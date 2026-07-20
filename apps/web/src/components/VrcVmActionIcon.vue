<script setup lang="ts">
import VmResizeIconMark from "./VmResizeIconMark.vue";

defineProps<{
  name: "start" | "shutdown" | "forceReboot" | "resize" | "delete";
}>();
</script>

<template>
  <VmResizeIconMark v-if="name === 'resize'" variant="rack-stack" :size="17" class="vrc-vm-action-icon is-resize" />
  <svg v-else class="vrc-vm-action-icon" :class="`is-${name}`" viewBox="0 0 24 24" aria-hidden="true">
    <template v-if="name === 'start'">
      <path d="M8.25 5.75v12.5L18 12Z" />
    </template>
    <template v-else-if="name === 'shutdown'">
      <path d="M12 4.9v6.8" />
      <path d="M7.4 7.7a6.7 6.7 0 1 0 9.2 0" />
    </template>
    <template v-else-if="name === 'forceReboot'">
      <path d="M4.7 9.4A7.5 7.5 0 0 1 18.2 7.2" />
      <path d="M18.2 4.4v3.2H15" />
      <path d="M19.3 14.6A7.5 7.5 0 0 1 5.8 16.8" />
      <path d="M5.8 19.6v-3.2H9" />
      <path d="M10 8.7v6.6l5.2-3.3Z" />
    </template>
    <template v-else>
      <path d="M6.4 7.4h11.2" />
      <path d="M9.4 7.4V5.5h5.2v1.9" />
      <path d="M8.1 9.8l.62 7.95c.07.8.68 1.35 1.48 1.35h3.6c.8 0 1.41-.55 1.48-1.35l.62-7.95" />
    </template>
  </svg>
</template>
