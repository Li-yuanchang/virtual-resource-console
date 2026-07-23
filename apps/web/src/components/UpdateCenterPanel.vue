<script setup lang="ts">
import { WarningFilled } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { computed, defineComponent, h, onBeforeUnmount, onMounted, ref } from "vue";

const props = defineProps<{ runtimeMode: "web" | "electron" | "chrome-native" }>();

const fallbackState: VrcDesktopUpdateState = {
  stage: "idle",
  currentVersion: "-",
  availableVersion: "",
  progress: 0,
  transferred: 0,
  total: 0,
  releaseNotes: "",
  message: "尚未检查更新",
  checkedAt: "",
  supported: false,
  distribution: "unsupported",
  platform: "",
};

const state = ref<VrcDesktopUpdateState>({ ...fallbackState });
const pendingAction = ref<"" | "check" | "download" | "install">("");
const autoCheck = ref(localStorage.getItem("vrc.update.auto-check") !== "false");
let removeStateListener: (() => void) | undefined;

const UpdatePlatformIcon = defineComponent({
  props: { platform: { type: String, required: true } },
  setup(iconProps) {
    return () => {
      const common = { viewBox: "0 0 24 24", "aria-hidden": "true" };
      if (iconProps.platform === "windows") {
        return h("svg", common, [h("path", { d: "M3.5 5.2 11 4.1v7.1H3.5V5.2Zm8.8-1.3 8.2-1.2v8.5h-8.2V3.9ZM3.5 12.6H11v7.2l-7.5-1.1v-6.1Zm8.8 0h8.2v8.6L12.3 20v-7.4Z" })]);
      }
      if (iconProps.platform === "web") {
        return h("svg", common, [h("path", { d: "M5 3h14a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm0 10h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2Z" })]);
      }
      if (iconProps.platform === "chrome") {
        return h("svg", common, [
          h("path", { "fill-rule": "evenodd", d: "M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20Zm0 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z" }),
          h("path", { d: "M11 3h2v7h-2zM4.2 16l1-1.7 6.1 3.5-1 1.7zM18.8 16l-6.1 3.5-1-1.7 6.1-3.5z" }),
        ]);
      }
      return h("svg", common, [h("path", { d: "M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 8.78 7.3c1.28-.07 2.44.72 3.2.72.75 0 2.14-.97 3.6-.83.61.03 2.33.24 3.43 1.86-3.12 1.87-2.63 5.99.54 7.26-.64 1.68-1.48 3.35-2.5 3.97ZM12.03 7.25C11.88 4.75 13.9 2.68 16.24 2.5c.32 2.89-2.62 5.04-4.21 4.75Z" })]);
    };
  },
});

const desktopApi = computed(() => window.vrcDesktopUpdate);
const isDesktop = computed(() => !!desktopApi.value);
const platformName = computed(() => {
  if (state.value.platform === "darwin") return "macOS 客户端";
  if (state.value.platform === "win32") return "Windows 客户端";
  if (props.runtimeMode === "chrome-native") return "Chrome 插件";
  return "2.26 Web 服务";
});
const platformClass = computed(() => {
  if (state.value.platform === "win32") return "windows";
  if (props.runtimeMode === "chrome-native") return "chrome";
  if (!isDesktop.value) return "web";
  return "mac";
});
const stageText = computed(() => {
  if (!isDesktop.value) return props.runtimeMode === "chrome-native" ? "浏览器管理" : "服务端管理";
  if (!state.value.supported) {
    return state.value.distribution === "portable" ? "免安装版" : "当前运行端不可用";
  }
  if (state.value.stage === "checking") return "正在检查";
  if (state.value.stage === "unavailable") return "未检测到更新";
  if (state.value.stage === "up-to-date") return "已是最新版本";
  if (state.value.stage === "available") return "可更新";
  if (state.value.stage === "downloading") return `正在下载 · ${Math.round(state.value.progress)}%`;
  if (state.value.stage === "ready") return "待重启";
  if (state.value.stage === "error") return "检查失败";
  return "尚未检查";
});
const description = computed(() => {
  if (!isDesktop.value) {
    return props.runtimeMode === "chrome-native"
      ? "Chrome 负责扩展的下载和安装，重新打开插件后使用新版本。"
      : "Web 资源由 2.26 服务更新，发布完成后刷新浏览器即可生效。";
  }
  if (state.value.stage === "downloading") return `正在下载更新 · ${Math.round(state.value.progress)}%`;
  return state.value.message || "检查客户端是否有新版本。";
});
const showAvailableVersion = computed(
  () =>
    ["available", "downloading", "ready"].includes(state.value.stage) &&
    Boolean(state.value.availableVersion) &&
    state.value.availableVersion !== state.value.currentVersion,
);
const releaseNotesVersion = computed(() => (showAvailableVersion.value ? state.value.availableVersion : state.value.currentVersion));
const canCheck = computed(() => isDesktop.value && state.value.supported && state.value.stage !== "checking" && state.value.stage !== "downloading");
const actionLabel = computed(() => {
  if (state.value.stage === "available") return "下载更新";
  if (state.value.stage === "downloading") return "下载中";
  if (state.value.stage === "ready") return "重启更新";
  if (state.value.stage === "error") return "重新检查";
  return "检查更新";
});
const actionDisabled = computed(() => {
  if (!isDesktop.value || !state.value.supported || pendingAction.value) return true;
  return state.value.stage === "checking" || state.value.stage === "downloading";
});

onMounted(async () => {
  if (!desktopApi.value) return;
  removeStateListener = desktopApi.value.onState((nextState) => {
    state.value = nextState;
  });
  try {
    state.value = await desktopApi.value.getState();
    if (autoCheck.value && state.value.supported && !state.value.checkedAt && state.value.stage === "idle") {
      await checkForUpdates();
    }
  } catch {
    state.value = { ...state.value, stage: "unavailable", message: "暂未检测到可用更新", checkedAt: new Date().toISOString() };
  }
});

onBeforeUnmount(() => removeStateListener?.());

function persistAutoCheck(value: string | number | boolean) {
  autoCheck.value = Boolean(value);
  localStorage.setItem("vrc.update.auto-check", String(autoCheck.value));
}

async function checkForUpdates() {
  if (!desktopApi.value || !canCheck.value || pendingAction.value) return;
  pendingAction.value = "check";
  try {
    state.value = await desktopApi.value.check();
  } catch {
    state.value = { ...state.value, stage: "unavailable", message: "暂未检测到可用更新", checkedAt: new Date().toISOString() };
  } finally {
    pendingAction.value = "";
  }
}

async function runPrimaryAction() {
  if (!desktopApi.value || actionDisabled.value) return;
  if (state.value.stage === "available") {
    pendingAction.value = "download";
    try {
      state.value = await desktopApi.value.download();
    } catch (error) {
      ElMessage.error(readableError(error));
    } finally {
      pendingAction.value = "";
    }
    return;
  }
  if (state.value.stage === "ready") {
    pendingAction.value = "install";
    try {
      await desktopApi.value.install();
    } catch (error) {
      pendingAction.value = "";
      ElMessage.error(readableError(error));
    }
    return;
  }
  await checkForUpdates();
}

function readableError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  if (/404|ENOENT|latest.*ya?ml/i.test(message)) return "更新源暂未发布当前平台版本";
  if (/network|ECONN|ENOTFOUND|ETIMEDOUT|fetch/i.test(message)) return "无法连接更新服务，请检查网络后重试";
  if (/signature|code sign|sha512|checksum/i.test(message)) return "更新包校验失败，已停止安装";
  return "更新操作失败，请稍后重试";
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatCheckedAt(value: string) {
  if (!value) return "尚未检查";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "尚未检查";
  return date.toLocaleString("zh-CN", { hour12: false });
}
</script>

<template>
  <section class="settings-card update-center-card">
    <div class="settings-card-head update-center-head">
      <div>
        <strong>客户端更新</strong>
        <span>检查当前运行端版本，下载完成后由对应平台安全应用更新。</span>
      </div>
      <div class="update-head-actions">
        <label class="update-auto-check">
          <span>自动检查</span>
          <el-switch v-model="autoCheck" :disabled="isDesktop && !state.supported" aria-label="自动检查更新" @change="persistAutoCheck" />
        </label>
      </div>
    </div>

    <div class="update-runtime-row">
      <span class="update-platform-icon" :class="platformClass">
        <UpdatePlatformIcon :platform="platformClass" />
      </span>
      <div class="update-runtime-main">
        <div class="update-runtime-title">
          <strong>{{ platformName }}</strong>
          <span v-if="isDesktop">{{ state.currentVersion }}<template v-if="showAvailableVersion"> → {{ state.availableVersion }}</template></span>
        </div>
        <p>{{ description }}</p>
        <template v-if="state.stage === 'downloading'">
          <el-progress :percentage="state.progress" :show-text="false" :stroke-width="5" />
          <small>{{ formatBytes(state.transferred) }} / {{ formatBytes(state.total) }}</small>
        </template>
      </div>
      <div class="update-runtime-actions">
        <span v-if="state.stage !== 'downloading'" class="update-stage" :class="state.stage">{{ stageText }}</span>
        <button v-if="isDesktop && state.supported && state.stage !== 'downloading'" type="button" class="update-command" :class="{ primary: state.stage === 'ready' }" :disabled="actionDisabled" @click="runPrimaryAction">{{ actionLabel }}</button>
      </div>
    </div>

    <div v-if="state.stage === 'error'" class="update-error-row">
      <el-icon><WarningFilled /></el-icon>
      <span>{{ state.message }}</span>
    </div>

    <div v-if="state.releaseNotes" class="update-release-notes">
      <div><strong>版本说明</strong><span>{{ releaseNotesVersion }}</span></div>
      <p>{{ state.releaseNotes }}</p>
    </div>

    <div class="update-meta-row"><span>上次检查</span><strong>{{ formatCheckedAt(state.checkedAt) }}</strong></div>
  </section>
</template>

<style scoped>
.update-center-card{padding:12px}.update-center-head{padding:0 0 10px}.update-head-actions,.update-auto-check{display:flex;align-items:center}.update-head-actions{gap:8px}.update-auto-check{gap:7px;color:var(--vrc-text-muted);font-size:11px}.update-auto-check :deep(.el-switch){--el-switch-on-color:var(--vrc-accent);--el-switch-off-color:var(--vrc-border-strong);flex:0 0 34px;width:34px;height:20px}.update-auto-check :deep(.el-switch__core){width:34px;min-width:34px;height:20px;border:0}.update-auto-check :deep(.el-switch__action){width:16px;height:16px}.update-runtime-row{display:grid;grid-template-columns:32px minmax(0,1fr) auto;align-items:center;gap:10px;min-height:64px;padding:8px 12px;border:1px solid var(--vrc-border);border-radius:7px}.update-platform-icon{display:grid;width:28px;height:28px;place-items:center;color:var(--vrc-accent);background:var(--vrc-accent-soft);border-radius:6px}.update-platform-icon.windows{color:#386899;background:#edf3f9}.update-platform-icon.web{color:var(--vrc-info);background:color-mix(in srgb,var(--vrc-info) 10%,var(--vrc-surface))}.update-platform-icon.chrome{color:#9b6c31;background:#f6f1e7}.update-platform-icon :deep(svg){width:17px;height:17px;fill:currentColor;stroke:none}.update-runtime-main{display:grid;gap:3px;min-width:0}.update-runtime-title{display:flex;align-items:center;gap:7px;flex-wrap:wrap}.update-runtime-title strong{font-size:12px;font-weight:400}.update-runtime-title span{color:var(--vrc-text-muted);font-size:11px}.update-runtime-main p,.update-runtime-main small{margin:0;color:var(--vrc-text-muted);font-size:11px;line-height:16px}.update-runtime-main :deep(.el-progress-bar__outer){background:color-mix(in srgb,var(--vrc-border) 70%,transparent)}.update-runtime-main :deep(.el-progress-bar__inner){background:linear-gradient(90deg,var(--vrc-accent),color-mix(in srgb,var(--vrc-accent) 72%,var(--vrc-success)))}.update-runtime-actions{display:flex;align-items:center;gap:10px}.update-stage{color:var(--vrc-text-muted);font-size:11px;white-space:nowrap}.update-stage.available,.update-stage.downloading{color:var(--vrc-accent)}.update-stage.ready,.update-stage.up-to-date{color:var(--vrc-success)}.update-stage.error{color:var(--vrc-danger)}.update-command{height:28px;min-width:72px;padding:0 10px;color:var(--vrc-text);font:inherit;font-size:12px;font-weight:400;background:var(--vrc-surface);border:1px solid var(--vrc-border);border-radius:6px}.update-command.primary{color:var(--vrc-logo-fg);background:var(--vrc-accent);border-color:var(--vrc-accent)}.update-command:disabled{cursor:not-allowed;opacity:.55}.update-error-row{display:flex;align-items:center;gap:7px;margin-top:10px;padding:9px 10px;color:var(--vrc-danger);font-size:11px;background:color-mix(in srgb,var(--vrc-danger) 6%,var(--vrc-surface));border:1px solid color-mix(in srgb,var(--vrc-danger) 22%,var(--vrc-border));border-radius:7px}.update-release-notes{display:grid;gap:5px;margin-top:10px;padding:10px 12px;background:var(--vrc-surface-muted);border-radius:7px}.update-release-notes>div{display:flex;align-items:center;gap:7px}.update-release-notes strong{font-size:12px;font-weight:400}.update-release-notes span,.update-release-notes p{color:var(--vrc-text-muted);font-size:11px}.update-release-notes p{margin:0;line-height:17px;white-space:pre-line}.update-meta-row{display:flex;align-items:center;justify-content:space-between;margin-top:10px;color:var(--vrc-text-muted);font-size:11px}.update-meta-row strong{font-weight:400}
@media(max-width:680px){.update-center-head,.update-runtime-row{align-items:flex-start}.update-runtime-row{grid-template-columns:32px minmax(0,1fr)}.update-runtime-actions{grid-column:2;flex-wrap:wrap}.update-head-actions{align-self:flex-end}}
</style>
