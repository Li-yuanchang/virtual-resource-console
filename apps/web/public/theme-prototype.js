(() => {
  "use strict";

  const themes = {
    "graphite-sage": {
      name: "石墨青",
      tone: "当前默认",
      description: "低饱和灰绿，适合长时间查看资源和状态。",
      mode: "light",
      colors: ["#f5f6f2", "#fbfbf7", "#426b57", "#27302a"],
      accent: "#426b57",
      success: "#477a45",
      warning: "#b77935",
      danger: "#a5483d",
      canvas: "linear-gradient(135deg, #f4f6f1 0%, #eef3ec 52%, #f7f4ef 100%)",
      darkCanvas: "linear-gradient(135deg, #171a19 0%, #1c211e 52%, #191c1a 100%)",
      light: { bg: "#f5f6f2", surface: "#fbfbf7", muted: "#eef1e8", raised: "#f8f9f3", border: "#d9ded0", strong: "#b8c2ae", text: "#27302a", textMuted: "#747b70", subtle: "#92988d", logoFg: "#fbfbf7" },
      dark: { bg: "#171a19", surface: "#202521", muted: "#29312b", raised: "#252b27", border: "#39433b", strong: "#59665c", text: "#e7ebe6", textMuted: "#a7b0a8", subtle: "#7f8981", logoFg: "#f3f6f2" },
    },
    "prism-frost": {
      name: "冰川光谱",
      tone: "现代渐变",
      description: "冷白底融合蓝、青与柔紫，适合现代化资源工作台。",
      mode: "light",
      colors: ["#eff5fb", "#78a7d2", "#69aa9f", "#9b88bd"],
      accent: "#527fa8",
      success: "#46856e",
      warning: "#b17a35",
      danger: "#ad5260",
      canvas: "linear-gradient(135deg, #edf5fb 0%, #edf7f3 46%, #f3eef8 100%)",
      darkCanvas: "linear-gradient(135deg, #171d26 0%, #152421 48%, #211b2b 100%)",
      light: { bg: "#edf2f6", surface: "#fbfcfe", muted: "#edf2f7", raised: "#f7f9fc", border: "#d3dce5", strong: "#aabac9", text: "#263441", textMuted: "#687886", subtle: "#8d9aa5", logoFg: "#fbfcfe" },
      dark: { bg: "#151a22", surface: "#1d2530", muted: "#283342", raised: "#232d39", border: "#354454", strong: "#526578", text: "#e7edf4", textMuted: "#a5b1bf", subtle: "#7d8b9b", logoFg: "#f5f8fc" },
    },
    "neon-carbon": {
      name: "霓虹夜幕",
      tone: "深色渐变",
      description: "碳黑界面配青蓝与洋红光谱，适合低光环境。",
      mode: "dark",
      colors: ["#171b24", "#4fc3b3", "#5c8ee6", "#c46aa5"],
      accent: "#5d9fe3",
      success: "#64bd91",
      warning: "#d49a51",
      danger: "#d36c7b",
      canvas: "linear-gradient(135deg, #edf4f8 0%, #edf6f2 46%, #f7eef5 100%)",
      darkCanvas: "linear-gradient(135deg, #151b24 0%, #142521 48%, #281b29 100%)",
      light: { bg: "#eef2f5", surface: "#fbfcfd", muted: "#e9eef2", raised: "#f6f8fa", border: "#d1d9e0", strong: "#aab7c2", text: "#26323c", textMuted: "#697783", subtle: "#8b98a3", logoFg: "#fbfcfd" },
      dark: { bg: "#11151c", surface: "#1a2029", muted: "#242c37", raised: "#202833", border: "#343e4c", strong: "#526174", text: "#e7edf5", textMuted: "#a3afbf", subtle: "#788697", logoFg: "#f6f8fb" },
    },
  };

  const gradients = {
    light: [
      { id: "glacier", name: "冰川薄雾", angle: 135, colors: ["#edf5fb", "#edf7f3", "#f3eef8"] },
      { id: "rose", name: "玫瑰晨曦", angle: 130, colors: ["#fbf0f2", "#f3f0fb", "#eef6f3"] },
      { id: "mint", name: "薄荷清泉", angle: 140, colors: ["#e9f8f1", "#eaf4fb", "#f4f0e9"] },
    ],
    dark: [
      { id: "abyss", name: "霓虹深渊", angle: 135, colors: ["#10141c", "#12202b", "#1a1530"] },
      { id: "sea", name: "深海潜流", angle: 160, colors: ["#0f1c28", "#102a33", "#14253c"] },
      { id: "ember", name: "余烬夜色", angle: 150, colors: ["#211a18", "#2b211d", "#1c2230"] },
    ],
  };

  const wallpapers = [
    ["mint-breeze", "薄荷清风", "mint-breeze.svg"],
    ["frost-spectrum", "冰川光谱", "frost-spectrum.svg"],
    ["copper-dusk", "玄武暮色", "copper-dusk.svg"],
    ["aurora-rose", "极光玫瑰", "aurora-rose.svg"],
    ["graphite-mist", "石墨青岚", "graphite-mist.svg"],
    ["sunrise-amber", "晨曦琥珀", "sunrise-amber.svg"],
    ["deep-ocean", "深海潜流", "deep-ocean.svg"],
    ["neon-night", "霓虹夜幕", "neon-night.svg"],
  ].map(([id, name, file]) => ({ id, name, src: `./public/prototype-wallpapers/${file}` }));

  const palettes = [
    { id: "vrc", name: "VRC", bg: "#090d0b", fg: "#d6ddd8", muted: "#78827c", accent: "#73b59a", success: "#7fcf91" },
    { id: "tokyo", name: "Tokyo", bg: "#1a1b26", fg: "#c0caf5", muted: "#565f89", accent: "#7aa2f7", success: "#9ece6a" },
    { id: "catppuccin", name: "Mocha", bg: "#1e1e2e", fg: "#cdd6f4", muted: "#7f849c", accent: "#89b4fa", success: "#a6e3a1" },
    { id: "nord", name: "Nord", bg: "#2e3440", fg: "#d8dee9", muted: "#7b88a1", accent: "#88c0d0", success: "#a3be8c" },
  ];

  const fontStacks = {
    system: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', 'Segoe UI', 'Microsoft YaHei', sans-serif",
    inter: "Inter, 'PingFang SC', 'Microsoft YaHei', sans-serif",
    noto: "'Noto Sans SC', 'Source Han Sans SC', 'PingFang SC', sans-serif",
    wenkai: "'LXGW WenKai Screen', 'LXGW WenKai', 'Kaiti SC', serif",
    compact: "'DIN Next', 'Roboto Condensed', 'PingFang SC', sans-serif",
  };

  const consoleFonts = {
    system: { stack: "'SFMono-Regular', Consolas, 'Liberation Mono', monospace", note: "跟随系统 · 0 KB" },
    jetbrains: { stack: "'JetBrains Mono', 'SFMono-Regular', Consolas, monospace", note: "首次使用时按需下载并缓存" },
    cascadia: { stack: "'Cascadia Mono', 'SFMono-Regular', Consolas, monospace", note: "首次使用时按需下载并缓存" },
    menlo: { stack: "Menlo, Monaco, Consolas, monospace", note: "macOS 本机字体 · 0 KB" },
  };

  const defaults = () => ({
    theme: "graphite-sage",
    tone: "light",
    accent: "#426b57",
    success: "#477a45",
    warning: "#b77935",
    danger: "#a5483d",
    background: "default",
    gradient: gradients.light[0],
    wallpaper: wallpapers[0].src,
    uiFont: "system",
    customFont: "",
    uiSize: 12,
    reduceMotion: false,
    consoleMode: "graphical",
    consoleFont: "system",
    consoleSize: 13,
    consoleLine: 1.2,
    palette: "vrc",
    cursor: "block",
    cursorBlink: true,
    watermark: true,
    watermarkDensity: "standard",
    watermarkOpacity: 12,
  });

  let state = defaults();
  let systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  let toastTimer;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const app = $("#themePrototype");
  const canvas = $("#themeCanvas");

  function isDark() {
    return state.tone === "dark" || (state.tone === "system" && systemDark);
  }

  function linearGradient(item) {
    return `linear-gradient(${item.angle}deg, ${item.colors.join(", ")})`;
  }

  function showToast(message) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.hidden = false;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { toast.hidden = true; }, 1800);
  }

  function setVariable(name, value) {
    app.style.setProperty(name, value);
  }

  function applyThemeVariables() {
    const theme = themes[state.theme];
    const vars = isDark() ? theme.dark : theme.light;
    const map = {
      "--vrc-bg": vars.bg,
      "--vrc-surface": vars.surface,
      "--vrc-surface-muted": vars.muted,
      "--vrc-surface-raised": vars.raised,
      "--vrc-border": vars.border,
      "--vrc-border-strong": vars.strong,
      "--vrc-text": vars.text,
      "--vrc-text-muted": vars.textMuted,
      "--vrc-text-subtle": vars.subtle,
      "--vrc-logo-fg": vars.logoFg,
      "--vrc-accent": state.accent,
      "--vrc-accent-hover": state.accent,
      "--vrc-accent-soft": `color-mix(in srgb, ${state.accent} 12%, ${vars.surface})`,
      "--vrc-logo-bg": state.accent,
      "--vrc-success": state.success,
      "--vrc-warning": state.warning,
      "--vrc-danger": state.danger,
    };
    Object.entries(map).forEach(([name, value]) => setVariable(name, value));
    document.documentElement.dataset.theme = state.theme;
    document.documentElement.style.colorScheme = isDark() ? "dark" : "light";
  }

  function renderThemeCards() {
    const cards = $("#themeCards");
    cards.innerHTML = Object.entries(themes).map(([id, theme]) => `
      <button class="theme-option${state.theme === id ? " active" : ""}" type="button" data-theme-value="${id}" aria-pressed="${state.theme === id}">
        <span class="theme-option-head"><strong>${theme.name}</strong><small>${state.theme === id ? "当前" : theme.tone}</small></span>
        <span class="theme-option-swatch" aria-hidden="true"><i style="background:${isDark() ? theme.darkCanvas : theme.canvas}"></i>${theme.colors.slice(1).map((color) => `<i style="background:${color}"></i>`).join("")}</span>
        <small>${theme.description}</small>
      </button>`).join("");
  }

  function renderThemeSummary() {
    const theme = themes[state.theme];
    $("#themeName").textContent = theme.name;
    $("#themeDescription").textContent = theme.description;
    $("#toneSummary").textContent = state.tone === "system" ? `跟随系统 · ${isDark() ? "深色" : "浅色"}` : isDark() ? "深色" : "浅色";
    $("#backgroundSummary").textContent = state.background === "default" ? theme.tone : state.background === "color" ? `渐变 · ${state.gradient.name}` : "图片背景";
    $("#accentSummary").textContent = state.accent;
    $("#summarySwatches").innerHTML = theme.colors.map((color) => `<i style="background:${color}"></i>`).join("");
  }

  function renderAccentPresets() {
    const colors = ["#426b57", "#2f6f68", "#315f92", "#6a5b88", "#9b5f35", "#8a4f5d"];
    $("#accentPresets").innerHTML = colors.map((color) => `<button class="color-chip${state.accent === color ? " active" : ""}" type="button" data-accent="${color}" style="--chip:${color}" title="强调色 ${color}" aria-label="使用强调色 ${color}"></button>`).join("") + `<input class="native-color" id="customAccent" type="color" value="${state.accent}" title="自定义强调色" aria-label="自定义强调色" />`;
  }

  function renderGradients() {
    const list = isDark() ? gradients.dark : gradients.light;
    if (!list.some((item) => item.id === state.gradient.id)) state.gradient = list[0];
    $("#gradientPresets").innerHTML = list.map((item) => `<button class="gradient-option${state.gradient.id === item.id ? " active" : ""}" type="button" data-gradient="${item.id}"><i style="background:${linearGradient(item)}"></i><span>${item.name}</span></button>`).join("");
    $("#gradientAngle").value = state.gradient.angle;
    $("#gradientAngleOutput").textContent = `${state.gradient.angle}°`;
  }

  function renderWallpapers() {
    $("#wallpaperGrid").innerHTML = wallpapers.map((item) => `<button class="wallpaper-option${state.wallpaper === item.src ? " active" : ""}" type="button" data-wallpaper="${item.src}"><i style="background-image:url('${item.src}')"></i><span>${item.name}</span></button>`).join("");
  }

  function renderPalettes() {
    $("#paletteGrid").innerHTML = palettes.map((item) => `<button class="palette-option${state.palette === item.id ? " active" : ""}" type="button" data-palette="${item.id}" style="--palette:linear-gradient(90deg,${item.bg} 0 35%,${item.accent} 35% 68%,${item.success} 68%)"><i></i><span>${item.name}</span></button>`).join("");
  }

  function renderWatermark() {
    const counts = { sparse: 3, standard: 6, dense: 10 };
    const text = "lyc · 192.0.2.26 · 2026-07-29 09:18";
    $$(".watermark-layer").forEach((layer) => {
      layer.hidden = !state.watermark;
      layer.style.opacity = String(state.watermarkOpacity / 100);
      layer.innerHTML = Array.from({ length: counts[state.watermarkDensity] }, () => `<span>${text}</span>`).join("");
    });
  }

  function renderBackground() {
    let background = "none";
    let preview = isDark() ? themes[state.theme].darkCanvas : themes[state.theme].canvas;
    if (state.background === "color") background = preview = linearGradient(state.gradient);
    if (state.background === "image") background = preview = `url('${state.wallpaper}')`;
    canvas.style.setProperty("--prototype-background", background);
    canvas.classList.toggle("has-custom-background", state.background !== "default");
    $("#backgroundPreview").style.background = preview;
    $("#backgroundPreview").style.backgroundPosition = "center";
    $("#backgroundPreview").style.backgroundSize = "cover";
    $$("[data-background-panel]").forEach((panel) => { panel.hidden = panel.dataset.backgroundPanel !== state.background; });
  }

  function renderTypography() {
    const custom = state.customFont.trim();
    setVariable("--prototype-ui-font", custom ? `'${custom}', ${fontStacks.system}` : fontStacks[state.uiFont]);
    setVariable("--prototype-ui-size", `${state.uiSize}px`);
    $("#uiFont").value = state.uiFont;
    $("#customFont").value = state.customFont;
    $("#reduceMotion").checked = state.reduceMotion;
    app.classList.toggle("reduce-motion", state.reduceMotion);
  }

  function renderConsole() {
    const palette = palettes.find((item) => item.id === state.palette) || palettes[0];
    const font = consoleFonts[state.consoleFont];
    setVariable("--console-bg", palette.bg);
    setVariable("--console-fg", palette.fg);
    setVariable("--console-muted", palette.muted);
    setVariable("--console-accent", palette.accent);
    setVariable("--console-success", palette.success);
    setVariable("--console-font", font.stack);
    setVariable("--console-size", `${state.consoleSize}px`);
    setVariable("--console-line", state.consoleLine.toFixed(2));
    $("#consoleFont").value = state.consoleFont;
    $("#consoleFontSource").textContent = font.note;
    $("#consoleFontSize").textContent = state.consoleSize;
    $("#consoleLineHeight").textContent = state.consoleLine.toFixed(2);
    $("#cursorBlink").checked = state.cursorBlink;
    $("#watermarkEnabled").checked = state.watermark;
    $("#watermarkDensity").value = state.watermarkDensity;
    $("#watermarkOpacity").value = state.watermarkOpacity;
    $("#watermarkOpacityOutput").textContent = `${state.watermarkOpacity}%`;
    app.classList.toggle("no-cursor-blink", !state.cursorBlink);
    $("[data-cli-controls]").hidden = state.consoleMode !== "cli";
    $$("[data-console-panel]").forEach((panel) => { panel.hidden = panel.dataset.consolePanel !== state.consoleMode; });
    const terminal = $(".terminal-preview");
    terminal.classList.toggle("cursor-bar", state.cursor === "bar");
    terminal.classList.toggle("cursor-underline", state.cursor === "underline");
    renderWatermark();
  }

  function markSegmented(control, value) {
    $$(`[data-control="${control}"] button`).forEach((button) => button.classList.toggle("active", button.dataset.value === String(value)));
  }

  function render() {
    applyThemeVariables();
    renderThemeCards();
    renderThemeSummary();
    renderAccentPresets();
    renderGradients();
    renderWallpapers();
    renderPalettes();
    renderBackground();
    renderTypography();
    renderConsole();
    markSegmented("tone", state.tone);
    markSegmented("background", state.background);
    markSegmented("fontSize", state.uiSize);
    markSegmented("consoleMode", state.consoleMode);
    markSegmented("cursor", state.cursor);
    $("#successColor").value = state.success;
    $("#warningColor").value = state.warning;
    $("#dangerColor").value = state.danger;
  }

  function selectTheme(id) {
    const theme = themes[id];
    if (!theme) return;
    state.theme = id;
    state.tone = theme.mode;
    state.accent = theme.accent;
    state.success = theme.success;
    state.warning = theme.warning;
    state.danger = theme.danger;
    render();
  }

  document.addEventListener("click", (event) => {
    const target = event.target.closest("button");
    if (!target) return;
    if (target.dataset.themeValue) selectTheme(target.dataset.themeValue);
    if (target.dataset.accent) { state.accent = target.dataset.accent; render(); }
    if (target.dataset.gradient) {
      const source = (isDark() ? gradients.dark : gradients.light).find((item) => item.id === target.dataset.gradient);
      if (source) { state.gradient = { ...source, colors: [...source.colors] }; state.background = "color"; render(); }
    }
    if (target.dataset.wallpaper) { state.wallpaper = target.dataset.wallpaper; state.background = "image"; render(); }
    if (target.dataset.step === "font") { state.consoleSize = Math.max(11, Math.min(18, state.consoleSize + Number(target.dataset.delta))); render(); }
    if (target.dataset.step === "line") { state.consoleLine = Math.max(1, Math.min(1.8, Math.round((state.consoleLine + Number(target.dataset.delta)) * 100) / 100)); render(); }
    if (target.dataset.palette) { state.palette = target.dataset.palette; render(); }
  });

  $$('[data-control]').forEach((group) => {
    group.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-value]");
      if (!button) return;
      const value = button.dataset.value;
      if (group.dataset.control === "tone") state.tone = value;
      if (group.dataset.control === "background") state.background = value;
      if (group.dataset.control === "fontSize") state.uiSize = Number(value);
      if (group.dataset.control === "consoleMode") state.consoleMode = value;
      if (group.dataset.control === "cursor") state.cursor = value;
      render();
    });
  });

  $("#customAccent");
  document.addEventListener("input", (event) => {
    if (event.target.id === "customAccent") { state.accent = event.target.value; render(); }
  });
  $("#successColor").addEventListener("input", (event) => { state.success = event.target.value; render(); });
  $("#warningColor").addEventListener("input", (event) => { state.warning = event.target.value; render(); });
  $("#dangerColor").addEventListener("input", (event) => { state.danger = event.target.value; render(); });
  $("#uiFont").addEventListener("change", (event) => { state.uiFont = event.target.value; renderTypography(); });
  $("#customFont").addEventListener("input", (event) => { state.customFont = event.target.value; renderTypography(); });
  $("#reduceMotion").addEventListener("change", (event) => { state.reduceMotion = event.target.checked; renderTypography(); });
  $("#consoleFont").addEventListener("change", (event) => { state.consoleFont = event.target.value; renderConsole(); });
  $("#cursorBlink").addEventListener("change", (event) => { state.cursorBlink = event.target.checked; renderConsole(); });
  $("#watermarkEnabled").addEventListener("change", (event) => { state.watermark = event.target.checked; renderConsole(); });
  $("#watermarkDensity").addEventListener("change", (event) => { state.watermarkDensity = event.target.value; renderWatermark(); });
  $("#watermarkOpacity").addEventListener("input", (event) => { state.watermarkOpacity = Number(event.target.value); renderConsole(); });
  $("#gradientAngle").addEventListener("input", (event) => {
    state.gradient = { ...state.gradient, id: "custom", name: "自定义", angle: Number(event.target.value) };
    renderBackground();
    $("#gradientAngleOutput").textContent = `${state.gradient.angle}°`;
    renderThemeSummary();
  });

  $("#wallpaperUpload").addEventListener("click", () => $("#wallpaperInput").click());
  $("#wallpaperInput").addEventListener("change", (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) { showToast("请选择图片文件"); return; }
    if (file.size > 16 * 1024 * 1024) { showToast("图片不能超过 16 MB"); return; }
    const reader = new FileReader();
    reader.addEventListener("load", () => { state.wallpaper = String(reader.result); state.background = "image"; render(); showToast("壁纸已应用到原型"); });
    reader.readAsDataURL(file);
  });

  $("#resetButton").addEventListener("click", () => { state = defaults(); render(); showToast("已恢复默认外观"); });
  $("#exportButton").addEventListener("click", () => {
    const exportState = { ...state, wallpaper: state.wallpaper.startsWith("data:") ? "" : state.wallpaper };
    const blob = new Blob([JSON.stringify({ version: 2, ...exportState }, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "vrc-theme.json";
    link.click();
    URL.revokeObjectURL(link.href);
    showToast("主题配置已导出");
  });
  $("#importButton").addEventListener("click", () => $("#themeImportInput").click());
  $("#themeImportInput").addEventListener("change", (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      try {
        const config = JSON.parse(String(reader.result));
        const next = { ...defaults(), ...config };
        if (!themes[next.theme] || !["system", "light", "dark"].includes(next.tone)) throw new Error("invalid theme");
        state = next;
        render();
        showToast("主题配置已载入");
      } catch {
        showToast("主题配置文件格式不正确");
      }
    });
    reader.readAsText(file);
  });

  const colorMode = window.matchMedia("(prefers-color-scheme: dark)");
  colorMode.addEventListener("change", (event) => { systemDark = event.matches; if (state.tone === "system") render(); });
  render();
})();
