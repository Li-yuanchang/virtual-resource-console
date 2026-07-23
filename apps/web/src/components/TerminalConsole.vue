<script lang="ts">
import type { ComponentPublicInstance } from "vue";

export type TerminalConnectionStatus = "idle" | "authenticating" | "connecting" | "connected" | "disconnected" | "error";

/**
 * Describes an already-authorized terminal session. The renderer never uses
 * the endpoint or metadata to create a transport; the owning runtime does so.
 */
export interface TerminalSessionDescriptor {
  sessionId: string;
  transport: "websocket" | "serial" | "ssh-pty";
  label?: string;
  endpoint?: string;
  expiresAt?: string;
}

export interface TerminalInputEvent {
  sessionId: string | null;
  data: string;
}

export interface TerminalResizeEvent {
  sessionId: string | null;
  cols: number;
  rows: number;
}

export interface TerminalReadyEvent {
  sessionId: string | null;
  cols: number;
  rows: number;
}

export interface TerminalConsoleExposed {
  write(data: string): void;
  clear(): void;
  fit(): void;
  focus(): void;
}

export type TerminalConsoleInstance = ComponentPublicInstance<{}, TerminalConsoleExposed>;
</script>

<script setup lang="ts">
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { ITheme } from "@xterm/xterm";

const props = withDefaults(
  defineProps<{
    session?: TerminalSessionDescriptor | null;
    status?: TerminalConnectionStatus;
    errorMessage?: string;
    initialData?: string;
    fontFamily?: string;
    fontSize?: number;
    lineHeight?: number;
    cursorStyle?: "block" | "underline" | "bar";
    cursorBlink?: boolean;
    theme?: ITheme;
    readOnly?: boolean;
    ariaLabel?: string;
  }>(),
  {
    session: null,
    status: "idle",
    errorMessage: "",
    initialData: "",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontSize: 13,
    lineHeight: 1.2,
    cursorStyle: "block",
    cursorBlink: true,
    theme: () => ({
      background: "#050505",
      foreground: "#d6dde7",
      cursor: "#d6dde7",
      selectionBackground: "#426b5766",
      selectionInactiveBackground: "#426b573d",
    }),
    readOnly: false,
    ariaLabel: "Linux CLI 终端",
  },
);

const emit = defineEmits<{
  input: [event: TerminalInputEvent];
  resize: [event: TerminalResizeEvent];
  ready: [event: TerminalReadyEvent];
  disposed: [];
  error: [error: Error];
}>();

const terminalHost = ref<HTMLDivElement | null>(null);
const terminalState = ref<TerminalConnectionStatus>(props.status);
const terminalError = ref("");
let terminal: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let resizeObserver: ResizeObserver | null = null;
let removeDataListener: (() => void) | null = null;
let removeResizeListener: (() => void) | null = null;
let lastSize = { cols: 0, rows: 0 };

watch(
  () => props.status,
  (status) => {
    terminalState.value = status;
    if (status !== "error") terminalError.value = "";
  },
);

watch(
  () => [props.fontFamily, props.fontSize, props.lineHeight, props.cursorStyle, props.cursorBlink, props.readOnly] as const,
  ([fontFamily, fontSize, lineHeight, cursorStyle, cursorBlink, readOnly]) => {
    if (!terminal) return;
    terminal.options.fontFamily = fontFamily;
    terminal.options.fontSize = fontSize;
    terminal.options.lineHeight = lineHeight;
    terminal.options.cursorStyle = cursorStyle;
    terminal.options.cursorInactiveStyle = cursorStyle;
    terminal.options.cursorBlink = cursorBlink;
    terminal.options.disableStdin = readOnly;
    fitTerminal();
  },
);

watch(
  () => props.theme,
  (theme) => {
    if (terminal) terminal.options.theme = theme;
  },
  { deep: true },
);

watch(
  () => props.session?.sessionId,
  () => {
    terminal?.clear();
    lastSize = { cols: 0, rows: 0 };
    void nextTick(fitTerminal);
  },
);

onMounted(() => {
  terminal = new Terminal({
    allowProposedApi: false,
    convertEol: true,
    cursorBlink: props.cursorBlink,
    cursorStyle: props.cursorStyle,
    cursorWidth: 1,
    cursorInactiveStyle: props.cursorStyle,
    disableStdin: props.readOnly,
    fontFamily: props.fontFamily,
    fontSize: props.fontSize,
    letterSpacing: 0,
    lineHeight: props.lineHeight,
    scrollback: 3000,
    theme: props.theme,
  });
  fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(terminalHost.value as HTMLDivElement);

  removeDataListener = terminal.onData((data) => {
    emit("input", { sessionId: props.session?.sessionId ?? null, data });
  }).dispose;
  removeResizeListener = terminal.onResize(({ cols, rows }) => {
    emitResize(cols, rows);
  }).dispose;
  resizeObserver = new ResizeObserver(fitTerminal);
  if (terminalHost.value) resizeObserver.observe(terminalHost.value);

  if (props.initialData) terminal.write(props.initialData);
  fitTerminal();
  terminalState.value = props.status;
  emit("ready", {
    sessionId: props.session?.sessionId ?? null,
    cols: terminal.cols,
    rows: terminal.rows,
  });
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
  removeDataListener?.();
  removeResizeListener?.();
  removeDataListener = null;
  removeResizeListener = null;
  terminal?.dispose();
  terminal = null;
  fitAddon = null;
  emit("disposed");
});

function fitTerminal() {
  if (!terminal || !fitAddon || !terminalHost.value || terminalHost.value.clientWidth === 0 || terminalHost.value.clientHeight === 0) return;
  try {
    fitAddon.fit();
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    terminalError.value = normalized.message;
    terminalState.value = "error";
    emit("error", normalized);
  }
}

function emitResize(cols: number, rows: number) {
  if (lastSize.cols === cols && lastSize.rows === rows) return;
  lastSize = { cols, rows };
  emit("resize", { sessionId: props.session?.sessionId ?? null, cols, rows });
}

function write(data: string) {
  terminal?.write(data);
}

function clear() {
  terminal?.reset();
}

function focus() {
  terminal?.focus();
}

defineExpose({ write, clear, fit: fitTerminal, focus });
</script>

<template>
  <section
    class="terminal-console"
    :class="`is-${terminalState}`"
    :style="{ '--terminal-font-size': `${fontSize}px`, '--terminal-line-height': String(lineHeight) }"
    :aria-label="ariaLabel"
  >
    <div ref="terminalHost" class="terminal-console__screen"></div>
    <p v-if="terminalState === 'error'" class="terminal-console__message" role="alert">
      {{ errorMessage || terminalError || "终端暂时不可用" }}
    </p>
    <p v-else-if="terminalState === 'disconnected'" class="terminal-console__message">
      终端连接已断开
    </p>
  </section>
</template>

<style scoped>
.terminal-console {
  position: relative;
  min-width: 0;
  min-height: 120px;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: var(--vrc-terminal-bg, #050505);
  color: var(--vrc-terminal-text, #d6dde7);
  font-size: var(--terminal-font-size, 13px);
  line-height: var(--terminal-line-height, 1.2);
  font-synthesis: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
}

.terminal-console__screen {
  width: 100%;
  height: 100%;
  min-height: inherit;
  padding: 15px;
  box-sizing: border-box;
}

.terminal-console__screen :deep(.xterm) {
  width: 100%;
  height: 100%;
  color: var(--vrc-terminal-text, #d6dde7);
  font-size: var(--terminal-font-size, 13px);
  font-variant-ligatures: none;
}

.terminal-console__screen :deep(.xterm-rows) {
  line-height: var(--terminal-line-height, 1.2);
}

.terminal-console__screen :deep(.xterm-viewport) {
  background: transparent !important;
  scrollbar-color: color-mix(in srgb, var(--vrc-terminal-text, #d6dde7) 28%, transparent) transparent;
}

.terminal-console__screen :deep(.xterm-screen) {
  background: transparent;
}

.terminal-console__screen :deep(.xterm-rows .xterm-cursor.xterm-cursor-bar) {
  position: relative;
  box-shadow: none !important;
}

.terminal-console__screen :deep(.xterm-rows .xterm-cursor.xterm-cursor-bar::after) {
  position: absolute;
  top: 50%;
  left: 0;
  width: 1px;
  height: 1em;
  background: currentColor;
  content: "";
  transform: translateY(-50%);
}

.terminal-console__screen :deep(.xterm-rows .xterm-cursor.xterm-cursor-bar.xterm-cursor-blink) {
  opacity: 1 !important;
  animation: none !important;
}

.terminal-console__screen :deep(.xterm-rows .xterm-cursor.xterm-cursor-bar.xterm-cursor-blink::after) {
  animation: vrc-terminal-cursor-blink 1s steps(1, end) infinite;
}

@keyframes vrc-terminal-cursor-blink {
  0%, 49% { opacity: 1; }
  50%, 100% { opacity: 0; }
}

.terminal-console__message {
  position: absolute;
  inset: 50% 16px auto;
  margin: 0;
  transform: translateY(-50%);
  color: var(--vrc-terminal-text-muted, #9ca6b5);
  text-align: center;
  pointer-events: none;
}

.terminal-console.is-error .terminal-console__message {
  color: var(--vrc-danger, #a5483d);
}
</style>
