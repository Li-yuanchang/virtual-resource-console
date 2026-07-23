import type { ProviderType, XenConnectionInput } from "./types.js";

export type ProvisioningReadinessState = "offline" | "network-visible" | "protocol-ready" | "ready";

export type ProvisioningReadinessReasonCode =
  | "GUEST_OFFLINE"
  | "GUEST_NETWORK_VISIBLE"
  | "GUEST_PROTOCOL_READY"
  | "GUEST_READY";

export interface ProvisioningReadinessSignals {
  windows: boolean;
  protocolReady: boolean;
  arpVisible: boolean;
  hostPingReady: boolean;
}

export interface ProvisioningReadinessResult {
  state: ProvisioningReadinessState;
  reasonCode: ProvisioningReadinessReasonCode;
  networkVisible: boolean;
  ready: boolean;
}

export interface ProvisioningReadinessStrategy {
  readonly providerType: ProviderType;
  readonly usesHostTunnel: boolean;
  readonly supportsHostArp: boolean;
  readonly requiresWindowsHostPing: boolean;
  readonly windowsLoginMode: "guest-credentials" | "host-metrics";
  resolveJumpHost(connection: XenConnectionInput): XenConnectionInput | undefined;
  evaluate(signals: ProvisioningReadinessSignals): ProvisioningReadinessResult;
  finalizeSuccessMessage(): string;
}

class StandardProvisioningReadinessStrategy implements ProvisioningReadinessStrategy {
  readonly usesHostTunnel = false;
  readonly supportsHostArp = false;
  readonly requiresWindowsHostPing = false;
  readonly windowsLoginMode = "guest-credentials" as const;

  constructor(
    readonly providerType: ProviderType,
    private readonly finalizeMessage: string,
  ) {}

  resolveJumpHost(): undefined {
    return undefined;
  }

  evaluate(signals: ProvisioningReadinessSignals): ProvisioningReadinessResult {
    return signals.protocolReady
      ? { state: "ready", reasonCode: "GUEST_READY", networkVisible: true, ready: true }
      : { state: "offline", reasonCode: "GUEST_OFFLINE", networkVisible: false, ready: false };
  }

  finalizeSuccessMessage(): string {
    return this.finalizeMessage;
  }
}

class XenServerProvisioningReadinessStrategy implements ProvisioningReadinessStrategy {
  readonly providerType = "xenserver" as const;
  readonly usesHostTunnel = true;
  readonly supportsHostArp = true;
  readonly requiresWindowsHostPing = true;
  readonly windowsLoginMode = "host-metrics" as const;

  resolveJumpHost(connection: XenConnectionInput): XenConnectionInput {
    return connection;
  }

  evaluate(signals: ProvisioningReadinessSignals): ProvisioningReadinessResult {
    if (!signals.windows) {
      return signals.protocolReady
        ? { state: "ready", reasonCode: "GUEST_READY", networkVisible: true, ready: true }
        : { state: "offline", reasonCode: "GUEST_OFFLINE", networkVisible: false, ready: false };
    }
    if (signals.protocolReady && signals.hostPingReady) {
      return { state: "ready", reasonCode: "GUEST_READY", networkVisible: true, ready: true };
    }
    if (signals.protocolReady) {
      return { state: "protocol-ready", reasonCode: "GUEST_PROTOCOL_READY", networkVisible: true, ready: false };
    }
    if (signals.arpVisible) {
      return { state: "network-visible", reasonCode: "GUEST_NETWORK_VISIBLE", networkVisible: true, ready: false };
    }
    return { state: "offline", reasonCode: "GUEST_OFFLINE", networkVisible: false, ready: false };
  }

  finalizeSuccessMessage(): string {
    return "已固定硬盘启动并清理安装介质";
  }
}

export class ProvisioningReadinessStrategyRegistry {
  private readonly strategies = new Map<ProviderType, ProvisioningReadinessStrategy>();

  register(strategy: ProvisioningReadinessStrategy): this {
    this.strategies.set(strategy.providerType, strategy);
    return this;
  }

  resolve(providerType: ProviderType): ProvisioningReadinessStrategy {
    const strategy = this.strategies.get(providerType);
    if (!strategy) throw new Error(`未注册创建验收策略：${providerType}`);
    return strategy;
  }
}

const readinessStrategies = new ProvisioningReadinessStrategyRegistry()
  .register(new XenServerProvisioningReadinessStrategy())
  .register(new StandardProvisioningReadinessStrategy("proxmox", "系统已从硬盘启动并完成 PVE 收尾"))
  .register(new StandardProvisioningReadinessStrategy("vmware", "系统已从硬盘启动，安装介质将在任务收尾阶段清理"))
  .register(new StandardProvisioningReadinessStrategy("libvirt", "系统已从硬盘启动"));

export function resolveProvisioningReadinessStrategy(providerType: ProviderType): ProvisioningReadinessStrategy {
  return readinessStrategies.resolve(providerType);
}
