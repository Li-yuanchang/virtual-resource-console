import type { ProviderType } from "../types.js";

/**
 * 终端模式。图形控制台由 noVNC 独立处理，本契约只覆盖文本终端。
 */
export type TerminalMode = "linux-cli" | "serial-console";

/** 后端实际建立的双向终端传输。SSE 只适合通知，不承载交互输入。 */
export type TransportKind = "ssh-pty" | "serial-pty";

/** 请求来自哪个产品运行端，用于选择后端会话边界。 */
export type TerminalRuntime = "web" | "electron" | "chrome-extension";

/** 终端会话的可观察生命周期。 */
export type TerminalSessionState = "created" | "active" | "closing" | "closed" | "failed";

/**
 * 结构化失败原因。调用方可按 code 做稳定处理，message 仅用于展示，不应被当作程序逻辑条件。
 */
export type TerminalFailureCode =
  | "PROVIDER_NOT_REGISTERED"
  | "RUNTIME_NOT_ALLOWED"
  | "VM_NOT_RUNNING"
  | "MODE_NOT_SUPPORTED"
  | "SERIAL_UNAVAILABLE"
  | "GUEST_NETWORK_UNAVAILABLE"
  | "SYSTEM_CREDENTIAL_REQUIRED"
  | "NO_TRANSPORT_AVAILABLE";

export interface TerminalSessionRequest {
  connectionId: string;
  vmId: string;
  providerType: ProviderType;
  runtime: TerminalRuntime;
  mode: TerminalMode;
  powerState: "running" | "halted" | "stopped" | "suspended" | "unknown";
  guestOs?: string;
  guestIp?: string;
  hasSystemCredential: boolean;
  hasSerialDevice: boolean;
}

export interface TerminalCapability {
  mode: TerminalMode;
  transports: TransportKind[];
  supported: boolean;
  reasonCode?: TerminalFailureCode;
  message?: string;
  retryable?: boolean;
}

export interface TerminalCapabilitiesResponse {
  connectionId: string;
  vmId: string;
  runtime: TerminalRuntime;
  capabilities: TerminalCapability[];
}

export interface TerminalFailure {
  code: TerminalFailureCode;
  message: string;
  retryable: boolean;
}

export interface TerminalSessionResponse {
  sessionId: string;
  connectionId: string;
  vmId: string;
  runtime: TerminalRuntime;
  mode: TerminalMode;
  transport: TransportKind;
  state: TerminalSessionState;
  expiresAt: string;
  websocketPath: string;
}

export interface TerminalStrategyDecision {
  capabilities: TerminalCapabilitiesResponse;
  session?: Omit<TerminalSessionResponse, "sessionId" | "expiresAt" | "websocketPath" | "state">;
  failure?: TerminalFailure;
}
