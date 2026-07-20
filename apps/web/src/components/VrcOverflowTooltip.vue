<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, useAttrs, watch } from "vue";

defineOptions({ inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    content: string;
    placement?: "bottom" | "bottom-end";
  }>(),
  {
    placement: "bottom",
  },
);

const attrs = useAttrs();
const triggerRef = ref<HTMLElement | null>(null);
const overflowing = ref(false);
let resizeObserver: ResizeObserver | null = null;

function updateOverflowState() {
  const target = triggerRef.value?.querySelector<HTMLElement>("[data-overflow-target]") ?? triggerRef.value;
  overflowing.value = Boolean(target && (target.scrollWidth > target.clientWidth + 1 || target.scrollHeight > target.clientHeight + 1));
}

onMounted(async () => {
  await nextTick();
  updateOverflowState();
  if (!triggerRef.value) return;
  resizeObserver = new ResizeObserver(updateOverflowState);
  resizeObserver.observe(triggerRef.value);
});

watch(
  () => props.content,
  () => void nextTick(updateOverflowState),
);

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
});
</script>

<template>
  <el-tooltip
    :content="content"
    :disabled="!overflowing"
    :placement="placement"
    popper-class="vrc-provision-resource-tooltip"
  >
    <span ref="triggerRef" v-bind="attrs"><slot /></span>
  </el-tooltip>
</template>
