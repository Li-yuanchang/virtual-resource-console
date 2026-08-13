export interface XenConnectionInput {
  host: string;
  port: number;
  username: string;
  password: string;
}

export type ProviderType = "xenserver" | "vmware" | "proxmox" | "libvirt";

export interface ProviderOperationCapability {
  supported: boolean;
  reasonCode?: string;
  message?: string;
}

export interface ProviderRenameCapability extends ProviderOperationCapability {
  maxLength: number;
  pattern?: string;
  patternMessage?: string;
  duplicateScope: string;
  effect: string;
}

export interface ProviderDescriptor {
  type: ProviderType;
  label: string;
  defaultPort: number;
  networkInterfaceLabel: string;
  capabilities: {
    inventory: ProviderOperationCapability;
    isoLibrary: ProviderOperationCapability & { emptyMessage: string; actionHint?: string };
    vmCreate: ProviderOperationCapability;
    vmRename: ProviderRenameCapability;
    vmResize: ProviderOperationCapability;
    vmConsole: ProviderOperationCapability;
    provisioningNetworkProbe: ProviderOperationCapability;
  };
}

export type ResourceStatus = "online" | "offline" | "maintenance" | "unknown";

export type PowerState = "running" | "halted" | "stopped" | "suspended" | "unknown";
export type VmPowerAction = "start" | "shutdown" | "forceReboot" | "delete";

export type ReclaimLevel = "P0" | "P1" | "P2" | "P3" | "KEEP";

export interface PlatformConnection {
  id: string;
  name: string;
  providerType: ProviderType;
  endpoint: string;
  authRef?: string;
  readonly: boolean;
  status: "unknown" | "online" | "offline" | "auth_failed";
  lastCheckedAt?: string;
}

export interface ProviderScope {
  connectionId?: string;
  poolId?: string;
  hostId?: string;
}

export interface ResourcePool {
  id: string;
  connectionId: string;
  providerId: string;
  name: string;
  type: "pool" | "cluster" | "datacenter" | "standalone";
}

export interface HostNode {
  id: string;
  connectionId: string;
  poolId?: string;
  providerId: string;
  name: string;
  address: string;
  vendor: string;
  version: string;
  cpuModel: string;
  cpuSockets: number;
  cpuCores: number;
  memoryTotalBytes: number;
  memoryFreeBytes?: number;
  uptime?: string;
  status: ResourceStatus;
  metadata?: Record<string, unknown>;
}

export interface VmNode {
  id: string;
  connectionId: string;
  hostId?: string;
  providerId: string;
  consoleRef?: string;
  name: string;
  powerState: PowerState;
  cpuCount: number;
  cpuStartup?: number;
  memoryBytes: number;
  diskVirtualBytes?: number;
  diskCount?: number;
  diskSizeSummary?: string;
  ipAddresses: string[];
  guestOs?: string;
  lastShutdownAt?: string | null;
  toolsStatus: "installed" | "missing" | "unknown";
  metrics?: VmMetricSnapshot;
  reclaimLevel: ReclaimLevel;
  reclaimReason: string;
  metadata?: Record<string, unknown>;
}

/** Lightweight VM identity used by cross-host IP/name search. */
export interface VmSearchIndexItem {
  providerId: string;
  hostId?: string;
  name: string;
  ipAddresses: string[];
}

export interface VmInventorySummary {
  total: number;
  running: number;
  halted: number;
  vcpu: number;
  runningVcpu?: number;
  memoryBytes: number;
  runningMemoryBytes?: number;
  diskBytes?: number;
}

export interface VmDisk {
  id: string;
  vmId: string;
  providerId: string;
  name: string;
  device: string;
  displayName?: string;
  virtualSizeBytes: number;
  storageRepositoryId?: string;
  storageRepository?: string;
  onlineResizeSupported?: boolean;
  canOnlineResize?: boolean;
  requiresShutdown?: boolean;
  allowedModes?: Array<"extend" | "add">;
}

export interface GuestStorageMount {
  mountPath: string;
  source: string;
  filesystem: string;
  sizeBytes: number;
  usedBytes: number;
  availableBytes: number;
  guestDiskPath: string;
  guestPartitionPath?: string;
  guestPartitionSizeBytes?: number;
  platformDiskId?: string;
  logicalVolume: boolean;
  pendingCapacityBytes: number;
}

export interface GuestStorageDirectory {
  path: string;
  state: "empty";
}

export interface GuestStorageDisk {
  path: string;
  sizeBytes: number;
  filesystem?: string;
  mountPath?: string;
}

export interface GuestStorageInventory {
  vmIp: string;
  supported: boolean;
  message: string;
  reasonCode?: "GUEST_OFFLINE" | "SYSTEM_EXECUTION_UNAVAILABLE" | "SYSTEM_AUTHENTICATION_REQUIRED";
  disks: GuestStorageDisk[];
  mounts: GuestStorageMount[];
  directories: GuestStorageDirectory[];
}

export interface VirtualDisk {
  id: string;
  providerId: string;
  name: string;
  storageRepositoryId?: string;
  storageRepository: string;
  virtualSizeBytes: number;
  physicalUtilisationBytes: number;
  type: string;
  readOnly: boolean;
  managed: boolean;
}

export interface IsoImage {
  id: string;
  providerId: string;
  name: string;
  sourceType?: "iso-library" | "host-dvd" | "tools";
  storageRepositoryId?: string;
  storageRepository: string;
  path?: string;
  sizeBytes?: number;
  hostId?: string;
  shared?: boolean;
  installProfileHint?: IsoInstallProfileHint;
  metadata?: {
    srDescription?: string;
    physicalUtilisationBytes?: number;
    modifiedAt?: string;
    format?: string;
    ctime?: number;
    [key: string]: unknown;
  };
}

export interface IsoInstallProfileHint {
  available: Array<"server" | "desktop">;
  recommended: "server" | "desktop";
  source: "media-name" | "template" | "default";
}

export interface ProvisioningSpecTemplate {
  id: string;
  name: string;
  cpu: number;
  memoryGiB: number;
  systemDiskGiB: number;
  dataDiskGiB: number;
  description?: string;
}

export interface EnvironmentProvisioningTemplate {
  id: string;
  name: string;
  providerType?: ProviderType;
  sourceType: VmProvisionSourceType;
  isoNamePattern?: string;
  platformTemplateName?: string;
  specId: string;
  ipPoolId: string;
  vmNamePrefix: string;
  autoStart: boolean;
  installStrategy: "template-clone" | "kickstart" | "windows-unattended" | "manual-iso" | "ubuntu-autoinstall";
  installProfile: "server" | "desktop";
  description?: string;
}

export interface IpPoolConfig {
  id: string;
  name: string;
  cidr: string;
  gateway: string;
  dns: string[];
  startIp: string;
  endIp: string;
  reservedIps: string[];
  networkName?: string;
  vlan?: string;
}

export interface ProvisioningConfig {
  environmentTemplates: EnvironmentProvisioningTemplate[];
  specTemplates: ProvisioningSpecTemplate[];
  ipPools: IpPoolConfig[];
}

export type IpLeaseStatus = "reserved" | "released";

export interface IpLease {
  id: string;
  ip: string;
  poolId: string;
  poolName: string;
  scopeKey: string;
  vmName: string;
  loginUsername?: string;
  rootPassword?: string;
  status: IpLeaseStatus;
  createdAt: string;
  updatedAt: string;
}

export interface VmSnapshot {
  id: string;
  vmId: string;
  providerId: string;
  name: string;
  createdAt?: string;
}

export interface VmActionResult {
  vmId: string;
  action: VmPowerAction;
  accepted: boolean;
  message: string;
  command?: string;
}

export interface VmRenameResult {
  vmId: string;
  previousName: string;
  newName: string;
  accepted: boolean;
  message: string;
}

export interface VmResizeDiskRequest {
  mode: "extend" | "add";
  diskId?: string;
  storageRepositoryId?: string;
  sizeBytes: number;
  name?: string;
}

export interface VmResizeStorageTarget {
  mountPath: string;
}

export interface VmSystemCredentials {
  username: string;
  password: string;
  jump?: {
    host: string;
    port: number;
    username: string;
    password: string;
  };
}

export interface VmResizeRequest {
  cpuCount?: number;
  memoryBytes?: number;
  disk?: VmResizeDiskRequest;
  storageTarget?: VmResizeStorageTarget;
  allowShutdown: boolean;
  restartAfterResize: boolean;
}

export interface VmResizeExecutionRequest {
  cpuCount?: number;
  memoryBytes?: number;
  disk?: VmResizeDiskRequest;
  allowShutdown: boolean;
  restartAfterResize: boolean;
  allowNoop?: boolean;
}

export interface VmResizeStorageResult {
  status: "completed" | "failed";
  mountPath: string;
  sizeBytes?: number;
  message: string;
}

export interface VmResizeResult {
  vmId: string;
  name: string;
  accepted: boolean;
  previousCpuCount: number;
  cpuCount: number;
  previousMemoryBytes: number;
  memoryBytes: number;
  disks: VmDisk[];
  stopped: boolean;
  restarted: boolean;
  storage?: VmResizeStorageResult;
  message: string;
}

/**
 * GRUB 启动项读取结果中识别的 GRUB 版本。
 */
export type GuestGrubKind = "grub1" | "grub2" | "unknown";

/**
 * 虚拟机操作系统内可用于设置"下一次启动启动项"的工具。
 */
export type GuestBootEntryTool = "grub2-reboot" | "grub-reboot" | "none" | "unknown";

/**
 * 虚拟机操作系统 GRUB 菜单中的单个启动项（通常对应一个内核）。
 */
export interface GuestBootEntry {
  /** GRUB 菜单中的 0 基序号 */
  index: number;
  /** 菜单标题；GRUB2 子菜单项为 "子菜单>条目" 完整路径 */
  title: string;
  /** 是否为当前默认启动项 */
  isDefault: boolean;
}

/**
 * 虚拟机操作系统 GRUB 启动项读取结果。
 */
export interface GuestBootEntryList {
  grubKind: GuestGrubKind;
  /** 检测到的 GRUB 配置文件路径，如 /boot/grub2/grub.cfg */
  config: string;
  /** 可用的"下一次启动"设置工具 */
  oneTimeTool: GuestBootEntryTool;
  /** 当前默认启动项序号；无法确定时为 null */
  defaultIndex: number | null;
  /** grubenv 中 saved_entry / next_entry 的回读值（GRUB2 且工具可用时） */
  savedEntry?: string;
  /** 供前端展示的说明文案；无异常时为空字符串 */
  message?: string;
  entries: GuestBootEntry[];
}

/**
 * 用户为"关机 / 重启"选择的下一次启动项。
 */
export interface GuestBootEntrySelection {
  /** GRUB 菜单中的 0 基序号 */
  index: number;
  /** 菜单标题；GRUB2 子菜单项为 "子菜单>条目" 完整路径 */
  title: string;
  grubKind: GuestGrubKind;
}

export interface VmActionOptions {
  shutdownTimeoutMs?: number;
  forceOnShutdownFailure?: boolean;
}

export type VmScheduleAction = Exclude<VmPowerAction, "forceReboot" | "delete">;
export type VmScheduleCycle = "once" | "daily" | "weekly";
export type VmScheduleFallback = "force" | "fail";
export type VmScheduleConflictPolicy = "block" | "skip" | "replace";
export type VmScheduleRunStatus = "running" | "success" | "partial" | "failed" | "skipped";

export interface VmScheduleTarget {
  vmId: string;
  name: string;
  connectionId?: string;
  providerType?: ProviderType;
  connectionName?: string;
  hostId?: string;
  hostName?: string;
  ip?: string;
  guestOs?: string;
  powerState?: PowerState;
}

export interface VmScheduleLastRun {
  status: VmScheduleRunStatus;
  startedAt: string;
  finishedAt?: string;
  successCount: number;
  failedCount: number;
  skippedCount: number;
  message: string;
}

export interface VmSchedule {
  id: string;
  name: string;
  connectionId: string;
  providerType: ProviderType;
  connectionName?: string;
  hostId?: string;
  hostName?: string;
  action: VmScheduleAction;
  cycle: VmScheduleCycle;
  onceAt?: string;
  executeTime?: string;
  weekdays?: number[];
  timezone: string;
  skipMatchingState: boolean;
  shutdownTimeoutMinutes: number;
  shutdownFallback: VmScheduleFallback;
  conflictPolicy: VmScheduleConflictPolicy;
  targets: VmScheduleTarget[];
  enabled: boolean;
  nextRunAt?: string;
  lastRun?: VmScheduleLastRun;
  createdAt: string;
  updatedAt: string;
}

export interface VmScheduleRunnerStatus {
  mode: "web" | "electron" | "chrome-native";
  owner: boolean;
  instanceId?: string;
  heartbeatAt?: string;
}

export type VmProvisionSourceType = "iso" | "template";

export interface VmProvisionPlanItem {
  name: string;
  ip: string;
  loginUsername?: string;
  rootPassword?: string;
  cpu: number;
  memoryGiB: number;
  diskGiB: number;
  installSource?: VmProvisionInstallSourceRef;
}

export interface VmProvisionInstallSourceRef {
  id: string;
  taskId?: string;
  ksUrl: string;
  repoUrl: string;
  installedUrl: string;
  autoinstallUrl?: string;
  autoinstallMetaUrl?: string;
}

export interface VmProvisionRequest {
  taskId?: string;
  installStrategy?: "template-clone" | "kickstart" | "windows-unattended" | "manual-iso" | "ubuntu-autoinstall";
  installProfile?: "server" | "desktop";
  connectionId?: string;
  scopeKey?: string;
  providerType: ProviderType;
  hostId?: string;
  environmentTemplateId?: string;
  sourceType: VmProvisionSourceType;
  isoId?: string;
  isoName?: string;
  templateName?: string;
  specId?: string;
  vmNamePrefix: string;
  count: number;
  ipPool: IpPoolConfig;
  autoStart: boolean;
  planItems: VmProvisionPlanItem[];
}

export interface VmProvisionCreatedVm {
  id: string;
  providerId: string;
  name: string;
  powerState: PowerState;
  ip?: string;
  macAddress?: string;
  generatedIsoRegistryId?: string;
}

export interface VmProvisionResult {
  accepted: boolean;
  providerType: ProviderType;
  message: string;
  created: VmProvisionCreatedVm[];
  taskId?: string;
}

export type ProvisionTaskStatus = "pending" | "running" | "success" | "warning" | "failed";

export type ProvisionTaskStepStatus = "pending" | "running" | "success" | "warning" | "failed" | "skipped";

export type ProvisionTaskStepKey =
  | "plan"
  | "publish-source"
  | "create-vm"
  | "boot"
  | "fetch-source"
  | "install-guest"
  | "wait-network"
  | "verify-login"
  | "finalize"
  | "guest-tools"
  | "complete";

export interface ProvisionTaskStep {
  key: ProvisionTaskStepKey;
  name: string;
  status: ProvisionTaskStepStatus;
  message?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface ProvisionTaskVm {
  id?: string;
  providerId?: string;
  name: string;
  ip?: string;
  powerState?: PowerState;
  status: ProvisionTaskStatus;
  currentStep?: ProvisionTaskStepKey;
  progressPercent?: number;
  installPackageTotal?: number;
  installPackageDone?: number;
  message?: string;
  reasonCode?: string;
  readiness?: {
    state: "offline" | "network-visible" | "protocol-ready" | "ready";
    networkVisible: boolean;
    ready: boolean;
  };
  actionHints?: string[];
}

export interface ProvisionTask {
  id: string;
  connectionId?: string;
  providerType: ProviderType;
  hostId?: string;
  environmentTemplateId?: string;
  title: string;
  status: ProvisionTaskStatus;
  currentStep: ProvisionTaskStepKey;
  progressPercent: number;
  eventSeq: number;
  message: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  steps: ProvisionTaskStep[];
  vms: ProvisionTaskVm[];
}

export interface VmQuery {
  connectionId?: string;
  poolId?: string;
  hostId?: string;
  page?: number;
  pageSize?: number;
  keyword?: string;
}

export interface MetricQuery {
  connectionId?: string;
  targetType: "host" | "vm" | "storage" | "network";
  targetIds: string[];
}

export type VmMetricSource = "hypervisor" | "guest-agent" | "guest-tools";

export interface GuestTelemetryState {
  status: "available" | "probing" | "unavailable" | "unknown";
  method: "qemu-guest-agent" | "vmware-tools" | "xenserver-tools" | "unknown";
  message: string;
}

export interface VmMetricSourceMap {
  cpu?: VmMetricSource;
  memory?: VmMetricSource;
  disk?: VmMetricSource;
  network?: VmMetricSource;
}

export interface MetricSample {
  id: string;
  connectionId: string;
  targetType: "host" | "vm" | "storage" | "network";
  targetId: string;
  metric:
    | "cpu_usage"
    | "memory_usage"
    | "memory_used"
    | "memory_total"
    | "disk_used"
    | "disk_total"
    | "disk_read"
    | "disk_write"
    | "net_rx"
    | "net_tx";
  value: number;
  unit: "ratio" | "bytes" | "bytes_per_sec";
  source: VmMetricSource;
  guestTelemetry?: GuestTelemetryState;
  sampledAt: string;
}

export interface PagedResult<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface HostSummary {
  uuid: string;
  name: string;
  address: string;
  enabled: boolean;
  version: string;
  cpuModel: string;
  cpuCount: number;
  socketCount: number;
  memoryTotalGiB: number;
  memoryFreeGiB: number;
  uptime: string;
}

export interface StorageRepository {
  name: string;
  type: string;
  typeLabel: string;
  purposeLabel: string;
  scopeLabel: string;
  mediaLabel: string;
  physicalGiB: number;
  usedGiB: number;
  /** Provider-native provisioned capacity. Null when the platform does not expose an equivalent metric. */
  virtualGiB: number | null;
  shared: boolean;
  hostId?: string;
  content?: string[];
}

export interface CapacityBreakdown {
  physicalTotalGiB: number;
  physicalUsedGiB: number;
  physicalFreeGiB: number;
  physicalStatus: "normal" | "warning" | "danger";
  vmConfiguredGiB: number;
  vmConfigurableGiB: number;
  vmOverconfiguredGiB: number;
  vmStatus: "within-capacity" | "overconfigured";
  /** Platform policy result retained for compatibility with capacity consumers. */
  allocatableGiB: number;
}

export interface MemoryCapacityBreakdown extends CapacityBreakdown {
  runningConfiguredGiB: number;
  haltedConfiguredGiB: number;
  guaranteedHeadroomGiB: number;
  startupDeficitGiB: number;
  startupStatus: "guaranteed" | "at-risk";
}

export interface ResourceCapacitySummary {
  memory: MemoryCapacityBreakdown;
  storage: CapacityBreakdown;
}

export interface NetworkInterface {
  hostId?: string;
  device: string;
  mac: string;
  ip: string;
  netmask: string;
  gateway: string;
  management: boolean;
  attached: boolean;
  network: string;
}

export interface VmSummary {
  uuid: string;
  name: string;
  powerState: string;
  vcpuMax: number;
  vcpuStartup: number;
  memoryGiB: number;
  diskTotalGiB: number;
  diskDetail: string;
  residentHost: string;
  ipAddresses: string[];
  cpuUsage: number | null;
  diskReadRate: number | null;
  diskWriteRate: number | null;
  networkRxRate: number | null;
  networkTxRate: number | null;
  reclaimLevel: "P0" | "P1" | "P2" | "P3" | "KEEP";
  reclaimReason: string;
}

export interface VmMetricSnapshot {
  uuid: string;
  cpuUsage: number | null;
  memoryUsedBytes?: number | null;
  memoryTotalBytes?: number | null;
  diskUsedBytes?: number | null;
  diskTotalBytes?: number | null;
  diskReadRate: number | null;
  diskWriteRate: number | null;
  networkRxRate: number | null;
  networkTxRate: number | null;
  metricSources: VmMetricSourceMap;
  guestTelemetry: GuestTelemetryState;
  sampledAt: string;
}

export interface XenOverview {
  collectedAt: string;
  host: HostSummary;
  storage: StorageRepository[];
  networks: NetworkInterface[];
  vms: VmSummary[];
}

export type HostDiagnosticStatus = "ok" | "warn" | "error" | "unknown";

export type HostDiagnosticCategory = "system" | "storage" | "service" | "network";

export type HostDiagnosticScope = "host" | "vm-link";

export interface HostDiagnosticCheck {
  key: string;
  label: string;
  category: HostDiagnosticCategory;
  scope: HostDiagnosticScope;
  status: HostDiagnosticStatus;
  summary: string;
  evidence?: string[];
  detail?: string;
}

export interface HostDiagnosticRepairAction {
  key: string;
  label: string;
  description: string;
  recommended?: boolean;
  scopeNote: string;
  commands: string[];
  verificationCommands: string[];
}

export interface HostDiagnosticsResult {
  collectedAt: string;
  providerType: ProviderType;
  supported: boolean;
  message?: string;
  hostId?: string;
  hostName: string;
  hostAddress: string;
  vmId?: string;
  vmName?: string;
  vmIp?: string;
  conclusion: {
    summary: string;
    faultPoint?: string;
    impact?: string;
    riskLevel: "none" | "low" | "medium" | "high";
  };
  checks: HostDiagnosticCheck[];
  repairActions: HostDiagnosticRepairAction[];
}

export interface HostDiagnosticsRequest {
  hostId?: string;
  vmId?: string;
  vmName?: string;
  vmIp?: string;
}
