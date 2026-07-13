<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import RFB from "@novnc/novnc";
import { CopyDocument, FullScreen, Refresh } from "@element-plus/icons-vue";
import type { NoVncVmConsoleTarget } from "../domain/consoleStrategies";
import { getProviderBrand } from "../domain/providerBrand";

const props = defineProps<{
  visible: boolean;
  target: NoVncVmConsoleTarget | null;
}>();

const emit = defineEmits<{
  "update:visible": [value: boolean];
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
const consoleAspectRatio = ref(4 / 3);
const consoleFrameReady = ref(false);
const dialogSize = reactive({
  width: 0,
  height: 0,
});
const isResizing = ref(false);
const isExpanded = ref(false);
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

interface PreparedConsoleSession {
  wsPath: string;
  password?: string;
}

interface ConsoleUploadResponse {
  message?: string;
}

const consoleLoadingBrand = computed(() => {
  return getProviderBrand(props.target?.providerType);
});
const consoleSpecText = computed(() => {
  const parts = [props.target?.cpuText, props.target?.memoryText, props.target?.diskText].filter(Boolean);
  return parts.length ? parts.join(" / ") : "-";
});
watch(
  () => [props.visible, props.target?.wsUrl] as const,
  async ([visible]) => {
    if (!visible || !props.target) {
      disconnectConsole();
      disconnectScreenResizeObserver();
      return;
    }
    const cachedAspectRatio = getCachedConsoleAspectRatio(props.target);
    consoleAspectRatio.value = cachedAspectRatio || props.target.aspectRatio || 4 / 3;
    consoleLoadingStartedAt = Date.now();
    consoleFrameReady.value = false;
    isExpanded.value = false;
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
  window.removeEventListener("keydown", handleConsolePrintableKeydown, true);
  window.removeEventListener("keyup", handleConsoleShortcutKeyup, true);
  window.removeEventListener("compositionend", handleConsoleCompositionEnd, true);
  window.removeEventListener("mousemove", handleResizeMove);
  window.removeEventListener("mouseup", stopResize);
  window.removeEventListener("pointermove", handleDialogDragMove);
  window.removeEventListener("pointerup", stopDialogDrag);
  window.removeEventListener("pointercancel", stopDialogDrag);
  if (viewportRefreshFrame != null) window.cancelAnimationFrame(viewportRefreshFrame);
  clearNativePasteFallbackTimer();
  disconnectConsole();
  disconnectScreenResizeObserver();
});

onMounted(() => {
  window.addEventListener("keydown", handleConsoleShortcut, true);
  window.addEventListener("keydown", handleConsolePrintableKeydown, true);
  window.addEventListener("keyup", handleConsoleShortcutKeyup, true);
  window.addEventListener("compositionend", handleConsoleCompositionEnd, true);
  connectScreenResizeObserver();
});

async function connectConsole() {
  disconnectConsole();
  const screen = screenRef.value;
  const target = props.target;
  if (!screen || !target) return;
  screen.replaceChildren();
  connected.value = false;
  statusText.value = "控制台连接中";

  let prepared: { wsUrl: string; password?: string };
  try {
    prepared = await prepareConsoleTarget(target);
  } catch (error) {
    statusText.value = error instanceof Error ? error.message : "控制台会话准备失败";
    return;
  }
  if (!prepared.wsUrl) {
    statusText.value = "控制台地址无效";
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
    connected.value = true;
    statusText.value = "已连接";
    focusConsole();
    scheduleConsoleWakeEnter();
    window.setTimeout(() => syncConsoleAspectRatio({ reveal: true }), 120);
    refreshNoVncViewport();
  });
  rfb.addEventListener("disconnect", () => {
    connected.value = false;
    consoleFrameReady.value = false;
    statusText.value = "连接已断开";
  });
  rfb.addEventListener("securityfailure", () => {
    connected.value = false;
    statusText.value = "认证失败或控制台被拒绝";
  });
  rfb.addEventListener("credentialsrequired", () => {
    connected.value = false;
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
  consoleTextSendToken += 1;
  if (!rfb) return;
  rfb.disconnect();
  rfb = null;
}

function sendCtrlAltDelete() {
  rfb?.sendCtrlAltDel();
  focusConsole();
}

function sendRemoteCtrlC() {
  if (!rfb) return;
  focusConsole();
  rfb.sendKey(0xffe3, "ControlLeft", true);
  rfb.sendKey("c".charCodeAt(0), "KeyC", true);
  rfb.sendKey("c".charCodeAt(0), "KeyC", false);
  rfb.sendKey(0xffe3, "ControlLeft", false);
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
    if (!props.visible || !connected.value || !rfb) return;
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
    setDialogSizeForConsoleFit({ expanded: true });
  }
  requestConsoleResize({ focus: true });
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
      void pasteFromClipboard();
    }
  }, 160);
}

function handleClipboardCapturePaste(event: ClipboardEvent) {
  if (!props.visible || !rfb) return;
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
    if (options.reveal && (options.attempt ?? 0) < 24) {
      window.setTimeout(() => syncConsoleAspectRatio({ ...options, attempt: (options.attempt ?? 0) + 1 }), 120);
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
    nextTick(() => {
      refreshNoVncViewport();
      window.requestAnimationFrame(() => {
        refreshNoVncViewport();
        if (!isConsoleCanvasFitted() && (options.attempt ?? 0) < 24) {
          window.setTimeout(() => syncConsoleAspectRatio({ ...options, attempt: (options.attempt ?? 0) + 1 }), 120);
          return;
        }
        revealConsoleFrame();
      });
    });
  }
}

function revealConsoleFrame() {
  consoleFrameReady.value = true;
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
  showUploadStatus(`正在上传 ${files.length} 个文件`, "info");
  const formData = new FormData();
  formData.append("connectionId", target.connectionId);
  formData.append("vmId", target.vmId);
  formData.append("providerType", target.providerType);
  formData.append("vmName", target.vmName);
  formData.append("vmIp", target.vmIp || "");
  for (const file of files) {
    formData.append("files", file, file.name);
  }
  try {
    const response = await fetch("/api/console/upload", {
      method: "POST",
      body: formData,
    });
    const result = await readUploadResponse(response);
    if (!response.ok) {
      throw new Error(result.message || (response.status === 404 ? "服务端未接入控制台上传" : "文件上传失败"));
    }
    showUploadStatus(result.message || `已上传 ${files.length} 个文件`, "success");
  } catch (error) {
    showUploadStatus(error instanceof Error ? error.message : "文件上传失败", "error");
  } finally {
    uploadBusy.value = false;
  }
}

async function readUploadResponse(response: Response): Promise<ConsoleUploadResponse> {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) return {};
  try {
    return (await response.json()) as ConsoleUploadResponse;
  } catch {
    return {};
  }
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
  if (!props.visible || !rfb) return;
  const shortcut = resolveLocalConsoleShortcut(event);
  if (!shortcut) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  suppressLocalShortcutUntil = Date.now() + 1000;
  suppressedLocalShortcutKey = shortcut.key;
  releaseModifierKeys();
  if (shortcut.action === "copy") {
    void copyConsoleInfo();
  } else if (shortcut.action === "paste") {
    requestNativePasteCapture();
  } else if (shortcut.action === "ctrl-c") {
    sendRemoteCtrlC();
  }
}

function handleConsolePrintableKeydown(event: KeyboardEvent) {
  if (!props.visible || !rfb) return;
  if (event.defaultPrevented || event.isComposing) return;
  if (isEditableEventTarget(event.target)) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key.length !== 1) return;
  const normalizedText = normalizeConsoleTextInput(event.key);
  if (!normalizedText) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  sendConsoleText(normalizedText);
}

function handleConsoleCompositionEnd(event: CompositionEvent) {
  if (!props.visible || !rfb) return;
  if (isEditableEventTarget(event.target)) return;
  const normalizedText = normalizeConsoleTextInput(event.data || "");
  if (!normalizedText) return;
  event.stopPropagation();
  event.stopImmediatePropagation();
  sendConsoleText(normalizedText);
}

function handleConsoleShortcutKeyup(event: KeyboardEvent) {
  if (!props.visible || !rfb) return;
  if (Date.now() > suppressLocalShortcutUntil || event.key.toLowerCase() !== suppressedLocalShortcutKey) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  releaseModifierKeys();
  suppressedLocalShortcutKey = "";
}

function handleConsolePaste(event: ClipboardEvent) {
  if (!props.visible || !rfb) return;
  const text = event.clipboardData?.getData("text/plain") ?? "";
  if (!text) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  void pasteTextToConsole(text);
}

function resolveLocalConsoleShortcut(event: KeyboardEvent): { action: "copy" | "paste" | "ctrl-c" | "block"; key: string } | null {
  const key = event.key.toLowerCase();
  if (key === "escape" && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
    return { action: "block", key };
  }
  if (event.shiftKey || event.altKey) return null;
  const isLocalModifier = event.metaKey || event.ctrlKey;
  if (!isLocalModifier) return null;
  if (key === "v") return { action: "paste", key };
  if (key === "c" && event.ctrlKey && !event.metaKey) return { action: "ctrl-c", key };
  if (key === "c" && event.metaKey) return { action: "copy", key };
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
  return !!element.closest("input, textarea, select, button, a[href], [role='button'], [contenteditable='true']");
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
</script>

<template>
  <el-dialog
    ref="dialogRef"
    :class="['console-dialog', 'is-medium-terminal', { 'is-console-resizing': isResizing, 'is-console-expanded': isExpanded }]"
    :model-value="visible"
    title="控制台"
    :width="`${dialogSize.width}px`"
    :style="{ height: `${dialogSize.height}px` }"
    top="4vh"
    draggable
    :close-on-click-modal="false"
    destroy-on-close
    append-to-body
    @update:model-value="emit('update:visible', $event)"
    @closed="disconnectConsole"
  >
    <section class="console-layout">
      <aside class="console-side" aria-label="控制台信息">
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
            <button class="console-action-icon active" :disabled="!rfb">
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
            <button class="console-action-icon" @click.stop="connectConsole">
              <el-icon><Refresh /></el-icon>
            </button>
          </el-tooltip>
          <el-tooltip content="放大控制台窗口" placement="top" :show-after="120" :hide-after="0">
            <button class="console-action-icon" @click.stop="toggleExpandedConsole">
              <el-icon><FullScreen /></el-icon>
            </button>
          </el-tooltip>
        </div>

        <div class="console-note-card">
          <div>
            <strong>键盘口径</strong>
            <span>Esc 本地拦截</span>
          </div>
          <p>单 Esc 不写入终端，Shift + Esc 透传到远端。</p>
        </div>

        <div class="console-note-card">
          <div>
            <strong>性能口径</strong>
            <span>拖拽中节流</span>
          </div>
          <p>拖拽只更新外框，松手后刷新终端尺寸。</p>
        </div>
      </aside>

      <main class="console-window">
        <div class="console-titlebar" @pointerdown="startDialogDrag">
          <div class="console-titlebar-main">
            <strong>{{ target?.vmName || "虚拟机" }}</strong>
            <span>{{ target?.vmIp || "-" }}</span>
            <span class="console-titlebar-status" :class="{ connected }">{{ statusText }}</span>
          </div>
          <div class="console-tools" @pointerdown.stop>
            <span v-if="consoleNoticeText" class="console-paste-status">{{ consoleNoticeText }}</span>
            <el-tooltip content="复制控制台信息" placement="top" :show-after="120" :hide-after="0">
              <button class="console-tool-button" @click.stop="copyConsoleInfo">
                <el-icon><CopyDocument /></el-icon>
              </button>
            </el-tooltip>
            <el-dropdown trigger="click" placement="bottom-end" popper-class="console-command-menu" :disabled="!rfb" @command="handleConsoleCommand">
              <button class="console-tool-button" :disabled="!rfb" title="常用命令">
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
              <button class="console-tool-button" @click.stop="connectConsole">
                <el-icon><Refresh /></el-icon>
              </button>
            </el-tooltip>
            <el-tooltip :content="isExpanded ? '退出放大' : '放大控制台窗口'" placement="top" :show-after="120" :hide-after="0">
              <button class="console-tool-button" @click.stop="toggleExpandedConsole">
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
              <span class="console-logo-loader" aria-hidden="true">
                <svg class="vrc-system-logo" viewBox="0 0 64 48">
                  <rect class="vrc-logo-tile" x="5" y="5" width="54" height="38" rx="10" />
                  <text class="vrc-logo-letter" x="32" y="29" text-anchor="middle">VRC</text>
                  <rect class="vrc-logo-cursor" x="38" y="34" width="11" height="2.5" rx="1.25" />
                </svg>
              </span>
              <strong>控制台加载中</strong>
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
            @keydown.capture="handleConsolePrintableKeydown"
          ></div>
        </section>

      </main>
    </section>
    <span class="console-resize-handle" @mousedown="startResize"></span>
  </el-dialog>
</template>
