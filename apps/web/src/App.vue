<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { ArrowLeft, Brush, Check, Connection, Delete, Loading, Plus, Refresh, Search, Setting, Tickets } from "@element-plus/icons-vue";
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

interface ProvisioningProgressState {
  title: string;
  message: string;
  status: "running" | "success" | "error";
}

interface ActivityEntry {
  id: string;
  time: string;
  title: string;
  detail?: string;
  target?: string;
  status: "info" | "pending" | "success" | "warning" | "error";
}

type ActivityStatusFilter = "all" | ActivityEntry["status"];
type UiTheme = "graphite-sage" | "basalt-copper" | "mist-teal";
type WorkspaceMode = "empty" | "overview" | "connection" | "settings";
type SettingsPanel = "appearance" | "connection" | "templates" | "logs";
type VmPowerFilter = "all" | "running" | "stopped";

const VM_SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const VRC_TOAST_DURATION_MS = 3000;
const activityStatusOptions: ActivityStatusFilter[] = ["all", "pending", "success", "warning", "error", "info"];
const themeOptions: Array<{ value: UiTheme; label: string; name: string; tone: string; description: string; colors: [string, string, string, string] }> = [
  {
    value: "graphite-sage",
    label: "石墨绿",
    name: "Graphite Sage",
    tone: "推荐",
    description: "低噪声、长时间看列表不累，适合默认主题。",
    colors: ["#f5f6f2", "#fbfbf7", "#426b57", "#b77935"],
  },
  {
    value: "basalt-copper",
    label: "岩铜",
    name: "Basalt Copper",
    tone: "专业客户端",
    description: "铜色只做重点，整体更接近桌面运维工具。",
    colors: ["#f4f2ed", "#fcfaf5", "#9b5f35", "#5f6f68"],
  },
  {
    value: "mist-teal",
    label: "雾青",
    name: "Mist Teal",
    tone: "轻量",
    description: "更清爽，适合 Web 感更强的控制台版本。",
    colors: ["#f3f6f4", "#fbfcfa", "#2f6f68", "#ad7833"],
  },
];

const connection = reactive({
  providerType: (localStorage.getItem("vrc.providerType") as ProviderType) || "xenserver",
  host: localStorage.getItem("vrc.host") || "",
  port: Number(localStorage.getItem("vrc.port") || defaultPortForProvider((localStorage.getItem("vrc.providerType") as ProviderType) || "xenserver")),
  username: localStorage.getItem("vrc.username") || "root",
  password: "",
});

const inventory = ref<HostsResponse | null>(null);
const vms = ref<VmsResponse | null>(null);
const vmSummary = ref<VmInventorySummary | null>(null);
const storedConnections = ref<StoredConnectionSummary[]>([]);
const selectedConnectionId = ref(localStorage.getItem("vrc.connectionId") || "");
const connectionName = ref("");
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
const vmDetailVisible = ref(false);
const consoleDialogVisible = ref(false);
const consoleTarget = ref<VmConsoleTarget | null>(null);
const loadingHosts = ref(false);
const loadingVmSummary = ref(false);
const loadingVms = ref(false);
const vmActionStates = ref<Record<string, VmActionState>>({});
const testing = ref(false);
const savingConnection = ref(false);
const errorMessage = ref("");
const successMessage = ref("");
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
let hostOverviewRequestSeq = 0;
let vmSearchRequestSeq = 0;
let activitySeq = 0;
let lastErrorToast = "";
let lastErrorToastAt = 0;
let vmSearchTimer: ReturnType<typeof setTimeout> | undefined;
const provisioningPollTimers = new Map<string, ReturnType<typeof setTimeout>>();
const provisioningTaskMarks = new Map<string, string>();

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
const connectionFeedbackMessage = computed(() => connectionActionPendingMessage.value || errorMessage.value || successMessage.value);
const connectionFeedbackStatus = computed(() => {
  if (connectionActionPendingMessage.value) return "loading";
  if (errorMessage.value) return "error";
  if (successMessage.value) return "success";
  return "";
});
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
      memoryBytes: vmSummary.value.memoryBytes,
      diskBytes: vmSummary.value.diskBytes ?? null,
    };
  }
  const items = vms.value?.items ?? [];
  return {
    all: vms.value?.total ?? items.length,
    running: items.filter((vm) => vm.powerState === "running").length,
    halted: items.filter((vm) => vm.powerState === "halted").length,
    vcpu: items.reduce((sum, vm) => sum + vm.cpuCount, 0),
    memoryBytes: items.reduce((sum, vm) => sum + vm.memoryBytes, 0),
    diskBytes: items.reduce((sum, vm) => sum + positive(vm.diskVirtualBytes ?? 0), 0),
  };
});

const resourceSummary = computed(() => {
  const host = selectedHost.value;
  const cpuTotal = positive(host?.cpuCores ?? 0);
  const cpuAllocated = positive(vmTotals.value.vcpu);
  const cpuOver = Math.max(cpuAllocated - cpuTotal, 0);
  const memoryTotalGiB = (host?.memoryTotalBytes ?? 0) / 1024 / 1024 / 1024;
  const memoryUsedGiB = hostUsage.value.memoryUsedBytes / 1024 / 1024 / 1024;
  const storageTotalGiB = storageTotals.value.physicalGiB;
  const storageUsedGiB = storageTotals.value.usedGiB;

  return [
    {
      key: "cpu",
      name: "CPU 分配",
      usedName: "已分配",
      freeName: "剩余",
      overName: "超配",
      unit: "vCPU",
      capacityUnit: "核",
      used: Math.min(cpuAllocated, cpuTotal),
      free: cpuOver > 0 ? 0 : Math.max(cpuTotal - cpuAllocated, 0),
      over: cpuOver,
      total: cpuTotal,
      headline: `${formatNumber(cpuAllocated)} vCPU / ${formatNumber(cpuTotal)} 核`,
      subline: cpuOver > 0 ? `超配 ${formatNumber(cpuOver)} vCPU` : `剩余 ${formatNumber(Math.max(cpuTotal - cpuAllocated, 0))} 核`,
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
  const cpuFree = readyRows.reduce((sum, row) => sum + hostCpuPlan(row).plannedFree, 0);
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
      label: "CPU 余量",
      value: `${formatNumber(cpuFree)} vCPU`,
      detail: "按 4x 规划口径估算",
      className: cpuFree < 12 ? "overview-metric-warning" : "",
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
const vmLoadStatusText = computed(() => {
  if (loadingVms.value) return "自动加载中";
  if (vms.value) return `已加载 ${vms.value.items.length} / ${vms.value.total}`;
  return "等待自动加载";
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

onMounted(async () => {
  await loadStoredConnections();
  if (selectedConnectionId.value) {
    applyStoredConnection(selectedConnectionId.value);
  }
  if (storedConnections.value.length) {
    await loadHostOverview();
  }
});

onBeforeUnmount(() => {
  for (const timer of provisioningPollTimers.values()) clearTimeout(timer);
  provisioningPollTimers.clear();
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

function normalizeTheme(value?: string | null): UiTheme {
  return value === "basalt-copper" || value === "mist-teal" || value === "graphite-sage" ? value : "graphite-sage";
}

function applyTheme(theme: UiTheme) {
  currentTheme.value = theme;
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("vrc.theme", theme);
}

function openSettingsWorkspace() {
  workspaceMode.value = "settings";
  settingsPanel.value = "appearance";
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
  selectedConnectionId.value = stored.id;
  connection.providerType = stored.providerType;
  connection.host = stored.host;
  connection.port = stored.port;
  connection.username = stored.username;
  connection.password = "";
  connectionName.value = stored.name;
  showConnectionEditor.value = false;
  localStorage.setItem("vrc.connectionId", stored.id);
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
  selectedConnectionId.value = "";
  localStorage.removeItem("vrc.connectionId");
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
  const direct = buildDirectConnectionPayload();
  if (!direct) return;
  clearMessages();
  savingConnection.value = true;

  try {
    const result = await postJson<{ connection: StoredConnectionSummary }>("/api/connections", {
      ...direct,
      id: selectedConnectionId.value || undefined,
      name: connectionName.value.trim() || `${direct.providerType}:${direct.host}`,
    });
    selectedConnectionId.value = result.connection.id;
    localStorage.setItem("vrc.connectionId", result.connection.id);
    await loadStoredConnections();
    applyStoredConnection(result.connection.id);
    setSuccessMessage(`连接已保存：${result.connection.name}。下次可直接加载资源。`);
    pushActivity("保存连接", {
      target: result.connection.name,
      detail: `${providerLabel(result.connection.providerType)} · ${result.connection.host}:${result.connection.port}`,
      status: "success",
    });
  } catch (error) {
    setErrorMessage(error instanceof Error ? error.message : "保存连接失败");
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
    localStorage.removeItem("vrc.connectionId");
    await loadStoredConnections();
    setSuccessMessage("保存的连接已删除。");
    pushActivity("删除连接", {
      target: deletedConnection?.name || "保存连接",
      detail: deletedConnection ? `${providerLabel(deletedConnection.providerType)} · ${deletedConnection.host}:${deletedConnection.port}` : "本地连接配置已删除",
      status: "warning",
    });
  } catch (error) {
    setErrorMessage(error instanceof Error ? error.message : "删除连接失败");
  }
}

async function loadSelectedConnectionResources() {
  if (!selectedConnectionId.value) {
    showConnectionEditor.value = true;
    setErrorMessage("还没有保存连接。请先填写 Host、用户名和密码，点“保存”，之后就能加载资源。");
    successMessage.value = "";
    return;
  }
  await loadHostInventory();
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
  const payload = buildConnectionPayload();
  if (!payload) return;
  testing.value = true;
  clearMessages();

  try {
    const result = await postJson<{ hostName?: string }>("/api/connections/test", payload);
    setSuccessMessage(`测试连接成功：${result.hostName || connection.host}`);
    pushActivity("连接测试成功", {
      target: result.hostName || connection.host,
      detail: `${providerLabel(connection.providerType)} · ${connection.host}:${connection.port}`,
      status: "success",
    });
  } catch (error) {
    setErrorMessage(error instanceof Error ? error.message : "测试连接失败");
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
  localStorage.setItem("vrc.connectionId", row.connection.id);

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
  const preflightToast = ElMessage({
    type: "info",
    message: "创建预检中...",
    duration: 0,
    showClose: false,
  });
  try {
    pushActivity("请求创建虚拟机", {
      target,
      detail: "执行创建预检",
      status: "pending",
    });
    const preflight = await postJson<ProvisionPreflightResponse>("/api/provisioning/preflight", payload);
    preflightToast.close();
    const blockingChecks = preflight.checks.filter((check) => check.status === "error");
    const warningChecks = preflight.checks.filter((check) => check.status === "warning");
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
    if (warningChecks.length) {
      showToast("warning", formatProvisionPreflightChecks(warningChecks));
    }
    pushActivity(warningChecks.length ? "创建预检有提醒" : "创建预检通过", {
      target,
      detail: warningChecks.length ? formatProvisionPreflightChecks(warningChecks) : "检查项通过",
      status: warningChecks.length ? "warning" : "success",
    });
  } catch (error) {
    preflightToast.close();
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
  pushActivity("提交创建虚拟机", {
    target,
    detail,
    status: "pending",
  });
  try {
    const response = await postJson<VmProvisionResponse>("/api/provisioning/vms", {
      ...payload,
      confirmToken: "CONFIRMED",
    });
    successMessage.value = response.result.message;
    showToast("success", response.result.message);
    pushActivity("创建虚拟机成功", {
      target,
      detail: response.result.created.map((item) => item.name).join(", "),
      status: "success",
    });
    if (response.result.taskId || response.task?.id) {
      activeProvisionTask.value = response.task ?? null;
      provisioningProgress.value = {
        title: "创建任务执行中",
        message: response.task?.message || response.result.message,
        status: "running",
      };
      keepSubmittingForTask = true;
      pollProvisioningTask(response.result.taskId || response.task?.id || "");
    }
    await reserveProvisioningIpsAfterCreate(payload);
    await Promise.all([loadVmSummary({ silent: true }), loadVms({ silent: true })]);
    syncSelectedOverviewRowAfterVmChange();
    if (!keepSubmittingForTask) {
      provisioningVisible.value = false;
      provisioningProgress.value = null;
    }
    if (payload.autoStart && response.result.created[0]) {
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
      const mark = `${task.status}:${task.currentStep}:${task.updatedAt}`;
      if (provisioningTaskMarks.get(taskId) !== mark) {
        provisioningTaskMarks.set(taskId, mark);
        pushActivity(provisionTaskActivityTitle(task.status), {
          target: task.title,
          detail: task.message,
          status: provisionTaskActivityStatus(task.status),
        });
        activeProvisionTask.value = task;
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
          await Promise.all([loadVmSummary({ silent: true }), loadVms({ silent: true })]);
          syncSelectedOverviewRowAfterVmChange();
        }
        if (task.status === "failed") {
          setErrorMessage(task.message);
          provisioningSubmitting.value = false;
          loadingVms.value = false;
        }
      }
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
  const header = ["平台", "连接", "物理机", "管理 IP", "状态", "CPU", "CPU 余量", "内存", "内存余量", "存储", "存储余量", "运行 VM / 总 VM", "创建评估", "评估原因", "错误"];
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
  return {
    total,
    running: items.filter((vm) => vm.powerState === "running").length,
    halted: items.filter((vm) => vm.powerState === "halted").length,
    vcpu: items.reduce((sum, vm) => sum + vm.cpuCount, 0),
    memoryBytes: items.reduce((sum, vm) => sum + vm.memoryBytes, 0),
    diskBytes: items.reduce((sum, vm) => sum + positive(vm.diskVirtualBytes ?? 0), 0),
  };
}

function hostCpuPlan(row: HostOverviewRow) {
  const cores = positive(row.host.cpuCores);
  const allocated = positive(row.summary?.vcpu ?? 0);
  const plannedCapacity = cores * 4;
  return {
    cores,
    allocated,
    physicalFree: Math.max(cores - allocated, 0),
    over: Math.max(allocated - cores, 0),
    plannedFree: Math.max(plannedCapacity - allocated, 0),
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
  const cpu = hostCpuPlan(row);
  const memory = hostMemoryPlan(row);
  const storagePlan = hostStoragePlan(row);
  if (cpu.plannedFree < 4 || memory.free < 8 * 1024 ** 3 || storagePlan.freeGiB < 100) {
    return { label: "不适合", className: "recommend-bad", reason: bottleneckText(cpu, memory, storagePlan) };
  }
  if (cpu.plannedFree < 12 || memory.free < 32 * 1024 ** 3 || storagePlan.freeGiB < 500) {
    return { label: "资源紧张", className: "recommend-warn", reason: bottleneckText(cpu, memory, storagePlan) };
  }
  return { label: "适合", className: "recommend-good", reason: `余量 ${formatNumber(cpu.plannedFree)} vCPU / ${formatBytes(memory.free)} / ${formatNumber(storagePlan.freeGiB)} GiB` };
}

function bottleneckText(cpu: ReturnType<typeof hostCpuPlan>, memory: ReturnType<typeof hostMemoryPlan>, storagePlan: ReturnType<typeof hostStoragePlan>) {
  const reasons: string[] = [];
  if (cpu.plannedFree < 12) reasons.push(`CPU 余量 ${formatNumber(cpu.plannedFree)} vCPU`);
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
  if (!row.summary) return `余量 ${formatNumber(cpu.cores * 4)} vCPU`;
  return `余量 ${formatNumber(cpu.plannedFree)} vCPU`;
}

function overviewCpuSubline(row: HostOverviewRow) {
  if (!hasOverviewInventory(row)) return "读取中";
  if (!row.summary) return "分配加载中";
  const cpu = hostCpuPlan(row);
  return `已分配 ${formatNumber(cpu.allocated)} / 4x ${formatNumber(cpu.cores * 4)}`;
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
    const cpu = hostCpuPlan(row);
    return cpu.over > 0 || cpu.percent >= 80 || cpu.plannedFree < 12;
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
  localStorage.setItem("vrc.providerType", payload.providerType);
  if ("connectionId" in payload) {
    localStorage.setItem("vrc.connectionId", payload.connectionId);
    return;
  }
  localStorage.setItem("vrc.host", payload.host);
  localStorage.setItem("vrc.port", String(payload.port));
  localStorage.setItem("vrc.username", payload.username);
}

function clearMessages() {
  errorMessage.value = "";
  successMessage.value = "";
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
</script>

<template>
  <main class="app-shell">
    <aside class="sidebar">
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
        <button class="icon-button" :class="{ active: isSettingsNavActive }" title="设置 / 外观" @click="openSettingsWorkspace">
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

    <section class="workspace">

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
          :vm-load-status-text="vmLoadStatusText"
          :loading-vms="loadingVms"
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
          <el-table-column label="CPU 余量" min-width="140" align="right">
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

            <section class="settings-tile-grid" aria-label="外观偏好">
              <article class="settings-tile">
                <div class="settings-row">
                  <strong>按钮密度</strong>
                  <span>28px 工具栏 / 24px 行内</span>
                </div>
                <div class="settings-row">
                  <span>图标按钮显示 tooltip</span>
                  <span class="settings-switch active"><i></i></span>
                </div>
              </article>
              <article class="settings-tile">
                <div class="settings-row">
                  <strong>表格密度</strong>
                  <span>44-48px 行高</span>
                </div>
                <div class="settings-row">
                  <span>长名称单行省略</span>
                  <span class="settings-switch active"><i></i></span>
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
                  <span class="settings-switch active"><i></i></span>
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
          :vm-load-status-text="vmLoadStatusText"
          :loading-vms="loadingVms"
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

      <ConsoleDialog v-model:visible="consoleDialogVisible" :target="consoleTarget" />

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

      <el-dialog v-model="hostDetailVisible" title="物理机详情" width="760px" :close-on-click-modal="false">
        <div v-if="selectedHost" class="dialog-summary host-detail-summary">
          <span>基础信息</span>
          <strong>{{ selectedHost.name }}</strong>
          <small>{{ selectedHost.address }} · {{ formatCpuCount(selectedHost.cpuCores) }} · {{ formatBytes(selectedHost.memoryTotalBytes) }}</small>
        </div>
        <div class="dialog-section-title">
          <strong>网络接口</strong>
          <span>管理网卡和 PIF 连接状态</span>
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
        @activity="pushActivity($event.title, { target: $event.target, detail: $event.detail, status: $event.status })"
        @open-iso-detail="openIsoDetail"
        @submit="handleProvisioningSubmit"
      />
    </section>
  </main>
</template>
