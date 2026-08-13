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

export interface ProviderDescriptorsResponse {
  providers: ProviderDescriptor[];
}

export type PowerState = "running" | "halted" | "stopped" | "suspended" | "unknown";

export type VmPowerAction = "start" | "shutdown" | "forceReboot" | "delete";

export type VmScheduleAction = Exclude<VmPowerAction, "forceReboot" | "delete">;
export type VmScheduleCycle = "once" | "daily" | "weekly";
export type VmScheduleFallback = "force" | "fail";
export type VmScheduleConflictPolicy = "block" | "skip" | "replace";
export type VmScheduleRunStatus = "running" | "success" | "partial" | "failed" | "skipped";

export type ReclaimLevel = "P0" | "P1" | "P2" | "P3" | "KEEP";

export interface RuntimePolicy {
  managedIpPattern?: string;
  ipInference: {
    enabled: boolean;
    shortIpBasePrefix?: string;
    shortIpThirdOctets: string[];
    shortIpPrefixes: string[];
    hostOnlyPrefix?: string;
  };
  provisioning: {
    rootPasswordTemplate: string;
  };
  xenserver: {
    networkDeviceRules: Array<{
      ipPrefix: string;
      device: string;
    }>;
  };
}

export interface RuntimePolicyResponse {
  policy: RuntimePolicy;
}

export interface RuntimeIpPoolPolicy {
  id: string;
  name: string;
  prefix: string;
  gateway: string;
  dns?: string[];
  startHost?: number;
  endHost?: number;
  hostPrefixes?: string[];
  networkName?: string;
  vlan?: string;
}

export interface IpPoolPolicy {
  defaultDns: string[];
  ipPools: RuntimeIpPoolPolicy[];
}

export interface IpPoolPolicyResponse {
  policy: IpPoolPolicy;
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
  status: "online" | "offline" | "maintenance" | "unknown";
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

export interface VmSearchIndexItem {
  providerId: string;
  hostId?: string;
  name: string;
  ipAddresses: string[];
}

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

export interface VmScheduleTargetCatalogResponse {
  targets: VmScheduleTarget[];
  errors: Array<{
    connectionId: string;
    connectionName?: string;
    message: string;
  }>;
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

export interface VmSchedulesResponse {
  tasks: VmSchedule[];
  runner: VmScheduleRunnerStatus;
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

export type GuestGrubKind = "grub1" | "grub2" | "unknown";

export type GuestBootEntryTool = "grub2-reboot" | "grub-reboot" | "none" | "unknown";

export interface GuestBootEntry {
  index: number;
  title: string;
  isDefault: boolean;
}

export interface GuestBootEntryList {
  grubKind: GuestGrubKind;
  config: string;
  oneTimeTool: GuestBootEntryTool;
  defaultIndex: number | null;
  savedEntry?: string;
  message?: string;
  entries: GuestBootEntry[];
}

export interface GuestBootEntrySelection {
  index: number;
  title: string;
  grubKind: GuestGrubKind;
}

export interface VmResizeRequest {
  cpuCount?: number;
  memoryBytes?: number;
  disk?: VmResizeDiskRequest;
  storageTarget?: VmResizeStorageTarget;
  systemCredentials?: VmSystemCredentials;
  allowShutdown: boolean;
  restartAfterResize: boolean;
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
  metricSources?: {
    cpu?: "hypervisor" | "guest-agent" | "guest-tools";
    memory?: "hypervisor" | "guest-agent" | "guest-tools";
    disk?: "hypervisor" | "guest-agent" | "guest-tools";
    network?: "hypervisor" | "guest-agent" | "guest-tools";
  };
  guestTelemetry?: {
    status: "available" | "probing" | "unavailable" | "unknown";
    method: "qemu-guest-agent" | "vmware-tools" | "xenserver-tools" | "unknown";
    message: string;
  };
  sampledAt: string;
}

export interface StoredConnectionSummary {
  id: string;
  name: string;
  providerType: ProviderType;
  host: string;
  port: number;
  username: string;
  readonly: boolean;
  createdAt: string;
  updatedAt: string;
  lastConnectedAt?: string;
}

export interface HostsResponse {
  collectedAt: string;
  hosts: HostNode[];
  storage: StorageRepository[];
  networks: NetworkInterface[];
  source?: "cache" | "live";
  cacheUpdatedAt?: string;
  refreshing?: boolean;
}

export interface VmsResponse {
  collectedAt: string;
  items: VmNode[];
  page: number;
  pageSize: number;
  total: number;
  source?: "cache" | "live";
  cacheUpdatedAt?: string;
  refreshing?: boolean;
}

export interface VmSearchIndexResponse {
  collectedAt: string;
  items: VmSearchIndexItem[];
  source?: "cache" | "live";
  cacheUpdatedAt?: string;
  refreshing?: boolean;
}

export interface VmDisksResponse {
  collectedAt: string;
  disks: VmDisk[];
}

export interface VmSnapshot {
  id: string;
  vmId: string;
  providerId: string;
  name: string;
  createdAt?: string;
}

export interface VmSnapshotsResponse {
  collectedAt: string;
  snapshots: VmSnapshot[];
}

export interface HostVmSnapshotGroup {
  vm: {
    providerId: string;
    name: string;
    powerState: PowerState;
  };
  snapshots: VmSnapshot[];
  error?: string;
}

export interface HostVmSnapshotsResponse {
  collectedAt: string;
  hostId: string;
  items: HostVmSnapshotGroup[];
}

export interface GuestStorageResponse {
  inventory: GuestStorageInventory;
}

export interface VirtualDisksResponse {
  collectedAt: string;
  disks: VirtualDisk[];
}

export interface IsoImagesResponse {
  collectedAt: string;
  images: IsoImage[];
  source?: "cache" | "live" | "unsupported";
  cacheUpdatedAt?: string;
  refreshing?: boolean;
  emptyState?: {
    reasonCode: string;
    message: string;
    actionHint?: string;
  };
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
  sourceType: "iso" | "template";
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

export interface ProvisioningConfigResponse {
  config: ProvisioningConfig;
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

export interface IpLeasesResponse {
  leases: IpLease[];
}

export type IpProbeStatus = "available" | "occupied" | "reserved" | "reachable";

export interface IpProbeResult {
  ip: string;
  status: IpProbeStatus;
  reason: string;
}

export interface ProvisioningNetworkProbeResult {
  status: "reachable" | "route-only" | "unreachable";
  message: string;
  installHost?: string;
  routeAvailable: boolean;
  gatewayReachable: boolean;
  respondingTarget?: string;
}

export interface IpProbeResponse {
  probedAt: string;
  results: IpProbeResult[];
  network?: ProvisioningNetworkProbeResult;
}

export interface IpLeaseReservationResponse {
  leases: IpLease[];
}

export interface VmCreateRequest {
  connectionId?: string;
  providerType: ProviderType;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  hostId?: string;
  scopeKey?: string;
  environmentTemplateId?: string;
  sourceType: "iso" | "template";
  installStrategy?: "template-clone" | "kickstart" | "windows-unattended" | "manual-iso" | "ubuntu-autoinstall";
  installProfile?: "server" | "desktop";
  isoId?: string;
  isoName?: string;
  templateName?: string;
  specId: string;
  vmNamePrefix: string;
  count: number;
  ipPool: IpPoolConfig;
  autoStart: boolean;
  planItems?: Array<{
    name: string;
    ip: string;
    loginUsername?: string;
    rootPassword?: string;
    cpu?: number;
    memoryGiB?: number;
    diskGiB?: number;
  }>;
}

export interface VmProvisionCreatedVm {
  id: string;
  providerId: string;
  name: string;
  powerState: PowerState;
  ip?: string;
  macAddress?: string;
}

export interface VmProvisionResponse {
  operatedAt: string;
  result: {
    accepted: boolean;
    providerType: ProviderType;
    message: string;
    created: VmProvisionCreatedVm[];
    taskId?: string;
  };
  task?: ProvisionTask;
}

export type ProvisionPreflightStatus = "success" | "warning" | "error";

export interface ProvisionPreflightCheck {
  key: string;
  label: string;
  status: ProvisionPreflightStatus;
  message: string;
  details?: Record<string, unknown>;
}

export interface ProvisionPreflightIssue {
  code: string;
  label: string;
  severity: "blocking" | "warning" | "info";
  message: string;
  actionHint?: string;
}

export interface ProvisionPreflightResponse {
  checkedAt: string;
  ok: boolean;
  operationSummary: string;
  checks: ProvisionPreflightCheck[];
  issues: ProvisionPreflightIssue[];
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

export interface ProvisionTaskResponse {
  task: ProvisionTask;
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

export interface HostDiagnosticsRequest {
  hostId?: string;
  vmId?: string;
  vmName?: string;
  vmIp?: string;
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

export type HostDiagnosticsResponse = HostDiagnosticsResult;
