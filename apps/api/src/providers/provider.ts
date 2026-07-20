import type {
  HostNode,
  IsoImage,
  MetricQuery,
  MetricSample,
  PagedResult,
  ProviderScope,
  ProviderType,
  ResourcePool,
  VirtualDisk,
  VmActionOptions,
  VmActionResult,
  VmDisk,
  VmInventorySummary,
  VmNode,
  VmPowerAction,
  VmProvisionRequest,
  VmProvisionResult,
  VmQuery,
  VmRenameResult,
  VmResizeRequest,
  VmResizeResult,
  VmSnapshot,
  XenConnectionInput,
  ProvisionTaskStepKey,
  ProvisionTaskStepStatus,
  ProvisionTaskVm,
} from "../types.js";

export interface ConnectionTestResult {
  ok: boolean;
  providerType: ProviderType;
  hostName: string;
  message?: string;
}

export interface ProvisionProgressReporter {
  markStep(stepKey: ProvisionTaskStepKey, status: ProvisionTaskStepStatus, message?: string): void;
  updateVm(vmName: string, patch: Partial<ProvisionTaskVm>, message?: string): void;
  recordTiming?(phase: string, elapsedMs: number, details?: Record<string, unknown>): void;
}

export interface VirtualizationProvider<C> {
  readonly type: ProviderType;
  testConnection(connection: C): Promise<ConnectionTestResult>;
  listPools(connection: C): Promise<ResourcePool[]>;
  listHosts(connection: C, scope?: ProviderScope): Promise<HostNode[]>;
  listHostSummary(connection: C, hostId: string): Promise<HostNode>;
  summarizeVms?(connection: C, query: VmQuery): Promise<VmInventorySummary>;
  listVms(connection: C, query: VmQuery): Promise<PagedResult<VmNode>>;
  listVmDisks(connection: C, vmId: string): Promise<VmDisk[]>;
  listVirtualDisks(connection: C, scope?: ProviderScope): Promise<VirtualDisk[]>;
  listIsoImages?(connection: C, scope?: ProviderScope): Promise<IsoImage[]>;
  listVmSnapshots(connection: C, vmId: string): Promise<VmSnapshot[]>;
  performVmAction?(connection: C, vmId: string, action: VmPowerAction, options?: VmActionOptions): Promise<VmActionResult>;
  renameVm?(connection: C, vmId: string, currentName: string, newName: string): Promise<VmRenameResult>;
  resizeVm?(connection: C, vmId: string, request: VmResizeRequest): Promise<VmResizeResult>;
  createVms?(connection: C, request: VmProvisionRequest, reporter?: ProvisionProgressReporter): Promise<VmProvisionResult>;
  collectMetrics(connection: C, query: MetricQuery): Promise<MetricSample[]>;
}

export type SupportedConnection = XenConnectionInput;

export class ProviderRegistry {
  private readonly providers = new Map<ProviderType, VirtualizationProvider<SupportedConnection>>();

  register(provider: VirtualizationProvider<SupportedConnection>) {
    this.providers.set(provider.type, provider);
  }

  get(type: ProviderType): VirtualizationProvider<SupportedConnection> {
    const provider = this.providers.get(type);
    if (!provider) {
      throw new Error(`未注册虚拟化平台 Provider: ${type}`);
    }
    return provider;
  }
}
