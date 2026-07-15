const { app, BrowserWindow, Menu, Tray, nativeImage, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const APP_DISPLAY_NAME = "VRC";

if (app && app.setName) {
  app.setName(APP_DISPLAY_NAME);
}

let mainWindow;
let apiProcess;
let apiBaseUrl = process.env.VRC_WEB_URL || "http://127.0.0.1:5173";
let tray;
let logDir;
let apiLogStream;
let mainLogStream;

async function createWindow() {
  const macWindowOptions =
    process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset",
          trafficLightPosition: { x: 14, y: 14 },
        }
      : {};

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1180,
    minHeight: 760,
    autoHideMenuBar: process.platform === "win32",
    ...macWindowOptions,
    backgroundColor: "#f6f3ee",
    icon: resolveAssetPath(process.platform === "win32" ? "app-icon.ico" : "app-icon.icns"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (app.isPackaged && !process.env.VRC_WEB_URL) {
    apiBaseUrl = await startBundledApi();
  }

  mainWindow.loadURL(apiBaseUrl);
}

app.whenReady().then(async () => {
  configureApplicationMenu();
  await createWindow();
  createTray();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("before-quit", () => {
  if (apiProcess && !apiProcess.killed) {
    apiProcess.kill();
  }
  apiLogStream?.end();
  mainLogStream?.end();
});

async function startBundledApi() {
  const port = await resolveApiPort(Number(process.env.PORT || 3987));
  const resourcesPath = process.resourcesPath;
  const apiEntry = path.join(resourcesPath, "api", "index.js");
  const webDistDir = path.join(resourcesPath, "web");
  const nodeModulesDir = path.join(resourcesPath, "node_modules");
  const nodeRuntime = resolveNodeRuntimePath(resourcesPath);
  const useElectronAsNode = nodeRuntime === process.execPath;
  const logsPath = getLogDir();
  apiLogStream = createLogStream("api.log");
  appendMainLog("starting bundled api", { port, apiEntry, webDistDir, nodeModulesDir, logsPath, nodeRuntime, useElectronAsNode });

  apiProcess = spawn(nodeRuntime, [apiEntry], {
    env: {
      ...process.env,
      ...(useElectronAsNode ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
      HOST: "127.0.0.1",
      PORT: String(port),
      NODE_PATH: nodeModulesDir,
      VRC_WEB_DIST_DIR: webDistDir,
      VRC_LOG_DIR: logsPath,
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
  appendMainLog("bundled api ready", { baseUrl });
  return baseUrl;
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
        click: () => app.quit(),
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
    if (!mainLogStream) {
      mainLogStream = createLogStream("main.log");
    }
    const suffix = detail ? ` ${JSON.stringify(detail)}` : "";
    mainLogStream.write(`[${new Date().toISOString()}] ${message}${suffix}\n`);
  } catch {
    // 日志失败不能影响桌面应用启动。
  }
}

function writeApiLog(streamName, chunk) {
  if (!apiLogStream) return;
  const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    apiLogStream.write(`[${new Date().toISOString()}] [${streamName}] ${line}\n`);
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
