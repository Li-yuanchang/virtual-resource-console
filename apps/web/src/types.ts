export type ProviderType = "xenserver" | "vmware" | "proxmox" | "libvirt";

export type PowerState = "running" | "halted" | "stopped" | "suspended" | "unknown";

export type VmPowerAction = "start" | "shutdown" | "delete";

export type ReclaimLevel = "P0" | "P1" | "P2" | "P3" | "KEEP";

export interface RuntimeIpPoolPolicy {
  id: string;
  name: string;
  prefix: string;
  gateway: string;
  dns?: string[];
  startHost?: number;
  endHost?: number;
  networkName?: string;
  vlan?: string;
}

export interface RuntimePolicy {
  managedIpPattern?: string;
  ipInference: {
    enabled: boolean;
    shortIpBasePrefix?: string;
    shortIpThirdOctets: string[];
    hostOnlyPrefix?: string;
  };
  provisioning: {
    defaultDns: string[];
    rootPasswordTemplate: string;
    providerIpPools: Partial<Record<ProviderType, RuntimeIpPoolPolicy[]>>;
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

export interface VmMetricSnapshot {
  uuid: string;
  cpuUsage: number | null;
  diskReadRate: number | null;
  diskWriteRate: number | null;
  networkRxRate: number | null;
  networkTxRate: number | null;
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
}

export interface VmsResponse {
  collectedAt: string;
  items: VmNode[];
  page: number;
  pageSize: number;
  total: number;
}

export interface VmDisksResponse {
  collectedAt: string;
  disks: VmDisk[];
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

export interface IpProbeResponse {
  probedAt: string;
  results: IpProbeResult[];
}

export interface IpLeaseReservationResponse {
  leases: IpLease[];
}

export interface VmCreateRequest {
  connectionId: string;
  providerType: ProviderType;
  hostId?: string;
  scopeKey?: string;
  environmentTemplateId?: string;
  sourceType: "iso" | "template";
  isoId?: string;
  isoName?: string;
  templateName?: string;
  specId: string;
  spec?: {
    cpu: number;
    memoryGiB: number;
    systemDiskGiB: number;
    dataDiskGiB: number;
  };
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

export interface ProvisionPreflightResponse {
  checkedAt: string;
  ok: boolean;
  checks: ProvisionPreflightCheck[];
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

export interface ProvisionTaskResponse {
  task: ProvisionTask;
}
