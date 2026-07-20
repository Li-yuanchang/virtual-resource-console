<script setup lang="ts">
import {
  ArrowRight,
  CircleCheck,
  Close,
  Coin,
  Cpu,
  Files,
  InfoFilled,
  Minus,
  Plus,
  Warning,
} from "@element-plus/icons-vue";
import { computed, ref, watch } from "vue";

type PrototypeVersion = "compact" | "compare" | "advanced";
type Provider = "xenserver" | "vmware" | "proxmox";
type DiskMode = "extend" | "add";
type ResourceKey = "cpu" | "memory" | "disk";

interface Capability {
  label: string;
  tone: "success" | "warning";
  detail: string;
}

const versions: Array<{ value: PrototypeVersion; label: string; note: string }> = [
  { value: "compact", label: "方案一 · 快速调整", note: "最短路径，适合高频单机扩容" },
  { value: "compare", label: "方案二 · 变更对比", note: "当前、调整、结果一眼核对" },
  { value: "advanced", label: "方案三 · 分类配置", note: "复杂磁盘和执行策略更清楚" },
];

const providers: Array<{ value: Provider; label: string }> = [
  { value: "xenserver", label: "XenServer" },
  { value: "vmware", label: "VMware" },
  { value: "proxmox", label: "PVE" },
];

const activeVersion = ref<PrototypeVersion>("compare");
const provider = ref<Provider>("xenserver");
const activeResource = ref<ResourceKey>("cpu");
const cpu = ref(8);
const memory = ref(16);
const diskMode = ref<DiskMode>("extend");
const disk = ref(180);
const autoGuestResize = ref(true);
const openConsole = ref(true);

const current = {
  cpu: 4,
  memory: 8,
  disk: 120,
};

const host = {
  name: "xenserver-6",
  address: "192.168.2.62",
  cpuFree: 28,
  memoryFree: 96,
  storageFree: 1380,
};

const capabilityMap: Record<Provider, Record<ResourceKey, Capability>> = {
  xenserver: {
    cpu: { label: "需关机", tone: "warning", detail: "当前 XenServer 配置未启用 vCPU 热插拔，提交后先正常关机。" },
    memory: { label: "需关机", tone: "warning", detail: "内存上限与启动值将一起调整，关机执行更稳定。" },
    disk: { label: "可在线", tone: "success", detail: "虚拟磁盘可在线增大；客户机分区和文件系统仍需扩展。" },
  },
  vmware: {
    cpu: { label: "可在线", tone: "success", detail: "已启用 CPU Hot Add；客户机系统需要支持热添加。" },
    memory: { label: "可在线", tone: "success", detail: "已启用 Memory Hot Add；结果以 vSphere 任务状态为准。" },
    disk: { label: "可在线", tone: "success", detail: "可在线扩展 VMDK；客户机内仍需扩展卷和文件系统。" },
  },
  proxmox: {
    cpu: { label: "可在线", tone: "success", detail: "已启用 CPU 热插拔；最大 vCPU 上限保持不变。" },
    memory: { label: "可在线", tone: "success", detail: "Balloon 与热插拔已启用，在线调整后持续校验状态。" },
    disk: { label: "可在线", tone: "success", detail: "可在线扩展 scsi0；不支持缩小已有磁盘。" },
  },
};

const providerLabel = computed(() => providers.find((item) => item.value === provider.value)?.label ?? provider.value);
const capabilities = computed(() => capabilityMap[provider.value]);
const diskResult = computed(() => (diskMode.value === "extend" ? disk.value : current.disk + disk.value));
const hasShutdownChange = computed(() =>
  (["cpu", "memory"] as ResourceKey[]).some((key) => capabilities.value[key].tone === "warning" && targetValue(key) !== currentValue(key)),
);
const changedCount = computed(() => {
  let count = Number(cpu.value !== current.cpu) + Number(memory.value !== current.memory);
  if (diskMode.value === "add" || disk.value !== current.disk) count += 1;
  return count;
});
const activeVersionInfo = computed(() => versions.find((item) => item.value === activeVersion.value) ?? versions[1]);

watch(diskMode, (mode) => {
  disk.value = mode === "extend" ? Math.max(disk.value, current.disk + 20) : 100;
});

function currentValue(key: ResourceKey) {
  return current[key];
}

function targetValue(key: ResourceKey) {
  if (key === "cpu") return cpu.value;
  if (key === "memory") return memory.value;
  return diskResult.value;
}

function resourceUnit(key: ResourceKey) {
  return key === "cpu" ? "vCPU" : "GiB";
}

function resourceLabel(key: ResourceKey) {
  return key === "cpu" ? "处理器" : key === "memory" ? "内存" : "虚拟硬盘";
}

function resourceIcon(key: ResourceKey) {
  return key === "cpu" ? Cpu : key === "memory" ? Coin : Files;
}

function adjust(target: "cpu" | "memory" | "disk", direction: number) {
  const step = target === "cpu" ? 1 : target === "memory" ? 2 : 20;
  const minimum = target === "cpu" ? current.cpu : target === "memory" ? current.memory : diskMode.value === "extend" ? current.disk : 20;
  const state = target === "cpu" ? cpu : target === "memory" ? memory : disk;
  state.value = Math.max(minimum, state.value + direction * step);
}

function resetValues() {
  cpu.value = 8;
  memory.value = 16;
  diskMode.value = "extend";
  disk.value = 180;
  autoGuestResize.value = true;
  openConsole.value = true;
}
</script>

<template>
  <main class="resize-prototype-shell">
    <header class="prototype-topbar">
      <div>
        <span class="prototype-kicker">VRC / 交互原型</span>
        <h1>虚拟机扩容</h1>
      </div>
      <div class="prototype-controls">
        <div class="prototype-provider-switch" aria-label="平台预览">
          <button v-for="item in providers" :key="item.value" type="button" :class="{ active: provider === item.value }" @click="provider = item.value">
            {{ item.label }}
          </button>
        </div>
        <button type="button" class="prototype-reset" @click="resetValues">重置示例</button>
      </div>
    </header>

    <nav class="prototype-version-tabs" aria-label="扩容原型版本">
      <button v-for="item in versions" :key="item.value" type="button" :class="{ active: activeVersion === item.value }" @click="activeVersion = item.value">
        <strong>{{ item.label }}</strong>
        <span>{{ item.note }}</span>
      </button>
    </nav>

    <section class="prototype-stage">
      <div class="prototype-context" aria-hidden="true">
        <div class="context-heading"><strong>虚拟机</strong><span>24 / 27 · {{ host.name }}</span></div>
        <div class="context-table-head"><span>名称</span><span>状态</span><span>系统</span><span>vCPU</span><span>内存</span><span>磁盘</span><span>IP</span><span>操作</span></div>
        <div class="context-table-row"><span>127.31_业务服务</span><span class="online-text">运行中</span><span>CentOS 7.9</span><span>4</span><span>8 GiB</span><span>120 GiB</span><span>192.168.127.31</span><span class="context-action">扩容</span></div>
      </div>

      <div class="prototype-mask"></div>
      <section class="resize-dialog" :class="`version-${activeVersion}`" role="dialog" aria-modal="true" aria-labelledby="resize-title">
        <header class="resize-dialog-header">
          <div class="resize-title-block">
            <div class="resize-title-line">
              <h2 id="resize-title">扩容虚拟机</h2>
              <span class="provider-badge">{{ providerLabel }}</span>
            </div>
            <p><strong>127.31_业务服务</strong><span>{{ host.name }} · {{ host.address }} · 运行中</span></p>
          </div>
          <button type="button" class="dialog-close" aria-label="关闭"><el-icon><Close /></el-icon></button>
        </header>

        <div class="resize-dialog-body">
          <template v-if="activeVersion === 'compact'">
            <div class="compact-capacity-line">
              <span>宿主机可用</span>
              <strong>CPU {{ host.cpuFree }} 核</strong>
              <strong>内存 {{ host.memoryFree }} GiB</strong>
              <strong>存储 {{ host.storageFree }} GiB</strong>
            </div>

            <div class="compact-resource-list">
              <section class="compact-resource-row">
                <div class="resource-identity"><el-icon><Cpu /></el-icon><span><strong>处理器</strong><small>当前 {{ current.cpu }} vCPU</small></span></div>
                <div class="compact-stepper"><button type="button" @click="adjust('cpu', -1)"><el-icon><Minus /></el-icon></button><strong>{{ cpu }}</strong><span>vCPU</span><button type="button" @click="adjust('cpu', 1)"><el-icon><Plus /></el-icon></button></div>
                <span class="capability-label" :class="capabilities.cpu.tone">{{ capabilities.cpu.label }}</span>
              </section>
              <section class="compact-resource-row">
                <div class="resource-identity"><el-icon><Coin /></el-icon><span><strong>内存</strong><small>当前 {{ current.memory }} GiB</small></span></div>
                <div class="compact-stepper"><button type="button" @click="adjust('memory', -1)"><el-icon><Minus /></el-icon></button><strong>{{ memory }}</strong><span>GiB</span><button type="button" @click="adjust('memory', 1)"><el-icon><Plus /></el-icon></button></div>
                <span class="capability-label" :class="capabilities.memory.tone">{{ capabilities.memory.label }}</span>
              </section>
              <section class="compact-resource-row disk-row">
                <div class="resource-identity"><el-icon><Files /></el-icon><span><strong>虚拟硬盘</strong><small>当前 1 块 · {{ current.disk }} GiB</small></span></div>
                <div class="disk-inline-config">
                  <el-segmented v-model="diskMode" :options="[{ label: '扩展原盘', value: 'extend' }, { label: '新增硬盘', value: 'add' }]" />
                  <div class="compact-stepper"><button type="button" @click="adjust('disk', -1)"><el-icon><Minus /></el-icon></button><strong>{{ disk }}</strong><span>GiB</span><button type="button" @click="adjust('disk', 1)"><el-icon><Plus /></el-icon></button></div>
                </div>
                <span class="capability-label" :class="capabilities.disk.tone">{{ capabilities.disk.label }}</span>
              </section>
            </div>

            <div class="compact-policy-line" :class="{ warning: hasShutdownChange }">
              <el-icon><Warning v-if="hasShutdownChange" /><CircleCheck v-else /></el-icon>
              <span>{{ hasShutdownChange ? "CPU 或内存变更需要先关机，磁盘扩容可在线执行。" : "本次变更可在线执行，不中断虚拟机。" }}</span>
            </div>
          </template>

          <template v-else-if="activeVersion === 'compare'">
            <div class="compare-layout">
              <section class="compare-main">
                <div class="compare-grid compare-grid-head"><span>资源</span><span>当前配置</span><span>调整</span><span>扩容后</span><span>执行</span></div>
                <div v-for="key in (['cpu', 'memory'] as ResourceKey[])" :key="key" class="compare-grid compare-row">
                  <span class="compare-resource"><el-icon><component :is="resourceIcon(key)" /></el-icon>{{ resourceLabel(key) }}</span>
                  <strong>{{ currentValue(key) }} <small>{{ resourceUnit(key) }}</small></strong>
                  <div class="delta-control"><button type="button" @click="adjust(key, -1)"><el-icon><Minus /></el-icon></button><span>+{{ targetValue(key) - currentValue(key) }}</span><button type="button" @click="adjust(key, 1)"><el-icon><Plus /></el-icon></button></div>
                  <strong class="result-value">{{ targetValue(key) }} <small>{{ resourceUnit(key) }}</small></strong>
                  <span class="capability-label" :class="capabilities[key].tone">{{ capabilities[key].label }}</span>
                </div>
                <div class="compare-grid compare-row disk-compare-row">
                  <span class="compare-resource"><el-icon><Files /></el-icon>虚拟硬盘</span>
                  <strong>{{ current.disk }} <small>GiB</small></strong>
                  <div class="compare-disk-control">
                    <el-segmented v-model="diskMode" :options="[{ label: '扩展原盘', value: 'extend' }, { label: '新增硬盘', value: 'add' }]" />
                    <el-input-number v-model="disk" :min="diskMode === 'extend' ? current.disk : 20" :step="20" controls-position="right" />
                  </div>
                  <strong class="result-value">{{ diskResult }} <small>GiB</small><em v-if="diskMode === 'add'">2 块</em></strong>
                  <span class="capability-label" :class="capabilities.disk.tone">{{ capabilities.disk.label }}</span>
                </div>
              </section>

              <aside class="impact-panel">
                <div class="impact-title"><span>资源影响</span><strong>{{ changedCount }} 项变更</strong></div>
                <dl>
                  <div><dt>CPU 余量</dt><dd>{{ host.cpuFree }} → {{ host.cpuFree - (cpu - current.cpu) }} 核</dd></div>
                  <div><dt>内存余量</dt><dd>{{ host.memoryFree }} → {{ host.memoryFree - (memory - current.memory) }} GiB</dd></div>
                  <div><dt>存储余量</dt><dd>{{ host.storageFree }} → {{ host.storageFree - (diskResult - current.disk) }} GiB</dd></div>
                </dl>
                <div class="impact-divider"></div>
                <div class="execution-summary" :class="{ warning: hasShutdownChange }">
                  <el-icon><Warning v-if="hasShutdownChange" /><CircleCheck v-else /></el-icon>
                  <span><strong>{{ hasShutdownChange ? "需短暂停机" : "支持在线执行" }}</strong><small>{{ hasShutdownChange ? "系统将先正常关机，完成后自动开机并打开控制台。" : "任务执行期间持续回读平台状态。" }}</small></span>
                </div>
              </aside>
            </div>
          </template>

          <template v-else>
            <div class="advanced-layout">
              <aside class="resource-nav">
                <button v-for="key in (['cpu', 'memory', 'disk'] as ResourceKey[])" :key="key" type="button" :class="{ active: activeResource === key }" @click="activeResource = key">
                  <el-icon><component :is="resourceIcon(key)" /></el-icon>
                  <span><strong>{{ resourceLabel(key) }}</strong><small>{{ currentValue(key) }} → {{ targetValue(key) }} {{ resourceUnit(key) }}</small></span>
                  <el-icon class="nav-arrow"><ArrowRight /></el-icon>
                </button>
              </aside>

              <section class="advanced-editor">
                <div class="advanced-editor-title">
                  <div><span>{{ resourceLabel(activeResource) }}</span><strong>调整配置</strong></div>
                  <span class="capability-label" :class="capabilities[activeResource].tone">{{ capabilities[activeResource].label }}</span>
                </div>

                <template v-if="activeResource === 'cpu'">
                  <div class="large-number-control"><button type="button" @click="adjust('cpu', -1)"><el-icon><Minus /></el-icon></button><div><strong>{{ cpu }}</strong><span>vCPU</span></div><button type="button" @click="adjust('cpu', 1)"><el-icon><Plus /></el-icon></button></div>
                  <div class="preset-row"><span>常用配置</span><button v-for="item in [4, 8, 12, 16]" :key="item" type="button" :class="{ active: cpu === item }" @click="cpu = item">{{ item }} 核</button></div>
                </template>

                <template v-else-if="activeResource === 'memory'">
                  <div class="large-number-control"><button type="button" @click="adjust('memory', -1)"><el-icon><Minus /></el-icon></button><div><strong>{{ memory }}</strong><span>GiB</span></div><button type="button" @click="adjust('memory', 1)"><el-icon><Plus /></el-icon></button></div>
                  <div class="preset-row"><span>常用配置</span><button v-for="item in [8, 16, 32, 64]" :key="item" type="button" :class="{ active: memory === item }" @click="memory = item">{{ item }} GiB</button></div>
                </template>

                <template v-else>
                  <div class="disk-mode-choice">
                    <button type="button" :class="{ active: diskMode === 'extend' }" @click="diskMode = 'extend'"><span class="choice-radio"></span><strong>扩展现有磁盘</strong><small>保持 1 块磁盘，直接增加容量。默认推荐。</small></button>
                    <button type="button" :class="{ active: diskMode === 'add' }" @click="diskMode = 'add'"><span class="choice-radio"></span><strong>新增数据盘</strong><small>保留原盘，创建并挂载一块新磁盘。</small></button>
                  </div>
                  <label class="advanced-field"><span>{{ diskMode === 'extend' ? '目标总容量' : '新硬盘容量' }}</span><el-input-number v-model="disk" :min="diskMode === 'extend' ? current.disk : 20" :step="20" controls-position="right" /><em>GiB</em></label>
                  <el-checkbox v-model="autoGuestResize">平台扩容后，自动扩展客户机分区和文件系统</el-checkbox>
                </template>

                <div class="capability-detail"><el-icon><InfoFilled /></el-icon><span>{{ capabilities[activeResource].detail }}</span></div>
              </section>
            </div>

            <div class="advanced-plan">
              <span>执行计划</span>
              <strong>{{ hasShutdownChange ? "正常关机" : "在线调整" }}</strong><el-icon><ArrowRight /></el-icon>
              <strong>修改 {{ changedCount }} 项配置</strong><el-icon><ArrowRight /></el-icon>
              <strong>{{ hasShutdownChange ? "自动开机" : "回读状态" }}</strong><el-icon><ArrowRight /></el-icon>
              <strong v-if="openConsole">打开控制台</strong>
              <el-checkbox v-model="openConsole">完成后打开控制台</el-checkbox>
            </div>
          </template>
        </div>

        <footer class="resize-dialog-footer">
          <div class="footer-summary">
            <span>{{ activeVersionInfo.label }}</span>
            <strong>{{ changedCount }} 项资源变更</strong>
            <small v-if="hasShutdownChange">包含停机操作</small>
          </div>
          <div class="footer-actions"><el-button>取消</el-button><el-button type="primary">确认扩容</el-button></div>
        </footer>
      </section>
    </section>
  </main>
</template>

<style scoped>
.resize-prototype-shell {
  min-height: 100vh;
  padding: 24px;
  color: var(--vrc-text);
  background: var(--vrc-bg);
}

button {
  font: inherit;
}

.prototype-topbar,
.prototype-version-tabs,
.prototype-stage {
  width: min(1420px, calc(100vw - 48px));
  margin: 0 auto;
}

.prototype-topbar {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 24px;
  margin-bottom: 16px;
}

.prototype-kicker {
  color: var(--vrc-text-subtle);
  font-size: 11px;
}

.prototype-topbar h1 {
  margin: 3px 0 0;
  font-size: 24px;
  font-weight: 500;
  letter-spacing: 0;
}

.prototype-controls,
.prototype-provider-switch {
  display: flex;
  align-items: center;
  gap: 8px;
}

.prototype-provider-switch {
  padding: 3px;
  background: var(--vrc-surface-muted);
  border: 1px solid var(--vrc-border);
  border-radius: 6px;
}

.prototype-provider-switch button,
.prototype-reset {
  height: 30px;
  padding: 0 12px;
  color: var(--vrc-text-muted);
  font-weight: 400;
  background: transparent;
  border: 0;
  border-radius: 4px;
  cursor: pointer;
}

.prototype-provider-switch button.active {
  color: var(--vrc-accent);
  background: var(--vrc-surface);
  box-shadow: 0 1px 3px rgba(39, 48, 42, 0.1);
}

.prototype-reset {
  color: var(--vrc-accent);
  border: 1px solid var(--vrc-border);
}

.prototype-version-tabs {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 12px;
}

.prototype-version-tabs button {
  display: grid;
  gap: 3px;
  min-height: 58px;
  padding: 10px 14px;
  text-align: left;
  color: var(--vrc-text-muted);
  background: var(--vrc-surface);
  border: 1px solid var(--vrc-border);
  border-radius: 6px;
  cursor: pointer;
}

.prototype-version-tabs button strong {
  color: var(--vrc-text);
  font-size: 13px;
  font-weight: 500;
}

.prototype-version-tabs button span {
  font-size: 11px;
}

.prototype-version-tabs button.active {
  border-color: var(--vrc-accent);
  box-shadow: inset 3px 0 0 var(--vrc-accent);
}

.prototype-stage {
  position: relative;
  min-height: 720px;
  overflow: hidden;
  background: var(--vrc-surface);
  border: 1px solid var(--vrc-border);
  border-radius: 8px;
}

.prototype-context {
  padding: 20px;
}

.context-heading {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 14px;
}

.context-heading strong {
  font-size: 15px;
  font-weight: 500;
}

.context-heading span {
  color: var(--vrc-text-subtle);
  font-size: 11px;
}

.context-table-head,
.context-table-row {
  display: grid;
  grid-template-columns: minmax(190px, 1.6fr) 80px 150px 70px 80px 100px 140px 90px;
  align-items: center;
  min-height: 42px;
  padding: 0 12px;
  border-bottom: 1px solid var(--vrc-border);
}

.context-table-head {
  color: var(--vrc-text-muted);
  font-size: 11px;
  text-align: center;
  background: var(--vrc-surface-muted);
}

.context-table-head span:first-child,
.context-table-row span:first-child {
  text-align: left;
}

.context-table-row {
  color: var(--vrc-text-muted);
  text-align: center;
}

.online-text {
  color: var(--vrc-success);
}

.context-action {
  color: #3571c8;
}

.prototype-mask {
  position: absolute;
  inset: 0;
  background: color-mix(in srgb, var(--vrc-text) 20%, transparent);
  backdrop-filter: blur(1px);
}

.resize-dialog {
  position: absolute;
  top: 50%;
  left: 50%;
  display: flex;
  flex-direction: column;
  width: min(980px, calc(100% - 48px));
  max-height: calc(100% - 48px);
  overflow: hidden;
  background: var(--vrc-surface);
  border: 1px solid var(--vrc-border-strong);
  border-radius: 8px;
  box-shadow: 0 24px 60px rgba(31, 43, 35, 0.22);
  transform: translate(-50%, -50%);
}

.resize-dialog.version-compact {
  width: min(680px, calc(100% - 48px));
}

.resize-dialog.version-advanced {
  width: min(980px, calc(100% - 48px));
}

.resize-dialog-header {
  display: flex;
  flex: 0 0 auto;
  align-items: flex-start;
  justify-content: space-between;
  min-height: 72px;
  padding: 14px 16px 12px;
  border-bottom: 1px solid var(--vrc-border);
}

.resize-title-line,
.resize-title-block p {
  display: flex;
  align-items: center;
  gap: 8px;
}

.resize-title-line h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 400;
}

.provider-badge {
  padding: 2px 6px;
  color: var(--vrc-accent);
  font-size: 10px;
  background: var(--vrc-accent-soft);
  border-radius: 3px;
}

.resize-title-block p {
  margin: 5px 0 0;
  color: var(--vrc-text-subtle);
  font-size: 11px;
}

.resize-title-block p strong {
  max-width: 320px;
  overflow: hidden;
  color: var(--vrc-text-muted);
  font-weight: 400;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.resize-title-block p span::before {
  margin-right: 8px;
  content: "·";
}

.dialog-close {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  padding: 0;
  color: var(--vrc-text-muted);
  background: transparent;
  border: 0;
  border-radius: 4px;
}

.dialog-close:hover {
  color: var(--vrc-text);
  background: var(--vrc-surface-muted);
}

.resize-dialog-body {
  flex: 1 1 auto;
  min-height: 0;
  padding: 16px;
  overflow: auto;
}

.resize-dialog-footer {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-height: 58px;
  padding: 10px 16px;
  background: var(--vrc-surface-raised);
  border-top: 1px solid var(--vrc-border);
}

.footer-summary {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  color: var(--vrc-text-muted);
  font-size: 11px;
}

.footer-summary > span {
  display: none;
}

.footer-summary strong {
  color: var(--vrc-text);
  font-size: 12px;
  font-weight: 500;
}

.footer-summary small {
  color: var(--vrc-warning);
}

.footer-actions {
  display: flex;
  gap: 8px;
}

.footer-actions :deep(.el-button) {
  min-width: 82px;
  height: 32px;
  margin: 0;
  font-weight: 400;
  border-radius: 4px;
}

.compact-capacity-line {
  display: flex;
  align-items: center;
  gap: 14px;
  min-height: 34px;
  padding: 0 10px;
  color: var(--vrc-text-muted);
  font-size: 11px;
  background: var(--vrc-surface-muted);
  border-radius: 5px;
}

.compact-capacity-line strong {
  font-weight: 400;
}

.compact-resource-list {
  margin-top: 10px;
  border: 1px solid var(--vrc-border);
  border-radius: 6px;
}

.compact-resource-row {
  display: grid;
  grid-template-columns: 150px minmax(240px, 1fr) 52px;
  gap: 12px;
  align-items: center;
  min-height: 64px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--vrc-border);
}

.compact-resource-row:last-child {
  border-bottom: 0;
}

.resource-identity {
  display: flex;
  align-items: center;
  gap: 10px;
}

.resource-identity > .el-icon {
  width: 30px;
  height: 30px;
  color: var(--vrc-accent);
  font-size: 17px;
  background: var(--vrc-accent-soft);
  border-radius: 5px;
}

.resource-identity span {
  display: grid;
  gap: 3px;
}

.resource-identity strong,
.resource-identity small {
  font-weight: 400;
}

.resource-identity small {
  color: var(--vrc-text-subtle);
  font-size: 10px;
}

.compact-stepper {
  display: grid;
  grid-template-columns: 30px minmax(32px, auto) 36px 30px;
  align-items: center;
  justify-content: center;
  min-height: 34px;
  overflow: hidden;
  border: 1px solid var(--vrc-border);
  border-radius: 5px;
}

.compact-resource-row > .compact-stepper {
  width: 180px;
  justify-self: end;
}

.compact-stepper button,
.delta-control button {
  display: grid;
  place-items: center;
  height: 32px;
  padding: 0;
  color: var(--vrc-text-muted);
  background: var(--vrc-surface-muted);
  border: 0;
  cursor: pointer;
}

.compact-stepper strong {
  text-align: right;
  font-size: 14px;
  font-weight: 500;
}

.compact-stepper > span {
  padding-left: 5px;
  color: var(--vrc-text-subtle);
  font-size: 10px;
}

.disk-inline-config {
  display: grid;
  grid-template-columns: minmax(178px, 1fr) 150px;
  gap: 8px;
}

.disk-inline-config :deep(.el-segmented) {
  min-width: 0;
  height: 34px;
  --el-segmented-item-selected-bg-color: var(--vrc-surface);
  --el-segmented-item-selected-color: var(--vrc-accent);
}

.disk-inline-config .compact-stepper {
  width: 150px;
}

.capability-label {
  justify-self: center;
  color: var(--vrc-text-muted);
  font-size: 10px;
  white-space: nowrap;
}

.capability-label.success {
  color: var(--vrc-success);
}

.capability-label.warning {
  color: var(--vrc-warning);
}

.compact-policy-line,
.capability-detail,
.execution-summary {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.compact-policy-line {
  min-height: 34px;
  margin-top: 10px;
  padding: 8px 10px;
  color: var(--vrc-success);
  font-size: 11px;
  background: var(--vrc-status-success-soft);
  border-radius: 5px;
}

.compact-policy-line.warning {
  color: var(--vrc-warning);
  background: var(--vrc-status-warning-soft);
}

.compare-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 230px;
  border: 1px solid var(--vrc-border);
  border-radius: 6px;
}

.compare-grid {
  display: grid;
  grid-template-columns: minmax(108px, 1fr) 84px minmax(188px, 1.45fr) 84px 56px;
  gap: 8px;
  align-items: center;
  min-height: 62px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--vrc-border);
}

.compare-grid-head {
  min-height: 34px;
  color: var(--vrc-text-subtle);
  font-size: 10px;
  text-align: center;
  background: var(--vrc-surface-muted);
}

.compare-grid-head span:first-child {
  text-align: left;
}

.compare-row:last-child {
  border-bottom: 0;
}

.compare-resource {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 400;
}

.compare-resource .el-icon {
  color: var(--vrc-accent);
  font-size: 16px;
}

.compare-row > strong {
  text-align: center;
  font-size: 14px;
  font-weight: 500;
}

.compare-row > strong small {
  color: var(--vrc-text-subtle);
  font-size: 9px;
  font-weight: 400;
}

.result-value {
  color: var(--vrc-accent);
}

.result-value em {
  display: block;
  color: var(--vrc-text-subtle);
  font-size: 9px;
  font-style: normal;
  font-weight: 400;
}

.delta-control {
  display: grid;
  grid-template-columns: 28px 1fr 28px;
  align-items: center;
  height: 32px;
  overflow: hidden;
  text-align: center;
  border: 1px solid var(--vrc-border);
  border-radius: 5px;
}

.delta-control span {
  color: var(--vrc-accent);
  font-size: 12px;
}

.compare-disk-control {
  display: grid;
  grid-template-columns: minmax(108px, 1fr) 88px;
  gap: 6px;
}

.compare-disk-control :deep(.el-segmented) {
  height: 32px;
  min-width: 0;
}

.compare-disk-control :deep(.el-segmented__item-label) {
  padding: 0 5px;
  font-size: 10px;
}

.compare-disk-control :deep(.el-input-number) {
  width: 88px;
}

.impact-panel {
  padding: 14px;
  background: var(--vrc-surface-raised);
  border-left: 1px solid var(--vrc-border);
}

.impact-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}

.impact-title span {
  color: var(--vrc-text-muted);
  font-size: 11px;
}

.impact-title strong {
  color: var(--vrc-accent);
  font-size: 11px;
  font-weight: 500;
}

.impact-panel dl {
  display: grid;
  gap: 12px;
  margin: 0;
}

.impact-panel dl div {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.impact-panel dt {
  color: var(--vrc-text-subtle);
  font-size: 10px;
}

.impact-panel dd {
  margin: 0;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.impact-divider {
  height: 1px;
  margin: 16px 0;
  background: var(--vrc-border);
}

.execution-summary {
  color: var(--vrc-success);
}

.execution-summary.warning {
  color: var(--vrc-warning);
}

.execution-summary > span {
  display: grid;
  gap: 4px;
}

.execution-summary strong {
  font-size: 11px;
  font-weight: 500;
}

.execution-summary small {
  color: var(--vrc-text-muted);
  font-size: 10px;
  line-height: 16px;
}

.advanced-layout {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  min-height: 330px;
  border: 1px solid var(--vrc-border);
  border-radius: 6px;
}

.resource-nav {
  display: grid;
  align-content: start;
  background: var(--vrc-surface-raised);
  border-right: 1px solid var(--vrc-border);
}

.resource-nav button {
  display: grid;
  grid-template-columns: 30px 1fr 18px;
  gap: 8px;
  align-items: center;
  min-height: 66px;
  padding: 10px 12px;
  text-align: left;
  color: var(--vrc-text-muted);
  background: transparent;
  border: 0;
  border-bottom: 1px solid var(--vrc-border);
  cursor: pointer;
}

.resource-nav button.active {
  color: var(--vrc-accent);
  background: var(--vrc-accent-soft);
  box-shadow: inset 3px 0 0 var(--vrc-accent);
}

.resource-nav button > .el-icon:first-child {
  width: 30px;
  height: 30px;
  font-size: 16px;
  background: var(--vrc-surface);
  border-radius: 5px;
}

.resource-nav button span {
  display: grid;
  gap: 4px;
}

.resource-nav button strong {
  color: var(--vrc-text);
  font-weight: 500;
}

.resource-nav button small {
  color: var(--vrc-text-subtle);
  font-size: 10px;
}

.nav-arrow {
  font-size: 12px;
}

.advanced-editor {
  padding: 16px 20px;
}

.advanced-editor-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--vrc-border);
}

.advanced-editor-title > div {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.advanced-editor-title span {
  color: var(--vrc-text-subtle);
  font-size: 10px;
}

.advanced-editor-title strong {
  font-size: 14px;
  font-weight: 500;
}

.large-number-control {
  display: grid;
  grid-template-columns: 38px 160px 38px;
  justify-content: center;
  margin: 34px auto 24px;
}

.large-number-control button {
  display: grid;
  place-items: center;
  color: var(--vrc-accent);
  background: var(--vrc-accent-soft);
  border: 1px solid var(--vrc-border);
  border-radius: 5px;
  cursor: pointer;
}

.large-number-control > div {
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 6px;
}

.large-number-control strong {
  font-size: 36px;
  font-weight: 400;
  font-variant-numeric: tabular-nums;
}

.large-number-control span {
  color: var(--vrc-text-subtle);
  font-size: 11px;
}

.preset-row {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.preset-row > span {
  margin-right: 4px;
  color: var(--vrc-text-subtle);
  font-size: 10px;
}

.preset-row button {
  height: 28px;
  padding: 0 10px;
  color: var(--vrc-text-muted);
  background: var(--vrc-surface);
  border: 1px solid var(--vrc-border);
  border-radius: 4px;
  cursor: pointer;
}

.preset-row button.active {
  color: var(--vrc-accent);
  background: var(--vrc-accent-soft);
  border-color: var(--vrc-accent);
}

.disk-mode-choice {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin: 18px 0;
}

.disk-mode-choice button {
  display: grid;
  grid-template-columns: 16px 1fr;
  gap: 3px 8px;
  min-height: 70px;
  padding: 12px;
  text-align: left;
  color: var(--vrc-text);
  background: var(--vrc-surface);
  border: 1px solid var(--vrc-border);
  border-radius: 6px;
  cursor: pointer;
}

.disk-mode-choice button.active {
  border-color: var(--vrc-accent);
  box-shadow: var(--vrc-focus-ring);
}

.choice-radio {
  grid-row: 1 / 3;
  width: 14px;
  height: 14px;
  margin-top: 1px;
  border: 1px solid var(--vrc-border-strong);
  border-radius: 50%;
}

.disk-mode-choice button.active .choice-radio {
  background: var(--vrc-accent);
  border: 3px solid var(--vrc-surface);
  box-shadow: 0 0 0 1px var(--vrc-accent);
}

.disk-mode-choice strong {
  font-weight: 500;
}

.disk-mode-choice small {
  color: var(--vrc-text-subtle);
  font-size: 10px;
  line-height: 15px;
}

.advanced-field {
  display: grid;
  grid-template-columns: 90px 140px 30px;
  gap: 8px;
  align-items: center;
  margin-bottom: 12px;
  color: var(--vrc-text-muted);
  font-size: 11px;
}

.advanced-field em {
  color: var(--vrc-text-subtle);
  font-size: 10px;
  font-style: normal;
}

.advanced-editor :deep(.el-checkbox__label),
.advanced-plan :deep(.el-checkbox__label) {
  color: var(--vrc-text-muted);
  font-size: 11px;
  font-weight: 400;
}

.capability-detail {
  margin-top: 18px;
  padding: 9px 10px;
  color: var(--vrc-info);
  font-size: 10px;
  line-height: 16px;
  background: var(--vrc-status-info-soft);
  border-radius: 5px;
}

.advanced-plan {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  margin-top: 10px;
  padding: 8px 12px;
  color: var(--vrc-text-muted);
  font-size: 10px;
  background: var(--vrc-surface-raised);
  border: 1px solid var(--vrc-border);
  border-radius: 6px;
}

.advanced-plan > span {
  margin-right: 4px;
  color: var(--vrc-text-subtle);
}

.advanced-plan > strong {
  color: var(--vrc-text);
  font-weight: 400;
}

.advanced-plan > .el-icon {
  color: var(--vrc-text-subtle);
  font-size: 10px;
}

.advanced-plan :deep(.el-checkbox) {
  margin-left: auto;
}

@media (max-width: 1080px) {
  .resize-prototype-shell {
    padding: 16px;
  }

  .prototype-topbar,
  .prototype-version-tabs,
  .prototype-stage {
    width: calc(100vw - 32px);
  }

  .compare-layout {
    grid-template-columns: 1fr;
  }

  .impact-panel {
    border-top: 1px solid var(--vrc-border);
    border-left: 0;
  }

  .impact-panel dl {
    grid-template-columns: repeat(3, 1fr);
  }
}
</style>
