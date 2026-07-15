<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import RFB from "@novnc/novnc";
import { ElDialog } from "element-plus";
import { CopyDocument, FullScreen, Monitor, Refresh } from "@element-plus/icons-vue";
import ConsoleVmMetrics from "./ConsoleVmMetrics.vue";
import type { NoVncVmConsoleTarget } from "../domain/consoleStrategies";
import { resolveConsoleMetricsLoadingStrategy } from "../domain/consoleStrategies";
import { getProviderBrand } from "../domain/providerBrand";
import type { ProvisionTask, ProvisionTaskStep, ProvisionTaskVm, VmMetricSnapshot } from "../types";

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
  target: NoVncVmConsoleTarget | null;
}

const props = defineProps<{
  visible: boolean;
  target: NoVncVmConsoleTarget | null;
  provisionTask?: ProvisionTask | null;
  provisionTargets?: ProvisionConsoleTargetItem[];
  embedded?: boolean;
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
const clipboardCaptureRef = ref<HTMLTextAreaElement | null>(null);
const dialogRef = ref<{ $el?: Element } | null>(null);
const statusText = ref("等待连接");
const connected = ref(false);
const consoleNoticeText = ref("");
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
const MIN_DIALOG_WIDTH = 720;
const MIN_DIALOG_HEIGHT = 480;
const DEFAULT_DIALOG_MAX_WIDTH = 1680;
const DEFAULT_DIALOG_MAX_HEIGHT = 920;
const DEFAULT_NORMAL_SCREEN_WIDTH = 980;
const DEFAULT_NORMAL_SCREEN_HEIGHT = 620;
const DEFAULT_EXPANDED_SCREEN_WIDTH = 1280;
const DEFAULT_EXPANDED_SCREEN_HEIGHT = 720;
const NORMAL_CONSOLE_SIDE_WIDTH = 360;
const NORMAL_CONSOLE_LAYOUT_GAP = 16;
const NORMAL_CONSOLE_LAYOUT_PADDING = 20;
const NORMAL_CONSOLE_HEADER_HEIGHT = 48;
const CONSOLE_TITLEBAR_HEIGHT = 42;
const CONSOLE_WAKE_ENTER_DELAY_MS = 260;
const CONSOLE_RETRY_DELAY_MS = 2500;
const CONSOLE_RETRY_LIMIT = 24;
const CONSOLE_FRAME_REVEAL_RETRY_LIMIT = 80;
const CONSOLE_FRAME_REVEAL_RETRY_DELAY_MS = 180;
const CONSOLE_FRAME_RECONNECT_TIMEOUT_MS = 8000;
const CONSOLE_MODIFIER_RELEASE_DELAY_MS = 90;
const CONSOLE_ASPECT_RATIO_CACHE_KEY = "virtual-resource-console:console-aspect-ratio";
const CONSOLE_TEXT_NORMALIZATION_MAP: Record<string, string> = {
  "。": ".",
  "．": ".",
  "｡": ".",
  "，": ",",
  "、": "\\",
  "；": ";",
  "：": ":",
  "？": "?",
  "！": "!",
  "（": "(",
  "）": ")",
  "【": "[",
  "】": "]",
  "［": "[",
  "］": "]",
  "｛": "{",
  "｝": "}",
  "＠": "@",
  "＿": "_",
  "－": "-",
  "＝": "=",
  "＋": "+",
  "／": "/",
  "＼": "\\",
  "｜": "|",
  "＂": "\"",
  "＇": "'",
  "｀": "`",
  "～": "~",
  "＜": "<",
  "＞": ">",
  "＃": "#",
  "＄": "$",
  "％": "%",
  "＾": "^",
  "＆": "&",
  "＊": "*",
};
const CONSOLE_TEXT_SEND_INTERVAL_MS = 12;
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
let screenResizeObserver: ResizeObserver | null = null;
let consoleLoadingStartedAt = 0;
let consoleWakeTimer: number | null = null;
let consoleReconnectTimer: number | null = null;
let consoleFrameWatchTimer: number | null = null;
let consoleCanvasProbeTimer: number | null = null;
let consoleCanvasObserver: MutationObserver | null = null;
let consoleReconnectAttempt = 0;
let suppressNextConsoleDisconnect = false;
let suppressLocalShortcutUntil = 0;
let suppressedLocalShortcutKey = "";
let viewportRefreshFrame: number | null = null;
let shouldFocusAfterViewportRefresh = false;
let nativePasteFallbackTimer: number | null = null;
let consoleTextSendQueue: Promise<number> = Promise.resolve(0);
let consoleTextSendToken = 0;
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

const consoleLoadingBrand = computed(() => {
  return getProviderBrand(props.target?.providerType);
});
const consoleSpecText = computed(() => {
  const parts = [props.target?.cpuText, props.target?.memoryText, props.target?.diskText].filter(Boolean);
  return parts.length ? parts.join(" / ") : "-";
});
const isProvisionConsole = computed(() => !!props.provisionTask && !!props.provisionTargets?.length);
const provisionTaskPercent = computed(() => {
  const explicitPercent = Number((props.provisionTask as (ProvisionTask & { progressPercent?: number }) | null | undefined)?.progressPercent);
  if (Number.isFinite(explicitPercent)) return clamp(Math.round(explicitPercent), 0, 100);
  const steps = props.provisionTask?.steps ?? [];
  if (!steps.length) return 0;
  const finished = steps.filter((step) => step.status === "success" || step.status === "skipped").length;
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
const provisionTaskRunningTitle = computed(() => {
  const status = props.provisionTask?.status ?? "pending";
  if (status === "success") return "创建链路已完成";
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
const consoleRootComponent = computed(() => (props.embedded ? "section" : ElDialog));
const consoleRootClass = computed(() => [
  "console-dialog",
  "is-medium-terminal",
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
const canCollectConsoleMetrics = computed(() => {
  const target = props.target;
  return !isProvisionConsole.value && consoleMetricsStrategy.value != null && !!target?.connectionId && !!target.vmId;
});
const consoleMetricView = computed(() => {
  const snapshot = consoleMetricSnapshot.value;
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
    cpuDetail: cpuPercent == null ? "实时利用率不可用" : cpuCount > 0 ? `${cpuCount} vCPU · 平均` : "vCPU -",
    memoryPercent,
    memoryValue: memoryPercent == null ? (memoryTotal == null ? "--" : formatMetricCapacity(memoryTotal)) : `${memoryPercent}%`,
    memoryDetail:
      memoryPercent == null
        ? memoryTotal == null ? "实时用量不可用" : "分配容量"
        : [consoleMetricsStrategy.value?.memoryUsageLabel, `${formatMetricCapacity(memoryUsed)} / ${formatMetricCapacity(memoryTotal)}`]
            .filter(Boolean)
            .join(" "),
    networkRate: networkTotal == null ? "--" : formatMetricRate(networkTotal),
    networkDetail: networkTotal == null ? "等待实时采样" : `↑${formatMetricRate(networkTx ?? 0)} ↓${formatMetricRate(networkRx ?? 0)}`,
    networkBarPercent,
    diskPercent,
    diskValue: diskPercent == null ? (diskTotal == null ? "--" : formatMetricCapacity(diskTotal)) : `${diskPercent}%`,
    diskDetail:
      diskPercent == null
        ? diskActivity == null
          ? diskTotal == null ? "实时数据不可用" : "配置容量 · I/O 待采样"
          : `读${formatMetricRate(diskRead ?? 0)} · 写${formatMetricRate(diskWrite ?? 0)}`
        : `${formatMetricCapacity(diskUsed)} / ${formatMetricCapacity(diskTotal)}`,
    diskActivityPercent,
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
    ? {}
    : {
        modelValue: props.visible,
        title: "控制台",
        width: `${dialogSize.width}px`,
        style: { height: `${dialogSize.height}px` },
        top: "4vh",
        draggable: true,
        closeOnClickModal: false,
        destroyOnClose: true,
        appendToBody: true,
      },
);
watch(
  () => [effectiveVisible.value, props.target?.wsUrl, props.target?.vmId, props.target?.connectionId, props.target?.providerType, isProvisionConsole.value] as const,
  async ([visible]) => {
    if (!visible || !props.target) {
      stopConsoleMetricsPolling();
      disconnectConsole();
      disconnectScreenResizeObserver();
      clearConsoleReconnectTimer();
      clearConsoleFrameWatchTimer();
      return;
    }
    clearConsoleReconnectTimer();
    consoleReconnectAttempt = 0;
    const cachedAspectRatio = getCachedConsoleAspectRatio(props.target);
    consoleAspectRatio.value = cachedAspectRatio || props.target.aspectRatio || 4 / 3;
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

onBeforeUnmount(() => {
  window.removeEventListener("keydown", handleConsoleShortcut, true);
  window.removeEventListener("keyup", handleConsoleShortcutKeyup, true);
  window.removeEventListener("compositionend", handleConsoleCompositionEnd, true);
  window.removeEventListener("copy", handleConsoleCopy, true);
  window.removeEventListener("mousemove", handleResizeMove);
  window.removeEventListener("mouseup", stopResize);
  window.removeEventListener("pointermove", handleDialogDragMove);
  window.removeEventListener("pointerup", stopDialogDrag);
  window.removeEventListener("pointercancel", stopDialogDrag);
  if (viewportRefreshFrame != null) window.cancelAnimationFrame(viewportRefreshFrame);
  clearNativePasteFallbackTimer();
  stopConsoleMetricsPolling();
  closeUploadProgressSource();
  disconnectConsole();
  disconnectScreenResizeObserver();
  clearConsoleFrameWatchTimer();
  stopConsoleCanvasProbe();
});

onMounted(async () => {
  window.addEventListener("keydown", handleConsoleShortcut, true);
  window.addEventListener("keyup", handleConsoleShortcutKeyup, true);
  window.addEventListener("compositionend", handleConsoleCompositionEnd, true);
  window.addEventListener("copy", handleConsoleCopy, true);
  connectScreenResizeObserver();
  if (effectiveVisible.value && props.target) {
    startConsoleMetricsPolling();
    await nextTick();
    void connectConsole();
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
    const response = await fetch("/api/metrics/snapshot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        connectionId: target.connectionId,
        providerType: target.providerType,
        targetType: "vm",
        targetIds: [target.vmId],
      }),
      signal: controller.signal,
    });
    const result = (await response.json()) as ConsoleMetricsResponse & { message?: string };
    if (!response.ok) throw new Error(result.message || "读取实时指标失败");
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
  disconnectConsole();
  const screen = screenRef.value;
  const target = props.target;
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
  rfb.scaleViewport = true;
  rfb.clipViewport = false;
  rfb.resizeSession = true;
  rfb.focusOnClick = true;
  setNoVncDotCursor(true);
  setNoVncBackground("#000");

  rfb.addEventListener("connect", () => {
    clearConsoleReconnectTimer();
    consoleReconnectAttempt = 0;
    connected.value = true;
    statusText.value = "已连接";
    focusConsole();
    scheduleConsoleWakeEnter();
    window.setTimeout(() => syncConsoleAspectRatio({ reveal: true }), 120);
    startConsoleFrameWatch();
    startConsoleCanvasProbe();
    refreshNoVncViewport();
  });
  rfb.addEventListener("disconnect", (event) => {
    connected.value = false;
    consoleFrameReady.value = false;
    clearConsoleFrameWatchTimer();
    stopConsoleCanvasProbe();
    if (suppressNextConsoleDisconnect) {
      suppressNextConsoleDisconnect = false;
      return;
    }
    const clean = event instanceof CustomEvent ? Boolean((event.detail as { clean?: boolean } | undefined)?.clean) : false;
    scheduleConsoleReconnect(clean ? "连接已断开" : "RFB 握手失败或远端控制台关闭");
  });
  rfb.addEventListener("securityfailure", () => {
    connected.value = false;
    clearConsoleFrameWatchTimer();
    stopConsoleCanvasProbe();
    scheduleConsoleReconnect("认证失败或控制台被拒绝");
  });
  rfb.addEventListener("credentialsrequired", () => {
    connected.value = false;
    clearConsoleFrameWatchTimer();
    stopConsoleCanvasProbe();
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
  const response = await fetch(target.prepareUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      connectionId: target.connectionId,
      vmId: target.vmId,
    }),
  });
  const result = (await response.json()) as PreparedConsoleSession & { message?: string };
  if (!response.ok) {
    throw new Error(result.message || "控制台会话准备失败");
  }
  return {
    wsUrl: buildApiWebSocketUrl(result.wsPath),
    password: result.password,
  };
}

function disconnectConsole() {
  clearConsoleWakeTimer();
  clearConsoleReconnectTimer();
  clearConsoleFrameWatchTimer();
  consoleTextSendToken += 1;
  if (!rfb) return;
  suppressNextConsoleDisconnect = true;
  rfb.disconnect();
  rfb = null;
  window.setTimeout(() => {
    suppressNextConsoleDisconnect = false;
  }, 250);
}

function scheduleConsoleReconnect(reason: string) {
  if (!effectiveVisible.value || !props.target) return;
  const normalizedReason = reason.trim().replace(/[，,。；;：:\s]+$/u, "") || "控制台连接失败";
  const retryLimit = isProvisionConsole.value ? Number.POSITIVE_INFINITY : CONSOLE_RETRY_LIMIT;
  if (consoleReconnectAttempt >= retryLimit) {
    statusText.value = normalizedReason;
    return;
  }
  clearConsoleReconnectTimer();
  consoleReconnectAttempt += 1;
  statusText.value = Number.isFinite(retryLimit)
    ? `${normalizedReason}，自动重试 ${consoleReconnectAttempt}/${retryLimit}`
    : `${normalizedReason}，自动重试 ${consoleReconnectAttempt}`;
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

function sendCtrlAltDelete() {
  rfb?.sendCtrlAltDel();
  focusConsole();
}

function sendRemoteCtrlC() {
  if (!rfb) return;
  focusConsole();
  rfb.sendKey(0xffe3, "ControlLeft", true);
  rfb.sendKey(0x0063, "KeyC", true);
  rfb.sendKey(0x0063, "KeyC", false);
  rfb.sendKey(0xffe3, "ControlLeft", false);
  releaseModifierKeys();
}

function sendRemoteCommand(command: string) {
  if (!rfb) return;
  focusConsole();
  sendConsoleText(`${command}\n`);
}

function sendRemoteEnter() {
  if (!rfb) return;
  focusConsole();
  tapRemoteKey(0xff0d, "Enter");
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
  screenRef.value?.focus({ preventScroll: true });
  rfb?.focus();
}

function scheduleConsoleWakeEnter() {
  clearConsoleWakeTimer();
  consoleWakeTimer = window.setTimeout(() => {
    consoleWakeTimer = null;
    if (!effectiveVisible.value || !connected.value || !rfb) return;
    focusConsole();
    rfb.sendKey(0xff0d, "Enter");
    refreshNoVncViewport();
  }, CONSOLE_WAKE_ENTER_DELAY_MS);
}

function clearConsoleWakeTimer() {
  if (consoleWakeTimer == null) return;
  window.clearTimeout(consoleWakeTimer);
  consoleWakeTimer = null;
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
  const dialogElement = dragHandle?.closest(".el-dialog") as HTMLElement | null;
  if (!dialogElement) return;
  event.preventDefault();
  dragHandle?.setPointerCapture?.(event.pointerId);
  dragStart = {
    x: event.clientX,
    y: event.clientY,
    offsetX: dialogOffsetX,
    offsetY: dialogOffsetY,
    element: dialogElement,
  };
  window.addEventListener("pointermove", handleDialogDragMove);
  window.addEventListener("pointerup", stopDialogDrag);
  window.addEventListener("pointercancel", stopDialogDrag);
}

function handleDialogDragMove(event: PointerEvent) {
  if (!dragStart) return;
  applyDialogOffset(dragStart.offsetX + event.clientX - dragStart.x, dragStart.offsetY + event.clientY - dragStart.y, dragStart.element);
}

function stopDialogDrag() {
  dragStart = null;
  window.removeEventListener("pointermove", handleDialogDragMove);
  window.removeEventListener("pointerup", stopDialogDrag);
  window.removeEventListener("pointercancel", stopDialogDrag);
}

function resetDialogOffset() {
  dialogOffsetX = 0;
  dialogOffsetY = 0;
  applyDialogOffset(0, 0);
}

function applyDialogOffset(x: number, y: number, targetElement?: HTMLElement) {
  dialogOffsetX = x;
  dialogOffsetY = y;
  const dialogElement = targetElement ?? dragStart?.element ?? getConsoleDialogElement();
  if (dialogElement) {
    dialogElement.style.transform = `translate(${x}px, ${y}px)`;
  }
}

function getConsoleDialogElement() {
  return dialogRef.value?.$el?.querySelector?.(".el-dialog") as HTMLElement | null | undefined;
}

function resetDialogSize() {
  setDialogSizeForConsoleFit({ expanded: false });
  rememberNormalDialogSize();
}

function setDialogSizeForConsoleFit(options: { expanded: boolean }) {
  const maxWidth = Math.min(Math.max(window.innerWidth - DIALOG_HORIZONTAL_MARGIN, MIN_DIALOG_WIDTH), DEFAULT_DIALOG_MAX_WIDTH);
  const maxHeight = Math.min(Math.max(window.innerHeight - DIALOG_VERTICAL_MARGIN, MIN_DIALOG_HEIGHT), DEFAULT_DIALOG_MAX_HEIGHT);
  const minWidth = Math.min(MIN_DIALOG_WIDTH, maxWidth);
  const minHeight = Math.min(MIN_DIALOG_HEIGHT, maxHeight);
  const aspectRatio = getConsoleAspectRatio();
  const horizontalChrome = options.expanded ? 0 : NORMAL_CONSOLE_SIDE_WIDTH + NORMAL_CONSOLE_LAYOUT_GAP + NORMAL_CONSOLE_LAYOUT_PADDING;
  const verticalChrome = (options.expanded ? 0 : NORMAL_CONSOLE_HEADER_HEIGHT + NORMAL_CONSOLE_LAYOUT_PADDING) + CONSOLE_TITLEBAR_HEIGHT;
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
  if (props.embedded) return;
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

async function pasteFromClipboard() {
  if (!rfb) return;
  try {
    const text = await navigator.clipboard.readText();
    void pasteTextToConsole(text);
  } catch {
    consoleNoticeText.value = "浏览器未允许读取剪贴板";
    window.setTimeout(() => {
      consoleNoticeText.value = "";
    }, 1800);
  } finally {
    focusConsole();
  }
}

function requestNativePasteCapture() {
  if (!rfb) return;
  const textarea = clipboardCaptureRef.value;
  if (!textarea) {
    void pasteFromClipboard();
    return;
  }
  clearNativePasteFallbackTimer();
  textarea.value = "";
  textarea.focus({ preventScroll: true });
  textarea.select();
  nativePasteFallbackTimer = window.setTimeout(() => {
    nativePasteFallbackTimer = null;
    if (!textarea.value) {
      textarea.blur();
      void pasteFromClipboard();
    } else {
      focusConsole();
    }
  }, 160);
}

function handleClipboardCapturePaste(event: ClipboardEvent) {
  if (!effectiveVisible.value || !rfb) return;
  const text = event.clipboardData?.getData("text/plain") ?? "";
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
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
  const target = props.target;
  if (target) cacheConsoleAspectRatio(target, nextAspectRatio);
  if (Math.abs(nextAspectRatio - consoleAspectRatio.value) >= 0.01) {
    consoleAspectRatio.value = nextAspectRatio;
    setDialogSizeForConsoleFit({ expanded: isExpanded.value });
    if (!isExpanded.value) rememberNormalDialogSize();
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
  if ((width > 1 && height > 1) || (rect.width > 1 && rect.height > 1)) return true;
  return hasNonBlankCanvasPixels(canvas);
}

function hasNonBlankCanvasPixels(canvas: HTMLCanvasElement): boolean {
  if (!canvas.width || !canvas.height) return false;
  try {
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return false;
    const sampleWidth = Math.min(canvas.width, 80);
    const sampleHeight = Math.min(canvas.height, 60);
    const image = context.getImageData(0, 0, sampleWidth, sampleHeight).data;
    for (let index = 0; index < image.length; index += 4) {
      if (image[index] || image[index + 1] || image[index + 2]) return true;
    }
  } catch {
    return false;
  }
  return false;
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
  return Math.abs(screenRect.width - canvasRect.width) <= 3 && Math.abs(screenRect.height - canvasRect.height) <= 3;
}

function refreshNoVncViewport(options: { focus?: boolean } = {}) {
  shouldFocusAfterViewportRefresh = shouldFocusAfterViewportRefresh || options.focus !== false;
  if (viewportRefreshFrame != null) return;
  viewportRefreshFrame = window.requestAnimationFrame(() => {
    viewportRefreshFrame = null;
    const shouldFocus = shouldFocusAfterViewportRefresh;
    shouldFocusAfterViewportRefresh = false;
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
  });
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
  refreshNoVncViewport({ focus: options.focus !== false });
}

function handleConsoleDragEnter(event: DragEvent) {
  if (!event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault();
  uploadDragActive.value = true;
}

function handleConsoleDragOver(event: DragEvent) {
  if (!event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = uploadBusy.value ? "none" : "copy";
  uploadDragActive.value = true;
}

function handleConsoleDragLeave(event: DragEvent) {
  const currentTarget = event.currentTarget as HTMLElement | null;
  const relatedTarget = event.relatedTarget as Node | null;
  if (currentTarget && relatedTarget && currentTarget.contains(relatedTarget)) return;
  uploadDragActive.value = false;
}

function handleConsoleDrop(event: DragEvent) {
  event.preventDefault();
  uploadDragActive.value = false;
  if (uploadBusy.value) return;
  const files = Array.from(event.dataTransfer?.files ?? []).filter((file) => file.size >= 0);
  if (!files.length) return;
  void uploadConsoleFiles(files);
}

async function uploadConsoleFiles(files: File[]) {
  const target = props.target;
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
  if (!effectiveVisible.value || !rfb) return;
  const shortcut = resolveLocalConsoleShortcut(event);
  if (!shortcut) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  suppressLocalShortcutUntil = Date.now() + 1000;
  suppressedLocalShortcutKey = shortcut.key;
  releaseModifierKeys();
  if (shortcut.action === "paste") {
    requestNativePasteCapture();
  } else if (shortcut.action === "ctrl-c") {
    sendRemoteCtrlC();
  }
}

function handleConsoleCompositionEnd(event: CompositionEvent) {
  if (!effectiveVisible.value || !rfb) return;
  if (isEditableEventTarget(event.target)) return;
  const normalizedText = normalizeConsoleTextInput(event.data || "");
  if (!normalizedText) return;
  event.stopPropagation();
  event.stopImmediatePropagation();
  sendConsoleText(normalizedText);
}

function handleConsoleShortcutKeyup(event: KeyboardEvent) {
  if (!effectiveVisible.value || !rfb) return;
  if (Date.now() > suppressLocalShortcutUntil || event.key.toLowerCase() !== suppressedLocalShortcutKey) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  releaseModifierKeys();
  suppressedLocalShortcutKey = "";
}

function handleConsoleCopy(event: ClipboardEvent) {
  if (!effectiveVisible.value || !rfb) return;
  if (isEditableEventTarget(event.target)) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  suppressLocalShortcutUntil = Date.now() + 1000;
  suppressedLocalShortcutKey = "c";
  sendRemoteCtrlC();
}

function handleConsolePaste(event: ClipboardEvent) {
  if (!effectiveVisible.value || !rfb) return;
  const text = event.clipboardData?.getData("text/plain") ?? "";
  if (!text) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  void pasteTextToConsole(text);
}

function resolveLocalConsoleShortcut(event: KeyboardEvent): { action: "paste" | "ctrl-c" | "block"; key: string } | null {
  const key = event.key.toLowerCase();
  if (key === "escape" && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
    return { action: "block", key };
  }
  if (event.shiftKey || event.altKey) return null;
  const isLocalModifier = event.metaKey || event.ctrlKey;
  if (!isLocalModifier) return null;
  if (key === "v") return { action: "paste", key };
  if (key === "c") return { action: "ctrl-c", key };
  if (["x", "a"].includes(key)) return { action: "block", key };
  return null;
}

async function pasteTextToConsole(text: string) {
  const normalizedText = normalizeConsoleClipboardText(text);
  if (!normalizedText) return;
  consoleNoticeText.value = `正在发送 ${normalizedText.length} 个字符`;
  const sentCount = await sendConsoleText(normalizedText);
  if (!sentCount) return;
  consoleNoticeText.value = `已发送 ${sentCount} 个字符`;
  window.setTimeout(() => {
    if (consoleNoticeText.value === `已发送 ${sentCount} 个字符`) consoleNoticeText.value = "";
  }, 1400);
}

function sendConsoleText(text: string): Promise<number> {
  const token = consoleTextSendToken;
  consoleTextSendQueue = consoleTextSendQueue
    .catch(() => 0)
    .then(() => sendConsoleTextNow(text, token));
  return consoleTextSendQueue;
}

async function sendConsoleTextNow(text: string, token: number) {
  let sentCount = 0;
  releaseModifierKeys();
  focusConsole();
  await delay(CONSOLE_MODIFIER_RELEASE_DELAY_MS);
  for (const char of text) {
    if (!rfb || token !== consoleTextSendToken) break;
    if (sendTextCharacter(char)) {
      sentCount += 1;
      await delay(CONSOLE_TEXT_SEND_INTERVAL_MS);
    }
  }
  releaseModifierKeys();
  focusConsole();
  return sentCount;
}

function sendTextCharacter(char: string) {
  const special = specialKeyForCharacter(char);
  if (special) {
    tapRemoteKey(special.keysym, special.code);
    return true;
  }
  const keyStroke = keyStrokeForCharacter(char);
  if (keyStroke) {
    tapRemoteKey(keyStroke.keysym, keyStroke.code, keyStroke.shift);
    return true;
  }
  if (!isPrintableTextCharacter(char)) return;
  const codePoint = char.codePointAt(0);
  if (codePoint == null) return;
  const keysym = codePoint <= 0xff ? codePoint : 0x01000000 | codePoint;
  tapRemoteKey(keysym, undefined);
  return true;
}

function tapRemoteKey(keysym: number, code?: string, shift = false) {
  if (!rfb) return;
  if (shift) rfb.sendKey(0xffe1, "ShiftLeft", true);
  rfb.sendKey(keysym, code, true);
  rfb.sendKey(keysym, code, false);
  if (shift) rfb.sendKey(0xffe1, "ShiftLeft", false);
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

function normalizeConsoleTextInput(text: string) {
  let normalizedText = "";
  for (const char of text) {
    const mappedChar = CONSOLE_TEXT_NORMALIZATION_MAP[char];
    if (mappedChar) {
      normalizedText += mappedChar;
      continue;
    }
    const codePoint = char.codePointAt(0);
    if (codePoint == null) continue;
    if (codePoint >= 0xff01 && codePoint <= 0xff5e) {
      normalizedText += String.fromCharCode(codePoint - 0xfee0);
      continue;
    }
    if (codePoint >= 0x20 && codePoint <= 0x7e) {
      normalizedText += char;
    }
  }
  return normalizedText;
}

function normalizeConsoleClipboardText(text: string) {
  let normalizedText = "";
  for (const char of text.replace(/\r\n/g, "\n")) {
    if (char === "\n" || char === "\r" || char === "\t" || char === "\b" || char === "\u001b") {
      normalizedText += char === "\r" ? "\n" : char;
      continue;
    }
    normalizedText += normalizeConsoleTextInput(char);
  }
  return normalizedText;
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
    @closed="disconnectConsole"
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
            <span>{{ provisionStepStatusText(provisionTask?.status || "pending") }}</span>
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
            <em>{{ provisionVmProgressLabel(item) }}</em>
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

        <div class="console-action-grid">
          <el-dropdown trigger="click" placement="bottom-start" popper-class="console-command-menu" :disabled="!rfb" @command="handleConsoleCommand">
            <button class="console-action-icon active" :disabled="!rfb" aria-label="常用命令" title="常用命令">
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
          <el-tooltip content="重新连接控制台" placement="top" :show-after="120" :hide-after="0">
            <button class="console-action-icon" aria-label="重新连接控制台" title="重新连接控制台" @click.stop="connectConsole">
              <el-icon><Refresh /></el-icon>
            </button>
          </el-tooltip>
          <el-tooltip v-if="!embedded" content="放大控制台窗口" placement="top" :show-after="120" :hide-after="0">
            <button class="console-action-icon" aria-label="放大控制台窗口" title="放大控制台窗口" @click.stop="toggleExpandedConsole">
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
            <el-tooltip
              v-if="shouldShowMetricsToggle"
              :content="metricsOverlayVisible ? '隐藏资源监控' : '显示资源监控'"
              placement="top"
              :show-after="120"
              :hide-after="0"
            >
              <button
                class="console-tool-button"
                :class="{ active: metricsOverlayVisible }"
                :aria-label="metricsOverlayVisible ? '隐藏资源监控' : '显示资源监控'"
                :aria-pressed="metricsOverlayVisible"
                :title="metricsOverlayVisible ? '隐藏资源监控' : '显示资源监控'"
                @click.stop="toggleMetricsOverlay"
              >
                <el-icon><Monitor /></el-icon>
              </button>
            </el-tooltip>
            <el-tooltip content="复制控制台信息" placement="top" :show-after="120" :hide-after="0">
              <button class="console-tool-button" aria-label="复制控制台信息" title="复制控制台信息" @click.stop="copyConsoleInfo">
                <el-icon><CopyDocument /></el-icon>
              </button>
            </el-tooltip>
            <el-dropdown trigger="click" placement="bottom-end" popper-class="console-command-menu" :disabled="!rfb" @command="handleConsoleCommand">
              <button class="console-tool-button" :disabled="!rfb" aria-label="常用命令" title="常用命令">
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
            <el-tooltip content="重新连接控制台" placement="top" :show-after="120" :hide-after="0">
              <button class="console-tool-button" aria-label="重新连接控制台" title="重新连接控制台" @click.stop="connectConsole">
                <el-icon><Refresh /></el-icon>
              </button>
            </el-tooltip>
            <el-tooltip v-if="!embedded" :content="isExpanded ? '退出放大' : '放大控制台窗口'" placement="top" :show-after="120" :hide-after="0">
              <button
                class="console-tool-button"
                :aria-label="isExpanded ? '退出放大' : '放大控制台窗口'"
                :title="isExpanded ? '退出放大' : '放大控制台窗口'"
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
            ref="clipboardCaptureRef"
            class="console-clipboard-capture"
            aria-hidden="true"
            tabindex="-1"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            @paste.capture="handleClipboardCapturePaste"
          ></textarea>
          <div v-if="!consoleFrameReady" class="console-frame-pending console-terminal-overlay" :class="`platform-${consoleLoadingBrand.type}`">
              <div class="console-loading-card">
                <div class="console-loading-mark">
                  <div class="resource-loader-mark console-resource-loader-mark" aria-hidden="true">
                    <span class="resource-loader-ring"></span>
                    <strong>VRC</strong>
                  </div>
                </div>
              <strong>控制台加载中</strong>
              <span v-if="statusText !== '控制台连接中'" :title="statusText">{{ statusText }}</span>
            </div>
          </div>
          <div
            ref="screenRef"
            class="console-screen"
            tabindex="-1"
            lang="en"
            inputmode="text"
            autocapitalize="off"
            spellcheck="false"
          ></div>
        </section>

      </main>
    </section>
    <span v-if="!embedded" class="console-resize-handle" @mousedown="startResize"></span>
  </component>
</template>
