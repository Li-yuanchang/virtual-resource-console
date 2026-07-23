import type { ProviderType, StoredConnectionSummary, VmNode } from "../types";

export type ConsoleMode = "graph" | "cli";
export type ConsoleTransport = "novnc" | "ssh-pty" | "serial";
export type ConsoleRuntime = "web" | "electron" | "chrome-extension";

export interface ConsoleCapability {
  mode: ConsoleMode;
  available: boolean;
  reasonCode?: "NOT_IMPLEMENTED" | "GUEST_OFFLINE" | "PROVIDER_UNSUPPORTED" | "RUNTIME_UNSUPPORTED";
  message: string;
  transport?: ConsoleTransport;
}

export interface TerminalSessionDescriptor {
  transport: Exclude<ConsoleTransport, "novnc">;
  sessionUrl: string;
  websocketUrl: string;
  runtime: ConsoleRuntime;
  shell?: string;
  planned: boolean;
}

interface ConsoleTargetSummary {
  capabilities: Record<ConsoleMode, ConsoleCapability>;
  label: string;
  title: string;
  vmName: string;
  vmIp?: string;
  hostName?: string;
  hostAddress?: string;
  powerStateLabel?: string;
  cpuCount?: number;
  memoryBytes?: number;
  diskBytes?: number;
  cpuText?: string;
  memoryText?: string;
  diskText?: string;
  providerType: ProviderType;
  aspectRatio?: number;
  connectionId?: string;
  vmId?: string;
}

export interface NoVncVmConsoleTarget extends ConsoleTargetSummary {
  mode: "novnc";
  consoleMode: "graph";
  transport: "novnc";
  wsUrl?: string;
  prepareUrl?: string;
  connection?: ConsoleDirectConnection;
  connectionId?: string;
  vmId?: string;
}

export interface CliVmConsoleTarget extends ConsoleTargetSummary {
  mode: "cli";
  consoleMode: "cli";
  transport: Exclude<ConsoleTransport, "novnc">;
  terminal: TerminalSessionDescriptor;
}

export type VmConsoleTarget = VmConsolePlan;
export type VmConsolePlan = NoVncVmConsoleTarget | CliVmConsoleTarget;

export interface VmConsoleContext {
  connection: Pick<StoredConnectionSummary, "id" | "providerType" | "host" | "port" | "username"> & { password?: string };
  vm: VmNode;
  hostName?: string;
  hostAddress?: string;
  runtime?: ConsoleRuntime;
}

export interface ConsoleDirectConnection {
  providerType: ProviderType;
  host: string;
  port: number;
  username: string;
  password: string;
}

export type ConsoleMetricKey = "cpu" | "memory" | "network" | "disk";

export interface ConsoleMetricsLoadingStrategy {
  readonly placeholderMetrics: readonly ConsoleMetricKey[];
  readonly pollIntervalMs: number;
  readonly memoryUsageLabel?: string;
  readonly memoryPressureTone: boolean;
}

export interface ConsoleDisplayStrategy {
  readonly scaleViewport: boolean;
  readonly resizeSession: boolean;
  readonly qualityLevel: number;
  readonly compressionLevel: number;
}

interface VmConsoleStrategy {
  readonly type: ProviderType;
  readonly metrics?: ConsoleMetricsLoadingStrategy;
  readonly display: ConsoleDisplayStrategy;
  readonly graph: (context: VmConsoleContext) => NoVncVmConsoleTarget | null;
  readonly cli: (context: VmConsoleContext) => CliVmConsoleTarget | null;
}

interface TerminalRuntimePolicy {
  readonly runtime: ConsoleRuntime;
  readonly transport: Exclude<ConsoleTransport, "novnc">;
  readonly available: boolean;
  readonly reasonCode: ConsoleCapability["reasonCode"];
  readonly message: string;
}

const localScaleDisplay: ConsoleDisplayStrategy = {
  scaleViewport: true,
  resizeSession: false,
  qualityLevel: 9,
  compressionLevel: 2,
};

const xenServerConsoleMetrics: ConsoleMetricsLoadingStrategy = {
  placeholderMetrics: ["cpu", "memory", "network", "disk"],
  pollIntervalMs: 2000,
  memoryPressureTone: true,
};

const proxmoxConsoleMetrics: ConsoleMetricsLoadingStrategy = {
  placeholderMetrics: ["cpu", "memory", "network", "disk"],
  pollIntervalMs: 2000,
  memoryUsageLabel: "平台占用",
  memoryPressureTone: false,
};

const vmwareConsoleMetrics: ConsoleMetricsLoadingStrategy = {
  placeholderMetrics: ["cpu", "memory", "network", "disk"],
  pollIntervalMs: 5000,
  memoryUsageLabel: "宿主占用",
  memoryPressureTone: false,
};

const terminalRuntimePolicies: Record<ConsoleRuntime, TerminalRuntimePolicy> = {
  web: {
    runtime: "web",
    transport: "ssh-pty",
    available: true,
    reasonCode: undefined,
    message: "Linux CLI 通过后端 SSH PTY 建立会话。",
  },
  electron: {
    runtime: "electron",
    transport: "ssh-pty",
    available: true,
    reasonCode: undefined,
    message: "客户端 Linux CLI 通过后端 SSH PTY 建立会话。",
  },
  "chrome-extension": {
    runtime: "chrome-extension",
    transport: "ssh-pty",
    available: false,
    reasonCode: "RUNTIME_UNSUPPORTED",
    message: "Chrome 插件不承载长连接终端，请通过 VRC 页面打开 Linux CLI。",
  },
};

const strategies: Record<ProviderType, VmConsoleStrategy> = {
  vmware: {
    type: "vmware",
    metrics: vmwareConsoleMetrics,
    display: localScaleDisplay,
    graph: ({ connection, vm }) => {
      const consoleRef = resolveConsoleRef(vm);
      if (!connection.id || !consoleRef || vm.powerState !== "running") return null;
      return buildGraphTarget({
        providerType: "vmware",
        vm,
        hostName: connection.host,
        hostAddress: connection.host,
        capabilities: buildCapabilities("vmware", "webmks"),
        prepareUrl: "/api/console/vmware/session",
        wsUrl: buildApiWebSocketUrl("/api/console/vmware"),
        title: "打开 VMware WebMKS 控制台",
        connection: buildDirectConnection(connection),
        connectionId: connection.id,
        vmId: consoleRef,
      });
    },
    cli: (context) => buildCliTarget(context, "vmware", "VMware"),
  },
  proxmox: {
    type: "proxmox",
    metrics: proxmoxConsoleMetrics,
    display: localScaleDisplay,
    graph: ({ connection, vm }) => {
      const consoleRef = resolveConsoleRef(vm);
      if (!connection.id || !consoleRef || vm.powerState !== "running") return null;
      return buildGraphTarget({
        providerType: "proxmox",
        vm,
        hostName: connection.host,
        hostAddress: connection.host,
        capabilities: buildCapabilities("proxmox", "novnc"),
        prepareUrl: "/api/console/proxmox/session",
        wsUrl: buildApiWebSocketUrl("/api/console/proxmox"),
        title: "打开 Proxmox VE noVNC 控制台",
        connection: buildDirectConnection(connection),
        connectionId: connection.id,
        vmId: consoleRef,
      });
    },
    cli: (context) => buildCliTarget(context, "proxmox", "Proxmox VE"),
  },
  xenserver: {
    type: "xenserver",
    metrics: xenServerConsoleMetrics,
    display: localScaleDisplay,
    graph: ({ connection, vm }) => {
      const consoleRef = resolveConsoleRef(vm);
      if (!connection.id || !consoleRef || vm.powerState !== "running") return null;
      return buildGraphTarget({
        providerType: "xenserver",
        vm,
        hostName: connection.host,
        hostAddress: connection.host,
        capabilities: buildCapabilities("xenserver", "novnc"),
        prepareUrl: "/api/console/xenserver/session",
        wsUrl: buildApiWebSocketUrl("/api/console/xenserver"),
        title: "打开 XenServer noVNC 控制台",
        connection: buildDirectConnection(connection),
        connectionId: connection.id,
        vmId: consoleRef,
      });
    },
    cli: (context) => buildCliTarget(context, "xenserver", "XenServer"),
  },
  libvirt: {
    type: "libvirt",
    display: localScaleDisplay,
    graph: () => null,
    cli: () => null,
  },
};

export function resolveVmConsoleTarget(context: VmConsoleContext): VmConsolePlan | null {
  const preferredMode = resolvePreferredConsoleMode(context.vm);
  // 渲染器由来宾系统策略决定；CLI 通道不可用时也不能静默切到 noVNC，
  // 否则 Linux Server 会被错误地展示成图形控制台。
  return resolveVmConsolePlan(context, preferredMode);
}

export function resolveVmGraphConsoleTarget(context: VmConsoleContext): NoVncVmConsoleTarget | null {
  const target = resolveVmConsolePlan(context, "graph");
  return target?.mode === "novnc" ? target : null;
}

export function resolveVmConsolePlan(context: VmConsoleContext, mode: ConsoleMode): VmConsolePlan | null {
  const strategy = strategies[context.connection.providerType];
  const target = strategy?.[mode](context) ?? null;
  if (!target) return null;
  return {
    ...target,
    ...buildConsoleSummary(context),
  };
}

export function resolveConsoleCapabilities(context: VmConsoleContext): Record<ConsoleMode, ConsoleCapability> {
  const strategy = strategies[context.connection.providerType];
  return strategy?.graph(context)?.capabilities ?? strategy?.cli(context)?.capabilities ?? buildCapabilities(context.connection.providerType, "none", context.runtime);
}

export function resolveTerminalSessionDescriptor(context: VmConsoleContext): TerminalSessionDescriptor {
  const runtime = context.runtime ?? "web";
  const policy = terminalRuntimePolicies[runtime];
  return {
    transport: policy.transport,
    sessionUrl: "/api/terminal/session",
    websocketUrl: buildApiWebSocketUrl("/api/terminal"),
    runtime,
    shell: "bash",
    planned: !policy.available,
  };
}

function buildDirectConnection(connection: VmConsoleContext["connection"]): ConsoleDirectConnection | undefined {
  if (!connection.password) return undefined;
  return {
    providerType: connection.providerType,
    host: connection.host,
    port: connection.port,
    username: connection.username,
    password: connection.password,
  };
}

export function resolveConsoleMetricsLoadingStrategy(providerType: ProviderType): ConsoleMetricsLoadingStrategy | null {
  return strategies[providerType]?.metrics ?? null;
}

export function resolveConsoleDisplayStrategy(providerType: ProviderType): ConsoleDisplayStrategy {
  return strategies[providerType]?.display ?? localScaleDisplay;
}

interface GraphTargetInput {
  providerType: ProviderType;
  vm: VmNode;
  hostName: string;
  hostAddress: string;
  capabilities: Record<ConsoleMode, ConsoleCapability>;
  prepareUrl: string;
  wsUrl: string;
  title: string;
  connection?: ConsoleDirectConnection;
  connectionId: string;
  vmId: string;
}

function buildGraphTarget(input: GraphTargetInput): NoVncVmConsoleTarget {
  return {
    mode: "novnc",
    consoleMode: "graph",
    transport: "novnc",
    prepareUrl: input.prepareUrl,
    wsUrl: input.wsUrl,
    label: "打开控制台",
    title: input.title,
    vmName: input.vm.name,
    ...buildConsoleSummary({ vm: input.vm, hostName: input.hostName, hostAddress: input.hostAddress }),
    providerType: input.providerType,
    capabilities: input.capabilities,
    connection: input.connection,
    aspectRatio: 4 / 3,
    connectionId: input.connectionId,
    vmId: input.vmId,
  };
}

function buildCliTarget(context: VmConsoleContext, providerType: ProviderType, providerLabel: string): CliVmConsoleTarget | null {
  const { connection, vm } = context;
  const runtime = context.runtime ?? "web";
  const policy = terminalRuntimePolicies[runtime];
  const capabilities = buildCapabilities(providerType, "cli", runtime);
  if (!connection.id || !resolveConsoleRef(vm)) return null;
  return {
    mode: "cli",
    consoleMode: "cli",
    transport: policy.transport,
    label: "Linux CLI",
    title: `${providerLabel} Linux CLI`,
    vmName: vm.name,
    ...buildConsoleSummary({ vm, hostName: connection.host, hostAddress: connection.host }),
    providerType,
    connectionId: connection.id,
    vmId: resolveConsoleRef(vm),
    capabilities,
    terminal: {
      transport: policy.transport,
      sessionUrl: "/api/terminal/session",
      websocketUrl: buildApiWebSocketUrl("/api/terminal"),
      runtime,
      shell: "bash",
      planned: !policy.available,
    },
  };
}

function buildCapabilities(
  providerType: ProviderType,
  graphTransport: "novnc" | "webmks" | "none" | "cli",
  runtime: ConsoleRuntime = "web",
): Record<ConsoleMode, ConsoleCapability> {
  const terminalPolicy = terminalRuntimePolicies[runtime];
  const graphAvailable = graphTransport !== "none" && graphTransport !== "cli";
  return {
    graph: {
      mode: "graph",
      available: graphAvailable,
      transport: graphAvailable ? "novnc" : undefined,
      message: graphAvailable ? "图形控制台可用。" : `${providerType} 暂不提供图形控制台。`,
      reasonCode: graphAvailable ? undefined : "PROVIDER_UNSUPPORTED",
    },
    cli: {
      mode: "cli",
      available: terminalPolicy.available,
      transport: terminalPolicy.transport,
      message: terminalPolicy.message,
      reasonCode: terminalPolicy.reasonCode,
    },
  };
}

function buildConsoleSummary(context: Pick<VmConsoleContext, "vm" | "hostName" | "hostAddress">) {
  return {
    vmIp: context.vm.ipAddresses[0] || "-",
    hostName: context.hostName || context.hostAddress || "-",
    hostAddress: context.hostAddress,
    powerStateLabel: powerStateLabel(context.vm.powerState),
    cpuCount: context.vm.cpuCount,
    memoryBytes: context.vm.memoryBytes,
    diskBytes: context.vm.diskVirtualBytes ?? 0,
    cpuText: context.vm.cpuCount > 0 ? `${context.vm.cpuCount}C` : "-",
    memoryText: formatBytes(context.vm.memoryBytes),
    diskText: formatBytes(context.vm.diskVirtualBytes ?? 0),
  };
}

function powerStateLabel(value: VmNode["powerState"]) {
  if (value === "running") return "运行中";
  if (value === "halted" || value === "stopped") return "已关机";
  if (value === "suspended") return "已暂停";
  return "未知";
}

function formatBytes(value: number) {
  if (!Number.isFinite(value)) return "-";
  const gib = value / 1024 / 1024 / 1024;
  if (gib >= 1) return `${formatNumber(gib)}GiB`;
  return `${formatNumber(value / 1024 / 1024)}MiB`;
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(value);
}

function resolveConsoleRef(vm: VmNode): string {
  return vm.consoleRef || vm.providerId;
}

export function resolvePreferredConsoleMode(vm: VmNode): ConsoleMode {
  const explicitMode = firstMetadataString(vm, ["consoleRenderer", "consoleMode", "terminalType", "terminalMode", "accessMode"]);
  const normalizedMode = explicitMode.toLowerCase();
  if (["cli", "xterm", "linux-cli", "ssh", "ssh-pty", "terminal"].includes(normalizedMode)) return "cli";
  if (["client", "desktop", "graph", "gui", "novnc", "webmks", "platform-console"].includes(normalizedMode)) return "graph";

  const installProfile = firstMetadataString(vm, ["installProfile", "profile"]).toLowerCase();
  if (["server", "cli", "minimal", "core"].includes(installProfile)) return "cli";
  if (installProfile === "desktop" || installProfile === "client") return "graph";

  const guestOs = (vm.guestOs ?? "").trim().toLowerCase();
  if (isDesktopGuestOs(guestOs)) return "graph";

  // Linux without a desktop marker is the server/CLI path. The platform console is
  // still used for Windows and Linux distributions explicitly reporting a desktop.
  if (isLinuxServerGuestOs(guestOs)) return "cli";

  return "graph";
}

function isDesktopGuestOs(guestOs: string): boolean {
  if (!guestOs) return false;
  if (guestOs.includes("windows") || guestOs.includes("mac os") || guestOs.includes("macos")) return true;
  return ["desktop", "workstation", "gnome", "kde", "xfce", "ukui", "deepin", "cinnamon", "mate"].some((token) => guestOs.includes(token));
}

function isLinuxServerGuestOs(guestOs: string): boolean {
  const linuxFamily = ["linux", "centos", "red hat", "rhel", "rocky", "alma", "anolis", "ubuntu", "debian", "suse", "opensuse", "oracle linux", "openeuler", "麒麟", "欧拉", "统信"];
  return linuxFamily.some((token) => guestOs.includes(token));
}

function firstMetadataString(vm: VmNode, keys: string[]): string {
  for (const key of keys) {
    const value = vm.metadata?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function buildApiWebSocketUrl(path: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.hostname || "127.0.0.1";
  const port = window.location.port === "5173" ? "3987" : window.location.port;
  const authority = port ? `${host}:${port}` : host;
  return `${protocol}//${authority}${path}`;
}
