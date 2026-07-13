import { request as httpsRequest } from "node:https";
import { assessVmReclaim } from "./analysis/reclaimStateMachine.js";
import type { VirtualizationProvider } from "./providers/provider.js";
import { inferIpv4FromName, isManagedIpv4 } from "./runtimePolicy.js";
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
  VmActionResult,
  VmDisk,
  VmInventorySummary,
  VmNode,
  VmPowerAction,
  VmProvisionCreatedVm,
  VmProvisionRequest,
  VmProvisionResult,
  VmQuery,
  VmSnapshot,
  XenConnectionInput,
} from "./types.js";

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

export class ProxmoxProvider implements VirtualizationProvider<XenConnectionInput> {
  readonly type = "proxmox" as const;

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
    return configToDisks(config, vmId);
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

  async performVmAction(input: XenConnectionInput, vmId: string, action: VmPowerAction): Promise<VmActionResult> {
    const [node, id] = parseVmProviderId(vmId);
    if (!node || !id) {
      throw new Error(`Proxmox VE VM ID 不完整：${vmId}`);
    }
    const client = await ProxmoxClient.login(input);
    const status = await client.get<ProxmoxVmStatus>(`/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(id)}/status/current`);
    if (action === "start") {
      if (status.status === "running") throw new Error("虚拟机已在运行。");
      await client.post(`/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(id)}/status/start`);
    } else if (action === "shutdown") {
      if (status.status !== "running") throw new Error("虚拟机未运行，无需关机。");
      try {
        await client.post(`/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(id)}/status/shutdown`);
      } catch {
        await client.post(`/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(id)}/status/stop`);
        return {
          vmId,
          action,
          accepted: true,
          message: `关机完成：${vmId}`,
        };
      }
    } else {
      if (status.status === "running") throw new Error("虚拟机正在运行，请先关机后再删除。");
      await client.delete(`/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(id)}`);
    }
    return {
      vmId,
      action,
      accepted: true,
      message: `${proxmoxActionLabel(action)}已提交：${vmId}`,
    };
  }

  async createVms(input: XenConnectionInput, request: VmProvisionRequest): Promise<VmProvisionResult> {
    if (request.sourceType === "template") {
      return this.cloneCloudInitTemplates(input, request);
    }
    throw new Error("PVE ISO 模式只能进入安装界面，不能自动装好系统；一键安装请使用 cloud-init 克隆源策略。");
  }

  async cloneCloudInitTemplates(input: XenConnectionInput, request: VmProvisionRequest): Promise<VmProvisionResult> {
    const templateName = request.templateName?.trim();
    if (!templateName) throw new Error("PVE 一键安装需要选择 cloud-init 克隆源。");
    const client = await ProxmoxClient.login(input);
    const inventory = await collectInventory(input);
    const template = findProxmoxTemplate(inventory, templateName);
    if (!template) throw new Error(`未找到 PVE cloud-init 克隆源：${templateName}`);
    const targetNode = request.hostId || template.node;
    const storage = await pickProxmoxVmStorage(client, targetNode);
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

  async collectMetrics(_input: XenConnectionInput, _query: MetricQuery): Promise<MetricSample[]> {
    return [];
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
      storage: Array.from(inventory.storageByNode.values()).flat().map(toStorageRepository),
      networks: Array.from(inventory.networksByNode.entries()).flatMap(([node, networks]) => toNetworkInterfaces(node, networks)),
    };
  }
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

async function pickProxmoxNode(client: ProxmoxClient): Promise<string> {
  const nodes = await client.get<ProxmoxNode[]>("/nodes");
  return nodes.find((node) => node.status === "online")?.node ?? nodes[0]?.node ?? "";
}

async function pickProxmoxVmStorage(client: ProxmoxClient, node: string): Promise<string> {
  const storage = await client.get<ProxmoxStorage[]>(`/nodes/${encodeURIComponent(node)}/storage`);
  const candidates = storage.filter((item) => storageSupportsContent(item, "images") || storageSupportsContent(item, "rootdir"));
  const best = candidates.sort((left, right) => (right.avail ?? 0) - (left.avail ?? 0))[0];
  if (!best) throw new Error(`PVE 节点 ${node} 未找到支持 VM 磁盘的存储。`);
  return best.storage;
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

function toStorageRepository(item: ProxmoxStorage): StorageRepository {
  const total = item.total ?? 0;
  const used = item.used ?? 0;
  return {
    name: item.storage,
    type: item.type ?? "",
    physicalGiB: bytesToGib(total),
    usedGiB: bytesToGib(used),
    virtualGiB: bytesToGib(used),
    shared: item.shared === 1,
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
    hostId: node,
    name,
    powerState: vm.status === "running" ? "running" : vm.status === "stopped" ? "halted" : "unknown",
    cpuCount: vm.cpus ?? 0,
    memoryBytes: vm.maxmem ?? 0,
    diskVirtualBytes: vm.maxdisk ?? vm.disk ?? 0,
    diskCount: vm.maxdisk || vm.disk ? 1 : 0,
    diskSizeSummary: vm.maxdisk || vm.disk ? `${bytesToGib(vm.maxdisk ?? vm.disk ?? 0).toFixed(1)} GiB` : undefined,
    ipAddresses: inferredIp ? [inferredIp] : [],
    guestOs: normalizeProxmoxGuestOs(config?.ostype, name),
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

function configToDisks(config: ProxmoxVmConfig, vmId: string): VmDisk[] {
  return Object.entries(config)
    .filter(([key]) => /^(ide|sata|scsi|virtio)\d+$/.test(key))
    .map(([device, value]) => {
      const text = String(value ?? "");
      const size = parseDiskSize(text);
      return {
        id: `${vmId}:${device}`,
        vmId,
        providerId: `${vmId}:${device}`,
        name: device,
        device,
        virtualSizeBytes: size,
        storageRepository: text.split(":")[0] || undefined,
      };
    });
}

function parseVmProviderId(value: string): [string, string] {
  const parts = value.includes(":vm:") ? value.split(":vm:").pop()?.split(":") : value.split(":");
  return [parts?.[0] ?? "", parts?.[1] ?? ""];
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
  return {
    total,
    running: items.filter((vm) => vm.powerState === "running").length,
    halted: items.filter((vm) => vm.powerState === "halted").length,
    vcpu: items.reduce((sum, vm) => sum + vm.cpuCount, 0),
    memoryBytes: items.reduce((sum, vm) => sum + vm.memoryBytes, 0),
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

function normalizeProxmoxGuestOs(value: unknown, vmName?: string): string | undefined {
  const ostype = String(value ?? "").trim().toLowerCase();
  const inferred = inferGuestOsFromName(vmName);
  if (!ostype) return inferred;
  if (["l24", "l26", "other"].includes(ostype) && inferred) return inferred;
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
  return labels[ostype] ?? ostype.toUpperCase();
}

function inferGuestOsFromName(value?: string): string | undefined {
  const name = value?.toLowerCase() ?? "";
  if (!name) return undefined;
  if (name.includes("openeuler") || name.includes("open_euler") || name.includes("open-euler")) return "openEuler";
  if (name.includes("centos")) return "CentOS";
  if (name.includes("ubuntu")) return "Ubuntu";
  if (name.includes("debian")) return "Debian";
  if (name.includes("rocky")) return "Rocky Linux";
  if (name.includes("alma")) return "AlmaLinux";
  if (name.includes("kylin") || name.includes("麒麟")) return "Kylin";
  if (name.includes("windows server") || name.includes("winserver")) return "Windows Server";
  if (name.includes("windows") || /\bwin\d*/.test(name)) return "Windows";
  return undefined;
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
  return `Proxmox VE API HTTP ${statusCode}`;
}
