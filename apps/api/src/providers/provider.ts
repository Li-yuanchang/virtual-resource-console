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
  VmSearchIndexItem,
  VmPowerAction,
  VmProvisionRequest,
  VmProvisionResult,
  VmQuery,
  VmRenameResult,
  VmResizeExecutionRequest,
  VmResizeResult,
  VmSnapshot,
  HostDiagnosticsRequest,
  HostDiagnosticsResult,
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
  listVmSearchIndex?(connection: C, scope?: ProviderScope): Promise<VmSearchIndexItem[]>;
  listVmDisks(connection: C, vmId: string): Promise<VmDisk[]>;
  /**
   * Executes a command inside the guest through a platform-provided guest agent.
   * The method is optional because not every provider exposes guest operations.
   */
  executeGuestCommand?(connection: C, vmId: string, command: string, timeoutMs: number): Promise<string>;
  listVirtualDisks(connection: C, scope?: ProviderScope): Promise<VirtualDisk[]>;
  listIsoImages?(connection: C, scope?: ProviderScope): Promise<IsoImage[]>;
  listVmSnapshots(connection: C, vmId: string): Promise<VmSnapshot[]>;
  performVmAction?(connection: C, vmId: string, action: VmPowerAction, options?: VmActionOptions): Promise<VmActionResult>;
  renameVm?(connection: C, vmId: string, currentName: string, newName: string): Promise<VmRenameResult>;
  resizeVm?(connection: C, vmId: string, request: VmResizeExecutionRequest): Promise<VmResizeResult>;
  createVms?(connection: C, request: VmProvisionRequest, reporter?: ProvisionProgressReporter): Promise<VmProvisionResult>;
  /**
   * 宿主机只读诊断：以宿主机为主语，可选携带 VM 线索补充链路检查。
   * 实现方必须保证只读，不执行任何会改变宿主机/VM 状态的操作。
   * 未实现该能力的 Provider 应返回 supported=false 的结果。
   */
  runHostDiagnostics?(connection: C, request: HostDiagnosticsRequest): Promise<HostDiagnosticsResult>;
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
