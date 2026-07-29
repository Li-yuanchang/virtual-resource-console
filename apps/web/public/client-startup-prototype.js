(() => {
  const page = document.querySelector(".client-startup-prototype");
  const win = document.querySelector(".client-window");
  const title = document.querySelector(".window-title");
  const phaseText = document.querySelector(".startup-copy p");
  const phases = ["正在启动本地服务", "正在载入资源配置", "正在准备工作区", "资源控制台已就绪"];
  let variant = "a";
  let timers = [];

  function play() {
    timers.forEach(window.clearTimeout);
    timers = [];
    win.classList.remove("is-preview-ready", "startup-phase-0", "startup-phase-1", "startup-phase-2", "startup-phase-3");
    win.classList.add("startup-phase-0");
    phaseText.textContent = phases[0];
    void win.offsetWidth;
    timers.push(window.setTimeout(() => { win.classList.replace("startup-phase-0", "startup-phase-1"); phaseText.textContent = phases[1]; }, 850));
    timers.push(window.setTimeout(() => { win.classList.replace("startup-phase-1", "startup-phase-2"); phaseText.textContent = phases[2]; win.classList.add("is-preview-ready"); }, 1750));
    timers.push(window.setTimeout(() => { win.classList.replace("startup-phase-2", "startup-phase-3"); phaseText.textContent = phases[3]; }, 3000));
  }

  document.querySelectorAll("[data-variant]").forEach((button) => button.addEventListener("click", () => {
    variant = button.dataset.variant;
    document.querySelectorAll("[data-variant]").forEach((item) => item.classList.toggle("active", item === button));
    win.classList.remove("startup-variant-a", "startup-variant-b", "startup-variant-c");
    win.classList.add(`startup-variant-${variant}`);
    title.textContent = `VRC · 启动方案 ${variant.toUpperCase()}`;
    play();
  }));

  document.querySelectorAll("[data-theme-value]").forEach((button) => button.addEventListener("click", () => {
    document.querySelectorAll("[data-theme-value]").forEach((item) => item.classList.toggle("active", item === button));
    document.documentElement.dataset.theme = button.dataset.themeValue;
    page.dataset.theme = button.dataset.themeValue;
    play();
  }));
  document.querySelector(".replay-button").addEventListener("click", play);
  play();
})();
