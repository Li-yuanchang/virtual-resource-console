<script setup lang="ts">
import {
  Clock,
  Close,
  Delete,
  EditPen,
  Finished,
  Search,
  Setting,
} from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { computed, nextTick, onMounted, ref } from "vue";
import VrcLogoMark from "../components/VrcLogoMark.vue";
import VrcToolbarIcon from "../components/VrcToolbarIcon.vue";
import VrcVmActionIcon from "../components/VrcVmActionIcon.vue";

type PowerState = "running" | "halted";
type ScheduleAction = "start" | "shutdown";
type ScheduleCycle = "once" | "daily" | "weekly";
type ScheduleView = "create" | "tasks";

interface PrototypeVm {
  id: string;
  name: string;
  powerState: PowerState;
  guestOs: string;
  cpuCount: number;
  memoryGiB: number;
  diskGiB: number;
  ip: string;
  hostId: string;
  hostName: string;
  connectionName: string;
  provider: string;
}

interface SchedulePlan {
  id: number;
  name: string;
  action: ScheduleAction;
  cycle: string;
  targetCount: number;
  nextRun: string;
  enabled: boolean;
  lastResult: string;
}

const mockVms: PrototypeVm[] = [
  { id: "vm-01", name: "prod-app-01", powerState: "running", guestOs: "Rocky Linux 9.4", cpuCount: 8, memoryGiB: 16, diskGiB: 160, ip: "192.0.2.81", hostId: "xs-1", hostName: "xenserver-1", connectionName: "生产资源池 A", provider: "XenServer" },
  { id: "vm-02", name: "prod-app-02", powerState: "running", guestOs: "Rocky Linux 9.4", cpuCount: 8, memoryGiB: 16, diskGiB: 160, ip: "192.0.2.82", hostId: "xs-1", hostName: "xenserver-1", connectionName: "生产资源池 A", provider: "XenServer" },
  { id: "vm-03", name: "dev-runner-01", powerState: "running", guestOs: "Ubuntu Server 24.04", cpuCount: 12, memoryGiB: 24, diskGiB: 240, ip: "192.0.2.96", hostId: "xs-3", hostName: "xenserver-3", connectionName: "研发资源池", provider: "XenServer" },
  { id: "vm-04", name: "dev-runner-02", powerState: "halted", guestOs: "Ubuntu Server 24.04", cpuCount: 12, memoryGiB: 24, diskGiB: 240, ip: "192.0.2.97", hostId: "xs-3", hostName: "xenserver-3", connectionName: "研发资源池", provider: "XenServer" },
  { id: "vm-05", name: "test-db-01", powerState: "halted", guestOs: "Windows Server 2022", cpuCount: 8, memoryGiB: 32, diskGiB: 500, ip: "192.0.2.110", hostId: "esxi-17", hostName: "esxi-17", connectionName: "VMware 实验集群", provider: "VMware" },
  { id: "vm-06", name: "ops-monitor-01", powerState: "running", guestOs: "Debian 12", cpuCount: 4, memoryGiB: 8, diskGiB: 100, ip: "192.0.2.66", hostId: "pve-20", hostName: "pve-20", connectionName: "Proxmox 运维节点", provider: "Proxmox VE" },
];

const tableRef = ref<{ toggleRowSelection: (row: PrototypeVm, selected?: boolean) => void } | null>(null);
const selectedVmIds = ref(["vm-01", "vm-02", "vm-03"]);
const scheduleTargetIds = ref(["vm-01", "vm-02", "vm-03"]);
const search = ref("");
const powerFilter = ref<"all" | "running" | "stopped">("all");
const scheduleTargetSearch = ref("");
const scheduleHostFilter = ref<string[]>([]);
const schedulePowerFilter = ref<"all" | "running" | "stopped">("all");
const scheduleDialogVisible = ref(true);
const scheduleView = ref<ScheduleView>("create");
const scheduleName = ref("工作日晚间关机");
const scheduleAction = ref<ScheduleAction>("shutdown");
const scheduleCycle = ref<ScheduleCycle>("once");
const onceAt = ref(defaultPrototypeOnceAt());
const executeTime = ref("22:30");
const weekdays = ref(["周一", "周二", "周三", "周四", "周五"]);
const timezone = ref("Asia/Shanghai");
const skipMatchingState = ref(true);
const shutdownTimeout = ref(10);
const shutdownFallback = ref("force");
const conflictPolicy = ref("block");
const editingPlanId = ref<number | null>(null);
const plans = ref<SchedulePlan[]>([
  { id: 1, name: "测试环境每日开机", action: "start", cycle: "每天 08:30", targetCount: 4, nextRun: "明天 08:30", enabled: true, lastResult: "今日 08:30 · 4/4 成功" },
  { id: 2, name: "开发环境日晚关机", action: "shutdown", cycle: "周一至周五 22:30", targetCount: 3, nextRun: "今天 22:30", enabled: true, lastResult: "昨天 22:30 · 3/3 成功" },
  { id: 3, name: "月末维护开机", action: "start", cycle: "单次 07-31 20:00", targetCount: 2, nextRun: "07-31 20:00", enabled: false, lastResult: "尚未执行" },
]);

const filteredVms = computed(() => {
  const keyword = search.value.trim().toLowerCase();
  return mockVms.filter((vm) => {
    const matchesPower = powerFilter.value === "all" || (powerFilter.value === "running" ? vm.powerState === "running" : vm.powerState === "halted");
    const matchesKeyword = !keyword || [vm.name, vm.ip, vm.guestOs].some((value) => value.toLowerCase().includes(keyword));
    return matchesPower && matchesKeyword;
  });
});
const selectedVms = computed(() => mockVms.filter((vm) => selectedVmIds.value.includes(vm.id)));
const selectedRunningCount = computed(() => selectedVms.value.filter((vm) => vm.powerState === "running").length);
const selectedStoppedCount = computed(() => selectedVms.value.filter((vm) => vm.powerState === "halted").length);
const scheduleTargets = computed(() => mockVms.filter((vm) => scheduleTargetIds.value.includes(vm.id)));
const scheduleRunningCount = computed(() => scheduleTargets.value.filter((vm) => vm.powerState === "running").length);
const scheduleStoppedCount = computed(() => scheduleTargets.value.filter((vm) => vm.powerState === "halted").length);
const scheduleHostOptions = computed(() => Array.from(new Map(mockVms.map((vm) => [vm.hostId, { value: vm.hostId, label: `${vm.hostName} · ${vm.provider}` }])).values()));
const filteredScheduleTargets = computed(() => {
  const keyword = scheduleTargetSearch.value.trim().toLowerCase();
  const hosts = new Set(scheduleHostFilter.value);
  return mockVms.filter((vm) => {
    if (hosts.size && !hosts.has(vm.hostId)) return false;
    if (schedulePowerFilter.value === "running" && vm.powerState !== "running") return false;
    if (schedulePowerFilter.value === "stopped" && vm.powerState !== "halted") return false;
    return !keyword || [vm.name, vm.ip, vm.guestOs, vm.hostName, vm.connectionName, vm.provider].some((value) => value.toLowerCase().includes(keyword));
  });
});
const allScheduleTargetsSelected = computed(() => filteredScheduleTargets.value.length > 0 && filteredScheduleTargets.value.every((vm) => scheduleTargetIds.value.includes(vm.id)));
const someScheduleTargetsSelected = computed(() => !allScheduleTargetsSelected.value && filteredScheduleTargets.value.some((vm) => scheduleTargetIds.value.includes(vm.id)));
const scheduleSummary = computed(() => {
  if (scheduleCycle.value === "once") return onceAt.value.replace(/^\d{4}-/, "").replace(":00", "");
  if (scheduleCycle.value === "daily") return `每天 ${executeTime.value}`;
  if (weekdays.value.length === 5 && !weekdays.value.includes("周六") && !weekdays.value.includes("周日")) return `周一至周五 ${executeTime.value}`;
  return `${weekdays.value.join("、")} ${executeTime.value}`;
});

onMounted(async () => {
  await nextTick();
  for (const vm of selectedVms.value) tableRef.value?.toggleRowSelection(vm, true);
});

function handleSelectionChange(rows: PrototypeVm[]) {
  selectedVmIds.value = rows.map((row) => row.id);
}

function openCreateSchedule() {
  editingPlanId.value = null;
  scheduleCycle.value = "once";
  onceAt.value = defaultPrototypeOnceAt();
  scheduleTargetIds.value = [...selectedVmIds.value];
  scheduleView.value = "create";
  scheduleDialogVisible.value = true;
}

function openGlobalSchedule() {
  scheduleCycle.value = "once";
  onceAt.value = defaultPrototypeOnceAt();
  scheduleTargetIds.value = [];
  scheduleTargetSearch.value = "";
  scheduleHostFilter.value = [];
  schedulePowerFilter.value = "all";
  scheduleView.value = "create";
  scheduleDialogVisible.value = true;
}

function startNewPlan() {
  editingPlanId.value = null;
  scheduleCycle.value = "once";
  onceAt.value = defaultPrototypeOnceAt();
  scheduleTargetIds.value = [...selectedVmIds.value];
  scheduleView.value = "create";
}

function toggleScheduleTarget(vmId: string, selected: string | number | boolean) {
  if (Boolean(selected)) {
    if (!scheduleTargetIds.value.includes(vmId)) scheduleTargetIds.value = [...scheduleTargetIds.value, vmId];
    return;
  }
  scheduleTargetIds.value = scheduleTargetIds.value.filter((id) => id !== vmId);
}

function toggleAllScheduleTargets(selected: string | number | boolean) {
  const filteredIds = new Set(filteredScheduleTargets.value.map((vm) => vm.id));
  if (Boolean(selected)) {
    scheduleTargetIds.value = Array.from(new Set([...scheduleTargetIds.value, ...filteredIds]));
    return;
  }
  scheduleTargetIds.value = scheduleTargetIds.value.filter((id) => !filteredIds.has(id));
}

function saveSchedule() {
  if (!scheduleName.value.trim()) {
    ElMessage.warning("请输入任务名称");
    return;
  }
  if (scheduleCycle.value === "weekly" && !weekdays.value.length) {
    ElMessage.warning("每周计划至少选择一天");
    return;
  }
  if (!scheduleTargets.value.length) {
    ElMessage.warning("请选择目标虚拟机");
    return;
  }

  const plan: SchedulePlan = {
    id: editingPlanId.value ?? Date.now(),
    name: scheduleName.value.trim(),
    action: scheduleAction.value,
    cycle: scheduleSummary.value,
    targetCount: scheduleTargets.value.length,
    nextRun: scheduleCycle.value === "once" ? scheduleSummary.value : `下一次 ${executeTime.value}`,
    enabled: true,
    lastResult: editingPlanId.value ? plans.value.find((item) => item.id === editingPlanId.value)?.lastResult ?? "尚未执行" : "尚未执行",
  };
  if (editingPlanId.value) {
    const index = plans.value.findIndex((item) => item.id === editingPlanId.value);
    if (index >= 0) plans.value[index] = plan;
  } else {
    plans.value.unshift(plan);
  }
  scheduleView.value = "tasks";
  editingPlanId.value = null;
  ElMessage.success("定时任务已保存");
}

function editPlan(plan: SchedulePlan) {
  editingPlanId.value = plan.id;
  scheduleName.value = plan.name;
  scheduleAction.value = plan.action;
  scheduleView.value = "create";
}

function removePlan(plan: SchedulePlan) {
  plans.value = plans.value.filter((item) => item.id !== plan.id);
  ElMessage.success("定时任务已删除");
}

function togglePlan(plan: SchedulePlan, enabled: string | number | boolean) {
  plan.enabled = Boolean(enabled);
}

function powerStateLabel(state: PowerState) {
  return state === "running" ? "运行中" : "已关机";
}

function formatMemory(value: number) {
  return `${value} GiB`;
}

function defaultPrototypeOnceAt() {
  const date = new Date(Date.now() + 60 * 60_000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:00`;
}
</script>

<template>
  <main class="app-shell vm-schedule-prototype">
    <aside class="sidebar">
      <div class="sidebar-head">
        <div class="brand-lockup">
          <span class="brand-mark sidebar-logo" aria-hidden="true">
            <VrcLogoMark shadow />
          </span>
          <div class="brand-copy"><h1>资源控制台</h1><p>3 个连接</p></div>
        </div>
        <button class="icon-button settings-entry-button" type="button" aria-label="设置"><el-icon><Setting /></el-icon></button>
      </div>
      <section class="sidebar-section">
        <el-input class="sidebar-search" placeholder="输入名称、平台或地址" :prefix-icon="Search" clearable />
      </section>
      <div class="connection-groups">
        <section class="connection-group overview-group">
          <button class="overview-entry" type="button">
            <span class="overview-entry-icon">↗</span>
            <span class="overview-entry-main"><strong>资源总览</strong><small>查看全部物理机</small></span>
          </button>
        </section>
        <section class="connection-group">
          <div class="group-title"><span>XenServer</span></div>
          <button class="connection-item active" type="button">
            <span class="status-dot online"></span>
            <span class="connection-main"><strong>xenserver-1</strong><small>192.0.2.77</small></span>
            <span class="connection-port">22</span>
          </button>
          <button class="connection-item" type="button">
            <span class="status-dot online"></span>
            <span class="connection-main"><strong>xenserver-2</strong><small>192.0.2.5</small></span>
            <span class="connection-port">22</span>
          </button>
        </section>
        <section class="connection-group">
          <div class="group-title"><span>VMware</span></div>
          <button class="connection-item" type="button">
            <span class="status-dot online"></span>
            <span class="connection-main"><strong>vmware-17</strong><small>192.0.2.17</small></span>
            <span class="connection-port">443</span>
          </button>
        </section>
      </div>
      <button class="activity-toggle" type="button">
        <span class="activity-toggle-icon" aria-hidden="true"><el-icon><Clock /></el-icon></span>
        <span>操作记录</span><strong>8</strong>
      </button>
    </aside>

    <section class="workspace schedule-workspace">
      <header class="host-vm-page-header overview-header">
        <div class="overview-title-group">
          <h3>物理机虚拟机</h3>
          <span>xenserver-1 · 192.0.2.77 · XenServer · 6 个 PIF</span>
        </div>
        <div class="overview-action-group" aria-label="物理机列表动作">
          <el-tooltip content="定时任务：跨物理机搜索并选择虚拟机" placement="top"><span class="toolbar-tooltip-target"><button type="button" class="overview-toolbar-button" aria-label="物理机定时任务" @click="openGlobalSchedule"><VrcToolbarIcon name="schedule" /></button></span></el-tooltip>
        </div>
      </header>

      <section class="metric-grid host-vm-panel-metrics host-vm-panel--page">
        <article class="metric-card host-card"><span class="metric-label">物理机</span><strong>xenserver-1</strong><small>192.0.2.77 · XenServer 8.4</small></article>
        <article class="metric-card"><span class="metric-label">CPU</span><div class="metric-main"><strong>56 核</strong><span>43%</span></div><small>80 运行 vCPU · 共配置 128 vCPU</small><div class="mini-meter"><span class="used" style="width: 43%"></span><span class="free" style="width: 57%"></span></div></article>
        <article class="metric-card"><span class="metric-label">内存</span><div class="metric-main"><strong>124 / 191.8 GiB</strong><span>65%</span></div><small>剩余 67.8 GiB</small><div class="mini-meter"><span class="used" style="width: 65%"></span><span class="free" style="width: 35%"></span></div></article>
        <article class="metric-card"><span class="metric-label">存储</span><div class="metric-main"><strong>13,532 / 15,366 GiB</strong><span>88%</span></div><small>剩余 1,834 GiB</small><div class="mini-meter warning"><span class="used" style="width: 88%"></span><span class="free" style="width: 12%"></span></div></article>
        <article class="metric-card"><span class="metric-label">VM</span><div class="metric-main"><strong>4 / 6</strong><span>67%</span></div><small>52 vCPU · 120 GiB 内存</small><div class="mini-meter vm-meter"><span class="used" style="width: 67%"></span><span class="free" style="width: 33%"></span></div></article>
      </section>

      <section class="panel table-panel host-vm-panel-table host-vm-panel--page schedule-table-panel">
        <div class="table-toolbar vm-table-toolbar">
          <div class="vm-table-toolbar-main">
            <div class="table-heading"><h3>虚拟机</h3><span>{{ filteredVms.length }} / {{ mockVms.length }} · xenserver-1</span></div>
            <div class="table-query-group">
              <el-input v-model="search" class="search-input" :prefix-icon="Search" placeholder="搜索名称 / UUID / IP" clearable />
              <el-segmented v-model="powerFilter" class="vm-power-filter" :options="[{ label: '全部', value: 'all' }, { label: '开机', value: 'running' }, { label: '关机', value: 'stopped' }]" aria-label="虚拟机状态筛选" />
            </div>
          </div>
          <div v-if="selectedVms.length" class="vm-batch-actions" aria-label="批量虚拟机操作">
            <span class="vm-batch-count">已选 {{ selectedVms.length }} 台</span>
            <el-tooltip :content="`批量开机 ${selectedStoppedCount} 台已关机 VM`" placement="top">
              <span class="toolbar-tooltip-target"><button type="button" class="vm-batch-action action-start" :disabled="!selectedStoppedCount" aria-label="批量开机"><VrcVmActionIcon name="start" /></button></span>
            </el-tooltip>
            <el-tooltip :content="`批量关机 ${selectedRunningCount} 台运行中 VM`" placement="top">
              <span class="toolbar-tooltip-target"><button type="button" class="vm-batch-action action-shutdown" :disabled="!selectedRunningCount" aria-label="批量关机"><VrcVmActionIcon name="shutdown" /></button></span>
            </el-tooltip>
            <el-tooltip content="删除前需先关机" placement="top">
              <span class="toolbar-tooltip-target"><button type="button" class="vm-batch-action action-delete" :disabled="selectedStoppedCount !== selectedVms.length" aria-label="批量删除"><VrcVmActionIcon name="delete" /></button></span>
            </el-tooltip>
            <el-tooltip :content="`为所选 ${selectedVms.length} 台 VM 创建定时任务`" placement="top">
              <span class="toolbar-tooltip-target"><button type="button" class="vm-batch-action schedule-batch-action" aria-label="创建定时任务" @click="openCreateSchedule"><VrcToolbarIcon name="schedule" /></button></span>
            </el-tooltip>
          </div>
          <div class="toolbar-action-buttons" aria-label="虚拟机表格操作">
            <el-tooltip content="创建虚拟机" placement="top"><span class="toolbar-tooltip-target"><button type="button" class="toolbar-action-button create-vm-action" aria-label="创建虚拟机"><VrcToolbarIcon name="create-vm" /></button></span></el-tooltip>
            <el-tooltip content="导出虚拟机清单" placement="top"><span class="toolbar-tooltip-target"><button type="button" class="toolbar-action-button" aria-label="导出虚拟机清单"><VrcToolbarIcon name="export" /></button></span></el-tooltip>
            <el-tooltip content="刷新虚拟机列表" placement="top"><span class="toolbar-tooltip-target"><button type="button" class="toolbar-action-button" aria-label="刷新虚拟机列表"><VrcToolbarIcon name="refresh" /></button></span></el-tooltip>
          </div>
        </div>

        <div class="vm-table-wrap">
          <el-table ref="tableRef" :data="filteredVms" height="100%" row-key="id" stripe @selection-change="handleSelectionChange">
            <el-table-column type="selection" width="40" align="center" reserve-selection />
            <el-table-column type="index" label="序号" width="50" align="center" />
            <el-table-column prop="name" label="名称" min-width="220" align="left"><template #default="{ row }"><button class="vm-console-link drilldown-link">{{ row.name }}</button></template></el-table-column>
            <el-table-column label="状态" width="96" align="center"><template #default="{ row }"><span class="state-text" :class="row.powerState === 'running' ? 'state-running' : 'state-stopped'">{{ powerStateLabel(row.powerState) }}</span></template></el-table-column>
            <el-table-column prop="guestOs" label="系统" min-width="170" align="left" show-overflow-tooltip />
            <el-table-column prop="cpuCount" label="vCPU" width="64" align="center"><template #default="{ row }">{{ row.cpuCount }} 核</template></el-table-column>
            <el-table-column label="内存" width="82" align="center"><template #default="{ row }">{{ formatMemory(row.memoryGiB) }}</template></el-table-column>
            <el-table-column label="磁盘" width="132" align="center"><template #default="{ row }"><span class="disk-total">{{ row.diskGiB }} GiB</span><small class="disk-subtitle">1 块</small></template></el-table-column>
            <el-table-column prop="ip" label="IP" width="128" align="center" />
            <el-table-column label="操作" width="116" align="center" fixed="right">
              <template #default="{ row }">
                <div class="vm-action-cell">
                  <button class="vm-action-link action-start" :disabled="row.powerState === 'running'" aria-label="开机"><VrcVmActionIcon name="start" /></button>
                  <button class="vm-action-link action-shutdown" :disabled="row.powerState === 'halted'" aria-label="关机"><VrcVmActionIcon name="shutdown" /></button>
                  <button class="vm-action-link action-delete" :disabled="row.powerState === 'running'" aria-label="删除"><VrcVmActionIcon name="delete" /></button>
                </div>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </section>
    </section>

    <el-dialog v-model="scheduleDialogVisible" width="880px" class="vm-schedule-dialog" top="6vh" :close-on-click-modal="false">
      <template #header>
        <div class="schedule-dialog-header">
          <strong>虚拟机定时任务</strong>
          <span>统一管理批量开机与关机计划</span>
        </div>
      </template>

      <el-tabs v-model="scheduleView" class="schedule-tabs">
        <el-tab-pane label="创建计划" name="create">
          <div class="schedule-create-content">
            <section class="schedule-section">
              <div class="schedule-section-heading">
                <strong>计划设置</strong>
                <span>时间按控制台所在时区执行</span>
              </div>
              <div class="schedule-form-grid">
                <label class="schedule-field schedule-name-field">
                  <span>任务名称</span>
                  <el-input v-model="scheduleName" placeholder="例如：工作日晚间关机" />
                </label>
                <div class="schedule-field schedule-action-field">
                  <span>执行动作</span>
                  <el-segmented v-model="scheduleAction" class="schedule-action-segmented" :options="[{ label: '开机', value: 'start' }, { label: '关机', value: 'shutdown' }]" />
                </div>
                <div class="schedule-field">
                  <span>执行周期</span>
                  <el-segmented v-model="scheduleCycle" class="schedule-cycle-segmented" :options="[{ label: '单次', value: 'once' }, { label: '每天', value: 'daily' }, { label: '每周', value: 'weekly' }]" />
                </div>
                <label class="schedule-field">
                  <span>执行时间</span>
                  <el-date-picker v-if="scheduleCycle === 'once'" v-model="onceAt" type="datetime" value-format="YYYY-MM-DD HH:mm:ss" format="YYYY-MM-DD HH:mm" placeholder="选择执行时间" />
                  <el-time-picker v-else v-model="executeTime" value-format="HH:mm" format="HH:mm" placeholder="选择时间" />
                </label>
                <label class="schedule-field">
                  <span>时区</span>
                  <el-select v-model="timezone">
                    <el-option label="Asia/Shanghai (UTC+8)" value="Asia/Shanghai" />
                    <el-option label="Asia/Tokyo (UTC+9)" value="Asia/Tokyo" />
                    <el-option label="UTC (UTC+0)" value="UTC" />
                  </el-select>
                </label>
                <div v-if="scheduleCycle === 'weekly'" class="schedule-field schedule-week-field">
                  <span>执行日期</span>
                  <el-checkbox-group v-model="weekdays" class="schedule-weekdays">
                    <el-checkbox v-for="day in ['周一', '周二', '周三', '周四', '周五', '周六', '周日']" :key="day" :value="day">{{ day }}</el-checkbox>
                  </el-checkbox-group>
                </div>
              </div>
            </section>

            <section class="schedule-section schedule-policy-section">
              <div class="schedule-section-heading">
                <strong>执行策略</strong>
                <span>任务冲突与关机失败处理</span>
              </div>
              <div class="schedule-policy-grid">
                <label class="schedule-field schedule-conflict-field">
                  <span>冲突处理</span>
                  <el-select v-model="conflictPolicy">
                    <el-option label="阻止创建并提示冲突" value="block" />
                    <el-option label="跳过冲突 VM，其余继续" value="skip" />
                    <el-option label="以当前计划覆盖旧计划" value="replace" />
                  </el-select>
                </label>
                <label v-if="scheduleAction === 'shutdown'" class="schedule-field schedule-timeout-field">
                  <span>关机超时（分钟）</span>
                  <span class="schedule-timeout-control"><el-input-number v-model="shutdownTimeout" :min="2" :max="60" controls-position="right" /></span>
                </label>
                <label v-if="scheduleAction === 'shutdown'" class="schedule-field schedule-fallback-field">
                  <span>失败处理</span>
                  <el-select v-model="shutdownFallback">
                    <el-option label="超时后强制关机" value="force" />
                    <el-option label="仅记录失败" value="fail" />
                  </el-select>
                </label>
                <div class="schedule-field schedule-skip-setting">
                  <span>状态一致时跳过</span>
                  <div class="schedule-skip-control"><small>不重复发送相同指令</small><el-switch v-model="skipMatchingState" /></div>
                </div>
              </div>
            </section>

            <section class="schedule-section schedule-target-section">
              <div class="schedule-section-heading schedule-target-heading">
                <strong>目标虚拟机 <em>已选 {{ scheduleTargets.length }} 台</em></strong>
                <span>{{ mockVms.length }} 台可选 · 已选 {{ scheduleRunningCount }} 台运行中 / {{ scheduleStoppedCount }} 台已关机</span>
              </div>
              <div class="schedule-target-filters">
                <el-input v-model="scheduleTargetSearch" clearable placeholder="搜索虚拟机名称 / IP / 系统" />
                <el-select v-model="scheduleHostFilter" multiple collapse-tags clearable placeholder="全部物理机"><el-option v-for="option in scheduleHostOptions" :key="option.value" :label="option.label" :value="option.value" /></el-select>
                <el-segmented v-model="schedulePowerFilter" class="schedule-target-power-filter" :options="[{ label: '全部', value: 'all' }, { label: '运行中', value: 'running' }, { label: '已关机', value: 'stopped' }]" />
                <div class="schedule-target-batch-actions">
                  <el-tooltip content="选择当前筛选结果" placement="top"><span class="toolbar-tooltip-target"><button type="button" class="schedule-target-icon-action" :disabled="!filteredScheduleTargets.length" aria-label="选择当前筛选结果" @click="toggleAllScheduleTargets(true)"><el-icon><Finished /></el-icon></button></span></el-tooltip>
                  <el-tooltip content="清空当前筛选结果" placement="top"><span class="toolbar-tooltip-target"><button type="button" class="schedule-target-icon-action" :disabled="!scheduleTargets.length" aria-label="清空当前筛选结果" @click="toggleAllScheduleTargets(false)"><el-icon><Close /></el-icon></button></span></el-tooltip>
                </div>
              </div>
              <div class="schedule-target-table">
                <div class="schedule-target-table-head"><span class="schedule-target-select-cell"><el-checkbox :model-value="allScheduleTargetsSelected" :indeterminate="someScheduleTargetsSelected" aria-label="选择当前筛选结果" @change="toggleAllScheduleTargets" /></span><span>序号</span><span>名称</span><span>物理机</span><span>IP 地址</span><span>当前状态</span></div>
                <div class="schedule-target-table-body">
                <div v-for="(vm, index) in filteredScheduleTargets" :key="vm.id" class="schedule-target-row">
                  <span class="schedule-target-select-cell"><el-checkbox :model-value="scheduleTargetIds.includes(vm.id)" :aria-label="`选择 ${vm.name}`" @change="toggleScheduleTarget(vm.id, $event)" /></span>
                  <span class="schedule-target-index">{{ index + 1 }}</span>
                  <span class="schedule-target-name"><strong>{{ vm.name }}</strong><small>{{ vm.guestOs }}</small></span>
                  <span class="schedule-target-host"><span>{{ vm.hostName }}</span><small>{{ vm.connectionName }}</small></span>
                  <span class="schedule-target-ip">{{ vm.ip }}</span>
                  <span class="schedule-target-state" :class="vm.powerState === 'running' ? 'is-running' : 'is-stopped'">{{ powerStateLabel(vm.powerState) }}</span>
                </div>
                <div v-if="!filteredScheduleTargets.length" class="schedule-target-empty">没有符合当前筛选条件的虚拟机</div>
                </div>
              </div>
            </section>
          </div>
        </el-tab-pane>

        <el-tab-pane :label="`任务管理 ${plans.length}`" name="tasks">
          <section class="schedule-task-list">
            <div class="schedule-task-toolbar">
              <div><strong>任务列表</strong><span>{{ plans.filter((item) => item.enabled).length }} 个启用 · {{ plans.length }} 个任务</span></div>
              <el-button type="primary" @click="startNewPlan">新建计划</el-button>
            </div>
            <el-table :data="plans" row-key="id">
              <el-table-column type="index" label="序号" width="52" align="center" />
              <el-table-column label="任务" min-width="190"><template #default="{ row }"><span class="schedule-task-name"><strong>{{ row.name }}</strong><small>{{ row.lastResult }}</small></span></template></el-table-column>
              <el-table-column label="动作" width="88" align="center"><template #default="{ row }"><span class="schedule-action-label" :class="`action-${row.action}`"><VrcVmActionIcon :name="row.action" />{{ row.action === 'start' ? '开机' : '关机' }}</span></template></el-table-column>
              <el-table-column prop="cycle" label="周期" min-width="132" />
              <el-table-column label="目标" width="68" align="center"><template #default="{ row }">{{ row.targetCount }} 台</template></el-table-column>
              <el-table-column prop="nextRun" label="下一次执行" min-width="112" />
              <el-table-column label="启用" width="66" align="center"><template #default="{ row }"><el-switch v-model="row.enabled" size="small" @change="togglePlan(row, $event)" /></template></el-table-column>
              <el-table-column label="操作" width="82" align="center" fixed="right">
                <template #default="{ row }"><div class="schedule-row-actions"><button type="button" aria-label="编辑任务" @click="editPlan(row)"><el-icon><EditPen /></el-icon></button><button type="button" class="danger" aria-label="删除任务" @click="removePlan(row)"><el-icon><Delete /></el-icon></button></div></template>
              </el-table-column>
            </el-table>
          </section>
        </el-tab-pane>
      </el-tabs>

      <template #footer>
        <div class="schedule-dialog-footer">
          <span v-if="scheduleView === 'create'"><strong>{{ scheduleAction === 'start' ? '开机' : '关机' }}</strong> · {{ scheduleSummary }} · {{ scheduleTargets.length }} 台 VM</span>
          <span v-else>任务由服务端按计划执行，关闭页面不受影响</span>
          <div>
            <el-button @click="scheduleDialogVisible = false">{{ scheduleView === 'create' ? '取消' : '关闭' }}</el-button>
            <el-button v-if="scheduleView === 'create'" type="primary" :disabled="!scheduleTargets.length" @click="saveSchedule">{{ editingPlanId ? "保存修改" : "创建计划" }}</el-button>
          </div>
        </div>
      </template>
    </el-dialog>
  </main>
</template>

<style scoped>
.schedule-workspace {
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr);
  overflow: hidden;
}

.schedule-table-panel {
  min-height: 0;
  margin: 0 16px 12px;
}

.schedule-batch-action {
  color: var(--vrc-accent);
}

:global(.vm-schedule-dialog) {
  max-width: calc(100vw - 48px);
  overflow: hidden;
  padding: 0;
  background: var(--vrc-surface);
}

:global(.vm-schedule-dialog .el-dialog__header) {
  margin: 0;
  padding: 10px 42px 8px 12px;
}

:global(.vm-schedule-dialog .el-dialog__header) {
  border-bottom: 0;
}

:global(.vm-schedule-dialog .el-dialog__body) {
  padding: 0;
}

:global(.vm-schedule-dialog .el-dialog__footer) {
  margin: 0;
  padding: 0;
  border-top: 0;
}

.schedule-dialog-header,
.schedule-dialog-footer,
.schedule-task-toolbar,
.schedule-target-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.schedule-dialog-header,
.schedule-task-toolbar > div,
.schedule-task-name {
  display: grid;
  gap: 3px;
}

.schedule-dialog-header strong {
  color: var(--vrc-text);
  font-size: 18px;
  font-weight: 400;
  line-height: 24px;
}

.schedule-dialog-header span {
  color: var(--vrc-text-muted);
  font-size: 11px;
  line-height: 1.3;
}

:global(.vm-schedule-dialog .schedule-tabs > .el-tabs__header) {
  margin: 0;
  padding: 0 12px;
  border-bottom: 0;
}

:global(.vm-schedule-dialog .schedule-tabs > .el-tabs__header .el-tabs__nav-wrap::after) {
  display: none;
}

:global(.vm-schedule-dialog .schedule-tabs > .el-tabs__header .el-tabs__item) {
  height: 32px;
  padding: 0 14px;
  color: var(--vrc-text-muted);
  font-size: 12px;
  font-weight: 400;
  line-height: 32px;
}

:global(.vm-schedule-dialog .schedule-tabs > .el-tabs__header .el-tabs__active-bar + .el-tabs__item) {
  padding-left: 0;
}

:global(.vm-schedule-dialog .schedule-tabs > .el-tabs__header .el-tabs__item.is-active) {
  color: var(--vrc-accent);
  font-weight: 400;
}

:global(.vm-schedule-dialog .schedule-tabs > .el-tabs__header .el-tabs__active-bar) {
  height: 2px;
  background: var(--vrc-accent);
}

:global(.vm-schedule-dialog .schedule-tabs > .el-tabs__content) {
  max-height: calc(88vh - 116px);
  overflow: auto;
  overscroll-behavior: contain;
}

.schedule-create-content {
  display: grid;
  gap: 10px;
  padding: 10px 12px 8px;
}

.schedule-section {
  display: grid;
  gap: 7px;
  min-width: 0;
  padding: 12px;
  background: var(--vrc-surface);
  border: 1px solid var(--vrc-border);
  border-radius: 8px;
}

.schedule-section-heading {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.schedule-section-heading strong,
.schedule-task-toolbar strong {
  color: var(--vrc-text);
  font-size: 12px;
  font-weight: 400;
  line-height: 1.25;
}

.schedule-section-heading > span,
.schedule-task-toolbar span,
.schedule-dialog-footer > span {
  color: var(--vrc-text-muted);
  font-size: 11px;
  line-height: 1.25;
}

.schedule-form-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px 10px;
  min-width: 0;
}

.schedule-field {
  display: grid;
  align-content: start;
  gap: 5px;
  min-width: 0;
}

.schedule-field > span:first-child {
  color: var(--vrc-text-muted);
  font-size: 11px;
  font-weight: 400;
  line-height: 1;
}

.schedule-field :deep(.el-input),
.schedule-field :deep(.el-select),
.schedule-field :deep(.el-date-editor),
.schedule-field :deep(.el-input-number) {
  width: 100%;
}

.schedule-field :deep(.el-input__wrapper),
.schedule-field :deep(.el-select__wrapper),
.schedule-field :deep(.el-input-number .el-input__wrapper) {
  height: 28px;
  min-height: 28px;
  background: var(--vrc-surface);
  border: 1px solid var(--vrc-border);
  border-radius: 6px;
  box-shadow: none;
}

.schedule-field :deep(.el-input__wrapper:hover),
.schedule-field :deep(.el-select__wrapper:hover),
.schedule-field :deep(.el-input-number .el-input__wrapper:hover) {
  border-color: var(--vrc-border);
  box-shadow: none;
}

.schedule-field :deep(.el-input__wrapper.is-focus),
.schedule-field :deep(.el-select__wrapper.is-focused) {
  border-color: var(--vrc-border-strong);
  box-shadow: none;
}

.schedule-field :deep(.el-input__inner),
.schedule-field :deep(.el-select__selected-item),
.schedule-field :deep(.el-select__placeholder) {
  font-size: 12px;
}

.schedule-action-segmented,
.schedule-cycle-segmented {
  --el-segmented-item-selected-color: var(--vrc-text);
  --el-segmented-item-selected-bg-color: var(--vrc-surface);
  box-sizing: border-box;
  height: 28px;
  min-height: 28px;
  padding: 2px;
  width: 100%;
  color: var(--vrc-text-muted);
  background: var(--vrc-surface-muted);
  border: 1px solid transparent;
  border-radius: 7px;
  box-shadow: none;
}

.schedule-action-segmented :deep(.el-segmented__group),
.schedule-cycle-segmented :deep(.el-segmented__group) {
  align-items: center;
  height: 22px;
  min-height: 22px;
}

.schedule-action-segmented :deep(.el-segmented__item),
.schedule-cycle-segmented :deep(.el-segmented__item) {
  height: 22px;
  min-height: 22px;
  padding: 0 8px;
  color: var(--vrc-text-muted);
  border-radius: 5px;
  font-size: 12px;
  font-weight: 400;
  line-height: 22px;
}

.schedule-action-segmented :deep(.el-segmented__item.is-selected),
.schedule-cycle-segmented :deep(.el-segmented__item.is-selected) {
  color: var(--vrc-text);
}

.schedule-action-segmented :deep(.el-segmented__item-selected),
.schedule-cycle-segmented :deep(.el-segmented__item-selected) {
  box-shadow: 0 1px 2px color-mix(in srgb, var(--vrc-text) 8%, transparent);
}

.schedule-week-field {
  grid-column: 1 / -1;
}

.schedule-weekdays {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 18px;
  min-height: 28px;
  padding: 0 2px;
}

.schedule-weekdays :deep(.el-checkbox) {
  height: 28px;
  margin-right: 0;
  color: var(--vrc-text);
  font-size: 12px;
}

.schedule-weekdays :deep(.el-checkbox__label) {
  font-size: 12px;
  font-weight: 400;
}

.schedule-policy-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  align-items: end;
  gap: 10px;
}

.schedule-timeout-control {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
}

.schedule-timeout-control :deep(.el-input-number) {
  flex: 1 1 auto;
  width: auto;
  min-width: 0;
}

.schedule-timeout-control :deep(.el-input-number__decrease),
.schedule-timeout-control :deep(.el-input-number__increase) {
  width: 26px;
  height: 14px;
  color: var(--vrc-text-muted);
  background: var(--vrc-surface);
  border-color: var(--vrc-border);
  font-size: 11px;
  line-height: 14px;
}

.schedule-timeout-control :deep(.el-input-number__decrease:hover),
.schedule-timeout-control :deep(.el-input-number__increase:hover) {
  color: var(--vrc-accent);
  background: var(--vrc-surface);
  border-color: var(--vrc-border);
}

.schedule-timeout-control small {
  color: var(--vrc-text-muted);
  font-size: 11px;
}

.schedule-skip-setting {
  min-width: 0;
}

.schedule-skip-control {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  height: 28px;
  min-width: 0;
  padding: 0 2px;
}

.schedule-skip-control small {
  min-width: 0;
  overflow: hidden;
  color: var(--vrc-text-muted);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.schedule-skip-control :deep(.el-switch) {
  flex: 0 0 34px;
  width: 34px;
  height: 20px;
}

.schedule-skip-control :deep(.el-switch__core) {
  width: 34px;
  min-width: 34px;
  height: 20px;
}

.schedule-skip-control :deep(.el-switch__action) {
  width: 16px;
  height: 16px;
}

.schedule-target-heading {
  align-items: center;
}

.schedule-target-heading strong {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  line-height: 16px;
}

.schedule-target-heading strong em {
  color: var(--vrc-text-muted);
  font-size: 11px;
  font-style: normal;
  font-weight: 400;
  font-variant-numeric: tabular-nums;
  line-height: 16px;
  white-space: nowrap;
}

.schedule-target-filters {
  display: grid;
  grid-template-columns: minmax(190px, 1fr) minmax(170px, .9fr) 210px auto;
  align-items: center;
  gap: 8px;
}

.schedule-target-filters :deep(.el-input__wrapper),
.schedule-target-filters :deep(.el-select__wrapper) {
  align-items: center;
  height: 28px;
  min-height: 28px;
  box-shadow: none;
}

.schedule-target-filters :deep(.el-input__wrapper) {
  padding-top: 1px;
  padding-bottom: 1px;
  background: var(--vrc-surface-muted);
  border: 1px solid transparent;
  border-radius: 7px;
}

.schedule-target-filters :deep(.el-select__wrapper) {
  padding-top: 0;
  padding-bottom: 0;
  background: var(--vrc-surface-muted);
  border: 1px solid transparent;
  border-radius: 7px;
}

.schedule-target-filters :deep(.el-input__wrapper:hover) {
  border-color: transparent;
  box-shadow: none;
}

.schedule-target-filters :deep(.el-select__wrapper:hover) {
  border-color: transparent;
  box-shadow: none;
}

.schedule-target-filters :deep(.el-input__wrapper.is-focus) {
  background: var(--vrc-surface-muted);
  border-color: color-mix(in srgb, var(--vrc-accent) 50%, var(--vrc-border));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--vrc-accent) 14%, transparent);
}

.schedule-target-filters :deep(.el-select__wrapper.is-focused) {
  background: var(--vrc-surface-muted);
  border-color: color-mix(in srgb, var(--vrc-accent) 50%, var(--vrc-border));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--vrc-accent) 14%, transparent);
}

.schedule-target-filters :deep(.el-input__inner),
.schedule-target-filters :deep(.el-select__selected-item),
.schedule-target-filters :deep(.el-select__placeholder) {
  height: 26px;
  font-size: 12px;
  line-height: 26px;
}

.schedule-target-filters :deep(.el-select__selected-item),
.schedule-target-filters :deep(.el-select__placeholder) {
  display: flex;
  align-items: center;
}

.schedule-target-filters :deep(.el-input__inner::placeholder) {
  color: var(--vrc-text-subtle);
  font-size: 12px;
  font-weight: 400;
  line-height: inherit;
}

.schedule-target-filters :deep(.el-select__placeholder.is-transparent) {
  color: var(--vrc-text-subtle);
  font-size: 12px;
  font-weight: 400;
}

.schedule-target-power-filter {
  --el-segmented-item-selected-color: var(--vrc-text);
  --el-segmented-item-selected-bg-color: var(--vrc-surface);
  box-sizing: border-box;
  width: 100%;
  height: 28px;
  min-height: 28px;
  padding: 2px;
  background: var(--vrc-surface-muted);
  border: 1px solid transparent;
  border-radius: 7px;
}

.schedule-target-power-filter :deep(.el-segmented__group),
.schedule-target-power-filter :deep(.el-segmented__item) {
  height: 22px;
  min-height: 22px;
}

.schedule-target-power-filter :deep(.el-segmented__item) {
  padding: 0 7px;
  border-radius: 5px;
  font-size: 12px;
  font-weight: 400;
  line-height: 22px;
}

.schedule-target-batch-actions {
  display: flex;
  gap: 6px;
  white-space: nowrap;
}

.schedule-target-batch-actions .toolbar-tooltip-target {
  display: inline-flex;
}

.schedule-target-icon-action {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  padding: 0;
  color: var(--vrc-text-muted);
  background: var(--vrc-surface);
  border: 1px solid var(--vrc-border);
  border-radius: 6px;
  cursor: pointer;
}

.schedule-target-icon-action:hover:not(:disabled),
.schedule-target-icon-action:focus-visible {
  color: var(--vrc-accent);
  border-color: color-mix(in srgb, var(--vrc-accent) 30%, var(--vrc-border));
  outline: none;
}

.schedule-target-icon-action:disabled {
  color: var(--vrc-text-subtle);
  background: var(--vrc-surface-muted);
  cursor: default;
  opacity: .65;
}

.schedule-target-icon-action :deep(.el-icon) {
  width: 15px;
  height: 15px;
  font-size: 15px;
}

.schedule-target-table {
  overflow: hidden;
  border: 1px solid var(--vrc-border);
  border-radius: 7px;
}

.schedule-target-table-head,
.schedule-target-row {
  display: grid;
  grid-template-columns: 34px 48px minmax(180px, 1.25fr) minmax(140px, .85fr) 126px 84px;
  align-items: center;
  column-gap: 10px;
  padding: 0 10px;
}

.schedule-target-table-body {
  max-height: 242px;
  overflow: auto;
  overscroll-behavior: contain;
}

.schedule-target-table-head {
  min-height: 36px;
  color: var(--vrc-text-muted);
  background: var(--vrc-surface-muted);
  border-bottom: 1px solid var(--vrc-border);
  font-size: 12px;
  font-weight: 600;
  line-height: 18px;
}

.schedule-target-table-head > span {
  min-width: 0;
  text-align: center;
}

.schedule-target-row {
  min-height: 48px;
  color: var(--vrc-text);
  background: var(--vrc-surface);
  font-size: 12px;
}

.schedule-target-row + .schedule-target-row {
  border-top: 1px solid color-mix(in srgb, var(--vrc-border) 72%, transparent);
}

.schedule-target-row strong {
  font-size: 12px;
  font-weight: 400;
}

.schedule-target-row > span:not(.schedule-target-select-cell) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.schedule-target-select-cell {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
}

.schedule-target-index,
.schedule-target-ip {
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.schedule-target-name,
.schedule-target-host {
  display: grid;
  min-width: 0;
  gap: 2px;
  overflow: hidden;
}

.schedule-target-name strong,
.schedule-target-name small,
.schedule-target-host span,
.schedule-target-host small {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.schedule-target-name strong,
.schedule-target-host span {
  color: var(--vrc-text);
  font-size: 12px;
  font-weight: 400;
  line-height: 16px;
}

.schedule-target-name small,
.schedule-target-host small {
  color: var(--vrc-text-muted);
  font-size: 10px;
  font-weight: 400;
  line-height: 14px;
}

.schedule-target-select-cell :deep(.el-checkbox) {
  flex: 0 0 auto;
  height: 28px;
  margin-right: 0;
}

.schedule-target-empty {
  display: grid;
  min-height: 48px;
  place-items: center;
  color: var(--vrc-text-muted);
  font-size: 11px;
}

.schedule-target-state {
  display: block;
  color: var(--vrc-text-muted);
  text-align: center;
}

.schedule-target-state.is-running {
  color: var(--vrc-success);
}

.schedule-task-list {
  display: grid;
  gap: 10px;
  min-width: 0;
  margin: 10px 12px 8px;
  padding: 12px;
  background: var(--vrc-surface);
  border: 1px solid var(--vrc-border);
  border-radius: 8px;
}

.schedule-task-toolbar {
  min-height: 30px;
}

.schedule-task-toolbar :deep(.el-button) {
  height: 30px;
  min-height: 30px;
  padding: 0 12px;
  border-radius: 7px;
  font-size: 12px;
  font-weight: 400;
}

.schedule-task-toolbar > div {
  min-width: 0;
}

.schedule-task-list :deep(.el-table th.el-table__cell) {
  height: 35px;
  padding: 0;
  color: var(--vrc-text-muted);
  background: var(--vrc-surface-muted);
  font-size: 12px;
  font-weight: 600;
}

.schedule-task-list :deep(.el-table th.el-table__cell > .cell) {
  line-height: 35px;
  text-align: center;
}

.schedule-task-list :deep(.el-table td.el-table__cell) {
  height: 48px;
  padding: 7px 0;
  color: var(--vrc-text);
  font-size: 12px;
  font-weight: 400;
}

.schedule-task-list :deep(.el-table td.el-table__cell > .cell) {
  line-height: 20px;
}

.schedule-task-name {
  gap: 2px;
}

.schedule-task-name strong,
.schedule-task-name small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.schedule-task-name strong {
  color: var(--vrc-text);
  font-size: 12px;
  font-weight: 400;
  line-height: 16px;
}

.schedule-task-name small {
  margin-top: 0;
  color: var(--vrc-text-muted);
  font-size: 10px;
  font-weight: 400;
  line-height: 14px;
}

.schedule-action-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--vrc-success);
  font-size: 11px;
}

.schedule-action-label :deep(svg) {
  width: 14px;
  height: 14px;
}

.schedule-action-label.action-shutdown {
  color: var(--vrc-warning);
}

.schedule-row-actions {
  display: flex;
  justify-content: center;
  gap: 6px;
}

.schedule-row-actions button {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  padding: 0;
  color: var(--vrc-text-muted);
  background: transparent;
  border: 1px solid var(--vrc-border);
  border-radius: 7px;
  cursor: pointer;
}

.schedule-row-actions button:hover {
  color: var(--vrc-accent);
  border-color: color-mix(in srgb, var(--vrc-accent) 32%, var(--vrc-border));
}

.schedule-row-actions button.danger {
  color: var(--vrc-danger);
}

.schedule-dialog-footer > div {
  display: flex;
  gap: 8px;
}

.schedule-dialog-footer {
  padding: 8px 12px 10px;
}

.schedule-dialog-footer :deep(.el-button + .el-button) {
  margin-left: 0;
}

.schedule-dialog-footer :deep(.el-button) {
  height: 30px;
  min-height: 30px;
  padding: 0 12px;
  border-radius: 7px;
  font-size: 12px;
  font-weight: 400;
}

.schedule-dialog-footer > span strong {
  color: var(--vrc-text);
  font-size: 11px;
  font-weight: 400;
}

@media (max-width: 920px) {
  .schedule-target-filters {
    grid-template-columns: 1fr 1fr;
  }

  .schedule-target-batch-actions {
    justify-content: flex-end;
  }
}
</style>
