<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import type { ProviderType, VmNode } from "../types";

interface RenameStrategy {
  providerLabel: string;
  method: string;
  duplicateScope: string;
  constraint: string;
  effect: string;
  maxLength: number;
  pattern?: RegExp;
  patternMessage?: string;
  supported: boolean;
}

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    vm: VmNode | null;
    providerType: ProviderType;
    existingNames?: string[];
    saving?: boolean;
  }>(),
  {
    existingNames: () => [],
    saving: false,
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  submit: [payload: { vm: VmNode; newName: string }];
}>();

const inputRef = ref<{ focus: () => void } | null>(null);
const newName = ref("");
const touched = ref(false);

const strategies: Record<ProviderType, RenameStrategy> = {
  xenserver: {
    providerLabel: "XenServer",
    method: "XenAPI / xe name-label",
    duplicateScope: "当前资源池",
    constraint: "运行中可修改；VRC 限制 1-128 个字符",
    effect: "更新 XenCenter、xe 与 VRC 清单中的显示名称。",
    maxLength: 128,
    supported: true,
  },
  vmware: {
    providerLabel: "VMware",
    method: "vSphere Rename_Task",
    duplicateScope: "当前 VM 文件夹",
    constraint: "运行中可提交；VRC 限制 1-80 个字符",
    effect: "只修改 vSphere 清单名称，不移动数据存储目录，也不重命名 VMX/VMDK 文件。",
    maxLength: 80,
    supported: true,
  },
  proxmox: {
    providerLabel: "Proxmox VE",
    method: "PVE QEMU config name",
    duplicateScope: "当前 PVE 节点",
    constraint: "1-63 个字符；使用字母、数字、点或连字符",
    effect: "更新 QEMU 配置名称，VMID 保持不变。",
    maxLength: 63,
    pattern: /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/,
    patternMessage: "Proxmox VE 名称只能使用字母、数字、点或连字符，且首尾必须为字母或数字",
    supported: true,
  },
  libvirt: {
    providerLabel: "KVM/libvirt",
    method: "当前版本未启用改名策略",
    duplicateScope: "-",
    constraint: "暂不支持",
    effect: "需要先补齐停机改名、存储引用和回滚校验后再开放。",
    maxLength: 128,
    supported: false,
  },
};

const strategy = computed(() => strategies[props.providerType]);
const normalizedName = computed(() => newName.value.trim());
const duplicateNames = computed(() => new Set(props.existingNames.map((name) => name.trim().toLocaleLowerCase("zh-CN"))));
const validationMessage = computed(() => {
  if (!props.vm) return "未选择虚拟机";
  if (!strategy.value.supported) return `${strategy.value.providerLabel} 暂不支持在线改名`;
  if (!normalizedName.value) return "请输入新的虚拟机名称";
  if (normalizedName.value.length > strategy.value.maxLength) return `名称不能超过 ${strategy.value.maxLength} 个字符`;
  if (strategy.value.pattern && !strategy.value.pattern.test(normalizedName.value)) return strategy.value.patternMessage || "名称格式不正确";
  if (normalizedName.value === props.vm.name.trim()) return "新名称不能与当前名称相同";
  if (duplicateNames.value.has(normalizedName.value.toLocaleLowerCase("zh-CN"))) return `${strategy.value.duplicateScope}内已存在同名虚拟机`;
  return "";
});
const canSubmit = computed(() => !props.saving && !validationMessage.value);

watch(
  () => props.modelValue,
  async (visible) => {
    if (!visible) return;
    newName.value = props.vm?.name ?? "";
    touched.value = false;
    await nextTick();
    inputRef.value?.focus();
  },
);

function close() {
  if (props.saving) return;
  emit("update:modelValue", false);
}

function submit() {
  touched.value = true;
  if (!props.vm || !canSubmit.value) return;
  emit("submit", { vm: props.vm, newName: normalizedName.value });
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="修改虚拟机名称"
    width="460px"
    class="vm-rename-dialog"
    append-to-body
    :close-on-click-modal="false"
    :close-on-press-escape="!saving"
    :show-close="!saving"
    @close="close"
  >
    <div v-if="vm" class="vm-rename-content">
      <section class="vm-rename-group" aria-label="名称设置">
        <div class="vm-rename-field">
          <span>当前名称</span>
          <div class="vm-rename-readonly" :title="vm.name">{{ vm.name }}</div>
        </div>
        <label class="vm-rename-field">
          <span>新名称</span>
          <el-input
            ref="inputRef"
            v-model="newName"
            :maxlength="strategy.maxLength"
            placeholder="输入新的虚拟机名称"
            clearable
            :disabled="saving"
            @blur="touched = true"
            @keyup.enter="submit"
          />
        </label>
        <div class="vm-rename-field-meta" :class="{ 'is-error': touched && validationMessage }">
          <span>{{ touched && validationMessage ? validationMessage : strategy.constraint }}</span>
          <span>{{ normalizedName.length }} / {{ strategy.maxLength }}</span>
        </div>
      </section>

      <section class="vm-rename-group vm-rename-strategy" aria-label="平台执行策略">
        <div class="vm-rename-group-title">
          <span>平台策略</span>
          <strong>{{ strategy.providerLabel }}</strong>
        </div>
        <dl>
          <div><dt>执行方式</dt><dd>{{ strategy.method }}</dd></div>
          <div><dt>重名检查</dt><dd>{{ strategy.duplicateScope }}</dd></div>
          <div><dt>生效范围</dt><dd>{{ strategy.effect }}</dd></div>
        </dl>
        <p>不会修改客户机系统主机名、IP、UUID / VMID 或虚拟磁盘内容。</p>
      </section>
    </div>

    <template #footer>
      <div class="vm-rename-footer">
        <el-button :disabled="saving" @click="close">取消</el-button>
        <el-button type="primary" :loading="saving" :disabled="!canSubmit" @click="submit">确认修改</el-button>
      </div>
    </template>
  </el-dialog>
</template>
