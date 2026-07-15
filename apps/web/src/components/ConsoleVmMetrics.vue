<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { ConsoleMetricKey } from "../domain/consoleStrategies";

const props = defineProps<{
  mode: "side" | "overlay";
  loading: boolean;
  loadingMetrics: readonly ConsoleMetricKey[];
  memoryPressureTone: boolean;
  refreshIntervalMs: number;
  cpuPercent: number | null;
  cpuValue: string;
  cpuDetail: string;
  memoryPercent: number | null;
  memoryValue: string;
  memoryDetail: string;
  networkRate: string;
  networkDetail: string;
  networkBarPercent: number;
  diskPercent: number | null;
  diskValue: string;
  diskDetail: string;
  diskActivityPercent: number;
  sampledAt: string;
}>();

const memoryCardRef = ref<HTMLElement | null>(null);
const diskCardRef = ref<HTMLElement | null>(null);
const memoryPathRef = ref<SVGPathElement | null>(null);
const diskPathRef = ref<SVGPathElement | null>(null);
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const waveStates = [
  createWaveState(memoryCardRef, memoryPathRef, 0.73),
  createWaveState(diskCardRef, diskPathRef, 2.41),
];
let animationFrame: number | null = null;
let lastFrame = 0;
let resizeObserver: ResizeObserver | null = null;

const metricLabels: Record<"side" | "overlay", Record<ConsoleMetricKey, string>> = {
  side: { cpu: "CPU", memory: "内存", network: "网络", disk: "磁盘" },
  overlay: { cpu: "CPU", memory: "MEM", network: "NET", disk: "DISK" },
};
const placeholderLabels = computed(() => props.loadingMetrics.map((metric) => metricLabels[props.mode][metric]));
const sampledAtLabel = computed(() => {
  if (props.mode === "overlay") return `${Math.max(Math.round(props.refreshIntervalMs / 1000), 1)}s refresh`;
  if (props.loading) return "";
  const sampledAt = new Date(props.sampledAt);
  if (!Number.isFinite(sampledAt.getTime())) return "刚刚";
  return sampledAt.toLocaleTimeString("zh-CN", { hour12: false });
});

onMounted(() => {
  resizeObserver = new ResizeObserver(() => updateWaveWidths());
  waveStates.forEach((wave) => {
    if (wave.card.value) resizeObserver?.observe(wave.card.value);
  });
  updateWaveWidths();
  animateWaves();
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
  if (animationFrame != null) window.cancelAnimationFrame(animationFrame);
});

function createWaveState(card: typeof memoryCardRef, path: typeof memoryPathRef, seed: number) {
  return {
    card,
    path,
    seed,
    width: 160,
    speedA: 0.0011 + seed * 0.00008,
    speedB: 0.00072 + seed * 0.00004,
    driftSpeed: 0.00034 + seed * 0.00002,
  };
}

function updateWaveWidths() {
  waveStates.forEach((wave) => {
    wave.width = wave.card.value?.clientWidth || 160;
  });
}

function animateWaves(time = 0) {
  if (time - lastFrame >= 32 || lastFrame === 0) {
    waveStates.forEach((wave) => wave.path.value?.setAttribute("d", buildWavePath(wave, time)));
    lastFrame = time;
  }
  if (!reduceMotion) animationFrame = window.requestAnimationFrame(animateWaves);
}

function buildWavePath(wave: (typeof waveStates)[number], time: number) {
  const points: Array<{ x: number; y: number }> = [];
  const pointCount = 28;
  const primaryAmplitude = 7 + Math.sin(time * wave.driftSpeed + wave.seed) * 1.8;
  const secondaryAmplitude = 2.6 + Math.sin(time * wave.driftSpeed * 1.71 + wave.seed * 1.9) * 1.1;
  const verticalDrift = Math.sin(time * wave.driftSpeed * 0.63 + wave.seed * 2.4) * 1.4;
  const primaryCycles = clamp(wave.width / 250, 1.15, 5.4);
  const secondaryCycles = primaryCycles * 2.05;
  const irregularCycles = Math.max(0.58, primaryCycles * 0.46);

  for (let index = 0; index <= pointCount; index += 1) {
    const x = (index / pointCount) * 1000;
    const primary = Math.sin((x / 1000) * Math.PI * 2 * primaryCycles + time * wave.speedA + wave.seed) * primaryAmplitude;
    const secondary = Math.sin((x / 1000) * Math.PI * 2 * secondaryCycles - time * wave.speedB + wave.seed * 1.47) * secondaryAmplitude;
    const irregularity = Math.sin((x / 1000) * Math.PI * 2 * irregularCycles + time * wave.driftSpeed + wave.seed * 2.1) * 1.5;
    points.push({ x, y: clamp(16 + verticalDrift + primary + secondary + irregularity, 4, 30) });
  }

  let pathData = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  for (let index = 1; index < points.length - 1; index += 1) {
    const point = points[index];
    const next = points[index + 1];
    pathData += ` Q ${point.x.toFixed(1)} ${point.y.toFixed(1)} ${((point.x + next.x) / 2).toFixed(1)} ${((point.y + next.y) / 2).toFixed(1)}`;
  }
  const penultimate = points[points.length - 2];
  const last = points[points.length - 1];
  return `${pathData} Q ${penultimate.x.toFixed(1)} ${penultimate.y.toFixed(1)} ${last.x.toFixed(1)} ${last.y.toFixed(1)} L 1000 140 L 0 140 Z`;
}

function waterTone(percent: number | null) {
  if (percent == null) return "";
  if (percent >= 90) return "is-danger";
  if (percent >= 75) return "is-warning";
  return "";
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
</script>

<template>
  <section
    class="console-vm-metrics"
    :class="[`is-${mode}`, { 'is-loading': loading }]"
    aria-label="VM 实时资源"
    :aria-busy="loading"
  >
    <header class="console-vm-metrics-head">
      <strong>{{ mode === "overlay" ? "VM 资源监控" : "实时资源" }}</strong>
      <span>{{ sampledAtLabel }}</span>
    </header>
    <div class="console-vm-metrics-grid">
      <template v-if="loading">
        <article v-for="label in placeholderLabels" :key="label" class="console-vm-metric-tile is-skeleton" aria-hidden="true">
          <label>{{ label }}</label>
          <span class="console-vm-metric-skeleton-value"></span>
          <span class="console-vm-metric-skeleton-detail"></span>
          <span class="console-vm-metric-skeleton-meter"></span>
        </article>
      </template>

      <template v-else>
        <article class="console-vm-metric-tile" :class="{ 'is-fallback': cpuPercent == null }">
          <label>CPU</label>
          <strong>{{ cpuValue }}</strong>
          <small>{{ cpuDetail }}</small>
          <span class="console-vm-metric-meter" aria-hidden="true"><i :style="{ width: `${cpuPercent ?? 0}%` }"></i></span>
        </article>

        <article
          ref="memoryCardRef"
          class="console-vm-metric-tile"
          :class="[{ 'is-water': memoryPercent != null, 'is-fallback': memoryPercent == null }, memoryPressureTone ? waterTone(memoryPercent) : '']"
          :style="memoryPercent == null ? undefined : { '--metric-level': `${memoryPercent}%` }"
        >
          <span v-if="memoryPercent != null" class="console-vm-metric-liquid" aria-hidden="true">
            <svg viewBox="0 0 1000 140" preserveAspectRatio="none"><path ref="memoryPathRef"></path></svg>
          </span>
          <label>{{ mode === "overlay" ? "MEM" : "内存" }}</label>
          <strong>{{ memoryValue }}</strong>
          <small>{{ memoryDetail }}</small>
          <span v-if="memoryPercent == null" class="console-vm-metric-meter" aria-hidden="true"><i></i></span>
        </article>

        <article class="console-vm-metric-tile" :class="{ 'is-fallback': networkRate === '--' }">
          <label>{{ mode === "overlay" ? "NET" : "网络" }}</label>
          <strong>{{ networkRate }}</strong>
          <small>{{ networkDetail }}</small>
          <span class="console-vm-metric-meter" aria-hidden="true"><i :style="{ width: `${networkBarPercent}%` }"></i></span>
        </article>

        <article
          ref="diskCardRef"
          class="console-vm-metric-tile"
          :class="[{ 'is-water': diskPercent != null, 'is-fallback': diskPercent == null }, waterTone(diskPercent)]"
          :style="diskPercent == null ? undefined : { '--metric-level': `${diskPercent}%` }"
        >
          <span v-if="diskPercent != null" class="console-vm-metric-liquid" aria-hidden="true">
            <svg viewBox="0 0 1000 140" preserveAspectRatio="none"><path ref="diskPathRef"></path></svg>
          </span>
          <label>{{ mode === "overlay" ? "DISK" : "磁盘" }}</label>
          <strong>{{ diskValue }}</strong>
          <small>{{ diskDetail }}</small>
          <span v-if="diskPercent == null" class="console-vm-metric-meter" aria-hidden="true"><i :style="{ width: `${diskActivityPercent}%` }"></i></span>
        </article>
      </template>
    </div>
  </section>
</template>
