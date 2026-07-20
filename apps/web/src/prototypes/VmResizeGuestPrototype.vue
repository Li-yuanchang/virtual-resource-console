<script setup lang="ts">
import { ArrowRight, CircleCheck, Close, Coin, Cpu, Files, FolderOpened, Minus, Plus, Warning } from "@element-plus/icons-vue";
import { computed, ref } from "vue";

type MountTarget = "root" | "home";
type ResourceKey = "cpu" | "memory" | "disk";
type DiskMode = "extend" | "add";

const current = { cpu: 5, memory: 10, disk: 140 };
const host = { name: "xenserver-11", address: "192.168.129.1", memoryFree: 135.8, storageFree: 2630.9 };
const cpuDelta = ref(0);
const memoryDelta = ref(0);
const diskDelta = ref(40);
const diskMode = ref<DiskMode>("extend");
const mountTarget = ref<MountTarget>("root");
const newMountPath = ref("/data");

const mounts = [
  { id: "root" as const, path: "/", label: "根目录", lv: "centos_129-root", fs: "XFS", currentGiB: 50, usedText: "859 MiB" },
  { id: "home" as const, path: "/home", label: "用户目录", lv: "centos_129-home", fs: "XFS", currentGiB: 42, usedText: "33 MiB" },
];
const mountDirectoryCandidates = [
  { path: "/srv", label: "已识别 · 可挂载" },
  { path: "/opt", label: "已识别 · 可挂载" },
];

const selectedMount = computed(() => mounts.find((item) => item.id === mountTarget.value) ?? mounts[0]);
const selectedNewMountDirectory = computed(() => mountDirectoryCandidates.find((item) => item.path === newMountPath.value));
const targetCpu = computed(() => current.cpu + cpuDelta.value);
const targetMemory = computed(() => current.memory + memoryDelta.value);
const targetDisk = computed(() => current.disk + diskDelta.value);
const targetMountPath = computed(() => (diskMode.value === "extend" ? selectedMount.value.path : newMountPath.value.trim() || "/data"));
const targetMountCurrentSize = computed(() => (diskMode.value === "extend" ? selectedMount.value.currentGiB : 0));
const targetMountSize = computed(() => targetMountCurrentSize.value + diskDelta.value);
const changedCount = computed(() => Number(cpuDelta.value > 0) + Number(memoryDelta.value > 0) + Number(diskDelta.value > 0));
const requiresShutdown = computed(() => cpuDelta.value > 0 || memoryDelta.value > 0 || (diskMode.value === "extend" && diskDelta.value > 0));

const cpuDeltaInput = normalizedModel(cpuDelta);
const memoryDeltaInput = normalizedModel(memoryDelta);
const diskDeltaInput = normalizedModel(diskDelta);

function normalizedModel(state: typeof cpuDelta) {
  return computed({
    get: () => state.value,
    set: (value: number) => {
      const parsed = Number(value);
      state.value = Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
    },
  });
}

function adjust(resource: ResourceKey, direction: number) {
  const state = resource === "cpu" ? cpuDelta : resource === "memory" ? memoryDelta : diskDelta;
  const step = resource === "cpu" ? 1 : resource === "memory" ? 2 : 20;
  state.value = Math.max(0, state.value + direction * step);
}

function mountResult(item: (typeof mounts)[number]) {
  return item.currentGiB + (item.id === mountTarget.value ? diskDelta.value : 0);
}
</script>

<template>
  <main class="guest-resize-page">
    <header class="prototype-header">
      <div><span>VRC / 操作原型</span><h1>磁盘扩容自动生效</h1></div>
      <strong>方案二 · 指定挂载目录</strong>
    </header>

    <section class="prototype-stage">
      <div class="context-table" aria-hidden="true">
        <div class="context-heading"><strong>虚拟机</strong><span>21 / 21 · xenserver-11</span></div>
        <div class="context-row context-head"><span>名称</span><span>状态</span><span>系统</span><span>vCPU</span><span>内存</span><span>磁盘</span><span>IP</span><span>操作</span></div>
        <div class="context-row"><span>129.21_test</span><span class="online">运行中</span><span>CentOS 7.2</span><span>5</span><span>10 GiB</span><span>140 GiB</span><span>192.168.129.21</span><span>扩容</span></div>
      </div>
      <div class="stage-mask"></div>

      <section class="resize-dialog" role="dialog" aria-modal="true" aria-labelledby="guest-resize-title">
        <header class="dialog-header">
          <div class="dialog-title">
            <div><h2 id="guest-resize-title">扩容虚拟机</h2><span>XenServer</span></div>
            <p><strong>129.21_test</strong><i></i><span>{{ host.name }}</span><i></i><span>{{ host.address }}</span><i></i><span>运行中</span></p>
          </div>
          <button type="button" class="dialog-close" aria-label="关闭"><el-icon><Close /></el-icon></button>
        </header>

        <div class="dialog-body">
          <div class="capacity-strip">
            <span>宿主机可用</span>
            <dl><div><dt>CPU</dt><dd>已超配</dd></div><div><dt>内存</dt><dd>{{ host.memoryFree }} GiB</dd></div><div><dt>存储</dt><dd>{{ host.storageFree.toLocaleString() }} GiB</dd></div></dl>
          </div>

          <div class="resize-layout">
            <section class="resize-main">
              <div class="resource-grid resource-head"><span>资源</span><span>当前配置</span><span>增加</span><span>扩容后</span><span>执行</span></div>

              <div class="resource-grid resource-row">
                <span class="resource-name"><el-icon><Cpu /></el-icon><strong>处理器</strong></span>
                <span class="resource-value"><strong>{{ current.cpu }}</strong><small>vCPU</small></span>
                <div class="value-stepper"><button type="button" aria-label="减少处理器" @click="adjust('cpu', -1)"><el-icon><Minus /></el-icon></button><label><input v-model.number="cpuDeltaInput" type="number" min="0" /></label><button type="button" aria-label="增加处理器" @click="adjust('cpu', 1)"><el-icon><Plus /></el-icon></button></div>
                <span class="resource-value target"><strong>{{ targetCpu }}</strong><small>vCPU</small></span>
                <span class="execution-state" :class="cpuDelta ? 'warning' : 'success'">{{ cpuDelta ? "需关机" : "不变" }}</span>
              </div>

              <div class="resource-grid resource-row">
                <span class="resource-name"><el-icon><Coin /></el-icon><strong>内存</strong></span>
                <span class="resource-value"><strong>{{ current.memory }}</strong><small>GiB</small></span>
                <div class="value-stepper"><button type="button" aria-label="减少内存" @click="adjust('memory', -1)"><el-icon><Minus /></el-icon></button><label><input v-model.number="memoryDeltaInput" type="number" min="0" /></label><button type="button" aria-label="增加内存" @click="adjust('memory', 1)"><el-icon><Plus /></el-icon></button></div>
                <span class="resource-value target"><strong>{{ targetMemory }}</strong><small>GiB</small></span>
                <span class="execution-state" :class="memoryDelta ? 'warning' : 'success'">{{ memoryDelta ? "需关机" : "不变" }}</span>
              </div>

              <section class="disk-config-group">
                <div class="resource-grid resource-row disk-row">
                  <span class="resource-name"><el-icon><Files /></el-icon><strong>虚拟硬盘</strong></span>
                  <span class="resource-value disk"><span><strong>{{ current.disk }}</strong><small>GiB</small></span><em>1 块 · 磁盘 0</em></span>
                  <div class="value-stepper"><button type="button" aria-label="减少磁盘" @click="adjust('disk', -1)"><el-icon><Minus /></el-icon></button><label><input v-model.number="diskDeltaInput" type="number" min="0" /></label><button type="button" aria-label="增加磁盘" @click="adjust('disk', 1)"><el-icon><Plus /></el-icon></button></div>
                  <span class="resource-value disk target"><span><strong>{{ targetDisk }}</strong><small>GiB</small></span><em v-if="diskMode === 'extend'">磁盘 0 {{ current.disk }} → {{ targetDisk }}</em><em v-else>新增 {{ diskDelta }} GiB · 共 2 块</em></span>
                  <span class="execution-state" :class="diskMode === 'extend' ? 'warning' : 'online'">{{ diskMode === "extend" ? "需关机" : "可在线" }}</span>
                </div>

                <section class="guest-allocation">
                <header>
                  <div class="allocation-title"><el-icon><FolderOpened /></el-icon><span><strong>容量分配</strong><small>选择磁盘与生效目录</small></span></div>
                  <div class="allocation-tools"><label class="disk-picker"><span>磁盘</span><el-select v-model="diskMode" aria-label="选择目标磁盘">
                    <el-option-group label="现有磁盘"><el-option label="磁盘 0 · 140 GiB" value="extend"><span class="disk-option"><strong>磁盘 0</strong><small>140 GiB</small></span></el-option></el-option-group>
                    <el-option-group label="新磁盘"><el-option label="新增磁盘 · 挂载空目录" value="add"><span class="disk-option"><strong>新增磁盘</strong><small>挂载空目录</small></span></el-option></el-option-group>
                  </el-select></label><span class="auto-status"><el-icon><CircleCheck /></el-icon>自动生效</span></div>
                </header>
                <div v-if="diskMode === 'extend'" class="mount-options" role="radiogroup" aria-label="选择扩容目录">
                  <button v-for="item in mounts" :key="item.id" type="button" role="radio" :aria-checked="mountTarget === item.id" :class="{ active: mountTarget === item.id }" @click="mountTarget = item.id">
                    <span class="mount-radio"></span>
                    <span class="mount-copy"><strong>{{ item.label }} <b>{{ item.path }}</b></strong><small>{{ item.lv }} · {{ item.fs }} · 已用 {{ item.usedText }}</small></span>
                    <span class="mount-size"><small>当前</small><strong>{{ item.currentGiB }} GiB</strong></span>
                    <el-icon><ArrowRight /></el-icon>
                    <span class="mount-size result"><small>完成后</small><strong>{{ mountResult(item) }} GiB</strong></span>
                  </button>
                </div>
                <div v-else class="new-disk-mount">
                  <label class="mount-directory-field">
                    <span>空目录 / 新目录 <i>{{ selectedNewMountDirectory ? "Guest 空目录" : "将自动创建" }}</i></span>
                    <el-select v-model="newMountPath" aria-label="新磁盘挂载目录" filterable allow-create default-first-option placeholder="选择或输入目录">
                      <el-option-group label="可安全挂载">
                        <el-option label="/data" value="/data"><span class="mount-directory-option"><strong>/data</strong><small>推荐 · 自动创建</small></span></el-option>
                        <el-option v-for="directory in mountDirectoryCandidates" :key="directory.path" :label="directory.path" :value="directory.path">
                          <span class="mount-directory-option"><strong>{{ directory.path }}</strong><small>{{ directory.label }}</small></span>
                        </el-option>
                      </el-option-group>
                      <el-option-group label="已有文件系统 · 请扩展原盘">
                        <el-option v-for="mount in mounts" :key="`mounted:${mount.path}`" :label="`${mount.path} · 已有数据`" :value="`mounted:${mount.path}`" disabled>
                          <span class="mount-directory-option unavailable"><strong>{{ mount.path }}</strong><small>已有数据 · 使用扩展原盘</small></span>
                        </el-option>
                      </el-option-group>
                    </el-select>
                  </label>
                  <div><span>文件系统</span><strong>XFS</strong></div>
                  <div><span>挂载方式</span><strong>UUID / fstab</strong></div>
                  <div><span>可用容量</span><strong>{{ diskDelta }} GiB</strong></div>
                </div>
                <div v-if="diskMode === 'extend'" class="execution-chain">
                  <span><small>虚拟磁盘</small><strong>{{ current.disk }} → {{ targetDisk }} GiB</strong></span><el-icon><ArrowRight /></el-icon><span><small>末尾分区</small><strong>xvda2 扩展</strong></span><el-icon><ArrowRight /></el-icon><span><small>LVM</small><strong>PV / LV 扩展</strong></span><el-icon><ArrowRight /></el-icon><span><small>{{ selectedMount.path }}</small><strong>{{ selectedMount.currentGiB }} → {{ targetMountSize }} GiB</strong></span>
                </div>
                <div v-else class="execution-chain">
                  <span><small>虚拟磁盘</small><strong>新增 {{ diskDelta }} GiB</strong></span><el-icon><ArrowRight /></el-icon><span><small>Guest 设备</small><strong>xvdb 识别</strong></span><el-icon><ArrowRight /></el-icon><span><small>文件系统</small><strong>XFS 格式化</strong></span><el-icon><ArrowRight /></el-icon><span><small>自动挂载</small><strong>{{ targetMountPath }}</strong></span>
                </div>
                </section>
              </section>
            </section>

            <aside class="impact-panel">
              <div class="impact-heading"><span>资源影响</span><strong>{{ changedCount }} 项变更</strong></div>
              <dl>
                <div><dt>存储余量</dt><dd>{{ host.storageFree.toLocaleString() }} → <strong>{{ (host.storageFree - diskDelta).toLocaleString() }} GiB</strong></dd></div>
                <div><dt>{{ diskMode === "extend" ? "扩容目录" : "挂载目录" }}</dt><dd><strong>{{ targetMountPath }}</strong></dd></div>
                <div><dt>目录容量</dt><dd>{{ targetMountCurrentSize }} → <strong>{{ targetMountSize }} GiB</strong></dd></div>
                <div><dt>文件系统</dt><dd><strong>{{ selectedMount.fs }}</strong></dd></div>
              </dl>
              <div class="impact-separator"></div>
              <div class="execution-summary" :class="{ warning: requiresShutdown }"><el-icon><Warning v-if="requiresShutdown" /><CircleCheck v-else /></el-icon><div><strong>{{ requiresShutdown ? "需要短暂停机" : "支持在线执行" }}</strong><p>{{ diskMode === "extend" ? "正常关机后扩展原盘，开机后自动完成分区、LVM 和文件系统扩容。" : "热挂载新磁盘后自动格式化，使用 UUID 写入 fstab 并挂载。" }}</p></div></div>
              <div class="verification-list" v-if="diskMode === 'extend'"><span><el-icon><CircleCheck /></el-icon>原磁盘 UUID 不变</span><span><el-icon><CircleCheck /></el-icon>挂载点保持 {{ targetMountPath }}</span><span><el-icon><CircleCheck /></el-icon>完成后回读目录容量</span></div>
              <div class="verification-list" v-else><span><el-icon><CircleCheck /></el-icon>仅格式化新建磁盘</span><span><el-icon><CircleCheck /></el-icon>fstab 使用文件系统 UUID</span><span><el-icon><CircleCheck /></el-icon>完成后验证 {{ targetMountPath }} 已挂载</span></div>
            </aside>
          </div>
        </div>

        <footer class="dialog-footer">
          <div><strong>{{ changedCount }} 项资源变更</strong><span>{{ diskMode === "extend" ? `自动扩展 ${targetMountPath} 至 ${targetMountSize} GiB` : `新增磁盘并挂载至 ${targetMountPath}` }}</span></div>
          <div><el-button>取消</el-button><el-button type="primary" :disabled="!changedCount">确认扩容</el-button></div>
        </footer>
      </section>
    </section>
  </main>
</template>

<style scoped>
.guest-resize-page { min-height: 100vh; padding: 20px 24px 24px; color: var(--vrc-text); background: var(--vrc-bg); }
button { font: inherit; }
.prototype-header, .prototype-stage { width: min(1380px, calc(100vw - 48px)); margin: 0 auto; }
.prototype-header { display: flex; align-items: flex-end; justify-content: space-between; min-height: 58px; margin-bottom: 12px; }
.prototype-header > div > span { color: var(--vrc-text-subtle); font-size: 11px; }
.prototype-header h1 { margin: 2px 0 0; font-size: 22px; font-weight: 500; }
.prototype-header > strong { color: var(--vrc-text-muted); font-size: 12px; font-weight: 400; }
.prototype-stage { position: relative; height: calc(100vh - 108px); min-height: 620px; overflow: hidden; background: var(--vrc-surface); border: 1px solid var(--vrc-border); border-radius: 8px; }
.context-table { padding: 20px; }
.context-heading { display: flex; align-items: baseline; gap: 8px; margin-bottom: 12px; }
.context-heading strong { font-size: 15px; font-weight: 500; }
.context-heading span { color: var(--vrc-text-subtle); font-size: 11px; }
.context-row { display: grid; grid-template-columns: minmax(190px, 1.6fr) 80px 150px 70px 80px 100px 140px 90px; align-items: center; min-height: 42px; padding: 0 12px; color: var(--vrc-text-muted); text-align: center; border-bottom: 1px solid var(--vrc-border); }
.context-head { min-height: 40px; font-size: 12px; font-weight: 600; background: var(--vrc-surface-muted); }
.context-row span:first-child { text-align: left; }
.context-row .online { color: var(--vrc-success); }
.stage-mask { position: absolute; inset: 0; background: color-mix(in srgb, var(--vrc-text) 20%, transparent); backdrop-filter: blur(1px); }
.resize-dialog { position: absolute; top: 50%; left: 50%; display: flex; flex-direction: column; width: min(1020px, calc(100% - 48px)); max-height: calc(100% - 32px); overflow: hidden; background: var(--vrc-surface); border: 1px solid var(--vrc-border-strong); border-radius: 8px; box-shadow: 0 24px 60px rgba(31, 43, 35, 0.22); transform: translate(-50%, -50%); }
.dialog-header { display: flex; flex: 0 0 auto; align-items: flex-start; justify-content: space-between; min-height: 68px; padding: 13px 14px 11px 16px; border-bottom: 1px solid var(--vrc-border); }
.dialog-title > div, .dialog-title p { display: flex; align-items: center; }
.dialog-title > div { gap: 8px; }
.dialog-title h2 { margin: 0; font-size: 18px; font-weight: 400; line-height: 24px; }
.dialog-title > div > span { padding: 1px 6px; color: var(--vrc-accent); font-size: 10px; line-height: 18px; background: var(--vrc-accent-soft); border-radius: 3px; }
.dialog-title p { gap: 7px; margin: 4px 0 0; color: var(--vrc-text-subtle); font-size: 11px; }
.dialog-title p strong { color: var(--vrc-text-muted); font-weight: 400; }
.dialog-title p i { width: 2px; height: 2px; background: var(--vrc-text-subtle); border-radius: 50%; }
.dialog-close { display: grid; place-items: center; width: 30px; height: 30px; padding: 0; color: var(--vrc-text-muted); background: transparent; border: 0; border-radius: 4px; cursor: pointer; }
.dialog-close:hover { color: var(--vrc-text); background: var(--vrc-surface-muted); }
.dialog-body { flex: 1 1 auto; min-height: 0; padding: 12px 16px; overflow: auto; }
.capacity-strip { display: flex; align-items: center; justify-content: space-between; min-height: 24px; padding: 0 4px; margin-bottom: 4px; color: var(--vrc-text-muted); font-size: 11px; background: transparent; }
.capacity-strip > span, .capacity-strip dt { color: var(--vrc-text-subtle); }
.capacity-strip dl, .capacity-strip dl div { display: flex; align-items: center; }
.capacity-strip dl { gap: 12px; margin: 0; }
.capacity-strip dl div { gap: 5px; }
.capacity-strip dl div + div { padding-left: 12px; border-left: 1px solid var(--vrc-border); }
.capacity-strip dd { margin: 0; color: var(--vrc-text); }
.resize-layout { display: grid; grid-template-columns: minmax(0, 1fr) 230px; overflow: hidden; border: 1px solid var(--vrc-border); border-radius: 6px; }
.resource-grid { display: grid; grid-template-columns: minmax(112px, 1fr) 88px minmax(176px, 1.45fr) 104px 58px; gap: 8px; align-items: center; min-height: 58px; padding: 7px 12px; border-bottom: 1px solid var(--vrc-border); }
.resource-head { min-height: 36px; padding-block: 0; color: var(--vrc-text-muted); font-size: 12px; font-weight: 600; text-align: center; background: var(--vrc-surface-muted); }
.resource-head span:first-child { text-align: left; }
.resource-name { display: flex; align-items: center; gap: 8px; }
.resource-name .el-icon { width: 24px; height: 24px; color: var(--vrc-accent); font-size: 15px; background: var(--vrc-accent-soft); border-radius: 4px; }
.resource-name strong { font-size: 12px; font-weight: 400; }
.resource-value { display: flex; align-items: baseline; justify-content: center; gap: 4px; white-space: nowrap; }
.resource-value strong { font-size: 14px; font-weight: 500; }
.resource-value small { color: var(--vrc-text-subtle); font-size: 11px; }
.resource-value.target { color: var(--vrc-accent); }
.resource-value.disk { display: grid; gap: 3px; justify-items: center; }
.resource-value.disk > span { display: flex; align-items: baseline; gap: 4px; }
.resource-value em { color: var(--vrc-text-subtle); font-size: 10px; font-style: normal; }
.value-stepper { display: grid; grid-template-columns: 30px minmax(52px, 1fr) 30px; justify-self: center; width: 156px; height: 30px; overflow: hidden; background: var(--vrc-surface); border: 1px solid var(--vrc-border); border-radius: 5px; }
.value-stepper button { display: grid; place-items: center; width: 30px; height: 28px; padding: 0; color: var(--vrc-text-muted); background: var(--vrc-surface); border: 0; cursor: pointer; }
.value-stepper button:first-child { border-right: 1px solid var(--vrc-border); }
.value-stepper button:last-child { border-left: 1px solid var(--vrc-border); }
.value-stepper button:hover { color: var(--vrc-accent); background: var(--vrc-accent-soft); }
.value-stepper label { display: flex; align-items: center; justify-content: center; min-width: 0; height: 28px; }
.value-stepper input { width: 46px; height: 26px; padding: 0; color: var(--vrc-text); font: inherit; text-align: center; background: transparent; border: 0; outline: 0; appearance: textfield; }
.value-stepper input::-webkit-inner-spin-button, .value-stepper input::-webkit-outer-spin-button { margin: 0; appearance: none; }
.disk-config-group { background: var(--vrc-surface-raised); }
.disk-row { min-height: 64px; background: var(--vrc-surface-raised); border-bottom: 0; }
.execution-state { justify-self: center; font-size: 12px; white-space: nowrap; }
.execution-state.success { color: var(--vrc-text-subtle); }
.execution-state.warning { color: var(--vrc-warning); }
.execution-state.online { color: var(--vrc-success); }
.guest-allocation { padding: 8px 12px 10px; background: var(--vrc-surface-raised); border-top: 1px dashed var(--vrc-border); }
.guest-allocation > header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 9px; }
.allocation-title, .allocation-tools, .disk-picker, .auto-status { display: flex; align-items: center; }
.allocation-title { gap: 7px; }
.allocation-title > .el-icon { color: var(--vrc-accent); font-size: 16px; }
.allocation-title > span { display: flex; align-items: baseline; gap: 6px; }
.guest-allocation > header strong { font-size: 12px; font-weight: 400; }
.guest-allocation > header small { color: var(--vrc-text-subtle); font-size: 11px; font-weight: 400; }
.allocation-tools { gap: 12px; }
.disk-picker { gap: 6px; color: var(--vrc-text-subtle); font-size: 11px; font-weight: 400; }
.disk-picker > .el-select { width: 174px; --el-component-size: 28px; }
.disk-picker :deep(.el-select__wrapper) { min-height: 28px; height: 28px; padding: 0 8px; border-radius: 4px; }
.disk-picker :deep(.el-select__selected-item) { font-size: 12px; font-weight: 400; }
.disk-option { display: flex; align-items: center; justify-content: space-between; width: 100%; gap: 20px; }
.disk-option strong { font-size: 12px; font-weight: 400; }
.disk-option small { font-size: 11px; font-weight: 400; }
.auto-status { gap: 5px; color: var(--vrc-success); font-size: 12px; font-weight: 400; white-space: nowrap; }
.mount-options { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.mount-options button { display: grid; grid-template-columns: 14px minmax(0, 1fr) 52px 14px 58px; gap: 7px; align-items: center; min-width: 0; min-height: 50px; padding: 6px 9px; color: var(--vrc-text); text-align: left; background: var(--vrc-surface); border: 1px solid var(--vrc-border); border-radius: 5px; cursor: pointer; }
.mount-options button.active { background: var(--vrc-surface); border-color: color-mix(in srgb, var(--vrc-accent) 55%, var(--vrc-border)); }
.mount-radio { width: 12px; height: 12px; border: 1px solid var(--vrc-border-strong); border-radius: 50%; }
.mount-options button.active .mount-radio { background: var(--vrc-accent); border: 3px solid var(--vrc-surface); box-shadow: 0 0 0 1px var(--vrc-accent); }
.mount-copy { display: grid; gap: 2px; min-width: 0; }
.mount-copy strong { overflow: hidden; font-size: 12px; font-weight: 400; text-overflow: ellipsis; white-space: nowrap; }
.mount-copy b { margin-left: 3px; color: var(--vrc-accent); font-weight: 500; }
.mount-copy small { overflow: hidden; color: var(--vrc-text-subtle); font-size: 10px; font-weight: 400; text-overflow: ellipsis; white-space: nowrap; }
.mount-size { display: grid; gap: 1px; text-align: right; }
.mount-size small { color: var(--vrc-text-subtle); font-size: 10px; font-weight: 400; }
.mount-size strong { font-size: 12px; font-weight: 400; white-space: nowrap; }
.mount-size.result { color: var(--vrc-accent); }
.mount-options button > .el-icon { color: var(--vrc-text-subtle); font-size: 12px; }
.new-disk-mount { display: grid; grid-template-columns: minmax(190px, 1.35fr) repeat(3, minmax(92px, 1fr)); gap: 8px; }
.new-disk-mount > label, .new-disk-mount > div { display: grid; gap: 3px; min-width: 0; min-height: 50px; padding: 6px 9px; background: var(--vrc-surface); border: 1px solid var(--vrc-border); border-radius: 5px; }
.new-disk-mount span { color: var(--vrc-text-subtle); font-size: 9px; }
.mount-directory-field > span { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.mount-directory-field > span i { color: var(--vrc-success); font-style: normal; }
.new-disk-mount strong { align-self: center; font-size: 11px; font-weight: 500; }
.new-disk-mount :deep(.el-select__wrapper) { min-height: 25px; padding: 0 7px; border-radius: 4px; box-shadow: 0 0 0 1px var(--vrc-border) inset; }
.new-disk-mount :deep(.el-select__selected-item), .new-disk-mount :deep(.el-select__placeholder) { font-size: 11px; }
.mount-directory-option { display: flex; align-items: center; justify-content: space-between; width: 100%; gap: 20px; }
.mount-directory-option strong { color: var(--vrc-text); font-size: 12px; font-weight: 400; }
.mount-directory-option small { color: var(--vrc-text-subtle); font-size: 10px; }
.execution-chain { display: grid; grid-template-columns: 1fr 14px 1fr 14px 1fr 14px 1fr; gap: 5px; align-items: center; margin-top: 8px; padding: 2px 0 0; background: transparent; }
.execution-chain > span { display: grid; gap: 1px; min-width: 0; text-align: center; }
.execution-chain small { color: var(--vrc-text-subtle); font-size: 10px; font-weight: 400; }
.execution-chain strong { overflow: hidden; font-size: 11px; font-weight: 400; text-overflow: ellipsis; white-space: nowrap; }
.execution-chain > .el-icon { color: var(--vrc-text-subtle); font-size: 11px; }
.impact-panel { padding: 13px 14px; background: var(--vrc-surface-raised); border-left: 1px solid var(--vrc-border); }
.impact-heading { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; font-size: 12px; }
.impact-heading span { color: var(--vrc-text-muted); }
.impact-heading strong { color: var(--vrc-accent); font-weight: 500; }
.impact-panel dl { display: grid; gap: 12px; margin: 0; }
.impact-panel dl div { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.impact-panel dt { color: var(--vrc-text-subtle); font-size: 11px; }
.impact-panel dd { margin: 0; font-size: 11px; text-align: right; }
.impact-panel dd strong { font-weight: 500; }
.impact-separator { height: 1px; margin: 16px 0; background: var(--vrc-border); }
.execution-summary { display: grid; grid-template-columns: 16px minmax(0, 1fr); gap: 8px; color: var(--vrc-warning); }
.execution-summary strong { font-size: 12px; font-weight: 500; }
.execution-summary p { margin: 4px 0 0; color: var(--vrc-text-muted); font-size: 10px; line-height: 16px; }
.verification-list { display: grid; gap: 7px; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--vrc-border); }
.verification-list span { display: flex; align-items: center; gap: 6px; color: var(--vrc-text-muted); font-size: 10px; }
.verification-list .el-icon { color: var(--vrc-success); }
.dialog-footer { display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between; gap: 16px; min-height: 56px; padding: 10px 16px; background: var(--vrc-surface-raised); border-top: 1px solid var(--vrc-border); }
.dialog-footer > div { display: flex; align-items: center; gap: 8px; }
.dialog-footer strong { font-size: 12px; font-weight: 500; }
.dialog-footer span { color: var(--vrc-warning); font-size: 11px; }
.dialog-footer :deep(.el-button) { min-width: 82px; height: 32px; margin: 0; font-weight: 400; border-radius: 4px; }
@media (max-width: 900px) { .resize-layout { grid-template-columns: 1fr; } .impact-panel { border-top: 1px solid var(--vrc-border); border-left: 0; } .mount-options { grid-template-columns: 1fr; } .new-disk-mount { grid-template-columns: 1fr 1fr; } }
</style>
