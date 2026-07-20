<script setup lang="ts">
withDefaults(defineProps<{
  variant: "rack-badge" | "server-plus" | "rack-stack" | "inset-plus" | "node-plus" | "tray-plus";
  size?: number;
}>(), {
  size: 18,
});
</script>

<template>
  <svg
    class="vm-resize-icon-mark"
    :viewBox="variant === 'rack-stack' ? '0 0 18 18' : '0 0 24 24'"
    :style="{ width: `${size}px`, height: `${size}px` }"
    fill="none"
    aria-hidden="true"
  >
    <template v-if="variant === 'rack-badge'">
      <rect x="3.5" y="5" width="13.5" height="14" rx="1.5" />
      <path d="M6.5 9h5.8M6.5 13h5.8M6.5 17h3.8" />
      <circle cx="17.5" cy="7" r="3.5" class="plus-badge" />
      <path d="M17.5 5.35v3.3M15.85 7h3.3" class="plus-stroke" />
    </template>

    <template v-else-if="variant === 'server-plus'">
      <rect x="3.5" y="4.5" width="11.5" height="15" rx="1.5" />
      <path d="M6.5 8.5h5.5M6.5 12h5.5M6.5 15.5h3.2" />
      <circle cx="12.1" cy="15.5" r=".65" class="status-dot" />
      <path d="M19 9v7M15.5 12.5h7" class="plus-stroke plus-large" />
    </template>

    <template v-else-if="variant === 'rack-stack'">
      <rect x="2.75" y="4.75" width="11.5" height="3.5" rx=".75" class="rack-stack-body" />
      <rect x="2.75" y="10.75" width="11.5" height="3.5" rx=".75" class="rack-stack-body" />
      <path d="M14.75 1.6v4.8M12.35 4h4.8" class="plus-stroke rack-stack-plus" />
    </template>

    <template v-else-if="variant === 'inset-plus'">
      <rect x="3.5" y="4.5" width="17" height="15" rx="1.5" />
      <path d="M3.5 9.5h17M7 7h.01M9.5 7h.01" />
      <path d="M12 12v5M9.5 14.5h5" class="plus-stroke plus-large" />
    </template>

    <template v-else-if="variant === 'node-plus'">
      <rect x="3.5" y="5" width="12.5" height="13.5" rx="1.4" />
      <path d="M6.3 8.5h6.8M6.3 12h6.8M6.3 15.5h3.8" />
      <path d="M16 10.5h2.3v2" />
      <circle cx="19" cy="15.5" r="3.3" class="plus-badge" />
      <path d="M19 13.95v3.1M17.45 15.5h3.1" class="plus-stroke" />
    </template>

    <template v-else>
      <path d="M4 7.3h16v10.4H4z" />
      <path d="M7 10.5h6M7 14.5h4M4 17.7l2 2h12l2-2" />
      <circle cx="18" cy="7" r="3.4" class="plus-badge" />
      <path d="M18 5.4v3.2M16.4 7h3.2" class="plus-stroke" />
    </template>
  </svg>
</template>

<style scoped>
.vm-resize-icon-mark {
  flex: 0 0 auto;
  overflow: visible;
  color: currentColor;
  stroke: currentColor;
  stroke-width: 1.55;
  stroke-linecap: round;
  stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
}

.plus-badge {
  fill: var(--vrc-surface, #fff);
  stroke-width: 1.55;
}

.plus-stroke {
  stroke-width: 1.65;
}

.plus-large {
  stroke-width: 1.8;
}

.status-dot {
  fill: currentColor;
  stroke: none;
}

.rack-stack-body {
  stroke-width: 1.5;
}

.rack-stack-plus {
  stroke-width: 1.7;
}
</style>
