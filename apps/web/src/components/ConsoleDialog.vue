<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import RFB from "@novnc/novnc";
import type { ITheme } from "@xterm/xterm";
import { ElDialog } from "element-plus";
import { Close, CopyDocument, FullScreen, Monitor, Refresh } from "@element-plus/icons-vue";
import ConsoleVmMetrics from "./ConsoleVmMetrics.vue";
import VrcLogoMark from "./VrcLogoMark.vue";
import type { NoVncVmConsoleTarget, VmConsoleTarget } from "../domain/consoleStrategies";
import { resolveConsoleDisplayStrategy, resolveConsoleMetricsLoadingStrategy } from "../domain/consoleStrategies";
import type { TerminalConsoleInstance, TerminalInputEvent, TerminalReadyEvent, TerminalResizeEvent } from "./TerminalConsole.vue";
import {
  normalizeConsoleClipboardText,
  normalizeConsoleTextInput,
} from "../domain/consoleTextInput";
import { getProviderBrand } from "../domain/providerBrand";
import { SecureRequestError, secureJsonRequest } from "../domain/secureRequest";
import { TerminalLoginPrompt, type TerminalSessionCredentials } from "../domain/terminalLogin";
import type { ProvisionTask, ProvisionTaskStep, ProvisionTaskStepKey, ProvisionTaskVm, VmMetricSnapshot } from "../types";

const TerminalConsole = defineAsyncComponent(() => import("./TerminalConsole.vue"));

interface ProvisionConsoleTargetItem {
  key: string;
  name: string;
  ip?: string;
  status: ProvisionTaskVm["status"];
  message?: string;
  progressPercent?: number;
  currentStep?: ProvisionTaskVm["currentStep"];
  installPackageDone?: number;
  installPackageTotal?: number;
  target: VmConsoleTarget | null;
}

const props = defineProps<{
  visible: boolean;
  target: VmConsoleTarget | null;
  provisionTask?: ProvisionTask | null;
  provisionTargets?: ProvisionConsoleTargetItem[];
  embedded?: boolean;
  terminalFontFamily?: string;
  terminalFontSize?: number;
  terminalLineHeight?: number;
  terminalCursorStyle?: "block" | "underline" | "bar";
  terminalCursorBlink?: boolean;
  terminalTheme?: ITheme;
  displayScaleMode?: "local" | "remote";
  displayQuality?: "auto" | "high" | "smooth";
  throttleResize?: boolean;
  watermarkEnabled?: boolean;
  watermarkDensity?: "sparse" | "standard" | "dense";
  watermarkOpacity?: number;
  watermarkText?: string;
  showIconTooltips?: boolean;
}>();

const emit = defineEmits<{
  "update:visible": [value: boolean];
  "select-provision-target": [value: ProvisionConsoleTargetItem];
  "upload-result": [
    value: {
      vmName: string;
      vmIp: string;
      status: "success" | "error";
      message: string;
      files: string[];
      remotePaths: string[];
    },
  ];
}>();

const screenRef = ref<HTMLElement | null>(null);
const consoleFrameRef = ref<HTMLElement | null>(null);
const clipboardCaptureRef = ref<HTMLTextAreaElement | null>(null);
const terminalConsoleRef = ref<TerminalConsoleInstance | null>(null);
const dialogRef = ref<{ $el?: Element } | null>(null);
const statusText = ref("等待连接");
const connected = ref(false);
const consoleNoticeText = ref("");
const terminalSession = ref<TerminalSessionDescriptor | null>(null);
const terminalStatus = ref<TerminalConnectionStatus>("idle");
const terminalErrorMessage = ref("");
const terminalLoginDisplay = ref("");
const terminalLoginPrompt = new TerminalLoginPrompt();
const consolePasteSending = ref(false);
const uploadDragActive = ref(false);
const uploadStatusText = ref("");
const uploadStatusLevel = ref<"info" | "success" | "error">("info");
const uploadBusy = ref(false);
const uploadProgressVisible = ref(false);
const uploadProgressTitle = ref("");
const uploadProgressDetail = ref("");
const uploadProgressPercent = ref(0);
const uploadProgressMeta = ref("");
const consoleAspectRatio = ref(4 / 3);
const consoleFrameReady = ref(false);
const dialogSize = reactive({
  width: 0,
  height: 0,
});
const isResizing = ref(false);
const isExpanded = ref(false);
const metricsOverlayVisible = ref(true);
const consoleMetricSnapshot = ref<VmMetricSnapshot | null>(null);
const consoleMetricsLoading = ref(false);
const normalDialogSize = reactive({
  width: 0,
  height: 0,
});

const DIALOG_HORIZONTAL_MARGIN = 32;
const DIALOG_VERTICAL_MARGIN = 64;
const DIALOG_DRAG_VIEWPORT_MARGIN = 8;
const MIN_DIALOG_WIDTH = 720;
const MIN_DIALOG_HEIGHT = 480;
const DEFAULT_DIALOG_MAX_WIDTH = 1680;
const DEFAULT_DIALOG_MAX_HEIGHT = 920;
const DEFAULT_NORMAL_SCREEN_WIDTH = 980;
const DEFAULT_NORMAL_SCREEN_HEIGHT = 620;
const DEFAULT_EXPANDED_SCREEN_WIDTH = 1280;
const DEFAULT_EXPANDED_SCREEN_HEIGHT = 720;
const NORMAL_CONSOLE_SIDE_WIDTH = 330;
const NORMAL_CONSOLE_LAYOUT_GAP = 14;
const NORMAL_CONSOLE_LAYOUT_HORIZONTAL_PADDING = 20;
const NORMAL_CONSOLE_LAYOUT_VERTICAL_PADDING = 10;
const NORMAL_CONSOLE_BORDER_ALLOWANCE = 4;
const NORMAL_CONSOLE_HEADER_HEIGHT = 48;
const CONSOLE_TITLEBAR_HEIGHT = 44;
const CONSOLE_WAKE_REFRESH_DELAY_MS = 260;
const CONSOLE_RETRY_DELAY_MS = 2500;
const CONSOLE_CONNECT_ATTEMPT_TIMEOUT_MS = 20_000;
const TERMINAL_CONNECT_TIMEOUT_MS = 20_000;
const CONSOLE_FRAME_REVEAL_RETRY_LIMIT = 80;
const CONSOLE_FRAME_REVEAL_RETRY_DELAY_MS = 180;
const CONSOLE_FRAME_RECONNECT_TIMEOUT_MS = 8000;
const CONSOLE_STAGE_RECONNECT_DELAY_MS = 500;
const CONSOLE_PROVISION_BLANK_RECONNECT_DELAY_MS = 8000;
const CONSOLE_PROVISION_BLANK_RECONNECT_MAX_DELAY_MS = 30000;
const CONSOLE_PROVISION_STALE_SAMPLE_INTERVAL_MS = 5000;
const CONSOLE_PROVISION_STALE_RECONNECT_DELAY_MS = 30000;
const CONSOLE_PROVISION_STALE_RECONNECT_MAX_DELAY_MS = 120000;
const CONSOLE_PROVISION_FRAME_SAMPLE_WIDTH = 32;
const CONSOLE_PROVISION_FRAME_SAMPLE_HEIGHT = 24;
const CONSOLE_MODIFIER_RELEASE_DELAY_MS = 12;
const CONSOLE_NATIVE_PASTE_CAPTURE_TIMEOUT_MS = 1200;
const CONSOLE_MAX_PASTE_CHARACTERS = 5000;
const CONSOLE_PASTE_SHORTCUT_LABEL = /Mac|iPhone|iPad/i.test(navigator.platform) ? "Cmd+V" : "Ctrl+V";
const CONSOLE_ASPECT_RATIO_CACHE_KEY = "virtual-resource-console:console-aspect-ratio";
const CONSOLE_TEXT_KEY_HOLD_MS = 10;
const CONSOLE_TEXT_SEND_INTERVAL_MS = 2;
const CONSOLE_TEXT_SHIFT_SETTLE_MS = 4;
const CONSOLE_CTRL_C_MODIFIER_SETTLE_MS = 18;
const CONSOLE_CTRL_C_KEY_HOLD_MS = 28;
const CONSOLE_BACKSPACE_KEY_HOLD_MS = 12;
const CONSOLE_BACKSPACE_REPEAT_DELAY_MS = 220;
const CONSOLE_BACKSPACE_REPEAT_INTERVAL_MS = 24;
const CONSOLE_KEY_STROKE_MAP: Record<string, { keysym: number; code: string; shift?: boolean }> = {
  " ": { keysym: 0x20, code: "Space" },
  "`": { keysym: 0x60, code: "Backquote" },
  "~": { keysym: 0x7e, code: "Backquote", shift: true },
  "1": { keysym: 0x31, code: "Digit1" },
  "!": { keysym: 0x21, code: "Digit1", shift: true },
  "2": { keysym: 0x32, code: "Digit2" },
  "@": { keysym: 0x40, code: "Digit2", shift: true },
  "3": { keysym: 0x33, code: "Digit3" },
  "#": { keysym: 0x23, code: "Digit3", shift: true },
  "4": { keysym: 0x34, code: "Digit4" },
  "$": { keysym: 0x24, code: "Digit4", shift: true },
  "5": { keysym: 0x35, code: "Digit5" },
  "%": { keysym: 0x25, code: "Digit5", shift: true },
  "6": { keysym: 0x36, code: "Digit6" },
  "^": { keysym: 0x5e, code: "Digit6", shift: true },
  "7": { keysym: 0x37, code: "Digit7" },
  "&": { keysym: 0x26, code: "Digit7", shift: true },
  "8": { keysym: 0x38, code: "Digit8" },
  "*": { keysym: 0x2a, code: "Digit8", shift: true },
  "9": { keysym: 0x39, code: "Digit9" },
  "(": { keysym: 0x28, code: "Digit9", shift: true },
  "0": { keysym: 0x30, code: "Digit0" },
  ")": { keysym: 0x29, code: "Digit0", shift: true },
  "-": { keysym: 0x2d, code: "Minus" },
  "_": { keysym: 0x5f, code: "Minus", shift: true },
  "=": { keysym: 0x3d, code: "Equal" },
  "+": { keysym: 0x2b, code: "Equal", shift: true },
  "[": { keysym: 0x5b, code: "BracketLeft" },
  "{": { keysym: 0x7b, code: "BracketLeft", shift: true },
  "]": { keysym: 0x5d, code: "BracketRight" },
  "}": { keysym: 0x7d, code: "BracketRight", shift: true },
  "\\": { keysym: 0x5c, code: "Backslash" },
  "|": { keysym: 0x7c, code: "Backslash", shift: true },
  ";": { keysym: 0x3b, code: "Semicolon" },
  ":": { keysym: 0x3a, code: "Semicolon", shift: true },
  "'": { keysym: 0x27, code: "Quote" },
  "\"": { keysym: 0x22, code: "Quote", shift: true },
  ",": { keysym: 0x2c, code: "Comma" },
  "<": { keysym: 0x3c, code: "Comma", shift: true },
  ".": { keysym: 0x2e, code: "Period" },
  ">": { keysym: 0x3e, code: "Period", shift: true },
  "/": { keysym: 0x2f, code: "Slash" },
  "?": { keysym: 0x3f, code: "Slash", shift: true },
};
const consoleAspectRatioCache = new Map<string, number>();

let rfb: RFB | null = null;
let terminalSocket: WebSocket | null = null;
let terminalAbortController: AbortController | null = null;
let terminalConnectTimer: number | null = null;
let terminalConnectSeq = 0;
let terminalTargetKey = "";
const terminalCredentialCache = new Map<string, TerminalSessionCredentials>();
// 本机密码库：记录本次会话内已保存过凭据的目标，避免连接成功后反复弹出“保存到本机”。
const terminalCredentialSavedKeys = new Set<string>();
const terminalSaveOffer = ref<TerminalSessionCredentials | null>(null);
let screenResizeObserver: ResizeObserver | null = null;
let consoleLoadingStartedAt = 0;
let consoleWakeRefreshTimer: number | null = null;
let consoleReconnectTimer: number | null = null;
let consoleConnectAttemptTimer: number | null = null;
let consoleFrameWatchTimer: number | null = null;
let consoleCanvasProbeTimer: number | null = null;
let consoleBlankReconnectTimer: number | null = null;
let consoleStaleWatchTimer: number | null = null;
let consoleStageReconnectTimer: number | null = null;
let consoleCanvasObserver: MutationObserver | null = null;
let consoleReconnectAttempt = 0;
let consoleBlankReconnectAttempt = 0;
let consoleStaleReconnectAttempt = 0;
let consoleLastFrameFingerprint = "";
let consoleLastFrameChangedAt = 0;
let suppressLocalShortcutUntil = 0;
let suppressedLocalShortcutKey = "";
let suppressedLocalShortcutModifier: "meta" | "ctrl" | "" = "";
let viewportRefreshFrame: number | null = null;
let shouldFocusAfterViewportRefresh = false;
let nativePasteFallbackTimer: number | null = null;
let nativePasteRequestSeq = 0;
let activeNativePasteRequestId = 0;
let consoleTextSendQueue: Promise<ConsoleTextSendResult> = Promise.resolve({ sentCount: 0, status: "cancelled" });
let consoleTextSendToken = 0;
let consolePasteTaskSeq = 0;
let remoteCtrlCInFlight = false;
let consoleBackspaceHeld = false;
let consoleBackspaceRepeatToken = 0;
let resizeStart:
  | {
      x: number;
      y: number;
      width: number;
      height: number;
    }
  | null = null;
let dragStart:
  | {
      x: number;
      y: number;
      offsetX: number;
      offsetY: number;
      element: HTMLElement;
      handle: HTMLElement;
      pointerId: number;
    }
  | null = null;
let dialogOffsetX = 0;
let dialogOffsetY = 0;
let uploadProgressSource: EventSource | null = null;
let consoleMetricsTimer: number | null = null;
let consoleMetricsAbortController: AbortController | null = null;
let consoleMetricsRequestSeq = 0;

interface PreparedConsoleSession {
  wsPath: string;
  password?: string;
}

type TerminalConnectionStatus = "idle" | "authenticating" | "connecting" | "connected" | "disconnected" | "error";

interface TerminalSessionDescriptor {
  sessionId: string;
  transport: "websocket" | "serial" | "ssh-pty";
  label?: string;
  endpoint?: string;
  expiresAt?: string;
}

interface PreparedTerminalSession {
  sessionId: string;
  connectionId: string;
  vmId: string;
  runtime: "web" | "electron" | "chrome-extension";
  mode: "linux-cli" | "serial-console";
  transport: "ssh-pty" | "serial-pty";
  state: "created" | "active" | "closing" | "closed" | "failed";
  expiresAt: string;
  websocketPath: string;
}

type TerminalServerMessage =
  | { type: "connected" }
  | { type: "output"; data: string }
  | { type: "exit"; code?: number }
  | { type: "error"; message?: string };

interface ConsoleUploadResponse {
  message?: string;
  uploaded?: Array<{
    name: string;
    remotePath: string;
    size: number;
  }>;
}

interface ConsoleUploadProgressEvent {
  uploadId: string;
  seq: number;
  stage: "queued" | "receiving" | "connecting" | "preparing" | "uploading" | "completed" | "failed";
  message: string;
  percent?: number;
  bytesTransferred?: number;
  totalBytes?: number;
  speedBytesPerSecond?: number;
  fileName?: string;
  remotePath?: string;
  createdAt: string;
}

interface ConsoleUploadProgressResponse {
  progress: ConsoleUploadProgressEvent;
}

interface ConsoleMetricsResponse {
  metrics?: VmMetricSnapshot[];
}

interface ConsoleTextSendResult {
  sentCount: number;
  status: "completed" | "cancelled" | "disconnected";
}

interface ConsoleTextSendOptions {
  onProgress?: (sentCount: number) => void;
}

interface NoVncDisplayCoordinateMapper {
  absX(position: number): number;
  absY(position: number): number;
}

const consoleLoadingBrand = computed(() => {
  return getProviderBrand(props.target?.providerType);
});
const consoleSpecText = computed(() => {
  const parts = [props.target?.cpuText, props.target?.memoryText, props.target?.diskText].filter(Boolean);
  return parts.length ? parts.join(" / ") : "-";
});
const isProvisionConsole = computed(() => !!props.provisionTask && !!props.provisionTargets?.length);
const isProvisionTaskTerminal = computed(() => isProvisionConsole.value && ["success", "warning", "failed"].includes(props.provisionTask?.status ?? ""));
const provisionTaskPercent = computed(() => {
  const explicitPercent = Number((props.provisionTask as (ProvisionTask & { progressPercent?: number }) | null | undefined)?.progressPercent);
  if (Number.isFinite(explicitPercent)) return clamp(Math.round(explicitPercent), 0, 100);
  const steps = props.provisionTask?.steps ?? [];
  if (!steps.length) return 0;
  const finished = steps.filter((step) => step.status === "success" || step.status === "warning" || step.status === "skipped").length;
  const runningBonus = steps.some((step) => step.status === "running") ? 0.45 : 0;
  return clamp(Math.round(((finished + runningBonus) / steps.length) * 100), 0, 100);
});
const currentProvisionVmIndex = computed(() => {
  const index = props.provisionTargets?.findIndex((item) => item.target?.vmId && item.target.vmId === props.target?.vmId) ?? -1;
  return index >= 0 ? index : 0;
});
const currentProvisionVm = computed(() => props.provisionTargets?.[currentProvisionVmIndex.value] ?? null);
const provisionTaskCurrentStep = computed(() => {
  const task = props.provisionTask;
  if (!task) return null;
  return task.steps.find((step) => step.key === task.currentStep) ?? task.steps.find((step) => step.status === "running") ?? null;
});
const provisionTaskStatusText = computed(() => {
  const step = provisionTaskCurrentStep.value;
  if (!step) return props.provisionTask?.message || "等待任务状态";
  return `${step.name} · ${step.message || provisionStepStatusText(step.status)}`;
});
const activeProvisionConsoleStep = computed<ProvisionTaskStepKey | "console">(
  () => currentProvisionVm.value?.currentStep ?? props.provisionTask?.currentStep ?? provisionTaskCurrentStep.value?.key ?? "console",
);
const consolePendingCopy = computed(() => {
  if (!isProvisionConsole.value) {
    return {
      title: "控制台加载中",
      detail: statusText.value === "控制台连接中" ? "正在建立控制台会话" : statusText.value,
    };
  }
  const vm = currentProvisionVm.value;
  const step = activeProvisionConsoleStep.value;
  const taskStatus = props.provisionTask?.status;
  const detail = vm?.message || provisionTaskCurrentStep.value?.message || props.provisionTask?.message || statusText.value;
  const consoleRecovering = /自动重试|暂时黑屏|重新获取当前画面|画面未就绪|画面长时间未更新/.test(statusText.value);
  if (taskStatus === "success") {
    return { title: "环境已完成", detail: "系统启动、登录验证和后续验收已完成" };
  }
  if (taskStatus === "warning") {
    return { title: "系统创建完成", detail };
  }
  if (taskStatus === "failed") {
    return { title: "创建链路失败", detail };
  }
  if (consoleRecovering) {
    return { title: "控制台画面恢复中", detail: statusText.value };
  }
  if (step === "boot" || step === "fetch-source") {
    return { title: "等待安装器画面", detail: detail || "VM 已启动，正在拉取 Kickstart 和安装源" };
  }
  if (step === "install-guest") {
    return { title: "系统安装中", detail: detail || "安装器正在安装软件包，画面恢复后自动显示" };
  }
  if (step === "wait-network") {
    return { title: "等待系统启动", detail: detail || "系统可能正在重启，等待控制台和 SSH 恢复" };
  }
  if (step === "verify-login") {
    return { title: "验证登录", detail: detail || "SSH 已就绪，正在校验账号密码" };
  }
  return { title: "控制台衔接中", detail };
});
const provisionTaskRunningTitle = computed(() => {
  const status = props.provisionTask?.status ?? "pending";
  if (status === "success") return "创建链路已完成";
  if (status === "warning") return "系统已完成，存在告警";
  if (status === "failed") return "创建链路失败";
  if (status === "pending") return "创建链路等待中";
  return "创建链路执行中";
});
const provisionTaskCurrentCopy = computed(() => {
  const count = props.provisionTargets?.length ?? 0;
  const current = currentProvisionVm.value;
  if (!current || !count) return props.provisionTask?.message || "等待 VM 控制台";
  return `当前 ${currentProvisionVmIndex.value + 1} / ${count}：${current.name}`;
});
const consoleTaskStatusTone = computed(() => `status-${props.provisionTask?.status ?? "pending"}`);
const consoleTaskTargetText = computed(() => {
  const current = currentProvisionVm.value;
  if (!current) return "等待 VM 控制台";
  return [current.name, current.ip].filter(Boolean).join(" · ");
});
const consoleTaskStatusRows = computed(() => {
  const current = currentProvisionVm.value;
  return [
    {
      label: "当前对象",
      value: consoleTaskTargetText.value,
    },
    {
      label: "执行步骤",
      value: provisionTaskStatusText.value,
    },
    {
      label: "VM 状态",
      value: current ? current.message || provisionStepStatusText(current.status) : props.provisionTask?.message || "等待任务状态",
    },
    {
      label: "控制台",
      value: connected.value ? "控制台已连接" : statusText.value,
    },
  ];
});
const effectiveVisible = computed(() => (props.embedded ? !!props.target : props.visible));
const shouldAutoConnectConsole = computed(() => !!props.target);
const isCliConsole = computed(() => props.target?.mode === "cli");
const noVncTarget = computed(() => props.target?.mode === "novnc" ? props.target : null);
const cliCapability = computed(() => props.target?.capabilities.cli);
const cliTerminalMessage = computed(() => terminalErrorMessage.value || cliCapability.value?.message || "当前没有可用的 Linux CLI 通道。");
const cliInitialData = computed(() => terminalLoginDisplay.value);
const terminalAcceptsInput = computed(() => terminalStatus.value === "connected" || terminalLoginPrompt.acceptsInput);
const consoleRootComponent = computed(() => (props.embedded ? "section" : ElDialog));
const consoleRootClass = computed(() => [
  "console-dialog",
  "is-medium-terminal",
  { "is-console-cli": isCliConsole.value },
  {
    "is-console-resizing": isResizing.value,
    "is-console-expanded": isExpanded.value,
    "is-console-embedded": props.embedded,
  },
]);
const shouldShowUploadProgressInSide = computed(() => uploadProgressVisible.value && !isExpanded.value);
const shouldShowUploadProgressInFrame = computed(() => uploadProgressVisible.value && isExpanded.value);
const consoleMetricsStrategy = computed(() =>
  props.target ? resolveConsoleMetricsLoadingStrategy(props.target.providerType) : null,
);
const consoleDisplayStrategy = computed(() => resolveConsoleDisplayStrategy(props.target?.providerType ?? "xenserver"));
const consoleWatermarkCopies = computed(() => ({ sparse: 3, standard: 6, dense: 10 })[props.watermarkDensity ?? "standard"]);
const consoleWatermarkStyle = computed(() => ({ "--console-watermark-opacity": String(Math.min(24, Math.max(6, props.watermarkOpacity ?? 12)) / 100) }));
const canCollectConsoleMetrics = computed(() => {
  const target = props.target;
  return !isProvisionConsole.value && consoleMetricsStrategy.value != null && !!target?.connectionId && !!target.vmId;
});
const consoleMetricView = computed(() => {
  const snapshot = consoleMetricSnapshot.value;
  const guestTelemetry = snapshot?.guestTelemetry;
  const telemetryLabel =
    guestTelemetry?.status === "available"
      ? "Guest 已增强"
      : guestTelemetry?.status === "probing"
        ? "Guest 探测中"
        : "宿主机采集";
  const memorySourceLabel =
    snapshot?.metricSources?.memory === "guest-agent" || snapshot?.metricSources?.memory === "guest-tools"
      ? "Guest 已用"
      : consoleMetricsStrategy.value?.memoryUsageLabel || "宿主占用";
  const diskHasGuestUsage = snapshot?.metricSources?.disk === "guest-agent" || snapshot?.metricSources?.disk === "guest-tools";
  const cpuRatio = finiteMetric(snapshot?.cpuUsage);
  const rawCpuPercent = cpuRatio == null ? null : clamp(cpuRatio * 100, 0, 100);
  const cpuPercent = rawCpuPercent == null ? null : Number(rawCpuPercent.toFixed(rawCpuPercent < 1 ? 2 : 1));
  const cpuCount = Math.max(props.target?.cpuCount ?? 0, 0);
  const memoryUsed = finiteMetric(snapshot?.memoryUsedBytes);
  const memoryTotal = finiteMetric(snapshot?.memoryTotalBytes) ?? finiteMetric(props.target?.memoryBytes);
  const memoryPercent = metricPercent(memoryUsed, memoryTotal);
  const diskUsed = finiteMetric(snapshot?.diskUsedBytes);
  const diskTotal = finiteMetric(snapshot?.diskTotalBytes) ?? finiteMetric(props.target?.diskBytes);
  const diskPercent = metricPercent(diskUsed, diskTotal);
  const networkRx = finiteMetric(snapshot?.networkRxRate);
  const networkTx = finiteMetric(snapshot?.networkTxRate);
  const networkTotal = networkRx == null && networkTx == null ? null : Math.max((networkRx ?? 0) + (networkTx ?? 0), 0);
  const networkBarPercent = networkTotal == null || networkTotal <= 0 ? 0 : clamp(Math.round((Math.log10(networkTotal + 1) / 7) * 100), 4, 100);
  const diskRead = finiteMetric(snapshot?.diskReadRate);
  const diskWrite = finiteMetric(snapshot?.diskWriteRate);
  const diskActivity = diskRead == null && diskWrite == null ? null : Math.max((diskRead ?? 0) + (diskWrite ?? 0), 0);
  const diskActivityPercent = diskActivity == null || diskActivity <= 0 ? 0 : clamp(Math.round((Math.log10(diskActivity + 1) / 7) * 100), 4, 100);

  return {
    cpuPercent,
    cpuValue: cpuPercent == null ? (cpuCount > 0 ? `${cpuCount} vCPU` : "--") : `${cpuPercent}%`,
    cpuDetail: cpuPercent == null ? "宿主机实时利用率不可用" : cpuCount > 0 ? `宿主机 · ${cpuCount} vCPU 平均` : "宿主机计数器",
    memoryPercent,
    memoryValue: memoryPercent == null ? (memoryTotal == null ? "--" : formatMetricCapacity(memoryTotal)) : `${memoryPercent}%`,
    memoryDetail:
      memoryPercent == null
        ? memoryTotal == null ? "实时用量不可用" : "分配容量"
        : [memorySourceLabel, `${formatMetricCapacity(memoryUsed)} / ${formatMetricCapacity(memoryTotal)}`]
            .filter(Boolean)
            .join(" "),
    networkRate: networkTotal == null ? "--" : formatMetricRate(networkTotal),
    networkDetail: networkTotal == null ? "等待宿主机实时采样" : `宿主机 · ↑${formatMetricRate(networkTx ?? 0)} ↓${formatMetricRate(networkRx ?? 0)}`,
    networkBarPercent,
    diskPercent,
    diskValue: diskPercent == null ? (diskTotal == null ? "--" : formatMetricCapacity(diskTotal)) : `${diskPercent}%`,
    diskDetail:
      diskPercent == null
        ? diskActivity == null
          ? diskTotal == null ? "实时数据不可用" : "虚拟磁盘配置容量 · I/O 待采样"
          : `宿主机 I/O · 读${formatMetricRate(diskRead ?? 0)} 写${formatMetricRate(diskWrite ?? 0)}`
        : `${diskHasGuestUsage ? "Guest 文件系统" : "宿主机存储"} · ${formatMetricCapacity(diskUsed)} / ${formatMetricCapacity(diskTotal)}`,
    diskActivityPercent,
    telemetryLabel,
    sampledAt: snapshot?.sampledAt ?? "",
  };
});
const shouldRenderConsoleMetrics = computed(() => canCollectConsoleMetrics.value);
const shouldShowConsoleMetricsInSide = computed(() => shouldRenderConsoleMetrics.value && !isExpanded.value && !isProvisionConsole.value);
const shouldShowConsoleMetricsInFrame = computed(
  () =>
    shouldRenderConsoleMetrics.value &&
    isExpanded.value &&
    metricsOverlayVisible.value &&
    consoleFrameReady.value &&
    !uploadProgressVisible.value &&
    !isProvisionConsole.value,
);
const shouldShowMetricsToggle = computed(
  () => shouldRenderConsoleMetrics.value && isExpanded.value && consoleFrameReady.value && !uploadProgressVisible.value && !isProvisionConsole.value,
);
const consoleRootAttrs = computed(() =>
  props.embedded
    ? {
        style: {
          "--console-frame-aspect-ratio": String(getConsoleAspectRatio()),
        },
      }
    : {
        modelValue: props.visible,
        title: "控制台",
        width: `${dialogSize.width}px`,
        style: { height: `${dialogSize.height}px` },
        top: "4vh",
        draggable: true,
        closeOnClickModal: false,
        destroyOnClose: false,
        appendToBody: true,
      },
);
watch(
  () => [
    effectiveVisible.value,
    props.target?.mode,
    noVncTarget.value?.wsUrl,
    props.target?.vmId,
    props.target?.connectionId,
    props.target?.providerType,
    isProvisionConsole.value,
  ] as const,
  async ([visible]) => {
    resetProvisionStaleConsoleWatchState();
    const nextTerminalTargetKey = resolveTerminalTargetKey();
    if (terminalTargetKey && terminalTargetKey !== nextTerminalTargetKey) disconnectTerminal();
    if (!props.target) {
      stopDialogDrag();
      stopConsoleMetricsPolling();
      disconnectConsole();
      disconnectTerminal();
      disconnectScreenResizeObserver();
      clearConsoleReconnectTimer();
      clearConsoleFrameWatchTimer();
      return;
    }
    if (!visible) {
      stopDialogDrag();
      stopConsoleMetricsPolling();
      disconnectConsole();
      disconnectScreenResizeObserver();
      clearConsoleReconnectTimer();
      clearConsoleFrameWatchTimer();
      return;
    }
    if (isCliConsole.value) {
      disconnectConsole();
      consoleFrameReady.value = true;
      resetDialogOffset();
      resetDialogSize();
      startConsoleMetricsPolling();
      await nextTick();
      if (canResumeTerminal(nextTerminalTargetKey)) {
        terminalConsoleRef.value?.fit();
        terminalConsoleRef.value?.focus();
        return;
      }
      statusText.value = "CLI 会话准备中";
      void connectTerminal();
      return;
    }
    if (!shouldAutoConnectConsole.value) {
      stopConsoleMetricsPolling();
      disconnectConsole();
      disconnectTerminal();
      statusText.value = props.provisionTask?.status === "success" ? "任务已完成" : "任务已结束";
      consoleFrameReady.value = false;
      return;
    }
    disconnectTerminal();
    clearConsoleReconnectTimer();
    consoleReconnectAttempt = 0;
    consoleBlankReconnectAttempt = 0;
    const target = noVncTarget.value;
    if (!target) return;
    const cachedAspectRatio = getCachedConsoleAspectRatio(target);
    consoleAspectRatio.value = cachedAspectRatio || target.aspectRatio || 4 / 3;
    consoleLoadingStartedAt = Date.now();
    consoleFrameReady.value = false;
    isExpanded.value = false;
    metricsOverlayVisible.value = true;
    startConsoleMetricsPolling();
    resetDialogOffset();
    resetDialogSize();
    await nextTick();
    resetDialogOffset();
    connectScreenResizeObserver();
    void connectConsole();
  },
);

watch(
  () => activeProvisionConsoleStep.value,
  (step, previousStep) => {
    if (step === previousStep || !effectiveVisible.value || !isProvisionConsole.value || isProvisionTaskTerminal.value) return;
    consoleBlankReconnectAttempt = 0;
    clearConsoleStageReconnectTimer();
    if (step === "wait-network" || step === "guest-tools") {
      consoleFrameReady.value = false;
      statusText.value = step === "guest-tools" ? "Guest 重启，正在刷新控制台" : "系统重启，正在刷新控制台";
      consoleStageReconnectTimer = window.setTimeout(() => {
        consoleStageReconnectTimer = null;
        if (!effectiveVisible.value || !props.target || isProvisionTaskTerminal.value) return;
        void connectConsole();
      }, CONSOLE_STAGE_RECONNECT_DELAY_MS);
      return;
    }
    if (!hasNonBlankConsoleCanvas()) {
      consoleFrameReady.value = false;
      statusText.value = "安装阶段已切换，正在获取当前控制台画面";
      startProvisionBlankConsoleWatch(350);
    }
  },
);

watch(
  () => [props.displayScaleMode, props.displayQuality] as const,
  () => {
    if (!rfb) return;
    applyNoVncDisplayPreferences(rfb);
    requestConsoleResize({ focus: false });
  },
);

watch(
  () => props.provisionTask?.status ?? "",
  (status, previousStatus) => {
    if (status === previousStatus) return;
    if (["success", "warning", "failed"].includes(status)) {
      stopProvisionStaleConsoleWatch({ reset: true });
    }
    if (!["success", "warning"].includes(status) || !effectiveVisible.value || !isProvisionConsole.value || !props.target) return;
    clearConsoleStageReconnectTimer();
    consoleFrameReady.value = false;
    statusText.value = "任务结束，正在获取最终控制台画面";
    consoleStageReconnectTimer = window.setTimeout(() => {
      consoleStageReconnectTimer = null;
      if (!effectiveVisible.value || !props.target) return;
      void connectConsole();
    }, CONSOLE_STAGE_RECONNECT_DELAY_MS);
  },
);

onBeforeUnmount(() => {
  window.removeEventListener("keydown", handleConsoleShortcut, true);
  window.removeEventListener("keyup", handleConsoleShortcutKeyup, true);
  window.removeEventListener("compositionend", handleConsoleCompositionEnd, true);
  window.removeEventListener("mousemove", handleResizeMove);
  window.removeEventListener("mouseup", stopResize);
  window.removeEventListener("pointermove", handleDialogDragMove);
  window.removeEventListener("pointerup", stopDialogDrag);
  window.removeEventListener("pointercancel", stopDialogDrag);
  window.removeEventListener("blur", stopDialogDrag);
  window.removeEventListener("blur", stopConsoleBackspaceRepeat);
  window.removeEventListener("resize", ensureDialogWithinViewport);
  if (viewportRefreshFrame != null) window.cancelAnimationFrame(viewportRefreshFrame);
  clearNativePasteFallbackTimer();
  stopConsoleMetricsPolling();
  closeUploadProgressSource();
  disconnectTerminal();
  disconnectConsole();
  disconnectScreenResizeObserver();
  clearConsoleFrameWatchTimer();
  clearConsoleStageReconnectTimer();
  stopConsoleCanvasProbe();
});

onMounted(async () => {
  window.addEventListener("keydown", handleConsoleShortcut, true);
  window.addEventListener("keyup", handleConsoleShortcutKeyup, true);
  window.addEventListener("compositionend", handleConsoleCompositionEnd, true);
  window.addEventListener("blur", stopConsoleBackspaceRepeat);
  window.addEventListener("resize", ensureDialogWithinViewport);
  connectScreenResizeObserver();
  if (effectiveVisible.value && props.target) {
    startConsoleMetricsPolling();
    await nextTick();
    if (isCliConsole.value) void connectTerminal();
    else if (shouldAutoConnectConsole.value) void connectConsole();
  }
});

function startConsoleMetricsPolling() {
  stopConsoleMetricsPolling();
  consoleMetricSnapshot.value = null;
  if (!effectiveVisible.value || !canCollectConsoleMetrics.value || !consoleMetricsStrategy.value) return;
  consoleMetricsLoading.value = true;
  const requestSeq = ++consoleMetricsRequestSeq;
  void pollConsoleMetrics(requestSeq);
}

function stopConsoleMetricsPolling() {
  consoleMetricsRequestSeq += 1;
  if (consoleMetricsTimer != null) {
    window.clearTimeout(consoleMetricsTimer);
    consoleMetricsTimer = null;
  }
  consoleMetricsAbortController?.abort();
  consoleMetricsAbortController = null;
  consoleMetricSnapshot.value = null;
  consoleMetricsLoading.value = false;
}

async function pollConsoleMetrics(requestSeq: number) {
  const target = props.target;
  if (!target?.connectionId || !target.vmId || requestSeq !== consoleMetricsRequestSeq) return;
  const controller = new AbortController();
  consoleMetricsAbortController = controller;

  try {
    const result = await secureJsonRequest<ConsoleMetricsResponse>("/api/metrics/snapshot", {
      ...buildConsoleConnectionRequest(target),
      targetType: "vm",
      targetIds: [target.vmId],
    }, "POST", { signal: controller.signal });
    if (requestSeq !== consoleMetricsRequestSeq) return;
    consoleMetricSnapshot.value = result.metrics?.find((item) => item.uuid === target.vmId) ?? null;
    consoleMetricsLoading.value = false;
  } catch (error) {
    if (requestSeq !== consoleMetricsRequestSeq) return;
    if (!(error instanceof DOMException && error.name === "AbortError")) {
      consoleMetricSnapshot.value = null;
      consoleMetricsLoading.value = false;
    }
  } finally {
    if (consoleMetricsAbortController === controller) consoleMetricsAbortController = null;
    if (requestSeq === consoleMetricsRequestSeq && effectiveVisible.value && canCollectConsoleMetrics.value) {
      const pollIntervalMs = consoleMetricsStrategy.value?.pollIntervalMs;
      if (pollIntervalMs != null) {
        consoleMetricsTimer = window.setTimeout(() => void pollConsoleMetrics(requestSeq), pollIntervalMs);
      }
    }
  }
}

async function connectConsole() {
  if (isCliConsole.value) return;
  disconnectConsole({ preserveProvisionStaleWatchState: true });
  const screen = screenRef.value;
  const target = noVncTarget.value;
  if (!screen || !target) return;
  screen.replaceChildren();
  connected.value = false;
  consoleFrameReady.value = false;
  stopConsoleCanvasProbe();
  statusText.value = "控制台连接中";

  let prepared: { wsUrl: string; password?: string };
  try {
    prepared = await prepareConsoleTarget(target);
  } catch (error) {
    scheduleConsoleReconnect(error instanceof Error ? error.message : "控制台会话准备失败");
    return;
  }
  if (!prepared.wsUrl) {
    scheduleConsoleReconnect("控制台地址无效");
    return;
  }

  rfb = new RFB(screen, prepared.wsUrl, {
    shared: true,
    ...(prepared.password ? { credentials: { password: prepared.password } } : {}),
  });
  applyNoVncDisplayPreferences(rfb);
  rfb.clipViewport = false;
  enableEmbeddedStretchPointerMapping(rfb);
  rfb.focusOnClick = true;
  setNoVncDotCursor(true);
  setNoVncBackground("#000");
  const connectingRfb = rfb;
  clearConsoleConnectAttemptTimer();
  consoleConnectAttemptTimer = window.setTimeout(() => {
    consoleConnectAttemptTimer = null;
    if (!effectiveVisible.value || rfb !== connectingRfb || connected.value) return;
    rfb = null;
    connectingRfb.disconnect();
    scheduleConsoleReconnect("控制台握手超时");
  }, CONSOLE_CONNECT_ATTEMPT_TIMEOUT_MS);

  rfb.addEventListener("connect", () => {
    if (rfb !== connectingRfb) return;
    clearConsoleConnectAttemptTimer();
    clearConsoleReconnectTimer();
    consoleReconnectAttempt = 0;
    connected.value = true;
    statusText.value = "已连接";
    focusConsole();
    scheduleConsoleWakeRefresh();
    window.setTimeout(() => syncConsoleAspectRatio({ reveal: true }), 120);
    startConsoleFrameWatch();
    startConsoleCanvasProbe();
    startProvisionBlankConsoleWatch();
    startProvisionStaleConsoleWatch();
    refreshNoVncViewport();
  });
  rfb.addEventListener("disconnect", (event) => {
    if (rfb !== connectingRfb) return;
    clearConsoleConnectAttemptTimer();
    stopConsoleBackspaceRepeat();
    connected.value = false;
    consoleFrameReady.value = false;
    clearConsoleFrameWatchTimer();
    stopConsoleCanvasProbe();
    clearProvisionBlankConsoleWatch();
    stopProvisionStaleConsoleWatch({ reset: false });
    const clean = event instanceof CustomEvent ? Boolean((event.detail as { clean?: boolean } | undefined)?.clean) : false;
    scheduleConsoleReconnect(clean ? "连接已断开" : "RFB 握手失败或远端控制台关闭");
  });
  rfb.addEventListener("securityfailure", () => {
    if (rfb !== connectingRfb) return;
    clearConsoleConnectAttemptTimer();
    connected.value = false;
    clearConsoleFrameWatchTimer();
    stopConsoleCanvasProbe();
    clearProvisionBlankConsoleWatch();
    stopProvisionStaleConsoleWatch({ reset: false });
    scheduleConsoleReconnect("认证失败或控制台被拒绝");
  });
  rfb.addEventListener("credentialsrequired", () => {
    if (rfb !== connectingRfb) return;
    clearConsoleConnectAttemptTimer();
    connected.value = false;
    clearConsoleFrameWatchTimer();
    stopConsoleCanvasProbe();
    clearProvisionBlankConsoleWatch();
    stopProvisionStaleConsoleWatch({ reset: false });
    statusText.value = "需要额外控制台认证";
  });
}

async function prepareConsoleTarget(target: NoVncVmConsoleTarget): Promise<{ wsUrl: string; password?: string }> {
  if (!target.prepareUrl) {
    return { wsUrl: target.wsUrl ?? "" };
  }
  if (!target.connectionId || !target.vmId) {
    throw new Error("控制台参数不完整");
  }
  const result = await secureJsonRequest<PreparedConsoleSession>(target.prepareUrl, {
    ...buildConsoleConnectionRequest(target),
    vmId: target.vmId,
  });
  return {
    wsUrl: buildApiWebSocketUrl(result.wsPath),
    password: result.password,
  };
}

function buildConsoleConnectionRequest(target: VmConsoleTarget) {
  if (target.mode === "novnc" && target.connection) {
    return {
      providerType: target.connection.providerType,
      host: target.connection.host,
      port: target.connection.port,
      username: target.connection.username,
      password: target.connection.password,
      connection: target.connection,
    };
  }
  return {
    connectionId: target.connectionId,
    providerType: target.providerType,
  };
}

function disconnectConsole(options: { preserveProvisionStaleWatchState?: boolean } = {}) {
  stopConsoleBackspaceRepeat();
  clearConsoleWakeRefreshTimer();
  clearConsoleReconnectTimer();
  clearConsoleConnectAttemptTimer();
  clearConsoleFrameWatchTimer();
  clearConsoleStageReconnectTimer();
  clearProvisionBlankConsoleWatch();
  stopProvisionStaleConsoleWatch({ reset: !options.preserveProvisionStaleWatchState });
  clearNativePasteFallbackTimer();
  activeNativePasteRequestId = 0;
  cancelConsolePaste("", { clearNotice: true });
  if (!rfb) return;
  const currentRfb = rfb;
  rfb = null;
  currentRfb.disconnect();
}

async function connectTerminal(credentials?: TerminalSessionCredentials) {
  const target = props.target;
  if (!target || target.mode !== "cli") return;
  const nextTerminalTargetKey = resolveTerminalTargetKey(target);
  const cachedCredentials = credentials ? undefined : terminalCredentialCache.get(nextTerminalTargetKey);
  const resolvedCredentials = credentials ?? cachedCredentials;
  const manualLogin = Boolean(resolvedCredentials);
  disconnectTerminal({ keepStatus: true, keepLoginPrompt: manualLogin });
  terminalTargetKey = nextTerminalTargetKey;
  if (!manualLogin) {
    terminalLoginPrompt.reset();
    terminalConsoleRef.value?.clear();
  } else if (cachedCredentials) {
    // A manual reconnect starts a fresh PTY, so remove the previous screen
    // buffer before the new shell writes its first prompt.
    terminalConsoleRef.value?.clear();
  }
  if (!target.connectionId || !target.vmId) {
    terminalStatus.value = "error";
    terminalErrorMessage.value = "终端参数不完整，请刷新列表后重试。";
    return;
  }
  const connectSeq = ++terminalConnectSeq;
  terminalStatus.value = "connecting";
  terminalErrorMessage.value = "";
  statusText.value = "CLI 会话准备中";
  const controller = new AbortController();
  terminalAbortController = controller;
  try {
    const session = await secureJsonRequest<PreparedTerminalSession>("/api/terminal/session", {
      connectionId: target.connectionId,
      vmId: target.vmId,
      providerType: target.providerType,
      mode: "linux-cli",
      powerState: "unknown",
      runtime: resolveTerminalRuntime(),
      ...(resolvedCredentials ? { credentials: resolvedCredentials } : {}),
    }, "POST", { signal: controller.signal });
    if (connectSeq !== terminalConnectSeq || props.target?.mode !== "cli") return;
    terminalSession.value = {
      sessionId: session.sessionId,
      transport: session.transport === "serial-pty" ? "serial" : session.transport,
      endpoint: session.websocketPath,
      expiresAt: session.expiresAt,
    };
    openTerminalSocket(session, connectSeq, resolvedCredentials);
  } catch (error) {
    if (connectSeq !== terminalConnectSeq) return;
    if (error instanceof DOMException && error.name === "AbortError") return;
    if (error instanceof SecureRequestError && error.code === "SYSTEM_CREDENTIAL_REQUIRED") {
      showTerminalLoginPrompt();
      return;
    }
    if (manualLogin) {
      showTerminalLoginPrompt(error instanceof Error ? error.message : "Login incorrect");
      return;
    }
    terminalStatus.value = "error";
    terminalErrorMessage.value = error instanceof Error ? error.message : "Linux CLI 会话创建失败。";
    statusText.value = "CLI 连接失败";
  } finally {
    if (terminalAbortController === controller) terminalAbortController = null;
  }
}

function openTerminalSocket(session: PreparedTerminalSession, connectSeq: number, credentials?: TerminalSessionCredentials) {
  const socket = new WebSocket(buildApiWebSocketUrl(session.websocketPath));
  let established = false;
  const manualLogin = Boolean(credentials);
  terminalSocket = socket;
  clearTerminalConnectTimer();
  terminalConnectTimer = window.setTimeout(() => {
    if (terminalSocket !== socket || connectSeq !== terminalConnectSeq || established) return;
    terminalSocket = null;
    socket.close(1000, "terminal connect timeout");
    connected.value = false;
    const message = "SSH 连接超时，请检查堡垒机或目标机网络后重试。";
    if (manualLogin) {
      showTerminalLoginPrompt(message);
      return;
    }
    terminalStatus.value = "error";
    terminalErrorMessage.value = message;
    statusText.value = "CLI 连接超时";
  }, TERMINAL_CONNECT_TIMEOUT_MS);
  socket.addEventListener("open", () => {
    if (terminalSocket !== socket || connectSeq !== terminalConnectSeq) return;
    terminalStatus.value = "connecting";
    statusText.value = "CLI 握手中";
  });
  socket.addEventListener("message", (event) => {
    if (terminalSocket !== socket || connectSeq !== terminalConnectSeq) return;
    const message = parseTerminalServerMessage(event.data);
    if (!message) return;
    if (message.type === "connected") {
      established = true;
      clearTerminalConnectTimer();
      if (credentials && terminalTargetKey) terminalCredentialCache.set(terminalTargetKey, credentials);
      if (credentials && terminalTargetKey && !terminalCredentialSavedKeys.has(terminalTargetKey)) {
        terminalSaveOffer.value = credentials;
      }
      terminalLoginPrompt.reset();
      terminalStatus.value = "connected";
      connected.value = true;
      statusText.value = "已连接";
      void nextTick(() => terminalConsoleRef.value?.focus());
      return;
    }
    if (message.type === "output") {
      terminalConsoleRef.value?.write(message.data);
      return;
    }
    if (message.type === "error") {
      clearTerminalConnectTimer();
      if (manualLogin && !established) {
        if (isTerminalAuthenticationFailure(message.message)) terminalCredentialCache.delete(terminalTargetKey);
        returnToTerminalLogin(socket, message.message || "Login incorrect");
        return;
      }
      terminalStatus.value = "error";
      terminalErrorMessage.value = message.message || "Linux CLI 连接失败。";
      statusText.value = "CLI 连接失败";
      return;
    }
    terminalStatus.value = "disconnected";
    connected.value = false;
    statusText.value = "CLI 已断开";
  });
  socket.addEventListener("close", (event) => {
    if (terminalSocket !== socket || connectSeq !== terminalConnectSeq) return;
    clearTerminalConnectTimer();
    terminalSocket = null;
    connected.value = false;
    terminalSaveOffer.value = null;
    if (!established && (manualLogin || event.code === 4403)) {
      if (event.code === 4403 || isTerminalAuthenticationFailure(event.reason)) terminalCredentialCache.delete(terminalTargetKey);
      showTerminalLoginPrompt(event.reason || "Login incorrect");
      return;
    }
    if (terminalStatus.value === "connected" || terminalStatus.value === "connecting") {
      terminalStatus.value = event.wasClean ? "disconnected" : "error";
      terminalErrorMessage.value = event.wasClean ? "" : event.reason || "Linux CLI 连接已断开。";
      statusText.value = event.wasClean ? "CLI 已断开" : "CLI 连接失败";
    }
  });
  socket.addEventListener("error", () => {
    if (terminalSocket !== socket || connectSeq !== terminalConnectSeq) return;
    clearTerminalConnectTimer();
    terminalSaveOffer.value = null;
    if (manualLogin && !established) {
      returnToTerminalLogin(socket, "SSH WebSocket 连接失败，请检查堡垒机或目标机网络后重试。");
      return;
    }
    terminalStatus.value = "error";
    terminalErrorMessage.value = "Linux CLI WebSocket 连接失败。";
    statusText.value = "CLI 连接失败";
  });
}

function disconnectTerminal(options: { keepStatus?: boolean; keepLoginPrompt?: boolean } = {}) {
  terminalConnectSeq += 1;
  clearTerminalConnectTimer();
  terminalAbortController?.abort();
  terminalAbortController = null;
  if (terminalSocket) {
    const socket = terminalSocket;
    terminalSocket = null;
    socket.close(1000, "console renderer changed");
  }
  terminalSession.value = null;
  terminalTargetKey = "";
  terminalSaveOffer.value = null;
  connected.value = false;
  if (!options.keepLoginPrompt) {
    terminalLoginPrompt.reset();
    terminalLoginDisplay.value = "";
  }
  if (!options.keepStatus) {
    terminalStatus.value = "idle";
    terminalErrorMessage.value = "";
  }
}

function clearTerminalConnectTimer() {
  if (terminalConnectTimer == null) return;
  window.clearTimeout(terminalConnectTimer);
  terminalConnectTimer = null;
}

function handleConsoleClosed() {
  if (!isCliConsole.value || terminalTargetKey !== resolveTerminalTargetKey()) disconnectTerminal();
  disconnectConsole();
}

function resolveTerminalTargetKey(target = props.target): string {
  if (!target || target.mode !== "cli" || !target.connectionId || !target.vmId) return "";
  return `${target.providerType}:${target.connectionId}:${target.vmId}`;
}

function isTerminalAuthenticationFailure(message: string | undefined): boolean {
  return typeof message === "string" && /login incorrect/i.test(message);
}

function canResumeTerminal(targetKey: string): boolean {
  if (!targetKey || terminalTargetKey !== targetKey) return false;
  return terminalSocket != null || terminalAbortController != null || terminalLoginPrompt.acceptsInput;
}

function handleTerminalReady(event: TerminalReadyEvent) {
  sendTerminalResize(event.cols, event.rows);
}

function handleTerminalInput(event: TerminalInputEvent) {
  if (!event.data) return;
  if (terminalLoginPrompt.acceptsInput) {
    const result = terminalLoginPrompt.consume(event.data);
    if (result.output) {
      terminalLoginDisplay.value += result.output;
      terminalConsoleRef.value?.write(result.output);
    }
    if (result.credentials) {
      terminalLoginDisplay.value = "";
      void connectTerminal(result.credentials);
    }
    return;
  }
  if (terminalSocket?.readyState !== WebSocket.OPEN) return;
  terminalSocket.send(JSON.stringify({ type: "input", data: event.data }));
}

function showTerminalLoginPrompt(message = "") {
  terminalSession.value = null;
  terminalSaveOffer.value = null;
  connected.value = false;
  terminalStatus.value = "authenticating";
  terminalErrorMessage.value = "";
  statusText.value = "等待登录";
  const prompt = `${message ? `${message}\r\n` : "SSH authentication required\r\n"}${terminalLoginPrompt.start()}`;
  // TerminalConsole 是异步组件，登录失败返回时可能尚未完成挂载；保留初始提示，
  // 让组件挂载时通过 initialData 重放，避免用户看到只有光标的黑屏。
  terminalLoginDisplay.value = prompt;
  void nextTick(() => {
    terminalConsoleRef.value?.clear();
    terminalConsoleRef.value?.write(prompt);
    terminalConsoleRef.value?.focus();
  });
}

function returnToTerminalLogin(socket: WebSocket, message: string) {
  if (terminalSocket === socket) terminalSocket = null;
  socket.close(1000, "retry login");
  showTerminalLoginPrompt(message);
}

/**
 * 手动输入凭据并连接成功后，把登录信息写入用户本机加密密码库，
 * 下次打开控制台或执行扩容时自动套用，无需再次输入。
 */
function saveTerminalCredentialsToVault() {
  const offer = terminalSaveOffer.value;
  const target = props.target;
  if (!offer || !target?.connectionId || !target.vmId) {
    showConsoleNotice("缺少连接信息，无法保存本机密码", 2400);
    return;
  }
  void secureJsonRequest<{ saved: boolean }>(
    "/api/vms/system-credentials",
    {
      connectionId: target.connectionId,
      vmId: target.vmId,
      systemCredentials: {
        username: offer.username,
        password: offer.password,
      },
    },
    "POST",
  )
    .then(() => {
      const targetKey = resolveTerminalTargetKey(target);
      if (targetKey) terminalCredentialSavedKeys.add(targetKey);
      terminalSaveOffer.value = null;
      showConsoleNotice("已保存到本机密码库（加密）", 2600);
    })
    .catch((error) => {
      showConsoleNotice(error instanceof Error ? `保存失败：${error.message}` : "保存失败，请重试", 3600);
    });
}

function dismissTerminalSaveOffer() {
  terminalSaveOffer.value = null;
}

function handleTerminalResize(event: TerminalResizeEvent) {
  sendTerminalResize(event.cols, event.rows);
}

function sendTerminalResize(cols: number, rows: number) {
  if (terminalSocket?.readyState !== WebSocket.OPEN || cols <= 0 || rows <= 0) return;
  terminalSocket.send(JSON.stringify({ type: "resize", cols, rows }));
}

function parseTerminalServerMessage(data: unknown): TerminalServerMessage | null {
  try {
    const parsed = JSON.parse(String(data)) as Partial<TerminalServerMessage>;
    if (parsed.type === "connected") return { type: "connected" };
    if (parsed.type === "output" && typeof parsed.data === "string") return { type: "output", data: parsed.data };
    if (parsed.type === "exit") return { type: "exit", code: typeof parsed.code === "number" ? parsed.code : undefined };
    if (parsed.type === "error") return { type: "error", message: typeof parsed.message === "string" ? parsed.message : undefined };
  } catch {
    return null;
  }
  return null;
}

function resolveTerminalRuntime(): "web" | "electron" {
  return window.vrcDesktopUpdate ? "electron" : "web";
}

function clearConsoleStageReconnectTimer() {
  if (consoleStageReconnectTimer == null) return;
  window.clearTimeout(consoleStageReconnectTimer);
  consoleStageReconnectTimer = null;
}

function scheduleConsoleReconnect(reason: string) {
  if (!effectiveVisible.value || !props.target) return;
  const normalizedReason = reason.trim().replace(/[，,。；;：:\s]+$/u, "") || "控制台连接失败";
  clearConsoleReconnectTimer();
  consoleReconnectAttempt += 1;
  statusText.value = `${normalizedReason}，自动重试 ${consoleReconnectAttempt}`;
  consoleReconnectTimer = window.setTimeout(() => {
    consoleReconnectTimer = null;
    if (!effectiveVisible.value || !props.target) return;
    void connectConsole();
  }, CONSOLE_RETRY_DELAY_MS);
}

function clearConsoleReconnectTimer() {
  if (consoleReconnectTimer == null) return;
  window.clearTimeout(consoleReconnectTimer);
  consoleReconnectTimer = null;
}

function clearConsoleConnectAttemptTimer() {
  if (consoleConnectAttemptTimer == null) return;
  window.clearTimeout(consoleConnectAttemptTimer);
  consoleConnectAttemptTimer = null;
}

function sendCtrlAltDelete() {
  cancelConsolePaste("已取消文本发送");
  rfb?.sendCtrlAltDel();
  focusConsole();
}

function sendRemoteCtrlC() {
  if (!rfb || remoteCtrlCInFlight) return;
  cancelConsolePaste("已取消文本发送");
  remoteCtrlCInFlight = true;
  void sendRemoteCtrlCNow();
}

async function sendRemoteCtrlCNow() {
  const session = rfb;
  if (!session || !connected.value) {
    remoteCtrlCInFlight = false;
    return;
  }
  try {
    releaseModifierKeys();
    focusConsole();
    await delay(CONSOLE_MODIFIER_RELEASE_DELAY_MS);
    if (session !== rfb || !connected.value) return;
    session.sendKey(0xffe3, "ControlLeft", true);
    await delay(CONSOLE_CTRL_C_MODIFIER_SETTLE_MS);
    if (session !== rfb || !connected.value) return;
    session.sendKey(0x0063, "KeyC", true);
    await delay(CONSOLE_CTRL_C_KEY_HOLD_MS);
    session.sendKey(0x0063, "KeyC", false);
    session.sendKey(0xffe3, "ControlLeft", false);
  } finally {
    remoteCtrlCInFlight = false;
    releaseModifierKeys();
    focusConsole();
  }
}

function startConsoleBackspaceRepeat() {
  if (consoleBackspaceHeld || !rfb || !connected.value) return;
  consoleBackspaceHeld = true;
  const token = ++consoleBackspaceRepeatToken;
  void runConsoleBackspaceRepeat(token);
}

async function runConsoleBackspaceRepeat(token: number) {
  await tapRemoteKey(0xff08, "Backspace", false, CONSOLE_BACKSPACE_KEY_HOLD_MS);
  await delay(CONSOLE_BACKSPACE_REPEAT_DELAY_MS);
  while (consoleBackspaceHeld && token === consoleBackspaceRepeatToken && connected.value && rfb) {
    await tapRemoteKey(0xff08, "Backspace", false, CONSOLE_BACKSPACE_KEY_HOLD_MS);
    await delay(CONSOLE_BACKSPACE_REPEAT_INTERVAL_MS);
  }
}

function stopConsoleBackspaceRepeat() {
  consoleBackspaceHeld = false;
  consoleBackspaceRepeatToken += 1;
}

function sendRemoteCommand(command: string) {
  if (!rfb) return;
  cancelConsolePaste("已取消文本发送");
  focusConsole();
  void sendConsoleText(`${command}\n`);
}

function sendRemoteEnter() {
  if (!rfb) return;
  cancelConsolePaste("已取消文本发送");
  focusConsole();
  void tapRemoteKey(0xff0d, "Enter");
}

function handleConsoleCommand(command: string) {
  if (command === "ctrl-alt-del") {
    sendCtrlAltDelete();
    return;
  }
  if (command === "ctrl-c") {
    sendRemoteCtrlC();
    return;
  }
  if (command === "enter") {
    sendRemoteEnter();
    return;
  }
  if (command === "paste") {
    void pasteFromClipboard();
    return;
  }
  if (command === "clear") {
    sendRemoteCommand("clear");
    return;
  }
  if (command === "reboot") {
    sendRemoteCommand("reboot");
  }
}

function focusConsole() {
  if (isCliConsole.value) {
    terminalConsoleRef.value?.focus();
    return;
  }
  screenRef.value?.focus({ preventScroll: true });
  rfb?.focus();
}

function scheduleConsoleWakeRefresh() {
  clearConsoleWakeRefreshTimer();
  consoleWakeRefreshTimer = window.setTimeout(() => {
    consoleWakeRefreshTimer = null;
    if (!effectiveVisible.value || !connected.value || !rfb) return;
    refreshNoVncViewport();
  }, CONSOLE_WAKE_REFRESH_DELAY_MS);
}

function clearConsoleWakeRefreshTimer() {
  if (consoleWakeRefreshTimer == null) return;
  window.clearTimeout(consoleWakeRefreshTimer);
  consoleWakeRefreshTimer = null;
}

function startResize(event: MouseEvent) {
  event.preventDefault();
  isResizing.value = true;
  resizeStart = {
    x: event.clientX,
    y: event.clientY,
    width: dialogSize.width,
    height: dialogSize.height,
  };
  window.addEventListener("mousemove", handleResizeMove);
  window.addEventListener("mouseup", stopResize);
}

function handleResizeMove(event: MouseEvent) {
  if (!resizeStart) return;
  const deltaX = event.clientX - resizeStart.x;
  const deltaY = event.clientY - resizeStart.y;
  setDialogSizeForDimensions(resizeStart.width + deltaX, resizeStart.height + deltaY);
  rememberNormalDialogSize();
  requestConsoleResize({ focus: false });
}

function stopResize() {
  resizeStart = null;
  isResizing.value = false;
  window.removeEventListener("mousemove", handleResizeMove);
  window.removeEventListener("mouseup", stopResize);
  requestConsoleResize({ focus: true });
}

function startDialogDrag(event: PointerEvent) {
  if (props.embedded) return;
  if (event.button !== 0) return;
  const dragHandle = event.currentTarget as HTMLElement | null;
  if (!dragHandle) return;
  const dialogElement = dragHandle.closest(".el-dialog") as HTMLElement | null;
  if (!dialogElement) return;
  event.preventDefault();
  try {
    dragHandle.setPointerCapture(event.pointerId);
  } catch {
    // Window-level listeners still provide a safe drag fallback.
  }
  dragStart = {
    x: event.clientX,
    y: event.clientY,
    offsetX: dialogOffsetX,
    offsetY: dialogOffsetY,
    element: dialogElement,
    handle: dragHandle,
    pointerId: event.pointerId,
  };
  dragHandle.addEventListener("lostpointercapture", stopDialogDrag);
  window.addEventListener("pointermove", handleDialogDragMove);
  window.addEventListener("pointerup", stopDialogDrag);
  window.addEventListener("pointercancel", stopDialogDrag);
  window.addEventListener("blur", stopDialogDrag);
}

function handleDialogDragMove(event: PointerEvent) {
  if (!dragStart) return;
  if ((event.buttons & 1) === 0) {
    stopDialogDrag();
    return;
  }
  applyDialogOffset(dragStart.offsetX + event.clientX - dragStart.x, dragStart.offsetY + event.clientY - dragStart.y, dragStart.element);
}

function stopDialogDrag() {
  const activeDrag = dragStart;
  dragStart = null;
  if (activeDrag) {
    activeDrag.handle.removeEventListener("lostpointercapture", stopDialogDrag);
    try {
      if (activeDrag.handle.hasPointerCapture(activeDrag.pointerId)) {
        activeDrag.handle.releasePointerCapture(activeDrag.pointerId);
      }
    } catch {
      // Pointer capture can already be gone when the browser window loses focus.
    }
  }
  window.removeEventListener("pointermove", handleDialogDragMove);
  window.removeEventListener("pointerup", stopDialogDrag);
  window.removeEventListener("pointercancel", stopDialogDrag);
  window.removeEventListener("blur", stopDialogDrag);
}

function resetDialogOffset() {
  dialogOffsetX = 0;
  dialogOffsetY = 0;
  applyDialogOffset(0, 0);
}

function applyDialogOffset(x: number, y: number, targetElement?: HTMLElement) {
  const dialogElement = targetElement ?? dragStart?.element ?? getConsoleDialogElement();
  if (!dialogElement) {
    dialogOffsetX = x;
    dialogOffsetY = y;
    return;
  }

  const rect = dialogElement.getBoundingClientRect();
  const nextLeft = rect.left + x - dialogOffsetX;
  const nextTop = rect.top + y - dialogOffsetY;
  const minLeft = DIALOG_DRAG_VIEWPORT_MARGIN;
  const minTop = DIALOG_DRAG_VIEWPORT_MARGIN;
  const maxLeft = Math.max(minLeft, window.innerWidth - rect.width - DIALOG_DRAG_VIEWPORT_MARGIN);
  const maxTop = Math.max(minTop, window.innerHeight - rect.height - DIALOG_DRAG_VIEWPORT_MARGIN);
  dialogOffsetX = x + clamp(nextLeft, minLeft, maxLeft) - nextLeft;
  dialogOffsetY = y + clamp(nextTop, minTop, maxTop) - nextTop;
  dialogElement.style.transform = `translate(${dialogOffsetX}px, ${dialogOffsetY}px)`;
}

function ensureDialogWithinViewport() {
  if (!effectiveVisible.value) return;
  if (props.embedded) return;
  const dialogElement = getConsoleDialogElement();
  if (dialogElement) {
    applyDialogOffset(dialogOffsetX, dialogOffsetY, dialogElement);
  }
}

function getConsoleDialogElement() {
  const rootElement = dialogRef.value?.$el;
  if (rootElement instanceof HTMLElement && rootElement.matches(".el-dialog.console-dialog")) {
    return rootElement;
  }
  return (rootElement?.querySelector?.(".el-dialog.console-dialog") ?? document.querySelector(".el-dialog.console-dialog")) as HTMLElement | null;
}

function resetDialogSize() {
  if (props.embedded) return;
  setDialogSizeForConsoleFit({ expanded: false });
  rememberNormalDialogSize();
}

function setDialogSizeForConsoleFit(options: { expanded: boolean }) {
  const maxWidth = Math.min(Math.max(window.innerWidth - DIALOG_HORIZONTAL_MARGIN, MIN_DIALOG_WIDTH), DEFAULT_DIALOG_MAX_WIDTH);
  const maxHeight = Math.min(Math.max(window.innerHeight - DIALOG_VERTICAL_MARGIN, MIN_DIALOG_HEIGHT), DEFAULT_DIALOG_MAX_HEIGHT);
  const minWidth = Math.min(MIN_DIALOG_WIDTH, maxWidth);
  const minHeight = Math.min(MIN_DIALOG_HEIGHT, maxHeight);
  const aspectRatio = getConsoleAspectRatio();
  const horizontalChrome = options.expanded
    ? 0
    : NORMAL_CONSOLE_SIDE_WIDTH + NORMAL_CONSOLE_LAYOUT_GAP + NORMAL_CONSOLE_LAYOUT_HORIZONTAL_PADDING + NORMAL_CONSOLE_BORDER_ALLOWANCE;
  const verticalChrome =
    CONSOLE_TITLEBAR_HEIGHT +
    (options.expanded ? 0 : NORMAL_CONSOLE_HEADER_HEIGHT + NORMAL_CONSOLE_LAYOUT_VERTICAL_PADDING + NORMAL_CONSOLE_BORDER_ALLOWANCE);
  const availableScreenWidth = Math.max(240, maxWidth - horizontalChrome);
  const availableScreenHeight = Math.max(180, maxHeight - verticalChrome);
  const targetScreenWidth = options.expanded ? DEFAULT_EXPANDED_SCREEN_WIDTH : DEFAULT_NORMAL_SCREEN_WIDTH;
  const targetScreenHeight = options.expanded ? DEFAULT_EXPANDED_SCREEN_HEIGHT : DEFAULT_NORMAL_SCREEN_HEIGHT;
  const maxScreenWidth = Math.min(availableScreenWidth, targetScreenWidth);
  const maxScreenHeight = Math.min(availableScreenHeight, targetScreenHeight);

  let screenWidth = maxScreenWidth;
  let screenHeight = Math.round(screenWidth / aspectRatio);
  if (screenHeight > maxScreenHeight) {
    screenHeight = maxScreenHeight;
    screenWidth = Math.round(screenHeight * aspectRatio);
  }
  dialogSize.width = clamp(screenWidth + horizontalChrome, minWidth, maxWidth);
  dialogSize.height = clamp(screenHeight + verticalChrome, minHeight, maxHeight);
}

function setDialogSizeForDimensions(preferredWidth: number, preferredHeight: number) {
  const maxWidth = Math.max(window.innerWidth - DIALOG_HORIZONTAL_MARGIN, MIN_DIALOG_WIDTH);
  const maxHeight = Math.max(window.innerHeight - DIALOG_VERTICAL_MARGIN, MIN_DIALOG_HEIGHT);
  dialogSize.width = clamp(preferredWidth, Math.min(MIN_DIALOG_WIDTH, maxWidth), maxWidth);
  dialogSize.height = clamp(preferredHeight, Math.min(MIN_DIALOG_HEIGHT, maxHeight), maxHeight);
}

function rememberNormalDialogSize() {
  if (isExpanded.value) return;
  normalDialogSize.width = dialogSize.width;
  normalDialogSize.height = dialogSize.height;
}

function toggleExpandedConsole() {
  if (props.embedded) {
    isExpanded.value = !isExpanded.value;
    requestConsoleResize({ focus: true });
    return;
  }
  if (isExpanded.value) {
    isExpanded.value = false;
    if (normalDialogSize.width && normalDialogSize.height) {
      setDialogSizeForDimensions(normalDialogSize.width, normalDialogSize.height);
    } else {
      setDialogSizeForConsoleFit({ expanded: false });
    }
  } else {
    rememberNormalDialogSize();
    isExpanded.value = true;
    metricsOverlayVisible.value = true;
    setDialogSizeForConsoleFit({ expanded: true });
  }
  void nextTick(ensureDialogWithinViewport);
  requestConsoleResize({ focus: true });
}

function toggleMetricsOverlay() {
  metricsOverlayVisible.value = !metricsOverlayVisible.value;
  focusConsole();
}

async function copyConsoleInfo() {
  const target = props.target;
  if (!target) return;
  const lines = [
    `VM: ${target.vmName}`,
    `Host: ${target.hostName || "-"}`,
    `IP: ${target.vmIp || "-"}`,
    `Spec: ${consoleSpecText.value}`,
  ];
  try {
    await navigator.clipboard.writeText(lines.join("\n"));
    consoleNoticeText.value = "已复制";
  } catch {
    consoleNoticeText.value = "复制失败";
  }
  window.setTimeout(() => {
    consoleNoticeText.value = "";
  }, 1400);
}

async function pasteFromClipboard(nativeRequestId = 0) {
  if (nativeRequestId && !consumeNativePasteRequest(nativeRequestId)) return;
  if (!connected.value || !rfb) {
    showConsoleNotice("控制台未连接，未发送文本", 1800);
    return;
  }
  clearConsoleWakeRefreshTimer();
  cancelConsolePaste("");
  const clipboardReadTaskId = ++consolePasteTaskSeq;
  try {
    const text = await navigator.clipboard.readText();
    if (clipboardReadTaskId !== consolePasteTaskSeq) return;
    void pasteTextToConsole(text);
  } catch {
    requestNativePasteCapture({ notice: `请按 ${CONSOLE_PASTE_SHORTCUT_LABEL} 粘贴` });
    return;
  } finally {
    if (!activeNativePasteRequestId) focusConsole();
  }
}

function requestNativePasteCapture(options: { notice?: string } = {}) {
  if (!connected.value || !rfb) {
    showConsoleNotice("控制台未连接，未发送文本", 1800);
    return;
  }
  clearConsoleWakeRefreshTimer();
  const textarea = clipboardCaptureRef.value;
  if (!textarea) {
    showConsoleNotice(`请点击控制台后按 ${CONSOLE_PASTE_SHORTCUT_LABEL} 粘贴`, 2200);
    focusConsole();
    return;
  }
  cancelConsolePaste("");
  clearNativePasteFallbackTimer();
  const requestId = ++nativePasteRequestSeq;
  activeNativePasteRequestId = requestId;
  textarea.value = "";
  textarea.focus({ preventScroll: true });
  textarea.select();
  if (options.notice) showConsoleNotice(options.notice, 2400);
  nativePasteFallbackTimer = window.setTimeout(() => {
    nativePasteFallbackTimer = null;
    consumeNativePasteRequest(requestId);
    textarea.blur();
    focusConsole();
  }, CONSOLE_NATIVE_PASTE_CAPTURE_TIMEOUT_MS);
}

function handleClipboardCapturePaste(event: ClipboardEvent) {
  if (!effectiveVisible.value || !connected.value || !rfb) return;
  const text = event.clipboardData?.getData("text/plain") ?? "";
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  const requestId = activeNativePasteRequestId;
  if (!requestId || !consumeNativePasteRequest(requestId)) return;
  clearNativePasteFallbackTimer();
  clipboardCaptureRef.value?.blur();
  if (text) {
    void pasteTextToConsole(text);
  } else {
    focusConsole();
  }
}

function clearNativePasteFallbackTimer() {
  if (nativePasteFallbackTimer == null) return;
  window.clearTimeout(nativePasteFallbackTimer);
  nativePasteFallbackTimer = null;
}

function consumeNativePasteRequest(requestId: number) {
  if (!requestId || requestId !== activeNativePasteRequestId) return false;
  activeNativePasteRequestId = 0;
  return true;
}

function getConsoleAspectRatio() {
  return Number.isFinite(consoleAspectRatio.value) && consoleAspectRatio.value > 0 ? consoleAspectRatio.value : 4 / 3;
}

function syncConsoleAspectRatio(options: { reveal?: boolean; attempt?: number } = {}) {
  const snapshot = getConsoleAspectRatioSnapshot();
  if (!snapshot) {
    if (options.reveal && (options.attempt ?? 0) < CONSOLE_FRAME_REVEAL_RETRY_LIMIT) {
      window.setTimeout(
        () => syncConsoleAspectRatio({ ...options, attempt: (options.attempt ?? 0) + 1 }),
        CONSOLE_FRAME_REVEAL_RETRY_DELAY_MS,
      );
    }
    return;
  }
  const nextAspectRatio = snapshot.aspectRatio;
  if (!Number.isFinite(nextAspectRatio) || nextAspectRatio <= 0) return;
  const target = noVncTarget.value;
  if (target) cacheConsoleAspectRatio(target, nextAspectRatio);
  if (Math.abs(nextAspectRatio - consoleAspectRatio.value) >= 0.01) {
    consoleAspectRatio.value = nextAspectRatio;
    if (!props.embedded) {
      setDialogSizeForConsoleFit({ expanded: isExpanded.value });
      if (!isExpanded.value) rememberNormalDialogSize();
    }
  }
  if (options.reveal) {
    revealConsoleFrame();
    nextTick(() => {
      refreshNoVncViewport();
      window.requestAnimationFrame(() => {
        refreshNoVncViewport();
        if (!isConsoleCanvasFitted() && (options.attempt ?? 0) < CONSOLE_FRAME_REVEAL_RETRY_LIMIT) {
          window.setTimeout(
            () => syncConsoleAspectRatio({ ...options, attempt: (options.attempt ?? 0) + 1 }),
            CONSOLE_FRAME_REVEAL_RETRY_DELAY_MS,
          );
          return;
        }
        revealConsoleFrame();
      });
    });
  }
}

function revealConsoleFrame() {
  consoleFrameReady.value = true;
  clearConsoleFrameWatchTimer();
  stopConsoleCanvasProbe();
}

function startConsoleFrameWatch() {
  clearConsoleFrameWatchTimer();
  const startedAt = Date.now();
  const tick = () => {
    if (!effectiveVisible.value || !props.target || !rfb || !connected.value || consoleFrameReady.value) {
      clearConsoleFrameWatchTimer();
      return;
    }
    const snapshot = getConsoleAspectRatioSnapshot();
    if (snapshot) {
      syncConsoleAspectRatio({ reveal: true });
      return;
    }
    if (Date.now() - startedAt >= CONSOLE_FRAME_RECONNECT_TIMEOUT_MS) {
      clearConsoleFrameWatchTimer();
      scheduleConsoleReconnect("控制台画面未就绪");
      return;
    }
    consoleFrameWatchTimer = window.setTimeout(tick, CONSOLE_FRAME_REVEAL_RETRY_DELAY_MS);
  };
  consoleFrameWatchTimer = window.setTimeout(tick, CONSOLE_FRAME_REVEAL_RETRY_DELAY_MS);
}

function clearConsoleFrameWatchTimer() {
  if (consoleFrameWatchTimer == null) return;
  window.clearTimeout(consoleFrameWatchTimer);
  consoleFrameWatchTimer = null;
}

function startConsoleCanvasProbe() {
  stopConsoleCanvasProbe();
  const screen = screenRef.value;
  if (!screen) return;
  const startedAt = Date.now();
  const probe = () => {
    if (!effectiveVisible.value || !props.target || !rfb || !connected.value || consoleFrameReady.value) {
      stopConsoleCanvasProbe();
      return;
    }
    if (hasRenderableConsoleCanvas()) {
      syncConsoleAspectRatio({ reveal: true });
      if (!consoleFrameReady.value) revealConsoleFrame();
      return;
    }
    const nextDelay = Date.now() - startedAt > CONSOLE_FRAME_RECONNECT_TIMEOUT_MS ? 500 : CONSOLE_FRAME_REVEAL_RETRY_DELAY_MS;
    consoleCanvasProbeTimer = window.setTimeout(probe, nextDelay);
  };
  consoleCanvasObserver = new MutationObserver(() => probe());
  consoleCanvasObserver.observe(screen, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["width", "height", "style", "class"],
  });
  consoleCanvasProbeTimer = window.setTimeout(probe, 60);
}

function stopConsoleCanvasProbe() {
  if (consoleCanvasProbeTimer != null) {
    window.clearTimeout(consoleCanvasProbeTimer);
    consoleCanvasProbeTimer = null;
  }
  consoleCanvasObserver?.disconnect();
  consoleCanvasObserver = null;
}

function hasRenderableConsoleCanvas(): boolean {
  const canvas = screenRef.value?.querySelector("canvas");
  if (!canvas) return false;
  const width = canvas.width || Number(canvas.getAttribute("width"));
  const height = canvas.height || Number(canvas.getAttribute("height"));
  const rect = canvas.getBoundingClientRect();
  const hasSize = (width > 1 && height > 1) || (rect.width > 1 && rect.height > 1);
  return hasSize;
}

function hasNonBlankConsoleCanvas(): boolean {
  const canvas = screenRef.value?.querySelector("canvas");
  return canvas ? hasNonBlankCanvasPixels(canvas) : false;
}

function startProvisionBlankConsoleWatch(delayMs?: number) {
  clearProvisionBlankConsoleWatch();
  if (!isProvisionConsole.value || props.provisionTask?.status === "failed") return;
  const nextDelay = delayMs ?? Math.min(
    CONSOLE_PROVISION_BLANK_RECONNECT_DELAY_MS * Math.max(consoleBlankReconnectAttempt + 1, 1),
    CONSOLE_PROVISION_BLANK_RECONNECT_MAX_DELAY_MS,
  );
  consoleBlankReconnectTimer = window.setTimeout(() => {
    consoleBlankReconnectTimer = null;
    if (!effectiveVisible.value || !props.target || !connected.value || !rfb || !isProvisionConsole.value || props.provisionTask?.status === "failed") return;
    if (hasNonBlankConsoleCanvas()) {
      consoleBlankReconnectAttempt = 0;
      startProvisionBlankConsoleWatch();
      return;
    }
    if (!shouldReconnectBlankProvisionConsole()) {
      startProvisionBlankConsoleWatch();
      return;
    }
    consoleBlankReconnectAttempt += 1;
    consoleFrameReady.value = false;
    statusText.value = `控制台暂时黑屏，正在重新获取当前画面（第 ${consoleBlankReconnectAttempt} 次）`;
    void connectConsole();
  }, nextDelay);
}

function clearProvisionBlankConsoleWatch() {
  if (consoleBlankReconnectTimer == null) return;
  window.clearTimeout(consoleBlankReconnectTimer);
  consoleBlankReconnectTimer = null;
}

function shouldReconnectBlankProvisionConsole() {
  if (!effectiveVisible.value || !props.target || !connected.value || !rfb || !isProvisionConsole.value) return false;
  const stepKey = currentProvisionVm.value?.currentStep || props.provisionTask?.currentStep || provisionTaskCurrentStep.value?.key;
  if (!["boot", "fetch-source", "install-guest", "wait-network", "verify-login", "finalize", "guest-tools"].includes(String(stepKey))) return false;
  const canvas = screenRef.value?.querySelector("canvas");
  if (!canvas) return true;
  return !hasNonBlankCanvasPixels(canvas);
}

function hasNonBlankCanvasPixels(canvas: HTMLCanvasElement): boolean {
  if (!canvas.width || !canvas.height) return false;
  try {
    const sampleWidth = Math.min(canvas.width, 80);
    const sampleHeight = Math.min(canvas.height, 60);
    const sampleCanvas = document.createElement("canvas");
    sampleCanvas.width = sampleWidth;
    sampleCanvas.height = sampleHeight;
    const sampleContext = sampleCanvas.getContext("2d", { willReadFrequently: true });
    if (!sampleContext) return false;
    sampleContext.drawImage(canvas, 0, 0, sampleWidth, sampleHeight);
    const image = sampleContext.getImageData(0, 0, sampleWidth, sampleHeight).data;
    for (let index = 0; index < image.length; index += 4) {
      if (image[index] || image[index + 1] || image[index + 2]) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function startProvisionStaleConsoleWatch() {
  stopProvisionStaleConsoleWatch({ reset: false });
  if (!shouldWatchProvisionConsoleForStaleFrame()) return;
  consoleStaleWatchTimer = window.setTimeout(pollProvisionStaleConsole, CONSOLE_PROVISION_STALE_SAMPLE_INTERVAL_MS);
}

function pollProvisionStaleConsole() {
  consoleStaleWatchTimer = null;
  if (!shouldWatchProvisionConsoleForStaleFrame()) {
    stopProvisionStaleConsoleWatch({ reset: true });
    return;
  }

  const fingerprint = getConsoleFrameFingerprint();
  const sampledAt = Date.now();
  if (!fingerprint) {
    scheduleNextProvisionStaleConsoleSample();
    return;
  }
  if (fingerprint !== consoleLastFrameFingerprint) {
    consoleLastFrameFingerprint = fingerprint;
    consoleLastFrameChangedAt = sampledAt;
    consoleStaleReconnectAttempt = 0;
    scheduleNextProvisionStaleConsoleSample();
    return;
  }
  if (!consoleLastFrameChangedAt) {
    consoleLastFrameChangedAt = sampledAt;
  }

  const staleDelay = Math.min(
    CONSOLE_PROVISION_STALE_RECONNECT_DELAY_MS * 2 ** consoleStaleReconnectAttempt,
    CONSOLE_PROVISION_STALE_RECONNECT_MAX_DELAY_MS,
  );
  if (sampledAt - consoleLastFrameChangedAt < staleDelay) {
    scheduleNextProvisionStaleConsoleSample();
    return;
  }

  consoleStaleReconnectAttempt += 1;
  consoleLastFrameChangedAt = sampledAt;
  consoleFrameReady.value = false;
  statusText.value = `控制台画面长时间未更新，正在重新获取当前画面（第 ${consoleStaleReconnectAttempt} 次）`;
  void connectConsole();
}

function scheduleNextProvisionStaleConsoleSample() {
  if (!shouldWatchProvisionConsoleForStaleFrame()) {
    stopProvisionStaleConsoleWatch({ reset: true });
    return;
  }
  consoleStaleWatchTimer = window.setTimeout(pollProvisionStaleConsole, CONSOLE_PROVISION_STALE_SAMPLE_INTERVAL_MS);
}

function stopProvisionStaleConsoleWatch(options: { reset: boolean }) {
  if (consoleStaleWatchTimer != null) {
    window.clearTimeout(consoleStaleWatchTimer);
    consoleStaleWatchTimer = null;
  }
  if (options.reset) resetProvisionStaleConsoleWatchState();
}

function resetProvisionStaleConsoleWatchState() {
  consoleStaleReconnectAttempt = 0;
  consoleLastFrameFingerprint = "";
  consoleLastFrameChangedAt = 0;
}

function shouldWatchProvisionConsoleForStaleFrame() {
  if (!effectiveVisible.value || !props.target || !connected.value || !rfb || !isProvisionConsole.value || isProvisionTaskTerminal.value) {
    return false;
  }
  const vmStatus = currentProvisionVm.value?.status;
  if (vmStatus && !["pending", "running"].includes(vmStatus)) return false;
  const stepKey = activeProvisionConsoleStep.value;
  return ["boot", "fetch-source", "install-guest", "wait-network", "verify-login", "finalize", "guest-tools"].includes(String(stepKey));
}

function getConsoleFrameFingerprint(): string {
  const canvas = screenRef.value?.querySelector("canvas");
  if (!canvas?.width || !canvas.height) return "";
  try {
    const sampleCanvas = document.createElement("canvas");
    sampleCanvas.width = CONSOLE_PROVISION_FRAME_SAMPLE_WIDTH;
    sampleCanvas.height = CONSOLE_PROVISION_FRAME_SAMPLE_HEIGHT;
    const sampleContext = sampleCanvas.getContext("2d", { willReadFrequently: true });
    if (!sampleContext) return "";
    sampleContext.drawImage(canvas, 0, 0, sampleCanvas.width, sampleCanvas.height);
    const pixels = sampleContext.getImageData(0, 0, sampleCanvas.width, sampleCanvas.height).data;
    let hash = 2166136261;
    for (let index = 0; index < pixels.length; index += 4) {
      hash ^= pixels[index] >> 4;
      hash = Math.imul(hash, 16777619);
      hash ^= pixels[index + 1] >> 4;
      hash = Math.imul(hash, 16777619);
      hash ^= pixels[index + 2] >> 4;
      hash = Math.imul(hash, 16777619);
    }
    return `${canvas.width}x${canvas.height}:${(hash >>> 0).toString(16)}`;
  } catch {
    return "";
  }
}

function getConsoleAspectRatioSnapshot(): { aspectRatio: number; source: "framebuffer" | "rendered-canvas" | "canvas" } | null {
  const framebufferSize = getRemoteFramebufferSize();
  if (framebufferSize) {
    return { aspectRatio: framebufferSize.width / framebufferSize.height, source: "framebuffer" };
  }

  const canvas = screenRef.value?.querySelector("canvas");
  if (!canvas) return null;
  const width = canvas.width || Number(canvas.getAttribute("width"));
  const height = canvas.height || Number(canvas.getAttribute("height"));
  if (width > 0 && height > 0) {
    return { aspectRatio: width / height, source: "canvas" };
  }

  const canvasRect = canvas.getBoundingClientRect();
  if (canvasRect.width > 0 && canvasRect.height > 0) {
    return { aspectRatio: canvasRect.width / canvasRect.height, source: "rendered-canvas" };
  }
  return null;
}

function getRemoteFramebufferSize(): { width: number; height: number } | null {
  const client = rfb as
    | (RFB & {
        _fbWidth?: number;
        _fbHeight?: number;
        _display?: {
          width?: number;
          height?: number;
        };
      })
    | null;
  const width = client?._fbWidth || client?._display?.width || 0;
  const height = client?._fbHeight || client?._display?.height || 0;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

function isConsoleCanvasFitted() {
  const screen = screenRef.value;
  const canvas = screen?.querySelector("canvas");
  if (!screen || !canvas) return false;
  const screenRect = screen.getBoundingClientRect();
  const canvasRect = canvas.getBoundingClientRect();
  if (!screenRect.width || !screenRect.height || !canvasRect.width || !canvasRect.height) return false;
  const sourceWidth = canvas.width || Number(canvas.getAttribute("width"));
  const sourceHeight = canvas.height || Number(canvas.getAttribute("height"));
  if (!sourceWidth || !sourceHeight) return false;
  const sourceAspectRatio = sourceWidth / sourceHeight;
  const renderedAspectRatio = canvasRect.width / canvasRect.height;
  const fitsWithinScreen = canvasRect.width <= screenRect.width + 3 && canvasRect.height <= screenRect.height + 3;
  const touchesScreenEdge = Math.abs(screenRect.width - canvasRect.width) <= 3 || Math.abs(screenRect.height - canvasRect.height) <= 3;
  const preservesAspectRatio = Math.abs(sourceAspectRatio - renderedAspectRatio) <= 0.01;
  const fillsEmbeddedScreen = props.embedded && !isExpanded.value &&
    Math.abs(screenRect.width - canvasRect.width) <= 3 &&
    Math.abs(screenRect.height - canvasRect.height) <= 3;
  return fitsWithinScreen && touchesScreenEdge && (preservesAspectRatio || fillsEmbeddedScreen);
}

function enableEmbeddedStretchPointerMapping(client: RFB) {
  if (!props.embedded) return;
  const display = (client as RFB & { _display?: NoVncDisplayCoordinateMapper })._display;
  const canvas = screenRef.value?.querySelector("canvas");
  if (!display || !canvas) return;

  const originalAbsX = display.absX.bind(display);
  const originalAbsY = display.absY.bind(display);
  display.absX = (position) => mapStretchedConsoleCoordinate(position, canvas.getBoundingClientRect().width, canvas.width, originalAbsX);
  display.absY = (position) => mapStretchedConsoleCoordinate(position, canvas.getBoundingClientRect().height, canvas.height, originalAbsY);
}

function mapStretchedConsoleCoordinate(
  position: number,
  renderedSize: number,
  framebufferSize: number,
  fallback: (position: number) => number,
) {
  if (!Number.isFinite(renderedSize) || renderedSize <= 0 || !Number.isFinite(framebufferSize) || framebufferSize <= 0) {
    return fallback(position);
  }
  return clamp(Math.floor((position / renderedSize) * framebufferSize), 0, Math.max(0, framebufferSize - 1));
}

function refreshNoVncViewport(options: { focus?: boolean } = {}) {
  shouldFocusAfterViewportRefresh = shouldFocusAfterViewportRefresh || options.focus !== false;
  if (viewportRefreshFrame != null) return;
  viewportRefreshFrame = window.requestAnimationFrame(() => {
    viewportRefreshFrame = null;
    const shouldFocus = shouldFocusAfterViewportRefresh;
    shouldFocusAfterViewportRefresh = false;
    refreshNoVncViewportNow(shouldFocus);
  });
}

function refreshNoVncViewportNow(shouldFocus: boolean) {
  const client = rfb as
    | (RFB & {
        _updateClip?: () => void;
        _updateScale?: () => void;
        _saveExpectedClientSize?: () => void;
      })
    | null;
  client?._updateClip?.();
  client?._updateScale?.();
  client?._saveExpectedClientSize?.();
  if (shouldFocus) focusConsole();
}

function setNoVncBackground(background: string) {
  const client = rfb as (RFB & { background?: string }) | null;
  if (client) client.background = background;
}

function setNoVncDotCursor(visible: boolean) {
  const client = rfb as (RFB & { showDotCursor?: boolean }) | null;
  if (client) client.showDotCursor = visible;
}

function cacheConsoleAspectRatio(target: NoVncVmConsoleTarget, aspectRatio: number) {
  const cacheKey = consoleAspectRatioCacheKey(target);
  consoleAspectRatioCache.set(cacheKey, aspectRatio);
  try {
    const rawCache = window.localStorage.getItem(CONSOLE_ASPECT_RATIO_CACHE_KEY);
    const cache = rawCache ? (JSON.parse(rawCache) as Record<string, number>) : {};
    cache[cacheKey] = aspectRatio;
    window.localStorage.setItem(CONSOLE_ASPECT_RATIO_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // localStorage can be unavailable in restricted browser contexts.
  }
}

function getCachedConsoleAspectRatio(target: NoVncVmConsoleTarget): number | undefined {
  const memoryValue = consoleAspectRatioCache.get(consoleAspectRatioCacheKey(target));
  if (memoryValue) return memoryValue;
  try {
    const rawCache = window.localStorage.getItem(CONSOLE_ASPECT_RATIO_CACHE_KEY);
    const cache = rawCache ? (JSON.parse(rawCache) as Record<string, number>) : {};
    const storedValue = cache[consoleAspectRatioCacheKey(target)];
    if (Number.isFinite(storedValue) && storedValue > 0) {
      consoleAspectRatioCache.set(consoleAspectRatioCacheKey(target), storedValue);
      return storedValue;
    }
  } catch {
    // Ignore malformed or inaccessible cache; the console will learn the ratio again.
  }
  return undefined;
}

function consoleAspectRatioCacheKey(target: NoVncVmConsoleTarget): string {
  return `${target.connectionId || ""}:${target.vmId || target.wsUrl || ""}`;
}

function connectScreenResizeObserver() {
  disconnectScreenResizeObserver();
  if (!screenRef.value) return;
  screenResizeObserver = new ResizeObserver(() => requestConsoleResize({ focus: false }));
  screenResizeObserver.observe(screenRef.value);
}

function disconnectScreenResizeObserver() {
  screenResizeObserver?.disconnect();
  screenResizeObserver = null;
}

function requestConsoleResize(options: { focus?: boolean } = {}) {
  if (props.throttleResize === false) {
    refreshNoVncViewportNow(options.focus !== false);
    return;
  }
  refreshNoVncViewport({ focus: options.focus !== false });
}

function applyNoVncDisplayPreferences(client: RFB) {
  const remoteResize = props.displayScaleMode === "remote";
  client.scaleViewport = props.displayScaleMode ? !remoteResize : consoleDisplayStrategy.value.scaleViewport;
  client.resizeSession = props.embedded || (props.displayScaleMode ? remoteResize : consoleDisplayStrategy.value.resizeSession);
  const displayClient = client as RFB & { qualityLevel: number; compressionLevel: number };
  const quality = props.displayQuality ?? "auto";
  if (quality === "high") {
    displayClient.qualityLevel = 9;
    displayClient.compressionLevel = 1;
  } else if (quality === "smooth") {
    displayClient.qualityLevel = 5;
    displayClient.compressionLevel = 6;
  } else {
    displayClient.qualityLevel = consoleDisplayStrategy.value.qualityLevel;
    displayClient.compressionLevel = consoleDisplayStrategy.value.compressionLevel;
  }
}

function handleConsoleDragEnter(event: DragEvent) {
  if (isCliConsole.value) return;
  if (!event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault();
  uploadDragActive.value = true;
}

function handleConsoleDragOver(event: DragEvent) {
  if (isCliConsole.value) return;
  if (!event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = uploadBusy.value ? "none" : "copy";
  uploadDragActive.value = true;
}

function handleConsoleDragLeave(event: DragEvent) {
  if (isCliConsole.value) return;
  const currentTarget = event.currentTarget as HTMLElement | null;
  const relatedTarget = event.relatedTarget as Node | null;
  if (currentTarget && relatedTarget && currentTarget.contains(relatedTarget)) return;
  uploadDragActive.value = false;
}

function handleConsoleDrop(event: DragEvent) {
  if (isCliConsole.value) return;
  event.preventDefault();
  uploadDragActive.value = false;
  if (uploadBusy.value) return;
  const files = Array.from(event.dataTransfer?.files ?? []).filter((file) => file.size >= 0);
  if (!files.length) return;
  void uploadConsoleFiles(files);
}

async function uploadConsoleFiles(files: File[]) {
  const target = noVncTarget.value;
  if (!target?.connectionId || !target.vmId) {
    showUploadStatus("控制台参数不完整，无法上传", "error");
    return;
  }
  uploadBusy.value = true;
  const uploadId = createConsoleUploadId();
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  showUploadStatus(`正在上传 ${files.length} 个文件`, "info");
  updateUploadProgress({
    title: "准备上传",
    detail: `即将上传 ${files.length} 个文件到 ${target.vmName}`,
    percent: 0,
    transferred: 0,
    total: totalBytes,
  });
  listenConsoleUploadProgress(uploadId);
  const formData = new FormData();
  formData.append("uploadId", uploadId);
  formData.append("connectionId", target.connectionId);
  formData.append("vmId", target.vmId);
  formData.append("providerType", target.providerType);
  formData.append("vmName", target.vmName);
  formData.append("vmIp", target.vmIp || "");
  for (const file of files) {
    formData.append("files", file, file.name);
  }
  try {
    const result = await requestConsoleUpload(formData, totalBytes);
    const remotePaths = result.uploaded?.map((item) => item.remotePath).filter(Boolean) ?? [];
    const successMessage = result.message || `已上传 ${files.length} 个文件`;
    const detailMessage = remotePaths.length ? `${successMessage}：${remotePaths.join("，")}` : successMessage;
    updateUploadProgress({
      title: "上传完成",
      detail: detailMessage,
      percent: 100,
      transferred: totalBytes,
      total: totalBytes,
    });
    showUploadStatus(detailMessage, "success");
    emit("upload-result", {
      vmName: target.vmName,
      vmIp: target.vmIp || "",
      status: "success",
      message: detailMessage,
      files: files.map((file) => file.name),
      remotePaths,
    });
  } catch (error) {
    const errorMessage = formatConsoleUploadError(error);
    updateUploadProgress({
      title: "上传失败",
      detail: errorMessage,
      percent: uploadProgressPercent.value,
      transferred: undefined,
      total: totalBytes,
    });
    showUploadStatus(errorMessage, "error");
    emit("upload-result", {
      vmName: target.vmName,
      vmIp: target.vmIp || "",
      status: "error",
      message: errorMessage,
      files: files.map((file) => file.name),
      remotePaths: [],
    });
  } finally {
    window.setTimeout(() => {
      if (!uploadBusy.value) uploadProgressVisible.value = false;
    }, 6000);
    uploadBusy.value = false;
    closeUploadProgressSource();
  }
}

function formatConsoleUploadError(error: unknown) {
  return error instanceof Error ? error.message : "文件上传失败";
}

function requestConsoleUpload(formData: FormData, totalBytes: number): Promise<ConsoleUploadResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/console/upload");
    xhr.responseType = "json";
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        updateUploadProgress({
          title: "发送到后端",
          detail: "浏览器正在把文件发送到本地 API，之后才会进入 SFTP 写入 VM",
          percent: clamp(Math.round((event.loaded / event.total) * 100), 0, 100),
          transferred: event.loaded,
          total: event.total,
        });
        return;
      }
      updateUploadProgress({
        title: "发送到后端",
        detail: "浏览器正在把文件发送到本地 API",
        percent: uploadProgressPercent.value,
        transferred: undefined,
        total: totalBytes,
      });
    };
    xhr.onload = () => {
      const result = parseConsoleUploadResponse(xhr);
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(result);
        return;
      }
      reject(new Error(result.message || (xhr.status === 404 ? "服务端未接入控制台上传" : "文件上传失败")));
    };
    xhr.onerror = () => reject(new Error("上传请求失败，请检查本地 API 是否可用"));
    xhr.onabort = () => reject(new Error("上传已取消，文件没有确认写入 VM"));
    xhr.ontimeout = () => reject(new Error("上传请求超时，文件没有确认写入 VM"));
    xhr.send(formData);
  });
}

function parseConsoleUploadResponse(xhr: XMLHttpRequest): ConsoleUploadResponse {
  if (xhr.response && typeof xhr.response === "object") return xhr.response as ConsoleUploadResponse;
  try {
    return JSON.parse(xhr.responseText || "{}") as ConsoleUploadResponse;
  } catch {
    return {};
  }
}

function listenConsoleUploadProgress(uploadId: string) {
  closeUploadProgressSource();
  if (typeof EventSource === "undefined") return;
  const source = new EventSource(`/api/console/upload/${encodeURIComponent(uploadId)}/events`);
  uploadProgressSource = source;
  source.addEventListener("progress", (event) => {
    try {
      const parsed = JSON.parse((event as MessageEvent).data) as ConsoleUploadProgressResponse;
      applyServerUploadProgress(parsed.progress);
    } catch {
      // Ignore malformed progress events; the final upload response still decides success.
    }
  });
  source.onerror = () => {
    source.close();
    if (uploadProgressSource === source) uploadProgressSource = null;
  };
}

function closeUploadProgressSource() {
  uploadProgressSource?.close();
  uploadProgressSource = null;
}

function applyServerUploadProgress(progress: ConsoleUploadProgressEvent) {
  const stageTitle: Record<ConsoleUploadProgressEvent["stage"], string> = {
    queued: "等待上传",
    receiving: "接收文件",
    connecting: "连接 VM",
    preparing: "准备远端目录",
    uploading: "SFTP 写入 VM",
    completed: "上传完成",
    failed: "上传失败",
  };
  updateUploadProgress({
    title: stageTitle[progress.stage],
    detail: progress.remotePath ? `${progress.message} -> ${progress.remotePath}` : progress.message,
    percent: progress.percent ?? uploadProgressPercent.value,
    transferred: progress.bytesTransferred,
    total: progress.totalBytes,
    speed: progress.speedBytesPerSecond,
  });
}

function updateUploadProgress(options: { title: string; detail: string; percent: number; transferred?: number; total?: number; speed?: number }) {
  uploadProgressVisible.value = true;
  uploadProgressTitle.value = options.title;
  uploadProgressDetail.value = options.detail;
  uploadProgressPercent.value = clamp(Math.round(options.percent), 0, 100);
  const parts = [];
  if (options.transferred != null && options.total != null) {
    parts.push(`${formatBytes(options.transferred)} / ${formatBytes(options.total)}`);
  } else if (options.total != null) {
    parts.push(`共 ${formatBytes(options.total)}`);
  }
  if (options.speed && options.speed > 0) {
    parts.push(`${formatBytes(options.speed)}/s`);
  }
  uploadProgressMeta.value = parts.join(" · ");
}

function createConsoleUploadId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `upload-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const fractionDigits = size >= 100 || unitIndex === 0 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(fractionDigits)} ${units[unitIndex]}`;
}

function finiteMetric(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function metricPercent(used: number | null, total: number | null) {
  if (used == null || total == null || total <= 0) return null;
  return clamp(Math.round((used / total) * 100), 0, 100);
}

function formatMetricNumber(value: number) {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(value);
}

function formatMetricCapacity(value: number | null) {
  if (value == null) return "-";
  const gib = value / 1024 ** 3;
  if (gib >= 1) return `${formatMetricNumber(gib)}GiB`;
  return `${formatMetricNumber(value / 1024 ** 2)}MiB`;
}

function formatMetricRate(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0KB/s";
  if (value >= 1024 ** 2) return `${formatMetricNumber(value / 1024 ** 2)}MB/s`;
  return `${formatMetricNumber(value / 1024)}KB/s`;
}

function showUploadStatus(message: string, level: "info" | "success" | "error" = "info") {
  uploadStatusText.value = message;
  uploadStatusLevel.value = level;
  const visibleMs = level === "error" ? 9000 : 3200;
  window.setTimeout(() => {
    if (uploadStatusText.value === message) uploadStatusText.value = "";
  }, visibleMs);
}

function handleConsoleShortcut(event: KeyboardEvent) {
  if (!effectiveVisible.value) return;
  if (event.key === "Escape" && isExpanded.value && !props.embedded) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    stopDialogDrag();
    releaseModifierKeys();
    toggleExpandedConsole();
    return;
  }
  if (!rfb || !isConsoleKeyboardContext(event.target)) return;
  clearConsoleWakeRefreshTimer();
  if (event.key === "Backspace" && !event.metaKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (consolePasteSending.value) cancelConsolePaste("已取消文本发送");
    if (!event.repeat) startConsoleBackspaceRepeat();
    return;
  }
  const isNativeCtrlC = event.key.toLowerCase() === "c" && event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
  if (consolePasteSending.value && !isModifierKey(event.key)) {
    cancelConsolePaste("已取消文本发送", { releaseModifiers: !isNativeCtrlC });
  }
  const directText = resolveDirectConsoleTextKey(event);
  if (directText) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    void sendConsoleText(directText);
    return;
  }
  const shortcut = resolveLocalConsoleShortcut(event);
  if (!shortcut) return;
  if (shortcut.action === "paste") {
    event.stopPropagation();
    event.stopImmediatePropagation();
    suppressLocalShortcutUntil = Date.now() + 1000;
    suppressedLocalShortcutKey = shortcut.key;
    suppressedLocalShortcutModifier = event.metaKey ? "meta" : "ctrl";
    releaseModifierKeys();
    requestNativePasteCapture();
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  suppressLocalShortcutUntil = Date.now() + 1000;
  suppressedLocalShortcutKey = shortcut.key;
  suppressedLocalShortcutModifier = event.metaKey ? "meta" : "ctrl";
  if (!remoteCtrlCInFlight) releaseModifierKeys();
}

function handleConsoleScreenShortcut(event: KeyboardEvent) {
  const isRemoteCtrlC =
    event.key.toLowerCase() === "c" &&
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    !event.shiftKey;
  if (!isRemoteCtrlC) return;

  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  if (!event.repeat) sendRemoteCtrlC();
}

function handleConsoleScreenShortcutKeyup(event: KeyboardEvent) {
  const isRemoteCtrlC =
    event.key.toLowerCase() === "c" &&
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    !event.shiftKey;
  if (!isRemoteCtrlC) return;

  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
}

function handleConsoleCompositionEnd(event: CompositionEvent) {
  if (!effectiveVisible.value || !rfb || !isConsoleKeyboardContext(event.target)) return;
  if (isEditableEventTarget(event.target)) return;
  const normalized = normalizeConsoleTextInput(event.data || "");
  if (normalized.unsupportedCharacterCount > 0) {
    showConsoleNotice(`包含 ${normalized.unsupportedCharacterCount} 个兼容模式不支持的字符，未发送`, 2400);
    return;
  }
  if (!normalized.text) return;
  event.stopPropagation();
  event.stopImmediatePropagation();
  void sendConsoleText(normalized.text);
}

function handleConsoleShortcutKeyup(event: KeyboardEvent) {
  if (!effectiveVisible.value || !rfb) return;
  if (event.key === "Backspace" && consoleBackspaceHeld) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    stopConsoleBackspaceRepeat();
    return;
  }
  const matchesSuppressedModifier =
    (suppressedLocalShortcutModifier === "meta" && event.metaKey && !event.ctrlKey) ||
    (suppressedLocalShortcutModifier === "ctrl" && event.ctrlKey && !event.metaKey);
  if (
    Date.now() > suppressLocalShortcutUntil ||
    event.key.toLowerCase() !== suppressedLocalShortcutKey ||
    !matchesSuppressedModifier
  ) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  releaseModifierKeys();
  suppressedLocalShortcutKey = "";
  suppressedLocalShortcutModifier = "";
}

function handleConsolePaste(event: ClipboardEvent) {
  if (isCliConsole.value) return;
  if (event.target === clipboardCaptureRef.value) return;
  if (!effectiveVisible.value || !connected.value || !rfb || !isConsoleKeyboardContext(event.target)) return;
  const text = event.clipboardData?.getData("text/plain") ?? "";
  if (!text) return;
  clearConsoleWakeRefreshTimer();
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  void pasteTextToConsole(text);
}

function resolveLocalConsoleShortcut(event: KeyboardEvent): { action: "paste" | "block"; key: string } | null {
  const key = event.key.toLowerCase();
  if (key === "escape" && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
    return { action: "block", key };
  }
  if (event.shiftKey || event.altKey) return null;
  const isLocalModifier = event.metaKey || event.ctrlKey;
  if (!isLocalModifier) return null;
  if (key === "v") return { action: "paste", key };
  if (["x", "a"].includes(key)) return { action: "block", key };
  return null;
}

function resolveDirectConsoleTextKey(event: KeyboardEvent) {
  if (isEditableEventTarget(event.target)) return "";
  if (event.metaKey || event.ctrlKey || event.altKey) return "";
  if (event.shiftKey) return "";
  if (event.key === "." || event.key === "。" || event.key === "．" || event.key === "｡") return ".";
  if (event.code === "NumpadDecimal" || event.code === "Period") return ".";
  return "";
}

function cancelConsolePaste(message: string, options: { clearNotice?: boolean; releaseModifiers?: boolean } = {}) {
  consoleTextSendToken += 1;
  consolePasteTaskSeq += 1;
  if (!consolePasteSending.value) {
    if (options.clearNotice) consoleNoticeText.value = "";
    return;
  }

  consolePasteSending.value = false;
  if (options.releaseModifiers !== false) releaseModifierKeys();
  if (options.clearNotice) {
    consoleNoticeText.value = "";
  } else if (message) {
    showConsoleNotice(message, 1600);
  }
}

function showConsoleNotice(message: string, visibleMs: number) {
  consoleNoticeText.value = message;
  window.setTimeout(() => {
    if (consoleNoticeText.value === message) consoleNoticeText.value = "";
  }, visibleMs);
}

function isConsoleKeyboardContext(target: EventTarget | null) {
  const frame = consoleFrameRef.value;
  if (!frame) return false;
  const targetNode = target instanceof Node ? target : null;
  const activeElement = document.activeElement;
  return (!!targetNode && frame.contains(targetNode)) || (!!activeElement && frame.contains(activeElement));
}

function isModifierKey(key: string) {
  return ["Alt", "AltGraph", "Control", "Meta", "Shift"].includes(key);
}

async function pasteTextToConsole(text: string) {
  if (!connected.value || !rfb) {
    showConsoleNotice("控制台未连接，未发送文本", 1800);
    return;
  }
  cancelConsolePaste("");
  const taskId = ++consolePasteTaskSeq;

  const normalized = normalizeConsoleClipboardText(text);
  if (normalized.unsupportedCharacterCount > 0) {
    showConsoleNotice(`包含 ${normalized.unsupportedCharacterCount} 个兼容模式不支持的字符，未发送`, 2800);
    return;
  }
  if (!normalized.text) {
    showConsoleNotice("剪贴板没有可发送文本", 1800);
    return;
  }

  const normalizedText = normalized.text;
  const characterCount = [...normalizedText].length;
  if (characterCount > CONSOLE_MAX_PASTE_CHARACTERS) {
    showConsoleNotice(`文本超过 ${CONSOLE_MAX_PASTE_CHARACTERS} 个字符，未发送`, 2800);
    return;
  }

  if (taskId !== consolePasteTaskSeq || !connected.value || !rfb) {
    showConsoleNotice("控制台连接已断开，未发送文本", 2200);
    return;
  }

  consolePasteSending.value = true;
  consoleNoticeText.value = `正在发送 0/${characterCount}`;
  const result = await sendConsoleText(normalizedText, {
    onProgress(sentCount) {
      if (taskId === consolePasteTaskSeq) consoleNoticeText.value = `正在发送 ${sentCount}/${characterCount}`;
    },
  });
  if (taskId !== consolePasteTaskSeq) return;

  consolePasteSending.value = false;
  if (result.status === "completed" && result.sentCount === characterCount) {
    showConsoleNotice(`已发送到控制台 ${result.sentCount} 个字符`, 1600);
  } else if (result.status === "disconnected") {
    showConsoleNotice(`连接已断开，发送 ${result.sentCount}/${characterCount}`, 2600);
  } else {
    showConsoleNotice(`已取消，发送 ${result.sentCount}/${characterCount}`, 2000);
  }
}

function sendConsoleText(text: string, options: ConsoleTextSendOptions = {}): Promise<ConsoleTextSendResult> {
  clearConsoleWakeRefreshTimer();
  const token = consoleTextSendToken;
  consoleTextSendQueue = consoleTextSendQueue
    .catch(() => ({ sentCount: 0, status: "cancelled" as const }))
    .then(() => sendConsoleTextNow(text, token, options));
  return consoleTextSendQueue;
}

async function sendConsoleTextNow(text: string, token: number, options: ConsoleTextSendOptions): Promise<ConsoleTextSendResult> {
  let sentCount = 0;
  if (!connected.value || !rfb) return { sentCount, status: "disconnected" };
  releaseModifierKeys();
  focusConsole();
  await delay(CONSOLE_MODIFIER_RELEASE_DELAY_MS);
  for (const char of text) {
    if (!connected.value || !rfb) {
      releaseModifierKeys();
      return { sentCount, status: "disconnected" };
    }
    if (token !== consoleTextSendToken) {
      releaseModifierKeys();
      return { sentCount, status: "cancelled" };
    }
    if (await sendTextCharacter(char)) {
      sentCount += 1;
      if (sentCount % 10 === 0 || sentCount === text.length) options.onProgress?.(sentCount);
      await delay(CONSOLE_TEXT_SEND_INTERVAL_MS);
    }
  }
  releaseModifierKeys();
  focusConsole();
  return { sentCount, status: "completed" };
}

async function sendTextCharacter(char: string) {
  if (!connected.value || !rfb) return false;
  const special = specialKeyForCharacter(char);
  if (special) {
    return tapRemoteKey(special.keysym, special.code);
  }
  const keyStroke = keyStrokeForCharacter(char);
  if (keyStroke) {
    return tapRemoteKey(keyStroke.keysym, keyStroke.code, keyStroke.shift);
  }
  if (!isPrintableTextCharacter(char)) return false;
  const codePoint = char.codePointAt(0);
  if (codePoint == null) return false;
  const keysym = codePoint <= 0xff ? codePoint : 0x01000000 | codePoint;
  return tapRemoteKey(keysym, undefined);
}

async function tapRemoteKey(keysym: number, code?: string, shift = false, holdMs = CONSOLE_TEXT_KEY_HOLD_MS) {
  const session = rfb;
  if (!session || !connected.value) return false;
  if (shift) {
    session.sendKey(0xffe1, "ShiftLeft", true);
    await delay(CONSOLE_TEXT_SHIFT_SETTLE_MS);
  }
  if (session !== rfb || !connected.value) {
    if (shift) session.sendKey(0xffe1, "ShiftLeft", false);
    return false;
  }
  session.sendKey(keysym, code, true);
  await delay(holdMs);
  session.sendKey(keysym, code, false);
  if (shift) {
    await delay(CONSOLE_TEXT_SHIFT_SETTLE_MS);
    session.sendKey(0xffe1, "ShiftLeft", false);
  }
  return session === rfb && connected.value;
}

function specialKeyForCharacter(char: string): { keysym: number; code: string } | null {
  if (char === "\n" || char === "\r") return { keysym: 0xff0d, code: "Enter" };
  if (char === "\t") return { keysym: 0xff09, code: "Tab" };
  if (char === "\b") return { keysym: 0xff08, code: "Backspace" };
  if (char === "\u001b") return { keysym: 0xff1b, code: "Escape" };
  return null;
}

function isPrintableTextCharacter(char: string) {
  const codePoint = char.codePointAt(0);
  if (codePoint == null) return false;
  return codePoint >= 0x20 && codePoint !== 0x7f;
}

function keyStrokeForCharacter(char: string): { keysym: number; code: string; shift?: boolean } | null {
  const mapped = CONSOLE_KEY_STROKE_MAP[char];
  if (mapped) return mapped;
  if (/^[a-z]$/.test(char)) {
    return { keysym: char.charCodeAt(0), code: `Key${char.toUpperCase()}` };
  }
  if (/^[A-Z]$/.test(char)) {
    return { keysym: char.charCodeAt(0), code: `Key${char}`, shift: true };
  }
  return null;
}

function releaseModifierKeys() {
  rfb?.sendKey(0xffe3, "ControlLeft", false);
  rfb?.sendKey(0xffe4, "ControlRight", false);
  rfb?.sendKey(0xffe7, "MetaLeft", false);
  rfb?.sendKey(0xffe8, "MetaRight", false);
  rfb?.sendKey(0xffe9, "MetaLeft", false);
  rfb?.sendKey(0xffeb, "MetaLeft", false);
  rfb?.sendKey(0xffec, "MetaRight", false);
  rfb?.sendKey(0xffe9, "AltLeft", false);
  rfb?.sendKey(0xffea, "AltRight", false);
  rfb?.sendKey(0xffe1, "ShiftLeft", false);
  rfb?.sendKey(0xffe2, "ShiftRight", false);
}

function delay(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

function isEditableEventTarget(target: EventTarget | null) {
  const element = target instanceof HTMLElement ? target : null;
  if (!element) return false;
  if (element.isContentEditable) return true;
  return !!element.closest("input, textarea, select, [contenteditable='true']");
}

function buildApiWebSocketUrl(path: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.hostname || "127.0.0.1";
  const port = window.location.port === "5173" ? "3987" : window.location.port;
  const authority = port ? `${host}:${port}` : host;
  return `${protocol}//${authority}${path}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function provisionStepStatusText(status: ProvisionTaskStep["status"] | ProvisionTaskVm["status"]) {
  if (status === "success") return "完成";
  if (status === "running") return "执行中";
  if (status === "warning") return "有告警";
  if (status === "failed") return "失败";
  if (status === "skipped") return "跳过";
  return "等待";
}

function provisionVmPercent(item: ProvisionConsoleTargetItem) {
  const packageDone = Number(item.installPackageDone);
  const packageTotal = Number(item.installPackageTotal);
  if (Number.isFinite(packageDone) && Number.isFinite(packageTotal) && packageTotal > 0 && Number.isFinite(item.progressPercent)) {
    return clamp(Math.round(item.progressPercent ?? 0), 0, 100);
  }
  if (item.status === "success") return 100;
  if (item.status === "failed") return Math.max(provisionTaskPercent.value, 12);
  if (item.status === "running") return Math.max(Math.min(provisionTaskPercent.value, 96), 18);
  return 0;
}

function provisionVmProgressLabel(item: ProvisionConsoleTargetItem) {
  const packageDone = Number(item.installPackageDone);
  const packageTotal = Number(item.installPackageTotal);
  if (Number.isFinite(packageDone) && Number.isFinite(packageTotal) && packageTotal > 0) {
    return `${packageDone}/${packageTotal}`;
  }
  return provisionStepStatusText(item.status);
}

function isProvisionTargetActive(item: ProvisionConsoleTargetItem) {
  if (item.target?.vmId && item.target.vmId === props.target?.vmId) return true;
  if (item.key && item.key === props.target?.vmId) return true;
  return !!item.target?.vmName && item.target.vmName === props.target?.vmName;
}

function selectProvisionTarget(item: ProvisionConsoleTargetItem) {
  if (!item.target) return;
  emit("select-provision-target", item);
}
</script>

<template>
  <component
    :is="consoleRootComponent"
    ref="dialogRef"
    :class="consoleRootClass"
    v-bind="consoleRootAttrs"
    @update:model-value="!embedded && emit('update:visible', $event)"
    @closed="handleConsoleClosed"
  >
    <section class="console-layout">
      <aside v-if="isProvisionConsole" class="console-side console-task-rail" aria-label="创建任务控制台">
        <div class="task-rail-head">
          <strong>控制台窗口</strong>
          <span>同一 taskId 下多台 VM 用对象列表切换，主画面始终只展开当前选中 VM。</span>
        </div>
        <section class="console-task-hero">
          <div class="console-task-hero-top">
            <div>
              <strong>{{ provisionTask?.id || "创建任务" }}</strong>
              <p>{{ provisionTaskCurrentCopy }}</p>
            </div>
            <span class="console-task-state" :class="consoleTaskStatusTone">{{ provisionStepStatusText(provisionTask?.status || "pending") }}</span>
          </div>
          <div class="console-task-track" aria-hidden="true">
            <i :style="{ width: `${provisionTaskPercent}%` }"></i>
          </div>
        </section>
        <section class="console-task-status-card" :class="consoleTaskStatusTone">
          <div class="console-task-status-head">
            <span class="console-task-status-dot" aria-hidden="true"></span>
            <span class="console-task-status-title">{{ provisionTaskRunningTitle }}</span>
          </div>
          <p class="console-task-status-message">{{ provisionTask?.message || provisionTaskStatusText }}</p>
          <dl class="console-task-status-list">
            <template v-for="row in consoleTaskStatusRows" :key="row.label">
              <dt>{{ row.label }}</dt>
              <dd>{{ row.value }}</dd>
            </template>
          </dl>
        </section>
        <div class="console-vm-tabs">
          <button
            v-for="item in provisionTargets"
            :key="item.key"
            type="button"
            class="console-vm-tab"
            :class="{ active: isProvisionTargetActive(item), disabled: !item.target }"
            :disabled="!item.target"
            @click="selectProvisionTarget(item)"
          >
            <span class="console-vm-preview" :style="{ '--mini-progress': `${provisionVmPercent(item)}%` }"></span>
            <span class="console-vm-copy">
              <strong>{{ item.name }}</strong>
              <span>{{ [item.ip, item.message || provisionStepStatusText(item.status)].filter(Boolean).join(" · ") }}</span>
            </span>
            <em :class="`status-${item.status}`">{{ provisionVmProgressLabel(item) }}</em>
          </button>
        </div>
        <div v-if="shouldShowUploadProgressInSide" class="console-upload-progress is-side">
          <div class="console-upload-progress-head">
            <strong>{{ uploadProgressTitle }}</strong>
            <span>{{ uploadProgressPercent }}%</span>
          </div>
          <div class="console-upload-progress-track" aria-hidden="true">
            <span :style="{ width: `${uploadProgressPercent}%` }"></span>
          </div>
          <p>{{ uploadProgressDetail }}</p>
          <small v-if="uploadProgressMeta">{{ uploadProgressMeta }}</small>
        </div>
      </aside>

      <aside v-else class="console-side" aria-label="控制台信息">
        <div class="console-vm-card">
          <div class="console-vm-head">
            <strong>{{ target?.vmName || "虚拟机控制台" }}</strong>
            <span :class="{ running: connected }">{{ connected ? "运行中" : target?.powerStateLabel || "未知" }}</span>
          </div>
          <div class="console-meta-line">
            <span>宿主机</span>
            <strong>{{ target?.hostName || "-" }}</strong>
          </div>
          <div class="console-meta-line">
            <span>IP</span>
            <strong>{{ target?.vmIp || "-" }}</strong>
          </div>
          <div class="console-meta-line">
            <span>规格</span>
            <strong>{{ consoleSpecText }}</strong>
          </div>
        </div>

        <div v-if="!isCliConsole" class="console-action-grid">
          <el-tooltip content="常用命令" placement="bottom" :show-after="120" :hide-after="0" :disabled="props.showIconTooltips === false">
            <el-dropdown trigger="click" placement="bottom-start" popper-class="console-command-menu" :disabled="!connected" @command="handleConsoleCommand">
              <button class="console-action-icon active" :disabled="!connected" aria-label="常用命令">
                <svg class="console-command-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M7 8h10" />
                  <path d="M7 12h10" />
                  <path d="M7 16h6" />
                </svg>
              </button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="paste">粘贴文本</el-dropdown-item>
                  <el-dropdown-item command="enter">Enter</el-dropdown-item>
                  <el-dropdown-item command="ctrl-c">Ctrl + C</el-dropdown-item>
                  <el-dropdown-item command="ctrl-alt-del">Ctrl + Alt + Del</el-dropdown-item>
                  <el-dropdown-item divided command="clear">clear</el-dropdown-item>
                  <el-dropdown-item command="reboot">reboot</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </el-tooltip>
          <el-tooltip content="重新连接控制台" placement="bottom" :show-after="120" :hide-after="0" :disabled="props.showIconTooltips === false">
            <button class="console-action-icon" aria-label="重新连接控制台" @click.stop="connectConsole">
              <el-icon><Refresh /></el-icon>
            </button>
          </el-tooltip>
          <el-tooltip v-if="!embedded" content="放大控制台窗口" placement="bottom" :show-after="120" :hide-after="0" :disabled="props.showIconTooltips === false">
            <button class="console-action-icon" aria-label="放大控制台窗口" @click.stop="toggleExpandedConsole">
              <el-icon><FullScreen /></el-icon>
            </button>
          </el-tooltip>
        </div>

        <ConsoleVmMetrics
          v-if="shouldShowConsoleMetricsInSide"
          mode="side"
          :loading="consoleMetricsLoading"
          :loading-metrics="consoleMetricsStrategy?.placeholderMetrics ?? []"
          :memory-pressure-tone="consoleMetricsStrategy?.memoryPressureTone ?? true"
          :refresh-interval-ms="consoleMetricsStrategy?.pollIntervalMs ?? 2000"
          v-bind="consoleMetricView"
        />

        <div v-if="shouldShowUploadProgressInSide" class="console-upload-progress is-side">
          <div class="console-upload-progress-head">
            <strong>{{ uploadProgressTitle }}</strong>
            <span>{{ uploadProgressPercent }}%</span>
          </div>
          <div class="console-upload-progress-track" aria-hidden="true">
            <span :style="{ width: `${uploadProgressPercent}%` }"></span>
          </div>
          <p>{{ uploadProgressDetail }}</p>
          <small v-if="uploadProgressMeta">{{ uploadProgressMeta }}</small>
        </div>
      </aside>

      <main class="console-window">
        <div class="console-titlebar" @pointerdown="startDialogDrag">
          <div class="console-titlebar-main">
            <strong>{{ target?.vmName || "虚拟机" }}</strong>
            <span>{{ target?.vmIp || "-" }}</span>
            <span class="console-titlebar-status" :class="{ connected }" :title="statusText">{{ statusText }}</span>
            <span v-if="isProvisionConsole" class="console-titlebar-status connected">{{ provisionTaskStatusText }}</span>
          </div>
          <div class="console-tools" @pointerdown.stop>
            <span v-if="consoleNoticeText" class="console-paste-status">{{ consoleNoticeText }}</span>
            <el-tooltip v-if="!isCliConsole && consolePasteSending" content="取消文本发送" placement="bottom" :show-after="80" :hide-after="0" :disabled="props.showIconTooltips === false">
              <button class="console-paste-cancel" aria-label="取消文本发送" @click.stop="cancelConsolePaste('已取消文本发送')">
                <el-icon><Close /></el-icon>
              </button>
            </el-tooltip>
            <el-tooltip
              v-if="shouldShowMetricsToggle"
              :content="metricsOverlayVisible ? '隐藏资源监控' : '显示资源监控'"
              placement="bottom"
              :show-after="120"
              :hide-after="0"
              :disabled="props.showIconTooltips === false"
            >
              <button
                class="console-tool-button"
                :class="{ active: metricsOverlayVisible }"
                :aria-label="metricsOverlayVisible ? '隐藏资源监控' : '显示资源监控'"
                :aria-pressed="metricsOverlayVisible"
                @click.stop="toggleMetricsOverlay"
              >
                <el-icon><Monitor /></el-icon>
              </button>
            </el-tooltip>
            <el-tooltip content="复制控制台信息" placement="bottom" :show-after="120" :hide-after="0" :disabled="props.showIconTooltips === false">
              <button class="console-tool-button" aria-label="复制控制台信息" @click.stop="copyConsoleInfo">
                <el-icon><CopyDocument /></el-icon>
              </button>
            </el-tooltip>
            <el-tooltip v-if="!isCliConsole" content="常用命令" placement="bottom" :show-after="120" :hide-after="0" :disabled="props.showIconTooltips === false">
              <el-dropdown trigger="click" placement="bottom-end" popper-class="console-command-menu" :disabled="!connected" @command="handleConsoleCommand">
                <button class="console-tool-button" :disabled="!connected" aria-label="常用命令">
                  <svg class="console-command-icon" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M7 8h10" />
                    <path d="M7 12h10" />
                    <path d="M7 16h6" />
                  </svg>
                </button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item command="paste">粘贴文本</el-dropdown-item>
                    <el-dropdown-item command="enter">Enter</el-dropdown-item>
                    <el-dropdown-item command="ctrl-c">Ctrl + C</el-dropdown-item>
                    <el-dropdown-item command="ctrl-alt-del">Ctrl + Alt + Del</el-dropdown-item>
                    <el-dropdown-item divided command="clear">clear</el-dropdown-item>
                    <el-dropdown-item command="reboot">reboot</el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </el-tooltip>
            <el-tooltip content="重新连接控制台" placement="bottom" :show-after="120" :hide-after="0" :disabled="props.showIconTooltips === false">
              <button class="console-tool-button" aria-label="重新连接控制台" @click.stop="isCliConsole ? connectTerminal() : connectConsole()">
                <el-icon><Refresh /></el-icon>
              </button>
            </el-tooltip>
            <el-tooltip :content="isExpanded ? '退出放大' : '放大控制台窗口'" placement="bottom" :show-after="120" :hide-after="0" :disabled="props.showIconTooltips === false">
              <button
                class="console-tool-button"
                :aria-label="isExpanded ? '退出放大' : '放大控制台窗口'"
                @click.stop="toggleExpandedConsole"
              >
                <svg v-if="isExpanded" class="console-command-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M9 4v5H4" />
                  <path d="M15 4v5h5" />
                  <path d="M9 20v-5H4" />
                  <path d="M15 20v-5h5" />
                </svg>
                <el-icon v-else><FullScreen /></el-icon>
              </button>
            </el-tooltip>
          </div>
        </div>

        <section
          ref="consoleFrameRef"
          class="console-frame"
          :class="{ pending: !consoleFrameReady }"
          tabindex="0"
          @click="focusConsole"
          @mouseenter="focusConsole"
          @paste.capture="handleConsolePaste"
          @dragenter.prevent="handleConsoleDragEnter"
          @dragover.prevent="handleConsoleDragOver"
          @dragleave="handleConsoleDragLeave"
          @drop.prevent="handleConsoleDrop"
        >
          <div v-if="uploadDragActive" class="console-upload-overlay">
            <div class="console-upload-card">
              <strong>{{ uploadBusy ? "正在上传" : "松手上传文件" }}</strong>
              <span>文件会提交到控制台上传通道</span>
            </div>
          </div>
          <ConsoleVmMetrics
            v-if="shouldShowConsoleMetricsInFrame"
            mode="overlay"
            :loading="consoleMetricsLoading"
            :loading-metrics="consoleMetricsStrategy?.placeholderMetrics ?? []"
            :memory-pressure-tone="consoleMetricsStrategy?.memoryPressureTone ?? true"
            :refresh-interval-ms="consoleMetricsStrategy?.pollIntervalMs ?? 2000"
            v-bind="consoleMetricView"
          />
          <div v-if="shouldShowUploadProgressInFrame" class="console-upload-progress">
            <div class="console-upload-progress-head">
              <strong>{{ uploadProgressTitle }}</strong>
              <span>{{ uploadProgressPercent }}%</span>
            </div>
            <div class="console-upload-progress-track" aria-hidden="true">
              <span :style="{ width: `${uploadProgressPercent}%` }"></span>
            </div>
            <p>{{ uploadProgressDetail }}</p>
            <small v-if="uploadProgressMeta">{{ uploadProgressMeta }}</small>
          </div>
          <div v-if="uploadStatusText" class="console-upload-status" :class="`is-${uploadStatusLevel}`">{{ uploadStatusText }}</div>
          <textarea
            v-if="!isCliConsole"
            ref="clipboardCaptureRef"
            class="console-clipboard-capture"
            aria-hidden="true"
            tabindex="-1"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            @paste.capture="handleClipboardCapturePaste"
          ></textarea>
          <div v-if="isCliConsole" class="console-cli-frame">
            <div v-if="terminalSaveOffer" class="console-credential-save-offer" role="status">
              <span>本次登录成功。是否将登录信息保存到本机密码库（加密）？下次打开控制台或扩容将自动套用。</span>
              <button type="button" class="console-credential-save-confirm" @click.stop="saveTerminalCredentialsToVault">保存到本机</button>
              <button type="button" class="console-credential-save-dismiss" @click.stop="dismissTerminalSaveOffer">不保存</button>
            </div>
            <TerminalConsole
              ref="terminalConsoleRef"
              :session="terminalSession"
              :status="terminalStatus"
              :initial-data="cliInitialData"
              :font-family="terminalFontFamily"
              :font-size="terminalFontSize"
              :line-height="terminalLineHeight"
              :cursor-style="terminalCursorStyle"
              :cursor-blink="terminalCursorBlink"
              :theme="terminalTheme"
              :read-only="!terminalAcceptsInput"
              :error-message="cliTerminalMessage"
              :aria-label="`${target?.vmName || '虚拟机'} Linux CLI`"
              @ready="handleTerminalReady"
              @input="handleTerminalInput"
              @resize="handleTerminalResize"
            />
          </div>
          <div
            v-if="!isCliConsole && !consoleFrameReady"
            class="console-frame-pending console-terminal-overlay"
            :class="`platform-${consoleLoadingBrand.type}`"
          >
              <div class="console-loading-card">
                <div class="console-loading-mark">
                  <div class="resource-loader-mark console-resource-loader-mark" aria-hidden="true">
                    <span class="resource-loader-ring"></span>
                    <VrcLogoMark />
                  </div>
                </div>
              <strong>{{ consolePendingCopy.title }}</strong>
              <span :title="consolePendingCopy.detail">{{ consolePendingCopy.detail }}</span>
            </div>
          </div>
          <div
            v-if="!isCliConsole"
            ref="screenRef"
            class="console-screen"
            tabindex="-1"
            lang="en"
            inputmode="text"
            autocapitalize="off"
            spellcheck="false"
            @pointerdown.capture="focusConsole"
            @keydown.capture="handleConsoleScreenShortcut"
            @keyup.capture="handleConsoleScreenShortcutKeyup"
          ></div>
          <div
            v-if="watermarkEnabled"
            class="console-security-watermark"
            :style="consoleWatermarkStyle"
            aria-hidden="true"
          >
            <span v-for="index in consoleWatermarkCopies" :key="index">{{ watermarkText || "VRC · console" }}</span>
          </div>
        </section>

      </main>
    </section>
    <span v-if="!embedded" class="console-resize-handle" @mousedown="startResize"></span>
  </component>
</template>
