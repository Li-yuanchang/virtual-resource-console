import type { ProviderType } from "../types.js";
import type {
  TerminalCapability,
  TerminalCapabilitiesResponse,
  TerminalFailure,
  TerminalMode,
  TerminalRuntime,
  TerminalSessionRequest,
  TerminalStrategyDecision,
  TransportKind,
} from "./contracts.js";

interface TransportCandidate {
  readonly mode: TerminalMode;
  readonly transport: TransportKind;
  readonly available: (input: TerminalSessionRequest) => boolean;
  readonly unavailable: (input: TerminalSessionRequest) => TerminalFailure;
}

interface TerminalProviderStrategy {
  readonly providerType: ProviderType;
  readonly candidates: readonly TransportCandidate[];
}

const serialCandidate: TransportCandidate = {
  mode: "serial-console",
  transport: "serial-pty",
  available: (input) => input.powerState === "running" && input.hasSerialDevice,
  unavailable: () => ({
    code: "SERIAL_UNAVAILABLE",
    message: "虚拟机没有可用的串口终端。",
    retryable: false,
  }),
};

const sshCandidate: TransportCandidate = {
  mode: "linux-cli",
  transport: "ssh-pty",
  available: (input) => input.powerState === "running" && Boolean(input.guestIp) && input.hasSystemCredential,
  unavailable: (input) => {
    const failureByCondition: Array<[boolean, TerminalFailure]> = [
      [input.powerState !== "running", { code: "VM_NOT_RUNNING", message: "虚拟机未开机，暂时无法打开 Linux CLI。", retryable: true }],
      [!input.guestIp, { code: "GUEST_NETWORK_UNAVAILABLE", message: "尚未获取虚拟机 IP，暂时无法打开 Linux CLI。", retryable: true }],
      [!input.hasSystemCredential, { code: "SYSTEM_CREDENTIAL_REQUIRED", message: "请输入 Linux 登录账号和密码。", retryable: true }],
    ];
    return failureByCondition.find(([condition]) => condition)?.[1] ?? {
      code: "NO_TRANSPORT_AVAILABLE",
      message: "当前没有可用的 Linux CLI 通道。",
      retryable: true,
    };
  },
};

const providerStrategies: ReadonlyMap<ProviderType, TerminalProviderStrategy> = new Map([
  ["proxmox", { providerType: "proxmox", candidates: [serialCandidate, sshCandidate] }],
  ["xenserver", { providerType: "xenserver", candidates: [sshCandidate] }],
  ["vmware", { providerType: "vmware", candidates: [sshCandidate] }],
  ["libvirt", { providerType: "libvirt", candidates: [sshCandidate] }],
]);

const runtimeAllowed = new Set<TerminalRuntime>(["web", "electron"]);

export interface TerminalStrategy {
  readonly providerType: ProviderType;
  describe(input: TerminalSessionRequest): TerminalCapability[];
  select(input: TerminalSessionRequest): TerminalStrategyDecision;
}

class RegisteredTerminalStrategy implements TerminalStrategy {
  constructor(private readonly definition: TerminalProviderStrategy) {}

  get providerType(): ProviderType {
    return this.definition.providerType;
  }

  describe(input: TerminalSessionRequest): TerminalCapability[] {
    return this.definition.candidates.map((candidate) => {
      const available = candidate.available(input);
      const failure = available ? undefined : candidate.unavailable(input);
      return {
        mode: candidate.mode,
        transports: [candidate.transport],
        supported: available,
        ...(failure
          ? { reasonCode: failure.code, message: failure.message, retryable: failure.retryable }
          : {}),
      };
    });
  }

  select(input: TerminalSessionRequest): TerminalStrategyDecision {
    const capabilities: TerminalCapabilitiesResponse = {
      connectionId: input.connectionId,
      vmId: input.vmId,
      runtime: input.runtime,
      capabilities: this.describe(input),
    };
    const requested = this.definition.candidates.find((candidate) => candidate.mode === input.mode);
    if (!requested) return { capabilities, failure: unsupportedMode(input.mode) };
    if (!requested.available(input)) return { capabilities, failure: requested.unavailable(input) };
    return {
      capabilities,
      session: {
        connectionId: input.connectionId,
        vmId: input.vmId,
        runtime: input.runtime,
        mode: requested.mode,
        transport: requested.transport,
      },
    };
  }
}

class UnsupportedProviderStrategy implements TerminalStrategy {
  constructor(readonly providerType: ProviderType) {}

  describe(): TerminalCapability[] {
    return [];
  }

  select(input: TerminalSessionRequest): TerminalStrategyDecision {
    return {
      capabilities: { connectionId: input.connectionId, vmId: input.vmId, runtime: input.runtime, capabilities: [] },
      failure: { code: "PROVIDER_NOT_REGISTERED", message: "当前平台未注册终端策略。", retryable: false },
    };
  }
}

function unsupportedMode(mode: TerminalMode): TerminalFailure {
  return { code: "MODE_NOT_SUPPORTED", message: `当前虚拟机不支持${mode === "linux-cli" ? " Linux CLI" : "串口终端"}。`, retryable: false };
}

class TerminalStrategyRegistry {
  private readonly strategies = new Map<ProviderType, TerminalStrategy>();

  register(strategy: TerminalStrategy): this {
    this.strategies.set(strategy.providerType, strategy);
    return this;
  }

  resolve(providerType: ProviderType): TerminalStrategy {
    return this.strategies.get(providerType) ?? new UnsupportedProviderStrategy(providerType);
  }
}

const registry = new TerminalStrategyRegistry();
for (const definition of providerStrategies.values()) registry.register(new RegisteredTerminalStrategy(definition));

export function resolveTerminalStrategy(providerType: ProviderType): TerminalStrategy {
  return registry.resolve(providerType);
}

export function selectTerminalStrategy(input: TerminalSessionRequest): TerminalStrategyDecision {
  const strategy = resolveTerminalStrategy(input.providerType);
  if (!runtimeAllowed.has(input.runtime)) {
    return {
      capabilities: { connectionId: input.connectionId, vmId: input.vmId, runtime: input.runtime, capabilities: [] },
      failure: { code: "RUNTIME_NOT_ALLOWED", message: "当前运行端不允许建立终端会话。", retryable: false },
    };
  }
  return strategy.select(input);
}
