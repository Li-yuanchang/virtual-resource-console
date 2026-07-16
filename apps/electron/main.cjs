const { app, BrowserWindow, Menu, Tray, WebContentsView, nativeImage, nativeTheme, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const APP_DISPLAY_NAME = "VRC";
const MIN_STARTUP_VISIBLE_MS = 650;
const STARTUP_READY_STATUS_MS = 60;
const STARTUP_EXIT_ANIMATION_MS = 260;
const RENDERER_READY_TIMEOUT_MS = 15000;

if (app && app.setName) {
  app.setName(APP_DISPLAY_NAME);
}

let mainWindow;
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

async function createWindow() {
  const startupAppearance = readStartupAppearance();
  startupOverlayReady = false;
  const shouldStartBundledApi = app.isPackaged && !process.env.VRC_WEB_URL;
  const bundledApiPromise = shouldStartBundledApi ? startBundledApi() : Promise.resolve(apiBaseUrl);
  bundledApiPromise.catch(() => undefined);
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
    },
  });

  mainWindow.on("close", (event) => {
    appendMainLog("main window close requested", { isQuitting, startupActive: Boolean(startupView) });
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
  });

  startupStartedAt = Date.now();
  try {
    await attachStartupView(startupAppearance);
    startupOverlayReady = true;
  } catch (error) {
    appendMainLog("startup overlay failed to load", { message: error instanceof Error ? error.message : String(error) });
    disposeStartupView();
    startupOverlayReady = true;
  }
  appendMainLog("startup overlay ready", { elapsedMs: Date.now() - startupStartedAt });
  mainWindow.show();

  try {
    await setStartupStatus("正在载入资源配置");
    apiBaseUrl = await bundledApiPromise;
    const rendererLoadStartedAt = Date.now();
    await mainWindow.loadURL(apiBaseUrl);
    await setStartupStatus("正在准备工作区");
    const rendererReady = await waitForRendererReady(mainWindow.webContents);
    appendMainLog("renderer startup readiness resolved", { rendererReady, elapsedMs: Date.now() - rendererLoadStartedAt });
    await finishStartupView();
  } catch (error) {
    appendMainLog("desktop startup failed", { message: error instanceof Error ? error.message : String(error) });
    await setStartupStatus("启动失败，请查看日志");
    throw error;
  }

}

app.whenReady().then(async () => {
  configureApplicationMenu();
  createTray();
  await createWindow();
}).catch((error) => {
  appendMainLog("electron initialization failed", { message: error instanceof Error ? error.message : String(error) });
});

app.on("window-all-closed", () => undefined);

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
    return;
  }
  if (!startupOverlayReady) return;
  mainWindow?.show();
  mainWindow?.focus();
});

app.on("before-quit", () => {
  isQuitting = true;
  logStreamsClosing = true;
  disposeStartupView();
  if (apiProcess && !apiProcess.killed) {
    apiProcess.kill();
  }
  closeLogStream(apiLogStream);
  closeLogStream(mainLogStream);
  apiLogStream = undefined;
  mainLogStream = undefined;
});

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
  if (remaining) await delay(remaining);
  await setStartupStatus("资源控制台已就绪");
  await delay(STARTUP_READY_STATUS_MS);
  try {
    await startupView.webContents.executeJavaScript("window.vrcStartup?.complete()");
  } catch {
    // 覆盖层仍会在下方统一释放。
  }
  await delay(STARTUP_EXIT_ANIMATION_MS);
  appendMainLog("releasing startup overlay", { visibleBefore: mainWindow?.isVisible() });
  disposeStartupView();
  mainWindow?.show();
  mainWindow?.focus();
  appendMainLog("startup overlay released", { visibleAfter: mainWindow?.isVisible() });
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
  while (Date.now() < deadline) {
    if (webContents.isDestroyed()) return false;
    try {
      const ready = await webContents.executeJavaScript("document.documentElement.dataset.appReady === 'true'");
      if (ready) return true;
    } catch {
      // 页面导航或首轮脚本执行期间继续等待。
    }
    await delay(50);
  }
  return false;
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

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function startBundledApi() {
  const apiStartupStartedAt = Date.now();
  const preferredPort = Number(process.env.PORT || 3987);
  const preferredBaseUrl = `http://127.0.0.1:${preferredPort}`;
  if (process.env.VRC_REUSE_EXISTING_API === "1" && await isVrcApiHealthy(preferredBaseUrl)) {
    appendMainLog("reusing existing vrc api", { baseUrl: preferredBaseUrl, elapsedMs: Date.now() - apiStartupStartedAt });
    return preferredBaseUrl;
  }
  const port = await resolveApiPort(preferredPort);
  const resourcesPath = process.resourcesPath;
  const apiEntry = path.join(resourcesPath, "api", "index.js");
  const webDistDir = path.join(resourcesPath, "web");
  const nodeModulesDir = path.join(resourcesPath, "node_modules");
  const nodeRuntime = resolveNodeRuntimePath(resourcesPath);
  const useElectronAsNode = nodeRuntime === process.execPath;
  const logsPath = getLogDir();
  const dataDir = getVrcDataDir();
  ensureBundledIpPoolsConfig(resourcesPath, dataDir);
  apiLogStream = createLogStream("api.log");
  appendMainLog("starting bundled api", { port, apiEntry, webDistDir, nodeModulesDir, logsPath, nodeRuntime, useElectronAsNode, dataDir });

  apiProcess = spawn(nodeRuntime, [apiEntry], {
    env: {
      ...process.env,
      ...(useElectronAsNode ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
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
  appendMainLog("bundled api ready", { baseUrl, elapsedMs: Date.now() - apiStartupStartedAt });
  return baseUrl;
}

function getVrcDataDir() {
  return process.env.VRC_DATA_DIR?.trim() || path.join(app.getPath("home"), ".virtual-resource-console");
}

function ensureBundledIpPoolsConfig(resourcesPath, dataDir = getVrcDataDir()) {
  const targetFile = path.join(dataDir, "ip-pools.json");
  if (fs.existsSync(targetFile)) return;
  const sourceFile = path.join(resourcesPath, "config", "ip-pools.json");
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.copyFileSync(sourceFile, targetFile);
  try {
    fs.chmodSync(targetFile, 0o600);
  } catch {
    // Windows 不支持 POSIX mode，忽略即可。
  }
  appendMainLog("seeded default ip pools config", { targetFile });
}

function createTray() {
  const trayIcon = nativeImage.createFromPath(resolveAssetPath("tray.png"));
  tray = new Tray(trayIcon);
  tray.setToolTip("Virtual Resource Console");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "打开资源控制台",
        click: () => {
          if (!mainWindow) return;
          mainWindow.show();
          mainWindow.focus();
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
  const deadline = Date.now() + 15000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
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
