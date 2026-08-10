<script setup lang="ts">
import VmResizeIconMark from "./VmResizeIconMark.vue";

defineProps<{
  name: "start" | "shutdown" | "forceReboot" | "resize" | "diagnose" | "snapshot" | "delete";
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
    <template v-else-if="name === 'diagnose'">
      <path d="M5.4 12.1a6.6 6.6 0 1 0 13.2 0 6.6 6.6 0 0 0-13.2 0Z" />
      <path d="M9.2 12.2h1.75l1.05-2.65 1.55 5.2 1.05-2.55h1.95" />
      <path d="M16.7 16.8l2.2 2.2" />
    </template>
    <template v-else-if="name === 'snapshot'">
      <path d="M5.2 8.4h2.15l1.3-2.05h6.7l1.3 2.05h2.15c.61 0 1.1.49 1.1 1.1v7.1c0 .61-.49 1.1-1.1 1.1H5.2a1.1 1.1 0 0 1-1.1-1.1V9.5c0-.61.49-1.1 1.1-1.1Z" />
      <circle cx="12" cy="12.9" r="3.15" />
    </template>
    <template v-else>
      <path d="M5.9 7.4h12.2" />
      <path d="M9.1 7.4V5.5h5.8v1.9" />
      <path d="M7.7 9.8l.66 7.95c.07.8.7 1.35 1.5 1.35h4.28c.8 0 1.43-.55 1.5-1.35l.66-7.95" />
      <path d="M10.7 11.2v5.25" />
      <path d="M13.3 11.2v5.25" />
    </template>
  </svg>
</template>
