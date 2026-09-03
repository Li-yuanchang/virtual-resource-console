<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { ArrowLeft, Brush, Check, Connection, Delete, Download, Loading, Picture, Plus, Refresh, Search, Setting, Tickets, Upload } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import ActivityLogTable from "./components/ActivityLogTable.vue";
import ConsoleDialog from "./components/ConsoleDialog.vue";
import HostDiagnosticsDialog from "./components/HostDiagnosticsDialog.vue";
import HostVmPanel from "./components/HostVmPanel.vue";
import UpdateCenterPanel from "./components/UpdateCenterPanel.vue";
import VrcLogoMark from "./components/VrcLogoMark.vue";
import VrcToolbarIcon from "./components/VrcToolbarIcon.vue";
import VmProvisioningDialog from "./components/VmProvisioningDialog.vue";
import VmRenameDialog from "./components/VmRenameDialog.vue";
import VmResizeDialog from "./components/VmResizeDialog.vue";
import VmBootEntryDialog from "./components/VmBootEntryDialog.vue";
import VmScheduleDialog from "./components/VmScheduleDialog.vue";
import VrcVmActionIcon from "./components/VrcVmActionIcon.vue";
import { resolveVmConsoleTarget, resolveVmGraphConsoleTarget, type VmConsoleTarget } from "./domain/consoleStrategies";
import { confirmVrcAction } from "./domain/confirmAction";
import { getProviderBrand } from "./domain/providerBrand";
import { isoSourceLabel } from "./domain/provisioningStrategies";
import { SecureRequestError, secureJsonRequest } from "./domain/secureRequest";
import { createVmListReconciler } from "./domain/vmListReconciliation";
import { vmPowerActionRowPatch } from "./domain/vmPowerState";
import {
  buildStartKernelReminder,
  cachedBootEntryKernelCount,
  rememberBootEntryKernelCount,
} from "./domain/bootEntryReminder";
import type {
  HostsResponse,
  GuestBootEntryList,
  GuestBootEntrySelection,
  GuestStorageInventory,
  GuestStorageResponse,
  HostNode,
  HostDiagnosticRepairAction,
  HostVmSnapshotGroup,
  HostVmSnapshotsResponse,
  IpPoolPolicy,
  IpPoolPolicyResponse,
  RuntimeIpPoolPolicy,
  IpLeaseReservationResponse,
  IsoImage,
  IsoImagesResponse,
  ProviderDescriptor,
  ProviderDescriptorsResponse,
  ProviderType,
  PowerState,
  StorageRepository,
  ResourceCapacitySummary,
  StoredConnectionSummary,
  VmInventorySummary,
  VmNode,
  VmSearchIndexItem,
  VmDisk,
  VmDisksResponse,
  VmPowerAction,
  VmResizeRequest,
  VmResizeResult,
  VmSystemCredentials,
  VmCreateRequest,
  VmProvisionCreatedVm,
  VmProvisionResponse,
  ProvisionPreflightResponse,
  ProvisionTask,
  ProvisionTaskResponse,
  VmsResponse,
  VmSearchIndexResponse,
} from "./types";

type HostNodeItem = HostsResponse["hosts"][number];

interface HostOverviewRow {
  key: string;
  connection: StoredConnectionSummary;
  inventory: HostsResponse;
  host: HostNodeItem;
  summary: VmInventorySummary | null;
  resourceCapacity: ResourceCapacitySummary | null;
  status: "loading" | "ready" | "error";
  error?: string;
}

interface BrowserStoredConnection extends StoredConnectionSummary {
  password: string;
  storage: "browser-local";
}

interface ChromeExtensionLaunchConnection {
  id: string;
  name?: string;
  providerType: ProviderType;
  host: string;
  port: number;
  username: string;
  password: string;
}

interface VmSearchCacheEntry {
  items: VmSearchIndexItem[];
  updatedAt: number;
  loading: boolean;
  error?: string;
}

interface VmActionResponse {
  operatedAt: string;
  result: {
    vmId: string;
    action: VmPowerAction;
    accepted: boolean;
    message: string;
    command?: string;
  };
  stoppedProvisionTaskIds?: string[];
}

interface VmRenameResponse {
  operatedAt: string;
  result: {
    vmId: string;
    previousName: string;
    newName: string;
    accepted: boolean;
    message: string;
  };
}

interface VmResizeResponse {
  operatedAt: string;
  result: VmResizeResult;
}

interface VmSummaryResponse {
  collectedAt: string;
  summary: VmInventorySummary;
  resourceCapacity?: ResourceCapacitySummary;
  source?: "cache" | "live";
  cacheUpdatedAt?: string;
  refreshing?: boolean;
}

type InventoryEvent =
  | {
      type: "vm.patch";
      connectionId?: string;
      providerType: ProviderType;
      hostId?: string;
      vmId: string;
      patch: Partial<VmNode>;
      eventSeq: number;
      updatedAt: string;
    }
  | {
      type: "vm.upsert";
      connectionId?: string;
      providerType: ProviderType;
      hostId?: string;
      vm: VmNode;
      eventSeq: number;
      updatedAt: string;
    }
  | {
      type: "vm.delete";
      connectionId?: string;
      providerType: ProviderType;
      hostId?: string;
      vmId: string;
      eventSeq: number;
      updatedAt: string;
    }
  | {
      type: "host.patch";
      connectionId?: string;
      providerType: ProviderType;
      hostId?: string;
      patch: Partial<HostNodeItem>;
      eventSeq: number;
      updatedAt: string;
    }
  | {
      type: "summary.patch";
      connectionId?: string;
      providerType: ProviderType;
      hostId?: string;
      summary: VmInventorySummary;
      resourceCapacity?: ResourceCapacitySummary;
      eventSeq: number;
      updatedAt: string;
    };

interface VmActionState {
  action: VmPowerAction;
  status: "pending" | "running" | "success" | "error";
  message?: string;
}

interface HostResourceFingerprint {
  running: number;
  runningVcpu: number;
  totalVms: number;
  memoryFreeBytes: number;
  storageUsedGiB: number;
}

interface ProvisioningProgressState {
  title: string;
  message: string;
  status: "running" | "success" | "warning" | "error";
}

const providerBootstrapPorts: Record<ProviderType, number> = {
  xenserver: 22,
  vmware: 443,
  proxmox: 8006,
  libvirt: 22,
};

interface ProvisionConsoleTargetItem {
  key: string;
  name: string;
  ip?: string;
  status: ProvisionTask["vms"][number]["status"];
  message?: string;
  progressPercent?: number;
  currentStep?: ProvisionTask["vms"][number]["currentStep"];
  installPackageDone?: number;
  installPackageTotal?: number;
  target: VmConsoleTarget | null;
}

interface ActivityEntry {
  id: string;
  time: string;
  title: string;
  detail?: string;
  target?: string;
  request?: string;
  command?: string;
  status: "info" | "pending" | "success" | "warning" | "error";
  action?: string;
  providerType?: string;
  connectionId?: string;
  connectionName?: string;
}

interface ConsoleUploadResultEvent {
  vmName: string;
  vmIp: string;
  status: "success" | "error";
  message: string;
  files: string[];
  remotePaths: string[];
}

interface PersistentAuditRecord {
  id: string;
  time: string;
  title: string;
  detail?: string;
  target?: string;
  request?: string;
  command?: string;
  status: ActivityEntry["status"];
  action?: string;
  providerType?: string;
  connectionId?: string;
  connectionName?: string;
}

type ActivityStatusFilter = "all" | ActivityEntry["status"];
type UiTheme = "graphite-sage" | "basalt-copper" | "mist-teal" | "prism-frost" | "aurora-mint" | "neon-carbon";
type UiToneMode = "system" | "light" | "dark";
type UiBackgroundMode = "default" | "solid" | "image";
type UiFontPreset = "system" | "inter" | "humanist" | "lxgw-wenkai" | "compact";
type ConsoleThemeMode = "vrc" | "tokyo-night" | "catppuccin" | "dracula" | "nord" | "rose-pine" | "solarized" | "light";
type ConsoleFontPreset = "system-mono" | "jetbrains" | "cascadia" | "menlo";
type ConsolePreviewMode = "graphical" | "cli";
type ConsoleScaleMode = "local" | "remote";
type ConsoleQuality = "auto" | "high" | "smooth";
type WatermarkScope = "console" | "workspace";
type WatermarkDensity = "sparse" | "standard" | "dense";
type WorkspaceMode = "empty" | "overview" | "connection" | "settings";
type SettingsPanel = "appearance" | "connection" | "templates" | "ipPools" | "chromeExtension" | "updates" | "maintenance" | "logs";
type StorageDisplayMode = "overall" | "hba-lvm";
type VmPowerFilter = "all" | "running" | "stopped";
type TableSortOrder = "ascending" | "descending" | null;
type HostOverviewSortKey = "hostName" | "cpuUsage" | "memoryFree" | "storageFree" | "vmTotal";
type AccountImportMode = "excel" | "json" | "fixed";
type AccountImportStatus = "new" | "update" | "error";
type ChromeExtensionProviderType = Extract<ProviderType, "xenserver" | "vmware" | "proxmox">;
type ChromeExtensionServiceMode = "intranet" | "local";
type ChromeExtensionTab = "service" | "vault";

interface UiPreferences {
  theme: UiTheme;
  toneMode: UiToneMode;
  accentColor: string;
  successColor: string;
  warningColor: string;
  dangerColor: string;
  backgroundMode: UiBackgroundMode;
  backgroundColor: string;
  backgroundImageName: string;
  backgroundImageMime: string;
  backgroundImageUpdatedAt: string;
  backgroundOpacity: number;
  backgroundBlur: number;
  backgroundOverlay: number;
  showIconTooltips: boolean;
  truncateLongNames: boolean;
  throttleConsoleResize: boolean;
  storageDisplayMode: StorageDisplayMode;
  uiFontPreset: UiFontPreset;
  uiFontSize: number;
  reduceMotion: boolean;
  consoleTheme: ConsoleThemeMode;
  consoleFontPreset: ConsoleFontPreset;
  consoleFontSize: number;
  consoleLineHeight: number;
  consoleCursorStyle: "block" | "underline" | "bar";
  consoleCursorBlink: boolean;
  consoleScaleMode: ConsoleScaleMode;
  consoleQuality: ConsoleQuality;
  consoleWatermarkEnabled: boolean;
  consoleWatermarkScope: WatermarkScope;
  consoleWatermarkDensity: WatermarkDensity;
  consoleWatermarkOpacity: number;
}

interface ChromeExtensionServiceSettings {
  mode: ChromeExtensionServiceMode;
  scheme: "http" | "https";
  host: string;
  port: number;
}

interface ChromeExtensionLocalConnection {
  id: string;
  name: string;
  providerType: ChromeExtensionProviderType;
  host: string;
  username: string;
  storage: "local-encrypted";
  status: "ready" | "pending";
  lastUsed: string;
}

interface ChromeExtensionDraftConnection {
  providerType: ChromeExtensionProviderType;
  name: string;
  host: string;
  username: string;
  password: string;
}

interface ConnectionPreferences {
  selectedConnectionId: string;
  providerType: ProviderType;
  host: string;
  port: number;
  username: string;
  connectionName: string;
}

interface AppPreferences {
  ui: UiPreferences;
  connection: ConnectionPreferences;
}

interface ApiHealthResponse {
  runtimeMode?: "web" | "electron" | "chrome-native";
  connectionStore?: {
    persistentEnabled?: boolean;
  };
}

interface AppearanceImportConfig {
  [key: string]: unknown;
  baseTheme?: unknown;
  theme?: unknown;
  toneMode?: unknown;
  colors?: Record<string, unknown>;
  background?: Record<string, unknown>;
  typography?: Record<string, unknown>;
  console?: Record<string, unknown>;
}

interface AccountImportDraft {
  rowNo: number;
  providerType: ProviderType | "";
  host: string;
  port: number;
  name: string;
  username: string;
  password: string;
  status: AccountImportStatus;
  statusText: string;
  statusDetail: string;
  existingName?: string;
  matchedId?: string;
}

interface IpPoolEditorDraft {
  id: string;
  name: string;
  prefix: string;
  gateway: string;
  startHost: number;
  endHost: number;
  hostPrefixesText: string;
  networkName: string;
  dnsText: string;
  vlan: string;
}

type MaintenanceCleanupDecision = "eligible" | "retained" | "skipped" | "cleaned" | "failed";

interface MaintenanceGeneratedIsoEntry {
  id: string;
  taskId: string;
  providerType: ProviderType;
  connectionId?: string;
  hostId?: string;
  vmName: string;
  vmIp?: string;
  isoName: string;
  isoPath: string;
  isoVdiUuid?: string;
  status: "creating" | "uploaded" | "attached" | "installed" | "failed" | "deleted";
  createdAt: string;
  updatedAt: string;
  cleanupAfter?: string;
  decision: MaintenanceCleanupDecision;
  reason: string;
  localBytes: number;
}

interface MaintenanceGeneratedIsoReport {
  generatedAt: string;
  retentionDays: number;
  summary: {
    total: number;
    eligible: number;
    retained: number;
    skipped: number;
    cleaned: number;
    failed: number;
    localBytes: number;
  };
  items: MaintenanceGeneratedIsoEntry[];
}

const VM_SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const OVERVIEW_SEARCH_APPLY_DEBOUNCE_MS = 180;
const OVERVIEW_VM_SEARCH_DEBOUNCE_MS = 300;
const OVERVIEW_VM_SEARCH_STABLE_HOLD_MS = 700;
const VM_SEARCH_REVALIDATE_INTERVAL_MS = 2_000;
const VM_SEARCH_REVALIDATE_MAX_ATTEMPTS = 15;
const INVENTORY_SNAPSHOT_REVALIDATE_INTERVAL_MS = 2_000;
const INVENTORY_SNAPSHOT_REVALIDATE_MAX_ATTEMPTS = 15;
const VRC_TOAST_DURATION_MS = 3000;
const ISO_TABLE_MAX_HEIGHT = 420;
const activityStatusOptions: ActivityStatusFilter[] = ["all", "pending", "success", "warning", "error", "info"];
const activityStatusSegmentOptions = activityStatusOptions.map((status) => ({
  label: activityStatusLabel(status),
  value: status,
}));
const themeOptions: Array<{
  value: UiTheme;
  label: string;
  name: string;
  tone: string;
  description: string;
  colors: [string, string, string, string];
  accentColor: string;
  successColor: string;
  warningColor: string;
  dangerColor: string;
}> = [
  {
    value: "graphite-sage",
    label: "石墨青",
    name: "石墨青",
    tone: "当前默认",
    description: "低饱和灰绿，适合长时间查看资源和状态。",
    colors: ["#f5f6f2", "#fbfbf7", "#426b57", "#27302a"],
    accentColor: "#426b57",
    successColor: "#477a45",
    warningColor: "#b77935",
    dangerColor: "#a5483d",
  },
  {
    value: "basalt-copper",
    label: "玄武铜",
    name: "玄武铜",
    tone: "暖色",
    description: "暖灰底配铜色强调，层级清楚但不刺眼。",
    colors: ["#f4f2ed", "#fcfaf5", "#9b5f35", "#2f2b24"],
    accentColor: "#9b5f35",
    successColor: "#4f7549",
    warningColor: "#b77935",
    dangerColor: "#a34f42",
  },
  {
    value: "mist-teal",
    label: "雾青",
    name: "雾青",
    tone: "清爽",
    description: "偏冷的青灰色，适合信息密度较高的列表。",
    colors: ["#f3f6f4", "#fbfcfa", "#2f6f68", "#22302d"],
    accentColor: "#2f6f68",
    successColor: "#4d7a50",
    warningColor: "#ad7833",
    dangerColor: "#a3483f",
  },
  {
    value: "prism-frost",
    label: "冰川光谱",
    name: "冰川光谱",
    tone: "现代渐变",
    description: "冷白底融合蓝、青与柔紫，适合现代化资源工作台。",
    colors: ["#edf2f6", "#fbfcfe", "#527fa8", "#263441"],
    accentColor: "#527fa8",
    successColor: "#46856e",
    warningColor: "#b17a35",
    dangerColor: "#ad5260",
  },
  {
    value: "aurora-mint",
    label: "极光薄荷",
    name: "极光薄荷",
    tone: "清透渐变",
    description: "薄荷青、湖蓝与珊瑚色过渡，明亮但保留业务层级。",
    colors: ["#edf5f2", "#fbfdfc", "#397d78", "#263734"],
    accentColor: "#397d78",
    successColor: "#4b8668",
    warningColor: "#b77734",
    dangerColor: "#b25355",
  },
  {
    value: "neon-carbon",
    label: "霓虹夜幕",
    name: "霓虹夜幕",
    tone: "深色渐变",
    description: "碳黑界面配青蓝与洋红光谱，适合低光环境。",
    colors: ["#11151c", "#1a2029", "#5d9fe3", "#e7edf5"],
    accentColor: "#5d9fe3",
    successColor: "#64bd91",
    warningColor: "#d49a51",
    dangerColor: "#d36c7b",
  },
];
const accentColorPresets = ["#426b57", "#2f6f68", "#315f92", "#6a5b88", "#9b5f35", "#8a4f5d"];
const uiFontOptions: Array<{ value: UiFontPreset; label: string; family: string; badge: "内置" | "本机"; note: string }> = [
  { value: "system", label: "跟随系统", family: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\", sans-serif", badge: "本机", note: "随操作系统，macOS 为苹方，Windows 为雅黑" },
  { value: "inter", label: "Inter", family: "\"Inter\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif", badge: "内置", note: "现代屏显无衬线，数字与英文锐利，中文回退黑体" },
  { value: "humanist", label: "思源黑体", family: "\"Source Han Sans SC\", \"Noto Sans SC\", \"PingFang SC\", sans-serif", badge: "内置", note: "Adobe 与 Google 联合发布，字形中性，字重齐全" },
  { value: "lxgw-wenkai", label: "霞鹜文楷", family: "\"LXGW WenKai Screen\", \"LXGW WenKai\", \"Kaiti SC\", serif", badge: "内置", note: "开源楷体，阅读温润，适合长时间盯屏" },
  { value: "compact", label: "紧凑字体", family: "\"DIN Next\", \"Roboto Condensed\", \"PingFang SC\", sans-serif", badge: "本机", note: "窄体字形，单行容纳更多字符" },
];
const consoleThemeOptions: Array<{
  value: ConsoleThemeMode;
  label: string;
  source: string;
  description: string;
  swatches: string[];
  colors: {
    background: string;
    surface: string;
    toolbar: string;
    border: string;
    borderStrong: string;
    text: string;
    selection: string;
    success: string;
  };
}> = [
  {
    value: "vrc",
    label: "VRC 墨青",
    source: "默认",
    description: "低对比墨青终端，适合长期运维操作。",
    swatches: ["#101715", "#315b4a", "#73a486", "#dce8df"],
    colors: {
      background: "#101715", surface: "#101715", toolbar: "#1b2823", border: "#2d4037", borderStrong: "#24362e",
      text: "#dce8df", selection: "#315b4a", success: "#79b88e",
    },
  },
  {
    value: "tokyo-night",
    label: "Tokyo Night",
    source: "GitHub",
    description: "蓝紫夜色配色，命令层级清晰。",
    swatches: ["#1a1b26", "#7aa2f7", "#bb9af7", "#7dcfff"],
    colors: {
      background: "#1a1b26", surface: "#1a1b26", toolbar: "#24283b", border: "#3b4261", borderStrong: "#2f354d",
      text: "#c0caf5", selection: "#364a82", success: "#9ece6a",
    },
  },
  {
    value: "catppuccin",
    label: "Catppuccin",
    source: "Mocha",
    description: "柔和深色终端，适合长时间阅读。",
    swatches: ["#1e1e2e", "#89b4fa", "#cba6f7", "#f5c2e7"],
    colors: {
      background: "#1e1e2e", surface: "#1e1e2e", toolbar: "#29293f", border: "#45475a", borderStrong: "#36364d",
      text: "#cdd6f4", selection: "#45475a", success: "#a6e3a1",
    },
  },
  {
    value: "dracula",
    label: "Dracula",
    source: "GitHub",
    description: "高辨识紫青配色，强调状态输出。",
    swatches: ["#282a36", "#8be9fd", "#bd93f9", "#ff79c6"],
    colors: {
      background: "#282a36", surface: "#282a36", toolbar: "#343746", border: "#4c5062", borderStrong: "#3f4252",
      text: "#f8f8f2", selection: "#44475a", success: "#50fa7b",
    },
  },
  {
    value: "nord", label: "Nord", source: "Arctic Ice", description: "克制冷灰配色，适合低光环境。",
    swatches: ["#2e3440", "#5e81ac", "#88c0d0", "#8fbcbb"],
    colors: { background: "#2e3440", surface: "#2e3440", toolbar: "#3b4252", border: "#4c566a", borderStrong: "#434c5e", text: "#eceff4", selection: "#4c566a", success: "#a3be8c" },
  },
  {
    value: "rose-pine", label: "Rose Pine", source: "Moon", description: "低饱和紫灰配色，层次柔和。",
    swatches: ["#232136", "#3e8fb0", "#c4a7e7", "#ea9a97"],
    colors: { background: "#232136", surface: "#232136", toolbar: "#2d2945", border: "#44415a", borderStrong: "#39354d", text: "#e0def4", selection: "#393552", success: "#9ccfd8" },
  },
  {
    value: "solarized", label: "Solarized", source: "Dark", description: "经典低对比配色，日志阅读稳定。",
    swatches: ["#002b36", "#268bd2", "#2aa198", "#b58900"],
    colors: { background: "#002b36", surface: "#002b36", toolbar: "#073642", border: "#31535b", borderStrong: "#1d4750", text: "#93a1a1", selection: "#28535c", success: "#859900" },
  },
  {
    value: "light", label: "Paper", source: "浅色", description: "亮光环境与截图使用的浅色终端。",
    swatches: ["#f6f7f5", "#b7c9be", "#658e78", "#29302c"],
    colors: { background: "#f6f7f5", surface: "#f6f7f5", toolbar: "#e8ede9", border: "#c9d2cc", borderStrong: "#b3bfb7", text: "#29302c", selection: "#b7c9be", success: "#477a45" },
  },
];
const consoleFontOptions: Array<{ value: ConsoleFontPreset; label: string; family: string }> = [
  { value: "system-mono", label: "系统等宽", family: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" },
  { value: "jetbrains", label: "JetBrains Mono（本机）", family: "\"JetBrains Mono\", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" },
  { value: "cascadia", label: "Cascadia Mono（本机）", family: "\"Cascadia Mono\", Consolas, ui-monospace, monospace" },
  { value: "menlo", label: "Menlo（macOS）", family: "Menlo, Monaco, \"SF Mono\", ui-monospace, monospace" },
];
const defaultUiPreferences: UiPreferences = {
  theme: normalizeTheme(document.documentElement.dataset.theme || localStorage.getItem("vrc.theme")),
  toneMode: "light",
  accentColor: "#426b57",
  successColor: "#477a45",
  warningColor: "#b77935",
  dangerColor: "#a5483d",
  backgroundMode: "default",
  backgroundColor: "#edf1ee",
  backgroundImageName: "",
  backgroundImageMime: "",
  backgroundImageUpdatedAt: "",
  backgroundOpacity: 32,
  backgroundBlur: 0,
  backgroundOverlay: 8,
  showIconTooltips: true,
  truncateLongNames: true,
  throttleConsoleResize: true,
  storageDisplayMode: "hba-lvm",
  uiFontPreset: "system",
  uiFontSize: 12,
  reduceMotion: false,
  consoleTheme: "vrc",
  consoleFontPreset: "system-mono",
  consoleFontSize: 13,
  consoleLineHeight: 1.2,
  consoleCursorStyle: "block",
  consoleCursorBlink: true,
  consoleScaleMode: "local",
  consoleQuality: "auto",
  consoleWatermarkEnabled: true,
  consoleWatermarkScope: "console",
  consoleWatermarkDensity: "standard",
  consoleWatermarkOpacity: 12,
};
const defaultConnectionPreferences: ConnectionPreferences = {
  selectedConnectionId: localStorage.getItem("vrc.connectionId") || "",
  providerType: normalizeProviderType(localStorage.getItem("vrc.providerType")),
  host: localStorage.getItem("vrc.host") || "",
  port: Number(localStorage.getItem("vrc.port") || defaultPortForProvider(normalizeProviderType(localStorage.getItem("vrc.providerType")))),
  username: localStorage.getItem("vrc.username") || "root",
  connectionName: "",
};
const chromeExtensionServiceStorageKey = "vrc.chromeExtension.service";
const chromeExtensionConnectionsStorageKey = "vrc.chromeExtension.localConnections";
const browserConnectionsStorageKey = "vrc.browserLocalConnections.v1";
const defaultChromeExtensionServiceSettings: ChromeExtensionServiceSettings = {
  mode: "intranet",
  scheme: "http",
  host: "vrc-server",
  port: 3987,
};
const chromeExtensionServiceModeOptions: Array<{ label: string; value: ChromeExtensionServiceMode }> = [
  { label: "内网", value: "intranet" },
  { label: "本机", value: "local" },
];
const deprecatedChromeExtensionSampleConnectionIds = new Set(["xs-prod", "vmware-lab", "pve-test"]);
const connection = reactive({
  providerType: defaultConnectionPreferences.providerType,
  host: defaultConnectionPreferences.host,
  port: defaultConnectionPreferences.port,
  username: defaultConnectionPreferences.username,
  password: "",
});

const inventory = ref<HostsResponse | null>(null);
const vms = ref<VmsResponse | null>(null);
const vmSummary = ref<VmInventorySummary | null>(null);
const selectedResourceCapacity = ref<ResourceCapacitySummary | null>(null);
const storedConnections = ref<StoredConnectionSummary[]>([]);
const selectedConnectionId = ref(defaultConnectionPreferences.selectedConnectionId);
const connectionName = ref(defaultConnectionPreferences.connectionName);
const persistentConnectionsEnabled = ref(true);
const apiRuntimeMode = ref<"web" | "electron" | "chrome-native">("web");
const desktopUpdateStage = ref<VrcDesktopUpdateStage>("idle");
const connectionSearch = ref("");
const showConnectionEditor = ref(true);
const showActivityPanel = ref(false);
const activityLogVisible = ref(false);
const activityDetailVisible = ref(false);
const selectedActivityEntry = ref<ActivityEntry | null>(null);
const selectedActivityEntrySequence = ref<number | null>(null);
const activitySearch = ref("");
const activityStatusFilter = ref<ActivityStatusFilter>("all");
const activityEntries = ref<ActivityEntry[]>([
  {
    id: "init",
    time: formatActivityTime(),
    title: "系统启动",
    detail: "等待选择虚拟化平台连接",
    target: "资源控制台",
    status: "info",
  },
]);
const persistentAuditEntries = ref<ActivityEntry[]>([]);
const persistentAuditLoading = ref(false);
const selectedHostId = ref("");
const connectionSettingsVisible = ref(false);
const accountImportVisible = ref(false);
const accountImportMode = ref<AccountImportMode>("excel");
const accountImportText = ref("");
const accountImportFileName = ref("");
const accountImportDrafts = ref<AccountImportDraft[]>([]);
const accountImportError = ref("");
const parsingAccountImport = ref(false);
const importingAccounts = ref(false);
const accountImportFileInput = ref<HTMLInputElement | null>(null);
const appearanceImageFileInput = ref<HTMLInputElement | null>(null);
const appearanceJsonFileInput = ref<HTMLInputElement | null>(null);
const ipPoolsJsonFileInput = ref<HTMLInputElement | null>(null);
const appearanceImageUploading = ref(false);
const vmDetailVisible = ref(false);
const vmRenameVisible = ref(false);
const vmRenameTarget = ref<VmNode | null>(null);
const vmRenameSaving = ref(false);
const vmResizeVisible = ref(false);
const vmResizeTarget = ref<VmNode | null>(null);
const vmResizeDisks = ref<VmDisk[]>([]);
const vmSnapshotVisible = ref(false);
const vmSnapshotHost = ref<HostNodeItem | null>(null);
const vmSnapshotProviderLabel = ref("");
const vmSnapshotGroups = ref<HostVmSnapshotGroup[]>([]);
const vmSnapshotLoading = ref(false);
const vmResizeLoadingDisks = ref(false);
const vmResizeGuestStorage = ref<GuestStorageInventory | null>(null);
const vmResizeLoadingGuestStorage = ref(false);
const vmResizeGuestStorageError = ref("");
const vmResizeSaving = ref(false);
const bootEntryVisible = ref(false);
const bootEntryDialogVm = ref<VmNode | null>(null);
const bootEntryDialogAction = ref<"shutdown" | "forceReboot">("forceReboot");
const bootEntryList = ref<GuestBootEntryList | null>(null);
const bootEntryLoading = ref(false);
const bootEntryError = ref("");
const bootEntryAuthRequired = ref(false);
// 内核数本地缓存实现见 domain/bootEntryReminder.ts（只存数量、不存凭据）。
// 虚拟机诊断功能暂未开放：先整体屏蔽前端入口，功能完善后再放开（改回 true 即恢复）。
const HOST_DIAGNOSTICS_ENABLED = false;
const hostDiagnosticsVisible = ref(false);
const hostDiagnosticsTarget = ref<VmNode | null>(null);
const hostDiagnosticsHost = ref<HostNode | null>(null);
const hostDiagnosticsProviderDescriptor = ref<ProviderDescriptor | undefined>(undefined);
const hostDiagnosticsConnectionPayload = ref<Record<string, unknown> | null>(null);
const consoleDialogVisible = ref(false);
const consoleTarget = ref<VmConsoleTarget | null>(null);
const consoleProvisionTaskId = ref("");
const loadingHosts = ref(false);
const loadingVmSummary = ref(false);
const loadingVms = ref(false);
const vmActionStates = ref<Record<string, VmActionState>>({});
const testing = ref(false);
const savingConnection = ref(false);
const errorMessage = ref("");
const successMessage = ref("");
const connectionFeedbackText = ref("");
const connectionFeedbackKind = ref<"" | "success" | "error">("");
const search = ref("");
const vmPowerFilter = ref<VmPowerFilter>("all");
const storageDetailVisible = ref(false);
// 存储池详情默认只看可分配 VM 磁盘的存储池（ISO 库、可移动介质、备份存储不计入可分配容量）
const storageAllocationFilter = ref(true);
const isoDetailVisible = ref(false);
const loadingIsoImages = ref(false);
const isoImages = ref<IsoImage[]>([]);
const isoImagesEmptyState = ref<IsoImagesResponse["emptyState"]>();
const providerDescriptors = ref<ProviderDescriptor[]>([]);
const isoSearch = ref("");
const provisioningVisible = ref(false);
const vmScheduleVisible = ref(false);
const vmScheduleInitialView = ref<"create" | "tasks">("tasks");
const vmScheduleSelectedVms = ref<VmNode[]>([]);
const provisioningSubmitting = ref(false);
const provisioningProgress = ref<ProvisioningProgressState | null>(null);
const activeProvisionTask = ref<ProvisionTask | null>(null);
const hostDetailVisible = ref(false);
const selectedVmIds = ref<string[]>([]);
const hostOverviewRows = ref<HostOverviewRow[]>([]);
const loadingHostOverview = ref(false);
const selectedHostOverviewKey = ref("");
const overviewSelectedRows = ref<HostOverviewRow[]>([]);
const workspaceMode = ref<WorkspaceMode>("empty");
const settingsPanel = ref<SettingsPanel>("appearance");
const appearanceConsolePreviewMode = ref<ConsolePreviewMode>("graphical");
const ipPoolPolicy = ref<IpPoolPolicy>({ defaultDns: [], ipPools: [] });
const ipPoolDefaultDnsText = ref("");
const ipPoolSelectedId = ref("");
const ipPoolSearch = ref("");
const ipPoolLoading = ref(false);
const ipPoolSaving = ref(false);
const ipPoolPolicyRevision = ref(0);
const maintenanceIsoReport = ref<MaintenanceGeneratedIsoReport | null>(null);
const maintenanceIsoLoading = ref(false);
const maintenanceIsoCleaning = ref(false);
const maintenanceIsoScannedAt = ref("");
const maintenanceIsoStatus = ref("");
const maintenanceIsoError = ref("");
const provisioningDialogSession = ref(0);
const ipPoolDraft = reactive<IpPoolEditorDraft>(emptyIpPoolDraft());
const chromeExtensionActiveTab = ref<ChromeExtensionTab>("service");
const chromeExtensionService = reactive<ChromeExtensionServiceSettings>(loadChromeExtensionServiceSettings());
const chromeExtensionLocalConnections = ref<ChromeExtensionLocalConnection[]>(loadChromeExtensionLocalConnections());
const chromeExtensionDraftConnection = reactive<ChromeExtensionDraftConnection>({
  providerType: "xenserver",
  name: "新连接",
  host: "",
  username: "root",
  password: "",
});
const hostOverviewSearch = ref("");
const appliedHostOverviewSearch = ref("");
const overviewVmSearchHolding = ref(false);
const hostOverviewMatchMode = ref<"exact" | "fuzzy">("exact");
const hostOverviewSort = ref<{ prop: HostOverviewSortKey; order: TableSortOrder }>({ prop: "hostName", order: "ascending" });
const vmSearchCache = ref<Record<string, VmSearchCacheEntry>>({});
const currentTheme = ref<UiTheme>(normalizeTheme(document.documentElement.dataset.theme || localStorage.getItem("vrc.theme")));
const uiPreferences = reactive<UiPreferences>({ ...defaultUiPreferences });
const uiPreferencesLoaded = ref(false);
const systemDark = ref(window.matchMedia("(prefers-color-scheme: dark)").matches);
const isElectron = /Electron/i.test(navigator.userAgent);
const isMacElectron = isElectron && /Mac/i.test(navigator.platform);
const isWindowsElectron = isElectron && /Win/i.test(navigator.platform);
let hostOverviewRequestSeq = 0;
let vmSearchRequestSeq = 0;
let vmSummaryRequestSeq = 0;
let vmListRequestSeq = 0;
let activitySeq = 0;
let lastErrorToast = "";
let lastErrorToastAt = 0;
let hostOverviewSearchApplyTimer: ReturnType<typeof setTimeout> | undefined;
let overviewVmSearchHoldTimer: ReturnType<typeof setTimeout> | undefined;
let vmSearchTimer: ReturnType<typeof setTimeout> | undefined;
let connectionPreferenceSaveTimer: ReturnType<typeof setTimeout> | undefined;
let appearanceMediaQuery: MediaQueryList | undefined;
let inventoryEventSource: EventSource | null = null;
let inventoryEventResourceRefreshTimer: ReturnType<typeof setTimeout> | undefined;
let inventoryEventResourceRefreshSeq = 0;
let removeDesktopUpdateListener: (() => void) | undefined;
let lastInventoryEventSeq = 0;
const provisioningPollTimers = new Map<string, ReturnType<typeof setTimeout>>();
const vmSearchRefreshTimers = new Set<ReturnType<typeof setTimeout>>();
const inventorySnapshotRefreshTimers = new Set<ReturnType<typeof setTimeout>>();
const provisioningTaskMarks = new Map<string, string>();
const provisioningEventSources = new Map<string, EventSource>();
const provisioningTaskPayloads = new Map<string, VmCreateRequest>();
const dismissedProvisionTaskIds = new Set<string>();
const provisionTasksStoppedByVmDelete = new Set<string>();
const vmListReconciler = createVmListReconciler();

const hosts = computed(() => inventory.value?.hosts ?? []);
const storage = computed(() => inventory.value?.storage ?? []);
// 可分配 VM 磁盘的存储池（与后端 summarizeResourceCapacity 过滤口径一致）
const storageForAllocation = computed(() => storage.value.filter((item) => isVmDiskRepositoryForProvider(connection.providerType, item)));
// 存储池详情展示用：受“仅看可分配”开关控制（只影响表格行，不影响顶部汇总口径）
const storageForDetail = computed(() => (storageAllocationFilter.value ? storageForAllocation.value : storage.value));
// 顶部汇总固定为“可分配 VM 磁盘”口径，与主卡存储卡片、物理机汇总保持一致；
// 镜像库/可移动介质等不可分配池的容量始终不计入，避免切换开关导致数字跳变。
const storageDetailTotals = computed(() => {
  const physicalGiB = storageForAllocation.value.reduce((sum, sr) => sum + positive(sr.physicalGiB), 0);
  const usedGiB = storageForAllocation.value.reduce((sum, sr) => sum + positive(sr.usedGiB), 0);
  return {
    physicalGiB,
    usedGiB,
    freeGiB: Math.max(physicalGiB - usedGiB, 0),
    usagePercent: percent(usedGiB, physicalGiB),
  };
});
type StoragePoolHighlightItem = {
  kind: "hba" | "local" | "file";
  label: string;
  note: string;
  usedGiB: number;
  totalGiB: number;
  freeGiB: number;
  percent: number;
};

// 可分配存储池按用途归类：虚拟硬盘（HBA/块存储）与本地系统盘（LVM）是 VM 磁盘的主要分配目标
const storageAllocationBreakdown = computed<{ hba: StoragePoolHighlightItem; local: StoragePoolHighlightItem; file: StoragePoolHighlightItem }>(() => {
  let hbaUsed = 0;
  let hbaTotal = 0;
  let localUsed = 0;
  let localTotal = 0;
  let fileUsed = 0;
  let fileTotal = 0;
  for (const sr of storageForAllocation.value) {
    const category = storagePoolCategory(connection.providerType, sr);
    if (category.kind === "hba") {
      hbaUsed += positive(sr.usedGiB);
      hbaTotal += positive(sr.physicalGiB);
    } else if (category.kind === "local") {
      localUsed += positive(sr.usedGiB);
      localTotal += positive(sr.physicalGiB);
    } else if (category.kind === "file") {
      fileUsed += positive(sr.usedGiB);
      fileTotal += positive(sr.physicalGiB);
    }
  }
  return {
    hba: { kind: "hba", label: "虚拟 HBA", note: "", usedGiB: hbaUsed, totalGiB: hbaTotal, freeGiB: Math.max(hbaTotal - hbaUsed, 0), percent: percent(hbaUsed, hbaTotal) },
    local: { kind: "local", label: "物理 LVM", note: "", usedGiB: localUsed, totalGiB: localTotal, freeGiB: Math.max(localTotal - localUsed, 0), percent: percent(localUsed, localTotal) },
    file: { kind: "file", label: "文件存储", note: "", usedGiB: fileUsed, totalGiB: fileTotal, freeGiB: Math.max(fileTotal - fileUsed, 0), percent: percent(fileUsed, fileTotal) },
  };
});
// 主卡存储卡片上的 HBA / LVM 高亮行
const storagePoolHighlightItems = computed(() => {
  const { hba, local, file } = storageAllocationBreakdown.value;
  const items: StoragePoolHighlightItem[] = [];
  if (hba.totalGiB > 0) items.push(hba);
  if (local.totalGiB > 0) items.push(local);
  if (file.totalGiB > 0) items.push(file);
  return items;
});
// 存储池详情顶部卡片：存在 HBA/LVM 分类时，把分类剩余/已用合并进顶部卡片（替代原中间 chips 行）；
// 无可分类存储池时回退展示整体容量六项。
type StorageDetailSummaryItem = {
  key: string;
  label: string;
  value: string;
  kind?: "hba" | "local" | "file" | "focus";
  sub?: string;
  /** 剩余占比（剩余语义，与主卡/总览一致），随剩余数字后的徽标展示 */
  pct?: number;
  pctClass?: "ok" | "warn" | "danger";
};
const storageDetailSummaryItems = computed<StorageDetailSummaryItem[]>(() => {
  const highlights = storagePoolHighlightItems.value;
  const capacity = selectedResourceCapacity.value;
  if (highlights.length) {
    return [
      { key: "count", label: "可分配存储池", value: `${storageForAllocation.value.length} 个` },
      ...highlights.map((item) => {
        const remaining = storageRemainingPercent(item.percent);
        return {
          key: item.kind,
          label: `${item.label} 剩余`,
          value: `${formatNumber(item.freeGiB)} GiB`,
          kind: item.kind,
          sub: `已用 ${formatNumber(item.usedGiB)} GiB`,
          pct: remaining,
          pctClass: storageRemainingHealth(remaining, item.freeGiB),
        };
      }),
      { key: "physical", label: "物理总量", value: `${formatNumber(storageDetailTotals.value.physicalGiB)} GiB` },
      { key: "virtual", label: "虚拟剩余", value: capacity ? `${formatNumber(capacity.storage.vmConfigurableGiB)} GiB` : "--" },
    ];
  }
  return [
    { key: "count", label: "可分配存储池", value: `${storageForAllocation.value.length} 个` },
    { key: "used", label: "物理已使用", value: `${formatNumber(storageDetailTotals.value.usedGiB)} GiB` },
    {
      key: "free",
      label: "物理剩余",
      value: `${formatNumber(storageDetailTotals.value.freeGiB)} GiB`,
      kind: "focus",
      sub: `已用 ${formatNumber(storageDetailTotals.value.usedGiB)} GiB`,
      pct: storageRemainingPercent(storageDetailTotals.value.usagePercent),
      pctClass: storageRemainingHealth(storageRemainingPercent(storageDetailTotals.value.usagePercent), storageDetailTotals.value.freeGiB),
    },
    { key: "physical", label: "物理总量", value: `${formatNumber(storageDetailTotals.value.physicalGiB)} GiB` },
    { key: "vm", label: "VM 已配置", value: capacity ? `${formatNumber(capacity.storage.vmConfiguredGiB)} GiB` : "--" },
    { key: "virtual", label: "虚拟剩余", value: capacity ? `${formatNumber(capacity.storage.vmConfigurableGiB)} GiB` : "--" },
  ];
});
const networks = computed(() => inventory.value?.networks ?? []);
const selectedHost = computed(() => hosts.value.find((host) => host.providerId === selectedHostId.value) ?? hosts.value[0] ?? null);
const selectedHostNetworks = computed(() => networks.value.filter((item) => !selectedHost.value || !item.hostId || item.hostId === selectedHost.value.providerId));
const selectedStoredConnection = computed(() => storedConnections.value.find((item) => item.id === selectedConnectionId.value) ?? null);
const selectedConnectionBrand = computed(() => getProviderBrand(selectedStoredConnection.value?.providerType ?? connection.providerType));
const selectedProviderDescriptor = computed(() => providerDescriptorFor(connection.providerType));
const canLoadDirectConnection = computed(() => Boolean(connection.host.trim() && connection.username.trim() && connection.password.trim()));
const connectionActionPendingMessage = computed(() => {
  if (savingConnection.value) return "正在保存连接配置";
  if (testing.value) return "正在测试平台连接";
  if (loadingHosts.value) return "正在读取物理机、存储、网络和 VM 清单";
  return "";
});
const connectionFeedbackMessage = computed(() => connectionActionPendingMessage.value || connectionFeedbackText.value);
const connectionFeedbackStatus = computed(() => {
  if (connectionActionPendingMessage.value) return "loading";
  return connectionFeedbackKind.value;
});
const accountImportSummary = computed(() => {
  const rows = accountImportDrafts.value;
  return {
    total: rows.length,
    importable: rows.filter((row) => row.status !== "error").length,
    update: rows.filter((row) => row.status === "update").length,
    error: rows.filter((row) => row.status === "error").length,
  };
});
const accountImportCanConfirm = computed(() => accountImportSummary.value.importable > 0 && !parsingAccountImport.value && !importingAccounts.value);
const accountImportPlaceholder = computed(() =>
  accountImportMode.value === "json"
    ? `[{"平台":"XenServer","主机":"192.0.2.77","服务器名称":"xenserver-1","登录账号":"root","登录密码":"P"}]`
    : "XenServer 192.0.2.77 xenserver-1 root P\nXenServer 192.0.2.6 xenserver-3 P",
);
const accountImportUpdateNotes = computed(() => accountImportDrafts.value.filter((row) => row.status === "update").slice(0, 3));
const provisioningReservedIps = computed(() => {
  const ips = new Set<string>();
  for (const item of storedConnections.value) {
    if (isIpv4(item.host)) ips.add(item.host);
  }
  for (const host of hosts.value) {
    if (isIpv4(host.address)) ips.add(host.address);
  }
  for (const row of hostOverviewRows.value) {
    if (isIpv4(row.host.address)) ips.add(row.host.address);
  }
  return Array.from(ips);
});
const activeConsoleProvisionTask = computed(() =>
  consoleProvisionTaskId.value && activeProvisionTask.value?.id === consoleProvisionTaskId.value ? activeProvisionTask.value : null,
);
const activeProvisioningConsoleVmIds = computed(() => {
  const task = activeProvisionTask.value;
  if (!task) return [];
  return task.vms
    .flatMap((vm) => [vm.providerId, vm.id, vm.name].filter((value): value is string => Boolean(value)));
});
function buildProvisionConsoleTargets(task: ProvisionTask | null) {
  if (!task) return [];
  return task.vms.map((taskVm, index) => {
    const target = resolveProvisionTaskVmConsoleTarget(taskVm);
    return {
      key: taskVm.providerId || taskVm.id || `${taskVm.name}:${taskVm.ip || index}`,
      name: taskVm.name,
      ip: taskVm.ip,
      status: taskVm.status,
      message: taskVm.message,
      progressPercent: taskVm.progressPercent,
      currentStep: taskVm.currentStep,
      installPackageDone: taskVm.installPackageDone,
      installPackageTotal: taskVm.installPackageTotal,
      target,
    };
  });
}
const provisionConsoleTargets = computed<ProvisionConsoleTargetItem[]>(() => buildProvisionConsoleTargets(activeConsoleProvisionTask.value));
const activeProvisionConsoleTargets = computed<ProvisionConsoleTargetItem[]>(() => buildProvisionConsoleTargets(activeProvisionTask.value));
const provisionInlineConsoleTarget = ref<VmConsoleTarget | null>(null);
const activeProvisionConsoleAvailable = computed(() => {
  return activeProvisionConsoleTargets.value.some((item) => !!item.target);
});
watch(
  () => [activeProvisionTask.value?.id, activeProvisionConsoleTargets.value.map((item) => `${item.target?.vmId || item.key}:${item.target?.mode || ""}`).join("|")] as const,
  () => {
    if (!activeProvisionTask.value) {
      provisionInlineConsoleTarget.value = null;
      return;
    }
    const targets = activeProvisionConsoleTargets.value;
    const currentTarget = provisionInlineConsoleTarget.value;
    if (currentTarget && targets.some((item) => item.target?.vmId === currentTarget.vmId && item.target?.mode === currentTarget.mode)) return;
    provisionInlineConsoleTarget.value = targets.find((item) => item.target)?.target ?? null;
  },
  { immediate: true },
);
watch(
  provisioningVisible,
  (visible, previousVisible) => {
    if (!visible && previousVisible) {
      resetProvisioningDialogView(true);
    }
  },
);
const showWorkspacePlaceholder = computed(
  () => workspaceMode.value === "empty" && !loadingHosts.value && !inventory.value && !hostOverviewRows.value.length && !loadingHostOverview.value,
);
const isOverviewNavActive = computed(() => workspaceMode.value === "overview" && (hostOverviewRows.value.length > 0 || loadingHostOverview.value));
const isSettingsNavActive = computed(() => workspaceMode.value === "settings");
const hasPendingDesktopUpdate = computed(() => ["available", "downloading", "ready"].includes(desktopUpdateStage.value));
const settingsTitle = computed(() => {
  if (settingsPanel.value === "connection") return "设置 / 连接";
  if (settingsPanel.value === "templates") return "设置 / 创建模板";
  if (settingsPanel.value === "ipPools") return "设置 / IP 池";
  if (settingsPanel.value === "chromeExtension") return "设置 / Chrome 插件";
  if (settingsPanel.value === "updates") return "设置 / 更新";
  if (settingsPanel.value === "maintenance") return "设置 / 维护";
  if (settingsPanel.value === "logs") return "设置 / 日志";
  return "设置 / 外观";
});
const settingsDescription = computed(() => {
  if (settingsPanel.value === "connection") {
    return persistentConnectionsEnabled.value
      ? "保存、测试和选择虚拟化平台连接，左侧列表仍作为主切换入口。"
      : "连接账号保存到当前浏览器本地，共享 Web 服务器只处理本次请求，不保存账号密码。";
  }
  if (settingsPanel.value === "templates") return "创建模板只做归档入口，真实模板能力仍以创建虚拟机弹框为准。";
  if (settingsPanel.value === "ipPools") return "只维护 ip-pools.json 地址池，创建 VM 时按物理机网段优先匹配，也允许用户手动选择。";
  if (settingsPanel.value === "chromeExtension") return "管理 Chrome 插件的服务地址和本地密文连接，和 Web、macOS、Windows 客户端配置分开。";
  if (settingsPanel.value === "updates") return "按当前运行端检查版本并应用更新，macOS、Windows、Web 和 Chrome 插件分别使用对应的更新策略。";
  if (settingsPanel.value === "maintenance") return "查看无人值守安装生成的临时介质，只清理任务已结束且校验通过的记录。";
  if (settingsPanel.value === "logs") return "查看持久化保存的本机操作记录，重启后仍然保留，敏感字段已脱敏。";
  return "主题、按钮密度、表格密度和控制台偏好统一归档，不混入 VM 工具栏。";
});
const settingsBackLabel = computed(() => (hostOverviewRows.value.length || loadingHostOverview.value ? "返回总览" : "关闭设置"));
const selectedIpPool = computed(() => ipPoolPolicy.value.ipPools.find((item) => item.id === ipPoolSelectedId.value) ?? ipPoolPolicy.value.ipPools[0] ?? null);
const filteredIpPoolItems = computed(() => {
  const keyword = ipPoolSearch.value.trim().toLowerCase();
  const items = ipPoolPolicy.value.ipPools;
  if (!keyword) return items;
  return items.filter((item) => [item.name, item.prefix, item.gateway, item.networkName ?? ""].join(" ").toLowerCase().includes(keyword));
});
const chromeExtensionBaseUrl = computed(() => {
  const host = chromeExtensionService.host.trim() || (chromeExtensionService.mode === "local" ? "127.0.0.1" : "vrc-server");
  const port = Number(chromeExtensionService.port) || 3987;
  return `${chromeExtensionService.scheme}://${host}:${port}`;
});
const maintenanceIsoSummary = computed(() => maintenanceIsoReport.value?.summary ?? {
  total: 0,
  eligible: 0,
  retained: 0,
  skipped: 0,
  cleaned: 0,
  failed: 0,
  localBytes: 0,
});
const maintenanceIsoActiveItems = computed(() =>
  maintenanceIsoReport.value?.items.filter((item) => item.status !== "deleted" && item.decision !== "cleaned") ?? [],
);
const maintenanceIsoVisibleItems = computed(() => maintenanceIsoActiveItems.value.slice(0, 8));
const filteredStoredConnections = computed(() => {
  const keyword = connectionSearch.value.trim().toLowerCase();
  return storedConnections.value
    .filter((item) => {
      if (!keyword) return true;
      return `${item.name} ${item.providerType} ${item.host} ${item.username}`.toLowerCase().includes(keyword);
    })
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN", { numeric: true, sensitivity: "base" }));
});
const groupedStoredConnections = computed(() => {
  const groups = new Map<string, StoredConnectionSummary[]>();
  for (const item of filteredStoredConnections.value) {
    const groupName = providerLabel(item.providerType);
    groups.set(groupName, [...(groups.get(groupName) ?? []), item]);
  }
  return Array.from(groups.entries());
});
const auditDialogEntries = computed(() =>
  persistentAuditEntries.value.length ? persistentAuditEntries.value : activityEntries.value,
);
const filteredActivityEntries = computed(() => {
  const keyword = activitySearch.value.trim().toLowerCase();
  return auditDialogEntries.value.filter((item) => {
    if (activityStatusFilter.value !== "all" && item.status !== activityStatusFilter.value) return false;
    if (!keyword) return true;
    return [item.time, item.title, item.target ?? "", item.detail ?? "", item.request ?? "", item.command ?? "", activityStatusLabel(item.status)]
      .join(" ")
      .toLowerCase()
      .includes(keyword);
  });
});
const filteredIsoImages = computed(() => {
  const keyword = isoSearch.value.trim().toLowerCase();
  return isoImages.value.filter((item) => {
    if (!keyword) return true;
    return [item.name, isoSourceLabel(item), item.storageRepository, isoLibraryDescription(item), item.path ?? "", item.providerId]
      .join(" ")
      .toLowerCase()
      .includes(keyword);
  });
});
const isoTotals = computed(() => {
  const totalBytes = isoImages.value.reduce((sum, item) => sum + positive(item.sizeBytes ?? 0), 0);
  const storages = new Set(isoImages.value.map((item) => item.storageRepository).filter(Boolean));
  return {
    count: isoImages.value.length,
    totalBytes,
    storageCount: storages.size,
  };
});

const hostUsage = computed(() => {
  const host = selectedHost.value;
  if (!host) return { memoryPercent: 0, storagePercent: 0, memoryUsedBytes: 0 };
  const memoryUsed = Math.max(host.memoryTotalBytes - (host.memoryFreeBytes ?? 0), 0);
  const storagePhysical = storageForAllocation.value.reduce((sum, sr) => sum + positive(sr.physicalGiB), 0);
  const storageUsed = storageForAllocation.value.reduce((sum, sr) => sum + positive(sr.usedGiB), 0);
  return {
    memoryUsedBytes: memoryUsed,
    memoryPercent: percent(memoryUsed, host.memoryTotalBytes),
    storagePercent: percent(storageUsed, storagePhysical),
  };
});

const storageTotals = computed(() => {
  // 只统计可承载 VM 磁盘的存储池，供预配弹窗与磁盘汇总使用
  const physicalGiB = storageForAllocation.value.reduce((sum, sr) => sum + positive(sr.physicalGiB), 0);
  const usedGiB = storageForAllocation.value.reduce((sum, sr) => sum + positive(sr.usedGiB), 0);
  return {
    physicalGiB,
    usedGiB,
    usagePercent: percent(usedGiB, physicalGiB),
  };
});

const vmTotals = computed(() => {
  const summary = vmSummary.value ? normalizeVmSummary(vmSummary.value) : null;
  if (summary) {
    return {
      all: summary.total,
      running: summary.running,
      halted: summary.halted,
      vcpu: summary.vcpu,
      runningVcpu: summary.runningVcpu ?? summary.vcpu,
      memoryBytes: summary.memoryBytes,
      runningMemoryBytes: summary.runningMemoryBytes ?? summary.memoryBytes,
      diskBytes: summary.diskBytes ?? null,
    };
  }
  const items = vms.value?.items ?? [];
  const runningItems = items.filter((vm) => vm.powerState === "running");
  const haltedItems = items.filter((vm) => vm.powerState === "halted");
  return {
    all: Math.max(vms.value?.total ?? 0, items.length, runningItems.length + haltedItems.length),
    running: runningItems.length,
    halted: haltedItems.length,
    vcpu: items.reduce((sum, vm) => sum + vm.cpuCount, 0),
    runningVcpu: runningItems.reduce((sum, vm) => sum + vm.cpuCount, 0),
    memoryBytes: items.reduce((sum, vm) => sum + vm.memoryBytes, 0),
    runningMemoryBytes: runningItems.reduce((sum, vm) => sum + vm.memoryBytes, 0),
    diskBytes: items.reduce((sum, vm) => sum + positive(vm.diskVirtualBytes ?? 0), 0),
  };
});

const resourceSummary = computed(() => {
  const host = selectedHost.value;
  const cpuTotal = positive(host?.cpuCores ?? 0);
  const cpuAllocated = positive(vmTotals.value.runningVcpu);
  const memoryTotalGiB = (host?.memoryTotalBytes ?? 0) / 1024 / 1024 / 1024;
  const memoryUsedGiB = hostUsage.value.memoryUsedBytes / 1024 / 1024 / 1024;
  // 与后端 vm-summary 的 resourceCapacity.storage 口径对齐（按主机范围 + 仅可分配 VM 磁盘的池），
  // 未加载到 summary 时退回前端同口径汇总
  const storageCapacity = selectedResourceCapacity.value?.storage;
  const storageTotalGiB = storageCapacity?.physicalTotalGiB ?? storageTotals.value.physicalGiB;
  const storageUsedGiB = storageCapacity?.physicalUsedGiB ?? storageTotals.value.usedGiB;
  const storageFreeGiB = storageCapacity?.physicalFreeGiB ?? Math.max(storageTotals.value.physicalGiB - storageTotals.value.usedGiB, 0);

  return [
    {
      key: "cpu",
      name: "运行 CPU",
      usedName: "运行占用",
      freeName: "物理核心",
      overName: "",
      unit: "vCPU",
      capacityUnit: "核",
      used: Math.min(cpuAllocated, cpuTotal),
      free: Math.max(cpuTotal - cpuAllocated, 0),
      over: 0,
      total: cpuTotal,
      headline: `${formatNumber(cpuAllocated)} 运行 vCPU / ${formatNumber(cpuTotal)} 核`,
      subline: `运行 ${formatNumber(cpuAllocated)} vCPU · ${formatNumber(cpuTotal)} 个物理核心`,
      percent: cpuTotal > 0 ? Math.round((cpuAllocated / cpuTotal) * 100) : 0,
    },
    {
      key: "memory",
      name: "内存",
      usedName: "已用",
      freeName: "剩余",
      overName: "超出",
      unit: "GiB",
      capacityUnit: "GiB",
      used: memoryUsedGiB,
      free: Math.max(memoryTotalGiB - memoryUsedGiB, 0),
      over: 0,
      total: memoryTotalGiB,
      headline: `${formatNumber(memoryUsedGiB)} / ${formatNumber(memoryTotalGiB)} GiB`,
      subline: `剩余 ${formatNumber(Math.max(memoryTotalGiB - memoryUsedGiB, 0))} GiB`,
      percent: percent(memoryUsedGiB, memoryTotalGiB),
    },
    {
      key: "storage",
      name: "磁盘",
      usedName: "已用",
      freeName: "剩余",
      overName: "超出",
      unit: "GiB",
      capacityUnit: "GiB",
      used: storageUsedGiB,
      free: storageFreeGiB,
      over: 0,
      total: storageTotalGiB,
      headline: `${formatNumber(storageUsedGiB)} / ${formatNumber(storageTotalGiB)} GiB`,
      subline: `剩余 ${formatNumber(storageFreeGiB)} GiB`,
      percent: percent(storageUsedGiB, storageTotalGiB),
    },
  ];
});

const filteredVms = computed(() => {
  const keywords = parseSearchKeywords(search.value);
  return (vms.value?.items ?? [])
    .filter((vm) => vmMatchesPowerFilter(vm, vmPowerFilter.value))
    .filter((vm) => !keywords.length || keywords.some((keyword) => vmMatchesKeyword(vm, selectedHost.value?.address, keyword, "fuzzy")))
    .sort(compareVmByIp);
});
const vmTableTotal = computed(() => Math.max(vms.value?.total ?? 0, vms.value?.items.length ?? 0, filteredVms.value.length));
const selectedVmRows = computed(() => {
  const selectedIds = new Set(selectedVmIds.value);
  return (vms.value?.items ?? []).filter((vm) => selectedIds.has(vm.providerId) || selectedIds.has(vm.id));
});

const hostOverviewTotals = computed(() => {
  const rows = hostOverviewRows.value;
  return {
    total: rows.length,
    ready: rows.filter((row) => row.status === "ready").length,
    error: rows.filter((row) => row.status === "error").length,
    runningVms: rows.reduce((sum, row) => sum + (row.summary?.running ?? 0), 0),
    totalVms: rows.reduce((sum, row) => sum + (row.summary?.total ?? 0), 0),
  };
});

const hostOverviewMetricCards = computed(() => {
  const rows = hostOverviewRows.value.filter(hasOverviewInventory);
  const readyRows = rows.filter((row) => row.summary && row.status !== "error");
  const physicalCpuCores = readyRows.reduce((sum, row) => sum + hostCpuPlan(row).cores, 0);
  const runningVcpu = readyRows.reduce((sum, row) => sum + hostCpuPlan(row).allocated, 0);
  const memoryFree = readyRows.reduce((sum, row) => sum + hostMemoryPlan(row).free, 0);
  // 存储风险口径与展示模式一致：HBA+LVM 模式按主分配盘（HBA 优先）判断，总体模式按可分配物理总体判断
  const storageTight = readyRows.filter((row) => {
    if (uiPreferences.storageDisplayMode === "hba-lvm") {
      const highlights = hostStorageHighlights(row);
      const primary = highlights[0];
      if (primary) return primary.freeGiB < 500 || primary.percent >= 85;
    }
    const storagePlan = hostStoragePlan(row);
    return storagePlan.freeGiB < 500 || storagePlan.percent >= 85;
  }).length;
  const pending = Math.max(hostOverviewTotals.value.total - hostOverviewTotals.value.ready - hostOverviewTotals.value.error, 0);

  return [
    {
      key: "connections",
      label: "连接",
      value: `${storedConnections.value.length}`,
      detail: hostOverviewTotals.value.error ? `${hostOverviewTotals.value.error} 个异常` : "全部保存连接",
      className: hostOverviewTotals.value.error ? "overview-metric-warning" : "",
    },
    {
      key: "hosts",
      label: "物理机",
      value: `${hostOverviewTotals.value.ready} / ${hostOverviewTotals.value.total}`,
      detail: pending ? `${pending} 台加载中` : "可下钻查看 VM",
      className: pending ? "overview-metric-pending" : "",
    },
    {
      key: "vms",
      label: "运行 VM",
      value: `${hostOverviewTotals.value.runningVms} / ${hostOverviewTotals.value.totalVms}`,
      detail: "按物理机归属查看",
      className: "",
    },
    {
      key: "cpu",
      label: "运行 vCPU",
      value: `${formatNumber(runningVcpu)} vCPU`,
      detail: `${formatNumber(physicalCpuCores)} 个物理核心`,
      className: "",
    },
    {
      key: "memory",
      label: "内存余量",
      value: formatBytes(memoryFree),
      detail: "来自物理机可用内存",
      className: memoryFree < 32 * 1024 ** 3 ? "overview-metric-warning" : "",
    },
    {
      key: "storage",
      label: "存储风险",
      value: `${storageTight} 台`,
      detail: storageTight ? "存储余量偏低" : "暂无高风险主机",
      className: storageTight ? "overview-metric-danger" : "",
    },
  ];
});

const overviewSearchKeywords = computed(() => parseOverviewSearchKeywords(appliedHostOverviewSearch.value));
const overviewSearchKeyword = computed(() => overviewSearchKeywords.value.join(" "));
const overviewSearchLabel = computed(() => overviewSearchKeywords.value.join("、"));
const overviewSearchBatchText = computed(() => (overviewSearchKeywords.value.length > 1 ? `批量 ${overviewSearchKeywords.value.length} 项 · ` : ""));
const overviewNeedsVmSearch = computed(() => overviewSearchKeywords.value.some(shouldSearchVmIp));
const filteredHostOverviewRows = computed(() => {
  const keywords = overviewSearchKeywords.value;
  if (!keywords.length) return hostOverviewRows.value;
  const waitingForVmIndex = keywords.some(shouldSearchVmIp) && hostOverviewRows.value.some((row) => hasOverviewInventory(row) && !hasSettledVmSearchCache(row));
  if (waitingForVmIndex && overviewVmSearchHolding.value) {
    // Keep a short stable window so VM-IP search does not shrink the table one row at a time.
    return hostOverviewRows.value;
  }
  return hostOverviewRows.value.filter((row) => rowMatchesOverviewKeywords(row, keywords));
});

const sortedHostOverviewRows = computed(() => {
  const { prop, order } = hostOverviewSort.value;
  return [...filteredHostOverviewRows.value].sort((left, right) => compareHostOverviewRows(left, right, prop, order));
});

const vmSearchSettledCount = computed(() => hostOverviewRows.value.filter((row) => hasSettledVmSearchCache(row)).length);
const overviewVmSearchLoading = computed(() => {
  if (!overviewNeedsVmSearch.value) return false;
  return hostOverviewRows.value.some((row) => hasOverviewInventory(row) && !hasSettledVmSearchCache(row));
});
const overviewEmptyState = computed(() => {
  if (loadingHostOverview.value) {
    return {
      mode: "loading",
      title: "正在读取物理机总览",
      detail: "并发加载 XenServer / VMware / Proxmox VE 基础信息",
    };
  }
  if (overviewVmSearchLoading.value) {
    const total = hostOverviewRows.value.filter(hasOverviewInventory).length;
    return {
      mode: "loading",
      title: "正在查询 VM IP",
      detail: `${overviewSearchBatchText.value}缓存 ${vmSearchSettledCount.value} / ${total} · ${overviewSearchLabel.value}`,
    };
  }
  if (overviewSearchKeyword.value) {
    return {
      mode: "empty",
      title: "未找到匹配资源",
      detail: `没有命中物理机 IP 或 VM IP：${overviewSearchLabel.value}`,
    };
  }
  return {
    mode: "empty",
    title: "暂无物理机数据",
    detail: "点击左侧资源总览加载物理机清单",
  };
});
const vmSearchStatusText = computed(() => {
  if (!overviewSearchKeywords.value.length) return "";
  if (!overviewNeedsVmSearch.value) return `${overviewSearchBatchText.value}本地匹配 ${filteredHostOverviewRows.value.length} / ${hostOverviewRows.value.length} 台`;
  const total = hostOverviewRows.value.filter(hasOverviewInventory).length;
  const cached = vmSearchSettledCount.value;
  if (overviewVmSearchLoading.value && overviewVmSearchHolding.value) return `${overviewSearchBatchText.value}VM IP 缓存 ${cached} / ${total} · 稳定结果中`;
  if (overviewVmSearchLoading.value) return `${overviewSearchBatchText.value}VM IP 匹配 ${filteredHostOverviewRows.value.length} / ${hostOverviewRows.value.length} 台 · 后台补齐 ${cached} / ${total}`;
  return `${overviewSearchBatchText.value}VM IP 匹配 ${filteredHostOverviewRows.value.length} / ${hostOverviewRows.value.length} 台 · 缓存 ${cached} / ${total}`;
});
const resolvedAppearanceDark = computed(() => uiPreferences.toneMode === "dark" || (uiPreferences.toneMode === "system" && systemDark.value));
const recommendedThemes = computed(() => themeOptions.filter((theme) => ["graphite-sage", "prism-frost", "neon-carbon"].includes(theme.value)));
const currentAppearanceTheme = computed(() => themeOptions.find((item) => item.value === uiPreferences.theme) ?? themeOptions[0]);
const appearanceToneText = computed(() => {
  if (uiPreferences.toneMode === "system") return systemDark.value ? "跟随系统 · 深色" : "跟随系统 · 浅色";
  return uiPreferences.toneMode === "dark" ? "深色" : "浅色";
});
const appearanceBackgroundText = computed(() => {
  if (uiPreferences.backgroundMode === "solid") return "纯色背景";
  if (uiPreferences.backgroundMode === "image") return `图片背景 · ${uiPreferences.backgroundOpacity}%`;
  return currentAppearanceTheme.value.tone;
});
const currentUiFont = computed(() => uiFontOptions.find((item) => item.value === uiPreferences.uiFontPreset) ?? uiFontOptions[0]);
const currentConsoleTheme = computed(() => consoleThemeOptions.find((item) => item.value === uiPreferences.consoleTheme) ?? consoleThemeOptions[0]);
const currentConsoleFont = computed(() => consoleFontOptions.find((item) => item.value === uiPreferences.consoleFontPreset) ?? consoleFontOptions[0]);
const consoleWatermarkCopies = computed(() => ({ sparse: 3, standard: 6, dense: 10 })[uiPreferences.consoleWatermarkDensity]);
const consoleWatermarkText = computed(() => {
  const operator = connection.username?.trim() || "VRC";
  const source = window.location.hostname || "local";
  const timestamp = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date()).replaceAll("/", "-");
  return `${operator} · ${source} · ${timestamp}`;
});
const appearanceConsolePreviewStyle = computed(() => ({
  "--appearance-console-bg": currentConsoleTheme.value.colors.background,
  "--appearance-console-fg": currentConsoleTheme.value.colors.text,
  "--appearance-console-muted": `color-mix(in srgb, ${currentConsoleTheme.value.colors.text} 62%, transparent)`,
  "--appearance-console-accent": currentConsoleTheme.value.colors.selection,
  "--appearance-console-success": currentConsoleTheme.value.colors.success,
  "--appearance-console-font": currentConsoleFont.value.family,
  "--appearance-console-size": `${uiPreferences.consoleFontSize}px`,
  "--appearance-console-line-height": String(uiPreferences.consoleLineHeight),
  "--appearance-watermark-opacity": String(uiPreferences.consoleWatermarkOpacity / 100),
}));
const consoleTerminalTheme = computed(() => ({
  background: currentConsoleTheme.value.colors.background,
  foreground: currentConsoleTheme.value.colors.text,
  cursor: currentConsoleTheme.value.colors.text,
  selectionBackground: withHexAlpha(currentConsoleTheme.value.colors.selection, "66"),
  selectionInactiveBackground: withHexAlpha(currentConsoleTheme.value.colors.selection, "3d"),
  black: currentConsoleTheme.value.colors.background,
  brightBlack: currentConsoleTheme.value.colors.border,
  green: currentConsoleTheme.value.colors.success,
  brightGreen: currentConsoleTheme.value.colors.success,
  cyan: currentConsoleTheme.value.colors.selection,
  brightCyan: currentConsoleTheme.value.colors.selection,
  white: currentConsoleTheme.value.colors.text,
  brightWhite: "#ffffff",
}));

function withHexAlpha(color: string, alpha: string) {
  return /^#[0-9a-f]{6}$/i.test(color) ? `${color}${alpha}` : color;
}
const appearanceBackgroundImageUrl = computed(() =>
  uiPreferences.backgroundImageUpdatedAt
    ? `/api/preferences/ui/background-image?v=${encodeURIComponent(uiPreferences.backgroundImageUpdatedAt)}`
    : "",
);
const workspaceAppearanceStyle = computed<Record<string, string>>(() => ({
  "--vrc-workspace-background-color": uiPreferences.backgroundMode === "solid" ? uiPreferences.backgroundColor : "transparent",
  "--vrc-workspace-background-image":
    uiPreferences.backgroundMode === "image" && appearanceBackgroundImageUrl.value ? `url(${JSON.stringify(appearanceBackgroundImageUrl.value)})` : "none",
  "--vrc-workspace-background-opacity": String(uiPreferences.backgroundOpacity / 100),
  "--vrc-workspace-background-blur": `${uiPreferences.backgroundBlur}px`,
  "--vrc-workspace-background-overlay": String(uiPreferences.backgroundOverlay / 100),
}));
const appearanceBackgroundPreviewStyle = computed(() => ({
  backgroundImage: appearanceBackgroundImageUrl.value ? `url(${JSON.stringify(appearanceBackgroundImageUrl.value)})` : "none",
}));

async function markRendererReady() {
  document.documentElement.dataset.startupStage = "vue-mounted";
  await nextTick();
  if (document.fonts?.ready) {
    document.documentElement.dataset.startupStage = "fonts-waiting";
    await Promise.race([document.fonts.ready, new Promise<void>((resolve) => window.setTimeout(resolve, 300))]);
  }
  document.documentElement.dataset.startupStage = "shell-ready";
  document.documentElement.dataset.appReady = "true";
}

async function initializeDesktopUpdateReminder() {
  const desktopUpdateApi = window.vrcDesktopUpdate;
  if (!desktopUpdateApi) return;
  const applyState = (state: VrcDesktopUpdateState) => {
    desktopUpdateStage.value = state.stage;
  };
  removeDesktopUpdateListener = desktopUpdateApi.onState(applyState);
  try {
    const state = await desktopUpdateApi.getState();
    applyState(state);
    const autoCheckEnabled = localStorage.getItem("vrc.update.auto-check") !== "false";
    if (autoCheckEnabled && state.supported && state.stage === "idle" && !state.checkedAt) {
      applyState(await desktopUpdateApi.check());
    }
  } catch {
    desktopUpdateStage.value = "error";
  }
}

onMounted(async () => {
  try {
    document.documentElement.dataset.startupStage = "mounted";
    appearanceMediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    systemDark.value = appearanceMediaQuery.matches;
    appearanceMediaQuery.addEventListener("change", handleAppearanceMediaChange);
    await loadRuntimeInfo();
    document.documentElement.dataset.startupStage = "runtime-loaded";
    await Promise.all([loadAppPreferences(), loadProviderDescriptors()]);
    document.documentElement.dataset.startupStage = "preferences-loaded";
  } catch (error) {
    document.documentElement.dataset.startupError = error instanceof Error ? error.message : String(error);
  } finally {
    await markRendererReady();
  }
  void loadIpPoolPolicy();
  void initializeDesktopUpdateReminder();
  connectInventoryEvents();
  await loadStoredConnections();
  const launchConnection = consumeChromeExtensionLaunchConnection();
  if (launchConnection.connectionId) {
    const extensionConnection = await requestChromeExtensionConnection(launchConnection).catch((error) => {
      setErrorMessage(error instanceof Error ? error.message : "读取 Chrome 插件本地连接失败", false);
      return null;
    });
    if (extensionConnection) {
      applyChromeExtensionConnection(extensionConnection);
      await loadHostInventory();
      return;
    }
  }
  if (selectedConnectionId.value && storedConnections.value.some((item) => item.id === selectedConnectionId.value)) {
    applyStoredConnection(selectedConnectionId.value);
  } else if (selectedConnectionId.value) {
    selectedConnectionId.value = "";
    if (persistentConnectionsEnabled.value) void saveConnectionPreferences(buildConnectionPreferencesFromState());
  }
  if (storedConnections.value.length) {
    await loadHostOverview();
  }
});

onBeforeUnmount(() => {
  removeDesktopUpdateListener?.();
  removeDesktopUpdateListener = undefined;
  appearanceMediaQuery?.removeEventListener("change", handleAppearanceMediaChange);
  if (connectionPreferenceSaveTimer) clearTimeout(connectionPreferenceSaveTimer);
  if (inventoryEventResourceRefreshTimer) clearTimeout(inventoryEventResourceRefreshTimer);
  inventoryEventResourceRefreshTimer = undefined;
  for (const timer of provisioningPollTimers.values()) clearTimeout(timer);
  provisioningPollTimers.clear();
  for (const timer of vmSearchRefreshTimers) clearTimeout(timer);
  vmSearchRefreshTimers.clear();
  for (const timer of inventorySnapshotRefreshTimers) clearTimeout(timer);
  inventorySnapshotRefreshTimers.clear();
  for (const source of provisioningEventSources.values()) source.close();
  provisioningEventSources.clear();
  inventoryEventSource?.close();
  inventoryEventSource = null;
  if (hostOverviewSearchApplyTimer) clearTimeout(hostOverviewSearchApplyTimer);
  hostOverviewSearchApplyTimer = undefined;
  if (overviewVmSearchHoldTimer) clearTimeout(overviewVmSearchHoldTimer);
  overviewVmSearchHoldTimer = undefined;
  overviewVmSearchHolding.value = false;
  if (vmSearchTimer) clearTimeout(vmSearchTimer);
  vmSearchTimer = undefined;
});

watch(hostOverviewSearch, (value) => {
  scheduleOverviewVmSearchStableHold(value);
  scheduleOverviewSearchApply(value);
  scheduleOverviewVmSearchCacheLoad(value);
});

watch(vmDetailVisible, (visible) => {
  if (visible) return;
  resetVmOperationState();
  if (hostOverviewRows.value.length && workspaceMode.value === "connection") {
    workspaceMode.value = "overview";
    selectedHostOverviewKey.value = "";
  }
});

watch(vmPowerFilter, () => {
  selectedVmIds.value = [];
});

watch(search, () => {
  selectedVmIds.value = [];
});

watch(
  () => connection.providerType,
  (next, previous) => {
    if (connection.port === defaultPortForProvider(previous)) {
      connection.port = defaultPortForProvider(next);
    }
  },
);

watch(
  () => [selectedConnectionId.value, connection.providerType, connection.host, connection.port, connection.username, connectionName.value] as const,
  () => {
    if (!uiPreferencesLoaded.value) return;
    queueConnectionPreferenceSave();
  },
);

watch(settingsPanel, (panel) => {
  if (panel === "maintenance" && !maintenanceIsoReport.value && !maintenanceIsoLoading.value) {
    void loadMaintenanceGeneratedIsos({ silent: true });
  }
  if (panel === "logs" && !persistentAuditEntries.value.length && !persistentAuditLoading.value) {
    void loadPersistentAudit();
  }
});

watch(activityLogVisible, (visible) => {
  if (visible && !persistentAuditEntries.value.length && !persistentAuditLoading.value) {
    void loadPersistentAudit();
  }
});

function normalizeTheme(value?: string | null): UiTheme {
  return themeOptions.some((item) => item.value === value) ? value as UiTheme : "graphite-sage";
}

function normalizeProviderType(value?: string | null): ProviderType {
  return value === "vmware" || value === "proxmox" || value === "libvirt" || value === "xenserver" ? value : "xenserver";
}

function isProviderType(value: ProviderType | ""): value is ProviderType {
  return value === "vmware" || value === "proxmox" || value === "libvirt" || value === "xenserver";
}

async function loadAppPreferences() {
  try {
    const result = await postJson<{ preferences: Partial<AppPreferences> }>("/api/preferences", undefined, "GET");
    const connectionPreferences = shouldUseLegacyConnectionPreferences(result.preferences.connection)
      ? defaultConnectionPreferences
      : result.preferences.connection;
    applyUiPreferences(result.preferences.ui ?? defaultUiPreferences);
    applyConnectionPreferences(connectionPreferences ?? defaultConnectionPreferences);
    if (persistentConnectionsEnabled.value && connectionPreferences === defaultConnectionPreferences && hasLegacyConnectionPreferences()) {
      void saveConnectionPreferences(buildConnectionPreferencesFromState()).then(clearLegacyConnectionPreferences);
    }
  } catch (error) {
    applyUiPreferences(defaultUiPreferences);
    applyConnectionPreferences(defaultConnectionPreferences);
    setErrorMessage(error instanceof Error ? `读取本地偏好失败：${error.message}` : "读取本地偏好失败", false);
  } finally {
    uiPreferencesLoaded.value = true;
  }
}

async function loadRuntimeInfo() {
  try {
    const result = await postJson<ApiHealthResponse>("/api/health", undefined, "GET");
    apiRuntimeMode.value = result.runtimeMode === "electron" || result.runtimeMode === "chrome-native" ? result.runtimeMode : "web";
    persistentConnectionsEnabled.value = result.connectionStore?.persistentEnabled !== false;
  } catch {
    apiRuntimeMode.value = "web";
    persistentConnectionsEnabled.value = false;
  }
}

async function loadProviderDescriptors() {
  try {
    const result = await postJson<ProviderDescriptorsResponse>("/api/providers", undefined, "GET");
    providerDescriptors.value = result.providers;
  } catch {
    providerDescriptors.value = [];
  }
}

function applyUiPreferences(preferences: Partial<UiPreferences>) {
  const theme = normalizeTheme(preferences.theme);
  const themeOption = themeOptions.find((item) => item.value === theme) ?? themeOptions[0];
  uiPreferences.theme = theme;
  uiPreferences.toneMode = preferences.toneMode === "system" || preferences.toneMode === "dark" ? preferences.toneMode : "light";
  uiPreferences.accentColor = normalizeHexColor(preferences.accentColor, themeOption.accentColor);
  uiPreferences.successColor = normalizeHexColor(preferences.successColor, themeOption.successColor);
  uiPreferences.warningColor = normalizeHexColor(preferences.warningColor, themeOption.warningColor);
  uiPreferences.dangerColor = normalizeHexColor(preferences.dangerColor, themeOption.dangerColor);
  uiPreferences.backgroundMode =
    preferences.backgroundMode === "solid" || preferences.backgroundMode === "image" ? preferences.backgroundMode : "default";
  uiPreferences.backgroundColor = normalizeHexColor(preferences.backgroundColor, defaultUiPreferences.backgroundColor);
  uiPreferences.backgroundImageName = typeof preferences.backgroundImageName === "string" ? preferences.backgroundImageName : "";
  uiPreferences.backgroundImageMime = typeof preferences.backgroundImageMime === "string" ? preferences.backgroundImageMime : "";
  uiPreferences.backgroundImageUpdatedAt = typeof preferences.backgroundImageUpdatedAt === "string" ? preferences.backgroundImageUpdatedAt : "";
  uiPreferences.backgroundOpacity = normalizeAppearanceNumber(preferences.backgroundOpacity, 5, 60, defaultUiPreferences.backgroundOpacity);
  uiPreferences.backgroundBlur = normalizeAppearanceNumber(preferences.backgroundBlur, 0, 16, defaultUiPreferences.backgroundBlur);
  uiPreferences.backgroundOverlay = normalizeAppearanceNumber(preferences.backgroundOverlay, 0, 35, defaultUiPreferences.backgroundOverlay);
  uiPreferences.showIconTooltips = preferences.showIconTooltips ?? defaultUiPreferences.showIconTooltips;
  uiPreferences.truncateLongNames = preferences.truncateLongNames ?? defaultUiPreferences.truncateLongNames;
  uiPreferences.throttleConsoleResize = preferences.throttleConsoleResize ?? defaultUiPreferences.throttleConsoleResize;
  uiPreferences.storageDisplayMode = preferences.storageDisplayMode === "overall" ? "overall" : "hba-lvm";
  uiPreferences.uiFontPreset = normalizeUiFontPreset(preferences.uiFontPreset);
  uiPreferences.uiFontSize = normalizeAppearanceNumber(preferences.uiFontSize, 11, 13, defaultUiPreferences.uiFontSize);
  uiPreferences.reduceMotion = preferences.reduceMotion ?? defaultUiPreferences.reduceMotion;
  uiPreferences.consoleTheme = normalizeConsoleTheme(preferences.consoleTheme);
  uiPreferences.consoleFontPreset = normalizeConsoleFontPreset(preferences.consoleFontPreset);
  uiPreferences.consoleFontSize = normalizeAppearanceNumber(preferences.consoleFontSize, 11, 18, defaultUiPreferences.consoleFontSize);
  uiPreferences.consoleLineHeight = normalizeAppearanceDecimal(preferences.consoleLineHeight, 1.05, 1.6, defaultUiPreferences.consoleLineHeight);
  uiPreferences.consoleCursorStyle =
    preferences.consoleCursorStyle === "underline" || preferences.consoleCursorStyle === "bar" ? preferences.consoleCursorStyle : "block";
  uiPreferences.consoleCursorBlink = preferences.consoleCursorBlink ?? defaultUiPreferences.consoleCursorBlink;
  uiPreferences.consoleScaleMode = preferences.consoleScaleMode === "remote" ? "remote" : "local";
  uiPreferences.consoleQuality = preferences.consoleQuality === "high" || preferences.consoleQuality === "smooth" ? preferences.consoleQuality : "auto";
  uiPreferences.consoleWatermarkEnabled = preferences.consoleWatermarkEnabled ?? defaultUiPreferences.consoleWatermarkEnabled;
  uiPreferences.consoleWatermarkScope = preferences.consoleWatermarkScope === "workspace" ? "workspace" : "console";
  uiPreferences.consoleWatermarkDensity =
    preferences.consoleWatermarkDensity === "sparse" || preferences.consoleWatermarkDensity === "dense"
      ? preferences.consoleWatermarkDensity
      : "standard";
  uiPreferences.consoleWatermarkOpacity = normalizeAppearanceNumber(
    preferences.consoleWatermarkOpacity,
    6,
    24,
    defaultUiPreferences.consoleWatermarkOpacity,
  );
  applyThemeToDocument(uiPreferences.theme);
  applyAppearanceToDocument();
  document.documentElement.dataset.iconTooltips = String(uiPreferences.showIconTooltips);
  document.documentElement.dataset.truncateLongNames = String(uiPreferences.truncateLongNames);
  document.documentElement.dataset.consoleResizeThrottle = String(uiPreferences.throttleConsoleResize);
  document.documentElement.dataset.reduceMotion = String(uiPreferences.reduceMotion);
}

function applyThemeToDocument(theme: UiTheme) {
  currentTheme.value = theme;
  uiPreferences.theme = theme;
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("vrc.theme", theme);
}

function applyTheme(theme: UiTheme) {
  const themeOption = themeOptions.find((item) => item.value === theme) ?? themeOptions[0];
  applyThemeToDocument(theme);
  uiPreferences.accentColor = themeOption.accentColor;
  uiPreferences.successColor = themeOption.successColor;
  uiPreferences.warningColor = themeOption.warningColor;
  uiPreferences.dangerColor = themeOption.dangerColor;
  applyAppearanceToDocument();
  void saveUiPreferences({
    theme,
    accentColor: themeOption.accentColor,
    successColor: themeOption.successColor,
    warningColor: themeOption.warningColor,
    dangerColor: themeOption.dangerColor,
  });
}

function updateUiPreference<K extends keyof UiPreferences>(key: K, value: UiPreferences[K]) {
  uiPreferences[key] = value;
  if (key === "theme") {
    applyThemeToDocument(value as UiTheme);
  }
  applyAppearanceToDocument();
  void saveUiPreferences({ [key]: value } as Partial<UiPreferences>);
}

function applyAppearanceToDocument() {
  const style = document.documentElement.style;
  const isDark = resolvedAppearanceDark.value;
  const consoleTheme = currentConsoleTheme.value.colors;
  style.setProperty("--vrc-accent", uiPreferences.accentColor);
  style.setProperty("--vrc-accent-hover", `color-mix(in srgb, ${uiPreferences.accentColor} ${isDark ? 76 : 82}%, ${isDark ? "white" : "black"})`);
  style.setProperty("--vrc-accent-soft", `color-mix(in srgb, ${uiPreferences.accentColor} ${isDark ? 22 : 13}%, var(--vrc-surface))`);
  style.setProperty("--vrc-success", uiPreferences.successColor);
  style.setProperty("--vrc-warning", uiPreferences.warningColor);
  style.setProperty("--vrc-danger", uiPreferences.dangerColor);
  style.setProperty("--vrc-ui-font", currentUiFont.value.family);
  style.setProperty("--vrc-ui-font-size", `${uiPreferences.uiFontSize}px`);
  style.setProperty("--vrc-terminal-bg", consoleTheme.background);
  style.setProperty("--vrc-terminal-surface", consoleTheme.surface);
  style.setProperty("--vrc-terminal-toolbar", consoleTheme.toolbar);
  style.setProperty("--vrc-terminal-border", consoleTheme.border);
  style.setProperty("--vrc-terminal-border-strong", consoleTheme.borderStrong);
  style.setProperty("--vrc-terminal-text", consoleTheme.text);
  style.setProperty("--vrc-terminal-text-muted", `color-mix(in srgb, ${consoleTheme.text} 66%, transparent)`);
  style.setProperty("--vrc-terminal-control-bg", `color-mix(in srgb, ${consoleTheme.text} 8%, transparent)`);
  style.setProperty("--vrc-terminal-control-border", `color-mix(in srgb, ${consoleTheme.text} 12%, transparent)`);
  style.setProperty("--vrc-terminal-overlay", `color-mix(in srgb, ${consoleTheme.toolbar} 92%, transparent)`);
  style.setProperty("--vrc-terminal-shadow", `0 12px 28px color-mix(in srgb, ${consoleTheme.background} 58%, transparent)`);
  style.setProperty("--vrc-terminal-success", consoleTheme.success);
  style.setProperty("color-scheme", isDark ? "dark" : "light");
  document.documentElement.dataset.tone = isDark ? "dark" : "light";

  const darkThemeVariables: Record<string, string> = {
    "--vrc-bg": "#0f1417",
    "--vrc-surface": "#161d21",
    "--vrc-surface-muted": "#202a2f",
    "--vrc-surface-raised": "#1b2429",
    "--vrc-border": "#314047",
    "--vrc-border-strong": "#536670",
    "--vrc-text": "#d8e0e4",
    "--vrc-text-muted": "#93a1aa",
    "--vrc-text-subtle": "#6b7880",
    "--vrc-tooltip-bg": "#0a0f12",
    "--vrc-shadow": "0 16px 38px rgba(0, 0, 0, 0.34)",
  };
  for (const [name, value] of Object.entries(darkThemeVariables)) {
    if (isDark) style.setProperty(name, value);
    else style.removeProperty(name);
  }
}

function handleAppearanceMediaChange(event: MediaQueryListEvent) {
  systemDark.value = event.matches;
  if (uiPreferences.toneMode === "system") applyAppearanceToDocument();
}

function normalizeHexColor(value: unknown, fallback: string) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : fallback;
}

function normalizeAppearanceNumber(value: unknown, min: number, max: number, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
}

function normalizeAppearanceDecimal(value: unknown, min: number, max: number, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number * 100) / 100)) : fallback;
}

function normalizeConsoleTheme(value: unknown): ConsoleThemeMode {
  const legacyMap: Record<string, ConsoleThemeMode> = { classic: "vrc", slate: "tokyo-night", matrix: "nord", paper: "light" };
  const normalized = typeof value === "string" ? legacyMap[value] ?? value : value;
  return consoleThemeOptions.some((item) => item.value === normalized) ? normalized as ConsoleThemeMode : defaultUiPreferences.consoleTheme;
}

function normalizeConsoleFontPreset(value: unknown): ConsoleFontPreset {
  const normalized = value === "consolas" ? "cascadia" : value;
  return consoleFontOptions.some((item) => item.value === normalized) ? normalized as ConsoleFontPreset : defaultUiPreferences.consoleFontPreset;
}

function normalizeUiFontPreset(value: unknown): UiFontPreset {
  return uiFontOptions.some((item) => item.value === value) ? value as UiFontPreset : defaultUiPreferences.uiFontPreset;
}

async function saveUiPreferences(preferences: Partial<UiPreferences>) {
  try {
    const result = await postJson<{ preferences: Partial<UiPreferences> }>("/api/preferences/ui", preferences, "PATCH");
    applyUiPreferences(result.preferences);
  } catch (error) {
    setErrorMessage(error instanceof Error ? `保存本地偏好失败：${error.message}` : "保存本地偏好失败");
  }
}

function setAppearanceAccentColor(color: string) {
  updateUiPreference("accentColor", normalizeHexColor(color, uiPreferences.accentColor));
}

function updateAppearanceColor(key: "accentColor" | "successColor" | "warningColor" | "dangerColor" | "backgroundColor", color: string | null) {
  if (!color) return;
  updateUiPreference(key, normalizeHexColor(color, uiPreferences[key]));
}

function persistAppearanceNumber(key: "backgroundOpacity" | "backgroundBlur" | "backgroundOverlay" | "consoleFontSize" | "consoleWatermarkOpacity") {
  persistAppearancePreference(key);
}

function persistAppearancePreference<K extends keyof UiPreferences>(key: K) {
  applyAppearanceToDocument();
  void saveUiPreferences({ [key]: uiPreferences[key] } as Partial<UiPreferences>);
}

function loadChromeExtensionServiceSettings(): ChromeExtensionServiceSettings {
  try {
    const raw = localStorage.getItem(chromeExtensionServiceStorageKey);
    const parsed = raw ? JSON.parse(raw) as Partial<ChromeExtensionServiceSettings> : {};
    return {
      mode: parsed.mode === "local" ? "local" : "intranet",
      scheme: parsed.scheme === "https" ? "https" : "http",
      host: typeof parsed.host === "string" && parsed.host.trim() ? parsed.host.trim() : defaultChromeExtensionServiceSettings.host,
      port: normalizeAppearanceNumber(parsed.port, 1, 65535, defaultChromeExtensionServiceSettings.port),
    };
  } catch {
    return { ...defaultChromeExtensionServiceSettings };
  }
}

function loadChromeExtensionLocalConnections(): ChromeExtensionLocalConnection[] {
  try {
    const raw = localStorage.getItem(chromeExtensionConnectionsStorageKey);
    const parsed = raw ? JSON.parse(raw) as ChromeExtensionLocalConnection[] : null;
    if (!Array.isArray(parsed) || !parsed.length) return [];
    const storedConnections: ChromeExtensionLocalConnection[] = parsed
      .filter((item) => (
        item
        && typeof item.id === "string"
        && !deprecatedChromeExtensionSampleConnectionIds.has(item.id)
        && typeof item.name === "string"
        && typeof item.host === "string"
      ))
      .map((item) => ({
        id: item.id,
        name: item.name,
        providerType: ["xenserver", "vmware", "proxmox"].includes(item.providerType) ? item.providerType : "xenserver",
        host: item.host,
        username: item.username || "root",
        storage: "local-encrypted",
        status: item.status === "pending" ? "pending" : "ready",
        lastUsed: item.lastUsed || "刚刚",
      }));
    if (storedConnections.length !== parsed.length) {
      localStorage.setItem(chromeExtensionConnectionsStorageKey, JSON.stringify(storedConnections));
    }
    return storedConnections;
  } catch {
    return [];
  }
}

function persistChromeExtensionServiceSettings(showMessage = true) {
  chromeExtensionService.host = chromeExtensionService.host.trim() || (chromeExtensionService.mode === "local" ? "127.0.0.1" : defaultChromeExtensionServiceSettings.host);
  chromeExtensionService.port = normalizeAppearanceNumber(chromeExtensionService.port, 1, 65535, defaultChromeExtensionServiceSettings.port);
  localStorage.setItem(chromeExtensionServiceStorageKey, JSON.stringify({ ...chromeExtensionService }));
  if (showMessage) ElMessage.success({ message: "Chrome 插件服务地址已保存", duration: VRC_TOAST_DURATION_MS });
}

function setChromeExtensionServiceMode(mode: ChromeExtensionServiceMode) {
  chromeExtensionService.mode = mode;
  if (mode === "local" && (!chromeExtensionService.host || chromeExtensionService.host === defaultChromeExtensionServiceSettings.host)) {
    chromeExtensionService.host = "127.0.0.1";
  }
  if (mode === "intranet" && chromeExtensionService.host === "127.0.0.1") {
    chromeExtensionService.host = defaultChromeExtensionServiceSettings.host;
  }
  persistChromeExtensionServiceSettings(false);
}

function handleChromeExtensionServiceModeChange(mode: string | number | boolean) {
  if (mode !== "intranet" && mode !== "local") return;
  setChromeExtensionServiceMode(mode);
}

function testChromeExtensionService() {
  ElMessage.success({ message: `已检测 ${chromeExtensionBaseUrl.value}/api/health`, duration: VRC_TOAST_DURATION_MS });
}

function persistChromeExtensionLocalConnections() {
  localStorage.setItem(chromeExtensionConnectionsStorageKey, JSON.stringify(chromeExtensionLocalConnections.value));
}

function addChromeExtensionLocalConnection() {
  const name = chromeExtensionDraftConnection.name.trim();
  const host = chromeExtensionDraftConnection.host.trim();
  if (!name || !host) {
    ElMessage.error({ message: "请填写连接名称和 Host", duration: VRC_TOAST_DURATION_MS });
    return;
  }
  chromeExtensionLocalConnections.value = [
    {
      id: `local-${Date.now()}`,
      name,
      providerType: chromeExtensionDraftConnection.providerType,
      host,
      username: chromeExtensionDraftConnection.username.trim() || "root",
      storage: "local-encrypted",
      status: "pending",
      lastUsed: "刚刚保存",
    },
    ...chromeExtensionLocalConnections.value,
  ];
  persistChromeExtensionLocalConnections();
  chromeExtensionDraftConnection.name = "新连接";
  chromeExtensionDraftConnection.host = "";
  chromeExtensionDraftConnection.password = "";
  ElMessage.success({ message: "连接已保存到浏览器本地密文库", duration: VRC_TOAST_DURATION_MS });
}

async function deleteChromeExtensionLocalConnection(item: ChromeExtensionLocalConnection) {
  try {
    await confirmVrcAction({
      heading: "删除本地连接",
      tone: "本地配置",
      summary: `${item.name} · ${providerLabel(item.providerType)} · ${item.host}`,
      detail: "只会移除当前浏览器本地保存的连接信息，不会修改服务器、虚拟机、存储或网络。",
      confirmButtonText: "确认删除",
      customClass: "connection-delete-message-box",
    });
  } catch {
    return;
  }
  chromeExtensionLocalConnections.value = chromeExtensionLocalConnections.value.filter((connectionItem) => connectionItem.id !== item.id);
  persistChromeExtensionLocalConnections();
  ElMessage.success({ message: "本地连接已删除", duration: VRC_TOAST_DURATION_MS });
}

function defaultIpPoolPolicy(): IpPoolPolicy {
  return {
    defaultDns: [],
    ipPools: [],
  };
}

function emptyIpPoolDraft(): IpPoolEditorDraft {
  return {
    id: "",
    name: "",
    prefix: "",
    gateway: "",
    startHost: 20,
    endHost: 250,
    hostPrefixesText: "",
    networkName: "",
    dnsText: "",
    vlan: "",
  };
}

function cloneIpPoolItem(item: RuntimeIpPoolPolicy): RuntimeIpPoolPolicy {
  return {
    ...item,
    dns: item.dns ? [...item.dns] : undefined,
    hostPrefixes: item.hostPrefixes ? [...item.hostPrefixes] : undefined,
  };
}

function normalizeIpPoolPolicyForEditor(input: Partial<IpPoolPolicy> | undefined): IpPoolPolicy {
  const defaultPolicy = defaultIpPoolPolicy();
  const defaultDns = Array.isArray(input?.defaultDns) && input.defaultDns.length ? parseCsvList(input.defaultDns.join(",")) : defaultPolicy.defaultDns;
  const ipPools = Array.isArray(input?.ipPools) ? input.ipPools.map(normalizeIpPoolItem).filter(Boolean) as RuntimeIpPoolPolicy[] : [];
  return {
    defaultDns: defaultDns.length ? defaultDns : defaultPolicy.defaultDns,
    ipPools: ipPools.length ? ipPools : defaultPolicy.ipPools,
  };
}

function normalizeImportedIpPoolPolicy(input: unknown): IpPoolPolicy {
  if (!input || typeof input !== "object") throw new Error("JSON 根节点必须是对象");
  const policy = input as Partial<IpPoolPolicy>;
  if (!Array.isArray(policy.ipPools) || !policy.ipPools.length) throw new Error("缺少 ipPools 数组");
  const ipPools = policy.ipPools.map(normalizeIpPoolItem).filter(Boolean) as RuntimeIpPoolPolicy[];
  if (!ipPools.length) throw new Error("没有可导入的 IP 池");
  return {
    defaultDns: Array.isArray(policy.defaultDns) && policy.defaultDns.length ? parseCsvList(policy.defaultDns.join(",")) : defaultIpPoolPolicy().defaultDns,
    ipPools,
  };
}

function normalizeIpPoolItem(input: unknown): RuntimeIpPoolPolicy | null {
  if (!input || typeof input !== "object") return null;
  const item = input as Partial<RuntimeIpPoolPolicy>;
  const prefix = String(item.prefix ?? "").trim();
  const gateway = String(item.gateway ?? "").trim();
  const name = String(item.name ?? "").trim();
  if (!prefix || !gateway || !name) return null;
  return {
    id: String(item.id || `pool-${prefix.replaceAll(".", "-")}`).trim(),
    name,
    prefix,
    gateway,
    dns: Array.isArray(item.dns) ? parseCsvList(item.dns.join(",")) : undefined,
    startHost: normalizeHostOctet(item.startHost, 20),
    endHost: normalizeHostOctet(item.endHost, 250),
    hostPrefixes: Array.isArray(item.hostPrefixes) ? parseCsvList(item.hostPrefixes.join(",")) : undefined,
    networkName: typeof item.networkName === "string" && item.networkName.trim() ? item.networkName.trim() : undefined,
    vlan: typeof item.vlan === "string" && item.vlan.trim() ? item.vlan.trim() : undefined,
  };
}

function normalizeHostOctet(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 && number < 255 ? number : fallback;
}

function parseCsvList(value: string) {
  return value.split(/[,，\s]+/).map((item) => item.trim()).filter(Boolean);
}

function applyIpPoolPolicy(policy: Partial<IpPoolPolicy> | undefined, selectedId?: string) {
  const normalized = normalizeIpPoolPolicyForEditor(policy);
  ipPoolPolicy.value = normalized;
  ipPoolDefaultDnsText.value = normalized.defaultDns.join(", ");
  ipPoolSelectedId.value = selectedId && normalized.ipPools.some((item) => item.id === selectedId) ? selectedId : normalized.ipPools[0]?.id ?? "";
  ipPoolPolicyRevision.value += 1;
  syncIpPoolDraftFromSelection();
}

async function loadIpPoolPolicy() {
  ipPoolLoading.value = true;
  try {
    const result = await postJson<IpPoolPolicyResponse>("/api/ip-pools/policy", undefined, "GET");
    applyIpPoolPolicy(result.policy, ipPoolSelectedId.value);
  } catch (error) {
    ipPoolPolicy.value = { defaultDns: [], ipPools: [] };
    ipPoolDefaultDnsText.value = "";
    ipPoolSelectedId.value = "";
    syncIpPoolDraftFromSelection();
    setErrorMessage(error instanceof Error ? `读取 IP 池失败：${error.message}` : "读取 IP 池失败", false);
  } finally {
    ipPoolLoading.value = false;
  }
}

async function loadMaintenanceGeneratedIsos(options: { silent?: boolean } = {}) {
  if (maintenanceIsoLoading.value) return;
  const startedAt = Date.now();
  maintenanceIsoLoading.value = true;
  maintenanceIsoStatus.value = options.silent ? maintenanceIsoStatus.value : "正在扫描安装临时介质";
  maintenanceIsoError.value = "";
  try {
    const result = await postJson<{ report: MaintenanceGeneratedIsoReport }>("/api/maintenance/generated-isos", undefined, "GET");
    maintenanceIsoReport.value = result.report;
    maintenanceIsoScannedAt.value = formatActivityTime();
    const summary = result.report.summary;
    maintenanceIsoStatus.value = `扫描完成，记录 ${summary.total} 条，可清理 ${summary.eligible} 条`;
  } catch (error) {
    maintenanceIsoStatus.value = "";
    maintenanceIsoError.value = error instanceof Error ? error.message : "扫描 VRC 残留失败";
    ElMessage.error({ message: maintenanceIsoError.value, duration: VRC_TOAST_DURATION_MS });
  } finally {
    const remaining = 300 - (Date.now() - startedAt);
    if (remaining > 0) await new Promise((resolve) => window.setTimeout(resolve, remaining));
    maintenanceIsoLoading.value = false;
  }
}

async function cleanupMaintenanceGeneratedIsos() {
  const count = maintenanceIsoSummary.value.eligible;
  if (!count) return;
  await confirmVrcAction({
    heading: "清理 VRC 临时介质",
    tone: "维护操作",
    summary: `将清理 ${count} 条已登记、任务已结束且校验通过的 vrc-*.iso / 临时介质。`,
    detail: "不会按文件名前缀批量删除原始系统 ISO；缺少连接信息、仍被挂载或任务未结束的记录会跳过。",
    confirmButtonText: "确认清理",
  });
  maintenanceIsoCleaning.value = true;
  try {
    const result = await postJson<{ report: MaintenanceGeneratedIsoReport }>(
      "/api/maintenance/generated-isos/cleanup",
      { confirmToken: "CONFIRMED" },
    );
    const summary = result.report.summary;
    const message = `清理完成，成功 ${summary.cleaned} 条，失败 ${summary.failed} 条，跳过 ${summary.skipped} 条`;
    await loadMaintenanceGeneratedIsos({ silent: true });
    maintenanceIsoStatus.value = message;
    ElMessage.success({ message, duration: VRC_TOAST_DURATION_MS });
    pushActivity("清理 VRC 临时介质", {
      detail: message,
      target: "设置 / 维护",
      request: "POST /api/maintenance/generated-isos/cleanup",
      status: summary.failed ? "warning" : "success",
    });
  } catch (error) {
    ElMessage.error({ message: error instanceof Error ? error.message : "清理 VRC 残留失败", duration: VRC_TOAST_DURATION_MS });
  } finally {
    maintenanceIsoCleaning.value = false;
  }
}

function syncIpPoolDraftFromSelection() {
  const pool = selectedIpPool.value;
  Object.assign(ipPoolDraft, pool ? {
    id: pool.id,
    name: pool.name,
    prefix: pool.prefix,
    gateway: pool.gateway,
    startHost: pool.startHost ?? 20,
    endHost: pool.endHost ?? 250,
    hostPrefixesText: pool.hostPrefixes?.join(", ") ?? "",
    networkName: pool.networkName ?? "",
    dnsText: pool.dns?.join(", ") ?? "",
    vlan: pool.vlan ?? "",
  } : emptyIpPoolDraft());
}

function commitIpPoolDraftToMemory(validate: boolean) {
  if (!ipPoolDraft.id) return true;
  const index = ipPoolPolicy.value.ipPools.findIndex((item) => item.id === ipPoolDraft.id);
  if (index < 0) return true;
  const next = buildIpPoolItemFromDraft(validate);
  if (!next) return false;
  ipPoolPolicy.value = {
    ...ipPoolPolicy.value,
    ipPools: ipPoolPolicy.value.ipPools.map((item, itemIndex) => itemIndex === index ? next : item),
  };
  return true;
}

function buildIpPoolItemFromDraft(validate: boolean): RuntimeIpPoolPolicy | null {
  const name = ipPoolDraft.name.trim();
  const prefix = ipPoolDraft.prefix.trim();
  const gateway = ipPoolDraft.gateway.trim();
  const startHost = normalizeHostOctet(ipPoolDraft.startHost, 20);
  const endHost = normalizeHostOctet(ipPoolDraft.endHost, 250);
  if (validate) {
    if (!name) return showIpPoolValidationError("请填写 IP 池名称");
    if (!isIpv4Prefix(prefix)) return showIpPoolValidationError("请填写正确的虚拟机 IP 段，格式为 IPv4 前三段");
    if (!isIpv4(gateway)) return showIpPoolValidationError("请填写正确的网关 IPv4 地址");
    if (!gateway.startsWith(`${prefix}.`)) return showIpPoolValidationError("网关必须属于当前 IP 池网段");
    if (startHost > endHost) return showIpPoolValidationError("起始 IP 尾号不能大于结束 IP 尾号");
  }
  const item: RuntimeIpPoolPolicy = {
    id: ipPoolDraft.id,
    name: name || "未命名 IP 池",
    prefix,
    gateway,
    startHost,
    endHost,
  };
  const hostPrefixes = parseCsvList(ipPoolDraft.hostPrefixesText);
  const dns = parseCsvList(ipPoolDraft.dnsText);
  if (hostPrefixes.length) item.hostPrefixes = hostPrefixes;
  if (dns.length) item.dns = dns;
  if (ipPoolDraft.networkName.trim()) item.networkName = ipPoolDraft.networkName.trim();
  if (ipPoolDraft.vlan.trim()) item.vlan = ipPoolDraft.vlan.trim();
  return item;
}

function showIpPoolValidationError(message: string): null {
  ElMessage.error({ message, duration: VRC_TOAST_DURATION_MS });
  return null;
}

function buildIpPoolPolicyForSave(validate: boolean): IpPoolPolicy | null {
  if (!commitIpPoolDraftToMemory(validate)) return null;
  const defaultDns = parseCsvList(ipPoolDefaultDnsText.value);
  const ipPools = ipPoolPolicy.value.ipPools.map((item) => normalizeIpPoolItem(item)).filter(Boolean) as RuntimeIpPoolPolicy[];
  if (validate && !defaultDns.length) return showIpPoolValidationError("请填写默认 DNS") as null;
  if (validate && !ipPools.length) return showIpPoolValidationError("至少保留一个 IP 池") as null;
  if (validate) {
    const validationMessage = validateIpPoolPolicyForSave({ defaultDns, ipPools });
    if (validationMessage) return showIpPoolValidationError(validationMessage) as null;
  }
  return {
    defaultDns,
    ipPools,
  };
}

function validateIpPoolPolicyForSave(policy: IpPoolPolicy): string | null {
  const invalidDefaultDns = policy.defaultDns.filter((item) => !isIpv4(item));
  if (invalidDefaultDns.length) return `默认 DNS 格式不正确：${invalidDefaultDns.join("、")}`;
  const ids = new Set<string>();
  const prefixes = new Set<string>();
  for (const pool of policy.ipPools) {
    if (!pool.id) return "IP 池 ID 不能为空";
    if (ids.has(pool.id)) return `IP 池 ID 重复：${pool.id}`;
    ids.add(pool.id);
    if (!pool.name.trim()) return "IP 池名称不能为空";
    if (!isIpv4Prefix(pool.prefix)) return `IP 池网段格式不正确：${pool.name}`;
    if (prefixes.has(pool.prefix)) return `IP 池网段重复：${pool.prefix}`;
    prefixes.add(pool.prefix);
    if (!isIpv4(pool.gateway)) return `IP 池网关格式不正确：${pool.name}`;
    if (!pool.gateway.startsWith(`${pool.prefix}.`)) return `IP 池网关必须属于本网段：${pool.name}`;
    if ((pool.startHost ?? 20) > (pool.endHost ?? 250)) return `IP 池起始尾号不能大于结束尾号：${pool.name}`;
    const invalidDns = (pool.dns ?? []).filter((item) => !isIpv4(item));
    if (invalidDns.length) return `IP 池 DNS 格式不正确：${pool.name}，${invalidDns.join("、")}`;
    const invalidHostPrefixes = (pool.hostPrefixes ?? []).filter((item) => !isIpv4Prefix(item));
    if (invalidHostPrefixes.length) return `适用物理机网段格式不正确：${pool.name}，${invalidHostPrefixes.join("、")}`;
  }
  return null;
}

async function saveIpPoolPolicy() {
  const policy = buildIpPoolPolicyForSave(true);
  if (!policy) return;
  ipPoolSaving.value = true;
  try {
    const result = await postJson<IpPoolPolicyResponse>("/api/ip-pools/policy", policy, "PATCH");
    applyIpPoolPolicy(result.policy, ipPoolSelectedId.value);
    notifyIpPoolPolicyUpdated(result.policy);
    ElMessage.success({ message: "IP 池配置已保存", duration: VRC_TOAST_DURATION_MS });
  } catch (error) {
    ElMessage.error({ message: error instanceof Error ? error.message : "保存 IP 池失败", duration: VRC_TOAST_DURATION_MS });
  } finally {
    ipPoolSaving.value = false;
  }
}

function notifyIpPoolPolicyUpdated(policy: IpPoolPolicy) {
  window.dispatchEvent(new CustomEvent<IpPoolPolicy>("vrc:ip-pool-policy-updated", { detail: policy }));
}

function selectIpPool(id: string) {
  commitIpPoolDraftToMemory(false);
  ipPoolSelectedId.value = id;
  syncIpPoolDraftFromSelection();
}

function createIpPool() {
  commitIpPoolDraftToMemory(false);
  const id = `pool-custom-${Date.now()}`;
  const pool: RuntimeIpPoolPolicy = {
    id,
    name: "新 IP 池",
    prefix: "",
    gateway: "",
    startHost: 20,
    endHost: 250,
  };
  ipPoolPolicy.value = { ...ipPoolPolicy.value, ipPools: [pool, ...ipPoolPolicy.value.ipPools] };
  selectIpPool(id);
}

function copySelectedIpPool() {
  if (!selectedIpPool.value) return;
  commitIpPoolDraftToMemory(false);
  const source = selectedIpPool.value;
  const id = `${source.id}-copy-${Date.now()}`;
  const pool = cloneIpPoolItem({ ...source, id, name: `${source.name} 副本` });
  ipPoolPolicy.value = { ...ipPoolPolicy.value, ipPools: [pool, ...ipPoolPolicy.value.ipPools] };
  selectIpPool(id);
}

async function deleteSelectedIpPool() {
  if (!selectedIpPool.value) return;
  if (ipPoolPolicy.value.ipPools.length <= 1) {
    ElMessage.warning({ message: "至少保留一个 IP 池", duration: VRC_TOAST_DURATION_MS });
    return;
  }
  await confirmVrcAction({
    heading: "删除 IP 池",
    tone: "危险操作",
    summary: `对象：${selectedIpPool.value.name}`,
    detail: "删除后该地址池不再参与后续虚拟机地址分配；当前未保存的修改也会丢失。",
    confirmButtonText: "删除",
  });
  const deletingId = selectedIpPool.value.id;
  ipPoolPolicy.value = {
    ...ipPoolPolicy.value,
    ipPools: ipPoolPolicy.value.ipPools.filter((item) => item.id !== deletingId),
  };
  ipPoolSelectedId.value = ipPoolPolicy.value.ipPools[0]?.id ?? "";
  syncIpPoolDraftFromSelection();
}

async function resetIpPoolPolicy() {
  await confirmVrcAction({
    heading: "清空 IP 池配置",
    tone: "需确认",
    summary: "对象：当前 IP 池编辑内容",
    detail: "当前未保存的编辑会被默认配置覆盖。",
    confirmButtonText: "清空",
  });
  applyIpPoolPolicy(defaultIpPoolPolicy());
}

function selectIpPoolsJson() {
  ipPoolsJsonFileInput.value?.click();
}

async function handleIpPoolsJsonChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  ipPoolSaving.value = true;
  try {
    const policy = normalizeImportedIpPoolPolicy(JSON.parse(await file.text()));
    const validationMessage = validateIpPoolPolicyForSave(policy);
    if (validationMessage) throw new Error(validationMessage);
    const result = await postJson<IpPoolPolicyResponse>("/api/ip-pools/policy", policy, "PATCH");
    applyIpPoolPolicy(result.policy);
    notifyIpPoolPolicyUpdated(result.policy);
    ElMessage.success({ message: "IP 池 JSON 已导入并保存", duration: VRC_TOAST_DURATION_MS });
  } catch (error) {
    ElMessage.error({ message: error instanceof Error ? error.message : "IP 池 JSON 导入失败", duration: VRC_TOAST_DURATION_MS });
  } finally {
    ipPoolSaving.value = false;
  }
}

function exportIpPoolPolicy() {
  const policy = buildIpPoolPolicyForSave(false);
  if (!policy) return;
  const blob = new Blob([`${JSON.stringify(policy, null, 2)}\n`], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "ip-pools.json";
  link.click();
  URL.revokeObjectURL(link.href);
}

function isIpv4Prefix(value: string) {
  const parts = value.split(".");
  return parts.length === 3 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

function selectAppearanceImage() {
  appearanceImageFileInput.value?.click();
}

async function handleAppearanceImageChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || appearanceImageUploading.value) return;

  try {
    await validateAppearanceImage(file);
    appearanceImageUploading.value = true;
    const formData = new FormData();
    formData.append("file", file);
    const response = await fetch("/api/preferences/ui/background-image", { method: "POST", body: formData });
    const result = (await response.json()) as { preferences?: Partial<UiPreferences>; message?: string };
    if (!response.ok || !result.preferences) throw new Error(result.message || "上传背景图片失败");
    applyUiPreferences(result.preferences);
    ElMessage.success({ message: "背景图片已应用", duration: VRC_TOAST_DURATION_MS });
  } catch (error) {
    ElMessage.error({ message: error instanceof Error ? error.message : "上传背景图片失败", duration: VRC_TOAST_DURATION_MS });
  } finally {
    appearanceImageUploading.value = false;
  }
}

async function validateAppearanceImage(file: File) {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    throw new Error("背景图片仅支持 JPG、PNG 和 WebP");
  }
  if (file.size > 16 * 1024 * 1024) {
    throw new Error("背景图片不能超过 16MB");
  }
  const objectUrl = URL.createObjectURL(file);
  try {
    await new Promise<void>((resolve, reject) => {
      const image = new Image();
      image.addEventListener("load", () => resolve(), { once: true });
      image.addEventListener("error", () => reject(new Error("图片无法读取，请更换文件")), { once: true });
      image.src = objectUrl;
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function selectAppearanceJson() {
  appearanceJsonFileInput.value?.click();
}

async function handleAppearanceJsonChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  try {
    const config = JSON.parse(await file.text()) as AppearanceImportConfig;
    const preferences = normalizeImportedAppearance(config);
    const result = await postJson<{ preferences: Partial<UiPreferences> }>("/api/preferences/ui", preferences, "PATCH");
    applyUiPreferences(result.preferences);
    ElMessage.success({ message: "主题配置已载入", duration: VRC_TOAST_DURATION_MS });
  } catch (error) {
    ElMessage.error({ message: error instanceof Error ? error.message : "主题配置文件格式不正确", duration: VRC_TOAST_DURATION_MS });
  }
}

function normalizeImportedAppearance(config: AppearanceImportConfig): Partial<UiPreferences> {
  const importedTheme = config.baseTheme ?? config.theme;
  const theme = normalizeTheme(typeof importedTheme === "string" ? importedTheme : undefined);
  const themeOption = themeOptions.find((item) => item.value === theme) ?? themeOptions[0];
  const colors = config.colors ?? config;
  const background = config.background ?? config;
  const typography = config.typography ?? config;
  const console = config.console ?? config;
  const cursorStyle = console.cursorStyle;
  return {
    theme,
    toneMode: config.toneMode === "system" || config.toneMode === "dark" ? config.toneMode : "light",
    accentColor: normalizeHexColor(colors.accent ?? colors.accentColor, themeOption.accentColor),
    successColor: normalizeHexColor(colors.success ?? colors.successColor, themeOption.successColor),
    warningColor: normalizeHexColor(colors.warning ?? colors.warningColor, themeOption.warningColor),
    dangerColor: normalizeHexColor(colors.danger ?? colors.dangerColor, themeOption.dangerColor),
    backgroundMode: background.mode === "solid" || background.mode === "image" ? background.mode : "default",
    backgroundColor: normalizeHexColor(background.color ?? background.backgroundColor, defaultUiPreferences.backgroundColor),
    backgroundOpacity: normalizeAppearanceNumber(background.opacity ?? background.backgroundOpacity, 5, 60, defaultUiPreferences.backgroundOpacity),
    backgroundBlur: normalizeAppearanceNumber(background.blur ?? background.backgroundBlur, 0, 16, defaultUiPreferences.backgroundBlur),
    backgroundOverlay: normalizeAppearanceNumber(background.overlay ?? background.backgroundOverlay, 0, 35, defaultUiPreferences.backgroundOverlay),
    uiFontPreset: normalizeUiFontPreset(typography.family ?? typography.uiFontPreset),
    uiFontSize: normalizeAppearanceNumber(typography.size ?? typography.uiFontSize, 11, 13, defaultUiPreferences.uiFontSize),
    reduceMotion: typeof typography.reduceMotion === "boolean" ? typography.reduceMotion : defaultUiPreferences.reduceMotion,
    consoleTheme: normalizeConsoleTheme(console.theme ?? console.consoleTheme),
    consoleFontPreset: normalizeConsoleFontPreset(console.fontPreset ?? console.consoleFontPreset),
    consoleFontSize: normalizeAppearanceNumber(console.fontSize ?? console.consoleFontSize, 11, 18, defaultUiPreferences.consoleFontSize),
    consoleLineHeight: normalizeAppearanceDecimal(console.lineHeight ?? console.consoleLineHeight, 1.05, 1.6, defaultUiPreferences.consoleLineHeight),
    consoleCursorStyle: cursorStyle === "underline" || cursorStyle === "bar" || cursorStyle === "block" ? cursorStyle : "block",
    consoleCursorBlink: typeof console.cursorBlink === "boolean" ? console.cursorBlink : defaultUiPreferences.consoleCursorBlink,
    consoleScaleMode: console.scaleMode === "remote" ? "remote" : "local",
    consoleQuality: console.quality === "high" || console.quality === "smooth" ? console.quality : "auto",
    consoleWatermarkEnabled:
      typeof console.watermarkEnabled === "boolean"
        ? console.watermarkEnabled
        : typeof (console.watermark as Record<string, unknown> | undefined)?.enabled === "boolean"
          ? Boolean((console.watermark as Record<string, unknown>).enabled)
          : defaultUiPreferences.consoleWatermarkEnabled,
    consoleWatermarkScope:
      (console.watermark as Record<string, unknown> | undefined)?.scope === "workspace" || console.watermarkScope === "workspace"
        ? "workspace"
        : "console",
    consoleWatermarkDensity:
      (console.watermark as Record<string, unknown> | undefined)?.density === "sparse" || (console.watermark as Record<string, unknown> | undefined)?.density === "dense"
        ? (console.watermark as Record<string, unknown>).density as WatermarkDensity
        : console.watermarkDensity === "sparse" || console.watermarkDensity === "dense"
          ? console.watermarkDensity as WatermarkDensity
          : "standard",
    consoleWatermarkOpacity: normalizeAppearanceNumber(
      (console.watermark as Record<string, unknown> | undefined)?.opacity ?? console.watermarkOpacity,
      6,
      24,
      defaultUiPreferences.consoleWatermarkOpacity,
    ),
  };
}

function exportAppearanceConfig() {
  const config = {
    version: 1,
    baseTheme: uiPreferences.theme,
    toneMode: uiPreferences.toneMode,
    colors: {
      accent: uiPreferences.accentColor,
      success: uiPreferences.successColor,
      warning: uiPreferences.warningColor,
      danger: uiPreferences.dangerColor,
    },
    background: {
      mode: uiPreferences.backgroundMode,
      color: uiPreferences.backgroundColor,
      imageName: uiPreferences.backgroundImageName,
      opacity: uiPreferences.backgroundOpacity,
      blur: uiPreferences.backgroundBlur,
      overlay: uiPreferences.backgroundOverlay,
    },
    typography: {
      family: uiPreferences.uiFontPreset,
      size: uiPreferences.uiFontSize,
      reduceMotion: uiPreferences.reduceMotion,
    },
    console: {
      theme: uiPreferences.consoleTheme,
      fontPreset: uiPreferences.consoleFontPreset,
      fontSize: uiPreferences.consoleFontSize,
      lineHeight: uiPreferences.consoleLineHeight,
      cursorStyle: uiPreferences.consoleCursorStyle,
      cursorBlink: uiPreferences.consoleCursorBlink,
      scaleMode: uiPreferences.consoleScaleMode,
      quality: uiPreferences.consoleQuality,
      watermark: {
        enabled: uiPreferences.consoleWatermarkEnabled,
        scope: uiPreferences.consoleWatermarkScope,
        density: uiPreferences.consoleWatermarkDensity,
        opacity: uiPreferences.consoleWatermarkOpacity,
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

async function resetAppearancePreferences() {
  try {
    const response = await fetch("/api/preferences/ui/background-image", { method: "DELETE" });
    const deleted = (await response.json()) as { preferences?: Partial<UiPreferences>; message?: string };
    if (!response.ok) throw new Error(deleted.message || "清除背景图片失败");
    const themeOption = themeOptions[0];
    const result = await postJson<{ preferences: Partial<UiPreferences> }>(
      "/api/preferences/ui",
      {
        theme: themeOption.value,
        toneMode: "light",
        accentColor: themeOption.accentColor,
        successColor: themeOption.successColor,
        warningColor: themeOption.warningColor,
        dangerColor: themeOption.dangerColor,
        backgroundMode: "default",
        backgroundColor: defaultUiPreferences.backgroundColor,
        backgroundOpacity: defaultUiPreferences.backgroundOpacity,
        backgroundBlur: defaultUiPreferences.backgroundBlur,
        backgroundOverlay: defaultUiPreferences.backgroundOverlay,
        uiFontPreset: defaultUiPreferences.uiFontPreset,
        uiFontSize: defaultUiPreferences.uiFontSize,
        reduceMotion: defaultUiPreferences.reduceMotion,
        consoleTheme: defaultUiPreferences.consoleTheme,
        consoleFontPreset: defaultUiPreferences.consoleFontPreset,
        consoleFontSize: defaultUiPreferences.consoleFontSize,
        consoleLineHeight: defaultUiPreferences.consoleLineHeight,
        consoleCursorStyle: defaultUiPreferences.consoleCursorStyle,
        consoleCursorBlink: defaultUiPreferences.consoleCursorBlink,
        consoleScaleMode: defaultUiPreferences.consoleScaleMode,
        consoleQuality: defaultUiPreferences.consoleQuality,
        consoleWatermarkEnabled: defaultUiPreferences.consoleWatermarkEnabled,
        consoleWatermarkScope: defaultUiPreferences.consoleWatermarkScope,
        consoleWatermarkDensity: defaultUiPreferences.consoleWatermarkDensity,
        consoleWatermarkOpacity: defaultUiPreferences.consoleWatermarkOpacity,
      },
      "PATCH",
    );
    applyUiPreferences(result.preferences);
    ElMessage.success({ message: "外观设置已重置", duration: VRC_TOAST_DURATION_MS });
  } catch (error) {
    ElMessage.error({ message: error instanceof Error ? error.message : "重置外观失败", duration: VRC_TOAST_DURATION_MS });
  }
}

function applyConnectionPreferences(preferences: Partial<ConnectionPreferences>) {
  selectedConnectionId.value = typeof preferences.selectedConnectionId === "string" ? preferences.selectedConnectionId : defaultConnectionPreferences.selectedConnectionId;
  connection.providerType = normalizeProviderType(preferences.providerType);
  connection.host = typeof preferences.host === "string" ? preferences.host : defaultConnectionPreferences.host;
  connection.port = normalizePort(preferences.port, connection.providerType);
  connection.username = typeof preferences.username === "string" && preferences.username.trim() ? preferences.username : defaultConnectionPreferences.username;
  connectionName.value = typeof preferences.connectionName === "string" ? preferences.connectionName : defaultConnectionPreferences.connectionName;
}

function buildConnectionPreferencesFromState(): ConnectionPreferences {
  return {
    selectedConnectionId: selectedConnectionId.value,
    providerType: connection.providerType,
    host: connection.host.trim(),
    port: normalizePort(connection.port, connection.providerType),
    username: connection.username.trim() || "root",
    connectionName: connectionName.value.trim(),
  };
}

async function saveConnectionPreferences(preferences: Partial<ConnectionPreferences>) {
  if (!persistentConnectionsEnabled.value) return;
  try {
    await postJson<{ preferences: ConnectionPreferences }>("/api/preferences/connection", preferences, "PATCH");
  } catch (error) {
    setErrorMessage(error instanceof Error ? `保存连接偏好失败：${error.message}` : "保存连接偏好失败", false);
  }
}

function queueConnectionPreferenceSave() {
  if (connectionPreferenceSaveTimer) clearTimeout(connectionPreferenceSaveTimer);
  connectionPreferenceSaveTimer = setTimeout(() => {
    connectionPreferenceSaveTimer = undefined;
    void saveConnectionPreferences(buildConnectionPreferencesFromState());
  }, 300);
}

function hasLegacyConnectionPreferences() {
  return ["vrc.connectionId", "vrc.providerType", "vrc.host", "vrc.port", "vrc.username"].some((key) => localStorage.getItem(key));
}

function clearLegacyConnectionPreferences() {
  for (const key of ["vrc.connectionId", "vrc.providerType", "vrc.host", "vrc.port", "vrc.username"]) {
    localStorage.removeItem(key);
  }
}

function consumeChromeExtensionLaunchConnection() {
  const url = new URL(window.location.href);
  const connectionId = url.searchParams.get("browserConnectionId") || url.searchParams.get("connectionId") || url.searchParams.get("vrcConnectionId") || "";
  const sessionId = url.searchParams.get("browserSessionId") || "";
  if (!connectionId) return { connectionId: "", sessionId: "" };
  url.searchParams.delete("browserConnectionId");
  url.searchParams.delete("browserSessionId");
  url.searchParams.delete("connectionId");
  url.searchParams.delete("vrcConnectionId");
  window.history.replaceState({}, document.title, `${url.pathname}${url.search}${url.hash}`);
  return { connectionId, sessionId };
}

function requestChromeExtensionConnection(input: { connectionId: string; sessionId: string }): Promise<ChromeExtensionLaunchConnection> {
  if (!input.sessionId) {
    return Promise.reject(new Error("Chrome 插件没有提供本地连接会话，请从插件连接库重新打开。"));
  }
  const requestId = `vrc-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error("等待 Chrome 插件本地连接超时，请确认插件已启用后重新打开。"));
    }, 5000);
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const data = event.data as { type?: string; requestId?: string; ok?: boolean; message?: string; connection?: ChromeExtensionLaunchConnection };
      if (data?.type !== "VRC_EXTENSION_CONNECTION_RESPONSE" || data.requestId !== requestId) return;
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      if (!data.ok || !data.connection) {
        reject(new Error(data.message || "Chrome 插件未返回本地连接"));
        return;
      }
      resolve(data.connection);
    };
    window.addEventListener("message", onMessage);
    window.postMessage(
      {
        type: "VRC_EXTENSION_CONNECTION_REQUEST",
        requestId,
        connectionId: input.connectionId,
        sessionId: input.sessionId,
      },
      window.location.origin,
    );
  });
}

function applyChromeExtensionConnection(input: ChromeExtensionLaunchConnection) {
  const summary: StoredConnectionSummary = {
    id: input.id,
    name: input.name?.trim() || `${providerLabel(input.providerType)}:${input.host}`,
    providerType: input.providerType,
    host: input.host,
    port: normalizePort(input.port, input.providerType),
    username: input.username,
    readonly: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastConnectedAt: new Date().toISOString(),
  };
  storedConnections.value = [summary, ...storedConnections.value.filter((item) => item.id !== summary.id)];
  selectedConnectionId.value = summary.id;
  connection.providerType = summary.providerType;
  connection.host = summary.host;
  connection.port = summary.port;
  connection.username = summary.username;
  connection.password = input.password;
  connectionName.value = summary.name;
  workspaceMode.value = "connection";
  resetVmOperationState();
  showConnectionEditor.value = false;
  pushActivity("插件连接", {
    target: summary.name,
    detail: `${providerLabel(summary.providerType)} · ${summary.host}:${summary.port}`,
    status: "info",
  });
}

function shouldUseLegacyConnectionPreferences(preferences?: Partial<ConnectionPreferences>) {
  if (!hasLegacyConnectionPreferences()) return false;
  if (!preferences) return true;
  return !preferences.selectedConnectionId && !preferences.host && normalizeProviderType(preferences.providerType) === "xenserver";
}

function openSettingsWorkspace() {
  workspaceMode.value = "settings";
  settingsPanel.value = "appearance";
  resetVmOperationState();
  clearConnectionFeedback();
  connectionSettingsVisible.value = false;
  vmDetailVisible.value = false;
  hostDetailVisible.value = false;
  storageDetailVisible.value = false;
  isoDetailVisible.value = false;
  provisioningVisible.value = false;
}

function closeSettingsWorkspace() {
  if (hostOverviewRows.value.length || loadingHostOverview.value) {
    resetVmOperationState();
    workspaceMode.value = "overview";
    selectedHostOverviewKey.value = "";
    return;
  }
  resetVmOperationState();
  workspaceMode.value = inventory.value ? "connection" : "empty";
}

async function loadStoredConnections() {
  if (!persistentConnectionsEnabled.value) {
    storedConnections.value = readBrowserStoredConnections().map(stripBrowserConnectionSecret);
    return;
  }
  try {
    const result = await postJson<{ connections: StoredConnectionSummary[] }>("/api/connections", undefined, "GET");
    storedConnections.value = result.connections ?? [];
  } catch (error) {
    setErrorMessage(error instanceof Error ? error.message : "读取保存连接失败", false);
  }
}

function readBrowserStoredConnections(): BrowserStoredConnection[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(browserConnectionsStorageKey) || "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is Partial<BrowserStoredConnection> => typeof item === "object" && item !== null)
      .map(normalizeBrowserStoredConnection)
      .filter((item): item is BrowserStoredConnection => Boolean(item));
  } catch {
    return [];
  }
}

function normalizeBrowserStoredConnection(item: Partial<BrowserStoredConnection>): BrowserStoredConnection | null {
  const providerType = normalizeProviderType(item.providerType);
  const host = typeof item.host === "string" ? item.host.trim() : "";
  const username = typeof item.username === "string" && item.username.trim() ? item.username.trim() : "root";
  const password = typeof item.password === "string" ? item.password : "";
  if (!host || !password) return null;
  const now = new Date().toISOString();
  return {
    id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : `browser-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : `${providerLabel(providerType)}:${host}`,
    providerType,
    host,
    port: normalizePort(item.port, providerType),
    username,
    password,
    readonly: true,
    storage: "browser-local",
    createdAt: typeof item.createdAt === "string" ? item.createdAt : now,
    updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : now,
    lastConnectedAt: typeof item.lastConnectedAt === "string" ? item.lastConnectedAt : undefined,
  };
}

function writeBrowserStoredConnections(connections: BrowserStoredConnection[]) {
  localStorage.setItem(browserConnectionsStorageKey, JSON.stringify(connections));
}

function stripBrowserConnectionSecret(connectionItem: BrowserStoredConnection): StoredConnectionSummary {
  const { password: _password, storage: _storage, ...summary } = connectionItem;
  return summary;
}

function findBrowserStoredConnection(connectionId: string): BrowserStoredConnection | undefined {
  return readBrowserStoredConnections().find((item) => item.id === connectionId);
}

function saveBrowserStoredConnection(input: {
  id?: string;
  name?: string;
  providerType: ProviderType;
  host: string;
  port: number;
  username: string;
  password: string;
}): StoredConnectionSummary {
  const connections = readBrowserStoredConnections();
  const now = new Date().toISOString();
  const matchedIndex = input.id
    ? connections.findIndex((item) => item.id === input.id)
    : connections.findIndex((item) => item.providerType === input.providerType && item.host === input.host && item.port === input.port);
  const existing = matchedIndex >= 0 ? connections[matchedIndex] : undefined;
  const record: BrowserStoredConnection = {
    id: existing?.id || `browser-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: input.name?.trim() || `${providerLabel(input.providerType)}:${input.host}`,
    providerType: input.providerType,
    host: input.host,
    port: input.port,
    username: input.username,
    password: input.password,
    readonly: true,
    storage: "browser-local",
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    lastConnectedAt: existing?.lastConnectedAt,
  };
  if (matchedIndex >= 0) connections[matchedIndex] = record;
  else connections.unshift(record);
  writeBrowserStoredConnections(connections);
  return stripBrowserConnectionSecret(record);
}

function deleteBrowserStoredConnection(connectionId: string): boolean {
  const connections = readBrowserStoredConnections();
  const next = connections.filter((item) => item.id !== connectionId);
  writeBrowserStoredConnections(next);
  return next.length !== connections.length;
}

function markBrowserStoredConnectionUsed(connectionId: string) {
  const connections = readBrowserStoredConnections();
  const index = connections.findIndex((item) => item.id === connectionId);
  if (index < 0) return;
  connections[index] = {
    ...connections[index],
    lastConnectedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeBrowserStoredConnections(connections);
}

function applyStoredConnection(connectionId: string) {
  const stored = storedConnections.value.find((item) => item.id === connectionId);
  if (!stored) return;
  const browserStored = persistentConnectionsEnabled.value ? undefined : findBrowserStoredConnection(connectionId);
  clearConnectionFeedback();
  selectedConnectionId.value = stored.id;
  connection.providerType = stored.providerType;
  connection.host = stored.host;
  connection.port = stored.port;
  connection.username = stored.username;
  connection.password = browserStored?.password || "";
  connectionName.value = stored.name;
  showConnectionEditor.value = false;
  if (persistentConnectionsEnabled.value) void saveConnectionPreferences(buildConnectionPreferencesFromState());
}

function handleStoredConnectionRowClick(row: StoredConnectionSummary) {
  applyStoredConnection(row.id);
}

async function selectConnectionAndLoad(connectionId: string) {
  if (workspaceMode.value === "connection" && selectedConnectionId.value === connectionId && inventory.value) {
    resetVmOperationState();
    vmDetailVisible.value = false;
    hostDetailVisible.value = false;
    storageDetailVisible.value = false;
    isoDetailVisible.value = false;
    provisioningVisible.value = false;
    return;
  }
  workspaceMode.value = "connection";
  resetVmOperationState();
  applyStoredConnection(connectionId);
  hostOverviewRequestSeq++;
  loadingHostOverview.value = false;
  hostOverviewRows.value = [];
  selectedHostOverviewKey.value = "";
  vmSearchCache.value = {};
  resetIsoImages();
  vmDetailVisible.value = false;
  inventory.value = null;
  selectedHostId.value = "";
  prepareVmPanelForHostLoad(false);
  await loadHostInventory();
}

function startNewConnection() {
  workspaceMode.value = "settings";
  settingsPanel.value = "connection";
  resetVmOperationState();
  clearConnectionFeedback();
  selectedConnectionId.value = "";
  connectionName.value = "";
  connection.providerType = "xenserver";
  connection.host = "";
  connection.port = defaultPortForProvider(connection.providerType);
  connection.username = "root";
  connection.password = "";
  inventory.value = null;
  vms.value = null;
  vmSummary.value = null;
  resetIsoImages();
  selectedHostId.value = "";
  showConnectionEditor.value = true;
  connectionSettingsVisible.value = false;
  pushActivity("新增连接", {
    target: "连接配置",
    detail: "已准备新连接表单",
    status: "info",
  });
}

async function saveConnection() {
  clearConnectionFeedback();
  const direct = buildDirectConnectionPayload();
  if (!direct) {
    setConnectionFeedback("error", errorMessage.value || "连接信息不完整");
    return;
  }
  clearMessages();
  savingConnection.value = true;

  try {
    const result = persistentConnectionsEnabled.value
      ? await postJson<{ connection: StoredConnectionSummary }>("/api/connections", {
          ...direct,
          id: selectedConnectionId.value || undefined,
          name: connectionName.value.trim() || `${direct.providerType}:${direct.host}`,
        })
      : {
          connection: saveBrowserStoredConnection({
            ...direct,
            id: selectedConnectionId.value || undefined,
            name: connectionName.value.trim() || `${direct.providerType}:${direct.host}`,
          }),
        };
    selectedConnectionId.value = result.connection.id;
    await loadStoredConnections();
    applyStoredConnection(result.connection.id);
    setConnectionSuccessMessage(
      persistentConnectionsEnabled.value
        ? `连接已保存：${result.connection.name}。下次可直接加载资源。`
        : `连接已保存到当前浏览器：${result.connection.name}。不会写入共享 Web 服务器。`,
    );
    pushActivity("保存连接", {
      target: result.connection.name,
      detail: `${providerLabel(result.connection.providerType)} · ${result.connection.host}:${result.connection.port}`,
      request: persistentConnectionsEnabled.value ? "POST /api/connections" : "browser.storage.local",
      status: "success",
    });
  } catch (error) {
    setConnectionErrorMessage(error instanceof Error ? error.message : "保存连接失败");
  } finally {
    savingConnection.value = false;
  }
}

async function deleteConnection() {
  if (!selectedConnectionId.value) return;
  const deletedConnection = storedConnections.value.find((item) => item.id === selectedConnectionId.value);
  try {
    await confirmVrcAction({
      heading: "删除连接",
      tone: "本地配置",
      summary: connectionDeleteConfirmSummary(deletedConnection),
      detail: "只会移除本地保存的账号配置，不会修改 XenServer 主机、虚拟机、存储或网络。",
      confirmButtonText: "删除",
      customClass: "connection-delete-message-box",
    });
  } catch {
    return;
  }

  clearMessages();
  try {
    if (persistentConnectionsEnabled.value) {
      await postJson(`/api/connections/${selectedConnectionId.value}`, undefined, "DELETE");
    } else {
      deleteBrowserStoredConnection(selectedConnectionId.value);
    }
    selectedConnectionId.value = "";
    void saveConnectionPreferences(buildConnectionPreferencesFromState());
    await loadStoredConnections();
    setConnectionSuccessMessage("保存的连接已删除。");
    pushActivity("删除连接", {
      target: deletedConnection?.name || "保存连接",
      detail: deletedConnection ? `${providerLabel(deletedConnection.providerType)} · ${deletedConnection.host}:${deletedConnection.port}` : "本地连接配置已删除",
      request: persistentConnectionsEnabled.value ? "DELETE /api/connections/:id" : "browser.storage.local",
      status: "warning",
    });
  } catch (error) {
    setConnectionErrorMessage(error instanceof Error ? error.message : "删除连接失败");
  }
}

async function loadSelectedConnectionResources() {
  if (!selectedConnectionId.value && !canLoadDirectConnection.value) {
    showConnectionEditor.value = true;
    setConnectionErrorMessage(
      persistentConnectionsEnabled.value
        ? "还没有保存连接。请先填写 Host、用户名和密码，点“保存”，之后就能加载资源。"
        : "请填写 Host、用户名和密码后加载资源；账号密码只保存到当前浏览器本地，不写入共享 Web 服务器。",
    );
    return;
  }
  clearConnectionFeedback();
  await loadHostInventory({ forceRefresh: true });
}

function openAccountImportDialog() {
  accountImportVisible.value = true;
  accountImportMode.value = "excel";
  accountImportError.value = "";
  accountImportDrafts.value = [];
  accountImportFileName.value = "";
  accountImportText.value = "";
}

function switchAccountImportMode(mode: AccountImportMode) {
  accountImportMode.value = mode;
  accountImportError.value = "";
}

function handleAccountImportTabChange(name: string | number) {
  if (name === "excel" || name === "json" || name === "fixed") {
    switchAccountImportMode(name);
  }
}

function triggerAccountImportFile() {
  accountImportFileInput.value?.click();
}

function downloadAccountImportTemplate() {
  const rows = [
    ["平台", "主机", "服务器名称", "登录账号", "登录密码", "端口"],
    ["XenServer", "192.0.2.77", "xenserver-1", "root", "P", "22"],
    ["VMware", "192.0.2.27", "vmware-27", "root", "P", "443"],
  ];
  const csv = rows.map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "vrc-server-account-template.csv";
  link.click();
  URL.revokeObjectURL(url);
}

async function handleAccountImportFileChange(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (file) {
    await parseAccountImportFile(file);
  }
  (event.target as HTMLInputElement).value = "";
}

async function handleAccountImportDrop(event: DragEvent) {
  const file = event.dataTransfer?.files?.[0];
  if (file) {
    accountImportMode.value = "excel";
    await parseAccountImportFile(file);
  }
}

async function parseAccountImport() {
  accountImportError.value = "";
  accountImportDrafts.value = [];
  parsingAccountImport.value = true;
  try {
    if (accountImportMode.value === "json") {
      accountImportDrafts.value = normalizeAccountImportRows(parseAccountImportJson(accountImportText.value));
    } else if (accountImportMode.value === "fixed") {
      accountImportDrafts.value = normalizeAccountImportRows(parseFixedAccountImport(accountImportText.value));
    } else if (accountImportFileName.value) {
      accountImportError.value = "文件已解析，可直接检查预览结果。";
    } else {
      accountImportError.value = "请先选择 .xlsx / .csv 文件。";
    }
  } catch (error) {
    accountImportError.value = error instanceof Error ? error.message : "解析失败";
  } finally {
    parsingAccountImport.value = false;
  }
}

async function parseAccountImportFile(file: File) {
  accountImportError.value = "";
  accountImportDrafts.value = [];
  parsingAccountImport.value = true;
  accountImportFileName.value = file.name;
  try {
    const lowerName = file.name.toLowerCase();
    if (lowerName.endsWith(".csv")) {
      accountImportDrafts.value = normalizeAccountImportRows(parseCsvAccountImport(await file.text()));
    } else if (lowerName.endsWith(".xlsx") || lowerName.endsWith(".xls")) {
      const XLSX = await import("xlsx");
      const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
      const firstSheetName = workbook.SheetNames[0];
      if (!firstSheetName) throw new Error("Excel 文件没有工作表");
      const sheet = workbook.Sheets[firstSheetName];
      accountImportDrafts.value = normalizeAccountImportRows(XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" }));
    } else {
      throw new Error("只支持 .xlsx / .xls / .csv 文件");
    }
  } catch (error) {
    accountImportError.value = error instanceof Error ? error.message : "文件解析失败";
  } finally {
    parsingAccountImport.value = false;
  }
}

function parseAccountImportJson(text: string): Array<Record<string, unknown>> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("请粘贴 JSON 数组或包含 connections/accounts 的对象");
  const parsed = JSON.parse(trimmed) as unknown;
  if (Array.isArray(parsed)) return parsed.filter(isRecord);
  if (isRecord(parsed)) {
    const nested = parsed.connections ?? parsed.accounts ?? parsed.items;
    if (Array.isArray(nested)) return nested.filter(isRecord);
  }
  throw new Error("JSON 格式应为数组，或包含 connections / accounts / items 数组");
}

function parseFixedAccountImport(text: string): Array<Record<string, unknown>> {
  return text
    .split(/\r?\n/)
    .map((line, index) => ({ line: line.trim(), rowNo: index + 1 }))
    .filter((item) => item.line && !item.line.startsWith("#"))
    .map((item) => {
      const parts = item.line.split(/\s+/);
      if (parts.length < 4) {
        return { rowNo: item.rowNo, platform: parts[0] ?? "", host: parts[1] ?? "", name: parts[2] ?? "", password: "", error: "固定格式至少需要 4 列" };
      }
      if (parts.length === 4) {
        return { rowNo: item.rowNo, platform: parts[0], host: parts[1], name: parts[2], username: "root", password: parts[3] };
      }
      return { rowNo: item.rowNo, platform: parts[0], host: parts[1], name: parts[2], username: parts[3], password: parts.slice(4).join(" ") };
    });
}

function parseCsvAccountImport(text: string): Array<Record<string, unknown>> {
  const rows = parseDelimitedRows(text);
  if (rows.length < 2) return [];
  const headers = rows[0].map((item) => item.trim());
  return rows.slice(1).map((row, index) => {
    const record: Record<string, unknown> = { rowNo: index + 2 };
    headers.forEach((header, columnIndex) => {
      record[header] = row[columnIndex] ?? "";
    });
    return record;
  });
}

function parseDelimitedRows(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"' && inQuotes && next === '"') {
      cell += '"';
      index++;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if ((char === "," || char === "\t") && !inQuotes) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") index++;
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

function normalizeAccountImportRows(records: Array<Record<string, unknown>>): AccountImportDraft[] {
  if (!records.length) return [];
  return records.map((record, index) => normalizeAccountImportRow(record, index + 1));
}

function normalizeAccountImportRow(record: Record<string, unknown>, fallbackRowNo: number): AccountImportDraft {
  const explicitError = textCell(record.error);
  const providerType = normalizeImportProvider(textCell(readImportCell(record, ["平台", "platform", "provider", "providerType"])));
  const host = textCell(readImportCell(record, ["主机", "Host", "host", "管理地址", "服务器地址", "ip", "IP"]));
  const name = textCell(readImportCell(record, ["服务器名称", "服务器名", "连接名", "name", "serverName"])) || host;
  const username = textCell(readImportCell(record, ["登录账号", "账号", "用户名", "username", "user"])) || "root";
  const password = textCell(readImportCell(record, ["登录密码", "密码", "password"]));
  const portValue = Number(textCell(readImportCell(record, ["端口", "port"])));
  const port = Number.isFinite(portValue) && portValue > 0 ? portValue : providerType ? defaultPortForProvider(providerType) : 0;
  const matched = providerType ? storedConnections.value.find((item) => item.providerType === providerType && item.host === host && item.port === port) : undefined;
  const errors = [
    explicitError,
    providerType ? "" : "平台不支持",
    host ? "" : "主机必填",
    isImportHostValid(host) ? "" : "主机格式错误",
    name ? "" : "服务器名称必填",
    username ? "" : "账号必填",
    password ? "" : "密码必填",
    port > 0 && port <= 65535 ? "" : "端口错误",
  ].filter(Boolean);
  return {
    rowNo: Number(record.rowNo) || fallbackRowNo,
    providerType,
    host,
    port,
    name,
    username,
    password,
    status: errors.length ? "error" : matched ? "update" : "new",
    statusText: errors[0] || (matched ? "相同 IP" : "新增"),
    statusDetail: errors[0] || buildAccountImportStatusDetail({ matched, name, username, port }),
    existingName: matched?.name,
    matchedId: matched?.id,
  };
}

function buildAccountImportStatusDetail(options: { matched: StoredConnectionSummary | undefined; name: string; username: string; port: number }) {
  if (!options.matched) return "将新增保存连接";
  const changes = [
    options.matched.name !== options.name ? `名称：${options.matched.name} -> ${options.name}` : "",
    options.matched.username !== options.username ? `账号：${options.matched.username} -> ${options.username}` : "",
    options.matched.port !== options.port ? `端口：${options.matched.port} -> ${options.port}` : "",
  ].filter(Boolean);
  return changes.length ? `已存在相同 IP/端口，将更新 ${changes.join("，")}，并覆盖密码` : `已存在相同 IP/端口：${options.matched.name}，将覆盖密码`;
}

function readImportCell(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  const normalizedEntries = Object.entries(record).map(([key, value]) => [key.trim().toLowerCase(), value] as const);
  for (const key of keys) {
    const found = normalizedEntries.find(([entryKey]) => entryKey === key.trim().toLowerCase());
    if (found) return found[1];
  }
  return "";
}

function normalizeImportProvider(value: string): ProviderType | "" {
  const normalized = value.trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (["xenserver", "xcpng", "xen"].includes(normalized)) return "xenserver";
  if (["vmware", "vsphere", "esxi"].includes(normalized)) return "vmware";
  if (["proxmox", "proxmoxve", "pve"].includes(normalized)) return "proxmox";
  if (["kvm", "libvirt"].includes(normalized)) return "libvirt";
  return "";
}

function textCell(value: unknown) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isImportHostValid(value: string) {
  return !!value && !/\s/.test(value) && value.length <= 255;
}

async function confirmAccountImport() {
  const rows = accountImportDrafts.value.filter((row) => row.status !== "error");
  if (!rows.length) return;
  const updateRows = rows.filter((row) => row.status === "update");
  const newRows = rows.filter((row) => row.status === "new");
  const updatePreview = updateRows
    .slice(0, 5)
    .map((row) => `${row.existingName || row.name} -> ${row.name} (${row.host}:${row.port})`)
    .join("\n");
  try {
    await confirmVrcAction({
      heading: "导入服务器账号",
      tone: updateRows.length ? "含覆盖更新" : "新增连接",
      summary: `新增 ${newRows.length} 条 / 更新 ${updateRows.length} 条 / 跳过错误 ${accountImportSummary.value.error} 条`,
      detail: updateRows.length
        ? `确认后会先逐条测试连接；全部通过才保存。将按“平台 + 主机 + 端口”覆盖已存在连接的名称、账号和密码。\n${updatePreview}${updateRows.length > 5 ? `\n... 还有 ${updateRows.length - 5} 条更新` : ""}`
        : "确认后会先逐条测试连接；全部通过才保存。不会自动加载资源，也不会修改 XenServer 主机、虚拟机、存储或网络。",
      confirmButtonText: "测试并导入",
      customClass: "account-import-confirm-message-box",
    });
  } catch {
    return;
  }
  importingAccounts.value = true;
  accountImportError.value = "";
  try {
    const failedRows = await testAccountImportRows(rows);
    if (failedRows.length) {
      accountImportError.value = `有 ${failedRows.length} 条连接测试失败，未导入任何账号。请修正密码、账号或地址后重新解析/导入。`;
      setConnectionErrorMessage(accountImportError.value);
      return;
    }
    for (const row of rows) {
      if (!isProviderType(row.providerType)) continue;
      if (persistentConnectionsEnabled.value) {
        await postJson<{ connection: StoredConnectionSummary }>("/api/connections", {
          id: row.matchedId,
          name: row.name,
          providerType: row.providerType,
          host: row.host,
          port: row.port,
          username: row.username,
          password: row.password,
        });
      } else {
        saveBrowserStoredConnection({
          id: row.matchedId,
          name: row.name,
          providerType: row.providerType,
          host: row.host,
          port: row.port,
          username: row.username,
          password: row.password,
        });
      }
    }
    const shouldRefreshSelectedConnection = rows.some((row) => row.matchedId && row.matchedId === selectedConnectionId.value);
    await loadStoredConnections();
    if (shouldRefreshSelectedConnection && selectedConnectionId.value) {
      applyStoredConnection(selectedConnectionId.value);
    }
    accountImportVisible.value = false;
    setConnectionSuccessMessage(
      persistentConnectionsEnabled.value
        ? `连接测试全部通过，已导入 ${rows.length} 个服务器账号，其中 ${rows.filter((row) => row.status === "update").length} 个覆盖更新。`
        : `连接测试全部通过，已导入 ${rows.length} 个账号到当前浏览器，其中 ${rows.filter((row) => row.status === "update").length} 个覆盖更新。`,
    );
    pushActivity("导入服务器账号", {
      target: "连接配置",
      detail: `${rows.length} 条账号配置测试通过并保存`,
      status: "success",
    });
  } catch (error) {
    accountImportError.value = error instanceof Error ? error.message : "导入失败";
    setConnectionErrorMessage(accountImportError.value);
  } finally {
    importingAccounts.value = false;
  }
}

async function testAccountImportRows(rows: AccountImportDraft[]) {
  const failedRows: AccountImportDraft[] = [];
  for (const row of rows) {
    try {
      await postJson<{ hostName?: string }>("/api/connections/test", {
        providerType: row.providerType,
        host: row.host,
        port: row.port,
        username: row.username,
        password: row.password,
      });
    } catch (error) {
      failedRows.push(row);
      markAccountImportRowFailed(row, error instanceof Error ? error.message : "连接测试失败");
    }
  }
  return failedRows;
}

function markAccountImportRowFailed(row: AccountImportDraft, message: string) {
  accountImportDrafts.value = accountImportDrafts.value.map((item) =>
    item === row || (item.rowNo === row.rowNo && item.host === row.host && item.port === row.port)
      ? {
          ...item,
          status: "error",
          statusText: "测试失败",
          statusDetail: message,
        }
      : item,
  );
}

async function loadHostOverview(options: { forceRefresh?: boolean } = {}) {
  if (!options.forceRefresh && workspaceMode.value === "overview" && hostOverviewRows.value.length) {
    resetVmOperationState();
    vmDetailVisible.value = false;
    hostDetailVisible.value = false;
    storageDetailVisible.value = false;
    isoDetailVisible.value = false;
    provisioningVisible.value = false;
    return;
  }
  clearMessages();
  const requestId = ++hostOverviewRequestSeq;
  workspaceMode.value = "overview";
  resetVmOperationState();
  vmSearchCache.value = {};
  vmDetailVisible.value = false;
  hostDetailVisible.value = false;
  storageDetailVisible.value = false;
  isoDetailVisible.value = false;
  provisioningVisible.value = false;

  const connections = storedConnections.value;
  if (!connections.length) {
    hostOverviewRows.value = [];
    showConnectionEditor.value = true;
    setErrorMessage("还没有保存连接。先保存 XenServer / VMware / PVE 连接后才能批量总览。");
    return;
  }

  loadingHostOverview.value = true;
  selectedHostOverviewKey.value = "";
  hostOverviewRows.value = connections.map((item) => createFallbackOverviewRow(item, "loading"));
  pushActivity("读取总览", {
    target: "全部连接",
    detail: `并发读取 ${connections.length} 个连接的物理机基础信息`,
    request: "POST /api/inventory/hosts",
    status: "pending",
  });

  void runLimited(connections, 5, async (item) => {
    if (requestId !== hostOverviewRequestSeq) return;
    try {
      const connectionPayload = buildConnectionPayloadFromSummary(item);
      const hostInventory = await postJson<HostsResponse>("/api/inventory/hosts", {
        ...connectionPayload,
        forceRefresh: options.forceRefresh,
      });
      if (requestId !== hostOverviewRequestSeq) return;
      const rows = hostInventory.hosts.map((host, index) => ({
        key: index === 0 ? item.id : `${item.id}:${host.providerId}`,
        connection: item,
        inventory: hostInventory,
        host,
        summary: null,
        resourceCapacity: null,
        status: "loading" as const,
      }));
      replaceHostOverviewRows(item.id, rows.length ? rows : [createFallbackOverviewRow(item, "error", "未读取到物理机")]);
      scheduleOverviewVmSearchCacheLoad();
      for (const row of rows) {
        void loadHostOverviewSummary(row, requestId, options.forceRefresh);
      }
      if (hostInventory.refreshing) scheduleHostOverviewRevalidation(item, requestId, 1);
    } catch (error) {
      if (requestId !== hostOverviewRequestSeq) return;
      updateHostOverviewRow(item.id, {
        status: "error",
        error: error instanceof Error ? error.message : "连接失败",
      });
    }
  })
    .then(() => {
      if (requestId !== hostOverviewRequestSeq) return;
      pushActivity("总览加载完成", {
        target: "物理机",
        detail: `已读取 ${hostOverviewRows.value.filter(hasOverviewInventory).length} 台`,
        request: "POST /api/inventory/hosts",
        status: "success",
      });
    })
    .catch((error) => {
      if (requestId !== hostOverviewRequestSeq) return;
      setErrorMessage(error instanceof Error ? error.message : "读取物理机总览失败");
    })
    .finally(() => {
      if (requestId === hostOverviewRequestSeq) {
        loadingHostOverview.value = false;
      }
    });
}

function scheduleHostOverviewRevalidation(connectionItem: StoredConnectionSummary, requestId: number, attempt: number) {
  scheduleInventorySnapshotRevalidation(async () => {
    if (requestId !== hostOverviewRequestSeq) return;
    try {
      const result = await postJson<HostsResponse>("/api/inventory/hosts", buildConnectionPayloadFromSummary(connectionItem));
      if (requestId !== hostOverviewRequestSeq) return;
      hostOverviewRows.value = hostOverviewRows.value.map((row) => {
        if (row.connection.id !== connectionItem.id) return row;
        const refreshedHost = result.hosts.find((host) => host.providerId === row.host.providerId || host.id === row.host.id);
        return refreshedHost ? { ...row, host: refreshedHost, inventory: result } : row;
      });
      if (result.refreshing && attempt < INVENTORY_SNAPSHOT_REVALIDATE_MAX_ATTEMPTS) {
        scheduleHostOverviewRevalidation(connectionItem, requestId, attempt + 1);
      }
    } catch {
      // Stale rows remain usable; a manual refresh or later SSE event can retry.
    }
  });
}

async function ensureVmSearchCacheForKeyword(keyword: string, force = false) {
  if (!shouldSearchVmIp(keyword)) return;
  const requestId = ++vmSearchRequestSeq;
  const rowsByConnection = new Map<string, HostOverviewRow[]>();
  for (const row of hostOverviewRows.value.filter(hasOverviewInventory)) {
    const rows = rowsByConnection.get(row.connection.id) ?? [];
    rows.push(row);
    rowsByConnection.set(row.connection.id, rows);
  }
  await runLimited(Array.from(rowsByConnection.values()), 3, async (rows) => {
    if (requestId !== vmSearchRequestSeq) return;
    await loadHostVmSearchCache(rows, force);
  });
}

function scheduleOverviewVmSearchCacheLoad(value = hostOverviewSearch.value) {
  if (vmSearchTimer) clearTimeout(vmSearchTimer);
  const keywords = parseOverviewSearchKeywords(value);
  if (!keywords.some(shouldSearchVmIp)) {
    vmSearchTimer = undefined;
    return;
  }
  vmSearchTimer = setTimeout(() => {
    vmSearchTimer = undefined;
    const latestKeywords = parseOverviewSearchKeywords(hostOverviewSearch.value);
    if (!latestKeywords.some(shouldSearchVmIp)) return;
    void ensureVmSearchCacheForKeyword(latestKeywords.join(" "));
  }, OVERVIEW_VM_SEARCH_DEBOUNCE_MS);
}

async function loadHostVmSearchCache(rows: HostOverviewRow[], force = false, revalidateAttempt = 0) {
  if (!rows.length) return;
  const hasFreshCache = rows.every((row) => {
    const cache = vmSearchCache.value[row.key];
    return !force && cache && Date.now() - cache.updatedAt < VM_SEARCH_CACHE_TTL_MS;
  });
  if (hasFreshCache && revalidateAttempt === 0) return;
  for (const row of rows) {
    const existing = vmSearchCache.value[row.key];
    const showLoading = revalidateAttempt === 0 || force;
    vmSearchCache.value = {
      ...vmSearchCache.value,
      [row.key]: {
        items: existing?.items ?? [],
        updatedAt: existing?.updatedAt ?? 0,
        loading: showLoading,
      },
    };
  }

  try {
    const connectionPayload = buildConnectionPayloadFromSummary(rows[0].connection);
    const result = await postJson<VmSearchIndexResponse>("/api/inventory/vm-search-index", {
      ...connectionPayload,
      forceRefresh: force,
    });
    const cacheUpdatedAt = Date.parse(result.cacheUpdatedAt ?? result.collectedAt);
    const updatedAt = Number.isFinite(cacheUpdatedAt) ? cacheUpdatedAt : Date.now();
    for (const row of rows) {
      const items = result.items.filter((item) => {
        if (item.hostId) return item.hostId === row.host.providerId || item.hostId === row.host.id;
        return rows.length === 1;
      });
      vmSearchCache.value = {
        ...vmSearchCache.value,
        [row.key]: { items, updatedAt, loading: false },
      };
    }
    if (result.refreshing && revalidateAttempt < VM_SEARCH_REVALIDATE_MAX_ATTEMPTS) {
      scheduleVmSearchRevalidation(rows, revalidateAttempt + 1);
    }
  } catch (error) {
    for (const row of rows) {
      const existing = vmSearchCache.value[row.key];
      vmSearchCache.value = {
        ...vmSearchCache.value,
        [row.key]: {
          items: existing?.items ?? [],
          updatedAt: Date.now(),
          loading: false,
          error: error instanceof Error ? error.message : "VM IP 缓存失败",
        },
      };
    }
  }
}

function scheduleVmSearchRevalidation(rows: HostOverviewRow[], attempt: number) {
  const rowKeys = new Set(rows.map((row) => row.key));
  const timer = setTimeout(() => {
    vmSearchRefreshTimers.delete(timer);
    if (!overviewNeedsVmSearch.value) return;
    const currentRows = hostOverviewRows.value.filter((row) => rowKeys.has(row.key));
    if (!currentRows.length) return;
    void loadHostVmSearchCache(currentRows, false, attempt);
  }, VM_SEARCH_REVALIDATE_INTERVAL_MS);
  vmSearchRefreshTimers.add(timer);
}

function scheduleInventorySnapshotRevalidation(callback: () => void | Promise<void>) {
  const timer = setTimeout(() => {
    inventorySnapshotRefreshTimers.delete(timer);
    void callback();
  }, INVENTORY_SNAPSHOT_REVALIDATE_INTERVAL_MS);
  inventorySnapshotRefreshTimers.add(timer);
}

async function loadHostOverviewSummary(row: HostOverviewRow, requestId = hostOverviewRequestSeq, forceRefresh = false, revalidateAttempt = 0) {
  if (!hasOverviewInventory(row)) return;
  try {
    const connectionPayload = buildConnectionPayloadFromSummary(row.connection);
    const result = await postJson<VmSummaryResponse>("/api/inventory/vm-summary", {
      ...connectionPayload,
      hostId: row.host.providerId,
      page: 1,
      pageSize: 500,
      forceRefresh,
    });
    if (requestId !== hostOverviewRequestSeq) return;
    const summary = normalizeVmSummary(result.summary);
    updateHostOverviewRow(row.key, {
      summary,
      resourceCapacity: result.resourceCapacity ?? null,
      status: "ready",
    });
    if (result.refreshing && revalidateAttempt < INVENTORY_SNAPSHOT_REVALIDATE_MAX_ATTEMPTS) {
      scheduleInventorySnapshotRevalidation(() => {
        const currentRow = hostOverviewRows.value.find((item) => item.key === row.key);
        if (currentRow) void loadHostOverviewSummary(currentRow, requestId, false, revalidateAttempt + 1);
      });
    }
  } catch (error) {
    if (requestId !== hostOverviewRequestSeq) return;
    updateHostOverviewRow(row.key, {
      status: "error",
      error: error instanceof Error ? error.message : "VM 汇总失败",
    });
  }
}

async function testConnection() {
  clearConnectionFeedback();
  const payload = buildConnectionPayload();
  if (!payload) {
    setConnectionFeedback("error", errorMessage.value || "连接信息不完整");
    return;
  }
  testing.value = true;
  clearMessages();

  try {
    const result = await postJson<{ hostName?: string }>("/api/connections/test", payload);
    setConnectionSuccessMessage(`测试连接成功：${result.hostName || connection.host}`);
    pushActivity("连接测试成功", {
      target: result.hostName || connection.host,
      detail: `${providerLabel(connection.providerType)} · ${connection.host}:${connection.port}`,
      request: "POST /api/connections/test",
      status: "success",
    });
  } catch (error) {
    setConnectionErrorMessage(error instanceof Error ? error.message : "测试连接失败");
    pushActivity("连接测试失败", {
      target: connection.host,
      detail: errorMessage.value,
      request: "POST /api/connections/test",
      status: "error",
    });
  } finally {
    testing.value = false;
  }
}

async function openHostOverview(row: HostOverviewRow) {
  if (!hasOverviewInventory(row)) return;
  resetVmOperationState();
  resetVmRowReconciliationState();
  search.value = overviewVmSearchMatchedKeywords(row).join(" ");
  vmDetailVisible.value = true;
  selectedHostOverviewKey.value = row.key;
  selectedConnectionId.value = row.connection.id;
  connection.providerType = row.connection.providerType;
  connection.host = row.connection.host;
  connection.port = row.connection.port;
  connection.username = row.connection.username;
  connection.password = "";
  connectionName.value = row.connection.name;
  showConnectionEditor.value = false;
  void saveConnectionPreferences(buildConnectionPreferencesFromState());

  inventory.value = row.inventory;
  selectedHostId.value = row.host.providerId;
  resetIsoImages();
  vmSummary.value = row.summary ? normalizeVmSummary(row.summary) : null;
  selectedResourceCapacity.value = row.resourceCapacity;
  vms.value = null;
  loadingVms.value = true;
  pushActivity("打开物理机", {
    target: row.host.name,
    detail: `${providerLabel(row.connection.providerType)} · ${row.host.address}`,
    status: "info",
  });
  void loadVmSummary({ silent: true });
  void loadVms({ silent: true });
}

async function loadHostInventory(options: { forceRefresh?: boolean } = {}) {
  const payload = buildConnectionPayload();
  if (!payload) return;
  workspaceMode.value = "connection";
  loadingHosts.value = true;
  clearMessages();
  persistConnection(payload);

  try {
    inventory.value = await postJson<HostsResponse>("/api/inventory/hosts", {
      ...payload,
      forceRefresh: options.forceRefresh,
    });
    selectedHostId.value = inventory.value.hosts[0]?.providerId ?? "";
    resetIsoImages();
    prepareVmPanelForHostLoad(!!selectedHostId.value);
    pushActivity("加载物理机", {
      target: selectedStoredConnection.value?.name || connection.host,
      detail: `${inventory.value.hosts.length} 台物理机`,
      request: "POST /api/inventory/hosts",
      status: "success",
    });
    if (selectedHostId.value) {
      void loadVmSummary({ silent: true, forceRefresh: options.forceRefresh });
      void loadVms({ silent: true, forceRefresh: options.forceRefresh });
    }
  } catch (error) {
    loadingVms.value = false;
    loadingVmSummary.value = false;
    setErrorMessage(error instanceof Error ? error.message : "读取物理机失败");
    pushActivity("读取物理机失败", {
      target: selectedStoredConnection.value?.name || connection.host,
      detail: errorMessage.value,
      request: "POST /api/inventory/hosts",
      status: "error",
    });
  } finally {
    loadingHosts.value = false;
  }
}

async function selectHost(hostId: string) {
  selectedHostId.value = hostId;
  resetIsoImages();
  prepareVmPanelForHostLoad(true);
  void loadVmSummary({ silent: true });
  void loadVms({ silent: true });
}

function prepareVmPanelForHostLoad(hasHost: boolean) {
  vmSummaryRequestSeq += 1;
  vmListRequestSeq += 1;
  vms.value = null;
  vmSummary.value = null;
  selectedResourceCapacity.value = null;
  resetVmOperationState();
  resetVmRowReconciliationState();
  loadingVms.value = hasHost;
  if (!hasHost) loadingVmSummary.value = false;
}

function resetVmOperationState(options: { preserveFilters?: boolean } = {}) {
  selectedVmIds.value = [];
  if (!options.preserveFilters) {
    search.value = "";
    vmPowerFilter.value = "all";
  }
  vmActionStates.value = {};
}

function resetVmSelectionState() {
  selectedVmIds.value = [];
}

function vmMatchesPowerFilter(vm: VmNode, filter: VmPowerFilter) {
  if (filter === "running") return vm.powerState === "running";
  if (filter === "stopped") return vm.powerState === "halted" || vm.powerState === "stopped";
  return true;
}

function resetIsoImages() {
  isoImages.value = [];
  isoSearch.value = "";
  loadingIsoImages.value = false;
}

async function loadVmSummary(options: { silent?: boolean; forceRefresh?: boolean; revalidateAttempt?: number } = {}) {
  const payload = buildConnectionPayload();
  if (!payload || !selectedHost.value) return;
  const hostId = selectedHost.value.providerId;
  const requestId = ++vmSummaryRequestSeq;
  loadingVmSummary.value = true;
  if (!options.silent) clearMessages();

  try {
    const result = await postJson<VmSummaryResponse>("/api/inventory/vm-summary", {
      ...payload,
      hostId,
      page: 1,
      pageSize: 500,
      forceRefresh: options.forceRefresh,
    });
    if (requestId !== vmSummaryRequestSeq || selectedHost.value?.providerId !== hostId) return;
    const summary = normalizeVmSummary(result.summary);
    vmSummary.value = summary;
    selectedResourceCapacity.value = result.resourceCapacity ?? null;
    if (selectedHostOverviewKey.value) {
      updateHostOverviewRow(selectedHostOverviewKey.value, {
        summary,
        resourceCapacity: result.resourceCapacity ?? null,
        status: "ready",
      });
    }
    pushActivity("加载 VM 汇总", {
      target: selectedHost.value.name,
      detail: `运行 ${summary.running} / 共 ${summary.total} 台`,
      request: "POST /api/inventory/vm-summary",
      status: "success",
    });
    const revalidateAttempt = options.revalidateAttempt ?? 0;
    if (result.refreshing && revalidateAttempt < INVENTORY_SNAPSHOT_REVALIDATE_MAX_ATTEMPTS) {
      scheduleInventorySnapshotRevalidation(() => {
        if (requestId !== vmSummaryRequestSeq || selectedHost.value?.providerId !== hostId) return;
        void loadVmSummary({ silent: true, revalidateAttempt: revalidateAttempt + 1 });
      });
    }
  } catch (error) {
    if (requestId !== vmSummaryRequestSeq || selectedHost.value?.providerId !== hostId) return;
    setErrorMessage(error instanceof Error ? error.message : "读取 VM 汇总失败");
    pushActivity("读取 VM 汇总失败", {
      target: selectedHost.value.name,
      detail: errorMessage.value,
      request: "POST /api/inventory/vm-summary",
      status: "error",
    });
  } finally {
    if (requestId === vmSummaryRequestSeq) loadingVmSummary.value = false;
  }
}

async function loadVms(
  options: { silent?: boolean; background?: boolean; forceRefresh?: boolean; revalidateAttempt?: number } = {},
) {
  const payload = buildConnectionPayload();
  if (!payload || !selectedHost.value) return;
  const hostId = selectedHost.value.providerId;
  const requestId = ++vmListRequestSeq;
  const requestRowRevision = vmListReconciler.currentRevision();
  const showLoading = !options.background || !vms.value?.items.length;
  if (showLoading) loadingVms.value = true;
  if (!options.silent) clearMessages();
  const keywords = parseSearchKeywords(search.value);
  const serverKeyword = keywords.length === 1 && !shouldSearchVmIp(keywords[0]) ? keywords[0] : undefined;

  try {
    const result = await postJson<VmsResponse>("/api/inventory/vms", {
      ...payload,
      hostId,
      page: 1,
      pageSize: serverKeyword ? 200 : 500,
      keyword: serverKeyword,
      forceRefresh: options.forceRefresh,
    });
    if (requestId !== vmListRequestSeq || selectedHost.value?.providerId !== hostId) return;
    vms.value = vmListReconciler.reconcile(
      result,
      vms.value?.items ?? [],
      vmActionStates.value,
      requestRowRevision,
      options.background === true,
    );
    if (!serverKeyword) {
      vmSummary.value = summarizeVms(vms.value.items, vms.value.total);
    }
    if (!options.silent) {
      successMessage.value = `VM 清单已加载：${vms.value.items.length} / ${vms.value.total} 台。`;
    }
    if (!options.background) {
      pushActivity("加载 VM 清单", {
        target: selectedHost.value.name,
        detail: `${vms.value.items.length} / ${vms.value.total} 台`,
        request: "POST /api/inventory/vms",
        status: "success",
      });
    }
    syncSelectedVmSearchCacheFromCurrentList();
    const revalidateAttempt = options.revalidateAttempt ?? 0;
    if (result.refreshing && revalidateAttempt < INVENTORY_SNAPSHOT_REVALIDATE_MAX_ATTEMPTS) {
      scheduleInventorySnapshotRevalidation(() => {
        if (requestId !== vmListRequestSeq || selectedHost.value?.providerId !== hostId) return;
        void loadVms({ silent: true, background: true, revalidateAttempt: revalidateAttempt + 1 });
      });
    }
  } catch (error) {
    if (requestId !== vmListRequestSeq || selectedHost.value?.providerId !== hostId) return;
    setErrorMessage(error instanceof Error ? error.message : "读取 VM 失败");
    pushActivity("读取 VM 失败", {
      target: selectedHost.value.name,
      detail: errorMessage.value,
      request: "POST /api/inventory/vms",
      status: "error",
    });
  } finally {
    if (showLoading && requestId === vmListRequestSeq) loadingVms.value = false;
  }
}

async function refreshVmPanelResources() {
  await Promise.all([
    loadVmSummary({ silent: true, forceRefresh: true }),
    loadVms({ forceRefresh: true }),
  ]);
}

function syncSelectedVmSearchCacheFromCurrentList() {
  if (!selectedHostOverviewKey.value || !vms.value) return;
  const existing = vmSearchCache.value[selectedHostOverviewKey.value];
  vmSearchCache.value = {
    ...vmSearchCache.value,
    [selectedHostOverviewKey.value]: {
      loading: false,
      items: vms.value.items,
      updatedAt: Date.now(),
      error: existing?.error,
    },
  };
}

async function openIsoDetail() {
  isoDetailVisible.value = true;
  isoSearch.value = "";
  await loadIsoImages();
}

async function loadIsoImages(force = false) {
  const payload = buildConnectionPayload();
  if (!payload || !selectedHost.value) return;
  if (loadingIsoImages.value) return;
  if (!force && isoImages.value.length) return;

  loadingIsoImages.value = true;
  pushActivity("读取系统镜像", {
    target: selectedHost.value.name,
    detail: `${providerLabel(connection.providerType)} · ISO 清单`,
    request: "POST /api/inventory/iso-images",
    status: "pending",
  });
  try {
    const result = await postJson<IsoImagesResponse>("/api/inventory/iso-images", {
      ...payload,
      hostId: selectedHost.value.providerId,
      forceRefresh: force,
    });
    isoImages.value = result.images;
    isoImagesEmptyState.value = result.emptyState;
    pushActivity(result.source === "cache" ? "系统镜像缓存已加载" : "系统镜像读取完成", {
      target: selectedHost.value.name,
      detail: result.refreshing ? `${result.images.length} 个 ISO · 后台刷新中` : `${result.images.length} 个 ISO`,
      request: "POST /api/inventory/iso-images",
      status: "success",
    });
  } catch (error) {
    setErrorMessage(error instanceof Error ? error.message : "读取系统镜像失败");
    pushActivity("读取系统镜像失败", {
      target: selectedHost.value.name,
      detail: errorMessage.value,
      request: "POST /api/inventory/iso-images",
      status: "error",
    });
  } finally {
    loadingIsoImages.value = false;
  }
}

function isoLibraryDescription(image: IsoImage) {
  const description = typeof image.metadata?.srDescription === "string" ? image.metadata.srDescription.trim() : "";
  return description && description !== image.storageRepository ? description : "";
}

function isoLocationText(image: IsoImage) {
  return image.path || image.providerId;
}

function isoEmptyText() {
  if (isoSearch.value.trim()) return `没有命中：${isoSearch.value.trim()}`;
  const emptyState = isoImagesEmptyState.value;
  if (!emptyState) return "当前平台没有返回 ISO 清单，或账号没有存储内容读取权限。";
  return [emptyState.message, emptyState.actionHint].filter(Boolean).join("。") + "。";
}

async function openProvisioningDialog() {
  const capability = selectedProviderDescriptor.value?.capabilities.vmCreate;
  if (!capability?.supported) {
    showToast("warning", capability?.message || "当前平台暂不支持创建虚拟机");
    return;
  }
  resetProvisioningDialogView(false);
  provisioningDialogSession.value += 1;
  provisioningVisible.value = true;
}

function resetProvisioningDialogView(markDismissed: boolean) {
  const taskId = activeProvisionTask.value?.id || consoleProvisionTaskId.value;
  if (markDismissed && taskId) dismissedProvisionTaskIds.add(taskId);
  if (taskId && consoleProvisionTaskId.value === taskId) {
    consoleProvisionTaskId.value = "";
    consoleTarget.value = null;
    consoleDialogVisible.value = false;
  }
  activeProvisionTask.value = null;
  provisioningProgress.value = null;
  provisioningSubmitting.value = false;
  provisionInlineConsoleTarget.value = null;
}

async function handleProvisioningSubmit(payload: VmCreateRequest) {
  const target = selectedHost.value?.name || payload.hostId || connection.host;
  const detail = `${providerLabel(payload.providerType)} · ${payload.sourceType === "iso" ? "ISO" : "克隆源"} · ${payload.count} 台`;
  let keepSubmittingForTask = false;
  clearMessages();
  activeProvisionTask.value = null;
  provisioningProgress.value = {
    title: "创建预检",
    message: "正在检查宿主机资源、镜像、存储和 IP 占用",
    status: "running",
  };
  provisioningSubmitting.value = true;
  let preflight: ProvisionPreflightResponse;
  try {
    preflight = await postJson<ProvisionPreflightResponse>("/api/provisioning/preflight", payload);
    const blockingIssues = preflight.issues.filter((issue) => issue.severity === "blocking");
    if (blockingIssues.length) {
      const detailText = blockingIssues.map((issue) => `${issue.label}：${issue.message}`).join("；");
      setErrorMessage(detailText);
      pushActivity("创建预检未通过", {
        target,
        detail: detailText,
        request: "POST /api/provisioning/preflight",
        status: "error",
      });
      provisioningProgress.value = {
        title: "创建预检未通过",
        message: detailText,
        status: "error",
      };
      provisioningSubmitting.value = false;
      return;
    }
  } catch (error) {
    setErrorMessage(error instanceof Error ? error.message : "创建预检失败");
    provisioningProgress.value = {
      title: "创建预检失败",
      message: errorMessage.value,
      status: "error",
    };
    pushActivity("创建预检失败", {
      target,
      detail: errorMessage.value,
      request: "POST /api/provisioning/preflight",
      status: "error",
    });
    provisioningSubmitting.value = false;
    return;
  }

  provisioningSubmitting.value = false;
  provisioningProgress.value = {
    title: "创建预检通过",
    message: preflight.operationSummary,
    status: "success",
  };
  provisioningProgress.value = {
    title: "提交创建任务",
    message: "正在向虚拟化平台提交创建请求",
    status: "running",
  };
  provisioningSubmitting.value = true;
  try {
    const response = await postJson<VmProvisionResponse>("/api/provisioning/vms", {
      ...payload,
      confirmToken: "CONFIRMED",
    });
    successMessage.value = response.result.message;
    if (response.result.taskId || response.task?.id) {
      const taskId = response.result.taskId || response.task?.id || "";
      if (taskId) provisioningTaskPayloads.set(taskId, payload);
      if (taskId) dismissedProvisionTaskIds.delete(taskId);
      activeProvisionTask.value = response.task ?? null;
      provisioningProgress.value = {
        title: "创建任务执行中",
        message: response.task?.message || response.result.message,
        status: "running",
      };
      keepSubmittingForTask = true;
      listenProvisioningTask(taskId);
    } else {
      showToast("success", response.result.message);
      await reserveProvisioningIpsAfterCreate(payload);
      resetVmSelectionState();
      await Promise.all([loadVmSummary({ silent: true, forceRefresh: true }), loadVms({ silent: true, forceRefresh: true })]);
      syncSelectedOverviewRowAfterVmChange();
    }
    if (!keepSubmittingForTask) {
      provisioningVisible.value = false;
      provisioningProgress.value = null;
    }
    if (payload.autoStart && !activeProvisionTask.value && response.result.created[0]) {
      openCreatedVmConsole(response.result.created[0]);
    }
  } catch (error) {
    setErrorMessage(error instanceof Error ? error.message : "创建虚拟机失败");
    provisioningProgress.value = {
      title: "创建虚拟机失败",
      message: errorMessage.value,
      status: "error",
    };
    pushActivity("创建虚拟机失败", {
      target,
      detail: errorMessage.value,
      request: "POST /api/provisioning/vms",
      status: "error",
    });
  } finally {
    if (!keepSubmittingForTask) {
      provisioningSubmitting.value = false;
    }
  }
}

function connectInventoryEvents() {
  if (typeof EventSource === "undefined" || inventoryEventSource) return;
  const source = new EventSource("/api/inventory/events");
  inventoryEventSource = source;
  source.addEventListener("inventory", (message) => {
    try {
      const parsed = JSON.parse((message as MessageEvent).data) as { event?: InventoryEvent };
      if (!parsed.event || parsed.event.eventSeq <= lastInventoryEventSeq) return;
      lastInventoryEventSeq = parsed.event.eventSeq;
      applyInventoryEvent(parsed.event);
    } catch {
      // SSE 事件解析失败时忽略本条，下一条事件或手动刷新会重新校正状态。
    }
  });
  source.onerror = () => {
    source.close();
    if (inventoryEventSource === source) inventoryEventSource = null;
    window.setTimeout(connectInventoryEvents, 5000);
  };
}

function applyInventoryEvent(event: InventoryEvent) {
  if (event.type === "host.patch") {
    patchHostFromInventoryEvent(event);
    return;
  }
  if (event.type === "summary.patch") {
    patchSummaryFromInventoryEvent(event);
    return;
  }
  patchVmSearchCacheFromInventoryEvent(event);
  if (!inventoryEventMatchesSelectedHost(event)) return;
  if (event.type === "vm.patch") {
    patchVmRowById(event.vmId, event.patch);
  } else if (event.type === "vm.upsert") {
    upsertVmRow(event.vm);
  } else if (event.type === "vm.delete") {
    removeVmRowById(event.vmId);
  }
  scheduleInventoryEventResourceRefresh();
}

function scheduleInventoryEventResourceRefresh() {
  const refreshSeq = ++inventoryEventResourceRefreshSeq;
  if (inventoryEventResourceRefreshTimer) clearTimeout(inventoryEventResourceRefreshTimer);
  inventoryEventResourceRefreshTimer = setTimeout(() => {
    inventoryEventResourceRefreshTimer = undefined;
    if (refreshSeq !== inventoryEventResourceRefreshSeq || !selectedHost.value) return;
    // VM 删除/创建后的物理内存回收可能晚于 VM 行事件，延迟一次汇总读取以校正容量卡片。
    void loadVmSummary({ silent: true, forceRefresh: true });
  }, 1_800);
}

function inventoryEventMatchesSelectedHost(event: InventoryEvent) {
  if (event.connectionId && event.connectionId !== selectedConnectionId.value) return false;
  if (event.providerType !== connection.providerType) return false;
  const currentHostId = selectedHost.value?.providerId || selectedHost.value?.id;
  if (event.hostId && currentHostId && event.hostId !== currentHostId) return false;
  return true;
}

function patchHostFromInventoryEvent(event: Extract<InventoryEvent, { type: "host.patch" }>) {
  if (inventory.value) {
    inventory.value = {
      ...inventory.value,
      hosts: inventory.value.hosts.map((host) => (hostMatchesEvent(host, event) ? { ...host, ...event.patch } : host)),
    };
  }
  hostOverviewRows.value = hostOverviewRows.value.map((row) => {
    if (!overviewRowMatchesEvent(row, event)) return row;
    const patchedHost = { ...row.host, ...event.patch };
    return {
      ...row,
      host: patchedHost,
      inventory: {
        ...row.inventory,
        hosts: row.inventory.hosts.map((host) => (hostMatchesEvent(host, event) ? { ...host, ...event.patch } : host)),
      },
    };
  });
}

function patchSummaryFromInventoryEvent(event: Extract<InventoryEvent, { type: "summary.patch" }>) {
  const summary = normalizeVmSummary(event.summary);
  if (inventoryEventMatchesSelectedHost(event)) {
    vmSummary.value = summary;
    if (event.resourceCapacity) selectedResourceCapacity.value = event.resourceCapacity;
  }
  hostOverviewRows.value = hostOverviewRows.value.map((row) =>
    overviewRowMatchesEvent(row, event)
      ? {
          ...row,
          summary,
          resourceCapacity: event.resourceCapacity ?? row.resourceCapacity,
          status: "ready",
        }
      : row,
  );
}

function patchVmSearchCacheFromInventoryEvent(
  event: Extract<InventoryEvent, { type: "vm.patch" | "vm.upsert" | "vm.delete" }>,
) {
  const nextCache = { ...vmSearchCache.value };
  let changed = false;
  for (const row of hostOverviewRows.value) {
    if (!overviewConnectionMatchesEvent(row, event)) continue;
    const cache = nextCache[row.key];
    if (!cache) continue;
    const vmId = event.type === "vm.upsert" ? event.vm.providerId || event.vm.id : event.vmId;
    let items = cache.items.filter((item) => item.providerId !== vmId);
    if (event.type === "vm.upsert" && overviewRowMatchesEvent(row, event)) {
      items = [
        ...items,
        {
          providerId: event.vm.providerId,
          hostId: event.vm.hostId ?? event.hostId,
          name: event.vm.name,
          ipAddresses: event.vm.ipAddresses,
        },
      ];
    } else if (event.type === "vm.patch") {
      const existing = cache.items.find((item) => item.providerId === vmId);
      if (existing) {
        const patched = {
          ...existing,
          hostId: event.patch.hostId ?? existing.hostId,
          name: event.patch.name ?? existing.name,
          ipAddresses: event.patch.ipAddresses ?? existing.ipAddresses,
        };
        if (!patched.hostId || patched.hostId === row.host.providerId || patched.hostId === row.host.id) items = [...items, patched];
      }
    }
    nextCache[row.key] = { ...cache, items, updatedAt: Date.now(), loading: false };
    changed = true;
  }
  if (changed) vmSearchCache.value = nextCache;
}

function hostMatchesEvent(host: HostNodeItem, event: Pick<InventoryEvent, "hostId">) {
  return !!event.hostId && (host.providerId === event.hostId || host.id === event.hostId);
}

function overviewRowMatchesEvent(row: HostOverviewRow, event: Pick<InventoryEvent, "connectionId" | "providerType" | "hostId">) {
  if (!overviewConnectionMatchesEvent(row, event)) return false;
  return !event.hostId || row.host.providerId === event.hostId || row.host.id === event.hostId;
}

function overviewConnectionMatchesEvent(row: HostOverviewRow, event: Pick<InventoryEvent, "connectionId" | "providerType">) {
  if (event.connectionId && row.connection.id !== event.connectionId) return false;
  return row.connection.providerType === event.providerType;
}

async function pollProvisioningTask(taskId: string) {
  if (!taskId) return;
  if (provisioningPollTimers.has(taskId)) return;
  const poll = async () => {
    try {
      const response = await postJson<ProvisionTaskResponse>(`/api/provisioning/tasks/${encodeURIComponent(taskId)}`, undefined, "GET");
      const task = response.task;
      await applyProvisioningTaskUpdate(task);
      if (task.status === "running" || task.status === "pending") {
        provisioningPollTimers.set(taskId, setTimeout(poll, 5000));
      } else {
        provisioningPollTimers.delete(taskId);
      }
    } catch (error) {
      provisioningPollTimers.delete(taskId);
      provisioningSubmitting.value = false;
      provisioningProgress.value = {
        title: "读取创建任务失败",
        message: error instanceof Error ? error.message : "任务状态读取失败",
        status: "error",
      };
      pushActivity("读取创建任务失败", {
        target: taskId,
        detail: error instanceof Error ? error.message : "任务状态读取失败",
        status: "warning",
      });
    }
  };
  provisioningPollTimers.set(taskId, setTimeout(poll, 800));
}

function listenProvisioningTask(taskId: string) {
  if (!taskId) return;
  if (typeof EventSource === "undefined") {
    pollProvisioningTask(taskId);
    return;
  }
  if (provisioningEventSources.has(taskId) || provisioningPollTimers.has(taskId)) return;
  const source = new EventSource(`/api/provisioning/tasks/${encodeURIComponent(taskId)}/events`);
  provisioningEventSources.set(taskId, source);
  // SSE can miss the terminal event when the API process restarts during a long install.
  // Keep a lightweight poller as the source of truth for terminal state reconciliation.
  pollProvisioningTask(taskId);
  const closeSource = () => {
    source.close();
    provisioningEventSources.delete(taskId);
  };
  source.addEventListener("task", (event) => {
    try {
      const parsed = JSON.parse((event as MessageEvent).data) as ProvisionTaskResponse;
      void applyProvisioningTaskUpdate(parsed.task).then(() => {
        if (parsed.task.status !== "running" && parsed.task.status !== "pending") closeSource();
      });
    } catch (error) {
      closeSource();
      pollProvisioningTask(taskId);
    }
  });
  source.onerror = () => {
    closeSource();
    pollProvisioningTask(taskId);
  };
}

async function applyProvisioningTaskUpdate(task: ProvisionTask) {
  const mark = `${task.status}:${task.currentStep}:${task.updatedAt}:${task.eventSeq}`;
  if (provisioningTaskMarks.get(task.id) === mark) return;
  provisioningTaskMarks.set(task.id, mark);
  const taskDismissedFromDialog = dismissedProvisionTaskIds.has(task.id) && !provisioningVisible.value;
  if (task.status === "success" || task.status === "warning" || task.status === "failed") {
    pushActivity(provisionTaskActivityTitle(task.status), {
      target: task.title,
      detail: task.message,
      status: provisionTaskActivityStatus(task.status),
    });
  }
  if (!taskDismissedFromDialog) {
    activeProvisionTask.value = task;
  }
  if (!taskDismissedFromDialog && consoleProvisionTaskId.value === task.id && !consoleTarget.value) {
    openProvisionTaskConsole(task, false);
  }
  if (!taskDismissedFromDialog) {
    provisioningProgress.value = {
      title: provisionTaskActivityTitle(task.status),
      message: task.message,
      status: task.status === "success" ? "success" : task.status === "warning" ? "warning" : task.status === "failed" ? "error" : "running",
    };
  }
  if (task.status === "success" || task.status === "warning") {
    if (task.status === "success") {
      successMessage.value = task.message;
      showToast("success", task.message);
    } else {
      showToast("warning", task.message);
    }
    provisioningSubmitting.value = false;
    const payload = provisioningTaskPayloads.get(task.id);
    if (payload) {
      await reserveProvisioningIpsAfterCreate(payload);
      provisioningTaskPayloads.delete(task.id);
    }
    resetVmSelectionState();
    await Promise.all([loadVmSummary({ silent: true, forceRefresh: true }), loadVms({ silent: true, forceRefresh: true })]);
    syncSelectedOverviewRowAfterVmChange();
  }
  if (task.status === "failed") {
    if (provisionTasksStoppedByVmDelete.delete(task.id)) {
      provisioningSubmitting.value = false;
      provisioningTaskPayloads.delete(task.id);
      return;
    }
    setErrorMessage(task.message);
    provisioningSubmitting.value = false;
    provisioningTaskPayloads.delete(task.id);
  }
}

function rememberProvisionTasksStoppedByVmDelete(response: Pick<VmActionResponse, "stoppedProvisionTaskIds">) {
  for (const taskId of response.stoppedProvisionTaskIds ?? []) {
    provisionTasksStoppedByVmDelete.add(taskId);
  }
}

async function reserveProvisioningIpsAfterCreate(payload: VmCreateRequest) {
  if (!payload.planItems?.length) return;
  try {
    await postJson<IpLeaseReservationResponse>("/api/provisioning/ip-leases", {
      leases: payload.planItems.map((item) => ({
        ip: item.ip,
        poolId: payload.ipPool.id,
        poolName: payload.ipPool.name,
        scopeKey: payload.scopeKey || payload.hostId || payload.connectionId,
        vmName: item.name,
        loginUsername: item.loginUsername,
        rootPassword: item.rootPassword,
      })),
    });
    pushActivity("预留 IP", {
      target: payload.ipPool.name,
      detail: payload.planItems.map((item) => item.ip).join(", "),
      status: "success",
    });
  } catch (error) {
    pushActivity("预留 IP 失败", {
      target: payload.ipPool.name,
      detail: error instanceof Error ? error.message : "本地 IP 池写入失败",
      status: "warning",
    });
  }
}

function openCreatedVmConsole(created: VmProvisionCreatedVm) {
  if (!persistentConnectionsEnabled.value) {
    showToast("warning", "虚拟机已创建；共享 Web 模式不使用服务器保存连接，控制台入口已关闭。");
    return;
  }
  consoleProvisionTaskId.value = "";
  const refreshedVm = vms.value?.items.find((item) => item.providerId === created.providerId || item.id === created.id);
  const consoleVm: VmNode =
    refreshedVm ?? {
      id: created.id,
      connectionId: selectedConnectionId.value,
      hostId: selectedHost.value?.providerId,
      providerId: created.providerId,
      consoleRef: created.providerId,
      name: created.name,
      powerState: created.powerState,
      cpuCount: 0,
      memoryBytes: 0,
      ipAddresses: created.ip ? [created.ip] : [],
      toolsStatus: "unknown",
      reclaimLevel: "KEEP",
      reclaimReason: "新建虚拟机",
    };
  const context = {
    connection: {
      id: selectedConnectionId.value,
      providerType: connection.providerType,
      host: connection.host,
      port: connection.port,
      username: connection.username,
      password: persistentConnectionsEnabled.value ? undefined : connection.password,
    },
    vm: { ...consoleVm, powerState: "running" as const },
    hostName: selectedHost.value?.name,
    hostAddress: selectedHost.value?.address,
  };
  // 创建完成后的首个控制台用于确认启动与安装画面，优先保留平台 VNC 通道。
  const target = resolveVmGraphConsoleTarget(context) ?? resolveVmConsoleTarget(context);
  if (!target) {
    showToast("warning", "虚拟机已创建，但当前平台还没有可用控制台入口。");
    return;
  }
  consoleTarget.value = target;
  consoleDialogVisible.value = true;
  pushActivity(`打开控制台：${created.name}`);
}

function resolveProvisionTaskVmConsoleTarget(taskVm: ProvisionTask["vms"][number]): VmConsoleTarget | null {
  if (!persistentConnectionsEnabled.value) return null;
  const providerId = taskVm.providerId || taskVm.id;
  if (!providerId) return null;
  const refreshedVm = vms.value?.items.find((item) => item.providerId === providerId || item.id === providerId || item.name === taskVm.name);
  const inferredPowerState = taskVm.powerState || (taskVm.status === "running" ? "running" : "halted");
  const consoleVm: VmNode =
    refreshedVm ?? {
      id: taskVm.id || providerId,
      connectionId: selectedConnectionId.value,
      hostId: selectedHost.value?.providerId,
      providerId,
      consoleRef: providerId,
      name: taskVm.name,
      powerState: inferredPowerState,
      cpuCount: 0,
      memoryBytes: 0,
      ipAddresses: taskVm.ip ? [taskVm.ip] : [],
      toolsStatus: "unknown",
      reclaimLevel: "KEEP",
      reclaimReason: "新建虚拟机",
    };
  const context = {
    connection: {
      id: selectedConnectionId.value,
      providerType: connection.providerType,
      host: connection.host,
      port: connection.port,
      username: connection.username,
      password: persistentConnectionsEnabled.value ? undefined : connection.password,
    },
    vm: consoleVm,
    hostName: selectedHost.value?.name,
    hostAddress: selectedHost.value?.address,
  };
  // 创建窗口必须保持平台图形控制台，安装程序、重启画面和异常现场均依赖 VNC；
  // 关闭创建窗口后，普通 VM 列表才按来宾系统策略选择 xterm 或 noVNC。
  return resolveVmGraphConsoleTarget(context) ?? resolveVmConsoleTarget(context);
}

function openProvisionTaskConsole(task: ProvisionTask, notifyIfUnavailable = true) {
  consoleProvisionTaskId.value = task.id;
  const firstTarget = buildProvisionConsoleTargets(task).map((item) => item.target).find(Boolean) ?? null;
  if (!firstTarget) {
    if (notifyIfUnavailable) showToast("warning", "创建任务已提交，但 VM 控制台入口还未就绪。");
    return false;
  }
  consoleTarget.value = firstTarget;
  consoleDialogVisible.value = true;
  return true;
}

function handleSelectProvisionConsoleTarget(item: ProvisionConsoleTargetItem) {
  if (!item.target) return;
  consoleTarget.value = item.target;
}

function handleSelectProvisionInlineConsoleTarget(item: ProvisionConsoleTargetItem) {
  if (!item.target) return;
  provisionInlineConsoleTarget.value = item.target;
}

function exportCsv(orderedVms: VmNode[] = filteredVms.value) {
  const rows = orderedVms.map((vm) => [
    selectedHost.value?.name ?? "",
    vm.name,
    vm.powerState,
    displayGuestOs(vm),
    vm.cpuCount,
    formatBytes(vm.memoryBytes),
    formatBytes(vm.diskVirtualBytes ?? 0),
    formatVmDiskSummary(vm),
    displayVmIp(vm),
  ]);
  const header = ["物理机", "名称", "状态", "系统", "vCPU", "内存", "磁盘总量", "磁盘明细", "IP"];
  const csv = [header, ...rows].map((row) => row.map((cell) => `"${String(cell).replaceAll("\"", "\"\"")}"`).join(",")).join("\n");
  const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  const hostName = sanitizeFilename(selectedHost.value?.name || "host");
  link.download = `vrc-vms-${hostName}-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

async function exportHostOverviewWorkbook() {
  const overviewRows = sortedHostOverviewRows.value;
  if (!overviewRows.length) return;

  const hostRows = overviewRows.map((row) => {
    const recommendation = hostRecommendation(row);
    return {
      平台: providerLabel(row.connection.providerType),
      连接: row.connection.name,
      物理机: row.host.name,
      "管理 IP": row.host.address,
      状态: overviewStatusLabel(row),
      CPU: overviewCpuMain(row),
      "CPU 运行情况": overviewCpuSubline(row),
      内存: overviewMemoryMain(row),
      "内存余量": overviewMemorySubline(row),
      存储: overviewStorageMain(row),
      "存储余量": overviewStorageSubline(row),
      "运行 VM / 总 VM": row.summary ? `${row.summary.running} / ${row.summary.total}` : "-",
      创建评估: recommendation.label,
      评估原因: recommendation.reason,
      错误: row.error ?? "",
    };
  });

  const vmRows: Array<Record<string, string>> = [];
  let vmItemCount = 0;
  const rowsByConnection = new Map<string, HostOverviewRow[]>();
  for (const row of overviewRows) {
    const rows = rowsByConnection.get(row.connection.id) ?? [];
    rows.push(row);
    rowsByConnection.set(row.connection.id, rows);
  }

  // The search-index endpoint is backed by VRC's persisted VM cache, so export does not
  // require opening each physical host or issuing a state-changing XenServer request.
  const indexesByConnection = new Map<string, VmSearchIndexItem[]>();
  const indexErrors = new Map<string, string>();
  await runLimited(Array.from(rowsByConnection.values()), 3, async (rows) => {
    const connection = rows[0]?.connection;
    if (!connection) return;
    try {
      const result = await postJson<VmSearchIndexResponse>("/api/inventory/vm-search-index", {
        ...buildConnectionPayloadFromSummary(connection),
      });
      indexesByConnection.set(connection.id, result.items);
    } catch (error) {
      indexErrors.set(connection.id, error instanceof Error ? error.message : "VM 缓存读取失败");
    }
  });

  for (const [connectionId, rows] of rowsByConnection) {
    const connection = rows[0]?.connection;
    if (!connection) continue;
    const items = indexesByConnection.get(connectionId) ?? [];
    for (const item of items) {
      vmItemCount += 1;
      const matchingRows = rows.filter((row) => item.hostId && (item.hostId === row.host.providerId || item.hostId === row.host.id));
      const hostRow = matchingRows.length === 1 ? matchingRows[0] : rows.length === 1 && !item.hostId ? rows[0] : undefined;
      vmRows.push({
        平台: providerLabel(connection.providerType),
        连接: connection.name,
        物理机名称: hostRow?.host.name ?? "",
        "物理机 IP": hostRow?.host.address ?? "",
        虚拟机名称: item.name,
        "虚拟机 IP": item.ipAddresses.join(" / ") || "-",
        "VM ID": item.providerId,
        匹配状态: hostRow ? "已匹配" : "未匹配物理机",
      });
    }
    const error = indexErrors.get(connectionId);
    if (error) {
      vmRows.push({
        平台: providerLabel(connection.providerType),
        连接: connection.name,
        物理机名称: "",
        "物理机 IP": "",
        虚拟机名称: "",
        "虚拟机 IP": "",
        "VM ID": "",
        匹配状态: `VM 缓存读取失败：${error}`,
      });
    }
  }

  const XLSX = await import("xlsx");
  const workbook = XLSX.utils.book_new();
  const hostSheet = XLSX.utils.json_to_sheet(hostRows);
  const vmSheet = XLSX.utils.json_to_sheet(vmRows, {
    header: ["平台", "连接", "物理机名称", "物理机 IP", "虚拟机名称", "虚拟机 IP", "VM ID", "匹配状态"],
  });
  hostSheet["!cols"] = [
    { wch: 12 }, { wch: 22 }, { wch: 24 }, { wch: 18 }, { wch: 12 },
    { wch: 18 }, { wch: 22 }, { wch: 18 }, { wch: 22 }, { wch: 18 },
    { wch: 22 }, { wch: 18 }, { wch: 14 }, { wch: 36 }, { wch: 36 },
  ];
  vmSheet["!cols"] = [
    { wch: 12 }, { wch: 22 }, { wch: 24 }, { wch: 18 },
    { wch: 30 }, { wch: 30 }, { wch: 38 }, { wch: 24 },
  ];
  XLSX.utils.book_append_sheet(workbook, hostSheet, "物理机总览");
  XLSX.utils.book_append_sheet(workbook, vmSheet, "虚拟机信息");
  XLSX.writeFile(workbook, `vrc-host-overview-${new Date().toISOString().slice(0, 10)}.xlsx`);
  if (indexErrors.size) {
    showToast("warning", `Excel 已导出，但 ${indexErrors.size} 个连接的 VM 缓存读取失败，请查看“虚拟机信息”Sheet。`);
  } else {
    showToast("success", `Excel 已导出：物理机 ${overviewRows.length} 台，虚拟机 ${vmItemCount} 条。`);
  }
}

function handleVmSelectionChange(rows: VmNode[]) {
  selectedVmIds.value = rows.map((row) => row.providerId);
}

function openVmScheduleCreate(rows: VmNode[]) {
  if (!selectedConnectionId.value) {
    showToast("warning", "定时任务需要使用已保存连接，请先保存当前连接");
    return;
  }
  if (!rows.length) {
    showToast("warning", "请先选择目标虚拟机");
    return;
  }
  vmScheduleSelectedVms.value = [...rows];
  vmScheduleInitialView.value = "create";
  vmScheduleVisible.value = true;
}

function openVmRename(vm: VmNode) {
  const capability = selectedProviderDescriptor.value?.capabilities.vmRename;
  if (!capability?.supported) {
    showToast("warning", capability?.message || "当前平台暂不支持虚拟机改名");
    return;
  }
  vmRenameTarget.value = vm;
  vmRenameVisible.value = true;
}

async function handleVmRename(payload: { vm: VmNode; newName: string }) {
  const connectionPayload = buildConnectionPayload();
  if (!connectionPayload) return;
  const previousName = payload.vm.name;
  const hostName = selectedHost.value?.name || connection.host;
  const target = `${hostName} / ${previousName}`;
  vmRenameSaving.value = true;
  clearMessages();
  pushActivity("提交虚拟机改名", {
    target,
    detail: `${providerLabel(connection.providerType)} · ${previousName} → ${payload.newName}`,
    request: "POST /api/vms/rename",
    status: "pending",
  });
  try {
    const response = await postJson<VmRenameResponse>("/api/vms/rename", {
      ...connectionPayload,
      vmId: payload.vm.providerId,
      hostId: selectedHost.value?.providerId,
      currentName: previousName,
      newName: payload.newName,
      confirmToken: "CONFIRMED",
    });
    if (!response.result.accepted) {
      throw new Error(response.result.message || "虚拟机改名请求未被平台接受");
    }
    patchVmRow(payload.vm, { name: response.result.newName });
    vmRenameVisible.value = false;
    showToast("success", response.result.message);
    pushActivity("虚拟机改名完成", {
      target: `${hostName} / ${response.result.newName}`,
      detail: `${response.result.previousName} → ${response.result.newName}`,
      request: "POST /api/vms/rename",
      status: "success",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "虚拟机改名失败";
    setErrorMessage(message);
    showToast("error", message);
    pushActivity("虚拟机改名失败", {
      target,
      detail: message,
      request: "POST /api/vms/rename",
      status: "error",
    });
  } finally {
    vmRenameSaving.value = false;
  }
}

function openVmResize(vm: VmNode) {
  const capability = selectedProviderDescriptor.value?.capabilities.vmResize;
  if (!capability?.supported) {
    showToast("warning", capability?.message || "当前平台暂不支持虚拟机扩容");
    return;
  }
  if (vm.powerState !== "running") {
    showToast("warning", "虚拟机已关机，请先开机后再扩容");
    return;
  }
  vmResizeTarget.value = vm;
  vmResizeDisks.value = [];
  vmResizeGuestStorage.value = null;
  vmResizeGuestStorageError.value = "";
  vmResizeVisible.value = true;
}

function openHostDiagnostics(vm: VmNode) {
  const connectionPayload = buildConnectionPayload();
  if (!connectionPayload) {
    return;
  }
  hostDiagnosticsTarget.value = vm;
  hostDiagnosticsHost.value = selectedHost.value;
  hostDiagnosticsProviderDescriptor.value = selectedProviderDescriptor.value;
  hostDiagnosticsConnectionPayload.value = connectionPayload;
  hostDiagnosticsVisible.value = true;
}

function openHostOverviewDiagnosticsToolbar() {
  const selected = overviewSelectedRows.value;
  if (!selected.length) {
    showToast("warning", "请先在列表勾选要诊断的物理机");
    return;
  }
  if (selected.length > 1) {
    showToast("warning", "一次只支持诊断一台物理机，请仅勾选一台");
    return;
  }
  const target = selected[0];
  if (!hasOverviewInventory(target)) {
    showToast("warning", "该物理机尚未完成总览加载，请刷新后再诊断");
    return;
  }
  openHostOverviewDiagnostics(target);
}

function overviewRowSelectable(row: HostOverviewRow) {
  return hasOverviewInventory(row);
}

function handleOverviewSelectionChange(rows: HostOverviewRow[]) {
  // 总览数据刷新时会重建行对象（map/spread），这里统一按 key 映射到最新行引用，
  // 避免诊断时误用已失效的旧行对象。
  const byKey = new Map(hostOverviewRows.value.map((row) => [row.key, row]));
  overviewSelectedRows.value = rows.map((row) => byKey.get(row.key) ?? row);
}

function handleOverviewRowClick(row: HostOverviewRow, _column: unknown, event: MouseEvent) {
  const target = event.target as HTMLElement | null;
  if (target?.closest(".el-checkbox") || target?.closest("td.el-table-column--selection")) return;
  void openHostOverview(row);
}

watch(hostOverviewRows, (rows) => {
  // 数据刷新后，把勾选状态同步到最新行对象；行已不存在则自动丢弃勾选。
  const byKey = new Map(rows.map((row) => [row.key, row]));
  overviewSelectedRows.value = overviewSelectedRows.value
    .map((row) => byKey.get(row.key))
    .filter((row): row is HostOverviewRow => Boolean(row));
});

function openHostOverviewDiagnostics(row: HostOverviewRow) {
  let connectionPayload: Record<string, unknown>;
  try {
    connectionPayload = buildConnectionPayloadFromSummary(row.connection);
  } catch (error) {
    const message = error instanceof Error ? error.message : "读取该连接的本地密码失败";
    setErrorMessage(message);
    showToast("error", message);
    return;
  }
  hostDiagnosticsTarget.value = null;
  hostDiagnosticsHost.value = row.host;
  hostDiagnosticsProviderDescriptor.value = providerDescriptorFor(row.connection.providerType) ?? undefined;
  hostDiagnosticsConnectionPayload.value = connectionPayload;
  hostDiagnosticsVisible.value = true;
}

function handleHostDiagnosticsConfirm(payload: { host: HostNode; vm: VmNode | null; action: HostDiagnosticRepairAction }) {
  const target = payload.vm ? `${payload.host.name} / ${payload.vm.name}` : payload.host.name;
  showToast("warning", "修复动作已记录，请在宿主机上手动确认执行建议命令。");
  pushActivity("诊断修复待确认", {
    target,
    detail: `建议动作：${payload.action.label}；命令需在宿主机二次确认后手动执行`,
    status: "warning",
  });
}

async function loadVmResizeDisks(vm: VmNode) {
  const connectionPayload = buildConnectionPayload();
  if (!connectionPayload) return;
  vmResizeLoadingDisks.value = true;
  try {
    const response = await postJson<VmDisksResponse>("/api/inventory/vm-disks", {
      ...connectionPayload,
      vmId: vm.providerId,
    });
    if (vmResizeTarget.value?.providerId === vm.providerId) {
      vmResizeDisks.value = response.disks;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "读取虚拟机磁盘失败";
    setErrorMessage(message);
    showToast("error", message);
  } finally {
    vmResizeLoadingDisks.value = false;
  }
}

function openHostOverviewSnapshotsToolbar() {
  const selected = overviewSelectedRows.value;
  if (!selected.length) {
    showToast("warning", "请先在列表勾选要查看快照的物理机");
    return;
  }
  if (selected.length > 1) {
    showToast("warning", "一次只支持查看一台物理机的快照，请仅勾选一台");
    return;
  }
  const target = selected[0];
  if (!hasOverviewInventory(target)) {
    showToast("warning", "该物理机尚未完成总览加载，请刷新后再查看快照");
    return;
  }
  void openHostOverviewSnapshots(target);
}

async function openHostOverviewSnapshots(row: HostOverviewRow) {
  let connectionPayload: Record<string, unknown>;
  try {
    connectionPayload = buildConnectionPayloadFromSummary(row.connection);
  } catch (error) {
    const message = error instanceof Error ? error.message : "读取该连接的本地密码失败";
    setErrorMessage(message);
    showToast("error", message);
    return;
  }
  vmSnapshotHost.value = row.host;
  vmSnapshotProviderLabel.value = providerLabel(row.connection.providerType);
  vmSnapshotGroups.value = [];
  vmSnapshotVisible.value = true;
  vmSnapshotLoading.value = true;
  try {
    const response = await postJson<HostVmSnapshotsResponse>("/api/hosts/vm-snapshots", {
      ...connectionPayload,
      hostId: row.host.providerId,
    });
    vmSnapshotGroups.value = response.items;
  } catch (error) {
    const message = error instanceof Error ? error.message : "读取物理机快照失败";
    setErrorMessage(message);
    showToast("error", message);
  } finally {
    vmSnapshotLoading.value = false;
  }
}

function formatSnapshotTime(value?: string) {
  return value ? formatMaintenanceIsoDate(value) : "-";
}

async function loadVmResizeGuestStorage(vm: VmNode, systemCredentials?: VmSystemCredentials, rememberSystemCredentials = false) {
  const connectionPayload = buildConnectionPayload();
  if (!connectionPayload) return;
  vmResizeGuestStorage.value = null;
  vmResizeGuestStorageError.value = "";
  vmResizeLoadingGuestStorage.value = true;
  try {
    const response = await postJson<GuestStorageResponse>("/api/inventory/vm-guest-storage", {
      ...connectionPayload,
      vmId: vm.providerId,
      systemCredentials,
      rememberSystemCredentials,
    });
    if (vmResizeTarget.value?.providerId === vm.providerId) {
      vmResizeGuestStorage.value = response.inventory;
      vmResizeGuestStorageError.value = response.inventory.supported ? "" : response.inventory.message;
    }
  } catch (error) {
    if (vmResizeTarget.value?.providerId === vm.providerId) {
      vmResizeGuestStorageError.value = error instanceof Error ? error.message : "读取虚拟机系统磁盘与目录失败";
    }
  } finally {
    vmResizeLoadingGuestStorage.value = false;
  }
}

async function handleVmResize(request: VmResizeRequest) {
  const vm = vmResizeTarget.value;
  const connectionPayload = buildConnectionPayload();
  if (!vm || !connectionPayload) return;
  const hostName = selectedHost.value?.name || connection.host;
  const target = `${hostName} / ${vm.name}`;
  const changes = describeVmResizeChanges(vm, request);
  try {
    await confirmVrcAction({
      heading: "确认扩容",
      tone: "资源变更",
      summary: target,
      detail: [
        ...changes,
        "后端将按平台能力选择在线执行，或正常关机后修改并自动恢复运行。",
        request.storageTarget ? `系统内容量生效目录：${request.storageTarget.mountPath}` : "本次不包含操作系统文件系统调整。",
        "扩容只允许增加，磁盘与文件系统扩展后不能通过 VRC 缩小。",
      ].join("\n"),
      confirmButtonText: "确认扩容",
      customClass: "vm-resize-confirm",
    });
  } catch (error) {
    if (error !== "cancel" && error !== "close") {
      showToast("error", error instanceof Error ? error.message : "扩容确认失败");
    }
    return;
  }

  vmResizeSaving.value = true;
  clearMessages();
  pushActivity("提交虚拟机扩容", {
    target,
    detail: changes.join("；"),
    request: "POST /api/vms/resize",
    status: "pending",
  });
  try {
    const response = await postJson<VmResizeResponse>("/api/vms/resize", {
      ...connectionPayload,
      vmId: vm.providerId,
      hostId: selectedHost.value?.providerId,
      ...request,
      confirmToken: "CONFIRMED",
    });
    if (!response.result.accepted) throw new Error(response.result.message || "虚拟机扩容请求未被平台接受");
    const diskVirtualBytes = response.result.disks.reduce((sum, disk) => sum + Math.max(disk.virtualSizeBytes, 0), 0);
    const updatedVm = patchVmRow(vm, {
      cpuCount: response.result.cpuCount,
      memoryBytes: response.result.memoryBytes,
      diskVirtualBytes,
      diskCount: response.result.disks.length,
      diskSizeSummary: response.result.disks.map((disk) => formatBytes(disk.virtualSizeBytes)).join(" + "),
      powerState: response.result.restarted ? "running" : vm.powerState,
    });
    vmResizeDisks.value = response.result.disks;
    const storageFailed = response.result.storage?.status === "failed";
    showToast(storageFailed ? "warning" : "success", response.result.message);
    void refreshVmRowQuietly(updatedVm, { attempts: 2, intervalMs: 800 });
    pushActivity(storageFailed ? "虚拟硬件已扩容，系统内容量生效失败" : "虚拟机扩容完成", {
      target,
      detail: `${changes.join("；")}；${response.result.storage?.message || (response.result.restarted ? "已自动开机" : "在线完成")}`,
      request: "POST /api/vms/resize",
      status: storageFailed ? "error" : "success",
    });
    if (storageFailed) {
      await Promise.all([loadVmResizeDisks(vm), loadVmResizeGuestStorage(vm)]);
      return;
    }
    vmResizeVisible.value = false;
    if (response.result.restarted) openConsoleAfterStart(updatedVm);
  } catch (error) {
    const message = error instanceof Error ? error.message : "虚拟机扩容失败";
    setErrorMessage(message);
    showToast("error", message);
    pushActivity("虚拟机扩容失败", { target, detail: message, request: "POST /api/vms/resize", status: "error" });
  } finally {
    vmResizeSaving.value = false;
  }
}

function describeVmResizeChanges(vm: VmNode, request: VmResizeRequest) {
  const changes: string[] = [];
  if (request.cpuCount && request.cpuCount !== vm.cpuCount) changes.push(`CPU：${vm.cpuCount} → ${request.cpuCount} vCPU`);
  if (request.memoryBytes && request.memoryBytes !== vm.memoryBytes) changes.push(`内存：${formatBytes(vm.memoryBytes)} → ${formatBytes(request.memoryBytes)}`);
  if (request.disk) {
    if (request.disk.mode === "extend") {
      const disk = vmResizeDisks.value.find((item) => item.id === request.disk?.diskId);
      if (disk && request.disk.sizeBytes <= disk.virtualSizeBytes) {
        changes.push(`磁盘：完成 ${disk.device || disk.name} 的未分配容量`);
      } else {
        changes.push(`磁盘：扩展 ${disk?.device || disk?.name || request.disk.diskId} 至 ${formatBytes(request.disk.sizeBytes)}`);
      }
    } else {
      changes.push(`磁盘：新增 ${formatBytes(request.disk.sizeBytes)}`);
    }
  }
  if (request.storageTarget) changes.push(`操作系统：自动生效至 ${request.storageTarget.mountPath}`);
  return changes;
}

function openGlobalVmSchedule() {
  if (!storedConnections.value.length) {
    showToast("warning", "请先保存至少一个平台连接");
    return;
  }
  vmScheduleSelectedVms.value = [];
  vmScheduleInitialView.value = "create";
  vmScheduleVisible.value = true;
}

function handleVmScheduleChanged() {
  pushActivity("定时任务已更新", {
    target: selectedHost.value?.name || connection.host,
    detail: "任务由 VRC API 后台调度执行",
    status: "success",
  });
}

function handleOpenVmConsole(target: VmConsoleTarget) {
  consoleProvisionTaskId.value = "";
  consoleTarget.value = target;
  consoleDialogVisible.value = true;
}

async function handleVmAction(action: VmPowerAction, vm: VmNode) {
  const payload = buildConnectionPayload();
  if (!payload) return;
  const meta = vmActionMeta(action);
  const hostName = selectedHost.value?.name || connection.host;
  const vmTarget = `${hostName} / ${vm.name}`;
  const vmActionDetail = `${providerLabel(connection.providerType)} · ${displayVmIp(vm)} · ${displayGuestOs(vm)}`;

  // 仅重启前让用户选择下次启动内核（机器运行中，可真实设置一次性启动项）；
  // 关机不再选择内核：内核选择只对“下次启动”有意义，开机时再提醒。
  if (action === "forceReboot") {
    bootEntryDialogVm.value = vm;
    bootEntryDialogAction.value = action;
    bootEntryList.value = null;
    bootEntryError.value = "";
    bootEntryAuthRequired.value = false;
    // 先不弹窗：静默读取内核列表后，按数量决定是否弹选择框（多内核才弹）。
    bootEntryVisible.value = false;
    pushActivity(`请求${meta.label}`, {
      target: vmTarget,
      detail: "等待读取启动内核",
      status: "pending",
    });
    void loadVmBootEntries(vm);
    return;
  }

  // 开机确认时，若近期读取过该虚拟机内核列表且多于 1 个，附上“按默认内核启动”的提醒。
  const detail = action === "start" ? buildStartActionDetail(vm, connection.providerType) : undefined;
  await handleVmActionPlain(action, vm, detail);
}

/**
 * 普通二次确认 + 提交 VM 电源操作（关机 / 开机 / 删除；重启选内核走独立流程）。
 *
 * @param action 电源操作类型
 * @param vm 目标虚拟机
 * @param detailOverride 可选的确认文案覆盖（如开机时附加内核提醒），缺省用 vmActionDescription
 */
async function handleVmActionPlain(action: VmPowerAction, vm: VmNode, detailOverride?: string) {
  const payload = buildConnectionPayload();
  if (!payload) return;
  const meta = vmActionMeta(action);
  const hostName = selectedHost.value?.name || connection.host;
  const vmTarget = `${hostName} / ${vm.name}`;
  const vmActionDetail = `${providerLabel(connection.providerType)} · ${displayVmIp(vm)} · ${displayGuestOs(vm)}`;

  try {
    pushActivity(`请求${meta.label}`, {
      target: vmTarget,
      detail: "等待二次确认",
      status: "pending",
    });
    await confirmVrcAction({
      heading: meta.confirmHeading,
      tone: meta.confirmTone,
      summary: `${hostName} / ${vm.name}`,
      detail: detailOverride ?? vmActionDescription(action, connection.providerType),
      confirmButtonText: meta.confirmButtonText,
      customClass: meta.customClass,
    });
  } catch (error) {
    if (error !== "cancel" && error !== "close") {
      setErrorMessage(error instanceof Error ? error.message : "操作确认失败");
      pushActivity(`${meta.label}确认失败`, {
        target: vmTarget,
        detail: errorMessage.value,
        status: "error",
      });
    } else {
      pushActivity(`取消${meta.label}`, {
        target: vmTarget,
        detail: vmActionDetail,
        status: "warning",
      });
    }
    return;
  }

  await executeVmAction(action, vm);
}

/**
 * 组装开机确认文案：近期缓存到该虚拟机有多个启动内核时，附加“按默认内核启动”提醒。
 *
 * @param vm 目标虚拟机
 * @param providerType 平台类型
 * @returns 确认弹窗详情文案
 */
function buildStartActionDetail(vm: VmNode, providerType: ProviderType) {
  const base = vmActionDescription("start", providerType);
  const count = cachedBootEntryKernelCount(vm.providerId)?.count ?? null;
  return buildStartKernelReminder(base, count);
}

async function handleBootEntryConfirm(
  selection: GuestBootEntrySelection | null,
  systemCredentials?: VmSystemCredentials,
  rememberSystemCredentials = false,
) {
  const action = bootEntryDialogAction.value;
  const vm = bootEntryDialogVm.value;
  bootEntryVisible.value = false;
  if (!action || !vm) return;
  const payload = buildConnectionPayload();
  if (!payload) return;
  const meta = vmActionMeta(action);
  const hostName = selectedHost.value?.name || connection.host;
  const vmTarget = `${hostName} / ${vm.name}`;
  const vmActionDetail = `${providerLabel(connection.providerType)} · ${displayVmIp(vm)} · ${displayGuestOs(vm)}`;
  const bootEntryBody: Record<string, unknown> = {};
  if (selection) {
    bootEntryBody.bootEntry = selection;
    if (systemCredentials) {
      bootEntryBody.systemCredentials = systemCredentials;
      bootEntryBody.rememberSystemCredentials = rememberSystemCredentials;
    }
  }

  try {
    pushActivity(`请求${meta.label}`, {
      target: vmTarget,
      detail: "等待二次确认",
      status: "pending",
    });
    await confirmVrcAction({
      heading: meta.confirmHeading,
      tone: meta.confirmTone,
      summary: `${hostName} / ${vm.name}`,
      detail: [
        vmActionDescription(action, connection.providerType),
        selection ? `本次${meta.label}后进入所选内核：${selection.title}` : "本次不指定内核，按系统默认启动项启动",
      ].join("\n"),
      confirmButtonText: meta.confirmButtonText,
      customClass: meta.customClass,
    });
  } catch (error) {
    if (error !== "cancel" && error !== "close") {
      setErrorMessage(error instanceof Error ? error.message : "操作确认失败");
      pushActivity(`${meta.label}确认失败`, {
        target: vmTarget,
        detail: errorMessage.value,
        status: "error",
      });
    } else {
      pushActivity(`取消${meta.label}`, {
        target: vmTarget,
        detail: vmActionDetail,
        status: "warning",
      });
    }
    return;
  }

  await executeVmAction(action, vm, bootEntryBody);
}

async function loadVmBootEntries(vm: VmNode, systemCredentials?: VmSystemCredentials, rememberSystemCredentials = false) {
  const connectionPayload = buildConnectionPayload();
  if (!connectionPayload) return;
  if (bootEntryDialogVm.value?.providerId !== vm.providerId) return;
  bootEntryList.value = null;
  bootEntryError.value = "";
  bootEntryAuthRequired.value = false;
  bootEntryLoading.value = true;
  try {
    const response = await postJson<GuestBootEntryList & { collectedAt: string }>("/api/vms/boot-entries", {
      ...connectionPayload,
      vmId: vm.providerId,
      systemCredentials,
      rememberSystemCredentials,
    });
    if (bootEntryDialogVm.value?.providerId !== vm.providerId) return;
    bootEntryList.value = response;
    bootEntryError.value = "";
    bootEntryAuthRequired.value = false;
    rememberBootEntryKernelCount(vm.providerId, response.entries.length);
    // 内核列表已拿到：多于 1 个才弹选择框；单内核 / 无可选内核直接按普通重启确认，
    // 全程不弹启动项对话框，避免“一闪而过”。
    if (response.entries.length > 1) {
      bootEntryVisible.value = true;
    } else {
      bootEntryVisible.value = false;
      void handleVmActionPlain(bootEntryDialogAction.value ?? "forceReboot", vm);
    }
  } catch (error) {
    if (bootEntryDialogVm.value?.providerId !== vm.providerId) return;
    const bootEntryFailure =
      error instanceof SecureRequestError && error.code === "SYSTEM_AUTHENTICATION_REQUIRED"
        ? "需要虚拟机系统账号"
        : error instanceof Error
          ? error.message
          : "读取虚拟机启动项失败";
    // 读取启动内核失败不应阻断重启：降级为按系统默认内核重启，并给出明确提示，
    // 避免“点重启无反应”。成功读取到多个内核时仍会弹选择框。
    bootEntryVisible.value = false;
    showToast("warning", `未读取到启动内核（${bootEntryFailure}），将按系统默认内核重启`);
    void handleVmActionPlain(bootEntryDialogAction.value ?? "forceReboot", vm);
  } finally {
    if (bootEntryDialogVm.value?.providerId === vm.providerId) {
      bootEntryLoading.value = false;
    }
  }
}

function handleBootEntryDialogClose(value: boolean) {
  if (!value && bootEntryVisible.value) {
    const action = bootEntryDialogAction.value;
    const vm = bootEntryDialogVm.value;
    if (action && vm) {
      const meta = vmActionMeta(action);
      const hostName = selectedHost.value?.name || connection.host;
      pushActivity(`取消${meta.label}`, {
        target: `${hostName} / ${vm.name}`,
        detail: "未选择启动内核",
        status: "warning",
      });
    }
  }
  bootEntryVisible.value = value;
}

async function executeVmAction(action: VmPowerAction, vm: VmNode, extraBody: Record<string, unknown> = {}) {
  const payload = buildConnectionPayload();
  if (!payload) return;
  const meta = vmActionMeta(action);
  const hostName = selectedHost.value?.name || connection.host;
  const vmTarget = `${hostName} / ${vm.name}`;
  const vmActionDetail = `${providerLabel(connection.providerType)} · ${displayVmIp(vm)} · ${displayGuestOs(vm)}`;

  clearMessages();
  const resourceBaseline = captureSelectedHostResourceFingerprint();
  setVmActionState(vm, {
    action,
    status: "running",
    message: `${meta.label}中`,
  });
  pushActivity(`提交${meta.label}`, {
    target: vmTarget,
    detail: vmActionDetail,
    request: "POST /api/vms/action",
    status: "pending",
  });
  try {
    let changedVm: VmNode | null = null;
    const response = await postJson<VmActionResponse>("/api/vms/action", {
      ...payload,
      vmId: vm.providerId,
      hostId: selectedHost.value?.providerId,
      action,
      confirmToken: "CONFIRMED",
      ...extraBody,
    });
    if (!response.result.accepted) {
      throw new Error(response.result.message || `VM ${meta.label}请求未被平台接受`);
    }
    if (action === "delete") {
      rememberProvisionTasksStoppedByVmDelete(response);
    }
    if (action === "start") {
      const runningVm = patchVmRow(vm, vmPowerActionRowPatch(action, response.operatedAt));
      changedVm = runningVm;
      setVmActionState(runningVm, { action, status: "success", message: "已开机" });
      openConsoleAfterStart(runningVm);
    } else if (action === "forceReboot") {
      const runningVm = patchVmRow(vm, vmPowerActionRowPatch(action, response.operatedAt));
      changedVm = runningVm;
      setVmActionState(runningVm, { action, status: "success", message: "已重启" });
      openConsoleAfterForceReboot(runningVm);
    } else if (action === "shutdown") {
      const haltedVm = patchVmRow(vm, vmPowerActionRowPatch(action, response.operatedAt));
      changedVm = haltedVm;
      setVmActionState(haltedVm, { action, status: "success", message: "已关机" });
    } else {
      successMessage.value = response.result.message;
      showToast("success", response.result.message);
      removeVmRow(vm);
    }
    await refreshSelectedHostResources(action, resourceBaseline);
    resetVmSelectionState();
    if (changedVm) {
      void refreshVmRowQuietly(changedVm, { expectedPowerState: expectedPowerStateForAction(action), attempts: 3, intervalMs: 800 });
    }
    pushActivity(`${meta.label}完成`, {
      target: vmTarget,
      detail: vmActionCompleteMessage(action),
      request: "POST /api/vms/action",
      command: response.result.command,
      status: "success",
    });
    if (action !== "delete") {
      scheduleClearVmActionState(vm, 1800);
    }
  } catch (error) {
    setErrorMessage(error instanceof Error ? error.message : `VM ${meta.label}失败`);
    setVmActionState(vm, { action, status: "error", message: `${meta.label}失败` });
    scheduleClearVmActionState(vm, 3600);
    pushActivity(`${meta.label}失败`, {
      target: vmTarget,
      detail: errorMessage.value,
      request: "POST /api/vms/action",
      status: "error",
    });
  }
}

async function handleBatchVmAction(action: VmPowerAction, rows: VmNode[]) {
  const payload = buildConnectionPayload();
  if (!payload) return;
  const meta = vmActionMeta(action);
  const hostName = selectedHost.value?.name || connection.host;
  const selectedRows = rows.length ? rows : selectedVmRows.value;
  const actionableRows = selectedRows.filter((vm) => canRunVmAction(action, vm));
  if (!actionableRows.length) {
    showToast("warning", `所选 VM 中没有可${meta.label}的对象`);
    return;
  }

  const skippedCount = Math.max(selectedRows.length - actionableRows.length, 0);
  const batchVmNames = actionableRows
    .slice(0, 8)
    .map((vm) => `- ${vm.name}`)
    .join("\n");
  const detailLines = [
    skippedCount ? `跳过：${skippedCount} 台状态不满足条件` : "",
    vmActionDescription(action, connection.providerType),
    action === "start" ? "说明：批量开机不会自动打开多个控制台，可在完成后点击 VM 名称查看。" : "",
    action === "forceReboot"
      ? "说明：批量重启不指定下次启动内核，按系统默认启动项启动；如需选择内核请单台操作。"
      : "",
    batchVmNames,
    actionableRows.length > 8 ? `... 还有 ${actionableRows.length - 8} 台` : "",
  ].filter(Boolean);

  try {
    pushActivity(`请求批量${meta.label}`, {
      target: hostName,
      detail: `${actionableRows.length} 台 VM 等待二次确认`,
      status: "pending",
    });
    await confirmVrcAction({
      heading: `批量${meta.label}`,
      tone: "批量变更",
      summary: `${hostName} / ${actionableRows.length} 台 VM`,
      detail: detailLines.join("\n"),
      confirmButtonText: `确认${meta.label}`,
      customClass: meta.customClass,
    });
  } catch (error) {
    if (error !== "cancel" && error !== "close") {
      setErrorMessage(error instanceof Error ? error.message : "批量操作确认失败");
      pushActivity(`批量${meta.label}确认失败`, {
        target: hostName,
        detail: errorMessage.value,
        status: "error",
      });
    } else {
      pushActivity(`取消批量${meta.label}`, {
        target: hostName,
        detail: `${actionableRows.length} 台 VM`,
        status: "warning",
      });
    }
    return;
  }

  clearMessages();
  const resourceBaseline = captureSelectedHostResourceFingerprint();
  for (const vm of actionableRows) {
    setVmActionState(vm, {
      action,
      status: "pending",
      message: `等待${meta.label}`,
    });
  }
  pushActivity(`提交批量${meta.label}`, {
    target: hostName,
    detail: `${actionableRows.length} 台 VM`,
    request: "POST /api/vms/action",
    status: "pending",
  });

  const failed: string[] = [];
  const changedVms: VmNode[] = [];
  let successCount = 0;
  for (const vm of actionableRows) {
    try {
      setVmActionState(vm, {
        action,
        status: "running",
        message: `${meta.label}中`,
      });
      const response = await postJson<VmActionResponse>("/api/vms/action", {
        ...payload,
        vmId: vm.providerId,
        hostId: selectedHost.value?.providerId,
        action,
        confirmToken: "CONFIRMED",
      });
      if (!response.result.accepted) {
        throw new Error(response.result.message || `VM ${meta.label}请求未被平台接受`);
      }
      if (action === "delete") {
        rememberProvisionTasksStoppedByVmDelete(response);
      }
      if (action === "start") {
        const runningVm = patchVmRow(vm, vmPowerActionRowPatch(action, response.operatedAt));
        changedVms.push(runningVm);
        setVmActionState(runningVm, { action, status: "success", message: "已开机" });
      } else if (action === "forceReboot") {
        const runningVm = patchVmRow(vm, vmPowerActionRowPatch(action, response.operatedAt));
        changedVms.push(runningVm);
        setVmActionState(runningVm, { action, status: "success", message: "已重启" });
      } else if (action === "shutdown") {
        const haltedVm = patchVmRow(vm, vmPowerActionRowPatch(action, response.operatedAt));
        changedVms.push(haltedVm);
        setVmActionState(haltedVm, { action, status: "success", message: "已关机" });
      } else {
        removeVmRow(vm);
      }
      successCount += 1;
      if (action !== "delete") {
        scheduleClearVmActionState(vm, 1800);
      }
      pushActivity(`${vm.name} ${meta.label}成功`, {
        target: hostName,
        detail: vmActionCompleteMessage(action),
        request: "POST /api/vms/action",
        command: response.result.command,
        status: "success",
      });
    } catch (error) {
      setVmActionState(vm, { action, status: "error", message: `${meta.label}失败` });
      scheduleClearVmActionState(vm, 3600);
      failed.push(`${vm.name}：${error instanceof Error ? error.message : `${meta.label}失败`}`);
    }
  }

  if (successCount > 0) {
    await refreshSelectedHostResources(action, resourceBaseline);
    resetVmSelectionState();
    if (action !== "delete") {
      void Promise.all(changedVms.map((vm) => refreshVmRowQuietly(vm, { expectedPowerState: expectedPowerStateForAction(action), attempts: 2, intervalMs: 900 })));
    }
  }

  const summary = `批量${meta.label}完成：成功 ${successCount} 台，失败 ${failed.length} 台`;
  if (failed.length) {
    setErrorMessage(`${summary}；${failed.slice(0, 3).join("；")}`);
    pushActivity(`批量${meta.label}部分失败`, {
      target: hostName,
      detail: failed.slice(0, 6).join("；"),
      request: "POST /api/vms/action",
      status: "error",
    });
  } else {
    if (action === "delete") {
      successMessage.value = summary;
      showToast("success", summary);
    }
    pushActivity(`批量${meta.label}成功`, {
      target: hostName,
      detail: `${successCount} 台 VM`,
      request: "POST /api/vms/action",
      status: "success",
    });
  }
}

function vmActionKey(vm: VmNode) {
  return vm.providerId || vm.id;
}

function resetVmRowReconciliationState() {
  vmListReconciler.reset();
}

function setVmActionState(vm: VmNode, state: VmActionState) {
  vmActionStates.value = {
    ...vmActionStates.value,
    [vmActionKey(vm)]: state,
  };
}

function clearVmActionState(vm: VmNode) {
  const key = vmActionKey(vm);
  if (!vmActionStates.value[key]) return;
  const next = { ...vmActionStates.value };
  delete next[key];
  vmActionStates.value = next;
}

function scheduleClearVmActionState(vm: VmNode, delayMs: number) {
  window.setTimeout(() => clearVmActionState(vm), delayMs);
}

function upsertVmRow(vm: VmNode): VmNode {
  vmListReconciler.clearDeleteTombstone(vm);
  vmListReconciler.markMutation(vm);
  if (!vms.value) {
    vms.value = {
      collectedAt: new Date().toISOString(),
      items: [vm],
      page: 1,
      pageSize: 500,
      total: 1,
    };
    vmSummary.value = summarizeVms(vms.value.items, vms.value.total);
    syncSelectedOverviewRowAfterVmChange();
    return vm;
  }
  const existing = vms.value.items.find((item) => isSameVm(item, vm));
  if (existing) {
    return patchVmRow(existing, vm);
  }
  vms.value = {
    ...vms.value,
    items: [vm, ...vms.value.items],
    total: vms.value.total + 1,
  };
  vmSummary.value = summarizeVms(vms.value.items, vms.value.total);
  syncSelectedOverviewRowAfterVmChange();
  return vm;
}

function patchVmRowById(vmId: string, patch: Partial<VmNode>): VmNode | null {
  const target = vms.value?.items.find((item) => item.providerId === vmId || item.id === vmId);
  if (!target) return null;
  return patchVmRow(target, patch);
}

function removeVmRowById(vmId: string) {
  const target = vms.value?.items.find((item) => item.providerId === vmId || item.id === vmId);
  if (!target) {
    vmListReconciler.markDeleted({ providerId: vmId, id: vmId });
    return;
  }
  removeVmRow(target);
}

function patchVmRow(vm: VmNode, patch: Partial<VmNode>): VmNode {
  const nextVm = { ...vm, ...patch };
  vmListReconciler.markMutation(nextVm);
  if (!vms.value) return nextVm;
  vms.value = {
    ...vms.value,
    items: vms.value.items.map((item) => (isSameVm(item, vm) ? { ...item, ...patch } : item)),
  };
  vmSummary.value = summarizeVms(vms.value.items, vms.value.total);
  syncSelectedOverviewRowAfterVmChange();
  return vms.value.items.find((item) => isSameVm(item, nextVm)) ?? nextVm;
}

function removeVmRow(vm: VmNode) {
  vmListReconciler.markDeleted(vm);
  if (!vms.value) return;
  clearVmActionState(vm);
  vms.value = {
    ...vms.value,
    items: vms.value.items.filter((item) => !isSameVm(item, vm)),
    total: Math.max(vms.value.total - 1, 0),
  };
  vmSummary.value = summarizeVms(vms.value.items, vms.value.total);
  selectedVmIds.value = selectedVmIds.value.filter((id) => id !== vm.providerId && id !== vm.id);
  syncSelectedOverviewRowAfterVmChange();
}

interface RefreshVmRowOptions {
  expectedPowerState?: PowerState;
  attempts?: number;
  intervalMs?: number;
}

async function refreshVmRow(vm: VmNode, options: RefreshVmRowOptions = {}): Promise<VmNode> {
  const payload = buildConnectionPayload();
  if (!payload || !selectedHost.value || !vms.value) return vm;
  const attempts = options.attempts ?? (options.expectedPowerState ? 10 : 1);
  const intervalMs = options.intervalMs ?? 1_200;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await sleep(intervalMs);
    try {
      const result = await postJson<VmsResponse>("/api/inventory/vms", {
        ...payload,
        hostId: selectedHost.value.providerId,
        page: 1,
        pageSize: 50,
        keyword: vm.name,
        forceRefresh: true,
      });
      const updated = result.items.find((item) => isSameVm(item, vm) || item.name === vm.name);
      if (!updated || !vms.value) continue;
      if (options.expectedPowerState && !matchesExpectedPowerState(updated.powerState, options.expectedPowerState)) {
        continue;
      }
      return patchVmRow(vm, updated);
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) {
    pushActivity("刷新 VM 行失败", {
      target: vm.name,
      detail: lastError instanceof Error ? lastError.message : "状态刷新失败",
      status: "warning",
    });
  }
  if (options.expectedPowerState) {
    throw new Error(`状态确认超时：${vm.name} 未变为${powerStateDoneLabel(options.expectedPowerState)}，请刷新列表核对。`);
  }
  return vm;
}

async function refreshVmRowQuietly(vm: VmNode, options: RefreshVmRowOptions = {}) {
  try {
    await refreshVmRow(vm, options);
  } catch (error) {
    pushActivity("VM 行刷新未完成", {
      target: vm.name,
      detail: error instanceof Error ? error.message : "请手动刷新列表核对最新状态",
      status: "warning",
    });
  }
}

function isSameVm(left: VmNode, right: VmNode) {
  return left.providerId === right.providerId || left.id === right.id;
}

function matchesExpectedPowerState(actual: PowerState, expected: PowerState) {
  if (expected === "halted") return actual === "halted" || actual === "stopped";
  return actual === expected;
}

function powerStateDoneLabel(state: PowerState) {
  if (state === "running") return "开机";
  if (state === "halted" || state === "stopped") return "关机";
  if (state === "suspended") return "暂停";
  return "目标状态";
}

function expectedPowerStateForAction(action: VmPowerAction): PowerState | undefined {
  if (action === "start" || action === "forceReboot") return "running";
  if (action === "shutdown") return "halted";
  return undefined;
}

function vmActionCompleteMessage(action: VmPowerAction) {
  if (action === "start") return "已开机";
  if (action === "shutdown") return "已关机";
  if (action === "forceReboot") return "已重启";
  return "已删除";
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openConsoleAfterStart(vm: VmNode) {
  openConsoleAfterPowerReady(vm, "开机指令已提交");
}

function openConsoleAfterForceReboot(vm: VmNode) {
  openConsoleAfterPowerReady(vm, "强制重启指令已提交");
}

function openConsoleAfterPowerReady(vm: VmNode, submittedMessage: string) {
  if (!persistentConnectionsEnabled.value) {
    showToast("warning", `${submittedMessage}；共享 Web 模式不使用服务器保存连接，控制台入口已关闭。`);
    return;
  }
  consoleProvisionTaskId.value = "";
  const refreshedVm = vms.value?.items.find((item) => item.providerId === vm.providerId || item.id === vm.id);
  const consoleVm: VmNode = {
    ...(refreshedVm ?? vm),
    powerState: "running",
  };
  const target = resolveVmConsoleTarget({
    connection: {
      id: selectedConnectionId.value,
      providerType: connection.providerType,
      host: connection.host,
      port: connection.port,
      username: connection.username,
      password: persistentConnectionsEnabled.value ? undefined : connection.password,
    },
    vm: consoleVm,
    hostName: selectedHost.value?.name,
    hostAddress: selectedHost.value?.address,
  });
  if (!target) {
    showToast("warning", `${submittedMessage}，但当前平台还没有可用控制台入口。`);
    return;
  }
  consoleTarget.value = target;
  consoleDialogVisible.value = true;
  pushActivity(`打开控制台：${consoleVm.name}`);
}

function syncSelectedOverviewRowAfterVmChange() {
  if (!selectedHostOverviewKey.value || !vmSummary.value) return;
  updateHostOverviewRow(selectedHostOverviewKey.value, {
    summary: vmSummary.value,
    status: "ready",
  });
  if (!vms.value) return;
  const existing = vmSearchCache.value[selectedHostOverviewKey.value];
  if (!existing) return;
  vmSearchCache.value = {
    ...vmSearchCache.value,
    [selectedHostOverviewKey.value]: {
      ...existing,
      items: vms.value.items,
      updatedAt: Date.now(),
      loading: false,
    },
  };
}

function captureSelectedHostResourceFingerprint(): HostResourceFingerprint | null {
  const host = selectedHost.value;
  if (!host) return null;
  return buildHostResourceFingerprint(host, inventory.value?.storage ?? [], vmSummary.value);
}

function buildHostResourceFingerprint(
  host: HostNodeItem,
  hostStorage: HostsResponse["storage"],
  summary: VmInventorySummary | null,
): HostResourceFingerprint {
  return {
    running: summary?.running ?? 0,
    runningVcpu: summary?.runningVcpu ?? summary?.vcpu ?? 0,
    totalVms: summary?.total ?? 0,
    memoryFreeBytes: host.memoryFreeBytes ?? 0,
    storageUsedGiB: hostStorage.reduce((sum, item) => sum + positive(item.usedGiB), 0),
  };
}

function hostResourceChangeObserved(
  action: VmPowerAction,
  baseline: HostResourceFingerprint | null,
  current: HostResourceFingerprint,
) {
  if (!baseline) return true;
  if (action === "start") {
    return current.running > baseline.running || current.runningVcpu > baseline.runningVcpu || current.memoryFreeBytes < baseline.memoryFreeBytes;
  }
  if (action === "shutdown") {
    return current.running < baseline.running || current.runningVcpu < baseline.runningVcpu || current.memoryFreeBytes > baseline.memoryFreeBytes;
  }
  if (action === "forceReboot") {
    return true;
  }
  return current.storageUsedGiB < baseline.storageUsedGiB;
}

async function refreshSelectedHostResources(action: VmPowerAction, baseline: HostResourceFingerprint | null) {
  const payload = buildConnectionPayload();
  const hostId = selectedHost.value?.providerId;
  if (!payload || !hostId) return;
  const attempts = action === "delete" ? 5 : 3;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(action === "delete" ? 800 : 500);
    try {
      const [hostInventory, summaryResult] = await Promise.all([
        postJson<HostsResponse>("/api/inventory/hosts", {
          ...payload,
          forceRefresh: true,
        }),
        postJson<VmSummaryResponse>("/api/inventory/vm-summary", {
          ...payload,
          hostId,
          page: 1,
          pageSize: 500,
          forceRefresh: true,
        }),
      ]);
      const refreshedHost = hostInventory.hosts.find((item) => item.providerId === hostId || item.id === hostId);
      if (!refreshedHost) throw new Error("刷新结果中未找到当前物理机");

      const summary = normalizeVmSummary(summaryResult.summary);
      inventory.value = hostInventory;
      vmSummary.value = summary;
      selectedResourceCapacity.value = summaryResult.resourceCapacity ?? null;
      const overviewConnectionId = selectedConnectionId.value;
      hostOverviewRows.value = hostOverviewRows.value.map((row) => {
        const sameConnection = !overviewConnectionId || row.connection.id === overviewConnectionId;
        const sameHost = row.host.providerId === hostId || row.host.id === hostId;
        return sameConnection && sameHost
          ? {
              ...row,
              inventory: hostInventory,
              host: refreshedHost,
              summary,
              status: "ready",
              error: undefined,
            }
          : row;
      });

      const current = buildHostResourceFingerprint(refreshedHost, hostInventory.storage, summary);
      if (hostResourceChangeObserved(action, baseline, current)) return;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    pushActivity("刷新物理机资源失败", {
      target: selectedHost.value?.name || connection.host,
      detail: lastError instanceof Error ? lastError.message : "资源刷新失败",
      status: "warning",
    });
  }
}

function updateHostOverviewRow(key: string, patch: Partial<HostOverviewRow>) {
  hostOverviewRows.value = hostOverviewRows.value.map((row) => (row.key === key ? { ...row, ...patch } : row));
}

function replaceHostOverviewRows(connectionId: string, rows: HostOverviewRow[]) {
  hostOverviewRows.value = [...hostOverviewRows.value.filter((row) => row.connection.id !== connectionId), ...rows];
}

function createFallbackOverviewRow(connectionItem: StoredConnectionSummary, status: HostOverviewRow["status"], error?: string): HostOverviewRow {
  const host: HostNodeItem = {
    id: connectionItem.id,
    connectionId: connectionItem.id,
    providerId: `pending:${connectionItem.id}`,
    name: connectionItem.name,
    address: connectionItem.host,
    vendor: "",
    version: "",
    cpuModel: "",
    cpuSockets: 0,
    cpuCores: 0,
    memoryTotalBytes: 0,
    memoryFreeBytes: 0,
    status: "unknown",
  };
  return {
    key: connectionItem.id,
    connection: connectionItem,
    inventory: {
      collectedAt: new Date().toISOString(),
      hosts: [],
      storage: [],
      networks: [],
    },
    host,
    summary: null,
    resourceCapacity: null,
    status,
    error,
  };
}

function hasOverviewInventory(row: HostOverviewRow) {
  return row.inventory.hosts.length > 0;
}

async function runLimited<T>(items: T[], limit: number, worker: (item: T) => Promise<void>) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      if (item) await worker(item);
    }
  });
  await Promise.all(workers);
}

function summarizeVms(items: VmNode[], total = items.length): VmInventorySummary {
  const runningItems = items.filter((vm) => vm.powerState === "running");
  return normalizeVmSummary({
    total: Math.max(total, items.length),
    running: runningItems.length,
    halted: items.filter((vm) => vm.powerState === "halted").length,
    vcpu: items.reduce((sum, vm) => sum + vm.cpuCount, 0),
    runningVcpu: runningItems.reduce((sum, vm) => sum + vm.cpuCount, 0),
    memoryBytes: items.reduce((sum, vm) => sum + vm.memoryBytes, 0),
    runningMemoryBytes: runningItems.reduce((sum, vm) => sum + vm.memoryBytes, 0),
    diskBytes: items.reduce((sum, vm) => sum + positive(vm.diskVirtualBytes ?? 0), 0),
  });
}

function normalizeVmSummary(summary: VmInventorySummary): VmInventorySummary {
  const running = positive(summary.running);
  const halted = positive(summary.halted);
  const total = Math.max(positive(summary.total), running, halted, running + halted);
  return {
    ...summary,
    total,
    running,
    halted,
    vcpu: positive(summary.vcpu),
    runningVcpu: positive(summary.runningVcpu ?? summary.vcpu),
    memoryBytes: positive(summary.memoryBytes),
    runningMemoryBytes: positive(summary.runningMemoryBytes ?? summary.memoryBytes),
    diskBytes: summary.diskBytes == null ? summary.diskBytes : positive(summary.diskBytes),
  };
}

function hostCpuPlan(row: HostOverviewRow) {
  const cores = positive(row.host.cpuCores);
  const allocated = positive(row.summary?.runningVcpu ?? row.summary?.vcpu ?? 0);
  return {
    cores,
    allocated,
    percent: percent(allocated, cores),
  };
}

function hostMemoryPlan(row: HostOverviewRow) {
  const total = row.host.memoryTotalBytes;
  const free = row.host.memoryFreeBytes ?? 0;
  const used = Math.max(total - free, 0);
  return {
    total,
    used,
    free,
    percent: percent(used, total),
  };
}

function hostStoragePlan(row: HostOverviewRow) {
  // 优先使用后端 vm-summary 已按“可承载 VM 磁盘的存储池 + 主机范围”修正过的容量
  const capacity = row.resourceCapacity?.storage;
  if (capacity && capacity.physicalTotalGiB > 0) {
    return {
      physicalGiB: capacity.physicalTotalGiB,
      usedGiB: capacity.physicalUsedGiB,
      freeGiB: capacity.physicalFreeGiB,
      percent: percent(capacity.physicalUsedGiB, capacity.physicalTotalGiB),
    };
  }
  // 兜底：resourceCapacity 未就绪时按平台过滤（剔除 ISO 库/可移动介质/纯备份存储），并按主机范围收敛
  const providerType = row.connection.providerType;
  const rows = row.inventory.storage.filter(
    (sr) => (!sr.hostId || sr.hostId === row.host.providerId) && isVmDiskRepositoryForProvider(providerType, sr),
  );
  const physicalGiB = rows.reduce((sum, sr) => sum + positive(sr.physicalGiB), 0);
  const usedGiB = rows.reduce((sum, sr) => sum + positive(sr.usedGiB), 0);
  const freeGiB = Math.max(physicalGiB - usedGiB, 0);
  return {
    physicalGiB,
    usedGiB,
    freeGiB,
    percent: percent(usedGiB, physicalGiB),
  };
}

function hostStorageHighlights(row: HostOverviewRow): Array<{ kind: "hba" | "local" | "file"; label: string; note: string; freeGiB: number; usedGiB: number; totalGiB: number; percent: number }> {
  // 与主卡存储卡片同口径：按主机范围 + 仅可承载 VM 磁盘的存储池，归类出 HBA / LVM 明细（最多加 HBA 和 LVM）
  const providerType = row.connection.providerType;
  const rows = row.inventory.storage.filter(
    (sr) => (!sr.hostId || sr.hostId === row.host.providerId) && isVmDiskRepositoryForProvider(providerType, sr),
  );
  let hbaUsed = 0;
  let hbaTotal = 0;
  let localUsed = 0;
  let localTotal = 0;
  for (const sr of rows) {
    const category = storagePoolCategory(providerType, sr);
    if (category.kind === "hba") {
      hbaUsed += positive(sr.usedGiB);
      hbaTotal += positive(sr.physicalGiB);
    } else if (category.kind === "local") {
      localUsed += positive(sr.usedGiB);
      localTotal += positive(sr.physicalGiB);
    }
  }
  const items: Array<{ kind: "hba" | "local" | "file"; label: string; note: string; freeGiB: number; usedGiB: number; totalGiB: number; percent: number }> = [];
  if (hbaTotal > 0) items.push({ kind: "hba", label: "虚拟 HBA", note: "", freeGiB: Math.max(hbaTotal - hbaUsed, 0), usedGiB: hbaUsed, totalGiB: hbaTotal, percent: percent(hbaUsed, hbaTotal) });
  if (localTotal > 0) items.push({ kind: "local", label: "物理 LVM", note: "", freeGiB: Math.max(localTotal - localUsed, 0), usedGiB: localUsed, totalGiB: localTotal, percent: percent(localUsed, localTotal) });
  return items;
}

function hostRecommendation(row: HostOverviewRow) {
  if (row.status === "error") return { label: "异常", className: "recommend-bad", reason: row.error || "连接失败" };
  if (!hasOverviewInventory(row)) return { label: "加载中", className: "recommend-wait", reason: "等待物理机基础信息" };
  if (!row.summary) return { label: "加载中", className: "recommend-wait", reason: "等待 VM 加载" };
  const memory = hostMemoryPlan(row);
  const storagePlan = hostStoragePlan(row);
  if (memory.free < 8 * 1024 ** 3 || storagePlan.freeGiB < 100) {
    return { label: "不适合", className: "recommend-bad", reason: bottleneckText(memory, storagePlan) };
  }
  if (memory.free < 32 * 1024 ** 3 || storagePlan.freeGiB < 500) {
    return { label: "资源紧张", className: "recommend-warn", reason: bottleneckText(memory, storagePlan) };
  }
  return { label: "适合", className: "recommend-good", reason: `余量 ${formatBytes(memory.free)} 内存 / ${formatNumber(storagePlan.freeGiB)} GiB 存储` };
}

function bottleneckText(memory: ReturnType<typeof hostMemoryPlan>, storagePlan: ReturnType<typeof hostStoragePlan>) {
  const reasons: string[] = [];
  if (memory.free < 32 * 1024 ** 3) reasons.push(`内存剩余 ${formatBytes(memory.free)}`);
  if (storagePlan.freeGiB < 500) reasons.push(`存储剩余 ${formatNumber(storagePlan.freeGiB)} GiB`);
  return reasons.join(" · ") || "资源正常";
}

function overviewRowClassName({ row }: { row: HostOverviewRow }) {
  return row.key === selectedHostOverviewKey.value ? "current-overview-row" : "";
}

function handleHostOverviewSort({ prop, order }: { prop: string; order: TableSortOrder }) {
  const supported: HostOverviewSortKey[] = ["hostName", "cpuUsage", "memoryFree", "storageFree", "vmTotal"];
  hostOverviewSort.value = {
    prop: supported.includes(prop as HostOverviewSortKey) ? (prop as HostOverviewSortKey) : "hostName",
    order,
  };
}

function compareHostOverviewRows(left: HostOverviewRow, right: HostOverviewRow, prop: HostOverviewSortKey, order: TableSortOrder) {
  if (!order) {
    return left.host.name.localeCompare(right.host.name, "zh-CN", { numeric: true, sensitivity: "base" });
  }
  const leftValue = hostOverviewSortValue(left, prop);
  const rightValue = hostOverviewSortValue(right, prop);
  if (leftValue == null && rightValue == null) return left.host.name.localeCompare(right.host.name, "zh-CN", { numeric: true, sensitivity: "base" });
  if (leftValue == null) return 1;
  if (rightValue == null) return -1;
  const direction = order === "ascending" ? 1 : -1;
  const compared =
    typeof leftValue === "number" && typeof rightValue === "number"
      ? leftValue - rightValue
      : String(leftValue).localeCompare(String(rightValue), "zh-CN", { numeric: true, sensitivity: "base" });
  return compared === 0
    ? left.host.name.localeCompare(right.host.name, "zh-CN", { numeric: true, sensitivity: "base" })
    : compared * direction;
}

function hostOverviewSortValue(row: HostOverviewRow, prop: HostOverviewSortKey): string | number | null {
  if (prop === "hostName") return row.host.name;
  if (prop === "cpuUsage") return hasOverviewInventory(row) && row.summary ? hostCpuPlan(row).percent : null;
  if (prop === "memoryFree") return hasOverviewInventory(row) ? hostMemoryPlan(row).free : null;
  if (prop === "storageFree") return hasOverviewInventory(row) ? hostStoragePlan(row).freeGiB : null;
  return row.summary?.total ?? null;
}

function overviewStatusLabel(row: HostOverviewRow) {
  if (row.status === "error") return "异常";
  if (!hasOverviewInventory(row) || !row.summary) return "加载中";
  return "在线";
}

function overviewStatusClass(row: HostOverviewRow) {
  if (row.status === "error") return "state-unknown";
  if (!hasOverviewInventory(row) || !row.summary) return "state-loading";
  return "state-running";
}

function overviewRowLoading(row: HostOverviewRow) {
  return row.status !== "error" && (!hasOverviewInventory(row) || !row.summary);
}

function overviewCpuMain(row: HostOverviewRow) {
  if (!hasOverviewInventory(row)) return "-";
  const cpu = hostCpuPlan(row);
  if (!row.summary) return `${formatNumber(cpu.cores)} 个物理核心`;
  return `运行 ${formatNumber(cpu.allocated)} vCPU`;
}

function overviewCpuSubline(row: HostOverviewRow) {
  if (!hasOverviewInventory(row)) return "读取中";
  if (!row.summary) return "分配加载中";
  const cpu = hostCpuPlan(row);
  return `${formatNumber(cpu.cores)} 个物理核心`;
}

function overviewMemoryMain(row: HostOverviewRow) {
  if (!hasOverviewInventory(row)) return "-";
  const memory = hostMemoryPlan(row);
  return `剩余 ${formatBytes(memory.free)}`;
}

function overviewMemorySubline(row: HostOverviewRow) {
  if (!hasOverviewInventory(row)) return "读取中";
  const memory = hostMemoryPlan(row);
  return `已用 ${formatBytes(memory.used)} / ${formatBytes(memory.total)}`;
}

/** 剩余占比 = 100 - 已用占比（存储统计统一用剩余语义，避免“剩余 xx GiB 43%”误读） */
function storageRemainingPercent(usedPercent: number) {
  return Math.max(100 - usedPercent, 0);
}

/** 剩余占比健康度：≥40% 正常绿 / 20–40% 偏紧橙 / <20% 告警红；绝对剩余 <500 GiB 至少橙色。 */
function storageRemainingHealth(remainingPercentValue: number, freeGiB: number) {
  if (remainingPercentValue < 20) return "danger" as const;
  if (remainingPercentValue < 40 || freeGiB < 500) return "warn" as const;
  return "ok" as const;
}

/** 存储池详情表格单行的剩余占比（剩余语义，与主卡/总览口径一致）。 */
function storageRowRemainingPercent(row: StorageRepository) {
  return storageRemainingPercent(percent(positive(row.usedGiB), positive(row.physicalGiB)));
}

/** 存储池详情表格单行的剩余健康度（与剩余占比文本/进度条同色）。 */
function storageRowRemainingHealth(row: StorageRepository) {
  return storageRemainingHealth(storageRowRemainingPercent(row), storageFreeGiB(row));
}

/** 当前存储展示口径（HBA+LVM 取主分配类型 HBA 优先；总体取可分配物理总体）的剩余占比。 */
function overviewStoragePercent(row: HostOverviewRow) {
  if (!hasOverviewInventory(row)) return null;
  if (uiPreferences.storageDisplayMode === "hba-lvm") {
    const highlights = hostStorageHighlights(row);
    const primary = highlights[0];
    if (primary) return storageRemainingPercent(primary.percent);
  }
  return storageRemainingPercent(hostStoragePlan(row).percent);
}

function overviewStorageHealth(row: HostOverviewRow) {
  if (!hasOverviewInventory(row)) return "ok" as const;
  if (uiPreferences.storageDisplayMode === "hba-lvm") {
    const highlights = hostStorageHighlights(row);
    const primary = highlights[0];
    if (primary) return storageRemainingHealth(storageRemainingPercent(primary.percent), primary.freeGiB);
  }
  const storagePlan = hostStoragePlan(row);
  return storageRemainingHealth(storageRemainingPercent(storagePlan.percent), storagePlan.freeGiB);
}

function overviewStorageCellClass(row: HostOverviewRow) {
  const health = overviewStorageHealth(row);
  return { warning: health === "warn", danger: health === "danger" };
}

function overviewStorageMain(row: HostOverviewRow) {
  if (!hasOverviewInventory(row)) return "-";
  const storagePlan = hostStoragePlan(row);
  // HBA+LVM 模式：主指标取第一个可分配存储类型（HBA 优先）的剩余，分类名移到副行展示
  if (uiPreferences.storageDisplayMode === "hba-lvm") {
    const highlights = hostStorageHighlights(row);
    const primary = highlights[0];
    if (primary) return `剩余 ${formatNumber(primary.freeGiB)} GiB`;
  }
  return `剩余 ${formatNumber(storagePlan.freeGiB)} GiB`;
}

function overviewStorageSubline(row: HostOverviewRow) {
  if (!hasOverviewInventory(row)) return "读取中";
  const storagePlan = hostStoragePlan(row);
  // HBA+LVM 模式：副行展示 HBA / LVM 分类已用量（如「HBA 已用 x GiB，LVM 已用 y GiB」），主行只保留剩余；
  // 没有实际用量的分类（已用 0 GiB）不展示
  if (uiPreferences.storageDisplayMode === "hba-lvm") {
    const highlights = hostStorageHighlights(row).filter((item) => item.usedGiB > 0);
    if (highlights.length) {
      return highlights
        .map((item) => `${storageHighlightShortLabel(item.kind)} 已用 ${formatNumber(item.usedGiB)} GiB`)
        .join("，");
    }
  }
  return `已用 ${formatNumber(storagePlan.usedGiB)} GiB`;
}

function storageHighlightShortLabel(kind: "hba" | "local" | "file") {
  if (kind === "hba") return "HBA";
  if (kind === "local") return "LVM";
  return "文件存储";
}

function overviewResourceMeterPercent(row: HostOverviewRow, type: "cpu" | "memory" | "storage") {
  if (!hasOverviewInventory(row)) return 0;
  // 存储列进度条表示「已用占比」（剩余 3% → 进度条 97%，与存储卡片一致），CPU/内存保持已用占比
  if (type === "storage") {
    const remainingPct = overviewStoragePercent(row);
    return remainingPct == null ? 0 : Math.min(Math.max(100 - remainingPct, 0), 100);
  }
  const value = type === "cpu" ? hostCpuPlan(row).percent : hostMemoryPlan(row).percent;
  return Math.min(Math.max(value, 0), 100);
}

function overviewResourceMeterWarning(row: HostOverviewRow, type: "cpu" | "memory" | "storage") {
  if (!hasOverviewInventory(row)) return false;
  if (type === "cpu") {
    return false;
  }
  if (type === "memory") {
    const memory = hostMemoryPlan(row);
    return memory.percent >= 78 || memory.free < 32 * 1024 ** 3;
  }
  const health = overviewStorageHealth(row);
  return health === "warn" || health === "danger";
}

function normalizeOverviewSearchInput(value: string) {
  return value
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[。．｡]/g, ".")
    .replace(/[\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/g, " ")
    .replace(/[，,；;、\r\n\t]+/g, " ")
    .replace(/\s*\.\s*/g, ".")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function parseSearchKeywords(value: string) {
  const normalized = normalizeOverviewSearchInput(value);
  if (!normalized) return [];
  const parts = normalized.split(" ").filter(Boolean);
  const compactedIp = compactSpacedIpKeyword(parts);
  return Array.from(new Set(compactedIp ? [compactedIp] : parts));
}

function compactSpacedIpKeyword(parts: string[]) {
  if (parts.length < 2 || !parts.every((part) => /^[0-9.]+$/.test(part))) return "";
  const compacted = parts.join("");
  if (!/^\d{1,3}(\.\d{1,3}){1,3}$/.test(compacted)) return "";
  return compacted;
}

function parseOverviewSearchKeywords(value: string) {
  return parseSearchKeywords(value);
}

function normalizeHostOverviewSearch() {
  const normalized = normalizeOverviewSearchInput(hostOverviewSearch.value);
  if (hostOverviewSearch.value !== normalized) hostOverviewSearch.value = normalized;
}

function scheduleOverviewVmSearchStableHold(value = hostOverviewSearch.value) {
  if (overviewVmSearchHoldTimer) clearTimeout(overviewVmSearchHoldTimer);
  const keywords = parseOverviewSearchKeywords(value);
  if (!keywords.some(shouldSearchVmIp)) {
    overviewVmSearchHoldTimer = undefined;
    overviewVmSearchHolding.value = false;
    return;
  }
  overviewVmSearchHolding.value = true;
  overviewVmSearchHoldTimer = setTimeout(() => {
    overviewVmSearchHoldTimer = undefined;
    overviewVmSearchHolding.value = false;
  }, OVERVIEW_VM_SEARCH_STABLE_HOLD_MS);
}

function scheduleOverviewSearchApply(value = hostOverviewSearch.value) {
  if (hostOverviewSearchApplyTimer) clearTimeout(hostOverviewSearchApplyTimer);
  const normalized = normalizeOverviewSearchInput(value);
  if (!normalized) {
    hostOverviewSearchApplyTimer = undefined;
    appliedHostOverviewSearch.value = "";
    return;
  }
  hostOverviewSearchApplyTimer = setTimeout(() => {
    hostOverviewSearchApplyTimer = undefined;
    appliedHostOverviewSearch.value = normalizeOverviewSearchInput(hostOverviewSearch.value);
  }, OVERVIEW_SEARCH_APPLY_DEBOUNCE_MS);
}

function rowMatchesOverviewKeyword(row: HostOverviewRow, keyword: string) {
  if (hostMatchesKeyword(row, keyword)) return true;
  if (!shouldSearchVmIp(keyword)) return false;

  const cache = vmSearchCache.value[row.key];
  if (!cache) return false;
  if (cache.loading && cache.items.length === 0) return false;
  return cache.items.some((vm) => vmMatchesOverviewKeyword(vm, row, keyword));
}

function rowMatchesOverviewKeywords(row: HostOverviewRow, keywords: string[]) {
  return keywords.some((keyword) => rowMatchesOverviewKeyword(row, keyword));
}

function vmSearchMatches(row: HostOverviewRow) {
  const keywords = overviewSearchKeywords.value;
  if (!keywords.some(shouldSearchVmIp)) return [];
  const cache = vmSearchCache.value[row.key];
  if (!cache?.items.length) return [];
  return cache.items.filter((vm) => keywords.some((keyword) => vmMatchesOverviewKeyword(vm, row, keyword)));
}

function overviewVmSearchMatchedKeywords(row: HostOverviewRow) {
  const keywords = overviewSearchKeywords.value.filter(shouldSearchVmIp);
  if (!keywords.length) return [];
  const cache = vmSearchCache.value[row.key];
  if (!cache?.items.length) return [];
  return keywords.filter((keyword) => cache.items.some((vm) => vmMatchesOverviewKeyword(vm, row, keyword)));
}

function vmSearchMatchSummary(row: HostOverviewRow) {
  const matches = vmSearchMatches(row);
  if (!matches.length) return "";
  const first = matches[0];
  const ip = displayVmIpForHost(first, row.host.address);
  const more = matches.length > 1 ? ` 等 ${matches.length} 台` : "";
  return `VM 命中：${ip} · ${first.name}${more}`;
}

function vmMatchesOverviewKeyword(vm: VmSearchIndexItem, row: HostOverviewRow, keyword: string) {
  return vmMatchesKeyword(vm, row.host.address, keyword);
}

function hostMatchesKeyword(row: HostOverviewRow, keyword: string) {
  const textFields = [row.connection.name, row.host.name].map((item) => item.toLowerCase()).filter(Boolean);
  if (hostOverviewMatchMode.value === "exact" ? textFields.includes(keyword) : textFields.some((item) => item.includes(keyword))) return true;
  const hostIps = [row.connection.host, row.host.address].map((item) => item.toLowerCase()).filter(Boolean);
  return hostIps.some((ip) => ipMatchesKeyword(ip, keyword, hostOverviewMatchMode.value));
}

function vmMatchesKeyword(vm: { name: string; providerId: string; guestOs?: string; ipAddresses: string[] }, hostIp: string | undefined, keyword: string, matchMode: "exact" | "fuzzy" = hostOverviewMatchMode.value) {
  const textFields = [vm.name, vm.providerId, vm.guestOs ?? ""].map((item) => item.toLowerCase()).filter(Boolean);
  if (matchMode === "exact" ? textFields.includes(keyword) : textFields.some((item) => item.includes(keyword))) return true;
  const ips = vm.ipAddresses.map((item) => item.toLowerCase()).filter(Boolean);
  return ips.some((ip) => ipMatchesKeyword(ip, keyword, matchMode));
}

function ipMatchesKeyword(ip: string, keyword: string, matchMode: "exact" | "fuzzy") {
  if (matchMode === "fuzzy") return ip.includes(keyword);
  if (ip === keyword) return true;
  return isShortIpFragment(keyword) && ip.endsWith(`.${keyword}`);
}

function isShortIpFragment(keyword: string) {
  return /^\d{1,3}(\.\d{1,3}){1,2}$/.test(keyword);
}

function shouldSearchVmIp(keyword: string) {
  return keyword.length >= 2 && /[0-9.]/.test(keyword);
}

function hasFreshVmSearchCache(row: HostOverviewRow) {
  const cache = vmSearchCache.value[row.key];
  return !!cache && !cache.loading && Date.now() - cache.updatedAt < VM_SEARCH_CACHE_TTL_MS;
}

function hasSettledVmSearchCache(row: HostOverviewRow) {
  const cache = vmSearchCache.value[row.key];
  return !!cache && !cache.loading && Date.now() - cache.updatedAt < VM_SEARCH_CACHE_TTL_MS;
}

function buildConnectionPayload() {
  if (selectedConnectionId.value && !connection.password.trim()) {
    if (!persistentConnectionsEnabled.value) {
      const stored = findBrowserStoredConnection(selectedConnectionId.value);
      if (!stored) {
        setErrorMessage("当前浏览器没有找到该连接的本地密码，请重新选择或重新保存连接。");
        return null;
      }
      return buildConnectionPayloadFromStored(stored);
    }
    if (hasUnsavedSelectedConnectionChanges()) {
      setErrorMessage("当前连接表单已修改。请重新输入密码后测试或保存，或从已保存连接列表重新选择原连接。");
      return null;
    }
    return {
      connectionId: selectedConnectionId.value,
      providerType: connection.providerType,
    };
  }
  return buildDirectConnectionPayload();
}

function buildConnectionPayloadFromStored(stored: BrowserStoredConnection | StoredConnectionSummary) {
  if (persistentConnectionsEnabled.value || !("password" in stored)) {
    return {
      connectionId: stored.id,
      providerType: stored.providerType,
    };
  }
  return {
    providerType: stored.providerType,
    host: stored.host,
    port: stored.port,
    username: stored.username,
    password: stored.password,
  };
}

function buildConnectionPayloadFromSummary(summary: StoredConnectionSummary) {
  if (persistentConnectionsEnabled.value) {
    return {
      connectionId: summary.id,
      providerType: summary.providerType,
    };
  }
  const stored = findBrowserStoredConnection(summary.id);
  if (!stored) {
    throw new Error(`当前浏览器缺少连接“${summary.name}”的本地密码，请重新保存该连接。`);
  }
  return buildConnectionPayloadFromStored(stored);
}

function hasUnsavedSelectedConnectionChanges() {
  const stored = selectedStoredConnection.value;
  if (!stored) return false;
  return (
    connection.providerType !== stored.providerType ||
    connection.host.trim() !== stored.host ||
    Number(connection.port || defaultPortForProvider(connection.providerType)) !== stored.port ||
    connection.username.trim() !== stored.username
  );
}

function buildDirectConnectionPayload() {
  const payload = {
    providerType: connection.providerType,
    host: connection.host.trim(),
    port: connection.port || defaultPortForProvider(connection.providerType),
    username: connection.username.trim(),
    password: connection.password.trim(),
  };
  if (!payload.host || !payload.username || !payload.password) {
    setErrorMessage("请填写平台、Host、用户名和密码。密码不要依赖浏览器自动填充。");
    return null;
  }
  return payload;
}

function persistConnection(payload: ReturnType<typeof buildConnectionPayload>) {
  if (!persistentConnectionsEnabled.value) return;
  if (!payload) return;
  if ("connectionId" in payload) {
    void saveConnectionPreferences({
      selectedConnectionId: payload.connectionId,
      providerType: payload.providerType,
    });
    return;
  }
  void saveConnectionPreferences({
    selectedConnectionId: selectedConnectionId.value,
    providerType: payload.providerType,
    host: payload.host,
    port: payload.port,
    username: payload.username,
    connectionName: connectionName.value,
  });
}

function clearMessages() {
  errorMessage.value = "";
  successMessage.value = "";
  clearConnectionFeedback();
}

function clearConnectionFeedback() {
  connectionFeedbackText.value = "";
  connectionFeedbackKind.value = "";
}

function setConnectionFeedback(kind: "success" | "error", message: string) {
  connectionFeedbackText.value = message;
  connectionFeedbackKind.value = kind;
}

function setErrorMessage(message: string, bubble = true) {
  errorMessage.value = message;
  successMessage.value = "";
  if (!bubble) return;
  const now = Date.now();
  if (message === lastErrorToast && now - lastErrorToastAt < 1200) return;
  lastErrorToast = message;
  lastErrorToastAt = now;
  showToast("error", message);
}

function setSuccessMessage(message: string) {
  successMessage.value = message;
  errorMessage.value = "";
  showToast("success", message);
}

function setConnectionErrorMessage(message: string) {
  setConnectionFeedback("error", message);
  setErrorMessage(message);
}

function setConnectionSuccessMessage(message: string) {
  setConnectionFeedback("success", message);
  setSuccessMessage(message);
}

function showToast(type: "success" | "error" | "warning" | "info", message: string) {
  ElMessage[type]({
    message,
    duration: VRC_TOAST_DURATION_MS,
    showClose: false,
  });
}

function pushActivity(
  title: string,
  options: {
    detail?: string;
    target?: string;
    request?: string;
    command?: string;
    status?: ActivityEntry["status"];
  } = {},
) {
  activityEntries.value = [
    {
      id: `${Date.now()}:${activitySeq++}`,
      time: formatActivityTime(),
      title,
      detail: options.detail,
      target: options.target,
      request: options.request,
      command: options.command,
      status: options.status ?? "info",
    },
    ...activityEntries.value,
  ].slice(0, 200);
}

function handleConsoleUploadResult(result: ConsoleUploadResultEvent) {
  const target = result.vmIp ? `${result.vmName} / ${result.vmIp}` : result.vmName;
  const fileText = result.files.length ? `文件：${result.files.join("，")}` : "";
  const pathText = result.remotePaths.length ? `位置：${result.remotePaths.join("，")}` : "";
  const detail = [fileText, pathText, result.message].filter(Boolean).join("；");
  if (result.status === "success") {
    showToast("success", result.message);
    pushActivity("控制台上传完成", {
      target,
      detail,
      status: "success",
    });
    return;
  }
  showToast("error", result.message);
  pushActivity("控制台上传失败", {
    target,
    detail,
    status: "error",
  });
}

function provisionTaskActivityTitle(status: ProvisionTask["status"]) {
  if (status === "success") return "创建链路完成";
  if (status === "warning") return "系统创建完成，存在告警";
  if (status === "failed") return "创建链路失败";
  if (status === "running") return "创建链路执行中";
  return "创建链路排队中";
}

function provisionTaskActivityStatus(status: ProvisionTask["status"]): ActivityEntry["status"] {
  if (status === "success") return "success";
  if (status === "warning") return "warning";
  if (status === "failed") return "error";
  if (status === "running") return "pending";
  return "info";
}

function formatActivityTime() {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

function formatPersistentAuditTime(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

async function loadPersistentAudit() {
  if (persistentAuditLoading.value) return;
  persistentAuditLoading.value = true;
  try {
    const result = await postJson<{ records: PersistentAuditRecord[]; total: number }>("/api/audit", undefined, "GET");
    persistentAuditEntries.value = (result.records ?? []).map((row) => ({
      id: row.id,
      time: formatPersistentAuditTime(row.time),
      title: row.title,
      status: row.status,
      ...(row.detail ? { detail: row.detail } : {}),
      ...(row.target ? { target: row.target } : {}),
      ...(row.request ? { request: row.request } : {}),
      ...(row.command ? { command: row.command } : {}),
      ...(row.action ? { action: row.action } : {}),
      ...(row.providerType ? { providerType: row.providerType } : {}),
      ...(row.connectionId ? { connectionId: row.connectionId } : {}),
      ...(row.connectionName ? { connectionName: row.connectionName } : {}),
    }));
  } catch {
    persistentAuditEntries.value = [];
  } finally {
    persistentAuditLoading.value = false;
  }
}

async function refreshPersistentAudit() {
  persistentAuditEntries.value = [];
  await loadPersistentAudit();
}

async function openPersistentAuditDialog() {
  if (!persistentAuditEntries.value.length && !persistentAuditLoading.value) {
    await loadPersistentAudit();
  }
  activityLogVisible.value = true;
}

function maintenanceIsoDecisionLabel(item: MaintenanceGeneratedIsoEntry) {
  if (item.decision === "eligible") return "可清理";
  if (item.decision === "retained") return "暂保留";
  if (item.decision === "cleaned") return "已清理";
  if (item.decision === "failed") return "清理失败";
  return item.reason.includes("任务仍在执行") ? "任务进行中" : "需检查";
}

function maintenanceIsoStatusLabel(status: MaintenanceGeneratedIsoEntry["status"]) {
  const labels: Record<MaintenanceGeneratedIsoEntry["status"], string> = {
    creating: "创建中",
    uploaded: "已上传",
    attached: "已挂载",
    installed: "安装完成",
    failed: "任务失败",
    deleted: "已删除",
  };
  return labels[status];
}

function formatMaintenanceIsoDate(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "-";
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function activityStatusLabel(status: ActivityEntry["status"] | "all") {
  const labels = {
    all: "全部",
    info: "信息",
    pending: "处理中",
    success: "成功",
    warning: "提醒",
    error: "失败",
  };
  return labels[status];
}

function activityFullText(item: ActivityEntry) {
  return [item.time, activityStatusLabel(item.status), item.title, item.target, item.detail, item.request, item.command].filter(Boolean).join(" · ");
}

function openActivityDetail(item: ActivityEntry, sequence: number) {
  selectedActivityEntry.value = item;
  selectedActivityEntrySequence.value = sequence;
  activityDetailVisible.value = true;
}

async function postJson<T>(url: string, payload: unknown, method = "POST"): Promise<T> {
  return secureJsonRequest<T>(url, payload, method);
}

function positive(value: number) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function percent(used: number, total: number) {
  if (!total) return 0;
  return Math.min(Math.round((used / total) * 100), 999);
}

/**
 * 判断存储池是否可承载虚拟机磁盘（与后端 isVmDiskRepository 口径一致）：
 * - xenserver：排除 iso / udev；
 * - proxmox：仅保留 content 含 images / rootdir（未声明 content 视为支持）；
 * - vmware / libvirt：全部视为可承载 VM 磁盘。
 */
function isVmDiskRepositoryForProvider(providerType: ProviderType, repository: StorageRepository): boolean {
  if (providerType === "xenserver") {
    const type = repository.type.trim().toLowerCase();
    return type !== "" && type !== "iso" && type !== "udev";
  }
  if (providerType === "proxmox") {
    const content = repository.content ?? [];
    if (content.length === 0) return true;
    const normalized = new Set(content.map((item) => item.trim().toLowerCase()));
    return normalized.has("images") || normalized.has("rootdir");
  }
  return true;
}

type StoragePoolCategoryKind = "hba" | "local" | "file" | "iso" | "media" | "vm" | "backup" | "other";

interface StoragePoolCategory {
  kind: StoragePoolCategoryKind;
  label: string;
  note: string;
}

/**
 * 存储池用途分类，用于详情弹窗/主卡区分“虚拟 HBA”“物理 LVM”
 * 与镜像库、可移动介质等不可分配 VM 磁盘的池；与 isVmDiskRepositoryForProvider 口径配套。
 */
function storagePoolCategory(providerType: ProviderType, repository: StorageRepository): StoragePoolCategory {
  const type = (repository.type ?? "").trim().toLowerCase();
  if (providerType === "xenserver") {
    if (["lvmohba", "lvmoiscsi", "lvmofc"].includes(type)) return { kind: "hba", label: "虚拟 HBA", note: "" };
    if (type === "lvm") return { kind: "local", label: "物理 LVM", note: "" };
    if (["ext", "nfs", "smb", "cifs"].includes(type)) return { kind: "file", label: "文件存储", note: "" };
    if (type === "iso") return { kind: "iso", label: "镜像库", note: "不计入可分配" };
    if (type === "udev") return { kind: "media", label: "可移动介质", note: "不计入可分配" };
    return { kind: "other", label: "其他存储池", note: "" };
  }
  if (providerType === "proxmox") {
    const content = new Set((repository.content ?? []).map((item) => item.trim().toLowerCase()));
    if (content.has("images") || content.has("rootdir")) return { kind: "vm", label: "VM 磁盘", note: "可分配" };
    if (content.has("iso")) return { kind: "iso", label: "镜像库", note: "不计入可分配" };
    if (content.has("backup")) return { kind: "backup", label: "备份存储", note: "不计入可分配" };
    return { kind: "vm", label: "VM 磁盘", note: "可分配" };
  }
  return { kind: "vm", label: "VM 磁盘", note: "可分配" };
}

function storageFreeGiB(row: StorageRepository) {
  return Math.max(positive(row.physicalGiB) - positive(row.usedGiB), 0);
}

/** 剩余容量醒目色：≥90% 红色告警、≥80% 橙色预警、其余正常绿色。 */
function storageFreeClass(row: StorageRepository) {
  const usage = percent(positive(row.usedGiB), positive(row.physicalGiB));
  if (usage >= 90) return "is-danger";
  if (usage >= 80) return "is-warning";
  return "is-ok";
}

function compareVmByIp(left: VmNode, right: VmNode) {
  const leftIp = vmIpSortValue(left);
  const rightIp = vmIpSortValue(right);
  if (leftIp !== rightIp) return leftIp - rightIp;
  return left.name.localeCompare(right.name, "zh-CN", { numeric: true, sensitivity: "base" });
}

function vmIpSortValue(vm: VmNode) {
  const ip = displayVmIp(vm);
  if (ip === "-") return Number.MAX_SAFE_INTEGER;
  return ip.split(".").reduce((sum, part) => sum * 256 + Number(part), 0);
}

function displayVmIp(vm: VmNode) {
  return displayVmIpForHost(vm, selectedHost.value?.address);
}

function displayVmIpForHost(vm: { ipAddresses: string[] }, hostIp?: string) {
  return vm.ipAddresses[0] || "-";
}

function displayGuestOs(vm: VmNode) {
  return vm.guestOs?.trim() || "-";
}

function formatVmDiskSummary(vm: VmNode) {
  const count = vm.diskCount ?? 0;
  const summary = vm.diskSizeSummary?.trim().replace(/\.0 GiB/g, " GiB");
  if (count > 0 && summary) return `${count} 块 · ${summary}`;
  if (count > 0) return `${count} 块`;
  return "未读到磁盘明细";
}

function formatBytes(value: number) {
  if (!Number.isFinite(value)) return "-";
  const gib = value / 1024 / 1024 / 1024;
  if (gib >= 1) return `${formatNumber(gib)} GiB`;
  return `${formatNumber(value / 1024 / 1024)} MiB`;
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(value);
}

function formatCpuCount(value: number) {
  return value > 0 ? `${value} 核` : "未读到";
}

function formatSocketCount(value: number) {
  return value > 0 ? `${value} Socket` : "Socket 未读到";
}

function isVmStopped(vm: VmNode) {
  return vm.powerState === "halted" || vm.powerState === "stopped";
}

function isVmRunning(vm: VmNode) {
  return vm.powerState === "running";
}

function canRunVmAction(action: VmPowerAction, vm: VmNode) {
  if (action === "start") return isVmStopped(vm);
  if (action === "shutdown") return isVmRunning(vm);
  if (action === "forceReboot") return isVmRunning(vm);
  return isVmStopped(vm);
}

function providerLabel(value: ProviderType) {
  return providerDescriptorFor(value)?.label ?? getProviderBrand(value).resourceName;
}

function vmActionMeta(action: VmPowerAction) {
  if (action === "start") {
    return {
      label: "开机",
      confirmHeading: "开机虚拟机",
      confirmTone: "资源变更",
      confirmButtonText: "确认开机",
      customClass: "vm-start-message-box",
    };
  }
  if (action === "shutdown") {
    return {
      label: "关机",
      confirmHeading: "关机虚拟机",
      confirmTone: "业务中断",
      confirmButtonText: "确认关机",
      customClass: "vm-shutdown-message-box",
    };
  }
  if (action === "forceReboot") {
    return {
      label: "重启",
      confirmHeading: "强制重启虚拟机",
      confirmTone: "高风险变更",
      confirmButtonText: "确认强制重启",
      customClass: "vm-force-reboot-message-box",
    };
  }
  return {
    label: "删除",
    confirmHeading: "删除虚拟机",
    confirmTone: "危险操作",
    confirmButtonText: "确认删除",
    customClass: "vm-delete-message-box",
  };
}

function vmActionDescription(action: VmPowerAction, providerType: ProviderType) {
  if (action === "start") {
    return `影响范围：会占用目标物理机 CPU、内存和存储 IO 资源；${providerLabel(providerType)} 确认开机后会自动打开控制台窗口。`;
  }
  if (action === "shutdown") {
    return "影响范围：可能中断虚拟机内正在运行的业务；系统会按平台策略完成关机，完成前状态保持关机中。";
  }
  if (action === "forceReboot") {
    return "影响范围：会立即中断当前运行状态并强制重启，可能导致未保存数据丢失；完成前状态保持重启中。";
  }
  return "影响范围：会移除虚拟机配置和磁盘，通常不可恢复。请确认 VM 已关机、已完成备份，并且这台 VM 确实可以回收。";
}

function connectionDeleteConfirmSummary(item: StoredConnectionSummary | undefined) {
  return item ? `${item.name} / ${providerLabel(item.providerType)} · ${item.host}:${item.port}` : "当前连接";
}

function sanitizeFilename(value: string) {
  return value.trim().replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "") || "host";
}

function isIpv4(value: string | undefined) {
  if (!value) return false;
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

function defaultPortForProvider(value: ProviderType) {
  return providerBootstrapPorts[value];
}

function providerDescriptorFor(value: ProviderType) {
  return providerDescriptors.value.find((item) => item.type === value);
}

function normalizePort(value: unknown, providerType: ProviderType) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : defaultPortForProvider(providerType);
}
</script>

<template>
  <main class="app-shell" :class="{ 'electron-shell': isElectron, 'electron-mac-shell': isMacElectron, 'electron-windows-shell': isWindowsElectron }">
    <aside class="sidebar">
      <div v-if="isMacElectron" class="electron-titlebar-drag" aria-hidden="true"></div>
      <div class="sidebar-head">
        <div class="brand-lockup">
          <span class="brand-mark sidebar-logo" aria-hidden="true">
            <VrcLogoMark shadow />
          </span>
          <div class="brand-copy">
            <h1>资源控制台</h1>
            <p>{{ storedConnections.length }} 个连接</p>
          </div>
        </div>
        <button class="icon-button settings-entry-button" :class="{ active: isSettingsNavActive }" title="设置" aria-label="设置" @click="openSettingsWorkspace">
          <el-icon><Setting /></el-icon>
          <i v-if="hasPendingDesktopUpdate" class="settings-update-dot" aria-hidden="true"></i>
        </button>
      </div>

      <section class="sidebar-section">
        <el-input v-model="connectionSearch" class="sidebar-search" placeholder="输入名称、平台或地址" :prefix-icon="Search" clearable />
      </section>

      <div class="connection-groups">
        <section v-if="filteredStoredConnections.length" class="connection-group overview-group">
          <button class="overview-entry" :class="{ active: isOverviewNavActive }" @click="loadHostOverview()">
            <span class="overview-entry-icon" aria-hidden="true"><VrcToolbarIcon name="overview" /></span>
            <span class="overview-entry-main">
              <strong>资源总览</strong>
              <small>查看全部物理机</small>
            </span>
          </button>
        </section>
        <div class="connection-list-scroll">
          <section v-for="[groupName, groupItems] in groupedStoredConnections" :key="groupName" class="connection-group">
            <div class="group-title">
              <span>{{ groupName }}</span>
            </div>
            <button
              v-for="item in groupItems"
              :key="item.id"
              class="connection-item"
              :class="{ active: workspaceMode === 'connection' && selectedConnectionId === item.id }"
              @click="selectConnectionAndLoad(item.id)"
            >
              <span class="status-dot" :class="{ online: workspaceMode === 'connection' && selectedConnectionId === item.id && !!inventory }"></span>
              <span class="connection-main">
                <strong>{{ item.name }}</strong>
                <small>{{ item.host }}</small>
              </span>
              <span class="connection-port">{{ item.port }}</span>
            </button>
          </section>
          <div v-if="storedConnections.length && connectionSearch.trim() && !filteredStoredConnections.length" class="sidebar-search-empty" role="status">
            未找到匹配连接
          </div>
          <div v-if="!storedConnections.length" class="sidebar-empty vrc-muted-block">
            <strong>还没有连接</strong>
            <span>在右侧填写账号后保存，之后可直接加载资源清单。</span>
          </div>
        </div>
      </div>

      <section v-if="showActivityPanel" class="activity-panel">
        <div class="section-title">
          <strong>操作记录</strong>
          <span class="section-actions">
            <button class="text-action" @click="activityLogVisible = true">详情</button>
            <button class="text-action" @click="showActivityPanel = false">隐藏</button>
          </span>
        </div>
        <div class="activity-list">
          <button
            v-for="item in activityEntries"
            :key="item.id"
            type="button"
            class="activity-line"
            :class="`status-${item.status}`"
            :title="activityFullText(item)"
            @click="activityLogVisible = true"
          >
            <div class="activity-line-main">
              <time>{{ item.time }}</time>
              <strong>{{ item.title }}</strong>
            </div>
            <div class="activity-line-sub">
              <span v-if="item.target">{{ item.target }}</span>
              <span v-if="item.detail">{{ item.detail }}</span>
            </div>
          </button>
        </div>
      </section>
      <button v-else class="activity-toggle" title="查看操作记录" @click="showActivityPanel = true">
        <span class="activity-toggle-icon" aria-hidden="true">
          <el-icon><Tickets /></el-icon>
        </span>
        <span>操作记录</span>
        <strong>{{ activityEntries.length }}</strong>
      </button>
    </aside>

    <section
      class="workspace"
      :class="{
        'is-settings-mode': workspaceMode === 'settings',
        'has-custom-background': uiPreferences.backgroundMode !== 'default',
        'has-security-watermark': uiPreferences.consoleWatermarkEnabled && uiPreferences.consoleWatermarkScope === 'workspace',
      }"
      :style="workspaceAppearanceStyle"
    >
      <div
        v-if="uiPreferences.consoleWatermarkEnabled && uiPreferences.consoleWatermarkScope === 'workspace'"
        class="workspace-security-watermark"
        :style="{ '--workspace-watermark-opacity': String(uiPreferences.consoleWatermarkOpacity / 100) }"
        aria-hidden="true"
      >
        <span v-for="index in consoleWatermarkCopies" :key="index">{{ consoleWatermarkText }}</span>
      </div>

      <section v-if="workspaceMode === 'connection' && loadingHosts && !inventory && !hostOverviewRows.length && !loadingHostOverview" class="panel loading-panel">
        <div class="resource-loading-card" :class="`platform-${selectedConnectionBrand.type}`">
          <div class="resource-loader-mark compact" aria-hidden="true">
            <span class="resource-loader-ring"></span>
            <VrcLogoMark :grid="false" />
          </div>
          <div class="resource-loader-copy">
            <strong>正在读取物理机信息</strong>
            <span>{{ selectedStoredConnection?.name || selectedConnectionBrand.resourceName }} · {{ selectedStoredConnection?.host || connection.host }}</span>
          </div>
          <div class="resource-loader-progress" aria-hidden="true">
            <i></i>
            <i></i>
            <i></i>
          </div>
        </div>
      </section>

      <section v-else-if="workspaceMode === 'connection' && inventory && selectedHost && !hostOverviewRows.length && !loadingHostOverview" class="single-host-view">
        <HostVmPanel
          v-model:search="search"
          v-model:power-filter="vmPowerFilter"
          :connection="{ id: selectedConnectionId, providerType: connection.providerType, host: connection.host, port: connection.port, username: connection.username, password: persistentConnectionsEnabled ? undefined : connection.password }"
          :provider-descriptor="selectedProviderDescriptor"
          :host="selectedHost"
          :network-count="selectedHostNetworks.length"
          :resource-summary="resourceSummary"
          :resource-capacity="selectedResourceCapacity"
          :storage-pool-highlights="storagePoolHighlightItems"
          :storage-display-mode="uiPreferences.storageDisplayMode"
          :vm-totals="vmTotals"
          :has-vm-summary="!!vmSummary"
          :loading-vm-summary="loadingVmSummary"
          :vms="filteredVms"
          :vms-total="vmTableTotal"
          :selected-vm-ids="selectedVmIds"
          :vm-action-states="vmActionStates"
          :provisioning-console-vm-ids="activeProvisioningConsoleVmIds"
          :loading-vms="loadingVms"
          :show-icon-tooltips="uiPreferences.showIconTooltips"
          variant="page"
          table-height="100%"
          table-panel-class="single-table-panel"
          @search-change="loadVms"
          @refresh="refreshVmPanelResources"
          @export="exportCsv"
          @host-detail="hostDetailVisible = true"
          @storage-detail="storageDetailVisible = true"
          @iso-detail="openIsoDetail"
          @create-vm="openProvisioningDialog"
          @selection-change="handleVmSelectionChange"
          @open-console="handleOpenVmConsole"
          @vm-action="handleVmAction"
          @batch-vm-action="handleBatchVmAction"
          @schedule-vms="openVmScheduleCreate"
          @rename-vm="openVmRename"
          @resize-vm="openVmResize"
          @diagnose-vm="openHostDiagnostics"
        />
      </section>

      <section v-if="workspaceMode === 'overview' && (hostOverviewRows.length || loadingHostOverview)" class="panel overview-panel">
        <div class="overview-header">
          <div class="overview-title-group">
            <h3>物理机总览</h3>
            <span>先判断物理机 CPU、内存、存储余量，再按物理机下钻 VM。</span>
          </div>
        </div>

        <div class="overview-metric-strip" aria-label="总览压缩指标">
          <article v-for="item in hostOverviewMetricCards" :key="item.key" class="overview-metric-card" :class="item.className">
            <span>{{ item.label }}</span>
            <strong>{{ item.value }}</strong>
            <small>{{ item.detail }}</small>
          </article>
        </div>

        <div class="overview-table-toolbar table-toolbar">
          <div class="overview-table-heading">
            <h3>物理机资源列表</h3>
            <span class="overview-table-meta">
              {{ hostOverviewTotals.ready }} / {{ hostOverviewTotals.total }} 台 · VM {{ hostOverviewTotals.runningVms }} / {{ hostOverviewTotals.totalVms }}
              <template v-if="overviewSearchKeyword"> · 显示 {{ filteredHostOverviewRows.length }} 台</template>
              <template v-if="vmSearchStatusText"> · {{ vmSearchStatusText }}</template>
            </span>
          </div>
          <div class="overview-query-group" aria-label="总览筛选">
            <el-input
              v-model="hostOverviewSearch"
              class="overview-search-input"
              :prefix-icon="Search"
              placeholder="查物理机 IP / VM IP，支持批量"
              clearable
              @change="normalizeHostOverviewSearch"
              @blur="normalizeHostOverviewSearch"
            />
            <el-segmented
              v-model="hostOverviewMatchMode"
              class="match-mode-control"
              :options="[
                { label: '完全匹配', value: 'exact' },
                { label: '模糊匹配', value: 'fuzzy' },
              ]"
            />
          </div>
          <div class="overview-action-group" aria-label="总览列表动作">
            <el-tooltip v-if="HOST_DIAGNOSTICS_ENABLED" content="问题诊断：勾选一台物理机后执行只读健康诊断" placement="top" :disabled="!uiPreferences.showIconTooltips">
              <span class="toolbar-tooltip-target">
                <button
                  type="button"
                  class="overview-toolbar-button"
                  :disabled="!sortedHostOverviewRows.some(hasOverviewInventory)"
                  aria-label="问题诊断"
                  @click="openHostOverviewDiagnosticsToolbar"
                >
                  <VrcToolbarIcon name="diagnose" />
                </button>
              </span>
            </el-tooltip>
            <el-tooltip content="查看快照：勾选一台物理机后查看其下全部虚拟机的快照" placement="top" :disabled="!uiPreferences.showIconTooltips">
              <span class="toolbar-tooltip-target">
                <button
                  type="button"
                  class="overview-toolbar-button"
                  :disabled="!sortedHostOverviewRows.some(hasOverviewInventory)"
                  aria-label="查看快照"
                  @click="openHostOverviewSnapshotsToolbar"
                >
                  <VrcToolbarIcon name="snapshot" />
                </button>
              </span>
            </el-tooltip>
            <el-tooltip content="定时任务：跨物理机搜索并选择虚拟机" placement="top" :disabled="!uiPreferences.showIconTooltips">
              <span class="toolbar-tooltip-target">
                <button
                  type="button"
                  class="overview-toolbar-button"
                  aria-label="虚拟机定时任务"
                  @click="openGlobalVmSchedule"
                >
                  <VrcToolbarIcon name="schedule" />
                </button>
              </span>
            </el-tooltip>
            <el-tooltip content="导出物理机总览：Excel 含物理机和虚拟机信息" placement="top" :disabled="!uiPreferences.showIconTooltips">
              <span class="toolbar-tooltip-target">
                <button
                  type="button"
                  class="overview-toolbar-button"
                  :disabled="!sortedHostOverviewRows.length"
                  aria-label="导出物理机总览"
                  @click="exportHostOverviewWorkbook"
                >
                  <VrcToolbarIcon name="export" />
                </button>
              </span>
            </el-tooltip>
            <el-tooltip content="刷新总览：重新读取全部保存连接的物理机资源" placement="top" :disabled="!uiPreferences.showIconTooltips">
              <span class="toolbar-tooltip-target">
                <button
                  type="button"
                  class="overview-toolbar-button"
                  :disabled="loadingHostOverview"
                  aria-label="刷新总览"
                  @click="loadHostOverview({ forceRefresh: true })"
                >
                  <VrcToolbarIcon name="refresh" />
                </button>
              </span>
            </el-tooltip>
          </div>
        </div>

        <el-table
          class="resource-sort-table overview-resource-table"
          :data="sortedHostOverviewRows"
          height="100%"
          row-key="key"
          stripe
          empty-text=" "
          :default-sort="{ prop: 'hostName', order: 'ascending' }"
          :row-class-name="overviewRowClassName"
          @sort-change="handleHostOverviewSort"
          @selection-change="handleOverviewSelectionChange"
          @row-click="handleOverviewRowClick"
        >
          <template #empty>
            <div class="overview-empty-state">
              <div v-if="overviewEmptyState.mode === 'loading'" class="resource-loading-card resource-table-loading overview-empty-loading">
                <div class="resource-loader-mark compact" aria-hidden="true">
                  <span class="resource-loader-ring"></span>
                  <VrcLogoMark :grid="false" />
                </div>
                <div class="resource-loader-copy">
                  <strong>{{ overviewEmptyState.title }}</strong>
                  <span>{{ overviewEmptyState.detail }}</span>
                </div>
                <div class="resource-loader-progress" aria-hidden="true">
                  <i></i>
                  <i></i>
                  <i></i>
                </div>
              </div>
              <div v-else class="overview-empty-card">
                <div class="overview-empty-mark" aria-hidden="true">
                  <VrcLogoMark shadow />
                </div>
                <strong>{{ overviewEmptyState.title }}</strong>
                <small>{{ overviewEmptyState.detail }}</small>
              </div>
            </div>
          </template>
          <el-table-column type="selection" width="46" align="center" header-align="center" reserve-selection :selectable="overviewRowSelectable" />
          <el-table-column type="index" label="序号" width="58" align="center" header-align="center" />
          <el-table-column prop="hostName" label="物理机" min-width="160" align="left" sortable="custom" show-overflow-tooltip>
            <template #default="{ row }">
              <span class="overview-host-cell">
                <button class="table-link drilldown-link" title="查看该物理机下的虚拟机" @click.stop="openHostOverview(row)">{{ row.host.name }}</button>
                <small>{{ row.host.address }}</small>
              </span>
              <small v-if="vmSearchMatchSummary(row)" class="vm-match-summary">{{ vmSearchMatchSummary(row) }}</small>
            </template>
          </el-table-column>
          <el-table-column label="平台" min-width="84" align="center">
            <template #default="{ row }">{{ providerLabel(row.connection.providerType) }}</template>
          </el-table-column>
          <el-table-column label="状态" min-width="64" align="center">
            <template #default="{ row }">
              <span class="state-text" :class="overviewStatusClass(row)">
                <el-icon v-if="overviewRowLoading(row)" class="inline-loading"><Loading /></el-icon>
                {{ overviewStatusLabel(row) }}
              </span>
            </template>
          </el-table-column>
          <el-table-column prop="cpuUsage" label="CPU 运行情况" min-width="140" align="right" sortable="custom">
            <template #default="{ row }">
              <span class="overview-resource-cell" :class="{ warning: overviewResourceMeterWarning(row, 'cpu') }">
                <strong>{{ overviewCpuMain(row) }}</strong>
                <span class="overview-resource-meter" aria-hidden="true">
                  <i :style="{ width: `${overviewResourceMeterPercent(row, 'cpu')}%` }"></i>
                </span>
                <small>{{ overviewCpuSubline(row) }}</small>
              </span>
            </template>
          </el-table-column>
          <el-table-column prop="memoryFree" label="内存余量" min-width="140" align="right" sortable="custom">
            <template #default="{ row }">
              <span class="overview-resource-cell" :class="{ warning: overviewResourceMeterWarning(row, 'memory') }">
                <strong>{{ overviewMemoryMain(row) }}</strong>
                <span class="overview-resource-meter" aria-hidden="true">
                  <i :style="{ width: `${overviewResourceMeterPercent(row, 'memory')}%` }"></i>
                </span>
                <small>{{ overviewMemorySubline(row) }}</small>
              </span>
            </template>
          </el-table-column>
          <el-table-column prop="storageFree" label="存储余量" min-width="240" align="right" sortable="custom">
            <template #default="{ row }">
              <span class="overview-resource-cell" :class="overviewStorageCellClass(row)">
                <span class="overview-storage-main">
                  <strong>{{ overviewStorageMain(row) }}</strong>
                  <em v-if="overviewStoragePercent(row) != null" class="overview-storage-pct" :class="`is-${overviewStorageHealth(row)}`">{{ overviewStoragePercent(row) }}%</em>
                </span>
                <span class="overview-resource-meter" aria-hidden="true">
                  <i :style="{ width: `${overviewResourceMeterPercent(row, 'storage')}%` }"></i>
                </span>
                <small>{{ overviewStorageSubline(row) }}</small>
              </span>
            </template>
          </el-table-column>
          <el-table-column prop="vmTotal" label="VM" width="78" align="center" sortable="custom">
            <template #default="{ row }">
              <span v-if="row.summary">{{ row.summary.running }} / {{ row.summary.total }}</span>
              <span v-else-if="hasOverviewInventory(row)" class="state-text state-loading">
                <el-icon class="inline-loading"><Loading /></el-icon>
                加载中
              </span>
              <span v-else>-</span>
            </template>
          </el-table-column>
          <el-table-column label="创建评估" min-width="170" align="left" show-overflow-tooltip>
            <template #default="{ row }">
              <span class="recommend-label" :class="hostRecommendation(row).className">{{ hostRecommendation(row).label }}</span>
              <small class="disk-subtitle">{{ hostRecommendation(row).reason }}</small>
            </template>
          </el-table-column>
        </el-table>
      </section>

      <section v-if="workspaceMode === 'settings'" class="panel settings-workspace-panel">
        <div class="settings-workspace-head">
          <div>
            <h3>{{ settingsTitle }}</h3>
            <span>{{ settingsDescription }}</span>
          </div>
          <button type="button" class="settings-close-button" @click="closeSettingsWorkspace">
            <el-icon><ArrowLeft /></el-icon>
            <span>{{ settingsBackLabel }}</span>
          </button>
        </div>

        <div class="settings-workspace-layout">
          <aside class="settings-workspace-nav" aria-label="设置分组">
            <button type="button" :class="{ active: settingsPanel === 'appearance' }" @click="settingsPanel = 'appearance'">
              <el-icon><Brush /></el-icon>
              <span>外观</span>
            </button>
            <button type="button" :class="{ active: settingsPanel === 'connection' }" @click="settingsPanel = 'connection'">
              <el-icon><Connection /></el-icon>
              <span>连接</span>
            </button>
            <button type="button" :class="{ active: settingsPanel === 'templates' }" @click="settingsPanel = 'templates'">
              <el-icon><Plus /></el-icon>
              <span>创建模板</span>
            </button>
            <button type="button" :class="{ active: settingsPanel === 'ipPools' }" @click="settingsPanel = 'ipPools'">
              <el-icon><Connection /></el-icon>
              <span>IP 池</span>
            </button>
            <button type="button" :class="{ active: settingsPanel === 'chromeExtension' }" @click="settingsPanel = 'chromeExtension'">
              <el-icon><Setting /></el-icon>
              <span>Chrome 插件</span>
            </button>
            <button type="button" :class="{ active: settingsPanel === 'updates' }" @click="settingsPanel = 'updates'">
              <el-icon><Download /></el-icon>
              <span>更新</span>
              <i v-if="hasPendingDesktopUpdate" class="settings-update-dot nav-dot" aria-hidden="true"></i>
            </button>
            <button type="button" :class="{ active: settingsPanel === 'maintenance' }" @click="settingsPanel = 'maintenance'">
              <el-icon><Setting /></el-icon>
              <span>维护</span>
            </button>
            <button type="button" :class="{ active: settingsPanel === 'logs' }" @click="settingsPanel = 'logs'">
              <el-icon><Tickets /></el-icon>
              <span>日志</span>
            </button>
          </aside>

          <section v-if="settingsPanel === 'appearance'" class="settings-workspace-content">
            <section class="settings-card appearance-theme-card">
              <div class="settings-card-head">
                <div>
                  <strong>框架主题</strong>
                  <span>精选 3 款推荐主题，全局应用；更多风格用下方自定义主题和背景自由搭配。</span>
                </div>
              </div>
              <div class="appearance-theme-layout">
                <div class="settings-theme-card-grid appearance-theme-card-grid">
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
                    <span class="theme-swatch" aria-hidden="true">
                      <i v-for="color in theme.colors" :key="color" :style="{ background: color }"></i>
                    </span>
                    <span>{{ theme.description }}</span>
                  </button>
                </div>

                <aside class="appearance-theme-summary vrc-muted-block" aria-label="当前外观摘要">
                  <div class="appearance-theme-summary-head">
                    <span>当前方案</span>
                    <strong>{{ currentAppearanceTheme.name }}</strong>
                    <small>{{ currentAppearanceTheme.description }}</small>
                  </div>
                  <div class="appearance-theme-summary-swatches" aria-hidden="true">
                    <i v-for="color in currentAppearanceTheme.colors" :key="color" :style="{ background: color }"></i>
                  </div>
                  <dl class="appearance-theme-summary-meta">
                    <div>
                      <dt>明暗模式</dt>
                      <dd>{{ appearanceToneText }}</dd>
                    </div>
                    <div>
                      <dt>工作区背景</dt>
                      <dd>{{ appearanceBackgroundText }}</dd>
                    </div>
                    <div>
                      <dt>强调色</dt>
                      <dd>{{ uiPreferences.accentColor }}</dd>
                    </div>
                  </dl>
                </aside>
              </div>
            </section>

            <section class="settings-card appearance-custom-settings">
              <div class="settings-card-head appearance-custom-head">
                <div>
                  <strong>自定义主题</strong>
                  <span>在基础主题上覆盖语义色和工作区背景，未修改的组件继续使用系统样式变量。</span>
                </div>
                <div class="appearance-head-actions">
                  <el-button size="small" @click="selectAppearanceJson">载入</el-button>
                  <el-button size="small" @click="exportAppearanceConfig">导出</el-button>
                  <el-button size="small" @click="resetAppearancePreferences">重置</el-button>
                </div>
              </div>

              <div class="appearance-custom-grid">
                <section class="appearance-setting-group">
                  <div class="appearance-group-title">
                    <strong>颜色</strong>
                    <span>基于语义变量覆盖，不逐个组件写死颜色。</span>
                  </div>
                  <div class="appearance-setting-row">
                    <div><strong>界面明暗</strong><span>浅色、深色或跟随系统。</span></div>
                    <el-segmented
                      v-model="uiPreferences.toneMode"
                      class="appearance-tone-segmented"
                      :options="[{ label: '跟随系统', value: 'system' }, { label: '浅色', value: 'light' }, { label: '深色', value: 'dark' }]"
                      size="small"
                      @change="persistAppearancePreference('toneMode')"
                    />
                  </div>
                  <div class="appearance-setting-row">
                    <div><strong>强调色</strong><span>按钮、选中态、链接和图表主色。</span></div>
                    <div class="appearance-color-control">
                      <button
                        v-for="color in accentColorPresets"
                        :key="color"
                        class="appearance-color-chip"
                        :class="{ active: uiPreferences.accentColor === color }"
                        type="button"
                        :style="{ '--appearance-chip-color': color }"
                        :aria-label="`使用强调色 ${color}`"
                        @click="setAppearanceAccentColor(color)"
                      ></button>
                      <el-color-picker
                        v-model="uiPreferences.accentColor"
                        size="small"
                        @change="updateAppearanceColor('accentColor', $event)"
                      />
                    </div>
                  </div>
                  <div class="appearance-setting-row">
                    <div><strong>状态色</strong><span>成功、警告、危险保持独立语义。</span></div>
                    <div class="appearance-semantic-colors">
                      <label><span>成功</span><el-color-picker v-model="uiPreferences.successColor" size="small" @change="updateAppearanceColor('successColor', $event)" /></label>
                      <label><span>警告</span><el-color-picker v-model="uiPreferences.warningColor" size="small" @change="updateAppearanceColor('warningColor', $event)" /></label>
                      <label><span>危险</span><el-color-picker v-model="uiPreferences.dangerColor" size="small" @change="updateAppearanceColor('dangerColor', $event)" /></label>
                    </div>
                  </div>
                </section>

                <section class="appearance-setting-group appearance-background-group">
                  <div class="appearance-group-title">
                    <strong>工作区背景</strong>
                    <span>背景只作用于内容画布，不覆盖侧栏和组件 surface。</span>
                  </div>
                  <div class="appearance-setting-row">
                    <div><strong>背景类型</strong><span>默认、纯色或本地图片。</span></div>
                    <el-segmented
                      v-model="uiPreferences.backgroundMode"
                      class="appearance-background-segmented"
                      :options="[{ label: '默认', value: 'default' }, { label: '纯色', value: 'solid' }, { label: '图片', value: 'image' }]"
                      size="small"
                      @change="persistAppearancePreference('backgroundMode')"
                    />
                  </div>
                  <div v-if="uiPreferences.backgroundMode === 'solid'" class="appearance-setting-row">
                    <div><strong>背景颜色</strong><span>{{ uiPreferences.backgroundColor }}</span></div>
                    <el-color-picker
                      v-model="uiPreferences.backgroundColor"
                      size="small"
                      @change="updateAppearanceColor('backgroundColor', $event)"
                    />
                  </div>
                  <div v-if="uiPreferences.backgroundMode === 'image'" class="appearance-setting-row">
                    <div><strong>背景图片</strong><span>支持 JPG、PNG 和 WebP，最大 16MB。</span></div>
                    <div class="appearance-image-control">
                      <span
                        class="appearance-image-preview"
                        :class="{ empty: !appearanceBackgroundImageUrl }"
                        :style="appearanceBackgroundPreviewStyle"
                        aria-hidden="true"
                      ></span>
                      <span class="appearance-image-name" :title="uiPreferences.backgroundImageName || '未选择图片'">
                        {{ uiPreferences.backgroundImageName || "未选择图片" }}
                      </span>
                      <el-button size="small" :icon="Picture" :loading="appearanceImageUploading" @click="selectAppearanceImage">
                        {{ uiPreferences.backgroundImageUpdatedAt ? "更换图片" : "选择图片" }}
                      </el-button>
                    </div>
                  </div>
                  <div v-if="uiPreferences.backgroundMode === 'image'" class="appearance-slider-row">
                    <span>透明度</span>
                    <el-slider v-model="uiPreferences.backgroundOpacity" :min="5" :max="60" :show-tooltip="false" @change="persistAppearanceNumber('backgroundOpacity')" />
                    <strong>{{ uiPreferences.backgroundOpacity }}%</strong>
                  </div>
                  <div v-if="uiPreferences.backgroundMode === 'image'" class="appearance-slider-row">
                    <span>模糊</span>
                    <el-slider v-model="uiPreferences.backgroundBlur" :min="0" :max="16" :show-tooltip="false" @change="persistAppearanceNumber('backgroundBlur')" />
                    <strong>{{ uiPreferences.backgroundBlur }}px</strong>
                  </div>
                  <div v-if="uiPreferences.backgroundMode !== 'default'" class="appearance-slider-row">
                    <span>遮罩</span>
                    <el-slider v-model="uiPreferences.backgroundOverlay" :min="0" :max="35" :show-tooltip="false" @change="persistAppearanceNumber('backgroundOverlay')" />
                    <strong>{{ uiPreferences.backgroundOverlay }}%</strong>
                  </div>
                </section>
              </div>
            </section>

            <section class="settings-card appearance-reading-card">
              <div class="settings-card-head">
                <div>
                  <strong>文字与阅读</strong>
                  <span>统一界面文字层级，并保留适合高密度资源列表的稳定布局。</span>
                </div>
              </div>
              <div class="appearance-reading-grid">
                <div class="appearance-reading-controls">
                  <div class="appearance-setting-row">
                    <div><strong>界面字体</strong><span>「内置」随应用打包、跨设备效果一致；「本机」依赖系统安装。</span></div>
                    <el-select
                      v-model="uiPreferences.uiFontPreset"
                      class="appearance-control-medium"
                      aria-label="界面字体"
                      @change="persistAppearancePreference('uiFontPreset')"
                    >
                      <el-option v-for="font in uiFontOptions" :key="font.value" :label="font.label" :value="font.value">
                        <span class="appearance-font-option">
                          <span class="appearance-font-option-name" :style="{ fontFamily: font.family }">{{ font.label }}</span>
                          <span class="appearance-font-option-tag" :class="{ bundled: font.badge === '内置' }">{{ font.badge }}</span>
                        </span>
                      </el-option>
                    </el-select>
                  </div>
                  <div class="appearance-setting-row">
                    <div><strong>文字大小</strong><span>只调整界面正文，表格与按钮尺寸保持规范。</span></div>
                    <el-segmented
                      v-model="uiPreferences.uiFontSize"
                      class="appearance-size-segmented"
                      :options="[{ label: '11', value: 11 }, { label: '12', value: 12 }, { label: '13', value: 13 }]"
                      size="small"
                      @change="updateUiPreference('uiFontSize', Number($event))"
                    />
                  </div>
                  <div class="appearance-setting-row">
                    <div><strong>减少动效</strong><span>降低弹窗、loading 和页面切换动画。</span></div>
                    <el-switch
                      :model-value="uiPreferences.reduceMotion"
                      aria-label="减少界面动效"
                      @change="updateUiPreference('reduceMotion', Boolean($event))"
                    />
                  </div>
                </div>
                <div class="appearance-reading-sample vrc-muted-block" :style="{ fontFamily: currentUiFont.family, fontSize: `${uiPreferences.uiFontSize}px` }">
                  <span>资源列表预览</span>
                  <strong>pve-production-01</strong>
                  <small>CPU 24% · 内存 18.6 / 32 GiB · 运行中</small>
                </div>
              </div>
            </section>

            <section class="settings-card appearance-resource-settings">
              <div class="settings-card-head">
                <div>
                  <strong>资源展示</strong>
                  <span>统一存储卡片、物理机总览与创建虚拟机时的存储统计展示方式。</span>
                </div>
              </div>
              <div class="appearance-setting-row">
                <div><strong>存储卡片</strong><span>「HBA + LVM」按磁盘类型分别统计剩余容量；「总体」合并展示可分配存储池。</span></div>
                <el-segmented
                  v-model="uiPreferences.storageDisplayMode"
                  class="appearance-storage-segmented"
                  :options="[{ label: 'HBA + LVM', value: 'hba-lvm' }, { label: '总体', value: 'overall' }]"
                  size="small"
                  @change="persistAppearancePreference('storageDisplayMode')"
                />
              </div>
            </section>

            <section class="settings-card appearance-console-settings">
              <div class="settings-card-head appearance-console-head">
                <div>
                  <strong>控制台外观</strong>
                  <span>打开控制台时由目标策略选择 noVNC 或 xterm；这里预览并配置两类画面。</span>
                </div>
                <div class="appearance-console-head-actions">
                  <el-segmented
                    v-model="appearanceConsolePreviewMode"
                    :options="[{ label: '图形控制台', value: 'graphical' }, { label: 'Linux CLI', value: 'cli' }]"
                    size="small"
                    aria-label="控制台预览对象"
                  />
                  <span class="appearance-preview-tag">{{ appearanceConsolePreviewMode === "cli" ? "xterm" : "noVNC / WebMKS" }}</span>
                </div>
              </div>

              <div v-if="appearanceConsolePreviewMode === 'cli'" class="appearance-console-layout" :style="appearanceConsolePreviewStyle">
                <div class="appearance-console-controls">
                  <section class="appearance-setting-group">
                    <div class="appearance-group-title"><strong>终端文字</strong><span>xterm.js · SSH / 串口通道</span></div>
                    <div class="appearance-setting-row">
                      <div><strong>字体</strong><span>使用系统或本机字体，不额外打包字体文件。</span></div>
                      <el-select
                        v-model="uiPreferences.consoleFontPreset"
                        class="appearance-control-medium"
                        aria-label="控制台字体"
                        @change="persistAppearancePreference('consoleFontPreset')"
                      >
                        <el-option v-for="font in consoleFontOptions" :key="font.value" :label="font.label" :value="font.value" />
                      </el-select>
                    </div>
                    <div class="appearance-setting-row">
                      <div><strong>字号与行高</strong><span>{{ uiPreferences.consoleFontSize }}px / {{ uiPreferences.consoleLineHeight.toFixed(1) }}</span></div>
                      <div class="appearance-number-pair">
                        <el-input-number v-model="uiPreferences.consoleFontSize" :min="11" :max="18" controls-position="right" aria-label="控制台字号" @change="persistAppearanceNumber('consoleFontSize')" />
                        <el-input-number v-model="uiPreferences.consoleLineHeight" :min="1.05" :max="1.6" :step="0.05" :precision="2" controls-position="right" aria-label="控制台行高" @change="persistAppearancePreference('consoleLineHeight')" />
                      </div>
                    </div>
                    <div class="appearance-setting-row">
                      <div><strong>光标</strong><span>{{ uiPreferences.consoleCursorBlink ? "闪烁" : "常亮" }}</span></div>
                      <div class="appearance-console-cursor-control">
                        <el-segmented
                          v-model="uiPreferences.consoleCursorStyle"
                          class="appearance-console-cursor-segmented"
                          :options="[{ label: '块', value: 'block' }, { label: '线', value: 'bar' }, { label: '下划线', value: 'underline' }]"
                          size="small"
                          @change="persistAppearancePreference('consoleCursorStyle')"
                        />
                        <el-switch :model-value="uiPreferences.consoleCursorBlink" aria-label="控制台光标闪烁" @change="updateUiPreference('consoleCursorBlink', Boolean($event))" />
                      </div>
                    </div>
                    <div class="appearance-palette-field">
                      <div class="appearance-palette-field-head">
                        <div><strong>终端配色</strong><span>配色只作用于 xterm，终端背景保持纯色。</span></div>
                      </div>
                      <div class="appearance-console-palettes" role="group" aria-label="控制台配色">
                        <button
                          v-for="theme in consoleThemeOptions"
                          :key="theme.value"
                          type="button"
                          :class="{ active: uiPreferences.consoleTheme === theme.value }"
                          :aria-label="`使用 ${theme.label} 控制台配色`"
                          :aria-pressed="uiPreferences.consoleTheme === theme.value"
                          @click="updateUiPreference('consoleTheme', theme.value)"
                        >
                          <span class="appearance-palette-gradient" :style="{ background: `linear-gradient(115deg, ${theme.swatches.join(', ')})` }"></span>
                          <span class="appearance-palette-name"><strong>{{ theme.label }}</strong><small>{{ theme.source }}</small></span>
                        </button>
                      </div>
                    </div>
                  </section>

                  <section class="appearance-setting-group appearance-watermark-group">
                    <div class="appearance-group-title"><strong>安全水印</strong><span>{{ uiPreferences.consoleWatermarkEnabled ? "已启用" : "未启用" }}</span></div>
                    <div class="appearance-setting-row">
                      <div><strong>显示水印</strong><span>操作用户、来源地址与时间。</span></div>
                      <el-switch :model-value="uiPreferences.consoleWatermarkEnabled" aria-label="显示安全水印" @change="updateUiPreference('consoleWatermarkEnabled', Boolean($event))" />
                    </div>
                    <div v-if="uiPreferences.consoleWatermarkEnabled" class="appearance-setting-row">
                      <div><strong>作用范围</strong><span>控制台或整个工作区。</span></div>
                      <el-segmented
                        v-model="uiPreferences.consoleWatermarkScope"
                        :options="[{ label: '控制台', value: 'console' }, { label: '工作区', value: 'workspace' }]"
                        size="small"
                        @change="persistAppearancePreference('consoleWatermarkScope')"
                      />
                    </div>
                    <div v-if="uiPreferences.consoleWatermarkEnabled" class="appearance-setting-row">
                      <div><strong>密度</strong><span>避免遮挡关键内容。</span></div>
                      <el-segmented
                        v-model="uiPreferences.consoleWatermarkDensity"
                        class="appearance-watermark-density-segmented"
                        :options="[{ label: '疏', value: 'sparse' }, { label: '标准', value: 'standard' }, { label: '密', value: 'dense' }]"
                        size="small"
                        @change="persistAppearancePreference('consoleWatermarkDensity')"
                      />
                    </div>
                    <div v-if="uiPreferences.consoleWatermarkEnabled" class="appearance-watermark-slider">
                      <span>透明度</span>
                      <el-slider v-model="uiPreferences.consoleWatermarkOpacity" :min="6" :max="24" :show-tooltip="false" @change="persistAppearanceNumber('consoleWatermarkOpacity')" />
                      <strong>{{ uiPreferences.consoleWatermarkOpacity }}%</strong>
                    </div>
                  </section>
                </div>

                <div class="appearance-console-preview" aria-label="Linux CLI 样式预览">
                  <div class="appearance-console-preview-toolbar"><span>centos-stream-9</span><small>xterm · 策略命中后使用</small></div>
                  <div class="appearance-terminal-content">
                    <span class="muted">Last login: Tue Jul 22 01:16:42 from 192.168.2.18</span>
                    <span><em>[root@vrc-node ~]#</em> systemctl status qemu-guest-agent</span>
                    <span class="success">● qemu-guest-agent.service - QEMU Guest Agent</span>
                    <span class="muted">&nbsp;&nbsp;&nbsp;Active: active (running) since Tue 2026-07-22 00:42:08 CST</span>
                    <span><em>[root@vrc-node ~]#</em> <i class="appearance-terminal-cursor" :class="[uiPreferences.consoleCursorStyle, { blink: uiPreferences.consoleCursorBlink }]">&nbsp;</i></span>
                  </div>
                  <div v-if="uiPreferences.consoleWatermarkEnabled" class="appearance-watermark-layer" aria-hidden="true">
                    <span v-for="index in consoleWatermarkCopies" :key="index">{{ consoleWatermarkText }}</span>
                  </div>
                  <div class="appearance-console-status"><span>{{ uiPreferences.consoleWatermarkScope === "console" ? "终端水印" : "工作区水印" }}</span><span>{{ uiPreferences.consoleFontSize }}px · {{ currentConsoleTheme.label }}</span></div>
                </div>
              </div>

              <div v-else class="appearance-console-layout appearance-graphical-layout" :style="appearanceConsolePreviewStyle">
                <div class="appearance-console-controls">
                  <section class="appearance-setting-group">
                    <div class="appearance-group-title"><strong>图形画面</strong><span>noVNC / WebMKS / PVE VNC</span></div>
                    <div class="appearance-setting-row">
                      <div><strong>缩放方式</strong><span>保持远端画面比例，不裁切桌面边缘。</span></div>
                      <el-segmented
                        v-model="uiPreferences.consoleScaleMode"
                        :options="[{ label: '本地缩放', value: 'local' }, { label: '远端调整', value: 'remote' }]"
                        size="small"
                        @change="persistAppearancePreference('consoleScaleMode')"
                      />
                    </div>
                    <div class="appearance-setting-row">
                      <div><strong>画面质量</strong><span>仅调整图像传输，不改变 Guest 分辨率。</span></div>
                      <el-select v-model="uiPreferences.consoleQuality" class="appearance-control-medium" aria-label="图形控制台画面质量" @change="persistAppearancePreference('consoleQuality')">
                        <el-option label="自动" value="auto" />
                        <el-option label="清晰" value="high" />
                        <el-option label="流畅" value="smooth" />
                      </el-select>
                    </div>
                    <div class="appearance-setting-row">
                      <div><strong>显示水印</strong><span>与 CLI 共用用户、来源地址与时间规则。</span></div>
                      <el-switch :model-value="uiPreferences.consoleWatermarkEnabled" aria-label="图形控制台显示安全水印" @change="updateUiPreference('consoleWatermarkEnabled', Boolean($event))" />
                    </div>
                    <div class="appearance-setting-row">
                      <div><strong>拖拽中节流刷新</strong><span>调整控制台窗口大小时减少频繁重绘。</span></div>
                      <el-switch :model-value="uiPreferences.throttleConsoleResize" aria-label="控制台拖拽中节流刷新" @change="updateUiPreference('throttleConsoleResize', Boolean($event))" />
                    </div>
                  </section>
                  <p class="appearance-console-note">字体、字号、ANSI 颜色和光标只作用于 xterm；noVNC 保留远端原始画面。</p>
                </div>
                <div class="appearance-graphical-preview">
                  <div class="appearance-console-preview-toolbar"><span>centos-stream-9</span><small>noVNC · 已连接</small></div>
                  <div class="appearance-graphical-screen">
                    <div class="appearance-login-mark">CentOS Stream 9</div>
                    <div class="appearance-login-copy"><span>vrc-node login:</span><i></i></div>
                  </div>
                  <div v-if="uiPreferences.consoleWatermarkEnabled" class="appearance-watermark-layer" aria-hidden="true">
                    <span v-for="index in consoleWatermarkCopies" :key="index">{{ consoleWatermarkText }}</span>
                  </div>
                  <div class="appearance-console-status"><span>{{ uiPreferences.consoleScaleMode === "local" ? "本地缩放" : "远端调整" }}</span><span>{{ uiPreferences.consoleQuality === "auto" ? "自动质量" : uiPreferences.consoleQuality === "high" ? "清晰" : "流畅" }}</span></div>
                </div>
              </div>
            </section>

            <section class="settings-tile-grid" aria-label="交互偏好">
              <article class="settings-tile">
                <div class="settings-row">
                  <strong>操作提示</strong>
                  <span>工具栏与行内按钮</span>
                </div>
                <div class="settings-row">
                  <span>图标按钮显示 tooltip</span>
                  <el-switch
                    :model-value="uiPreferences.showIconTooltips"
                    size="small"
                    aria-label="图标按钮显示提示"
                    @change="updateUiPreference('showIconTooltips', Boolean($event))"
                  />
                </div>
              </article>
              <article class="settings-tile">
                <div class="settings-row">
                  <strong>资源列表</strong>
                  <span>44-48px 行高</span>
                </div>
                <div class="settings-row">
                  <span>长名称单行省略</span>
                  <el-switch
                    :model-value="uiPreferences.truncateLongNames"
                    size="small"
                    aria-label="长名称单行省略"
                    @change="updateUiPreference('truncateLongNames', Boolean($event))"
                  />
                </div>
              </article>
              <article class="settings-tile">
                <div class="settings-row">
                  <strong>控制台缩放</strong>
                  <span>减少画面抖动</span>
                </div>
                <div class="settings-row">
                  <span>拖拽中节流刷新</span>
                  <el-switch
                    :model-value="uiPreferences.throttleConsoleResize"
                    size="small"
                    aria-label="控制台拖拽中节流刷新"
                    @change="updateUiPreference('throttleConsoleResize', Boolean($event))"
                  />
                </div>
              </article>
            </section>
          </section>

          <section v-else-if="settingsPanel === 'connection'" class="settings-workspace-content settings-workspace-content--single settings-workspace-content--connection">
            <section class="settings-card connection-settings-card">
              <div class="settings-card-head settings-section-head connection-settings-head">
                <div>
                  <strong>连接设置</strong>
                  <span>{{ persistentConnectionsEnabled ? "保存后可在左侧连接列表中选择并读取物理机资源。" : "保存到当前浏览器本地，不写入共享 Web 服务器。" }}</span>
                </div>
                <span>{{ persistentConnectionsEnabled ? "保存 / 测试 / 删除 / 加载资源" : "本地保存 / 测试 / 加载资源" }}</span>
              </div>
              <div class="settings-form-grid connection-settings-form">
                <label class="settings-field">
                  <span>连接名</span>
                  <el-input v-model="connectionName" placeholder="例如 xenserver-3" autocomplete="off" />
                </label>
                <label class="settings-field">
                  <span>平台</span>
                  <el-select v-model="connection.providerType">
                    <el-option label="XenServer" value="xenserver" />
                    <el-option label="VMware" value="vmware" />
                    <el-option label="Proxmox VE" value="proxmox" />
                    <el-option label="KVM/libvirt" value="libvirt" />
                  </el-select>
                </label>
                <label class="settings-field is-wide">
                  <span>管理地址</span>
                  <el-input v-model="connection.host" placeholder="IP / Host" autocomplete="off" />
                </label>
                <label class="settings-field">
                  <span>端口</span>
                  <el-input-number v-model="connection.port" :min="1" :max="65535" controls-position="right" />
                </label>
                <label class="settings-field">
                  <span>账号</span>
                  <el-input v-model="connection.username" placeholder="User" autocomplete="off" />
                </label>
                <label class="settings-field is-wide">
                  <span>密码</span>
                  <el-input
                    v-model="connection.password"
                    placeholder="Password"
                    type="password"
                    show-password
                    autocomplete="new-password"
                    name="vrc-platform-password"
                  />
                </label>
              </div>
              <div class="settings-actions connection-settings-actions">
                <div class="connection-settings-summary">
                  <strong>已保存连接</strong>
                  <span>{{ storedConnections.length }} 条</span>
                </div>
                <div class="connection-settings-command-group">
                  <el-button @click="startNewConnection">新连接</el-button>
                  <el-button :loading="testing" @click="testConnection">{{ testing ? "测试中" : "测试" }}</el-button>
                  <el-button @click="openAccountImportDialog">导入账号</el-button>
                  <el-tooltip :content="persistentConnectionsEnabled ? '加载资源：使用已保存账号读取物理机、存储、网络和 VM 清单' : '加载资源：使用当前表单账号读取物理机、存储、网络和 VM 清单，不在服务器保存账号密码'" placement="top" :disabled="!uiPreferences.showIconTooltips">
                    <el-button :loading="loadingHosts" :disabled="!selectedConnectionId && !canLoadDirectConnection" @click="loadSelectedConnectionResources">
                      {{ loadingHosts ? "加载中" : "加载资源" }}
                    </el-button>
                  </el-tooltip>
                  <el-button :disabled="!selectedConnectionId" @click="deleteConnection">删除</el-button>
                  <el-button type="primary" :loading="savingConnection" :disabled="!connection.password" @click="saveConnection">
                    {{ savingConnection ? "保存中" : "保存" }}
                  </el-button>
                </div>
              </div>
              <div
                v-if="connectionFeedbackMessage"
                class="settings-action-feedback"
                :class="connectionFeedbackStatus"
                aria-live="polite"
              >
                <span v-if="connectionFeedbackStatus === 'loading'" class="inline-loader"><i></i>{{ connectionFeedbackMessage }}</span>
                <template v-else>{{ connectionFeedbackMessage }}</template>
              </div>
              <div class="settings-connection-list-region">
                <div class="settings-connection-table-wrap">
                  <el-table
                    class="settings-data-table settings-connection-table"
                    :data="storedConnections"
                    height="100%"
                    row-key="id"
                    highlight-current-row
                    :current-row-key="selectedConnectionId"
                    @row-click="handleStoredConnectionRowClick"
                  >
                    <template #empty>
                      <div class="settings-table-empty" role="status">
                        {{ persistentConnectionsEnabled ? "还没有保存连接，请先填写上方连接信息。" : "当前浏览器还没有保存连接，请填写上方连接信息并保存到本机。" }}
                      </div>
                    </template>
                    <el-table-column type="index" label="序号" width="58" align="center" header-align="center" />
                    <el-table-column label="名称" min-width="170" align="center" header-align="center" show-overflow-tooltip>
                      <template #default="{ row }">{{ row.name }}</template>
                    </el-table-column>
                    <el-table-column label="平台" width="104" align="center" header-align="center">
                      <template #default="{ row }">{{ providerLabel(row.providerType) }}</template>
                    </el-table-column>
                    <el-table-column label="管理地址" min-width="190" align="center" header-align="center" show-overflow-tooltip>
                      <template #default="{ row }">{{ row.host }}</template>
                    </el-table-column>
                    <el-table-column label="端口" width="76" align="center" header-align="center">
                      <template #default="{ row }">{{ row.port }}</template>
                    </el-table-column>
                    <el-table-column label="账号" min-width="110" align="center" header-align="center" show-overflow-tooltip>
                      <template #default="{ row }">{{ row.username || "未填写" }}</template>
                    </el-table-column>
                  </el-table>
                </div>
              </div>
            </section>
          </section>

          <section v-else-if="settingsPanel === 'templates'" class="settings-workspace-content settings-workspace-content--single">
            <section class="settings-card">
              <div class="settings-card-head settings-section-head">
                <div>
                  <strong>模板管理</strong>
                  <span>模板能力当前仍由创建虚拟机弹框里的真实配置读取，设置页先保留归档入口。</span>
                </div>
              </div>
              <div class="vrc-muted-block">暂不在设置页直接编辑模板，避免和当前创建 VM 真实配置链路产生两套口径。</div>
            </section>
          </section>

          <section v-else-if="settingsPanel === 'ipPools'" class="settings-workspace-content ip-pool-settings">
            <section class="settings-card ip-pool-card">
              <div class="settings-card-head ip-pool-card-head">
                <div>
                  <strong>IP 池</strong>
                  <span>按物理机 IP 自动匹配默认地址池；判断不符合现场时，用户仍可手动选择其它地址池。</span>
                </div>
                <div class="ip-pool-head-actions">
                  <el-button class="ip-pool-command-button" size="small" @click="selectIpPoolsJson">导入 JSON</el-button>
                  <el-button class="ip-pool-command-button" size="small" :disabled="!ipPoolPolicy.ipPools.length" @click="exportIpPoolPolicy">导出 JSON</el-button>
                  <el-button class="ip-pool-command-button primary" size="small" @click="createIpPool">新增 IP 池</el-button>
                </div>
              </div>

              <div class="ip-pool-layout">
                <aside class="ip-pool-list-panel">
                  <el-input v-model="ipPoolSearch" class="ip-pool-search" :prefix-icon="Search" placeholder="搜索名称 / IP 段 / 网关" clearable />
                  <div class="ip-pool-list">
                    <button
                      v-for="pool in filteredIpPoolItems"
                      :key="pool.id"
                      type="button"
                      class="ip-pool-list-item"
                      :class="{ active: pool.id === ipPoolSelectedId }"
                      @click="selectIpPool(pool.id)"
                    >
                      <span class="ip-pool-list-title">
                        <strong>{{ pool.name }}</strong>
                      </span>
                      <span class="ip-pool-list-meta">
                        <small>{{ pool.prefix }}.{{ pool.startHost ?? 20 }} - {{ pool.prefix }}.{{ pool.endHost ?? 250 }}</small>
                        <small>网关 {{ pool.gateway }}</small>
                      </span>
                    </button>
                    <div v-if="!filteredIpPoolItems.length" class="settings-table-empty" role="status">
                      {{ ipPoolLoading ? "正在读取 IP 池配置" : "没有可展示的 IP 池，请导入或新增后保存。" }}
                    </div>
                  </div>
                </aside>

                <section class="ip-pool-editor-panel">
                  <div class="ip-pool-editor-head">
                    <div>
                      <strong>{{ selectedIpPool?.name || "未选择 IP 池" }}</strong>
                      <span>{{ selectedIpPool ? "修改后点击底部保存写入 ip-pools.json" : "请先选择、导入或新增 IP 池" }}</span>
                    </div>
                    <el-button class="ip-pool-command-button" size="small" :loading="ipPoolLoading" @click="loadIpPoolPolicy">重新读取</el-button>
                  </div>

                  <div class="ip-pool-form">
                    <label class="settings-field">
                      <span>默认 DNS</span>
                      <el-input v-model="ipPoolDefaultDnsText" placeholder="多个 DNS 用逗号分隔" autocomplete="off" />
                    </label>
                    <label class="settings-field">
                      <span>名称</span>
                      <el-input v-model="ipPoolDraft.name" placeholder="填写 IP 池名称" autocomplete="off" :disabled="!ipPoolDraft.id" />
                    </label>
                    <label class="settings-field">
                      <span>网段</span>
                      <el-input v-model="ipPoolDraft.prefix" placeholder="填写 IPv4 前三段" autocomplete="off" :disabled="!ipPoolDraft.id" />
                    </label>
                    <label class="settings-field">
                      <span>适用物理机网段</span>
                      <el-input v-model="ipPoolDraft.hostPrefixesText" placeholder="填写物理机 IPv4 前三段；留空表示通用池" autocomplete="off" :disabled="!ipPoolDraft.id" />
                    </label>
                    <label class="settings-field ip-gateway-field">
                      <span>网关</span>
                      <el-input v-model="ipPoolDraft.gateway" placeholder="填写网关 IPv4 地址" autocomplete="off" :disabled="!ipPoolDraft.id" />
                    </label>
                    <label class="settings-field ip-range-field">
                      <span>IP 池号段</span>
                      <div class="ip-range-control">
                        <span class="ip-range-endpoint">
                          <span class="ip-range-prefix">{{ ipPoolDraft.prefix || "网段" }}.</span>
                          <el-input-number v-model="ipPoolDraft.startHost" :min="1" :max="254" controls-position="right" :disabled="!ipPoolDraft.id" />
                        </span>
                        <span class="ip-range-separator">~</span>
                        <span class="ip-range-endpoint">
                          <span class="ip-range-prefix">{{ ipPoolDraft.prefix || "网段" }}.</span>
                          <el-input-number v-model="ipPoolDraft.endHost" :min="1" :max="254" controls-position="right" :disabled="!ipPoolDraft.id" />
                        </span>
                      </div>
                    </label>
                    <label class="settings-field is-full">
                      <span>指定网络（可选）</span>
                      <el-input v-model="ipPoolDraft.networkName" placeholder="例如 Pool-wide network associated with eth1；可留空" autocomplete="off" :disabled="!ipPoolDraft.id" />
                    </label>
                    <label class="settings-field is-full">
                      <span>单池 DNS</span>
                      <el-input v-model="ipPoolDraft.dnsText" placeholder="可留空，默认使用上方 DNS；多个用逗号分隔" autocomplete="off" :disabled="!ipPoolDraft.id" />
                    </label>
                    <label class="settings-field">
                      <span>VLAN</span>
                      <el-input v-model="ipPoolDraft.vlan" placeholder="可留空" autocomplete="off" :disabled="!ipPoolDraft.id" />
                    </label>
                  </div>

                  <div class="settings-actions ip-pool-actions">
                    <el-button class="ip-pool-command-button danger" :disabled="!selectedIpPool || ipPoolPolicy.ipPools.length <= 1" @click="deleteSelectedIpPool">删除</el-button>
                    <div>
                      <el-button class="ip-pool-command-button" :disabled="!selectedIpPool" @click="copySelectedIpPool">复制</el-button>
                      <el-button class="ip-pool-command-button" @click="resetIpPoolPolicy">清空配置</el-button>
                      <el-button class="ip-pool-command-button primary" :loading="ipPoolSaving" :disabled="!ipPoolPolicy.ipPools.length" @click="saveIpPoolPolicy">
                        {{ ipPoolSaving ? "保存中" : "保存" }}
                      </el-button>
                    </div>
                  </div>
                </section>
              </div>
            </section>
          </section>

          <section v-else-if="settingsPanel === 'chromeExtension'" class="settings-workspace-content settings-workspace-content--single chrome-extension-settings">
            <section class="settings-card chrome-extension-card">
              <div class="settings-card-head settings-section-head chrome-extension-card-head">
                <div>
                  <strong>Chrome 插件配置项</strong>
                  <span>设置入口统一，但该配置只作用于 Chrome 插件，不影响 Web、macOS、Windows 客户端。</span>
                </div>
              </div>
              <el-tabs v-model="chromeExtensionActiveTab" class="chrome-extension-tabs" aria-label="Chrome 插件配置项">
                <el-tab-pane label="服务地址" name="service">
                  <div class="chrome-extension-service-layout">
                    <section class="chrome-extension-inner-panel">
                      <div class="chrome-extension-inner-head">
                        <div>
                          <strong>VRC API 服务</strong>
                          <span>插件只保存入口地址，资源能力仍由后台执行。</span>
                        </div>
                        <div class="chrome-extension-action-group">
                          <el-segmented
                            :model-value="chromeExtensionService.mode"
                            class="chrome-extension-service-mode"
                            :options="chromeExtensionServiceModeOptions"
                            aria-label="Chrome 插件服务位置"
                            @change="handleChromeExtensionServiceModeChange"
                          />
                      <el-button class="chrome-extension-command-button secondary" @click="testChromeExtensionService">检测</el-button>
                      <el-button class="chrome-extension-command-button primary" @click="persistChromeExtensionServiceSettings()">保存地址</el-button>
                        </div>
                      </div>
                      <div class="chrome-extension-service-form">
                        <label class="settings-field">
                          <span>协议</span>
                          <el-select v-model="chromeExtensionService.scheme">
                            <el-option label="http" value="http" />
                            <el-option label="https" value="https" />
                          </el-select>
                        </label>
                        <label class="settings-field">
                          <span>服务地址</span>
                          <el-input v-model="chromeExtensionService.host" placeholder="vrc-server" autocomplete="off" />
                        </label>
                        <label class="settings-field">
                          <span>端口</span>
                          <el-input-number v-model="chromeExtensionService.port" :min="1" :max="65535" controls-position="right" />
                        </label>
                        <label class="settings-field is-full">
                          <span>完整 Base URL</span>
                          <el-input :model-value="chromeExtensionBaseUrl" readonly />
                        </label>
                      </div>
                    </section>
                    <aside class="chrome-extension-side-stack">
                      <section class="vrc-muted-block chrome-extension-note">
                        <strong>nginx 边界</strong>
                        <span>nginx 只做 HTTPS、反向代理和访问控制；Chrome 插件只保存入口地址，连接账号留在浏览器本地连接库。</span>
                      </section>
                      <pre class="chrome-extension-code vrc-muted-block">GET  /api/health
GET  /api/inventory/*
WS   /api/console/*

connectionStore: chrome.storage.local
serverStore: disabled</pre>
                    </aside>
                  </div>
                </el-tab-pane>

                <el-tab-pane label="本地连接库" name="vault">
                  <div class="chrome-extension-service-layout chrome-extension-vault-layout">
                <section class="chrome-extension-inner-panel chrome-extension-vault-panel">
                  <div class="chrome-extension-inner-head">
                    <div>
                      <strong>本地连接库</strong>
                      <span>连接信息只在当前浏览器本地保存，后续接 WebCrypto 加密。</span>
                    </div>
                  </div>
                  <div class="chrome-extension-table-wrap vrc-scroll-container">
                    <el-table
                      class="chrome-extension-table"
                      :data="chromeExtensionLocalConnections"
                      height="100%"
                      row-key="id"
                      empty-text=" "
                      stripe
                    >
                      <template #empty>
                        <div class="chrome-extension-table-empty">
                          <strong>暂无本地连接</strong>
                        </div>
                      </template>
                      <el-table-column type="index" label="序号" width="58" align="center" />
                      <el-table-column prop="name" label="名称" min-width="120" align="center" show-overflow-tooltip />
                      <el-table-column label="平台" min-width="88" align="center">
                        <template #default="{ row }">{{ providerLabel(row.providerType) }}</template>
                      </el-table-column>
                      <el-table-column prop="host" label="管理地址" min-width="132" align="center" show-overflow-tooltip />
                      <el-table-column prop="username" label="账号" min-width="88" align="center" show-overflow-tooltip />
                      <el-table-column prop="lastUsed" label="最近使用" min-width="96" align="center" show-overflow-tooltip />
                      <el-table-column label="状态" min-width="76" align="center">
                        <template #default="{ row }">
                          <span class="chrome-extension-status" :class="row.status">{{ row.status === "ready" ? "可用" : "需验证" }}</span>
                        </template>
                      </el-table-column>
                      <el-table-column label="操作" width="58" align="center" class-name="chrome-extension-operation-column">
                        <template #default="{ row }">
                          <span class="chrome-extension-action-cell">
                            <button
                              type="button"
                              class="chrome-extension-row-action action-delete"
                              :aria-label="`删除本地连接 ${row.name}`"
                              @click.stop="deleteChromeExtensionLocalConnection(row)"
                            >
                              <VrcVmActionIcon name="delete" />
                            </button>
                          </span>
                        </template>
                      </el-table-column>
                    </el-table>
                  </div>
                </section>
                <aside class="chrome-extension-side-stack">
                  <section class="chrome-extension-inner-panel">
                    <div class="chrome-extension-inner-head">
                      <div><strong>新增连接</strong><span>保存前先用主密码加密。</span></div>
                    </div>
                    <div class="chrome-extension-draft-form">
                      <label class="settings-field">
                        <span>平台</span>
                        <el-select v-model="chromeExtensionDraftConnection.providerType">
                          <el-option label="XenServer" value="xenserver" />
                          <el-option label="VMware" value="vmware" />
                          <el-option label="Proxmox VE" value="proxmox" />
                        </el-select>
                      </label>
                      <label class="settings-field">
                        <span>名称</span>
                        <el-input v-model="chromeExtensionDraftConnection.name" autocomplete="off" />
                      </label>
                      <label class="settings-field is-full">
                        <span>Host</span>
                        <el-input v-model="chromeExtensionDraftConnection.host" placeholder="10.12.8.21" autocomplete="off" />
                      </label>
                      <label class="settings-field">
                        <span>用户名</span>
                        <el-input v-model="chromeExtensionDraftConnection.username" autocomplete="off" />
                      </label>
                      <label class="settings-field">
                        <span>密码</span>
                        <el-input v-model="chromeExtensionDraftConnection.password" type="password" show-password autocomplete="new-password" />
                      </label>
                    </div>
                    <div class="chrome-extension-draft-actions">
                      <el-button class="chrome-extension-command-button primary" @click="addChromeExtensionLocalConnection">加密保存</el-button>
                    </div>
                  </section>
                  <section class="vrc-muted-block chrome-extension-note">
                    <strong>存储口径</strong>
                    <span>使用 chrome.storage.local；禁止 chrome.storage.sync；密文可以导出，明文不能写文件。</span>
                  </section>
                    </aside>
                  </div>
                </el-tab-pane>
              </el-tabs>
            </section>
          </section>

          <section v-else-if="settingsPanel === 'updates'" class="settings-workspace-content settings-workspace-content--single">
            <UpdateCenterPanel :runtime-mode="apiRuntimeMode" />
          </section>

          <section v-else-if="settingsPanel === 'maintenance'" class="settings-workspace-content settings-workspace-content--single maintenance-settings">
            <section class="settings-card maintenance-card">
              <div class="settings-card-head settings-section-head maintenance-card-head">
                <div>
                  <strong>安装临时介质</strong>
                  <span>无人值守任务结束后会自动删除 vrc-*.iso；这里只处理自动清理失败或暂时保留的介质。</span>
                </div>
                <div class="maintenance-head-actions">
                  <el-button class="ip-pool-command-button" size="small" :loading="maintenanceIsoLoading" @click="loadMaintenanceGeneratedIsos()">
                    {{ maintenanceIsoLoading ? "扫描中" : "重新扫描" }}
                  </el-button>
                  <el-button
                    class="ip-pool-command-button primary"
                    size="small"
                    :loading="maintenanceIsoCleaning"
                    :disabled="!maintenanceIsoSummary.eligible"
                    @click="cleanupMaintenanceGeneratedIsos"
                  >
                    {{ maintenanceIsoCleaning ? "清理中" : "清理残留" }}
                  </el-button>
                </div>
              </div>
              <div v-if="maintenanceIsoStatus" class="maintenance-iso-status">
                <span>扫描状态：</span>
                <strong>{{ maintenanceIsoStatus }}</strong>
              </div>

              <div class="maintenance-summary-grid">
                <article>
                  <span>可清理</span>
                  <strong>{{ maintenanceIsoSummary.eligible }}</strong>
                </article>
                <article>
                  <span>保留</span>
                  <strong>{{ maintenanceIsoSummary.retained }}</strong>
                </article>
                <article>
                  <span>需检查</span>
                  <strong>{{ maintenanceIsoSummary.failed + maintenanceIsoSummary.skipped }}</strong>
                </article>
                <article>
                  <span>本地占用</span>
                  <strong>{{ formatBytes(maintenanceIsoSummary.localBytes) }}</strong>
                </article>
              </div>

              <div v-if="maintenanceIsoLoading && !maintenanceIsoReport" class="vrc-muted-block maintenance-empty">
                正在扫描 generated-isos.json 和本地临时目录。
              </div>
              <div v-else-if="maintenanceIsoError" class="vrc-muted-block maintenance-empty error">
                {{ maintenanceIsoError }}
              </div>
              <div v-else-if="!maintenanceIsoReport || !maintenanceIsoActiveItems.length" class="vrc-muted-block maintenance-empty">
                没有待处理的安装临时介质。
              </div>
              <div v-else class="maintenance-iso-list">
                <div class="maintenance-iso-list-head">
                  <strong>待处理介质</strong>
                  <span>
                    {{ maintenanceIsoScannedAt ? `最后扫描 ${maintenanceIsoScannedAt} · ` : "" }}显示
                    {{ maintenanceIsoVisibleItems.length }} / {{ maintenanceIsoActiveItems.length }} 条
                  </span>
                </div>
                <el-table :data="maintenanceIsoVisibleItems" row-key="id" class="maintenance-iso-table">
                  <el-table-column label="介质" min-width="300">
                    <template #default="{ row }">
                      <span class="maintenance-iso-main">
                        <strong :title="row.isoName">{{ row.isoName }}</strong>
                        <small :title="row.reason">{{ row.reason }}</small>
                      </span>
                    </template>
                  </el-table-column>
                  <el-table-column label="清理状态" width="100" align="center">
                    <template #default="{ row }">
                      <span class="maintenance-iso-state" :class="`state-${row.decision}`">
                        <strong>{{ maintenanceIsoDecisionLabel(row) }}</strong>
                        <small>{{ maintenanceIsoStatusLabel(row.status) }}</small>
                      </span>
                    </template>
                  </el-table-column>
                  <el-table-column label="创建时间" width="128" align="center">
                    <template #default="{ row }">
                      <span class="maintenance-iso-created">
                        <strong>{{ formatMaintenanceIsoDate(row.createdAt) }}</strong>
                        <small>创建时间</small>
                      </span>
                    </template>
                  </el-table-column>
                  <el-table-column label="平台 / 目标" min-width="140" align="center">
                    <template #default="{ row }">
                      <span class="maintenance-iso-meta">
                        <small>{{ providerLabel(row.providerType) }}</small>
                        <small>{{ row.vmIp || row.vmName || "-" }}</small>
                      </span>
                    </template>
                  </el-table-column>
                  <el-table-column label="占用" width="86" align="right" header-align="right">
                    <template #default="{ row }">
                      <span class="maintenance-iso-size">{{ formatBytes(row.localBytes) }}</span>
                    </template>
                  </el-table-column>
                </el-table>
              </div>
            </section>
          </section>

          <section v-else class="settings-workspace-content settings-workspace-content--single">
            <section class="settings-card">
              <div class="settings-card-head settings-section-head">
                <div>
                  <strong>操作记录</strong>
                  <span>持久化保存本机操作记录，重启后仍然保留，敏感字段已脱敏。</span>
                </div>
                <div class="settings-log-actions">
                  <el-button :loading="persistentAuditLoading" @click="refreshPersistentAudit">刷新</el-button>
                  <el-button @click="openPersistentAuditDialog">查看完整记录</el-button>
                </div>
              </div>
              <div v-if="persistentAuditLoading" class="settings-log-loading" role="status">正在加载操作记录…</div>
              <ActivityLogTable
                v-else
                class="settings-log-table"
                :entries="persistentAuditEntries.slice(0, 6)"
                @detail="openActivityDetail"
              />
            </section>
          </section>
        </div>
      </section>

      <section v-if="showWorkspacePlaceholder" class="workspace-placeholder">
        <div class="workspace-placeholder-mark" aria-hidden="true">
          <VrcLogoMark shadow />
        </div>
        <strong>资源控制台</strong>
        <small>Virtual Resource Console</small>
      </section>

      <el-dialog v-model="vmDetailVisible" title="虚拟机信息" width="80vw" class="vm-detail-dialog" top="4vh" :close-on-click-modal="false" destroy-on-close>
        <HostVmPanel
          v-if="selectedHost"
          v-model:search="search"
          v-model:power-filter="vmPowerFilter"
          :connection="{ id: selectedConnectionId, providerType: connection.providerType, host: connection.host, port: connection.port, username: connection.username, password: persistentConnectionsEnabled ? undefined : connection.password }"
          :provider-descriptor="selectedProviderDescriptor"
          :host="selectedHost"
          :network-count="selectedHostNetworks.length"
          :resource-summary="resourceSummary"
          :resource-capacity="selectedResourceCapacity"
          :storage-pool-highlights="storagePoolHighlightItems"
          :storage-display-mode="uiPreferences.storageDisplayMode"
          :vm-totals="vmTotals"
          :has-vm-summary="!!vmSummary"
          :loading-vm-summary="loadingVmSummary"
          :vms="filteredVms"
          :vms-total="vmTableTotal"
          :selected-vm-ids="selectedVmIds"
          :vm-action-states="vmActionStates"
          :provisioning-console-vm-ids="activeProvisioningConsoleVmIds"
          :loading-vms="loadingVms"
          :show-icon-tooltips="uiPreferences.showIconTooltips"
          variant="dialog"
          table-height="100%"
          metric-grid-class="dialog-metric-grid"
          table-panel-class="dialog-table-panel"
          @search-change="loadVms"
          @refresh="refreshVmPanelResources"
          @export="exportCsv"
          @host-detail="hostDetailVisible = true"
          @storage-detail="storageDetailVisible = true"
          @iso-detail="openIsoDetail"
          @create-vm="openProvisioningDialog"
          @selection-change="handleVmSelectionChange"
          @open-console="handleOpenVmConsole"
          @vm-action="handleVmAction"
          @batch-vm-action="handleBatchVmAction"
          @schedule-vms="openVmScheduleCreate"
          @rename-vm="openVmRename"
          @resize-vm="openVmResize"
          @diagnose-vm="openHostDiagnostics"
        />
      </el-dialog>

      <VmRenameDialog
        v-model="vmRenameVisible"
        :vm="vmRenameTarget"
        :provider-descriptor="selectedProviderDescriptor"
        :existing-names="(vms?.items ?? []).filter((item) => item.providerId !== vmRenameTarget?.providerId).map((item) => item.name)"
        :saving="vmRenameSaving"
        @submit="handleVmRename"
      />

      <VmResizeDialog
        v-model="vmResizeVisible"
        :vm="vmResizeTarget"
        :host="selectedHost"
        :provider-descriptor="selectedProviderDescriptor"
        :disks="vmResizeDisks"
        :loading-disks="vmResizeLoadingDisks"
        :guest-storage="vmResizeGuestStorage"
        :loading-guest-storage="vmResizeLoadingGuestStorage"
        :guest-storage-error="vmResizeGuestStorageError"
        :saving="vmResizeSaving"
        :cpu-free="resourceSummary[0]?.free ?? 0"
        :cpu-overcommitted="(resourceSummary[0]?.percent ?? 0) > 100"
        :memory-free-gi-b="resourceSummary[1]?.free ?? 0"
        :storage-free-gi-b="resourceSummary[2]?.free ?? 0"
        @load-disks="loadVmResizeDisks"
        @load-guest-storage="loadVmResizeGuestStorage"
        @submit="handleVmResize"
      />

      <VmBootEntryDialog
        :model-value="bootEntryVisible"
        :vm="bootEntryDialogVm"
        :action="bootEntryDialogAction"
        :loading="bootEntryLoading"
        :boot-entries="bootEntryList"
        :error="bootEntryError"
        :auth-required="bootEntryAuthRequired"
        @update:model-value="handleBootEntryDialogClose"
        @load-boot-entries="loadVmBootEntries"
        @confirm="handleBootEntryConfirm"
      />

      <HostDiagnosticsDialog
        v-model="hostDiagnosticsVisible"
        :host="hostDiagnosticsHost"
        :vm="hostDiagnosticsTarget"
        :provider-descriptor="hostDiagnosticsProviderDescriptor"
        :connection-payload="hostDiagnosticsConnectionPayload"
        @confirm="handleHostDiagnosticsConfirm"
      />

      <el-dialog v-model="vmSnapshotVisible" title="物理机快照" width="820px" class="vm-snapshot-dialog" top="10vh" :close-on-click-modal="false">
        <div v-if="vmSnapshotHost" class="vm-snapshot-target">
          <strong class="vrc-copyable-text">{{ vmSnapshotHost.name }}</strong>
          <small>{{ vmSnapshotProviderLabel }} · {{ vmSnapshotHost.providerId }}</small>
        </div>
        <div v-if="vmSnapshotLoading" class="vm-snapshot-loading" role="status">正在读取快照…</div>
        <div v-else-if="vmSnapshotGroups.length === 0" class="vm-snapshot-empty" role="status">该物理机下暂无快照</div>
        <div v-else class="vm-snapshot-groups">
          <section v-for="group in vmSnapshotGroups" :key="group.vm.providerId" class="vm-snapshot-group">
            <header class="vm-snapshot-group-head">
              <span class="vm-snapshot-group-name vrc-copyable-text" :title="group.vm.name">{{ group.vm.name }}</span>
              <code class="vm-snapshot-group-id vrc-copyable-text">{{ group.vm.providerId }}</code>
            </header>
            <div v-if="group.error" class="vm-snapshot-group-error" role="status">读取该虚拟机快照失败：{{ group.error }}</div>
            <el-table v-else-if="group.snapshots.length" class="vm-snapshot-table" :data="group.snapshots" row-key="providerId">
              <el-table-column type="index" label="序号" width="62" align="center" />
              <el-table-column prop="name" label="快照名称" min-width="200" align="left" show-overflow-tooltip>
                <template #default="{ row }"><span class="vrc-copyable-text">{{ row.name }}</span></template>
              </el-table-column>
              <el-table-column label="创建时间" width="176" align="center">
                <template #default="{ row }"><time>{{ formatSnapshotTime(row.createdAt) }}</time></template>
              </el-table-column>
              <el-table-column prop="providerId" label="快照 ID" min-width="180" align="center" show-overflow-tooltip>
                <template #default="{ row }"><code class="vrc-copyable-text">{{ row.providerId }}</code></template>
              </el-table-column>
            </el-table>
            <div v-else class="vm-snapshot-group-empty" role="status">该虚拟机暂无快照</div>
          </section>
        </div>
      </el-dialog>

      <ConsoleDialog
        v-model:visible="consoleDialogVisible"
        :target="consoleTarget"
        :provision-task="activeConsoleProvisionTask"
        :provision-targets="provisionConsoleTargets"
        :terminal-font-family="currentConsoleFont.family"
        :terminal-font-size="uiPreferences.consoleFontSize"
        :terminal-line-height="uiPreferences.consoleLineHeight"
        :terminal-cursor-style="uiPreferences.consoleCursorStyle"
        :terminal-cursor-blink="uiPreferences.consoleCursorBlink"
        :terminal-theme="consoleTerminalTheme"
        :display-scale-mode="uiPreferences.consoleScaleMode"
        :display-quality="uiPreferences.consoleQuality"
        :throttle-resize="uiPreferences.throttleConsoleResize"
        :watermark-enabled="uiPreferences.consoleWatermarkEnabled && uiPreferences.consoleWatermarkScope === 'console'"
        :watermark-density="uiPreferences.consoleWatermarkDensity"
        :watermark-opacity="uiPreferences.consoleWatermarkOpacity"
        :watermark-text="consoleWatermarkText"
        :show-icon-tooltips="uiPreferences.showIconTooltips"
        @select-provision-target="handleSelectProvisionConsoleTarget"
        @upload-result="handleConsoleUploadResult"
      />

      <el-dialog v-model="activityLogVisible" title="操作记录" width="820px" class="activity-log-dialog" top="7vh" :close-on-click-modal="false">
        <div class="activity-log-tools">
          <div class="activity-query-group">
            <el-input v-model="activitySearch" class="activity-search" :prefix-icon="Search" placeholder="搜索动作 / 对象 / 详情" clearable />
            <span class="activity-log-count">{{ filteredActivityEntries.length }} / {{ auditDialogEntries.length }}</span>
          </div>
          <el-segmented
            v-model="activityStatusFilter"
            class="activity-status-filter"
            :options="activityStatusSegmentOptions"
            aria-label="操作记录状态筛选"
          />
          <el-button :loading="persistentAuditLoading" @click="refreshPersistentAudit">刷新</el-button>
        </div>
        <div v-if="persistentAuditLoading" class="activity-log-loading" role="status">正在加载操作记录…</div>
        <ActivityLogTable v-else class="activity-log-table" :entries="filteredActivityEntries" :max-height="460" @detail="openActivityDetail" />
      </el-dialog>

      <el-dialog
        v-model="activityDetailVisible"
        title="日志详情"
        width="640px"
        class="activity-detail-dialog"
        top="10vh"
        append-to-body
        :close-on-click-modal="false"
      >
        <dl v-if="selectedActivityEntry" class="activity-detail-list">
          <div>
            <dt>序号</dt>
            <dd>{{ selectedActivityEntrySequence ?? "-" }}</dd>
          </div>
          <div>
            <dt>时间</dt>
            <dd>{{ selectedActivityEntry.time }}</dd>
          </div>
          <div>
            <dt>状态</dt>
            <dd><span class="activity-record-status" :class="`status-${selectedActivityEntry.status}`">{{ activityStatusLabel(selectedActivityEntry.status) }}</span></dd>
          </div>
          <div>
            <dt>事件</dt>
            <dd>{{ selectedActivityEntry.title }}</dd>
          </div>
          <div class="is-full">
            <dt>对象</dt>
            <dd>{{ selectedActivityEntry.target || "-" }}</dd>
          </div>
          <div class="is-full">
            <dt>详情</dt>
            <dd>{{ selectedActivityEntry.detail || "-" }}</dd>
          </div>
          <div v-if="selectedActivityEntry.request" class="is-full">
            <dt>执行入口</dt>
            <dd><code>{{ selectedActivityEntry.request }}</code></dd>
          </div>
          <div v-if="selectedActivityEntry.command" class="is-full">
            <dt>平台命令</dt>
            <dd><pre>{{ selectedActivityEntry.command }}</pre></dd>
          </div>
        </dl>
      </el-dialog>

      <el-dialog v-model="connectionSettingsVisible" title="连接设置" width="1280px" class="connection-settings-dialog" top="5vh" :close-on-click-modal="false">
        <form class="settings-dialog-shell" autocomplete="off" @submit.prevent="loadHostInventory()">
          <aside class="settings-nav" aria-label="设置分组">
            <div class="settings-current">
              <span>当前连接</span>
              <strong>{{ selectedStoredConnection?.name || connectionName || "未保存连接" }}</strong>
              <small>{{ providerLabel(connection.providerType) }} · {{ connection.host }}:{{ connection.port }}</small>
            </div>
            <div class="settings-nav-item active">
              <el-icon><Connection /></el-icon>
              <span>平台连接</span>
            </div>
            <div class="settings-nav-item">
              <el-icon><Brush /></el-icon>
              <span>界面主题</span>
            </div>
          </aside>

          <section class="settings-content">
            <section class="settings-card">
              <div class="settings-card-head">
                <div>
                  <strong>界面主题</strong>
                  <span>主题优先影响背景、弹窗、按钮、表格和提示色。</span>
                </div>
              </div>
              <div class="settings-theme-options">
                <button
                  v-for="theme in recommendedThemes"
                  :key="theme.value"
                  type="button"
                  class="settings-theme-option"
                  :class="{ active: currentTheme === theme.value }"
                  :aria-pressed="currentTheme === theme.value"
                  @click="applyTheme(theme.value)"
                >
                  <span class="theme-swatch" aria-hidden="true">
                    <i v-for="color in theme.colors" :key="color" :style="{ background: color }"></i>
                  </span>
                  <strong>{{ theme.label }}</strong>
                </button>
              </div>
            </section>

            <section class="settings-card connection-settings-card">
              <div class="settings-card-head connection-settings-head">
                <div>
                  <strong>连接设置</strong>
                  <span>{{ persistentConnectionsEnabled ? "保存后可在左侧连接列表中直接选择并读取物理机资源。" : "保存到当前浏览器本地，不写入共享 Web 服务器。" }}</span>
                </div>
                <span>{{ persistentConnectionsEnabled ? "保存 / 测试 / 删除 / 加载资源" : "本地保存 / 测试 / 加载资源" }}</span>
              </div>
              <div class="settings-form-grid connection-settings-form">
                <label class="settings-field">
                  <span>连接名</span>
                  <el-input v-model="connectionName" placeholder="例如 xenserver-3" autocomplete="off" />
                </label>
                <label class="settings-field">
                  <span>平台</span>
                  <el-select v-model="connection.providerType">
                    <el-option label="XenServer" value="xenserver" />
                    <el-option label="VMware" value="vmware" />
                    <el-option label="Proxmox VE" value="proxmox" />
                    <el-option label="KVM/libvirt" value="libvirt" />
                  </el-select>
                </label>
                <label class="settings-field is-wide">
                  <span>管理地址</span>
                  <el-input v-model="connection.host" placeholder="IP / Host" autocomplete="off" />
                </label>
                <label class="settings-field">
                  <span>端口</span>
                  <el-input-number v-model="connection.port" :min="1" :max="65535" controls-position="right" />
                </label>
                <label class="settings-field">
                  <span>账号</span>
                  <el-input v-model="connection.username" placeholder="User" autocomplete="off" />
                </label>
                <label class="settings-field is-wide">
                  <span>密码</span>
                  <el-input
                    v-model="connection.password"
                    placeholder="Password"
                    type="password"
                    show-password
                    autocomplete="new-password"
                    name="vrc-platform-password"
                  />
                </label>
              </div>
              <div class="settings-actions connection-settings-actions">
                <el-button :icon="Plus" @click="startNewConnection">新连接</el-button>
                <el-button :icon="Connection" :loading="testing" @click="testConnection">{{ testing ? "测试中" : "测试" }}</el-button>
                <el-button :icon="Upload" @click="openAccountImportDialog">导入账号</el-button>
                <el-tooltip :content="persistentConnectionsEnabled ? '加载资源：使用已保存账号读取物理机、存储、网络和 VM 清单' : '加载资源：使用当前表单账号读取物理机、存储、网络和 VM 清单，不在服务器保存账号密码'" placement="top" :disabled="!uiPreferences.showIconTooltips">
                  <el-button :icon="Refresh" :loading="loadingHosts" :disabled="!selectedConnectionId && !canLoadDirectConnection" @click="loadSelectedConnectionResources">
                    {{ loadingHosts ? "加载中" : "加载资源" }}
                  </el-button>
                </el-tooltip>
                <el-button :icon="Delete" :disabled="!selectedConnectionId" @click="deleteConnection">删除</el-button>
                <el-button type="primary" :icon="Check" :loading="savingConnection" :disabled="!connection.password" @click="saveConnection">
                  {{ savingConnection ? "保存中" : "保存" }}
                </el-button>
              </div>
              <div
                v-if="connectionFeedbackMessage"
                class="settings-action-feedback"
                :class="connectionFeedbackStatus"
                aria-live="polite"
              >
                <span v-if="connectionFeedbackStatus === 'loading'" class="inline-loader"><i></i>{{ connectionFeedbackMessage }}</span>
                <template v-else>{{ connectionFeedbackMessage }}</template>
              </div>
            </section>
          </section>
        </form>
      </el-dialog>

      <el-dialog v-model="accountImportVisible" width="980px" class="account-import-dialog" top="8vh" :close-on-click-modal="false">
        <template #header>
          <div class="account-import-dialog-title">
            <div>
              <strong>服务器账号导入</strong>
              <span>{{ persistentConnectionsEnabled ? "Excel / JSON / 固定格式，先测试连接，通过后再保存" : "导入到当前浏览器本地，不写入共享 Web 服务器" }}</span>
            </div>
          </div>
        </template>
        <section class="settings-card account-import-card">
          <div class="account-import-layout">
            <section class="import-drop-panel">
              <el-tabs :model-value="accountImportMode" class="import-mode-tabs" aria-label="导入方式" @tab-change="handleAccountImportTabChange">
                <el-tab-pane label="Excel 文件" name="excel" />
                <el-tab-pane label="JSON 串" name="json" />
                <el-tab-pane label="固定格式" name="fixed" />
              </el-tabs>

              <input ref="accountImportFileInput" class="account-import-file-input" type="file" accept=".xlsx,.xls,.csv" @change="handleAccountImportFileChange" />

              <div v-if="accountImportMode === 'excel'" class="import-drop-zone" @click="triggerAccountImportFile" @dragover.prevent @drop.prevent="handleAccountImportDrop">
                <div>
                  <strong>{{ accountImportFileName || "拖入 .xlsx / .csv，或点击选择文件" }}</strong>
                  <span>表头：平台、主机、服务器名称、登录账号、登录密码、端口；端口和账号可为空。</span>
                </div>
              </div>

              <textarea
                v-else
                v-model="accountImportText"
                class="import-textarea"
                :placeholder="accountImportPlaceholder"
              ></textarea>

              <div class="format-sample">
                <span>固定格式示例：</span>
                <span>XenServer 192.0.2.77 xenserver-1 root P</span>
                <span>XenServer 192.0.2.6 xenserver-3 P</span>
              </div>
              <span class="format-rule">固定格式按空格 / Tab 拆列；4 列时账号默认 root，5 列时第 4 列为账号。密码包含空格时请用 Excel 或 JSON。</span>
              <div v-if="accountImportError" class="import-error-note">{{ accountImportError }}</div>
              <div class="button-row account-import-buttons">
                <button type="button" class="btn" @click="downloadAccountImportTemplate">
                  <el-icon><Download /></el-icon>
                  下载模板
                </button>
                <button type="button" class="btn primary" :disabled="parsingAccountImport" @click="parseAccountImport">
                  {{ parsingAccountImport ? "解析中" : "解析预览" }}
                </button>
              </div>
            </section>

            <section class="import-preview-panel">
              <div class="import-summary-row">
                <span class="import-summary-tile"><span>总行数</span><strong>{{ accountImportSummary.total }}</strong></span>
                <span class="import-summary-tile"><span>可导入</span><strong>{{ accountImportSummary.importable }}</strong></span>
                <span class="import-summary-tile"><span>覆盖更新</span><strong>{{ accountImportSummary.update }}</strong></span>
                <span class="import-summary-tile"><span>错误</span><strong>{{ accountImportSummary.error }}</strong></span>
              </div>

              <div class="import-preview-table vrc-scroll-container">
                <div class="import-preview-row header">
                  <span>平台</span>
                  <span>服务器名称</span>
                  <span>主机</span>
                  <span>账号</span>
                  <span>结果</span>
                </div>
                <div
                  v-for="row in accountImportDrafts"
                  :key="`${row.rowNo}:${row.host}:${row.name}`"
                  class="import-preview-row"
                  :class="{ update: row.status === 'update', error: row.status === 'error' }"
                  :title="row.statusDetail"
                >
                  <span>{{ row.providerType ? providerLabel(row.providerType) : "-" }}</span>
                  <span>{{ row.name || "-" }}</span>
                  <span>{{ row.host || "-" }}{{ row.port ? `:${row.port}` : "" }}</span>
                  <span>{{ row.username || "-" }}</span>
                  <span class="pill" :class="row.status === 'error' ? 'danger' : row.status === 'update' ? 'warn' : 'good'">{{ row.statusText }}</span>
                </div>
                <div v-if="!accountImportDrafts.length" class="import-preview-empty">解析后在这里预览导入结果</div>
              </div>

              <div v-if="accountImportUpdateNotes.length" class="import-preview-alert">
                <strong>已存在相同 IP/端口</strong>
                <span v-for="row in accountImportUpdateNotes" :key="`${row.rowNo}:${row.host}:note`">{{ row.statusDetail }}</span>
                <span v-if="accountImportSummary.update > accountImportUpdateNotes.length">还有 {{ accountImportSummary.update - accountImportUpdateNotes.length }} 条相同 IP/端口记录会覆盖更新。</span>
              </div>

              <span class="import-preview-note">预览只展示掩码后的密码；点击导入后会先逐条测试连接，全部通过才保存；保存时按“平台 + 主机 + 端口”识别重复连接，重复项默认更新名称、账号和密码，不自动加载资源。</span>
            </section>
          </div>
        </section>
        <template #footer>
          <div class="account-import-footer">
            <el-button @click="accountImportVisible = false">取消</el-button>
            <el-button :disabled="!accountImportCanConfirm || accountImportSummary.update === accountImportSummary.importable" @click="accountImportDrafts = accountImportDrafts.filter((row) => row.status === 'new')">只导入新增</el-button>
            <el-button type="primary" :loading="importingAccounts" :disabled="!accountImportCanConfirm" @click="confirmAccountImport">
              {{ importingAccounts ? "测试中" : `测试并导入 ${accountImportSummary.importable} 条` }}
            </el-button>
          </div>
        </template>
      </el-dialog>

      <el-dialog v-model="hostDetailVisible" title="物理机详情" width="760px" class="resource-detail-dialog host-resource-detail-dialog" :close-on-click-modal="false">
        <div class="resource-detail-body vrc-scroll-container">
        <div v-if="selectedHost" class="resource-detail-summary">
          <div>
            <span>物理机</span>
            <strong>{{ selectedHost.name }}</strong>
          </div>
          <div>
            <span>管理地址</span>
            <strong>{{ selectedHost.address }}</strong>
          </div>
          <div>
            <span>资源规格</span>
            <strong>{{ formatCpuCount(selectedHost.cpuCores) }} · {{ formatBytes(selectedHost.memoryTotalBytes) }}</strong>
          </div>
        </div>
        <div class="dialog-section-title">
          <strong>网络接口</strong>
          <span>查看当前平台网络接口连接状态</span>
        </div>
        <el-table class="resource-detail-table host-network-detail-table" :data="selectedHostNetworks" :max-height="360" row-key="device" stripe empty-text="暂无网络接口">
          <el-table-column prop="device" label="设备" width="112" align="center" class-name="resource-detail-nowrap" show-overflow-tooltip />
          <el-table-column prop="ip" label="IP" width="132" align="left" />
          <el-table-column prop="mac" label="MAC" width="142" align="left" show-overflow-tooltip />
          <el-table-column prop="network" label="网络" min-width="150" align="left" show-overflow-tooltip />
          <el-table-column label="管理口" width="80" align="center">
            <template #default="{ row }">
              <span :class="{ 'resource-detail-positive': row.management }">{{ row.management ? "是" : "否" }}</span>
            </template>
          </el-table-column>
          <el-table-column label="已连接" width="86" align="center">
            <template #default="{ row }">{{ row.attached ? "是" : "否" }}</template>
          </el-table-column>
        </el-table>
        </div>
      </el-dialog>

      <el-dialog v-model="storageDetailVisible" title="存储池详情" width="980px" class="resource-detail-dialog storage-resource-detail-dialog" :close-on-click-modal="false">
        <div class="resource-detail-body vrc-scroll-container">
        <div class="resource-detail-summary storage-detail-summary">
          <div v-for="item in storageDetailSummaryItems" :key="item.key" class="storage-detail-item" :class="[item.kind ? `storage-detail-${item.kind}` : '', item.kind === 'focus' ? 'storage-summary-focus' : '']">
            <span>{{ item.label }}</span>
            <strong>
              {{ item.value }}<em v-if="item.pct != null" class="storage-pct" :class="`is-${item.pctClass || 'ok'}`">{{ item.pct }}%</em>
            </strong>
            <small v-if="item.sub">{{ item.sub }}</small>
          </div>
        </div>
        <div class="dialog-section-title storage-detail-section-title">
          <strong>存储池</strong>
          <span>仅统计可承载 VM 磁盘的存储池（HBA / LVM）</span>
          <el-segmented
            v-model="storageAllocationFilter"
            class="storage-allocation-filter"
            :options="[
              { label: '仅可分配 VM 磁盘', value: true },
              { label: '全部存储池', value: false },
            ]"
          />
        </div>
        <el-table class="resource-detail-table storage-resource-detail-table" :data="storageForDetail" :max-height="420" row-key="name" stripe empty-text="暂无存储池数据">
          <el-table-column prop="name" label="存储池名称" min-width="200" align="left" show-overflow-tooltip />
          <el-table-column label="分类" width="110" align="left">
            <template #default="{ row }">
              <span class="storage-category-text" :class="`storage-category-${storagePoolCategory(connection.providerType, row).kind}`">{{ storagePoolCategory(connection.providerType, row).label }}</span>
            </template>
          </el-table-column>
          <el-table-column label="剩余" min-width="150" align="left">
            <template #default="{ row }">
              <div class="storage-detail-free-cell">
                <div class="storage-detail-free-line">
                  <strong class="storage-free-value" :class="storageFreeClass(row)">{{ formatNumber(storageFreeGiB(row)) }} GiB</strong>
                  <em class="storage-pct" :class="`is-${storageRowRemainingHealth(row)}`">{{ storageRowRemainingPercent(row) }}%</em>
                </div>
                <span class="storage-remain-bar" :class="`is-${storageRowRemainingHealth(row)}`" aria-hidden="true"><i :style="{ width: `${100 - storageRowRemainingPercent(row)}%` }"></i></span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="已使用" width="110" align="right">
            <template #default="{ row }">{{ formatNumber(row.usedGiB) }} GiB</template>
          </el-table-column>
          <el-table-column label="物理总量" width="110" align="right">
            <template #default="{ row }">{{ formatNumber(row.physicalGiB) }} GiB</template>
          </el-table-column>
          <el-table-column label="存储类型" min-width="150" align="left">
            <template #default="{ row }">
              <div class="storage-type-cell">
                <strong>{{ row.typeLabel }}</strong>
                <small>{{ row.type }}</small>
              </div>
            </template>
          </el-table-column>
        </el-table>
        </div>
      </el-dialog>

      <el-dialog v-model="isoDetailVisible" title="系统镜像" width="920px" class="iso-dialog" top="8vh" :close-on-click-modal="false">
        <div class="iso-dialog-head">
          <div class="dialog-summary">
            <strong>{{ isoTotals.count }} 个 ISO · {{ formatBytes(isoTotals.totalBytes) }}</strong>
            <span>{{ selectedHost?.name || connection.host }} · {{ isoTotals.storageCount }} 个存储库</span>
          </div>
          <div class="iso-dialog-query-group" aria-label="系统镜像筛选">
            <el-input v-model="isoSearch" class="iso-search-input" :prefix-icon="Search" placeholder="搜索镜像 / ISO 库 / 路径" clearable />
          </div>
          <div class="iso-dialog-action-group" aria-label="系统镜像列表动作">
            <el-tooltip content="刷新系统镜像" placement="top" :disabled="!uiPreferences.showIconTooltips">
              <span class="toolbar-tooltip-target">
                <button type="button" class="toolbar-action-button" :disabled="loadingIsoImages" aria-label="刷新系统镜像" @click="loadIsoImages(true)">
                  <el-icon v-if="loadingIsoImages" class="inline-loading"><Loading /></el-icon>
                  <VrcToolbarIcon v-else name="refresh" />
                </button>
              </span>
            </el-tooltip>
          </div>
        </div>
        <div class="iso-table-wrap" :class="{ loading: loadingIsoImages }">
          <el-table :data="filteredIsoImages" :max-height="ISO_TABLE_MAX_HEIGHT" row-key="id" stripe empty-text=" ">
            <template #empty>
              <div class="overview-empty-state iso-empty-state">
                <div v-if="loadingIsoImages" class="resource-loading-card resource-table-loading overview-empty-loading">
                  <div class="resource-loader-mark compact" aria-hidden="true">
                    <span class="resource-loader-ring"></span>
                    <VrcLogoMark :grid="false" />
                  </div>
                  <div class="resource-loader-copy">
                    <strong>正在读取系统镜像</strong>
                    <span>{{ selectedHost?.name || selectedStoredConnection?.name || connection.host }}</span>
                  </div>
                  <div class="resource-loader-progress" aria-hidden="true">
                    <i></i>
                    <i></i>
                    <i></i>
                  </div>
                </div>
                <div v-else class="overview-empty-card">
                  <div class="overview-empty-mark" aria-hidden="true">
                    <VrcLogoMark shadow />
                  </div>
                  <strong>{{ isoSearch.trim() ? "未找到匹配 ISO" : "暂无系统镜像" }}</strong>
                  <small>{{ isoEmptyText() }}</small>
                </div>
              </div>
            </template>
            <el-table-column type="index" label="序号" width="58" align="center" />
            <el-table-column prop="name" label="镜像名称" min-width="260" align="left" show-overflow-tooltip />
            <el-table-column label="来源" width="110" align="left">
              <template #default="{ row }">{{ isoSourceLabel(row) }}</template>
            </el-table-column>
            <el-table-column label="ISO 库" min-width="180" align="left" show-overflow-tooltip>
              <template #default="{ row }">
                <span>{{ row.storageRepository || "-" }}</span>
                <small v-if="isoLibraryDescription(row)" class="table-subline">{{ isoLibraryDescription(row) }}</small>
              </template>
            </el-table-column>
            <el-table-column label="大小" width="120" align="right">
              <template #default="{ row }">{{ formatBytes(row.sizeBytes ?? 0) }}</template>
            </el-table-column>
            <el-table-column label="共享" width="76" align="center">
              <template #default="{ row }">{{ row.shared ? "是" : "否" }}</template>
            </el-table-column>
            <el-table-column label="路径" min-width="260" align="left" show-overflow-tooltip>
              <template #default="{ row }">{{ isoLocationText(row) }}</template>
            </el-table-column>
          </el-table>
        </div>
      </el-dialog>

      <VmProvisioningDialog
        :key="`provisioning-${ipPoolPolicyRevision}-${provisioningDialogSession}`"
        v-model:visible="provisioningVisible"
        :connection="{ id: selectedConnectionId, providerType: connection.providerType, host: connection.host, port: connection.port, username: connection.username, password: persistentConnectionsEnabled ? undefined : connection.password }"
        :host="selectedHost"
        :networks="selectedHostNetworks"
        :vms="vms?.items ?? []"
        :reserved-ips="provisioningReservedIps"
        :storage-totals="storageTotals"
        :storage-display-mode="uiPreferences.storageDisplayMode"
        :storage-pool-highlights="storagePoolHighlightItems"
        :submitting="provisioningSubmitting"
        :progress="provisioningProgress"
        :provision-task="activeProvisionTask"
        :console-available="activeProvisionConsoleAvailable"
        :console-target="provisionInlineConsoleTarget"
        :provision-console-targets="activeProvisionConsoleTargets"
        :terminal-font-family="currentConsoleFont.family"
        :terminal-font-size="uiPreferences.consoleFontSize"
        :terminal-line-height="uiPreferences.consoleLineHeight"
        :terminal-cursor-style="uiPreferences.consoleCursorStyle"
        :terminal-cursor-blink="uiPreferences.consoleCursorBlink"
        :terminal-theme="consoleTerminalTheme"
        :display-scale-mode="uiPreferences.consoleScaleMode"
        :display-quality="uiPreferences.consoleQuality"
        :throttle-resize="uiPreferences.throttleConsoleResize"
        :watermark-enabled="uiPreferences.consoleWatermarkEnabled && uiPreferences.consoleWatermarkScope === 'console'"
        :watermark-density="uiPreferences.consoleWatermarkDensity"
        :watermark-opacity="uiPreferences.consoleWatermarkOpacity"
        :watermark-text="consoleWatermarkText"
        @activity="pushActivity($event.title, { target: $event.target, detail: $event.detail, status: $event.status })"
        @open-iso-detail="openIsoDetail"
        @select-console-target="handleSelectProvisionInlineConsoleTarget"
        @submit="handleProvisioningSubmit"
      />
      <VmScheduleDialog
        v-model:visible="vmScheduleVisible"
        :initial-view="vmScheduleInitialView"
        :connection="{ id: selectedConnectionId, providerType: connection.providerType, name: selectedStoredConnection?.name }"
        :host="selectedHost"
        :available-vms="vms?.items ?? []"
        :selected-vms="vmScheduleSelectedVms"
        :show-icon-tooltips="uiPreferences.showIconTooltips"
        @changed="handleVmScheduleChanged"
      />
    </section>
    <input
      ref="appearanceImageFileInput"
      class="appearance-hidden-input"
      type="file"
      accept="image/jpeg,image/png,image/webp"
      @change="handleAppearanceImageChange"
    />
    <input
      ref="appearanceJsonFileInput"
      class="appearance-hidden-input"
      type="file"
      accept="application/json,.json"
      @change="handleAppearanceJsonChange"
    />
    <input
      ref="ipPoolsJsonFileInput"
      class="appearance-hidden-input"
      type="file"
      accept="application/json,.json"
      @change="handleIpPoolsJsonChange"
    />
  </main>
</template>
