<script setup lang="ts">
export type VrcToolbarIconName =
  | "create-vm"
  | "export"
  | "overview"
  | "refresh"
  | "schedule";

defineProps<{
  name: VrcToolbarIconName;
}>();
</script>

<template>
  <svg class="vrc-toolbar-icon" viewBox="0 0 24 24" aria-hidden="true">
    <template v-if="name === 'create-vm'">
      <path d="M4.6 6.4h10.8c.72 0 1.3.58 1.3 1.3v6.2c0 .72-.58 1.3-1.3 1.3H4.6c-.72 0-1.3-.58-1.3-1.3V7.7c0-.72.58-1.3 1.3-1.3Z" />
      <path d="M10 15.2v2.25" />
      <path d="M7.75 17.45h4.5" />
      <path d="M18.75 11.9v5.8" />
      <path d="M15.85 14.8h5.8" />
    </template>
    <template v-else-if="name === 'export'">
      <path d="M12 5.25v9.2" />
      <path d="M8.55 10.95 12 14.4l3.45-3.45" />
      <path d="M6.15 16.35v1.45c0 .78.62 1.4 1.4 1.4h8.9c.78 0 1.4-.62 1.4-1.4v-1.45" />
    </template>
    <template v-else-if="name === 'overview'">
      <rect x="4.25" y="4.25" width="6.25" height="6.25" rx="1.1" />
      <rect x="13.5" y="4.25" width="6.25" height="6.25" rx="1.1" />
      <rect x="4.25" y="13.5" width="6.25" height="6.25" rx="1.1" />
      <path d="M13.5 19.75h6.25v-6.25H13.5z" />
    </template>
    <template v-else-if="name === 'refresh'">
      <path d="M17.85 7.35A7.05 7.05 0 0 0 5.35 9.9" />
      <path d="M17.85 4.85v2.5h-2.55" />
      <path d="M6.15 16.65a7.05 7.05 0 0 0 12.5-2.55" />
      <path d="M6.15 19.15v-2.5H8.7" />
    </template>
    <template v-else-if="name === 'schedule'">
      <path d="M9.1 4.5h5.8M12 4.5v2.2" />
      <path d="M17.35 7.35 18.7 6" />
      <circle cx="12" cy="13.4" r="6.25" />
      <path d="M12 9.8v3.6l2.55 1.45" />
    </template>
  </svg>
</template>
