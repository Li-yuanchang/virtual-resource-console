<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { secureJsonRequest } from "../domain/secureRequest";
import type {
  HostDiagnosticRepairAction,
  HostDiagnosticStatus,
  HostDiagnosticsResponse,
  HostNode,
  ProviderDescriptor,
  VmNode,
} from "../types";

type ReportStage = "collect" | "analyze" | "render";

const props = defineProps<{
  modelValue: boolean;
  host: HostNode | null;
  vm: VmNode | null;
  providerDescriptor?: ProviderDescriptor;
  connectionPayload?: Record<string, unknown> | null;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  confirm: [payload: { host: HostNode; vm: VmNode | null; action: HostDiagnosticRepairAction }];
}>();

const stages: Array<{ key: ReportStage; label: string }> = [
  { key: "collect", label: "采集证据" },
  { key: "analyze", label: "关联检查" },
  { key: "render", label: "整理报告" },
];

const activitySteps: Array<{ key: ReportStage; label: string }> = [
  { key: "collect", label: "采集宿主机证据" },
  { key: "analyze", label: "关联 OVS 与 VIF 检查" },
  { key: "render", label: "整理异常链路与建议" },
];

const scopeOptions: Array<{ key: string; label: string }> = [
  { key: "all", label: "全部" },
  { key: "network", label: "网络链路" },
  { key: "storage", label: "存储日志" },
  { key: "service", label: "服务状态" },
];

const MIN_RUNNING_MS = 900;

const reporting = ref(false);
const reportComplete = ref(false);
const reportFailed = ref(false);
const reportUnsupported = ref(false);
const reportError = ref("");
const reportPercent = ref(0);
const activeStage = ref<ReportStage>("collect");
const reportSubtitle = ref("等待生成诊断报告");
const result = ref<HostDiagnosticsResponse | null>(null);
const selectedActionKey = ref("");
const confirmArmed = ref(false);
const selectedScopeKey = ref("all");
const scopeOpen = ref(false);

let requestController: AbortController | null = null;
let stageTimers: number[] = [];
let stageTimerHandles: Array<ReturnType<typeof setTimeout>> = [];

const hostLabel = computed(() => props.host?.name || "-");
const hostAddress = computed(() => props.host?.address || "-");
const providerLabel = computed(() => props.providerDescriptor?.label || "虚拟化平台");
const vmIp = computed(() => props.vm?.ipAddresses[0] || "-");
const entrySource = computed(() => (props.vm ? "从 VM 列表进入" : "从物理机总览进入"));
const titleCopy = computed(() => {
  if (reportFailed.value) return "诊断失败";
  if (reportUnsupported.value) return "当前平台不支持诊断";
  if (reportComplete.value) return "诊断报告已生成";
  if (reporting.value) return "正在生成诊断报告";
  return "物理机问题诊断";
});

const riskLabel = computed(() => {
  const level = result.value?.conclusion.riskLevel;
  if (level === "high") return "高";
  if (level === "medium") return "中";
  if (level === "low") return "低";
  return "未评估";
});

const riskClass = computed(() => `is-risk-${result.value?.conclusion.riskLevel ?? "none"}`);

const statusLabel: Record<HostDiagnosticStatus, string> = {
  ok: "正常",
  warn: "关注",
  error: "异常",
  unknown: "未知",
};

const statusClass: Record<HostDiagnosticStatus, string> = {
  ok: "is-ok",
  warn: "is-warn",
  error: "is-error",
  unknown: "is-unknown",
};

const checks = computed(() => result.value?.checks ?? []);
const repairActions = computed(() => result.value?.repairActions ?? []);
const errorCount = computed(() => checks.value.filter((check) => check.status === "error").length);
const warnCount = computed(() => checks.value.filter((check) => check.status === "warn").length);
const selectedAction = computed(
  () => repairActions.value.find((action) => action.key === selectedActionKey.value) ?? repairActions.value[0] ?? null,
);
const selectedScopeLabel = computed(() => scopeOptions.find((option) => option.key === selectedScopeKey.value)?.label ?? "全部");

const footerCopy = computed(() => {
  if (reportFailed.value) return reportError.value || "诊断请求失败，请重试或检查连接。";
  if (reportUnsupported.value) return "该平台暂不支持宿主机诊断，请切换至 XenServer 平台宿主机后使用。";
  if (reporting.value) return `${reportSubtitle.value} · ${reportPercent.value}%`;
  if (reportComplete.value) return "诊断默认只读。修复动作仅提供建议命令，需二次确认后由管理员在宿主机上手动执行。";
  return "诊断默认只读：仅查询宿主机健康与 VM 链路，不执行任何变更。";
});

watch(
  () => props.modelValue,
  (visible) => {
    if (!visible) {
      abortRequest();
      clearStageTimers();
      resetReportState();
      return;
    }
    resetReportState();
    if (props.host) {
      void runDiagnostics();
    }
  },
);

function abortRequest() {
  requestController?.abort();
  requestController = null;
}

function clearStageTimers() {
  stageTimerHandles.forEach((handle) => clearTimeout(handle));
  stageTimerHandles = [];
  stageTimers = [];
}

function resetReportState() {
  abortRequest();
  clearStageTimers();
  reporting.value = false;
  reportComplete.value = false;
  reportFailed.value = false;
  reportUnsupported.value = false;
  reportError.value = "";
  reportPercent.value = 0;
  activeStage.value = "collect";
  reportSubtitle.value = "等待生成诊断报告";
  result.value = null;
  selectedActionKey.value = "";
  confirmArmed.value = false;
}

function close() {
  emit("update:modelValue", false);
}

function scheduleStage(delay: number, stage: ReportStage, subtitle: string, percent: number) {
  const handle = setTimeout(() => {
    if (!reporting.value || reportComplete.value || reportFailed.value || reportUnsupported.value) return;
    activeStage.value = stage;
    reportSubtitle.value = subtitle;
    reportPercent.value = Math.max(reportPercent.value, percent);
  }, delay);
  stageTimerHandles.push(handle);
}

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    const handle = setTimeout(resolve, ms);
    stageTimerHandles.push(handle);
  });
}

function buildRequestPayload() {
  return {
    ...(props.connectionPayload ?? {}),
    hostId: props.host?.providerId || undefined,
    vmId: props.vm?.providerId || undefined,
    vmName: props.vm?.name || undefined,
    vmIp: props.vm?.ipAddresses[0] || undefined,
  };
}

async function runDiagnostics() {
  if (reporting.value) return;
  abortRequest();
  clearStageTimers();
  reporting.value = true;
  reportComplete.value = false;
  reportFailed.value = false;
  reportUnsupported.value = false;
  reportError.value = "";
  reportPercent.value = 4;
  activeStage.value = "collect";
  reportSubtitle.value = "正在连接宿主机并采集证据";
  selectedActionKey.value = "";
  confirmArmed.value = false;

  scheduleStage(520, "analyze", "正在关联 OVS / VIF / 存储检查", 38);
  scheduleStage(1150, "render", "正在整理报告摘要与证据链", 72);

  requestController = new AbortController();
  const startedAt = Date.now();
  try {
    const response = await secureJsonRequest<HostDiagnosticsResponse>(
      "/api/hosts/diagnostics",
      buildRequestPayload(),
      "POST",
      { signal: requestController.signal },
    );
    // 未支持平台秒回时也保留一段可见的“生成中”过程，避免用户以为点击无效。
    const elapsed = Date.now() - startedAt;
    if (elapsed < MIN_RUNNING_MS) {
      await delay(MIN_RUNNING_MS - elapsed);
    }
    if (requestController.signal.aborted) return;
    result.value = response;
    reporting.value = false;
    if (!response.supported) {
      // 平台未实现诊断能力：如实展示“未支持”，不伪装成报告已生成。
      reportUnsupported.value = true;
      activeStage.value = "collect";
      reportSubtitle.value = response.message || "当前平台暂不支持宿主机诊断";
      return;
    }
    reportComplete.value = true;
    reportPercent.value = 100;
    activeStage.value = "render";
    reportSubtitle.value = "报告已生成";
    selectedActionKey.value = response.repairActions[0]?.key ?? "";
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    reporting.value = false;
    reportFailed.value = true;
    reportError.value = error instanceof Error ? error.message : "诊断请求失败";
    reportSubtitle.value = reportError.value;
  }
}

function selectAction(action: HostDiagnosticRepairAction) {
  selectedActionKey.value = action.key;
  confirmArmed.value = false;
}

function selectScope(key: string) {
  selectedScopeKey.value = key;
  scopeOpen.value = false;
}

function onScopeToggle(event: Event) {
  scopeOpen.value = (event.target as HTMLDetailsElement).open;
}

function confirmRepair() {
  if (!props.host || reporting.value || !reportComplete.value || !selectedAction.value) return;
  if (!confirmArmed.value) {
    confirmArmed.value = true;
    return;
  }
  emit("confirm", { host: props.host, vm: props.vm, action: selectedAction.value });
  confirmArmed.value = false;
}

function stageState(stage: ReportStage) {
  if (reportFailed.value || reportUnsupported.value) return "pending";
  const order: ReportStage[] = ["collect", "analyze", "render"];
  const current = order.indexOf(activeStage.value);
  const index = order.indexOf(stage);
  if (reportComplete.value || index < current) return "done";
  if (index === current && reporting.value) return "active";
  return "pending";
}

function stageLabel(stage: ReportStage) {
  const state = stageState(stage);
  if (state === "done") return "已完成";
  if (state === "active") return "进行中";
  return "等待中";
}

function copyCommands(action: { commands: string[] }) {
  const text = action.commands.join("\n");
  void navigator.clipboard?.writeText(text).catch(() => undefined);
}

/** 报告明细卡片按索引错峰入场，返回 --report-index 供动画延迟使用。 */
function reportIndex(index: number): Record<string, string> {
  return { "--report-index": String(index) };
}

/** 检查证据文本：证据条目以间隔符连接，缺失时回退到结果摘要。 */
function evidenceText(item: { evidence?: string[]; summary: string }): string {
  return item.evidence?.join(" · ") || item.summary;
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    width="min(1180px, calc(100vw - 48px))"
    class="host-diagnostics-dialog"
    append-to-body
    :close-on-click-modal="false"
    @close="close"
  >
    <template #header>
      <div class="host-diagnostics-title">
        <strong>{{ titleCopy }}</strong>
        <span>{{ entrySource }} · {{ vm ? `${vm.name} 网络链路 · ${hostLabel}` : `仅宿主机健康检查 · ${hostLabel}` }}</span>
      </div>
    </template>

    <section v-if="host" class="host-diagnostics-body">
      <section class="host-diagnostics-context">
        <dl>
          <div><dt>宿主机</dt><dd>{{ host.name }}</dd></div>
          <div><dt>管理地址</dt><dd>{{ host.address }}</dd></div>
          <div><dt>平台</dt><dd>{{ providerLabel }}</dd></div>
          <div><dt>触发对象</dt><dd>{{ vm ? `${vm.name} · ${vmIp}` : "仅宿主机" }}</dd></div>
        </dl>
        <details
          class="host-diagnostics-scope-select"
          :open="scopeOpen"
          @toggle="onScopeToggle"
        >
          <summary>检查范围：{{ selectedScopeLabel }}</summary>
          <div class="host-diagnostics-scope-menu">
            <button
              v-for="option in scopeOptions"
              :key="option.key"
              type="button"
              :class="{ active: option.key === selectedScopeKey }"
              @click="selectScope(option.key)"
            >
              {{ option.label }}
            </button>
          </div>
        </details>
      </section>

      <div class="host-diagnostics-content">
        <section
          class="host-diagnostics-report"
          :class="{
            'is-live': reporting,
            'is-complete': reportComplete,
            'is-failed': reportFailed,
            'is-unsupported': reportUnsupported,
            'is-idle': !reporting && !reportComplete && !reportFailed && !reportUnsupported,
          }"
        >
          <div class="host-diagnostics-report-head">
            <div class="host-diagnostics-report-title">
              <i class="status-dot" aria-hidden="true"></i>
              <div>
                <strong>{{ titleCopy }}</strong>
                <span>{{ reportSubtitle }}</span>
              </div>
            </div>
            <small>{{ reportUnsupported ? "—" : `${reportPercent}%` }}</small>
          </div>
          <div class="host-diagnostics-report-stages" aria-label="报告生成步骤">
            <span v-for="stage in stages" :key="stage.key" :class="`is-${stageState(stage.key)}`">{{ stage.label }}</span>
          </div>
          <div class="host-diagnostics-report-activity" aria-label="报告生成明细">
            <div
              v-for="(step, index) in activitySteps"
              :key="step.key"
              :class="`is-${stageState(step.key)}`"
              :style="reportIndex(index)"
            >
              <span>{{ index + 1 }}</span>
              <strong>{{ step.label }}</strong>
              <em>{{ stageLabel(step.key) }}</em>
            </div>
          </div>
        </section>

        <section v-if="result && reportUnsupported" class="host-diagnostics-main">
          <article class="host-diagnostics-card host-diagnostics-unsupported">
            <div class="host-diagnostics-card-head">
              <span>诊断能力</span>
              <strong>当前平台暂不支持宿主机诊断</strong>
              <small>宿主机诊断能力目前仅对 XenServer 平台开放，不在此平台执行任何采集。</small>
            </div>
            <div class="host-diagnostics-unsupported-body">
              <div class="host-diagnostics-unsupported-icon" aria-hidden="true"></div>
              <p>{{ result.message || "当前平台 Provider 尚未实现宿主机诊断能力，仅支持 XenServer。" }}</p>
              <dl>
                <div><dt>诊断对象</dt><dd>{{ hostLabel }}</dd></div>
                <div><dt>管理地址</dt><dd>{{ result.hostAddress || hostAddress }}</dd></div>
                <div><dt>平台类型</dt><dd>{{ result.providerType }} · {{ providerLabel }}</dd></div>
              </dl>
              <div class="host-diagnostics-unsupported-note">该平台暂未接入宿主机诊断能力，请切换已支持的平台后重新发起诊断；重新生成仅会重新查询该平台是否具备诊断能力。</div>
            </div>
          </article>
        </section>

        <section v-if="result && !reportUnsupported" class="host-diagnostics-main">
          <article class="host-diagnostics-card host-diagnostics-result">
            <div class="host-diagnostics-card-head">
              <span>当前结论</span>
              <strong>{{ result.conclusion.summary }}</strong>
              <small>诊断主语为宿主机，VM 仅作为触发线索补充链路检查。</small>
            </div>
            <dl class="host-diagnostics-result-meta">
              <div v-if="result.conclusion.faultPoint"><dt>故障点</dt><dd>{{ result.conclusion.faultPoint }}</dd></div>
              <div v-if="result.conclusion.impact"><dt>影响</dt><dd>{{ result.conclusion.impact }}</dd></div>
              <div><dt>风险等级</dt><dd :class="riskClass">{{ riskLabel }}</dd></div>
            </dl>
            <div class="host-diagnostics-scope-summary">
              <div><span>诊断对象</span><strong>{{ result.hostName || hostLabel }}</strong><small>{{ result.hostAddress || hostAddress }} · {{ providerLabel }}</small></div>
              <div><span>VM 线索</span><strong>{{ result.vmName || vm?.name || "无" }}</strong><small>{{ result.vmIp || "未提供 VM IP" }}</small></div>
              <div><span>检查范围</span><strong>宿主机健康 + VM 链路</strong><small>不扫描全部虚拟机</small></div>
            </div>
          </article>

          <article class="host-diagnostics-card host-diagnostics-checks">
            <div class="host-diagnostics-card-head">
              <span>检查项</span>
              <strong>{{ checks.length }} 项检查 · {{ errorCount }} 项异常 · {{ warnCount }} 项关注</strong>
              <small>默认先查宿主机，携带 VM 线索时追加 VIF 挂桥与连通性检查。</small>
            </div>
            <div class="host-diagnostics-check-list">
              <div
                v-for="(item, index) in checks"
                :key="item.key"
                :class="{ warning: item.status === 'error' }"
                :style="reportIndex(index)"
              >
                <span>{{ item.label }}</span>
                <strong>{{ item.summary }}</strong>
                <em :class="statusClass[item.status]">{{ statusLabel[item.status] }}</em>
              </div>
            </div>
            <details v-if="checks.length" class="host-diagnostics-detail host-diagnostics-check-detail">
              <summary>查看检查证据</summary>
              <section class="host-diagnostics-detail-body">
                <div class="host-diagnostics-trace">
                  <div
                    v-for="(item, index) in checks"
                    :key="item.key"
                    :class="{ warning: item.status === 'error' }"
                    :style="reportIndex(index)"
                  >
                    <span>{{ index + 1 }}</span>
                    <strong>{{ item.label }}</strong>
                    <code :title="evidenceText(item)">{{ evidenceText(item) }}</code>
                    <em :class="statusClass[item.status]">{{ statusLabel[item.status] }}</em>
                  </div>
                </div>
              </section>
            </details>
          </article>
        </section>

        <section v-if="result && !reportUnsupported" class="host-diagnostics-card host-diagnostics-repair">
          <div class="host-diagnostics-card-head">
            <span>建议修复</span>
            <strong>{{ repairActions.length ? "以下为建议命令，需二次确认后由管理员在宿主机上手动执行" : "无需修复" }}</strong>
            <small>本弹框不会直接修改宿主机；所有命令均需在宿主机 root 权限下确认后执行。</small>
          </div>
          <template v-if="repairActions.length">
            <div class="host-diagnostics-repair-body">
              <label
                v-for="action in repairActions"
                :key="action.key"
                class="host-diagnostics-repair-option"
                :class="{ active: selectedAction?.key === action.key }"
              >
                <input
                  type="radio"
                  name="host-diagnostics-repair"
                  :checked="selectedAction?.key === action.key"
                  @change="selectAction(action)"
                />
                <span>
                  <strong>{{ action.label }}</strong>
                  <small>{{ action.description }}</small>
                </span>
                <em>{{ action.recommended ? "推荐" : "可选" }}</em>
              </label>
              <details v-if="selectedAction" class="host-diagnostics-subdetail">
                <summary>命令预览与验证</summary>
                <div class="host-diagnostics-command-block">
                  <div class="command-block-head">
                    <span>建议命令（只读展示，不会自动执行）</span>
                    <button type="button" class="command-copy-button" @click="copyCommands(selectedAction)">复制</button>
                  </div>
                  <div class="host-diagnostics-command-row"><span>命令预览</span><code>{{ selectedAction.commands.join(" && ") }}</code></div>
                  <div class="host-diagnostics-command-row"><span>验证动作</span><code>{{ selectedAction.verificationCommands.join(" && ") }}</code></div>
                  <p class="host-diagnostics-scope-note">{{ selectedAction.scopeNote }}</p>
                </div>
              </details>
            </div>
          </template>
          <div v-else class="host-diagnostics-no-repair">
            各项检查均正常，暂无建议修复动作。
          </div>
        </section>
      </div>
    </section>

    <template #footer>
      <div class="host-diagnostics-footer">
        <span>{{ footerCopy }}</span>
        <div class="host-diagnostics-footer-actions">
          <button type="button" class="host-diagnostics-button" :disabled="reporting" @click="runDiagnostics">
            {{ reportComplete || reportFailed || reportUnsupported ? "重新生成报告" : "生成诊断报告" }}
          </button>
          <button
            type="button"
            class="host-diagnostics-button primary"
            :class="{ 'is-armed': confirmArmed }"
            :disabled="reporting || !reportComplete || !repairActions.length || !selectedAction"
            @click="confirmRepair"
          >
            {{ confirmArmed ? "再次点击确认（需在宿主机手动执行）" : "确认修复" }}
          </button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
/* ---------- Element Plus 弹框外壳对齐原型 dialog-static ---------- */
:global(.host-diagnostics-dialog.el-dialog) {
  display: flex;
  flex-direction: column;
  width: var(--el-dialog-width, min(1180px, calc(100vw - 48px)));
  height: min(720px, calc(100vh - 48px));
  max-height: calc(100vh - 48px);
  margin: 24px auto;
  padding: 0;
  overflow: hidden;
  background: var(--vrc-surface);
  border: 1px solid var(--vrc-border-strong);
  border-radius: 8px;
  box-shadow: 0 24px 60px rgb(31 43 35 / 22%);
}

:global(.host-diagnostics-dialog .el-dialog__header) {
  flex: 0 0 auto;
  padding: 12px 12px 8px;
  margin: 0;
}

:global(.host-diagnostics-dialog .el-dialog__headerbtn) {
  top: 5px;
  right: 5px;
  width: 30px;
  height: 30px;
  font-size: 18px;
}

:global(.host-diagnostics-dialog .el-dialog__headerbtn .el-dialog__close) {
  color: var(--vrc-text-muted);
  font-size: 18px;
}

:global(.host-diagnostics-dialog .el-dialog__headerbtn:hover),
:global(.host-diagnostics-dialog .el-dialog__headerbtn:focus-visible) {
  color: var(--vrc-accent);
  background: var(--vrc-accent-soft);
  border-radius: 5px;
}

:global(.host-diagnostics-dialog .el-dialog__headerbtn:hover .el-dialog__close),
:global(.host-diagnostics-dialog .el-dialog__headerbtn:focus-visible .el-dialog__close) {
  color: var(--vrc-accent);
}

:global(.host-diagnostics-dialog .el-dialog__body) {
  flex: 1 1 0;
  height: 0;
  min-height: 0;
  padding: 0;
  overflow: hidden;
}

:global(.host-diagnostics-dialog .el-dialog__footer) {
  flex: 0 0 auto;
  padding: 0;
}

/* ---------- 标题 ---------- */
.host-diagnostics-title {
  display: grid;
  gap: 3px;
  padding-right: 36px;
}

.host-diagnostics-title strong {
  font-size: 18px;
  font-weight: 400;
}

.host-diagnostics-title span {
  color: var(--vrc-text-muted);
  font-size: 11px;
}

/* ---------- 整体布局 ---------- */
.host-diagnostics-body {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  height: 100%;
  min-height: 0;
}

.host-diagnostics-content {
  display: grid;
  gap: 10px;
  min-height: 0;
  padding: 10px 12px;
  overflow-y: auto;
}

/* ---------- 上下文条（宿主机 / 管理地址 / 平台 / 触发对象 + 检查范围） ---------- */
.host-diagnostics-context {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 12px;
  align-items: center;
  padding: 9px 12px;
  background: var(--vrc-surface-raised);
  border-bottom: 1px solid var(--vrc-border);
}

.host-diagnostics-context dl {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px 14px;
  margin: 0;
}

.host-diagnostics-context dl div {
  display: flex;
  gap: 6px;
  min-width: 0;
}

.host-diagnostics-context dt,
.host-diagnostics-context dd {
  margin: 0;
  font-size: 11px;
  white-space: nowrap;
}

.host-diagnostics-context dt {
  color: var(--vrc-text-muted);
}

.host-diagnostics-context dd {
  min-width: 0;
  overflow: hidden;
  color: var(--vrc-text);
  font-weight: 500;
  text-overflow: ellipsis;
}

.host-diagnostics-scope-select {
  position: relative;
  min-width: 150px;
}

.host-diagnostics-scope-select summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 30px;
  padding: 0 10px;
  color: var(--vrc-text);
  font-size: 11px;
  background: var(--vrc-surface);
  border: 1px solid var(--vrc-border);
  border-radius: 6px;
  cursor: pointer;
  list-style: none;
}

.host-diagnostics-scope-select summary::-webkit-details-marker {
  display: none;
}

.host-diagnostics-scope-select summary::after {
  margin-left: 8px;
  color: var(--vrc-text-muted);
  content: "展开";
}

.host-diagnostics-scope-select[open] summary {
  border-color: var(--vrc-active-border);
}

.host-diagnostics-scope-select[open] summary::after {
  content: "收起";
}

.host-diagnostics-scope-menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 3;
  display: grid;
  gap: 2px;
  width: 168px;
  padding: 6px;
  background: var(--vrc-surface);
  border: 1px solid var(--vrc-border);
  border-radius: 7px;
  box-shadow: 0 10px 24px rgb(31 43 35 / 12%);
}

.host-diagnostics-scope-menu button {
  height: 28px;
  padding: 0 8px;
  color: var(--vrc-text);
  font-size: 11px;
  font-weight: 400;
  text-align: left;
  background: transparent;
  border: 0;
  border-radius: 5px;
  cursor: pointer;
}

.host-diagnostics-scope-menu button.active {
  color: var(--vrc-active-text);
  background: var(--vrc-surface-raised);
}

/* ---------- 报告状态卡 ---------- */
.host-diagnostics-report {
  position: relative;
  display: grid;
  gap: 6px;
  min-height: 146px;
  padding: 10px 12px;
  overflow: hidden;
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--vrc-surface-raised) 95%, white), var(--vrc-surface-raised)),
    linear-gradient(90deg, color-mix(in srgb, var(--vrc-accent) 4%, transparent), transparent 24%, transparent 76%, color-mix(in srgb, var(--vrc-success) 4%, transparent));
  border: 1px solid var(--vrc-border);
  border-radius: 8px;
}

.host-diagnostics-report::before {
  position: absolute;
  inset: 0 0 auto 0;
  height: 2px;
  background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--vrc-accent) 72%, white), color-mix(in srgb, var(--vrc-success) 70%, var(--vrc-accent)), transparent);
  opacity: 0;
  content: "";
}

.host-diagnostics-report.is-live::before {
  opacity: 1;
  animation: host-diagnostics-report-flow 2.4s linear infinite;
}

.host-diagnostics-report.is-failed::before {
  opacity: 0.9;
  background: linear-gradient(90deg, transparent, var(--vrc-danger), transparent);
}

.host-diagnostics-report.is-failed {
  background: linear-gradient(180deg, color-mix(in srgb, var(--vrc-danger) 6%, var(--vrc-surface-raised)), var(--vrc-surface-raised));
  border-color: color-mix(in srgb, var(--vrc-danger) 38%, var(--vrc-border));
}

.host-diagnostics-report.is-complete {
  background: linear-gradient(180deg, color-mix(in srgb, var(--vrc-success) 7%, var(--vrc-surface-raised)), var(--vrc-surface-raised));
  border-color: color-mix(in srgb, var(--vrc-success) 38%, var(--vrc-border));
}

.host-diagnostics-report.is-unsupported {
  background: linear-gradient(180deg, color-mix(in srgb, var(--vrc-warning) 7%, var(--vrc-surface-raised)), var(--vrc-surface-raised));
  border-color: color-mix(in srgb, var(--vrc-warning) 38%, var(--vrc-border));
}

.host-diagnostics-report.is-unsupported::before {
  opacity: 0.9;
  background: linear-gradient(90deg, transparent, var(--vrc-warning), transparent);
}

.host-diagnostics-report-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
}

.host-diagnostics-report-title {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.host-diagnostics-report-title > div {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.host-diagnostics-report-title .status-dot {
  flex: 0 0 7px;
  width: 7px;
  height: 7px;
  background: var(--vrc-success);
  border-radius: 50%;
  animation: host-diagnostics-report-pulse 1.2s ease-in-out infinite;
}

.host-diagnostics-report.is-complete .status-dot {
  animation: none;
  background: var(--vrc-success);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--vrc-success) 12%, transparent);
}

.host-diagnostics-report.is-failed .status-dot {
  animation: none;
  background: var(--vrc-danger);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--vrc-danger) 12%, transparent);
}

.host-diagnostics-report.is-failed .host-diagnostics-report-title strong {
  color: var(--vrc-danger);
}

.host-diagnostics-report.is-unsupported .status-dot {
  animation: none;
  background: var(--vrc-warning);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--vrc-warning) 12%, transparent);
}

.host-diagnostics-report.is-unsupported .host-diagnostics-report-title strong {
  color: var(--vrc-warning);
}

.host-diagnostics-report-title strong {
  font-size: 14px;
  font-weight: 600;
}

.host-diagnostics-report-title span,
.host-diagnostics-report-head > small {
  color: var(--vrc-text-muted);
  font-size: 11px;
}

.host-diagnostics-report-stages {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.host-diagnostics-report-stages span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 22px;
  padding: 0 8px 0 7px;
  color: var(--vrc-text-muted);
  font-size: 10px;
  background: var(--vrc-surface);
  border: 1px solid var(--vrc-border);
  border-radius: 999px;
  transition: border-color 180ms ease, background-color 180ms ease, color 180ms ease, transform 180ms ease, box-shadow 180ms ease;
}

.host-diagnostics-report-stages span::before {
  width: 6px;
  height: 6px;
  background: color-mix(in srgb, var(--vrc-text-subtle) 75%, white);
  border-radius: 50%;
  content: "";
}

.host-diagnostics-report-stages span.is-active::before {
  background: var(--vrc-accent);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--vrc-accent) 12%, transparent);
  animation: host-diagnostics-report-dot 1.1s ease-in-out infinite;
}

.host-diagnostics-report-stages span.is-active {
  color: var(--vrc-accent);
  border-color: var(--vrc-active-border);
  background: color-mix(in srgb, var(--vrc-accent) 8%, var(--vrc-surface));
  transform: translateY(-1px);
  box-shadow: 0 6px 16px rgb(31 44 35 / 7%);
}

.host-diagnostics-report-stages span.is-done {
  color: var(--vrc-success);
  border-color: color-mix(in srgb, var(--vrc-success) 34%, var(--vrc-border));
}

.host-diagnostics-report-stages span.is-done::before {
  background: var(--vrc-success);
}

.host-diagnostics-report-activity {
  position: relative;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  align-items: stretch;
  padding-top: 4px;
}

.host-diagnostics-report-activity > div {
  position: relative;
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr);
  gap: 5px 8px;
  align-content: start;
  min-height: 58px;
  padding: 10px 10px 9px 11px;
  background: var(--vrc-surface);
  border: 1px solid var(--vrc-border);
  border-radius: 7px;
  box-shadow: 0 1px 1px rgb(31 44 35 / 3%);
  opacity: 0.96;
  transition: border-color 180ms ease, background-color 180ms ease, transform 180ms ease, box-shadow 180ms ease, opacity 180ms ease;
}

.host-diagnostics-report.is-live .host-diagnostics-report-activity > div {
  opacity: 1;
  animation: host-diagnostics-report-rise 420ms cubic-bezier(0.16, 0.84, 0.24, 1) both;
  animation-delay: calc(var(--report-index) * 88ms);
}

.host-diagnostics-report-activity > div::before {
  position: absolute;
  top: -1px;
  right: 12px;
  left: 12px;
  height: 2px;
  background: transparent;
  border-radius: 999px;
  content: "";
}

.host-diagnostics-report-activity span {
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  color: var(--vrc-text-muted);
  font-family: "SFMono-Regular", Consolas, monospace;
  font-size: 10px;
  background: var(--vrc-surface-raised);
  border-radius: 50%;
  transition: transform 180ms ease, background-color 180ms ease, color 180ms ease, box-shadow 180ms ease;
}

.host-diagnostics-report-activity strong {
  overflow: hidden;
  color: var(--vrc-text);
  font-size: 11px;
  font-weight: 500;
  line-height: 1.25;
  text-overflow: ellipsis;
}

.host-diagnostics-report-activity em {
  grid-column: 2;
  display: inline-flex;
  align-items: center;
  width: fit-content;
  min-height: 18px;
  padding: 0 7px;
  color: var(--vrc-text-muted);
  font-size: 10px;
  font-style: normal;
  background: var(--vrc-surface-raised);
  border: 1px solid var(--vrc-border);
  border-radius: 999px;
}

.host-diagnostics-report-activity > div.is-active {
  border-color: var(--vrc-active-border);
  background: color-mix(in srgb, var(--vrc-accent) 6%, var(--vrc-surface));
  box-shadow: 0 8px 18px rgb(31 44 35 / 7%);
  transform: translateY(-2px);
}

.host-diagnostics-report-activity > div.is-active strong {
  color: var(--vrc-accent);
}

.host-diagnostics-report-activity > div.is-active span {
  color: var(--vrc-accent);
  background: color-mix(in srgb, var(--vrc-accent) 11%, var(--vrc-surface-raised));
  animation: host-diagnostics-report-step 1.1s ease-in-out infinite;
}

.host-diagnostics-report-activity > div.is-active::before {
  background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--vrc-accent) 88%, white), transparent);
  animation: host-diagnostics-report-track 1.2s ease-in-out infinite;
}

.host-diagnostics-report-activity > div.is-active em {
  color: var(--vrc-accent);
  background: color-mix(in srgb, var(--vrc-accent) 8%, var(--vrc-surface-raised));
  border-color: color-mix(in srgb, var(--vrc-accent) 28%, var(--vrc-border));
}

.host-diagnostics-report-activity > div.is-done {
  border-color: color-mix(in srgb, var(--vrc-success) 28%, var(--vrc-border));
  background: color-mix(in srgb, var(--vrc-success) 4%, var(--vrc-surface));
}

.host-diagnostics-report-activity > div.is-done span {
  color: var(--vrc-success);
  background: color-mix(in srgb, var(--vrc-success) 10%, var(--vrc-surface-raised));
}

.host-diagnostics-report-activity > div.is-done::before {
  background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--vrc-success) 88%, white), transparent);
}

.host-diagnostics-report-activity > div.is-done em {
  color: var(--vrc-success);
  background: color-mix(in srgb, var(--vrc-success) 7%, var(--vrc-surface-raised));
  border-color: color-mix(in srgb, var(--vrc-success) 26%, var(--vrc-border));
}

.host-diagnostics-report-activity > div.is-pending {
  opacity: 0.72;
}

/* ---------- 主体双列卡片 ---------- */
.host-diagnostics-main {
  display: grid;
  grid-template-columns: minmax(300px, 0.72fr) minmax(0, 1.28fr);
  gap: 10px;
  align-items: stretch;
}

.host-diagnostics-card {
  display: grid;
  align-content: start;
  gap: 10px;
  min-height: 100%;
  padding: 14px;
  background: var(--vrc-surface);
  border: 1px solid var(--vrc-border);
  border-radius: 8px;
}

.host-diagnostics-card.host-diagnostics-unsupported {
  grid-column: 1 / -1;
  min-height: 230px;
  background: linear-gradient(180deg, color-mix(in srgb, var(--vrc-warning) 5%, var(--vrc-surface)), var(--vrc-surface));
  border-color: color-mix(in srgb, var(--vrc-warning) 30%, var(--vrc-border));
}

.host-diagnostics-unsupported-body {
  display: grid;
  gap: 12px;
  align-content: start;
  padding: 4px 2px 2px;
}

.host-diagnostics-unsupported-icon {
  width: 34px;
  height: 34px;
  background: color-mix(in srgb, var(--vrc-warning) 13%, var(--vrc-surface-raised));
  border: 1px solid color-mix(in srgb, var(--vrc-warning) 34%, var(--vrc-border));
  border-radius: 50%;
}

.host-diagnostics-unsupported-icon::before {
  display: block;
  width: 10px;
  height: 10px;
  margin: 11px auto;
  border: 2px solid var(--vrc-warning);
  border-right-color: transparent;
  border-radius: 50%;
  content: "";
  animation: host-diagnostics-report-step 1.1s ease-in-out infinite;
}

.host-diagnostics-unsupported-body p {
  margin: 0;
  color: var(--vrc-text);
  font-size: 12px;
  line-height: 1.6;
}

.host-diagnostics-unsupported-body dl {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px 14px;
  margin: 0;
  padding: 10px 12px;
  background: var(--vrc-surface-raised);
  border: 1px solid var(--vrc-border);
  border-radius: 7px;
}

.host-diagnostics-unsupported-body dl div {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.host-diagnostics-unsupported-body dt {
  color: var(--vrc-text-muted);
  font-size: 10px;
}

.host-diagnostics-unsupported-body dd {
  margin: 0;
  overflow: hidden;
  color: var(--vrc-text);
  font-size: 11px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.host-diagnostics-unsupported-note {
  padding: 8px 10px;
  color: var(--vrc-text-muted);
  font-size: 11px;
  line-height: 1.5;
  background: color-mix(in srgb, var(--vrc-warning) 6%, var(--vrc-surface-raised));
  border: 1px dashed color-mix(in srgb, var(--vrc-warning) 30%, var(--vrc-border));
  border-radius: 6px;
}

.host-diagnostics-card-head {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.host-diagnostics-card-head::before {
  width: 34px;
  height: 3px;
  background: var(--vrc-warning);
  border-radius: 999px;
  content: "";
}

.host-diagnostics-card-head span {
  color: var(--vrc-text-muted);
  font-size: 11px;
}

.host-diagnostics-card-head strong {
  font-size: 15px;
  font-weight: 500;
}

.host-diagnostics-card-head small {
  color: var(--vrc-text-muted);
  font-size: 11px;
  line-height: 1.55;
}

/* ---------- 结果卡 ---------- */
.host-diagnostics-result-meta {
  display: grid;
  gap: 8px;
  margin: 0;
  padding-top: 10px;
  border-top: 1px dashed var(--vrc-border);
}

.host-diagnostics-result-meta div {
  display: flex;
  justify-content: space-between;
  gap: 10px;
}

.host-diagnostics-result-meta dt,
.host-diagnostics-result-meta dd {
  margin: 0;
  font-size: 11px;
}

.host-diagnostics-result-meta dt {
  color: var(--vrc-text-muted);
}

.host-diagnostics-result-meta dd {
  color: var(--vrc-text);
  text-align: right;
}

.host-diagnostics-scope-summary {
  display: grid;
  padding-top: 10px;
  border-top: 1px dashed var(--vrc-border);
}

.host-diagnostics-scope-summary div {
  display: grid;
  grid-template-columns: 72px minmax(0, 1fr);
  gap: 6px 10px;
  align-items: center;
  min-height: 32px;
  padding: 4px 0;
}

.host-diagnostics-scope-summary span {
  color: var(--vrc-text-muted);
  font-size: 11px;
}

.host-diagnostics-scope-summary strong {
  overflow: hidden;
  font-size: 11px;
  font-weight: 400;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.host-diagnostics-scope-summary small {
  grid-column: 2;
  overflow: hidden;
  color: var(--vrc-text-muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---------- 检查卡 ---------- */
.host-diagnostics-check-list {
  display: grid;
  flex: 1 1 auto;
  padding-top: 2px;
  border-top: 1px dashed var(--vrc-border);
}

.host-diagnostics-check-list > div {
  position: relative;
  display: grid;
  grid-template-columns: 118px minmax(0, 1fr) 48px;
  gap: 12px;
  align-items: center;
  min-height: 36px;
  padding: 0 10px 0 12px;
  border-bottom: 1px solid color-mix(in srgb, var(--vrc-border) 72%, transparent);
  transition: background-color 180ms ease, box-shadow 180ms ease, border-color 180ms ease, transform 180ms ease;
}

.host-diagnostics-check-list > div:last-child {
  border-bottom: 0;
}

.host-diagnostics-check-list span {
  color: var(--vrc-text);
  font-size: 11px;
}

.host-diagnostics-check-list strong {
  overflow: hidden;
  color: var(--vrc-text-muted);
  font-family: "SFMono-Regular", Consolas, monospace;
  font-size: 11px;
  font-weight: 400;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.host-diagnostics-check-list em {
  font-style: normal;
  text-align: right;
}

.host-diagnostics-check-list .warning strong {
  color: var(--vrc-text);
}

/* ---------- 检查证据详情与轨迹卡 ---------- */
.host-diagnostics-detail {
  background: var(--vrc-surface);
  border: 1px solid var(--vrc-border);
  border-radius: 8px;
}

.host-diagnostics-detail summary {
  display: flex;
  align-items: center;
  min-height: 34px;
  padding: 0 12px;
  color: var(--vrc-text);
  font-size: 11px;
  cursor: pointer;
  list-style: none;
}

.host-diagnostics-detail summary::-webkit-details-marker {
  display: none;
}

.host-diagnostics-detail summary::after {
  margin-left: auto;
  color: var(--vrc-text-muted);
  content: "展开";
  font-size: 11px;
}

.host-diagnostics-detail[open] summary {
  border-bottom: 1px solid var(--vrc-border);
}

.host-diagnostics-detail[open] summary::after {
  content: "收起";
}

.host-diagnostics-check-detail {
  margin: 0;
  background: var(--vrc-surface-raised);
  border-color: var(--vrc-border);
  border-radius: 7px;
}

.host-diagnostics-trace {
  display: grid;
  gap: 0;
  max-height: min(248px, 40vh);
  padding: 4px 0 6px;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.host-diagnostics-trace > div {
  position: relative;
  display: grid;
  grid-template-columns: 24px 118px minmax(0, 1fr) 48px;
  gap: 10px;
  align-items: center;
  min-height: 34px;
  padding: 0 10px 0 8px;
  border-bottom: 1px solid color-mix(in srgb, var(--vrc-border) 72%, transparent);
  transition: background-color 180ms ease;
}

.host-diagnostics-trace > div:last-child {
  border-bottom: 0;
}

.host-diagnostics-trace span {
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  color: var(--vrc-text-muted);
  font-family: "SFMono-Regular", Consolas, monospace;
  font-size: 10px;
  background: var(--vrc-surface-raised);
  border-radius: 50%;
}

.host-diagnostics-trace strong {
  overflow: hidden;
  font-size: 11px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.host-diagnostics-trace code {
  overflow: hidden;
  color: var(--vrc-text-muted);
  font-family: "SFMono-Regular", Consolas, monospace;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.host-diagnostics-trace em {
  font-style: normal;
  text-align: right;
}

.host-diagnostics-trace .warning span {
  color: var(--vrc-warning);
  background: color-mix(in srgb, var(--vrc-warning) 12%, var(--vrc-surface));
}

.host-diagnostics-trace .warning strong {
  color: var(--vrc-text);
}

.host-diagnostics-trace .warning {
  background: color-mix(in srgb, var(--vrc-warning) 6%, transparent);
}

/* ---------- 修复卡 ---------- */
.host-diagnostics-repair-body {
  display: grid;
  gap: 8px;
  padding-top: 2px;
  border-top: 1px dashed var(--vrc-border);
}

.host-diagnostics-repair-option {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr) 58px;
  gap: 8px;
  align-items: center;
  min-height: 48px;
  padding: 8px 10px;
  border: 1px solid var(--vrc-border);
  border-radius: 7px;
  cursor: pointer;
}

.host-diagnostics-repair-option.active {
  border-color: var(--vrc-active-border);
}

.host-diagnostics-repair-option input {
  margin: 0;
}

.host-diagnostics-repair-option > span {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.host-diagnostics-repair-option strong {
  font-weight: 500;
}

.host-diagnostics-repair-option small {
  color: var(--vrc-text-muted);
  font-size: 11px;
  line-height: 1.45;
}

.host-diagnostics-repair-option em {
  color: var(--vrc-text-muted);
  font-style: normal;
  text-align: right;
}

.host-diagnostics-repair-option.active em {
  color: var(--vrc-accent);
}

.host-diagnostics-subdetail {
  border: 1px solid var(--vrc-border);
  border-radius: 7px;
}

.host-diagnostics-subdetail summary {
  display: flex;
  align-items: center;
  min-height: 34px;
  padding: 0 10px;
  color: var(--vrc-text);
  font-size: 11px;
  cursor: pointer;
  list-style: none;
}

.host-diagnostics-subdetail summary::-webkit-details-marker {
  display: none;
}

.host-diagnostics-subdetail summary::after {
  margin-left: auto;
  color: var(--vrc-text-muted);
  content: "展开";
  font-size: 11px;
}

.host-diagnostics-subdetail[open] summary {
  border-bottom: 1px solid var(--vrc-border);
}

.host-diagnostics-subdetail[open] summary::after {
  content: "收起";
}

.host-diagnostics-command-block {
  display: grid;
  gap: 8px;
  margin: 8px 10px;
}

.command-block-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.command-block-head span {
  color: var(--vrc-text-muted);
  font-size: 11px;
}

.command-copy-button {
  padding: 2px 8px;
  color: var(--vrc-accent);
  font-size: 11px;
  background: transparent;
  border: 1px solid color-mix(in srgb, var(--vrc-accent) 32%, var(--vrc-border));
  border-radius: 6px;
  cursor: pointer;
}

.host-diagnostics-command-row {
  display: grid;
  grid-template-columns: 78px minmax(0, 1fr);
  gap: 8px;
  align-items: center;
  min-height: 33px;
  padding: 0 12px;
  background: var(--vrc-surface);
  border: 1px solid var(--vrc-border);
  border-radius: 7px;
}

.host-diagnostics-command-row span {
  color: var(--vrc-text-muted);
  font-size: 11px;
}

.host-diagnostics-command-row code {
  overflow: hidden;
  color: var(--vrc-text);
  font-family: "SFMono-Regular", Consolas, monospace;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.host-diagnostics-scope-note {
  margin: 0;
  color: var(--vrc-warning);
  font-size: 11px;
  line-height: 1.6;
}

.host-diagnostics-no-repair {
  padding: 10px;
  color: var(--vrc-text-muted);
  font-size: 12px;
  background: color-mix(in srgb, var(--vrc-success) 5%, var(--vrc-surface));
  border: 1px dashed color-mix(in srgb, var(--vrc-success) 34%, var(--vrc-border));
  border-radius: 7px;
}

/* ---------- 状态与风险配色 ---------- */
.is-ok {
  color: var(--vrc-success);
}

.is-warn {
  color: var(--vrc-warning);
}

.is-error {
  color: var(--vrc-danger);
}

.is-unknown {
  color: var(--vrc-text-subtle);
}

.is-risk-high {
  color: var(--vrc-danger);
}

.is-risk-medium {
  color: var(--vrc-warning);
}

.is-risk-low {
  color: var(--vrc-success);
}

/* ---------- 底部操作条 ---------- */
.host-diagnostics-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 54px;
  padding: 10px 14px;
  background: var(--vrc-surface-raised);
  border-top: 1px solid var(--vrc-border);
}

.host-diagnostics-footer > span {
  min-width: 0;
  color: var(--vrc-text-muted);
  font-size: 11px;
}

.host-diagnostics-footer-actions {
  display: flex;
  flex: 0 0 auto;
  gap: 8px;
}

.host-diagnostics-button {
  min-width: 76px;
  height: 32px;
  padding: 0 12px;
  color: var(--vrc-text);
  font-size: 12px;
  font-weight: 400;
  background: var(--vrc-surface);
  border: 1px solid var(--vrc-border);
  border-radius: 5px;
  cursor: pointer;
}

.host-diagnostics-button.primary {
  color: var(--vrc-logo-fg);
  background: var(--vrc-accent);
  border-color: var(--vrc-accent);
}

.host-diagnostics-button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.host-diagnostics-footer .is-armed {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--vrc-warning) 34%, transparent);
}

/* ---------- 动画 ---------- */
@keyframes host-diagnostics-report-flow {
  from { transform: translateX(-20%); }
  to { transform: translateX(540px); }
}

@keyframes host-diagnostics-report-step {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--vrc-accent) 14%, transparent); transform: scale(1); }
  50% { box-shadow: 0 0 0 5px color-mix(in srgb, var(--vrc-accent) 8%, transparent); transform: scale(1.08); }
}

@keyframes host-diagnostics-report-rise {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 0.96; transform: translateY(0); }
}

@keyframes host-diagnostics-report-dot {
  0%, 100% { transform: scale(1); box-shadow: 0 0 0 0 color-mix(in srgb, var(--vrc-accent) 10%, transparent); }
  50% { transform: scale(1.08); box-shadow: 0 0 0 5px color-mix(in srgb, var(--vrc-accent) 8%, transparent); }
}

@keyframes host-diagnostics-report-pulse {
  0%, 100% { transform: scale(1); opacity: 0.82; box-shadow: 0 0 0 0 color-mix(in srgb, var(--vrc-accent) 26%, transparent); }
  50% { transform: scale(1.12); opacity: 1; box-shadow: 0 0 0 6px color-mix(in srgb, var(--vrc-accent) 10%, transparent); }
}

@keyframes host-diagnostics-report-track {
  0%, 100% { opacity: 0.72; }
  50% { opacity: 1; }
}

/* ---------- 响应式对齐原型断点 ---------- */
@media (max-width: 1040px) {
  .host-diagnostics-context {
    grid-template-columns: 1fr;
  }

  .host-diagnostics-context dl {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .host-diagnostics-main {
    grid-template-columns: 1fr;
  }

  .host-diagnostics-report-activity {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 900px) {
  .host-diagnostics-report-activity {
    grid-template-columns: 1fr;
  }
}
</style>
