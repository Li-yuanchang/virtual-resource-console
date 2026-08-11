<script setup lang="ts">
import { Warning } from "@element-plus/icons-vue";
import { computed, ref, watch } from "vue";
import type { GuestBootEntryList, GuestBootEntrySelection, VmNode, VmSystemCredentials } from "../types";

/**
 * 关机 / 重启前的"选择下次启动内核"对话框。
 *
 * 读取虚拟机操作系统 GRUB 启动项列表，由用户选择下一次启动进入的内核；
 * 选择结果通过 confirm 事件交给上层，上层先设置一次性启动项再执行关机 / 重启。
 * 读取失败（如需要系统账号）时展示登录表单；没有可设置工具或未识别到
 * GRUB 时允许"不指定启动项，按系统默认启动"继续操作。
 */
const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    vm: VmNode | null;
    action?: "shutdown" | "forceReboot";
    loading?: boolean;
    bootEntries?: GuestBootEntryList | null;
    error?: string;
    authRequired?: boolean;
    saving?: boolean;
  }>(),
  {
    vm: null,
    action: "forceReboot",
    loading: false,
    bootEntries: null,
    error: "",
    authRequired: false,
    saving: false,
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  "load-boot-entries": [vm: VmNode, systemCredentials?: VmSystemCredentials, rememberSystemCredentials?: boolean];
  confirm: [selection: GuestBootEntrySelection | null, systemCredentials?: VmSystemCredentials, rememberSystemCredentials?: boolean];
}>();

const systemLogin = ref("root");
const systemPassword = ref("");
const useJumpServer = ref(false);
const jumpHost = ref("");
const jumpPort = ref(22);
const jumpLogin = ref("root");
const jumpPassword = ref("");
const rememberSystemCredentials = ref(false);
const selectedIndex = ref<number | null>(null);
const skipBootEntry = ref(false);

const entries = computed(() => props.bootEntries?.entries ?? []);
const canSetBootEntry = computed(() => {
  const list = props.bootEntries;
  return Boolean(
    list &&
      (list.grubKind === "grub1" || list.grubKind === "grub2") &&
      list.oneTimeTool !== "none" &&
      list.oneTimeTool !== "unknown" &&
      entries.value.length > 0,
  );
});
const selectedEntry = computed(() => entries.value.find((entry) => entry.index === selectedIndex.value) ?? null);
const loadingList = computed(() => props.loading && !props.bootEntries);
const dialogTitle = computed(() => (props.action === "shutdown" ? "关机并选择下次启动内核" : "重启并选择下次启动内核"));
const confirmText = computed(() => (props.action === "shutdown" ? "确认关机" : "确认重启"));
const canRetrySystemLogin = computed(
  () =>
    Boolean(systemLogin.value.trim() && systemPassword.value && !props.loading) &&
    (!useJumpServer.value ||
      (jumpHost.value.trim() && jumpPort.value > 0 && jumpLogin.value.trim() && jumpPassword.value)),
);
const canConfirm = computed(
  () =>
    !props.loading &&
    !props.saving &&
    Boolean(props.vm) &&
    (skipBootEntry.value || canSetBootEntry.value || !props.authRequired),
);

watch(
  () => props.modelValue,
  (visible) => {
    if (!visible) return;
    systemLogin.value = "root";
    systemPassword.value = "";
    useJumpServer.value = false;
    jumpHost.value = "";
    jumpPort.value = 22;
    jumpLogin.value = "root";
    jumpPassword.value = "";
    rememberSystemCredentials.value = false;
    selectedIndex.value = null;
    skipBootEntry.value = false;
  },
);

watch(
  () => props.bootEntries,
  (list) => {
    if (!list) {
      selectedIndex.value = null;
      return;
    }
    const fallback = list.entries.find((entry) => entry.isDefault) ?? list.entries[0];
    selectedIndex.value = fallback?.index ?? null;
    skipBootEntry.value = false;
  },
  { immediate: true },
);

function buildSystemCredentials(): VmSystemCredentials {
  return {
    username: systemLogin.value.trim(),
    password: systemPassword.value,
    ...(useJumpServer.value
      ? {
          jump: {
            host: jumpHost.value.trim(),
            port: jumpPort.value,
            username: jumpLogin.value.trim(),
            password: jumpPassword.value,
          },
        }
      : {}),
  };
}

function retrySystemLogin() {
  if (!canRetrySystemLogin.value || !props.vm) return;
  emit("load-boot-entries", props.vm, buildSystemCredentials(), rememberSystemCredentials.value);
}

function close() {
  if (props.saving) return;
  emit("update:modelValue", false);
}

function confirm() {
  if (!canConfirm.value || !props.vm) return;
  let selection: GuestBootEntrySelection | null = null;
  if (!skipBootEntry.value && canSetBootEntry.value && selectedEntry.value) {
    selection = {
      index: selectedEntry.value.index,
      title: selectedEntry.value.title,
      grubKind: props.bootEntries?.grubKind === "grub2" ? "grub2" : "grub1",
    };
  }
  const credentials = systemPassword.value ? buildSystemCredentials() : undefined;
  emit("confirm", selection, credentials, rememberSystemCredentials.value);
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    :title="dialogTitle"
    width="640px"
    class="vm-boot-entry-dialog"
    top="14vh"
    :close-on-click-modal="false"
    :show-close="!saving"
    @update:model-value="(value: boolean) => emit('update:modelValue', value)"
  >
    <div v-if="vm" class="vm-boot-entry-target">
      <strong class="vrc-copyable-text">{{ vm.name }}</strong>
      <small>{{ vm.providerId }}</small>
    </div>

    <div v-if="loadingList" class="vm-boot-entry-state" role="status">
      <span class="vm-boot-entry-loader"></span>
      <strong>正在读取启动项…</strong>
    </div>

    <div v-else-if="authRequired" class="vm-boot-entry-login">
      <div class="vm-boot-entry-login-copy">
        <el-icon aria-hidden="true"><Warning /></el-icon>
        <span>
          <strong>需要虚拟机系统账号</strong>
          <small>默认凭据无法登录，请提供系统账号密码；仅能通过跳板机访问时请同时填写 JumpServer 连接。</small>
        </span>
      </div>
      <div class="vm-boot-entry-login-fields">
        <el-input v-model="systemLogin" aria-label="系统登录账号" autocomplete="username" name="vrc-boot-system-login" placeholder="登录账号" />
        <el-input v-model="systemPassword" aria-label="系统登录密码" type="password" show-password autocomplete="current-password" name="vrc-boot-system-password" placeholder="登录密码" @keyup.enter="retrySystemLogin" />
        <el-button :loading="loading" :disabled="!canRetrySystemLogin" @click="retrySystemLogin">验证并读取</el-button>
        <el-checkbox v-model="rememberSystemCredentials" class="vm-boot-entry-login-remember">保存到本机（加密）</el-checkbox>
        <el-checkbox v-model="useJumpServer" class="vm-boot-entry-login-jump">通过 JumpServer 连接</el-checkbox>
      </div>
      <div v-if="useJumpServer" class="vm-boot-entry-jump-fields">
        <el-input v-model="jumpHost" aria-label="JumpServer 地址" name="vrc-boot-jump-host" placeholder="JumpServer Host" />
        <el-input-number v-model="jumpPort" aria-label="JumpServer 端口" :min="1" :max="65535" :controls="false" />
        <el-input v-model="jumpLogin" aria-label="JumpServer 登录账号" autocomplete="username" name="vrc-boot-jump-login" placeholder="Jump Login" />
        <el-input v-model="jumpPassword" aria-label="JumpServer 登录密码" type="password" show-password autocomplete="current-password" name="vrc-boot-jump-password" placeholder="Jump Password" @keyup.enter="retrySystemLogin" />
      </div>
    </div>

    <div v-else-if="bootEntries && entries.length" class="vm-boot-entry-list">
      <div class="vm-boot-entry-copy">
        <span><strong>选择下一次启动的内核</strong><small>本次{{ action === "shutdown" ? "关机后再次开机" : "重启" }}进入所选内核，之后恢复系统默认启动项。</small></span>
        <span class="vm-boot-entry-config">{{ bootEntries.config }}</span>
      </div>
      <div v-if="bootEntries.message" class="vm-boot-entry-message">
        <el-icon aria-hidden="true"><Warning /></el-icon>
        <span>{{ bootEntries.message }}</span>
      </div>
      <div v-if="bootEntries.oneTimeTool === 'none'" class="vm-boot-entry-message">
        <el-icon aria-hidden="true"><Warning /></el-icon>
        <span>缺少一次性启动工具（grub2-reboot / grub-reboot），无法指定内核；请勾选"不指定"后按系统默认启动。</span>
      </div>
      <div class="vm-boot-entry-radios" role="radiogroup" aria-label="选择下次启动内核">
        <button
          v-for="entry in entries"
          :key="entry.index"
          type="button"
          role="radio"
          :aria-checked="!skipBootEntry && selectedIndex === entry.index"
          :class="{ active: !skipBootEntry && selectedIndex === entry.index, disabled: skipBootEntry }"
          :disabled="skipBootEntry"
          @click="selectedIndex = entry.index"
        >
          <span class="vm-boot-entry-radio"></span>
          <span class="vm-boot-entry-entry-copy">
            <strong>{{ entry.title }}</strong>
            <small>启动项 #{{ entry.index }}<template v-if="entry.isDefault"> · 当前默认</template></small>
          </span>
          <em v-if="entry.isDefault">默认</em>
        </button>
      </div>
    </div>

    <div v-else-if="bootEntries" class="vm-boot-entry-state unavailable">
      <el-icon aria-hidden="true"><Warning /></el-icon>
      <div>
        <strong>无法读取可启动内核</strong>
        <small>{{ bootEntries.message || "未识别到 GRUB 启动项，将按系统默认启动。" }}</small>
      </div>
    </div>

    <div v-else-if="error" class="vm-boot-entry-state error" :title="error">
      <el-icon aria-hidden="true"><Warning /></el-icon>
      <div>
        <strong>读取启动项失败</strong>
        <small>{{ error }}</small>
      </div>
    </div>

    <label class="vm-boot-entry-skip" :class="{ active: skipBootEntry }">
      <input v-model="skipBootEntry" type="checkbox" :disabled="loading || saving" />
      <span>
        <strong>不指定启动项，按系统默认启动</strong>
        <small>不修改 GRUB 一次性启动项</small>
      </span>
    </label>

    <div v-if="saving" class="vm-boot-entry-saving" role="status">正在设置下次启动内核并{{ action === "shutdown" ? "关机" : "重启" }}…</div>
    <div v-if="error && !authRequired && !bootEntries" class="vm-boot-entry-error">{{ error }}</div>

    <template #footer>
      <div class="vm-boot-entry-footer">
        <span v-if="skipBootEntry" class="vm-boot-entry-footer-hint">按系统默认启动项启动</span>
        <span v-else-if="selectedEntry" class="vm-boot-entry-footer-hint">下次启动内核：{{ selectedEntry.title }}</span>
        <span v-else></span>
        <div>
          <el-button :disabled="saving" @click="close">取消</el-button>
          <el-button type="primary" :loading="saving" :disabled="!canConfirm" @click="confirm">{{ confirmText }}</el-button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.vm-boot-entry-target {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
  padding: 9px 12px;
  background: var(--vrc-surface);
  border: 1px solid var(--vrc-border);
  border-radius: 5px;
}
.vm-boot-entry-target strong { overflow: hidden; font-size: 13px; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
.vm-boot-entry-target small { color: var(--vrc-text-muted); font-size: 12px; }
.vm-boot-entry-state { display: flex; align-items: center; justify-content: center; gap: 7px; min-height: 62px; color: var(--vrc-text-muted); font-size: 13px; background: var(--vrc-surface); border: 1px solid var(--vrc-border); border-radius: 5px; }
.vm-boot-entry-state strong { font-weight: 400; }
.vm-boot-entry-state.unavailable { color: var(--vrc-warning); }
.vm-boot-entry-state.error { color: var(--vrc-danger); }
.vm-boot-entry-state > div { display: grid; gap: 2px; }
.vm-boot-entry-state small { color: var(--vrc-text-muted); font-size: 12px; line-height: 17px; }
.vm-boot-entry-loader { width: 14px; height: 14px; border: 2px solid var(--vrc-border-strong); border-top-color: var(--vrc-accent); border-radius: 50%; animation: vm-boot-entry-spin 0.8s linear infinite; }
.vm-boot-entry-login { display: grid; gap: 8px; padding: 9px; background: var(--vrc-surface); border: 1px solid var(--vrc-border); border-radius: 5px; }
.vm-boot-entry-login-copy { display: flex; align-items: center; gap: 7px; color: var(--vrc-warning); }
.vm-boot-entry-login-copy > span { display: grid; gap: 2px; }
.vm-boot-entry-login-copy strong { color: var(--vrc-text); font-size: 13px; font-weight: 400; line-height: 19px; }
.vm-boot-entry-login-copy small { color: var(--vrc-text-muted); font-size: 12px; font-weight: 400; line-height: 17px; }
.vm-boot-entry-login-fields { display: grid; grid-template-columns: minmax(120px, 0.8fr) minmax(180px, 1.2fr) 104px; gap: 8px; }
.vm-boot-entry-login-fields :deep(.el-input), .vm-boot-entry-login-fields :deep(.el-button) { height: var(--vrc-command-height); min-height: var(--vrc-command-height); }
.vm-boot-entry-login-fields :deep(.el-input__wrapper) { height: var(--vrc-command-height); min-height: var(--vrc-command-height); padding: 0 8px; background: var(--vrc-surface); border: 1px solid var(--vrc-border); border-radius: var(--vrc-command-radius); box-shadow: none; }
.vm-boot-entry-login-fields :deep(.el-input__wrapper:hover) { border-color: var(--vrc-border-strong); background: var(--vrc-surface); box-shadow: none; }
.vm-boot-entry-login-fields :deep(.el-input__wrapper.is-focus) { border-color: var(--vrc-border-strong); background: var(--vrc-surface); box-shadow: none; }
.vm-boot-entry-login-fields :deep(.el-input__inner) { height: calc(var(--vrc-command-height) - 2px); color: var(--vrc-text); font-size: var(--vrc-font-size-body); font-weight: var(--vrc-font-weight-regular); line-height: calc(var(--vrc-command-height) - 2px); }
.vm-boot-entry-login-fields :deep(.el-input__inner::placeholder) { color: var(--vrc-text-subtle); font-size: var(--vrc-font-size-label); opacity: 1; }
.vm-boot-entry-login-fields :deep(.el-button) { padding: 0 10px; color: var(--vrc-text-muted); font-size: var(--vrc-font-size-body); font-weight: var(--vrc-font-weight-regular); background: var(--vrc-surface); border-color: var(--vrc-border); border-radius: var(--vrc-command-radius); }
.vm-boot-entry-login-fields :deep(.el-button:hover:not(.is-disabled)) { color: var(--vrc-accent); background: var(--vrc-accent-soft); border-color: var(--vrc-border-strong); }
.vm-boot-entry-login-fields :deep(.el-button:focus-visible) { color: var(--vrc-accent); border-color: var(--vrc-accent); box-shadow: var(--vrc-focus-ring); }
.vm-boot-entry-login-remember, .vm-boot-entry-login-jump { width: max-content; height: 18px; margin: 0; }
.vm-boot-entry-login-remember { grid-column: 1 / 2; }
.vm-boot-entry-login-jump { grid-column: 2 / -1; }
.vm-boot-entry-login-remember :deep(.el-checkbox__label), .vm-boot-entry-login-jump :deep(.el-checkbox__label) { padding-left: 6px; color: var(--vrc-text-muted); font-size: 13px; font-weight: 400; line-height: 18px; }
.vm-boot-entry-jump-fields { display: grid; grid-template-columns: minmax(150px, 1.2fr) 84px minmax(130px, 0.9fr) minmax(180px, 1.2fr); gap: 8px; padding-top: 8px; border-top: 1px solid var(--vrc-border); }
.vm-boot-entry-jump-fields :deep(.el-input), .vm-boot-entry-jump-fields :deep(.el-input-number) { width: 100%; height: var(--vrc-command-height); }
.vm-boot-entry-jump-fields :deep(.el-input__wrapper), .vm-boot-entry-jump-fields :deep(.el-input-number .el-input__wrapper) { height: var(--vrc-command-height); min-height: var(--vrc-command-height); padding: 0 8px; background: var(--vrc-surface); border: 1px solid var(--vrc-border); border-radius: var(--vrc-command-radius); box-shadow: none; }
.vm-boot-entry-jump-fields :deep(.el-input__wrapper:hover) { border-color: var(--vrc-border-strong); }
.vm-boot-entry-jump-fields :deep(.el-input__wrapper.is-focus) { border-color: var(--vrc-accent); }
.vm-boot-entry-list { display: grid; gap: 8px; }
.vm-boot-entry-copy { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.vm-boot-entry-copy > span { display: grid; gap: 2px; }
.vm-boot-entry-copy strong { font-size: 14px; font-weight: 500; }
.vm-boot-entry-copy small { color: var(--vrc-text-muted); font-size: 12px; line-height: 17px; }
.vm-boot-entry-config { color: var(--vrc-text-muted); font-family: var(--vrc-font-mono); font-size: 12px; white-space: nowrap; user-select: all; }
.vm-boot-entry-message { display: flex; align-items: flex-start; gap: 6px; padding: 7px 9px; color: var(--vrc-warning); font-size: 12px; line-height: 17px; background: var(--vrc-status-warning-soft); border: 1px solid var(--vrc-border); border-radius: 5px; }
.vm-boot-entry-message .el-icon { margin-top: 2px; }
.vm-boot-entry-radios { display: grid; gap: 6px; max-height: 300px; overflow-y: auto; padding: 2px; }
.vm-boot-entry-radios > button { display: flex; align-items: center; gap: 9px; width: 100%; padding: 8px 10px; text-align: left; background: var(--vrc-surface); border: 1px solid var(--vrc-border); border-radius: 5px; cursor: pointer; }
.vm-boot-entry-radios > button:hover:not(.disabled) { border-color: var(--vrc-border-strong); background: var(--vrc-surface-raised); }
.vm-boot-entry-radios > button.active { border-color: var(--vrc-accent); background: var(--vrc-accent-soft); box-shadow: var(--vrc-focus-ring); }
.vm-boot-entry-radios > button.disabled { cursor: not-allowed; opacity: 0.55; }
.vm-boot-entry-radio { position: relative; flex: 0 0 auto; width: 14px; height: 14px; border: 1px solid var(--vrc-border-strong); border-radius: 50%; background: var(--vrc-surface); }
.vm-boot-entry-radios > button.active .vm-boot-entry-radio { border-color: var(--vrc-accent); }
.vm-boot-entry-radios > button.active .vm-boot-entry-radio::after { position: absolute; inset: 3px; background: var(--vrc-accent); border-radius: 50%; content: ""; }
.vm-boot-entry-entry-copy { display: grid; gap: 1px; min-width: 0; flex: 1; }
.vm-boot-entry-entry-copy strong { overflow: hidden; font-size: 13px; font-weight: 400; text-overflow: ellipsis; white-space: nowrap; }
.vm-boot-entry-entry-copy small { color: var(--vrc-text-muted); font-size: 12px; }
.vm-boot-entry-radios > button em { flex: 0 0 auto; padding: 1px 6px; color: var(--vrc-accent); font-size: 11px; font-style: normal; background: var(--vrc-accent-soft); border: 1px solid var(--vrc-border-strong); border-radius: 4px; }
.vm-boot-entry-skip { display: flex; align-items: flex-start; gap: 9px; margin-top: 12px; padding: 9px 11px; background: var(--vrc-surface); border: 1px solid var(--vrc-border); border-radius: 5px; cursor: pointer; }
.vm-boot-entry-skip.active { border-color: var(--vrc-border-strong); background: var(--vrc-surface-raised); }
.vm-boot-entry-skip input { margin-top: 2px; accent-color: var(--vrc-accent); }
.vm-boot-entry-skip > span { display: grid; gap: 1px; }
.vm-boot-entry-skip strong { font-size: 13px; font-weight: 400; }
.vm-boot-entry-skip small { color: var(--vrc-text-muted); font-size: 12px; }
.vm-boot-entry-saving { margin-top: 10px; color: var(--vrc-text-muted); font-size: 13px; }
.vm-boot-entry-error { margin-top: 10px; color: var(--vrc-danger); font-size: 12px; line-height: 18px; }
.vm-boot-entry-footer { display: flex; align-items: center; justify-content: space-between; gap: 16px; text-align: left; }
.vm-boot-entry-footer > div { display: flex; align-items: center; gap: 8px; }
.vm-boot-entry-footer-hint { flex: 1 1 auto; min-width: 0; overflow: hidden; color: var(--vrc-text-muted); font-size: 12px; text-align: left; text-overflow: ellipsis; white-space: nowrap; }
.vm-boot-entry-footer :deep(.el-button) { min-width: 92px; height: var(--vrc-command-height); margin: 0; border-radius: var(--vrc-command-radius); }
@media (max-width: 760px) {
  .vm-boot-entry-login-fields, .vm-boot-entry-jump-fields { grid-template-columns: 1fr; }
  .vm-boot-entry-login-remember, .vm-boot-entry-login-jump { grid-column: 1; }
}
@keyframes vm-boot-entry-spin { to { transform: rotate(360deg); } }
</style>
