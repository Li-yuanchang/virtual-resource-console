<script setup lang="ts">
import { RefreshRight, Search, Setting } from "@element-plus/icons-vue";
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import VrcLogoMark from "../components/VrcLogoMark.vue";

type StartupVariant = "a" | "b" | "c";
type ThemeId = "graphite-sage" | "basalt-copper" | "mist-teal";

const phase = ref(0);
const animationKey = ref(0);
const startupVariant = ref<StartupVariant>("a");
const theme = ref<ThemeId>("graphite-sage");
const previewReady = ref(false);
let timers: number[] = [];

const phaseText = computed(() => ["正在启动本地服务", "正在载入资源配置", "正在准备工作区", "资源控制台已就绪"][phase.value]);
const startupVariants: Array<{ id: StartupVariant; label: string; title: string }> = [
  { id: "a", label: "A", title: "方案 A：环形扫描" },
  { id: "b", label: "B", title: "方案 B：边框聚焦" },
  { id: "c", label: "C", title: "方案 C：轨道收束" },
];
const themes: Array<{ id: ThemeId; title: string }> = [
  { id: "graphite-sage", title: "Graphite Sage" },
  { id: "basalt-copper", title: "Basalt Copper" },
  { id: "mist-teal", title: "Mist Teal" },
];

const connections = [
  { name: "生产资源池", meta: "XenServer · 192.0.2.6", count: "36 VM" },
  { name: "VMware 集群", meta: "VMware · 192.0.2.27", count: "12 VM" },
  { name: "PVE 运维节点", meta: "Proxmox VE · 203.0.113.2", count: "4 VM" },
];

const hosts = [
  { name: "xenserver-3", platform: "XenServer", ip: "192.0.2.6", cpu: "22 核", memory: "418 GiB", storage: "3.84 TiB", vm: "36" },
  { name: "esxi-prod-27", platform: "VMware", ip: "192.0.2.27", cpu: "18 核", memory: "286 GiB", storage: "2.12 TiB", vm: "12" },
  { name: "kunpeng920", platform: "Proxmox VE", ip: "203.0.113.2", cpu: "8 核", memory: "96 GiB", storage: "1.76 TiB", vm: "4" },
];

function clearTimers() {
  timers.forEach((timer) => window.clearTimeout(timer));
  timers = [];
}

async function markPreviewReady() {
  await nextTick();
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())));
  previewReady.value = true;
}

function finishWhenReady() {
  if (previewReady.value) {
    phase.value = 3;
    return;
  }
  timers.push(window.setTimeout(finishWhenReady, 50));
}

function play() {
  clearTimers();
  phase.value = 0;
  previewReady.value = false;
  animationKey.value += 1;
  timers.push(
    window.setTimeout(() => (phase.value = 1), 850),
    window.setTimeout(() => {
      phase.value = 2;
      void markPreviewReady();
    }, 1750),
    window.setTimeout(finishWhenReady, 3000),
  );
}

function selectVariant(value: StartupVariant) {
  startupVariant.value = value;
  play();
}

function selectTheme(value: ThemeId) {
  theme.value = value;
  play();
}

onMounted(play);
onBeforeUnmount(clearTimers);
</script>

<template>
  <main class="client-startup-prototype" :data-theme="theme">
    <section
      :key="animationKey"
      class="client-window"
      :class="[`startup-phase-${phase}`, `startup-variant-${startupVariant}`, { 'is-preview-ready': previewReady }]"
    >
      <header class="client-titlebar">
        <div class="traffic-lights" aria-hidden="true"><i></i><i></i><i></i></div>
        <span>VRC · 启动方案 {{ startupVariant.toUpperCase() }}</span>
        <div class="prototype-controls">
          <div class="variant-control" role="group" aria-label="启动动画方案">
            <el-tooltip v-for="item in startupVariants" :key="item.id" :content="item.title" placement="bottom" :show-after="350">
              <button type="button" :class="{ active: startupVariant === item.id }" :aria-label="item.title" @click="selectVariant(item.id)">{{ item.label }}</button>
            </el-tooltip>
          </div>
          <div class="theme-control" role="group" aria-label="主题背景">
            <el-tooltip v-for="item in themes" :key="item.id" :content="item.title" placement="bottom" :show-after="350">
              <button type="button" :data-theme="item.id" :class="{ active: theme === item.id }" :aria-label="`切换到 ${item.title}`" @click="selectTheme(item.id)"><i></i></button>
            </el-tooltip>
          </div>
          <el-tooltip content="重新播放启动动画" placement="bottom" :show-after="350">
            <button class="replay-button" type="button" aria-label="重新播放启动动画" @click="play">
              <el-icon><RefreshRight /></el-icon>
            </button>
          </el-tooltip>
        </div>
      </header>

      <div class="console-preview" aria-hidden="true">
        <aside class="preview-sidebar">
          <div class="preview-brand">
            <span class="brand-mark"><VrcLogoMark /></span>
            <div><strong>资源控制台</strong><small>3 个连接</small></div>
            <button type="button" tabindex="-1"><el-icon><Setting /></el-icon></button>
          </div>
          <div class="preview-search"><el-icon><Search /></el-icon><span>输入名称、平台或地址</span></div>
          <div class="preview-groups">
            <span class="preview-group-label">资源</span>
            <div class="preview-overview"><b>V</b><span><strong>资源总览</strong><small>3 台物理机</small></span></div>
            <span class="preview-group-label">已保存连接</span>
            <div v-for="connection in connections" :key="connection.name" class="preview-connection">
              <i></i><span><strong>{{ connection.name }}</strong><small>{{ connection.meta }}</small></span><em>{{ connection.count }}</em>
            </div>
          </div>
        </aside>

        <section class="preview-workspace">
          <div class="preview-heading"><div><h1>物理机总览</h1><p>跨平台查看物理资源和虚拟机容量</p></div><span>刚刚更新</span></div>
          <div class="preview-metrics">
            <div><span>物理机</span><strong>3</strong><small>3 台在线</small></div>
            <div><span>虚拟机</span><strong>52</strong><small>34 台运行中</small></div>
            <div><span>可用 CPU</span><strong>48 核</strong><small>当前余量</small></div>
            <div><span>可用内存</span><strong>800 GiB</strong><small>当前余量</small></div>
          </div>
          <div class="preview-table">
            <div class="preview-table-toolbar"><strong>物理机资源列表</strong><span>共 3 台</span></div>
            <div class="preview-row preview-row-head"><span>序号</span><span>平台</span><span>物理机</span><span>管理 IP</span><span>CPU 余量</span><span>内存余量</span><span>存储余量</span><span>VM</span></div>
            <div v-for="(host, index) in hosts" :key="host.name" class="preview-row">
              <span>{{ index + 1 }}</span><span>{{ host.platform }}</span><a>{{ host.name }}</a><span>{{ host.ip }}</span><span>{{ host.cpu }}</span><span>{{ host.memory }}</span><span>{{ host.storage }}</span><span>{{ host.vm }}</span>
            </div>
          </div>
        </section>
      </div>

      <section class="startup-layer" aria-live="polite">
        <div class="startup-center">
          <div class="startup-mark" :class="`mark-${startupVariant}`">
            <template v-if="startupVariant === 'a'">
              <span class="startup-ring startup-ring-outer"></span>
              <span class="startup-ring startup-ring-inner"></span>
              <i class="startup-scan"></i>
            </template>
            <template v-else-if="startupVariant === 'b'">
              <span class="focus-corner corner-tl"></span><span class="focus-corner corner-tr"></span>
              <span class="focus-corner corner-bl"></span><span class="focus-corner corner-br"></span>
              <i class="focus-sweep"></i>
            </template>
            <template v-else>
              <span class="startup-track track-horizontal"></span>
              <span class="startup-track track-vertical"></span>
              <i class="track-glow track-glow-horizontal"></i>
              <i class="track-glow track-glow-vertical"></i>
            </template>
            <VrcLogoMark shadow />
          </div>
          <div class="startup-copy">
            <h1>Virtual Resource Console</h1>
            <p>{{ phaseText }}</p>
          </div>
          <div class="startup-progress" aria-hidden="true"><i></i></div>
        </div>
      </section>
    </section>
  </main>
</template>

<style scoped>
.client-startup-prototype {
  display: grid;
  min-height: 100vh;
  padding: 24px;
  place-items: center;
  color: var(--vrc-text);
  background: var(--vrc-bg);
}

.client-window {
  position: relative;
  width: min(1380px, calc(100vw - 48px));
  height: min(860px, calc(100vh - 48px));
  min-height: min(680px, calc(100vh - 48px));
  overflow: hidden;
  background: var(--vrc-surface);
  border: 1px solid var(--vrc-border);
  border-radius: 8px;
  box-shadow: var(--vrc-shadow);
}

.client-titlebar {
  position: relative;
  z-index: 5;
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  height: 38px;
  padding: 0 10px 0 14px;
  color: var(--vrc-text-muted);
  background: var(--vrc-surface);
  border-bottom: 1px solid var(--vrc-border);
  font-size: 12px;
  font-weight: 400;
}

.traffic-lights { display: flex; gap: 8px; }
.traffic-lights i { width: 11px; height: 11px; border: 1px solid color-mix(in srgb, var(--vrc-text) 14%, transparent); border-radius: 50%; }
.traffic-lights i:nth-child(1) { background: color-mix(in srgb, var(--vrc-danger) 72%, var(--vrc-surface)); }
.traffic-lights i:nth-child(2) { background: color-mix(in srgb, var(--vrc-warning) 70%, var(--vrc-surface)); }
.traffic-lights i:nth-child(3) { background: color-mix(in srgb, var(--vrc-success) 70%, var(--vrc-surface)); }

.prototype-controls,
.variant-control,
.theme-control {
  display: flex;
  align-items: center;
}

.prototype-controls { justify-self: end; gap: 7px; }
.variant-control { height: 28px; padding: 2px; gap: 2px; background: var(--vrc-surface-muted); border-radius: 7px; }
.variant-control button { width: 24px; height: 24px; padding: 0; color: var(--vrc-text-muted); background: transparent; border: 0; border-radius: 5px; font-size: 11px; font-weight: 400; cursor: pointer; }
.variant-control button.active { color: var(--vrc-text); background: var(--vrc-surface); box-shadow: 0 0 0 1px var(--vrc-border); }
.theme-control { gap: 3px; }
.theme-control button { display: grid; width: 24px; height: 28px; padding: 0; place-items: center; background: transparent; border: 1px solid transparent; border-radius: 6px; cursor: pointer; }
.theme-control button.active { border-color: var(--vrc-border-strong); }
.theme-control button i { width: 12px; height: 12px; background: var(--vrc-accent); border: 1px solid color-mix(in srgb, var(--vrc-text) 12%, transparent); border-radius: 3px; }

.replay-button {
  display: grid;
  width: 28px;
  height: 28px;
  padding: 0;
  place-items: center;
  color: var(--vrc-text-muted);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  cursor: pointer;
}

.replay-button:hover { color: var(--vrc-accent); border-color: var(--vrc-border); }
.replay-button .el-icon { font-size: 16px; }

.console-preview {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  height: calc(100% - 38px);
  opacity: 0;
  transform: scale(0.992);
  transform-origin: center;
  transition: opacity 520ms ease, transform 620ms cubic-bezier(0.22, 1, 0.36, 1);
}

.startup-phase-2.is-preview-ready .console-preview,
.startup-phase-3.is-preview-ready .console-preview { opacity: 1; transform: scale(1); }

.preview-sidebar { min-width: 0; background: var(--vrc-surface); border-right: 1px solid var(--vrc-border); }
.preview-brand { display: grid; grid-template-columns: 46px minmax(0, 1fr) 28px; align-items: center; gap: 8px; min-height: 74px; padding: 10px 12px; border-bottom: 1px solid var(--vrc-border); }
.preview-brand .brand-mark { width: 46px; height: 46px; }
.preview-brand div { display: grid; gap: 3px; min-width: 0; }
.preview-brand strong, .preview-brand small, .preview-connection strong, .preview-connection small { overflow: hidden; font-weight: 400; text-overflow: ellipsis; white-space: nowrap; }
.preview-brand strong { font-size: 13px; }
.preview-brand small, .preview-connection small { color: var(--vrc-text-muted); font-size: 11px; }
.preview-brand button { display: grid; width: 28px; height: 28px; padding: 0; place-items: center; color: var(--vrc-text-muted); background: transparent; border: 0; border-radius: 6px; }
.preview-search { display: flex; align-items: center; gap: 7px; height: 28px; margin: 10px 12px; padding: 0 9px; color: var(--vrc-text-subtle); background: var(--vrc-surface-muted); border-radius: 7px; font-size: 11px; }
.preview-groups { display: grid; gap: 4px; padding: 2px 8px; }
.preview-group-label { padding: 6px 8px 2px; color: var(--vrc-text-subtle); font-size: 11px; }
.preview-overview, .preview-connection { display: grid; grid-template-columns: 28px minmax(0, 1fr) auto; align-items: center; gap: 7px; min-height: 46px; padding: 5px 8px; background: var(--vrc-surface); border: 1px solid transparent; border-radius: 7px; }
.preview-overview { border-color: var(--vrc-accent); }
.preview-overview b { display: grid; width: 26px; height: 26px; place-items: center; color: var(--vrc-accent); border: 1px solid var(--vrc-border); border-radius: 6px; font-size: 11px; }
.preview-overview span, .preview-connection span { display: grid; gap: 3px; min-width: 0; }
.preview-overview strong, .preview-overview small { font-weight: 400; }
.preview-overview strong, .preview-connection strong { font-size: 12px; }
.preview-overview small { color: var(--vrc-text-muted); font-size: 11px; }
.preview-connection { grid-template-columns: 8px minmax(0, 1fr) auto; }
.preview-connection > i { width: 6px; height: 6px; background: var(--vrc-success); border-radius: 50%; }
.preview-connection em { color: var(--vrc-text-subtle); font-size: 10px; font-style: normal; }

.preview-workspace { min-width: 0; padding: 18px; background: var(--vrc-bg); }
.preview-heading { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
.preview-heading h1, .preview-heading p { margin: 0; font-weight: 400; }
.preview-heading h1 { font-size: 18px; line-height: 24px; }
.preview-heading p, .preview-heading > span { margin-top: 3px; color: var(--vrc-text-muted); font-size: 11px; }
.preview-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-bottom: 14px; }
.preview-metrics > div { display: grid; gap: 5px; min-height: 82px; padding: 11px 12px; background: var(--vrc-surface); border: 1px solid var(--vrc-border); border-radius: 8px; }
.preview-metrics span, .preview-metrics small { color: var(--vrc-text-muted); font-size: 11px; }
.preview-metrics strong { align-self: end; color: var(--vrc-accent); font-size: 20px; font-weight: 600; }
.preview-table { overflow: hidden; background: var(--vrc-surface); border: 1px solid var(--vrc-border); border-radius: 8px; }
.preview-table-toolbar { display: flex; align-items: center; justify-content: space-between; height: 44px; padding: 0 12px; }
.preview-table-toolbar strong { font-size: 13px; font-weight: 400; }
.preview-table-toolbar span { color: var(--vrc-text-muted); font-size: 11px; }
.preview-row { display: grid; grid-template-columns: 64px 110px minmax(160px, 1fr) 140px repeat(3, minmax(100px, 0.7fr)) 70px; align-items: center; min-height: 48px; border-top: 1px solid var(--vrc-border); font-size: 12px; }
.preview-row > * { min-width: 0; padding: 0 10px; overflow: hidden; text-align: center; text-overflow: ellipsis; white-space: nowrap; }
.preview-row > :nth-child(3) { text-align: left; }
.preview-row-head { min-height: 36px; color: var(--vrc-text-muted); background: var(--vrc-surface-muted); font-weight: 600; }
.preview-row a { color: #2563eb; text-decoration: underline; }

.startup-layer {
  position: absolute;
  z-index: 4;
  inset: 38px 0 0;
  display: grid;
  overflow: hidden;
  place-items: center;
  background: var(--vrc-bg);
  opacity: 1;
  transition: opacity 480ms cubic-bezier(0.4, 0, 0.2, 1), visibility 480ms linear;
  visibility: visible;
}

.startup-phase-3 .startup-layer { opacity: 0; pointer-events: none; visibility: hidden; }

.startup-layer::after {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  height: 1px;
  background: var(--vrc-border);
  content: "";
  opacity: 0.7;
}

.startup-center { display: grid; justify-items: center; width: min(320px, calc(100vw - 64px)); transform: translateY(-10px); }
.startup-mark { position: relative; display: grid; width: 104px; height: 104px; margin-bottom: 20px; place-items: center; }
.startup-mark .vrc-logo-mark { position: relative; z-index: 2; width: 78px; height: 78px; animation: startup-logo-enter 620ms cubic-bezier(0.22, 1, 0.36, 1) both, startup-logo-breathe 1.7s 620ms ease-in-out infinite; }

/* A: concentric scan */
.startup-ring { position: absolute; border: 1px solid color-mix(in srgb, var(--vrc-accent) 24%, transparent); border-radius: 50%; }
.startup-ring-outer { inset: 0; animation: startup-ring-breathe 1.7s 260ms ease-in-out infinite; }
.startup-ring-inner { inset: 10px; border-color: color-mix(in srgb, var(--vrc-accent) 13%, transparent); animation: startup-ring-breathe 1.7s 520ms ease-in-out infinite reverse; }
.startup-scan { position: absolute; z-index: 3; top: 14px; left: 20px; width: 64px; height: 1px; background: color-mix(in srgb, var(--vrc-logo-fg) 72%, transparent); box-shadow: 0 0 8px color-mix(in srgb, var(--vrc-logo-fg) 45%, transparent); opacity: 0; animation: startup-logo-scan 1.55s 520ms ease-in-out infinite; }

/* B: focus frame */
.focus-corner { position: absolute; z-index: 1; width: 22px; height: 22px; color: color-mix(in srgb, var(--vrc-accent) 72%, var(--vrc-text-muted)); border-color: currentColor; border-style: solid; border-width: 0; opacity: 0; animation: startup-corner-enter 560ms cubic-bezier(0.22, 1, 0.36, 1) forwards; }
.corner-tl { top: 0; left: 0; border-width: 1px 0 0 1px; transform: translate(8px, 8px); }
.corner-tr { top: 0; right: 0; border-width: 1px 1px 0 0; transform: translate(-8px, 8px); }
.corner-bl { bottom: 0; left: 0; border-width: 0 0 1px 1px; transform: translate(8px, -8px); }
.corner-br { right: 0; bottom: 0; border-width: 0 1px 1px 0; transform: translate(-8px, -8px); }
.corner-tr, .corner-bl { animation-delay: 90ms; }
.corner-br { animation-delay: 180ms; }
.focus-sweep { position: absolute; z-index: 3; top: 12px; left: 10px; width: 84px; height: 1px; background: color-mix(in srgb, var(--vrc-accent) 62%, transparent); box-shadow: 0 0 7px color-mix(in srgb, var(--vrc-accent) 24%, transparent); opacity: 0; animation: startup-focus-sweep 1.65s 580ms ease-in-out infinite; }
.mark-b .vrc-logo-mark { animation: startup-logo-focus 700ms 120ms cubic-bezier(0.22, 1, 0.36, 1) both, startup-logo-breathe 2s 900ms ease-in-out infinite; }

/* C: crossing rails */
.mark-c::before { position: absolute; z-index: 0; inset: 7px; border: 1px solid color-mix(in srgb, var(--vrc-accent) 16%, transparent); border-radius: 24px; content: ""; animation: startup-track-frame 1.8s ease-in-out infinite; }
.startup-track, .track-glow { position: absolute; z-index: 1; display: block; }
.track-horizontal { right: -12px; left: -12px; height: 1px; background: color-mix(in srgb, var(--vrc-accent) 18%, transparent); }
.track-vertical { top: -12px; bottom: -12px; width: 1px; background: color-mix(in srgb, var(--vrc-accent) 18%, transparent); }
.track-glow-horizontal { left: -12px; width: 34px; height: 1px; background: var(--vrc-accent); box-shadow: 0 0 6px color-mix(in srgb, var(--vrc-accent) 28%, transparent); animation: startup-track-horizontal 1.65s ease-in-out infinite; }
.track-glow-vertical { top: -12px; width: 1px; height: 34px; background: var(--vrc-accent); box-shadow: 0 0 6px color-mix(in srgb, var(--vrc-accent) 28%, transparent); animation: startup-track-vertical 1.65s 180ms ease-in-out infinite; }
.mark-c .vrc-logo-mark { animation: startup-logo-settle 760ms cubic-bezier(0.22, 1, 0.36, 1) both, startup-logo-breathe 2.1s 820ms ease-in-out infinite; }

.startup-copy { display: grid; gap: 7px; justify-items: center; }
.startup-copy h1, .startup-copy p { margin: 0; font-weight: 400; letter-spacing: 0; }
.startup-copy h1 { font-size: 16px; line-height: 24px; }
.startup-copy p { color: var(--vrc-text-muted); font-size: 12px; line-height: 18px; transition: opacity 180ms ease; }
.startup-progress { width: 150px; height: 2px; margin-top: 18px; overflow: hidden; background: color-mix(in srgb, var(--vrc-border) 72%, transparent); border-radius: 999px; }
.startup-progress i { display: block; width: 42%; height: 100%; background: var(--vrc-accent); border-radius: inherit; animation: startup-progress-travel 1.25s ease-in-out infinite; }
.startup-variant-b .startup-progress i { width: 100%; transform: scaleX(0); transform-origin: left; animation: startup-progress-fill 2.72s cubic-bezier(0.4, 0, 0.2, 1) forwards; }
.startup-variant-c .startup-progress i { width: 30%; animation: startup-progress-converge 1.45s ease-in-out infinite; }

@keyframes startup-logo-enter { from { opacity: 0.38; transform: scale(0.9); } to { opacity: 1; transform: scale(1); } }
@keyframes startup-logo-breathe { 0%, 100% { transform: scale(0.98); } 50% { transform: scale(1.025); } }
@keyframes startup-ring-breathe { 0%, 100% { opacity: 0.28; transform: scale(0.94); } 50% { opacity: 0.8; transform: scale(1.04); } }
@keyframes startup-logo-scan { 0% { opacity: 0; transform: translateY(0); } 18%, 76% { opacity: 0.65; } 100% { opacity: 0; transform: translateY(75px); } }
@keyframes startup-progress-travel { 0% { transform: translateX(-105%); } 52% { transform: translateX(92%); } 100% { transform: translateX(242%); } }
@keyframes startup-corner-enter { to { opacity: 1; transform: translate(0, 0); } }
@keyframes startup-focus-sweep { 0% { opacity: 0; transform: translateY(0); } 20%, 72% { opacity: 0.72; } 100% { opacity: 0; transform: translateY(79px); } }
@keyframes startup-logo-focus { from { opacity: 0; transform: scale(0.9); } to { opacity: 1; transform: scale(1); } }
@keyframes startup-track-frame { 0%, 100% { opacity: 0.35; transform: scale(0.96); } 50% { opacity: 0.82; transform: scale(1.02); } }
@keyframes startup-track-horizontal { 0% { opacity: 0; transform: translateX(0); } 18%, 78% { opacity: 0.78; } 100% { opacity: 0; transform: translateX(94px); } }
@keyframes startup-track-vertical { 0% { opacity: 0; transform: translateY(0); } 18%, 78% { opacity: 0.78; } 100% { opacity: 0; transform: translateY(94px); } }
@keyframes startup-logo-settle { from { opacity: 0; transform: scale(1.12); } to { opacity: 1; transform: scale(1); } }
@keyframes startup-progress-fill { 0% { transform: scaleX(0); } 38% { transform: scaleX(0.28); } 72% { transform: scaleX(0.74); } 100% { transform: scaleX(1); } }
@keyframes startup-progress-converge { 0% { opacity: 0; transform: translateX(-105%); } 20%, 76% { opacity: 1; } 100% { opacity: 0; transform: translateX(440%); } }
@media (max-width: 980px) {
  .client-startup-prototype { padding: 14px; }
  .client-window { width: calc(100vw - 28px); height: calc(100vh - 28px); min-height: min(620px, calc(100vh - 28px)); }
  .console-preview { grid-template-columns: 190px minmax(0, 1fr); }
  .preview-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .preview-row { min-width: 900px; }
  .preview-table { overflow: hidden; }
}

@media (max-width: 700px) {
  .client-startup-prototype { padding: 0; }
  .client-window { width: 100vw; height: 100vh; min-height: 560px; border: 0; border-radius: 0; }
  .console-preview { grid-template-columns: 1fr; }
  .preview-sidebar { display: none; }
  .preview-workspace { padding: 12px; }
  .preview-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

</style>
