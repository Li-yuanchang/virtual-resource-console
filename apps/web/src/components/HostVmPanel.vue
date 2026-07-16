<script setup lang="ts">
import { computed } from "vue";
import { EditPen, Search } from "@element-plus/icons-vue";
import { resolveVmConsoleTarget, type VmConsoleTarget } from "../domain/consoleStrategies";
import { getProviderBrand } from "../domain/providerBrand";
import type { HostNode, ProviderType, VmNode, VmPowerAction } from "../types";
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

interface StorageTotals {
  usedGiB: number;
  physicalGiB: number;
  virtualGiB: number;
  usagePercent: number;
}

interface VmTotals {
  all: number;
  running: number;
  halted: number;
  vcpu: number;
  runningVcpu: number;
  memoryBytes: number;
  diskBytes: number | null;
}

type VmActionState = {
  action: VmPowerAction;
  status: "pending" | "running" | "success" | "error";
  message?: string;
};
type VmPowerFilter = "all" | "running" | "stopped";
type HostVmPanelVariant = "page" | "dialog";

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
    };
    host: HostNode;
    networkCount: number;
    resourceSummary: CapacitySummaryItem[];
    hostMemoryPercent: number;
    storageTotals: StorageTotals;
    vmTotals: VmTotals;
    hasVmSummary: boolean;
    loadingVmSummary: boolean;
    vms: VmNode[];
    vmsTotal: number;
    selectedVmIds: string[];
    vmActionStates: Record<string, VmActionState>;
    search: string;
    powerFilter: VmPowerFilter;
    loadingVms: boolean;
    tableHeight?: string | number | null;
    tableMaxHeight?: string | number;
    metricGridClass?: string;
    tablePanelClass?: string;
    variant?: HostVmPanelVariant;
    allowVmRename?: boolean;
  }>(),
  {
    vmActionStates: () => ({}),
    tableHeight: "100%",
    tableMaxHeight: undefined,
    metricGridClass: "",
    tablePanelClass: "",
    variant: "page",
    allowVmRename: false,
  },
);

const emit = defineEmits<{
  "update:search": [value: string];
  "update:powerFilter": [value: VmPowerFilter];
  "search-change": [];
  refresh: [];
  export: [];
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
const providerName = computed(() => providerLabel(props.connection.providerType));
const networkCountLabel = computed(() => formatNetworkCount(props.connection.providerType, props.networkCount));

const cpuSummary = computed(() => props.resourceSummary[0]);
const memorySummary = computed(() => props.resourceSummary[1]);
const storageSummary = computed(() => props.resourceSummary[2]);
const loadingBrand = computed(() => getProviderBrand(props.connection.providerType));
const exportTooltipText = computed(() =>
  props.vms.length ? "导出虚拟机清单：下载当前筛选结果 CSV" : "无可导出的虚拟机：当前筛选结果为空",
);
const selectedVmRows = computed(() => props.vms.filter((vm) => props.selectedVmIds.includes(vm.providerId) || props.selectedVmIds.includes(vm.id)));
const selectedVmCount = computed(() => selectedVmRows.value.length);
const batchActionRows = computed<Record<VmPowerAction, VmNode[]>>(() => ({
  start: selectedVmRows.value.filter((vm) => canRunVmAction("start", vm)),
  shutdown: selectedVmRows.value.filter((vm) => canRunVmAction("shutdown", vm)),
  delete: selectedVmRows.value.filter((vm) => canRunVmAction("delete", vm)),
}));

function percent(used: number, total: number) {
  if (!total) return 0;
  return Math.min(Math.round((used / total) * 100), 999);
}

function barWidth(row: CapacitySummaryItem, segment: "used" | "free" | "over") {
  const total = Math.max(row.used + row.free + row.over, 1);
  return `${Math.round((row[segment] / total) * 1000) / 10}%`;
}

function displayVmIp(vm: VmNode, hostIp?: string) {
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

function formatCpuCount(value: number) {
  return value > 0 ? `${value} 核` : "未读到";
}

function providerLabel(value: ProviderType) {
  if (value === "xenserver") return "XenServer";
  if (value === "vmware") return "VMware";
  if (value === "proxmox") return "Proxmox VE";
  return "KVM/libvirt";
}

function formatNetworkCount(providerType: ProviderType, count: number) {
  if (providerType === "xenserver") return `${count} 个 PIF`;
  if (providerType === "vmware") return `${count} 个 VMkernel 网卡`;
  if (providerType === "proxmox") return `${count} 个网络接口`;
  return `${count} 个网络接口`;
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
  return isVmStopped(vm) ? "" : "删除前需要先关机，避免删除运行中的业务 VM";
}

function canRunVmAction(action: VmPowerAction, vm: VmNode) {
  return !actionDisabledReason(action, vm);
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
  return resolveVmConsoleTarget({
    connection: props.connection,
    vm,
    hostName: props.host.name,
    hostAddress: props.host.address,
  });
}

function openVmConsoleByRow(vm: VmNode) {
  const target = vmConsoleTarget(vm);
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
    <article class="metric-card host-card">
      <div class="metric-label-row">
        <span class="metric-label">物理机</span>
        <button class="metric-link" @click="emit('host-detail')">详情</button>
      </div>
      <strong>{{ host.name }}</strong>
      <small>{{ host.address }} · {{ host.vendor }} {{ host.version }} · {{ networkCountLabel }}</small>
    </article>
    <article class="metric-card">
      <span class="metric-label">CPU</span>
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
    <article class="metric-card">
      <span class="metric-label">内存</span>
      <div class="metric-main">
        <strong>{{ formatBytes(host.memoryTotalBytes - (host.memoryFreeBytes ?? 0)) }} / {{ formatBytes(host.memoryTotalBytes) }}</strong>
        <span>{{ hostMemoryPercent }}%</span>
      </div>
      <small>{{ memorySummary.subline }}</small>
      <div class="mini-meter" :class="{ warning: memorySummary.percent >= 85 }">
        <span class="used" :style="{ width: barWidth(memorySummary, 'used') }"></span>
        <span class="free" :style="{ width: barWidth(memorySummary, 'free') }"></span>
      </div>
    </article>
    <article class="metric-card">
      <div class="metric-label-row">
        <span class="metric-label">存储</span>
        <span class="metric-link-group">
          <button class="metric-link" @click="emit('iso-detail')">ISO</button>
          <button class="metric-link" @click="emit('storage-detail')">详情</button>
        </span>
      </div>
      <div class="metric-main">
        <strong>{{ formatNumber(storageTotals.usedGiB) }} / {{ formatNumber(storageTotals.physicalGiB) }} GiB</strong>
        <span>{{ storageTotals.usagePercent }}%</span>
      </div>
      <small>剩余 {{ formatNumber(storageSummary.free) }} GiB · 虚拟分配 {{ formatNumber(storageTotals.virtualGiB) }} GiB</small>
      <div class="mini-meter" :class="{ warning: storageSummary.percent >= 85 }">
        <span class="used" :style="{ width: barWidth(storageSummary, 'used') }"></span>
        <span class="free" :style="{ width: barWidth(storageSummary, 'free') }"></span>
      </div>
    </article>
    <article class="metric-card">
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
  </section>

  <section class="panel table-panel host-vm-panel-table" :class="[tablePanelClass, variantClass]">
    <div class="table-toolbar vm-table-toolbar">
      <div class="vm-table-toolbar-main">
        <div class="table-heading">
          <h3>虚拟机</h3>
          <span>
            {{ vms.length }} / {{ vmsTotal }} · {{ host.name }}
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
        <el-tooltip :content="batchActionRows.start.length ? `批量开机 ${batchActionRows.start.length} 台已关机 VM` : '所选 VM 中没有可开机项'" placement="top">
          <span class="toolbar-tooltip-target">
            <button type="button" class="vm-batch-action action-start" :disabled="!batchActionRows.start.length" aria-label="批量开机" @click="emitBatchVmAction('start')">
              <VrcVmActionIcon name="start" />
            </button>
          </span>
        </el-tooltip>
        <el-tooltip :content="batchActionRows.shutdown.length ? `批量关机 ${batchActionRows.shutdown.length} 台运行中 VM` : '所选 VM 中没有可关机项'" placement="top">
          <span class="toolbar-tooltip-target">
            <button type="button" class="vm-batch-action action-shutdown" :disabled="!batchActionRows.shutdown.length" aria-label="批量关机" @click="emitBatchVmAction('shutdown')">
              <VrcVmActionIcon name="shutdown" />
            </button>
          </span>
        </el-tooltip>
        <el-tooltip :content="batchActionRows.delete.length ? `批量删除 ${batchActionRows.delete.length} 台已关机 VM` : '删除前需先关机'" placement="top">
          <span class="toolbar-tooltip-target">
            <button type="button" class="vm-batch-action action-delete" :disabled="!batchActionRows.delete.length" aria-label="批量删除" @click="emitBatchVmAction('delete')">
              <VrcVmActionIcon name="delete" />
            </button>
          </span>
        </el-tooltip>
        <el-tooltip :content="`为所选 ${selectedVmCount} 台 VM 创建定时任务`" placement="top">
          <span class="toolbar-tooltip-target">
            <button type="button" class="vm-batch-action schedule-batch-action" aria-label="创建定时任务" @click="emit('schedule-vms', selectedVmRows)">
              <VrcToolbarIcon name="schedule" />
            </button>
          </span>
        </el-tooltip>
      </div>
      <div class="toolbar-action-buttons" aria-label="虚拟机表格操作">
        <el-tooltip content="创建虚拟机：按当前物理机资源打开创建向导" placement="top">
          <span class="toolbar-tooltip-target">
            <button type="button" class="toolbar-action-button create-vm-action" aria-label="创建虚拟机" @click="emit('create-vm')">
              <VrcToolbarIcon name="create-vm" />
            </button>
          </span>
        </el-tooltip>
        <el-tooltip :content="exportTooltipText" placement="top">
          <span class="toolbar-tooltip-target">
            <button type="button" class="toolbar-action-button" :disabled="!vms.length" aria-label="导出虚拟机清单" @click="emit('export')">
              <VrcToolbarIcon name="export" />
            </button>
          </span>
        </el-tooltip>
        <el-tooltip content="刷新列表：重新读取当前物理机虚拟机清单" placement="top">
          <span class="toolbar-tooltip-target">
            <button type="button" class="toolbar-action-button" :disabled="loadingVms" aria-label="刷新虚拟机列表" @click="emit('refresh')">
              <VrcToolbarIcon name="refresh" />
            </button>
          </span>
        </el-tooltip>
      </div>
    </div>

    <div class="vm-table-wrap" :class="{ loading: loadingVms }">
      <el-table
        :data="vms"
        :height="tableHeight || undefined"
        :max-height="tableMaxHeight"
        :empty-text="loadingVms ? ' ' : '暂无虚拟机数据'"
        row-key="providerId"
        :row-class-name="vmRowClassName"
        stripe
        @selection-change="emit('selection-change', $event)"
      >
        <el-table-column type="selection" width="40" align="center" reserve-selection />
        <el-table-column type="index" label="序号" width="50" align="center" />
        <el-table-column prop="name" label="名称" min-width="240" align="left" show-overflow-tooltip>
          <template #default="{ row }">
            <div class="vm-name-entry">
              <button v-if="vmConsoleTarget(row)" class="vm-console-link drilldown-link" :title="`${vmConsoleTarget(row)?.title}，点击打开控制台`" @click.stop="openVmConsoleByRow(row)">
                {{ row.name }}
              </button>
              <span v-else class="vm-name-cell">{{ row.name }}</span>
              <button
                v-if="allowVmRename"
                type="button"
                class="vm-rename-entry"
                :aria-label="`修改虚拟机名称：${row.name}`"
                @click.stop="emit('rename-vm', row)"
              >
                <el-icon><EditPen /></el-icon>
              </button>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="powerState" label="状态" width="96" align="center" class-name="vm-state-column" label-class-name="vm-state-column">
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
        <el-table-column label="系统" min-width="170" align="left" show-overflow-tooltip class-name="vm-os-column" label-class-name="vm-os-column">
          <template #default="{ row }">{{ displayGuestOs(row) }}</template>
        </el-table-column>
        <el-table-column label="vCPU" width="64" align="center">
          <template #default="{ row }">{{ formatCpuCount(row.cpuCount) }}</template>
        </el-table-column>
        <el-table-column label="内存" width="78" align="center">
          <template #default="{ row }">{{ formatBytes(row.memoryBytes) }}</template>
        </el-table-column>
        <el-table-column label="磁盘" width="220" align="center">
          <template #default="{ row }">
            <span class="disk-total" :title="formatVmDiskSummary(row)">{{ formatBytes(row.diskVirtualBytes ?? 0) }}</span>
            <small class="disk-subtitle">{{ formatVmDiskSummary(row) }}</small>
          </template>
        </el-table-column>
        <el-table-column label="IP" width="128" align="center">
          <template #default="{ row }">{{ displayVmIp(row, host.address) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="116" align="center" fixed="right" class-name="vm-operation-column" label-class-name="vm-operation-column">
          <template #default="{ row }">
            <div class="vm-action-cell">
              <button class="vm-action-link action-start" :disabled="!canRunVmAction('start', row)" :aria-label="actionDisabledReason('start', row) || '开机'" @click.stop="emitVmAction('start', row)">
                <VrcVmActionIcon name="start" />
              </button>
              <button class="vm-action-link action-shutdown" :disabled="!canRunVmAction('shutdown', row)" :aria-label="actionDisabledReason('shutdown', row) || '关机'" @click.stop="emitVmAction('shutdown', row)">
                <VrcVmActionIcon name="shutdown" />
              </button>
              <button class="vm-action-link action-delete" :disabled="!canRunVmAction('delete', row)" :aria-label="actionDisabledReason('delete', row) || '删除'" @click.stop="emitVmAction('delete', row)">
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
