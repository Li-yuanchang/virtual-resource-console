const { app, BrowserWindow, Menu, Tray, WebContentsView, ipcMain, nativeImage, nativeTheme, shell } = require("electron");
const { autoUpdater } = require("electron-updater");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const APP_DISPLAY_NAME = "VRC";
const MAIN_PROCESS_STARTED_AT = Date.now();
const WINDOWS_APP_USER_MODEL_ID = "com.virtualresource.console";
const WINDOWS_SINGLE_INSTANCE_PIPE = "\\\\.\\pipe\\vrc-desktop-single-instance";
const MIN_STARTUP_VISIBLE_MS = 1800;
const STARTUP_READY_STATUS_MS = 60;
const STARTUP_EXIT_ANIMATION_MS = 460;
const RENDERER_READY_TIMEOUT_MS = 5000;
const DESKTOP_UPDATE_FEED_URL = process.env.VRC_UPDATE_URL || "";
const DESKTOP_UPDATE_DISTRIBUTION = resolveDesktopUpdateDistribution();

if (app && app.setName) {
  app.setName(APP_DISPLAY_NAME);
}
if (process.platform === "win32") {
  app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID);
  try {
    const userDataDir = path.join(app.getPath("appData"), APP_DISPLAY_NAME);
    fs.mkdirSync(userDataDir, { recursive: true });
    app.setPath("userData", userDataDir);
  } catch (error) {
    // 固定 userData 失败时继续依赖 Electron 默认路径，并把问题写入日志。
  }
}

let mainWindow;
let windowCreationPromise;
let startupView;
let startupStartedAt = 0;
let startupResizeHandler;
let startupOverlayReady = false;
let apiProcess;
let apiBaseUrl = process.env.VRC_WEB_URL || "http://127.0.0.1:5173";
let tray;
let logDir;
let apiLogStream;
let mainLogStream;
let isQuitting = false;
let logStreamsClosing = false;
let pendingShowMainWindow = false;
let windowsSingleInstanceServer;
let desktopUpdateState = {
  stage: "idle",
  currentVersion: typeof app.getVersion === "function" ? app.getVersion() : "0.0.0",
  availableVersion: typeof app.getVersion === "function" ? app.getVersion() : "0.0.0",
  progress: 0,
  transferred: 0,
  total: 0,
  releaseNotes: readBundledReleaseNotes(),
  message:
    DESKTOP_UPDATE_DISTRIBUTION === "portable"
      ? "免安装版不支持自动安装更新，请下载新版 ZIP 后替换当前目录"
      : !DESKTOP_UPDATE_FEED_URL
        ? "未配置桌面更新源，请设置 VRC_UPDATE_URL"
      : "尚未检查更新",
  checkedAt: "",
  supported:
    app.isPackaged &&
    Boolean(DESKTOP_UPDATE_FEED_URL) &&
    (process.platform === "darwin" || (process.platform === "win32" && DESKTOP_UPDATE_DISTRIBUTION === "installed")),
  distribution: DESKTOP_UPDATE_DISTRIBUTION,
  platform: process.platform,
};
let desktopUpdaterConfigured = false;
let desktopUpdateOperation = "";

configureDesktopUpdater();

appendMainLog("startup phase", buildStartupDetail("main process started", {
  platform: process.platform,
  arch: process.arch,
  packaged: app.isPackaged,
  version: typeof app.getVersion === "function" ? app.getVersion() : undefined,
}));

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  void notifyExistingWindowsInstance().finally(() => app.quit());
} else {
  app.on("second-instance", () => {
    appendMainLog("second instance requested; focusing existing window");
    void showMainWindow();
  });
}

const instanceReadyPromise = singleInstanceLock && process.platform === "win32" ? startWindowsSingleInstanceServer() : Promise.resolve(singleInstanceLock);

async function createWindow() {
  appendMainLog("startup phase", buildStartupDetail("create window start"));
  const startupAppearance = readStartupAppearance();
  startupOverlayReady = false;
  const shouldStartBundledApi = app.isPackaged && !process.env.VRC_WEB_URL;
  const macWindowOptions =
    process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset",
          trafficLightPosition: { x: 14, y: 14 },
        }
      : {};

  mainWindow = new BrowserWindow({
    show: false,
    width: 1440,
    height: 920,
    minWidth: 1180,
    minHeight: 760,
    autoHideMenuBar: process.platform === "win32",
    ...macWindowOptions,
    backgroundColor: startupAppearance.bg,
    icon: resolveAssetPath(process.platform === "win32" ? "app-icon.ico" : "app-icon.icns"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });
  appendMainLog("startup phase", buildStartupDetail("browser window created"));

  mainWindow.on("close", (event) => {
    appendMainLog("main window close requested", { isQuitting, startupActive: Boolean(startupView) });
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
  });

  startupStartedAt = Date.now();
  try {
    appendMainLog("startup phase", buildStartupDetail("startup overlay load start"));
    await attachStartupView(startupAppearance);
    startupOverlayReady = true;
  } catch (error) {
    appendMainLog("startup overlay failed to load", { message: error instanceof Error ? error.message : String(error) });
    disposeStartupView();
    startupOverlayReady = true;
  }
  appendMainLog("startup overlay ready", buildStartupDetail("startup overlay ready", { phaseElapsedMs: Date.now() - startupStartedAt }));
  mainWindow.show();
  appendMainLog("startup phase", buildStartupDetail("main window shown with startup overlay"));

  try {
    await setStartupStatus("正在载入资源配置");
    const bundledApiPromise = shouldStartBundledApi ? startBundledApi() : Promise.resolve(apiBaseUrl);
    bundledApiPromise.catch(() => undefined);
    appendMainLog("startup phase", buildStartupDetail("waiting for api base url"));
    apiBaseUrl = await bundledApiPromise;
    appendMainLog("startup phase", buildStartupDetail("api base url ready", { apiBaseUrl }));
    const rendererLoadStartedAt = Date.now();
    appendMainLog("startup phase", buildStartupDetail("renderer load start", { apiBaseUrl }));
    await mainWindow.loadURL(apiBaseUrl);
    appendMainLog("startup phase", buildStartupDetail("renderer load url resolved", { phaseElapsedMs: Date.now() - rendererLoadStartedAt }));
    await setStartupStatus("正在准备工作区");
    const rendererReady = await waitForRendererReady(mainWindow.webContents);
    appendMainLog("renderer startup readiness resolved", buildStartupDetail("renderer app ready", {
      rendererReady: rendererReady.ready,
      rendererState: rendererReady.state,
      phaseElapsedMs: Date.now() - rendererLoadStartedAt,
    }));
    if (!rendererReady.ready) {
      await setStartupStatus("工作区初始化较慢，先进入主界面");
    }
    await finishStartupView();
  } catch (error) {
    appendMainLog("desktop startup failed", { message: error instanceof Error ? error.message : String(error) });
    await setStartupStatus("启动失败，请查看日志");
    throw error;
  }

}

if (singleInstanceLock) {
  instanceReadyPromise.then((canStart) => {
    if (!canStart) return undefined;
    return app.whenReady();
  }).then(async () => {
    appendMainLog("startup phase", buildStartupDetail("app ready"));
    configureApplicationMenu();
    appendMainLog("startup phase", buildStartupDetail("application menu configured"));
    createTray();
    appendMainLog("startup phase", buildStartupDetail("tray created"));
    await ensureMainWindow();
    if (pendingShowMainWindow) {
      pendingShowMainWindow = false;
      await showMainWindow();
    }
  }).catch((error) => {
    appendMainLog("electron initialization failed", { message: error instanceof Error ? error.message : String(error) });
  });
}

app.on("window-all-closed", () => undefined);

app.on("activate", () => {
  void showMainWindow();
});

async function ensureMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  if (windowCreationPromise) {
    await windowCreationPromise;
    return mainWindow;
  }
  windowCreationPromise = createWindow().finally(() => {
    windowCreationPromise = undefined;
  });
  await windowCreationPromise;
  return mainWindow;
}

async function showMainWindow() {
  if (!app.isReady()) {
    pendingShowMainWindow = true;
    return;
  }
  const targetWindow = await ensureMainWindow();
  if (!targetWindow || targetWindow.isDestroyed()) return;
  if (targetWindow.isMinimized()) targetWindow.restore();
  targetWindow.setSkipTaskbar(false);
  if (!targetWindow.isVisible()) targetWindow.show();
  if (process.platform === "win32") {
    targetWindow.setAlwaysOnTop(true);
  }
  targetWindow.moveTop();
  targetWindow.focus();
  if (process.platform === "win32") {
    setTimeout(() => {
      if (!targetWindow.isDestroyed()) targetWindow.setAlwaysOnTop(false);
    }, 250);
  }
}

app.on("before-quit", () => {
  isQuitting = true;
  logStreamsClosing = true;
  if (windowsSingleInstanceServer) {
    windowsSingleInstanceServer.close();
    windowsSingleInstanceServer = undefined;
  }
  disposeStartupView();
  if (apiProcess && !apiProcess.killed) {
    apiProcess.kill();
  }
  closeLogStream(apiLogStream);
  closeLogStream(mainLogStream);
  apiLogStream = undefined;
  mainLogStream = undefined;
});

function startWindowsSingleInstanceServer() {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      appendMainLog("windows single instance pipe requested; focusing window");
      void showMainWindow();
      socket.end("ok");
    });
    server.once("listening", () => {
      windowsSingleInstanceServer = server;
      appendMainLog("windows single instance pipe listening", { pipe: WINDOWS_SINGLE_INSTANCE_PIPE });
      resolve(true);
    });
    server.once("error", (error) => {
      appendMainLog("windows single instance pipe failed", { code: error.code, message: error.message });
      if (error.code === "EADDRINUSE") {
        void notifyExistingWindowsInstance().finally(() => {
          isQuitting = true;
          app.quit();
          resolve(false);
        });
        return;
      }
      resolve(true);
    });
    server.listen(WINDOWS_SINGLE_INSTANCE_PIPE);
  });
}

function notifyExistingWindowsInstance() {
  if (process.platform !== "win32") return Promise.resolve(false);
  return new Promise((resolve) => {
    const socket = net.connect(WINDOWS_SINGLE_INSTANCE_PIPE);
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(800);
    socket.once("connect", () => {
      socket.end("show");
      done(true);
    });
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function attachStartupView(appearance) {
  startupView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  startupView.webContents.setBackgroundThrottling(false);
  startupView.setBackgroundColor("#00000000");
  mainWindow.contentView.addChildView(startupView);
  startupResizeHandler = () => layoutStartupView();
  mainWindow.on("resize", startupResizeHandler);
  layoutStartupView();
  await startupView.webContents.loadFile(path.join(__dirname, "startup.html"), {
    query: {
      bg: appearance.bg,
      surface: appearance.surface,
      border: appearance.border,
      text: appearance.text,
      muted: appearance.muted,
      accent: appearance.accent,
      logoFg: appearance.logoFg,
    },
  });
}

function layoutStartupView() {
  if (!mainWindow || mainWindow.isDestroyed() || !startupView) return;
  const [width, height] = mainWindow.getContentSize();
  startupView.setBounds({ x: 0, y: 0, width, height });
}

async function setStartupStatus(message) {
  if (!startupView || startupView.webContents.isDestroyed()) return;
  try {
    await startupView.webContents.executeJavaScript(`window.vrcStartup?.setStatus(${JSON.stringify(message)})`);
  } catch {
    // 启动覆盖层退出期间的状态更新失败不影响主界面。
  }
}

async function finishStartupView() {
  if (!startupView) return;
  const remaining = Math.max(MIN_STARTUP_VISIBLE_MS - (Date.now() - startupStartedAt), 0);
  appendMainLog("startup phase", buildStartupDetail("startup overlay finish start", { remainingVisibleMs: remaining }));
  if (remaining) await delay(remaining);
  await setStartupStatus("资源控制台已就绪");
  await delay(STARTUP_READY_STATUS_MS);
  try {
    await startupView.webContents.executeJavaScript("window.vrcStartup?.complete()");
  } catch {
    // 覆盖层仍会在下方统一释放。
  }
  await delay(STARTUP_EXIT_ANIMATION_MS);
  appendMainLog("releasing startup overlay", buildStartupDetail("startup overlay release start", { visibleBefore: mainWindow?.isVisible() }));
  disposeStartupView();
  mainWindow?.show();
  mainWindow?.focus();
  appendMainLog("startup overlay released", buildStartupDetail("startup overlay released", { visibleAfter: mainWindow?.isVisible() }));
}

function disposeStartupView() {
  if (mainWindow && startupResizeHandler) {
    mainWindow.removeListener("resize", startupResizeHandler);
  }
  startupResizeHandler = undefined;
  if (!startupView) return;
  try {
    mainWindow?.contentView.removeChildView(startupView);
    if (!startupView.webContents.isDestroyed()) startupView.webContents.close();
  } catch {
    // 应用退出或窗口销毁时视图可能已被 Electron 回收。
  }
  startupView = undefined;
  startupOverlayReady = true;
}

async function waitForRendererReady(webContents) {
  const deadline = Date.now() + RENDERER_READY_TIMEOUT_MS;
  let lastState = null;
  while (Date.now() < deadline) {
    if (webContents.isDestroyed()) return { ready: false, state: lastState };
    try {
      const state = await readRendererStartupState(webContents);
      lastState = state;
      if (state.appReady) return { ready: true, state };
    } catch {
      // 页面导航或首轮脚本执行期间继续等待。
    }
    await delay(50);
  }
  return { ready: false, state: lastState };
}

async function readRendererStartupState(webContents) {
  return webContents.executeJavaScript(`(() => {
    const dataset = document.documentElement.dataset;
    return {
      appReady: dataset.appReady === "true",
      startupStage: dataset.startupStage || "",
      startupError: dataset.startupError || "",
      readyState: document.readyState,
      visibilityState: document.visibilityState
    };
  })()`);
}

function readStartupAppearance() {
  const fallback = {
    theme: "graphite-sage",
    toneMode: "light",
    accentColor: "#426b57",
  };
  let preferences = fallback;
  try {
    const file = path.join(app.getPath("home"), ".virtual-resource-console", "preferences.json");
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    preferences = { ...fallback, ...(parsed?.ui ?? {}) };
  } catch {
    preferences = fallback;
  }

  const theme = ["graphite-sage", "basalt-copper", "mist-teal"].includes(preferences.theme) ? preferences.theme : fallback.theme;
  const dark = preferences.toneMode === "dark" || (preferences.toneMode === "system" && nativeTheme.shouldUseDarkColors);
  const palettes = {
    "graphite-sage": { bg: "#f5f6f2", surface: "#fbfbf7", border: "#d9ded0", text: "#27302a", muted: "#747b70", accent: "#426b57" },
    "basalt-copper": { bg: "#f4f2ed", surface: "#fcfaf5", border: "#d7d0c3", text: "#2f2b24", muted: "#766f63", accent: "#9b5f35" },
    "mist-teal": { bg: "#f3f6f4", surface: "#fbfcfa", border: "#d2dbd5", text: "#22302d", muted: "#6f7b77", accent: "#2f6f68" },
  };
  const palette = dark
    ? { bg: "#0f1417", surface: "#161d21", border: "#314047", text: "#d8e0e4", muted: "#93a1aa", accent: palettes[theme].accent }
    : palettes[theme];
  return {
    ...palette,
    accent: isHexColor(preferences.accentColor) ? preferences.accentColor.toLowerCase() : palette.accent,
    logoFg: dark ? "#edf4ef" : "#f7fbf2",
  };
}

function isHexColor(value) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

function configureDesktopUpdater() {
  if (desktopUpdaterConfigured) return;
  desktopUpdaterConfigured = true;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  if (DESKTOP_UPDATE_FEED_URL) {
    ensureDesktopUpdaterConfig();
    autoUpdater.setFeedURL({ provider: "generic", url: DESKTOP_UPDATE_FEED_URL, channel: "latest" });
  }

  autoUpdater.on("checking-for-update", () => {
    updateDesktopUpdateState({ stage: "checking", message: "正在检查更新", progress: 0 });
  });
  autoUpdater.on("update-available", (info) => {
    updateDesktopUpdateState({
      stage: "available",
      availableVersion: info.version || "",
      releaseNotes: normalizeReleaseNotes(info.releaseNotes),
      message: `发现 VRC ${info.version || "新版本"}`,
      progress: 0,
      checkedAt: new Date().toISOString(),
    });
  });
  autoUpdater.on("update-not-available", () => {
    updateDesktopUpdateState({
      stage: "up-to-date",
      availableVersion: desktopUpdateState.currentVersion,
      releaseNotes: readBundledReleaseNotes(),
      message: "当前已是最新版本",
      progress: 0,
      checkedAt: new Date().toISOString(),
    });
  });
  autoUpdater.on("download-progress", (progress) => {
    updateDesktopUpdateState({
      stage: "downloading",
      progress: normalizePercent(progress.percent),
      transferred: Number(progress.transferred) || 0,
      total: Number(progress.total) || 0,
      message: "正在下载更新",
    });
  });
  autoUpdater.on("update-downloaded", (info) => {
    updateDesktopUpdateState({
      stage: "ready",
      availableVersion: info.version || desktopUpdateState.availableVersion,
      releaseNotes: normalizeReleaseNotes(info.releaseNotes) || desktopUpdateState.releaseNotes,
      progress: 100,
      message: "更新已准备完成，重启客户端后生效",
    });
  });
  autoUpdater.on("error", (error) => {
    settleDesktopUpdateFailure(error, desktopUpdateOperation);
    appendMainLog("desktop update failed", { message: error instanceof Error ? error.message : String(error) });
  });

  ipcMain.handle("vrc:update:get-state", () => ({ ...desktopUpdateState }));
  ipcMain.handle("vrc:update:check", async () => {
    assertDesktopUpdateSupported();
    desktopUpdateOperation = "check";
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      settleDesktopUpdateFailure(error, "check");
    } finally {
      if (desktopUpdateOperation === "check") desktopUpdateOperation = "";
    }
    return { ...desktopUpdateState };
  });
  ipcMain.handle("vrc:update:download", async () => {
    assertDesktopUpdateSupported();
    if (desktopUpdateState.stage !== "available") {
      return { ...desktopUpdateState };
    }
    desktopUpdateOperation = "download";
    updateDesktopUpdateState({ stage: "downloading", progress: 0, transferred: 0, total: 0, message: "正在下载更新" });
    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      settleDesktopUpdateFailure(error, "download");
    } finally {
      if (desktopUpdateOperation === "download") desktopUpdateOperation = "";
    }
    return { ...desktopUpdateState };
  });
  ipcMain.handle("vrc:update:install", async () => {
    assertDesktopUpdateSupported();
    if (desktopUpdateState.stage !== "ready") throw new Error("更新包尚未准备完成");
    await showUpdateRestartView();
    isQuitting = true;
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return { accepted: true };
  });
}

async function showUpdateRestartView() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!startupView) {
    startupOverlayReady = false;
    await attachStartupView(readStartupAppearance());
    startupOverlayReady = true;
  }
  await setStartupStatus("正在应用更新，客户端即将重启");
  mainWindow.show();
  mainWindow.focus();
  await delay(320);
}

function updateDesktopUpdateState(patch) {
  desktopUpdateState = { ...desktopUpdateState, ...patch };
  const payload = { ...desktopUpdateState };
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send("vrc:update:state", payload);
  }
}

function assertDesktopUpdateSupported() {
  if (!desktopUpdateState.supported) {
    if (desktopUpdateState.distribution === "portable") {
      throw new Error("免安装版不支持自动安装更新，请下载新版 ZIP 后替换当前目录");
    }
    if (!DESKTOP_UPDATE_FEED_URL) {
      throw new Error("未配置桌面更新源，请设置 VRC_UPDATE_URL");
    }
    throw new Error("桌面更新仅在已安装的 macOS 或 Windows 客户端中可用");
  }
}

function resolveDesktopUpdateDistribution() {
  if (process.platform === "darwin") return "installed";
  if (process.platform !== "win32") return "unsupported";
  if (process.env.PORTABLE_EXECUTABLE_FILE || process.env.PORTABLE_EXECUTABLE_DIR) return "portable";
  const uninstallPath = path.join(path.dirname(process.execPath), `Uninstall ${APP_DISPLAY_NAME}.exe`);
  return fs.existsSync(uninstallPath) ? "installed" : "portable";
}

function ensureDesktopUpdaterConfig() {
  const packagedConfigPath = path.join(process.resourcesPath, "app-update.yml");
  if (fs.existsSync(packagedConfigPath)) {
    autoUpdater.updateConfigPath = packagedConfigPath;
    return;
  }

  const fallbackConfigPath = path.join(app.getPath("userData"), "app-update.yml");
  const fallbackConfig = [
    "provider: generic",
    `url: ${JSON.stringify(DESKTOP_UPDATE_FEED_URL)}`,
    "updaterCacheDirName: vrc-updater",
    "",
  ].join("\n");
  fs.mkdirSync(path.dirname(fallbackConfigPath), { recursive: true });
  if (!fs.existsSync(fallbackConfigPath) || fs.readFileSync(fallbackConfigPath, "utf8") !== fallbackConfig) {
    fs.writeFileSync(fallbackConfigPath, fallbackConfig, "utf8");
  }
  autoUpdater.updateConfigPath = fallbackConfigPath;
}

function settleDesktopUpdateFailure(error, operation) {
  if (operation === "check") {
    updateDesktopUpdateState({
      stage: "unavailable",
      message: "暂未检测到可用更新",
      checkedAt: new Date().toISOString(),
    });
    return;
  }
  if (desktopUpdateState.stage === "error") return;
  updateDesktopUpdateState({
    stage: "error",
    message: readableDesktopUpdateError(error),
    checkedAt: new Date().toISOString(),
  });
}

function normalizePercent(value) {
  const percent = Number(value);
  if (!Number.isFinite(percent)) return 0;
  return Math.max(0, Math.min(100, Math.round(percent * 10) / 10));
}

function normalizeReleaseNotes(value) {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => (typeof item === "string" ? item : item?.note))
    .filter((item) => typeof item === "string" && item.trim())
    .join("\n")
    .trim();
}

function readBundledReleaseNotes() {
  try {
    return fs.readFileSync(path.join(__dirname, "release-notes.md"), "utf8").trim();
  } catch {
    return "";
  }
}

function readableDesktopUpdateError(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  if (/app-update\.ya?ml|ENOENT/i.test(message)) return "更新组件配置异常，请重新启动客户端后再试";
  if (/404|latest.*ya?ml/i.test(message)) return "更新源暂未发布当前平台版本";
  if (/network|ECONN|ENOTFOUND|ETIMEDOUT|fetch/i.test(message)) return "无法连接更新服务，请检查网络后重试";
  if (/signature|code sign|sha512|checksum/i.test(message)) return "更新包校验失败，已停止安装";
  return message ? `更新失败：${message}` : "更新失败，请稍后重试";
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function startBundledApi() {
  const apiStartupStartedAt = Date.now();
  appendMainLog("startup phase", buildStartupDetail("bundled api startup start"));
  const preferredPort = Number(process.env.PORT || 3987);
  const preferredBaseUrl = `http://127.0.0.1:${preferredPort}`;
  if (process.env.VRC_REUSE_EXISTING_API === "1" && await isVrcApiHealthy(preferredBaseUrl)) {
    appendMainLog("reusing existing vrc api", buildStartupDetail("bundled api reused", { baseUrl: preferredBaseUrl, phaseElapsedMs: Date.now() - apiStartupStartedAt }));
    return preferredBaseUrl;
  }
  const port = await resolveApiPort(preferredPort);
  const resourcesPath = process.resourcesPath;
  const apiBootstrapEntry = path.join(resourcesPath, "api", "bootstrap.js");
  const apiIndexEntry = path.join(resourcesPath, "api", "index.js");
  const apiEntry = fs.existsSync(apiBootstrapEntry) ? apiBootstrapEntry : apiIndexEntry;
  const webDistDir = path.join(resourcesPath, "web");
  const nodeModulesDir = path.join(resourcesPath, "node_modules");
  const nodeRuntime = resolveNodeRuntimePath(resourcesPath);
  const useElectronAsNode = nodeRuntime === process.execPath;
  const logsPath = getLogDir();
  const dataDir = getVrcDataDir();
  apiLogStream = createLogStream("api.log");
  appendMainLog("starting bundled api", buildStartupDetail("bundled api spawn start", { port, apiEntry, webDistDir, nodeModulesDir, logsPath, nodeRuntime, useElectronAsNode, dataDir }));

  apiProcess = spawn(nodeRuntime, [apiEntry], {
    env: {
      ...process.env,
      ...(useElectronAsNode ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
      VRC_API_SPAWNED_AT: String(Date.now()),
      HOST: "127.0.0.1",
      PORT: String(port),
      NODE_PATH: nodeModulesDir,
      VRC_WEB_DIST_DIR: webDistDir,
      VRC_LOG_DIR: logsPath,
      VRC_DATA_DIR: dataDir,
      VRC_RUNTIME_MODE: "electron",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  appendMainLog("startup phase", buildStartupDetail("bundled api process spawned", { pid: apiProcess.pid, phaseElapsedMs: Date.now() - apiStartupStartedAt }));

  apiProcess.stdout?.on("data", (chunk) => writeApiLog("stdout", chunk));
  apiProcess.stderr?.on("data", (chunk) => writeApiLog("stderr", chunk));
  apiProcess.once("error", (error) => {
    appendMainLog("api process failed to start", { message: error.message });
  });
  apiProcess.once("exit", (code, signal) => {
    appendMainLog("api process exited", { code, signal });
  });
  apiProcess.unref();
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl);
  appendMainLog("bundled api ready", buildStartupDetail("bundled api health ready", { baseUrl, phaseElapsedMs: Date.now() - apiStartupStartedAt }));
  return baseUrl;
}

function getVrcDataDir() {
  const configured = process.env.VRC_DATA_DIR?.trim();
  if (configured) return path.resolve(configured);

  const packagedDataDir = path.join(app.getPath("userData"), "data");
  const legacyDataDir = path.join(app.getPath("home"), ".virtual-resource-console");
  if (!fs.existsSync(packagedDataDir) && fs.existsSync(legacyDataDir)) return legacyDataDir;
  return packagedDataDir;
}

function createTray() {
  if (tray && !tray.isDestroyed()) return;
  const trayIcon = resolveTrayIcon();
  tray = new Tray(trayIcon);
  tray.setToolTip("Virtual Resource Console");
  tray.on("click", () => {
    void showMainWindow();
  });
  tray.on("double-click", () => {
    void showMainWindow();
  });
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "打开资源控制台",
        click: () => {
          void showMainWindow();
        },
      },
      {
        label: "打开本机服务",
        click: () => {
          if (apiBaseUrl) {
            shell.openExternal(apiBaseUrl);
          }
        },
      },
      {
        label: "打开日志目录",
        click: () => {
          fs.mkdirSync(getLogDir(), { recursive: true });
          shell.openPath(getLogDir());
        },
      },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
}

function resolveTrayIcon() {
  const iconCandidates =
    process.platform === "win32"
      ? ["app-icon.ico", "tray.png"]
      : ["tray.png", "app-icon.icns"];
  for (const filename of iconCandidates) {
    const icon = nativeImage.createFromPath(resolveAssetPath(filename));
    if (!icon.isEmpty()) {
      return process.platform === "win32" ? icon.resize({ width: 16, height: 16 }) : icon;
    }
  }
  appendMainLog("tray icon failed to load; using empty native image", { iconCandidates });
  return nativeImage.createEmpty();
}

function configureApplicationMenu() {
  if (process.platform === "win32") {
    Menu.setApplicationMenu(null);
    return;
  }

  app.setAboutPanelOptions({
    applicationName: APP_DISPLAY_NAME,
    applicationVersion: app.getVersion(),
    copyright: "Copyright © 2026 Virtual Resource Console",
    iconPath: resolveAssetPath(process.platform === "win32" ? "app-icon.ico" : "app-icon.icns"),
  });

  const template =
    process.platform === "darwin"
      ? [
          {
            label: APP_DISPLAY_NAME,
            submenu: [
              { label: `关于${APP_DISPLAY_NAME}`, role: "about" },
              { type: "separator" },
              { label: "服务", role: "services", submenu: [] },
              { type: "separator" },
              { label: `隐藏${APP_DISPLAY_NAME}`, role: "hide" },
              { label: "隐藏其他", role: "hideOthers" },
              { label: "全部显示", role: "unhide" },
              { type: "separator" },
              { label: `退出${APP_DISPLAY_NAME}`, role: "quit" },
            ],
          },
          buildFileMenu(),
          buildEditMenu(),
          buildViewMenu(),
          buildWindowMenu(),
          buildHelpMenu(),
        ]
      : [buildFileMenu(), buildEditMenu(), buildViewMenu(), buildHelpMenu()];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function buildFileMenu() {
  return {
    label: "文件",
    submenu: [
      { label: "关闭窗口", role: "close" },
      { type: "separator" },
      { label: "退出", role: process.platform === "darwin" ? "quit" : "quit" },
    ],
  };
}

function buildEditMenu() {
  return {
    label: "编辑",
    submenu: [
      { label: "撤销", role: "undo" },
      { label: "重做", role: "redo" },
      { type: "separator" },
      { label: "剪切", role: "cut" },
      { label: "复制", role: "copy" },
      { label: "粘贴", role: "paste" },
      { label: "全选", role: "selectAll" },
    ],
  };
}

function buildViewMenu() {
  return {
    label: "视图",
    submenu: [
      { label: "重新加载", role: "reload" },
      { label: "强制重新加载", role: "forceReload" },
      { label: "开发者工具", role: "toggleDevTools" },
      { type: "separator" },
      { label: "放大", role: "zoomIn" },
      { label: "缩小", role: "zoomOut" },
      { label: "实际大小", role: "resetZoom" },
      { type: "separator" },
      { label: "切换全屏", role: "togglefullscreen" },
    ],
  };
}

function buildWindowMenu() {
  return {
    label: "窗口",
    submenu: [
      { label: "最小化", role: "minimize" },
      { label: "缩放", role: "zoom" },
      { type: "separator" },
      { label: "前置所有窗口", role: "front" },
    ],
  };
}

function buildHelpMenu() {
  return {
    label: "帮助",
    submenu: [
      {
        label: "打开日志目录",
        click: () => {
          fs.mkdirSync(getLogDir(), { recursive: true });
          shell.openPath(getLogDir());
        },
      },
      {
        label: "打开本机服务",
        click: () => {
          if (apiBaseUrl) {
            shell.openExternal(apiBaseUrl);
          }
        },
      },
    ],
  };
}

function resolveAssetPath(filename) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "assets", filename);
  }
  return path.join(__dirname, "assets", filename);
}

function resolveNodeRuntimePath(resourcesPath) {
  const runtimeTarget = resolveNodeRuntimeTarget();
  if (app.isPackaged && runtimeTarget) {
    const bundledNode = path.join(resourcesPath, "runtime", `node-${runtimeTarget}`, process.platform === "win32" ? "node.exe" : path.join("bin", "node"));
    if (fs.existsSync(bundledNode)) {
      return bundledNode;
    }
    appendMainLog("bundled node runtime not found, falling back to electron runtime", { bundledNode, runtimeTarget });
  }
  return process.execPath;
}

function resolveNodeRuntimeTarget() {
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  }
  if (process.platform === "win32") {
    return "win-x64";
  }
  return "";
}

function getLogDir() {
  if (!logDir) {
    logDir = resolveWritableLogDir();
  }
  return logDir;
}

function resolveWritableLogDir() {
  const candidates = [];
  if (process.env.VRC_LOG_DIR) {
    candidates.push(process.env.VRC_LOG_DIR);
  }
  if (app.isPackaged && process.platform === "win32") {
    candidates.push(path.join(path.dirname(process.execPath), "logs"));
  }
  candidates.push(path.join(app.getPath("userData"), "logs"));

  for (const candidate of candidates) {
    try {
      fs.mkdirSync(candidate, { recursive: true });
      fs.accessSync(candidate, fs.constants.W_OK);
      return candidate;
    } catch {
      // 例如安装到 Program Files 时同级目录不可写，继续尝试用户目录。
    }
  }
  return path.join(app.getPath("userData"), "logs");
}

function createLogStream(filename) {
  const dir = getLogDir();
  fs.mkdirSync(dir, { recursive: true });
  const stream = fs.createWriteStream(path.join(dir, filename), { flags: "a" });
  stream.write(`\n[${new Date().toISOString()}] ===== Virtual Resource Console =====\n`);
  return stream;
}

function buildStartupDetail(phase, detail = {}) {
  return {
    phase,
    elapsedSinceMainStartMs: Date.now() - MAIN_PROCESS_STARTED_AT,
    ...detail,
  };
}

function appendMainLog(message, detail) {
  try {
    if (logStreamsClosing) return;
    if (mainLogStream && isLogStreamClosed(mainLogStream)) {
      mainLogStream = undefined;
    }
    if (!mainLogStream) {
      mainLogStream = createLogStream("main.log");
    }
    const suffix = detail ? ` ${JSON.stringify(detail)}` : "";
    safeWriteLogStream(mainLogStream, `[${new Date().toISOString()}] ${message}${suffix}\n`);
  } catch {
    // 日志失败不能影响桌面应用启动。
  }
}

function writeApiLog(streamName, chunk) {
  if (logStreamsClosing || !apiLogStream || isLogStreamClosed(apiLogStream)) return;
  const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    safeWriteLogStream(apiLogStream, `[${new Date().toISOString()}] [${streamName}] ${line}\n`);
  }
}

function isLogStreamClosed(stream) {
  return Boolean(stream.destroyed || stream.closed || stream.writableEnded || stream.writableFinished);
}

function safeWriteLogStream(stream, line) {
  if (!stream || isLogStreamClosed(stream)) return;
  try {
    stream.write(line);
  } catch {
    // 退出阶段 stream 可能已结束，不能让日志写入变成主进程异常。
  }
}

function closeLogStream(stream) {
  if (!stream || isLogStreamClosed(stream)) return;
  try {
    stream.end();
  } catch {
    // 忽略退出阶段日志关闭异常。
  }
}

async function resolveApiPort(preferredPort) {
  if (!(await isPortReachable(preferredPort)) && (await canListen(preferredPort))) {
    return preferredPort;
  }
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        resolve(typeof address === "object" && address ? address.port : preferredPort);
      });
    });
  });
}

function isPortReachable(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(500);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

async function waitForHealth(baseUrl) {
  const healthStartedAt = Date.now();
  const deadline = Date.now() + 15000;
  let lastError;
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts += 1;
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) {
        appendMainLog("startup phase", buildStartupDetail("api health check passed", { baseUrl, attempts, phaseElapsedMs: Date.now() - healthStartedAt }));
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastError || new Error("Timed out waiting for VRC API.");
}

async function isVrcApiHealthy(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return false;
    const payload = await response.json();
    return payload?.service === "virtual-resource-console-api";
  } catch {
    return false;
  }
}
