<script setup lang="ts">
import { ArrowRight, CircleCheck, Coin, Cpu, Files, FolderOpened, Minus, Plus, Warning } from "@element-plus/icons-vue";
import { computed, ref, watch } from "vue";
import type { GuestStorageInventory, HostNode, ProviderDescriptor, VmDisk, VmNode, VmResizeRequest, VmSystemCredentials } from "../types";

type ResourceKey = "cpu" | "memory";

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    vm: VmNode | null;
    host: HostNode | null;
    providerDescriptor?: ProviderDescriptor;
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
  "load-guest-storage": [vm: VmNode, systemCredentials?: VmSystemCredentials, rememberSystemCredentials?: boolean];
  submit: [request: VmResizeRequest];
}>();

const gib = 1024 ** 3;
const cpuDelta = ref(0);
const memoryDelta = ref(0);
// 新增磁盘模式的容量；扩展原盘时总增量由下方各目录的增量自动汇总。
const manualDiskDelta = ref(0);
const mountDeltas = ref<Record<string, number>>({});
const diskMode = ref<"extend" | "add">("extend");
const selectedDiskId = ref("");
const selectedMountPaths = ref<string[]>([]);
const newMountPath = ref("/data");
const systemLogin = ref("root");
const systemPassword = ref("");
const useJumpServer = ref(false);
const jumpHost = ref("");
const jumpPort = ref(22);
const jumpLogin = ref("root");
const jumpPassword = ref("");
const rememberSystemCredentials = ref(false);

const cpuDeltaInput = normalizedModel(cpuDelta);
const memoryDeltaInput = normalizedModel(memoryDelta);
const manualDiskDeltaInput = normalizedModel(manualDiskDelta);
const currentMemoryGiB = computed(() => Math.round((props.vm?.memoryBytes ?? 0) / gib));
const currentDiskTotalGiB = computed(() => Math.round(props.disks.reduce((sum, disk) => sum + disk.virtualSizeBytes, 0) / gib));
const diskSizeSummary = computed(() => props.disks.map((disk) => formatGiB(disk.virtualSizeBytes)).join(" + "));
const selectedDisk = computed(() => props.disks.find((disk) => disk.id === selectedDiskId.value) ?? props.disks[0] ?? null);
const matchingGuestMounts = computed(() =>
  props.guestStorage?.mounts.filter((mount) => mount.platformDiskId === selectedDisk.value?.id) ?? [],
);
// 多选：保留用户勾选顺序，后面的目录优先作为首个目标的自然顺序。
const checkedGuestMounts = computed(() =>
  selectedMountPaths.value
    .map((path) => matchingGuestMounts.value.find((mount) => mount.mountPath === path))
    .filter((mount): mount is NonNullable<typeof mount> => Boolean(mount)),
);
const selectedGuestMount = computed(() => checkedGuestMounts.value[0] ?? null);
const pendingCapacityBytes = computed(() =>
  checkedGuestMounts.value.reduce((max, mount) => Math.max(max, mount.pendingCapacityBytes), 0),
);
// 未勾选任何目录时也要提示磁盘上还有上次未分配的容量，引导用户勾选目录续作。
const availablePendingCapacityBytes = computed(() =>
  matchingGuestMounts.value.reduce((max, mount) => Math.max(max, mount.pendingCapacityBytes), 0),
);
// 扩展原盘时总增量由各目录的独立增量汇总得到；新增磁盘只有一个步进器。
const extendDeltaGiB = computed(() =>
  checkedGuestMounts.value.reduce((sum, mount) => sum + mountDeltaGiB(mount), 0),
);
const diskDelta = computed(() => (diskMode.value === "add" ? manualDiskDelta.value : extendDeltaGiB.value));
const hasPendingCapacity = computed(() => diskMode.value === "extend" && pendingCapacityBytes.value > 512 * 1024 ** 2);
// 磁盘上存在上次已扩、尚未分配的容量：即使用户还没勾选目录，也要提示可续作。
const hasAvailablePendingCapacity = computed(() => diskMode.value === "extend" && availablePendingCapacityBytes.value > 512 * 1024 ** 2);
const reconcileExistingCapacity = computed(() => hasPendingCapacity.value && diskDelta.value === 0);
const diskChangeActive = computed(() => diskDelta.value > 0 || reconcileExistingCapacity.value);
const detectedNewMountDirectory = computed(() => props.guestStorage?.directories.find((item) => item.path === newMountPath.value));
const targetCpu = computed(() => (props.vm?.cpuCount ?? 0) + cpuDelta.value);
const targetMemoryGiB = computed(() => currentMemoryGiB.value + memoryDelta.value);
const targetDiskTotalGiB = computed(() => currentDiskTotalGiB.value + diskDelta.value);
const targetSelectedDiskGiB = computed(() => formatGiB(selectedDisk.value?.virtualSizeBytes ?? 0) + diskDelta.value);
const diskCount = computed(() => props.disks.length + (diskMode.value === "add" ? 1 : 0));
const changedCount = computed(() => Number(cpuDelta.value > 0) + Number(memoryDelta.value > 0) + Number(diskChangeActive.value));
const supported = computed(() => props.providerDescriptor?.capabilities.vmResize.supported === true);
const guestAutoApplyAvailable = computed(() => props.guestStorage?.supported === true);
const guestOffline = computed(() => props.guestStorage?.reasonCode === "GUEST_OFFLINE");
const systemExecutionUnavailable = computed(() => props.guestStorage?.reasonCode === "SYSTEM_EXECUTION_UNAVAILABLE");
const systemAuthenticationRequired = computed(() =>
  props.guestStorage?.reasonCode === "SYSTEM_AUTHENTICATION_REQUIRED" || systemExecutionUnavailable.value,
);
const canRetrySystemLogin = computed(() => Boolean(
  systemLogin.value.trim()
  && systemPassword.value
  && !props.loadingGuestStorage
  && (!useJumpServer.value || (jumpHost.value.trim() && jumpPort.value > 0 && jumpLogin.value.trim() && jumpPassword.value)),
));
const diskAutoApplyBlocked = computed(() => diskDelta.value > 0 && !props.loadingGuestStorage && !guestAutoApplyAvailable.value);
// 只有填了增量的目录才参与校验，未填增量的目录仅作为“可扩容候选”展示。
const increasingMounts = computed(() => checkedGuestMounts.value.filter((mount) => mountDeltaGiB(mount) > 0));
const guestStorageValidationError = computed(() => {
  if (!diskChangeActive.value) return "";
  if (props.loadingGuestStorage || !guestAutoApplyAvailable.value) return "";
  if (diskMode.value === "extend" && !checkedGuestMounts.value.length) return "请至少勾选一个要扩容的目录后填写增量";
  if (diskMode.value === "extend" && !selectedGuestMount.value) return "所选虚拟磁盘没有匹配到可扩容的系统目录";
  if (diskMode.value === "extend" && increasingMounts.value.length > 1 && increasingMounts.value.some((mount) => !mount.logicalVolume)) {
    return "同时扩容多个目录只支持各自独立的 LVM 逻辑卷目录；非 LVM 目录请单独扩容";
  }
  if (diskMode.value === "extend" && mountDeviceKeys(increasingMounts.value).size < increasingMounts.value.length) {
    return "多个目录不能共用同一个逻辑卷或分区，请分别填写增量";
  }
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
      // 新增磁盘容量默认 0，由用户显式增加，避免默认值被误提交。
      mountDeltas.value = {};
      return;
    }
    selectedDiskId.value = value;
    diskMode.value = "extend";
  },
});

watch(
  () => props.modelValue,
  (visible) => {
    if (!visible) return;
    if (!props.vm) return;
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
    if (diskMode.value !== "extend") return;
    const available = matchingGuestMounts.value;
    // 目录默认不勾选：容量增量由用户主动勾选目录后填写，避免误扩。
    const kept = selectedMountPaths.value.filter((path) => available.some((mount) => mount.mountPath === path));
    if (kept.length !== selectedMountPaths.value.length) selectedMountPaths.value = kept;
    // 目录刷新后可能已消失或被重新挂载，清理不再存在的目录增量。
    const keptDeltas = Object.entries(mountDeltas.value).filter(([path]) => available.some((mount) => mount.mountPath === path));
    if (keptDeltas.length !== Object.keys(mountDeltas.value).length) mountDeltas.value = Object.fromEntries(keptDeltas);
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
  manualDiskDelta.value = 0;
  mountDeltas.value = {};
  diskMode.value = "extend";
  selectedDiskId.value = props.disks[0]?.id ?? "";
  selectedMountPaths.value = [];
  newMountPath.value = "/data";
  systemLogin.value = "root";
  systemPassword.value = "";
  useJumpServer.value = false;
  jumpHost.value = "";
  jumpPort.value = 22;
  jumpLogin.value = "root";
  jumpPassword.value = "";
  rememberSystemCredentials.value = false;
}

function adjust(resource: "cpu" | "memory", direction: number) {
  const state = resource === "cpu" ? cpuDelta : memoryDelta;
  const step = resource === "cpu" ? 1 : 2;
  state.value = Math.max(0, state.value + direction * step);
}

function adjustDisk(direction: number) {
  manualDiskDelta.value = Math.max(0, manualDiskDelta.value + direction * 10);
}

function close() {
  if (props.saving) return;
  emit("update:modelValue", false);
}

function retrySystemLogin() {
  if (!canRetrySystemLogin.value || !props.vm) return;
  emit("load-guest-storage", props.vm, buildSystemCredentials(), rememberSystemCredentials.value);
}

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

function submit() {
  if (!canSubmit.value || !props.vm) return;
  const request: VmResizeRequest = {
    cpuCount: cpuDelta.value > 0 ? targetCpu.value : undefined,
    memoryBytes: memoryDelta.value > 0 ? targetMemoryGiB.value * gib : undefined,
    allowShutdown: true,
    restartAfterResize: true,
  };
  if (systemPassword.value) request.systemCredentials = buildSystemCredentials();
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
      if (diskMode.value === "extend") {
        const mounts = increasingMounts.value;
        // 各目录填写的 GiB 增量直接作为相对权重提交；只提交真实填了增量的目录。
        if (mounts.length > 1) {
          request.storageTarget = {
            mountPaths: mounts.map((mount) => ({ mountPath: mount.mountPath, weight: mountDeltaGiB(mount) })),
          };
        } else {
          // 只扩一个目录时用单目录契约；没有填增量则只续作既有未分配容量。
          const target = mounts[0] ?? firstTargetMount.value;
          request.storageTarget = { mountPath: target?.mountPath ?? "" };
        }
      } else {
        request.storageTarget = { mountPath: normalizeMountPath(newMountPath.value) };
      }
      if (systemPassword.value) {
        request.systemCredentials = {
          username: systemLogin.value.trim(),
          password: systemPassword.value,
        };
      }
    }
  }
  emit("submit", request);
}

function formatGiB(value: number) {
  return Math.round(value / gib);
}

function toggleMountPath(mountPath: string) {
  const current = selectedMountPaths.value;
  if (current.includes(mountPath)) {
    // 允许取消全部勾选：此时磁盘增量为 0，提交按钮由 changedCount 控制。
    selectedMountPaths.value = current.filter((item) => item !== mountPath);
    const next = { ...mountDeltas.value };
    delete next[mountPath];
    mountDeltas.value = next;
    return;
  }
  const mount = matchingGuestMounts.value.find((item) => item.mountPath === mountPath);
  if (!mount) return;
  selectedMountPaths.value = [...current, mountPath];
}

function mountDeltaGiB(mount: { mountPath: string }) {
  const value = mountDeltas.value[mount.mountPath];
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function setMountDelta(mountPath: string, value: number) {
  const parsed = Number(value);
  const next = { ...mountDeltas.value };
  if (!Number.isFinite(parsed) || parsed <= 0) delete next[mountPath];
  // 单个目录的增量不允许超过存储当前余量，避免提交后才被容量校验拦下。
  else next[mountPath] = Math.max(0, Math.min(Math.floor(props.storageFreeGiB), Math.round(parsed)));
  mountDeltas.value = next;
}

// 与顶部 CPU／内存步进器同一套交互：每次 ±10 GiB，减到 0 后禁用减号。
function adjustMountDelta(mountPath: string, direction: number) {
  setMountDelta(mountPath, mountDeltaGiB({ mountPath }) + direction * 10);
}

function mountDeviceKey(mount: { logicalVolume: boolean; source: string; guestPartitionPath?: string }) {
  return mount.logicalVolume ? mount.source : mount.guestPartitionPath || mount.source;
}

function mountDeviceKeys(mounts: Array<{ logicalVolume: boolean; source: string; guestPartitionPath?: string }>) {
  return new Set(mounts.map((mount) => mountDeviceKey(mount)));
}

// 提交给后端的 weight 就是各目录填写的 GiB 增量，新增容量按权重拆分后与填写值一致。
// 首个目标额外接收该目录此前累计的未分配空间，与后端 applyGuestStorageResize 的口径一致。
function mountAddedGiB(mount: { mountPath: string; pendingCapacityBytes: number }) {
  const pending = firstTargetMount.value?.mountPath === mount.mountPath ? Math.max(0, mount.pendingCapacityBytes) : 0;
  return mountDeltaGiB(mount) + formatGiB(pending);
}

const allocatedDeltaText = computed(() =>
  increasingMounts.value
    .map((mount) => `${mount.mountPath} +${mountDeltaGiB(mount)} GiB`)
    .join("，"),
);

// 提交计划的首个目标：填了增量时是最先勾选且填了增量的目录，否则回退到待分配最多的已选目录。
const firstTargetMount = computed(() =>
  increasingMounts.value[0]
  ?? [...checkedGuestMounts.value].sort((left, right) => right.pendingCapacityBytes - left.pendingCapacityBytes)[0]
  ?? null,
);

function diskDeviceLabel(disk: VmDisk) {
  return disk.displayName || disk.device || disk.name || "虚拟硬盘";
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
        <div><h2>扩容虚拟机</h2><span>{{ providerDescriptor?.label || "虚拟化平台" }}</span></div>
        <p v-if="vm"><strong>{{ vm.name }}</strong><i></i><span>{{ host?.name }}</span><i></i><span>{{ host?.address }}</span><i></i><span>{{ vm.powerState === "running" ? "运行中" : "已关机" }}</span></p>
      </div>
    </template>

    <div v-if="vm" class="vm-resize-content vrc-scroll-container">
      <div class="vm-resize-capacity">
        <span>宿主机可用</span>
        <dl><div><dt>CPU</dt><dd :class="{ warning: cpuOvercommitted }">{{ cpuCapacityText }}</dd></div><div><dt>内存</dt><dd>{{ formatNumber(memoryFreeGiB) }} GiB</dd></div><div><dt>存储</dt><dd>{{ formatNumber(storageFreeGiB) }} GiB</dd></div></dl>
      </div>

      <div class="vm-resize-layout">
        <section class="vm-resize-table">
          <div class="vm-resize-row vm-resize-head"><span>资源</span><span>当前配置</span><span>增加</span><span>扩容后</span><span>执行</span></div>

          <div class="vm-resize-row">
            <span class="vm-resize-resource"><el-icon><Cpu /></el-icon><strong>处理器</strong></span>
            <span class="vm-resize-value current" data-label="当前配置"><strong>{{ vm.cpuCount }}</strong><small>vCPU</small></span>
            <div class="vm-resize-stepper" data-label="增加"><button type="button" :disabled="cpuDelta <= 0" aria-label="减少处理器" @click="adjust('cpu', -1)"><el-icon><Minus /></el-icon></button><label><input v-model.number="cpuDeltaInput" type="number" min="0" step="1" aria-label="处理器增加量" /></label><button type="button" aria-label="增加处理器" @click="adjust('cpu', 1)"><el-icon><Plus /></el-icon></button></div>
            <span class="vm-resize-value target" data-label="扩容后"><strong>{{ targetCpu }}</strong><small>vCPU</small></span>
            <span class="vm-resize-state" :class="cpuDelta ? 'warning' : 'success'">{{ cpuDelta ? "后端规划" : "未变更" }}</span>
          </div>

          <div class="vm-resize-row">
            <span class="vm-resize-resource"><el-icon><Coin /></el-icon><strong>内存</strong></span>
            <span class="vm-resize-value current" data-label="当前配置"><strong>{{ currentMemoryGiB }}</strong><small>GiB</small></span>
            <div class="vm-resize-stepper" data-label="增加"><button type="button" :disabled="memoryDelta <= 0" aria-label="减少内存" @click="adjust('memory', -1)"><el-icon><Minus /></el-icon></button><label><input v-model.number="memoryDeltaInput" type="number" min="0" step="2" aria-label="内存增加量" /></label><button type="button" aria-label="增加内存" @click="adjust('memory', 1)"><el-icon><Plus /></el-icon></button></div>
            <span class="vm-resize-value target" data-label="扩容后"><strong>{{ targetMemoryGiB }}</strong><small>GiB</small></span>
            <span class="vm-resize-state" :class="memoryDelta ? 'warning' : 'success'">{{ memoryDelta ? "后端规划" : "未变更" }}</span>
          </div>

          <section class="vm-resize-disk-group">
            <div class="vm-resize-row vm-resize-disk-row">
              <span class="vm-resize-resource"><el-icon><Files /></el-icon><strong>虚拟硬盘</strong></span>
              <span class="vm-resize-value disk current" data-label="当前配置"><span><strong>{{ currentDiskTotalGiB }}</strong><small>GiB</small></span><em>{{ disks.length }} 块 · {{ diskSizeSummary || "读取中" }}<template v-if="diskSizeSummary"> GiB</template></em></span>
              <div v-if="diskMode === 'add'" class="vm-resize-stepper disk" data-label="增加"><button type="button" :disabled="manualDiskDelta <= 0" aria-label="减少磁盘" @click="adjustDisk(-1)"><el-icon><Minus /></el-icon></button><label><input v-model.number="manualDiskDeltaInput" type="number" min="0" step="10" aria-label="新增磁盘容量" /></label><button type="button" aria-label="增加磁盘" @click="adjustDisk(1)"><el-icon><Plus /></el-icon></button></div>
              <span v-else class="vm-resize-value disk increase-summary" data-label="增加"><span><strong>{{ diskDelta }}</strong><small>GiB</small></span><em>{{ checkedGuestMounts.length ? `由下方 ${checkedGuestMounts.length} 个目录汇总` : "未勾选目录" }}</em></span>
              <span class="vm-resize-value disk target" data-label="扩容后"><span><strong>{{ targetDiskTotalGiB }}</strong><small>GiB</small></span><em v-if="diskMode === 'extend' && selectedDisk">{{ diskDeviceLabel(selectedDisk) }} {{ formatGiB(selectedDisk.virtualSizeBytes) }} → {{ targetSelectedDiskGiB }}</em><em v-else>新增 {{ diskDelta }} GiB · 共 {{ diskCount }} 块</em></span>
              <span class="vm-resize-state" :class="diskChangeActive ? 'warning' : 'success'">{{ reconcileExistingCapacity ? "待生效" : diskDelta ? "后端规划" : "未变更" }}</span>
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
                <span v-if="hasAvailablePendingCapacity && diskDelta === 0" class="vm-resize-pending">待分配 {{ formatGiB(availablePendingCapacityBytes) }} GiB</span>
              </div>
            </header>

            <div v-if="loadingGuestStorage" class="vm-resize-guest-state"><span class="vm-resize-state-loader"></span><strong>正在识别真实磁盘、分区和目录</strong></div>
            <div v-else-if="systemAuthenticationRequired" class="vm-resize-system-login">
              <div class="vm-resize-system-login-copy">
                <el-icon aria-hidden="true"><Warning /></el-icon>
                <span><strong>{{ systemExecutionUnavailable ? "系统执行通道不可用" : "需要虚拟机系统账号" }}</strong><small>{{ systemExecutionUnavailable ? "请提供系统账号；只能经 JumpServer 访问时同时填写跳板连接。" : "默认凭据无法登录，请提供本次扩容使用的登录账号和密码。" }}</small></span>
              </div>
              <div class="vm-resize-system-login-fields">
                <el-input v-model="systemLogin" aria-label="系统登录账号" autocomplete="username" name="vrc-resize-system-login" placeholder="登录账号" />
                <el-input v-model="systemPassword" aria-label="系统登录密码" type="password" show-password autocomplete="current-password" name="vrc-resize-system-password" placeholder="登录密码" @keyup.enter="retrySystemLogin" />
                <el-button :loading="loadingGuestStorage" :disabled="!canRetrySystemLogin" @click="retrySystemLogin">验证并读取</el-button>
                <el-checkbox v-model="rememberSystemCredentials" class="vm-resize-system-login-remember">保存到本机（加密）</el-checkbox>
                <el-checkbox v-model="useJumpServer" class="vm-resize-system-login-jump">通过 JumpServer 连接</el-checkbox>
              </div>
              <div v-if="useJumpServer" class="vm-resize-jump-fields">
                <el-input v-model="jumpHost" aria-label="JumpServer 地址" name="vrc-resize-jump-host" placeholder="JumpServer Host" />
                <el-input-number v-model="jumpPort" aria-label="JumpServer 端口" :min="1" :max="65535" :controls="false" />
                <el-input v-model="jumpLogin" aria-label="JumpServer 登录账号" autocomplete="username" name="vrc-resize-jump-login" placeholder="Jump Login" />
                <el-input v-model="jumpPassword" aria-label="JumpServer 登录密码" type="password" show-password autocomplete="current-password" name="vrc-resize-jump-password" placeholder="Jump Password" @keyup.enter="retrySystemLogin" />
              </div>
            </div>
            <div v-else-if="guestOffline" class="vm-resize-guest-state unavailable" :title="guestStorage?.message || guestStorageError">
              <el-icon aria-hidden="true"><Warning /></el-icon>
              <div><strong>虚拟机当前已关机</strong><small>{{ guestStorage?.message || "无法读取操作系统磁盘与目录；请先开机后再按目录扩容。" }}</small></div>
            </div>
            <div v-else-if="!guestStorage?.supported" class="vm-resize-guest-state unavailable" :title="guestStorage?.message || guestStorageError">
              <el-icon aria-hidden="true"><Warning /></el-icon>
              <div><strong>系统执行通道不可用</strong><small>{{ guestStorage?.message || guestStorageError || "磁盘扩容需先完成系统磁盘与目录检测" }}</small></div>
            </div>

            <template v-else-if="diskMode === 'extend'">
              <div v-if="matchingGuestMounts.length" class="vm-resize-mounts" role="group" aria-label="选择扩容目录与增量">
                <div v-for="mount in matchingGuestMounts" :key="mount.mountPath" class="vm-resize-mount-card" :class="{ active: selectedMountPaths.includes(mount.mountPath), muted: !selectedMountPaths.includes(mount.mountPath) }">
                  <button class="vm-resize-mount-head" type="button" role="checkbox" :aria-checked="selectedMountPaths.includes(mount.mountPath)" @click="toggleMountPath(mount.mountPath)">
                    <span class="vm-resize-radio"></span>
                    <span class="vm-resize-mount-copy"><strong>{{ mount.mountPath === "/" ? "根目录" : mount.mountPath }}</strong><small>{{ mount.source }} · {{ mount.filesystem.toUpperCase() }}</small></span>
                    <span class="vm-resize-mount-size"><small>当前</small><strong>{{ formatGiB(mount.sizeBytes) }} GiB</strong></span>
                    <el-icon><ArrowRight /></el-icon>
                    <span class="vm-resize-mount-size target"><small>完成后</small><strong>{{ formatGiB(mount.sizeBytes) + mountAddedGiB(mount) }} GiB</strong></span>
                  </button>
                  <div class="vm-resize-mount-increase" :class="{ disabled: !selectedMountPaths.includes(mount.mountPath) }">
                    <span>增加</span>
                    <div class="vm-resize-stepper" data-label="增加">
                      <button type="button" :disabled="!selectedMountPaths.includes(mount.mountPath) || mountDeltaGiB(mount) <= 0" :aria-label="`减少 ${mount.mountPath} 增加容量`" @click="adjustMountDelta(mount.mountPath, -1)"><el-icon><Minus /></el-icon></button>
                      <label><input :value="mountDeltaGiB(mount)" type="number" min="0" step="10" :disabled="!selectedMountPaths.includes(mount.mountPath)" :aria-label="`${mount.mountPath} 增加容量（GiB）`" @input="setMountDelta(mount.mountPath, Number(($event.target as HTMLInputElement).value))" /></label>
                      <button type="button" :disabled="!selectedMountPaths.includes(mount.mountPath)" :aria-label="`增加 ${mount.mountPath} 增加容量`" @click="adjustMountDelta(mount.mountPath, 1)"><el-icon><Plus /></el-icon></button>
                    </div>
                    <span>GiB</span>
                    <em v-if="!selectedMountPaths.includes(mount.mountPath)">勾选后可填写增量</em>
                    <em v-else-if="mount.pendingCapacityBytes > 512 * 1024 ** 2">含待分配 {{ formatGiB(mount.pendingCapacityBytes) }} GiB</em>
                    <em v-else-if="!mount.logicalVolume && increasingMounts.length > 1">非 LVM 目录不能与其它目录同时填写增量</em>
                  </div>
                </div>
              </div>
              <div v-else class="vm-resize-guest-state error"><el-icon><Warning /></el-icon><strong>该虚拟磁盘没有匹配到可扩容目录</strong></div>
              <p v-if="increasingMounts.length > 1" class="vm-resize-mount-hint">
                已为 {{ increasingMounts.length }} 个目录分别填写增量（{{ allocatedDeltaText }}），合计 {{ diskDelta }} GiB。
              </p>
              <p v-else-if="increasingMounts.length === 1" class="vm-resize-mount-hint">
                本次只为 {{ allocatedDeltaText }} 扩容，其余已选目录保持当前容量。
              </p>
              <p v-else-if="!checkedGuestMounts.length" class="vm-resize-mount-hint">
                请勾选需要扩容的目录；未勾选的目录保持当前容量，磁盘不增加。
                <template v-if="hasAvailablePendingCapacity">当前磁盘还有 {{ formatGiB(availablePendingCapacityBytes) }} GiB 已扩未分配容量，勾选目录即可续作。</template>
              </p>
              <div v-if="selectedGuestMount" class="vm-resize-chain">
                <span><small>虚拟磁盘</small><strong>{{ selectedGuestMount.guestDiskPath }}</strong></span><el-icon><ArrowRight /></el-icon>
                <span><small>末尾分区</small><strong>{{ selectedGuestMount.guestPartitionPath || "整盘" }}</strong></span><el-icon><ArrowRight /></el-icon>
                <span><small>{{ selectedGuestMount.logicalVolume ? "LVM" : "文件系统" }}</small><strong>{{ selectedGuestMount.logicalVolume ? "PV / LV 扩展" : "分区扩展" }}</strong></span><el-icon><ArrowRight /></el-icon>
                <span><small>自动生效</small><strong>{{ increasingMounts.map((mount) => mount.mountPath).join("、") || checkedGuestMounts.map((mount) => mount.mountPath).join("、") }}</strong></span>
              </div>
            </template>

            <template v-else>
              <div class="vm-resize-new-mount">
                <label class="vm-resize-directory-field">
                  <span>空目录 / 新目录 <i>{{ detectedNewMountDirectory ? "系统空目录" : "将自动创建" }}</i></span>
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
                <span><small>系统设备</small><strong>自动识别</strong></span><el-icon><ArrowRight /></el-icon>
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
          <div class="vm-resize-execution" :class="{ warning: diskAutoApplyBlocked }"><el-icon><Warning v-if="diskAutoApplyBlocked" /><CircleCheck v-else /></el-icon><div><strong>{{ diskAutoApplyBlocked ? "自动生效不可用" : reconcileExistingCapacity ? "完成未生效容量" : "后端统一编排" }}</strong><p>{{ diskAutoApplyBlocked ? "未读取到系统磁盘，暂不允许只扩虚拟硬件。" : reconcileExistingCapacity ? "无需再次增加虚拟磁盘，直接扩展所选目录并回读容量。" : "后端根据平台能力选择在线或停机策略，并持续回读平台和系统内容量。" }}</p></div></div>
        </aside>
      </div>
      <p v-if="capacityError" class="vm-resize-error">{{ capacityError }}</p>
    </div>

    <template #footer>
      <div class="vm-resize-footer">
        <div><strong>{{ changedCount }} 项资源变更</strong><span>{{ diskAutoApplyBlocked ? "等待系统连接" : "后端编排并回读" }}</span></div>
        <div><el-button :disabled="saving" @click="close">取消</el-button><el-button type="primary" :loading="saving" :disabled="!canSubmit" @click="submit">{{ reconcileExistingCapacity ? "完成扩容" : "确认扩容" }}</el-button></div>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
:global(html:has(.vm-resize-dialog)) { overflow: hidden; }
:global(.vm-resize-dialog) { max-width: calc(100vw - 32px); padding: 0; border-radius: 8px; }
:global(.vm-resize-dialog .el-dialog__header) { min-height: 68px; padding: 13px 46px 11px 16px; margin: 0; border-bottom: 1px solid var(--vrc-border); }
:global(.vm-resize-dialog .el-dialog__headerbtn) { top: 7px; right: 7px; width: 32px; height: 32px; }
:global(.vm-resize-dialog .el-dialog__body), :global(.vm-resize-dialog .el-dialog__footer) { padding: 0; }
.vm-resize-title > div, .vm-resize-title p, .vm-resize-capacity, .vm-resize-capacity dl, .vm-resize-capacity dl div, .vm-resize-value, .vm-resize-value > span { display: flex; align-items: center; }
.vm-resize-title > div { gap: 8px; }
.vm-resize-title h2 { margin: 0; font-size: var(--vrc-font-size-dialog-title); font-weight: var(--vrc-font-weight-heading); line-height: 24px; }
.vm-resize-title > div > span { padding: 1px 6px; color: var(--vrc-accent); font-size: 10px; line-height: 18px; background: var(--vrc-accent-soft); border-radius: 3px; }
.vm-resize-title p { gap: 7px; margin: 4px 0 0; color: var(--vrc-text-subtle); font-size: 11px; }
.vm-resize-title p strong { max-width: 280px; overflow: hidden; color: var(--vrc-text-muted); font-weight: 400; text-overflow: ellipsis; white-space: nowrap; }
.vm-resize-title p i { width: 2px; height: 2px; background: var(--vrc-text-subtle); border-radius: 50%; }
.vm-resize-content { max-height: calc(88vh - 124px); overflow: auto; overscroll-behavior: contain; scrollbar-gutter: auto; padding: 14px 16px 16px; }
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
.vm-resize-stepper button:hover:not(:disabled) { color: var(--vrc-accent); background: var(--vrc-accent-soft); }
.vm-resize-stepper button:disabled { color: var(--vrc-text-subtle); background: var(--vrc-surface-muted); cursor: not-allowed; }
.vm-resize-stepper label { display: flex; align-items: center; justify-content: center; gap: 2px; min-width: 0; height: 28px; background: var(--vrc-surface); }
.vm-resize-stepper:focus-within { border-color: var(--vrc-border-strong); box-shadow: none; }
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
.vm-resize-disk-picker > .el-select { width: 174px; --el-component-size: var(--vrc-control-height); }
.vm-resize-disk-picker :deep(.el-select__wrapper) { min-height: var(--vrc-control-height); height: var(--vrc-control-height); padding: 0 8px; background: var(--vrc-surface); border: 1px solid var(--vrc-border); border-radius: var(--vrc-control-radius); box-shadow: none; }
.vm-resize-disk-picker :deep(.el-select__wrapper:hover) { border-color: var(--vrc-border-strong); box-shadow: none; }
.vm-resize-disk-picker :deep(.el-select__wrapper.is-focused) { border-color: var(--vrc-border-strong); box-shadow: none; }
.vm-resize-disk-picker :deep(.el-select__selected-item) { font-size: 12px; font-weight: 400; }
.vm-resize-disk-option { display: flex; align-items: center; justify-content: space-between; width: 100%; gap: 20px; }
.vm-resize-disk-option strong { font-size: 12px; font-weight: 400; }
.vm-resize-disk-option small { font-size: 11px; font-weight: 400; }
.vm-resize-auto { gap: 5px; color: var(--vrc-success); font-size: 12px; font-weight: 400; white-space: nowrap; }
.vm-resize-pending { color: var(--vrc-warning); font-size: 11px; font-weight: 400; white-space: nowrap; }
.vm-resize-guest-state { display: flex; align-items: center; justify-content: center; gap: 7px; min-height: 58px; color: var(--vrc-text-muted); font-size: 11px; background: var(--vrc-surface); border: 1px solid var(--vrc-border); border-radius: 5px; }
.vm-resize-guest-state strong { font-weight: 400; }
.vm-resize-guest-state.error { color: var(--vrc-warning); }
.vm-resize-guest-state.unavailable { color: var(--vrc-warning); }
.vm-resize-guest-state.unavailable > div { display: grid; gap: 2px; }
.vm-resize-guest-state.unavailable strong { color: var(--vrc-text); font-size: 12px; }
.vm-resize-guest-state.unavailable small { color: var(--vrc-text-muted); font-size: 11px; }
.vm-resize-system-login { display: grid; gap: 8px; min-height: 0; padding: 8px 9px; background: var(--vrc-surface); border: 1px solid var(--vrc-border); border-radius: 5px; }
.vm-resize-system-login-copy { display: flex; align-items: center; gap: 7px; color: var(--vrc-warning); }
.vm-resize-system-login-copy > span { display: grid; gap: 2px; }
.vm-resize-system-login-copy strong { color: var(--vrc-text); font-size: 12px; font-weight: 400; line-height: 18px; }
.vm-resize-system-login-copy small { color: var(--vrc-text-muted); font-size: 11px; font-weight: 400; line-height: 16px; }
.vm-resize-system-login-fields { display: grid; grid-template-columns: minmax(120px, 0.8fr) minmax(180px, 1.2fr) 104px; gap: 8px; }
.vm-resize-system-login-fields :deep(.el-input), .vm-resize-system-login-fields :deep(.el-button) { height: var(--vrc-command-height); min-height: var(--vrc-command-height); }
.vm-resize-system-login-fields :deep(.el-input__wrapper) { height: var(--vrc-command-height); min-height: var(--vrc-command-height); padding: 0 8px; background: var(--vrc-surface); border: 1px solid var(--vrc-border); border-radius: var(--vrc-command-radius); box-shadow: none; }
.vm-resize-system-login-fields :deep(.el-input__wrapper:hover) { border-color: var(--vrc-border-strong); background: var(--vrc-surface); box-shadow: none; }
.vm-resize-system-login-fields :deep(.el-input__wrapper.is-focus) { border-color: var(--vrc-border-strong); background: var(--vrc-surface); box-shadow: none; }
.vm-resize-system-login-fields :deep(.el-input__inner) { height: calc(var(--vrc-command-height) - 2px); color: var(--vrc-text); font-size: var(--vrc-font-size-body); font-weight: var(--vrc-font-weight-regular); line-height: calc(var(--vrc-command-height) - 2px); }
.vm-resize-system-login-fields :deep(.el-input__inner::placeholder) { color: var(--vrc-text-subtle); font-size: var(--vrc-font-size-label); font-weight: var(--vrc-font-weight-regular); opacity: 1; }
.vm-resize-system-login-fields :deep(.el-button) { padding: 0 10px; color: var(--vrc-text-muted); font-size: var(--vrc-font-size-body); font-weight: var(--vrc-font-weight-regular); background: var(--vrc-surface); border-color: var(--vrc-border); border-radius: var(--vrc-command-radius); }
.vm-resize-system-login-fields :deep(.el-button:hover:not(.is-disabled)) { color: var(--vrc-accent); background: var(--vrc-accent-soft); border-color: var(--vrc-border-strong); }
.vm-resize-system-login-fields :deep(.el-button:focus-visible) { color: var(--vrc-accent); border-color: var(--vrc-accent); box-shadow: var(--vrc-focus-ring); }
.vm-resize-system-login-fields :deep(.el-button.is-disabled), .vm-resize-system-login-fields :deep(.el-button.is-disabled:hover) { color: var(--vrc-text-subtle); background: var(--vrc-surface-muted); border-color: var(--vrc-border); }
.vm-resize-system-login-remember, .vm-resize-system-login-jump { width: max-content; height: 18px; margin: 0; }
.vm-resize-system-login-remember { grid-column: 1 / 2; }
.vm-resize-system-login-jump { grid-column: 2 / -1; }
.vm-resize-system-login-remember :deep(.el-checkbox__label), .vm-resize-system-login-jump :deep(.el-checkbox__label) { padding-left: 6px; color: var(--vrc-text-muted); font-size: 12px; font-weight: 400; line-height: 18px; }
.vm-resize-jump-fields { display: grid; grid-template-columns: minmax(150px, 1.2fr) 84px minmax(130px, 0.9fr) minmax(180px, 1.2fr); gap: 8px; padding-top: 8px; border-top: 1px solid var(--vrc-border); }
.vm-resize-jump-fields :deep(.el-input), .vm-resize-jump-fields :deep(.el-input-number) { width: 100%; height: var(--vrc-command-height); }
.vm-resize-jump-fields :deep(.el-input__wrapper), .vm-resize-jump-fields :deep(.el-input-number .el-input__wrapper) { height: var(--vrc-command-height); min-height: var(--vrc-command-height); padding: 0 8px; background: var(--vrc-surface); border: 1px solid var(--vrc-border); border-radius: var(--vrc-command-radius); box-shadow: none; }
.vm-resize-jump-fields :deep(.el-input__wrapper:hover) { border-color: var(--vrc-border-strong); }
.vm-resize-jump-fields :deep(.el-input__wrapper.is-focus) { border-color: var(--vrc-border-strong); box-shadow: none; }
.vm-resize-jump-fields :deep(.el-input__inner) { color: var(--vrc-text); font-size: var(--vrc-font-size-body); font-weight: var(--vrc-font-weight-regular); }
.vm-resize-state-loader { width: 14px; height: 14px; border: 2px solid var(--vrc-border); border-top-color: var(--vrc-accent); border-radius: 50%; animation: vm-resize-spin 0.8s linear infinite; }
.vm-resize-mounts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.vm-resize-mount-card { display: grid; gap: 6px; min-width: 0; padding: 6px 9px 7px; background: var(--vrc-surface); border: 1px solid var(--vrc-border); border-radius: 5px; }
.vm-resize-mount-card.active { border-color: color-mix(in srgb, var(--vrc-accent) 55%, var(--vrc-border)); }
/* 未勾选的目录只是可扩容候选，弱化展示并禁止填写增量。 */
.vm-resize-mount-card.muted { background: var(--vrc-surface-muted); }
.vm-resize-mount-card.muted .vm-resize-mount-size.target strong { color: var(--vrc-text-subtle); }
.vm-resize-mount-head { display: grid; grid-template-columns: 14px minmax(0, 1fr) 52px 14px 58px; gap: 7px; align-items: center; min-width: 0; padding: 0; color: var(--vrc-text); text-align: left; background: transparent; border: 0; cursor: pointer; }
.vm-resize-mount-head:focus-visible { outline: none; box-shadow: var(--vrc-focus-ring); }
.vm-resize-radio { width: 12px; height: 12px; border: 1px solid var(--vrc-border-strong); border-radius: 50%; }
.vm-resize-mount-card.active .vm-resize-radio { background: var(--vrc-accent); border: 3px solid var(--vrc-surface); box-shadow: 0 0 0 1px var(--vrc-accent); }
.vm-resize-mount-copy, .vm-resize-mount-size { display: grid; gap: 2px; min-width: 0; }
.vm-resize-mount-copy strong, .vm-resize-mount-size strong { overflow: hidden; font-size: 12px; font-weight: 400; text-overflow: ellipsis; white-space: nowrap; }
.vm-resize-mount-copy small, .vm-resize-mount-size small { overflow: hidden; color: var(--vrc-text-subtle); font-size: 10px; font-weight: 400; text-overflow: ellipsis; white-space: nowrap; }
.vm-resize-mount-size { text-align: right; }
.vm-resize-mount-size.target { color: var(--vrc-accent); }
.vm-resize-mount-head > .el-icon, .vm-resize-chain > .el-icon { color: var(--vrc-text-subtle); font-size: 11px; }
.vm-resize-mount-increase { display: flex; align-items: center; gap: 6px; min-width: 0; padding-top: 6px; color: var(--vrc-text-subtle); font-size: 11px; border-top: 1px dashed var(--vrc-border); }
.vm-resize-mount-increase.disabled { opacity: 0.55; }
.vm-resize-mount-increase > em { min-width: 0; overflow: hidden; color: var(--vrc-text-subtle); font-size: 10px; font-style: normal; text-overflow: ellipsis; white-space: nowrap; }
/* 复用顶部 CPU／内存步进器的尺寸，保证同一弹窗内增量输入样式一致。 */
.vm-resize-mount-increase > .vm-resize-stepper { justify-self: start; width: 156px; }
.vm-resize-value.disk.increase-summary em { white-space: nowrap; }
.vm-resize-mount-hint { margin: 6px 0 0; padding: 6px 8px; color: var(--vrc-text-muted); font-size: 11px; background: var(--vrc-surface-muted); border-radius: 4px; }
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
.vm-resize-footer { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 56px; padding: 10px 16px; background: var(--vrc-surface); }
.vm-resize-footer > div { display: flex; align-items: center; gap: 8px; }
.vm-resize-footer strong { font-size: 12px; font-weight: 500; }
.vm-resize-footer span { color: var(--vrc-warning); font-size: 11px; }
.vm-resize-footer :deep(.el-button) { min-width: 82px; height: var(--vrc-command-height); margin: 0; font-weight: var(--vrc-font-weight-regular); border-radius: var(--vrc-command-radius); }
@media (max-width: 1080px) { .vm-resize-layout { grid-template-columns: 1fr; } .vm-resize-impact { border-top: 1px solid var(--vrc-border); border-left: 0; } }
@media (max-width: 760px) { .vm-resize-mounts { grid-template-columns: 1fr; } .vm-resize-new-mount, .vm-resize-system-login-fields, .vm-resize-jump-fields { grid-template-columns: 1fr; } .vm-resize-system-login-remember, .vm-resize-system-login-jump { grid-column: 1; } }
@media (max-width: 700px) {
  .vm-resize-head { display: none; }
  .vm-resize-row:not(.vm-resize-head) { grid-template-columns: minmax(64px, .8fr) minmax(156px, 1.4fr) minmax(64px, .8fr); grid-template-areas: "resource resource state" "current increase target"; gap: 8px; min-height: 104px; padding: 10px 12px 12px; }
  .vm-resize-resource { grid-area: resource; min-width: 0; }
  .vm-resize-state { grid-area: state; justify-self: end; }
  .vm-resize-value.current { grid-area: current; }
  .vm-resize-stepper { grid-area: increase; width: min(156px, 100%); }
  .vm-resize-value.target { grid-area: target; }
  .vm-resize-value.current, .vm-resize-value.target, .vm-resize-stepper { position: relative; margin-top: 16px; }
  .vm-resize-value.current::before, .vm-resize-value.target::before, .vm-resize-stepper::before { position: absolute; top: -17px; right: 0; left: 0; color: var(--vrc-text-subtle); font-size: 10px; font-weight: 400; line-height: 14px; text-align: center; content: attr(data-label); }
  .vm-resize-value.disk { width: 100%; min-width: 0; }
  .vm-resize-value.disk em { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
}
@media (max-width: 460px) {
  .vm-resize-row:not(.vm-resize-head) { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); grid-template-areas: "resource state" "current target" "increase increase"; min-height: 148px; }
  .vm-resize-stepper { margin-top: 18px; }
}
@keyframes vm-resize-spin { to { transform: rotate(360deg); } }
</style>
