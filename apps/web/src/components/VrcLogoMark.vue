<script setup lang="ts">
import { computed, useId } from "vue";

const props = withDefaults(
  defineProps<{
    title?: string;
    decorative?: boolean;
    shadow?: boolean;
    grid?: boolean;
  }>(),
  {
    title: "VRC",
    decorative: true,
    shadow: false,
    grid: true,
  },
);

const logoId = useId().replace(/:/g, "");
const gradientId = computed(() => `${logoId}-gradient`);
const gridId = computed(() => `${logoId}-grid`);
const shadowId = computed(() => `${logoId}-shadow`);
</script>

<template>
  <svg
    class="vrc-logo-mark"
    viewBox="0 0 128 128"
    role="img"
    :aria-hidden="decorative ? 'true' : undefined"
    :aria-label="decorative ? undefined : title"
  >
    <defs>
      <linearGradient :id="gradientId" x1="24" y1="16" x2="104" y2="118" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#527c67" />
        <stop offset="1" stop-color="#2f5944" />
      </linearGradient>
      <pattern :id="gridId" width="11" height="11" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <path d="M 0 0 L 0 11" stroke="#ffffff" stroke-opacity=".075" stroke-width="1" />
      </pattern>
      <filter v-if="shadow" :id="shadowId" x="-20%" y="-20%" width="140%" height="150%">
        <feDropShadow dx="0" dy="8" stdDeviation="8" flood-color="#173128" flood-opacity=".22" />
      </filter>
    </defs>
    <rect
      x="17"
      y="17"
      width="94"
      height="94"
      rx="20"
      :fill="`url(#${gradientId})`"
      :filter="shadow ? `url(#${shadowId})` : undefined"
    />
    <rect v-if="grid" x="17" y="17" width="94" height="94" rx="20" :fill="`url(#${gridId})`" />
    <text class="vrc-logo-mark__text" x="64" y="60" text-anchor="middle" dominant-baseline="middle">VRC</text>
    <rect class="vrc-logo-mark__cursor" x="70" y="78" width="19" height="4" rx="2" />
  </svg>
</template>
