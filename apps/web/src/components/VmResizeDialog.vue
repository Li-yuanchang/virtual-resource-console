<script setup lang="ts">
import { ArrowRight, CircleCheck, Coin, Cpu, Files, FolderOpened, Minus, Plus, Warning } from "@element-plus/icons-vue";
import { computed, ref, watch } from "vue";
import type { GuestStorageInventory, HostNode, ProviderType, VmDisk, VmNode, VmResizeRequest } from "../types";

type ResourceKey = "cpu" | "memory" | "disk";

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    vm: VmNode | null;
    host: HostNode | null;
    providerType: ProviderType;
    disks?: VmDisk[];
    loadingDisks?: boolean;
    guestStorage?: GuestStorageInventory | null;
    loadingGuestStorage?: boolean;
    guestStorageError?: string;
    saving?: boolean;
    cpuFree?: number;
    cpuOvercommitted?: boolean;
    memoryFreeGiB?: number;
    storageFreeGiB?: number;
  }>(),
  {
    disks: () => [],
    loadingDisks: false,
    guestStorage: null,
    loadingGuestStorage: false,
    guestStorageError: "",
    saving: false,
    cpuFree: 0,
    cpuOvercommitted: false,
    memoryFreeGiB: 0,
    storageFreeGiB: 0,
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  "load-disks": [vm: VmNode];
  "load-guest-storage": [vm: VmNode];
  submit: [request: VmResizeRequest];
}>();

const gib = 1024 ** 3;
const cpuDelta = ref(0);
const memoryDelta = ref(0);
const diskDelta = ref(0);
const diskMode = ref<"extend" | "add">("extend");
const selectedDiskId = ref("");
const selectedMountPath = ref("");
const newMountPath = ref("/data");

const providerLabels: Record<ProviderType, string> = {
  xenserver: "XenServer",
  vmware: "VMware",
  proxmox: "PVE",
  libvirt: "KVM/libvirt",
};

const cpuDeltaInput = normalizedModel(cpuDelta);
const memoryDeltaInput = normalizedModel(memoryDelta);
const diskDeltaInput = normalizedModel(diskDelta);
const currentMemoryGiB = computed(() => Math.round((props.vm?.memoryBytes ?? 0) / gib));
const currentDiskTotalGiB = computed(() => Math.round(props.disks.reduce((sum, disk) => sum + disk.virtualSizeBytes, 0) / gib));
const diskSizeSummary = computed(() => props.disks.map((disk) => formatGiB(disk.virtualSizeBytes)).join(" + "));
const selectedDisk = computed(() => props.disks.find((disk) => disk.id === selectedDiskId.value) ?? props.disks[0] ?? null);
const matchingGuestMounts = computed(() =>
  props.guestStorage?.mounts.filter((mount) => mount.platformDiskId === selectedDisk.value?.id) ?? [],
);
const selectedGuestMount = computed(() =>
  matchingGuestMounts.value.find((mount) => mount.mountPath === selectedMountPath.value) ?? matchingGuestMounts.value[0] ?? null,
);
const pendingCapacityBytes = computed(() => Math.max(0, selectedGuestMount.value?.pendingCapacityBytes ?? 0));
const hasPendingCapacity = computed(() => diskMode.value === "extend" && pendingCapacityBytes.value > 512 * 1024 ** 2);
const reconcileExistingCapacity = computed(() => hasPendingCapacity.value && diskDelta.value === 0);
const diskChangeActive = computed(() => diskDelta.value > 0 || reconcileExistingCapacity.value);
const detectedNewMountDirectory = computed(() => props.guestStorage?.directories.find((item) => item.path === newMountPath.value));
const targetCpu = computed(() => (props.vm?.cpuCount ?? 0) + cpuDelta.value);
const targetMemoryGiB = computed(() => currentMemoryGiB.value + memoryDelta.value);
const targetDiskTotalGiB = computed(() => currentDiskTotalGiB.value + diskDelta.value);
const targetSelectedDiskGiB = computed(() => formatGiB(selectedDisk.value?.virtualSizeBytes ?? 0) + diskDelta.value);
const diskCount = computed(() => props.disks.length + (diskMode.value === "add" ? 1 : 0));
const changedCount = computed(() => Number(cpuDelta.value > 0) + Number(memoryDelta.value > 0) + Number(diskChangeActive.value));
const supported = computed(() => props.providerType !== "libvirt");
const diskRequiresShutdown = computed(() =>
  props.vm?.powerState === "running" &&
  diskDelta.value > 0 &&
  diskMode.value === "extend" &&
  props.providerType === "xenserver" &&
  selectedDisk.value?.onlineResizeSupported !== true,
);
const requiresShutdown = computed(() =>
  props.vm?.powerState === "running" && (cpuDelta.value > 0 || memoryDelta.value > 0 || diskRequiresShutdown.value),
);
const guestAutoApplyAvailable = computed(() => props.guestStorage?.supported === true);
const diskAutoApplyBlocked = computed(() => diskDelta.value > 0 && !props.loadingGuestStorage && !guestAutoApplyAvailable.value);
const guestStorageValidationError = computed(() => {
  if (!diskChangeActive.value) return "";
  if (props.loadingGuestStorage || !guestAutoApplyAvailable.value) return "";
  if (diskMode.value === "extend" && !selectedGuestMount.value) return "所选虚拟磁盘没有匹配到可扩容的 Guest 目录";
  if (diskMode.value === "add" && !isAllowedNewMountPath(newMountPath.value)) return "新磁盘挂载目录仅允许位于 /data、/mnt、/srv 或 /opt 下";
  return "";
});
const capacityError = computed(() => {
  if (memoryDelta.value > props.memoryFreeGiB) return `内存增加量超过宿主机当前余量 ${formatNumber(props.memoryFreeGiB)} GiB`;
  if (diskDelta.value > props.storageFreeGiB) return `磁盘增加量超过存储当前余量 ${formatNumber(props.storageFreeGiB)} GiB`;
  if (diskDelta.value > 0 && diskMode.value === "extend" && !selectedDisk.value) return "扩展原盘需要选择目标磁盘";
  if (diskDelta.value > 0 && diskMode.value === "add" && !defaultStorageRepositoryId.value) return "新增磁盘需要可用的存储 SR";
  return "";
});
const canSubmit = computed(
  () =>
    supported.value &&
    !props.loadingDisks &&
    !props.loadingGuestStorage &&
    !props.saving &&
    changedCount.value > 0 &&
    !diskAutoApplyBlocked.value &&
    !capacityError.value &&
    !guestStorageValidationError.value,
);
const defaultStorageRepositoryId = computed(() => selectedDisk.value?.storageRepositoryId || props.disks.find((disk) => disk.storageRepositoryId)?.storageRepositoryId || "");
const cpuCapacityText = computed(() => (props.cpuOvercommitted ? "已超配" : `${formatNumber(props.cpuFree)} 核`));
const diskAction = computed({
  get: () => (diskMode.value === "add" ? "add" : selectedDiskId.value),
  set: (value: string) => {
    if (value === "add") {
      diskMode.value = "add";
      if (!diskDelta.value) diskDelta.value = 20;
      return;
    }
    selectedDiskId.value = value;
    diskMode.value = "extend";
  },
});

watch(
  () => props.modelValue,
  (visible) => {
    if (!visible || !props.vm) return;
    resetForm();
    emit("load-disks", props.vm);
    emit("load-guest-storage", props.vm);
  },
);

watch(
  () => props.disks,
  (disks) => {
    if (!selectedDiskId.value || !disks.some((disk) => disk.id === selectedDiskId.value)) {
      selectedDiskId.value = disks[0]?.id ?? "";
    }
  },
  { immediate: true },
);

watch(
  [() => props.guestStorage, selectedDiskId, diskMode],
  () => {
    if (diskMode.value === "extend") {
      if (!matchingGuestMounts.value.some((mount) => mount.mountPath === selectedMountPath.value)) {
        selectedMountPath.value = matchingGuestMounts.value[0]?.mountPath ?? "";
      }
    }
  },
  { immediate: true },
);

function normalizedModel(state: typeof cpuDelta) {
  return computed({
    get: () => state.value,
    set: (value: number) => {
      const parsed = Number(value);
      state.value = Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
    },
  });
}

function resetForm() {
  cpuDelta.value = 0;
  memoryDelta.value = 0;
  diskDelta.value = 0;
  diskMode.value = "extend";
  selectedDiskId.value = props.disks[0]?.id ?? "";
  selectedMountPath.value = "";
  newMountPath.value = "/data";
}

function adjust(resource: ResourceKey, direction: number) {
  const state = resource === "cpu" ? cpuDelta : resource === "memory" ? memoryDelta : diskDelta;
  const step = resource === "cpu" ? 1 : resource === "memory" ? 2 : 20;
  state.value = Math.max(0, state.value + direction * step);
}

function close() {
  if (props.saving) return;
  emit("update:modelValue", false);
}

function submit() {
  if (!canSubmit.value || !props.vm) return;
  const request: VmResizeRequest = {
    cpuCount: cpuDelta.value > 0 ? targetCpu.value : undefined,
    memoryBytes: memoryDelta.value > 0 ? targetMemoryGiB.value * gib : undefined,
    allowShutdown: requiresShutdown.value,
    restartAfterResize: true,
  };
  if (diskChangeActive.value) {
    request.disk =
      diskMode.value === "extend"
        ? {
            mode: "extend",
            diskId: selectedDisk.value?.id,
            sizeBytes: (formatGiB(selectedDisk.value?.virtualSizeBytes ?? 0) + diskDelta.value) * gib,
          }
        : {
            mode: "add",
            storageRepositoryId: defaultStorageRepositoryId.value,
            sizeBytes: diskDelta.value * gib,
            name: `${props.vm.name} data disk`,
          };
    if (guestAutoApplyAvailable.value) {
      const guestMount = diskMode.value === "extend" ? selectedGuestMount.value : null;
      request.guestStorage = {
        vmIp: props.guestStorage?.vmIp ?? "",
        mountPath: diskMode.value === "extend" ? guestMount?.mountPath ?? "" : normalizeMountPath(newMountPath.value),
        guestDiskPath: guestMount?.guestDiskPath,
        guestPartitionPath: guestMount?.guestPartitionPath,
        filesystem: guestMount?.filesystem || "xfs",
      };
    }
  }
  emit("submit", request);
}

function formatGiB(value: number) {
  return Math.round(value / gib);
}

function diskDeviceLabel(disk: VmDisk) {
  if (props.providerType === "xenserver" && /^\d+$/.test(disk.device)) return `磁盘 ${disk.device}`;
  return disk.device || disk.name || "虚拟硬盘";
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(Math.max(value, 0));
}

function normalizeMountPath(value: string) {
  return value.trim().replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
}

function isAllowedNewMountPath(value: string) {
  return /^\/(?:data|mnt|srv|opt)(?:\/[A-Za-z0-9._-]+)*$/.test(normalizeMountPath(value));
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="扩容虚拟机"
    width="960px"
    class="vm-resize-dialog"
    top="6vh"
    append-to-body
    destroy-on-close
    :close-on-click-modal="false"
    :close-on-press-escape="!saving"
    :show-close="!saving"
    @close="close"
  >
    <template #header>
      <div class="vm-resize-title">
        <div><h2>扩容虚拟机</h2><span>{{ providerLabels[providerType] }}</span></div>
        <p v-if="vm"><strong>{{ vm.name }}</strong><i></i><span>{{ host?.name }}</span><i></i><span>{{ host?.address }}</span><i></i><span>{{ vm.powerState === "running" ? "运行中" : "已关机" }}</span></p>
      </div>
    </template>

    <div v-if="vm" class="vm-resize-content">
      <div class="vm-resize-capacity">
        <span>宿主机可用</span>
        <dl><div><dt>CPU</dt><dd :class="{ warning: cpuOvercommitted }">{{ cpuCapacityText }}</dd></div><div><dt>内存</dt><dd>{{ formatNumber(memoryFreeGiB) }} GiB</dd></div><div><dt>存储</dt><dd>{{ formatNumber(storageFreeGiB) }} GiB</dd></div></dl>
      </div>

      <div class="vm-resize-layout">
        <section class="vm-resize-table">
          <div class="vm-resize-row vm-resize-head"><span>资源</span><span>当前配置</span><span>增加</span><span>扩容后</span><span>执行</span></div>

          <div class="vm-resize-row">
            <span class="vm-resize-resource"><el-icon><Cpu /></el-icon><strong>处理器</strong></span>
            <span class="vm-resize-value"><strong>{{ vm.cpuCount }}</strong><small>vCPU</small></span>
            <div class="vm-resize-stepper"><button type="button" aria-label="减少处理器" @click="adjust('cpu', -1)"><el-icon><Minus /></el-icon></button><label><input v-model.number="cpuDeltaInput" type="number" min="0" step="1" aria-label="处理器增加量" /></label><button type="button" aria-label="增加处理器" @click="adjust('cpu', 1)"><el-icon><Plus /></el-icon></button></div>
            <span class="vm-resize-value target"><strong>{{ targetCpu }}</strong><small>vCPU</small></span>
            <span class="vm-resize-state" :class="requiresShutdown && cpuDelta ? 'warning' : 'success'">{{ requiresShutdown && cpuDelta ? "需关机" : "可在线" }}</span>
          </div>

          <div class="vm-resize-row">
            <span class="vm-resize-resource"><el-icon><Coin /></el-icon><strong>内存</strong></span>
            <span class="vm-resize-value"><strong>{{ currentMemoryGiB }}</strong><small>GiB</small></span>
            <div class="vm-resize-stepper"><button type="button" aria-label="减少内存" @click="adjust('memory', -1)"><el-icon><Minus /></el-icon></button><label><input v-model.number="memoryDeltaInput" type="number" min="0" step="2" aria-label="内存增加量" /></label><button type="button" aria-label="增加内存" @click="adjust('memory', 1)"><el-icon><Plus /></el-icon></button></div>
            <span class="vm-resize-value target"><strong>{{ targetMemoryGiB }}</strong><small>GiB</small></span>
            <span class="vm-resize-state" :class="requiresShutdown && memoryDelta ? 'warning' : 'success'">{{ requiresShutdown && memoryDelta ? "需关机" : "可在线" }}</span>
          </div>

          <section class="vm-resize-disk-group">
            <div class="vm-resize-row vm-resize-disk-row">
              <span class="vm-resize-resource"><el-icon><Files /></el-icon><strong>虚拟硬盘</strong></span>
              <span class="vm-resize-value disk"><span><strong>{{ currentDiskTotalGiB }}</strong><small>GiB</small></span><em>{{ disks.length }} 块 · {{ diskSizeSummary || "读取中" }}<template v-if="diskSizeSummary"> GiB</template></em></span>
              <div class="vm-resize-stepper disk"><button type="button" aria-label="减少磁盘" @click="adjust('disk', -1)"><el-icon><Minus /></el-icon></button><label><input v-model.number="diskDeltaInput" type="number" min="0" step="20" aria-label="磁盘增加量" /></label><button type="button" aria-label="增加磁盘" @click="adjust('disk', 1)"><el-icon><Plus /></el-icon></button></div>
              <span class="vm-resize-value disk target"><span><strong>{{ targetDiskTotalGiB }}</strong><small>GiB</small></span><em v-if="diskMode === 'extend' && selectedDisk">{{ diskDeviceLabel(selectedDisk) }} {{ formatGiB(selectedDisk.virtualSizeBytes) }} → {{ targetSelectedDiskGiB }}</em><em v-else>新增 {{ diskDelta }} GiB · 共 {{ diskCount }} 块</em></span>
              <span class="vm-resize-state" :class="diskRequiresShutdown || reconcileExistingCapacity ? 'warning' : 'success'">{{ diskRequiresShutdown ? "需关机" : reconcileExistingCapacity ? "待生效" : "可在线" }}</span>
            </div>

            <section class="vm-resize-guest">
            <header>
              <div class="vm-resize-guest-title"><el-icon><FolderOpened /></el-icon><span><strong>容量分配</strong><small>选择磁盘与生效目录</small></span></div>
              <div class="vm-resize-guest-tools">
                <label class="vm-resize-disk-picker"><span>磁盘</span><el-select v-model="diskAction" aria-label="选择目标磁盘" :loading="loadingDisks" :disabled="loadingDisks || !disks.length">
                  <el-option-group label="现有磁盘">
                    <el-option v-for="disk in disks" :key="disk.id" :label="`${diskDeviceLabel(disk)} · ${formatGiB(disk.virtualSizeBytes)} GiB`" :value="disk.id"><span class="vm-resize-disk-option"><strong>{{ diskDeviceLabel(disk) }}</strong><small>{{ formatGiB(disk.virtualSizeBytes) }} GiB</small></span></el-option>
                  </el-option-group>
                  <el-option-group label="新磁盘"><el-option label="新增磁盘 · 挂载空目录" value="add"><span class="vm-resize-disk-option"><strong>新增磁盘</strong><small>挂载空目录</small></span></el-option></el-option-group>
                </el-select></label>
                <span v-if="guestStorage?.supported" class="vm-resize-auto"><el-icon><CircleCheck /></el-icon>自动生效</span>
                <span v-if="reconcileExistingCapacity" class="vm-resize-pending">待分配 {{ formatGiB(pendingCapacityBytes) }} GiB</span>
              </div>
            </header>

            <div v-if="loadingGuestStorage" class="vm-resize-guest-state"><span class="vm-resize-state-loader"></span><strong>正在识别真实磁盘、分区和目录</strong></div>
            <div v-else-if="!guestStorage?.supported" class="vm-resize-guest-state platform-only" :title="guestStorageError">
              <el-icon><Warning /></el-icon>
              <div><strong>{{ diskMode === "add" ? "仅创建虚拟磁盘" : "仅扩展虚拟硬盘" }}</strong><small>{{ diskMode === "add" ? "初始化与挂载需在系统内完成" : "分区与文件系统需在系统内完成" }}</small></div>
            </div>

            <template v-else-if="diskMode === 'extend'">
              <div v-if="matchingGuestMounts.length" class="vm-resize-mounts" role="radiogroup" aria-label="选择扩容目录">
                <button v-for="mount in matchingGuestMounts" :key="mount.mountPath" type="button" role="radio" :aria-checked="selectedGuestMount?.mountPath === mount.mountPath" :class="{ active: selectedGuestMount?.mountPath === mount.mountPath }" @click="selectedMountPath = mount.mountPath">
                  <span class="vm-resize-radio"></span>
                  <span class="vm-resize-mount-copy"><strong>{{ mount.mountPath === "/" ? "根目录" : mount.mountPath }}</strong><small>{{ mount.source }} · {{ mount.filesystem.toUpperCase() }}</small></span>
                  <span class="vm-resize-mount-size"><small>当前</small><strong>{{ formatGiB(mount.sizeBytes) }} GiB</strong></span>
                  <el-icon><ArrowRight /></el-icon>
                  <span class="vm-resize-mount-size target"><small>完成后</small><strong>{{ formatGiB(mount.sizeBytes + mount.pendingCapacityBytes) + diskDelta }} GiB</strong></span>
                </button>
              </div>
              <div v-else class="vm-resize-guest-state error"><el-icon><Warning /></el-icon><strong>该虚拟磁盘没有匹配到可扩容目录</strong></div>
              <div v-if="selectedGuestMount" class="vm-resize-chain">
                <span><small>虚拟磁盘</small><strong>{{ selectedGuestMount.guestDiskPath }}</strong></span><el-icon><ArrowRight /></el-icon>
                <span><small>末尾分区</small><strong>{{ selectedGuestMount.guestPartitionPath || "整盘" }}</strong></span><el-icon><ArrowRight /></el-icon>
                <span><small>{{ selectedGuestMount.logicalVolume ? "LVM" : "文件系统" }}</small><strong>{{ selectedGuestMount.logicalVolume ? "PV / LV 扩展" : "分区扩展" }}</strong></span><el-icon><ArrowRight /></el-icon>
                <span><small>自动生效</small><strong>{{ selectedGuestMount.mountPath }}</strong></span>
              </div>
            </template>

            <template v-else>
              <div class="vm-resize-new-mount">
                <label class="vm-resize-directory-field">
                  <span>空目录 / 新目录 <i>{{ detectedNewMountDirectory ? "Guest 空目录" : "将自动创建" }}</i></span>
                  <el-select v-model="newMountPath" aria-label="新磁盘挂载目录" filterable allow-create default-first-option placeholder="选择或输入目录">
                    <el-option-group label="可安全挂载">
                      <el-option v-if="!guestStorage.directories.some((directory) => directory.path === '/data')" label="/data" value="/data">
                        <span class="vm-resize-directory-option"><strong>/data</strong><small>推荐 · 自动创建</small></span>
                      </el-option>
                      <el-option v-for="directory in guestStorage.directories" :key="directory.path" :label="directory.path" :value="directory.path">
                        <span class="vm-resize-directory-option"><strong>{{ directory.path }}</strong><small>真实空目录 · 可挂载</small></span>
                      </el-option>
                    </el-option-group>
                    <el-option-group v-if="guestStorage.mounts.length" label="已有文件系统 · 请扩展原盘">
                      <el-option v-for="mount in guestStorage.mounts" :key="`mounted:${mount.mountPath}`" :label="`${mount.mountPath} · 已有数据`" :value="`mounted:${mount.mountPath}`" disabled>
                        <span class="vm-resize-directory-option unavailable"><strong>{{ mount.mountPath }}</strong><small>已有数据 · 使用扩展原盘</small></span>
                      </el-option>
                    </el-option-group>
                  </el-select>
                </label>
                <div><span>文件系统</span><strong>XFS</strong></div>
                <div><span>挂载方式</span><strong>UUID / fstab</strong></div>
                <div><span>可用容量</span><strong>{{ diskDelta }} GiB</strong></div>
              </div>
              <div class="vm-resize-chain">
                <span><small>虚拟磁盘</small><strong>新增 {{ diskDelta }} GiB</strong></span><el-icon><ArrowRight /></el-icon>
                <span><small>Guest 设备</small><strong>自动识别</strong></span><el-icon><ArrowRight /></el-icon>
                <span><small>文件系统</small><strong>XFS 格式化</strong></span><el-icon><ArrowRight /></el-icon>
                <span><small>自动挂载</small><strong>{{ normalizeMountPath(newMountPath) }}</strong></span>
              </div>
            </template>
            </section>
          </section>
        </section>

        <aside class="vm-resize-impact">
          <div class="vm-resize-impact-head"><span>资源影响</span><strong>{{ changedCount }} 项变更</strong></div>
          <dl><div><dt>CPU 容量</dt><dd v-if="cpuOvercommitted">已超配 → <strong>平台校验</strong></dd><dd v-else>{{ formatNumber(cpuFree) }} → <strong>{{ cpuDelta ? "平台校验" : `${formatNumber(cpuFree)} 核` }}</strong></dd></div><div><dt>内存余量</dt><dd>{{ formatNumber(memoryFreeGiB) }} → <strong>{{ formatNumber(memoryFreeGiB - memoryDelta) }} GiB</strong></dd></div><div><dt>存储余量</dt><dd>{{ formatNumber(storageFreeGiB) }} → <strong>{{ formatNumber(storageFreeGiB - diskDelta) }} GiB</strong></dd></div></dl>
          <div class="vm-resize-divider"></div>
          <div class="vm-resize-execution" :class="{ warning: requiresShutdown || diskAutoApplyBlocked }"><el-icon><Warning v-if="requiresShutdown || diskAutoApplyBlocked" /><CircleCheck v-else /></el-icon><div><strong>{{ requiresShutdown ? "需要短暂停机" : diskAutoApplyBlocked ? "自动生效不可用" : reconcileExistingCapacity ? "完成未生效容量" : "支持在线执行" }}</strong><p>{{ requiresShutdown ? "系统先正常关机，修改配置后自动开机并回读状态。" : diskAutoApplyBlocked ? "未读取到系统磁盘，暂不允许只扩虚拟硬件。" : reconcileExistingCapacity ? "无需再次增加虚拟磁盘，直接扩展所选目录并回读容量。" : "提交后持续回读平台和系统内容量。" }}</p></div></div>
        </aside>
      </div>
      <p v-if="capacityError" class="vm-resize-error">{{ capacityError }}</p>
    </div>

    <template #footer>
      <div class="vm-resize-footer">
        <div><strong>{{ changedCount }} 项资源变更</strong><span>{{ requiresShutdown ? "包含停机操作" : diskAutoApplyBlocked ? "等待系统连接" : "自动生效并回读" }}</span></div>
        <div><el-button :disabled="saving" @click="close">取消</el-button><el-button type="primary" :loading="saving" :disabled="!canSubmit" @click="submit">{{ reconcileExistingCapacity ? "完成扩容" : "确认扩容" }}</el-button></div>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
:global(.vm-resize-dialog) { max-width: calc(100vw - 32px); padding: 0; border-radius: 8px; }
:global(.vm-resize-dialog .el-dialog__header) { min-height: 68px; padding: 13px 46px 11px 16px; margin: 0; border-bottom: 1px solid var(--vrc-border); }
:global(.vm-resize-dialog .el-dialog__headerbtn) { top: 7px; right: 7px; width: 32px; height: 32px; }
:global(.vm-resize-dialog .el-dialog__body), :global(.vm-resize-dialog .el-dialog__footer) { padding: 0; }
.vm-resize-title > div, .vm-resize-title p, .vm-resize-capacity, .vm-resize-capacity dl, .vm-resize-capacity dl div, .vm-resize-value, .vm-resize-value > span { display: flex; align-items: center; }
.vm-resize-title > div { gap: 8px; }
.vm-resize-title h2 { margin: 0; font-size: 18px; font-weight: 400; line-height: 24px; }
.vm-resize-title > div > span { padding: 1px 6px; color: var(--vrc-accent); font-size: 10px; line-height: 18px; background: var(--vrc-accent-soft); border-radius: 3px; }
.vm-resize-title p { gap: 7px; margin: 4px 0 0; color: var(--vrc-text-subtle); font-size: 11px; }
.vm-resize-title p strong { max-width: 280px; overflow: hidden; color: var(--vrc-text-muted); font-weight: 400; text-overflow: ellipsis; white-space: nowrap; }
.vm-resize-title p i { width: 2px; height: 2px; background: var(--vrc-text-subtle); border-radius: 50%; }
.vm-resize-content { padding: 14px 16px 16px; }
.vm-resize-capacity { justify-content: space-between; min-height: 24px; padding: 0 4px; margin-bottom: 4px; color: var(--vrc-text-muted); font-size: 11px; background: transparent; }
.vm-resize-capacity > span, .vm-resize-capacity dt { color: var(--vrc-text-subtle); }
.vm-resize-capacity dl { gap: 12px; margin: 0; }
.vm-resize-capacity dl div { gap: 5px; }
.vm-resize-capacity dl div + div { padding-left: 12px; border-left: 1px solid var(--vrc-border); }
.vm-resize-capacity dd { margin: 0; color: var(--vrc-text); }
.vm-resize-capacity dd.warning { color: var(--vrc-warning); }
.vm-resize-error { margin: 0 0 8px; padding: 8px 10px; color: var(--vrc-warning); font-size: 11px; background: var(--vrc-status-warning-soft); border-radius: 5px; }
.vm-resize-layout { display: grid; grid-template-columns: minmax(0, 1fr) 224px; overflow: hidden; border: 1px solid var(--vrc-border); border-radius: 6px; }
.vm-resize-row { display: grid; grid-template-columns: minmax(112px, 1fr) 90px minmax(180px, 1.5fr) 104px 58px; gap: 8px; align-items: center; min-height: 64px; padding: 8px 12px; border-bottom: 1px solid var(--vrc-border); }
.vm-resize-row:last-child { border-bottom: 0; }
.vm-resize-head { min-height: 40px; padding-block: 0; color: var(--vrc-text-muted); font-size: 12px; font-weight: 600; text-align: center; background: var(--vrc-surface-muted); }
.vm-resize-head span:first-child { text-align: left; }
.vm-resize-resource { display: flex; align-items: center; gap: 8px; }
.vm-resize-resource .el-icon { width: 24px; height: 24px; color: var(--vrc-accent); font-size: 15px; background: var(--vrc-accent-soft); border-radius: 4px; }
.vm-resize-resource strong { font-size: 12px; font-weight: 400; }
.vm-resize-value { justify-content: center; gap: 4px; white-space: nowrap; }
.vm-resize-value strong { font-size: 14px; font-weight: 500; }
.vm-resize-value small { color: var(--vrc-text-subtle); font-size: 11px; }
.vm-resize-value.target { color: var(--vrc-accent); }
.vm-resize-value.disk { display: grid; gap: 3px; justify-items: center; }
.vm-resize-value.disk > span { gap: 4px; }
.vm-resize-value em { color: var(--vrc-text-subtle); font-size: 10px; font-style: normal; font-weight: 400; }
.vm-resize-stepper { display: grid; grid-template-columns: 30px minmax(52px, 1fr) 30px; justify-self: center; width: 156px; height: 30px; overflow: hidden; background: var(--vrc-surface); border: 1px solid var(--vrc-border); border-radius: 5px; }
.vm-resize-stepper button { display: grid; place-items: center; width: 30px; height: 28px; padding: 0; color: var(--vrc-text-muted); background: var(--vrc-surface); border: 0; cursor: pointer; }
.vm-resize-stepper button:first-child { border-right: 1px solid var(--vrc-border); }
.vm-resize-stepper button:last-child { border-left: 1px solid var(--vrc-border); }
.vm-resize-stepper button:hover { color: var(--vrc-accent); background: var(--vrc-accent-soft); }
.vm-resize-stepper label { display: flex; align-items: center; justify-content: center; gap: 2px; min-width: 0; height: 28px; background: var(--vrc-surface); }
.vm-resize-stepper label:focus-within { box-shadow: inset 0 0 0 1px var(--vrc-border-strong); }
.vm-resize-stepper input { width: 36px; min-width: 0; height: 26px; padding: 0; color: var(--vrc-text); font: inherit; text-align: center; background: transparent; border: 0; outline: 0; appearance: textfield; }
.vm-resize-stepper input::-webkit-inner-spin-button, .vm-resize-stepper input::-webkit-outer-spin-button { margin: 0; appearance: none; }
.vm-resize-stepper.disk { width: 156px; grid-template-columns: 30px minmax(58px, 1fr) 30px; }
.vm-resize-stepper.disk button { width: 30px; }
.vm-resize-stepper.disk input { width: 42px; }
.vm-resize-state { justify-self: center; font-size: 12px; }
.vm-resize-state.success { color: var(--vrc-success); }
.vm-resize-state.warning { color: var(--vrc-warning); }
.vm-resize-disk-group { background: var(--vrc-surface-raised); }
.vm-resize-disk-row { min-height: 64px; background: var(--vrc-surface-raised); border-bottom: 0; }
.vm-resize-guest { padding: 8px 12px 10px; background: var(--vrc-surface-raised); border-top: 1px dashed var(--vrc-border); }
.vm-resize-guest > header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 9px; }
.vm-resize-guest-title, .vm-resize-guest-tools, .vm-resize-disk-picker, .vm-resize-auto { display: flex; align-items: center; }
.vm-resize-guest-title { gap: 7px; }
.vm-resize-guest-title > .el-icon { color: var(--vrc-accent); font-size: 16px; }
.vm-resize-guest-title > span { display: flex; align-items: baseline; gap: 6px; }
.vm-resize-guest > header strong { font-size: 12px; font-weight: 400; }
.vm-resize-guest > header small { color: var(--vrc-text-subtle); font-size: 11px; font-weight: 400; }
.vm-resize-guest-tools { gap: 12px; }
.vm-resize-disk-picker { gap: 6px; color: var(--vrc-text-subtle); font-size: 11px; font-weight: 400; }
.vm-resize-disk-picker > .el-select { width: 174px; --el-component-size: 28px; }
.vm-resize-disk-picker :deep(.el-select__wrapper) { min-height: 28px; height: 28px; padding: 0 8px; border-radius: 4px; }
.vm-resize-disk-picker :deep(.el-select__selected-item) { font-size: 12px; font-weight: 400; }
.vm-resize-disk-option { display: flex; align-items: center; justify-content: space-between; width: 100%; gap: 20px; }
.vm-resize-disk-option strong { font-size: 12px; font-weight: 400; }
.vm-resize-disk-option small { font-size: 11px; font-weight: 400; }
.vm-resize-auto { gap: 5px; color: var(--vrc-success); font-size: 12px; font-weight: 400; white-space: nowrap; }
.vm-resize-pending { color: var(--vrc-warning); font-size: 11px; font-weight: 400; white-space: nowrap; }
.vm-resize-guest-state { display: flex; align-items: center; justify-content: center; gap: 7px; min-height: 58px; color: var(--vrc-text-muted); font-size: 11px; background: var(--vrc-surface); border: 1px solid var(--vrc-border); border-radius: 5px; }
.vm-resize-guest-state strong { font-weight: 400; }
.vm-resize-guest-state.error { color: var(--vrc-warning); }
.vm-resize-guest-state.platform-only { color: var(--vrc-warning); }
.vm-resize-guest-state.platform-only > div { display: grid; gap: 2px; }
.vm-resize-guest-state.platform-only strong { color: var(--vrc-text); font-size: 12px; }
.vm-resize-guest-state.platform-only small { color: var(--vrc-text-muted); font-size: 11px; }
.vm-resize-state-loader { width: 14px; height: 14px; border: 2px solid var(--vrc-border); border-top-color: var(--vrc-accent); border-radius: 50%; animation: vm-resize-spin 0.8s linear infinite; }
.vm-resize-mounts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.vm-resize-mounts button { display: grid; grid-template-columns: 14px minmax(0, 1fr) 52px 14px 58px; gap: 7px; align-items: center; min-width: 0; min-height: 50px; padding: 6px 9px; color: var(--vrc-text); text-align: left; background: var(--vrc-surface); border: 1px solid var(--vrc-border); border-radius: 5px; cursor: pointer; }
.vm-resize-mounts button.active { background: var(--vrc-surface); border-color: color-mix(in srgb, var(--vrc-accent) 55%, var(--vrc-border)); }
.vm-resize-radio { width: 12px; height: 12px; border: 1px solid var(--vrc-border-strong); border-radius: 50%; }
.vm-resize-mounts button.active .vm-resize-radio { background: var(--vrc-accent); border: 3px solid var(--vrc-surface); box-shadow: 0 0 0 1px var(--vrc-accent); }
.vm-resize-mount-copy, .vm-resize-mount-size { display: grid; gap: 2px; min-width: 0; }
.vm-resize-mount-copy strong, .vm-resize-mount-size strong { overflow: hidden; font-size: 12px; font-weight: 400; text-overflow: ellipsis; white-space: nowrap; }
.vm-resize-mount-copy small, .vm-resize-mount-size small { overflow: hidden; color: var(--vrc-text-subtle); font-size: 10px; font-weight: 400; text-overflow: ellipsis; white-space: nowrap; }
.vm-resize-mount-size { text-align: right; }
.vm-resize-mount-size.target { color: var(--vrc-accent); }
.vm-resize-mounts button > .el-icon, .vm-resize-chain > .el-icon { color: var(--vrc-text-subtle); font-size: 11px; }
.vm-resize-new-mount { display: grid; grid-template-columns: minmax(190px, 1.35fr) repeat(3, minmax(92px, 1fr)); gap: 8px; }
.vm-resize-new-mount > label, .vm-resize-new-mount > div { display: grid; gap: 3px; min-width: 0; min-height: 50px; padding: 6px 9px; background: var(--vrc-surface); border: 1px solid var(--vrc-border); border-radius: 5px; }
.vm-resize-new-mount span { color: var(--vrc-text-subtle); font-size: 9px; }
.vm-resize-new-mount strong { align-self: center; font-size: 11px; font-weight: 500; }
.vm-resize-directory-field > span { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.vm-resize-directory-field > span i { color: var(--vrc-success); font-style: normal; }
.vm-resize-new-mount :deep(.el-select__wrapper) { min-height: 25px; padding: 0 7px; border-radius: 4px; box-shadow: 0 0 0 1px var(--vrc-border) inset; }
.vm-resize-new-mount :deep(.el-select__selected-item), .vm-resize-new-mount :deep(.el-select__placeholder) { font-size: 11px; }
.vm-resize-directory-option { display: flex; align-items: center; justify-content: space-between; width: 100%; gap: 20px; }
.vm-resize-directory-option strong { color: var(--vrc-text); font-size: 12px; font-weight: 400; }
.vm-resize-directory-option small { color: var(--vrc-text-subtle); font-size: 10px; }
.vm-resize-chain { display: grid; grid-template-columns: 1fr 14px 1fr 14px 1fr 14px 1fr; gap: 5px; align-items: center; margin-top: 8px; padding: 2px 0 0; background: transparent; }
.vm-resize-chain > span { display: grid; gap: 1px; min-width: 0; text-align: center; }
.vm-resize-chain small { color: var(--vrc-text-subtle); font-size: 10px; font-weight: 400; }
.vm-resize-chain strong { overflow: hidden; font-size: 11px; font-weight: 400; text-overflow: ellipsis; white-space: nowrap; }
.vm-resize-impact { padding: 13px 14px; background: var(--vrc-surface-raised); border-left: 1px solid var(--vrc-border); }
.vm-resize-impact-head { display: flex; justify-content: space-between; margin-bottom: 14px; font-size: 12px; }
.vm-resize-impact-head span { color: var(--vrc-text-muted); }
.vm-resize-impact-head strong { color: var(--vrc-accent); font-weight: 500; }
.vm-resize-impact > dl { display: grid; gap: 12px; margin: 0; }
.vm-resize-impact > dl div { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.vm-resize-impact dt { color: var(--vrc-text-subtle); font-size: 11px; }
.vm-resize-impact dd { margin: 0; font-size: 11px; }
.vm-resize-impact dd strong { font-weight: 500; }
.vm-resize-divider { height: 1px; margin: 16px 0; background: var(--vrc-border); }
.vm-resize-execution { display: grid; grid-template-columns: 16px minmax(0, 1fr); gap: 8px; color: var(--vrc-success); }
.vm-resize-execution.warning { color: var(--vrc-warning); }
.vm-resize-execution strong { font-size: 12px; font-weight: 500; }
.vm-resize-execution p { margin: 4px 0 0; color: var(--vrc-text-muted); font-size: 11px; line-height: 16px; }
.vm-resize-error { margin: 8px 0 0; color: var(--vrc-danger); background: var(--vrc-status-danger-soft); }
.vm-resize-footer { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 56px; padding: 10px 16px; background: var(--vrc-surface-raised); border-top: 1px solid var(--vrc-border); }
.vm-resize-footer > div { display: flex; align-items: center; gap: 8px; }
.vm-resize-footer strong { font-size: 12px; font-weight: 500; }
.vm-resize-footer span { color: var(--vrc-warning); font-size: 11px; }
.vm-resize-footer :deep(.el-button) { min-width: 82px; height: 32px; margin: 0; font-weight: 400; border-radius: 4px; }
@media (max-width: 1080px) { .vm-resize-layout { grid-template-columns: 1fr; } .vm-resize-impact { border-top: 1px solid var(--vrc-border); border-left: 0; } }
@media (max-width: 760px) { .vm-resize-mounts { grid-template-columns: 1fr; } .vm-resize-new-mount { grid-template-columns: 1fr 1fr; } }
@keyframes vm-resize-spin { to { transform: rotate(360deg); } }
</style>
