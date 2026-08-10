import { request as httpsRequest } from "node:https";
import { createReadStream, statSync } from "node:fs";
import { XMLParser } from "fast-xml-parser";
import { assessVmReclaim } from "./analysis/reclaimStateMachine.js";
import { getGeneratedIso, markGeneratedIsoStatus, markGeneratedIsoUploaded, registerGeneratedIso } from "./generatedIsoStore.js";
import type { VirtualizationProvider } from "./providers/provider.js";
import { inferIpv4FromName, isManagedIpv4 } from "./runtimePolicy.js";
import { buildDiagnosticRepairActions, concludeHostDiagnostics, formatBytes, percentOf, statusForPercent } from "./hostDiagnostics.js";
import { normalizeStorageCapacity } from "./storageCapacity.js";
import { describeStorageRepository } from "./storageRepositoryProfile.js";
import { ensureVmwareCentosBootFiles, generateVmwareCentosKickstartIso, removeLocalVmwareKickstartIso } from "./vmwareUnattendedIso.js";
import type {
  HostDiagnosticCheck,
  HostDiagnosticStatus,
  HostDiagnosticsRequest,
  HostDiagnosticsResult,
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

type XmlValue = any;

export interface ManagedRef {
  type: string;
  value: string;
}

interface ServiceContent {
  rootFolder: ManagedRef;
  propertyCollector: ManagedRef;
  sessionManager: ManagedRef;
  viewManager: ManagedRef;
  fileManager: ManagedRef;
  performanceManager: ManagedRef;
  aboutName: string;
  aboutFullName: string;
  apiVersion: string;
}

interface PropertyObject {
  ref: ManagedRef;
  props: Map<string, XmlValue>;
}

interface HostInventory {
  hosts: HostNode[];
  storage: StorageRepository[];
  networks: NetworkInterface[];
}

export interface VmwareDiskInfo {
  id: string;
  name: string;
  device: string;
  virtualSizeBytes: number;
  storageRepository?: string;
  key: number;
  controllerKey: number;
  unitNumber: number;
  backingFileName: string;
  diskMode: string;
  thinProvisioned: boolean;
  eagerlyScrub: boolean;
}

interface VmwarePerformanceCounter {
  id: number;
  multiplier: number;
}

interface VmwareNetworkCounterConfig {
  received: VmwarePerformanceCounter;
  transmitted: VmwarePerformanceCounter;
}

interface VmwareNetworkRates {
  receivedBytesPerSecond: number | null;
  transmittedBytesPerSecond: number | null;
}

interface VmwareIsoSearchResult {
  datastore: string;
  folderPath: string;
  path: string;
  sizeBytes?: number;
  modifiedAt?: string;
}

interface VmwareCreatePlacement {
  host: ManagedRef;
  resourcePool: ManagedRef;
  folder: ManagedRef;
  datastore: ManagedRef;
  datastoreName: string;
  datacenterName: string;
  network?: ManagedRef;
  networkName?: string;
}

type VmwareProvisionStrategyId = "template-clone" | "kickstart";

interface VmwareProvisionStrategy {
  id: VmwareProvisionStrategyId;
  execute(input: XenConnectionInput, request: VmProvisionRequest): Promise<VmProvisionResult>;
}

class VmwareProvisionStrategyRegistry {
  private readonly strategies = new Map<VmwareProvisionStrategyId, VmwareProvisionStrategy>();

  register(strategy: VmwareProvisionStrategy): void {
    this.strategies.set(strategy.id, strategy);
  }

  execute(strategyId: string, input: XenConnectionInput, request: VmProvisionRequest): Promise<VmProvisionResult> {
    const strategy = this.strategies.get(strategyId as VmwareProvisionStrategyId);
    if (!strategy) throw new Error(`VMware 暂不支持安装策略：${strategyId}`);
    return strategy.execute(input, request);
  }
}

const defaultVmwareStrategyBySource = new Map<VmProvisionRequest["sourceType"], VmwareProvisionStrategyId>([
  ["template", "template-clone"],
  ["iso", "kickstart"],
]);

const SOAP_NS = "urn:vim25";
const SOAP_TIMEOUT_MS = 60_000;
const DEFAULT_VMWARE_PORT = 443;
const VMWARE_PERFORMANCE_COUNTER_CACHE_MS = 60 * 60 * 1000;
const VMWARE_PERFORMANCE_COUNTER_RETRY_MS = 5 * 60 * 1000;

const vmwareNetworkCounterCache = new Map<string, { value: VmwareNetworkCounterConfig | null; expiresAtMs: number }>();

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  textNodeName: "#text",
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

export class VmwareProvider implements VirtualizationProvider<XenConnectionInput> {
  readonly type = "vmware" as const;
  private readonly provisionStrategies = new VmwareProvisionStrategyRegistry();

  constructor() {
    this.provisionStrategies.register({
      id: "template-clone",
      execute: (input, request) => this.cloneTemplates(input, request),
    });
    this.provisionStrategies.register({
      id: "kickstart",
      execute: (input, request) => this.installFromIso(input, request),
    });
  }

  async testConnection(input: XenConnectionInput) {
    const session = await VmwareSoapSession.login(input);
    try {
      return {
        ok: true,
        providerType: this.type,
        hostName: session.content.aboutFullName || session.content.aboutName || input.host,
        message: session.content.apiVersion ? `vSphere API ${session.content.apiVersion}` : undefined,
      };
    } finally {
      await session.logout();
    }
  }

  async listPools(input: XenConnectionInput): Promise<ResourcePool[]> {
    const connectionId = connectionKey(input);
    return [
      {
        id: `${connectionId}:standalone`,
        connectionId,
        providerId: "standalone",
        name: input.host,
        type: "standalone",
      },
    ];
  }

  async listHosts(input: XenConnectionInput, _scope: ProviderScope = {}): Promise<HostNode[]> {
    return (await this.collectHostInventory(input)).hosts;
  }

  async listHostSummary(input: XenConnectionInput, hostId: string): Promise<HostNode> {
    const host = (await this.listHosts(input)).find((item) => item.providerId === hostId || item.id === hostId);
    if (!host) {
      throw new Error(`未找到 VMware 物理机: ${hostId}`);
    }
    return host;
  }

  async summarizeVms(input: XenConnectionInput, query: VmQuery): Promise<VmInventorySummary> {
    const result = await this.listVms(input, { ...query, page: 1, pageSize: 500, keyword: undefined });
    return summarizeVmItems(result.items, result.total);
  }

  async listVms(input: XenConnectionInput, query: VmQuery): Promise<PagedResult<VmNode>> {
    const connectionId = connectionKey(input);
    const session = await VmwareSoapSession.login(input);
    try {
      const vmObjects = await session.retrieveContainerProperties("VirtualMachine", [
        "name",
        "config.uuid",
        "config.instanceUuid",
        "config.guestFullName",
        "config.guestId",
        "config.hardware.numCPU",
        "config.hardware.memoryMB",
        "config.hardware.device",
        "summary.config.numVirtualDisks",
        "summary.storage.committed",
        "summary.storage.uncommitted",
        "runtime.powerState",
        "runtime.host",
        "guest.ipAddress",
        "guest.net",
        "guest.guestFullName",
        "guest.guestId",
        "guest.toolsStatus",
      ]);
      const keyword = (query.keyword ?? "").trim().toLowerCase();
      const allItems = vmObjects
        .map((item) => toVmNode(item, connectionId))
        .filter((vm) => !query.hostId || vm.hostId === query.hostId)
        .filter((vm) => !keyword || vmMatchesKeyword(vm, keyword))
        .sort((left, right) => left.name.localeCompare(right.name, "zh-CN", { numeric: true, sensitivity: "base" }));
      const pageSize = clampPageSize(query.pageSize);
      const page = Math.max(query.page ?? 1, 1);
      const offset = (page - 1) * pageSize;
      return {
        items: allItems.slice(offset, offset + pageSize),
        page,
        pageSize,
        total: allItems.length,
      };
    } finally {
      await session.logout();
    }
  }

  async listVmDisks(input: XenConnectionInput, vmId: string): Promise<VmDisk[]> {
    const result = await this.listVms(input, { page: 1, pageSize: 500 });
    const vm = result.items.find((item) => item.providerId === vmId || item.id === vmId);
    const disks = (vm?.metadata?.disks as VmwareDiskInfo[] | undefined) ?? [];
    return disks.map((disk) => ({
      id: disk.id,
      vmId,
      providerId: disk.id,
      name: disk.name,
      device: disk.device,
      displayName: disk.device || disk.name || "虚拟硬盘",
      virtualSizeBytes: disk.virtualSizeBytes,
      storageRepositoryId: disk.storageRepository,
      storageRepository: disk.storageRepository,
      onlineResizeSupported: true,
      canOnlineResize: true,
      requiresShutdown: false,
      allowedModes: ["extend", "add"],
    }));
  }

  async listVirtualDisks(input: XenConnectionInput, scope: ProviderScope = {}): Promise<VirtualDisk[]> {
    const result = await this.listVms(input, { hostId: scope.hostId, page: 1, pageSize: 500 });
    return result.items.flatMap((vm) => {
      const disks = (vm.metadata?.disks as VmwareDiskInfo[] | undefined) ?? [];
      return disks.map((disk) => ({
        id: disk.id,
        providerId: disk.id,
        name: `${vm.name} / ${disk.name}`,
        storageRepository: disk.storageRepository ?? "",
        virtualSizeBytes: disk.virtualSizeBytes,
        physicalUtilisationBytes: 0,
        type: "vmdk",
        readOnly: false,
        managed: true,
      }));
    });
  }

  async listIsoImages(input: XenConnectionInput, _scope: ProviderScope = {}): Promise<IsoImage[]> {
    const session = await VmwareSoapSession.login(input);
    try {
      const datastores = await session.retrieveContainerProperties("Datastore", ["name", "browser", "summary.multipleHostAccess"]);
      const errors: string[] = [];
      const results = await Promise.all(
        datastores.map(async (datastore) => {
          const browser = readOptionalManagedRef(datastore.props.get("browser"));
          const datastoreName = textOf(datastore.props.get("name"));
          if (!browser || !datastoreName) return [];
          return session.searchIsoImages({ ...browser, type: "HostDatastoreBrowser" }, datastoreName).catch((error) => {
            errors.push(error instanceof Error ? error.message : `${datastoreName} ISO 搜索失败`);
            return [];
          });
        }),
      );
      const images = results
        .flat()
        .map((item) => ({
          id: `vmware:${item.datastore}:${item.path}`,
          providerId: `${item.datastore}:${item.path}`,
          name: item.path.split("/").pop() || item.path,
          storageRepository: item.datastore,
          path: item.folderPath ? `${item.folderPath}/${item.path}`.replace(/\/+/g, "/") : item.path,
          sizeBytes: item.sizeBytes ?? 0,
          shared: textOf(datastores.find((datastore) => textOf(datastore.props.get("name")) === item.datastore)?.props.get("summary.multipleHostAccess")) === "true",
          metadata: {
            modifiedAt: item.modifiedAt,
          },
        }))
        .sort((left, right) => {
          return `${left.storageRepository} ${left.name}`.localeCompare(`${right.storageRepository} ${right.name}`, "zh-CN", {
            numeric: true,
            sensitivity: "base",
          });
        });
      if (!images.length && errors.length && errors.length === datastores.length) {
        throw new Error(`VMware Datastore ISO 搜索失败：${errors[0]}`);
      }
      return images;
    } finally {
      await session.logout();
    }
  }

  async listVmSnapshots(input: XenConnectionInput, vmId: string): Promise<VmSnapshot[]> {
    const session = await VmwareSoapSession.login(input);
    try {
      const vmObjects = await session.retrieveContainerProperties("VirtualMachine", ["name", "snapshot.rootSnapshotList"]);
      const target = normalizeVmwareTargetId(vmId);
      const match = vmObjects.find((item) => vmwareProviderId(item) === target || item.ref.value === target);
      if (!match) throw new Error(`未找到 VMware 虚拟机：${vmId}`);
      return collectVmSnapshots(match.props.get("snapshot.rootSnapshotList"), vmId, vmwareProviderId(match));
    } finally {
      await session.logout();
    }
  }

  async performVmAction(input: XenConnectionInput, vmId: string, action: VmPowerAction, options?: VmActionOptions): Promise<VmActionResult> {
    const session = await VmwareSoapSession.login(input);
    try {
      const vm = (await this.listVms(input, { page: 1, pageSize: 500 })).items.find((item) => item.providerId === vmId || item.id === vmId);
      if (!vm) throw new Error(`未找到 VMware 虚拟机：${vmId}`);
      const vmMoid = typeof vm.metadata?.managedObjectId === "string" ? vm.metadata.managedObjectId : vm.providerId;
      let command = "";
      if (action === "start") {
        if (vm.powerState === "running") throw new Error("虚拟机已在运行。");
        await session.powerOnVm(vmMoid);
        command = `SOAP PowerOnVM_Task vm=${vmMoid}`;
      } else if (action === "shutdown") {
        if (vm.powerState !== "running") throw new Error("虚拟机未运行，无需关机。");
        const forceOnFailure = options?.forceOnShutdownFailure ?? true;
        try {
          if (vm.toolsStatus === "missing") {
            throw new Error("VMware Tools unavailable before guest shutdown");
          }
          await session.shutdownGuest(vmMoid);
          command = `SOAP ShutdownGuest vm=${vmMoid}`;
          const gracefullyPoweredOff = await session.waitForVmPowerState(vmMoid, "halted", options?.shutdownTimeoutMs ?? 18_000);
          if (!gracefullyPoweredOff) {
            if (!forceOnFailure) throw new Error("VMware 客户机关机超时，当前策略不允许强制关机。");
            await session.powerOffVm(vmMoid);
            command = `SOAP ShutdownGuest vm=${vmMoid}\nSOAP PowerOffVM_Task vm=${vmMoid}`;
          }
        } catch (error) {
          if (!isVmwareGuestShutdownUnavailable(error)) throw error;
          if (!forceOnFailure) throw new Error("VMware Tools 不可用，当前策略不允许强制关机。");
          await session.powerOffVm(vmMoid);
          command = `SOAP PowerOffVM_Task vm=${vmMoid}`;
        }
        return {
          vmId,
          action,
          accepted: true,
          command,
          message: `${vmwareActionLabel(action)}完成：${vm.name}`,
        };
      } else if (action === "forceReboot") {
        if (vm.powerState !== "running") throw new Error("虚拟机未运行，不能强制重启。");
        await session.powerOffVm(vmMoid);
        await session.powerOnVm(vmMoid);
        command = `SOAP PowerOffVM_Task vm=${vmMoid}\nSOAP PowerOnVM_Task vm=${vmMoid}`;
      } else {
        if (vm.powerState === "running") throw new Error("虚拟机正在运行，请先关机后再删除。");
        await session.destroyVm(vmMoid);
        command = `SOAP Destroy_Task vm=${vmMoid}`;
      }
      return {
        vmId,
        action,
        accepted: true,
        command,
        message: `${vmwareActionLabel(action)}完成：${vm.name}`,
      };
    } finally {
      await session.logout();
    }
  }

  async renameVm(input: XenConnectionInput, vmId: string, currentName: string, newName: string): Promise<VmRenameResult> {
    const normalized = normalizeVmRenameInput(this.type, currentName, newName);
    const session = await VmwareSoapSession.login(input);
    try {
      const vmObjects = await session.retrieveContainerProperties("VirtualMachine", ["name", "config.uuid", "config.instanceUuid", "parent"]);
      const vmObject = vmObjects.find((item) => vmwareProviderId(item) === vmId || item.ref.value === vmId);
      if (!vmObject) throw new Error(`未找到 VMware 虚拟机：${vmId}`);
      const actualName = textOf(vmObject.props.get("name"));
      assertVmRenameCurrentName(actualName, normalized.currentName);
      const parent = readOptionalManagedRef(vmObject.props.get("parent"));
      const duplicateFound = vmObjects.some((item) => {
        if (
          item.ref.value === vmObject.ref.value ||
          textOf(item.props.get("name")).toLocaleLowerCase("en-US") !== normalized.newName.toLocaleLowerCase("en-US")
        ) return false;
        const itemParent = readOptionalManagedRef(item.props.get("parent"));
        return parent?.value ? itemParent?.value === parent.value : true;
      });
      assertVmRenameNameAvailable(duplicateFound, "当前 VM 文件夹", normalized.newName);
      await session.renameVm(vmObject.ref.value, normalized.newName);
      return {
        vmId,
        previousName: actualName,
        newName: normalized.newName,
        accepted: true,
        message: `虚拟机名称已修改：${actualName} → ${normalized.newName}`,
      };
    } finally {
      await session.logout();
    }
  }

  async resizeVm(input: XenConnectionInput, vmId: string, request: VmResizeExecutionRequest): Promise<VmResizeResult> {
    const session = await VmwareSoapSession.login(input);
    let stopped = false;
    let restarted = false;
    let previousCpuCount = 0;
    let previousMemoryBytes = 0;
    let name = vmId;
    try {
      const vmObjects = await session.retrieveContainerProperties("VirtualMachine", [
        "name",
        "config.uuid",
        "config.instanceUuid",
        "config.hardware.numCPU",
        "config.hardware.memoryMB",
        "config.hardware.device",
        "runtime.powerState",
      ]);
      const vmObject = vmObjects.find((item) => vmwareProviderId(item) === normalizeVmwareTargetId(vmId) || item.ref.value === vmId);
      if (!vmObject) throw new Error(`未找到 VMware 虚拟机：${vmId}`);
      name = textOf(vmObject.props.get("name")) || vmId;
      previousCpuCount = numberOf(vmObject.props.get("config.hardware.numCPU"));
      previousMemoryBytes = numberOf(vmObject.props.get("config.hardware.memoryMB")) * 1024 * 1024;
      const currentDisks = collectVirtualDisks(vmObject.props.get("config.hardware.device"), normalizeVmwareTargetId(vmId));
      assertVmwareResizeIncrease("CPU", request.cpuCount, previousCpuCount);
      assertVmwareResizeIncrease("内存", request.memoryBytes, previousMemoryBytes);

      const powerState = normalizePowerState(textOf(vmObject.props.get("runtime.powerState")));
      const needsShutdown = powerState === "running" && Boolean(request.cpuCount || request.memoryBytes);
      if (needsShutdown && !request.allowShutdown) throw new Error("VMware 当前配置需要先关机才能调整 CPU 或内存。");
      if (needsShutdown) {
        await session.shutdownGuest(vmObject.ref.value);
        const poweredOff = await session.waitForVmPowerState(vmObject.ref.value, "halted", 60_000);
        if (!poweredOff) throw new Error("VMware 客户机正常关机超时，未执行扩容。请检查 VMware Tools 或先手动关机。");
        stopped = true;
      }

      const specParts: string[] = [];
      if (request.cpuCount) specParts.push(`<numCPUs>${Math.floor(request.cpuCount)}</numCPUs>`);
      if (request.memoryBytes) specParts.push(`<memoryMB>${Math.ceil(request.memoryBytes / 1024 / 1024)}</memoryMB>`);
      if (request.disk?.mode === "extend") {
        const disk = currentDisks.find((item) => item.id === request.disk?.diskId);
        if (!disk) throw new Error("VMware 扩展原盘失败：目标磁盘不属于当前虚拟机。");
        if (request.disk.sizeBytes < disk.virtualSizeBytes) throw new Error("不允许缩减 VMware 虚拟磁盘。");
        if (request.disk.sizeBytes > disk.virtualSizeBytes) {
          specParts.push(vmwareEditDiskSpec(disk, request.disk.sizeBytes));
        }
      } else if (request.disk?.mode === "add") {
        const storage = request.disk.storageRepositoryId?.trim();
        if (!storage) throw new Error("VMware 新增磁盘需要选择 Datastore。");
        specParts.push(vmwareAddDiskSpec(currentDisks, storage, request.disk.sizeBytes, request.disk.name));
      }
      if (!specParts.length && !request.allowNoop) throw new Error("没有需要执行的 VMware 扩容变更。");
      if (specParts.length) await session.reconfigureVm(vmObject.ref.value, specParts.join(""));

      if (stopped && request.restartAfterResize) {
        await session.powerOnVm(vmObject.ref.value);
        restarted = true;
      }
    } catch (error) {
      if (stopped && request.restartAfterResize && !restarted) {
        const vmObjects = await session.retrieveContainerProperties("VirtualMachine", ["config.uuid", "config.instanceUuid"]);
        const vmObject = vmObjects.find((item) => vmwareProviderId(item) === normalizeVmwareTargetId(vmId) || item.ref.value === vmId);
        if (vmObject) await session.powerOnVm(vmObject.ref.value).catch(() => undefined);
      }
      throw error;
    } finally {
      await session.logout();
    }

    const updated = (await this.listVms(input, { page: 1, pageSize: 500 })).items.find(
      (item) => item.providerId === normalizeVmwareTargetId(vmId) || item.id === vmId,
    );
    if (!updated) throw new Error("VMware 已执行扩容，但回读虚拟机配置失败。");
    return {
      vmId,
      name: updated.name || name,
      accepted: true,
      previousCpuCount,
      cpuCount: updated.cpuCount,
      previousMemoryBytes,
      memoryBytes: updated.memoryBytes,
      disks: await this.listVmDisks(input, vmId),
      stopped,
      restarted,
      message: `扩容完成：${updated.name || name}`,
    };
  }

  async createVms(input: XenConnectionInput, request: VmProvisionRequest): Promise<VmProvisionResult> {
    const strategyId = request.installStrategy || defaultVmwareStrategyBySource.get(request.sourceType);
    if (!strategyId) throw new Error(`VMware 未配置 ${request.sourceType} 对应的安装策略。`);
    return this.provisionStrategies.execute(strategyId, input, request);
  }

  async installFromIso(input: XenConnectionInput, request: VmProvisionRequest): Promise<VmProvisionResult> {
    if (!request.isoId) throw new Error("VMware 无人值守安装需要选择系统 ISO。");
    const images = await this.listIsoImages(input);
    const iso = images.find((item) => item.id === request.isoId || item.providerId === request.isoId);
    if (!iso) throw new Error(`未找到 VMware 系统 ISO：${request.isoName || request.isoId}`);
    if (!iso.name.toLowerCase().includes("centos-7")) {
      throw new Error("当前 VMware 无人值守安装仅支持 CentOS 7 ISO。");
    }
    const session = await VmwareSoapSession.login(input);
    const created: VmProvisionCreatedVm[] = [];
    try {
      const placement = await session.resolveCreatePlacement(request, iso);
      const bootFiles = await ensureVmwareCentosBootFiles({
        cacheKey: `${request.connectionId || input.host}|${iso.storageRepository}|${iso.path || iso.providerId}|${iso.sizeBytes || 0}`,
        readRange: (start, end) => session.readDatastoreRange(placement.datacenterName, iso.storageRepository, iso.path || iso.name, start, end),
      });
      for (const item of request.planItems) {
        const generated = await generateVmwareCentosKickstartIso({
          bootFiles,
          vm: item,
          ipPool: request.ipPool,
        });
        const remotePath = `ISOs/${generated.isoName}`;
        const registry = registerGeneratedIso({
          taskId: request.taskId || `vmware-${Date.now().toString(36)}`,
          providerType: "vmware",
          connectionId: request.connectionId,
          hostId: request.hostId,
          vmName: item.name,
          vmIp: item.ip,
          sourceIsoId: iso.id,
          sourceIsoName: iso.name,
          isoSrUuid: placement.datastoreName,
          isoName: generated.isoName,
          isoPath: remotePath,
        });
        try {
          await session.uploadDatastoreFile(placement.datacenterName, placement.datastoreName, remotePath, generated.localPath);
          markGeneratedIsoUploaded(registry.id, { isoVdiUuid: `${placement.datastoreName}:${remotePath}`, message: "VMware Kickstart ISO 已上传" });
          const bootIso: IsoImage = {
            id: `vmware:${placement.datastoreName}:${generated.isoName}`,
            providerId: `${placement.datastoreName}:${generated.isoName}`,
            name: generated.isoName,
            storageRepository: placement.datastoreName,
            path: remotePath,
          };
          const vmRef = await session.createIsoVm(placement, request, item, bootIso, iso);
          markGeneratedIsoStatus(registry.id, "attached", `已挂载到 ${item.name}`);
          if (request.autoStart) await session.powerOnVm(vmRef.value);
          created.push({
            id: vmRef.value,
            providerId: vmRef.value,
            name: item.name,
            powerState: request.autoStart ? "running" : "halted",
            ip: item.ip,
            generatedIsoRegistryId: registry.id,
          });
        } catch (error) {
          markGeneratedIsoStatus(registry.id, "failed", error instanceof Error ? error.message : "VMware 无人值守安装准备失败");
          await session.deleteDatastoreFile(placement.datacenterName, placement.datastoreName, remotePath).catch(() => undefined);
          throw error;
        } finally {
          removeLocalVmwareKickstartIso(generated.localPath);
        }
      }
      return {
        accepted: true,
        providerType: this.type,
        message: `VMware 无人值守安装已启动：${created.length} 台 VM`,
        created,
      };
    } finally {
      await session.logout();
    }
  }

  async cloneTemplates(input: XenConnectionInput, request: VmProvisionRequest): Promise<VmProvisionResult> {
    const templateName = request.templateName?.trim();
    if (!templateName) throw new Error("VMware 一键安装需要选择克隆源。");
    const session = await VmwareSoapSession.login(input);
    try {
      const template = await session.findTemplateVm(templateName);
      if (!template) throw new Error(`未找到 VMware 克隆源：${templateName}`);
      const placement = await session.resolveCreatePlacement(request);
      const created: VmProvisionCreatedVm[] = [];
      for (const item of request.planItems) {
        const vmRef = await session.cloneTemplateVm(template, placement, request, item);
        if (request.autoStart) {
          await session.powerOnVm(vmRef.value);
        }
        created.push({
          id: vmRef.value,
          providerId: vmRef.value,
          name: item.name,
          powerState: request.autoStart ? "running" : "halted",
          ip: item.ip,
        });
      }
      return {
        accepted: true,
        providerType: this.type,
        message: `VMware 模板安装任务已完成：${created.length} 台 VM`,
        created,
      };
    } finally {
      await session.logout();
    }
  }

  async collectMetrics(input: XenConnectionInput, query: MetricQuery): Promise<MetricSample[]> {
    if (query.targetType !== "vm" || query.targetIds.length === 0) return [];
    const connectionId = query.connectionId || connectionKey(input);
    const targetIds = new Set(query.targetIds.map(normalizeVmwareTargetId));
    const sampledAtMs = Date.now();
    const sampledAt = new Date(sampledAtMs).toISOString();
    const session = await VmwareSoapSession.login(input);
    try {
      const vmObjects = await session.retrieveContainerProperties("VirtualMachine", [
        "config.uuid",
        "config.instanceUuid",
        "config.hardware.numCPU",
        "config.hardware.memoryMB",
        "config.hardware.device",
        "runtime.maxCpuUsage",
        "summary.quickStats.overallCpuUsage",
        "summary.quickStats.guestMemoryUsage",
        "summary.quickStats.hostMemoryUsage",
        "summary.storage.committed",
        "summary.storage.uncommitted",
        "guest.disk",
        "guest.toolsStatus",
      ]);
      const matchedVms = vmObjects.flatMap((item) => {
        const providerId = vmwareProviderId(item);
        const targetId = targetIds.has(item.ref.value) ? item.ref.value : targetIds.has(providerId) ? providerId : "";
        return targetId ? [{ item, targetId }] : [];
      });
      const networkCounters = await resolveVmwareNetworkCounters(session, connectionId);
      const networkRates = networkCounters
        ? await session.queryVmNetworkRates(matchedVms.map(({ item }) => item.ref), networkCounters).catch(() => new Map())
        : new Map<string, VmwareNetworkRates>();
      return matchedVms.flatMap(({ item, targetId }) =>
        toVmwareMetricSamples(item, { connectionId, targetId, sampledAt, sampledAtMs }, networkRates.get(item.ref.value)),
      );
    } finally {
      await session.logout();
    }
  }

  async collectHostInventory(input: XenConnectionInput): Promise<HostInventory> {
    const connectionId = connectionKey(input);
    const session = await VmwareSoapSession.login(input);
    try {
      const [hostObjects, datastoreObjects] = await Promise.all([
        session.retrieveContainerProperties("HostSystem", [
          "name",
          "config.product.fullName",
          "summary.hardware.cpuModel",
          "summary.hardware.numCpuCores",
          "summary.hardware.numCpuPkgs",
          "summary.hardware.memorySize",
          "summary.quickStats.overallMemoryUsage",
          "summary.managementServerIp",
          "summary.config.name",
          "config.network.vnic",
          "config.virtualNicManagerInfo.netConfig",
          "runtime.connectionState",
        ]),
        session.retrieveContainerProperties("Datastore", [
          "name",
          "summary.capacity",
          "summary.freeSpace",
          "summary.type",
          "summary.accessible",
          "summary.multipleHostAccess",
        ]),
      ]);
      const hosts = hostObjects.map((item) => toHostNode(item, connectionId, input));
      if (hosts.length === 0) {
        throw new Error("未读取到 VMware 物理机信息，请确认账号有 vSphere 清单读取权限。");
      }
      return {
        hosts,
        storage: datastoreObjects.map(toStorageRepository),
        networks: hostObjects.flatMap(toVmwareNetworkInterfaces),
      };
    } finally {
      await session.logout();
    }
  }

  /**
   * 宿主机只读诊断（VMware vSphere）：通过 SOAP 只读属性采集宿主机负载、数据存储、
   * ESXi 服务、硬件传感器与 VMkernel 网络，可选携带 VM 线索补充链路检查。
   * 全部使用 RetrievePropertiesEx 只读查询，不执行任何变更操作。
   *
   * @param input vSphere 连接参数。
   * @param request 诊断请求；hostId 为 HostSystem 的 ManagedObjectReference（如 host-12），
   *                vmId 为 VM 的 config.uuid / instanceUuid / ManagedObjectReference。
   * @return 结构化诊断报告；supported 恒为 true。
   */
  async runHostDiagnostics(input: XenConnectionInput, request: HostDiagnosticsRequest): Promise<HostDiagnosticsResult> {
    const session = await VmwareSoapSession.login(input);
    try {
      const data = await session.retrieveHostDiagnostics(request.hostId, request.vmId);
      return buildVmwareHostDiagnostics(input, request, data);
    } finally {
      await session.logout();
    }
  }
}

interface VmwareDiagnosticsData {
  host?: {
    name: string;
    connectionState: string;
    productFullName?: string;
    cpuModel?: string;
    cpuUsageMhz?: number;
    cpuMhz?: number;
    numCpuCores?: number;
    memoryTotalBytes?: number;
    memoryUsageMb?: number;
    pnics: Array<{ device: string; linked: boolean }>;
    vmknicIps: string[];
  };
  datastores: Array<{
    name: string;
    capacityBytes?: number;
    freeSpaceBytes?: number;
    accessible: boolean;
    type?: string;
  }>;
  services: VmwareServiceData[];
  sensors: VmwareNumericSensorData[];
  storageStatus: VmwareStorageElementData[];
  vm?: VmwareVmLinkData;
}

interface VmwareServiceData {
  key: string;
  label: string;
  running: boolean;
  policy: string;
}

interface VmwareNumericSensorData {
  name: string;
  health: string;
  sensorType?: string;
  currentReading?: string;
  baseUnits?: string;
}

interface VmwareStorageElementData {
  name: string;
  health: string;
}

interface VmwareVmLinkData {
  name: string;
  powerState: string;
  toolsStatus: string;
  guestIp?: string;
  guestNics: Array<{ deviceName: string; network: string; connected: boolean; ipAddresses: string[] }>;
}

const VMWARE_CRITICAL_SERVICES = ["hostd", "vpxa", "ntpd", "slpd"];

const VMWARE_DIAGNOSTIC_REPAIR_SUGGESTIONS: Record<
  string,
  { label: string; description: string; scopeNote: string; commands: string[]; verificationCommands: string[] }
> = {
  "node-load": {
    label: "排查 CPU / 内存高负载",
    description: "定位占用 CPU / 内存的 VM，必要时在低峰期调整资源配额或迁移。",
    scopeNote: "以下命令仅用于排查与确认，调整资源需管理员在 vSphere 客户端或 API 上另行执行。",
    commands: ["esxtop -b -n 1", "esxcli system process list", "esxcli vm process list"],
    verificationCommands: ["esxtop -b -n 1 -d 5"],
  },
  "datastore-usage": {
    label: "清理数据存储空间",
    description: "对使用率偏高的数据存储清理快照、日志与不再使用的模板。",
    scopeNote: "清理操作会影响数据存储内容，执行前需确认目标文件可删除。",
    commands: ["esxcli storage filesystem list", "du -sh /vmfs/volumes/*", "vim-cmd vmsvc/snapshot.removeall <vmid>"],
    verificationCommands: ["df -h /vmfs/volumes/<datastore>"],
  },
  "storage-health": {
    label: "检查存储健康与设备状态",
    description: "对健康异常的存储设备执行状态核对与日志排查。",
    scopeNote: "esxcli 查询为只读操作，可安全执行；更换磁盘属于硬件变更操作。",
    commands: ["esxcli storage core device list", "esxcli storage health list"],
    verificationCommands: ["esxcli storage health list"],
  },
  "esx-services": {
    label: "恢复 ESXi 核心服务",
    description: "核心服务未运行时先查看状态与日志，确认后按需重启。",
    scopeNote: "重启服务会影响对应服务可用性，需在维护窗口执行。",
    commands: ["/etc/init.d/hostd status", "/etc/init.d/vpxa status", "/etc/init.d/ntpd status"],
    verificationCommands: ["/etc/init.d/hostd status"],
  },
  "sensor-health": {
    label: "核对硬件传感器告警",
    description: "查看温度 / 风扇 / 电压 / 电源等传感器详情，确认是否需要硬件维护。",
    scopeNote: "esxcli 查询为只读操作，可安全执行；更换硬件属于变更操作。",
    commands: ["esxcli hardware sensor list", "esxcli hardware status get"],
    verificationCommands: ["esxcli hardware sensor list"],
  },
  "network-vmk": {
    label: "检查 VMkernel 网络",
    description: "核对物理网卡链路与 VMkernel 地址配置。",
    scopeNote: "修改 vSphere 网络配置会影响管理网络与 VM 网络，需谨慎执行。",
    commands: ["esxcli network nic list", "esxcli network ip interface list", "esxcli network ip route ipv4 list"],
    verificationCommands: ["esxcli network ip interface list"],
  },
  "vm-link": {
    label: "核对 VM 网络连通",
    description: "确认 VM 网卡连接状态、Tools 与 IP 获取情况，必要时重新挂接网络。",
    scopeNote: "修改 VM 网络适配器需要 VM 停机或在维护窗口执行。",
    commands: ["vim-cmd vmsvc/get.summary <vmid>", "esxcli network vm list"],
    verificationCommands: ["esxcli network vm list"],
  },
};

/**
 * 由 VMware 只读证据生成诊断报告。纯函数，便于单元测试；不发起任何请求、不执行任何变更。
 *
 * @param input vSphere 连接参数（host 用于回退展示地址）。
 * @param request 诊断请求。
 * @param data retrieveHostDiagnostics 采集到的只读证据。
 * @return 结构化诊断报告。
 */
export function buildVmwareHostDiagnostics(
  input: XenConnectionInput,
  request: HostDiagnosticsRequest,
  data: VmwareDiagnosticsData,
): HostDiagnosticsResult {
  const checks: HostDiagnosticCheck[] = [];
  const findings: Array<{ key: string; label: string }> = [];
  const hostName = data.host?.name || input.host;
  const hostAddress = input.host;
  const formatPercentText = (value: number | null) => (value == null ? "未知" : `${Math.round(value)}%`);

  // 1. 宿主机负载：CPU / 内存 / 连接状态
  const connectionState = data.host?.connectionState ?? "";
  const connectionStatus: HostDiagnosticStatus =
    connectionState === "connected" ? "ok" :
    connectionState === "maintenance" ? "warn" :
    connectionState === "disconnected" || connectionState === "notResponding" ? "error" :
    "unknown";
  const cpuPercent =
    data.host?.cpuUsageMhz != null && data.host.cpuMhz && data.host.numCpuCores
      ? percentOf(data.host.cpuUsageMhz, data.host.cpuMhz * data.host.numCpuCores)
      : null;
  const memoryPercent = percentOf(
    data.host?.memoryUsageMb != null ? data.host.memoryUsageMb * 1024 * 1024 : undefined,
    data.host?.memoryTotalBytes,
  );
  const loadStatuses = [connectionStatus, statusForPercent(cpuPercent), statusForPercent(memoryPercent)];
  const loadStatus: HostDiagnosticStatus = loadStatuses.includes("error") ? "error" : loadStatuses.includes("warn") ? "warn" : loadStatuses.includes("unknown") ? "unknown" : "ok";
  checks.push({
    key: "node-load",
    label: "宿主机负载",
    category: "system",
    scope: "host",
    status: loadStatus,
    summary:
      loadStatus === "ok" ? "CPU / 内存 / 连接状态正常" :
      loadStatus === "unknown" ? "未读取到宿主机负载数据" :
      connectionStatus === "error" ? "宿主机连接状态异常" :
      connectionStatus === "warn" ? "宿主机处于维护模式" :
      "CPU / 内存存在高负载项",
    evidence: [
      `CPU ${formatPercentText(cpuPercent)} · 内存 ${formatPercentText(memoryPercent)}`,
      `连接状态：${connectionState || "未知"}`,
      ...(data.host?.cpuModel ? [`CPU 型号：${data.host.cpuModel}`] : []),
      ...(data.host?.productFullName ? [`系统：${data.host.productFullName}`] : []),
    ],
    detail: loadStatus === "ok" ? undefined : "宿主机 CPU / 内存长期高负载或连接异常会直接影响 VM 性能与可用性。",
  });
  if (loadStatus === "error" || loadStatus === "warn") findings.push({ key: "node-load", label: "宿主机负载" });

  // 2. 数据存储空间：容量使用率与可访问性
  const datastoreUsage = data.datastores.map((ds) => ({
    ds,
    percent: percentOf(
      ds.capacityBytes != null && ds.freeSpaceBytes != null ? ds.capacityBytes - ds.freeSpaceBytes : undefined,
      ds.capacityBytes,
    ),
  }));
  const inaccessibleCount = data.datastores.filter((ds) => !ds.accessible).length;
  const maxUsage = datastoreUsage.reduce((max, item) => Math.max(max, item.percent ?? 0), 0);
  const hasUsage = datastoreUsage.some((item) => item.percent != null);
  let datastoreStatus: HostDiagnosticStatus = "unknown";
  if (data.datastores.length === 0) datastoreStatus = "unknown";
  else if (inaccessibleCount > 0) datastoreStatus = "error";
  else if (!hasUsage) datastoreStatus = "unknown";
  else if (maxUsage >= 95) datastoreStatus = "error";
  else if (maxUsage >= 85) datastoreStatus = "warn";
  else datastoreStatus = "ok";
  checks.push({
    key: "datastore-usage",
    label: "数据存储空间",
    category: "storage",
    scope: "host",
    status: datastoreStatus,
    summary:
      datastoreStatus === "ok" ? `${data.datastores.length} 个数据存储使用正常` :
      datastoreStatus === "error" && inaccessibleCount > 0 ? `${inaccessibleCount} 个数据存储不可访问` :
      datastoreStatus === "error" ? "存在使用率超过 95% 的数据存储" :
      datastoreStatus === "warn" ? "存在使用率超过 85% 的数据存储" :
      "未读取到数据存储信息",
    evidence:
      data.datastores.length === 0
        ? ["未读取到 Datastore 数据"]
        : datastoreUsage.map(({ ds, percent }) => `${ds.name || "未知存储"} · ${ds.type || "未知类型"} · ${percent == null ? "使用率未知" : `${Math.round(percent)}%`} · 可用 ${formatBytes(ds.freeSpaceBytes ?? 0)} · ${ds.accessible ? "可访问" : "不可访问"}`),
    detail: datastoreStatus === "ok" ? undefined : "数据存储使用率过高或不可访问会影响 VM 磁盘读写与迁移，需优先处理。",
  });
  if (datastoreStatus === "error" || datastoreStatus === "warn") findings.push({ key: "datastore-usage", label: "数据存储空间" });

  // 3. 存储健康：硬件存储设备告警状态
  const redStorage = data.storageStatus.filter((item) => item.health === "red");
  const yellowStorage = data.storageStatus.filter((item) => item.health === "yellow" || item.health === "gray");
  let storageHealthStatus: HostDiagnosticStatus = "unknown";
  if (data.storageStatus.length === 0) storageHealthStatus = "unknown";
  else if (redStorage.length > 0) storageHealthStatus = "error";
  else if (yellowStorage.length > 0) storageHealthStatus = "warn";
  else storageHealthStatus = "ok";
  checks.push({
    key: "storage-health",
    label: "存储健康",
    category: "storage",
    scope: "host",
    status: storageHealthStatus,
    summary:
      storageHealthStatus === "ok" ? "存储硬件健康正常" :
      storageHealthStatus === "error" ? `${redStorage.length} 个存储设备健康异常` :
      storageHealthStatus === "warn" ? `${yellowStorage.length} 个存储设备状态待确认` :
      "未读取到存储健康数据",
    evidence:
      data.storageStatus.length === 0
        ? ["runtime.healthSystemRuntime.hardwareStatusInfo 未返回存储健康数据"]
        : data.storageStatus.map((item) => `${item.name || "未知设备"} · ${item.health || "未知"}`),
    detail: storageHealthStatus === "ok" ? undefined : "存储健康异常（如磁盘 / 控制器告警）会影响数据可用性，建议在 vSphere 客户端或 esxcli 侧核对。",
  });
  if (storageHealthStatus === "error" || storageHealthStatus === "warn") findings.push({ key: "storage-health", label: "存储健康" });

  // 4. ESXi 核心服务
  const serviceByName = new Map(data.services.map((item) => [item.key, item]));
  const presentCritical = VMWARE_CRITICAL_SERVICES.filter((key) => serviceByName.has(key));
  const stoppedCritical = presentCritical.filter((key) => !serviceByName.get(key)?.running);
  let serviceStatus: HostDiagnosticStatus = "unknown";
  if (data.services.length === 0) serviceStatus = "unknown";
  else if (stoppedCritical.length > 0) serviceStatus = "error";
  else serviceStatus = "ok";
  checks.push({
    key: "esx-services",
    label: "ESXi 核心服务",
    category: "service",
    scope: "host",
    status: serviceStatus,
    summary:
      serviceStatus === "ok" ? "ESXi 核心服务运行正常" :
      serviceStatus === "error" ? `${stoppedCritical.length} 个核心服务未运行` :
      "未读取到 ESXi 服务状态",
    evidence:
      data.services.length === 0
        ? ["configManager.serviceSystem.serviceInfo 未返回服务数据"]
        : [
            ...presentCritical.map((key) => {
              const service = serviceByName.get(key);
              return `${service?.label || key} · ${service?.running ? "运行中" : "未运行"}`;
            }),
            `服务总数：${data.services.length}`,
          ],
    detail: serviceStatus === "ok" ? undefined : "hostd / vpxa / ntpd 等核心服务未运行会影响 ESXi 管理面与时间同步。",
  });
  if (serviceStatus === "error") findings.push({ key: "esx-services", label: "ESXi 核心服务" });

  // 5. 硬件传感器：温度 / 风扇 / 电压 / 电源等
  const redSensors = data.sensors.filter((item) => item.health === "red");
  const yellowSensors = data.sensors.filter((item) => item.health === "yellow" || item.health === "gray");
  let sensorStatus: HostDiagnosticStatus = "unknown";
  if (data.sensors.length === 0) sensorStatus = "unknown";
  else if (redSensors.length > 0) sensorStatus = "error";
  else if (yellowSensors.length > 0) sensorStatus = "warn";
  else sensorStatus = "ok";
  checks.push({
    key: "sensor-health",
    label: "硬件传感器",
    category: "system",
    scope: "host",
    status: sensorStatus,
    summary:
      sensorStatus === "ok" ? `${data.sensors.length} 项硬件传感器正常` :
      sensorStatus === "error" ? `${redSensors.length} 项硬件传感器告警` :
      sensorStatus === "warn" ? `${yellowSensors.length} 项硬件传感器状态待确认` :
      "未读取到硬件传感器数据",
    evidence:
      data.sensors.length === 0
        ? ["runtime.healthSystemRuntime.systemHealthInfo 未返回传感器数据"]
        : [
            `传感器总数：${data.sensors.length}`,
            ...data.sensors
              .filter((item) => item.health && item.health !== "green")
              .slice(0, 20)
              .map((item) => `${item.name || "未知传感器"} · ${item.health || "未知"}`),
          ],
    detail: sensorStatus === "ok" ? undefined : "硬件传感器（温度 / 风扇 / 电压 / 电源等）告警可能预示硬件故障，建议在 vSphere 客户端查看告警详情。",
  });
  if (sensorStatus === "error" || sensorStatus === "warn") findings.push({ key: "sensor-health", label: "硬件传感器" });

  // 6. VMkernel 网络：物理网卡链路与 vmk 地址
  const pnics = data.host?.pnics ?? [];
  const vmknicIps = data.host?.vmknicIps ?? [];
  let networkStatus: HostDiagnosticStatus = "unknown";
  if (pnics.length === 0 && vmknicIps.length === 0) networkStatus = "unknown";
  else if (pnics.length > 0 && !pnics.some((item) => item.linked)) networkStatus = "error";
  else if (vmknicIps.length === 0) networkStatus = "warn";
  else networkStatus = "ok";
  checks.push({
    key: "network-vmk",
    label: "VMkernel 网络",
    category: "network",
    scope: "host",
    status: networkStatus,
    summary:
      networkStatus === "ok" ? `${pnics.length} 个物理网卡 · ${vmknicIps.length} 个 VMkernel 地址` :
      networkStatus === "error" ? "物理网卡均未连接链路" :
      networkStatus === "warn" ? "未读取到 VMkernel 地址" :
      "未读取到网络信息",
    evidence: [
      ...(pnics.length === 0 ? ["未返回物理网卡（pnic）数据"] : pnics.map((item) => `${item.device || "未知网卡"} · ${item.linked ? "链路已连接" : "链路断开"}`)),
      ...(vmknicIps.length === 0 ? ["未返回 VMkernel 地址"] : [`VMkernel 地址：${vmknicIps.join("、")}`]),
    ],
    detail: networkStatus === "ok" ? undefined : "物理网卡链路断开或 VMkernel 地址缺失会导致宿主机管理网络与 VM 网络不可用。",
  });
  if (networkStatus === "error" || networkStatus === "warn") findings.push({ key: "network-vmk", label: "VMkernel 网络" });

  // 7. VM 网络链路（仅携带 VM 线索时）
  if (data.vm) {
    const connectedNicsWithIp = data.vm.guestNics.filter((nic) => nic.connected && nic.ipAddresses.length > 0).length;
    const toolsReady = data.vm.toolsStatus === "toolsOk";
    let vmLinkStatus: HostDiagnosticStatus = "unknown";
    if (data.vm.powerState !== "poweredOn") vmLinkStatus = "warn";
    else if (!toolsReady) vmLinkStatus = "warn";
    else if (connectedNicsWithIp === 0) vmLinkStatus = "warn";
    else vmLinkStatus = "ok";
    checks.push({
      key: "vm-link",
      label: "VM 网络连通",
      category: "network",
      scope: "vm-link",
      status: vmLinkStatus,
      summary:
        vmLinkStatus === "ok" ? `${connectedNicsWithIp} 个网卡已连接且获取到 IP` :
        vmLinkStatus === "warn" && data.vm.powerState !== "poweredOn" ? "VM 未运行，无法验证网络" :
        vmLinkStatus === "warn" ? "VM 网卡未全部连接或未获取到 IP" :
        "未读取到该 VM 网络信息",
      evidence: [
        `VM 状态：${data.vm.powerState || "未知"}`,
        `Tools 状态：${data.vm.toolsStatus || "未知"}`,
        ...(data.vm.guestIp ? [`Guest IP：${data.vm.guestIp}`] : []),
        `网卡：${data.vm.guestNics.map((nic) => `${nic.deviceName || "未知网卡"} · ${nic.connected ? "已连接" : "未连接"} · ${nic.ipAddresses.join("/") || "无 IP"}`).join("；") || "未返回网卡"}`,
      ],
      detail: vmLinkStatus === "ok" ? undefined : "VM 网卡未连接或未获取 IP 时该 VM 会失去网络，需在 vSphere 客户端核对网络适配器与 Tools 状态。",
    });
    if (vmLinkStatus === "warn") findings.push({ key: "vm-link", label: "VM 网络连通" });
  }

  const conclusion = concludeHostDiagnostics(checks);
  return {
    collectedAt: new Date().toISOString(),
    providerType: "vmware",
    supported: true,
    hostId: request.hostId,
    hostName,
    hostAddress,
    vmId: request.vmId,
    vmName: request.vmName,
    vmIp: request.vmIp,
    conclusion,
    checks,
    repairActions: buildDiagnosticRepairActions(findings, VMWARE_DIAGNOSTIC_REPAIR_SUGGESTIONS),
  };
}

export async function cleanupRegisteredVmwareGeneratedIso(input: XenConnectionInput, registryId: string): Promise<void> {
  const record = getGeneratedIso(registryId);
  if (!record) throw new Error(`未找到生成 ISO 登记记录：${registryId}`);
  if (record.providerType !== "vmware") throw new Error(`生成 ISO 不是 VMware 类型：${registryId}`);
  if (!record.isoName.startsWith("vrc-") || !record.isoName.endsWith(".iso")) {
    throw new Error("登记文件不是受管的 VMware 临时 ISO，拒绝删除。");
  }
  const session = await VmwareSoapSession.login(input);
  try {
    await session.removeVmCdromsByName(record.vmName);
    await session.deleteDatastoreFileTask(record.isoSrUuid, record.isoPath);
    markGeneratedIsoStatus(registryId, "deleted", "VMware 临时 Kickstart ISO 已清理");
  } finally {
    await session.logout();
  }
}

export async function verifyVmwareGuestTools(input: XenConnectionInput, vmId: string, timeoutMs = 120_000): Promise<void> {
  const normalizedTarget = normalizeVmwareTargetId(vmId);
  const session = await VmwareSoapSession.login(input);
  try {
    const deadline = Date.now() + timeoutMs;
    let lastStatus = "unknown";
    while (Date.now() < deadline) {
      const vmObjects = await session.retrieveContainerProperties("VirtualMachine", ["config.uuid", "config.instanceUuid", "guest.toolsStatus"]);
      const matched = vmObjects.find((item) => vmwareProviderId(item) === normalizedTarget || item.ref.value === vmId);
      if (!matched) throw new Error(`VMware 未找到待验证 VM：${vmId}`);
      lastStatus = textOf(matched.props.get("guest.toolsStatus")) || "unknown";
      if (normalizeToolsStatus(lastStatus) === "installed") return;
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
    throw new Error(`VMware 未回报 Tools 运行状态，当前状态：${lastStatus}`);
  } finally {
    await session.logout();
  }
}

export class VmwareSoapSession {
  private cookie = "";

  private constructor(
    private readonly input: XenConnectionInput,
    readonly content: ServiceContent,
  ) {}

  static async login(input: XenConnectionInput): Promise<VmwareSoapSession> {
    const bootstrap = new VmwareSoapSession(input, await retrieveServiceContent(input));
    await bootstrap.call("Login", `
      <Login xmlns="${SOAP_NS}">
        ${managedRefXml("_this", bootstrap.content.sessionManager)}
        <userName>${escapeXml(input.username)}</userName>
        <password>${escapeXml(input.password)}</password>
      </Login>
    `);
    return bootstrap;
  }

  async logout(): Promise<void> {
    try {
      await this.call("Logout", `
        <Logout xmlns="${SOAP_NS}">
          ${managedRefXml("_this", this.content.sessionManager)}
        </Logout>
      `);
    } catch {
      // Logout only cleans the VMware API session. Inventory reads have already completed.
    }
  }

  async retrieveContainerProperties(type: string, paths: string[]): Promise<PropertyObject[]> {
    const view = await this.createContainerView(type);
    const objects: PropertyObject[] = [];
    let response = await this.retrieveProperties(view, type, paths);
    objects.push(...parsePropertyObjects(response));
    let token = textOf(response?.returnval?.token);
    while (token) {
      response = await this.continueRetrieveProperties(token);
      objects.push(...parsePropertyObjects(response));
      token = textOf(response?.returnval?.token);
    }
    return objects;
  }


  /**
   * 只读采集宿主机诊断证据（VMware vSphere）：返回结构化数据，供 buildVmwareHostDiagnostics 生成报告。
   * 仅使用 RetrievePropertiesEx 只读查询，不调用任何会改变状态的接口。
   *
   * @param hostId HostSystem 的 ManagedObjectReference（如 host-12）；为空时取清单中第一个宿主机。
   * @param vmId 可选的 VM 标识（config.uuid / instanceUuid / ManagedObjectReference），用于补充链路检查。
   * @return 结构化诊断证据；宿主机不存在时 host 为 undefined。
   */
  async retrieveHostDiagnostics(hostId?: string, vmId?: string): Promise<VmwareDiagnosticsData> {
    const hostObjects = await this.retrieveContainerProperties("HostSystem", [
      "name",
      "config.product.fullName",
      "summary.hardware.cpuModel",
      "summary.hardware.cpuMhz",
      "summary.hardware.numCpuCores",
      "summary.hardware.memorySize",
      "summary.quickStats.overallCpuUsage",
      "summary.quickStats.overallMemoryUsage",
      "summary.managementServerIp",
      "runtime.connectionState",
      "config.network.vnic",
      "config.network.pnic",
      "config.virtualNicManagerInfo.netConfig",
      "configManager.serviceSystem",
      "runtime.healthSystemRuntime",
    ]);
    const host = hostObjects.find((item) => item.ref.value === hostId) ?? hostObjects[0];
    const datastoreObjects = await this.retrieveContainerProperties("Datastore", [
      "name",
      "summary.capacity",
      "summary.freeSpace",
      "summary.accessible",
      "summary.type",
    ]);
    const [services, healthData, vm] = await Promise.all([
      host ? this.retrieveServiceData(host.props.get("configManager.serviceSystem")) : [],
      host ? this.retrieveHealthData(host.props.get("runtime.healthSystemRuntime")) : { sensors: [], storageStatus: [] },
      vmId ? this.retrieveVmLinkData(vmId) : undefined,
    ]);
    return {
      host: host
        ? {
            name: textOf(host.props.get("name")),
            connectionState: textOf(host.props.get("runtime.connectionState")),
            productFullName: textOf(host.props.get("config.product.fullName")),
            cpuModel: textOf(host.props.get("summary.hardware.cpuModel")),
            cpuUsageMhz: numberOf(host.props.get("summary.quickStats.overallCpuUsage")) || undefined,
            cpuMhz: numberOf(host.props.get("summary.hardware.cpuMhz")) || undefined,
            numCpuCores: numberOf(host.props.get("summary.hardware.numCpuCores")) || undefined,
            memoryTotalBytes: numberOf(host.props.get("summary.hardware.memorySize")) || undefined,
            memoryUsageMb: numberOf(host.props.get("summary.quickStats.overallMemoryUsage")) || undefined,
            pnics: toArray(host.props.get("config.network.pnic")).map((pnic) => ({
              device: textOf(pnic?.device),
              linked: Boolean(pnic?.linkSpeed),
            })),
            vmknicIps: collectVmkernelIps(host.props.get("config.network.vnic"), host.props.get("config.virtualNicManagerInfo.netConfig")),
          }
        : undefined,
      datastores: datastoreObjects.map((item) => ({
        name: textOf(item.props.get("name")),
        capacityBytes: numberOf(item.props.get("summary.capacity")) || undefined,
        freeSpaceBytes: numberOf(item.props.get("summary.freeSpace")) || undefined,
        accessible: textOf(item.props.get("summary.accessible")) !== "false",
        type: textOf(item.props.get("summary.type")),
      })),
      services,
      sensors: healthData.sensors,
      storageStatus: healthData.storageStatus,
      vm,
    };
  }

  private async retrieveServiceData(serviceSystemValue: XmlValue): Promise<VmwareServiceData[]> {
    const ref = readOptionalManagedRefAs(serviceSystemValue, "HostServiceSystem");
    if (!ref) return [];
    const [serviceObject] = await this.retrieveObjectProperties(ref, ["serviceInfo.services"]).catch(() => []);
    return toArray(serviceObject?.props.get("serviceInfo.services")).map((service) => ({
      key: textOf(service?.key),
      label: textOf(service?.label),
      running: textOf(service?.running) === "true",
      policy: textOf(service?.policy),
    }));
  }

  private async retrieveHealthData(healthSystemValue: XmlValue): Promise<{ sensors: VmwareNumericSensorData[]; storageStatus: VmwareStorageElementData[] }> {
    const ref = readOptionalManagedRefAs(healthSystemValue, "HealthSystemRuntime");
    if (!ref) return { sensors: [], storageStatus: [] };
    const [healthObject] = await this.retrieveObjectProperties(ref, ["systemHealthInfo.numericSensor", "hardwareStatusInfo"]).catch(() => []);
    const sensors = toArray(healthObject?.props.get("systemHealthInfo.numericSensor")).map((sensor) => ({
      name: textOf(sensor?.name),
      health: textOf(sensor?.healthState?.key) || textOf(sensor?.healthState),
      sensorType: textOf(sensor?.sensorType),
      currentReading: textOf(sensor?.currentReading),
      baseUnits: textOf(sensor?.baseUnits),
    }));
    const hardwareStatus = healthObject?.props.get("hardwareStatusInfo");
    const storageStatus = toArray(hardwareStatus?.storageStatusInfo).map((item) => ({
      name: textOf(item?.name),
      health: textOf(item?.healthState?.key) || textOf(item?.healthState),
    }));
    return { sensors, storageStatus };
  }

  private async retrieveVmLinkData(vmId: string): Promise<VmwareVmLinkData | undefined> {
    const vmObjects = await this.retrieveContainerProperties("VirtualMachine", [
      "name",
      "config.uuid",
      "config.instanceUuid",
      "runtime.powerState",
      "guest.toolsStatus",
      "guest.net",
      "guest.ipAddress",
    ]);
    const target = normalizeVmwareTargetId(vmId);
    const vm = vmObjects.find((item) => vmwareProviderId(item) === target || item.ref.value === vmId);
    if (!vm) return undefined;
    return {
      name: textOf(vm.props.get("name")),
      powerState: textOf(vm.props.get("runtime.powerState")),
      toolsStatus: textOf(vm.props.get("guest.toolsStatus")),
      guestIp: textOf(vm.props.get("guest.ipAddress")),
      guestNics: toArray(vm.props.get("guest.net")).map((nic) => ({
        deviceName: textOf(nic?.deviceName),
        network: textOf(nic?.network),
        connected: textOf(nic?.connected) === "true",
        ipAddresses: toArray(nic?.ipAddress).map((ip) => textOf(ip)).filter(Boolean),
      })),
    };
  }

  async getPerformanceCounters(): Promise<XmlValue> {
    if (!this.content.performanceManager.value) return undefined;
    const [performanceManager] = await this.retrieveObjectProperties(this.content.performanceManager, ["perfCounter"]);
    return performanceManager?.props.get("perfCounter");
  }

  async queryVmNetworkRates(
    vmRefs: ManagedRef[],
    counters: VmwareNetworkCounterConfig,
  ): Promise<Map<string, VmwareNetworkRates>> {
    if (!this.content.performanceManager.value || vmRefs.length === 0) return new Map();
    const response = await this.call("QueryPerf", `
      <QueryPerf xmlns="${SOAP_NS}">
        ${managedRefXml("_this", this.content.performanceManager)}
        ${vmRefs.map((vmRef) => `
          <querySpec>
            ${managedRefXml("entity", { ...vmRef, type: "VirtualMachine" })}
            <maxSample>1</maxSample>
            <metricId><counterId>${counters.received.id}</counterId><instance>*</instance></metricId>
            <metricId><counterId>${counters.transmitted.id}</counterId><instance>*</instance></metricId>
            <intervalId>20</intervalId>
          </querySpec>
        `).join("")}
      </QueryPerf>
    `);
    return parseVmwareNetworkRates(response?.returnval, counters);
  }

  async resolveDatacenterName(): Promise<string> {
    const datacenters = await this.retrieveContainerProperties("Datacenter", ["name"]);
    return textOf(datacenters[0]?.props.get("name")) || "ha-datacenter";
  }

  async removeVmCdromsByName(vmName: string): Promise<void> {
    const vms = await this.retrieveContainerProperties("VirtualMachine", ["name", "config.hardware.device"]);
    const vm = vms.find((item) => textOf(item.props.get("name")) === vmName);
    if (!vm) return;
    const cdroms = collectVirtualCdroms(vm.props.get("config.hardware.device")).filter((item) => item.fileName);
    if (!cdroms.length) return;
    const response = await this.call("ReconfigVM_Task", `
      <ReconfigVM_Task xmlns="${SOAP_NS}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        ${managedRefXml("_this", { type: "VirtualMachine", value: vm.ref.value })}
        <spec>
          ${cdroms.map((cdrom) => `<deviceChange><operation>edit</operation><device xsi:type="VirtualCdrom"><key>${cdrom.key}</key><deviceInfo><label>${escapeXml(cdrom.label)}</label><summary>Remote device</summary></deviceInfo><backing xsi:type="VirtualCdromRemotePassthroughBackingInfo"><deviceName></deviceName><useAutoDetect>true</useAutoDetect><exclusive>false</exclusive></backing><connectable><startConnected>false</startConnected><allowGuestControl>true</allowGuestControl><connected>false</connected></connectable><controllerKey>${cdrom.controllerKey}</controllerKey><unitNumber>${cdrom.unitNumber}</unitNumber></device></deviceChange>`).join("")}
        </spec>
      </ReconfigVM_Task>
    `);
    await this.waitForTaskResult({ ...readManagedRef(response?.returnval), type: "Task" });
  }

  async reconfigureVm(vmMoid: string, specXml: string): Promise<void> {
    const response = await this.call("ReconfigVM_Task", `
      <ReconfigVM_Task xmlns="${SOAP_NS}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        ${managedRefXml("_this", { type: "VirtualMachine", value: vmMoid })}
        <spec>${specXml}</spec>
      </ReconfigVM_Task>
    `);
    await this.waitForTaskResult({ ...readManagedRef(response?.returnval), type: "Task" });
  }

  async deleteDatastoreFileTask(datastoreName: string, datastorePath: string): Promise<void> {
    const datacenters = await this.retrieveContainerProperties("Datacenter", ["name"]);
    const datacenter = datacenters[0]?.ref;
    const response = await this.call("DeleteDatastoreFile_Task", `
      <DeleteDatastoreFile_Task xmlns="${SOAP_NS}">
        ${managedRefXml("_this", this.content.fileManager)}
        <name>[${escapeXml(datastoreName)}] ${escapeXml(datastorePath)}</name>
        ${datacenter ? managedRefXml("datacenter", { type: "Datacenter", value: datacenter.value }) : ""}
      </DeleteDatastoreFile_Task>
    `);
    try {
      await this.waitForTaskResult({ ...readManagedRef(response?.returnval), type: "Task" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/FileNotFound|was not found/i.test(message)) return;
      throw error;
    }
  }

  async acquireWebMksTicket(vmMoid: string): Promise<string> {
    const response = await this.call("AcquireTicket", `
      <AcquireTicket xmlns="${SOAP_NS}">
        ${managedRefXml("_this", { type: "VirtualMachine", value: vmMoid })}
        <ticketType>webmks</ticketType>
      </AcquireTicket>
    `);
    const ticket = textOf(response?.returnval?.ticket);
    if (!ticket) {
      throw new Error("VMware 未返回 WebMKS 控制台 ticket，请确认 VM 正在运行且账号有控制台权限。");
    }
    return ticket;
  }

  async searchIsoImages(browser: ManagedRef, datastoreName: string): Promise<VmwareIsoSearchResult[]> {
    const response = await this.call("SearchDatastoreSubFolders_Task", `
      <SearchDatastoreSubFolders_Task xmlns="${SOAP_NS}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        ${managedRefXml("_this", browser)}
        <datastorePath>[${escapeXml(datastoreName)}]</datastorePath>
        <searchSpec>
          <details>
            <fileType>true</fileType>
            <fileSize>true</fileSize>
            <modification>true</modification>
            <fileOwner>false</fileOwner>
          </details>
          <matchPattern>*.iso</matchPattern>
        </searchSpec>
      </SearchDatastoreSubFolders_Task>
    `);
    const task = { ...readManagedRef(response?.returnval), type: "Task" };
    const result = await this.waitForTaskResult(task);
    return parseVmwareIsoResults(result, datastoreName);
  }

  async findTemplateVm(templateName: string): Promise<ManagedRef | undefined> {
    const normalized = templateName.toLowerCase();
    const objects = await this.retrieveContainerProperties("VirtualMachine", ["name", "config.template"]);
    return objects.find((item) => textOf(item.props.get("config.template")) === "true" && textOf(item.props.get("name")).toLowerCase() === normalized)?.ref ??
      objects.find((item) => textOf(item.props.get("config.template")) === "true" && textOf(item.props.get("name")).toLowerCase().includes(normalized))?.ref;
  }

  async resolveCreatePlacement(request: VmProvisionRequest, iso?: IsoImage): Promise<VmwareCreatePlacement> {
    const [hostObjects, datacenterObjects, datastoreObjects] = await Promise.all([
      this.retrieveContainerProperties("HostSystem", ["name", "parent", "datastore", "network"]),
      this.retrieveContainerProperties("Datacenter", ["name", "vmFolder"]),
      this.retrieveContainerProperties("Datastore", ["name", "summary.freeSpace", "summary.accessible"]),
    ]);
    const hostObject = hostObjects.find((item) => item.ref.value === request.hostId) ?? hostObjects[0];
    if (!hostObject) throw new Error("未找到可用于创建 VM 的 VMware Host。");
    const computeResource = readOptionalManagedRefAs(hostObject.props.get("parent"), "ComputeResource");
    if (!computeResource) throw new Error(`VMware Host ${textOf(hostObject.props.get("name")) || hostObject.ref.value} 没有关联计算资源。`);
    const [computeResourceProps] = await this.retrieveObjectProperties(computeResource, ["resourcePool"]);
    const resourcePool = readOptionalManagedRefAs(computeResourceProps?.props.get("resourcePool"), "ResourcePool");
    if (!resourcePool) throw new Error("未找到 VMware ResourcePool，无法创建 VM。");
    const folder = readOptionalManagedRefAs(datacenterObjects[0]?.props.get("vmFolder"), "Folder");
    if (!folder) throw new Error("未找到 VMware VM Folder，无法创建 VM。");

    const hostDatastores = new Set(collectManagedRefsAs(hostObject.props.get("datastore"), "Datastore").map((item) => item.value));
    const datastore = datastoreObjects
      .filter((item) => !hostDatastores.size || hostDatastores.has(item.ref.value))
      .filter((item) => textOf(item.props.get("summary.accessible")) !== "false")
      .sort((left, right) => {
        const leftName = textOf(left.props.get("name"));
        const rightName = textOf(right.props.get("name"));
        if (iso && leftName === iso.storageRepository) return -1;
        if (iso && rightName === iso.storageRepository) return 1;
        return numberOf(right.props.get("summary.freeSpace")) - numberOf(left.props.get("summary.freeSpace"));
      })[0];
    if (!datastore) throw new Error("未找到 VMware 可用 Datastore，无法创建虚拟硬盘。");

    const networks = await this.resolveNetworkObjects(collectManagedRefsAs(hostObject.props.get("network"), "Network"));
    const preferredNetwork = request.ipPool.networkName?.trim();
    const network =
      (preferredNetwork ? networks.find((item) => textOf(item.props.get("name")) === preferredNetwork) : undefined) ??
      networks.find((item) => textOf(item.props.get("name")).toLowerCase().includes("vm network")) ??
      networks[0];

    return {
      host: hostObject.ref,
      resourcePool,
      folder,
      datastore: datastore.ref,
      datastoreName: textOf(datastore.props.get("name")),
      datacenterName: textOf(datacenterObjects[0]?.props.get("name")) || "ha-datacenter",
      network: network?.ref,
      networkName: network ? textOf(network.props.get("name")) : undefined,
    };
  }

  async createIsoVm(
    placement: VmwareCreatePlacement,
    request: VmProvisionRequest,
    item: VmProvisionRequest["planItems"][number],
    iso: IsoImage,
    sourceIso?: IsoImage,
  ): Promise<ManagedRef> {
    const diskKb = Math.max(Math.floor(item.diskGiB), 1) * 1024 * 1024;
    const isoFileName = vmwareIsoFileName(iso);
    const networkDevice = placement.network
      ? `
          <deviceChange>
            <operation>add</operation>
            <device xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="VirtualVmxnet3">
              <key>-50</key>
              <deviceInfo>
                <label>Network adapter 1</label>
                <summary>${escapeXml(placement.networkName ?? "VM Network")}</summary>
              </deviceInfo>
              <backing xsi:type="VirtualEthernetCardNetworkBackingInfo">
                <deviceName>${escapeXml(placement.networkName ?? "VM Network")}</deviceName>
                ${managedRefXml("network", placement.network)}
              </backing>
              <connectable>
                <startConnected>true</startConnected>
                <allowGuestControl>true</allowGuestControl>
                <connected>false</connected>
              </connectable>
              <addressType>generated</addressType>
            </device>
          </deviceChange>`
      : "";
    const response = await this.call("CreateVM_Task", `
      <CreateVM_Task xmlns="${SOAP_NS}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        ${managedRefXml("_this", placement.folder)}
        <config>
          <name>${escapeXml(item.name)}</name>
          <guestId>${escapeXml(vmwareGuestIdForProvision(request))}</guestId>
          <files>
            <vmPathName>[${escapeXml(placement.datastoreName)}]</vmPathName>
          </files>
          <numCPUs>${Math.max(Math.floor(item.cpu), 1)}</numCPUs>
          <memoryMB>${Math.max(Math.floor(item.memoryGiB), 1) * 1024}</memoryMB>
          <deviceChange>
            <operation>add</operation>
            <device xsi:type="VirtualLsiLogicController">
              <key>1000</key>
              <busNumber>0</busNumber>
              <sharedBus>noSharing</sharedBus>
            </device>
          </deviceChange>
          <deviceChange>
            <operation>add</operation>
            <device xsi:type="VirtualIDEController">
              <key>200</key>
              <busNumber>0</busNumber>
            </device>
          </deviceChange>
          <deviceChange>
            <operation>add</operation>
            <fileOperation>create</fileOperation>
            <device xsi:type="VirtualDisk">
              <key>-100</key>
              <deviceInfo>
                <label>Hard disk 1</label>
                <summary>${Math.max(Math.floor(item.diskGiB), 1)} GiB thin provisioned disk</summary>
              </deviceInfo>
              <backing xsi:type="VirtualDiskFlatVer2BackingInfo">
                <fileName>[${escapeXml(placement.datastoreName)}]</fileName>
                <diskMode>persistent</diskMode>
                <thinProvisioned>true</thinProvisioned>
              </backing>
              <controllerKey>1000</controllerKey>
              <unitNumber>0</unitNumber>
              <capacityInKB>${diskKb}</capacityInKB>
            </device>
          </deviceChange>
          <deviceChange>
            <operation>add</operation>
            <device xsi:type="VirtualCdrom">
              <key>-200</key>
              <deviceInfo>
                <label>CD/DVD drive 1</label>
                <summary>${escapeXml(iso.name)}</summary>
              </deviceInfo>
              <backing xsi:type="VirtualCdromIsoBackingInfo">
                <fileName>${escapeXml(isoFileName)}</fileName>
                ${managedRefXml("datastore", placement.datastore)}
              </backing>
              <connectable>
                <startConnected>true</startConnected>
                <allowGuestControl>true</allowGuestControl>
                <connected>false</connected>
              </connectable>
              <controllerKey>200</controllerKey>
              <unitNumber>0</unitNumber>
            </device>
          </deviceChange>
          ${sourceIso ? `
          <deviceChange>
            <operation>add</operation>
            <device xsi:type="VirtualCdrom">
              <key>-201</key>
              <deviceInfo><label>CD/DVD drive 2</label><summary>${escapeXml(sourceIso.name)}</summary></deviceInfo>
              <backing xsi:type="VirtualCdromIsoBackingInfo">
                <fileName>${escapeXml(vmwareIsoFileName(sourceIso))}</fileName>
                ${managedRefXml("datastore", placement.datastore)}
              </backing>
              <connectable><startConnected>true</startConnected><allowGuestControl>true</allowGuestControl><connected>false</connected></connectable>
              <controllerKey>200</controllerKey>
              <unitNumber>1</unitNumber>
            </device>
          </deviceChange>` : ""}
          ${networkDevice}
        </config>
        ${managedRefXml("pool", placement.resourcePool)}
        ${managedRefXml("host", placement.host)}
      </CreateVM_Task>
    `);
    const task = { ...readManagedRef(response?.returnval), type: "Task" };
    const result = await this.waitForTaskResult(task);
    const vmRef = readManagedRef(result);
    if (!vmRef.value) throw new Error("VMware 创建任务已完成但未返回新 VM。");
    return { ...vmRef, type: vmRef.type || "VirtualMachine" };
  }

  async cloneTemplateVm(
    template: ManagedRef,
    placement: VmwareCreatePlacement,
    request: VmProvisionRequest,
    item: VmProvisionRequest["planItems"][number],
  ): Promise<ManagedRef> {
    const response = await this.call("CloneVM_Task", `
      <CloneVM_Task xmlns="${SOAP_NS}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        ${managedRefXml("_this", { ...template, type: "VirtualMachine" })}
        ${managedRefXml("folder", placement.folder)}
        <name>${escapeXml(item.name)}</name>
        <spec>
          <location>
            ${managedRefXml("datastore", placement.datastore)}
            ${managedRefXml("host", placement.host)}
            ${managedRefXml("pool", placement.resourcePool)}
          </location>
          <powerOn>false</powerOn>
          <template>false</template>
          <config>
            <numCPUs>${Math.max(Math.floor(item.cpu), 1)}</numCPUs>
            <memoryMB>${Math.max(Math.floor(item.memoryGiB), 1) * 1024}</memoryMB>
          </config>
          <customization>
            <identity xsi:type="CustomizationLinuxPrep">
              <hostName xsi:type="CustomizationFixedName">
                <name>${escapeXml(safeVmwareHostName(item.name))}</name>
              </hostName>
              <domain>local</domain>
            </identity>
            <globalIPSettings>
              ${request.ipPool.dns.map((dns) => `<dnsServerList>${escapeXml(dns)}</dnsServerList>`).join("")}
            </globalIPSettings>
            <nicSettingMap>
              <adapter>
                <ip xsi:type="CustomizationFixedIp">
                  <ipAddress>${escapeXml(item.ip)}</ipAddress>
                </ip>
                <subnetMask>${escapeXml(cidrToNetmask(request.ipPool.cidr) || "255.255.255.0")}</subnetMask>
                <gateway>${escapeXml(request.ipPool.gateway)}</gateway>
              </adapter>
            </nicSettingMap>
          </customization>
        </spec>
      </CloneVM_Task>
    `);
    const task = { ...readManagedRef(response?.returnval), type: "Task" };
    const result = await this.waitForTaskResult(task);
    const vmRef = readManagedRef(result);
    if (!vmRef.value) throw new Error("VMware 克隆任务已完成但未返回新 VM。");
    return { ...vmRef, type: vmRef.type || "VirtualMachine" };
  }

  async powerOnVm(vmMoid: string): Promise<void> {
    const response = await this.call("PowerOnVM_Task", `
      <PowerOnVM_Task xmlns="${SOAP_NS}">
        ${managedRefXml("_this", { type: "VirtualMachine", value: vmMoid })}
      </PowerOnVM_Task>
    `);
    await this.waitForTaskResult({ ...readManagedRef(response?.returnval), type: "Task" });
  }

  async renameVm(vmMoid: string, newName: string): Promise<void> {
    const response = await this.call("Rename_Task", `
      <Rename_Task xmlns="${SOAP_NS}">
        ${managedRefXml("_this", { type: "VirtualMachine", value: vmMoid })}
        <newName>${escapeXml(newName)}</newName>
      </Rename_Task>
    `);
    await this.waitForTaskResult({ ...readManagedRef(response?.returnval), type: "Task" });
  }

  async uploadDatastoreFile(datacenterName: string, datastoreName: string, datastorePath: string, localPath: string): Promise<void> {
    const size = statSync(localPath).size;
    const path = datastoreHttpPath(datacenterName, datastoreName, datastorePath);
    await new Promise<void>((resolve, reject) => {
      const req = httpsRequest({
        hostname: this.input.host,
        port: this.input.port || DEFAULT_VMWARE_PORT,
        path,
        method: "PUT",
        rejectUnauthorized: false,
        headers: { Cookie: this.cookie, "Content-Type": "application/octet-stream", "Content-Length": size },
        timeout: SOAP_TIMEOUT_MS,
      }, (response) => {
        response.resume();
        response.on("end", () => {
          if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) resolve();
          else reject(new Error(`VMware Datastore 上传失败：HTTP ${response.statusCode || 0}`));
        });
      });
      req.on("timeout", () => req.destroy(new Error("VMware Datastore 上传超时。")));
      req.on("error", reject);
      createReadStream(localPath).on("error", reject).pipe(req);
    });
  }

  async readDatastoreRange(datacenterName: string, datastoreName: string, datastorePath: string, start: number, end: number): Promise<Buffer> {
    const path = datastoreHttpPath(datacenterName, datastoreName, datastorePath);
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const req = httpsRequest({
        hostname: this.input.host,
        port: this.input.port || DEFAULT_VMWARE_PORT,
        path,
        method: "GET",
        rejectUnauthorized: false,
        headers: { Cookie: this.cookie, Range: `bytes=${start}-${end}` },
        timeout: SOAP_TIMEOUT_MS,
      }, (response) => {
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          if (response.statusCode === 206) resolve(Buffer.concat(chunks));
          else reject(new Error(`VMware Datastore Range 读取失败：HTTP ${response.statusCode || 0}`));
        });
      });
      req.on("timeout", () => req.destroy(new Error("VMware Datastore Range 读取超时。")));
      req.on("error", reject);
      req.end();
    });
  }

  async deleteDatastoreFile(datacenterName: string, datastoreName: string, datastorePath: string): Promise<void> {
    const path = datastoreHttpPath(datacenterName, datastoreName, datastorePath);
    await new Promise<void>((resolve, reject) => {
      const req = httpsRequest({
        hostname: this.input.host,
        port: this.input.port || DEFAULT_VMWARE_PORT,
        path,
        method: "DELETE",
        rejectUnauthorized: false,
        headers: { Cookie: this.cookie },
        timeout: SOAP_TIMEOUT_MS,
      }, (response) => {
        response.resume();
        response.on("end", () => {
          if (response.statusCode === 404 || (response.statusCode && response.statusCode >= 200 && response.statusCode < 300)) resolve();
          else reject(new Error(`VMware Datastore 清理失败：HTTP ${response.statusCode || 0}`));
        });
      });
      req.on("timeout", () => req.destroy(new Error("VMware Datastore 清理超时。")));
      req.on("error", reject);
      req.end();
    });
  }

  async shutdownGuest(vmMoid: string): Promise<void> {
    await this.call("ShutdownGuest", `
      <ShutdownGuest xmlns="${SOAP_NS}">
        ${managedRefXml("_this", { type: "VirtualMachine", value: vmMoid })}
      </ShutdownGuest>
    `);
  }

  async powerOffVm(vmMoid: string): Promise<void> {
    const response = await this.call("PowerOffVM_Task", `
      <PowerOffVM_Task xmlns="${SOAP_NS}">
        ${managedRefXml("_this", { type: "VirtualMachine", value: vmMoid })}
      </PowerOffVM_Task>
    `);
    await this.waitForTaskResult({ ...readManagedRef(response?.returnval), type: "Task" });
  }

  async destroyVm(vmMoid: string): Promise<void> {
    const response = await this.call("Destroy_Task", `
      <Destroy_Task xmlns="${SOAP_NS}">
        ${managedRefXml("_this", { type: "VirtualMachine", value: vmMoid })}
      </Destroy_Task>
    `);
    await this.waitForTaskResult({ ...readManagedRef(response?.returnval), type: "Task" });
  }

  async waitForVmPowerState(vmMoid: string, expectedState: VmNode["powerState"], timeoutMs = 18_000): Promise<boolean> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const state = await this.getVmPowerState(vmMoid);
      if (state === expectedState) return true;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    return false;
  }

  private async createContainerView(type: string): Promise<ManagedRef> {
    const response = await this.call("CreateContainerView", `
      <CreateContainerView xmlns="${SOAP_NS}">
        ${managedRefXml("_this", this.content.viewManager)}
        ${managedRefXml("container", this.content.rootFolder)}
        <type>${escapeXml(type)}</type>
        <recursive>true</recursive>
      </CreateContainerView>
    `);
    return readManagedRef(response?.returnval);
  }

  private async retrieveProperties(view: ManagedRef, type: string, paths: string[]): Promise<XmlValue> {
    return this.call("RetrievePropertiesEx", `
      <RetrievePropertiesEx xmlns="${SOAP_NS}">
        ${managedRefXml("_this", this.content.propertyCollector)}
        <specSet>
          <propSet>
            <type>${escapeXml(type)}</type>
            <all>false</all>
            ${paths.map((path) => `<pathSet>${escapeXml(path)}</pathSet>`).join("")}
          </propSet>
          <objectSet>
            ${managedRefXml("obj", view)}
            <skip>true</skip>
            <selectSet xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="TraversalSpec">
              <name>view</name>
              <type>ContainerView</type>
              <path>view</path>
              <skip>false</skip>
            </selectSet>
          </objectSet>
        </specSet>
        <options>
          <maxObjects>500</maxObjects>
        </options>
      </RetrievePropertiesEx>
    `);
  }

  private async continueRetrieveProperties(token: string): Promise<XmlValue> {
    return this.call("ContinueRetrievePropertiesEx", `
      <ContinueRetrievePropertiesEx xmlns="${SOAP_NS}">
        ${managedRefXml("_this", this.content.propertyCollector)}
        <token>${escapeXml(token)}</token>
      </ContinueRetrievePropertiesEx>
    `);
  }

  private async retrieveObjectProperties(ref: ManagedRef, paths: string[]): Promise<PropertyObject[]> {
    const response = await this.call("RetrievePropertiesEx", `
      <RetrievePropertiesEx xmlns="${SOAP_NS}">
        ${managedRefXml("_this", this.content.propertyCollector)}
        <specSet>
          <propSet>
            <type>${escapeXml(ref.type)}</type>
            <all>false</all>
            ${paths.map((path) => `<pathSet>${escapeXml(path)}</pathSet>`).join("")}
          </propSet>
          <objectSet>
            ${managedRefXml("obj", ref)}
            <skip>false</skip>
          </objectSet>
        </specSet>
        <options>
          <maxObjects>20</maxObjects>
        </options>
      </RetrievePropertiesEx>
    `);
    return parsePropertyObjects(response);
  }

  private async resolveNetworkObjects(refs: ManagedRef[]): Promise<PropertyObject[]> {
    const objects: PropertyObject[] = [];
    for (const ref of refs) {
      objects.push(...(await this.retrieveObjectProperties(ref, ["name"]).catch(() => [])));
    }
    return objects;
  }

  private async getVmPowerState(vmMoid: string): Promise<VmNode["powerState"]> {
    const [vmObject] = await this.retrieveObjectProperties({ type: "VirtualMachine", value: vmMoid }, ["runtime.powerState"]);
    return normalizePowerState(textOf(vmObject?.props.get("runtime.powerState")));
  }

  private async waitForTaskResult(task: ManagedRef): Promise<XmlValue> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < SOAP_TIMEOUT_MS) {
      const [taskObject] = await this.retrieveObjectProperties(task, ["info.state", "info.result", "info.error"]);
      const state = textOf(taskObject?.props.get("info.state"));
      if (state === "success") return taskObject?.props.get("info.result");
      if (state === "error") {
        const message = readableVmwareTaskError(taskObject?.props.get("info.error"));
        throw new Error(message || "VMware 任务执行失败。");
      }
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
    throw new Error("VMware 任务执行超时。");
  }

  private async call(action: string, body: string): Promise<XmlValue> {
    const { parsed, cookie } = await postSoap(this.input, body, this.cookie);
    if (cookie) this.cookie = cookie;
    const soapBody = parsed?.Envelope?.Body;
    const fault = soapBody?.Fault;
    if (fault) {
      throw new Error(toVmwareFaultMessage(fault));
    }
    return soapBody?.[`${action}Response`];
  }
}

function vmwareActionLabel(action: VmPowerAction) {
  if (action === "start") return "开机";
  if (action === "shutdown") return "关机";
  if (action === "forceReboot") return "强制重启";
  return "删除";
}

async function retrieveServiceContent(input: XenConnectionInput): Promise<ServiceContent> {
  const { parsed } = await postSoap(
    input,
    `
      <RetrieveServiceContent xmlns="${SOAP_NS}">
        <_this type="ServiceInstance">ServiceInstance</_this>
      </RetrieveServiceContent>
    `,
    "",
  );
  const body = parsed?.Envelope?.Body;
  const fault = body?.Fault;
  if (fault) {
    throw new Error(toVmwareFaultMessage(fault));
  }
  const returnval = body?.RetrieveServiceContentResponse?.returnval;
  if (!returnval) {
    throw new Error("VMware API 未返回 ServiceContent，请确认目标是 ESXi/vCenter 的 HTTPS API 地址。");
  }
  return {
    rootFolder: readManagedRef(returnval.rootFolder),
    propertyCollector: readManagedRef(returnval.propertyCollector),
    sessionManager: readManagedRef(returnval.sessionManager),
    viewManager: readManagedRef(returnval.viewManager),
    fileManager: readManagedRef(returnval.fileManager),
    performanceManager: readManagedRef(returnval.perfManager),
    aboutName: textOf(returnval.about?.name),
    aboutFullName: textOf(returnval.about?.fullName),
    apiVersion: textOf(returnval.about?.apiVersion),
  };
}

function postSoap(input: XenConnectionInput, body: string, cookie: string): Promise<{ parsed: XmlValue; cookie: string }> {
  const port = input.port || DEFAULT_VMWARE_PORT;
  const url = new URL(`https://${input.host}:${port}/sdk`);
  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
    <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
      <soapenv:Body>${body}</soapenv:Body>
    </soapenv:Envelope>`;

  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        rejectUnauthorized: false,
        timeout: SOAP_TIMEOUT_MS,
        headers: {
          "Content-Type": "text/xml; charset=utf-8",
          SOAPAction: `"${SOAP_NS}"`,
          "Content-Length": Buffer.byteLength(envelope),
          ...(cookie ? { Cookie: cookie } : {}),
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
            const parsed = xmlParser.parse(text);
            const setCookie = res.headers["set-cookie"]?.find((item) => item.startsWith("vmware_soap_session="));
            const nextCookie = setCookie?.split(";")[0] ?? cookie;
            if ((res.statusCode ?? 500) >= 400 && !parsed?.Envelope?.Body?.Fault) {
              reject(new Error(`VMware API HTTP ${res.statusCode}: ${res.statusMessage || "请求失败"}`));
              return;
            }
            resolve({ parsed, cookie: nextCookie });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("连接 VMware API 超时，请确认 HTTPS 端口和网络连通。"));
    });
    req.on("error", reject);
    req.write(envelope);
    req.end();
  });
}

function parsePropertyObjects(response: XmlValue): PropertyObject[] {
  return toArray(response?.returnval?.objects).map((object) => {
    const props = new Map<string, XmlValue>();
    for (const prop of toArray(object?.propSet)) {
      const name = textOf(prop?.name);
      if (name) props.set(name, prop?.val);
    }
    return {
      ref: readManagedRef(object?.obj),
      props,
    };
  });
}

function toHostNode(item: PropertyObject, connectionId: string, input: XenConnectionInput): HostNode {
  const memoryTotalBytes = numberOf(item.props.get("summary.hardware.memorySize"));
  const usedMemoryMb = numberOf(item.props.get("summary.quickStats.overallMemoryUsage"));
  const memoryFreeBytes = Math.max(memoryTotalBytes - usedMemoryMb * 1024 * 1024, 0);
  const connectionState = textOf(item.props.get("runtime.connectionState"));
  const managementIp = pickVmwareHostAddress(item, input.host);
  return {
    id: `${connectionId}:host:${item.ref.value}`,
    connectionId,
    providerId: item.ref.value,
    name: textOf(item.props.get("name")) || textOf(item.props.get("summary.config.name")) || input.host,
    address: managementIp,
    vendor: "VMware",
    version: textOf(item.props.get("config.product.fullName")),
    cpuModel: textOf(item.props.get("summary.hardware.cpuModel")),
    cpuSockets: numberOf(item.props.get("summary.hardware.numCpuPkgs")),
    cpuCores: numberOf(item.props.get("summary.hardware.numCpuCores")),
    memoryTotalBytes,
    memoryFreeBytes,
    status: normalizeHostStatus(connectionState),
  };
}

function pickVmwareHostAddress(item: PropertyObject, fallbackHost: string): string {
  const ips = new Set<string>();
  const summaryIp = normalizeIpv4(textOf(item.props.get("summary.managementServerIp")));
  if (summaryIp) ips.add(summaryIp);

  for (const ip of collectVmkernelIps(item.props.get("config.network.vnic"), item.props.get("config.virtualNicManagerInfo.netConfig"))) {
    ips.add(ip);
  }

  const fallbackIp = normalizeIpv4(fallbackHost);
  if (fallbackIp) ips.add(fallbackIp);
  return Array.from(ips)[0] || fallbackHost;
}

function toVmwareNetworkInterfaces(item: PropertyObject): NetworkInterface[] {
  const managementKeys = collectManagementVnicKeys(item.props.get("config.virtualNicManagerInfo.netConfig"));
  return collectVmkernelNics(item.props.get("config.network.vnic"), managementKeys).map((nic) => ({
    hostId: item.ref.value,
    device: nic.device || nic.key,
    mac: nic.mac,
    ip: nic.ip,
    netmask: nic.netmask,
    gateway: "",
    management: vmkernelNicPriority(nic, managementKeys) <= 1,
    attached: true,
    network: nic.portgroup,
  }));
}

function collectVmkernelIps(vnicValue: XmlValue, managerValue: XmlValue): string[] {
  const managementKeys = collectManagementVnicKeys(managerValue);
  const nics = collectVmkernelNics(vnicValue, managementKeys);
  return Array.from(new Set(nics.map((item) => item.ip)));
}

function collectVmkernelNics(
  vnicValue: XmlValue,
  managementKeys: Set<string>,
): Array<{ key: string; device: string; portgroup: string; ip: string; netmask: string; mac: string }> {
  const nics: Array<{ key: string; device: string; portgroup: string; ip: string; netmask: string; mac: string }> = [];
  const visit = (node: XmlValue) => {
    if (node == null) return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (typeof node !== "object") return;
    const ip = normalizeIpv4(textOf(node.spec?.ip?.ipAddress));
    if (ip) {
      nics.push({
        key: textOf(node.key),
        device: textOf(node.device),
        portgroup: textOf(node.portgroup),
        ip,
        netmask: textOf(node.spec?.ip?.subnetMask),
        mac: textOf(node.spec?.mac),
      });
    }
    for (const child of Object.values(node)) {
      visit(child);
    }
  };
  visit(vnicValue);

  return nics.sort((left, right) => vmkernelNicPriority(left, managementKeys) - vmkernelNicPriority(right, managementKeys));
}

function collectManagementVnicKeys(value: XmlValue): Set<string> {
  const keys = new Set<string>();
  const visit = (node: XmlValue) => {
    if (node == null) return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (typeof node !== "object") return;
    if (textOf(node.nicType) === "management") {
      collectTextValues(node.selectedVnic).forEach((item) => {
        keys.add(item);
        const vmk = item.match(/vmk\d+/)?.[0];
        if (vmk) keys.add(vmk);
      });
    }
    for (const child of Object.values(node)) {
      visit(child);
    }
  };
  visit(value);
  return keys;
}

function collectTextValues(value: XmlValue): string[] {
  const values: string[] = [];
  const visit = (node: XmlValue) => {
    if (node == null) return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") {
      const text = String(node).trim();
      if (text) values.push(text);
      return;
    }
    if (typeof node !== "object") return;
    if ("#text" in node) {
      visit(node["#text"]);
      return;
    }
    for (const child of Object.values(node)) {
      visit(child);
    }
  };
  visit(value);
  return values;
}

function readableVmwareTaskError(value: XmlValue): string {
  return Array.from(new Set(collectTextValues(value).filter((item) => item && item !== "LocalizedMethodFault")))
    .slice(0, 8)
    .join(" · ");
}

function vmkernelNicPriority(nic: { key: string; device: string; portgroup: string }, managementKeys: Set<string>): number {
  if (managementKeys.has(nic.key) || managementKeys.has(nic.device)) return 0;
  if (nic.portgroup.toLowerCase().includes("management")) return 1;
  if (nic.device === "vmk0") return 2;
  return 3;
}

function toStorageRepository(item: PropertyObject): StorageRepository {
  const capacity = numberOf(item.props.get("summary.capacity"));
  const free = numberOf(item.props.get("summary.freeSpace"));
  const used = Math.max(capacity - free, 0);
  const type = textOf(item.props.get("summary.type"));
  const shared = textOf(item.props.get("summary.multipleHostAccess")) === "true";
  return {
    name: textOf(item.props.get("name")),
    type,
    ...describeStorageRepository("vmware", { type, shared }),
    ...normalizeStorageCapacity({ physicalGiB: bytesToGib(capacity), usedGiB: bytesToGib(used) }),
    shared,
  };
}

function toVmNode(item: PropertyObject, connectionId: string): VmNode {
  const providerId = vmwareProviderId(item);
  const host = readOptionalManagedRef(item.props.get("runtime.host"));
  const disks = collectVirtualDisks(item.props.get("config.hardware.device"), providerId);
  const configuredDiskBytes = disks.reduce((sum, disk) => sum + disk.virtualSizeBytes, 0);
  const storageCommittedBytes = numberOf(item.props.get("summary.storage.committed"));
  const storageUncommittedBytes = numberOf(item.props.get("summary.storage.uncommitted"));
  const storageProvisionedBytes = Math.max(storageCommittedBytes + storageUncommittedBytes, 0);
  const diskVirtualBytes = configuredDiskBytes || storageProvisionedBytes;
  const reportedDiskCount = numberOf(item.props.get("summary.config.numVirtualDisks"));
  const diskCount = disks.length || reportedDiskCount || (diskVirtualBytes > 0 ? 1 : 0);
  const name = textOf(item.props.get("name")) || providerId;
  const vm: VmNode = {
    id: `${connectionId}:vm:${providerId}`,
    connectionId,
    providerId,
    consoleRef: item.ref.value,
    name,
    powerState: normalizePowerState(textOf(item.props.get("runtime.powerState"))),
    cpuCount: numberOf(item.props.get("config.hardware.numCPU")),
    memoryBytes: numberOf(item.props.get("config.hardware.memoryMB")) * 1024 * 1024,
    diskVirtualBytes,
    diskCount,
    diskSizeSummary:
      disks.map((disk) => `${bytesToGib(disk.virtualSizeBytes).toFixed(1)} GiB`).join(" + ") ||
      (diskVirtualBytes > 0 ? `${bytesToGib(diskVirtualBytes).toFixed(1)} GiB` : undefined),
    hostId: host?.value,
    ipAddresses: collectGuestIps(item.props.get("guest.ipAddress"), item.props.get("guest.net"), name),
    guestOs: normalizeGuestOsLabel(
      textOf(item.props.get("guest.guestFullName")) ||
        textOf(item.props.get("config.guestFullName")) ||
        textOf(item.props.get("guest.guestId")) ||
        textOf(item.props.get("config.guestId")),
    ),
    toolsStatus: normalizeToolsStatus(textOf(item.props.get("guest.toolsStatus"))),
    reclaimLevel: "P3",
    reclaimReason: "",
    metadata: {
      managedObjectId: item.ref.value,
      disks,
      storageCommittedBytes,
      storageUncommittedBytes,
      diskCapacitySource: configuredDiskBytes > 0 ? "virtual-device" : storageProvisionedBytes > 0 ? "storage-summary" : "unavailable",
    },
  };
  const assessment = assessVmReclaim({
    uuid: vm.providerId,
    name: vm.name,
    powerState: vm.powerState,
    vcpuMax: vm.cpuCount,
    vcpuStartup: vm.cpuCount,
    memoryGiB: bytesToGib(vm.memoryBytes),
    diskTotalGiB: bytesToGib(vm.diskVirtualBytes ?? 0),
    diskDetail: vm.diskSizeSummary ?? "",
    residentHost: vm.hostId ?? "",
    ipAddresses: vm.ipAddresses,
    cpuUsage: null,
    diskReadRate: null,
    diskWriteRate: null,
    networkRxRate: null,
    networkTxRate: null,
    reclaimLevel: "P3",
    reclaimReason: "",
  });
  vm.reclaimLevel = assessment.reclaimLevel;
  vm.reclaimReason = assessment.reclaimReason;
  return vm;
}

function vmwareProviderId(item: PropertyObject): string {
  return textOf(item.props.get("config.uuid")) || textOf(item.props.get("config.instanceUuid")) || item.ref.value;
}

function normalizeVmwareTargetId(value: string): string {
  return value.includes(":vm:") ? value.split(":vm:").pop() || value : value;
}

async function resolveVmwareNetworkCounters(
  session: VmwareSoapSession,
  connectionId: string,
): Promise<VmwareNetworkCounterConfig | null> {
  const now = Date.now();
  const cached = vmwareNetworkCounterCache.get(connectionId);
  if (cached && now < cached.expiresAtMs) return cached.value;
  const value = findVmwareNetworkCounters(await session.getPerformanceCounters());
  vmwareNetworkCounterCache.set(connectionId, {
    value,
    expiresAtMs: now + (value ? VMWARE_PERFORMANCE_COUNTER_CACHE_MS : VMWARE_PERFORMANCE_COUNTER_RETRY_MS),
  });
  return value;
}

function findVmwareNetworkCounters(value: XmlValue): VmwareNetworkCounterConfig | null {
  let received: VmwarePerformanceCounter | null = null;
  let transmitted: VmwarePerformanceCounter | null = null;
  const visit = (node: XmlValue) => {
    if (node == null || (received && transmitted)) return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (typeof node !== "object") return;
    const id = numberOf(node.key);
    const group = textOf(node.groupInfo?.key);
    const name = textOf(node.nameInfo?.key);
    const rollup = textOf(node.rollupType);
    if (id > 0 && group === "net" && rollup === "average" && (name === "received" || name === "transmitted")) {
      const counter = { id, multiplier: vmwarePerformanceUnitMultiplier(textOf(node.unitInfo?.key)) };
      if (name === "received") received = counter;
      if (name === "transmitted") transmitted = counter;
      return;
    }
    for (const child of Object.values(node)) visit(child);
  };
  visit(value);
  return received && transmitted ? { received, transmitted } : null;
}

function vmwarePerformanceUnitMultiplier(unit: string): number {
  const normalized = unit.toLowerCase();
  if (normalized === "kilobytespersecond") return 1024;
  if (normalized === "megabytespersecond") return 1024 * 1024;
  return 1;
}

function parseVmwareNetworkRates(
  value: XmlValue,
  counters: VmwareNetworkCounterConfig,
): Map<string, VmwareNetworkRates> {
  const result = new Map<string, VmwareNetworkRates>();
  for (const entity of collectVmwarePerfEntities(value)) {
    const vmId = readManagedRef(entity.entity).value;
    if (!vmId) continue;
    const series = toArray(entity.value);
    result.set(vmId, {
      receivedBytesPerSecond: vmwareCounterSeriesValue(series, counters.received),
      transmittedBytesPerSecond: vmwareCounterSeriesValue(series, counters.transmitted),
    });
  }
  return result;
}

function collectVmwarePerfEntities(value: XmlValue): XmlValue[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap(collectVmwarePerfEntities);
  if (typeof value !== "object") return [];
  if (value.entity && value.value) return [value];
  return Object.values(value).flatMap(collectVmwarePerfEntities);
}

function vmwareCounterSeriesValue(series: XmlValue[], counter: VmwarePerformanceCounter): number | null {
  const matching = series.filter((item) => numberOf(item.id?.counterId) === counter.id);
  const aggregate = matching.find((item) => textOf(item.id?.instance) === "");
  const selected = aggregate ? [aggregate] : matching;
  const values = selected
    .map((item) => latestVmwarePerfValue(item.value))
    .filter((value): value is number => value != null && value >= 0);
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) * counter.multiplier : null;
}

function latestVmwarePerfValue(value: XmlValue): number | null {
  const values = collectTextValues(value)
    .map(Number)
    .filter((item) => Number.isFinite(item));
  return values.length > 0 ? values[values.length - 1] : null;
}

function toVmwareMetricSamples(
  item: PropertyObject,
  context: { connectionId: string; targetId: string; sampledAt: string; sampledAtMs: number },
  networkRates?: VmwareNetworkRates,
): MetricSample[] {
  const samples: MetricSample[] = [];
  const toolsStatus = normalizeToolsStatus(textOf(item.props.get("guest.toolsStatus")));
  const guestTelemetry: NonNullable<MetricSample["guestTelemetry"]> = {
    status: toolsStatus === "installed" ? "available" : toolsStatus === "missing" ? "unavailable" : "unknown",
    method: "vmware-tools",
    message:
      toolsStatus === "installed"
        ? "VMware Tools 可读取 Guest 指标"
        : toolsStatus === "missing"
          ? "VMware Tools 未运行，使用宿主机指标"
          : "VMware Tools 状态未知",
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

  const cpuUsageMhz = nonNegativeNumberOf(item.props.get("summary.quickStats.overallCpuUsage"));
  const cpuCapacityMhz = positiveNumberOf(item.props.get("runtime.maxCpuUsage"));
  const memoryTotalMb = positiveNumberOf(item.props.get("config.hardware.memoryMB"));
  const guestMemoryMb = positiveNumberOf(item.props.get("summary.quickStats.guestMemoryUsage"));
  const hostMemoryMb = positiveNumberOf(item.props.get("summary.quickStats.hostMemoryUsage"));
  const memoryUsedMb = hostMemoryMb ?? guestMemoryMb;
  const guestDiskUsage = collectVmwareGuestDiskUsage(item.props.get("guest.disk"));
  const configuredDiskBytes = collectVirtualDisks(item.props.get("config.hardware.device"), context.targetId)
    .reduce((sum, disk) => sum + disk.virtualSizeBytes, 0);
  const storageCommittedBytes = positiveNumberOf(item.props.get("summary.storage.committed"));
  const storageUncommittedBytes = nonNegativeNumberOf(item.props.get("summary.storage.uncommitted"));
  const storageProvisionedBytes =
    storageCommittedBytes == null ? null : storageCommittedBytes + (storageUncommittedBytes ?? 0);
  const diskUsedBytes = guestDiskUsage?.usedBytes ?? null;
  const diskTotalBytes = guestDiskUsage?.totalBytes ?? (configuredDiskBytes > 0 ? configuredDiskBytes : storageProvisionedBytes);

  pushSample("cpu_usage", cpuUsageMhz != null && cpuCapacityMhz != null ? Math.min(cpuUsageMhz / cpuCapacityMhz, 1) : null, "ratio", "hypervisor");
  pushSample(
    "memory_used",
    memoryUsedMb == null ? null : Math.min(memoryUsedMb, memoryTotalMb ?? memoryUsedMb) * 1024 * 1024,
    "bytes",
    hostMemoryMb != null ? "hypervisor" : "guest-tools",
  );
  pushSample("memory_total", memoryTotalMb == null ? null : memoryTotalMb * 1024 * 1024, "bytes", "hypervisor");
  pushSample(
    "disk_used",
    diskUsedBytes == null ? null : Math.min(diskUsedBytes, diskTotalBytes ?? diskUsedBytes),
    "bytes",
    "guest-tools",
  );
  pushSample("disk_total", diskTotalBytes, "bytes", guestDiskUsage ? "guest-tools" : "hypervisor");
  pushSample("net_rx", networkRates?.receivedBytesPerSecond ?? null, "bytes_per_sec", "hypervisor");
  pushSample("net_tx", networkRates?.transmittedBytesPerSecond ?? null, "bytes_per_sec", "hypervisor");
  return samples;
}

function collectVmwareGuestDiskUsage(value: XmlValue): { usedBytes: number; totalBytes: number } | null {
  let usedBytes = 0;
  let totalBytes = 0;
  const visit = (node: XmlValue) => {
    if (node == null) return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (typeof node !== "object") return;
    const capacityText = textOf(node.capacity);
    const freeSpaceText = textOf(node.freeSpace);
    if (capacityText && freeSpaceText) {
      const capacity = Number(capacityText);
      const freeSpace = Number(freeSpaceText);
      if (Number.isFinite(capacity) && capacity > 0 && Number.isFinite(freeSpace) && freeSpace >= 0) {
        totalBytes += capacity;
        usedBytes += Math.max(capacity - Math.min(freeSpace, capacity), 0);
        return;
      }
    }
    for (const child of Object.values(node)) visit(child);
  };
  visit(value);
  return totalBytes > 0 ? { usedBytes, totalBytes } : null;
}

function positiveNumberOf(value: XmlValue): number | null {
  const number = Number(textOf(value));
  return Number.isFinite(number) && number > 0 ? number : null;
}

function nonNegativeNumberOf(value: XmlValue): number | null {
  const number = Number(textOf(value));
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function collectVirtualDisks(value: XmlValue, vmId: string): VmwareDiskInfo[] {
  const disks: VmwareDiskInfo[] = [];
  const visit = (node: XmlValue) => {
    if (node == null) return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (typeof node !== "object") return;
    const type = textOf(node["@xsi:type"] ?? node["@type"]);
    const capacityKb = numberOf(node.capacityInKB);
    const capacityBytes = numberOf(node.capacityInBytes);
    if ((type.includes("VirtualDisk") || capacityKb > 0 || capacityBytes > 0) && (capacityKb > 0 || capacityBytes > 0)) {
      const key = textOf(node.key) || String(disks.length + 1);
      const name = textOf(node.deviceInfo?.label) || `Hard disk ${disks.length + 1}`;
      disks.push({
        id: `${vmId}:disk:${key}`,
        name,
        device: key,
        virtualSizeBytes: capacityBytes || capacityKb * 1024,
        storageRepository: parseDatastoreName(textOf(node.backing?.fileName)),
        key: numberOf(node.key),
        controllerKey: numberOf(node.controllerKey),
        unitNumber: numberOf(node.unitNumber),
        backingFileName: textOf(node.backing?.fileName),
        diskMode: textOf(node.backing?.diskMode) || "persistent",
        thinProvisioned: textOf(node.backing?.thinProvisioned) === "true",
        eagerlyScrub: textOf(node.backing?.eagerlyScrub) === "true",
      });
      return;
    }
    for (const child of Object.values(node)) {
      visit(child);
    }
  };
  visit(value);
  return disks;
}

/**
 * 递归收集 VMware VirtualMachineSnapshotTree 中的全部快照（含子快照），只读解析清单数据。
 *
 * @param value RetrieveProperties 返回的 snapshot.rootSnapshotList 原始 XML 值。
 * @param vmId 调用方传入的 VM 标识，作为快照归属 VM 的展示口径。
 * @param providerId 快照所属 VM 的 providerId（config.uuid / instanceUuid / ManagedObjectReference）。
 * @return 快照列表，按树深度优先顺序返回；无快照时为空数组。
 */
export function collectVmSnapshots(value: XmlValue, vmId: string, providerId: string): VmSnapshot[] {
  const snapshots: VmSnapshot[] = [];
  const visit = (node: XmlValue) => {
    if (node == null) return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (typeof node !== "object") return;
    const snapshotRef = readOptionalManagedRef(node.snapshot);
    if (snapshotRef) {
      const createTime = textOf(node.createTime);
      snapshots.push({
        id: snapshotRef.value,
        vmId,
        providerId: snapshotRef.value,
        name: textOf(node.name) || snapshotRef.value,
        ...(createTime ? { createdAt: createTime } : {}),
      });
      visit(node.childSnapshotList);
      return;
    }
    for (const child of Object.values(node)) {
      visit(child);
    }
  };
  visit(value);
  return snapshots;
}

export function vmwareEditDiskSpec(disk: VmwareDiskInfo, targetSizeBytes: number): string {
  const capacityInKb = Math.ceil(targetSizeBytes / 1024);
  return `<deviceChange>
    <operation>edit</operation>
    <device xsi:type="VirtualDisk">
      <key>${disk.key}</key>
      <deviceInfo><label>${escapeXml(disk.name)}</label><summary>${Math.ceil(targetSizeBytes / 1024 ** 3)} GiB</summary></deviceInfo>
      <backing xsi:type="VirtualDiskFlatVer2BackingInfo">
        <fileName>${escapeXml(disk.backingFileName)}</fileName>
        <diskMode>${escapeXml(disk.diskMode)}</diskMode>
        <thinProvisioned>${disk.thinProvisioned}</thinProvisioned>
        <eagerlyScrub>${disk.eagerlyScrub}</eagerlyScrub>
      </backing>
      <controllerKey>${disk.controllerKey}</controllerKey>
      <unitNumber>${disk.unitNumber}</unitNumber>
      <capacityInKB>${capacityInKb}</capacityInKB>
    </device>
  </deviceChange>`;
}

export function vmwareAddDiskSpec(disks: VmwareDiskInfo[], datastore: string, sizeBytes: number, name?: string): string {
  const firstDisk = disks[0];
  if (!firstDisk?.controllerKey) throw new Error("VMware 当前虚拟机没有可复用的磁盘控制器，无法自动新增磁盘。");
  const usedUnits = new Set(disks.filter((disk) => disk.controllerKey === firstDisk.controllerKey).map((disk) => disk.unitNumber));
  let unitNumber = -1;
  for (let index = 0; index < 16; index += 1) {
    if (index !== 7 && !usedUnits.has(index)) {
      unitNumber = index;
      break;
    }
  }
  if (unitNumber < 0) throw new Error("VMware 当前磁盘控制器没有可用槽位。");
  const label = name?.trim() || `Hard disk ${disks.length + 1}`;
  return `<deviceChange>
    <operation>add</operation>
    <fileOperation>create</fileOperation>
    <device xsi:type="VirtualDisk">
      <key>-${100 + disks.length}</key>
      <deviceInfo><label>${escapeXml(label)}</label><summary>${Math.ceil(sizeBytes / 1024 ** 3)} GiB thin provisioned disk</summary></deviceInfo>
      <backing xsi:type="VirtualDiskFlatVer2BackingInfo">
        <fileName>[${escapeXml(datastore)}]</fileName>
        <diskMode>persistent</diskMode>
        <thinProvisioned>true</thinProvisioned>
      </backing>
      <controllerKey>${firstDisk.controllerKey}</controllerKey>
      <unitNumber>${unitNumber}</unitNumber>
      <capacityInKB>${Math.ceil(sizeBytes / 1024)}</capacityInKB>
    </device>
  </deviceChange>`;
}

function assertVmwareResizeIncrease(label: string, target: number | undefined, current: number): void {
  if (target == null) return;
  if (!Number.isFinite(target) || target <= current) throw new Error(`${label}扩容目标必须大于当前值。`);
}

function collectVirtualCdroms(value: XmlValue): Array<{ key: number; controllerKey: number; unitNumber: number; label: string; fileName: string; datastore: string; connected: boolean }> {
  const cdroms: Array<{ key: number; controllerKey: number; unitNumber: number; label: string; fileName: string; datastore: string; connected: boolean }> = [];
  const visit = (node: XmlValue) => {
    if (node == null) return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (typeof node !== "object") return;
    if (textOf(node["@type"]).includes("VirtualCdrom")) {
      const key = numberOf(node.key);
      if (key) cdroms.push({
        key,
        controllerKey: numberOf(node.controllerKey),
        unitNumber: numberOf(node.unitNumber),
        label: textOf(node.deviceInfo?.label) || "CD/DVD drive",
        fileName: textOf(node.backing?.fileName),
        datastore: textOf(node.backing?.datastore),
        connected: textOf(node.connectable?.connected) === "true",
      });
      return;
    }
    for (const child of Object.values(node)) visit(child);
  };
  visit(value);
  return cdroms;
}

function parseVmwareIsoResults(value: XmlValue, datastoreName: string): VmwareIsoSearchResult[] {
  const results: VmwareIsoSearchResult[] = [];
  for (const folder of vmwareDatastoreSearchFolders(value)) {
    const folderPath = textOf(folder.folderPath).replace(new RegExp(`^\\[${escapeRegExp(datastoreName)}\\]\\s*`), "");
    for (const file of toArray(folder.file)) {
      const path = textOf(file.path);
      if (!path.toLowerCase().endsWith(".iso")) continue;
      results.push({
        datastore: datastoreName,
        folderPath,
        path,
        sizeBytes: numberOf(file.fileSize),
        modifiedAt: textOf(file.modification),
      });
    }
  }
  return results;
}

function vmwareDatastoreSearchFolders(value: XmlValue): XmlValue[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap(vmwareDatastoreSearchFolders);
  if (typeof value !== "object") return [];
  if ("HostDatastoreBrowserSearchResults" in value) {
    return toArray(value.HostDatastoreBrowserSearchResults).flatMap(vmwareDatastoreSearchFolders);
  }
  if ("folderPath" in value || "file" in value) {
    return [value];
  }
  return [];
}

function collectGuestIps(primary: XmlValue, guestNet: XmlValue, vmName?: string): string[] {
  const ips = new Set<string>();
  const first = textOf(primary);
  if (isIpLike(first)) ips.add(normalizeIpv4(first) || first);
  const visit = (node: XmlValue) => {
    if (node == null) return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (typeof node === "string" || typeof node === "number") {
      const text = String(node);
      if (isIpLike(text)) ips.add(normalizeIpv4(text) || text);
      return;
    }
    if (typeof node !== "object") return;
    if ("ipAddress" in node) visit(node.ipAddress);
    for (const child of Object.values(node)) {
      if (child !== node.ipAddress) visit(child);
    }
  };
  visit(guestNet);
  const inferredIp = inferIpv4FromVmName(vmName ?? "");
  if (inferredIp) ips.add(inferredIp);
  return Array.from(ips);
}

function inferIpv4FromVmName(name: string): string {
  return inferIpv4FromName(name);
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
  const text = fields.join(" ").toLowerCase();
  return text.includes(keyword);
}

function shouldSearchProviderId(keyword: string): boolean {
  return /^[a-f0-9:-]{8,}$/i.test(keyword);
}

function readManagedRef(node: XmlValue): ManagedRef {
  return {
    type: textOf(node?.["@type"]),
    value: textOf(node),
  };
}

function readOptionalManagedRef(node: XmlValue): ManagedRef | undefined {
  const ref = readManagedRef(node);
  return ref.value ? ref : undefined;
}

function readOptionalManagedRefAs(node: XmlValue, type: string): ManagedRef | undefined {
  const value = textOf(node);
  return value ? { type, value } : undefined;
}

function collectManagedRefsAs(value: XmlValue, type: string): ManagedRef[] {
  const refs: ManagedRef[] = [];
  const visit = (node: XmlValue) => {
    if (node == null) return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (typeof node !== "object") return;
    if ("#text" in node && textOf(node)) {
      refs.push({ type, value: textOf(node) });
      return;
    }
    for (const child of Object.values(node)) visit(child);
  };
  visit(value);
  return refs;
}

function collectManagedRefs(value: XmlValue, type?: string): ManagedRef[] {
  const refs: ManagedRef[] = [];
  const visit = (node: XmlValue) => {
    if (node == null) return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (typeof node !== "object") return;
    const ref = readManagedRef(node);
    if (ref.value && (!type || ref.type === type)) {
      refs.push(ref);
      return;
    }
    for (const child of Object.values(node)) {
      visit(child);
    }
  };
  visit(value);
  return refs;
}

function managedRefXml(tag: string, ref: ManagedRef): string {
  return `<${tag} type="${escapeXml(ref.type)}">${escapeXml(ref.value)}</${tag}>`;
}

function toArray<T = XmlValue>(value: T | T[] | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function textOf(value: XmlValue): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return textOf(value[0]);
  if (typeof value === "object" && "#text" in value) return textOf(value["#text"]);
  return "";
}

function numberOf(value: XmlValue): number {
  const parsed = Number(textOf(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseDatastoreName(fileName: string): string | undefined {
  const match = fileName.match(/^\[([^\]]+)\]/);
  return match?.[1];
}

function normalizeVmwareIsoId(isoId: string): string {
  return isoId.startsWith("vmware:") ? isoId.slice("vmware:".length) : isoId;
}

function vmwareIsoFileName(iso: IsoImage): string {
  const path = iso.path || normalizeVmwareIsoId(iso.providerId).split(":").slice(1).join(":") || iso.name;
  return `[${iso.storageRepository}] ${path}`;
}

function datastoreHttpPath(datacenterName: string, datastoreName: string, datastorePath: string): string {
  const encodedPath = datastorePath.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return `/folder/${encodedPath}?dcPath=${encodeURIComponent(datacenterName)}&dsName=${encodeURIComponent(datastoreName)}`;
}

function vmwareGuestIdForProvision(request: VmProvisionRequest): string {
  const text = `${request.isoId ?? ""} ${request.templateName ?? ""}`.toLowerCase();
  if (text.includes("windows") || text.includes("win")) return "windows9_64Guest";
  if (text.includes("ubuntu")) return "ubuntu64Guest";
  if (text.includes("centos")) return "centos7_64Guest";
  return "other3xLinux64Guest";
}

function safeVmwareHostName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63) || "vm";
}

function cidrToNetmask(cidr: string | undefined): string {
  const prefix = Number((cidr ?? "").split("/")[1]);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return "";
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return [24, 16, 8, 0].map((shift) => String((mask >>> shift) & 255)).join(".");
}

function parseProviderHost(input: XenConnectionInput): string {
  return `${input.host}:${input.port || DEFAULT_VMWARE_PORT}`;
}

function connectionKey(input: XenConnectionInput): string {
  return `vmware:${parseProviderHost(input)}`;
}

function clampPageSize(pageSize: number | undefined): number {
  if (!pageSize) return 100;
  return Math.min(Math.max(pageSize, 1), 500);
}

function bytesToGib(value: number): number {
  return Math.round((value / 1024 / 1024 / 1024) * 10) / 10;
}

function normalizePowerState(value: string): VmNode["powerState"] {
  if (value === "poweredOn") return "running";
  if (value === "poweredOff") return "halted";
  if (value === "suspended") return "suspended";
  return "unknown";
}

function normalizeHostStatus(value: string): HostNode["status"] {
  if (value === "connected") return "online";
  if (value === "disconnected" || value === "notResponding") return "offline";
  if (value === "maintenance") return "maintenance";
  return "unknown";
}

function normalizeToolsStatus(value: string): VmNode["toolsStatus"] {
  if (value === "toolsOk" || value === "toolsOld") return "installed";
  if (value === "toolsNotInstalled" || value === "toolsNotRunning") return "missing";
  return "unknown";
}

function isVmwareGuestShutdownUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes("ToolsUnavailable") || message.includes("VMware Tools is not running") || message.includes("VMware Tools unavailable");
}

function isIpLike(value: string): boolean {
  return /^[0-9a-fA-F:.]+$/.test(value) && value.includes(".");
}

function normalizeIpv4(value: string): string {
  const ip = value.split("/")[0]?.trim() ?? "";
  return isManagedIpv4(ip) ? ip : "";
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toVmwareFaultMessage(fault: XmlValue): string {
  const faultText = textOf(fault?.faultstring);
  const detailText = readableVmwareTaskError(fault?.detail);
  if (faultText.includes("Cannot complete login")) {
    return "VMware 账号或密码认证失败，请确认 ESXi/vCenter 用户名和密码。";
  }
  if (faultText.includes("NoPermission")) {
    return "VMware 账号权限不足，需要清单读取权限。";
  }
  return [faultText, detailText].filter(Boolean).join("：") || "VMware API 调用失败。";
}
