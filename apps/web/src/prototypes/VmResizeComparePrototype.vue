<script setup lang="ts">
import { CircleCheck, Close, Coin, Cpu, Files, Minus, Plus, Warning } from "@element-plus/icons-vue";
import { computed, ref, watch } from "vue";
import VmResizeIconMark from "../components/VmResizeIconMark.vue";

type Provider = "xenserver" | "vmware" | "proxmox";
type DiskMode = "extend" | "add";
type ResourceKey = "cpu" | "memory" | "disk";

interface Capability {
  label: string;
  tone: "success" | "warning";
}

interface HostPreview {
  name: string;
  address: string;
  cpuFree: number;
  memoryFree: number;
  storageFree: number;
}

interface VmDiskPreview {
  id: string;
  device: string;
  name: string;
  sizeGiB: number;
}

const providerLabels: Record<Provider, string> = {
  xenserver: "XenServer",
  vmware: "VMware",
  proxmox: "PVE",
};

const resizeIconOptions = [
  { id: "rack-badge", label: "机架角标" },
  { id: "server-plus", label: "服务器增加" },
  { id: "rack-stack", label: "双层机架" },
  { id: "inset-plus", label: "内嵌增加" },
  { id: "node-plus", label: "节点扩容" },
  { id: "tray-plus", label: "容量托盘" },
] as const;
const selectedResizeIconId = ref<(typeof resizeIconOptions)[number]["id"]>("rack-stack");

const hosts: Record<Provider, HostPreview> = {
  xenserver: { name: "xenserver-6", address: "192.168.2.62", cpuFree: 28, memoryFree: 96, storageFree: 1380 },
  vmware: { name: "esxi-2.17", address: "192.168.2.17", cpuFree: 24, memoryFree: 82, storageFree: 1260 },
  proxmox: { name: "pve-2.20", address: "192.168.2.20", cpuFree: 36, memoryFree: 118, storageFree: 1640 },
};

const capabilityMap: Record<Provider, Record<ResourceKey, Capability>> = {
  xenserver: {
    cpu: { label: "需关机", tone: "warning" },
    memory: { label: "需关机", tone: "warning" },
    disk: { label: "可在线", tone: "success" },
  },
  vmware: {
    cpu: { label: "可在线", tone: "success" },
    memory: { label: "可在线", tone: "success" },
    disk: { label: "可在线", tone: "success" },
  },
  proxmox: {
    cpu: { label: "可在线", tone: "success" },
    memory: { label: "可在线", tone: "success" },
    disk: { label: "可在线", tone: "success" },
  },
};

const current = { cpu: 4, memory: 8 };
const selectedVm = { providerType: "xenserver" as Provider };
const provider = computed(() => selectedVm.providerType);
const cpuDelta = ref(4);
const memoryDelta = ref(8);
const diskDelta = ref(60);
const diskMode = ref<DiskMode>("extend");
const selectedDiskId = ref("disk-0");
const cpuDeltaInput = computed({
  get: () => cpuDelta.value,
  set: (value: number) => {
    cpuDelta.value = normalizeDeltaValue(value);
  },
});
const memoryDeltaInput = computed({
  get: () => memoryDelta.value,
  set: (value: number) => {
    memoryDelta.value = normalizeDeltaValue(value);
  },
});
const diskDeltaInput = computed({
  get: () => diskDelta.value,
  set: (value: number) => {
    diskDelta.value = normalizeDeltaValue(value);
  },
});

const host = computed(() => hosts[provider.value]);
const providerLabel = computed(() => providerLabels[provider.value]);
const capabilities = computed(() => capabilityMap[provider.value]);
const disks = computed<VmDiskPreview[]>(() => {
  const devices: Record<Provider, string[]> = {
    xenserver: ["xvda", "xvdb"],
    vmware: ["硬盘 1", "硬盘 2"],
    proxmox: ["scsi0", "scsi1"],
  };
  return [
    { id: "disk-0", device: devices[provider.value][0], name: "系统盘", sizeGiB: 120 },
    { id: "disk-1", device: devices[provider.value][1], name: "数据盘", sizeGiB: 500 },
  ];
});
const selectedDisk = computed(() => disks.value.find((item) => item.id === selectedDiskId.value) ?? disks.value[0]);
const currentDiskTotal = computed(() => disks.value.reduce((sum, item) => sum + item.sizeGiB, 0));
const diskSizeSummary = computed(() => disks.value.map((item) => item.sizeGiB).join(" + "));
const targetCpu = computed(() => current.cpu + cpuDelta.value);
const targetMemory = computed(() => current.memory + memoryDelta.value);
const targetDiskTotal = computed(() => currentDiskTotal.value + diskDelta.value);
const targetSelectedDiskSize = computed(() => selectedDisk.value.sizeGiB + diskDelta.value);
const diskCount = computed(() => disks.value.length + (diskMode.value === "add" ? 1 : 0));
const diskAction = computed({
  get: () => (diskMode.value === "add" ? "add" : selectedDiskId.value),
  set: (value: string) => {
    if (value === "add") {
      diskMode.value = "add";
      return;
    }
    selectedDiskId.value = value;
    diskMode.value = "extend";
  },
});
const changedCount = computed(() => Number(cpuDelta.value > 0) + Number(memoryDelta.value > 0) + Number(diskDelta.value > 0));
const requiresShutdown = computed(() =>
  (cpuDelta.value > 0 && capabilities.value.cpu.tone === "warning") ||
  (memoryDelta.value > 0 && capabilities.value.memory.tone === "warning"),
);

watch(diskMode, (mode) => {
  diskDelta.value = mode === "extend" ? 60 : 100;
});

function adjust(resource: ResourceKey, direction: number) {
  const state = resource === "cpu" ? cpuDelta : resource === "memory" ? memoryDelta : diskDelta;
  const step = resource === "cpu" ? 1 : resource === "memory" ? 2 : 20;
  state.value = Math.max(0, state.value + direction * step);
}

function normalizeDeltaValue(value: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
}

function resetPreview() {
  cpuDelta.value = 4;
  memoryDelta.value = 8;
  diskMode.value = "extend";
  diskDelta.value = 60;
  selectedDiskId.value = "disk-0";
}
</script>

<template>
  <main class="resize-compare-page">
    <header class="prototype-header">
      <div class="prototype-title">
        <span>VRC / 交互原型</span>
        <div><h1>虚拟机扩容</h1><small>变更对比方案</small></div>
      </div>
      <div class="prototype-tools">
        <button type="button" class="reset-button" @click="resetPreview">重置示例</button>
      </div>
    </header>

    <section class="icon-candidates" aria-label="扩容图标候选">
      <div class="icon-candidates-title"><strong>扩容图标</strong><span>操作列 18px 实际效果</span></div>
      <div class="icon-candidates-list">
        <button
          v-for="(option, index) in resizeIconOptions"
          :key="option.id"
          type="button"
          :class="{ active: selectedResizeIconId === option.id }"
          :aria-pressed="selectedResizeIconId === option.id"
          @click="selectedResizeIconId = option.id"
        >
          <span class="candidate-icon"><VmResizeIconMark :variant="option.id" /></span>
          <span><b>方案 {{ index + 1 }}</b><small>{{ option.label }}</small></span>
        </button>
      </div>
    </section>

    <section class="prototype-stage">
      <div class="context-table" aria-hidden="true">
        <div class="context-heading"><strong>虚拟机</strong><span>24 / 27 · {{ host.name }}</span></div>
        <div class="context-row context-row-head"><span>名称</span><span>状态</span><span>系统</span><span>vCPU</span><span>内存</span><span>磁盘</span><span>IP</span><span>操作</span></div>
        <div class="context-row"><span>127.31_业务服务</span><span class="online">运行中</span><span>CentOS 7.9</span><span>4</span><span>8 GiB</span><span>620 GiB</span><span>192.168.127.31</span><span class="context-action" title="资源扩容"><VmResizeIconMark :variant="selectedResizeIconId" /></span></div>
      </div>
      <div class="stage-mask"></div>

      <section class="resize-dialog" role="dialog" aria-modal="true" aria-labelledby="resize-title">
        <header class="dialog-header">
          <div class="dialog-title">
            <div><h2 id="resize-title">扩容虚拟机</h2><span>{{ providerLabel }}</span></div>
            <p><strong>127.31_业务服务</strong><i></i><span>{{ host.name }}</span><i></i><span>{{ host.address }}</span><i></i><span>运行中</span></p>
          </div>
          <button type="button" class="dialog-close" aria-label="关闭"><el-icon><Close /></el-icon></button>
        </header>

        <div class="dialog-body">
          <div class="capacity-strip">
            <span>宿主机可用</span>
            <dl><div><dt>CPU</dt><dd>{{ host.cpuFree }} 核</dd></div><div><dt>内存</dt><dd>{{ host.memoryFree }} GiB</dd></div><div><dt>存储</dt><dd>{{ host.storageFree }} GiB</dd></div></dl>
          </div>

          <div class="compare-layout">
            <section class="compare-table">
              <div class="compare-row compare-head"><span>资源</span><span>当前配置</span><span>增加</span><span>扩容后</span><span>执行</span></div>

              <div class="compare-row">
                <span class="resource-name"><el-icon><Cpu /></el-icon><strong>处理器</strong></span>
                <span class="current-value"><strong>{{ current.cpu }}</strong><small>vCPU</small></span>
                <div class="value-stepper" aria-label="增加处理器">
                  <button type="button" aria-label="减少处理器" @click="adjust('cpu', -1)"><el-icon><Minus /></el-icon></button>
                  <label class="stepper-input"><b aria-hidden="true">+</b><input v-model.number="cpuDeltaInput" type="number" min="0" step="1" aria-label="处理器增加量" /></label>
                  <button type="button" aria-label="增加处理器" @click="adjust('cpu', 1)"><el-icon><Plus /></el-icon></button>
                </div>
                <span class="target-value"><strong>{{ targetCpu }}</strong><small>vCPU</small></span>
                <span class="execution-state" :class="capabilities.cpu.tone">{{ capabilities.cpu.label }}</span>
              </div>

              <div class="compare-row">
                <span class="resource-name"><el-icon><Coin /></el-icon><strong>内存</strong></span>
                <span class="current-value"><strong>{{ current.memory }}</strong><small>GiB</small></span>
                <div class="value-stepper" aria-label="增加内存">
                  <button type="button" aria-label="减少内存" @click="adjust('memory', -1)"><el-icon><Minus /></el-icon></button>
                  <label class="stepper-input"><b aria-hidden="true">+</b><input v-model.number="memoryDeltaInput" type="number" min="0" step="2" aria-label="内存增加量" /></label>
                  <button type="button" aria-label="增加内存" @click="adjust('memory', 1)"><el-icon><Plus /></el-icon></button>
                </div>
                <span class="target-value"><strong>{{ targetMemory }}</strong><small>GiB</small></span>
                <span class="execution-state" :class="capabilities.memory.tone">{{ capabilities.memory.label }}</span>
              </div>

              <div class="compare-row disk-row">
                <span class="resource-name"><el-icon><Files /></el-icon><strong>虚拟硬盘</strong></span>
                <span class="current-value disk-value">
                  <span><strong>{{ currentDiskTotal }}</strong><small>GiB</small></span>
                  <em>{{ disks.length }} 块 · {{ diskSizeSummary }} GiB</em>
                </span>
                <div class="disk-adjustment">
                  <el-select v-model="diskAction" class="disk-action-select" aria-label="选择磁盘扩容方式">
                    <el-option-group label="扩展现有磁盘">
                      <el-option v-for="item in disks" :key="item.id" :label="`扩展 ${item.device} · ${item.sizeGiB} GiB`" :value="item.id">
                        <span>{{ item.device }} · {{ item.name }}</span>
                        <small>{{ item.sizeGiB }} GiB</small>
                      </el-option>
                    </el-option-group>
                    <el-option-group label="新增磁盘">
                      <el-option :label="`新增第 ${disks.length + 1} 块磁盘`" value="add" />
                    </el-option-group>
                  </el-select>
                  <div class="value-stepper disk-stepper" aria-label="增加磁盘容量">
                    <button type="button" aria-label="减少磁盘容量" @click="adjust('disk', -1)"><el-icon><Minus /></el-icon></button>
                    <label class="stepper-input"><b aria-hidden="true">+</b><input v-model.number="diskDeltaInput" type="number" min="0" step="20" aria-label="磁盘增加量" /><small>GiB</small></label>
                    <button type="button" aria-label="增加磁盘容量" @click="adjust('disk', 1)"><el-icon><Plus /></el-icon></button>
                  </div>
                </div>
                <span class="target-value disk-value">
                  <span><strong>{{ targetDiskTotal }}</strong><small>GiB</small></span>
                  <em v-if="diskMode === 'extend'">{{ selectedDisk.device }} {{ selectedDisk.sizeGiB }} → {{ targetSelectedDiskSize }}</em>
                  <em v-else>新增 {{ diskDelta }} GiB · 共 {{ diskCount }} 块</em>
                </span>
                <span class="execution-state" :class="capabilities.disk.tone">{{ capabilities.disk.label }}</span>
              </div>
            </section>

            <aside class="impact-panel">
              <div class="impact-heading"><span>资源影响</span><strong>{{ changedCount }} 项变更</strong></div>
              <dl class="impact-list">
                <div><dt>CPU 余量</dt><dd><span>{{ host.cpuFree }}</span><i>→</i><strong>{{ host.cpuFree - cpuDelta }} 核</strong></dd></div>
                <div><dt>内存余量</dt><dd><span>{{ host.memoryFree }}</span><i>→</i><strong>{{ host.memoryFree - memoryDelta }} GiB</strong></dd></div>
                <div><dt>存储余量</dt><dd><span>{{ host.storageFree }}</span><i>→</i><strong>{{ host.storageFree - diskDelta }} GiB</strong></dd></div>
              </dl>
              <div class="impact-separator"></div>
              <div class="execution-summary" :class="{ warning: requiresShutdown }">
                <el-icon><Warning v-if="requiresShutdown" /><CircleCheck v-else /></el-icon>
                <div>
                  <strong>{{ requiresShutdown ? "需要短暂停机" : "支持在线执行" }}</strong>
                  <p>{{ requiresShutdown ? "系统先正常关机，修改配置后自动开机并回读状态。" : "提交后直接调整，持续回读平台任务和虚拟机状态。" }}</p>
                </div>
              </div>
            </aside>
          </div>
        </div>

        <footer class="dialog-footer">
          <div class="change-summary"><strong>{{ changedCount }} 项资源变更</strong><span v-if="requiresShutdown">包含停机操作</span><span v-else>无需停机</span></div>
          <div class="dialog-actions"><el-button>取消</el-button><el-button type="primary">确认扩容</el-button></div>
        </footer>
      </section>
    </section>
  </main>
</template>

<style scoped>
.resize-compare-page {
  min-height: 100vh;
  padding: 20px 24px 24px;
  color: var(--vrc-text);
  background: var(--vrc-bg);
}

button {
  font: inherit;
}

.prototype-header,
.icon-candidates,
.prototype-stage {
  width: min(1380px, calc(100vw - 48px));
  margin: 0 auto;
}

.icon-candidates {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  min-height: 58px;
  padding: 8px 10px 8px 14px;
  margin-bottom: 10px;
  background: var(--vrc-surface);
  border: 1px solid var(--vrc-border);
  border-radius: 6px;
}

.icon-candidates-title { display: grid; gap: 2px; min-width: 130px; }
.icon-candidates-title strong { font-size: 13px; font-weight: 500; }
.icon-candidates-title span { color: var(--vrc-text-subtle); font-size: 10px; }
.icon-candidates-list { display: grid; grid-template-columns: repeat(6, minmax(100px, 1fr)); gap: 8px; width: min(840px, 100%); }
.icon-candidates-list button { display: flex; align-items: center; gap: 8px; min-width: 0; height: 40px; padding: 0 9px; color: var(--vrc-text-muted); text-align: left; background: var(--vrc-surface); border: 1px solid var(--vrc-border); border-radius: 4px; cursor: pointer; }
.icon-candidates-list button:hover { color: var(--vrc-accent); border-color: var(--vrc-border-strong); }
.icon-candidates-list button.active { color: var(--vrc-accent); background: var(--vrc-accent-soft); border-color: color-mix(in srgb, var(--vrc-accent) 45%, var(--vrc-border)); }
.candidate-icon { display: grid; flex: 0 0 26px; place-items: center; width: 26px; height: 26px; background: var(--vrc-surface); border: 1px solid var(--vrc-border); border-radius: 4px; }
.candidate-icon .vm-resize-icon-mark { width: 18px; height: 18px; }
.icon-candidates-list button > span:last-child { display: grid; gap: 1px; min-width: 0; }
.icon-candidates-list b { overflow: hidden; font-size: 11px; font-weight: 400; text-overflow: ellipsis; white-space: nowrap; }
.icon-candidates-list small { overflow: hidden; color: var(--vrc-text-subtle); font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }

.prototype-header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 24px;
  min-height: 58px;
  margin-bottom: 12px;
}

.prototype-title > span {
  color: var(--vrc-text-subtle);
  font-size: 11px;
}

.prototype-title > div {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-top: 2px;
}

.prototype-title h1 {
  margin: 0;
  font-size: 22px;
  font-weight: 500;
  letter-spacing: 0;
}

.prototype-title small {
  color: var(--vrc-text-muted);
  font-size: 11px;
  font-weight: 400;
}

.prototype-tools {
  display: flex;
  align-items: center;
  gap: 8px;
}

.reset-button {
  height: 30px;
  padding: 0 12px;
  color: var(--vrc-text-muted);
  font-size: 12px;
  font-weight: 400;
  background: var(--vrc-surface);
  border: 1px solid var(--vrc-border);
  border-radius: 4px;
  cursor: pointer;
}

.reset-button:hover {
  color: var(--vrc-accent);
  border-color: var(--vrc-border-strong);
}

.prototype-stage {
  position: relative;
  min-height: 740px;
  overflow: hidden;
  background: var(--vrc-surface);
  border: 1px solid var(--vrc-border);
  border-radius: 8px;
}

.context-table {
  padding: 20px;
}

.context-heading {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 12px;
}

.context-heading strong {
  font-size: 15px;
  font-weight: 500;
}

.context-heading span {
  color: var(--vrc-text-subtle);
  font-size: 11px;
}

.context-row {
  display: grid;
  grid-template-columns: minmax(190px, 1.6fr) 80px 150px 70px 80px 100px 140px 90px;
  align-items: center;
  min-height: 42px;
  padding: 0 12px;
  color: var(--vrc-text-muted);
  text-align: center;
  border-bottom: 1px solid var(--vrc-border);
}

.context-row-head {
  min-height: 40px;
  color: var(--vrc-text-muted);
  font-size: 12px;
  font-weight: 600;
  background: var(--vrc-surface-muted);
}

.context-row span:first-child {
  text-align: left;
}

.context-row .online {
  color: var(--vrc-success);
}

.context-action { display: grid; place-items: center; width: 26px; height: 26px; margin: 0 auto; color: var(--vrc-info); }
.context-action .vm-resize-icon-mark { width: 18px; height: 18px; }

.stage-mask {
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
  width: min(960px, calc(100% - 48px));
  max-height: calc(100% - 48px);
  overflow: hidden;
  background: var(--vrc-surface);
  border: 1px solid var(--vrc-border-strong);
  border-radius: 8px;
  box-shadow: 0 24px 60px rgba(31, 43, 35, 0.22);
  transform: translate(-50%, -50%);
}

.dialog-header {
  display: flex;
  flex: 0 0 auto;
  align-items: flex-start;
  justify-content: space-between;
  min-height: 68px;
  padding: 13px 14px 11px 16px;
  border-bottom: 1px solid var(--vrc-border);
}

.dialog-title > div,
.dialog-title p {
  display: flex;
  align-items: center;
}

.dialog-title > div {
  gap: 8px;
}

.dialog-title h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 400;
  line-height: 24px;
}

.dialog-title > div > span {
  padding: 1px 6px;
  color: var(--vrc-accent);
  font-size: 10px;
  line-height: 18px;
  background: var(--vrc-accent-soft);
  border-radius: 3px;
}

.dialog-title p {
  gap: 7px;
  margin: 4px 0 0;
  color: var(--vrc-text-subtle);
  font-size: 11px;
  line-height: 16px;
}

.dialog-title p strong {
  max-width: 280px;
  overflow: hidden;
  color: var(--vrc-text-muted);
  font-weight: 400;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dialog-title p i {
  width: 2px;
  height: 2px;
  background: var(--vrc-text-subtle);
  border-radius: 50%;
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
  cursor: pointer;
}

.dialog-close:hover {
  color: var(--vrc-text);
  background: var(--vrc-surface-muted);
}

.dialog-body {
  flex: 1 1 auto;
  min-height: 0;
  padding: 14px 16px 16px;
  overflow: auto;
}

.capacity-strip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 34px;
  padding: 0 10px;
  margin-bottom: 8px;
  color: var(--vrc-text-muted);
  font-size: 12px;
  background: var(--vrc-surface-muted);
  border-radius: 5px;
}

.capacity-strip > span {
  color: var(--vrc-text-subtle);
}

.capacity-strip dl,
.capacity-strip dl div {
  display: flex;
  align-items: center;
}

.capacity-strip dl {
  gap: 20px;
  margin: 0;
}

.capacity-strip dl div {
  gap: 5px;
}

.capacity-strip dt {
  color: var(--vrc-text-subtle);
}

.capacity-strip dd {
  margin: 0;
  color: var(--vrc-text);
  font-variant-numeric: tabular-nums;
}

.compare-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 224px;
  overflow: hidden;
  border: 1px solid var(--vrc-border);
  border-radius: 6px;
}

.compare-row {
  display: grid;
  grid-template-columns: minmax(112px, 1fr) 90px minmax(290px, 1.9fr) 104px 58px;
  gap: 8px;
  align-items: center;
  min-height: 64px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--vrc-border);
}

.compare-row:last-child {
  border-bottom: 0;
}

.compare-head {
  min-height: 40px;
  padding-block: 0;
  color: var(--vrc-text-muted);
  font-size: 12px;
  font-weight: 600;
  text-align: center;
  background: var(--vrc-surface-muted);
}

.compare-head span:first-child {
  text-align: left;
}

.resource-name {
  display: flex;
  align-items: center;
  gap: 8px;
}

.resource-name .el-icon {
  width: 24px;
  height: 24px;
  color: var(--vrc-accent);
  font-size: 15px;
  background: var(--vrc-accent-soft);
  border-radius: 4px;
}

.resource-name strong {
  font-size: 12px;
  font-weight: 400;
}

.current-value,
.target-value {
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 4px;
  white-space: nowrap;
}

.current-value strong,
.target-value strong {
  font-size: 14px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

.current-value small,
.target-value small {
  color: var(--vrc-text-subtle);
  font-size: 11px;
  font-weight: 400;
}

.target-value {
  color: var(--vrc-accent);
}

.disk-value {
  display: grid;
  gap: 3px;
  justify-items: center;
}

.disk-value > span {
  display: flex;
  align-items: baseline;
  gap: 4px;
}

.disk-value em {
  color: var(--vrc-text-subtle);
  font-size: 10px;
  font-style: normal;
  font-weight: 400;
  white-space: nowrap;
}

.value-stepper {
  display: grid;
  grid-template-columns: 30px minmax(52px, 1fr) 30px;
  align-items: center;
  justify-self: center;
  width: 132px;
  height: 30px;
  overflow: hidden;
  background: var(--vrc-surface);
  border: 1px solid var(--vrc-border);
  border-radius: 5px;
}

.value-stepper button {
  display: grid;
  place-items: center;
  width: 30px;
  height: 28px;
  padding: 0;
  color: var(--vrc-text-muted);
  background: var(--vrc-surface);
  border: 0;
  cursor: pointer;
}

.value-stepper button:first-child {
  border-right: 1px solid var(--vrc-border);
}

.value-stepper button:last-child {
  border-left: 1px solid var(--vrc-border);
}

.value-stepper button:hover {
  color: var(--vrc-accent);
  background: var(--vrc-accent-soft);
}

.value-stepper button .el-icon {
  font-size: 11px;
}

.stepper-input {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  min-width: 0;
  height: 28px;
  color: var(--vrc-text);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  background: var(--vrc-surface);
}

.stepper-input b {
  color: var(--vrc-text-subtle);
  font-weight: 400;
}

.stepper-input input {
  min-width: 0;
  width: 36px;
  height: 26px;
  padding: 0;
  color: var(--vrc-text);
  font: inherit;
  text-align: center;
  background: transparent;
  border: 0;
  outline: 0;
  appearance: textfield;
}

.stepper-input input::-webkit-inner-spin-button,
.stepper-input input::-webkit-outer-spin-button {
  margin: 0;
  appearance: none;
}

.stepper-input:focus-within {
  box-shadow: inset 0 0 0 1px var(--vrc-border-strong);
}

.disk-adjustment {
  display: grid;
  grid-template-columns: 156px 126px;
  gap: 8px;
  align-items: center;
}

.disk-stepper {
  width: 126px;
  grid-template-columns: 28px minmax(58px, 1fr) 28px;
}

.disk-action-select {
  width: 156px;
  --el-component-size: 30px;
}

.disk-action-select :deep(.el-select__wrapper) {
  min-height: 30px;
  height: 30px;
  padding: 0 8px;
  background: var(--vrc-surface);
  border: 1px solid var(--vrc-border);
  border-radius: 5px;
  box-shadow: none;
}

.disk-action-select :deep(.el-select__selected-item) {
  font-size: 11px;
  font-weight: 400;
}

.disk-stepper button {
  width: 28px;
}

.stepper-input small {
  margin-left: 3px;
  color: var(--vrc-text-subtle);
  font-size: 10px;
}

.disk-stepper .stepper-input input {
  width: 34px;
}


.execution-state {
  justify-self: center;
  font-size: 12px;
  font-weight: 400;
  white-space: nowrap;
}

.execution-state.success {
  color: var(--vrc-success);
}

.execution-state.warning {
  color: var(--vrc-warning);
}

.impact-panel {
  padding: 13px 14px;
  background: var(--vrc-surface-raised);
  border-left: 1px solid var(--vrc-border);
}

.impact-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}

.impact-heading span {
  color: var(--vrc-text-muted);
  font-size: 12px;
}

.impact-heading strong {
  color: var(--vrc-accent);
  font-size: 12px;
  font-weight: 500;
}

.impact-list {
  display: grid;
  gap: 12px;
  margin: 0;
}

.impact-list > div {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.impact-list dt {
  color: var(--vrc-text-subtle);
  font-size: 11px;
}

.impact-list dd {
  display: flex;
  align-items: center;
  gap: 5px;
  margin: 0;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.impact-list dd span,
.impact-list dd i {
  color: var(--vrc-text-subtle);
  font-style: normal;
}

.impact-list dd strong {
  color: var(--vrc-text);
  font-weight: 500;
}

.impact-separator {
  height: 1px;
  margin: 16px 0;
  background: var(--vrc-border);
}

.execution-summary {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr);
  gap: 8px;
  color: var(--vrc-success);
}

.execution-summary.warning {
  color: var(--vrc-warning);
}

.execution-summary .el-icon {
  margin-top: 1px;
  font-size: 14px;
}

.execution-summary strong {
  font-size: 12px;
  font-weight: 500;
}

.execution-summary p {
  margin: 4px 0 0;
  color: var(--vrc-text-muted);
  font-size: 11px;
  line-height: 16px;
}

.dialog-footer {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-height: 56px;
  padding: 10px 16px;
  background: var(--vrc-surface-raised);
  border-top: 1px solid var(--vrc-border);
}

.change-summary {
  display: flex;
  align-items: baseline;
  gap: 8px;
  color: var(--vrc-text-muted);
  font-size: 11px;
}

.change-summary strong {
  color: var(--vrc-text);
  font-size: 12px;
  font-weight: 500;
}

.change-summary span {
  color: var(--vrc-warning);
}

.dialog-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.dialog-actions :deep(.el-button) {
  min-width: 82px;
  height: 32px;
  min-height: 32px;
  margin: 0;
  padding: 0 14px;
  font-size: 12px;
  font-weight: 400;
  border-radius: 4px;
}

@media (max-width: 1080px) {
  .compare-layout {
    grid-template-columns: 1fr;
  }

  .impact-panel {
    display: grid;
    grid-template-columns: 1fr 1px 240px;
    gap: 14px;
    align-items: start;
    border-top: 1px solid var(--vrc-border);
    border-left: 0;
  }

  .impact-heading {
    grid-column: 1 / -1;
    margin-bottom: 0;
  }

  .impact-list {
    grid-template-columns: repeat(3, 1fr);
    gap: 16px;
  }

  .impact-list > div {
    display: grid;
    gap: 4px;
  }

  .impact-separator {
    width: 1px;
    height: 100%;
    margin: 0;
  }
}

@media (max-width: 760px) {
  .prototype-header {
    align-items: flex-start;
  }

  .prototype-tools {
    align-items: flex-end;
    flex-direction: column;
  }
}
</style>
