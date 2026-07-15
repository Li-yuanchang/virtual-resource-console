import { request as httpsRequest } from "node:https";
import { createReadStream, statSync } from "node:fs";
import { XMLParser } from "fast-xml-parser";
import { assessVmReclaim } from "./analysis/reclaimStateMachine.js";
import { getGeneratedIso, markGeneratedIsoStatus, markGeneratedIsoUploaded, registerGeneratedIso } from "./generatedIsoStore.js";
import type { VirtualizationProvider } from "./providers/provider.js";
import { inferIpv4FromName, isManagedIpv4 } from "./runtimePolicy.js";
import { ensureVmwareCentosBootFiles, generateVmwareCentosKickstartIso, removeLocalVmwareKickstartIso } from "./vmwareUnattendedIso.js";
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

interface VmwareDiskInfo {
  id: string;
  name: string;
  device: string;
  virtualSizeBytes: number;
  storageRepository?: string;
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
      virtualSizeBytes: disk.virtualSizeBytes,
      storageRepository: disk.storageRepository,
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

  async listVmSnapshots(_input: XenConnectionInput, _vmId: string): Promise<VmSnapshot[]> {
    return [];
  }

  async performVmAction(input: XenConnectionInput, vmId: string, action: VmPowerAction): Promise<VmActionResult> {
    const session = await VmwareSoapSession.login(input);
    try {
      const vm = (await this.listVms(input, { page: 1, pageSize: 500 })).items.find((item) => item.providerId === vmId || item.id === vmId);
      if (!vm) throw new Error(`未找到 VMware 虚拟机：${vmId}`);
      const vmMoid = typeof vm.metadata?.managedObjectId === "string" ? vm.metadata.managedObjectId : vm.providerId;
      if (action === "start") {
        if (vm.powerState === "running") throw new Error("虚拟机已在运行。");
        await session.powerOnVm(vmMoid);
      } else if (action === "shutdown") {
        if (vm.powerState !== "running") throw new Error("虚拟机未运行，无需关机。");
        try {
          if (vm.toolsStatus === "missing") {
            throw new Error("VMware Tools unavailable before guest shutdown");
          }
          await session.shutdownGuest(vmMoid);
          const gracefullyPoweredOff = await session.waitForVmPowerState(vmMoid, "halted", 18_000);
          if (!gracefullyPoweredOff) {
            await session.powerOffVm(vmMoid);
          }
        } catch (error) {
          if (!isVmwareGuestShutdownUnavailable(error)) throw error;
          await session.powerOffVm(vmMoid);
        }
        return {
          vmId,
          action,
          accepted: true,
          message: `${vmwareActionLabel(action)}完成：${vm.name}`,
        };
      } else {
        if (vm.powerState === "running") throw new Error("虚拟机正在运行，请先关机后再删除。");
        await session.destroyVm(vmMoid);
      }
      return {
        vmId,
        action,
        accepted: true,
        message: `${vmwareActionLabel(action)}完成：${vm.name}`,
      };
    } finally {
      await session.logout();
    }
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
  return {
    name: textOf(item.props.get("name")),
    type: textOf(item.props.get("summary.type")),
    physicalGiB: bytesToGib(capacity),
    usedGiB: bytesToGib(used),
    virtualGiB: bytesToGib(used),
    shared: textOf(item.props.get("summary.multipleHostAccess")) === "true",
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
    guestOs: normalizeGuestOs(
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
  const pushSample = (metric: MetricSample["metric"], value: number | null, unit: MetricSample["unit"]) => {
    if (value == null) return;
    samples.push({
      id: `${context.connectionId}:${context.targetId}:${metric}:${context.sampledAtMs}`,
      connectionId: context.connectionId,
      targetType: "vm",
      targetId: context.targetId,
      metric,
      value,
      unit,
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

  pushSample("cpu_usage", cpuUsageMhz != null && cpuCapacityMhz != null ? Math.min(cpuUsageMhz / cpuCapacityMhz, 1) : null, "ratio");
  pushSample("memory_used", memoryUsedMb == null ? null : Math.min(memoryUsedMb, memoryTotalMb ?? memoryUsedMb) * 1024 * 1024, "bytes");
  pushSample("memory_total", memoryTotalMb == null ? null : memoryTotalMb * 1024 * 1024, "bytes");
  pushSample("disk_used", diskUsedBytes == null ? null : Math.min(diskUsedBytes, diskTotalBytes ?? diskUsedBytes), "bytes");
  pushSample("disk_total", diskTotalBytes, "bytes");
  pushSample("net_rx", networkRates?.receivedBytesPerSecond ?? null, "bytes_per_sec");
  pushSample("net_tx", networkRates?.transmittedBytesPerSecond ?? null, "bytes_per_sec");
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

function collectVirtualDisks(value: XmlValue, vmId: string): VmwareDiskInfo[] {
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

function normalizeGuestOs(value: string): string | undefined {
  const text = value.trim();
  if (!text) return undefined;
  return text
    .replace(/\s*\(\d+-bit\)\s*/i, " ")
    .replace(/\s+/g, " ")
    .trim();
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
