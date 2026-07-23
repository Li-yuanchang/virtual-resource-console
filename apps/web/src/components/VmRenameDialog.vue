<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import type { ProviderDescriptor, VmNode } from "../types";

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    vm: VmNode | null;
    providerDescriptor?: ProviderDescriptor;
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

const capability = computed(() => props.providerDescriptor?.capabilities.vmRename);
const maxLength = computed(() => capability.value?.maxLength ?? 128);
const namePattern = computed(() => {
  const pattern = capability.value?.pattern;
  if (!pattern) return null;
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
});
const constraintText = computed(() => capability.value?.patternMessage || `最多 ${maxLength.value} 个字符`);
const normalizedName = computed(() => newName.value.trim());
const duplicateNames = computed(() => new Set(props.existingNames.map((name) => name.trim().toLocaleLowerCase("zh-CN"))));
const validationMessage = computed(() => {
  if (!props.vm) return "未选择虚拟机";
  if (!capability.value) return "平台能力信息尚未加载";
  if (!capability.value.supported) return capability.value.message || "当前平台暂不支持虚拟机改名";
  if (!normalizedName.value) return "请输入新的虚拟机名称";
  if (normalizedName.value.length > maxLength.value) return `名称不能超过 ${maxLength.value} 个字符`;
  if (namePattern.value && !namePattern.value.test(normalizedName.value)) return capability.value.patternMessage || "名称格式不正确";
  if (normalizedName.value === props.vm.name.trim()) return "新名称不能与当前名称相同";
  if (duplicateNames.value.has(normalizedName.value.toLocaleLowerCase("zh-CN"))) return `${capability.value.duplicateScope}内已存在同名虚拟机`;
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
            :maxlength="maxLength"
            placeholder="输入新的虚拟机名称"
            clearable
            :disabled="saving"
            @blur="touched = true"
            @keyup.enter="submit"
          />
        </label>
        <div class="vm-rename-field-meta" :class="{ 'is-error': touched && validationMessage }">
          <span>{{ touched && validationMessage ? validationMessage : constraintText }}</span>
          <span>{{ normalizedName.length }} / {{ maxLength }}</span>
        </div>
      </section>

      <section class="vm-rename-group vm-rename-strategy" aria-label="平台执行策略">
        <div class="vm-rename-group-title">
          <span>平台策略</span>
          <strong>{{ providerDescriptor?.label || "虚拟化平台" }}</strong>
        </div>
        <dl>
          <div><dt>执行方式</dt><dd>由平台 Provider 执行并回读结果</dd></div>
          <div><dt>重名检查</dt><dd>{{ capability?.duplicateScope || "平台默认范围" }}</dd></div>
          <div><dt>生效范围</dt><dd>{{ capability?.effect || "更新虚拟机显示名称" }}</dd></div>
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
