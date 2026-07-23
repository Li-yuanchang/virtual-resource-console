import { request as httpsRequest } from "node:https";
import { assessVmReclaim } from "./analysis/reclaimStateMachine.js";
import { getGeneratedIso, markGeneratedIsoStatus, markGeneratedIsoUploaded, registerGeneratedIso } from "./generatedIsoStore.js";
import type { VirtualizationProvider } from "./providers/provider.js";
import {
  buildProxmoxInstallerArgs,
  cleanupProxmoxKickstartArtifacts,
  prepareProxmoxArmKickstartArtifacts,
  resolveProxmoxArmDistribution,
} from "./proxmoxUnattended.js";
import { inferIpv4FromName, isManagedIpv4 } from "./runtimePolicy.js";
import { normalizeStorageCapacity } from "./storageCapacity.js";
import { describeStorageRepository } from "./storageRepositoryProfile.js";
import type {
  HostNode,
  IsoImage,
  MetricQuery,
  MetricSample,
  NetworkInterface,
  PagedResult,
  ProviderScope,
  ResourcePool,
  StorageRepository,
  VirtualDisk,
  VmActionOptions,
  VmActionResult,
  VmDisk,
  VmInventorySummary,
  VmNode,
  VmPowerAction,
  VmProvisionCreatedVm,
  VmProvisionRequest,
  VmProvisionResult,
  VmQuery,
  VmRenameResult,
  VmResizeExecutionRequest,
  VmResizeResult,
  VmSnapshot,
  XenConnectionInput,
} from "./types.js";
import { assertVmRenameCurrentName, assertVmRenameNameAvailable, normalizeVmRenameInput } from "./vmRename.js";
import { normalizeGuestOsLabel } from "./guestOs.js";

interface ProxmoxLogin {
  ticket: string;
  csrf: string;
}

interface ProxmoxResponse<T> {
  data: T;
}

interface ProxmoxNode {
  node: string;
  status?: string;
  maxcpu?: number;
  maxmem?: number;
  mem?: number;
  uptime?: number;
  cpu?: number;
}

interface ProxmoxNodeStatus {
  pveversion?: string;
  uptime?: number;
  memory?: {
    total?: number;
    used?: number;
    free?: number;
  };
  cpuinfo?: {
    cpus?: number;
    sockets?: number;
    model?: string;
  };
}

interface ProxmoxStorage {
  storage: string;
  type?: string;
  shared?: number;
  total?: number;
  used?: number;
  avail?: number;
  content?: string;
}

interface ProxmoxNetworkInterface {
  iface?: string;
  type?: string;
  active?: number;
  address?: string;
  cidr?: string;
  gateway?: string;
  netmask?: string;
  hwaddress?: string;
}

interface ProxmoxVm {
  vmid: number;
  name?: string;
  status?: string;
  template?: number;
  cpus?: number;
  maxmem?: number;
  maxdisk?: number;
  disk?: number;
  uptime?: number;
}

interface ProxmoxVmStatus {
  status?: string;
  cpu?: number;
  cpus?: number;
  mem?: number;
  maxmem?: number;
  disk?: number;
  maxdisk?: number;
  diskread?: number;
  diskwrite?: number;
  netin?: number;
  netout?: number;
}

interface ProxmoxGuestAgentFsInfo {
  disk?: Array<Record<string, unknown>>;
  mountpoint?: string;
  type?: string;
  "total-bytes"?: number;
  "used-bytes"?: number;
}

interface ProxmoxGuestAgentFsInfoResponse {
  result?: ProxmoxGuestAgentFsInfo[];
}

interface ProxmoxGuestAgentInfoResponse {
  result?: {
    supported_commands?: Array<{ name?: string; enabled?: boolean }>;
  };
}

type ProxmoxVmConfig = Record<string, string | number | boolean | undefined>;

interface ProxmoxStorageContent {
  volid?: string;
  content?: string;
  size?: number;
  format?: string;
  ctime?: number;
}

interface ProxmoxInventory {
  nodes: ProxmoxNode[];
  nodeStatusByName: Map<string, ProxmoxNodeStatus>;
  networksByNode: Map<string, ProxmoxNetworkInterface[]>;
  storageByNode: Map<string, ProxmoxStorage[]>;
  vmsByNode: Map<string, ProxmoxVm[]>;
  vmConfigsByNode: Map<string, Map<number, ProxmoxVmConfig>>;
}

const DEFAULT_PROXMOX_PORT = 8006;
const PROXMOX_TIMEOUT_MS = 18_000;
const PROXMOX_METRIC_COUNTER_TTL_MS = 10 * 60 * 1000;
const PROXMOX_GUEST_FS_REFRESH_MS = 30 * 1000;
const PROXMOX_GUEST_FS_RETRY_MS = 5 * 60 * 1000;

interface ProxmoxMetricCounters {
  sampledAtMs: number;
  diskReadBytes: number | null;
  diskWriteBytes: number | null;
  networkRxBytes: number | null;
  networkTxBytes: number | null;
}

interface ProxmoxGuestFsCacheEntry {
  value?: ProxmoxGuestAgentFsInfoResponse;
  expiresAtMs: number;
  retryAfterMs: number;
  pending?: Promise<void>;
}

interface ProxmoxGuestFsLookup {
  value?: ProxmoxGuestAgentFsInfoResponse;
  status: "available" | "probing" | "unavailable" | "unknown";
}

const proxmoxMetricCounters = new Map<string, ProxmoxMetricCounters>();
const proxmoxGuestFsCache = new Map<string, ProxmoxGuestFsCacheEntry>();

type ProxmoxProvisionStrategyId = "template-clone" | "kickstart";

interface ProxmoxProvisionStrategy {
  id: ProxmoxProvisionStrategyId;
  execute(input: XenConnectionInput, request: VmProvisionRequest): Promise<VmProvisionResult>;
}

class ProxmoxProvisionStrategyRegistry {
  private readonly strategies = new Map<ProxmoxProvisionStrategyId, ProxmoxProvisionStrategy>();

  register(strategy: ProxmoxProvisionStrategy): void {
    this.strategies.set(strategy.id, strategy);
  }

  execute(strategyId: string, input: XenConnectionInput, request: VmProvisionRequest): Promise<VmProvisionResult> {
    const strategy = this.strategies.get(strategyId as ProxmoxProvisionStrategyId);
    if (!strategy) throw new Error(`PVE 暂不支持安装策略：${strategyId}`);
    return strategy.execute(input, request);
  }
}

const defaultProxmoxStrategyBySource = new Map<VmProvisionRequest["sourceType"], ProxmoxProvisionStrategyId>([
  ["template", "template-clone"],
  ["iso", "kickstart"],
]);

export class ProxmoxProvider implements VirtualizationProvider<XenConnectionInput> {
  readonly type = "proxmox" as const;

  /**
   * Executes a guest command through QEMU Guest Agent. This is the preferred
   * PVE path for storage inspection and filesystem expansion because it uses
   * the already authenticated PVE API session rather than VM SSH credentials.
   *
   * @param input PVE API connection, including host, port and API credentials.
   * @param vmId Provider VM id in `proxmox:<node>:<vmid>` format.
   * @param command Shell command to execute inside the guest; must be supplied by the storage workflow.
   * @param timeoutMs Maximum execution and polling time in milliseconds.
   * @return Captured standard output. Rejects when the guest agent is unavailable, exits non-zero, or times out.
   */
  async executeGuestCommand(input: XenConnectionInput, vmId: string, command: string, timeoutMs: number): Promise<string> {
    const [node, id] = parseVmProviderId(vmId);
    if (!node || !id) throw new Error(`无法解析 PVE 虚拟机标识：${vmId}`);
    const client = await ProxmoxClient.login(input);
    const vmPath = `/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(id)}`;
    const agentInfo = await client.get<ProxmoxGuestAgentInfoResponse>(`${vmPath}/agent/info`);
    const guestExec = agentInfo.result?.supported_commands?.find((item) => item.name === "guest-exec");
    if (!guestExec?.enabled) {
      throw new Error("PVE QEMU Guest Agent 已连接，但 guest-exec 未启用，无法执行虚拟机系统命令。");
    }
    const started = await client.post<{ pid?: number }>(`${vmPath}/agent/exec`, buildProxmoxGuestExecBody(command));
    const pid = Number(started?.pid);
    if (!Number.isFinite(pid) || pid <= 0) throw new Error("PVE QEMU Guest Agent 未返回命令进程号，请确认 Agent 已安装并运行。");
    const deadline = Date.now() + timeoutMs;
    let lastStatus: { exited?: boolean; exitcode?: number; "out-data"?: string; "err-data"?: string } = {};
    while (Date.now() < deadline) {
      lastStatus = await client.get<typeof lastStatus>(`${vmPath}/agent/exec-status?pid=${encodeURIComponent(String(pid))}`);
      if (lastStatus.exited) {
        const exitCode = Number(lastStatus.exitcode ?? 0);
        if (exitCode !== 0) throw new Error(lastStatus["err-data"]?.trim() || `PVE Guest Agent 命令退出：${exitCode}`);
        return lastStatus["out-data"] ?? "";
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`PVE Guest Agent 命令执行超时（${Math.ceil(timeoutMs / 1000)} 秒）。`);
  }
  private readonly provisionStrategies = new ProxmoxProvisionStrategyRegistry();

  constructor() {
    this.provisionStrategies.register({ id: "template-clone", execute: (input, request) => this.cloneCloudInitTemplates(input, request) });
    this.provisionStrategies.register({ id: "kickstart", execute: (input, request) => this.installArmIsoWithKickstart(input, request) });
  }

  async testConnection(input: XenConnectionInput) {
    const client = await ProxmoxClient.login(input);
    const version = await client.get<{ version?: string; release?: string }>("/version");
    return {
      ok: true,
      providerType: this.type,
      hostName: version.version ? `Proxmox VE ${version.version}` : input.host,
      message: version.release ? `release ${version.release}` : undefined,
    };
  }

  async listPools(input: XenConnectionInput): Promise<ResourcePool[]> {
    const connectionId = connectionKey(input);
    return [
      {
        id: `${connectionId}:cluster`,
        connectionId,
        providerId: "cluster",
        name: input.host,
        type: "cluster",
      },
    ];
  }

  async listHosts(input: XenConnectionInput, _scope: ProviderScope = {}): Promise<HostNode[]> {
    return (await this.collectHostInventory(input)).hosts;
  }

  async listHostSummary(input: XenConnectionInput, hostId: string): Promise<HostNode> {
    const host = (await this.listHosts(input)).find((item) => item.providerId === hostId || item.id === hostId);
    if (!host) {
      throw new Error(`未找到 Proxmox VE 节点: ${hostId}`);
    }
    return host;
  }

  async summarizeVms(input: XenConnectionInput, query: VmQuery): Promise<VmInventorySummary> {
    const connectionId = connectionKey(input);
    const inventory = await collectInventory(input);
    const items = Array.from(inventory.vmsByNode.entries())
      .filter(([node]) => !query.hostId || query.hostId === node)
      .flatMap(([node, vms]) => vms.map((vm) => toVmNode(vm, node, connectionId)));
    return summarizeVmItems(items, items.length);
  }

  async listVms(input: XenConnectionInput, query: VmQuery): Promise<PagedResult<VmNode>> {
    const connectionId = connectionKey(input);
    const inventory = await collectInventory(input, { includeVmConfigs: true });
    const keyword = (query.keyword ?? "").trim().toLowerCase();
    const items = Array.from(inventory.vmsByNode.entries())
      .filter(([node]) => !query.hostId || query.hostId === node)
      .flatMap(([node, vms]) => vms.map((vm) => toVmNode(vm, node, connectionId, inventory.vmConfigsByNode.get(node)?.get(vm.vmid))))
      .filter((vm) => !keyword || vmMatchesKeyword(vm, keyword))
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN", { numeric: true, sensitivity: "base" }));
    const pageSize = clampPageSize(query.pageSize);
    const page = Math.max(query.page ?? 1, 1);
    const offset = (page - 1) * pageSize;
    return {
      items: items.slice(offset, offset + pageSize),
      page,
      pageSize,
      total: items.length,
    };
  }

  async listVmDisks(input: XenConnectionInput, vmId: string): Promise<VmDisk[]> {
    const [node, id] = parseVmProviderId(vmId);
    if (!node || !id) return [];
    const client = await ProxmoxClient.login(input);
    const config = await client.get<ProxmoxVmConfig>(`/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(id)}/config`);
    return parseProxmoxVmDisks(config, vmId);
  }

  async listVirtualDisks(input: XenConnectionInput, scope: ProviderScope = {}): Promise<VirtualDisk[]> {
    const result = await this.listVms(input, { hostId: scope.hostId, page: 1, pageSize: 500 });
    return result.items.map((vm) => ({
      id: `${vm.providerId}:disk`,
      providerId: `${vm.providerId}:disk`,
      name: vm.name,
      storageRepository: "",
      virtualSizeBytes: vm.diskVirtualBytes ?? 0,
      physicalUtilisationBytes: 0,
      type: "qcow2/raw",
      readOnly: false,
      managed: true,
    }));
  }

  async listIsoImages(input: XenConnectionInput, scope: ProviderScope = {}): Promise<IsoImage[]> {
    const client = await ProxmoxClient.login(input);
    const nodes = await client.get<ProxmoxNode[]>("/nodes");
    const rows = await Promise.all(
      nodes
        .filter((node) => !scope.hostId || scope.hostId === node.node)
        .map(async (node) => {
          const nodeName = node.node;
          const storage = await client.get<ProxmoxStorage[]>(`/nodes/${encodeURIComponent(nodeName)}/storage`).catch(() => []);
          const isoStorage = storage.filter((item) => !item.content || item.content.split(",").map((part) => part.trim()).includes("iso"));
          const contentRows = await Promise.all(
            isoStorage.map(async (item) => {
              const storageName = item.storage;
              const content = await client
                .get<ProxmoxStorageContent[]>(
                  `/nodes/${encodeURIComponent(nodeName)}/storage/${encodeURIComponent(storageName)}/content?content=iso`,
                )
                .catch(() => []);
              return content
                .filter((entry) => entry.content === "iso" || entry.volid?.toLowerCase().endsWith(".iso"))
                .map((entry) => toProxmoxIsoImage(entry, item, nodeName));
            }),
          );
          return contentRows.flat();
        }),
    );
    const deduped = new Map<string, IsoImage>();
    for (const image of rows.flat()) {
      if (!deduped.has(image.providerId)) {
        deduped.set(image.providerId, image);
      }
    }
    return Array.from(deduped.values()).sort((left, right) =>
      `${left.storageRepository} ${left.name}`.localeCompare(`${right.storageRepository} ${right.name}`, "zh-CN", {
        numeric: true,
        sensitivity: "base",
      }),
    );
  }

  async listVmSnapshots(_input: XenConnectionInput, _vmId: string): Promise<VmSnapshot[]> {
    return [];
  }

  async performVmAction(input: XenConnectionInput, vmId: string, action: VmPowerAction, options?: VmActionOptions): Promise<VmActionResult> {
    const [node, id] = parseVmProviderId(vmId);
    if (!node || !id) {
      throw new Error(`Proxmox VE VM ID 不完整：${vmId}`);
    }
    const client = await ProxmoxClient.login(input);
    const status = await client.get<ProxmoxVmStatus>(`/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(id)}/status/current`);
    if (action === "start") {
      if (status.status === "running") throw new Error("虚拟机已在运行。");
      const upid = await client.post<string>(`/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(id)}/status/start`);
      await client.waitForTask(node, upid);
    } else if (action === "shutdown") {
      if (status.status !== "running") throw new Error("虚拟机未运行，无需关机。");
      try {
        const upid = await client.post<string>(`/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(id)}/status/shutdown`);
        await client.waitForTask(node, upid, options?.shutdownTimeoutMs);
      } catch (error) {
        if (options?.forceOnShutdownFailure === false) throw error;
        const upid = await client.post<string>(`/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(id)}/status/stop`);
        await client.waitForTask(node, upid);
        return {
          vmId,
          action,
          accepted: true,
          message: `关机完成：${vmId}`,
        };
      }
    } else if (action === "forceReboot") {
      if (status.status !== "running") throw new Error("虚拟机未运行，不能强制重启。");
      const stopUpid = await client.post<string>(`/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(id)}/status/stop`);
      await client.waitForTask(node, stopUpid);
      const startUpid = await client.post<string>(`/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(id)}/status/start`);
      await client.waitForTask(node, startUpid);
    } else {
      if (status.status === "running") throw new Error("虚拟机正在运行，请先关机后再删除。");
      const upid = await client.delete<string>(`/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(id)}`);
      await client.waitForTask(node, upid);
    }
    return {
      vmId,
      action,
      accepted: true,
      message: `${proxmoxActionLabel(action)}完成：${vmId}`,
    };
  }

  async renameVm(input: XenConnectionInput, vmId: string, currentName: string, newName: string): Promise<VmRenameResult> {
    const normalized = normalizeVmRenameInput(this.type, currentName, newName);
    const [node, id] = parseVmProviderId(vmId);
    if (!node || !id) throw new Error(`Proxmox VE VM ID 不完整：${vmId}`);
    const client = await ProxmoxClient.login(input);
    const [vms, config] = await Promise.all([
      client.get<ProxmoxVm[]>(`/nodes/${encodeURIComponent(node)}/qemu`),
      client.get<ProxmoxVmConfig>(`/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(id)}/config`),
    ]);
    const target = vms.find((item) => String(item.vmid) === id);
    if (!target) throw new Error(`未找到 Proxmox VE 虚拟机：${vmId}`);
    const actualName = String(config.name ?? target.name ?? target.vmid);
    assertVmRenameCurrentName(actualName, normalized.currentName);
    assertVmRenameNameAvailable(
      vms.some(
        (item) =>
          String(item.vmid) !== id &&
          item.name?.toLocaleLowerCase("en-US") === normalized.newName.toLocaleLowerCase("en-US"),
      ),
      "当前 PVE 节点",
      normalized.newName,
    );
    await client.put(`/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(id)}/config`, new URLSearchParams({ name: normalized.newName }));
    const updatedConfig = await client.get<ProxmoxVmConfig>(`/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(id)}/config`);
    const updatedName = String(updatedConfig.name ?? "");
    if (updatedName !== normalized.newName) {
      throw new Error("Proxmox VE 已接受改名请求，但名称校验未通过。");
    }
    return {
      vmId,
      previousName: actualName,
      newName: updatedName,
      accepted: true,
      message: `虚拟机名称已修改：${actualName} → ${updatedName}`,
    };
  }

  async resizeVm(input: XenConnectionInput, vmId: string, request: VmResizeExecutionRequest): Promise<VmResizeResult> {
    const [node, id] = parseVmProviderId(vmId);
    if (!node || !id) throw new Error(`Proxmox VE VM ID 不完整：${vmId}`);
    const client = await ProxmoxClient.login(input);
    const [status, config] = await Promise.all([
      client.get<ProxmoxVmStatus>(`/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(id)}/status/current`),
      client.get<ProxmoxVmConfig>(`/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(id)}/config`),
    ]);
    const previousCpuCount = Number(config.cores ?? status.cpus ?? 0);
    const previousMemoryBytes = Number(config.memory ?? 0) * 1024 * 1024 || Number(status.maxmem ?? 0);
    const currentDisks = parseProxmoxVmDisks(config, vmId);
    assertResizeIncrease("CPU", request.cpuCount, previousCpuCount);
    assertResizeIncrease("内存", request.memoryBytes, previousMemoryBytes);

    const needsShutdown = status.status === "running" && Boolean(request.cpuCount || request.memoryBytes);
    if (needsShutdown && !request.allowShutdown) throw new Error("PVE 当前配置需要先关机才能调整 CPU 或内存。");
    let stopped = false;
    let restarted = false;
    try {
      if (needsShutdown) {
        const shutdownTask = await client.post<string>(`/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(id)}/status/shutdown`);
        await client.waitForTask(node, shutdownTask);
        stopped = true;
      }

      const configChanges = new URLSearchParams();
      if (request.cpuCount) configChanges.set("cores", String(Math.floor(request.cpuCount)));
      if (request.memoryBytes) configChanges.set("memory", String(Math.ceil(request.memoryBytes / 1024 / 1024)));
      if ([...configChanges.keys()].length) {
        await client.put(`/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(id)}/config`, configChanges);
      }

      if (request.disk?.mode === "extend") {
        const disk = currentDisks.find((item) => item.id === request.disk?.diskId);
        if (!disk) throw new Error("PVE 扩展原盘失败：目标磁盘不属于当前虚拟机。");
        if (request.disk.sizeBytes < disk.virtualSizeBytes) throw new Error("不允许缩减 PVE 虚拟磁盘。");
        if (request.disk.sizeBytes > disk.virtualSizeBytes) {
          await client.put(
            `/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(id)}/resize`,
            new URLSearchParams({ disk: disk.device, size: `${Math.ceil(request.disk.sizeBytes / 1024 ** 3)}G` }),
          );
        }
      } else if (request.disk?.mode === "add") {
        const storage = request.disk.storageRepositoryId?.trim();
        if (!storage) throw new Error("PVE 新增磁盘需要选择存储。");
        const device = nextProxmoxScsiDevice(config);
        const sizeGiB = Math.ceil(request.disk.sizeBytes / 1024 ** 3);
        await client.put(
          `/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(id)}/config`,
          new URLSearchParams({ [device]: `${storage}:${sizeGiB},discard=on` }),
        );
      }

      if (stopped && request.restartAfterResize) {
        const startTask = await client.post<string>(`/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(id)}/status/start`);
        await client.waitForTask(node, startTask);
        restarted = true;
      }
    } catch (error) {
      if (stopped && request.restartAfterResize && !restarted) {
        await client
          .post<string>(`/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(id)}/status/start`)
          .then((upid) => client.waitForTask(node, upid))
          .catch(() => undefined);
      }
      throw error;
    }

    const updatedConfig = await client.get<ProxmoxVmConfig>(`/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(id)}/config`);
    return {
      vmId,
      name: String(updatedConfig.name ?? config.name ?? vmId),
      accepted: true,
      previousCpuCount,
      cpuCount: Number(updatedConfig.cores ?? previousCpuCount),
      previousMemoryBytes,
      memoryBytes: Number(updatedConfig.memory ?? previousMemoryBytes / 1024 / 1024) * 1024 * 1024,
      disks: parseProxmoxVmDisks(updatedConfig, vmId),
      stopped,
      restarted,
      message: `扩容完成：${String(updatedConfig.name ?? config.name ?? vmId)}`,
    };
  }

  async createVms(input: XenConnectionInput, request: VmProvisionRequest): Promise<VmProvisionResult> {
    const strategyId = request.installStrategy || defaultProxmoxStrategyBySource.get(request.sourceType);
    if (!strategyId) throw new Error(`PVE 未配置 ${request.sourceType} 对应的安装策略。`);
    return this.provisionStrategies.execute(strategyId, input, request);
  }

  async installArmIsoWithKickstart(input: XenConnectionInput, request: VmProvisionRequest): Promise<VmProvisionResult> {
    if (!request.isoId) throw new Error("PVE Kickstart 安装需要选择系统 ISO。");
    const images = await this.listIsoImages(input, { hostId: request.hostId });
    const iso = images.find((item) => item.id === request.isoId || item.providerId === request.isoId);
    if (!iso) throw new Error(`未找到 PVE 系统 ISO：${request.isoName || request.isoId}`);
    const distribution = resolveProxmoxArmDistribution(iso.name);
    if (!distribution) throw new Error("当前 PVE Kickstart 策略仅支持 openEuler/Kylin ARM64 ISO。");
    const client = await ProxmoxClient.login(input);
    const targetNode = request.hostId || await pickProxmoxNode(client);
    const storage = await pickProxmoxVmStorage(client, targetNode, plannedDiskGiB(request));
    const bridge = await pickProxmoxBridge(client, targetNode, request.ipPool.networkName);
    const created: VmProvisionCreatedVm[] = [];
    for (const item of request.planItems) {
      const vmid = Number(await client.get<number | string>("/cluster/nextid"));
      const platformVmName = safeProxmoxVmName(item.name);
      const artifacts = await prepareProxmoxArmKickstartArtifacts({
        connection: input,
        taskId: request.taskId || `pve-${Date.now().toString(36)}`,
        sourceIsoVolid: iso.providerId,
        vm: item,
        ipPool: request.ipPool,
        installProfile: request.installProfile,
      });
      const registry = registerGeneratedIso({
        taskId: request.taskId || `pve-${Date.now().toString(36)}`,
        providerType: "proxmox",
        connectionId: request.connectionId,
        hostId: targetNode,
        vmName: platformVmName,
        vmIp: item.ip,
        sourceIsoId: iso.id,
        sourceIsoName: iso.name,
        isoSrUuid: "local",
        isoName: artifacts.isoName,
        isoPath: artifacts.isoPath,
      });
      markGeneratedIsoUploaded(registry.id, { isoVdiUuid: artifacts.taskDir, message: "PVE Kickstart 配置 ISO 已生成" });
      let vmCreated = false;
      try {
        const createTask = await client.post<string>(`/nodes/${encodeURIComponent(targetNode)}/qemu`, new URLSearchParams({
          vmid: String(vmid),
          name: platformVmName,
          arch: "aarch64",
          bios: "ovmf",
          machine: "virt",
          cpu: "host",
          sockets: "1",
          cores: String(Math.max(Math.floor(item.cpu), 1)),
          memory: String(Math.max(Math.floor(item.memoryGiB), 1) * 1024),
          scsihw: "virtio-scsi-pci",
          scsi0: `${storage}:${Math.max(Math.floor(item.diskGiB), 1)}`,
          scsi1: `${iso.providerId},media=cdrom`,
          scsi2: `${artifacts.isoVolid},media=cdrom`,
          efidisk0: `${storage}:0,efitype=4m,pre-enrolled-keys=0`,
          net0: `virtio,bridge=${bridge}`,
          boot: "order=scsi0",
          ostype: "l26",
          agent: "1",
          args: buildProxmoxInstallerArgs({ artifacts, vm: item, ipPool: request.ipPool }),
        }));
        await client.waitForTask(targetNode, createTask);
        vmCreated = true;
        markGeneratedIsoStatus(registry.id, "attached", `已挂载到 ${item.name}`);
        if (request.autoStart) {
          const startTask = await client.post<string>(`/nodes/${encodeURIComponent(targetNode)}/qemu/${vmid}/status/start`);
          await client.waitForTask(targetNode, startTask);
          // QEMU 已加载本次 installer kernel/initrd；删除持久 args，确保安装后重启从 scsi0 系统盘启动。
          await client.put(
            `/nodes/${encodeURIComponent(targetNode)}/qemu/${vmid}/config`,
            new URLSearchParams({ delete: "args" }),
          );
        }
        created.push({
          id: `${targetNode}:${vmid}`,
          providerId: `${targetNode}:${vmid}`,
          name: item.name,
          powerState: request.autoStart ? "running" : "halted",
          ip: item.ip,
          generatedIsoRegistryId: registry.id,
        });
      } catch (error) {
        markGeneratedIsoStatus(registry.id, "failed", error instanceof Error ? error.message : "PVE Kickstart 安装准备失败");
        if (vmCreated) {
          await client.post<string>(`/nodes/${encodeURIComponent(targetNode)}/qemu/${vmid}/status/stop`).then((upid) => client.waitForTask(targetNode, upid)).catch(() => undefined);
          await client.delete<string>(`/nodes/${encodeURIComponent(targetNode)}/qemu/${vmid}`).then((upid) => client.waitForTask(targetNode, upid)).catch(() => undefined);
        }
        await cleanupProxmoxKickstartArtifacts(input, { isoPath: artifacts.isoPath, taskDir: artifacts.taskDir }).catch(() => undefined);
        markGeneratedIsoStatus(registry.id, "deleted", `PVE 创建失败后临时介质已清理：${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
    }
    return {
      accepted: true,
      providerType: this.type,
      message: `PVE ${distribution === "kylin" ? "Kylin" : "openEuler"} 无人值守安装已启动：${created.length} 台 VM`,
      created,
    };
  }

  async cloneCloudInitTemplates(input: XenConnectionInput, request: VmProvisionRequest): Promise<VmProvisionResult> {
    const templateName = request.templateName?.trim();
    if (!templateName) throw new Error("PVE 一键安装需要选择 cloud-init 克隆源。");
    const client = await ProxmoxClient.login(input);
    const inventory = await collectInventory(input);
    const template = findProxmoxTemplate(inventory, templateName);
    if (!template) throw new Error(`未找到 PVE cloud-init 克隆源：${templateName}`);
    const targetNode = request.hostId || template.node;
    const storage = await pickProxmoxVmStorage(client, targetNode, plannedDiskGiB(request));
    const created: VmProvisionCreatedVm[] = [];
    for (const item of request.planItems) {
      const vmid = await client.get<number | string>("/cluster/nextid");
      await client.post(
        `/nodes/${encodeURIComponent(template.node)}/qemu/${encodeURIComponent(String(template.vmid))}/clone`,
        new URLSearchParams({
          newid: String(vmid),
          name: item.name,
          target: targetNode,
          full: "1",
          storage,
        }),
      );
      await client.post(
        `/nodes/${encodeURIComponent(targetNode)}/qemu/${encodeURIComponent(String(vmid))}/config`,
        new URLSearchParams({
          cores: String(Math.max(Math.floor(item.cpu), 1)),
          memory: String(Math.max(Math.floor(item.memoryGiB), 1) * 1024),
          agent: "1",
          ciuser: item.loginUsername || "root",
          cipassword: item.rootPassword ?? "",
          nameserver: request.ipPool.dns[0] ?? "",
          ipconfig0: buildProxmoxIpConfig(item.ip, request.ipPool),
        }),
      );
      await client
        .put(
          `/nodes/${encodeURIComponent(targetNode)}/qemu/${encodeURIComponent(String(vmid))}/resize`,
          new URLSearchParams({ disk: "scsi0", size: `${Math.max(Math.floor(item.diskGiB), 1)}G` }),
        )
        .catch(() => undefined);
      if (request.autoStart) {
        await client.post(`/nodes/${encodeURIComponent(targetNode)}/qemu/${encodeURIComponent(String(vmid))}/status/start`);
      }
      created.push({
        id: `${targetNode}:${vmid}`,
        providerId: `${targetNode}:${vmid}`,
        name: item.name,
        powerState: request.autoStart ? "running" : "halted",
        ip: item.ip,
      });
    }
    return {
      accepted: true,
      providerType: this.type,
      message: `Proxmox VE 模板安装任务已完成：${created.length} 台 VM`,
      created,
    };
  }

  async collectMetrics(input: XenConnectionInput, query: MetricQuery): Promise<MetricSample[]> {
    if (query.targetType !== "vm" || query.targetIds.length === 0) return [];
    const client = await ProxmoxClient.login(input);
    const connectionId = query.connectionId || connectionKey(input);
    const sampledAtMs = Date.now();
    const sampledAt = new Date(sampledAtMs).toISOString();
    pruneProxmoxMetricCounters(sampledAtMs);

    const samples = await Promise.all(
      query.targetIds.map(async (targetId) => {
        const [node, vmId] = parseVmProviderId(targetId);
        if (!node || !vmId) return [];
        const vmPath = `/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(vmId)}`;
        const status = await client.get<ProxmoxVmStatus>(`${vmPath}/status/current`);
        const guestFsInfo = getCachedProxmoxGuestFsInfo(client, vmPath, `${connectionId}:${targetId}`, sampledAtMs);
        return toProxmoxMetricSamples(status, {
          connectionId,
          targetId,
          sampledAt,
          sampledAtMs,
        }, guestFsInfo);
      }),
    );
    return samples.flat();
  }

  async collectHostInventory(input: XenConnectionInput): Promise<{
    hosts: HostNode[];
    storage: StorageRepository[];
    networks: NetworkInterface[];
  }> {
    const connectionId = connectionKey(input);
    const inventory = await collectInventory(input);
    const hosts = inventory.nodes.map((node) =>
      toHostNode(node, inventory.nodeStatusByName.get(node.node), inventory.networksByNode.get(node.node) ?? [], connectionId, input),
    );
    if (!hosts.length) {
      throw new Error("未读取到 Proxmox VE 节点信息，请确认账号有 PVEAuditor 或等价只读权限。");
    }
    return {
      hosts,
      storage: Array.from(inventory.storageByNode.entries()).flatMap(([node, storage]) =>
        storage.map((item) => toStorageRepository(item, node)),
      ),
      networks: Array.from(inventory.networksByNode.entries()).flatMap(([node, networks]) => toNetworkInterfaces(node, networks)),
    };
  }
}

/** Builds the PVE form body for the array-typed QEMU Guest Agent command parameter. */
export function buildProxmoxGuestExecBody(command: string): URLSearchParams {
  return new URLSearchParams({
    command: JSON.stringify(["sh", "-lc", command]),
  });
}

export async function cleanupRegisteredProxmoxGeneratedIso(input: XenConnectionInput, registryId: string): Promise<void> {
  const record = getGeneratedIso(registryId);
  if (!record) throw new Error(`未找到生成 ISO 登记记录：${registryId}`);
  if (record.providerType !== "proxmox") throw new Error(`生成 ISO 不是 PVE 类型：${registryId}`);
  if (!record.isoVdiUuid) throw new Error(`PVE 临时介质缺少任务目录登记：${registryId}`);
  const client = await ProxmoxClient.login(input);
  const inventory = await collectInventory(input);
  const matched = Array.from(inventory.vmsByNode.entries()).flatMap(([node, vms]) =>
    vms.filter((vm) => vm.name === record.vmName).map((vm) => ({ node, vmid: vm.vmid })),
  )[0];
  if (matched) {
    await client.put(
      `/nodes/${encodeURIComponent(matched.node)}/qemu/${matched.vmid}/config`,
      new URLSearchParams({ delete: "args,scsi1,scsi2" }),
    );
  }
  await cleanupProxmoxKickstartArtifacts(input, { isoPath: record.isoPath, taskDir: record.isoVdiUuid });
  markGeneratedIsoStatus(registryId, "deleted", "PVE Kickstart 临时介质已清理");
}

export async function startProxmoxVmFromDiskIfStopped(input: XenConnectionInput, vmId: string): Promise<boolean> {
  const [node, id] = parseVmProviderId(vmId);
  if (!node || !id) throw new Error(`PVE VM 标识不完整：${vmId}`);
  const client = await ProxmoxClient.login(input);
  const status = await client.get<ProxmoxVmStatus>(`/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(id)}/status/current`);
  if (status.status !== "stopped") return false;
  const upid = await client.post<string>(`/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(id)}/status/start`);
  await client.waitForTask(node, upid);
  return true;
}

export async function enableAndVerifyProxmoxGuestAgent(
  input: XenConnectionInput,
  vmId: string,
  timeoutMs = 120_000,
): Promise<void> {
  const [node, id] = parseVmProviderId(vmId);
  if (!node || !id) throw new Error(`PVE VM 标识不完整：${vmId}`);
  const client = await ProxmoxClient.login(input);
  const vmPath = `/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(id)}`;
  await client.put(`${vmPath}/config`, new URLSearchParams({ agent: "1" }));
  const deadline = Date.now() + timeoutMs;
  let lastError = "qemu-guest-agent 尚未响应";
  while (Date.now() < deadline) {
    try {
      await client.post(`${vmPath}/agent/ping`);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  }
  throw new Error(`PVE 未能通过 Agent API 验证 qemu-guest-agent：${lastError}`);
}

class ProxmoxClient {
  private constructor(
    private readonly input: XenConnectionInput,
    private readonly login: ProxmoxLogin,
  ) {}

  static async login(input: XenConnectionInput): Promise<ProxmoxClient> {
    const username = normalizeUsername(input.username);
    const body = new URLSearchParams({
      username,
      password: input.password,
    }).toString();
    const response = await proxmoxRequest<{
      ticket: string;
      CSRFPreventionToken?: string;
    }>(input, "POST", "/access/ticket", body, undefined);
    return new ProxmoxClient(input, {
      ticket: response.ticket,
      csrf: response.CSRFPreventionToken ?? "",
    });
  }

  async get<T>(path: string): Promise<T> {
    return proxmoxRequest<T>(this.input, "GET", path, undefined, this.login);
  }

  async post<T = unknown>(path: string, body?: URLSearchParams): Promise<T> {
    return proxmoxRequest<T>(this.input, "POST", path, body?.toString() ?? "", this.login);
  }

  async put<T = unknown>(path: string, body?: URLSearchParams): Promise<T> {
    return proxmoxRequest<T>(this.input, "PUT", path, body?.toString() ?? "", this.login);
  }

  async delete<T = unknown>(path: string): Promise<T> {
    return proxmoxRequest<T>(this.input, "DELETE", path, undefined, this.login);
  }

  async waitForTask(node: string, upid: string, timeoutMs = 120_000): Promise<void> {
    if (!upid) return;
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const status = await this.get<{ status?: string; exitstatus?: string }>(
        `/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}/status`,
      );
      if (status.status === "stopped") {
        if (!status.exitstatus || status.exitstatus === "OK") return;
        throw new Error(`PVE 任务失败：${status.exitstatus}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    throw new Error("PVE 任务执行超时。");
  }
}

async function collectInventory(input: XenConnectionInput, options: { includeVmConfigs?: boolean } = {}): Promise<ProxmoxInventory> {
  const client = await ProxmoxClient.login(input);
  const nodes = await client.get<ProxmoxNode[]>("/nodes");
  const nodeStatusByName = new Map<string, ProxmoxNodeStatus>();
  const networksByNode = new Map<string, ProxmoxNetworkInterface[]>();
  const storageByNode = new Map<string, ProxmoxStorage[]>();
  const vmsByNode = new Map<string, ProxmoxVm[]>();
  const vmConfigsByNode = new Map<string, Map<number, ProxmoxVmConfig>>();

  await Promise.all(
    nodes.map(async (node) => {
      const nodeName = node.node;
      const [status, network, storage, vms] = await Promise.all([
        client.get<ProxmoxNodeStatus>(`/nodes/${encodeURIComponent(nodeName)}/status`).catch(() => ({})),
        client.get<ProxmoxNetworkInterface[]>(`/nodes/${encodeURIComponent(nodeName)}/network`).catch(() => []),
        client.get<ProxmoxStorage[]>(`/nodes/${encodeURIComponent(nodeName)}/storage`).catch(() => []),
        client.get<ProxmoxVm[]>(`/nodes/${encodeURIComponent(nodeName)}/qemu`).catch(() => []),
      ]);
      const vmConfigs = options.includeVmConfigs ? await collectVmConfigs(client, nodeName, vms) : new Map<number, ProxmoxVmConfig>();
      nodeStatusByName.set(nodeName, status);
      networksByNode.set(nodeName, network);
      storageByNode.set(nodeName, storage);
      vmsByNode.set(nodeName, vms);
      vmConfigsByNode.set(nodeName, vmConfigs);
    }),
  );

  return {
    nodes,
    nodeStatusByName,
    networksByNode,
    storageByNode,
    vmsByNode,
    vmConfigsByNode,
  };
}

async function collectVmConfigs(client: ProxmoxClient, nodeName: string, vms: ProxmoxVm[]): Promise<Map<number, ProxmoxVmConfig>> {
  const vmConfigs = new Map<number, ProxmoxVmConfig>();
  await Promise.all(
    vms.map(async (vm) => {
      const config = await client.get<ProxmoxVmConfig>(`/nodes/${encodeURIComponent(nodeName)}/qemu/${encodeURIComponent(vm.vmid)}/config`).catch(() => ({}));
      vmConfigs.set(vm.vmid, config);
    }),
  );
  return vmConfigs;
}

function proxmoxRequest<T>(
  input: XenConnectionInput,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body: string | undefined,
  login: ProxmoxLogin | undefined,
): Promise<T> {
  const port = input.port || DEFAULT_PROXMOX_PORT;
  const requestPath = `/api2/json${path}`;
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: input.host,
        port,
        path: requestPath,
        method,
        rejectUnauthorized: false,
        timeout: PROXMOX_TIMEOUT_MS,
        headers: {
          ...(body
            ? {
                "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
                "Content-Length": Buffer.byteLength(body),
              }
            : {}),
          ...(login
            ? {
                Cookie: `PVEAuthCookie=${login.ticket}`,
                ...(login.csrf ? { CSRFPreventionToken: login.csrf } : {}),
              }
            : {}),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => {
          try {
            const parsed = text ? (JSON.parse(text) as ProxmoxResponse<T> & { errors?: unknown }) : ({ data: undefined } as ProxmoxResponse<T>);
            if ((res.statusCode ?? 500) >= 400) {
              reject(new Error(toProxmoxErrorMessage(res.statusCode ?? 500, parsed)));
              return;
            }
            resolve(parsed.data);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("连接 Proxmox VE API 超时，请确认 8006 端口和网络连通。"));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function proxmoxActionLabel(action: VmPowerAction) {
  if (action === "start") return "开机";
  if (action === "shutdown") return "关机";
  if (action === "forceReboot") return "强制重启";
  return "删除";
}

function findProxmoxTemplate(inventory: ProxmoxInventory, templateName: string): { node: string; vmid: number } | undefined {
  const normalized = templateName.toLowerCase();
  for (const [node, vms] of inventory.vmsByNode.entries()) {
    const matched = vms.find((vm) => vm.template === 1 && ((vm.name ?? "").toLowerCase() === normalized || String(vm.vmid) === templateName));
    if (matched) return { node, vmid: matched.vmid };
  }
  for (const [node, vms] of inventory.vmsByNode.entries()) {
    const matched = vms.find((vm) => vm.template === 1 && (vm.name ?? "").toLowerCase().includes(normalized));
    if (matched) return { node, vmid: matched.vmid };
  }
}

function buildProxmoxIpConfig(ip: string, pool: { cidr: string; gateway: string }): string {
  const prefix = Number(pool.cidr.split("/")[1]);
  const mask = Number.isInteger(prefix) && prefix >= 0 && prefix <= 32 ? prefix : 24;
  return `ip=${ip}/${mask},gw=${pool.gateway}`;
}

function safeProxmoxVmName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63) || "vrc-vm";
}

async function pickProxmoxNode(client: ProxmoxClient): Promise<string> {
  const nodes = await client.get<ProxmoxNode[]>("/nodes");
  return nodes.find((node) => node.status === "online")?.node ?? nodes[0]?.node ?? "";
}

async function pickProxmoxVmStorage(client: ProxmoxClient, node: string, requiredGiB: number): Promise<string> {
  const storage = await client.get<ProxmoxStorage[]>(`/nodes/${encodeURIComponent(node)}/storage`);
  const candidates = storage.filter((item) => storageSupportsContent(item, "images") || storageSupportsContent(item, "rootdir"));
  if (!candidates.length) throw new Error(`PVE 节点 ${node} 未找到支持 VM 磁盘的存储。`);
  const requiredBytes = Math.max(requiredGiB, 1) * 1024 ** 3;
  const best = candidates
    .filter((item) => (item.avail ?? 0) >= requiredBytes)
    .sort((left, right) => (right.avail ?? 0) - (left.avail ?? 0))[0];
  if (!best) {
    const capacity = candidates
      .sort((left, right) => (right.avail ?? 0) - (left.avail ?? 0))
      .map((item) => `${item.storage} ${bytesToGib(item.avail ?? 0).toFixed(1)} GiB`)
      .join("、");
    throw new Error(`PVE 节点 ${node} 没有单个存储可容纳计划磁盘 ${requiredGiB} GiB；当前余量：${capacity}`);
  }
  return best.storage;
}

function plannedDiskGiB(request: VmProvisionRequest): number {
  return request.planItems.reduce((sum, item) => sum + Math.max(Math.floor(item.diskGiB), 1), 0);
}

async function pickProxmoxBridge(client: ProxmoxClient, node: string, preferred?: string): Promise<string> {
  const networks = await client.get<ProxmoxNetworkInterface[]>(`/nodes/${encodeURIComponent(node)}/network`).catch(() => []);
  if (preferred) {
    const matched = networks.find((item) => item.iface === preferred && item.type === "bridge");
    if (matched?.iface) return matched.iface;
  }
  return networks.find((item) => item.iface === "vmbr0")?.iface ?? networks.find((item) => item.type === "bridge")?.iface ?? "vmbr0";
}

function storageSupportsContent(storage: ProxmoxStorage, content: string): boolean {
  return !storage.content || storage.content.split(",").map((item) => item.trim()).includes(content);
}

function normalizeProxmoxIsoId(isoId: string): string {
  return isoId.startsWith("proxmox:") ? isoId.slice("proxmox:".length) : isoId;
}

function proxmoxOsTypeForIso(request: VmProvisionRequest): string {
  const text = `${request.isoId ?? ""} ${request.templateName ?? ""}`.toLowerCase();
  if (text.includes("win")) return "win10";
  return "l26";
}

function toHostNode(
  node: ProxmoxNode,
  status: ProxmoxNodeStatus | undefined,
  networks: ProxmoxNetworkInterface[],
  connectionId: string,
  input: XenConnectionInput,
): HostNode {
  const memoryTotal = status?.memory?.total ?? node.maxmem ?? 0;
  const memoryUsed = status?.memory?.used ?? node.mem ?? 0;
  return {
    id: `${connectionId}:host:${node.node}`,
    connectionId,
    providerId: node.node,
    name: node.node,
    address: pickProxmoxHostAddress(networks, input.host) || node.node,
    vendor: "Proxmox VE",
    version: status?.pveversion ?? "",
    cpuModel: status?.cpuinfo?.model ?? "",
    cpuSockets: status?.cpuinfo?.sockets ?? 0,
    cpuCores: status?.cpuinfo?.cpus ?? node.maxcpu ?? 0,
    memoryTotalBytes: memoryTotal,
    memoryFreeBytes: Math.max(memoryTotal - memoryUsed, 0),
    uptime: formatUptime(status?.uptime ?? node.uptime),
    status: node.status === "online" ? "online" : node.status === "offline" ? "offline" : "unknown",
  };
}

function pickProxmoxHostAddress(networks: ProxmoxNetworkInterface[], fallbackHost: string): string {
  const activeNetworks = networks.filter((item) => item.active === 1 || item.active == null);
  const candidates = [
    ...activeNetworks.filter((item) => item.gateway),
    ...activeNetworks.filter((item) => item.iface === "vmbr0"),
    ...activeNetworks.filter((item) => item.type === "bridge"),
    ...activeNetworks,
  ];
  for (const item of candidates) {
    const address = normalizeIpAddress(item.address || item.cidr || "");
    if (address) return address;
  }
  return normalizeIpAddress(fallbackHost) || fallbackHost;
}

function normalizeIpAddress(value: string): string {
  const ip = value.split("/")[0]?.trim() ?? "";
  return isManagedIpv4(ip) ? ip : "";
}

function inferIpv4FromVmName(name: string): string {
  return inferIpv4FromName(name);
}

function toNetworkInterfaces(hostId: string, networks: ProxmoxNetworkInterface[]): NetworkInterface[] {
  return networks
    .filter((item) => item.iface || item.address || item.cidr)
    .map((item) => {
      const ip = normalizeIpAddress(item.address || item.cidr || "");
      return {
        hostId,
        device: item.iface ?? "",
        mac: item.hwaddress ?? "",
        ip,
        netmask: item.netmask || cidrToNetmask(item.cidr ?? ""),
        gateway: item.gateway ?? "",
        management: Boolean(ip) && (Boolean(item.gateway) || item.iface === "vmbr0"),
        attached: item.active === 1 || item.active == null,
        network: item.type ?? "",
      };
    });
}

function cidrToNetmask(cidr: string): string {
  const prefix = Number(cidr.split("/")[1]);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return "";
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return [24, 16, 8, 0].map((shift) => String((mask >>> shift) & 255)).join(".");
}

function toStorageRepository(item: ProxmoxStorage, hostId: string): StorageRepository {
  const total = item.total ?? 0;
  const used = item.used ?? 0;
  const shared = item.shared === 1;
  const content = item.content?.split(",").map((value) => value.trim()).filter(Boolean);
  return {
    name: item.storage,
    type: item.type ?? "",
    ...describeStorageRepository("proxmox", { type: item.type ?? "", shared, content }),
    ...normalizeStorageCapacity({ physicalGiB: bytesToGib(total), usedGiB: bytesToGib(used) }),
    shared,
    hostId,
    content,
  };
}

function toProxmoxIsoImage(entry: ProxmoxStorageContent, storage: ProxmoxStorage, nodeName: string): IsoImage {
  const volid = entry.volid ?? `${storage.storage}:iso/${entry.format ?? "unknown"}`;
  const name = volid.split("/").pop() || volid.split(":").pop() || volid;
  return {
    id: `proxmox:${volid}`,
    providerId: volid,
    name,
    storageRepositoryId: storage.storage,
    storageRepository: storage.storage,
    path: volid,
    sizeBytes: entry.size ?? 0,
    hostId: nodeName,
    shared: storage.shared === 1,
    metadata: {
      format: entry.format,
      ctime: entry.ctime,
    },
  };
}

function toVmNode(vm: ProxmoxVm, node: string, connectionId: string, config?: ProxmoxVmConfig): VmNode {
  const providerId = `${node}:${vm.vmid}`;
  const name = vm.name || String(vm.vmid);
  const inferredIp = inferIpv4FromVmName(name);
  const item: VmNode = {
    id: `${connectionId}:vm:${providerId}`,
    connectionId,
    providerId,
    consoleRef: providerId,
    hostId: node,
    name,
    powerState: vm.status === "running" ? "running" : vm.status === "stopped" ? "halted" : "unknown",
    cpuCount: vm.cpus ?? 0,
    memoryBytes: vm.maxmem ?? 0,
    diskVirtualBytes: vm.maxdisk ?? vm.disk ?? 0,
    diskCount: vm.maxdisk || vm.disk ? 1 : 0,
    diskSizeSummary: vm.maxdisk || vm.disk ? `${bytesToGib(vm.maxdisk ?? vm.disk ?? 0).toFixed(1)} GiB` : undefined,
    ipAddresses: inferredIp ? [inferredIp] : [],
    guestOs: normalizeProxmoxGuestOs(config?.ostype),
    toolsStatus: "unknown",
    reclaimLevel: "P3",
    reclaimReason: "",
  };
  const assessment = assessVmReclaim({
    uuid: item.providerId,
    name: item.name,
    powerState: item.powerState,
    vcpuMax: item.cpuCount,
    vcpuStartup: item.cpuCount,
    memoryGiB: bytesToGib(item.memoryBytes),
    diskTotalGiB: bytesToGib(item.diskVirtualBytes ?? 0),
    diskDetail: item.diskSizeSummary ?? "",
    residentHost: item.hostId ?? "",
    ipAddresses: item.ipAddresses,
    cpuUsage: null,
    diskReadRate: null,
    diskWriteRate: null,
    networkRxRate: null,
    networkTxRate: null,
    reclaimLevel: "P3",
    reclaimReason: "",
  });
  item.reclaimLevel = assessment.reclaimLevel;
  item.reclaimReason = assessment.reclaimReason;
  return item;
}

export function parseProxmoxVmDisks(config: ProxmoxVmConfig, vmId: string): VmDisk[] {
  return Object.entries(config)
    .filter(([key, value]) => {
      if (!/^(ide|sata|scsi|virtio)\d+$/.test(key)) return false;
      return !/(?:^|,)media=cdrom(?:,|$)|cloudinit/i.test(String(value ?? ""));
    })
    .map(([device, value]) => {
      const text = String(value ?? "");
      const size = parseDiskSize(text);
      return {
        id: `${vmId}:${device}`,
        vmId,
        providerId: `${vmId}:${device}`,
        name: device,
        device,
        displayName: device,
        virtualSizeBytes: size,
        storageRepositoryId: text.split(":")[0] || undefined,
        storageRepository: text.split(":")[0] || undefined,
        onlineResizeSupported: true,
        canOnlineResize: true,
        requiresShutdown: false,
        allowedModes: ["extend", "add"] as VmDisk["allowedModes"],
      };
    })
    .filter((disk) => disk.virtualSizeBytes > 0)
    .sort((left, right) => left.device.localeCompare(right.device, "en", { numeric: true }));
}

function nextProxmoxScsiDevice(config: ProxmoxVmConfig): string {
  for (let index = 0; index < 31; index += 1) {
    const device = `scsi${index}`;
    if (!(device in config)) return device;
  }
  throw new Error("PVE 当前虚拟机没有可用的 SCSI 磁盘槽位。");
}

function assertResizeIncrease(label: string, target: number | undefined, current: number): void {
  if (target == null) return;
  if (!Number.isFinite(target) || target <= current) throw new Error(`${label}扩容目标必须大于当前值。`);
}

function parseVmProviderId(value: string): [string, string] {
  const parts = value.includes(":vm:") ? value.split(":vm:").pop()?.split(":") : value.split(":");
  return [parts?.[0] ?? "", parts?.[1] ?? ""];
}

function toProxmoxMetricSamples(
  status: ProxmoxVmStatus,
  context: { connectionId: string; targetId: string; sampledAt: string; sampledAtMs: number },
  guestFsLookup: ProxmoxGuestFsLookup,
): MetricSample[] {
  const samples: MetricSample[] = [];
  const guestTelemetry: NonNullable<MetricSample["guestTelemetry"]> = {
    status: guestFsLookup.status,
    method: "qemu-guest-agent",
    message:
      guestFsLookup.status === "available"
        ? "QEMU Guest Agent 可读取文件系统"
        : guestFsLookup.status === "probing"
          ? "正在探测 QEMU Guest Agent"
          : guestFsLookup.status === "unavailable"
            ? "QEMU Guest Agent 不可用，使用宿主机指标"
            : "QEMU Guest Agent 状态未知",
  };
  const pushSample = (
    metric: MetricSample["metric"],
    value: number | null,
    unit: MetricSample["unit"],
    source: MetricSample["source"],
  ) => {
    if (value == null) return;
    samples.push({
      id: `${context.connectionId}:${context.targetId}:${metric}:${context.sampledAtMs}`,
      connectionId: context.connectionId,
      targetType: "vm",
      targetId: context.targetId,
      metric,
      value,
      unit,
      source,
      guestTelemetry,
      sampledAt: context.sampledAt,
    });
  };

  const cpuUsage = finiteNonNegative(status.cpu);
  const memoryTotal = finitePositive(status.maxmem);
  const memoryUsed = clampToTotal(finiteNonNegative(status.mem), memoryTotal);
  const guestDiskUsage = summarizeProxmoxGuestDiskUsage(guestFsLookup.value);
  const diskTotal = guestDiskUsage?.totalBytes ?? finitePositive(status.maxdisk);
  // PVE reports status.disk as zero when guest filesystem usage is unavailable.
  // Only Guest Agent fsinfo has the semantics required for a utilisation ratio.
  const diskUsed = guestDiskUsage?.usedBytes ?? null;
  pushSample("cpu_usage", cpuUsage == null ? null : Math.min(cpuUsage, 1), "ratio", "hypervisor");
  pushSample("memory_used", memoryUsed, "bytes", "hypervisor");
  pushSample("memory_total", memoryTotal, "bytes", "hypervisor");
  pushSample("disk_used", diskUsed, "bytes", "guest-agent");
  pushSample("disk_total", diskTotal, "bytes", guestDiskUsage ? "guest-agent" : "hypervisor");

  const counterKey = `${context.connectionId}:${context.targetId}`;
  const currentCounters: ProxmoxMetricCounters = {
    sampledAtMs: context.sampledAtMs,
    diskReadBytes: finiteNonNegative(status.diskread),
    diskWriteBytes: finiteNonNegative(status.diskwrite),
    networkRxBytes: finiteNonNegative(status.netin),
    networkTxBytes: finiteNonNegative(status.netout),
  };
  const previousCounters = proxmoxMetricCounters.get(counterKey);
  const elapsedSeconds = previousCounters ? (context.sampledAtMs - previousCounters.sampledAtMs) / 1000 : 0;
  if (previousCounters && elapsedSeconds > 0) {
    pushSample("disk_read", counterRate(currentCounters.diskReadBytes, previousCounters.diskReadBytes, elapsedSeconds), "bytes_per_sec", "hypervisor");
    pushSample("disk_write", counterRate(currentCounters.diskWriteBytes, previousCounters.diskWriteBytes, elapsedSeconds), "bytes_per_sec", "hypervisor");
    pushSample("net_rx", counterRate(currentCounters.networkRxBytes, previousCounters.networkRxBytes, elapsedSeconds), "bytes_per_sec", "hypervisor");
    pushSample("net_tx", counterRate(currentCounters.networkTxBytes, previousCounters.networkTxBytes, elapsedSeconds), "bytes_per_sec", "hypervisor");
  }
  proxmoxMetricCounters.set(counterKey, currentCounters);
  return samples;
}

function finiteNonNegative(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function finitePositive(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function summarizeProxmoxGuestDiskUsage(
  response: ProxmoxGuestAgentFsInfoResponse | undefined,
): { usedBytes: number; totalBytes: number } | null {
  const fileSystems = response?.result?.filter((item) => {
    const totalBytes = finitePositive(item["total-bytes"]);
    return totalBytes != null && Array.isArray(item.disk) && item.disk.length > 0;
  }) ?? [];
  if (fileSystems.length === 0) return null;
  const totalBytes = fileSystems.reduce((sum, item) => sum + (finitePositive(item["total-bytes"]) ?? 0), 0);
  const usedBytes = fileSystems.reduce((sum, item) => sum + (finiteNonNegative(item["used-bytes"]) ?? 0), 0);
  return totalBytes > 0 ? { usedBytes: Math.min(usedBytes, totalBytes), totalBytes } : null;
}

function clampToTotal(value: number | null, total: number | null): number | null {
  if (value == null) return null;
  return total == null ? value : Math.min(value, total);
}

function counterRate(current: number | null, previous: number | null, elapsedSeconds: number): number | null {
  if (current == null || previous == null || current < previous || elapsedSeconds <= 0) return null;
  return (current - previous) / elapsedSeconds;
}

function pruneProxmoxMetricCounters(now: number): void {
  for (const [key, value] of proxmoxMetricCounters.entries()) {
    if (now - value.sampledAtMs > PROXMOX_METRIC_COUNTER_TTL_MS) proxmoxMetricCounters.delete(key);
  }
  for (const [key, value] of proxmoxGuestFsCache.entries()) {
    if (!value.pending && now >= Math.max(value.expiresAtMs, value.retryAfterMs) + PROXMOX_METRIC_COUNTER_TTL_MS) {
      proxmoxGuestFsCache.delete(key);
    }
  }
}

function getCachedProxmoxGuestFsInfo(
  client: ProxmoxClient,
  vmPath: string,
  cacheKey: string,
  now: number,
): ProxmoxGuestFsLookup {
  const cached = proxmoxGuestFsCache.get(cacheKey);
  if (cached?.value && now < cached.expiresAtMs) return { value: cached.value, status: "available" };
  if (cached?.pending) return cached.value ? { value: cached.value, status: "available" } : { status: "probing" };
  if (cached && now < cached.retryAfterMs) return { status: "unavailable" };

  const entry = cached ?? { expiresAtMs: 0, retryAfterMs: 0 };
  entry.pending = client
    .get<ProxmoxGuestAgentFsInfoResponse>(`${vmPath}/agent/get-fsinfo`)
    .then((value) => {
      entry.value = value;
      entry.expiresAtMs = Date.now() + PROXMOX_GUEST_FS_REFRESH_MS;
      entry.retryAfterMs = 0;
    })
    .catch(() => {
      entry.value = undefined;
      entry.expiresAtMs = 0;
      entry.retryAfterMs = Date.now() + PROXMOX_GUEST_FS_RETRY_MS;
    })
    .finally(() => {
      entry.pending = undefined;
    });
  proxmoxGuestFsCache.set(cacheKey, entry);
  return entry.value ? { value: entry.value, status: "available" } : { status: "probing" };
}

function parseDiskSize(value: string): number {
  const match = value.match(/size=(\d+(?:\.\d+)?)([KMGTP]?)/i);
  if (!match) return 0;
  const amount = Number(match[1]);
  const unit = match[2].toUpperCase();
  const factors: Record<string, number> = {
    "": 1,
    K: 1024,
    M: 1024 ** 2,
    G: 1024 ** 3,
    T: 1024 ** 4,
    P: 1024 ** 5,
  };
  return Math.round(amount * (factors[unit] ?? 1));
}

function summarizeVmItems(items: VmNode[], total = items.length): VmInventorySummary {
  const runningItems = items.filter((vm) => vm.powerState === "running");
  return {
    total,
    running: runningItems.length,
    halted: items.filter((vm) => vm.powerState === "halted").length,
    vcpu: items.reduce((sum, vm) => sum + vm.cpuCount, 0),
    runningVcpu: runningItems.reduce((sum, vm) => sum + vm.cpuCount, 0),
    memoryBytes: items.reduce((sum, vm) => sum + vm.memoryBytes, 0),
    runningMemoryBytes: runningItems.reduce((sum, vm) => sum + vm.memoryBytes, 0),
    diskBytes: items.reduce((sum, vm) => sum + Math.max(vm.diskVirtualBytes ?? 0, 0), 0),
  };
}

function vmMatchesKeyword(vm: VmNode, keyword: string): boolean {
  const fields = shouldSearchProviderId(keyword) ? [vm.name, vm.providerId, vm.guestOs ?? "", ...vm.ipAddresses] : [vm.name, vm.guestOs ?? "", ...vm.ipAddresses];
  return fields.join(" ").toLowerCase().includes(keyword);
}

function shouldSearchProviderId(keyword: string): boolean {
  return /^[a-f0-9:-]{8,}$/i.test(keyword);
}

function normalizeProxmoxGuestOs(value: unknown): string | undefined {
  const ostype = String(value ?? "").trim().toLowerCase();
  if (!ostype) return undefined;
  const labels: Record<string, string> = {
    l24: "Linux 2.4",
    l26: "Linux 2.6+",
    win7: "Windows 7/2008 R2",
    win8: "Windows 8/2012",
    win10: "Windows 10/2016/2019",
    win11: "Windows 11/2022",
    w2k: "Windows 2000",
    w2k3: "Windows Server 2003",
    w2k8: "Windows Server 2008",
    wvista: "Windows Vista",
    wxp: "Windows XP",
    solaris: "Solaris",
    other: "Other",
  };
  return normalizeGuestOsLabel(labels[ostype] ?? ostype.toUpperCase());
}

function normalizeUsername(username: string): string {
  return username.includes("@") ? username : `${username}@pam`;
}

function connectionKey(input: XenConnectionInput): string {
  return `proxmox:${input.host}:${input.port || DEFAULT_PROXMOX_PORT}`;
}

function clampPageSize(pageSize: number | undefined): number {
  if (!pageSize) return 100;
  return Math.min(Math.max(pageSize, 1), 500);
}

function bytesToGib(value: number): number {
  return Math.round((value / 1024 / 1024 / 1024) * 10) / 10;
}

function formatUptime(seconds: number | undefined): string {
  if (!seconds) return "";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  return `${days}d ${hours}h`;
}

function toProxmoxErrorMessage(statusCode: number, parsed: { errors?: unknown; data?: unknown }): string {
  const text = JSON.stringify(parsed.errors ?? parsed.data ?? "");
  if (statusCode === 401 || text.includes("authentication failure")) {
    return "Proxmox VE 账号或密码认证失败，请确认账号、密码和 realm。";
  }
  if (statusCode === 403 || text.includes("permission")) {
    return "Proxmox VE 账号权限不足，需要节点、存储和 VM 清单读取权限。";
  }
  const detail = Array.from(new Set(collectProxmoxErrorText(parsed.errors ?? parsed.data))).filter(Boolean).slice(0, 6).join("；");
  return detail ? `Proxmox VE API HTTP ${statusCode}：${detail}` : `Proxmox VE API HTTP ${statusCode}`;
}

function collectProxmoxErrorText(value: unknown): string[] {
  if (value == null) return [];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) return value.flatMap(collectProxmoxErrorText);
  if (typeof value === "object") return Object.entries(value).flatMap(([key, item]) => [key, ...collectProxmoxErrorText(item)]);
  return [];
}
