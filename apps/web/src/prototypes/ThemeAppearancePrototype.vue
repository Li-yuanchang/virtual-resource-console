<script setup lang="ts">
import {
  ArrowLeft,
  Brush,
  Connection,
  Plus,
  Search,
  Setting,
  Tickets,
} from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import VrcLogoMark from "../components/VrcLogoMark.vue";

type ThemeName =
  | "graphite-sage"
  | "basalt-copper"
  | "mist-teal"
  | "prism-frost"
  | "aurora-mint"
  | "neon-carbon"
  | "primer-azure"
  | "radix-iris"
  | "carbon-graphite"
  | "flexoki-ink"
  | "rose-pine-moon"
  | "ayu-mirage"
  | "mech-forge"
  | "punk-neon"
  | "retro-film"
  | "modern-minimal"
  | "sci-fi-orbit"
  | "cyber-terminal";
type ToneMode = "system" | "light" | "dark";
type BackgroundMode = "default" | "color" | "image";
type WallpaperTarget = "light" | "dark";
type UiFontFamily = "system" | "inter" | "noto-sans-sc" | "lxgw-wenkai" | "compact";
type ConsoleFontFamily = "system-mono" | "jetbrains" | "cascadia" | "menlo";
type ConsoleMode = "graphical" | "cli";
type ConsolePalette = "vrc" | "tokyo-night" | "catppuccin" | "dracula" | "nord" | "rose-pine" | "solarized" | "light";
type ConsoleCursor = "block" | "bar" | "underline";
type WatermarkScope = "console" | "workspace";
type WatermarkDensity = "sparse" | "standard" | "dense";

interface ThemeOption {
  value: ThemeName;
  name: string;
  tone: string;
  description: string;
  colors: string[];
  accent: string;
  success: string;
  warning: string;
  danger: string;
  mode: "light" | "dark";
  canvas: string;
  darkCanvas: string;
  variables: ThemeVariables;
  darkVariables?: ThemeVariables;
}

interface ThemeVariables {
  bg: string;
  surface: string;
  surfaceMuted: string;
  surfaceRaised: string;
  border: string;
  borderStrong: string;
  text: string;
  textMuted: string;
  textSubtle: string;
  tooltip: string;
}

interface ConsolePaletteOption {
  value: ConsolePalette;
  name: string;
  source: string;
  background: string;
  foreground: string;
  muted: string;
  accent: string;
  success: string;
  colors: string[];
}

interface GradientPreset {
  value: string;
  name: string;
  angle: number;
  stops: string[];
}

interface BuiltinWallpaper {
  value: string;
  name: string;
  src: string;
  mood: "light" | "dark";
}

interface UiFontOption {
  value: UiFontFamily;
  name: string;
  family: string;
  badge: "内置" | "本机";
  note: string;
}

const themeOptions: ThemeOption[] = [
  {
    value: "graphite-sage",
    name: "石墨青",
    tone: "当前默认",
    description: "低饱和灰绿，适合长时间查看资源和状态。",
    colors: ["#f5f6f2", "#fbfbf7", "#426b57", "#27302a"],
    accent: "#426b57",
    success: "#477a45",
    warning: "#b77935",
    danger: "#a5483d",
    mode: "light",
    canvas: "linear-gradient(135deg, #f4f6f1 0%, #eef3ec 52%, #f7f4ef 100%)",
    darkCanvas: "linear-gradient(135deg, #171a19 0%, #1c211e 52%, #191c1a 100%)",
    variables: { bg: "#f5f6f2", surface: "#fbfbf7", surfaceMuted: "#eef1e8", surfaceRaised: "#f8f9f3", border: "#d9ded0", borderStrong: "#b8c2ae", text: "#27302a", textMuted: "#747b70", textSubtle: "#92988d", tooltip: "#223329" },
  },
  {
    value: "basalt-copper",
    name: "玄武铜",
    tone: "暖色",
    description: "暖灰底配铜色强调，层级清楚但不刺眼。",
    colors: ["#f4f2ed", "#fcfaf5", "#9b5f35", "#2f2b24"],
    accent: "#9b5f35",
    success: "#4f7549",
    warning: "#b77935",
    danger: "#a34f42",
    mode: "light",
    canvas: "linear-gradient(135deg, #f5f2ec 0%, #eee9df 55%, #f7f3ed 100%)",
    darkCanvas: "linear-gradient(135deg, #1c1a17 0%, #242019 55%, #1c1b19 100%)",
    variables: { bg: "#f4f2ed", surface: "#fcfaf5", surfaceMuted: "#ebe7dd", surfaceRaised: "#f8f3eb", border: "#d7d0c3", borderStrong: "#bdaf9c", text: "#2f2b24", textMuted: "#766f63", textSubtle: "#968d7e", tooltip: "#342c23" },
  },
  {
    value: "mist-teal",
    name: "雾青",
    tone: "清爽",
    description: "偏冷的青灰色，适合信息密度较高的列表。",
    colors: ["#f3f6f4", "#fbfcfa", "#2f6f68", "#22302d"],
    accent: "#2f6f68",
    success: "#4d7a50",
    warning: "#ad7833",
    danger: "#a3483f",
    mode: "light",
    canvas: "linear-gradient(135deg, #f2f7f5 0%, #eaf2ef 50%, #f5f7f3 100%)",
    darkCanvas: "linear-gradient(135deg, #161c1b 0%, #192321 50%, #181d1b 100%)",
    variables: { bg: "#f3f6f4", surface: "#fbfcfa", surfaceMuted: "#e9efeb", surfaceRaised: "#f6faf7", border: "#d2dbd5", borderStrong: "#aec1b7", text: "#22302d", textMuted: "#6f7b77", textSubtle: "#8d9995", tooltip: "#213633" },
  },
  {
    value: "prism-frost",
    name: "冰川光谱",
    tone: "现代渐变",
    description: "冷白底融合蓝、青与柔紫，适合现代化资源工作台。",
    colors: ["#eff5fb", "#78a7d2", "#69aa9f", "#9b88bd"],
    accent: "#527fa8",
    success: "#46856e",
    warning: "#b17a35",
    danger: "#ad5260",
    mode: "light",
    canvas: "linear-gradient(135deg, #edf5fb 0%, #edf7f3 46%, #f3eef8 100%)",
    darkCanvas: "linear-gradient(135deg, #171d26 0%, #152421 48%, #211b2b 100%)",
    variables: { bg: "#edf2f6", surface: "#fbfcfe", surfaceMuted: "#edf2f7", surfaceRaised: "#f7f9fc", border: "#d3dce5", borderStrong: "#aabac9", text: "#263441", textMuted: "#687886", textSubtle: "#8d9aa5", tooltip: "#263846" },
  },
  {
    value: "aurora-mint",
    name: "极光薄荷",
    tone: "清透渐变",
    description: "薄荷青、湖蓝与珊瑚色过渡，明亮但保留业务层级。",
    colors: ["#eef8f4", "#56a89b", "#6599be", "#d78378"],
    accent: "#397d78",
    success: "#4b8668",
    warning: "#b77734",
    danger: "#b25355",
    mode: "light",
    canvas: "linear-gradient(130deg, #eaf7f2 0%, #edf5fa 52%, #faefed 100%)",
    darkCanvas: "linear-gradient(130deg, #13221f 0%, #16232d 52%, #2a1c1e 100%)",
    variables: { bg: "#edf5f2", surface: "#fbfdfc", surfaceMuted: "#e8f1ee", surfaceRaised: "#f6faf8", border: "#cfded8", borderStrong: "#a8c0b7", text: "#263734", textMuted: "#687b76", textSubtle: "#8b9b96", tooltip: "#213a35" },
  },
  {
    value: "neon-carbon",
    name: "霓虹夜幕",
    tone: "深色渐变",
    description: "碳黑界面配青蓝与洋红光谱，适合低光环境。",
    colors: ["#171b24", "#4fc3b3", "#5c8ee6", "#c46aa5"],
    accent: "#5d9fe3",
    success: "#64bd91",
    warning: "#d49a51",
    danger: "#d36c7b",
    mode: "dark",
    canvas: "linear-gradient(135deg, #edf4f8 0%, #edf6f2 46%, #f7eef5 100%)",
    darkCanvas: "linear-gradient(135deg, #151b24 0%, #142521 48%, #281b29 100%)",
    variables: { bg: "#eef2f5", surface: "#fbfcfd", surfaceMuted: "#e9eef2", surfaceRaised: "#f6f8fa", border: "#d1d9e0", borderStrong: "#aab7c2", text: "#26323c", textMuted: "#697783", textSubtle: "#8b98a3", tooltip: "#253440" },
    darkVariables: { bg: "#11151c", surface: "#1a2029", surfaceMuted: "#242c37", surfaceRaised: "#202833", border: "#343e4c", borderStrong: "#526174", text: "#e7edf5", textMuted: "#a3afbf", textSubtle: "#788697", tooltip: "#0b0e13" },
  },
  {
    value: "primer-azure",
    name: "Primer Azure",
    tone: "GitHub 设计系统",
    description: "清晰的蓝色操作层级，表格和资源状态辨识度高。",
    colors: ["#f6f8fa", "#ffffff", "#0969da", "#1f2328"],
    accent: "#0969da",
    success: "#1a7f37",
    warning: "#9a6700",
    danger: "#cf222e",
    mode: "light",
    canvas: "linear-gradient(135deg, #f6f8fa 0%, #eef5fc 54%, #f8fafc 100%)",
    darkCanvas: "linear-gradient(135deg, #0d1117 0%, #111b29 54%, #0d1117 100%)",
    variables: { bg: "#f6f8fa", surface: "#ffffff", surfaceMuted: "#eef1f4", surfaceRaised: "#f8fafc", border: "#d0d7de", borderStrong: "#afb8c1", text: "#1f2328", textMuted: "#636c76", textSubtle: "#818b98", tooltip: "#24292f" },
    darkVariables: { bg: "#0d1117", surface: "#161b22", surfaceMuted: "#21262d", surfaceRaised: "#1c2128", border: "#30363d", borderStrong: "#484f58", text: "#e6edf3", textMuted: "#8b949e", textSubtle: "#6e7681", tooltip: "#010409" },
  },
  {
    value: "radix-iris",
    name: "Radix Iris",
    tone: "无障碍色阶",
    description: "中性灰配鸢尾紫，控件状态柔和且对比稳定。",
    colors: ["#f9f9fb", "#ffffff", "#5b5bd6", "#1c2024"],
    accent: "#5b5bd6",
    success: "#2a7e68",
    warning: "#c25d0b",
    danger: "#d1343c",
    mode: "light",
    canvas: "linear-gradient(135deg, #f9f9fb 0%, #f1f0fb 52%, #f8f8fa 100%)",
    darkCanvas: "linear-gradient(135deg, #111113 0%, #1d1b2f 52%, #141416 100%)",
    variables: { bg: "#f9f9fb", surface: "#ffffff", surfaceMuted: "#f0f0f3", surfaceRaised: "#f8f8fa", border: "#d9d9e0", borderStrong: "#b9bbc6", text: "#1c2024", textMuted: "#60646c", textSubtle: "#8b8d98", tooltip: "#2b2b31" },
    darkVariables: { bg: "#111113", surface: "#18191b", surfaceMuted: "#212225", surfaceRaised: "#1d1e21", border: "#3a3a40", borderStrong: "#56565f", text: "#edeef0", textMuted: "#b9bbc6", textSubtle: "#777b84", tooltip: "#0b0b0d" },
  },
  {
    value: "carbon-graphite",
    name: "Carbon Graphite",
    tone: "企业级",
    description: "IBM Carbon 灰阶与高辨识蓝，克制、规整、偏专业工具。",
    colors: ["#f4f4f4", "#ffffff", "#0f62fe", "#161616"],
    accent: "#0f62fe",
    success: "#198038",
    warning: "#b28600",
    danger: "#da1e28",
    mode: "light",
    canvas: "linear-gradient(135deg, #f4f4f4 0%, #edf2fa 52%, #f7f7f7 100%)",
    darkCanvas: "linear-gradient(135deg, #161616 0%, #1d2738 52%, #181818 100%)",
    variables: { bg: "#f4f4f4", surface: "#ffffff", surfaceMuted: "#e8e8e8", surfaceRaised: "#f8f8f8", border: "#c6c6c6", borderStrong: "#8d8d8d", text: "#161616", textMuted: "#525252", textSubtle: "#6f6f6f", tooltip: "#262626" },
    darkVariables: { bg: "#161616", surface: "#262626", surfaceMuted: "#393939", surfaceRaised: "#303030", border: "#525252", borderStrong: "#6f6f6f", text: "#f4f4f4", textMuted: "#c6c6c6", textSubtle: "#8d8d8d", tooltip: "#0f0f0f" },
  },
  {
    value: "flexoki-ink",
    name: "Flexoki Ink",
    tone: "墨黑",
    description: "纸墨感暖黑底与青色强调，低光环境下层次自然。",
    colors: ["#100f0f", "#1c1b1a", "#3aa99f", "#cecdc3"],
    accent: "#3aa99f",
    success: "#879a39",
    warning: "#d0a215",
    danger: "#d14d41",
    mode: "dark",
    canvas: "linear-gradient(135deg, #f2f0e5 0%, #e8f0eb 52%, #f2eee8 100%)",
    darkCanvas: "linear-gradient(135deg, #100f0f 0%, #17211f 52%, #171513 100%)",
    variables: { bg: "#f2f0e5", surface: "#fffcf0", surfaceMuted: "#e6e4d9", surfaceRaised: "#f7f4e8", border: "#cecdc3", borderStrong: "#b7b5ac", text: "#282726", textMuted: "#6f6e69", textSubtle: "#878580", tooltip: "#282726" },
    darkVariables: { bg: "#100f0f", surface: "#1c1b1a", surfaceMuted: "#282726", surfaceRaised: "#242321", border: "#403e3c", borderStrong: "#575653", text: "#cecdc3", textMuted: "#878580", textSubtle: "#6f6e69", tooltip: "#080808" },
  },
  {
    value: "rose-pine-moon",
    name: "Rose Pine Moon",
    tone: "柔和深色",
    description: "带灰度的月夜紫与浅青高光，深色但不过度沉闷。",
    colors: ["#191724", "#1f1d2e", "#9ccfd8", "#e0def4"],
    accent: "#9ccfd8",
    success: "#8fb9a8",
    warning: "#f6c177",
    danger: "#eb6f92",
    mode: "dark",
    canvas: "linear-gradient(135deg, #f7f3fa 0%, #edf7f8 52%, #faf2f5 100%)",
    darkCanvas: "linear-gradient(135deg, #191724 0%, #1d2934 50%, #292033 100%)",
    variables: { bg: "#f7f3fa", surface: "#fffafd", surfaceMuted: "#eee8f1", surfaceRaised: "#faf7fb", border: "#d8cfdf", borderStrong: "#b9abc5", text: "#312d3d", textMuted: "#6e687b", textSubtle: "#918a9e", tooltip: "#312d3d" },
    darkVariables: { bg: "#191724", surface: "#1f1d2e", surfaceMuted: "#26233a", surfaceRaised: "#242135", border: "#403d52", borderStrong: "#59546d", text: "#e0def4", textMuted: "#908caa", textSubtle: "#6e6a86", tooltip: "#0f0e16" },
  },
  {
    value: "ayu-mirage",
    name: "Ayu Mirage",
    tone: "深灰蓝",
    description: "冷静的深灰蓝背景配天蓝高光，信息密度高但不刺眼。",
    colors: ["#1f2430", "#232834", "#73d0ff", "#cccac2"],
    accent: "#73d0ff",
    success: "#bae67e",
    warning: "#ffd580",
    danger: "#f28779",
    mode: "dark",
    canvas: "linear-gradient(135deg, #f1f4f8 0%, #eaf5fa 52%, #f7f4ed 100%)",
    darkCanvas: "linear-gradient(135deg, #1f2430 0%, #202d3a 52%, #292832 100%)",
    variables: { bg: "#f1f4f8", surface: "#fbfcfe", surfaceMuted: "#e7ebf0", surfaceRaised: "#f7f9fc", border: "#ccd3dc", borderStrong: "#a9b4c0", text: "#242936", textMuted: "#687183", textSubtle: "#8992a2", tooltip: "#242936" },
    darkVariables: { bg: "#1f2430", surface: "#232834", surfaceMuted: "#2a3040", surfaceRaised: "#282e3b", border: "#3d424d", borderStrong: "#565d6a", text: "#cccac2", textMuted: "#8a94a6", textSubtle: "#707a8c", tooltip: "#151820" },
  },
  {
    value: "mech-forge",
    name: "Mech Forge",
    tone: "机械工业渐变",
    description: "钢铁灰、氧化铜与警示黄，偏设备控制台的工业质感。",
    colors: ["#20252b", "#3d4850", "#d39b3d", "#d56a45"],
    accent: "#d39b3d",
    success: "#6da36b",
    warning: "#d39b3d",
    danger: "#d56a45",
    mode: "light",
    canvas: "linear-gradient(135deg, #edf0ef 0%, #eef2f1 42%, #f3eee6 100%)",
    darkCanvas: "linear-gradient(135deg, #1c2228 0%, #29343a 48%, #30281f 100%)",
    variables: { bg: "#eef0ef", surface: "#fbfcfb", surfaceMuted: "#e7ebea", surfaceRaised: "#f6f8f7", border: "#cbd3d1", borderStrong: "#aab6b2", text: "#252b2e", textMuted: "#667075", textSubtle: "#899398", tooltip: "#252b2e" },
    darkVariables: { bg: "#20252b", surface: "#283037", surfaceMuted: "#323c42", surfaceRaised: "#2d363d", border: "#465159", borderStrong: "#657179", text: "#e2e7e5", textMuted: "#a8b3b5", textSubtle: "#7e8b90", tooltip: "#111518" },
  },
  {
    value: "punk-neon",
    name: "Punk Neon",
    tone: "朋克霓虹渐变",
    description: "炭黑底叠加洋红、酸性绿与电光蓝，强烈但保持操作可辨。",
    colors: ["#15141d", "#3a1d45", "#f04f9d", "#a8d64b"],
    accent: "#f04f9d",
    success: "#a8d64b",
    warning: "#f3b33d",
    danger: "#ff6b6b",
    mode: "light",
    canvas: "linear-gradient(135deg, #f3eef5 0%, #f7edf4 48%, #eef6eb 100%)",
    darkCanvas: "linear-gradient(135deg, #17151f 0%, #321b3f 46%, #202b21 100%)",
    variables: { bg: "#f4f0f5", surface: "#fffaff", surfaceMuted: "#eee7f0", surfaceRaised: "#faf5fb", border: "#d8cbdc", borderStrong: "#b99fc2", text: "#302636", textMuted: "#75667c", textSubtle: "#97899e", tooltip: "#302636" },
    darkVariables: { bg: "#15141d", surface: "#211d2b", surfaceMuted: "#2d2638", surfaceRaised: "#282132", border: "#493751", borderStrong: "#69506e", text: "#f2eaf3", textMuted: "#bbaabd", textSubtle: "#8e7e93", tooltip: "#0d0c12" },
  },
  {
    value: "retro-film",
    name: "Retro Film",
    tone: "复古胶片渐变",
    description: "米白、橄榄绿与褪色橙，带一点老式工作站的温度。",
    colors: ["#282823", "#4f5b3a", "#d29a55", "#c96b4b"],
    accent: "#b9783c",
    success: "#738b52",
    warning: "#c8924b",
    danger: "#bc594b",
    mode: "light",
    canvas: "linear-gradient(135deg, #f5f0e2 0%, #eef0dc 48%, #f7e8d7 100%)",
    darkCanvas: "linear-gradient(135deg, #24241f 0%, #303726 48%, #35291f 100%)",
    variables: { bg: "#f5f0e2", surface: "#fffaf0", surfaceMuted: "#ebe6d6", surfaceRaised: "#fbf5e9", border: "#d7cfb8", borderStrong: "#b7aa8c", text: "#322f27", textMuted: "#776f5e", textSubtle: "#9a907b", tooltip: "#322f27" },
    darkVariables: { bg: "#282823", surface: "#323229", surfaceMuted: "#3d3c30", surfaceRaised: "#37372d", border: "#5a5846", borderStrong: "#77745a", text: "#eee6d4", textMuted: "#b9af98", textSubtle: "#8f8876", tooltip: "#161612" },
  },
  {
    value: "modern-minimal",
    name: "Modern Minimal",
    tone: "现代简约渐变",
    description: "大面积留白与极浅蓝灰，强调色克制，适合日常资源管理。",
    colors: ["#f7f9fc", "#ffffff", "#4778b8", "#273142"],
    accent: "#4778b8",
    success: "#47866a",
    warning: "#b5833d",
    danger: "#bd5d5d",
    mode: "light",
    canvas: "linear-gradient(135deg, #f8fafc 0%, #eef4fb 54%, #f9fbfd 100%)",
    darkCanvas: "linear-gradient(135deg, #171b22 0%, #1c2938 54%, #1c2129 100%)",
    variables: { bg: "#f7f9fc", surface: "#ffffff", surfaceMuted: "#eef2f7", surfaceRaised: "#fafcff", border: "#d8e0ea", borderStrong: "#b9c6d5", text: "#273142", textMuted: "#6d7887", textSubtle: "#909baa", tooltip: "#273142" },
    darkVariables: { bg: "#171b22", surface: "#202630", surfaceMuted: "#2a323e", surfaceRaised: "#252d38", border: "#3c4654", borderStrong: "#596676", text: "#e6ebf1", textMuted: "#a7b1bd", textSubtle: "#7e8a98", tooltip: "#0e1116" },
  },
  {
    value: "sci-fi-orbit",
    name: "Sci-Fi Orbit",
    tone: "科幻极光渐变",
    description: "深空蓝、青色与紫色光晕，适合监控大屏与高科技资源工作台。",
    colors: ["#0d1728", "#163656", "#53d5db", "#9a7bff"],
    accent: "#53d5db",
    success: "#80d66b",
    warning: "#efc15b",
    danger: "#f4778c",
    mode: "dark",
    canvas: "linear-gradient(135deg, #edf5fa 0%, #eaf8f7 48%, #f2edfb 100%)",
    darkCanvas: "linear-gradient(135deg, #0d1728 0%, #12364b 48%, #261c45 100%)",
    variables: { bg: "#eef5fa", surface: "#fbfdff", surfaceMuted: "#e7f0f5", surfaceRaised: "#f7fbfd", border: "#c9dce6", borderStrong: "#a3c2d2", text: "#233642", textMuted: "#667d88", textSubtle: "#8ba0aa", tooltip: "#233642" },
    darkVariables: { bg: "#0d1728", surface: "#132237", surfaceMuted: "#19304a", surfaceRaised: "#172a42", border: "#284967", borderStrong: "#3d698c", text: "#e3f2f4", textMuted: "#9bbcc5", textSubtle: "#6e96a4", tooltip: "#070d17" },
  },
  {
    value: "cyber-terminal",
    name: "Cyber Terminal",
    tone: "赛博终端渐变",
    description: "墨黑终端底配青绿和琥珀提示，保留命令行的专注感。",
    colors: ["#0b1215", "#12352e", "#38d6a0", "#f4b942"],
    accent: "#38d6a0",
    success: "#62d48b",
    warning: "#f4b942",
    danger: "#ef6c6c",
    mode: "light",
    canvas: "linear-gradient(135deg, #edf7f3 0%, #e9f4f1 48%, #f7f1e6 100%)",
    darkCanvas: "linear-gradient(135deg, #0b1215 0%, #10362f 48%, #30261a 100%)",
    variables: { bg: "#eef7f3", surface: "#fbfefa", surfaceMuted: "#e5f1ed", surfaceRaised: "#f6fbf8", border: "#c9ddd5", borderStrong: "#9ec1b2", text: "#21332d", textMuted: "#668078", textSubtle: "#8ca198", tooltip: "#21332d" },
    darkVariables: { bg: "#0b1215", surface: "#10201f", surfaceMuted: "#16302c", surfaceRaised: "#142925", border: "#285248", borderStrong: "#3d7667", text: "#dcefe8", textMuted: "#8fb9aa", textSubtle: "#659184", tooltip: "#050809" },
  },
];

const accentPresets = ["#426b57", "#2f6f68", "#315f92", "#6a5b88", "#9b5f35", "#8a4f5d"];
const consolePaletteOptions: ConsolePaletteOption[] = [
  {
    value: "vrc",
    name: "VRC 墨青",
    source: "默认",
    background: "#101715",
    foreground: "#dce8df",
    muted: "#819089",
    accent: "#73a486",
    success: "#79b88e",
    colors: ["#101715", "#315b4a", "#73a486", "#dce8df"],
  },
  {
    value: "tokyo-night",
    name: "Tokyo Night",
    source: "GitHub",
    background: "#1a1b26",
    foreground: "#c0caf5",
    muted: "#737aa2",
    accent: "#7aa2f7",
    success: "#9ece6a",
    colors: ["#1a1b26", "#7aa2f7", "#bb9af7", "#7dcfff"],
  },
  {
    value: "catppuccin",
    name: "Catppuccin",
    source: "Mocha",
    background: "#1e1e2e",
    foreground: "#cdd6f4",
    muted: "#7f849c",
    accent: "#cba6f7",
    success: "#a6e3a1",
    colors: ["#1e1e2e", "#89b4fa", "#cba6f7", "#f5c2e7"],
  },
  {
    value: "dracula",
    name: "Dracula",
    source: "GitHub",
    background: "#282a36",
    foreground: "#f8f8f2",
    muted: "#8b90a7",
    accent: "#bd93f9",
    success: "#50fa7b",
    colors: ["#282a36", "#8be9fd", "#bd93f9", "#ff79c6"],
  },
  {
    value: "nord",
    name: "Nord",
    source: "Arctic Ice",
    background: "#2e3440",
    foreground: "#eceff4",
    muted: "#8f9bae",
    accent: "#88c0d0",
    success: "#a3be8c",
    colors: ["#2e3440", "#5e81ac", "#88c0d0", "#8fbcbb"],
  },
  {
    value: "rose-pine",
    name: "Rose Pine",
    source: "Moon",
    background: "#232136",
    foreground: "#e0def4",
    muted: "#817c9c",
    accent: "#c4a7e7",
    success: "#9ccfd8",
    colors: ["#232136", "#3e8fb0", "#c4a7e7", "#ea9a97"],
  },
  {
    value: "solarized",
    name: "Solarized",
    source: "Dark",
    background: "#002b36",
    foreground: "#93a1a1",
    muted: "#657b83",
    accent: "#b58900",
    success: "#859900",
    colors: ["#002b36", "#268bd2", "#2aa198", "#b58900"],
  },
  {
    value: "light",
    name: "Paper",
    source: "浅色",
    background: "#f6f7f5",
    foreground: "#29302c",
    muted: "#737d77",
    accent: "#426b57",
    success: "#477a45",
    colors: ["#f6f7f5", "#b7c9be", "#658e78", "#29302c"],
  },
];

const uiFontOptions: UiFontOption[] = [
  { value: "system", name: "跟随系统", family: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif", badge: "本机", note: "随操作系统，macOS 为苹方，Windows 为雅黑" },
  { value: "inter", name: "Inter", family: "\"Inter\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif", badge: "内置", note: "现代屏显无衬线，数字与英文锐利，中文回退黑体" },
  { value: "noto-sans-sc", name: "思源黑体", family: "\"Noto Sans SC\", \"Source Han Sans SC\", \"PingFang SC\", sans-serif", badge: "内置", note: "Adobe 与 Google 联合发布，字形中性，字重齐全" },
  { value: "lxgw-wenkai", name: "霞鹜文楷", family: "\"LXGW WenKai Screen\", \"LXGW WenKai\", \"Kaiti SC\", serif", badge: "内置", note: "开源楷体，阅读温润，适合长时间盯屏" },
  { value: "compact", name: "紧凑字体", family: "\"DIN Next\", \"Roboto Condensed\", \"PingFang SC\", sans-serif", badge: "本机", note: "窄体字形，单行容纳更多字符" },
];

const gradientPresetsLight: GradientPreset[] = [
  { value: "glacier-mist", name: "冰川薄雾", angle: 135, stops: ["#edf5fb", "#edf7f3", "#f3eef8"] },
  { value: "rose-dawn", name: "玫瑰晨曦", angle: 130, stops: ["#fbf0f2", "#f3f0fb", "#eef6f3"] },
  { value: "mint-spring", name: "薄荷清泉", angle: 140, stops: ["#e9f8f1", "#eaf4fb", "#f4f0e9"] },
];

const gradientPresetsDark: GradientPreset[] = [
  { value: "neon-abyss", name: "霓虹深渊", angle: 135, stops: ["#10141c", "#12202b", "#1a1530"] },
  { value: "deep-sea", name: "深海潜流", angle: 160, stops: ["#0f1c28", "#102a33", "#14253c"] },
  { value: "ember-night", name: "余烬夜色", angle: 150, stops: ["#211a18", "#2b211d", "#1c2230"] },
];

const builtinWallpapers: BuiltinWallpaper[] = [
  { value: "mint-breeze", name: "薄荷清风", src: "/prototype-wallpapers/mint-breeze.svg", mood: "light" },
  { value: "frost-spectrum", name: "冰川光谱", src: "/prototype-wallpapers/frost-spectrum.svg", mood: "light" },
  { value: "copper-dusk", name: "玄武暮色", src: "/prototype-wallpapers/copper-dusk.svg", mood: "light" },
  { value: "aurora-rose", name: "极光玫瑰", src: "/prototype-wallpapers/aurora-rose.svg", mood: "light" },
  { value: "graphite-mist", name: "石墨青岚", src: "/prototype-wallpapers/graphite-mist.svg", mood: "light" },
  { value: "sunrise-amber", name: "晨曦琥珀", src: "/prototype-wallpapers/sunrise-amber.svg", mood: "light" },
  { value: "deep-ocean", name: "深海潜流", src: "/prototype-wallpapers/deep-ocean.svg", mood: "dark" },
  { value: "neon-night", name: "霓虹夜幕", src: "/prototype-wallpapers/neon-night.svg", mood: "dark" },
];

const currentTheme = ref<ThemeName>("graphite-sage");
const toneMode = ref<ToneMode>("light");
const systemDark = ref(false);
const accentColor = ref(themeOptions[0].accent);
const successColor = ref(themeOptions[0].success);
const warningColor = ref(themeOptions[0].warning);
const dangerColor = ref(themeOptions[0].danger);
const backgroundMode = ref<BackgroundMode>("default");
const defaultBackgroundImage = "/prototype-wallpapers/mint-breeze.svg";
const backgroundImage = ref(defaultBackgroundImage);
const backgroundImageName = ref("薄荷清风（内置）");
const showIconTooltips = ref(true);
const truncateLongNames = ref(true);
const throttleConsoleResize = ref(true);
const uiFontFamily = ref<UiFontFamily>("system");
const uiFontSize = ref(12);
const reduceMotion = ref(false);
const consoleMode = ref<ConsoleMode>("graphical");
const consoleFontFamily = ref<ConsoleFontFamily>("system-mono");
const consoleFontSize = ref(13);
const consoleLineHeight = ref(1.2);
const consolePalette = ref<ConsolePalette>("vrc");
const consoleCursor = ref<ConsoleCursor>("block");
const consoleCursorBlink = ref(true);
const watermarkEnabled = ref(true);
const watermarkScope = ref<WatermarkScope>("console");
const watermarkDensity = ref<WatermarkDensity>("standard");
const watermarkOpacity = ref(12);
const watermarkText = ref("lyc · 192.168.2.26 · 2026-07-22 01:18");
const imageFileInput = ref<HTMLInputElement>();
const jsonFileInput = ref<HTMLInputElement>();
const gradientPreset = ref("glacier-mist");
const gradientAngle = ref(135);
const gradientStops = ref<string[]>(["#edf5fb", "#edf7f3", "#f3eef8"]);
const dualWallpaper = ref(false);
const wallpaperTarget = ref<WallpaperTarget>("light");
const darkBackgroundImage = ref("");
const darkBackgroundImageName = ref("");
const favoriteWallpapers = ref<string[]>([]);
const rotationEnabled = ref(false);
const rotationInterval = ref(15);
const extractedColors = ref<string[]>([]);
const imageMeta = ref<{ name: string; width: number; height: number; sizeText: string; compressedText: string } | null>(null);
const customFontFamily = ref("");
let darkModeQuery: MediaQueryList | undefined;
let backgroundObjectUrl: string | undefined;
let rotationTimer: number | undefined;

const resolvedDark = computed(() => toneMode.value === "dark" || (toneMode.value === "system" && systemDark.value));
const selectedTheme = computed(() => themeOptions.find((theme) => theme.value === currentTheme.value) ?? themeOptions[0]);
// 只推荐 3 款主题（浅/渐变/深各一），更多风格靠下方自定义自由搭配
const recommendedThemes = computed(() => themeOptions.filter((theme) => ["graphite-sage", "prism-frost", "neon-carbon"].includes(theme.value)));
const activeBackgroundImage = computed(() =>
  resolvedDark.value && dualWallpaper.value && darkBackgroundImage.value ? darkBackgroundImage.value : backgroundImage.value,
);
const uiFontStack = computed(() => {
  const custom = customFontFamily.value.trim();
  const fallback = uiFontOptions[0].family;
  if (custom) return `${custom}, ${fallback}`;
  return uiFontOptions.find((option) => option.value === uiFontFamily.value)?.family ?? fallback;
});
const consoleFontStack = computed(() => {
  if (consoleFontFamily.value === "jetbrains") return '"JetBrains Mono", "SFMono-Regular", Consolas, monospace';
  if (consoleFontFamily.value === "cascadia") return '"Cascadia Mono", "SFMono-Regular", Consolas, monospace';
  if (consoleFontFamily.value === "menlo") return 'Menlo, Monaco, Consolas, monospace';
  return '"SFMono-Regular", Consolas, "Liberation Mono", monospace';
});
const consoleFontSource = computed(() => {
  if (consoleFontFamily.value === "system-mono") return "跟随系统 · 0 KB";
  if (consoleFontFamily.value === "menlo") return "macOS 本机字体 · 0 KB";
  return "首次使用时按需下载并缓存";
});
const consolePaletteStyle = computed(() => {
  const palette = consolePaletteOptions.find((item) => item.value === consolePalette.value) ?? consolePaletteOptions[0];
  return {
    "--console-preview-bg": palette.background,
    "--console-preview-fg": palette.foreground,
    "--console-preview-muted": palette.muted,
    "--console-preview-accent": palette.accent,
    "--console-preview-success": palette.success,
    "--console-preview-font": consoleFontStack.value,
    "--console-preview-size": `${consoleFontSize.value}px`,
    "--console-preview-line-height": String(consoleLineHeight.value),
  };
});
const watermarkCopies = computed(() => ({ sparse: 3, standard: 6, dense: 10 })[watermarkDensity.value]);
const currentThemeToneText = computed(() => {
  if (toneMode.value === "system") return systemDark.value ? "跟随系统 · 深色" : "跟随系统 · 浅色";
  return toneMode.value === "dark" ? "深色" : "浅色";
});
const recommendedGradients = computed(() => (resolvedDark.value ? gradientPresetsDark : gradientPresetsLight));
const allGradientPresets = [...gradientPresetsLight, ...gradientPresetsDark];
const activeGradientCss = computed(() =>
  gradientStops.value.length === 1 ? gradientStops.value[0] : `linear-gradient(${gradientAngle.value}deg, ${gradientStops.value.join(", ")})`,
);
const currentGradientName = computed(() => allGradientPresets.find((item) => item.value === gradientPreset.value)?.name ?? "自定义");
const hasCustomBackground = computed(() => backgroundMode.value !== "default");
const currentBackgroundText = computed(() => {
  if (backgroundMode.value === "color") {
    return gradientStops.value.length === 1 ? `纯色 ${gradientStops.value[0]}` : `渐变 · ${currentGradientName.value}`;
  }
  if (backgroundMode.value === "image") return dualWallpaper.value ? "图片 · 明暗双壁纸" : "图片背景";
  return selectedTheme.value.tone;
});
const bgPreviewStyle = computed(() => {
  if (backgroundMode.value === "color") return { background: activeGradientCss.value };
  if (backgroundMode.value === "image") {
    return { backgroundImage: `url(${JSON.stringify(activeBackgroundImage.value)})`, backgroundSize: "cover", backgroundPosition: "center" };
  }
  return { background: resolvedDark.value ? selectedTheme.value.darkCanvas : selectedTheme.value.canvas };
});
const themePreviewRows = computed(() => [
  { name: "xenserver-2", ip: "192.168.2.26", status: "运行中", tone: "good", cpu: "24%", memory: "18.6 GiB" },
  { name: "pve-lab-01", ip: "192.168.2.68", status: "维护", tone: "warn", cpu: "12%", memory: "9.4 GiB" },
  { name: "vmware-prod", ip: "10.10.1.21", status: "离线", tone: "danger", cpu: "-", memory: "-" },
]);

const prototypeStyle = computed<Record<string, string>>(() => {
  const theme = selectedTheme.value;
  const variables = resolvedDark.value && theme.darkVariables ? theme.darkVariables : theme.variables;
  const style: Record<string, string> = {
    "--vrc-bg": variables.bg,
    "--vrc-surface": variables.surface,
    "--vrc-surface-muted": variables.surfaceMuted,
    "--vrc-surface-raised": variables.surfaceRaised,
    "--vrc-border": variables.border,
    "--vrc-border-strong": variables.borderStrong,
    "--vrc-text": variables.text,
    "--vrc-text-muted": variables.textMuted,
    "--vrc-text-subtle": variables.textSubtle,
    "--vrc-tooltip-bg": variables.tooltip,
    "--vrc-accent": accentColor.value,
    "--vrc-accent-hover": `color-mix(in srgb, ${accentColor.value} 82%, black)`,
    "--vrc-accent-soft": `color-mix(in srgb, ${accentColor.value} 13%, var(--vrc-surface))`,
    "--vrc-success": successColor.value,
    "--vrc-warning": warningColor.value,
    "--vrc-danger": dangerColor.value,
    "--prototype-theme-background":
      backgroundMode.value === "color" ? activeGradientCss.value : backgroundMode.value === "default" ? (resolvedDark.value ? theme.darkCanvas : theme.canvas) : "none",
    "--prototype-background-image": backgroundMode.value === "image" && activeBackgroundImage.value ? `url(${JSON.stringify(activeBackgroundImage.value)})` : "none",
    "--prototype-ui-font": uiFontStack.value,
    "--prototype-ui-size": `${uiFontSize.value}px`,
  };

  if (resolvedDark.value && !theme.darkVariables) {
    Object.assign(style, {
      "--vrc-bg": "#171a19",
      "--vrc-surface": "#202422",
      "--vrc-surface-muted": "#292e2b",
      "--vrc-surface-raised": "#252a27",
      "--vrc-border": "#383f3b",
      "--vrc-border-strong": "#56605a",
      "--vrc-text": "#e7ebe8",
      "--vrc-text-muted": "#a6aea9",
      "--vrc-text-subtle": "#7e8882",
      "--vrc-tooltip-bg": "#0f1210",
    });
  }

  return style;
});

function applyTheme(value: ThemeName) {
  const theme = themeOptions.find((item) => item.value === value);
  if (!theme) return;
  currentTheme.value = value;
  accentColor.value = theme.accent;
  successColor.value = theme.success;
  warningColor.value = theme.warning;
  dangerColor.value = theme.danger;
  toneMode.value = theme.mode;
  document.documentElement.dataset.theme = value;
}

function resetPrototype() {
  releaseBackgroundObjectUrl();
  toneMode.value = "light";
  backgroundMode.value = "default";
  backgroundImage.value = defaultBackgroundImage;
  backgroundImageName.value = "薄荷清风（内置）";
  gradientPreset.value = "glacier-mist";
  gradientAngle.value = 135;
  gradientStops.value = ["#edf5fb", "#edf7f3", "#f3eef8"];
  dualWallpaper.value = false;
  wallpaperTarget.value = "light";
  darkBackgroundImage.value = "";
  darkBackgroundImageName.value = "";
  favoriteWallpapers.value = [];
  rotationEnabled.value = false;
  extractedColors.value = [];
  imageMeta.value = null;
  customFontFamily.value = "";
  showIconTooltips.value = true;
  truncateLongNames.value = true;
  throttleConsoleResize.value = true;
  uiFontFamily.value = "system";
  uiFontSize.value = 12;
  reduceMotion.value = false;
  consoleMode.value = "graphical";
  consoleFontFamily.value = "system-mono";
  consoleFontSize.value = 13;
  consoleLineHeight.value = 1.2;
  consolePalette.value = "vrc";
  consoleCursor.value = "block";
  consoleCursorBlink.value = true;
  watermarkEnabled.value = true;
  watermarkScope.value = "console";
  watermarkDensity.value = "standard";
  watermarkOpacity.value = 12;
  applyTheme("graphite-sage");
}

function selectImageFile() {
  imageFileInput.value?.click();
}

function loadBackgroundImage(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (file) loadWallpaperFile(file);
}

function handleWallpaperDrop(event: DragEvent) {
  const file = event.dataTransfer?.files?.[0];
  if (file) loadWallpaperFile(file);
}

function loadWallpaperFile(file: File) {
  if (!file.type.startsWith("image/")) {
    ElMessage.error("请选择图片文件");
    return;
  }
  if (file.size > 16 * 1024 * 1024) {
    ElMessage.error("图片不能超过 16MB");
    return;
  }
  const reader = new FileReader();
  reader.addEventListener("load", () => {
    const image = new Image();
    image.addEventListener("load", () => {
      // 原型演示正式版要做的压缩：最长边 2560 + WebP 0.85，16MB 原图通常压到 1-2MB
      const maxEdge = 2560;
      const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(image.naturalWidth * scale);
      canvas.height = Math.round(image.naturalHeight * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      const compressed = canvas.toDataURL("image/webp", 0.85);
      applyWallpaperSource(compressed, file.name);
      imageMeta.value = {
        name: file.name,
        width: image.naturalWidth,
        height: image.naturalHeight,
        sizeText: formatSize(file.size),
        compressedText: formatSize(Math.round(compressed.length * 0.75)),
      };
      ElMessage.success("壁纸已压缩并应用");
    });
    image.addEventListener("error", () => ElMessage.error("图片无法读取，请使用 JPG、PNG 或 WebP 文件"));
    image.src = String(reader.result);
  });
  reader.readAsDataURL(file);
}

function formatSize(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function applyWallpaperSource(src: string, name: string) {
  if (dualWallpaper.value && wallpaperTarget.value === "dark") {
    darkBackgroundImage.value = src;
    darkBackgroundImageName.value = name;
  } else {
    backgroundImage.value = src;
    backgroundImageName.value = name;
  }
  backgroundMode.value = "image";
  extractColorsFromImage(src);
}

function applyBuiltinWallpaper(wp: BuiltinWallpaper) {
  imageMeta.value = null;
  applyWallpaperSource(wp.src, wp.name);
}

function toggleFavorite(value: string) {
  const index = favoriteWallpapers.value.indexOf(value);
  if (index >= 0) favoriteWallpapers.value.splice(index, 1);
  else favoriteWallpapers.value.push(value);
}

function extractColorsFromImage(src: string) {
  const image = new Image();
  image.crossOrigin = "anonymous";
  image.addEventListener("load", () => {
    try {
      const size = 72;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = Math.max(1, Math.round((size * image.naturalHeight) / Math.max(1, image.naturalWidth)));
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const buckets = new Map<string, number>();
      for (let i = 0; i + 2 < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        if (max - min < 28 || max > 244 || max < 36) continue;
        const key = [r, g, b].map((v) => Math.round(v / 24) * 24).join(",");
        buckets.set(key, (buckets.get(key) ?? 0) + 1);
      }
      extractedColors.value = [...buckets.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([key]) => `#${key.split(",").map((v) => Math.min(255, Number(v)).toString(16).padStart(2, "0")).join("")}`);
    } catch {
      extractedColors.value = [];
    }
  });
  image.addEventListener("error", () => {
    extractedColors.value = [];
  });
  image.src = src;
}

function applyExtractedColor(color: string) {
  accentColor.value = color;
  ElMessage.success(`强调色已取色 ${color}`);
}

function applyGradientPreset(value: string) {
  const preset = allGradientPresets.find((item) => item.value === value);
  if (!preset) return;
  gradientPreset.value = value;
  gradientAngle.value = preset.angle;
  gradientStops.value = [...preset.stops];
  backgroundMode.value = "color";
}

function updateGradientStop(index: number, color: string | null) {
  if (!color) return;
  gradientStops.value.splice(index, 1, color);
  gradientPreset.value = "custom";
}

function addGradientStop() {
  if (gradientStops.value.length >= 4) return;
  gradientStops.value.push("#a8cbe8");
  gradientPreset.value = "custom";
}

function removeGradientStop() {
  if (gradientStops.value.length <= 1) return;
  gradientStops.value.pop();
  gradientPreset.value = "custom";
}

function useThemeGradient() {
  const source = resolvedDark.value ? selectedTheme.value.darkCanvas : selectedTheme.value.canvas;
  const stops = source.match(/#[0-9a-fA-F]{3,8}/g);
  const angle = source.match(/(\d+(?:\.\d+)?)deg/);
  if (!stops || stops.length < 2) {
    ElMessage.warning("当前主题画布没有可取色的渐变");
    return;
  }
  gradientStops.value = stops.slice(0, 4);
  if (angle) gradientAngle.value = Number(angle[1]);
  gradientPreset.value = "custom";
  backgroundMode.value = "color";
  ElMessage.success("已从当前主题画布取色");
}

function stopRotation() {
  if (rotationTimer !== undefined) {
    window.clearInterval(rotationTimer);
    rotationTimer = undefined;
  }
}

watch([rotationEnabled, rotationInterval, favoriteWallpapers], () => {
  stopRotation();
  if (!rotationEnabled.value || favoriteWallpapers.value.length < 2) return;
  rotationTimer = window.setInterval(() => {
    const list = favoriteWallpapers.value;
    const currentIndex = list.findIndex((value) => builtinWallpapers.find((item) => item.value === value)?.src === backgroundImage.value);
    const next = list[(currentIndex + 1) % list.length];
    const wp = builtinWallpapers.find((item) => item.value === next);
    if (!wp) return;
    // 轮换只切浅色槽位，避免打断深色槽位配置
    backgroundImage.value = wp.src;
    backgroundImageName.value = wp.name;
    backgroundMode.value = "image";
  }, rotationInterval.value * 1000);
});

function releaseBackgroundObjectUrl() {
  if (!backgroundObjectUrl) return;
  URL.revokeObjectURL(backgroundObjectUrl);
  backgroundObjectUrl = undefined;
}

function exportTheme() {
  const config = {
    version: 2,
    baseTheme: currentTheme.value,
    toneMode: toneMode.value,
    colors: {
      accent: accentColor.value,
      success: successColor.value,
      warning: warningColor.value,
      danger: dangerColor.value,
    },
    background: {
      mode: backgroundMode.value,
      image: backgroundImage.value.startsWith("data:") ? "" : backgroundImage.value,
      gradient: { angle: gradientAngle.value, stops: [...gradientStops.value] },
      dualWallpaper: dualWallpaper.value,
    },
    typography: {
      family: uiFontFamily.value,
      size: uiFontSize.value,
      customFontFamily: customFontFamily.value || null,
      reduceMotion: reduceMotion.value,
    },
    console: {
      mode: consoleMode.value,
      fontFamily: consoleFontFamily.value,
      fontSize: consoleFontSize.value,
      lineHeight: consoleLineHeight.value,
      palette: consolePalette.value,
      cursor: consoleCursor.value,
      cursorBlink: consoleCursorBlink.value,
      watermark: {
        enabled: watermarkEnabled.value,
        scope: watermarkScope.value,
        density: watermarkDensity.value,
        opacity: watermarkOpacity.value,
      },
    },
  };
  const blob = new Blob([JSON.stringify(config, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "vrc-theme.json";
  link.click();
  URL.revokeObjectURL(link.href);
}

function selectJsonFile() {
  jsonFileInput.value?.click();
}

function importTheme(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.addEventListener("load", () => {
    try {
      const config = JSON.parse(String(reader.result)) as Record<string, any>;
      if (themeOptions.some((theme) => theme.value === config.baseTheme)) applyTheme(config.baseTheme as ThemeName);
      if (["system", "light", "dark"].includes(config.toneMode)) toneMode.value = config.toneMode as ToneMode;
      if (config.colors?.accent) accentColor.value = config.colors.accent;
      if (config.colors?.success) successColor.value = config.colors.success;
      if (config.colors?.warning) warningColor.value = config.colors.warning;
      if (config.colors?.danger) dangerColor.value = config.colors.danger;
      if (["default", "color", "image"].includes(config.background?.mode)) backgroundMode.value = config.background.mode;
      if (config.background?.image) backgroundImage.value = config.background.image;
      if (Array.isArray(config.background?.gradient?.stops) && config.background.gradient.stops.length >= 1) {
        gradientStops.value = config.background.gradient.stops.map(String).slice(0, 4);
        if (Number.isFinite(config.background.gradient.angle)) gradientAngle.value = Number(config.background.gradient.angle);
      }
      if (typeof config.background?.dualWallpaper === "boolean") dualWallpaper.value = config.background.dualWallpaper;
      if (["system", "inter", "noto-sans-sc", "lxgw-wenkai", "compact"].includes(config.typography?.family)) uiFontFamily.value = config.typography.family;
      if (typeof config.typography?.customFontFamily === "string") customFontFamily.value = config.typography.customFontFamily;
      if ([11, 12, 13].includes(config.typography?.size)) uiFontSize.value = config.typography.size;
      if (typeof config.typography?.reduceMotion === "boolean") reduceMotion.value = config.typography.reduceMotion;
      if (["graphical", "cli"].includes(config.console?.mode)) consoleMode.value = config.console.mode;
      if (["system-mono", "jetbrains", "cascadia", "menlo"].includes(config.console?.fontFamily)) consoleFontFamily.value = config.console.fontFamily;
      if (Number.isFinite(config.console?.fontSize)) consoleFontSize.value = Math.min(18, Math.max(11, config.console.fontSize));
      if (Number.isFinite(config.console?.lineHeight)) consoleLineHeight.value = Math.min(1.8, Math.max(1, config.console.lineHeight));
      if (consolePaletteOptions.some((palette) => palette.value === config.console?.palette)) consolePalette.value = config.console.palette;
      if (["block", "bar", "underline"].includes(config.console?.cursor)) consoleCursor.value = config.console.cursor;
      if (typeof config.console?.cursorBlink === "boolean") consoleCursorBlink.value = config.console.cursorBlink;
      if (typeof config.console?.watermark?.enabled === "boolean") watermarkEnabled.value = config.console.watermark.enabled;
      if (["console", "workspace"].includes(config.console?.watermark?.scope)) watermarkScope.value = config.console.watermark.scope;
      if (["sparse", "standard", "dense"].includes(config.console?.watermark?.density)) watermarkDensity.value = config.console.watermark.density;
      if (Number.isFinite(config.console?.watermark?.opacity)) watermarkOpacity.value = Math.min(24, Math.max(6, config.console.watermark.opacity));
      ElMessage.success("主题配置已载入原型");
    } catch {
      ElMessage.error("主题配置文件格式不正确");
    }
  });
  reader.readAsText(file);
  input.value = "";
}

function updateSystemMode(event: MediaQueryListEvent | MediaQueryList) {
  systemDark.value = event.matches;
}

onMounted(() => {
  darkModeQuery = window.matchMedia("(prefers-color-scheme: dark)");
  updateSystemMode(darkModeQuery);
  darkModeQuery.addEventListener("change", updateSystemMode);
});

onBeforeUnmount(() => {
  darkModeQuery?.removeEventListener("change", updateSystemMode);
  releaseBackgroundObjectUrl();
  stopRotation();
});
</script>

<template>
  <main class="app-shell prototype-app-shell" :class="{ 'reduce-motion': reduceMotion }" :style="prototypeStyle">
    <aside class="sidebar">
      <div class="sidebar-head">
        <div class="brand-lockup">
          <span class="brand-mark sidebar-logo" aria-hidden="true">
            <VrcLogoMark shadow />
          </span>
          <div class="brand-copy">
            <h1>资源控制台</h1>
            <p>3 个连接</p>
          </div>
        </div>
        <button class="icon-button settings-entry-button active" type="button" aria-label="设置">
          <el-icon><Setting /></el-icon>
        </button>
      </div>

      <section class="sidebar-section">
        <el-input class="sidebar-search" placeholder="输入名称、平台或地址" :prefix-icon="Search" clearable />
      </section>

      <div class="connection-groups">
        <section class="connection-group overview-group">
          <button class="overview-entry" type="button">
            <span class="overview-entry-icon">↗</span>
            <span class="overview-entry-main">
              <strong>资源总览</strong>
              <small>查看全部物理机</small>
            </span>
          </button>
        </section>
        <section class="connection-group">
          <div class="group-title"><span>生产环境</span></div>
          <button class="connection-item" type="button">
            <span class="status-dot online"></span>
            <span class="connection-main"><strong>xenserver-1</strong><small>10.10.1.21</small></span>
            <span class="connection-port">22</span>
          </button>
          <button class="connection-item" type="button">
            <span class="status-dot online"></span>
            <span class="connection-main"><strong>xenserver-2</strong><small>10.10.1.22</small></span>
            <span class="connection-port">22</span>
          </button>
        </section>
        <section class="connection-group">
          <div class="group-title"><span>测试环境</span></div>
          <button class="connection-item" type="button">
            <span class="status-dot"></span>
            <span class="connection-main"><strong>vmware-lab</strong><small>10.10.2.11</small></span>
            <span class="connection-port">443</span>
          </button>
        </section>
      </div>

      <button class="activity-toggle" type="button">
        <span class="activity-toggle-icon" aria-hidden="true"><el-icon><Tickets /></el-icon></span>
        <span>操作记录</span>
        <strong>6</strong>
      </button>
    </aside>

    <section class="workspace is-settings-mode">
      <section class="panel settings-workspace-panel">
        <div class="settings-workspace-head">
          <div>
            <h3>设置</h3>
            <span>管理外观、连接、创建模板和运行日志。</span>
          </div>
          <button type="button" class="settings-close-button">
            <el-icon><ArrowLeft /></el-icon>
            <span>返回资源总览</span>
          </button>
        </div>

        <div class="settings-workspace-layout">
          <aside class="settings-workspace-nav" aria-label="设置分组">
            <button type="button" class="active"><el-icon><Brush /></el-icon><span>外观</span></button>
            <button type="button"><el-icon><Connection /></el-icon><span>连接</span></button>
            <button type="button"><el-icon><Plus /></el-icon><span>创建模板</span></button>
            <button type="button"><el-icon><Tickets /></el-icon><span>日志</span></button>
          </aside>

          <section class="settings-workspace-content prototype-theme-canvas" :class="{ 'has-custom-bg': hasCustomBackground }">
            <section class="settings-card prototype-theme-card">
              <div class="settings-card-head">
                <div>
                  <strong>框架主题</strong>
                  <span>精选 3 款推荐主题，全局应用；更多风格用下方自定义主题和背景自由搭配。</span>
                </div>
              </div>
              <div class="prototype-theme-studio">
                <div class="prototype-theme-selection">
                  <div class="prototype-theme-summary">
                    <div>
                      <span class="prototype-eyebrow">当前方案</span>
                      <strong>{{ selectedTheme.name }}</strong>
                      <small>{{ selectedTheme.description }}</small>
                    </div>
                    <div class="prototype-theme-summary-swatches" aria-hidden="true">
                      <i v-for="color in selectedTheme.colors" :key="color" :style="{ background: color }"></i>
                    </div>
                    <div class="prototype-theme-summary-meta">
                      <span><strong>{{ currentThemeToneText }}</strong><small>明暗模式</small></span>
                      <span><strong>{{ currentBackgroundText }}</strong><small>工作区背景</small></span>
                      <span><strong>{{ accentColor }}</strong><small>强调色</small></span>
                    </div>
                  </div>
                  <div class="settings-theme-card-grid">
                    <button
                      v-for="theme in recommendedThemes"
                      :key="theme.value"
                      type="button"
                      class="settings-theme-card"
                      :class="{ active: currentTheme === theme.value }"
                      :aria-pressed="currentTheme === theme.value"
                      @click="applyTheme(theme.value)"
                    >
                      <span class="settings-theme-card-head">
                        <strong>{{ theme.name }}</strong>
                        <small>{{ currentTheme === theme.value ? "当前" : theme.tone }}</small>
                      </span>
                      <span class="theme-swatch prototype-framework-swatch" aria-hidden="true">
                        <i class="prototype-theme-gradient" :style="{ background: resolvedDark && theme.darkCanvas ? theme.darkCanvas : theme.canvas }"></i>
                        <i v-for="color in theme.colors.slice(1)" :key="color" :style="{ background: color }"></i>
                      </span>
                      <span>{{ theme.description }}</span>
                    </button>
                  </div>
                </div>

                <aside class="prototype-theme-live-preview" aria-label="主题实时预览">
                  <div class="prototype-preview-window">
                    <div class="prototype-preview-topbar">
                      <span></span><span></span><span></span>
                      <strong>资源总览</strong>
                    </div>
                    <div class="prototype-preview-toolbar">
                      <div><strong>虚拟机列表</strong><small>主题变量实时预览</small></div>
                      <button type="button">创建</button>
                    </div>
                    <div class="prototype-preview-table">
                      <div class="prototype-preview-row header"><span>名称</span><span>IP</span><span>CPU</span><span>状态</span></div>
                      <div v-for="row in themePreviewRows" :key="row.name" class="prototype-preview-row">
                        <span><strong>{{ row.name }}</strong><small>{{ row.memory }}</small></span>
                        <span>{{ row.ip }}</span>
                        <span>{{ row.cpu }}</span>
                        <span class="prototype-preview-status" :class="row.tone">{{ row.status }}</span>
                      </div>
                    </div>
                  </div>
                </aside>
              </div>
            </section>

            <section class="settings-card prototype-custom-settings">
              <div class="settings-card-head prototype-custom-head">
                <div>
                  <strong>自定义主题</strong>
                  <span>在基础主题上覆盖语义色和工作区背景，未修改的组件继续使用系统样式变量。</span>
                </div>
                <div class="prototype-head-actions">
                  <el-button size="small" @click="selectJsonFile">载入</el-button>
                  <el-button size="small" @click="exportTheme">导出</el-button>
                  <el-button size="small" @click="resetPrototype">重置</el-button>
                </div>
              </div>

              <div class="prototype-custom-grid">
                <section class="prototype-setting-group">
                  <div class="prototype-group-title">
                    <strong>颜色</strong>
                    <span>基于语义变量覆盖，不逐个组件写死颜色。</span>
                  </div>
                  <div class="prototype-setting-row">
                    <div><strong>界面明暗</strong><span>浅色、深色或跟随系统。</span></div>
                    <el-segmented
                      v-model="toneMode"
                      class="prototype-tone-segmented"
                      :options="[{ label: '跟随系统', value: 'system' }, { label: '浅色', value: 'light' }, { label: '深色', value: 'dark' }]"
                      size="small"
                    />
                  </div>
                  <div class="prototype-setting-row prototype-accent-row">
                    <div><strong>强调色</strong><span>按钮、选中态、链接和图表主色。</span></div>
                    <div class="prototype-color-control">
                      <button
                        v-for="color in accentPresets"
                        :key="color"
                        class="prototype-color-chip"
                        :class="{ active: accentColor === color }"
                        type="button"
                        :style="{ '--chip-color': color }"
                        :aria-label="`使用强调色 ${color}`"
                        @click="accentColor = color"
                      ></button>
                      <el-color-picker v-model="accentColor" size="small" />
                    </div>
                  </div>
                  <div class="prototype-setting-row">
                    <div><strong>状态色</strong><span>成功、警告、危险保持独立语义。</span></div>
                    <div class="prototype-semantic-colors">
                      <label><span>成功</span><el-color-picker v-model="successColor" size="small" /></label>
                      <label><span>警告</span><el-color-picker v-model="warningColor" size="small" /></label>
                      <label><span>危险</span><el-color-picker v-model="dangerColor" size="small" /></label>
                    </div>
                  </div>
                </section>

              </div>
            </section>

            <section class="settings-card prototype-wallpaper-card">
              <div class="settings-card-head">
                <div>
                  <strong>背景与壁纸</strong>
                  <span>背景铺在卡片下层、透过卡片显现；选图即用，无需调参。</span>
                </div>
              </div>
              <div class="prototype-wallpaper-body">
                <div class="prototype-bg-preview" :style="bgPreviewStyle" aria-hidden="true">
                  <div class="prototype-bg-preview-cards">
                    <i></i><i class="short"></i>
                  </div>
                  <span class="prototype-bg-preview-tip">背景透过卡片显现 —— 这就是它的作用范围</span>
                </div>
                <div class="prototype-setting-row">
                  <div><strong>背景类型</strong><span>默认跟随主题画布。</span></div>
                  <el-segmented
                    v-model="backgroundMode"
                    :options="[{ label: '默认', value: 'default' }, { label: '颜色', value: 'color' }, { label: '图片', value: 'image' }]"
                    size="small"
                  />
                </div>

                <template v-if="backgroundMode === 'color'">
                  <div class="prototype-setting-row">
                    <div><strong>推荐</strong><span>{{ resolvedDark ? "深色系" : "浅色系" }} 3 款，跟随明暗模式切换。</span></div>
                    <div class="prototype-gradient-recs">
                      <button
                        v-for="preset in recommendedGradients"
                        :key="preset.value"
                        type="button"
                        class="prototype-gradient-rec"
                        :class="{ active: gradientPreset === preset.value }"
                        @click="applyGradientPreset(preset.value)"
                      >
                        <i :style="{ background: `linear-gradient(${preset.angle}deg, ${preset.stops.join(', ')})` }" aria-hidden="true"></i>
                        <span>{{ preset.name }}</span>
                      </button>
                    </div>
                  </div>
                  <div class="prototype-gradient-builder">
                    <div class="prototype-gradient-stops">
                      <span class="prototype-control-meta">颜色</span>
                      <el-color-picker
                        v-for="(stop, index) in gradientStops"
                        :key="index"
                        :model-value="stop"
                        size="small"
                        @change="updateGradientStop(index, $event)"
                      />
                      <el-button size="small" :disabled="gradientStops.length >= 4" @click="addGradientStop">＋</el-button>
                      <el-button size="small" :disabled="gradientStops.length <= 1" @click="removeGradientStop">－</el-button>
                      <el-button size="small" type="primary" plain @click="useThemeGradient">从主题取色</el-button>
                    </div>
                    <div v-if="gradientStops.length >= 2" class="prototype-gradient-angle">
                      <span class="prototype-control-meta">角度</span>
                      <el-slider v-model="gradientAngle" :min="0" :max="360" :step="5" :show-tooltip="false" @change="gradientPreset = 'custom'" />
                      <span class="prototype-control-meta">{{ gradientAngle }}°</span>
                    </div>
                  </div>
                </template>

                <template v-if="backgroundMode === 'image'">
                  <div class="prototype-gallery-head">
                    <strong>内置图库</strong>
                    <span>点击应用 · ☆ 收藏加入轮换</span>
                  </div>
                  <div class="prototype-wallpaper-grid">
                    <div
                      v-for="wp in builtinWallpapers"
                      :key="wp.value"
                      class="prototype-wallpaper-item"
                      :class="{ active: backgroundImage === wp.src || darkBackgroundImage === wp.src }"
                      @click="applyBuiltinWallpaper(wp)"
                    >
                      <div class="prototype-wallpaper-thumb" :style="{ backgroundImage: `url(${wp.src})` }">
                        <button
                          type="button"
                          class="prototype-wallpaper-star"
                          :class="{ on: favoriteWallpapers.includes(wp.value) }"
                          :aria-label="`收藏 ${wp.name}`"
                          @click.stop="toggleFavorite(wp.value)"
                        >{{ favoriteWallpapers.includes(wp.value) ? "★" : "☆" }}</button>
                        <span v-if="wp.mood === 'dark'" class="prototype-wallpaper-mood">深色</span>
                      </div>
                      <span class="prototype-wallpaper-name">{{ wp.name }}</span>
                    </div>
                  </div>

                  <div class="prototype-upload-row">
                    <div class="prototype-dropzone" @dragover.prevent @drop.prevent="handleWallpaperDrop" @click="selectImageFile">
                      <span class="prototype-dropzone-title">点击或拖拽上传</span>
                      <span class="prototype-dropzone-meta">自动压缩 WebP ≤2560 · JPG/PNG/WebP ≤16MB</span>
                    </div>
                    <div v-if="imageMeta" class="prototype-image-meta">
                      {{ imageMeta.name }} · {{ imageMeta.width }}×{{ imageMeta.height }} · 原始 {{ imageMeta.sizeText }} → 压缩后约 {{ imageMeta.compressedText }}
                    </div>
                  </div>

                  <div v-if="extractedColors.length" class="prototype-extract-row">
                    <strong>壁纸取色</strong>
                    <div class="prototype-extract-colors">
                      <button
                        v-for="color in extractedColors"
                        :key="color"
                        type="button"
                        class="prototype-extract-chip"
                        :style="{ background: color }"
                        :title="`设为强调色 ${color}`"
                        @click="applyExtractedColor(color)"
                      ></button>
                      <span class="prototype-control-meta">点击色块设为强调色</span>
                    </div>
                  </div>

                  <div class="prototype-bg-toggles">
                    <span class="prototype-bg-toggle">
                      <span class="prototype-bg-toggle-label">明暗双壁纸</span>
                      <el-switch v-model="dualWallpaper" size="small" aria-label="明暗双壁纸" />
                    </span>
                    <span class="prototype-bg-toggle">
                      <span class="prototype-bg-toggle-label">轮换</span>
                      <el-switch v-model="rotationEnabled" size="small" :disabled="favoriteWallpapers.length < 2" aria-label="壁纸轮换" />
                      <el-select v-model="rotationInterval" size="small" class="prototype-rotation-interval" :disabled="!rotationEnabled">
                        <el-option :value="15" label="15 秒（演示）" />
                        <el-option :value="60" label="1 分钟" />
                        <el-option :value="300" label="5 分钟" />
                        <el-option :value="1800" label="30 分钟" />
                      </el-select>
                      <span class="prototype-control-meta">已收藏 {{ favoriteWallpapers.length }} 张</span>
                    </span>
                  </div>
                  <div v-if="dualWallpaper" class="prototype-dual-row">
                    <div class="prototype-dual-slot" :class="{ armed: wallpaperTarget === 'light' }" @click="wallpaperTarget = 'light'">
                      <div class="prototype-dual-thumb" :style="{ backgroundImage: backgroundImage ? `url(${JSON.stringify(backgroundImage)})` : 'none' }"></div>
                      <div class="prototype-dual-meta">
                        <strong>浅色壁纸</strong>
                        <span>{{ backgroundImageName || "未设置" }}</span>
                      </div>
                    </div>
                    <div class="prototype-dual-slot" :class="{ armed: wallpaperTarget === 'dark' }" @click="wallpaperTarget = 'dark'">
                      <div class="prototype-dual-thumb dark" :style="{ backgroundImage: darkBackgroundImage ? `url(${JSON.stringify(darkBackgroundImage)})` : 'none' }"></div>
                      <div class="prototype-dual-meta">
                        <strong>深色壁纸</strong>
                        <span>{{ darkBackgroundImageName || "未设置 · 跟随浅色" }}</span>
                      </div>
                    </div>
                    <span class="prototype-dual-tip">点选槽位后，再从图库或上传应用</span>
                  </div>
                </template>
              </div>
            </section>

            <section class="settings-card prototype-advanced-card">
              <div class="settings-card-head">
                <div>
                  <strong>文字与阅读</strong>
                  <span>统一界面文字层级，并保留适合高密度资源列表的稳定布局。</span>
                </div>
              </div>
              <div class="prototype-reading-grid">
                <div class="prototype-reading-controls">
                  <div class="prototype-setting-row">
                    <div><strong>界面字体</strong><span>「内置」随应用打包、跨设备效果一致；「本机」依赖系统安装。</span></div>
                    <el-select v-model="uiFontFamily" class="prototype-control-medium" size="small" aria-label="界面字体">
                      <el-option v-for="option in uiFontOptions" :key="option.value" :label="option.name" :value="option.value">
                        <span class="prototype-font-option">
                          <span class="prototype-font-option-name" :style="{ fontFamily: option.family }">{{ option.name }}</span>
                          <span class="prototype-font-option-tag" :class="{ bundled: option.badge === '内置' }">{{ option.badge }}</span>
                        </span>
                      </el-option>
                    </el-select>
                  </div>
                  <div class="prototype-setting-row">
                    <div><strong>自定义字体</strong><span>填入本机已安装的字体名（高级），留空则使用上方选择。</span></div>
                    <el-input v-model="customFontFamily" class="prototype-control-medium" size="small" placeholder="例如 MiSans、HarmonyOS Sans SC" clearable />
                  </div>
                  <div class="prototype-setting-row">
                    <div><strong>文字大小</strong><span>只调整界面正文，表格与按钮尺寸保持规范。</span></div>
                    <el-segmented v-model="uiFontSize" class="prototype-size-segmented" :options="[{ label: '11', value: 11 }, { label: '12', value: 12 }, { label: '13', value: 13 }]" size="small" />
                  </div>
                  <div class="prototype-setting-row">
                    <div><strong>减少动效</strong><span>降低弹窗、loading 和页面切换动画。</span></div>
                    <el-switch v-model="reduceMotion" aria-label="减少界面动效" />
                  </div>
                </div>
                <div class="prototype-reading-sample">
                  <span>资源列表预览</span>
                  <strong>pve-production-01</strong>
                  <small>CPU 24% · 内存 18.6 / 32 GiB · 运行中</small>
                </div>
              </div>
            </section>

            <section class="settings-card prototype-console-card">
              <div class="settings-card-head prototype-console-head">
                <div>
                  <strong>控制台外观</strong>
                  <span>打开控制台时由目标策略选择 noVNC 或 xterm；这里仅预览两类画面的外观效果。</span>
                </div>
                <div class="prototype-console-head-actions">
                  <el-segmented
                    v-model="consoleMode"
                    :options="[{ label: '图形控制台', value: 'graphical' }, { label: 'Linux CLI', value: 'cli' }]"
                    size="small"
                    aria-label="控制台预览对象"
                  />
                  <span v-if="consoleMode === 'cli'" class="prototype-preview-tag">仅预览</span>
                  <span v-else class="prototype-preview-tag">noVNC / WebMKS</span>
                </div>
              </div>
              <div v-if="consoleMode === 'cli'" class="prototype-console-layout">
                <div class="prototype-console-controls">
                  <section class="prototype-control-group">
                    <div class="prototype-group-title"><strong>终端文字</strong><span>xterm.js · SSH / 串口通道</span></div>
                    <div class="prototype-setting-row">
                      <div><strong>字体</strong><span>{{ consoleFontSource }}</span></div>
                      <el-select v-model="consoleFontFamily" class="prototype-control-medium" aria-label="控制台字体">
                        <el-option label="系统等宽" value="system-mono" />
                        <el-option label="JetBrains Mono（按需）" value="jetbrains" />
                        <el-option label="Cascadia Mono（按需）" value="cascadia" />
                        <el-option label="Menlo（macOS）" value="menlo" />
                      </el-select>
                    </div>
                    <div class="prototype-setting-row">
                      <div><strong>字号与行高</strong><span>{{ consoleFontSize }}px / {{ consoleLineHeight.toFixed(1) }}</span></div>
                      <div class="prototype-number-pair">
                        <el-input-number v-model="consoleFontSize" :min="11" :max="18" controls-position="right" aria-label="控制台字号" />
                        <el-input-number v-model="consoleLineHeight" :min="1" :max="1.8" :step="0.1" :precision="1" controls-position="right" aria-label="控制台行高" />
                      </div>
                    </div>
                    <div class="prototype-setting-row">
                      <div><strong>光标</strong><span>形态与闪烁</span></div>
                      <div class="prototype-cursor-control">
                        <el-segmented v-model="consoleCursor" :options="[{ label: '块', value: 'block' }, { label: '线', value: 'bar' }, { label: '下划线', value: 'underline' }]" size="small" />
                        <el-switch v-model="consoleCursorBlink" aria-label="控制台光标闪烁" />
                      </div>
                    </div>
                    <div class="prototype-palette-field">
                      <div class="prototype-palette-field-head">
                        <div><strong>终端配色</strong><span>参考 iTerm2 Color Schemes、Tokyo Night、Catppuccin 与 Dracula</span></div>
                        <small>色卡渐变仅用于预览，终端背景保持纯色</small>
                      </div>
                      <div class="prototype-console-palettes" role="group" aria-label="控制台配色">
                        <button
                          v-for="palette in consolePaletteOptions"
                          :key="palette.value"
                          type="button"
                          :class="{ active: consolePalette === palette.value }"
                          :aria-label="`使用 ${palette.name} 控制台配色`"
                          :aria-pressed="consolePalette === palette.value"
                          @click="consolePalette = palette.value"
                        >
                          <span class="prototype-palette-gradient" :style="{ background: `linear-gradient(115deg, ${palette.colors.join(', ')})` }"></span>
                          <span class="prototype-palette-name"><strong>{{ palette.name }}</strong><small>{{ palette.source }}</small></span>
                        </button>
                      </div>
                    </div>
                  </section>

                  <section class="prototype-control-group">
                    <div class="prototype-group-title"><strong>安全水印</strong><span>{{ watermarkEnabled ? '已启用' : '未启用' }}</span></div>
                    <div class="prototype-setting-row">
                      <div><strong>显示水印</strong><span>操作用户、来源 IP 与时间</span></div>
                      <el-switch v-model="watermarkEnabled" aria-label="显示安全水印" />
                    </div>
                    <div v-if="watermarkEnabled" class="prototype-setting-row">
                      <div><strong>作用范围</strong><span>控制台或整个工作区</span></div>
                      <el-segmented v-model="watermarkScope" :options="[{ label: '控制台', value: 'console' }, { label: '工作区', value: 'workspace' }]" size="small" />
                    </div>
                    <div v-if="watermarkEnabled" class="prototype-setting-row">
                      <div><strong>密度</strong><span>避免遮挡关键内容</span></div>
                      <el-segmented v-model="watermarkDensity" :options="[{ label: '疏', value: 'sparse' }, { label: '标准', value: 'standard' }, { label: '密', value: 'dense' }]" size="small" />
                    </div>
                    <div v-if="watermarkEnabled" class="prototype-watermark-slider">
                      <span>透明度</span><el-slider v-model="watermarkOpacity" :min="6" :max="24" :show-tooltip="false" /><strong>{{ watermarkOpacity }}%</strong>
                    </div>
                  </section>
                </div>

                <div class="prototype-console-preview" :style="consolePaletteStyle">
                  <div class="prototype-console-toolbar"><span>centos-stream-9</span><small>xterm · 策略命中后使用</small></div>
                  <div class="prototype-terminal-content">
                    <span class="muted">Last login: Tue Jul 22 01:16:42 from 192.168.2.18</span>
                    <span><em>[root@vrc-node ~]#</em> systemctl status qemu-guest-agent</span>
                    <span class="success">● qemu-guest-agent.service - QEMU Guest Agent</span>
                    <span class="muted">&nbsp;&nbsp;&nbsp;Active: active (running) since Tue 2026-07-22 00:42:08 CST</span>
                    <span><em>[root@vrc-node ~]#</em> <i class="prototype-terminal-cursor" :class="[consoleCursor, { blink: consoleCursorBlink }]">&nbsp;</i></span>
                  </div>
                  <div v-if="watermarkEnabled" class="prototype-watermark-layer" :style="{ '--watermark-opacity': String(watermarkOpacity / 100) }" aria-hidden="true">
                    <span v-for="index in watermarkCopies" :key="index">{{ watermarkText }}</span>
                  </div>
                  <div class="prototype-console-status"><span>{{ watermarkScope === 'console' ? '终端水印' : '工作区水印' }}</span><span>{{ consoleFontSize }}px · {{ consolePalette }}</span></div>
                </div>
              </div>
              <div v-else class="prototype-console-layout prototype-graphical-layout">
                <div class="prototype-console-controls">
                  <section class="prototype-control-group">
                    <div class="prototype-group-title"><strong>图形画面</strong><span>noVNC / WebMKS / PVE VNC</span></div>
                    <div class="prototype-setting-row">
                      <div><strong>缩放方式</strong><span>保持远端画面比例，不裁切桌面边缘</span></div>
                      <el-segmented :model-value="'local'" :options="[{ label: '本地缩放', value: 'local' }, { label: '远端调整', value: 'remote' }]" size="small" />
                    </div>
                    <div class="prototype-setting-row">
                      <div><strong>画面质量</strong><span>仅调整图像传输，不改变 Guest 分辨率</span></div>
                      <el-select :model-value="'auto'" class="prototype-control-medium" aria-label="图形控制台画面质量">
                        <el-option label="自动" value="auto" />
                        <el-option label="清晰" value="high" />
                        <el-option label="流畅" value="smooth" />
                      </el-select>
                    </div>
                    <div class="prototype-setting-row">
                      <div><strong>显示水印</strong><span>与 CLI 共用用户、来源 IP 与时间规则</span></div>
                      <el-switch v-model="watermarkEnabled" aria-label="图形控制台显示安全水印" />
                    </div>
                  </section>
                  <p class="prototype-console-note">字体、字号、ANSI 颜色和光标只作用于明确标记为 CLI 的目标；CentOS 安装器、黑底登录屏和桌面画面都保持 noVNC 原始画面。</p>
                </div>
                <div class="prototype-graphical-preview">
                  <div class="prototype-console-toolbar"><span>centos-stream-9</span><small>noVNC · 已连接</small></div>
                  <div class="prototype-graphical-screen">
                    <div class="prototype-login-mark">CentOS Stream 9</div>
                    <div class="prototype-login-copy"><span>vrc-node login:</span><i></i></div>
                  </div>
                  <div v-if="watermarkEnabled" class="prototype-watermark-layer prototype-graphical-watermark" :style="{ '--watermark-opacity': String(watermarkOpacity / 100) }" aria-hidden="true">
                    <span v-for="index in watermarkCopies" :key="index">{{ watermarkText }}</span>
                  </div>
                  <div class="prototype-console-status"><span>远端原始画面</span><span>1280 × 720</span></div>
                </div>
              </div>
            </section>

            <section class="settings-tile-grid" aria-label="交互偏好">
              <article class="settings-tile">
                <div class="settings-row"><strong>操作提示</strong><span>工具栏与行内按钮</span></div>
                <div class="settings-row"><span>图标按钮显示 tooltip</span><el-switch v-model="showIconTooltips" aria-label="图标按钮显示提示" /></div>
              </article>
              <article class="settings-tile">
                <div class="settings-row"><strong>资源列表</strong><span>44-48px 行高</span></div>
                <div class="settings-row"><span>长名称单行省略</span><el-switch v-model="truncateLongNames" aria-label="长名称单行省略" /></div>
              </article>
              <article class="settings-tile">
                <div class="settings-row"><strong>控制台缩放</strong><span>减少画面抖动</span></div>
                <div class="settings-row"><span>拖拽中节流刷新</span><el-switch v-model="throttleConsoleResize" aria-label="控制台拖拽中节流刷新" /></div>
              </article>
            </section>
          </section>
        </div>
      </section>
    </section>

    <input ref="imageFileInput" class="prototype-hidden-input" type="file" accept="image/png,image/jpeg,image/webp" @change="loadBackgroundImage" />
    <input ref="jsonFileInput" class="prototype-hidden-input" type="file" accept="application/json,.json" @change="importTheme" />
  </main>
</template>

<style scoped>
.prototype-theme-canvas {
  position: relative;
  isolation: isolate;
  background-color: var(--prototype-background-color, var(--vrc-surface));
  background-image: var(--prototype-theme-background, none);
}

.prototype-framework-swatch {
  width: 100%;
  height: 24px;
}

.prototype-framework-swatch .prototype-theme-gradient {
  flex: 1 1 auto;
  width: auto;
  height: 24px;
  border-radius: 5px;
}

.prototype-framework-swatch i:not(.prototype-theme-gradient) {
  flex: 0 0 14px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
}

.prototype-theme-canvas :deep(.settings-card),
.prototype-theme-canvas :deep(.settings-tile) {
  background: var(--vrc-surface);
}

.prototype-theme-canvas::before {
  position: absolute;
  z-index: 0;
  inset: 0;
  pointer-events: none;
  content: "";
  border-radius: inherit;
}

.prototype-theme-canvas::before {
  inset: 0;
  background-image: var(--prototype-background-image, none);
  background-position: center;
  background-size: cover;
  opacity: 0.42;
}

.prototype-theme-canvas.has-custom-bg :deep(.settings-card),
.prototype-theme-canvas.has-custom-bg :deep(.settings-tile),
.prototype-theme-canvas.has-custom-bg :deep(.settings-theme-card),
.prototype-theme-canvas.has-custom-bg .prototype-preview-window,
.prototype-theme-canvas.has-custom-bg .prototype-theme-summary {
  background: color-mix(in srgb, var(--vrc-surface) 84%, transparent);
  backdrop-filter: blur(18px) saturate(1.25);
}

.prototype-theme-canvas.has-custom-bg :deep(.settings-theme-card.active) {
  background: color-mix(in srgb, var(--vrc-accent-soft) 88%, transparent);
}

.prototype-theme-canvas > * {
  position: relative;
  z-index: 1;
}

.prototype-theme-card {
  gap: 14px;
}

.prototype-theme-studio {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 360px;
  gap: 12px;
  align-items: stretch;
}

.prototype-theme-selection {
  display: grid;
  gap: 12px;
  min-width: 0;
}

.prototype-theme-summary {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 132px;
  gap: 10px 12px;
  align-items: center;
  padding: 12px;
  background: var(--vrc-surface);
  border: 1px solid var(--vrc-border);
  border-radius: 8px;
}

.prototype-theme-summary > div:first-child {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.prototype-eyebrow {
  width: fit-content;
  color: var(--vrc-accent);
  font-size: 10px;
  line-height: 14px;
}

.prototype-theme-summary strong {
  color: var(--vrc-text);
  font-size: 14px;
  font-weight: 400;
  line-height: 1.3;
}

.prototype-theme-summary small {
  color: var(--vrc-text-muted);
  font-size: 11px;
  line-height: 1.5;
}

.prototype-theme-summary-swatches {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px;
}

.prototype-theme-summary-swatches i {
  height: 42px;
  border: 1px solid var(--vrc-border);
  border-radius: 6px;
}

.prototype-theme-summary-meta {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.prototype-theme-summary-meta span {
  display: grid;
  gap: 2px;
  min-width: 0;
  padding-top: 8px;
  border-top: 1px solid var(--vrc-border);
}

.prototype-theme-summary-meta strong {
  overflow: hidden;
  color: var(--vrc-text);
  font-size: 12px;
  font-weight: 400;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.prototype-theme-summary-meta small {
  color: var(--vrc-text-muted);
  font-size: 10px;
}

.prototype-custom-settings,
.prototype-custom-settings :deep(*) {
  min-width: 0;
}

.prototype-theme-canvas :deep(.settings-theme-card-grid) {
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.prototype-theme-canvas :deep(.settings-theme-card) {
  min-height: 118px;
  padding: 12px;
  background: var(--vrc-surface);
  border-color: var(--vrc-border);
}

.prototype-theme-canvas :deep(.settings-theme-card:hover) {
  border-color: var(--vrc-border-strong);
}

.prototype-theme-canvas :deep(.settings-theme-card.active) {
  background: var(--vrc-surface);
  border-color: var(--vrc-active-border);
  box-shadow: none;
}

.prototype-theme-canvas :deep(.settings-theme-card-head) {
  align-items: center;
}

.prototype-theme-canvas :deep(.settings-theme-card-head strong) {
  font-weight: 400;
}

.prototype-theme-canvas :deep(.settings-theme-card-head small) {
  color: var(--vrc-text-muted);
  font-size: 10px;
}

.prototype-theme-canvas :deep(.settings-theme-card.active .settings-theme-card-head small) {
  color: var(--vrc-accent);
}

.prototype-theme-live-preview {
  min-width: 0;
}

.prototype-preview-window {
  display: grid;
  grid-template-rows: 34px auto minmax(0, 1fr);
  min-height: 100%;
  overflow: hidden;
  background: var(--vrc-surface);
  border: 1px solid var(--vrc-border);
  border-radius: 8px;
}

.prototype-preview-topbar,
.prototype-preview-toolbar,
.prototype-preview-row {
  display: grid;
  align-items: center;
}

.prototype-preview-topbar {
  grid-template-columns: 10px 10px 10px minmax(0, 1fr);
  gap: 6px;
  padding: 0 12px;
  background: color-mix(in srgb, var(--vrc-surface-muted) 84%, transparent);
  border-bottom: 1px solid var(--vrc-border);
}

.prototype-preview-topbar span {
  width: 8px;
  height: 8px;
  background: var(--vrc-border-strong);
  border-radius: 50%;
}

.prototype-preview-topbar strong {
  justify-self: end;
  color: var(--vrc-text-muted);
  font-size: 11px;
  font-weight: 400;
}

.prototype-preview-toolbar {
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px;
  padding: 13px 14px;
}

.prototype-preview-toolbar > div {
  display: grid;
  gap: 3px;
}

.prototype-preview-toolbar strong {
  color: var(--vrc-text);
  font-size: 12px;
  font-weight: 400;
}

.prototype-preview-toolbar small {
  color: var(--vrc-text-muted);
  font-size: 11px;
}

.prototype-preview-toolbar button {
  height: 30px;
  padding: 0 12px;
  color: #fff;
  background: var(--vrc-accent);
  border: 0;
  border-radius: 7px;
  font-size: 12px;
  font-weight: 400;
}

.prototype-preview-table {
  display: grid;
  align-content: start;
  margin: 0 12px 12px;
  overflow: hidden;
  border: 1px solid var(--vrc-border);
  border-radius: 7px;
}

.prototype-preview-row {
  grid-template-columns: minmax(104px, 1.35fr) minmax(90px, 1fr) 54px 58px;
  gap: 8px;
  min-height: 44px;
  padding: 0 10px;
  color: var(--vrc-text);
  background: var(--vrc-surface);
  border-top: 1px solid var(--vrc-border);
  font-size: 12px;
  font-weight: 400;
}

.prototype-preview-row.header {
  min-height: 36px;
  color: var(--vrc-text-muted);
  background: var(--vrc-surface-muted);
  border-top: 0;
  font-weight: 600;
}

.prototype-preview-row > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.prototype-preview-row > span:first-child {
  display: grid;
  gap: 1px;
}

.prototype-preview-row strong {
  overflow: hidden;
  color: var(--vrc-text);
  font-size: 12px;
  font-weight: 400;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.prototype-preview-row small {
  color: var(--vrc-text-subtle);
  font-size: 10px;
}

.prototype-preview-status {
  justify-self: center;
}

.prototype-preview-status.good {
  color: var(--vrc-success);
}

.prototype-preview-status.warn {
  color: var(--vrc-warning);
}

.prototype-preview-status.danger {
  color: var(--vrc-danger);
}

.prototype-custom-head {
  align-items: center;
}

.prototype-head-actions {
  display: flex;
  flex: 0 0 auto;
  gap: 6px;
}

.prototype-head-actions :deep(.el-button + .el-button) {
  margin-left: 0;
}

.prototype-custom-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 18px;
}

.prototype-setting-group {
  display: grid;
  align-content: start;
  gap: 0;
}

.prototype-background-group {
  padding-left: 18px;
  border-left: 1px solid var(--vrc-border);
}

.prototype-group-title {
  display: grid;
  gap: 3px;
  padding-bottom: 8px;
}

.prototype-group-title strong,
.prototype-setting-row strong {
  color: var(--vrc-text);
  font-size: 12px;
  font-weight: 400;
}

.prototype-group-title span,
.prototype-setting-row > div > span,
.prototype-semantic-colors label > span {
  color: var(--vrc-text-muted);
  font-size: 11px;
  font-weight: 400;
}

.prototype-setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-height: 44px;
  padding: 7px 0;
  border-top: 1px solid color-mix(in srgb, var(--vrc-border) 72%, transparent);
}

.prototype-setting-row > div:first-child {
  display: grid;
  gap: 3px;
}

.prototype-color-control,
.prototype-semantic-colors,
.prototype-semantic-colors label {
  display: flex;
  align-items: center;
}

.prototype-color-control {
  gap: 7px;
}

.prototype-tone-segmented {
  flex: 0 0 228px;
  width: 228px;
}

.prototype-color-chip {
  width: 20px;
  height: 20px;
  padding: 0;
  background: var(--chip-color);
  border: 2px solid var(--vrc-surface);
  border-radius: 5px;
  box-shadow: 0 0 0 1px var(--vrc-border);
  cursor: pointer;
}

.prototype-color-chip.active {
  box-shadow: 0 0 0 2px var(--vrc-accent);
}

.prototype-semantic-colors {
  gap: 10px;
}

.prototype-semantic-colors label {
  gap: 5px;
}

.prototype-hidden-input {
  display: none;
}

.prototype-app-shell {
  font-family: var(--prototype-ui-font);
  font-size: var(--prototype-ui-size);
}

.prototype-advanced-card,
.prototype-console-card {
  gap: 10px;
}

.prototype-reading-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 280px;
  gap: 14px;
  align-items: stretch;
}

.prototype-reading-controls,
.prototype-control-group {
  display: grid;
  align-content: start;
}

.prototype-reading-sample {
  display: grid;
  align-content: center;
  gap: 4px;
  min-height: 116px;
  padding: 12px 14px;
  background: var(--vrc-surface-muted);
  border: 1px solid var(--vrc-border);
  border-radius: 7px;
  font-family: var(--prototype-ui-font);
}

.prototype-reading-sample span,
.prototype-reading-sample small {
  color: var(--vrc-text-muted);
  font-size: 11px;
}

.prototype-reading-sample strong {
  color: var(--vrc-text);
  font-size: var(--prototype-ui-size);
  font-weight: 400;
}

.prototype-control-medium {
  flex: 0 0 148px;
  width: 148px;
}

.prototype-size-segmented {
  flex: 0 0 150px;
  width: 150px;
}

.prototype-console-head {
  align-items: center;
}

.prototype-console-head-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.prototype-preview-tag {
  flex: 0 0 auto;
  color: var(--vrc-text-muted);
  font-size: 11px;
}

.prototype-console-layout {
  display: grid;
  grid-template-columns: minmax(470px, .95fr) minmax(420px, 1.05fr);
  gap: 14px;
  align-items: stretch;
}

.prototype-console-controls {
  display: grid;
  gap: 12px;
}

.prototype-control-group + .prototype-control-group {
  padding-top: 10px;
  border-top: 1px solid var(--vrc-border);
}

.prototype-number-pair,
.prototype-cursor-control {
  display: flex;
  align-items: center;
  gap: 6px;
}

.prototype-number-pair :deep(.el-input-number) {
  width: 88px;
}

.prototype-palette-field {
  padding-top: 10px;
  border-top: 1px solid color-mix(in srgb, var(--vrc-border) 72%, transparent);
}

.prototype-palette-field-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 8px;
}

.prototype-palette-field-head > div,
.prototype-palette-name {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.prototype-palette-field-head strong,
.prototype-palette-name strong {
  color: var(--vrc-text);
  font-size: 11px;
  font-weight: 400;
}

.prototype-palette-field-head > div > strong {
  font-size: 12px;
}

.prototype-palette-field-head span,
.prototype-palette-field-head small,
.prototype-palette-name small {
  color: var(--vrc-text-muted);
  font-size: 10px;
  font-weight: 400;
}

.prototype-palette-field-head span,
.prototype-palette-field-head > small {
  font-size: 11px;
}

.prototype-console-palettes {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px;
}

.prototype-console-palettes button {
  display: grid;
  grid-template-columns: 38px minmax(0, 1fr);
  align-items: center;
  gap: 7px;
  min-width: 0;
  height: 44px;
  padding: 7px;
  color: var(--vrc-text);
  background: var(--vrc-surface);
  border: 1px solid var(--vrc-border);
  border-radius: 6px;
  cursor: pointer;
  text-align: left;
}

.prototype-console-palettes button.active {
  border-color: var(--vrc-accent);
  background: var(--vrc-surface);
  box-shadow: none;
}

.prototype-palette-gradient {
  width: 38px;
  height: 28px;
  border: 1px solid color-mix(in srgb, #fff 18%, transparent);
  border-radius: 4px;
}

.prototype-palette-name strong,
.prototype-palette-name small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.35;
}

.prototype-console-note {
  margin: 0;
  padding: 9px 10px;
  color: var(--vrc-text-muted);
  background: var(--vrc-surface-muted);
  border-radius: 6px;
  font-size: 11px;
  line-height: 1.55;
}

.prototype-watermark-slider {
  display: grid;
  grid-template-columns: 48px minmax(100px, 1fr) 38px;
  align-items: center;
  gap: 8px;
  min-height: 34px;
}

.prototype-watermark-slider > span,
.prototype-watermark-slider > strong {
  color: var(--vrc-text-muted);
  font-size: 11px;
  font-weight: 400;
}

.prototype-watermark-slider > strong {
  text-align: right;
}

.prototype-console-preview {
  position: relative;
  display: grid;
  grid-template-rows: 34px minmax(240px, 1fr) 28px;
  min-height: 350px;
  overflow: hidden;
  color: var(--console-preview-fg);
  background: var(--console-preview-bg);
  border: 1px solid var(--vrc-border-strong);
  border-radius: 7px;
}

.prototype-graphical-preview {
  --console-preview-bg: #070a09;
  --console-preview-fg: #d9e1dc;
  --console-preview-muted: #87918b;
  position: relative;
  display: grid;
  grid-template-rows: 34px minmax(240px, 1fr) 28px;
  min-height: 350px;
  overflow: hidden;
  color: var(--console-preview-fg);
  background: var(--console-preview-bg);
  border: 1px solid var(--vrc-border-strong);
  border-radius: 7px;
}

.prototype-graphical-screen {
  position: relative;
  z-index: 1;
  display: grid;
  place-content: center;
  gap: 22px;
  background: #020303;
  font-family: "SFMono-Regular", Consolas, monospace;
}

.prototype-login-mark {
  color: #d8ddd9;
  font-size: 18px;
  text-align: center;
}

.prototype-login-copy {
  display: flex;
  align-items: center;
  gap: 7px;
  color: #b8c1bb;
  font-size: 12px;
}

.prototype-login-copy i {
  width: 7px;
  height: 14px;
  background: #b8c1bb;
  animation: prototype-cursor-blink 1.05s steps(1) infinite;
}

.prototype-console-toolbar,
.prototype-console-status {
  position: relative;
  z-index: 3;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 10px;
  color: var(--console-preview-muted);
  background: color-mix(in srgb, var(--console-preview-bg) 88%, var(--console-preview-fg));
  font-size: 11px;
}

.prototype-console-toolbar {
  border-bottom: 1px solid color-mix(in srgb, var(--console-preview-fg) 16%, transparent);
}

.prototype-console-toolbar > span {
  color: var(--console-preview-fg);
}

.prototype-console-status {
  border-top: 1px solid color-mix(in srgb, var(--console-preview-fg) 13%, transparent);
}

.prototype-terminal-content {
  position: relative;
  z-index: 1;
  display: grid;
  align-content: start;
  gap: 3px;
  padding: 15px;
  font-family: var(--console-preview-font);
  font-size: var(--console-preview-size);
  line-height: var(--console-preview-line-height);
  white-space: nowrap;
}

.prototype-terminal-content > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.prototype-terminal-content .muted { color: var(--console-preview-muted); }
.prototype-terminal-content .success { color: var(--console-preview-success); }
.prototype-terminal-content em { color: var(--console-preview-accent); font-style: normal; }

.prototype-terminal-cursor {
  display: inline-block;
  width: .66em;
  height: 1.05em;
  margin-left: 2px;
  vertical-align: -.18em;
  background: var(--console-preview-accent);
  font-style: normal;
}

.prototype-terminal-cursor.bar { width: 2px; }
.prototype-terminal-cursor.underline { height: 2px; vertical-align: -.08em; }
.prototype-terminal-cursor.blink { animation: prototype-cursor-blink 1.05s steps(1) infinite; }

.prototype-watermark-layer {
  position: absolute;
  z-index: 2;
  inset: 35px 0 29px;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-content: space-around;
  gap: 22px 8px;
  overflow: hidden;
  pointer-events: none;
}

.prototype-watermark-layer span {
  color: var(--console-preview-fg);
  font-family: var(--console-preview-font);
  font-size: 10px;
  line-height: 1;
  text-align: center;
  white-space: nowrap;
  opacity: var(--watermark-opacity);
  transform: rotate(-18deg);
}

.prototype-graphical-watermark {
  inset: 35px 0 29px;
}

.prototype-app-shell :deep(.el-switch) {
  --el-switch-on-color: var(--vrc-accent);
  --el-switch-off-color: var(--vrc-border-strong);
  flex: 0 0 34px;
  width: 34px;
  height: 20px;
}

.prototype-app-shell :deep(.el-switch__core) {
  width: 34px;
  min-width: 34px;
  height: 20px;
  border: 0;
}

.prototype-app-shell :deep(.el-switch__action) {
  width: 16px;
  height: 16px;
}

.prototype-app-shell :deep(.el-select__wrapper),
.prototype-app-shell :deep(.el-input__wrapper) {
  min-height: 30px;
  background: var(--vrc-surface-muted);
  border-radius: 7px;
  box-shadow: 0 0 0 1px transparent inset;
}

.prototype-app-shell :deep(.el-select__wrapper:hover),
.prototype-app-shell :deep(.el-input__wrapper:hover),
.prototype-app-shell :deep(.el-select__wrapper.is-focused),
.prototype-app-shell :deep(.el-input__wrapper.is-focus) {
  background: var(--vrc-surface-muted);
  box-shadow: 0 0 0 1px var(--vrc-border-strong) inset;
}

.prototype-app-shell.reduce-motion *,
.prototype-app-shell.reduce-motion *::before,
.prototype-app-shell.reduce-motion *::after {
  scroll-behavior: auto !important;
  animation-duration: .01ms !important;
  animation-iteration-count: 1 !important;
  transition-duration: .01ms !important;
}

@keyframes prototype-cursor-blink {
  50% { opacity: 0; }
}

@media (max-width: 1380px) {
  .prototype-theme-canvas :deep(.settings-theme-card-grid) {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .prototype-custom-grid {
    grid-template-columns: 1fr;
    gap: 12px;
  }

  .prototype-background-group {
    padding-top: 12px;
    padding-left: 0;
    border-top: 1px solid var(--vrc-border);
    border-left: 0;
  }

  .prototype-console-layout {
    grid-template-columns: 1fr;
  }

  .prototype-console-preview {
    min-height: 320px;
  }
}

@media (max-width: 860px) {
  .prototype-theme-studio {
    grid-template-columns: 1fr;
  }

  .prototype-theme-live-preview {
    min-height: 360px;
  }

  .prototype-theme-canvas :deep(.settings-theme-card-grid) {
    grid-template-columns: 1fr;
  }

  .prototype-console-head {
    align-items: flex-start;
    flex-direction: column;
  }

  .prototype-console-head-actions {
    width: 100%;
    justify-content: space-between;
  }

  .prototype-console-palettes {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .prototype-palette-field-head {
    align-items: flex-start;
    flex-direction: column;
    gap: 4px;
  }

  .prototype-reading-grid {
    grid-template-columns: 1fr;
  }

  .prototype-setting-row {
    align-items: flex-start;
    flex-direction: column;
  }

  .prototype-control-medium,
  .prototype-size-segmented {
    width: 100%;
  }
}

/* 背景与壁纸 */
.prototype-wallpaper-body {
  display: grid;
  gap: 4px;
}

.prototype-bg-preview {
  position: relative;
  height: 72px;
  margin-bottom: 8px;
  overflow: hidden;
  border: 1px solid var(--vrc-border);
  border-radius: 10px;
  background-color: var(--vrc-surface-muted);
}

.prototype-bg-preview-cards {
  position: absolute;
  inset: 10px 12px auto;
  display: grid;
  gap: 6px;
}

.prototype-bg-preview-cards i {
  display: block;
  width: 62%;
  height: 22px;
  border: 1px solid var(--vrc-border);
  border-radius: 6px;
  background: color-mix(in srgb, var(--vrc-surface) 84%, transparent);
  backdrop-filter: blur(6px);
}

.prototype-bg-preview-cards i.short {
  width: 44%;
}

.prototype-bg-preview-tip {
  position: absolute;
  right: 10px;
  bottom: 8px;
  padding: 2px 8px;
  border-radius: 5px;
  background: color-mix(in srgb, var(--vrc-surface) 80%, transparent);
  color: var(--vrc-text-muted);
  font-size: 10px;
}

.prototype-gallery-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 2px 8px;
}

.prototype-gallery-head strong {
  font-size: 12px;
  color: var(--vrc-text);
}

.prototype-gallery-head span {
  font-size: 11px;
  color: var(--vrc-text-muted);
}

.prototype-wallpaper-grid {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 8px;
}

.prototype-wallpaper-item {
  display: grid;
  gap: 6px;
  cursor: pointer;
}

.prototype-wallpaper-thumb {
  position: relative;
  aspect-ratio: 16 / 10;
  border: 1px solid var(--vrc-border);
  border-radius: 8px;
  background-position: center;
  background-size: cover;
  transition: box-shadow 0.18s ease, transform 0.18s ease;
}

.prototype-wallpaper-item:hover .prototype-wallpaper-thumb {
  transform: translateY(-1px);
  box-shadow: 0 4px 14px rgba(29, 36, 48, 0.14);
}

.prototype-wallpaper-item.active .prototype-wallpaper-thumb {
  border-color: transparent;
  box-shadow: 0 0 0 2px var(--vrc-accent);
}

.prototype-wallpaper-name {
  color: var(--vrc-text-muted);
  font-size: 11px;
  text-align: center;
}

.prototype-wallpaper-item.active .prototype-wallpaper-name {
  color: var(--vrc-text);
  font-weight: 600;
}

.prototype-wallpaper-star {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: rgba(20, 24, 32, 0.45);
  color: #fff;
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.prototype-wallpaper-item:hover .prototype-wallpaper-star,
.prototype-wallpaper-star.on {
  opacity: 1;
}

.prototype-wallpaper-star.on {
  background: rgba(20, 24, 32, 0.6);
  color: #ffd666;
}

.prototype-wallpaper-mood {
  position: absolute;
  bottom: 6px;
  left: 6px;
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(20, 24, 32, 0.55);
  color: #fff;
  font-size: 10px;
}

.prototype-upload-row {
  display: grid;
  gap: 6px;
  padding-top: 10px;
}

.prototype-dropzone {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 12px 14px;
  border: 1px dashed var(--vrc-border-strong);
  border-radius: 10px;
  background: var(--vrc-surface-muted);
  cursor: pointer;
  transition: border-color 0.15s ease;
}

.prototype-dropzone:hover {
  border-color: var(--vrc-accent);
}

.prototype-dropzone-title {
  color: var(--vrc-text);
  font-size: 12px;
  font-weight: 600;
}

.prototype-dropzone-meta,
.prototype-image-meta {
  color: var(--vrc-text-muted);
  font-size: 11px;
}

.prototype-extract-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-top: 8px;
}

.prototype-extract-row > strong {
  font-size: 12px;
  color: var(--vrc-text);
}

.prototype-extract-colors {
  display: flex;
  align-items: center;
  gap: 8px;
}

.prototype-extract-chip {
  width: 22px;
  height: 22px;
  padding: 0;
  border: 1px solid var(--vrc-border-strong);
  border-radius: 6px;
  cursor: pointer;
  transition: transform 0.15s ease;
}

.prototype-extract-chip:hover {
  transform: scale(1.14);
}

.prototype-control-meta {
  color: var(--vrc-text-muted);
  font-size: 11px;
  white-space: nowrap;
}

.prototype-dual-row {
  display: grid;
  grid-template-columns: 1fr 1fr auto;
  align-items: center;
  gap: 10px;
  padding: 6px 2px 2px;
}

.prototype-dual-slot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px;
  border: 1px solid var(--vrc-border);
  border-radius: 8px;
  cursor: pointer;
}

.prototype-dual-slot.armed {
  border-color: var(--vrc-accent);
  box-shadow: 0 0 0 1px var(--vrc-accent);
}

.prototype-dual-thumb {
  width: 64px;
  height: 40px;
  flex: 0 0 64px;
  border: 1px solid var(--vrc-border);
  border-radius: 6px;
  background-color: var(--vrc-surface-muted);
  background-position: center;
  background-size: cover;
}

.prototype-dual-thumb.dark {
  background-color: #171a21;
}

.prototype-dual-meta {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.prototype-dual-meta strong {
  font-size: 12px;
  color: var(--vrc-text);
}

.prototype-dual-meta span {
  overflow: hidden;
  color: var(--vrc-text-muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.prototype-dual-tip {
  color: var(--vrc-text-muted);
  font-size: 11px;
}

.prototype-bg-toggles {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 28px;
  padding-top: 10px;
}

.prototype-bg-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
}

.prototype-bg-toggle-label {
  color: var(--vrc-text);
  font-size: 12px;
  white-space: nowrap;
}

.prototype-rotation-interval {
  width: 118px;
}

/* 渐变 */
.prototype-gradient-recs {
  display: flex;
  align-items: center;
  gap: 8px;
}

.prototype-gradient-rec {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px 4px 4px;
  border: 1px solid var(--vrc-border);
  border-radius: 7px;
  background: var(--vrc-surface-muted);
  color: var(--vrc-text);
  cursor: pointer;
  font-size: 11px;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.prototype-gradient-rec:hover {
  border-color: var(--vrc-border-strong);
}

.prototype-gradient-rec.active {
  border-color: var(--vrc-accent);
  box-shadow: 0 0 0 1px var(--vrc-accent);
}

.prototype-gradient-rec i {
  width: 26px;
  height: 16px;
  border: 1px solid var(--vrc-border);
  border-radius: 5px;
}

.prototype-gradient-builder {
  display: grid;
  gap: 10px;
  padding: 4px 0 6px;
}

.prototype-gradient-angle {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 320px;
}

.prototype-gradient-angle :deep(.el-slider) {
  flex: 1;
}

.prototype-gradient-stops {
  display: flex;
  align-items: center;
  gap: 8px;
}

.prototype-gradient-stops :deep(.el-button + .el-button) {
  margin-left: 0;
}

/* 字体 */
.prototype-font-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  width: 100%;
}

.prototype-font-option-name {
  font-size: 13px;
}

.prototype-font-option-tag {
  font-size: 10px;
  color: var(--vrc-text-subtle);
}

.prototype-font-option-tag.bundled {
  color: var(--vrc-accent);
}

@media (max-width: 1380px) {
  .prototype-wallpaper-grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }

  .prototype-dual-row {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 860px) {
  .prototype-wallpaper-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .prototype-gradient-angle {
    width: 100%;
  }
}
</style>
