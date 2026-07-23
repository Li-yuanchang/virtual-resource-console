<script setup lang="ts">
import { Check, Download, Monitor, Setting, WarningFilled } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { computed, defineComponent, h, onBeforeUnmount, reactive, ref } from "vue";
import VrcLogoMark from "../components/VrcLogoMark.vue";

type Variant = "a" | "b" | "c" | "d";
type TargetKey = "mac" | "windows" | "web" | "chrome";
type Stage = "available" | "downloading" | "ready" | "updated";

interface Target {
  key: TargetKey;
  name: string;
  version: string;
  current: string;
  mode: string;
  description: string;
}

const variants = [
  { value: "a" as Variant, label: "A", name: "平台状态" },
  { value: "b" as Variant, label: "B", name: "更新列表" },
  { value: "c" as Variant, label: "C", name: "批量更新" },
  { value: "d" as Variant, label: "D", name: "更新过程" },
];

const targets: Target[] = [
  { key: "mac", name: "macOS 客户端", version: "0.1.38", current: "0.1.37", mode: "下载后重启", description: "适用于 Apple 芯片和 Intel Mac" },
  { key: "windows", name: "Windows 客户端", version: "0.1.38", current: "0.1.37", mode: "下载后重启", description: "适用于 Windows 桌面客户端" },
  { key: "web", name: "2.26 Web 服务", version: "0.1.38", current: "0.1.37", mode: "更新后刷新", description: "更新完成后刷新浏览器即可生效" },
  { key: "chrome", name: "Chrome 插件", version: "0.1.8", current: "0.1.7", mode: "浏览器管理", description: "由 Chrome 自动完成安装和启用" },
];

const variant = ref<Variant>("a");
const checking = ref(false);
const autoCheck = ref(true);
const selected = ref<TargetKey[]>(["mac", "windows", "web"]);
const stages = reactive<Record<TargetKey, Stage>>({ mac: "available", windows: "available", web: "available", chrome: "available" });
const progress = reactive<Record<TargetKey, number>>({ mac: 0, windows: 0, web: 0, chrome: 0 });
const timers = new Map<TargetKey, number>();

const activeTargets = computed(() => targets.filter((target) => selected.value.includes(target.key)));
const batchProgress = computed(() => activeTargets.value.length
  ? Math.round(activeTargets.value.reduce((total, target) => total + progress[target.key], 0) / activeTargets.value.length)
  : 0);

function checkForUpdates() {
  if (checking.value) return;
  checking.value = true;
  window.setTimeout(() => {
    checking.value = false;
    ElMessage.success("已完成检查，发现 1 个新版本");
  }, 650);
}

function startUpdate(target: Target) {
  if (target.key === "chrome") {
    ElMessage.info("Chrome 插件由浏览器负责安装更新");
    return;
  }
  if (stages[target.key] === "downloading" || stages[target.key] === "updated") return;
  if (stages[target.key] === "ready") {
    stages[target.key] = "updated";
    progress[target.key] = 100;
    ElMessage.success(target.key === "web" ? "Web 服务已更新，请刷新页面" : `${target.name}将在重启后完成更新`);
    return;
  }
  stages[target.key] = "downloading";
  progress[target.key] = 8;
  const timer = window.setInterval(() => {
    progress[target.key] = Math.min(100, progress[target.key] + 16);
    if (progress[target.key] === 100) {
      window.clearInterval(timer);
      timers.delete(target.key);
      stages[target.key] = "ready";
      ElMessage.success(`${target.name}更新包已准备就绪`);
    }
  }, 220);
  timers.set(target.key, timer);
}

function startBatch() {
  const batch = activeTargets.value.filter((target) => target.key !== "chrome");
  if (!batch.length) {
    ElMessage.warning("请选择至少一个可更新的平台");
    return;
  }
  batch.forEach(startUpdate);
}

function toggleTarget(key: TargetKey) {
  selected.value = selected.value.includes(key)
    ? selected.value.filter((item) => item !== key)
    : [...selected.value, key];
}

function stageText(target: Target) {
  if (target.key === "chrome") return "浏览器管理";
  if (stages[target.key] === "downloading") return `下载中 ${progress[target.key]}%`;
  if (stages[target.key] === "ready") return target.key === "web" ? "待刷新" : "待重启";
  if (stages[target.key] === "updated") return "已更新";
  return "可更新";
}

const PlatformIcon = defineComponent({
  props: { platform: { type: String, required: true } },
  setup(props) {
    return () => {
      const common = { viewBox: "0 0 24 24", "aria-hidden": "true" };
      if (props.platform === "windows") return h("svg", common, [h("path", { d: "M3.5 5.2 11 4.1v7.1H3.5V5.2Zm8.8-1.3 8.2-1.2v8.5h-8.2V3.9ZM3.5 12.6H11v7.2l-7.5-1.1v-6.1Zm8.8 0h8.2v8.6L12.3 20v-7.4Z" })]);
      if (props.platform === "web") return h("svg", common, [h("path", { d: "M5 3h14a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm0 10h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2Z" })]);
      if (props.platform === "chrome") return h("svg", common, [h("path", { "fill-rule": "evenodd", d: "M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20Zm0 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z" }), h("path", { d: "M11 3h2v7h-2zM4.2 16l1-1.7 6.1 3.5-1 1.7zM18.8 16l-6.1 3.5-1-1.7 6.1-3.5z" })]);
      return h("svg", common, [h("path", { "fill-rule": "evenodd", d: "M5 3h14a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3h-5v1.5h4V22H6v-2.5h4V18H5a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Zm7 5.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z" })]);
    };
  },
});

onBeforeUnmount(() => timers.forEach((timer) => window.clearInterval(timer)));
</script>

<template>
  <main class="update-prototype app-shell">
    <aside class="prototype-sidebar">
      <div class="brand-lockup"><VrcLogoMark /><span><strong>资源控制台</strong><small>设置中心</small></span></div>
      <div class="sidebar-current"><small>当前版本</small><strong>VRC 0.1.37</strong><span>稳定版</span></div>
      <nav class="prototype-nav" aria-label="设置导航">
        <button type="button"><el-icon><Setting /></el-icon><span>常规设置</span></button>
        <button class="active" type="button"><el-icon><Download /></el-icon><span>更新中心</span></button>
        <button type="button"><el-icon><Monitor /></el-icon><span>运行端</span></button>
      </nav>
      <span class="service-state"><i></i>更新服务正常</span>
    </aside>

    <section class="prototype-content vrc-scroll-container">
      <header class="page-head">
        <div><h1>更新中心</h1><p>检查运行端版本，了解更新状态。</p></div>
        <div class="head-actions"><span>上次检查：刚刚</span><button class="text-button" type="button" :disabled="checking" @click="checkForUpdates">{{ checking ? "检查中" : "检查更新" }}</button></div>
      </header>

      <div class="prototype-switch" aria-label="原型方案">
        <button v-for="item in variants" :key="item.value" type="button" :class="{ active: variant === item.value }" @click="variant = item.value"><span>{{ item.label }}</span>{{ item.name }}</button>
      </div>

      <section class="notice-group">
        <div class="notice-copy"><el-icon><Download /></el-icon><div><strong>发现 VRC 0.1.38 更新</strong><span>包含连接恢复、资源列表刷新和安装流程稳定性修复。</span></div></div>
        <button class="link-button" type="button" @click="ElMessage.info('打开版本说明')">查看版本说明</button>
      </section>

      <section v-if="variant === 'a'" class="business-group">
        <div class="group-head"><div><h2>平台状态</h2><span>不同运行端使用相应的更新方式。</span></div><label class="switch-line"><span>自动检查</span><button class="switch" :class="{ active: autoCheck }" type="button" :aria-pressed="autoCheck" @click="autoCheck = !autoCheck"><i></i></button></label></div>
        <div class="platform-list">
          <article v-for="target in targets" :key="target.key" class="platform-row">
            <span class="platform-icon" :class="target.key"><PlatformIcon :platform="target.key" /></span>
            <div class="platform-info"><div class="platform-title"><strong>{{ target.name }}</strong><span>{{ target.current }} → {{ target.version }}</span></div><p>{{ target.description }}</p></div>
            <div class="platform-action"><span class="stage" :class="stages[target.key]">{{ stageText(target) }}</span><button class="text-button" type="button" :disabled="stages[target.key] === 'downloading' || stages[target.key] === 'updated'" @click="startUpdate(target)">{{ target.key === 'chrome' ? '查看方式' : stages[target.key] === 'ready' ? (target.key === 'web' ? '刷新应用' : '重启更新') : stages[target.key] === 'downloading' ? '下载中' : '下载更新' }}</button></div>
            <el-progress v-if="stages[target.key] === 'downloading'" class="row-progress" :percentage="progress[target.key]" :show-text="false" :stroke-width="5" />
          </article>
        </div>
      </section>

      <section v-else-if="variant === 'b'" class="business-group list-variant">
        <div class="group-head"><div><h2>更新列表</h2><span>查看各运行端的当前版本和更新状态。</span></div><span class="count-text">{{ targets.length }} 个运行端</span></div>
        <div class="update-table">
          <div class="table-row table-head"><span>运行端</span><span>当前版本</span><span>最新版本</span><span>更新方式</span><span>状态</span><span>操作</span></div>
          <div v-for="target in targets" :key="target.key" class="table-row"><span class="table-platform"><PlatformIcon :platform="target.key" :class="target.key" /><strong>{{ target.name }}</strong></span><span>{{ target.current }}</span><span>{{ target.version }}</span><span>{{ target.mode }}</span><span class="stage" :class="stages[target.key]">{{ stageText(target) }}</span><button class="row-button" type="button" @click="startUpdate(target)">{{ target.key === 'chrome' ? '查看方式' : '更新' }}</button></div>
        </div>
      </section>

      <section v-else-if="variant === 'c'" class="business-group batch-variant">
        <div class="group-head"><div><h2>批量更新</h2><span>选择运行端后统一下载更新。</span></div><button class="primary-button" type="button" @click="startBatch"><el-icon><Download /></el-icon>开始更新</button></div>
        <div class="batch-layout"><div class="target-picker"><button v-for="target in targets" :key="target.key" type="button" :class="{ selected: selected.includes(target.key) }" @click="toggleTarget(target.key)"><i><el-icon v-if="selected.includes(target.key)"><Check /></el-icon></i><span><strong>{{ target.name }}</strong><small>{{ target.version }} · {{ target.mode }}</small></span><em class="stage" :class="stages[target.key]">{{ stageText(target) }}</em></button></div><div class="batch-summary"><div><span>整体进度</span><strong>{{ batchProgress }}%</strong></div><el-progress :percentage="batchProgress" :show-text="false" :stroke-width="5" /><ol><li class="done"><i><el-icon><Check /></el-icon></i><span>检查更新<small>已完成</small></span></li><li :class="{ active: batchProgress > 0 && batchProgress < 100, done: batchProgress === 100 }"><i>2</i><span>下载更新<small>按所选运行端执行</small></span></li><li :class="{ active: batchProgress === 100 }"><i>3</i><span>应用更新<small>桌面端重启，Web 端刷新</small></span></li></ol></div></div>
      </section>

      <section v-else class="business-group process-variant">
        <div class="group-head"><div><h2>更新过程</h2><span>下载、应用和等待重启状态保持在同一位置。</span></div><span class="count-text">3 个更新任务</span></div>
        <div class="process-list">
          <article class="process-row">
            <span class="platform-icon mac"><PlatformIcon platform="mac" /></span>
            <div class="process-main"><div><strong>macOS 客户端</strong><span>正在下载 · 68%</span></div><el-progress :percentage="68" :show-text="false" :stroke-width="5" /><small>42.6 MB / 62.7 MB</small></div>
            <button class="text-button" type="button" @click="ElMessage.info('已暂停下载')">暂停</button>
          </article>
          <article class="process-row">
            <span class="platform-icon web"><PlatformIcon platform="web" /></span>
            <div class="process-main"><div><strong>2.26 Web 服务</strong><span class="is-applying">正在应用更新</span></div><div class="indeterminate-progress"><i></i></div><small>正在切换资源，请保持页面打开</small></div>
            <button class="text-button" type="button" disabled>更新中</button>
          </article>
          <article class="process-row">
            <span class="platform-icon windows"><PlatformIcon platform="windows" /></span>
            <div class="process-main"><div><strong>Windows 客户端</strong><span class="is-ready">更新已准备完成</span></div><p>重启客户端后完成安装，已保存的连接不会丢失。</p></div>
            <button class="primary-button" type="button" @click="ElMessage.success('原型状态：准备重启客户端')">重启更新</button>
          </article>
        </div>
        <div class="process-failure"><el-icon><WarningFilled /></el-icon><div><strong>Chrome 插件更新失败</strong><span>浏览器暂时无法获取新版本，可以稍后重试。</span></div><button class="text-button process-retry" type="button" @click="ElMessage.info('重新检查 Chrome 插件版本')">重新检查</button></div>
      </section>

      <section class="release-group"><div class="group-head"><div><h2>版本说明</h2><span>VRC 0.1.38 · 稳定版</span></div><button class="link-button" type="button" @click="ElMessage.info('已展开版本说明')">展开</button></div><p class="release-copy">优化物理机和虚拟机资源列表刷新体验，修复安装流程状态与控制台显示不同步的问题。</p></section>
      <footer class="safety-note"><el-icon><WarningFilled /></el-icon><span>更新过程中不会删除已保存的连接和资源配置。</span></footer>
    </section>
  </main>
</template>

<style scoped>
.update-prototype{display:grid;grid-template-columns:220px minmax(0,1fr);height:100vh;overflow:hidden;background:var(--vrc-bg);color:var(--vrc-text)}
.prototype-sidebar{display:flex;flex-direction:column;gap:18px;padding:18px 14px 14px;background:var(--vrc-surface);border-right:1px solid var(--vrc-border)}
.brand-lockup{display:flex;align-items:center;gap:9px;padding:0 6px}.brand-lockup :deep(.vrc-logo-mark){width:32px;height:32px}.brand-lockup span{display:grid;gap:2px}.brand-lockup strong{font-size:14px;font-weight:600}.brand-lockup small,.sidebar-current small,.sidebar-current span,.service-state{font-size:11px;color:var(--vrc-text-muted)}
.sidebar-current{display:grid;gap:4px;padding:10px 11px;background:var(--vrc-surface-muted);border:1px solid var(--vrc-border);border-radius:7px}.sidebar-current strong{font-size:13px;font-weight:400}.prototype-nav{display:grid;align-content:start;gap:4px}.prototype-nav button{display:flex;align-items:center;gap:8px;height:36px;padding:0 10px;color:var(--vrc-text-muted);font:inherit;font-size:12px;text-align:left;background:transparent;border:1px solid transparent;border-radius:7px}.prototype-nav button.active{color:var(--vrc-accent);background:var(--vrc-surface-muted);border-color:var(--vrc-active-border)}.service-state{display:flex;align-items:center;gap:7px;margin-top:auto;padding:10px 6px 0;border-top:1px solid var(--vrc-border)}.service-state i{width:7px;height:7px;background:var(--vrc-success);border-radius:50%}
.prototype-content{display:grid;align-content:start;gap:14px;min-width:0;overflow:auto;padding:24px clamp(20px,4vw,48px) 28px}.page-head,.prototype-switch,.notice-group,.business-group,.release-group,.safety-note{width:min(1040px,100%);margin:0 auto}.page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:20px}.page-head h1{margin:0;font-size:14px;line-height:20px;font-weight:600}.page-head p{margin:3px 0 0;color:var(--vrc-text-muted);font-size:11px;line-height:16px}.head-actions{display:flex;align-items:center;gap:8px;padding-top:1px}.head-actions>span{margin-right:2px;color:var(--vrc-text-muted);font-size:11px;white-space:nowrap}
.text-button,.primary-button,.row-button{height:30px;font:inherit;font-size:12px;font-weight:400;border-radius:7px;cursor:pointer}.text-button{padding:0 12px;color:var(--vrc-text);background:var(--vrc-surface);border:1px solid var(--vrc-border)}.primary-button{display:inline-flex;align-items:center;gap:6px;padding:0 12px;color:#fff;background:var(--vrc-accent);border:1px solid var(--vrc-accent)}.text-button:hover:not(:disabled),.row-button:hover{border-color:var(--vrc-border-strong)}.primary-button:hover{background:var(--vrc-accent-hover)}button:disabled{cursor:not-allowed;opacity:.55}
.prototype-switch{display:flex;gap:0;height:32px;border-bottom:1px solid var(--vrc-border)}.prototype-switch button{position:relative;display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;color:var(--vrc-text-muted);font:inherit;font-size:12px;background:transparent;border:0}.prototype-switch button span{color:var(--vrc-text-subtle);font-size:11px}.prototype-switch button.active{color:var(--vrc-text)}.prototype-switch button.active:after{position:absolute;right:12px;bottom:-1px;left:12px;height:2px;background:var(--vrc-accent);content:""}
.notice-group{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:10px 12px;background:var(--vrc-surface);border:1px solid var(--vrc-border);border-radius:8px}.notice-copy{display:flex;align-items:center;gap:9px;min-width:0}.notice-copy>.el-icon{flex:0 0 auto;color:var(--vrc-accent);font-size:17px}.notice-copy div{display:grid;gap:2px}.notice-copy strong{font-size:12px;font-weight:400}.notice-copy span{color:var(--vrc-text-muted);font-size:11px}.link-button{padding:0;color:var(--vrc-accent);font:inherit;font-size:11px;background:transparent;border:0;white-space:nowrap;cursor:pointer}
.business-group,.release-group{overflow:hidden;padding:12px;background:var(--vrc-surface);border:1px solid var(--vrc-border);border-radius:8px}.group-head{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:0 0 10px}.group-head>div{display:grid;gap:2px}.group-head h2{margin:0;font-size:12px;line-height:18px;font-weight:400}.group-head span,.count-text{color:var(--vrc-text-muted);font-size:11px;line-height:16px}.switch-line{display:flex;align-items:center;gap:7px;color:var(--vrc-text-muted);font-size:11px}.switch{position:relative;width:34px;height:20px;padding:0;background:var(--vrc-border-strong);border:0;border-radius:999px}.switch i{position:absolute;top:2px;left:2px;width:16px;height:16px;background:var(--vrc-surface);border-radius:50%;transition:transform 160ms ease}.switch.active{background:var(--vrc-accent)}.switch.active i{transform:translateX(14px)}
.platform-list,.update-table,.batch-layout{border:1px solid var(--vrc-border);border-radius:7px;overflow:hidden}.platform-row{position:relative;display:grid;grid-template-columns:32px minmax(0,1fr) auto;align-items:center;gap:10px;min-height:64px;padding:8px 12px}.platform-row+.platform-row,.table-row+.table-row{border-top:1px solid var(--vrc-border)}.platform-icon{display:grid;width:28px;height:28px;place-items:center;color:var(--vrc-accent);background:var(--vrc-accent-soft);border-radius:6px}.platform-icon.windows{color:#386899;background:#edf3f9}.platform-icon.web{color:var(--vrc-info);background:color-mix(in srgb,var(--vrc-info) 10%,var(--vrc-surface))}.platform-icon.chrome{color:#9b6c31;background:#f6f1e7}.platform-icon :deep(svg){width:17px;height:17px;fill:currentColor;stroke:none}.platform-info{display:grid;gap:2px;min-width:0}.platform-title{display:flex;align-items:center;gap:7px;flex-wrap:wrap}.platform-title strong{font-size:12px;font-weight:400}.platform-title span{color:var(--vrc-text-muted);font-size:11px}.platform-info p{margin:0;color:var(--vrc-text-muted);font-size:11px;line-height:16px}.platform-action{display:flex;align-items:center;gap:10px}.stage{font-size:11px;white-space:nowrap;color:var(--vrc-text-muted)}.stage.available{color:var(--vrc-warning)}.stage.downloading,.stage.ready{color:var(--vrc-accent)}.stage.updated{color:var(--vrc-success)}.row-progress{position:absolute;right:12px;bottom:3px;left:52px}.row-progress :deep(.el-progress-bar__outer){background:color-mix(in srgb,var(--vrc-border) 70%,transparent)}.row-progress :deep(.el-progress-bar__inner){background:linear-gradient(90deg,var(--vrc-accent),color-mix(in srgb,var(--vrc-accent) 72%,var(--vrc-success)))}
.update-table{min-width:720px}.table-row{display:grid;grid-template-columns:minmax(150px,1.3fr) 90px 90px minmax(120px,1fr) 92px 72px;align-items:center;gap:10px;min-height:48px;padding:0 12px;color:var(--vrc-text);font-size:12px}.table-head{min-height:36px;color:var(--vrc-text-muted);font-size:12px;font-weight:600;background:var(--vrc-surface-muted)}.table-platform{display:flex;align-items:center;gap:7px}.table-platform :deep(svg){width:16px;height:16px;color:var(--vrc-accent);fill:currentColor;stroke:none}.table-platform :deep(svg.windows){color:#386899}.table-platform :deep(svg.web){color:var(--vrc-info)}.table-platform :deep(svg.chrome){color:#9b6c31}.table-platform strong{font-weight:400}.row-button{height:28px;padding:0 9px;color:var(--vrc-accent);background:transparent;border:1px solid var(--vrc-border)}
.batch-layout{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(250px,.75fr)}.target-picker{padding:4px 12px}.target-picker>button{display:grid;grid-template-columns:20px minmax(0,1fr) auto;align-items:center;gap:8px;width:100%;min-height:48px;padding:0;color:var(--vrc-text);font:inherit;text-align:left;background:transparent;border:0;border-bottom:1px solid var(--vrc-border)}.target-picker>button:last-child{border-bottom:0}.target-picker>button>i{display:grid;width:18px;height:18px;place-items:center;color:#fff;font-style:normal;border:1px solid var(--vrc-border-strong);border-radius:4px}.target-picker>button.selected>i{background:var(--vrc-accent);border-color:var(--vrc-accent)}.target-picker strong,.target-picker small{display:block}.target-picker strong{font-size:12px;font-weight:400}.target-picker small{margin-top:2px;color:var(--vrc-text-muted);font-size:11px}.batch-summary{padding:14px;background:var(--vrc-surface-muted);border-left:1px solid var(--vrc-border)}.batch-summary>div{display:flex;justify-content:space-between;color:var(--vrc-text-muted);font-size:11px}.batch-summary strong{color:var(--vrc-accent);font-size:12px;font-weight:600}.batch-summary :deep(.el-progress-bar__outer){background:color-mix(in srgb,var(--vrc-border) 70%,transparent)}.batch-summary :deep(.el-progress-bar__inner){background:linear-gradient(90deg,var(--vrc-accent),color-mix(in srgb,var(--vrc-accent) 72%,var(--vrc-success)))}.batch-summary ol{display:grid;gap:10px;margin:14px 0 0;padding:0;list-style:none}.batch-summary li{display:grid;grid-template-columns:20px 1fr;gap:8px;color:var(--vrc-text-muted);font-size:11px}.batch-summary li i{display:grid;width:20px;height:20px;place-items:center;font-size:10px;font-style:normal;border:1px solid var(--vrc-border);border-radius:50%}.batch-summary li span{display:grid;gap:2px}.batch-summary li small{font-size:10px;color:var(--vrc-text-subtle)}.batch-summary li.done,.batch-summary li.active{color:var(--vrc-accent)}.batch-summary li.done i{color:#fff;background:var(--vrc-success);border-color:var(--vrc-success)}.batch-summary li.active i{border-color:var(--vrc-accent)}
.process-list{overflow:hidden;border:1px solid var(--vrc-border);border-radius:7px}.process-row{display:grid;grid-template-columns:32px minmax(0,1fr) auto;align-items:center;gap:10px;min-height:64px;padding:8px 12px}.process-row+.process-row{border-top:1px solid var(--vrc-border)}.process-row>.text-button,.process-row>.primary-button{height:28px;min-width:72px;padding:0 10px;border-radius:6px}.process-main{display:grid;gap:4px;min-width:0}.process-main>div:first-child{display:flex;align-items:center;justify-content:space-between;gap:12px}.process-main strong{font-size:12px;font-weight:400}.process-main span,.process-main small,.process-main p{color:var(--vrc-text-muted);font-size:11px}.process-main small{line-height:14px}.process-main p{margin:0;line-height:16px}.process-main .is-applying{color:var(--vrc-accent)}.process-main .is-ready{color:var(--vrc-success)}.process-main :deep(.el-progress-bar__outer){background:color-mix(in srgb,var(--vrc-border) 70%,transparent)}.process-main :deep(.el-progress-bar__inner){background:linear-gradient(90deg,var(--vrc-accent),color-mix(in srgb,var(--vrc-accent) 72%,var(--vrc-success)))}.indeterminate-progress{position:relative;height:5px;overflow:hidden;background:color-mix(in srgb,var(--vrc-border) 70%,transparent);border-radius:999px}.indeterminate-progress i{position:absolute;top:0;bottom:0;width:34%;background:linear-gradient(90deg,var(--vrc-accent),color-mix(in srgb,var(--vrc-accent) 72%,var(--vrc-success)));border-radius:inherit;animation:indeterminate 1.15s ease-in-out infinite}.process-failure{display:grid;grid-template-columns:18px minmax(0,1fr) auto;align-items:center;gap:8px;margin-top:10px;padding:9px 10px;color:var(--vrc-danger);background:color-mix(in srgb,var(--vrc-danger) 6%,var(--vrc-surface));border:1px solid color-mix(in srgb,var(--vrc-danger) 22%,var(--vrc-border));border-radius:7px}.process-failure>div{display:grid;gap:2px}.process-failure strong{font-size:11px;font-weight:400}.process-failure span{color:var(--vrc-text-muted);font-size:11px}.process-failure .process-retry{height:28px;min-width:72px;padding:0 10px;color:var(--vrc-danger);border-color:color-mix(in srgb,var(--vrc-danger) 28%,var(--vrc-border));border-radius:6px}
.release-group{padding:12px}.release-group .group-head{padding-bottom:7px}.release-copy{margin:0;color:var(--vrc-text-muted);font-size:11px;line-height:17px}.safety-note{display:flex;align-items:center;gap:6px;color:var(--vrc-text-muted);font-size:11px}.safety-note .el-icon{color:var(--vrc-warning)}
@keyframes indeterminate{0%{left:-35%}100%{left:105%}}
@media(max-width:900px){.update-prototype{grid-template-columns:1fr;height:auto;min-height:100vh;overflow:visible}.prototype-sidebar{display:grid;grid-template-columns:1fr auto;grid-template-rows:auto auto;padding:14px}.sidebar-current,.prototype-nav{grid-column:1/-1}.prototype-nav{display:flex;gap:4px}.prototype-nav button{flex:1}.service-state{justify-self:end}.prototype-content{overflow:visible}.batch-layout{grid-template-columns:1fr}.batch-summary{border-top:1px solid var(--vrc-border);border-left:0}}
@media(max-width:680px){.page-head,.group-head{align-items:flex-start;flex-direction:column}.head-actions{justify-content:flex-start;flex-wrap:wrap}.head-actions>span{width:100%}.notice-group{align-items:flex-start;flex-direction:column}.platform-row,.process-row{grid-template-columns:32px minmax(0,1fr)}.platform-action,.process-row>.text-button,.process-row>.primary-button{grid-column:2;justify-self:start}.update-table{overflow:auto}.switch-line{align-self:flex-end}.process-failure{grid-template-columns:18px minmax(0,1fr)}.process-failure .process-retry{grid-column:2;justify-self:start}}
</style>
