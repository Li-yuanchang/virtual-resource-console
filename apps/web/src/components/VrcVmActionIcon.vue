<script setup lang="ts">
defineProps<{
  name: "start" | "shutdown" | "delete";
}>();
</script>

<template>
  <svg class="vrc-vm-action-icon" :class="`is-${name}`" viewBox="0 0 24 24" aria-hidden="true">
    <template v-if="name === 'start'">
      <path d="M8 5v14l11-7Z" />
    </template>
    <template v-else-if="name === 'shutdown'">
      <path d="M12 4.9v6.8" />
      <path d="M7.4 7.7a6.7 6.7 0 1 0 9.2 0" />
    </template>
    <template v-else>
      <path d="M6.4 7.4h11.2" />
      <path d="M9.4 7.4V5.5h5.2v1.9" />
      <path d="M8.1 9.8l.62 7.95c.07.8.68 1.35 1.48 1.35h3.6c.8 0 1.41-.55 1.48-1.35l.62-7.95" />
    </template>
  </svg>
</template>
