<script setup lang="ts">
import { Close, Delete, EditPen, Finished } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { computed, ref, watch } from "vue";
import type {
  HostNode,
  ProviderType,
  VmNode,
  VmSchedule,
  VmScheduleAction,
  VmScheduleConflictPolicy,
  VmScheduleCycle,
  VmScheduleFallback,
  VmScheduleRunnerStatus,
  VmScheduleTarget,
  VmScheduleTargetCatalogResponse,
  VmSchedulesResponse,
} from "../types";
import VrcVmActionIcon from "./VrcVmActionIcon.vue";
import { getProviderBrand } from "../domain/providerBrand";
import { confirmVrcAction } from "../domain/confirmAction";

type ScheduleView = "create" | "tasks";

const props = defineProps<{
  visible: boolean;
  initialView: ScheduleView;
  connection: {
    id: string;
    providerType: ProviderType;
    name?: string;
  };
  host: HostNode | null;
  availableVms: VmNode[];
  selectedVms: VmNode[];
  showIconTooltips?: boolean;
}>();

const iconTooltipsDisabled = computed(() => props.showIconTooltips === false);

const emit = defineEmits<{
  "update:visible": [value: boolean];
  changed: [];
}>();

const weekdayOptions = [
  { label: "周一", value: 1 },
  { label: "周二", value: 2 },
  { label: "周三", value: 3 },
  { label: "周四", value: 4 },
  { label: "周五", value: 5 },
  { label: "周六", value: 6 },
  { label: "周日", value: 7 },
];

const dialogVisible = computed({
  get: () => props.visible,
  set: (value: boolean) => emit("update:visible", value),
});
const scheduleView = ref<ScheduleView>("create");
const scheduleName = ref("工作日晚间关机");
const scheduleAction = ref<VmScheduleAction>("shutdown");
const scheduleCycle = ref<VmScheduleCycle>("once");
const onceAt = ref(defaultOnceAt());
const executeTime = ref("22:30");
const weekdays = ref([1, 2, 3, 4, 5]);
const timezone = ref("Asia/Shanghai");
const skipMatchingState = ref(true);
const shutdownTimeout = ref(10);
const shutdownFallback = ref<VmScheduleFallback>("force");
const conflictPolicy = ref<VmScheduleConflictPolicy>("block");
const editingTaskId = ref("");
const targets = ref<VmScheduleTarget[]>([]);
const catalogTargets = ref<VmScheduleTarget[]>([]);
const catalogErrors = ref<VmScheduleTargetCatalogResponse["errors"]>([]);
const tasks = ref<VmSchedule[]>([]);
const runner = ref<VmScheduleRunnerStatus>({ mode: "web", owner: false });
const loadingTasks = ref(false);
const loadingTargets = ref(false);
const saving = ref(false);
const targetSearch = ref("");
const targetHostFilter = ref<string[]>([]);
const targetPowerFilter = ref<"all" | "running" | "stopped">("all");

const runningTargetCount = computed(() => targets.value.filter((target) => target.powerState === "running").length);
const stoppedTargetCount = computed(() => targets.value.filter((target) => target.powerState === "halted" || target.powerState === "stopped").length);
const targetOptions = computed(() => {
  const options = new Map(catalogTargets.value.map((target) => [targetKey(target), { ...target }]));
  for (const vm of props.availableVms) {
    const target = toScheduleTarget(vm);
    if (!options.has(targetKey(target))) options.set(targetKey(target), target);
  }
  for (const target of targets.value) {
    if (!options.has(targetKey(target))) options.set(targetKey(target), { ...target });
  }
  return Array.from(options.values());
});
const targetHostOptions = computed(() => {
  const options = new Map<string, { value: string; label: string }>();
  for (const target of targetOptions.value) {
    const value = targetHostKey(target);
    if (!options.has(value)) {
      options.set(value, {
        value,
        label: `${target.hostName || target.connectionName || "未命名物理机"} · ${providerLabel(target.providerType)}`,
      });
    }
  }
  return Array.from(options.values()).sort((left, right) => left.label.localeCompare(right.label, "zh-CN", { numeric: true }));
});
const filteredTargetOptions = computed(() => {
  const keyword = targetSearch.value.trim().toLowerCase();
  const hosts = new Set(targetHostFilter.value);
  return targetOptions.value.filter((target) => {
    if (hosts.size && !hosts.has(targetHostKey(target))) return false;
    const stopped = target.powerState === "halted" || target.powerState === "stopped";
    if (targetPowerFilter.value === "running" && target.powerState !== "running") return false;
    if (targetPowerFilter.value === "stopped" && !stopped) return false;
    if (!keyword) return true;
    return [target.name, target.ip, target.guestOs, target.hostName, target.connectionName, providerLabel(target.providerType)]
      .some((value) => value?.toLowerCase().includes(keyword));
  });
});
const allTargetsSelected = computed(() => filteredTargetOptions.value.length > 0 && filteredTargetOptions.value.every((target) => isTargetSelected(target)));
const someTargetsSelected = computed(() => !allTargetsSelected.value && filteredTargetOptions.value.some((target) => isTargetSelected(target)));
const scheduleSummary = computed(() => {
  if (scheduleCycle.value === "once") return onceAt.value.replace(/^\d{4}-/, "").replace(":00", "");
  if (scheduleCycle.value === "daily") return `每天 ${executeTime.value}`;
  if (weekdays.value.length === 5 && weekdays.value.every((day) => day >= 1 && day <= 5)) return `周一至周五 ${executeTime.value}`;
  return `${weekdays.value.map(weekdayLabel).join("、")} ${executeTime.value}`;
});
const runnerSummary = computed(() => {
  const modeLabel = runner.value.mode === "electron" ? "客户端后台" : runner.value.mode === "chrome-native" ? "Native Host 服务" : "Web/API 服务";
  return runner.value.owner ? `${modeLabel}正在执行任务` : `任务由${modeLabel}统一执行`;
});

watch(
  () => props.visible,
  (visible) => {
    if (!visible) return;
    scheduleView.value = props.initialView;
    editingTaskId.value = "";
    targetSearch.value = "";
    targetHostFilter.value = [];
    targetPowerFilter.value = "all";
    if (props.initialView === "create") resetFormFromSelection();
    void loadTargets();
    void loadTasks();
  },
);

function resetFormFromSelection() {
  scheduleName.value = "工作日晚间关机";
  scheduleAction.value = "shutdown";
  scheduleCycle.value = "once";
  onceAt.value = defaultOnceAt();
  executeTime.value = "22:30";
  weekdays.value = [1, 2, 3, 4, 5];
  timezone.value = "Asia/Shanghai";
  skipMatchingState.value = true;
  shutdownTimeout.value = 10;
  shutdownFallback.value = "force";
  conflictPolicy.value = "block";
  targets.value = props.selectedVms.map(toScheduleTarget);
}

async function loadTasks() {
  loadingTasks.value = true;
  try {
    const response = await requestJson<VmSchedulesResponse>("/api/vm-schedules");
    tasks.value = response.tasks;
    runner.value = response.runner;
  } catch (error) {
    ElMessage.error(errorMessage(error, "读取定时任务失败"));
  } finally {
    loadingTasks.value = false;
  }
}

async function loadTargets() {
  loadingTargets.value = true;
  try {
    const response = await requestJson<VmScheduleTargetCatalogResponse>("/api/vm-schedule-targets");
    catalogTargets.value = response.targets;
    catalogErrors.value = response.errors;
  } catch (error) {
    catalogErrors.value = [{ connectionId: "catalog", message: errorMessage(error, "读取虚拟机范围失败") }];
  } finally {
    loadingTargets.value = false;
  }
}

async function saveSchedule() {
  if (!scheduleName.value.trim()) {
    ElMessage.warning("请输入任务名称");
    return;
  }
  if (!targets.value.length) {
    ElMessage.warning("请先选择目标虚拟机");
    return;
  }
  if (scheduleCycle.value === "weekly" && !weekdays.value.length) {
    ElMessage.warning("每周计划至少选择一天");
    return;
  }
  saving.value = true;
  try {
    const payload = {
      name: scheduleName.value.trim(),
      connectionId: targets.value[0].connectionId || props.connection.id,
      providerType: targets.value[0].providerType || props.connection.providerType,
      connectionName: targets.value[0].connectionName || props.connection.name,
      hostId: singleTargetHost()?.hostId,
      hostName: singleTargetHost()?.hostName,
      action: scheduleAction.value,
      cycle: scheduleCycle.value,
      onceAt: scheduleCycle.value === "once" ? onceAt.value : undefined,
      executeTime: scheduleCycle.value === "once" ? undefined : executeTime.value,
      weekdays: scheduleCycle.value === "weekly" ? weekdays.value : undefined,
      timezone: timezone.value,
      skipMatchingState: skipMatchingState.value,
      shutdownTimeoutMinutes: shutdownTimeout.value,
      shutdownFallback: shutdownFallback.value,
      conflictPolicy: conflictPolicy.value,
      targets: targets.value,
      confirmToken: "CONFIRMED",
    };
    const url = editingTaskId.value ? `/api/vm-schedules/${encodeURIComponent(editingTaskId.value)}` : "/api/vm-schedules";
    const response = await requestJson<{ task: VmSchedule; runner: VmScheduleRunnerStatus }>(url, {
      method: editingTaskId.value ? "PUT" : "POST",
      body: JSON.stringify(payload),
    });
    runner.value = response.runner;
    editingTaskId.value = "";
    scheduleView.value = "tasks";
    await loadTasks();
    emit("changed");
    ElMessage.success("定时任务已保存");
  } catch (error) {
    ElMessage.error(errorMessage(error, "保存定时任务失败"));
  } finally {
    saving.value = false;
  }
}

function openCreate() {
  editingTaskId.value = "";
  resetFormFromSelection();
  scheduleView.value = "create";
}

function isTargetSelected(target: VmScheduleTarget) {
  const key = targetKey(target);
  return targets.value.some((item) => targetKey(item) === key);
}

function toggleTarget(target: VmScheduleTarget, selected: string | number | boolean) {
  if (Boolean(selected)) {
    if (!isTargetSelected(target)) targets.value = [...targets.value, { ...target }];
    return;
  }
  const key = targetKey(target);
  targets.value = targets.value.filter((item) => targetKey(item) !== key);
}

function toggleAllTargets(selected: string | number | boolean) {
  const filteredKeys = new Set(filteredTargetOptions.value.map(targetKey));
  if (Boolean(selected)) {
    const retained = targets.value.filter((target) => !filteredKeys.has(targetKey(target)));
    targets.value = [...retained, ...filteredTargetOptions.value.map((target) => ({ ...target }))];
    return;
  }
  targets.value = targets.value.filter((target) => !filteredKeys.has(targetKey(target)));
}

function editTask(task: VmSchedule) {
  editingTaskId.value = task.id;
  scheduleName.value = task.name;
  scheduleAction.value = task.action;
  scheduleCycle.value = task.cycle;
  onceAt.value = task.onceAt ?? defaultOnceAt();
  executeTime.value = task.executeTime ?? "22:30";
  weekdays.value = [...(task.weekdays ?? [1, 2, 3, 4, 5])];
  timezone.value = task.timezone;
  skipMatchingState.value = task.skipMatchingState;
  shutdownTimeout.value = task.shutdownTimeoutMinutes;
  shutdownFallback.value = task.shutdownFallback;
  conflictPolicy.value = task.conflictPolicy;
  targets.value = task.targets.map((target) => ({ ...target }));
  scheduleView.value = "create";
}

async function toggleTask(task: VmSchedule, enabled: string | number | boolean) {
  const nextEnabled = Boolean(enabled);
  try {
    const response = await requestJson<{ task: VmSchedule; runner: VmScheduleRunnerStatus }>(`/api/vm-schedules/${encodeURIComponent(task.id)}/enabled`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: nextEnabled }),
    });
    Object.assign(task, response.task);
    runner.value = response.runner;
    emit("changed");
  } catch (error) {
    task.enabled = !nextEnabled;
    ElMessage.error(errorMessage(error, "更新任务状态失败"));
  }
}

async function removeTask(task: VmSchedule) {
  try {
    await confirmVrcAction({
      heading: "删除定时任务",
      tone: "危险操作",
      summary: `对象：${task.name}`,
      detail: "删除后该计划不再自动执行，已执行记录不受影响。",
      confirmButtonText: "确认删除",
    });
  } catch {
    return;
  }
  try {
    await requestJson(`/api/vm-schedules/${encodeURIComponent(task.id)}`, { method: "DELETE" });
    tasks.value = tasks.value.filter((item) => item.id !== task.id);
    emit("changed");
    ElMessage.success("定时任务已删除");
  } catch (error) {
    ElMessage.error(errorMessage(error, "删除定时任务失败"));
  }
}

function toScheduleTarget(vm: VmNode): VmScheduleTarget {
  return {
    vmId: vm.providerId,
    name: vm.name,
    connectionId: props.connection.id,
    providerType: props.connection.providerType,
    connectionName: props.connection.name,
    hostId: vm.hostId,
    hostName: !vm.hostId || vm.hostId === props.host?.providerId ? props.host?.name : undefined,
    ip: vm.ipAddresses[0],
    guestOs: vm.guestOs,
    powerState: vm.powerState,
  };
}

function targetKey(target: VmScheduleTarget) {
  return `${target.connectionId || props.connection.id}|${target.vmId}`;
}

function targetHostKey(target: VmScheduleTarget) {
  return `${target.connectionId || props.connection.id}|${target.hostId || "default"}`;
}

function singleTargetHost() {
  const first = targets.value[0];
  if (!first) return undefined;
  const key = targetHostKey(first);
  return targets.value.every((target) => targetHostKey(target) === key) ? first : undefined;
}

function providerLabel(value?: ProviderType) {
  return value ? getProviderBrand(value).resourceName : "平台未知";
}

function powerStateLabel(value?: VmScheduleTarget["powerState"]) {
  if (value === "running") return "运行中";
  if (value === "halted" || value === "stopped") return "已关机";
  if (value === "suspended") return "已暂停";
  return "未知";
}

function weekdayLabel(value: number) {
  return weekdayOptions.find((item) => item.value === value)?.label ?? `周${value}`;
}

function taskCycleLabel(task: VmSchedule) {
  if (task.cycle === "once") return `单次 ${task.onceAt?.slice(5, 16).replace("T", " ") ?? "-"}`;
  if (task.cycle === "daily") return `每天 ${task.executeTime}`;
  const dayText = task.weekdays?.length === 5 && task.weekdays.every((day) => day >= 1 && day <= 5) ? "周一至周五" : (task.weekdays ?? []).map(weekdayLabel).join("、");
  return `${dayText} ${task.executeTime}`;
}

function taskLastResult(task: VmSchedule) {
  if (!task.lastRun) return "尚未执行";
  return `${formatDateTime(task.lastRun.finishedAt ?? task.lastRun.startedAt, task.timezone)} · ${task.lastRun.message}`;
}

function formatDateTime(value?: string, timeZone = "Asia/Shanghai") {
  if (!value) return "-";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function defaultOnceAt() {
  const date = new Date(Date.now() + 60 * 60_000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:00`;
}

async function requestJson<T = unknown>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: init.body ? { "Content-Type": "application/json", ...(init.headers ?? {}) } : init.headers,
  });
  const data = (await response.json().catch(() => ({}))) as { message?: string } & T;
  if (!response.ok) throw new Error(data.message || `请求失败：HTTP ${response.status}`);
  return data;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}
</script>

<template>
  <el-dialog v-model="dialogVisible" width="880px" class="vm-schedule-dialog" top="6vh" :close-on-click-modal="false">
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
            <div class="schedule-section-heading"><strong>计划设置</strong><span>时间按所选时区执行</span></div>
            <div class="schedule-form-grid">
              <label class="schedule-field schedule-name-field"><span>任务名称</span><el-input v-model="scheduleName" placeholder="例如：工作日晚间关机" /></label>
              <div class="schedule-field"><span>执行动作</span><el-segmented v-model="scheduleAction" class="schedule-action-segmented" :options="[{ label: '开机', value: 'start' }, { label: '关机', value: 'shutdown' }]" /></div>
              <div class="schedule-field"><span>执行周期</span><el-segmented v-model="scheduleCycle" class="schedule-cycle-segmented" :options="[{ label: '单次', value: 'once' }, { label: '每天', value: 'daily' }, { label: '每周', value: 'weekly' }]" /></div>
              <label class="schedule-field"><span>执行时间</span><el-date-picker v-if="scheduleCycle === 'once'" v-model="onceAt" type="datetime" value-format="YYYY-MM-DD HH:mm:ss" format="YYYY-MM-DD HH:mm" placeholder="选择执行时间" /><el-time-picker v-else v-model="executeTime" value-format="HH:mm" format="HH:mm" placeholder="选择时间" /></label>
              <label class="schedule-field"><span>时区</span><el-select v-model="timezone"><el-option label="Asia/Shanghai (UTC+8)" value="Asia/Shanghai" /><el-option label="Asia/Tokyo (UTC+9)" value="Asia/Tokyo" /><el-option label="UTC (UTC+0)" value="UTC" /></el-select></label>
              <div v-if="scheduleCycle === 'weekly'" class="schedule-field schedule-week-field"><span>执行日期</span><el-checkbox-group v-model="weekdays" class="schedule-weekdays"><el-checkbox v-for="day in weekdayOptions" :key="day.value" :value="day.value">{{ day.label }}</el-checkbox></el-checkbox-group></div>
            </div>
          </section>

          <section class="schedule-section">
            <div class="schedule-section-heading"><strong>执行策略</strong><span>任务冲突与关机失败处理</span></div>
            <div class="schedule-policy-grid">
              <label class="schedule-field"><span>冲突处理</span><el-select v-model="conflictPolicy"><el-option label="阻止创建并提示冲突" value="block" /><el-option label="跳过冲突 VM，其余继续" value="skip" /><el-option label="以当前计划覆盖旧计划" value="replace" /></el-select></label>
              <label v-if="scheduleAction === 'shutdown'" class="schedule-field"><span>关机超时（分钟）</span><span class="schedule-timeout-control"><el-input-number v-model="shutdownTimeout" :min="2" :max="60" controls-position="right" /></span></label>
              <label v-if="scheduleAction === 'shutdown'" class="schedule-field"><span>失败处理</span><el-select v-model="shutdownFallback"><el-option label="超时后强制关机" value="force" /><el-option label="仅记录失败" value="fail" /></el-select></label>
              <div class="schedule-field schedule-skip-setting"><span>状态一致时跳过</span><div class="schedule-skip-control"><small>不重复发送相同指令</small><el-switch v-model="skipMatchingState" /></div></div>
            </div>
          </section>

          <section class="schedule-section schedule-target-section">
            <div class="schedule-section-heading schedule-target-heading"><strong>目标虚拟机 <em>已选 {{ targets.length }} 台</em></strong><span>{{ targetOptions.length }} 台可选 · 已选 {{ runningTargetCount }} 台运行中 / {{ stoppedTargetCount }} 台已关机</span></div>
            <div class="schedule-target-filters">
              <div class="schedule-target-query-group">
                <el-input v-model="targetSearch" clearable placeholder="搜索虚拟机名称 / IP / 系统" />
                <el-select v-model="targetHostFilter" multiple collapse-tags collapse-tags-tooltip clearable placeholder="全部物理机">
                  <el-option v-for="option in targetHostOptions" :key="option.value" :label="option.label" :value="option.value" />
                </el-select>
                <el-segmented v-model="targetPowerFilter" class="schedule-target-power-filter" :options="[{ label: '全部', value: 'all' }, { label: '运行中', value: 'running' }, { label: '已关机', value: 'stopped' }]" />
              </div>
              <div class="schedule-target-batch-actions">
                <el-tooltip content="选择当前筛选结果" placement="top" :disabled="iconTooltipsDisabled"><span class="toolbar-tooltip-target"><button type="button" class="schedule-target-icon-action" :disabled="!filteredTargetOptions.length" aria-label="选择当前筛选结果" @click="toggleAllTargets(true)"><el-icon><Finished /></el-icon></button></span></el-tooltip>
                <el-tooltip content="清空当前筛选结果" placement="top" :disabled="iconTooltipsDisabled"><span class="toolbar-tooltip-target"><button type="button" class="schedule-target-icon-action" :disabled="!targets.length" aria-label="清空当前筛选结果" @click="toggleAllTargets(false)"><el-icon><Close /></el-icon></button></span></el-tooltip>
              </div>
            </div>
            <div v-if="catalogErrors.length" class="schedule-target-load-note">{{ catalogErrors.length }} 个连接读取失败，其余虚拟机仍可选择</div>
            <div v-loading="loadingTargets" class="schedule-target-table">
              <div class="schedule-target-table-head"><span class="schedule-target-select-cell"><el-checkbox :model-value="allTargetsSelected" :indeterminate="someTargetsSelected" aria-label="选择当前筛选结果" @change="toggleAllTargets" /></span><span>序号</span><span>名称</span><span>物理机</span><span>IP 地址</span><span>当前状态</span></div>
              <div class="schedule-target-table-body">
                <div v-for="(target, index) in filteredTargetOptions" :key="targetKey(target)" class="schedule-target-row"><span class="schedule-target-select-cell"><el-checkbox :model-value="isTargetSelected(target)" :aria-label="`选择 ${target.name}`" @change="toggleTarget(target, $event)" /></span><span class="schedule-target-index">{{ index + 1 }}</span><span class="schedule-target-name"><strong>{{ target.name }}</strong><small>{{ target.guestOs || providerLabel(target.providerType) }}</small></span><span class="schedule-target-host"><span>{{ target.hostName || target.connectionName || '-' }}</span><small>{{ target.connectionName || providerLabel(target.providerType) }}</small></span><span class="schedule-target-ip">{{ target.ip || '-' }}</span><span class="schedule-target-state" :class="{ 'is-running': target.powerState === 'running' }">{{ powerStateLabel(target.powerState) }}</span></div>
                <div v-if="!loadingTargets && !filteredTargetOptions.length" class="schedule-target-empty">没有符合当前筛选条件的虚拟机</div>
              </div>
            </div>
          </section>
        </div>
      </el-tab-pane>

      <el-tab-pane :label="`任务管理 ${tasks.length}`" name="tasks">
        <section class="schedule-task-list">
          <div class="schedule-task-toolbar"><div><strong>任务列表</strong><span>{{ tasks.filter((task) => task.enabled).length }} 个启用 · {{ tasks.length }} 个任务</span></div><el-button type="primary" @click="openCreate">新建计划</el-button></div>
          <el-table v-loading="loadingTasks" :data="tasks" row-key="id" max-height="360" empty-text="暂无定时任务">
            <el-table-column type="index" label="序号" width="52" align="center" />
            <el-table-column label="任务" min-width="190"><template #default="{ row }"><span class="schedule-task-name"><strong>{{ row.name }}</strong><small>{{ taskLastResult(row) }}</small></span></template></el-table-column>
            <el-table-column label="动作" width="82" align="center"><template #default="{ row }"><span class="schedule-action-label" :class="`action-${row.action}`"><VrcVmActionIcon :name="row.action" />{{ row.action === 'start' ? '开机' : '关机' }}</span></template></el-table-column>
            <el-table-column label="周期" min-width="126"><template #default="{ row }">{{ taskCycleLabel(row) }}</template></el-table-column>
            <el-table-column label="目标" width="62" align="center"><template #default="{ row }">{{ row.targets.length }} 台</template></el-table-column>
            <el-table-column label="下一次执行" width="112"><template #default="{ row }">{{ row.enabled ? formatDateTime(row.nextRunAt, row.timezone) : '已停用' }}</template></el-table-column>
            <el-table-column label="启用" width="62" align="center"><template #default="{ row }"><el-switch v-model="row.enabled" size="small" @change="toggleTask(row, $event)" /></template></el-table-column>
            <el-table-column label="操作" width="82" align="center" fixed="right"><template #default="{ row }"><div class="schedule-row-actions"><button type="button" title="编辑任务" aria-label="编辑任务" @click="editTask(row)"><el-icon><EditPen /></el-icon></button><button type="button" class="danger" title="删除任务" aria-label="删除任务" @click="removeTask(row)"><el-icon><Delete /></el-icon></button></div></template></el-table-column>
          </el-table>
        </section>
      </el-tab-pane>
    </el-tabs>

    <template #footer>
      <div class="schedule-dialog-footer"><span v-if="scheduleView === 'create'"><strong>{{ scheduleAction === 'start' ? '开机' : '关机' }}</strong> · {{ scheduleSummary }} · {{ targets.length }} 台 VM</span><span v-else>{{ runnerSummary }}</span><div><el-button @click="dialogVisible = false">{{ scheduleView === 'create' ? '取消' : '关闭' }}</el-button><el-button v-if="scheduleView === 'create'" type="primary" :loading="saving" :disabled="!targets.length" @click="saveSchedule">{{ editingTaskId ? '保存修改' : '创建计划' }}</el-button></div></div>
    </template>
  </el-dialog>
</template>

<style scoped>
:global(.vm-schedule-dialog) { max-width: calc(100vw - 48px); overflow: hidden; padding: 0; background: var(--vrc-surface); }
:global(.vm-schedule-dialog .el-dialog__header) { margin: 0; padding: 10px 42px 8px 12px; border-bottom: 0; }
:global(.vm-schedule-dialog .el-dialog__body) { padding: 0; }
:global(.vm-schedule-dialog .el-dialog__footer) { margin: 0; padding: 0; border-top: 0; }
.schedule-dialog-header, .schedule-dialog-footer, .schedule-task-toolbar, .schedule-target-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.schedule-dialog-header, .schedule-task-toolbar > div, .schedule-task-name { display: grid; gap: 3px; }
.schedule-dialog-header strong { color: var(--vrc-text); font-size: var(--vrc-font-size-dialog-title); font-weight: var(--vrc-font-weight-heading); line-height: 24px; }
.schedule-dialog-header span { color: var(--vrc-text-muted); font-size: 11px; line-height: 1.3; }
:global(.vm-schedule-dialog .schedule-tabs > .el-tabs__header) { margin: 0; padding: 0 12px; border-bottom: 0; }
:global(.vm-schedule-dialog .schedule-tabs > .el-tabs__header .el-tabs__nav-wrap::after) { display: none; }
:global(.vm-schedule-dialog .schedule-tabs > .el-tabs__header .el-tabs__item) { height: 32px; padding: 0 14px; color: var(--vrc-text-muted); font-size: 12px; font-weight: 400; line-height: 32px; }
:global(.vm-schedule-dialog .schedule-tabs > .el-tabs__header .el-tabs__active-bar + .el-tabs__item) { padding-left: 0; }
:global(.vm-schedule-dialog .schedule-tabs > .el-tabs__header .el-tabs__item.is-active) { color: var(--vrc-accent); font-weight: 400; }
:global(.vm-schedule-dialog .schedule-tabs > .el-tabs__header .el-tabs__active-bar) { height: 2px; background: var(--vrc-accent); }
:global(.vm-schedule-dialog .schedule-tabs > .el-tabs__content) { max-height: calc(88vh - 116px); overflow: auto; overscroll-behavior: contain; scrollbar-gutter: stable; }
.schedule-create-content { display: grid; gap: 10px; padding: 10px 12px 8px; }
.schedule-section { display: grid; gap: 7px; min-width: 0; padding: 12px; background: var(--vrc-surface); border: 1px solid var(--vrc-border); border-radius: 8px; }
.schedule-section-heading { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.schedule-section-heading strong, .schedule-task-toolbar strong { color: var(--vrc-text); font-size: 12px; font-weight: 400; line-height: 1.25; }
.schedule-section-heading > span, .schedule-task-toolbar span, .schedule-dialog-footer > span { color: var(--vrc-text-muted); font-size: 11px; line-height: 1.25; }
.schedule-form-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px 10px; min-width: 0; }
.schedule-field { display: grid; align-content: start; gap: 5px; min-width: 0; }
.schedule-field > span:first-child { color: var(--vrc-text-muted); font-size: 11px; font-weight: 400; line-height: 1; }
.schedule-field :deep(.el-input), .schedule-field :deep(.el-select), .schedule-field :deep(.el-date-editor), .schedule-field :deep(.el-input-number) { width: 100%; }
.schedule-field :deep(.el-input__wrapper), .schedule-field :deep(.el-select__wrapper), .schedule-field :deep(.el-input-number .el-input__wrapper) { height: var(--vrc-control-height); min-height: var(--vrc-control-height); background: var(--vrc-surface); border: 1px solid var(--vrc-border); border-radius: var(--vrc-control-radius); box-shadow: none; }
.schedule-field :deep(.el-input__wrapper:hover), .schedule-field :deep(.el-select__wrapper:hover), .schedule-field :deep(.el-input-number .el-input__wrapper:hover) { border-color: var(--vrc-border); box-shadow: none; }
.schedule-field :deep(.el-input__wrapper.is-focus), .schedule-field :deep(.el-select__wrapper.is-focused) { border-color: var(--vrc-border-strong); box-shadow: none; }
.schedule-field :deep(.el-input__inner), .schedule-field :deep(.el-select__selected-item), .schedule-field :deep(.el-select__placeholder) { height: calc(var(--vrc-control-height) - 2px); color: var(--vrc-text); font-size: var(--vrc-font-size-body); font-weight: var(--vrc-font-weight-regular); line-height: calc(var(--vrc-control-height) - 2px); }
.schedule-action-segmented, .schedule-cycle-segmented { --el-segmented-item-selected-color: var(--vrc-text); --el-segmented-item-selected-bg-color: var(--vrc-surface); box-sizing: border-box; width: 100%; height: 28px; min-height: 28px; padding: 2px; color: var(--vrc-text-muted); background: var(--vrc-surface-muted); border: 1px solid transparent; border-radius: 7px; box-shadow: none; }
.schedule-action-segmented :deep(.el-segmented__group), .schedule-cycle-segmented :deep(.el-segmented__group) { align-items: center; height: 22px; min-height: 22px; }
.schedule-action-segmented :deep(.el-segmented__item), .schedule-cycle-segmented :deep(.el-segmented__item) { height: 22px; min-height: 22px; padding: 0 8px; color: var(--vrc-text-muted); border-radius: 5px; font-size: 12px; font-weight: 400; line-height: 22px; }
.schedule-action-segmented :deep(.el-segmented__item.is-selected), .schedule-cycle-segmented :deep(.el-segmented__item.is-selected) { color: var(--vrc-text); }
.schedule-action-segmented :deep(.el-segmented__item-selected), .schedule-cycle-segmented :deep(.el-segmented__item-selected) { box-shadow: 0 1px 2px color-mix(in srgb, var(--vrc-text) 8%, transparent); }
.schedule-week-field { grid-column: 1 / -1; }
.schedule-weekdays { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 18px; min-height: 28px; padding: 0 2px; }
.schedule-weekdays :deep(.el-checkbox) { height: 28px; margin-right: 0; color: var(--vrc-text); font-size: 12px; }
.schedule-weekdays :deep(.el-checkbox__label) { font-size: 12px; font-weight: 400; }
.schedule-policy-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); align-items: end; gap: 10px; }
.schedule-timeout-control { display: flex; align-items: center; width: 100%; }
.schedule-timeout-control :deep(.el-input-number) { flex: 1 1 auto; width: auto; min-width: 0; }
.schedule-timeout-control :deep(.el-input-number__decrease), .schedule-timeout-control :deep(.el-input-number__increase) { width: 28px; height: var(--vrc-number-step-height); color: var(--vrc-text-muted); background: var(--vrc-surface); border-color: var(--vrc-border); font-size: 11px; line-height: var(--vrc-number-step-height); }
.schedule-timeout-control :deep(.el-input-number__decrease:hover), .schedule-timeout-control :deep(.el-input-number__increase:hover) { color: var(--vrc-accent); background: var(--vrc-surface); border-color: var(--vrc-border); }
.schedule-skip-control { display: flex; align-items: center; justify-content: space-between; gap: 8px; height: 28px; min-width: 0; padding: 0 2px; }
.schedule-skip-control small { min-width: 0; overflow: hidden; color: var(--vrc-text-muted); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.schedule-skip-control :deep(.el-switch) { flex: 0 0 34px; width: 34px; height: 20px; }
.schedule-skip-control :deep(.el-switch__core) { width: 34px; min-width: 34px; height: 20px; }
.schedule-skip-control :deep(.el-switch__action) { width: 16px; height: 16px; }
.schedule-target-heading { align-items: center; }
.schedule-target-heading strong { display: inline-flex; align-items: center; gap: 5px; line-height: 16px; }
.schedule-target-heading strong em { color: var(--vrc-text-muted); font-size: 11px; font-style: normal; font-weight: 400; font-variant-numeric: tabular-nums; line-height: 16px; white-space: nowrap; }
.schedule-target-filters { display: flex; align-items: center; gap: 12px; }
.schedule-target-query-group { display: grid; flex: 1 1 auto; grid-template-columns: minmax(190px, 1fr) minmax(170px, .9fr) 210px; align-items: center; gap: 8px; min-width: 0; }
.schedule-target-filters :deep(.el-input__wrapper), .schedule-target-filters :deep(.el-select__wrapper) { align-items: center; height: var(--vrc-control-height); min-height: var(--vrc-control-height); box-shadow: none; }
.schedule-target-filters :deep(.el-input__wrapper) { padding-top: 1px; padding-bottom: 1px; background: var(--vrc-surface-muted); border: 1px solid transparent; border-radius: 7px; }
.schedule-target-filters :deep(.el-select__wrapper) { padding-top: 0; padding-bottom: 0; background: var(--vrc-surface-muted); border: 1px solid transparent; border-radius: 7px; }
.schedule-target-filters :deep(.el-input__wrapper:hover) { border-color: transparent; box-shadow: none; }
.schedule-target-filters :deep(.el-select__wrapper:hover) { border-color: transparent; box-shadow: none; }
.schedule-target-filters :deep(.el-input__wrapper.is-focus) { background: var(--vrc-surface-muted); border-color: color-mix(in srgb, var(--vrc-accent) 50%, var(--vrc-border)); box-shadow: none; }
.schedule-target-filters :deep(.el-select__wrapper.is-focused) { background: var(--vrc-surface-muted); border-color: color-mix(in srgb, var(--vrc-accent) 50%, var(--vrc-border)); box-shadow: none; }
.schedule-target-filters :deep(.el-input__inner), .schedule-target-filters :deep(.el-select__selected-item), .schedule-target-filters :deep(.el-select__placeholder) { height: calc(var(--vrc-control-height) - 2px); font-size: var(--vrc-font-size-body); line-height: calc(var(--vrc-control-height) - 2px); }
.schedule-target-filters :deep(.el-select__selected-item), .schedule-target-filters :deep(.el-select__placeholder) { display: flex; align-items: center; }
.schedule-target-filters :deep(.el-input__inner::placeholder) { color: var(--vrc-text-subtle); font-size: var(--vrc-font-size-label); font-weight: var(--vrc-font-weight-regular); line-height: calc(var(--vrc-control-height) - 2px); }
.schedule-target-filters :deep(.el-select__placeholder.is-transparent) { color: var(--vrc-text-subtle); font-size: var(--vrc-font-size-label); font-weight: var(--vrc-font-weight-regular); }
.schedule-target-power-filter { --el-segmented-item-selected-color: var(--vrc-text); --el-segmented-item-selected-bg-color: var(--vrc-surface); box-sizing: border-box; width: 100%; height: 28px; min-height: 28px; padding: 2px; color: var(--vrc-text-muted); background: var(--vrc-surface-muted); border: 1px solid transparent; border-radius: 7px; }
.schedule-target-power-filter :deep(.el-segmented__group), .schedule-target-power-filter :deep(.el-segmented__item) { height: 22px; min-height: 22px; }
.schedule-target-power-filter :deep(.el-segmented__item) { padding: 0 7px; border-radius: 5px; font-size: 12px; font-weight: 400; line-height: 22px; }
.schedule-target-batch-actions { display: flex; flex: 0 0 auto; gap: 6px; margin-left: auto; white-space: nowrap; }
.schedule-target-batch-actions .toolbar-tooltip-target { display: inline-flex; }
.schedule-target-icon-action { display: grid; place-items: center; width: 28px; height: 28px; padding: 0; color: var(--vrc-text-muted); background: var(--vrc-surface); border: 1px solid var(--vrc-border); border-radius: 6px; cursor: pointer; }
.schedule-target-icon-action:hover:not(:disabled), .schedule-target-icon-action:focus-visible { color: var(--vrc-accent); border-color: color-mix(in srgb, var(--vrc-accent) 30%, var(--vrc-border)); outline: none; }
.schedule-target-icon-action:disabled { color: var(--vrc-text-subtle); background: var(--vrc-surface-muted); cursor: default; opacity: .65; }
.schedule-target-icon-action :deep(.el-icon) { width: 15px; height: 15px; font-size: 15px; }
.schedule-target-load-note { color: var(--vrc-warning); font-size: 10px; line-height: 1.3; }
.schedule-target-table { overflow: hidden; border: 1px solid var(--vrc-border); border-radius: 7px; }
.schedule-target-table-head, .schedule-target-row { display: grid; grid-template-columns: 34px 48px minmax(180px, 1.25fr) minmax(140px, .85fr) 126px 84px; align-items: center; column-gap: 10px; padding: 0 10px; }
.schedule-target-table-head { min-height: 36px; color: var(--vrc-text-muted); background: var(--vrc-surface-muted); border-bottom: 1px solid var(--vrc-border); font-size: 12px; font-weight: 600; line-height: 18px; }
.schedule-target-table-head > span { min-width: 0; text-align: center; }
.schedule-target-table-body { max-height: 242px; overflow: auto; overscroll-behavior: contain; scrollbar-gutter: stable; }
.schedule-target-row { min-height: 48px; color: var(--vrc-text); background: var(--vrc-surface); font-size: 12px; }
.schedule-target-row + .schedule-target-row { border-top: 1px solid color-mix(in srgb, var(--vrc-border) 72%, transparent); }
.schedule-target-row strong, .schedule-target-row > span:not(.schedule-target-select-cell) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.schedule-target-row strong { font-size: 12px; font-weight: 400; }
.schedule-target-select-cell { display: flex; align-items: center; justify-content: center; min-width: 0; }
.schedule-target-index, .schedule-target-ip { text-align: center; font-variant-numeric: tabular-nums; }
.schedule-target-name, .schedule-target-host { display: grid; min-width: 0; gap: 2px; overflow: hidden; }
.schedule-target-name strong, .schedule-target-name small, .schedule-target-host span, .schedule-target-host small { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.schedule-target-name strong, .schedule-target-host span { color: var(--vrc-text); font-size: 12px; font-weight: 400; line-height: 16px; }
.schedule-target-name small, .schedule-target-host small { color: var(--vrc-text-muted); font-size: 10px; font-weight: 400; line-height: 14px; }
.schedule-target-select-cell :deep(.el-checkbox) { flex: 0 0 auto; height: 28px; margin-right: 0; }
.schedule-target-empty { min-height: 48px; display: grid; place-items: center; color: var(--vrc-text-muted); font-size: 11px; }
.schedule-target-state { display: block; color: var(--vrc-text-muted); text-align: center; }
.schedule-target-state.is-running { color: var(--vrc-success); }
.schedule-task-list { display: grid; gap: 10px; min-width: 0; margin: 10px 12px 8px; padding: 12px; background: var(--vrc-surface); border: 1px solid var(--vrc-border); border-radius: 8px; }
.schedule-task-toolbar { min-height: 30px; }
.schedule-task-toolbar :deep(.el-button), .schedule-dialog-footer :deep(.el-button) { height: 30px; min-height: 30px; padding: 0 12px; border-radius: 7px; font-size: 12px; font-weight: 400; }
.schedule-task-list :deep(.el-table th.el-table__cell) { height: 35px; padding: 0; color: var(--vrc-text-muted); background: var(--vrc-surface-muted); font-size: 12px; font-weight: 600; }
.schedule-task-list :deep(.el-table th.el-table__cell > .cell) { line-height: 35px; text-align: center; }
.schedule-task-list :deep(.el-table td.el-table__cell) { height: 48px; padding: 7px 0; color: var(--vrc-text); font-size: 12px; font-weight: 400; }
.schedule-task-list :deep(.el-table td.el-table__cell > .cell) { line-height: 20px; }
.schedule-task-name { gap: 2px; }
.schedule-task-name strong, .schedule-task-name small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.schedule-task-name strong { color: var(--vrc-text); font-size: 12px; font-weight: 400; line-height: 16px; }
.schedule-task-name small { margin-top: 0; color: var(--vrc-text-muted); font-size: 10px; font-weight: 400; line-height: 14px; }
.schedule-action-label { display: inline-flex; align-items: center; gap: 5px; color: var(--vrc-success); font-size: 11px; }
.schedule-action-label :deep(svg) { width: 14px; height: 14px; }
.schedule-action-label.action-shutdown { color: var(--vrc-warning); }
.schedule-row-actions { display: flex; justify-content: center; gap: 6px; }
.schedule-row-actions button { display: grid; place-items: center; width: var(--vrc-row-action-size); height: var(--vrc-row-action-size); padding: 0; color: var(--vrc-text-muted); background: transparent; border: 1px solid var(--vrc-border); border-radius: var(--vrc-command-radius); cursor: pointer; }
.schedule-row-actions button:hover, .schedule-row-actions button:focus-visible { color: var(--vrc-accent); border-color: color-mix(in srgb, var(--vrc-accent) 32%, var(--vrc-border)); outline: none; box-shadow: var(--vrc-focus-ring); }
.schedule-row-actions button.danger { color: var(--vrc-danger); }
.schedule-dialog-footer { padding: 8px 12px 10px; }
.schedule-dialog-footer > div { display: flex; gap: 8px; }
.schedule-dialog-footer :deep(.el-button + .el-button) { margin-left: 0; }
.schedule-dialog-footer > span strong { color: var(--vrc-text); font-size: 11px; font-weight: 400; }
@media (max-width: 920px) { .schedule-target-filters { align-items: flex-end; } .schedule-target-query-group { grid-template-columns: 1fr 1fr; } .schedule-target-power-filter { grid-column: 1 / -1; } }
@media (max-width: 760px) { .schedule-form-grid, .schedule-policy-grid { grid-template-columns: 1fr 1fr; } .schedule-target-filters { flex-wrap: wrap; } .schedule-target-query-group { flex-basis: 100%; } .schedule-target-batch-actions { justify-content: flex-end; } .schedule-target-table-head, .schedule-target-row { grid-template-columns: 34px 42px minmax(150px, 1fr) minmax(120px, .8fr) 76px; } .schedule-target-table-head > :nth-child(5), .schedule-target-row > :nth-child(5) { display: none; } }
</style>
