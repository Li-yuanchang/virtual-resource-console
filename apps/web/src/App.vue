<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { ArrowLeft, Brush, Check, Connection, Delete, Download, Loading, Picture, Plus, Refresh, RefreshLeft, Search, Setting, Tickets, Upload } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import ConsoleDialog from "./components/ConsoleDialog.vue";
import HostVmPanel from "./components/HostVmPanel.vue";
import VrcToolbarIcon from "./components/VrcToolbarIcon.vue";
import VmProvisioningDialog from "./components/VmProvisioningDialog.vue";
import { resolveVmConsoleTarget, type VmConsoleTarget } from "./domain/consoleStrategies";
import { getProviderBrand } from "./domain/providerBrand";
import type {
  HostsResponse,
  IpLeaseReservationResponse,
  IsoImage,
  IsoImagesResponse,
	  ProviderType,
	  PowerState,
	  StoredConnectionSummary,
  VmInventorySummary,
  VmNode,
  VmPowerAction,
  VmCreateRequest,
  VmProvisionCreatedVm,
  VmProvisionResponse,
  ProvisionPreflightCheck,
  ProvisionPreflightResponse,
  ProvisionTask,
  ProvisionTaskResponse,
  VmsResponse,
} from "./types";

type HostNodeItem = HostsResponse["hosts"][number];

interface HostOverviewRow {
  key: string;
  connection: StoredConnectionSummary;
  inventory: HostsResponse;
  host: HostNodeItem;
  summary: VmInventorySummary | null;
  status: "loading" | "ready" | "error";
  error?: string;
}

interface VmSearchCacheEntry {
  items: VmNode[];
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
  };
}

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
  status: "running" | "success" | "error";
}

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
  status: "info" | "pending" | "success" | "warning" | "error";
}

interface ConsoleUploadResultEvent {
  vmName: string;
  vmIp: string;
  status: "success" | "error";
  message: string;
  files: string[];
  remotePaths: string[];
}

type ActivityStatusFilter = "all" | ActivityEntry["status"];
type UiTheme = "graphite-sage" | "basalt-copper" | "mist-teal";
type UiToneMode = "system" | "light" | "dark";
type UiBackgroundMode = "default" | "solid" | "image";
type WorkspaceMode = "empty" | "overview" | "connection" | "settings";
type SettingsPanel = "appearance" | "connection" | "templates" | "logs";
type VmPowerFilter = "all" | "running" | "stopped";
type AccountImportMode = "excel" | "json" | "fixed";
type AccountImportStatus = "new" | "update" | "error";

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

interface AppearanceImportConfig {
  [key: string]: unknown;
  baseTheme?: unknown;
  theme?: unknown;
  toneMode?: unknown;
  colors?: Record<string, unknown>;
  background?: Record<string, unknown>;
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

const VM_SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const VRC_TOAST_DURATION_MS = 3000;
const activityStatusOptions: ActivityStatusFilter[] = ["all", "pending", "success", "warning", "error", "info"];
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
];
const accentColorPresets = ["#426b57", "#2f6f68", "#315f92", "#6a5b88", "#9b5f35", "#8a4f5d"];
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
};
const defaultConnectionPreferences: ConnectionPreferences = {
  selectedConnectionId: localStorage.getItem("vrc.connectionId") || "",
  providerType: normalizeProviderType(localStorage.getItem("vrc.providerType")),
  host: localStorage.getItem("vrc.host") || "",
  port: Number(localStorage.getItem("vrc.port") || defaultPortForProvider(normalizeProviderType(localStorage.getItem("vrc.providerType")))),
  username: localStorage.getItem("vrc.username") || "root",
  connectionName: "",
};

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
const storedConnections = ref<StoredConnectionSummary[]>([]);
const selectedConnectionId = ref(defaultConnectionPreferences.selectedConnectionId);
const connectionName = ref(defaultConnectionPreferences.connectionName);
const connectionSearch = ref("");
const showConnectionEditor = ref(true);
const showActivityPanel = ref(false);
const activityLogVisible = ref(false);
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
const appearanceImageUploading = ref(false);
const vmDetailVisible = ref(false);
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
const isoDetailVisible = ref(false);
const loadingIsoImages = ref(false);
const isoImages = ref<IsoImage[]>([]);
const isoSearch = ref("");
const provisioningVisible = ref(false);
const provisioningSubmitting = ref(false);
const provisioningProgress = ref<ProvisioningProgressState | null>(null);
const activeProvisionTask = ref<ProvisionTask | null>(null);
const hostDetailVisible = ref(false);
const selectedVmIds = ref<string[]>([]);
const hostOverviewRows = ref<HostOverviewRow[]>([]);
const loadingHostOverview = ref(false);
const selectedHostOverviewKey = ref("");
const workspaceMode = ref<WorkspaceMode>("empty");
const settingsPanel = ref<SettingsPanel>("appearance");
const hostOverviewSearch = ref("");
const hostOverviewMatchMode = ref<"exact" | "fuzzy">("exact");
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
let activitySeq = 0;
let lastErrorToast = "";
let lastErrorToastAt = 0;
let vmSearchTimer: ReturnType<typeof setTimeout> | undefined;
let connectionPreferenceSaveTimer: ReturnType<typeof setTimeout> | undefined;
let appearanceMediaQuery: MediaQueryList | undefined;
const provisioningPollTimers = new Map<string, ReturnType<typeof setTimeout>>();
const provisioningTaskMarks = new Map<string, string>();
const provisioningEventSources = new Map<string, EventSource>();
const provisioningTaskPayloads = new Map<string, VmCreateRequest>();

const hosts = computed(() => inventory.value?.hosts ?? []);
const storage = computed(() => inventory.value?.storage ?? []);
const networks = computed(() => inventory.value?.networks ?? []);
const selectedHost = computed(() => hosts.value.find((host) => host.providerId === selectedHostId.value) ?? hosts.value[0] ?? null);
const selectedHostNetworks = computed(() => networks.value.filter((item) => !selectedHost.value || !item.hostId || item.hostId === selectedHost.value.providerId));
const selectedStoredConnection = computed(() => storedConnections.value.find((item) => item.id === selectedConnectionId.value) ?? null);
const selectedConnectionBrand = computed(() => getProviderBrand(selectedStoredConnection.value?.providerType ?? connection.providerType));
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
    ? `[{"平台":"XenServer","主机":"192.0.2.77","服务器名称":"xenserver-1","登录账号":"root","登录密码":"change-me"}]`
    : "XenServer 192.0.2.77 xenserver-1 root change-me\nXenServer 192.0.2.6 xenserver-3 change-me",
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
  () => [activeProvisionTask.value?.id, activeProvisionConsoleTargets.value.map((item) => item.target?.vmId || item.key).join("|")] as const,
  () => {
    if (!activeProvisionTask.value) {
      provisionInlineConsoleTarget.value = null;
      return;
    }
    const targets = activeProvisionConsoleTargets.value;
    const currentVmId = provisionInlineConsoleTarget.value?.vmId;
    if (currentVmId && targets.some((item) => item.target?.vmId === currentVmId)) return;
    provisionInlineConsoleTarget.value = targets.find((item) => item.target)?.target ?? null;
  },
  { immediate: true },
);
const showWorkspacePlaceholder = computed(
  () => workspaceMode.value === "empty" && !loadingHosts.value && !inventory.value && !hostOverviewRows.value.length && !loadingHostOverview.value,
);
const isOverviewNavActive = computed(() => workspaceMode.value === "overview" && (hostOverviewRows.value.length > 0 || loadingHostOverview.value));
const isSettingsNavActive = computed(() => workspaceMode.value === "settings");
const settingsTitle = computed(() => {
  if (settingsPanel.value === "connection") return "设置 / 连接";
  if (settingsPanel.value === "templates") return "设置 / 创建模板";
  if (settingsPanel.value === "logs") return "设置 / 日志";
  return "设置 / 外观";
});
const settingsDescription = computed(() => {
  if (settingsPanel.value === "connection") return "保存、测试和选择虚拟化平台连接，左侧列表仍作为主切换入口。";
  if (settingsPanel.value === "templates") return "创建模板只做归档入口，真实模板能力仍以创建虚拟机弹框为准。";
  if (settingsPanel.value === "logs") return "查看当前会话操作记录，持久化审计后续单独接入。";
  return "主题、按钮密度、表格密度和控制台偏好统一归档，不混入 VM 工具栏。";
});
const settingsBackLabel = computed(() => (hostOverviewRows.value.length || loadingHostOverview.value ? "返回总览" : "关闭设置"));
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
const filteredActivityEntries = computed(() => {
  const keyword = activitySearch.value.trim().toLowerCase();
  return activityEntries.value.filter((item) => {
    if (activityStatusFilter.value !== "all" && item.status !== activityStatusFilter.value) return false;
    if (!keyword) return true;
    return [item.time, item.title, item.target ?? "", item.detail ?? "", activityStatusLabel(item.status)].join(" ").toLowerCase().includes(keyword);
  });
});
const filteredIsoImages = computed(() => {
  const keyword = isoSearch.value.trim().toLowerCase();
  return isoImages.value.filter((item) => {
    if (!keyword) return true;
    return [item.name, item.storageRepository, isoLibraryDescription(item), item.path ?? "", item.providerId].join(" ").toLowerCase().includes(keyword);
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
  const storagePhysical = storage.value.reduce((sum, sr) => sum + positive(sr.physicalGiB), 0);
  const storageUsed = storage.value.reduce((sum, sr) => sum + positive(sr.usedGiB), 0);
  return {
    memoryUsedBytes: memoryUsed,
    memoryPercent: percent(memoryUsed, host.memoryTotalBytes),
    storagePercent: percent(storageUsed, storagePhysical),
  };
});

const storageTotals = computed(() => {
  const physicalGiB = storage.value.reduce((sum, sr) => sum + positive(sr.physicalGiB), 0);
  const usedGiB = storage.value.reduce((sum, sr) => sum + positive(sr.usedGiB), 0);
  const virtualGiB = storage.value.reduce((sum, sr) => sum + positive(sr.virtualGiB), 0);
  return {
    physicalGiB,
    usedGiB,
    virtualGiB,
    usagePercent: percent(usedGiB, physicalGiB),
  };
});

const vmTotals = computed(() => {
  if (!vms.value && vmSummary.value) {
    return {
      all: vmSummary.value.total,
      running: vmSummary.value.running,
      halted: vmSummary.value.halted,
      vcpu: vmSummary.value.vcpu,
      runningVcpu: vmSummary.value.runningVcpu ?? vmSummary.value.vcpu,
      memoryBytes: vmSummary.value.memoryBytes,
      runningMemoryBytes: vmSummary.value.runningMemoryBytes ?? vmSummary.value.memoryBytes,
      diskBytes: vmSummary.value.diskBytes ?? null,
    };
  }
  const items = vms.value?.items ?? [];
  const runningItems = items.filter((vm) => vm.powerState === "running");
  return {
    all: vms.value?.total ?? items.length,
    running: runningItems.length,
    halted: items.filter((vm) => vm.powerState === "halted").length,
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
  const storageTotalGiB = storageTotals.value.physicalGiB;
  const storageUsedGiB = storageTotals.value.usedGiB;

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
      free: Math.max(storageTotalGiB - storageUsedGiB, 0),
      over: 0,
      total: storageTotalGiB,
      headline: `${formatNumber(storageUsedGiB)} / ${formatNumber(storageTotalGiB)} GiB`,
      subline: `剩余 ${formatNumber(Math.max(storageTotalGiB - storageUsedGiB, 0))} GiB · 虚拟分配 ${formatNumber(storageTotals.value.virtualGiB)} GiB`,
      percent: percent(storageUsedGiB, storageTotalGiB),
    },
  ];
});

const filteredVms = computed(() => {
  const keyword = search.value.trim().toLowerCase();
  return (vms.value?.items ?? [])
    .filter((vm) => vmMatchesPowerFilter(vm, vmPowerFilter.value))
    .filter((vm) => !keyword || vmMatchesKeyword(vm, selectedHost.value?.address, keyword))
    .sort(compareVmByIp);
});
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
  const storageTight = readyRows.filter((row) => {
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

const overviewSearchKeyword = computed(() => hostOverviewSearch.value.trim().toLowerCase());
const filteredHostOverviewRows = computed(() => {
  const keyword = overviewSearchKeyword.value;
  if (!keyword) return hostOverviewRows.value;
  return hostOverviewRows.value.filter((row) => rowMatchesOverviewKeyword(row, keyword));
});

const sortedHostOverviewRows = computed(() =>
  [...filteredHostOverviewRows.value].sort((left, right) =>
    left.host.name.localeCompare(right.host.name, "zh-CN", { numeric: true, sensitivity: "base" }),
  ),
);

const vmSearchLoadingCount = computed(() => Object.values(vmSearchCache.value).filter((entry) => entry.loading).length);
const vmSearchSettledCount = computed(() => hostOverviewRows.value.filter((row) => hasSettledVmSearchCache(row)).length);
const overviewVmSearchLoading = computed(() => {
  const keyword = overviewSearchKeyword.value;
  if (!shouldSearchVmIp(keyword)) return false;
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
      detail: `缓存 ${vmSearchSettledCount.value} / ${total} · ${overviewSearchKeyword.value}`,
    };
  }
  if (overviewSearchKeyword.value) {
    return {
      mode: "empty",
      title: "未找到匹配资源",
      detail: `没有命中物理机 IP 或 VM IP：${overviewSearchKeyword.value}`,
    };
  }
  return {
    mode: "empty",
    title: "暂无物理机数据",
    detail: "点击左侧资源总览加载物理机清单",
  };
});
const vmSearchStatusText = computed(() => {
  const keyword = overviewSearchKeyword.value;
  if (!keyword) return "";
  if (!shouldSearchVmIp(keyword)) return `本地匹配 ${filteredHostOverviewRows.value.length} / ${hostOverviewRows.value.length} 台`;
  const total = hostOverviewRows.value.filter(hasOverviewInventory).length;
  const cached = vmSearchSettledCount.value;
  if (overviewVmSearchLoading.value) return `VM IP 缓存 ${cached} / ${total} · 加载中`;
  return `VM IP 匹配 ${filteredHostOverviewRows.value.length} / ${hostOverviewRows.value.length} 台 · 缓存 ${cached} / ${total}`;
});
const resolvedAppearanceDark = computed(() => uiPreferences.toneMode === "dark" || (uiPreferences.toneMode === "system" && systemDark.value));
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

onMounted(async () => {
  appearanceMediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  systemDark.value = appearanceMediaQuery.matches;
  appearanceMediaQuery.addEventListener("change", handleAppearanceMediaChange);
  await loadAppPreferences();
  await loadStoredConnections();
  if (selectedConnectionId.value && storedConnections.value.some((item) => item.id === selectedConnectionId.value)) {
    applyStoredConnection(selectedConnectionId.value);
  } else if (selectedConnectionId.value) {
    selectedConnectionId.value = "";
    void saveConnectionPreferences(buildConnectionPreferencesFromState());
  }
  if (storedConnections.value.length) {
    await loadHostOverview();
  }
});

onBeforeUnmount(() => {
  appearanceMediaQuery?.removeEventListener("change", handleAppearanceMediaChange);
  if (connectionPreferenceSaveTimer) clearTimeout(connectionPreferenceSaveTimer);
  for (const timer of provisioningPollTimers.values()) clearTimeout(timer);
  provisioningPollTimers.clear();
  for (const source of provisioningEventSources.values()) source.close();
  provisioningEventSources.clear();
});

watch(hostOverviewSearch, (value) => {
  if (vmSearchTimer) clearTimeout(vmSearchTimer);
  const keyword = value.trim().toLowerCase();
  if (!shouldSearchVmIp(keyword)) return;
  vmSearchTimer = setTimeout(() => {
    void ensureVmSearchCacheForKeyword(keyword);
  }, 350);
});

watch(vmDetailVisible, (visible) => {
  if (!visible && hostOverviewRows.value.length && workspaceMode.value === "connection") {
    workspaceMode.value = "overview";
    selectedHostOverviewKey.value = "";
  }
});

watch(vmPowerFilter, () => {
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

function normalizeTheme(value?: string | null): UiTheme {
  return value === "basalt-copper" || value === "mist-teal" || value === "graphite-sage" ? value : "graphite-sage";
}

function normalizeProviderType(value?: string | null): ProviderType {
  return value === "vmware" || value === "proxmox" || value === "libvirt" || value === "xenserver" ? value : "xenserver";
}

async function loadAppPreferences() {
  try {
    const result = await postJson<{ preferences: Partial<AppPreferences> }>("/api/preferences", undefined, "GET");
    const connectionPreferences = shouldUseLegacyConnectionPreferences(result.preferences.connection)
      ? defaultConnectionPreferences
      : result.preferences.connection;
    applyUiPreferences(result.preferences.ui ?? defaultUiPreferences);
    applyConnectionPreferences(connectionPreferences ?? defaultConnectionPreferences);
    if (connectionPreferences === defaultConnectionPreferences && hasLegacyConnectionPreferences()) {
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
  applyThemeToDocument(uiPreferences.theme);
  applyAppearanceToDocument();
  document.documentElement.dataset.iconTooltips = String(uiPreferences.showIconTooltips);
  document.documentElement.dataset.truncateLongNames = String(uiPreferences.truncateLongNames);
  document.documentElement.dataset.consoleResizeThrottle = String(uiPreferences.throttleConsoleResize);
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
  style.setProperty("--vrc-accent", uiPreferences.accentColor);
  style.setProperty("--vrc-accent-hover", `color-mix(in srgb, ${uiPreferences.accentColor} 82%, black)`);
  style.setProperty("--vrc-accent-soft", `color-mix(in srgb, ${uiPreferences.accentColor} 13%, var(--vrc-surface))`);
  style.setProperty("--vrc-success", uiPreferences.successColor);
  style.setProperty("--vrc-warning", uiPreferences.warningColor);
  style.setProperty("--vrc-danger", uiPreferences.dangerColor);
  style.setProperty("color-scheme", resolvedAppearanceDark.value ? "dark" : "light");
  document.documentElement.dataset.tone = resolvedAppearanceDark.value ? "dark" : "light";

  const darkThemeVariables: Record<string, string> = {
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
  };
  for (const [name, value] of Object.entries(darkThemeVariables)) {
    if (resolvedAppearanceDark.value) style.setProperty(name, value);
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

function persistAppearanceNumber(key: "backgroundOpacity" | "backgroundBlur" | "backgroundOverlay") {
  persistAppearancePreference(key);
}

function persistAppearancePreference<K extends keyof UiPreferences>(key: K) {
  applyAppearanceToDocument();
  void saveUiPreferences({ [key]: uiPreferences[key] } as Partial<UiPreferences>);
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

function shouldUseLegacyConnectionPreferences(preferences?: Partial<ConnectionPreferences>) {
  if (!hasLegacyConnectionPreferences()) return false;
  if (!preferences) return true;
  return !preferences.selectedConnectionId && !preferences.host && normalizeProviderType(preferences.providerType) === "xenserver";
}

function openSettingsWorkspace() {
  workspaceMode.value = "settings";
  settingsPanel.value = "appearance";
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
    workspaceMode.value = "overview";
    selectedHostOverviewKey.value = "";
    return;
  }
  workspaceMode.value = inventory.value ? "connection" : "empty";
}

async function loadStoredConnections() {
  try {
    const result = await postJson<{ connections: StoredConnectionSummary[] }>("/api/connections", undefined, "GET");
    storedConnections.value = result.connections ?? [];
  } catch (error) {
    setErrorMessage(error instanceof Error ? error.message : "读取保存连接失败", false);
  }
}

function applyStoredConnection(connectionId: string) {
  const stored = storedConnections.value.find((item) => item.id === connectionId);
  if (!stored) return;
  clearConnectionFeedback();
  selectedConnectionId.value = stored.id;
  connection.providerType = stored.providerType;
  connection.host = stored.host;
  connection.port = stored.port;
  connection.username = stored.username;
  connection.password = "";
  connectionName.value = stored.name;
  showConnectionEditor.value = false;
  void saveConnectionPreferences(buildConnectionPreferencesFromState());
  pushActivity("选择连接", {
    target: stored.name,
    detail: `${providerLabel(stored.providerType)} · ${stored.host}:${stored.port}`,
    status: "info",
  });
}

async function selectConnectionAndLoad(connectionId: string) {
  workspaceMode.value = "connection";
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
  clearConnectionFeedback();
  selectedConnectionId.value = "";
  connectionName.value = "";
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
    const result = await postJson<{ connection: StoredConnectionSummary }>("/api/connections", {
      ...direct,
      id: selectedConnectionId.value || undefined,
      name: connectionName.value.trim() || `${direct.providerType}:${direct.host}`,
    });
    selectedConnectionId.value = result.connection.id;
    await loadStoredConnections();
    applyStoredConnection(result.connection.id);
    setConnectionSuccessMessage(`连接已保存：${result.connection.name}。下次可直接加载资源。`);
    pushActivity("保存连接", {
      target: result.connection.name,
      detail: `${providerLabel(result.connection.providerType)} · ${result.connection.host}:${result.connection.port}`,
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
    await postJson(`/api/connections/${selectedConnectionId.value}`, undefined, "DELETE");
    selectedConnectionId.value = "";
    void saveConnectionPreferences(buildConnectionPreferencesFromState());
    await loadStoredConnections();
    setConnectionSuccessMessage("保存的连接已删除。");
    pushActivity("删除连接", {
      target: deletedConnection?.name || "保存连接",
      detail: deletedConnection ? `${providerLabel(deletedConnection.providerType)} · ${deletedConnection.host}:${deletedConnection.port}` : "本地连接配置已删除",
      status: "warning",
    });
  } catch (error) {
    setConnectionErrorMessage(error instanceof Error ? error.message : "删除连接失败");
  }
}

async function loadSelectedConnectionResources() {
  if (!selectedConnectionId.value) {
    showConnectionEditor.value = true;
    setConnectionErrorMessage("还没有保存连接。请先填写 Host、用户名和密码，点“保存”，之后就能加载资源。");
    return;
  }
  clearConnectionFeedback();
  await loadHostInventory();
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

function triggerAccountImportFile() {
  accountImportFileInput.value?.click();
}

function downloadAccountImportTemplate() {
  const rows = [
    ["平台", "主机", "服务器名称", "登录账号", "登录密码", "端口"],
    ["XenServer", "192.0.2.77", "xenserver-1", "root", "change-me", "22"],
    ["VMware", "192.0.2.27", "vmware-27", "root", "change-me", "443"],
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
      await postJson<{ connection: StoredConnectionSummary }>("/api/connections", {
        id: row.matchedId,
        name: row.name,
        providerType: row.providerType,
        host: row.host,
        port: row.port,
        username: row.username,
        password: row.password,
      });
    }
    const shouldRefreshSelectedConnection = rows.some((row) => row.matchedId && row.matchedId === selectedConnectionId.value);
    await loadStoredConnections();
    if (shouldRefreshSelectedConnection && selectedConnectionId.value) {
      applyStoredConnection(selectedConnectionId.value);
    }
    accountImportVisible.value = false;
    setConnectionSuccessMessage(`连接测试全部通过，已导入 ${rows.length} 个服务器账号，其中 ${rows.filter((row) => row.status === "update").length} 个覆盖更新。`);
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

async function loadHostOverview() {
  clearMessages();
  const requestId = ++hostOverviewRequestSeq;
  workspaceMode.value = "overview";
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
    status: "pending",
  });

  void runLimited(connections, 5, async (item) => {
    if (requestId !== hostOverviewRequestSeq) return;
    try {
      const hostInventory = await postJson<HostsResponse>("/api/inventory/hosts", {
        connectionId: item.id,
        providerType: item.providerType,
      });
      if (requestId !== hostOverviewRequestSeq) return;
      const rows = hostInventory.hosts.map((host, index) => ({
        key: index === 0 ? item.id : `${item.id}:${host.providerId}`,
        connection: item,
        inventory: hostInventory,
        host,
        summary: null,
        status: "loading" as const,
      }));
      replaceHostOverviewRows(item.id, rows.length ? rows : [createFallbackOverviewRow(item, "error", "未读取到物理机")]);
      for (const row of rows) {
        void loadHostOverviewSummary(row, requestId);
      }
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

async function ensureVmSearchCacheForKeyword(keyword: string, force = false) {
  if (!shouldSearchVmIp(keyword)) return;
  const requestId = ++vmSearchRequestSeq;
  const rows = hostOverviewRows.value.filter(hasOverviewInventory);
  await runLimited(rows, 3, async (row) => {
    if (requestId !== vmSearchRequestSeq) return;
    await loadHostVmSearchCache(row, force);
  });
}

async function refreshVmSearchCache() {
  const keyword = overviewSearchKeyword.value;
  if (!shouldSearchVmIp(keyword)) return;
  await ensureVmSearchCacheForKeyword(keyword, true);
}

async function loadHostVmSearchCache(row: HostOverviewRow, force = false) {
  const existing = vmSearchCache.value[row.key];
  if (!force && existing && Date.now() - existing.updatedAt < VM_SEARCH_CACHE_TTL_MS) return;
  if (existing?.loading) return;

  vmSearchCache.value = {
    ...vmSearchCache.value,
    [row.key]: {
      items: existing?.items ?? [],
      updatedAt: existing?.updatedAt ?? 0,
      loading: true,
    },
  };

  try {
    const result = await postJson<VmsResponse>("/api/inventory/vms", {
      connectionId: row.connection.id,
      providerType: row.connection.providerType,
      hostId: row.host.providerId,
      page: 1,
      pageSize: 500,
    });
    vmSearchCache.value = {
      ...vmSearchCache.value,
      [row.key]: {
        items: result.items,
        updatedAt: Date.now(),
        loading: false,
      },
    };
  } catch (error) {
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

async function loadHostOverviewSummary(row: HostOverviewRow, requestId = hostOverviewRequestSeq) {
  if (!hasOverviewInventory(row)) return;
  try {
    const result = await postJson<{ summary: VmInventorySummary }>("/api/inventory/vm-summary", {
      connectionId: row.connection.id,
      providerType: row.connection.providerType,
      hostId: row.host.providerId,
      page: 1,
      pageSize: 500,
    });
    if (requestId !== hostOverviewRequestSeq) return;
    updateHostOverviewRow(row.key, {
      summary: result.summary,
      status: "ready",
    });
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
      status: "success",
    });
  } catch (error) {
    setConnectionErrorMessage(error instanceof Error ? error.message : "测试连接失败");
    pushActivity("连接测试失败", {
      target: connection.host,
      detail: errorMessage.value,
      status: "error",
    });
  } finally {
    testing.value = false;
  }
}

async function openHostOverview(row: HostOverviewRow) {
  if (!hasOverviewInventory(row)) return;
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
  vmSummary.value = row.summary;
  const keyword = overviewSearchKeyword.value;
  search.value = keyword && vmSearchMatches(row).length > 0 ? keyword : "";
  vmPowerFilter.value = "all";
  selectedVmIds.value = [];
  vms.value = null;
  loadingVms.value = true;
  pushActivity("打开物理机", {
    target: row.host.name,
    detail: `${providerLabel(row.connection.providerType)} · ${row.host.address}`,
    status: "info",
  });
  void loadVms({ silent: true });
}

async function loadHostInventory() {
  const payload = buildConnectionPayload();
  if (!payload) return;
  workspaceMode.value = "connection";
  loadingHosts.value = true;
  clearMessages();
  persistConnection(payload);

  try {
    inventory.value = await postJson<HostsResponse>("/api/inventory/hosts", payload);
    selectedHostId.value = inventory.value.hosts[0]?.providerId ?? "";
    resetIsoImages();
    prepareVmPanelForHostLoad(!!selectedHostId.value);
    pushActivity("加载物理机", {
      target: selectedStoredConnection.value?.name || connection.host,
      detail: `${inventory.value.hosts.length} 台物理机`,
      status: "success",
    });
    if (selectedHostId.value) {
      void loadVmSummary({ silent: true });
      void loadVms({ silent: true });
    }
  } catch (error) {
    loadingVms.value = false;
    loadingVmSummary.value = false;
    setErrorMessage(error instanceof Error ? error.message : "读取物理机失败");
    pushActivity("读取物理机失败", {
      target: selectedStoredConnection.value?.name || connection.host,
      detail: errorMessage.value,
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
  vms.value = null;
  vmSummary.value = null;
  selectedVmIds.value = [];
  vmPowerFilter.value = "all";
  loadingVms.value = hasHost;
  if (!hasHost) loadingVmSummary.value = false;
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

async function loadVmSummary(options: { silent?: boolean } = {}) {
  const payload = buildConnectionPayload();
  if (!payload || !selectedHost.value) return;
  loadingVmSummary.value = true;
  if (!options.silent) clearMessages();

  try {
    const result = await postJson<{ summary: VmInventorySummary }>("/api/inventory/vm-summary", {
      ...payload,
      hostId: selectedHost.value.providerId,
      page: 1,
      pageSize: 500,
    });
    vmSummary.value = result.summary;
    pushActivity("加载 VM 汇总", {
      target: selectedHost.value.name,
      detail: `运行 ${result.summary.running} / 共 ${result.summary.total} 台`,
      status: "success",
    });
  } catch (error) {
    setErrorMessage(error instanceof Error ? error.message : "读取 VM 汇总失败");
    pushActivity("读取 VM 汇总失败", {
      target: selectedHost.value.name,
      detail: errorMessage.value,
      status: "error",
    });
  } finally {
    loadingVmSummary.value = false;
  }
}

async function loadVms(options: { silent?: boolean; background?: boolean } = {}) {
  const payload = buildConnectionPayload();
  if (!payload || !selectedHost.value) return;
  const showLoading = !options.background || !vms.value?.items.length;
  if (showLoading) loadingVms.value = true;
  if (!options.silent) clearMessages();
  const keyword = search.value.trim();
  const serverKeyword = shouldSearchVmIp(keyword.toLowerCase()) ? undefined : keyword || undefined;

  try {
    vms.value = await postJson<VmsResponse>("/api/inventory/vms", {
      ...payload,
      hostId: selectedHost.value.providerId,
      page: 1,
      pageSize: serverKeyword ? 200 : 500,
      keyword: serverKeyword,
    });
    vmSummary.value = summarizeVms(vms.value.items, vms.value.total);
    if (!options.silent) {
      successMessage.value = `VM 清单已加载：${vms.value.items.length} / ${vms.value.total} 台。`;
    }
    if (!options.background) {
      pushActivity("加载 VM 清单", {
        target: selectedHost.value.name,
        detail: `${vms.value.items.length} / ${vms.value.total} 台`,
        status: "success",
      });
    }
    syncSelectedVmSearchCacheFromCurrentList();
  } catch (error) {
    setErrorMessage(error instanceof Error ? error.message : "读取 VM 失败");
    pushActivity("读取 VM 失败", {
      target: selectedHost.value.name,
      detail: errorMessage.value,
      status: "error",
    });
  } finally {
    if (showLoading) loadingVms.value = false;
  }
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
    status: "pending",
  });
  try {
    const result = await postJson<IsoImagesResponse>("/api/inventory/iso-images", {
      ...payload,
      hostId: selectedHost.value.providerId,
      forceRefresh: force,
    });
    isoImages.value = result.images;
    pushActivity(result.source === "cache" ? "系统镜像缓存已加载" : "系统镜像读取完成", {
      target: selectedHost.value.name,
      detail: result.refreshing ? `${result.images.length} 个 ISO · 后台刷新中` : `${result.images.length} 个 ISO`,
      status: "success",
    });
  } catch (error) {
    setErrorMessage(error instanceof Error ? error.message : "读取系统镜像失败");
    pushActivity("读取系统镜像失败", {
      target: selectedHost.value.name,
      detail: errorMessage.value,
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
  if (connection.providerType === "xenserver") return "未读取到 XenServer ISO SR 下的 ISO，请确认 XenCenter 里已附加 NFS/SMB ISO Library。";
  if (connection.providerType === "vmware") return "未在 Datastore Browser 中搜索到 ISO，请确认数据存储权限和镜像目录。";
  if (connection.providerType === "proxmox") return "未读取到 PVE content=iso 的存储内容，请确认存储启用了 ISO 镜像内容类型。";
  return "当前平台没有返回 ISO 清单，或账号没有存储内容读取权限。";
}

async function openProvisioningDialog() {
  if (!provisioningSubmitting.value) {
    provisioningProgress.value = null;
    activeProvisionTask.value = null;
  }
  provisioningVisible.value = true;
}

async function handleProvisioningSubmit(payload: VmCreateRequest) {
  const target = selectedHost.value?.name || payload.hostId || connection.host;
  const detail = `${providerLabel(payload.providerType)} · ${payload.sourceType === "iso" ? "ISO" : "克隆源"} · ${payload.count} 台`;
  let keepSubmittingForTask = false;
  const installModeText =
    payload.providerType === "xenserver"
      ? "将创建 VM、虚拟硬盘、网卡，挂载系统 ISO，写入无人值守安装参数，并开机打开控制台。"
      : payload.providerType === "vmware" && payload.sourceType === "iso"
        ? "将创建 VMware VM、虚拟硬盘和网卡，挂载 ESXi 原版 ISO 与任务级 Kickstart ISO，并启动无人值守安装。"
      : payload.sourceType === "template"
        ? "将按克隆源生成 VM，写入 CPU、内存、磁盘和静态 IP，并启动打开控制台。"
        : "将创建 VM 并挂载 ISO。该模式不会自动装好系统。";
  try {
    await confirmVrcAction({
      heading: "创建虚拟机",
      tone: "资源校验",
      summary: `${target} · ${payload.count} 台`,
      detail: `${installModeText}\n确认后会先执行资源预检。`,
      confirmButtonText: "确认创建",
    });
  } catch (error) {
    if (error !== "cancel" && error !== "close") {
      setErrorMessage(error instanceof Error ? error.message : "创建确认失败");
      pushActivity("创建确认失败", {
        target,
        detail: errorMessage.value,
        status: "error",
      });
    } else {
      pushActivity("取消创建虚拟机", {
        target,
        detail,
        status: "warning",
      });
    }
    return;
  }

  clearMessages();
  activeProvisionTask.value = null;
  provisioningProgress.value = {
    title: "创建预检",
    message: "正在检查宿主机资源、镜像、存储和 IP 占用",
    status: "running",
  };
  provisioningSubmitting.value = true;
  loadingVms.value = true;
  try {
    const preflight = await postJson<ProvisionPreflightResponse>("/api/provisioning/preflight", payload);
    const blockingChecks = preflight.checks.filter((check) => check.status === "error");
    if (blockingChecks.length) {
      const detailText = formatProvisionPreflightChecks(blockingChecks);
      setErrorMessage(detailText);
      showToast("error", "创建预检未通过");
      pushActivity("创建预检未通过", {
        target,
        detail: detailText,
        status: "error",
      });
      provisioningProgress.value = {
        title: "创建预检未通过",
        message: detailText,
        status: "error",
      };
      provisioningSubmitting.value = false;
      loadingVms.value = false;
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
      status: "error",
    });
    provisioningSubmitting.value = false;
    loadingVms.value = false;
    return;
  }

  provisioningProgress.value = {
    title: "提交创建任务",
    message: "正在向虚拟化平台提交创建请求",
    status: "running",
  };
  try {
    const response = await postJson<VmProvisionResponse>("/api/provisioning/vms", {
      ...payload,
      confirmToken: "CONFIRMED",
    });
    successMessage.value = response.result.message;
    if (response.result.taskId || response.task?.id) {
      const taskId = response.result.taskId || response.task?.id || "";
      if (taskId) provisioningTaskPayloads.set(taskId, payload);
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
      await Promise.all([loadVmSummary({ silent: true }), loadVms({ silent: true })]);
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
      status: "error",
    });
  } finally {
    if (!keepSubmittingForTask) {
      provisioningSubmitting.value = false;
      loadingVms.value = false;
    }
  }
}

function formatProvisionPreflightChecks(checks: ProvisionPreflightCheck[]) {
  return checks.map((check) => `${check.label}：${check.message}`).join("；");
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
      loadingVms.value = false;
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
  if (task.status === "success" || task.status === "failed") {
    pushActivity(provisionTaskActivityTitle(task.status), {
      target: task.title,
      detail: task.message,
      status: provisionTaskActivityStatus(task.status),
    });
  }
  activeProvisionTask.value = task;
  if (consoleProvisionTaskId.value === task.id && !consoleTarget.value) {
    openProvisionTaskConsole(task, false);
  }
  provisioningProgress.value = {
    title: provisionTaskActivityTitle(task.status),
    message: task.message,
    status: task.status === "success" ? "success" : task.status === "failed" ? "error" : "running",
  };
  if (task.status === "success") {
    successMessage.value = task.message;
    showToast("success", task.message);
    provisioningSubmitting.value = false;
    loadingVms.value = false;
    const payload = provisioningTaskPayloads.get(task.id);
    if (payload) {
      await reserveProvisioningIpsAfterCreate(payload);
      provisioningTaskPayloads.delete(task.id);
    }
    await Promise.all([loadVmSummary({ silent: true }), loadVms({ silent: true })]);
    syncSelectedOverviewRowAfterVmChange();
  }
  if (task.status === "failed") {
    setErrorMessage(task.message);
    provisioningSubmitting.value = false;
    loadingVms.value = false;
    provisioningTaskPayloads.delete(task.id);
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
  consoleProvisionTaskId.value = "";
  const refreshedVm = vms.value?.items.find((item) => item.providerId === created.providerId || item.id === created.id);
  const consoleVm: VmNode =
    refreshedVm ?? {
      id: created.id,
      connectionId: selectedConnectionId.value,
      hostId: selectedHost.value?.providerId,
      providerId: created.providerId,
      name: created.name,
      powerState: created.powerState,
      cpuCount: 0,
      memoryBytes: 0,
      ipAddresses: created.ip ? [created.ip] : [],
      toolsStatus: "unknown",
      reclaimLevel: "KEEP",
      reclaimReason: "新建虚拟机",
      metadata: connection.providerType === "vmware" ? { managedObjectId: created.providerId } : undefined,
    };
  const target = resolveVmConsoleTarget({
    connection: {
      id: selectedConnectionId.value,
      providerType: connection.providerType,
      host: connection.host,
      port: connection.port,
      username: connection.username,
    },
    vm: { ...consoleVm, powerState: "running" },
    hostName: selectedHost.value?.name,
    hostAddress: selectedHost.value?.address,
  });
  if (!target) {
    showToast("warning", "虚拟机已创建，但当前平台还没有可用控制台入口。");
    return;
  }
  consoleTarget.value = target;
  consoleDialogVisible.value = true;
  pushActivity(`打开控制台：${created.name}`);
}

function resolveProvisionTaskVmConsoleTarget(taskVm: ProvisionTask["vms"][number]): VmConsoleTarget | null {
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
      name: taskVm.name,
      powerState: inferredPowerState,
      cpuCount: 0,
      memoryBytes: 0,
      ipAddresses: taskVm.ip ? [taskVm.ip] : [],
      toolsStatus: "unknown",
      reclaimLevel: "KEEP",
      reclaimReason: "新建虚拟机",
      metadata: connection.providerType === "vmware" ? { managedObjectId: providerId } : undefined,
    };
  return resolveVmConsoleTarget({
    connection: {
      id: selectedConnectionId.value,
      providerType: connection.providerType,
      host: connection.host,
      port: connection.port,
      username: connection.username,
    },
    vm: consoleVm,
    hostName: selectedHost.value?.name,
    hostAddress: selectedHost.value?.address,
  });
}

function openProvisionTaskConsole(task: ProvisionTask, notifyIfUnavailable = true) {
  consoleProvisionTaskId.value = task.id;
  const firstTarget = task.vms.map((vm) => resolveProvisionTaskVmConsoleTarget(vm)).find(Boolean) ?? null;
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

function exportCsv() {
  const rows = filteredVms.value.map((vm) => [
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

function exportHostOverviewCsv() {
  const rows = sortedHostOverviewRows.value.map((row) => {
    const recommendation = hostRecommendation(row);
    return [
      providerLabel(row.connection.providerType),
      row.connection.name,
      row.host.name,
      row.host.address,
      overviewStatusLabel(row),
      overviewCpuMain(row),
      overviewCpuSubline(row),
      overviewMemoryMain(row),
      overviewMemorySubline(row),
      overviewStorageMain(row),
      overviewStorageSubline(row),
      row.summary ? `${row.summary.running} / ${row.summary.total}` : "-",
      recommendation.label,
      recommendation.reason,
      row.error ?? "",
    ];
  });
  const header = ["平台", "连接", "物理机", "管理 IP", "状态", "CPU", "CPU 运行情况", "内存", "内存余量", "存储", "存储余量", "运行 VM / 总 VM", "创建评估", "评估原因", "错误"];
  const csv = [header, ...rows].map((row) => row.map((cell) => `"${String(cell).replaceAll("\"", "\"\"")}"`).join(",")).join("\n");
  const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `vrc-host-overview-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function handleVmSelectionChange(rows: VmNode[]) {
  selectedVmIds.value = rows.map((row) => row.providerId);
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
      detail: vmActionDescription(action, connection.providerType),
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
    status: "pending",
  });
  try {
    const response = await postJson<VmActionResponse>("/api/vms/action", {
      ...payload,
      vmId: vm.providerId,
      action,
      confirmToken: "CONFIRMED",
    });
    if (!response.result.accepted) {
      throw new Error(response.result.message || `VM ${meta.label}请求未被平台接受`);
    }
    if (action === "start") {
      const runningVm = await refreshVmRow(vm, { expectedPowerState: "running" });
      setVmActionState(runningVm, { action, status: "success", message: "已开机" });
      openConsoleAfterStart(runningVm);
    } else if (action === "shutdown") {
      const haltedVm = await refreshVmRow(vm, { expectedPowerState: "halted" });
      setVmActionState(haltedVm, { action, status: "success", message: "已关机" });
    } else {
      successMessage.value = response.result.message;
      showToast("success", response.result.message);
      removeVmRow(vm);
    }
    await refreshSelectedHostResources(action, resourceBaseline);
    pushActivity(`${meta.label}完成`, {
      target: vmTarget,
      detail: vmActionCompleteMessage(action),
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
    status: "pending",
  });

  const failed: string[] = [];
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
        action,
        confirmToken: "CONFIRMED",
      });
	      if (!response.result.accepted) {
	        throw new Error(response.result.message || `VM ${meta.label}请求未被平台接受`);
	      }
	      if (action === "start") {
	        const runningVm = await refreshVmRow(vm, { expectedPowerState: "running" });
	        setVmActionState(runningVm, { action, status: "success", message: "已开机" });
	      } else if (action === "shutdown") {
	        const haltedVm = await refreshVmRow(vm, { expectedPowerState: "halted" });
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
  }

  const summary = `批量${meta.label}完成：成功 ${successCount} 台，失败 ${failed.length} 台`;
  if (failed.length) {
    setErrorMessage(`${summary}；${failed.slice(0, 3).join("；")}`);
    pushActivity(`批量${meta.label}部分失败`, {
      target: hostName,
      detail: failed.slice(0, 6).join("；"),
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
      status: "success",
    });
  }
}

function vmActionKey(vm: VmNode) {
  return vm.providerId || vm.id;
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

function patchVmRow(vm: VmNode, patch: Partial<VmNode>): VmNode {
  const nextVm = { ...vm, ...patch };
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
      });
      const updated = result.items.find((item) => isSameVm(item, vm) || item.name === vm.name);
      if (!updated || !vms.value) continue;
      if (options.expectedPowerState && !matchesExpectedPowerState(updated.powerState, options.expectedPowerState)) {
        continue;
      }
      vms.value = {
        ...vms.value,
        items: vms.value.items.map((item) => (isSameVm(item, vm) ? updated : item)),
      };
      vmSummary.value = summarizeVms(vms.value.items, vms.value.total);
      syncSelectedOverviewRowAfterVmChange();
      return updated;
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

function vmActionCompleteMessage(action: VmPowerAction) {
  if (action === "start") return "已开机";
  if (action === "shutdown") return "已关机";
  return "已删除";
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openConsoleAfterStart(vm: VmNode) {
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
    },
    vm: consoleVm,
    hostName: selectedHost.value?.name,
    hostAddress: selectedHost.value?.address,
  });
  if (!target) {
    showToast("warning", "开机指令已提交，但当前平台还没有可用控制台入口。");
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
        postJson<HostsResponse>("/api/inventory/hosts", payload),
        postJson<{ summary: VmInventorySummary }>("/api/inventory/vm-summary", {
          ...payload,
          hostId,
          page: 1,
          pageSize: 500,
        }),
      ]);
      const refreshedHost = hostInventory.hosts.find((item) => item.providerId === hostId || item.id === hostId);
      if (!refreshedHost) throw new Error("刷新结果中未找到当前物理机");

      inventory.value = hostInventory;
      vmSummary.value = summaryResult.summary;
      const overviewConnectionId = selectedConnectionId.value;
      hostOverviewRows.value = hostOverviewRows.value.map((row) => {
        const sameConnection = !overviewConnectionId || row.connection.id === overviewConnectionId;
        const sameHost = row.host.providerId === hostId || row.host.id === hostId;
        return sameConnection && sameHost
          ? {
              ...row,
              inventory: hostInventory,
              host: refreshedHost,
              summary: summaryResult.summary,
              status: "ready",
              error: undefined,
            }
          : row;
      });

      const current = buildHostResourceFingerprint(refreshedHost, hostInventory.storage, summaryResult.summary);
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
  return {
    total,
    running: runningItems.length,
    halted: items.filter((vm) => vm.powerState === "halted").length,
    vcpu: items.reduce((sum, vm) => sum + vm.cpuCount, 0),
    runningVcpu: runningItems.reduce((sum, vm) => sum + vm.cpuCount, 0),
    memoryBytes: items.reduce((sum, vm) => sum + vm.memoryBytes, 0),
    runningMemoryBytes: runningItems.reduce((sum, vm) => sum + vm.memoryBytes, 0),
    diskBytes: items.reduce((sum, vm) => sum + positive(vm.diskVirtualBytes ?? 0), 0),
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
  const physicalGiB = row.inventory.storage.reduce((sum, sr) => sum + positive(sr.physicalGiB), 0);
  const usedGiB = row.inventory.storage.reduce((sum, sr) => sum + positive(sr.usedGiB), 0);
  const freeGiB = Math.max(physicalGiB - usedGiB, 0);
  return {
    physicalGiB,
    usedGiB,
    freeGiB,
    percent: percent(usedGiB, physicalGiB),
  };
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

function overviewStorageMain(row: HostOverviewRow) {
  if (!hasOverviewInventory(row)) return "-";
  const storagePlan = hostStoragePlan(row);
  return `剩余 ${formatNumber(storagePlan.freeGiB)} GiB`;
}

function overviewStorageSubline(row: HostOverviewRow) {
  if (!hasOverviewInventory(row)) return "读取中";
  const storagePlan = hostStoragePlan(row);
  return `已用 ${formatNumber(storagePlan.usedGiB)} / ${formatNumber(storagePlan.physicalGiB)} GiB`;
}

function overviewResourceMeterPercent(row: HostOverviewRow, type: "cpu" | "memory" | "storage") {
  if (!hasOverviewInventory(row)) return 0;
  const value = type === "cpu" ? hostCpuPlan(row).percent : type === "memory" ? hostMemoryPlan(row).percent : hostStoragePlan(row).percent;
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
  const storagePlan = hostStoragePlan(row);
  return storagePlan.percent >= 80 || storagePlan.freeGiB < 500;
}

function rowMatchesOverviewKeyword(row: HostOverviewRow, keyword: string) {
  if (hostMatchesKeyword(row, keyword)) return true;
  if (!shouldSearchVmIp(keyword)) return false;

  const cache = vmSearchCache.value[row.key];
  if (!cache) return false;
  if (cache.loading && cache.items.length === 0) return false;
  return cache.items.some((vm) => vmMatchesOverviewKeyword(vm, row, keyword));
}

function vmSearchMatches(row: HostOverviewRow) {
  const keyword = overviewSearchKeyword.value;
  if (!shouldSearchVmIp(keyword)) return [];
  const cache = vmSearchCache.value[row.key];
  if (!cache?.items.length) return [];
  return cache.items.filter((vm) => vmMatchesOverviewKeyword(vm, row, keyword));
}

function vmSearchMatchSummary(row: HostOverviewRow) {
  const matches = vmSearchMatches(row);
  if (!matches.length) return "";
  const first = matches[0];
  const ip = displayVmIpForHost(first, row.host.address);
  const more = matches.length > 1 ? ` 等 ${matches.length} 台` : "";
  return `VM 命中：${ip} · ${first.name}${more}`;
}

function vmMatchesOverviewKeyword(vm: VmNode, row: HostOverviewRow, keyword: string) {
  return vmMatchesKeyword(vm, row.host.address, keyword);
}

function hostMatchesKeyword(row: HostOverviewRow, keyword: string) {
  const textFields = [row.connection.name, row.host.name].join(" ").toLowerCase();
  if (textFields.includes(keyword)) return true;
  const hostIps = [row.connection.host, row.host.address].map((item) => item.toLowerCase()).filter(Boolean);
  return hostOverviewMatchMode.value === "exact" ? hostIps.includes(keyword) : hostIps.some((ip) => ip.includes(keyword));
}

function vmMatchesKeyword(vm: VmNode, hostIp: string | undefined, keyword: string) {
  const textFields = [vm.name, vm.providerId, vm.guestOs ?? ""].join(" ").toLowerCase();
  if (textFields.includes(keyword)) return true;
  const ips = vm.ipAddresses.map((item) => item.toLowerCase()).filter(Boolean);
  return hostOverviewMatchMode.value === "exact" ? ips.includes(keyword) : ips.some((ip) => ip.includes(keyword));
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

interface VrcConfirmActionOptions {
  heading: string;
  tone: string;
  summary?: string;
  detail?: string;
  confirmButtonText: string;
  cancelButtonText?: string;
  customClass?: string;
}

function confirmVrcAction(options: VrcConfirmActionOptions) {
  return ElMessageBox.confirm(renderVrcConfirmAction(options), "", {
    confirmButtonText: options.confirmButtonText,
    cancelButtonText: options.cancelButtonText ?? "取消",
    customClass: normalizeVrcConfirmClass(options.customClass),
    distinguishCancelAndClose: true,
    closeOnClickModal: false,
    showClose: false,
  });
}

function normalizeVrcConfirmClass(customClass?: string) {
  const classes = (customClass ?? "").split(/\s+/).filter(Boolean);
  if (!classes.includes("vrc-confirm-message-box")) {
    classes.unshift("vrc-confirm-message-box");
  }
  return classes.join(" ");
}

function renderVrcConfirmAction(options: VrcConfirmActionOptions) {
  return h("section", { class: "vrc-confirm-card" }, [
    h("div", { class: "vrc-confirm-head" }, [h("strong", options.heading), h("span", options.tone)]),
    options.summary ? h("p", { class: "vrc-confirm-summary" }, options.summary) : null,
    options.detail ? h("p", { class: "vrc-confirm-detail" }, options.detail) : null,
  ]);
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

function provisionTaskActivityTitle(status: "pending" | "running" | "success" | "failed") {
  if (status === "success") return "创建链路完成";
  if (status === "failed") return "创建链路失败";
  if (status === "running") return "创建链路执行中";
  return "创建链路排队中";
}

function provisionTaskActivityStatus(status: "pending" | "running" | "success" | "failed"): ActivityEntry["status"] {
  if (status === "success") return "success";
  if (status === "failed") return "error";
  if (status === "running") return "pending";
  return "info";
}

function formatActivityTime() {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

function activityStatusLabel(status: ActivityEntry["status"] | "all") {
  const labels = {
    all: "全部",
    info: "信息",
    pending: "处理中",
    success: "成功",
    warning: "取消",
    error: "失败",
  };
  return labels[status];
}

function activityFullText(item: ActivityEntry) {
  return [item.time, activityStatusLabel(item.status), item.title, item.target, item.detail].filter(Boolean).join(" · ");
}

async function postJson<T>(url: string, payload: unknown, method = "POST"): Promise<T> {
  const init: RequestInit = { method };
  if (payload !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(payload);
  }
  const response = await fetch(url, init);
  const text = await response.text();
  const result = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(result.message || "请求失败");
  }
  return result as T;
}

function positive(value: number) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function percent(used: number, total: number) {
  if (!total) return 0;
  return Math.min(Math.round((used / total) * 100), 999);
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

function displayVmIpForHost(vm: VmNode, hostIp?: string) {
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
  return isVmStopped(vm);
}

function providerLabel(value: ProviderType) {
  if (value === "xenserver") return "XenServer";
  if (value === "vmware") return "VMware";
  if (value === "proxmox") return "Proxmox VE";
  return "KVM/libvirt";
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
  if (value === "proxmox") return 8006;
  return value === "vmware" ? 443 : 22;
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
            <svg class="vrc-system-logo" viewBox="0 0 64 48">
              <rect class="vrc-logo-tile" x="5" y="5" width="54" height="38" rx="10" />
              <text class="vrc-logo-letter" x="32" y="29" text-anchor="middle">VRC</text>
              <rect class="vrc-logo-cursor" x="38" y="34" width="11" height="2.5" rx="1.25" />
            </svg>
          </span>
          <div class="brand-copy">
            <h1>资源控制台</h1>
            <p>{{ storedConnections.length }} 个连接</p>
          </div>
        </div>
        <button class="icon-button settings-entry-button" :class="{ active: isSettingsNavActive }" title="设置" aria-label="设置" @click="openSettingsWorkspace">
          <el-icon><Setting /></el-icon>
        </button>
      </div>

      <section class="sidebar-section">
        <el-input v-model="connectionSearch" class="sidebar-search" placeholder="输入名称、平台或地址" :prefix-icon="Search" clearable />
      </section>

      <div class="connection-groups">
        <section v-if="filteredStoredConnections.length" class="connection-group overview-group">
          <button class="overview-entry" :class="{ active: isOverviewNavActive }" @click="loadHostOverview">
            <span class="overview-entry-icon">↗</span>
            <span class="overview-entry-main">
              <strong>资源总览</strong>
              <small>查看全部物理机</small>
            </span>
          </button>
        </section>
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
        <div v-if="!storedConnections.length" class="sidebar-empty">
          <strong>还没有连接</strong>
          <span>在右侧填写账号后保存，之后可直接加载资源清单。</span>
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
          <div
            v-for="item in activityEntries"
            :key="item.id"
            class="activity-line"
            :class="`status-${item.status}`"
            :title="activityFullText(item)"
            @dblclick="activityLogVisible = true"
          >
            <div class="activity-line-main">
              <time>{{ item.time }}</time>
              <strong>{{ item.title }}</strong>
            </div>
            <div class="activity-line-sub">
              <span v-if="item.target">{{ item.target }}</span>
              <span v-if="item.detail">{{ item.detail }}</span>
            </div>
          </div>
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
      }"
      :style="workspaceAppearanceStyle"
    >

      <section v-if="workspaceMode === 'connection' && loadingHosts && !inventory && !hostOverviewRows.length && !loadingHostOverview" class="panel loading-panel">
        <div class="resource-loading-card" :class="`platform-${selectedConnectionBrand.type}`">
          <div class="resource-loader-mark compact" aria-hidden="true">
            <span class="resource-loader-ring"></span>
            <strong>VRC</strong>
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
          :connection="{ id: selectedConnectionId, providerType: connection.providerType, host: connection.host, port: connection.port, username: connection.username }"
          :host="selectedHost"
          :network-count="selectedHostNetworks.length"
          :resource-summary="resourceSummary"
          :host-memory-percent="hostUsage.memoryPercent"
          :storage-totals="storageTotals"
          :vm-totals="vmTotals"
          :has-vm-summary="!!vmSummary"
          :loading-vm-summary="loadingVmSummary"
          :vms="filteredVms"
          :vms-total="vms?.total ?? 0"
          :selected-vm-ids="selectedVmIds"
          :vm-action-states="vmActionStates"
          :loading-vms="loadingVms"
          variant="page"
          table-height="100%"
          table-panel-class="single-table-panel"
          @search-change="loadVms"
          @refresh="loadVms"
          @export="exportCsv"
          @host-detail="hostDetailVisible = true"
          @storage-detail="storageDetailVisible = true"
          @iso-detail="openIsoDetail"
          @create-vm="openProvisioningDialog"
          @selection-change="handleVmSelectionChange"
          @open-console="handleOpenVmConsole"
          @vm-action="handleVmAction"
          @batch-vm-action="handleBatchVmAction"
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
              placeholder="查物理机 IP / VM IP"
              clearable
            />
            <el-segmented
              v-model="hostOverviewMatchMode"
              class="match-mode-control"
              :options="[
                { label: '完全匹配', value: 'exact' },
                { label: '模糊匹配', value: 'fuzzy' },
              ]"
            />
            <el-tooltip v-if="shouldSearchVmIp(overviewSearchKeyword)" content="刷新 VM IP 搜索缓存" placement="top">
              <span class="toolbar-tooltip-target">
                <button
                  class="cache-refresh-link overview-cache-refresh"
                  :disabled="vmSearchLoadingCount > 0"
                  type="button"
                  aria-label="刷新 VM IP 搜索缓存"
                  @click="refreshVmSearchCache"
                >
                  <el-icon v-if="vmSearchLoadingCount > 0" class="inline-loading"><Loading /></el-icon>
                  <el-icon v-else><Refresh /></el-icon>
                  <span>刷新 VM</span>
                </button>
              </span>
            </el-tooltip>
          </div>
          <div class="overview-action-group" aria-label="总览列表动作">
            <el-tooltip content="导出物理机总览：下载当前筛选结果 CSV" placement="top">
              <span class="toolbar-tooltip-target">
                <button
                  type="button"
                  class="overview-toolbar-button"
                  :disabled="!sortedHostOverviewRows.length"
                  title="导出物理机总览"
                  aria-label="导出物理机总览"
                  @click="exportHostOverviewCsv"
                >
                  <VrcToolbarIcon name="export" />
                </button>
              </span>
            </el-tooltip>
            <el-tooltip content="刷新总览：重新读取全部保存连接的物理机资源" placement="top">
              <span class="toolbar-tooltip-target">
                <button
                  type="button"
                  class="overview-toolbar-button"
                  title="刷新总览"
                  :disabled="loadingHostOverview"
                  aria-label="刷新总览"
                  @click="loadHostOverview"
                >
                  <el-icon v-if="loadingHostOverview" class="is-loading"><Loading /></el-icon>
                  <VrcToolbarIcon v-else name="refresh" />
                </button>
              </span>
            </el-tooltip>
          </div>
        </div>

        <el-table
          :data="sortedHostOverviewRows"
          height="100%"
          row-key="key"
          stripe
          empty-text=" "
          :row-class-name="overviewRowClassName"
          @row-click="openHostOverview"
        >
          <template #empty>
            <div class="overview-empty-state">
              <div v-if="overviewEmptyState.mode === 'loading'" class="resource-loading-card resource-table-loading overview-empty-loading">
                <div class="resource-loader-mark compact" aria-hidden="true">
                  <span class="resource-loader-ring"></span>
                  <strong>VRC</strong>
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
                  <span></span>
                  <strong>VRC</strong>
                </div>
                <strong>{{ overviewEmptyState.title }}</strong>
                <small>{{ overviewEmptyState.detail }}</small>
              </div>
            </div>
          </template>
          <el-table-column type="index" label="序号" width="58" align="center" header-align="center" />
          <el-table-column label="物理机" min-width="160" align="left" show-overflow-tooltip>
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
          <el-table-column label="CPU 运行情况" min-width="140" align="right">
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
          <el-table-column label="内存余量" min-width="140" align="right">
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
          <el-table-column label="存储余量" min-width="150" align="right">
            <template #default="{ row }">
              <span class="overview-resource-cell" :class="{ warning: overviewResourceMeterWarning(row, 'storage') }">
                <strong>{{ overviewStorageMain(row) }}</strong>
                <span class="overview-resource-meter" aria-hidden="true">
                  <i :style="{ width: `${overviewResourceMeterPercent(row, 'storage')}%` }"></i>
                </span>
                <small>{{ overviewStorageSubline(row) }}</small>
              </span>
            </template>
          </el-table-column>
          <el-table-column label="VM" min-width="58" align="center">
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
            <button type="button" :class="{ active: settingsPanel === 'logs' }" @click="settingsPanel = 'logs'">
              <el-icon><Tickets /></el-icon>
              <span>日志</span>
            </button>
          </aside>

          <section v-if="settingsPanel === 'appearance'" class="settings-workspace-content">
            <section class="settings-card">
              <div class="settings-card-head">
                <div>
                  <strong>主题</strong>
                  <span>选择后全局应用，背景、surface、表格、弹窗、loading、toast 和图表都跟随主题。</span>
                </div>
              </div>
              <div class="settings-theme-card-grid">
                <button
                  v-for="theme in themeOptions"
                  :key="theme.value"
                  type="button"
                  class="settings-theme-card"
                  :class="{ active: currentTheme === theme.value }"
                  :aria-pressed="currentTheme === theme.value"
                  @click="applyTheme(theme.value)"
                >
                  <span class="settings-theme-card-head">
                    <strong>{{ theme.name }}</strong>
                    <small>{{ theme.tone }}</small>
                  </span>
                  <span class="theme-swatch" aria-hidden="true">
                    <i v-for="color in theme.colors" :key="color" :style="{ background: color }"></i>
                  </span>
                  <span>{{ theme.description }}</span>
                </button>
              </div>
            </section>

            <section class="settings-card appearance-custom-settings">
              <div class="settings-card-head appearance-custom-head">
                <div>
                  <strong>自定义主题</strong>
                  <span>在基础主题上覆盖语义色和工作区背景，未修改的组件继续使用系统样式变量。</span>
                </div>
                <div class="appearance-head-actions">
                  <el-button size="small" :icon="Upload" @click="selectAppearanceJson">载入</el-button>
                  <el-button size="small" :icon="Download" @click="exportAppearanceConfig">导出</el-button>
                  <el-button size="small" :icon="RefreshLeft" @click="resetAppearancePreferences">重置</el-button>
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
                    <el-radio-group v-model="uiPreferences.backgroundMode" size="small" @change="persistAppearancePreference('backgroundMode')">
                      <el-radio-button value="default">默认</el-radio-button>
                      <el-radio-button value="solid">纯色</el-radio-button>
                      <el-radio-button value="image">图片</el-radio-button>
                    </el-radio-group>
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

            <section class="settings-tile-grid" aria-label="外观偏好">
              <article class="settings-tile">
                <div class="settings-row">
                  <strong>按钮密度</strong>
                  <span>28px 工具栏 / 24px 行内</span>
                </div>
                <div class="settings-row">
                  <span>图标按钮显示 tooltip</span>
                  <button
                    type="button"
                    class="settings-switch"
                    :class="{ active: uiPreferences.showIconTooltips }"
                    :aria-pressed="uiPreferences.showIconTooltips"
                    @click="updateUiPreference('showIconTooltips', !uiPreferences.showIconTooltips)"
                  >
                    <i></i>
                  </button>
                </div>
              </article>
              <article class="settings-tile">
                <div class="settings-row">
                  <strong>表格密度</strong>
                  <span>44-48px 行高</span>
                </div>
                <div class="settings-row">
                  <span>长名称单行省略</span>
                  <button
                    type="button"
                    class="settings-switch"
                    :class="{ active: uiPreferences.truncateLongNames }"
                    :aria-pressed="uiPreferences.truncateLongNames"
                    @click="updateUiPreference('truncateLongNames', !uiPreferences.truncateLongNames)"
                  >
                    <i></i>
                  </button>
                </div>
              </article>
              <article class="settings-tile">
                <div class="settings-row">
                  <strong>状态色</strong>
                  <span>成功 / 警告 / 危险</span>
                </div>
                <span class="settings-status-swatches" aria-hidden="true">
                  <i class="success"></i>
                  <i class="warning"></i>
                  <i class="danger"></i>
                </span>
              </article>
              <article class="settings-tile">
                <div class="settings-row">
                  <strong>控制台</strong>
                  <span>默认中尺寸</span>
                </div>
                <div class="settings-row">
                  <span>拖拽中节流刷新</span>
                  <button
                    type="button"
                    class="settings-switch"
                    :class="{ active: uiPreferences.throttleConsoleResize }"
                    :aria-pressed="uiPreferences.throttleConsoleResize"
                    @click="updateUiPreference('throttleConsoleResize', !uiPreferences.throttleConsoleResize)"
                  >
                    <i></i>
                  </button>
                </div>
              </article>
            </section>
          </section>

          <section v-else-if="settingsPanel === 'connection'" class="settings-workspace-content">
            <section class="settings-card connection-settings-card">
              <div class="settings-card-head connection-settings-head">
                <div>
                  <strong>连接设置</strong>
                  <span>保存后可在左侧连接列表中选择并读取物理机资源。</span>
                </div>
                <span>保存 / 测试 / 删除 / 加载资源</span>
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
                <el-tooltip content="加载资源：使用已保存账号读取物理机、存储、网络和 VM 清单" placement="top">
                  <el-button :icon="Refresh" :loading="loadingHosts" :disabled="!selectedConnectionId" @click="loadSelectedConnectionResources">
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
              <div class="settings-connection-list">
                <button
                  v-for="item in storedConnections"
                  :key="item.id"
                  type="button"
                  class="settings-connection-row"
                  :class="{ active: selectedConnectionId === item.id }"
                  @click="applyStoredConnection(item.id)"
                >
                  <span>
                    <strong>{{ item.name }}</strong>
                    <small>{{ providerLabel(item.providerType) }} · {{ item.host }}:{{ item.port }}</small>
                  </span>
                  <i>{{ selectedConnectionId === item.id ? "已选" : "选择" }}</i>
                </button>
                <div v-if="!storedConnections.length" class="settings-empty-note">还没有保存连接，请先填写上方连接信息。</div>
              </div>
            </section>
          </section>

          <section v-else-if="settingsPanel === 'templates'" class="settings-workspace-content">
            <section class="settings-card">
              <div class="settings-card-head">
                <div>
                  <strong>创建模板</strong>
                  <span>模板能力当前仍由创建虚拟机弹框里的真实配置读取，设置页先保留归档入口。</span>
                </div>
              </div>
              <div class="settings-empty-note">暂不在设置页直接编辑模板，避免和当前创建 VM 真实配置链路产生两套口径。</div>
            </section>
          </section>

          <section v-else class="settings-workspace-content">
            <section class="settings-card">
              <div class="settings-card-head">
                <div>
                  <strong>操作记录</strong>
                  <span>当前会话内记录，完整审计后续需要后端持久化。</span>
                </div>
                <el-button @click="activityLogVisible = true">查看完整记录</el-button>
              </div>
              <div class="settings-log-list">
                <article v-for="item in activityEntries.slice(0, 6)" :key="item.id" class="settings-log-row" :class="`status-${item.status}`">
                  <time>{{ item.time }}</time>
                  <strong>{{ item.title }}</strong>
                  <span>{{ item.target || item.detail || activityStatusLabel(item.status) }}</span>
                </article>
              </div>
            </section>
          </section>
        </div>
      </section>

      <section v-if="showWorkspacePlaceholder" class="workspace-placeholder">
        <div class="workspace-placeholder-mark" aria-hidden="true">
          <span></span>
          <strong>VRC</strong>
        </div>
        <strong>资源控制台</strong>
        <small>Virtual Resource Console</small>
      </section>

      <el-dialog v-model="vmDetailVisible" title="虚拟机信息" width="80vw" class="vm-detail-dialog" top="4vh" :close-on-click-modal="false">
        <HostVmPanel
          v-if="selectedHost"
          v-model:search="search"
          v-model:power-filter="vmPowerFilter"
          :connection="{ id: selectedConnectionId, providerType: connection.providerType, host: connection.host, port: connection.port, username: connection.username }"
          :host="selectedHost"
          :network-count="selectedHostNetworks.length"
          :resource-summary="resourceSummary"
          :host-memory-percent="hostUsage.memoryPercent"
          :storage-totals="storageTotals"
          :vm-totals="vmTotals"
          :has-vm-summary="!!vmSummary"
          :loading-vm-summary="loadingVmSummary"
          :vms="filteredVms"
          :vms-total="vms?.total ?? 0"
          :selected-vm-ids="selectedVmIds"
          :vm-action-states="vmActionStates"
          :loading-vms="loadingVms"
          variant="dialog"
          table-height="100%"
          metric-grid-class="dialog-metric-grid"
          table-panel-class="dialog-table-panel"
          @search-change="loadVms"
          @refresh="loadVms"
          @export="exportCsv"
          @host-detail="hostDetailVisible = true"
          @storage-detail="storageDetailVisible = true"
          @iso-detail="openIsoDetail"
          @create-vm="openProvisioningDialog"
          @selection-change="handleVmSelectionChange"
          @open-console="handleOpenVmConsole"
          @vm-action="handleVmAction"
          @batch-vm-action="handleBatchVmAction"
        />
      </el-dialog>

      <ConsoleDialog
        v-model:visible="consoleDialogVisible"
        :target="consoleTarget"
        :provision-task="activeConsoleProvisionTask"
        :provision-targets="provisionConsoleTargets"
        @select-provision-target="handleSelectProvisionConsoleTarget"
        @upload-result="handleConsoleUploadResult"
      />

      <el-dialog v-model="activityLogVisible" title="操作记录" width="820px" class="activity-log-dialog" top="7vh" :close-on-click-modal="false">
        <div class="activity-log-tools">
          <div class="activity-query-group">
            <el-input v-model="activitySearch" class="activity-search" :prefix-icon="Search" placeholder="搜索动作 / 对象 / 详情" clearable />
            <span class="activity-log-count">{{ filteredActivityEntries.length }} / {{ activityEntries.length }}</span>
          </div>
          <div class="activity-status-filter">
            <button
              v-for="status in activityStatusOptions"
              :key="status"
              type="button"
              :class="{ active: activityStatusFilter === status }"
              @click="activityStatusFilter = status"
            >
              {{ activityStatusLabel(status) }}
            </button>
          </div>
        </div>
        <div class="activity-log-list">
          <article v-for="item in filteredActivityEntries" :key="item.id" class="activity-log-item" :class="`status-${item.status}`">
            <div class="activity-log-content">
              <strong>{{ item.title }}</strong>
              <p>{{ [item.time, item.target, item.detail].filter(Boolean).join(" · ") }}</p>
            </div>
            <span class="activity-log-status">{{ activityStatusLabel(item.status) }}</span>
          </article>
          <div v-if="!filteredActivityEntries.length" class="activity-log-empty">没有匹配的操作记录</div>
        </div>
      </el-dialog>

      <el-dialog v-model="connectionSettingsVisible" title="连接设置" width="1280px" class="connection-settings-dialog" top="5vh" :close-on-click-modal="false">
        <form class="settings-dialog-shell" autocomplete="off" @submit.prevent="loadHostInventory">
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
                  v-for="theme in themeOptions"
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
                  <span>保存后可在左侧连接列表中直接选择并读取物理机资源。</span>
                </div>
                <span>保存 / 测试 / 删除 / 加载资源</span>
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
                <el-tooltip content="加载资源：使用已保存账号读取物理机、存储、网络和 VM 清单" placement="top">
                  <el-button :icon="Refresh" :loading="loadingHosts" :disabled="!selectedConnectionId" @click="loadSelectedConnectionResources">
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
              <span>Excel / JSON / 固定格式，先测试连接，通过后再保存</span>
            </div>
          </div>
        </template>
        <section class="settings-card account-import-card">
          <div class="account-import-layout">
            <section class="import-drop-panel">
              <div class="import-mode-tabs" role="tablist" aria-label="导入方式">
                <button type="button" :class="{ active: accountImportMode === 'excel' }" @click="switchAccountImportMode('excel')">Excel 文件</button>
                <button type="button" :class="{ active: accountImportMode === 'json' }" @click="switchAccountImportMode('json')">JSON 串</button>
                <button type="button" :class="{ active: accountImportMode === 'fixed' }" @click="switchAccountImportMode('fixed')">固定格式</button>
              </div>

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
                <span>XenServer 192.0.2.77 xenserver-1 root change-me</span>
                <span>XenServer 192.0.2.6 xenserver-3 change-me</span>
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

              <div class="import-preview-table">
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
              <div class="button-row account-import-buttons">
                <button type="button" class="btn" @click="accountImportVisible = false">取消</button>
                <button type="button" class="btn" :disabled="!accountImportCanConfirm || accountImportSummary.update === accountImportSummary.importable" @click="accountImportDrafts = accountImportDrafts.filter((row) => row.status === 'new')">只导入新增</button>
                <button type="button" class="btn primary" :disabled="!accountImportCanConfirm" @click="confirmAccountImport">
                  {{ importingAccounts ? "测试中" : `测试并导入 ${accountImportSummary.importable} 条` }}
                </button>
              </div>
            </section>
          </div>
        </section>
      </el-dialog>

      <el-dialog v-model="hostDetailVisible" title="物理机详情" width="760px" :close-on-click-modal="false">
        <div v-if="selectedHost" class="dialog-summary host-detail-summary">
          <span>基础信息</span>
          <strong>{{ selectedHost.name }}</strong>
          <small>{{ selectedHost.address }} · {{ formatCpuCount(selectedHost.cpuCores) }} · {{ formatBytes(selectedHost.memoryTotalBytes) }}</small>
        </div>
        <div class="dialog-section-title">
          <strong>网络接口</strong>
          <span>查看当前平台网络接口连接状态</span>
        </div>
        <el-table :data="selectedHostNetworks" height="280" row-key="device" stripe>
          <el-table-column prop="device" label="Device" width="86" align="center" />
          <el-table-column prop="ip" label="IP" width="132" align="left" />
          <el-table-column prop="mac" label="MAC" width="152" align="left" show-overflow-tooltip />
          <el-table-column prop="network" label="Network" min-width="190" align="left" show-overflow-tooltip />
          <el-table-column label="Mgmt" width="76" align="center">
            <template #default="{ row }">
              <el-tag v-if="row.management" size="small" type="success" effect="plain">Yes</el-tag>
              <span v-else>No</span>
            </template>
          </el-table-column>
          <el-table-column label="Attached" width="86" align="center">
            <template #default="{ row }">{{ row.attached ? "Yes" : "No" }}</template>
          </el-table-column>
        </el-table>
      </el-dialog>

      <el-dialog v-model="storageDetailVisible" title="SR 详情" width="860px" :close-on-click-modal="false">
        <div class="dialog-summary storage-detail-summary">
          <span>容量摘要</span>
          <strong>{{ storage.length }} 个 SR · 已用 {{ storageTotals.usagePercent }}%</strong>
          <small>{{ formatNumber(storageTotals.usedGiB) }} / {{ formatNumber(storageTotals.physicalGiB) }} GiB · 虚拟分配 {{ formatNumber(storageTotals.virtualGiB) }} GiB</small>
        </div>
        <div class="dialog-section-title">
          <strong>SR 表格</strong>
          <span>区分物理容量、已用容量和虚拟分配容量</span>
        </div>
        <el-table :data="storage" height="320" row-key="name" stripe>
          <el-table-column prop="name" label="Name" min-width="230" align="left" show-overflow-tooltip />
          <el-table-column prop="type" label="Type" width="96" align="center" />
          <el-table-column label="Shared" width="82" align="center">
            <template #default="{ row }">{{ row.shared ? "Yes" : "No" }}</template>
          </el-table-column>
          <el-table-column label="Usage" width="160" align="center">
            <template #default="{ row }">
              <el-progress :percentage="percent(positive(row.usedGiB), positive(row.physicalGiB))" :stroke-width="7" />
            </template>
          </el-table-column>
          <el-table-column label="Size" width="110" align="right">
            <template #default="{ row }">{{ formatNumber(row.physicalGiB) }} GiB</template>
          </el-table-column>
          <el-table-column label="Used" width="110" align="right">
            <template #default="{ row }">{{ formatNumber(row.usedGiB) }} GiB</template>
          </el-table-column>
          <el-table-column label="Virtual" width="120" align="right">
            <template #default="{ row }">{{ formatNumber(row.virtualGiB) }} GiB</template>
          </el-table-column>
        </el-table>
      </el-dialog>

      <el-dialog v-model="isoDetailVisible" title="系统镜像" width="920px" class="iso-dialog" top="8vh" :close-on-click-modal="false">
        <div class="iso-dialog-head">
          <div class="dialog-summary">
            <strong>{{ isoTotals.count }} 个 ISO · {{ formatBytes(isoTotals.totalBytes) }}</strong>
            <span>{{ selectedHost?.name || connection.host }} · {{ isoTotals.storageCount }} 个存储库</span>
          </div>
          <div class="iso-dialog-actions">
            <el-input v-model="isoSearch" class="iso-search-input" :prefix-icon="Search" placeholder="搜索镜像 / ISO 库 / 路径" clearable />
            <button class="cache-refresh-link" :disabled="loadingIsoImages" title="刷新系统镜像" @click="loadIsoImages(true)">
              <el-icon v-if="loadingIsoImages" class="inline-loading"><Loading /></el-icon>
              <el-icon v-else><Refresh /></el-icon>
              <span>刷新</span>
            </button>
          </div>
        </div>
        <div class="iso-table-wrap" :class="{ loading: loadingIsoImages }">
          <el-table :data="filteredIsoImages" height="420" row-key="id" stripe empty-text=" ">
            <template #empty>
              <div class="overview-empty-state iso-empty-state">
                <div v-if="loadingIsoImages" class="resource-loading-card resource-table-loading overview-empty-loading">
                  <div class="resource-loader-mark compact" aria-hidden="true">
                    <span class="resource-loader-ring"></span>
                    <strong>VRC</strong>
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
                    <span></span>
                    <strong>VRC</strong>
                  </div>
                  <strong>{{ isoSearch.trim() ? "未找到匹配 ISO" : "暂无系统镜像" }}</strong>
                  <small>{{ isoEmptyText() }}</small>
                </div>
              </div>
            </template>
            <el-table-column type="index" label="序号" width="58" align="center" />
            <el-table-column prop="name" label="镜像名称" min-width="260" align="left" show-overflow-tooltip />
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
        v-model:visible="provisioningVisible"
        :connection="{ id: selectedConnectionId, providerType: connection.providerType, host: connection.host, port: connection.port, username: connection.username }"
        :host="selectedHost"
        :networks="selectedHostNetworks"
        :vms="vms?.items ?? []"
        :reserved-ips="provisioningReservedIps"
        :storage-totals="storageTotals"
        :submitting="provisioningSubmitting"
        :progress="provisioningProgress"
        :provision-task="activeProvisionTask"
        :console-available="activeProvisionConsoleAvailable"
        :console-target="provisionInlineConsoleTarget"
        :provision-console-targets="activeProvisionConsoleTargets"
        @activity="pushActivity($event.title, { target: $event.target, detail: $event.detail, status: $event.status })"
        @open-iso-detail="openIsoDetail"
        @select-console-target="handleSelectProvisionInlineConsoleTarget"
        @submit="handleProvisioningSubmit"
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
  </main>
</template>
