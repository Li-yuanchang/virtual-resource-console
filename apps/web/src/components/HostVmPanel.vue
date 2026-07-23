<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type ComponentPublicInstance } from "vue";
import { EditPen, Loading, Search } from "@element-plus/icons-vue";
import type { TableInstance } from "element-plus";
import { resolveVmConsoleTarget, resolveVmGraphConsoleTarget, type VmConsoleTarget } from "../domain/consoleStrategies";
import { getProviderBrand } from "../domain/providerBrand";
import type { CapacityBreakdown, HostNode, MemoryCapacityBreakdown, ProviderDescriptor, ProviderType, ResourceCapacitySummary, VmNode, VmPowerAction } from "../types";
import VrcLogoMark from "./VrcLogoMark.vue";
import VrcToolbarIcon from "./VrcToolbarIcon.vue";
import VrcVmActionIcon from "./VrcVmActionIcon.vue";

interface CapacitySummaryItem {
  key: string;
  used: number;
  free: number;
  over: number;
  percent: number;
  subline: string;
}

interface VmTotals {
  all: number;
  running: number;
  halted: number;
  vcpu: number;
  runningVcpu: number;
  memoryBytes: number;
  runningMemoryBytes: number;
  diskBytes: number | null;
}

type VmActionState = {
  action: VmPowerAction;
  status: "pending" | "running" | "success" | "error";
  message?: string;
};
type VmPowerFilter = "all" | "running" | "stopped";
type HostVmPanelVariant = "page" | "dialog";
type VmSortOrder = "ascending" | "descending" | null;
type VmSortKey = "name" | "powerState" | "guestOs" | "cpuCount" | "memoryBytes" | "diskVirtualBytes" | "ip" | "lastShutdownAt";

const powerFilterOptions: Array<{ label: string; value: VmPowerFilter }> = [
  { label: "全部", value: "all" },
  { label: "开机", value: "running" },
  { label: "关机", value: "stopped" },
];

const props = withDefaults(
  defineProps<{
    connection: {
      id: string;
      providerType: ProviderType;
      host: string;
      port: number;
      username: string;
      password?: string;
    };
    providerDescriptor?: ProviderDescriptor;
    host: HostNode;
    networkCount: number;
    resourceSummary: CapacitySummaryItem[];
    resourceCapacity?: ResourceCapacitySummary | null;
    vmTotals: VmTotals;
    hasVmSummary: boolean;
    loadingVmSummary: boolean;
    vms: VmNode[];
    vmsTotal: number;
    selectedVmIds: string[];
    vmActionStates: Record<string, VmActionState>;
    provisioningConsoleVmIds?: string[];
    search: string;
    powerFilter: VmPowerFilter;
    loadingVms: boolean;
    tableHeight?: string | number | null;
    tableMaxHeight?: string | number;
    metricGridClass?: string;
    tablePanelClass?: string;
    variant?: HostVmPanelVariant;
    showIconTooltips?: boolean;
  }>(),
  {
    vmActionStates: () => ({}),
    provisioningConsoleVmIds: () => [],
    tableHeight: "100%",
    tableMaxHeight: undefined,
    metricGridClass: "",
    tablePanelClass: "",
    variant: "page",
    showIconTooltips: true,
  },
);

const emit = defineEmits<{
  "update:search": [value: string];
  "update:powerFilter": [value: VmPowerFilter];
  "search-change": [];
  refresh: [];
  export: [rows: VmNode[]];
  "host-detail": [];
  "storage-detail": [];
  "iso-detail": [];
  "create-vm": [];
  "selection-change": [rows: VmNode[]];
  "open-console": [target: VmConsoleTarget, vm: VmNode];
  "vm-action": [action: VmPowerAction, vm: VmNode];
  "batch-vm-action": [action: VmPowerAction, rows: VmNode[]];
  "schedule-vms": [rows: VmNode[]];
  "rename-vm": [vm: VmNode];
  "resize-vm": [vm: VmNode];
}>();

const searchModel = computed({
  get: () => props.search,
  set: (value: string) => emit("update:search", value),
});
const powerFilterModel = computed({
  get: () => props.powerFilter,
  set: (value: VmPowerFilter) => emit("update:powerFilter", value),
});
const variantClass = computed(() => `host-vm-panel--${props.variant}`);
const iconTooltipsDisabled = computed(() => !props.showIconTooltips);
const providerName = computed(() => props.providerDescriptor?.label ?? getProviderBrand(props.connection.providerType).resourceName);
const networkCountLabel = computed(() => `${props.networkCount} 个${props.providerDescriptor?.networkInterfaceLabel || "网络接口"}`);

const cpuSummary = computed(() => props.resourceSummary[0]);
const storageSummary = computed(() => props.resourceSummary[2]);
const refreshingResources = computed(() => props.loadingVms || props.loadingVmSummary);
const loadingBrand = computed(() => getProviderBrand(props.connection.providerType));
const supportsVmResize = computed(() => props.providerDescriptor?.capabilities.vmResize.supported === true);
const supportsVmRename = computed(() => props.providerDescriptor?.capabilities.vmRename.supported === true);
const supportsVmCreate = computed(() => props.providerDescriptor?.capabilities.vmCreate.supported === true);
const supportsVmConsole = computed(() => props.providerDescriptor?.capabilities.vmConsole.supported === true);
const vmOperationColumnWidth = computed(() => (supportsVmResize.value ? 176 : 144));
const exportTooltipText = computed(() =>
  props.vms.length ? "导出虚拟机清单：下载当前筛选结果 CSV" : "无可导出的虚拟机：当前筛选结果为空",
);
const selectedVmRows = computed(() => props.vms.filter((vm) => props.selectedVmIds.includes(vm.providerId) || props.selectedVmIds.includes(vm.id)));
const selectedVmCount = computed(() => selectedVmRows.value.length);
const batchActionRows = computed<Record<VmPowerAction, VmNode[]>>(() => ({
  start: selectedVmRows.value.filter((vm) => canRunVmAction("start", vm)),
  shutdown: selectedVmRows.value.filter((vm) => canRunVmAction("shutdown", vm)),
  forceReboot: selectedVmRows.value.filter((vm) => canRunVmAction("forceReboot", vm)),
  delete: selectedVmRows.value.filter((vm) => canRunVmAction("delete", vm)),
}));
const vmSort = ref<{ prop: VmSortKey; order: VmSortOrder }>({ prop: "ip", order: "ascending" });
const vmSortingEnabled = computed(() => props.vms.length > 1);
const vmColumnSortable = computed(() => (vmSortingEnabled.value ? "custom" : false));
const defaultVmSort = computed(() => (vmSortingEnabled.value ? { prop: "ip", order: "ascending" as const } : undefined));
const sortedVms = computed(() => {
  if (!vmSortingEnabled.value) return props.vms;
  const { prop, order } = vmSort.value;
  return [...props.vms].sort((left, right) => compareVmRows(left, right, prop, order));
});
const vmTableRef = ref<TableInstance>();
let syncingVmTableSelection = false;

const metricTooltipTargets = new Map<string, HTMLElement>();
const metricTooltipKeys = new WeakMap<HTMLElement, string>();
const metricTooltipOverflow = ref(new Set<string>());
let metricTooltipResizeObserver: ResizeObserver | null = null;

function resolveMetricTooltipElement(target: Element | ComponentPublicInstance | null) {
  if (target instanceof HTMLElement) return target;
  if (target && "$el" in target && target.$el instanceof HTMLElement) return target.$el;
  return null;
}

function updateMetricTooltipOverflow(key: string, element: HTMLElement) {
  const measuredElements = [element, ...element.querySelectorAll<HTMLElement>("strong, small, .metric-label, .capacity-term, .capacity-value, .memory-capacity-detail > span")];
  const isOverflowing = measuredElements.some((item) => item.scrollWidth > item.clientWidth + 1 || item.scrollHeight > item.clientHeight + 1);
  element.dataset.tooltipOverflow = isOverflowing ? "true" : "false";
  const next = new Set(metricTooltipOverflow.value);
  if (isOverflowing) next.add(key);
  else next.delete(key);
  if (next.size !== metricTooltipOverflow.value.size || [...next].some((item) => !metricTooltipOverflow.value.has(item))) metricTooltipOverflow.value = next;
}

function registerMetricTooltip(key: string, target: Element | ComponentPublicInstance | null) {
  const element = resolveMetricTooltipElement(target);
  const previous = metricTooltipTargets.get(key);
  if (previous && previous !== element) metricTooltipResizeObserver?.unobserve(previous);
  if (!element) {
    metricTooltipTargets.delete(key);
    return;
  }
  metricTooltipTargets.set(key, element);
  metricTooltipKeys.set(element, key);
  metricTooltipResizeObserver?.observe(element);
  void nextTick(() => updateMetricTooltipOverflow(key, element));
}

function isMetricTooltipEnabled(key: string) {
  return metricTooltipOverflow.value.has(key);
}

function refreshMetricTooltips() {
  void nextTick(() => {
    for (const [key, element] of metricTooltipTargets) updateMetricTooltipOverflow(key, element);
  });
}

onMounted(() => {
  if (typeof ResizeObserver !== "undefined") {
    metricTooltipResizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const element = entry.target as HTMLElement;
        const key = metricTooltipKeys.get(element);
        if (key) updateMetricTooltipOverflow(key, element);
      }
    });
    for (const [key, element] of metricTooltipTargets) {
      metricTooltipResizeObserver.observe(element);
      updateMetricTooltipOverflow(key, element);
    }
  }
  refreshMetricTooltips();
});

watch(
  () => [props.host, props.networkCount, props.resourceCapacity, props.vmTotals, props.loadingVmSummary, props.hasVmSummary],
  refreshMetricTooltips,
  { deep: true, flush: "post" },
);

onBeforeUnmount(() => {
  metricTooltipResizeObserver?.disconnect();
  metricTooltipResizeObserver = null;
  metricTooltipTargets.clear();
});

function vmSelectionKey(vm: VmNode) {
  return vm.providerId || vm.id;
}

function handleVmSort({ prop, order }: { prop: string; order: VmSortOrder }) {
  if (!vmSortingEnabled.value) return;
  const supported: VmSortKey[] = ["name", "powerState", "guestOs", "cpuCount", "memoryBytes", "diskVirtualBytes", "ip", "lastShutdownAt"];
  vmSort.value = {
    prop: supported.includes(prop as VmSortKey) ? (prop as VmSortKey) : "ip",
    order,
  };
}

function compareVmRows(left: VmNode, right: VmNode, prop: VmSortKey, order: VmSortOrder) {
  if (!order) return compareVmIp(left, right);
  const leftValue = vmSortValue(left, prop);
  const rightValue = vmSortValue(right, prop);
  if (leftValue == null && rightValue == null) return compareVmIp(left, right);
  if (leftValue == null) return 1;
  if (rightValue == null) return -1;
  const direction = order === "ascending" ? 1 : -1;
  const compared =
    typeof leftValue === "number" && typeof rightValue === "number"
      ? leftValue - rightValue
      : String(leftValue).localeCompare(String(rightValue), "zh-CN", { numeric: true, sensitivity: "base" });
  return compared === 0 ? compareVmIp(left, right) : compared * direction;
}

function vmSortValue(vm: VmNode, prop: VmSortKey): string | number | null {
  if (prop === "name") return vm.name;
  if (prop === "powerState") return vmPowerStateRank(vm.powerState);
  if (prop === "guestOs") return displayGuestOs(vm) === "-" ? null : displayGuestOs(vm);
  if (prop === "cpuCount") return Number.isFinite(vm.cpuCount) ? vm.cpuCount : null;
  if (prop === "memoryBytes") return Number.isFinite(vm.memoryBytes) ? vm.memoryBytes : null;
  if (prop === "diskVirtualBytes") return vm.diskVirtualBytes == null || !Number.isFinite(vm.diskVirtualBytes) ? null : vm.diskVirtualBytes;
  if (prop === "lastShutdownAt") {
    const timestamp = vm.lastShutdownAt ? Date.parse(vm.lastShutdownAt) : Number.NaN;
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  return vm.ipAddresses[0] || null;
}

function vmPowerStateRank(value: VmNode["powerState"]) {
  if (value === "running") return 0;
  if (value === "suspended") return 1;
  if (value === "halted" || value === "stopped") return 2;
  return 3;
}

function compareVmIp(left: VmNode, right: VmNode) {
  const leftIp = left.ipAddresses[0] || "";
  const rightIp = right.ipAddresses[0] || "";
  if (!leftIp && !rightIp) return left.name.localeCompare(right.name, "zh-CN", { numeric: true, sensitivity: "base" });
  if (!leftIp) return 1;
  if (!rightIp) return -1;
  const compared = leftIp.localeCompare(rightIp, "zh-CN", { numeric: true, sensitivity: "base" });
  return compared === 0 ? left.name.localeCompare(right.name, "zh-CN", { numeric: true, sensitivity: "base" }) : compared;
}

async function syncVmTableSelection() {
  await nextTick();
  const table = vmTableRef.value;
  if (!table) return;

  const selectedIds = new Set(props.selectedVmIds);
  const targetRows = props.vms.filter((vm) => selectedIds.has(vm.providerId) || selectedIds.has(vm.id));
  const currentKeys = (table.getSelectionRows() as VmNode[]).map(vmSelectionKey).sort();
  const targetKeys = targetRows.map(vmSelectionKey).sort();
  if (currentKeys.length === targetKeys.length && currentKeys.every((key, index) => key === targetKeys[index])) return;

  syncingVmTableSelection = true;
  table.clearSelection();
  for (const row of targetRows) table.toggleRowSelection(row, true);
  await nextTick();
  syncingVmTableSelection = false;
}

function handleVmTableSelectionChange(rows: VmNode[]) {
  if (syncingVmTableSelection) return;
  emit("selection-change", rows);
}

watch(
  () => [props.selectedVmIds.join("|"), props.vms.map(vmSelectionKey).join("|")] as const,
  () => void syncVmTableSelection(),
  { immediate: true, flush: "post" },
);

function percent(used: number, total: number) {
  if (!total) return 0;
  return Math.min(Math.round((used / total) * 100), 999);
}

function barWidth(row: CapacitySummaryItem, segment: "used" | "free" | "over") {
  const total = Math.max(row.used + row.free + row.over, 1);
  return `${Math.round((row[segment] / total) * 1000) / 10}%`;
}

function physicalCapacityBarWidth(capacity: CapacityBreakdown | undefined, segment: "used" | "free") {
  if (!capacity?.physicalTotalGiB) return "0%";
  const value = segment === "free" ? capacity.physicalFreeGiB : capacity.physicalUsedGiB;
  return `${Math.round((value / capacity.physicalTotalGiB) * 1000) / 10}%`;
}

function displayVmIp(vm: VmNode, hostIp?: string) {
  return vm.ipAddresses[0] || "-";
}

function displayGuestOs(vm: VmNode) {
  return vm.guestOs?.trim() || "-";
}

function displayLastShutdownAt(vm: VmNode) {
  if (!vm.lastShutdownAt) return "-";
  const date = new Date(vm.lastShutdownAt);
  if (!Number.isFinite(date.getTime())) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date).replace(/\//g, "-");
}

function formatVmDiskSummary(vm: VmNode) {
  const count = vm.diskCount ?? 0;
  const summary = vm.diskSizeSummary?.trim().replace(/\.0 GiB/g, " GiB");
  if (count > 0 && summary) return `${count} 块 · ${summary}`;
  if (count > 0) return `${count} 块`;
  return "未读到磁盘明细";
}

function formatVmCardSubline(vmTotals: VmTotals) {
  const diskText = vmTotals.diskBytes == null ? "磁盘加载中" : `${formatBytes(vmTotals.diskBytes)} 磁盘`;
  return `${vmTotals.vcpu} vCPU · ${formatBytes(vmTotals.memoryBytes)} 内存 · ${diskText}`;
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

function capacityGiBText(value: number | undefined) {
  if (typeof value === "number" && Number.isFinite(value)) return `${formatNumber(value)} GiB`;
  return props.loadingVmSummary ? "读取中" : "未获取";
}

function capacityValueUnavailable(value: number | undefined) {
  return typeof value !== "number" || !Number.isFinite(value);
}

function isMemoryCapacity(capacity: CapacityBreakdown | undefined): capacity is MemoryCapacityBreakdown {
  return Boolean(capacity && "startupStatus" in capacity);
}

function capacityStateLabel(capacity: CapacityBreakdown | undefined) {
  if (!capacity) return props.loadingVmSummary ? "读取中" : "未获取";
  if (capacity.vmStatus === "overconfigured") return "已超配";
  if (isMemoryCapacity(capacity) && capacity.startupStatus === "at-risk") return "启动风险";
  if (capacity.physicalStatus === "danger") return "容量告警";
  if (capacity.physicalStatus === "warning") return "容量偏紧";
  return "";
}

function capacityStateSuffix(capacity: CapacityBreakdown | undefined) {
  const state = capacityStateLabel(capacity);
  return state ? ` · ${state}` : "";
}

function capacityStateClass(capacity: CapacityBreakdown | undefined) {
  if (!capacity) return props.loadingVmSummary ? "is-loading" : "is-unavailable";
  if (capacity.vmStatus === "overconfigured" || (isMemoryCapacity(capacity) && capacity.startupStatus === "at-risk") || capacity.physicalStatus === "danger") return "is-danger";
  if (capacity.physicalStatus === "warning") return "is-warning";
  return "is-normal";
}

function capacityMeterClass(capacity: CapacityBreakdown | undefined) {
  return {
    warning: capacity?.physicalStatus === "warning",
    danger: capacity?.physicalStatus === "danger",
  };
}

function vmCapacityTerm(capacity: CapacityBreakdown | undefined) {
  return capacity?.vmStatus === "overconfigured" ? "超出" : "剩余";
}

function vmCapacityValue(capacity: CapacityBreakdown | undefined) {
  return capacity?.vmStatus === "overconfigured" ? capacity.vmOverconfiguredGiB : capacity?.vmConfigurableGiB;
}

function vmConfiguredMemoryText() {
  const configured = props.resourceCapacity?.memory.vmConfiguredGiB;
  return typeof configured === "number" && Number.isFinite(configured) ? capacityGiBText(configured) : formatBytes(props.vmTotals.memoryBytes);
}

function memoryGuaranteeText(capacity: MemoryCapacityBreakdown | undefined) {
  if (!capacity) return props.loadingVmSummary ? "保障余量读取中" : "保障余量未获取";
  return capacity.startupStatus === "at-risk"
    ? `启动缺口 ${capacityGiBText(capacity.startupDeficitGiB)}`
    : `保障余量 ${capacityGiBText(capacity.guaranteedHeadroomGiB)}`;
}

function formatCpuCount(value: number) {
  return value > 0 ? `${value} 核` : "未读到";
}

function powerStateLabel(value: VmNode["powerState"]) {
  if (value === "running") return "运行中";
  if (value === "halted" || value === "stopped") return "已关机";
  if (value === "suspended") return "已暂停";
  return "未知";
}

function powerStateClass(value: VmNode["powerState"]) {
  if (value === "running") return "state-running";
  if (value === "halted" || value === "stopped") return "state-stopped";
  if (value === "suspended") return "state-suspended";
  return "state-unknown";
}

function isVmStopped(vm: VmNode) {
  return vm.powerState === "halted" || vm.powerState === "stopped";
}

function isVmRunning(vm: VmNode) {
  return vm.powerState === "running";
}

function vmActionState(vm: VmNode) {
  return props.vmActionStates[vm.providerId] ?? props.vmActionStates[vm.id];
}

function isVmActionBusy(vm: VmNode) {
  const state = vmActionState(vm);
  return state?.status === "pending" || state?.status === "running";
}

function vmActionStatusLabel(vm: VmNode) {
  const state = vmActionState(vm);
  if (!state) return powerStateLabel(vm.powerState);
  if (state.status === "pending" || state.status === "running") return `${vmActionLabel(state.action)}中`;
  if (state.message) return state.message;
  if (state.status === "success") return "已提交";
  return "操作失败";
}

function vmActionLabel(action: VmPowerAction) {
  if (action === "start") return "开机";
  if (action === "shutdown") return "关机";
  if (action === "forceReboot") return "重启";
  return "删除";
}

function vmActionStateClass(vm: VmNode) {
  const state = vmActionState(vm);
  return state ? `vm-action-state-${state.status}` : powerStateClass(vm.powerState);
}

function vmActionTypeClass(vm: VmNode) {
  const state = vmActionState(vm);
  if (!state || (state.status !== "pending" && state.status !== "running")) return "";
  return `vm-action-type-${state.action}`;
}

function vmRowClassName({ row }: { row: VmNode }) {
  const state = vmActionState(row);
  const classes = [];
  if (isVmStopped(row)) classes.push("vm-row-stopped");
  if (state) {
    classes.push(`vm-row-action-${state.status}`);
    classes.push(`vm-row-action-type-${state.action}`);
  }
  if (state?.status === "pending" || state?.status === "running") classes.push("vm-row-action-operating");
  return classes.join(" ");
}

function actionDisabledReason(action: VmPowerAction, vm: VmNode) {
  if (isVmActionBusy(vm)) return "当前 VM 操作正在执行";
  if (action === "start") {
    return isVmStopped(vm) ? "" : "只有已关机的虚拟机可以开机";
  }
  if (action === "shutdown") {
    return isVmRunning(vm) ? "" : "只有运行中的虚拟机可以关机";
  }
  if (action === "forceReboot") {
    return isVmRunning(vm) ? "" : "只有运行中的虚拟机可以强制重启";
  }
  return isVmStopped(vm) ? "" : "删除前需要先关机，避免删除运行中的业务 VM";
}

function actionButtonTitle(action: VmPowerAction, vm: VmNode) {
  const labels: Record<VmPowerAction, string> = {
    start: "开机",
    shutdown: "关机",
    forceReboot: "强制重启",
    delete: "删除",
  };
  const reason = actionDisabledReason(action, vm);
  return reason ? `${labels[action]}：${reason}` : labels[action];
}

function canRunVmAction(action: VmPowerAction, vm: VmNode) {
  return !actionDisabledReason(action, vm);
}

function canResizeVm(vm: VmNode) {
  return isVmRunning(vm) && !isVmActionBusy(vm);
}

function resizeButtonTitle(vm: VmNode) {
  if (isVmActionBusy(vm)) return "资源扩容：当前 VM 操作正在执行";
  if (!isVmRunning(vm)) return "资源扩容：虚拟机已关机，请先开机";
  return "资源扩容";
}

function emitResize(vm: VmNode) {
  if (!canResizeVm(vm)) return;
  emit("resize-vm", vm);
}

function emitVmAction(action: VmPowerAction, vm: VmNode) {
  if (!canRunVmAction(action, vm)) return;
  emit("vm-action", action, vm);
}

function emitBatchVmAction(action: VmPowerAction) {
  const rows = batchActionRows.value[action];
  if (!rows.length) return;
  emit("batch-vm-action", action, rows);
}

function vmConsoleTarget(vm: VmNode) {
  if (!supportsVmConsole.value) return null;
  const context = {
    connection: props.connection,
    vm,
    hostName: props.host.name,
    hostAddress: props.host.address,
  };
  return isProvisioningConsoleVm(vm)
    ? resolveVmGraphConsoleTarget(context) ?? resolveVmConsoleTarget(context)
    : resolveVmConsoleTarget(context);
}

function vmConsoleTargetForRow(vm: VmNode) {
  if (!isVmRunning(vm) || isVmActionBusy(vm)) return null;
  return vmConsoleTarget(vm);
}

function isProvisioningConsoleVm(vm: VmNode) {
  const ids = new Set(props.provisioningConsoleVmIds);
  return ids.has(vm.providerId) || ids.has(vm.id) || ids.has(vm.name);
}

function openVmConsoleByRow(vm: VmNode) {
  const target = vmConsoleTargetForRow(vm);
  if (!target) return;
  emit("open-console", target, vm);
}
</script>

<template>
  <header v-if="variant === 'page'" class="host-vm-page-header overview-header">
    <div class="overview-title-group">
      <h3>物理机虚拟机</h3>
      <span>{{ host.name }} · {{ host.address }} · {{ providerName }} · {{ networkCountLabel }}</span>
    </div>
  </header>

  <section class="metric-grid host-vm-panel-metrics" :class="[metricGridClass, variantClass]">
    <el-tooltip placement="top" effect="light" popper-class="vrc-metric-tooltip" :disabled="!isMetricTooltipEnabled('host')" :show-after="240" :hide-after="0">
      <article class="metric-card host-card" :ref="(element) => registerMetricTooltip('host', element)">
        <div class="metric-label-row">
          <span class="metric-label">物理机</span>
          <button class="metric-link" @click="emit('host-detail')">详情</button>
        </div>
        <strong>{{ host.name }}</strong>
        <small>{{ host.address }} · {{ host.vendor }} {{ host.version }} · {{ networkCountLabel }}</small>
      </article>
      <template #content>
        <div class="metric-card-tooltip-content">
          <strong>{{ host.name }}</strong>
          <span>{{ host.address }} · {{ host.vendor }} {{ host.version }} · {{ networkCountLabel }}</span>
        </div>
      </template>
    </el-tooltip>

    <el-tooltip placement="top" effect="light" popper-class="vrc-metric-tooltip" :disabled="!isMetricTooltipEnabled('cpu')" :show-after="240" :hide-after="0">
      <article class="metric-card cpu-metric-card" :ref="(element) => registerMetricTooltip('cpu', element)">
        <span class="metric-label">CPU 配置</span>
        <div class="metric-main">
          <strong>{{ formatCpuCount(host.cpuCores) }}</strong>
          <span>{{ cpuSummary.percent }}%</span>
        </div>
        <small>{{ vmTotals.runningVcpu }} 运行 vCPU · 共配置 {{ vmTotals.vcpu }} vCPU</small>
        <div class="mini-meter">
          <span class="used" :style="{ width: barWidth(cpuSummary, 'used') }"></span>
          <span class="free" :style="{ width: barWidth(cpuSummary, 'free') }"></span>
        </div>
      </article>
      <template #content>
        <div class="metric-card-tooltip-content">
          <strong>CPU · {{ formatCpuCount(host.cpuCores) }} · {{ cpuSummary.percent }}%</strong>
          <span>{{ vmTotals.runningVcpu }} 运行 vCPU · 共配置 {{ vmTotals.vcpu }} vCPU</span>
        </div>
      </template>
    </el-tooltip>

    <el-tooltip placement="top" effect="light" popper-class="vrc-metric-tooltip vrc-capacity-tooltip" :disabled="!isMetricTooltipEnabled('memory')" :show-after="240" :hide-after="0">
      <article class="metric-card capacity-metric-card memory-metric-card" :ref="(element) => registerMetricTooltip('memory', element)">
        <div class="metric-label-row capacity-card-head">
          <span class="capacity-card-title">
            <span class="metric-label">内存容量</span>
            <span v-if="capacityStateLabel(resourceCapacity?.memory)" class="capacity-state" :class="capacityStateClass(resourceCapacity?.memory)">{{ capacityStateLabel(resourceCapacity?.memory) }}</span>
          </span>
        </div>
        <div class="memory-capacity-primary">
          <span>当前可用</span>
          <strong :class="{ 'is-unavailable': capacityValueUnavailable(resourceCapacity?.memory.physicalFreeGiB) }">{{ capacityGiBText(resourceCapacity?.memory.physicalFreeGiB) }}</strong>
        </div>
        <div class="memory-capacity-detail">
          <span>已用 {{ capacityGiBText(resourceCapacity?.memory.physicalUsedGiB) }} / {{ capacityGiBText(resourceCapacity?.memory.physicalTotalGiB) }}</span>
          <span>未开机 {{ capacityGiBText(resourceCapacity?.memory.haltedConfiguredGiB) }}</span>
        </div>
        <div class="mini-meter" :class="capacityMeterClass(resourceCapacity?.memory)">
          <span class="used" :style="{ width: physicalCapacityBarWidth(resourceCapacity?.memory, 'used') }"></span>
          <span class="free" :style="{ width: physicalCapacityBarWidth(resourceCapacity?.memory, 'free') }"></span>
        </div>
      </article>
      <template #content>
        <div class="metric-card-tooltip-content capacity-tooltip-content memory-tooltip-content">
          <strong>内存 · 当前可用 {{ capacityGiBText(resourceCapacity?.memory.physicalFreeGiB) }}{{ capacityStateSuffix(resourceCapacity?.memory) }}</strong>
          <table class="metric-tooltip-table" aria-label="内存容量明细">
            <tbody>
              <tr>
                <th scope="row">物理</th>
                <td class="metric-tooltip-term">已用</td>
                <td class="metric-tooltip-value">{{ capacityGiBText(resourceCapacity?.memory.physicalUsedGiB) }}</td>
                <td class="metric-tooltip-term">当前可用</td>
                <td class="metric-tooltip-value">{{ capacityGiBText(resourceCapacity?.memory.physicalFreeGiB) }}</td>
                <td class="metric-tooltip-term">总量</td>
                <td class="metric-tooltip-value">{{ capacityGiBText(resourceCapacity?.memory.physicalTotalGiB) }}</td>
              </tr>
              <tr>
                <th scope="row">VM 内存</th>
                <td class="metric-tooltip-term">运行中</td>
                <td class="metric-tooltip-value">{{ capacityGiBText(resourceCapacity?.memory.runningConfiguredGiB) }}</td>
                <td class="metric-tooltip-term">未开机</td>
                <td class="metric-tooltip-value">{{ capacityGiBText(resourceCapacity?.memory.haltedConfiguredGiB) }}</td>
                <td class="metric-tooltip-term">合计</td>
                <td class="metric-tooltip-value">{{ vmConfiguredMemoryText() }}</td>
              </tr>
            </tbody>
          </table>
          <span class="metric-tooltip-note">{{ memoryGuaranteeText(resourceCapacity?.memory) }} · 未开机 VM 重新启动时需要再次分配内存</span>
        </div>
      </template>
    </el-tooltip>

    <el-tooltip placement="top" effect="light" popper-class="vrc-metric-tooltip vrc-capacity-tooltip" :disabled="!isMetricTooltipEnabled('storage')" :show-after="240" :hide-after="0">
      <article class="metric-card capacity-metric-card storage-metric-card" :ref="(element) => registerMetricTooltip('storage', element)">
        <div class="metric-label-row">
          <span class="capacity-card-title">
            <span class="metric-label">存储 · 物理总量 {{ capacityGiBText(resourceCapacity?.storage.physicalTotalGiB) }}</span>
            <span v-if="capacityStateLabel(resourceCapacity?.storage)" class="capacity-state" :class="capacityStateClass(resourceCapacity?.storage)">{{ capacityStateLabel(resourceCapacity?.storage) }}</span>
          </span>
          <span class="metric-link-group">
            <button class="metric-link" @click="emit('iso-detail')">ISO</button>
            <button class="metric-link" @click="emit('storage-detail')">详情</button>
          </span>
        </div>
        <div class="resource-capacity-rows">
          <div class="resource-capacity-row">
            <strong>物理</strong>
            <span class="capacity-term">已分配</span>
            <b class="capacity-value" :class="{ 'is-unavailable': capacityValueUnavailable(resourceCapacity?.storage.physicalUsedGiB) }">{{ capacityGiBText(resourceCapacity?.storage.physicalUsedGiB) }}</b>
            <span class="capacity-term">剩余</span>
            <b class="capacity-value" :class="{ 'is-unavailable': capacityValueUnavailable(resourceCapacity?.storage.physicalFreeGiB) }">{{ capacityGiBText(resourceCapacity?.storage.physicalFreeGiB) }}</b>
          </div>
          <div class="resource-capacity-row">
            <strong>虚拟</strong>
            <span class="capacity-term">已分配</span>
            <b class="capacity-value" :class="{ 'is-unavailable': capacityValueUnavailable(resourceCapacity?.storage.vmConfiguredGiB) }">{{ capacityGiBText(resourceCapacity?.storage.vmConfiguredGiB) }}</b>
            <span class="capacity-term" :class="{ 'is-overcommitted': resourceCapacity?.storage.vmStatus === 'overconfigured' }">{{ vmCapacityTerm(resourceCapacity?.storage) }}</span>
            <b class="capacity-value" :class="{ 'is-unavailable': capacityValueUnavailable(vmCapacityValue(resourceCapacity?.storage)), 'is-overcommitted': resourceCapacity?.storage.vmStatus === 'overconfigured' }">{{ capacityGiBText(vmCapacityValue(resourceCapacity?.storage)) }}</b>
          </div>
        </div>
        <div class="mini-meter" :class="capacityMeterClass(resourceCapacity?.storage)">
          <span class="used" :style="{ width: barWidth(storageSummary, 'used') }"></span>
          <span class="free" :style="{ width: barWidth(storageSummary, 'free') }"></span>
        </div>
      </article>
      <template #content>
        <div class="metric-card-tooltip-content capacity-tooltip-content storage-tooltip-content">
          <strong>存储 · 物理总量 {{ capacityGiBText(resourceCapacity?.storage.physicalTotalGiB) }}{{ capacityStateSuffix(resourceCapacity?.storage) }}</strong>
          <table class="metric-tooltip-table" aria-label="存储容量明细">
            <tbody>
              <tr>
                <th scope="row">物理</th>
                <td class="metric-tooltip-term">已分配</td>
                <td class="metric-tooltip-value">{{ capacityGiBText(resourceCapacity?.storage.physicalUsedGiB) }}</td>
                <td class="metric-tooltip-term">剩余</td>
                <td class="metric-tooltip-value">{{ capacityGiBText(resourceCapacity?.storage.physicalFreeGiB) }}</td>
              </tr>
              <tr>
                <th scope="row">虚拟</th>
                <td class="metric-tooltip-term">已分配</td>
                <td class="metric-tooltip-value">{{ capacityGiBText(resourceCapacity?.storage.vmConfiguredGiB) }}</td>
                <td class="metric-tooltip-term">{{ vmCapacityTerm(resourceCapacity?.storage) }}</td>
                <td class="metric-tooltip-value">{{ capacityGiBText(vmCapacityValue(resourceCapacity?.storage)) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </el-tooltip>

    <el-tooltip placement="top" effect="light" popper-class="vrc-metric-tooltip" :disabled="!isMetricTooltipEnabled('vm')" :show-after="240" :hide-after="0">
      <article class="metric-card vm-metric-card" :ref="(element) => registerMetricTooltip('vm', element)">
        <span class="metric-label">VM</span>
        <div class="metric-main">
          <strong>{{ vmTotals.running }} / {{ vmTotals.all }}</strong>
          <span>{{ percent(vmTotals.running, vmTotals.all) }}%</span>
        </div>
        <small>{{ loadingVmSummary && !hasVmSummary ? "VM 汇总加载中" : formatVmCardSubline(vmTotals) }}</small>
        <div class="mini-meter vm-meter">
          <span class="used" :style="{ width: `${percent(vmTotals.running, vmTotals.all)}%` }"></span>
          <span class="free" :style="{ width: `${100 - Math.min(percent(vmTotals.running, vmTotals.all), 100)}%` }"></span>
        </div>
      </article>
      <template #content>
        <div class="metric-card-tooltip-content">
          <strong>VM · {{ vmTotals.running }} / {{ vmTotals.all }} · {{ percent(vmTotals.running, vmTotals.all) }}%</strong>
          <span>{{ loadingVmSummary && !hasVmSummary ? "VM 汇总加载中" : formatVmCardSubline(vmTotals) }}</span>
        </div>
      </template>
    </el-tooltip>
  </section>

  <section class="panel table-panel host-vm-panel-table" :class="[tablePanelClass, variantClass]">
    <div class="table-toolbar vm-table-toolbar">
      <div class="vm-table-toolbar-main">
        <div class="table-heading">
          <h3>虚拟机</h3>
          <span>
            {{ vms.length }} / {{ vmsTotal }} · 配置内存 {{ vmConfiguredMemoryText() }}
            <template v-if="search.trim()"> · 已定位 {{ search.trim() }}</template>
          </span>
        </div>
        <div class="table-query-group">
          <el-input v-model="searchModel" class="search-input" :prefix-icon="Search" placeholder="搜索名称 / UUID / IP" clearable @change="emit('search-change')" />
          <el-segmented v-model="powerFilterModel" class="vm-power-filter" :options="powerFilterOptions" aria-label="虚拟机状态筛选" />
        </div>
      </div>
      <div v-if="selectedVmCount" class="vm-batch-actions" aria-label="批量虚拟机操作">
        <span class="vm-batch-count">已选 {{ selectedVmCount }} 台</span>
        <el-tooltip :content="batchActionRows.start.length ? `批量开机 ${batchActionRows.start.length} 台已关机 VM` : '所选 VM 中没有可开机项'" placement="top" :disabled="iconTooltipsDisabled">
          <span class="toolbar-tooltip-target">
            <button type="button" class="vm-batch-action action-start" :disabled="!batchActionRows.start.length" aria-label="批量开机" @click="emitBatchVmAction('start')">
              <VrcVmActionIcon name="start" />
            </button>
          </span>
        </el-tooltip>
        <el-tooltip :content="batchActionRows.shutdown.length ? `批量关机 ${batchActionRows.shutdown.length} 台运行中 VM` : '所选 VM 中没有可关机项'" placement="top" :disabled="iconTooltipsDisabled">
          <span class="toolbar-tooltip-target">
            <button type="button" class="vm-batch-action action-shutdown" :disabled="!batchActionRows.shutdown.length" aria-label="批量关机" @click="emitBatchVmAction('shutdown')">
              <VrcVmActionIcon name="shutdown" />
            </button>
          </span>
        </el-tooltip>
        <el-tooltip :content="batchActionRows.forceReboot.length ? `批量重启 ${batchActionRows.forceReboot.length} 台运行中 VM` : '所选 VM 中没有可重启项'" placement="top" :disabled="iconTooltipsDisabled">
          <span class="toolbar-tooltip-target">
            <button type="button" class="vm-batch-action action-force-reboot" :disabled="!batchActionRows.forceReboot.length" aria-label="批量重启" @click="emitBatchVmAction('forceReboot')">
              <VrcVmActionIcon name="forceReboot" />
            </button>
          </span>
        </el-tooltip>
        <el-tooltip :content="batchActionRows.delete.length ? `批量删除 ${batchActionRows.delete.length} 台已关机 VM` : '删除前需先关机'" placement="top" :disabled="iconTooltipsDisabled">
          <span class="toolbar-tooltip-target">
            <button type="button" class="vm-batch-action action-delete" :disabled="!batchActionRows.delete.length" aria-label="批量删除" @click="emitBatchVmAction('delete')">
              <VrcVmActionIcon name="delete" />
            </button>
          </span>
        </el-tooltip>
        <el-tooltip :content="`为所选 ${selectedVmCount} 台 VM 创建定时任务`" placement="top" :disabled="iconTooltipsDisabled">
          <span class="toolbar-tooltip-target">
            <button type="button" class="vm-batch-action schedule-batch-action" aria-label="创建定时任务" @click="emit('schedule-vms', selectedVmRows)">
              <VrcToolbarIcon name="schedule" />
            </button>
          </span>
        </el-tooltip>
      </div>
      <div class="toolbar-action-buttons" aria-label="虚拟机表格操作">
        <el-tooltip content="创建虚拟机：按当前物理机资源打开创建向导" placement="top" :disabled="iconTooltipsDisabled">
          <span class="toolbar-tooltip-target">
            <button type="button" class="toolbar-action-button create-vm-action" :disabled="!supportsVmCreate" aria-label="创建虚拟机" @click="emit('create-vm')">
              <VrcToolbarIcon name="create-vm" />
            </button>
          </span>
        </el-tooltip>
        <el-tooltip :content="exportTooltipText" placement="top" :disabled="iconTooltipsDisabled">
          <span class="toolbar-tooltip-target">
            <button type="button" class="toolbar-action-button" :disabled="!vms.length" aria-label="导出虚拟机清单" @click="emit('export', sortedVms)">
              <VrcToolbarIcon name="export" />
            </button>
          </span>
        </el-tooltip>
        <el-tooltip content="刷新资源：重新读取当前物理机虚拟机清单和容量汇总" placement="top" :disabled="iconTooltipsDisabled">
          <span class="toolbar-tooltip-target">
            <button type="button" class="toolbar-action-button" :disabled="refreshingResources" aria-label="刷新虚拟机和资源容量" @click="emit('refresh')">
              <el-icon v-if="refreshingResources" class="toolbar-refresh-loading is-loading"><Loading /></el-icon>
              <VrcToolbarIcon v-else name="refresh" />
            </button>
          </span>
        </el-tooltip>
      </div>
    </div>

    <div class="vm-table-wrap" :class="{ loading: loadingVms }">
      <el-table
        ref="vmTableRef"
        class="resource-sort-table vm-resource-table"
        :data="sortedVms"
        :height="tableHeight || undefined"
        :max-height="tableMaxHeight"
        :empty-text="loadingVms ? ' ' : '暂无虚拟机数据'"
        row-key="providerId"
        :default-sort="defaultVmSort"
        :row-class-name="vmRowClassName"
        stripe
        @sort-change="handleVmSort"
        @selection-change="handleVmTableSelectionChange"
      >
        <el-table-column type="selection" width="40" align="center" reserve-selection />
        <el-table-column type="index" label="序号" width="50" align="center" />
        <el-table-column prop="name" label="名称" min-width="240" align="left" :sortable="vmColumnSortable" show-overflow-tooltip>
          <template #default="{ row }">
            <div class="vm-name-entry">
              <button v-if="vmConsoleTargetForRow(row)" type="button" class="vm-console-link drilldown-link vrc-copyable-text" :title="`${vmConsoleTargetForRow(row)?.title}，点击打开控制台`" @click.stop="openVmConsoleByRow(row)">
                {{ row.name }}
              </button>
              <span v-else class="vm-name-cell vrc-copyable-text">{{ row.name }}</span>
              <button
                v-if="supportsVmRename"
                type="button"
                class="vm-rename-entry"
                :aria-label="`修改虚拟机名称：${row.name}`"
                :title="`修改虚拟机名称：${row.name}`"
                @click.stop="emit('rename-vm', row)"
              >
                <el-icon><EditPen /></el-icon>
              </button>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="powerState" label="状态" width="96" align="center" :sortable="vmColumnSortable" class-name="vm-state-column" label-class-name="vm-state-column">
          <template #default="{ row }">
            <span class="vm-state-inline" :class="[vmActionStateClass(row), vmActionTypeClass(row), { 'is-action-busy': isVmActionBusy(row) }]">
              <template v-if="isVmActionBusy(row)">
                <span class="vm-action-stage-copy">{{ vmActionStatusLabel(row) }}</span>
                <span class="vm-action-stage-dots" aria-hidden="true"><i></i><i></i><i></i></span>
              </template>
              <template v-else>
                <span class="state-text" :class="vmActionStateClass(row)">{{ vmActionStatusLabel(row) }}</span>
              </template>
            </span>
          </template>
        </el-table-column>
        <el-table-column prop="guestOs" label="系统" min-width="170" align="left" :sortable="vmColumnSortable" show-overflow-tooltip class-name="vm-os-column" label-class-name="vm-os-column">
          <template #default="{ row }"><span class="vrc-copyable-text">{{ displayGuestOs(row) }}</span></template>
        </el-table-column>
        <el-table-column prop="cpuCount" label="vCPU" width="84" align="center" :sortable="vmColumnSortable">
          <template #default="{ row }"><span class="vrc-copyable-text">{{ formatCpuCount(row.cpuCount) }}</span></template>
        </el-table-column>
        <el-table-column prop="memoryBytes" label="配置内存" width="96" align="center" :sortable="vmColumnSortable">
          <template #default="{ row }"><span class="vrc-copyable-text">{{ formatBytes(row.memoryBytes) }}</span></template>
        </el-table-column>
        <el-table-column prop="diskVirtualBytes" label="虚拟磁盘" width="220" align="center" :sortable="vmColumnSortable">
          <template #default="{ row }">
            <span class="disk-total vrc-copyable-text" :title="formatVmDiskSummary(row)">{{ formatBytes(row.diskVirtualBytes ?? 0) }}</span>
            <small class="disk-subtitle vrc-copyable-text">{{ formatVmDiskSummary(row) }}</small>
          </template>
        </el-table-column>
        <el-table-column prop="ip" label="IP" width="128" align="center" :sortable="vmColumnSortable">
          <template #default="{ row }"><span class="vrc-copyable-text">{{ displayVmIp(row, host.address) }}</span></template>
        </el-table-column>
        <el-table-column prop="lastShutdownAt" label="关机时间" width="150" align="center" :sortable="vmColumnSortable">
          <template #default="{ row }"><span class="vrc-copyable-text">{{ displayLastShutdownAt(row) }}</span></template>
        </el-table-column>
        <el-table-column label="操作" :width="vmOperationColumnWidth" align="center" fixed="right" class-name="vm-operation-column" label-class-name="vm-operation-column">
          <template #default="{ row }">
            <div class="vm-action-cell">
              <button type="button" class="vm-action-link action-start" :disabled="!canRunVmAction('start', row)" :aria-label="actionButtonTitle('start', row)" :title="actionButtonTitle('start', row)" @click.stop="emitVmAction('start', row)">
                <VrcVmActionIcon name="start" />
              </button>
              <button type="button" class="vm-action-link action-shutdown" :disabled="!canRunVmAction('shutdown', row)" :aria-label="actionButtonTitle('shutdown', row)" :title="actionButtonTitle('shutdown', row)" @click.stop="emitVmAction('shutdown', row)">
                <VrcVmActionIcon name="shutdown" />
              </button>
              <button type="button" class="vm-action-link action-force-reboot" :disabled="!canRunVmAction('forceReboot', row)" :aria-label="actionButtonTitle('forceReboot', row)" :title="actionButtonTitle('forceReboot', row)" @click.stop="emitVmAction('forceReboot', row)">
                <VrcVmActionIcon name="forceReboot" />
              </button>
              <button v-if="supportsVmResize" type="button" class="vm-action-link action-resize" :disabled="!canResizeVm(row)" :aria-label="resizeButtonTitle(row)" :title="resizeButtonTitle(row)" @click.stop="emitResize(row)">
                <VrcVmActionIcon name="resize" />
              </button>
              <button type="button" class="vm-action-link action-delete" :disabled="!canRunVmAction('delete', row)" :aria-label="actionButtonTitle('delete', row)" :title="actionButtonTitle('delete', row)" @click.stop="emitVmAction('delete', row)">
                <VrcVmActionIcon name="delete" />
              </button>
            </div>
          </template>
        </el-table-column>
      </el-table>
      <div v-if="loadingVms" class="resource-table-loading" :class="`platform-${loadingBrand.type}`">
        <div class="resource-loader-mark" aria-hidden="true">
          <span class="resource-loader-ring"></span>
          <VrcLogoMark :grid="false" />
        </div>
        <div class="resource-loader-copy">
          <strong>正在读取虚拟机清单</strong>
          <span>{{ loadingBrand.resourceName }} · {{ host.name }}</span>
        </div>
        <div class="resource-loader-progress" aria-hidden="true">
          <i></i>
          <i></i>
          <i></i>
        </div>
      </div>
    </div>
  </section>
</template>
