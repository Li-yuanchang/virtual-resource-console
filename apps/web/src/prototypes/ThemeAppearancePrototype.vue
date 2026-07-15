<script setup lang="ts">
import {
  ArrowLeft,
  Brush,
  Connection,
  Download,
  Picture,
  Plus,
  RefreshLeft,
  Search,
  Setting,
  Tickets,
  Upload,
} from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

type ThemeName = "graphite-sage" | "basalt-copper" | "mist-teal";
type ToneMode = "system" | "light" | "dark";
type BackgroundMode = "default" | "solid" | "image";

interface ThemeOption {
  value: ThemeName;
  name: string;
  tone: string;
  description: string;
  colors: string[];
  accent: string;
  success: string;
  warning: string;
  danger: string;
}

const themeOptions: ThemeOption[] = [
  {
    value: "graphite-sage",
    name: "石墨青",
    tone: "当前默认",
    description: "低饱和灰绿，适合长时间查看资源和状态。",
    colors: ["#f5f6f2", "#fbfbf7", "#426b57", "#27302a"],
    accent: "#426b57",
    success: "#477a45",
    warning: "#b77935",
    danger: "#a5483d",
  },
  {
    value: "basalt-copper",
    name: "玄武铜",
    tone: "暖色",
    description: "暖灰底配铜色强调，层级清楚但不刺眼。",
    colors: ["#f4f2ed", "#fcfaf5", "#9b5f35", "#2f2b24"],
    accent: "#9b5f35",
    success: "#4f7549",
    warning: "#b77935",
    danger: "#a34f42",
  },
  {
    value: "mist-teal",
    name: "雾青",
    tone: "清爽",
    description: "偏冷的青灰色，适合信息密度较高的列表。",
    colors: ["#f3f6f4", "#fbfcfa", "#2f6f68", "#22302d"],
    accent: "#2f6f68",
    success: "#4d7a50",
    warning: "#ad7833",
    danger: "#a3483f",
  },
];

const accentPresets = ["#426b57", "#2f6f68", "#315f92", "#6a5b88", "#9b5f35", "#8a4f5d"];
const currentTheme = ref<ThemeName>("graphite-sage");
const toneMode = ref<ToneMode>("light");
const systemDark = ref(false);
const accentColor = ref(themeOptions[0].accent);
const successColor = ref(themeOptions[0].success);
const warningColor = ref(themeOptions[0].warning);
const dangerColor = ref(themeOptions[0].danger);
const backgroundMode = ref<BackgroundMode>("default");
const backgroundColor = ref("#edf1ee");
const defaultBackgroundImage = "https://images.unsplash.com/photo-1558494949-ef010cbdcc31?auto=format&fit=crop&w=1600&q=82";
const backgroundImage = ref(defaultBackgroundImage);
const backgroundImageName = ref("内置示例");
const backgroundOpacity = ref(18);
const backgroundBlur = ref(0);
const overlayOpacity = ref(8);
const showIconTooltips = ref(true);
const truncateLongNames = ref(true);
const throttleConsoleResize = ref(true);
const imageFileInput = ref<HTMLInputElement>();
const jsonFileInput = ref<HTMLInputElement>();
let darkModeQuery: MediaQueryList | undefined;
let backgroundObjectUrl: string | undefined;

const resolvedDark = computed(() => toneMode.value === "dark" || (toneMode.value === "system" && systemDark.value));
const backgroundPreviewStyle = computed(() => ({ backgroundImage: `url(${JSON.stringify(backgroundImage.value)})` }));

const prototypeStyle = computed<Record<string, string>>(() => {
  const style: Record<string, string> = {
    "--vrc-accent": accentColor.value,
    "--vrc-accent-hover": `color-mix(in srgb, ${accentColor.value} 82%, black)`,
    "--vrc-accent-soft": `color-mix(in srgb, ${accentColor.value} 13%, var(--vrc-surface))`,
    "--vrc-success": successColor.value,
    "--vrc-warning": warningColor.value,
    "--vrc-danger": dangerColor.value,
    "--prototype-background-color": backgroundMode.value === "solid" ? backgroundColor.value : "transparent",
    "--prototype-background-image": backgroundMode.value === "image" ? `url(${JSON.stringify(backgroundImage.value)})` : "none",
    "--prototype-background-opacity": String(backgroundOpacity.value / 100),
    "--prototype-background-blur": `${backgroundBlur.value}px`,
    "--prototype-overlay-opacity": String(overlayOpacity.value / 100),
  };

  if (resolvedDark.value) {
    Object.assign(style, {
      "--vrc-bg": "#171a19",
      "--vrc-surface": "#202422",
      "--vrc-surface-muted": "#292e2b",
      "--vrc-surface-raised": "#252a27",
      "--vrc-border": "#383f3b",
      "--vrc-border-strong": "#56605a",
      "--vrc-text": "#e7ebe8",
      "--vrc-text-muted": "#a6aea9",
      "--vrc-text-subtle": "#7e8882",
      "--vrc-tooltip-bg": "#0f1210",
    });
  }

  return style;
});

function applyTheme(value: ThemeName) {
  const theme = themeOptions.find((item) => item.value === value);
  if (!theme) return;
  currentTheme.value = value;
  accentColor.value = theme.accent;
  successColor.value = theme.success;
  warningColor.value = theme.warning;
  dangerColor.value = theme.danger;
  document.documentElement.dataset.theme = value;
}

function resetPrototype() {
  releaseBackgroundObjectUrl();
  toneMode.value = "light";
  backgroundMode.value = "default";
  backgroundColor.value = "#edf1ee";
  backgroundImage.value = defaultBackgroundImage;
  backgroundImageName.value = "内置示例";
  backgroundOpacity.value = 18;
  backgroundBlur.value = 0;
  overlayOpacity.value = 8;
  showIconTooltips.value = true;
  truncateLongNames.value = true;
  throttleConsoleResize.value = true;
  applyTheme("graphite-sage");
}

function selectImageFile() {
  imageFileInput.value?.click();
}

function loadBackgroundImage(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  const objectUrl = URL.createObjectURL(file);
  const image = new Image();
  image.addEventListener("load", () => {
    releaseBackgroundObjectUrl();
    backgroundObjectUrl = objectUrl;
    backgroundImage.value = objectUrl;
    backgroundImageName.value = file.name;
    backgroundMode.value = "image";
    backgroundOpacity.value = Math.max(backgroundOpacity.value, 32);
    ElMessage.success("背景图片已载入");
  });
  image.addEventListener("error", () => {
    URL.revokeObjectURL(objectUrl);
    ElMessage.error("图片无法读取，请使用 JPG、PNG 或 WebP 文件");
  });
  image.src = objectUrl;
  input.value = "";
}

function releaseBackgroundObjectUrl() {
  if (!backgroundObjectUrl) return;
  URL.revokeObjectURL(backgroundObjectUrl);
  backgroundObjectUrl = undefined;
}

function exportTheme() {
  const config = {
    version: 1,
    baseTheme: currentTheme.value,
    toneMode: toneMode.value,
    colors: {
      accent: accentColor.value,
      success: successColor.value,
      warning: warningColor.value,
      danger: dangerColor.value,
    },
    background: {
      mode: backgroundMode.value,
      color: backgroundColor.value,
      image: backgroundImage.value.startsWith("data:") ? "" : backgroundImage.value,
      opacity: backgroundOpacity.value,
      blur: backgroundBlur.value,
      overlay: overlayOpacity.value,
    },
  };
  const blob = new Blob([JSON.stringify(config, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "vrc-theme.json";
  link.click();
  URL.revokeObjectURL(link.href);
}

function selectJsonFile() {
  jsonFileInput.value?.click();
}

function importTheme(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.addEventListener("load", () => {
    try {
      const config = JSON.parse(String(reader.result)) as Record<string, any>;
      if (themeOptions.some((theme) => theme.value === config.baseTheme)) applyTheme(config.baseTheme as ThemeName);
      if (["system", "light", "dark"].includes(config.toneMode)) toneMode.value = config.toneMode as ToneMode;
      if (config.colors?.accent) accentColor.value = config.colors.accent;
      if (config.colors?.success) successColor.value = config.colors.success;
      if (config.colors?.warning) warningColor.value = config.colors.warning;
      if (config.colors?.danger) dangerColor.value = config.colors.danger;
      if (["default", "solid", "image"].includes(config.background?.mode)) backgroundMode.value = config.background.mode;
      if (config.background?.color) backgroundColor.value = config.background.color;
      if (config.background?.image) backgroundImage.value = config.background.image;
      if (Number.isFinite(config.background?.opacity)) backgroundOpacity.value = config.background.opacity;
      if (Number.isFinite(config.background?.blur)) backgroundBlur.value = config.background.blur;
      if (Number.isFinite(config.background?.overlay)) overlayOpacity.value = config.background.overlay;
      ElMessage.success("主题配置已载入原型");
    } catch {
      ElMessage.error("主题配置文件格式不正确");
    }
  });
  reader.readAsText(file);
  input.value = "";
}

function updateSystemMode(event: MediaQueryListEvent | MediaQueryList) {
  systemDark.value = event.matches;
}

onMounted(() => {
  darkModeQuery = window.matchMedia("(prefers-color-scheme: dark)");
  updateSystemMode(darkModeQuery);
  darkModeQuery.addEventListener("change", updateSystemMode);
});

onBeforeUnmount(() => {
  darkModeQuery?.removeEventListener("change", updateSystemMode);
  releaseBackgroundObjectUrl();
});
</script>

<template>
  <main class="app-shell prototype-app-shell" :style="prototypeStyle">
    <aside class="sidebar">
      <div class="sidebar-head">
        <div class="brand-lockup">
          <span class="brand-mark sidebar-logo" aria-hidden="true">
            <svg class="vrc-system-logo" viewBox="0 0 64 48">
              <rect class="vrc-logo-tile" x="5" y="5" width="54" height="38" rx="10" />
              <text class="vrc-logo-letter" x="32" y="29" text-anchor="middle">VRC</text>
              <rect class="vrc-logo-cursor" x="38" y="34" width="11" height="2.5" rx="1.25" />
            </svg>
          </span>
          <div class="brand-copy">
            <h1>资源控制台</h1>
            <p>3 个连接</p>
          </div>
        </div>
        <button class="icon-button settings-entry-button active" type="button" aria-label="设置">
          <el-icon><Setting /></el-icon>
        </button>
      </div>

      <section class="sidebar-section">
        <el-input class="sidebar-search" placeholder="输入名称、平台或地址" :prefix-icon="Search" clearable />
      </section>

      <div class="connection-groups">
        <section class="connection-group overview-group">
          <button class="overview-entry" type="button">
            <span class="overview-entry-icon">↗</span>
            <span class="overview-entry-main">
              <strong>资源总览</strong>
              <small>查看全部物理机</small>
            </span>
          </button>
        </section>
        <section class="connection-group">
          <div class="group-title"><span>生产环境</span></div>
          <button class="connection-item" type="button">
            <span class="status-dot online"></span>
            <span class="connection-main"><strong>xenserver-1</strong><small>10.10.1.21</small></span>
            <span class="connection-port">22</span>
          </button>
          <button class="connection-item" type="button">
            <span class="status-dot online"></span>
            <span class="connection-main"><strong>xenserver-2</strong><small>10.10.1.22</small></span>
            <span class="connection-port">22</span>
          </button>
        </section>
        <section class="connection-group">
          <div class="group-title"><span>测试环境</span></div>
          <button class="connection-item" type="button">
            <span class="status-dot"></span>
            <span class="connection-main"><strong>vmware-lab</strong><small>10.10.2.11</small></span>
            <span class="connection-port">443</span>
          </button>
        </section>
      </div>

      <button class="activity-toggle" type="button">
        <span class="activity-toggle-icon" aria-hidden="true"><el-icon><Tickets /></el-icon></span>
        <span>操作记录</span>
        <strong>6</strong>
      </button>
    </aside>

    <section class="workspace is-settings-mode">
      <section class="panel settings-workspace-panel">
        <div class="settings-workspace-head">
          <div>
            <h3>设置</h3>
            <span>管理外观、连接、创建模板和运行日志。</span>
          </div>
          <button type="button" class="settings-close-button">
            <el-icon><ArrowLeft /></el-icon>
            <span>返回资源总览</span>
          </button>
        </div>

        <div class="settings-workspace-layout">
          <aside class="settings-workspace-nav" aria-label="设置分组">
            <button type="button" class="active"><el-icon><Brush /></el-icon><span>外观</span></button>
            <button type="button"><el-icon><Connection /></el-icon><span>连接</span></button>
            <button type="button"><el-icon><Plus /></el-icon><span>创建模板</span></button>
            <button type="button"><el-icon><Tickets /></el-icon><span>日志</span></button>
          </aside>

          <section class="settings-workspace-content prototype-theme-canvas">
            <section class="settings-card">
              <div class="settings-card-head">
                <div>
                  <strong>主题</strong>
                  <span>选择后全局应用，背景、surface、表格、弹窗、loading、toast 和图表都跟随主题。</span>
                </div>
              </div>
              <div class="settings-theme-card-grid">
                <button
                  v-for="theme in themeOptions"
                  :key="theme.value"
                  type="button"
                  class="settings-theme-card"
                  :class="{ active: currentTheme === theme.value }"
                  :aria-pressed="currentTheme === theme.value"
                  @click="applyTheme(theme.value)"
                >
                  <span class="settings-theme-card-head"><strong>{{ theme.name }}</strong><small>{{ theme.tone }}</small></span>
                  <span class="theme-swatch" aria-hidden="true">
                    <i v-for="color in theme.colors" :key="color" :style="{ background: color }"></i>
                  </span>
                  <span>{{ theme.description }}</span>
                </button>
              </div>
            </section>

            <section class="settings-card prototype-custom-settings">
              <div class="settings-card-head prototype-custom-head">
                <div>
                  <strong>自定义主题</strong>
                  <span>在基础主题上覆盖语义色和工作区背景，未修改的组件继续使用系统样式变量。</span>
                </div>
                <div class="prototype-head-actions">
                  <el-button size="small" :icon="Upload" @click="selectJsonFile">载入</el-button>
                  <el-button size="small" :icon="Download" @click="exportTheme">导出</el-button>
                  <el-button size="small" :icon="RefreshLeft" @click="resetPrototype">重置</el-button>
                </div>
              </div>

              <div class="prototype-custom-grid">
                <section class="prototype-setting-group">
                  <div class="prototype-group-title">
                    <strong>颜色</strong>
                    <span>基于语义变量覆盖，不逐个组件写死颜色。</span>
                  </div>
                  <div class="prototype-setting-row">
                    <div><strong>界面明暗</strong><span>浅色、深色或跟随系统。</span></div>
                    <el-segmented
                      v-model="toneMode"
                      class="prototype-tone-segmented"
                      :options="[{ label: '跟随系统', value: 'system' }, { label: '浅色', value: 'light' }, { label: '深色', value: 'dark' }]"
                      size="small"
                    />
                  </div>
                  <div class="prototype-setting-row prototype-accent-row">
                    <div><strong>强调色</strong><span>按钮、选中态、链接和图表主色。</span></div>
                    <div class="prototype-color-control">
                      <button
                        v-for="color in accentPresets"
                        :key="color"
                        class="prototype-color-chip"
                        :class="{ active: accentColor === color }"
                        type="button"
                        :style="{ '--chip-color': color }"
                        :aria-label="`使用强调色 ${color}`"
                        @click="accentColor = color"
                      ></button>
                      <el-color-picker v-model="accentColor" size="small" />
                    </div>
                  </div>
                  <div class="prototype-setting-row">
                    <div><strong>状态色</strong><span>成功、警告、危险保持独立语义。</span></div>
                    <div class="prototype-semantic-colors">
                      <label><span>成功</span><el-color-picker v-model="successColor" size="small" /></label>
                      <label><span>警告</span><el-color-picker v-model="warningColor" size="small" /></label>
                      <label><span>危险</span><el-color-picker v-model="dangerColor" size="small" /></label>
                    </div>
                  </div>
                </section>

                <section class="prototype-setting-group prototype-background-group">
                  <div class="prototype-group-title">
                    <strong>工作区背景</strong>
                    <span>背景只作用于内容画布，不覆盖侧栏和组件 surface。</span>
                  </div>
                  <div class="prototype-setting-row">
                    <div><strong>背景类型</strong><span>默认、纯色或本地图片。</span></div>
                    <el-radio-group v-model="backgroundMode" size="small">
                      <el-radio-button value="default">默认</el-radio-button>
                      <el-radio-button value="solid">纯色</el-radio-button>
                      <el-radio-button value="image">图片</el-radio-button>
                    </el-radio-group>
                  </div>
                  <div v-if="backgroundMode === 'solid'" class="prototype-setting-row">
                    <div><strong>背景颜色</strong><span>{{ backgroundColor }}</span></div>
                    <el-color-picker v-model="backgroundColor" size="small" />
                  </div>
                  <div v-if="backgroundMode === 'image'" class="prototype-setting-row">
                    <div><strong>背景图片</strong><span>支持 JPG、PNG 和 WebP。</span></div>
                    <div class="prototype-image-control">
                      <span class="prototype-image-preview" :style="backgroundPreviewStyle" aria-hidden="true"></span>
                      <span class="prototype-image-name" :title="backgroundImageName">{{ backgroundImageName }}</span>
                      <el-button size="small" :icon="Picture" @click="selectImageFile">选择图片</el-button>
                    </div>
                  </div>
                  <div v-if="backgroundMode === 'image'" class="prototype-slider-row">
                    <span>透明度</span><el-slider v-model="backgroundOpacity" :min="5" :max="60" :show-tooltip="false" /><strong>{{ backgroundOpacity }}%</strong>
                  </div>
                  <div v-if="backgroundMode === 'image'" class="prototype-slider-row">
                    <span>模糊</span><el-slider v-model="backgroundBlur" :min="0" :max="16" :show-tooltip="false" /><strong>{{ backgroundBlur }}px</strong>
                  </div>
                  <div v-if="backgroundMode !== 'default'" class="prototype-slider-row">
                    <span>遮罩</span><el-slider v-model="overlayOpacity" :min="0" :max="35" :show-tooltip="false" /><strong>{{ overlayOpacity }}%</strong>
                  </div>
                </section>
              </div>
            </section>

            <section class="settings-tile-grid" aria-label="外观偏好">
              <article class="settings-tile">
                <div class="settings-row"><strong>按钮密度</strong><span>28px 工具栏 / 24px 行内</span></div>
                <div class="settings-row">
                  <span>图标按钮显示 tooltip</span>
                  <button type="button" class="settings-switch" :class="{ active: showIconTooltips }" :aria-pressed="showIconTooltips" @click="showIconTooltips = !showIconTooltips"><i></i></button>
                </div>
              </article>
              <article class="settings-tile">
                <div class="settings-row"><strong>表格密度</strong><span>44-48px 行高</span></div>
                <div class="settings-row">
                  <span>长名称单行省略</span>
                  <button type="button" class="settings-switch" :class="{ active: truncateLongNames }" :aria-pressed="truncateLongNames" @click="truncateLongNames = !truncateLongNames"><i></i></button>
                </div>
              </article>
              <article class="settings-tile">
                <div class="settings-row"><strong>状态色</strong><span>成功 / 警告 / 危险</span></div>
                <span class="settings-status-swatches" aria-hidden="true"><i class="success"></i><i class="warning"></i><i class="danger"></i></span>
              </article>
              <article class="settings-tile">
                <div class="settings-row"><strong>控制台</strong><span>默认中尺寸</span></div>
                <div class="settings-row">
                  <span>拖拽中节流刷新</span>
                  <button type="button" class="settings-switch" :class="{ active: throttleConsoleResize }" :aria-pressed="throttleConsoleResize" @click="throttleConsoleResize = !throttleConsoleResize"><i></i></button>
                </div>
              </article>
            </section>
          </section>
        </div>
      </section>
    </section>

    <input ref="imageFileInput" class="prototype-hidden-input" type="file" accept="image/png,image/jpeg,image/webp" @change="loadBackgroundImage" />
    <input ref="jsonFileInput" class="prototype-hidden-input" type="file" accept="application/json,.json" @change="importTheme" />
  </main>
</template>

<style scoped>
.prototype-theme-canvas {
  position: relative;
  isolation: isolate;
  background-color: var(--prototype-background-color, var(--vrc-surface));
}

.prototype-theme-canvas::before,
.prototype-theme-canvas::after {
  position: absolute;
  z-index: 0;
  inset: 0;
  pointer-events: none;
  content: "";
  border-radius: inherit;
}

.prototype-theme-canvas::before {
  inset: calc(var(--prototype-background-blur, 0px) * -1);
  background-image: var(--prototype-background-image, none);
  background-position: center;
  background-size: cover;
  filter: blur(var(--prototype-background-blur, 0px));
  opacity: var(--prototype-background-opacity, 0);
}

.prototype-theme-canvas::after {
  background: var(--vrc-surface);
  opacity: var(--prototype-overlay-opacity, 0);
}

.prototype-theme-canvas > * {
  position: relative;
  z-index: 1;
}

.prototype-custom-settings,
.prototype-custom-settings :deep(*) {
  min-width: 0;
}

.prototype-custom-head {
  align-items: center;
}

.prototype-head-actions {
  display: flex;
  flex: 0 0 auto;
  gap: 6px;
}

.prototype-head-actions :deep(.el-button + .el-button) {
  margin-left: 0;
}

.prototype-custom-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 18px;
}

.prototype-setting-group {
  display: grid;
  align-content: start;
  gap: 0;
}

.prototype-background-group {
  padding-left: 18px;
  border-left: 1px solid var(--vrc-border);
}

.prototype-group-title {
  display: grid;
  gap: 3px;
  padding-bottom: 8px;
}

.prototype-group-title strong,
.prototype-setting-row strong {
  color: var(--vrc-text);
  font-size: 12px;
  font-weight: 680;
}

.prototype-group-title span,
.prototype-setting-row > div > span,
.prototype-slider-row > span,
.prototype-slider-row > strong,
.prototype-semantic-colors label > span {
  color: var(--vrc-text-muted);
  font-size: 11px;
  font-weight: 400;
}

.prototype-setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-height: 44px;
  padding: 7px 0;
  border-top: 1px solid color-mix(in srgb, var(--vrc-border) 72%, transparent);
}

.prototype-setting-row > div:first-child {
  display: grid;
  gap: 3px;
}

.prototype-color-control,
.prototype-semantic-colors,
.prototype-semantic-colors label {
  display: flex;
  align-items: center;
}

.prototype-color-control {
  gap: 7px;
}

.prototype-tone-segmented {
  flex: 0 0 228px;
  width: 228px;
}

.prototype-color-chip {
  width: 20px;
  height: 20px;
  padding: 0;
  background: var(--chip-color);
  border: 2px solid var(--vrc-surface);
  border-radius: 5px;
  box-shadow: 0 0 0 1px var(--vrc-border);
  cursor: pointer;
}

.prototype-color-chip.active {
  box-shadow: 0 0 0 2px var(--vrc-accent);
}

.prototype-semantic-colors {
  gap: 10px;
}

.prototype-semantic-colors label {
  gap: 5px;
}

.prototype-image-control {
  display: grid;
  grid-template-columns: 42px minmax(0, 112px) auto;
  align-items: center;
  gap: 7px;
}

.prototype-image-preview {
  width: 42px;
  height: 28px;
  background-color: var(--vrc-surface-muted);
  background-position: center;
  background-size: cover;
  border: 1px solid var(--vrc-border);
  border-radius: 5px;
}

.prototype-image-name {
  overflow: hidden;
  color: var(--vrc-text-muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.prototype-slider-row {
  display: grid;
  grid-template-columns: 44px minmax(80px, 1fr) 36px;
  align-items: center;
  gap: 8px;
  min-height: 34px;
}

.prototype-slider-row > strong {
  text-align: right;
}

.prototype-hidden-input {
  display: none;
}

@media (max-width: 1380px) {
  .prototype-custom-grid {
    grid-template-columns: 1fr;
    gap: 12px;
  }

  .prototype-background-group {
    padding-top: 12px;
    padding-left: 0;
    border-top: 1px solid var(--vrc-border);
    border-left: 0;
  }
}
</style>
