export interface XenConnectionInput {
  host: string;
  port: number;
  username: string;
  password: string;
}

export type ProviderType = "xenserver" | "vmware" | "proxmox" | "libvirt";

export type ResourceStatus = "online" | "offline" | "maintenance" | "unknown";

export type PowerState = "running" | "halted" | "stopped" | "suspended" | "unknown";
export type VmPowerAction = "start" | "shutdown" | "delete";

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
  toolsStatus: "installed" | "missing" | "unknown";
  metrics?: VmMetricSnapshot;
  reclaimLevel: ReclaimLevel;
  reclaimReason: string;
  metadata?: Record<string, unknown>;
}

export interface VmInventorySummary {
  total: number;
  running: number;
  halted: number;
  vcpu: number;
  memoryBytes: number;
  diskBytes?: number;
}

export interface VmDisk {
  id: string;
  vmId: string;
  providerId: string;
  name: string;
  device: string;
  virtualSizeBytes: number;
  storageRepository?: string;
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
  storageRepositoryId?: string;
  storageRepository: string;
  path?: string;
  sizeBytes?: number;
  hostId?: string;
  shared?: boolean;
  metadata?: {
    srDescription?: string;
    physicalUtilisationBytes?: number;
    modifiedAt?: string;
    format?: string;
    ctime?: number;
    [key: string]: unknown;
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
  sourceType: VmProvisionSourceType;
  isoNamePattern?: string;
  platformTemplateName?: string;
  specId: string;
  ipPoolId: string;
  vmNamePrefix: string;
  autoStart: boolean;
  installStrategy: "template-clone" | "kickstart" | "manual-iso";
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
}

export interface VmProvisionRequest {
  connectionId?: string;
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
}

export interface VmProvisionResult {
  accepted: boolean;
  providerType: ProviderType;
  message: string;
  created: VmProvisionCreatedVm[];
  taskId?: string;
}

export type ProvisionTaskStatus = "pending" | "running" | "success" | "failed";

export type ProvisionTaskStepStatus = "pending" | "running" | "success" | "failed" | "skipped";

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
  message?: string;
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

export interface MetricSample {
  id: string;
  connectionId: string;
  targetType: "host" | "vm" | "storage" | "network";
  targetId: string;
  metric: "cpu_usage" | "memory_usage" | "disk_read" | "disk_write" | "net_rx" | "net_tx";
  value: number;
  unit: "ratio" | "bytes" | "bytes_per_sec";
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
  physicalGiB: number;
  usedGiB: number;
  virtualGiB: number;
  shared: boolean;
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
  diskReadRate: number | null;
  diskWriteRate: number | null;
  networkRxRate: number | null;
  networkTxRate: number | null;
  sampledAt: string;
}

export interface XenOverview {
  collectedAt: string;
  host: HostSummary;
  storage: StorageRepository[];
  networks: NetworkInterface[];
  vms: VmSummary[];
}
