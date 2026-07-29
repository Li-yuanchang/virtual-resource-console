<!--
THESIS: Put each icon inside its native toolbar so optical size, not source pixels, decides quality.
OWN-WORLD: Quiet VRC settings surface, neutral bands, precise native chrome, sage as the only accent.
STORY: Compare current and proposed small icons, then confirm the export format per platform.
FIRST VIEWPORT: Three platform simulations appear immediately; macOS leads because it is the only redesign.
FORM: Operate-mode inspection bench, extending the project's existing visual language.
-->
<script setup lang="ts">
import { ArrowLeft, Check, Connection, Grid, Monitor, MoreFilled, Setting } from "@element-plus/icons-vue";
import { ref } from "vue";
import VrcLogoMark from "../components/VrcLogoMark.vue";
import currentTrayIcon from "../../../electron/assets/tray@2x.png";
import macTemplateIcon from "../../../electron/assets/tray-template@2x.png";
import windowsIcon from "../../../electron/assets/app-icon-1024.png";
import chromeIcon16 from "../../../chrome-extension/src/icons/vrc-16.png";
import chromeIcon32 from "../../../chrome-extension/src/icons/vrc-32.png";

const macAppearance = ref<"light" | "dark">("light");
</script>

<template>
  <main class="icon-prototype">
    <header class="prototype-header">
      <div>
        <p class="prototype-kicker">外观 / 平台图标</p>
        <h1>小尺寸图标适配</h1>
        <p class="prototype-summary">按各平台的真实显示尺寸检查清晰度与视觉占比。</p>
      </div>
      <div class="prototype-status"><Check class="icon-15" aria-hidden="true" /> Chrome 比例已确认</div>
    </header>

    <section class="platform-band mac-band" aria-labelledby="mac-title">
      <div class="platform-heading">
        <span class="platform-mark apple-mark" aria-hidden="true">⌘</span>
        <div>
          <h2 id="mac-title">macOS 菜单栏</h2>
          <p>改为单色轮廓 Template 图标，系统自动适配浅色和深色菜单栏。</p>
        </div>
        <div class="appearance-switch" aria-label="菜单栏外观预览">
          <button :class="{ active: macAppearance === 'light' }" type="button" @click="macAppearance = 'light'">浅色</button>
          <button :class="{ active: macAppearance === 'dark' }" type="button" @click="macAppearance = 'dark'">深色</button>
        </div>
      </div>

      <div class="comparison-grid">
        <article class="comparison current-comparison">
          <div class="comparison-label">
            <span>当前</span>
            <small>彩色图标</small>
          </div>
          <div class="mac-menubar" :class="macAppearance">
            <span class="menu-copy">VRC</span>
            <div class="menu-spacer"></div>
            <Connection class="icon-15" aria-hidden="true" />
            <img class="mac-current-icon" :src="currentTrayIcon" alt="当前 VRC 菜单栏图标" />
            <span class="menu-clock">09:41</span>
          </div>
        </article>

        <article class="comparison proposed-comparison">
          <div class="comparison-label">
            <span>A</span>
            <small>单色轮廓 · 视觉占比约 16/18</small>
          </div>
          <div class="mac-menubar" :class="macAppearance">
            <span class="menu-copy">VRC</span>
            <div class="menu-spacer"></div>
            <Connection class="icon-15" aria-hidden="true" />
            <img class="mac-template-icon" :src="macTemplateIcon" alt="建议的 VRC 单色菜单栏图标" />
            <span class="menu-clock">09:41</span>
          </div>
        </article>

        <article class="comparison knockout-comparison">
          <div class="comparison-label">
            <span>B</span>
            <small>实心底板 · VRC 镂空</small>
          </div>
          <div class="mac-menubar reference-tone">
            <span class="menu-copy">VRC</span>
            <div class="menu-spacer"></div>
            <Connection class="icon-15" aria-hidden="true" />
            <svg class="mac-knockout-icon" viewBox="0 0 18 18" role="img" aria-label="白色底板并镂空 VRC 字母的菜单栏图标">
              <defs>
                <mask id="vrc-knockout-small" maskUnits="userSpaceOnUse">
                  <rect x="1.4" y="1.4" width="15.2" height="15.2" rx="2.9" fill="#fff" />
                  <text x="9" y="9" fill="#000" font-family="Arial Narrow, Arial, sans-serif" font-size="5.8" font-weight="800" text-anchor="middle" dominant-baseline="middle">VRC</text>
                  <rect x="10.35" y="12.5" width="3.55" height="0.8" rx="0.4" fill="#000" />
                </mask>
              </defs>
              <rect x="1.4" y="1.4" width="15.2" height="15.2" rx="2.9" fill="currentColor" mask="url(#vrc-knockout-small)" />
            </svg>
            <span class="menu-clock">09:41</span>
          </div>
        </article>

        <aside class="detail-inspector mac-detail" aria-label="macOS 图标放大细节">
          <div class="detail-option">
            <img class="mac-template-icon enlarged" :src="macTemplateIcon" alt="" />
            <span><strong>A · 细轮廓</strong><small>当前接入版本</small></span>
          </div>
          <div class="detail-option knockout-detail-option">
            <span class="knockout-detail-stage">
              <svg class="mac-knockout-icon enlarged" viewBox="0 0 18 18" aria-hidden="true">
                <defs>
                  <mask id="vrc-knockout-large" maskUnits="userSpaceOnUse">
                    <rect x="1.4" y="1.4" width="15.2" height="15.2" rx="2.9" fill="#fff" />
                    <text x="9" y="9" fill="#000" font-family="Arial Narrow, Arial, sans-serif" font-size="5.8" font-weight="800" text-anchor="middle" dominant-baseline="middle">VRC</text>
                    <rect x="10.35" y="12.5" width="3.55" height="0.8" rx="0.4" fill="#000" />
                  </mask>
                </defs>
                <rect x="1.4" y="1.4" width="15.2" height="15.2" rx="2.9" fill="currentColor" mask="url(#vrc-knockout-large)" />
              </svg>
            </span>
            <span><strong>B · 白底镂空</strong><small>候选版本</small></span>
          </div>
          <div class="detail-spec">
            <strong>18 × 18 pt</strong>
            <span>最终导出 18px / 36px Template PNG</span>
          </div>
        </aside>
      </div>
    </section>

    <section class="platform-band chrome-band" aria-labelledby="chrome-title">
      <div class="platform-heading">
        <span class="platform-mark chrome-mark" aria-hidden="true"></span>
        <div>
          <h2 id="chrome-title">Chrome 插件工具栏</h2>
          <p>保持你确认的 VRC 图形比例，16px 负责标准屏，32px 负责高分屏清晰度。</p>
        </div>
        <span class="confirmed-badge"><Check class="icon-13" aria-hidden="true" /> 比例确认</span>
      </div>

      <div class="chrome-preview-layout">
        <div class="browser-window">
          <div class="browser-tabbar">
            <span class="browser-dot red"></span><span class="browser-dot yellow"></span><span class="browser-dot green"></span>
            <div class="browser-tab"><span class="mini-site-icon"></span>Virtual Resource Console</div>
            <div class="browser-toolbar-actions">
              <Grid class="icon-16" aria-hidden="true" />
              <button class="chrome-icon-button" type="button" title="Virtual Resource Console">
                <img :src="chromeIcon32" alt="VRC Chrome 插件图标" />
              </button>
              <MoreFilled class="icon-18" aria-hidden="true" />
            </div>
          </div>
          <div class="browser-addressbar">
            <ArrowLeft class="icon-16" aria-hidden="true" />
            <div class="address-field">127.0.0.1:5173</div>
          </div>
          <div class="browser-body">
            <strong>工具栏实际显示约 16px</strong>
            <span>Retina 屏会读取 32px 资源再缩放显示，因此边缘更清楚。</span>
          </div>
        </div>

        <div class="chrome-size-family" aria-label="Chrome 图标尺寸预览">
          <div class="size-sample">
            <div class="sample-stage stage-16"><img :src="chromeIcon16" alt="16px VRC 图标" /></div>
            <strong>16px</strong><span>标准屏</span>
          </div>
          <div class="size-sample selected">
            <div class="sample-stage stage-32"><img :src="chromeIcon32" alt="32px VRC 图标" /></div>
            <strong>32px</strong><span>高分屏 · 当前正好</span>
          </div>
          <div class="optical-note">
            <span class="measure-line"></span>
            <p>不继续放大图形，避免圆角和文字在 16px 下挤成一团。</p>
          </div>
        </div>
      </div>
    </section>

    <section class="platform-band web-band" aria-labelledby="web-title">
      <div class="platform-heading">
        <span class="platform-mark" aria-hidden="true"><Monitor class="icon-16" /></span>
        <div>
          <h2 id="web-title">Web 正式界面</h2>
          <p>保留彩色 SVG，统一提高共享 Logo 的视觉占比，侧栏、空状态和加载态同时生效。</p>
        </div>
        <span class="confirmed-badge"><Check class="icon-13" aria-hidden="true" /> 已同步</span>
      </div>

      <div class="web-preview-layout">
        <div class="web-sidebar-preview">
          <div class="web-brand-lockup">
            <VrcLogoMark shadow />
            <span><strong>资源控制台</strong><small>3 个连接</small></span>
          </div>
          <Setting class="web-setting-icon" aria-label="设置" />
        </div>
        <div class="web-size-family">
          <div class="web-size-item"><span class="web-logo-box size-22"><VrcLogoMark :grid="false" /></span><strong>22px</strong><small>紧凑加载</small></div>
          <div class="web-size-item"><span class="web-logo-box size-38"><VrcLogoMark /></span><strong>38px</strong><small>空状态</small></div>
          <div class="web-size-item selected"><span class="web-logo-box size-54"><VrcLogoMark shadow /></span><strong>54px</strong><small>侧栏品牌</small></div>
        </div>
      </div>
    </section>

    <section class="platform-band windows-band" aria-labelledby="windows-title">
      <div class="platform-heading">
        <span class="platform-mark windows-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
        <div>
          <h2 id="windows-title">Windows 桌面与托盘</h2>
          <p>保留现有彩色图标，按桌面和托盘的不同尺寸提高主体视觉占比。</p>
        </div>
        <span class="keep-badge">彩色保留</span>
      </div>

      <div class="windows-preview-layout">
        <div class="windows-desktop-compare">
          <div class="desktop-preview-title">
            <strong>桌面快捷方式</strong>
            <span>32px 图标槽</span>
          </div>
          <div class="desktop-shortcuts">
            <div class="desktop-shortcut">
              <span class="windows-icon-viewport desktop-viewport"><img :src="windowsIcon" alt="当前 Windows VRC 桌面图标" /></span>
              <span>VRC</span><small>当前</small>
            </div>
            <div class="desktop-shortcut proposed-shortcut">
              <span class="windows-icon-viewport desktop-viewport optimized"><img :src="windowsIcon" alt="优化视觉占比后的 Windows VRC 桌面图标" /></span>
              <span>VRC</span><small>建议</small>
            </div>
          </div>
        </div>
        <div class="windows-contexts">
          <div class="windows-context-row">
            <span class="context-name">当前</span>
            <div class="windows-taskbar">
              <div class="taskbar-spacer"></div>
              <span class="tray-chevron">⌃</span>
              <span class="windows-icon-viewport tray-viewport"><img :src="windowsIcon" alt="当前 Windows VRC 托盘图标" /></span>
              <span class="windows-net">⌁</span>
              <span class="windows-volume">◖</span>
              <div class="windows-clock"><strong>9:41</strong><span>2026/7/29</span></div>
            </div>
          </div>
          <div class="windows-context-row">
            <span class="context-name proposed-name">建议</span>
            <div class="windows-taskbar">
              <div class="taskbar-spacer"></div>
              <span class="tray-chevron">⌃</span>
              <span class="windows-icon-viewport tray-viewport optimized"><img :src="windowsIcon" alt="优化视觉占比后的 Windows VRC 托盘图标" /></span>
              <span class="windows-net">⌁</span>
              <span class="windows-volume">◖</span>
              <div class="windows-clock"><strong>9:41</strong><span>2026/7/29</span></div>
            </div>
          </div>
        </div>
        <div class="windows-sizes">
          <div v-for="size in [16, 20, 24, 32, 48]" :key="size" class="windows-size-item">
            <span class="windows-icon-stage">
              <span class="windows-icon-viewport optimized" :style="{ width: `${size}px`, height: `${size}px` }">
                <img :src="windowsIcon" alt="" />
              </span>
            </span>
            <strong>{{ size }}px</strong>
            <small>{{ size < 32 ? '托盘' : '桌面' }}</small>
          </div>
        </div>
      </div>
    </section>

    <footer class="asset-pipeline">
      <strong>资源策略</strong>
      <span class="pipeline-source">SVG 母版</span><i>→</i>
      <span>Web 彩色 SVG</span><i>·</i>
      <span>macOS Template PNG</span><i>·</i>
      <span>Chrome PNG 16/32/48/128</span><i>·</i>
      <span>Windows 多分辨率 ICO</span>
    </footer>
  </main>
</template>

<style scoped>
:global(*) { box-sizing: border-box; }
:global(body) { margin: 0; background: #f4f6f3; color: #29312d; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
:global(button) { font: inherit; }

.icon-prototype { min-height: 100vh; padding: 28px 32px 36px; }
.icon-13 { width: 13px; height: 13px; }.icon-15 { width: 15px; height: 15px; }.icon-16 { width: 16px; height: 16px; }.icon-18 { width: 18px; height: 18px; }
.prototype-header { max-width: 1180px; margin: 0 auto 22px; display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; }
.prototype-kicker { margin: 0 0 5px; color: #6e7972; font-size: 12px; line-height: 18px; }
h1 { margin: 0; font-size: 24px; line-height: 34px; font-weight: 600; letter-spacing: 0; }
.prototype-summary { margin: 4px 0 0; color: #79827d; font-size: 13px; line-height: 20px; }
.prototype-status { min-height: 30px; display: inline-flex; align-items: center; gap: 6px; padding: 0 10px; border: 1px solid #cbd7cf; border-radius: 5px; color: #406852; background: #f8faf7; font-size: 12px; white-space: nowrap; }

.platform-band { max-width: 1180px; margin: 0 auto; padding: 22px 0 24px; border-top: 1px solid #d9dfda; }
.platform-band:first-of-type { border-top-color: #cbd4cd; }
.platform-heading { display: grid; grid-template-columns: 34px minmax(0, 1fr) auto; gap: 11px; align-items: center; margin-bottom: 18px; }
.platform-heading h2 { margin: 0 0 2px; font-size: 16px; line-height: 23px; font-weight: 600; letter-spacing: 0; }
.platform-heading p { margin: 0; color: #768079; font-size: 12px; line-height: 19px; }
.platform-mark { width: 30px; height: 30px; display: grid; place-items: center; border: 1px solid #d2d9d4; border-radius: 6px; background: #fbfcfa; }
.apple-mark { color: #343a36; font-size: 13px; }
.chrome-mark { position: relative; border: 0; border-radius: 50%; background: conic-gradient(#d95145 0 33%, #dfba3e 0 66%, #4c9660 0); }
.chrome-mark::before { content: ""; width: 14px; height: 14px; border: 3px solid #f7f9f7; border-radius: 50%; background: #4f80b8; }
.windows-mark { grid-template-columns: repeat(2, 7px); grid-template-rows: repeat(2, 7px); gap: 2px; }
.windows-mark i { width: 7px; height: 7px; background: #4f7ca7; }

.appearance-switch { display: inline-flex; padding: 2px; border: 1px solid #cfd6d1; border-radius: 5px; background: #edf0ed; }
.appearance-switch button { min-width: 48px; height: 26px; padding: 0 10px; border: 0; border-radius: 3px; color: #707a73; background: transparent; font-size: 12px; cursor: pointer; }
.appearance-switch button.active { color: #2f3b34; background: #fff; box-shadow: 0 1px 2px rgb(31 44 35 / 12%); }

.comparison-grid { display: grid; grid-template-columns: repeat(3, minmax(220px, 1fr)); gap: 14px; align-items: stretch; }
.comparison { min-width: 0; border: 1px solid #d5dcd7; border-radius: 6px; overflow: hidden; background: #fbfcfa; }
.proposed-comparison { border-color: #aebfb3; }
.comparison-label { height: 38px; padding: 0 12px; display: flex; align-items: center; gap: 8px; }
.comparison-label span { font-size: 12px; font-weight: 600; }
.comparison-label small { color: #7c857f; font-size: 11px; }
.mac-menubar { height: 34px; padding: 0 11px; display: flex; align-items: center; gap: 10px; color: #1f2421; background: #e8e9e7; border-top: 1px solid #d6d8d5; font-size: 11px; }
.mac-menubar.dark { color: #f0f3f0; background: #262a28; border-top-color: #353a37; }
.menu-copy { font-weight: 600; }
.menu-spacer { flex: 1; }
.menu-clock { font-variant-numeric: tabular-nums; }
.mac-current-icon { width: 18px; height: 18px; object-fit: contain; }
.mac-template-icon { width: 18px; height: 18px; display: block; object-fit: contain; }
.mac-menubar.dark .mac-template-icon { filter: invert(1); }
.mac-knockout-icon { width: 18px; height: 18px; display: block; color: currentColor; }
.mac-menubar.reference-tone { color: #fff; background: #777ac8; border-top-color: #696cb6; }
.detail-inspector { min-height: 74px; padding: 12px 14px; display: flex; align-items: center; gap: 24px; border: 1px dashed #bdc7c0; border-radius: 6px; background: #eef2ef; }
.mac-detail { grid-column: 1 / -1; }
.mac-template-icon.enlarged { width: 48px; height: 48px; flex: 0 0 auto; }
.detail-option { min-width: 168px; display: flex; align-items: center; gap: 10px; }.detail-option > span:last-child { display: grid; gap: 2px; }
.detail-option strong, .detail-spec strong { color: #303a34; font-size: 12px; line-height: 18px; }.detail-option small, .detail-spec span { color: #768079; font-size: 10px; line-height: 15px; }
.knockout-detail-stage { width: 54px; height: 54px; display: grid; place-items: center; border-radius: 5px; color: #fff; background: #777ac8; }
.mac-knockout-icon.enlarged { width: 48px; height: 48px; }.detail-spec { margin-left: auto; min-width: 190px; display: grid; gap: 2px; }

.confirmed-badge, .keep-badge { display: inline-flex; align-items: center; gap: 5px; min-height: 25px; padding: 0 8px; border-radius: 4px; font-size: 11px; white-space: nowrap; }
.confirmed-badge { color: #3f6a52; background: #e7f0e9; }
.keep-badge { color: #68736c; background: #e9ece9; }
.chrome-preview-layout, .windows-preview-layout { display: grid; grid-template-columns: minmax(420px, 1.5fr) minmax(300px, 1fr); gap: 14px; }
.browser-window { border: 1px solid #cbd2cd; border-radius: 7px; overflow: hidden; background: white; box-shadow: 0 5px 16px rgb(49 62 53 / 8%); }
.browser-tabbar { height: 38px; padding: 0 10px; display: flex; align-items: center; gap: 6px; background: #dde1de; }
.browser-dot { width: 8px; height: 8px; border-radius: 50%; }
.browser-dot.red { background: #db7068; }.browser-dot.yellow { background: #d9b458; }.browser-dot.green { background: #6ba773; }
.browser-tab { align-self: end; width: min(235px, 45%); height: 31px; margin-left: 5px; padding: 0 11px; display: flex; align-items: center; gap: 7px; border-radius: 7px 7px 0 0; color: #4f5852; background: #f6f7f6; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mini-site-icon { width: 12px; height: 12px; border-radius: 3px; background: #547762; }
.browser-toolbar-actions { margin-left: auto; display: flex; align-items: center; gap: 10px; color: #4c554f; }
.chrome-icon-button { width: 28px; height: 28px; padding: 0; display: grid; place-items: center; border: 0; border-radius: 4px; background: transparent; }
.chrome-icon-button img { width: 20px; height: 20px; image-rendering: auto; }
.browser-addressbar { height: 38px; padding: 0 12px; display: flex; align-items: center; gap: 9px; border-bottom: 1px solid #e1e5e2; background: #f6f7f6; color: #677069; }
.address-field { flex: 1; height: 25px; padding: 0 12px; display: flex; align-items: center; border-radius: 13px; background: #e9ecea; font-size: 11px; }
.browser-body { height: 74px; padding: 13px 15px; display: flex; flex-direction: column; justify-content: center; background: #fff; }
.browser-body strong { margin-bottom: 3px; font-size: 12px; line-height: 18px; }
.browser-body span { color: #7a837d; font-size: 11px; line-height: 17px; }
.chrome-size-family { padding: 14px; display: grid; grid-template-columns: 92px 126px minmax(0, 1fr); gap: 10px; align-items: center; border: 1px solid #d5dcd7; border-radius: 6px; background: #fbfcfa; }
.size-sample { min-height: 112px; padding: 9px; display: flex; flex-direction: column; align-items: center; justify-content: center; border-radius: 5px; }
.size-sample.selected { outline: 1px solid #a7b9ad; background: #eef3ef; }
.sample-stage { width: 48px; height: 48px; margin-bottom: 7px; display: grid; place-items: center; background: #e2e7e3; border-radius: 6px; }
.stage-16 img { width: 16px; height: 16px; }.stage-32 img { width: 32px; height: 32px; }
.size-sample strong { font-size: 12px; line-height: 17px; }.size-sample span { color: #778079; font-size: 10px; line-height: 15px; text-align: center; }
.optical-note { min-width: 0; padding-left: 8px; color: #707a73; }
.measure-line { width: 40px; height: 1px; display: block; margin-bottom: 8px; background: #7f9c89; position: relative; }
.measure-line::before, .measure-line::after { content: ""; position: absolute; top: -3px; width: 1px; height: 7px; background: #7f9c89; }
.measure-line::before { left: 0; }.measure-line::after { right: 0; }
.optical-note p { margin: 0; font-size: 11px; line-height: 17px; }

.web-preview-layout { display: grid; grid-template-columns: minmax(360px, 1.2fr) minmax(300px, 1fr); gap: 14px; }
.web-sidebar-preview { min-height: 92px; padding: 15px 16px; display: flex; align-items: center; border: 1px solid #d5dcd7; border-radius: 6px; background: #fbfcfa; }
.web-brand-lockup { display: flex; align-items: center; gap: 10px; }.web-brand-lockup > .vrc-logo-mark { width: 54px; height: 54px; }.web-brand-lockup span { display: grid; gap: 3px; }.web-brand-lockup strong { font-size: 14px; line-height: 20px; }.web-brand-lockup small { color: #7a837d; font-size: 11px; }
.web-setting-icon { width: 17px; height: 17px; margin-left: auto; color: #79837c; }
.web-size-family { padding: 8px 12px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; border: 1px solid #d5dcd7; border-radius: 6px; background: #fbfcfa; }
.web-size-item { min-width: 0; padding: 6px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; border-radius: 5px; }.web-size-item.selected { outline: 1px solid #a7b9ad; background: #eef3ef; }
.web-logo-box { display: grid; place-items: center; }.web-logo-box .vrc-logo-mark { width: 100%; height: 100%; }.size-22 { width: 22px; height: 22px; }.size-38 { width: 38px; height: 38px; }.size-54 { width: 54px; height: 54px; }
.web-size-item strong { font-size: 10px; line-height: 14px; }.web-size-item small { color: #7a837d; font-size: 9px; line-height: 13px; text-align: center; }

.windows-contexts { padding: 10px; display: grid; gap: 8px; border: 1px solid #d5dcd7; border-radius: 6px; background: #fbfcfa; }
.windows-desktop-compare { min-height: 132px; padding: 12px 14px; display: grid; grid-template-columns: minmax(110px, 1fr) auto; align-items: center; gap: 18px; border-radius: 6px; color: #eef4f1; background: #18132e; }
.desktop-preview-title strong, .desktop-preview-title span { display: block; }.desktop-preview-title strong { margin-bottom: 4px; font-size: 12px; }.desktop-preview-title span { color: #aaa5bd; font-size: 10px; }
.desktop-shortcuts { display: flex; align-items: center; gap: 22px; }
.desktop-shortcut { width: 54px; min-height: 88px; padding: 8px 6px 5px; display: flex; flex-direction: column; align-items: center; gap: 4px; border: 1px solid transparent; font-size: 11px; }
.desktop-shortcut small { color: #aaa5bd; font-size: 9px; }.proposed-shortcut { border-color: #7a7691; background: rgb(255 255 255 / 10%); }
.desktop-viewport { width: 32px; height: 32px; }
.windows-context-row { display: grid; grid-template-columns: 42px minmax(0, 1fr); gap: 8px; align-items: center; }
.context-name { color: #7a837d; font-size: 11px; text-align: center; }.proposed-name { color: #406852; font-weight: 600; }
.windows-taskbar { height: 42px; padding: 0 12px; display: flex; align-items: center; gap: 10px; color: #f2f4f3; background: #27302e; border-radius: 4px; }
.taskbar-spacer { flex: 1; }.tray-chevron, .windows-net, .windows-volume { color: #d7ddda; font-size: 15px; }
.windows-icon-viewport { display: grid; place-items: center; overflow: hidden; flex: 0 0 auto; }
.tray-viewport { width: 20px; height: 20px; }
.windows-icon-viewport img { width: 100%; height: 100%; object-fit: contain; }
.windows-icon-viewport.optimized img { transform: scale(1.13); }
.windows-clock { padding-left: 4px; display: flex; flex-direction: column; align-items: flex-end; font-size: 9px; line-height: 13px; }
.windows-clock strong { font-weight: 400; }
.windows-sizes { grid-column: 1 / -1; padding: 8px 10px; display: grid; grid-template-columns: repeat(5, 1fr); gap: 5px; border: 1px solid #d5dcd7; border-radius: 6px; background: #fbfcfa; }
.windows-size-item { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 5px; }
.windows-icon-stage { width: 52px; height: 54px; display: grid; place-items: center; background: #e8ece9; border-radius: 5px; }
.windows-icon-stage img { object-fit: contain; }.windows-size-item strong { font-size: 10px; color: #707a73; }
.windows-size-item small { color: #98a09b; font-size: 9px; line-height: 11px; }

.asset-pipeline { max-width: 1180px; min-height: 48px; margin: 0 auto; padding: 0 14px; display: flex; align-items: center; gap: 10px; border: 1px solid #d4dcd6; border-radius: 6px; color: #707a73; background: #eef2ef; font-size: 11px; overflow-x: auto; white-space: nowrap; }
.asset-pipeline strong { color: #354039; font-size: 12px; }.asset-pipeline i { color: #98a29b; font-style: normal; }.pipeline-source { color: #38634d; font-weight: 600; }

@media (max-width: 920px) {
  .icon-prototype { padding: 22px 18px 30px; }
  .comparison-grid { grid-template-columns: 1fr 1fr; }
  .detail-inspector { grid-column: 1 / -1; }
  .chrome-preview-layout, .web-preview-layout, .windows-preview-layout { grid-template-columns: 1fr; }
}

@media (max-width: 620px) {
  .icon-prototype { padding: 18px 12px 24px; }
  .prototype-header { align-items: flex-start; flex-direction: column; gap: 12px; }
  .prototype-status { display: none; }
  h1 { font-size: 21px; line-height: 30px; }
  .platform-heading { grid-template-columns: 32px minmax(0, 1fr); align-items: start; }
  .appearance-switch, .confirmed-badge, .keep-badge { grid-column: 2; justify-self: start; margin-top: 4px; }
  .comparison-grid { grid-template-columns: 1fr; }
  .detail-inspector { grid-column: auto; align-items: flex-start; flex-wrap: wrap; gap: 12px; }
  .detail-spec { min-width: 0; margin-left: 0; }
  .chrome-preview-layout, .web-preview-layout, .windows-preview-layout { grid-template-columns: minmax(0, 1fr); }
  .browser-tab { width: 44%; }
  .chrome-size-family { grid-template-columns: 1fr 1fr; }
  .optical-note { grid-column: 1 / -1; padding: 4px 2px 0; }
  .windows-sizes { padding-inline: 8px; }
}
</style>
