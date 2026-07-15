const DEFAULT_API_BASE_URL = "http://127.0.0.1:3987";

const elements = {
  apiBaseUrl: document.querySelector("#apiBaseUrl"),
  saveButton: document.querySelector("#saveButton"),
  openButton: document.querySelector("#openButton"),
  checkButton: document.querySelector("#checkButton"),
  startButton: document.querySelector("#startButton"),
  healthTitle: document.querySelector("#healthTitle"),
  healthDetail: document.querySelector("#healthDetail"),
  statusDot: document.querySelector("#statusDot"),
};

init();

async function init() {
  const apiBaseUrl = await getApiBaseUrl();
  elements.apiBaseUrl.value = apiBaseUrl;
  bindEvents();
  await checkHealth(false);
}

function bindEvents() {
  elements.saveButton.addEventListener("click", async () => {
    const apiBaseUrl = normalizeBaseUrl(elements.apiBaseUrl.value);
    elements.apiBaseUrl.value = apiBaseUrl;
    await chrome.storage.local.set({ apiBaseUrl });
    await checkHealth(true);
  });

  elements.checkButton.addEventListener("click", () => {
    void checkHealth(true);
  });

  elements.startButton.addEventListener("click", () => {
    void startLocalService();
  });

  elements.openButton.addEventListener("click", async () => {
    const apiBaseUrl = normalizeBaseUrl(elements.apiBaseUrl.value);
    await chrome.storage.local.set({ apiBaseUrl });
    await chrome.tabs.create({ url: apiBaseUrl });
  });
}

async function startLocalService() {
  setStatus("checking", "正在启动", "正在请求本机 VRC Native Host 启动服务。");
  try {
    const response = await sendNativeMessage({ type: "start", preferredBaseUrl: normalizeBaseUrl(elements.apiBaseUrl.value) });
    if (!response?.ok) {
      throw new Error(response?.message || "Native Host 未返回可用服务地址。");
    }
    const apiBaseUrl = normalizeBaseUrl(response.baseUrl || DEFAULT_API_BASE_URL);
    elements.apiBaseUrl.value = apiBaseUrl;
    await chrome.storage.local.set({ apiBaseUrl });
    await checkHealth(true);
    return;
  } catch (error) {
    await openProtocolFallback();
    setStatus(
      "error",
      "需要本机组件或内网服务",
      `${formatError(error)}。已尝试唤起 vrc://start；如果没有安装客户端，请填写内网服务器地址。`,
    );
  }
}

function sendNativeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage("com.virtualresource.console", message, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      resolve(response);
    });
  });
}

async function openProtocolFallback() {
  try {
    await chrome.tabs.create({ url: "vrc://start" });
  } catch {
    // Chrome can reject unknown protocols. The health text gives the actionable fallback.
  }
}

async function getApiBaseUrl() {
  const result = await chrome.storage.local.get("apiBaseUrl");
  return normalizeBaseUrl(result.apiBaseUrl || DEFAULT_API_BASE_URL);
}

async function checkHealth(showChecking) {
  const apiBaseUrl = normalizeBaseUrl(elements.apiBaseUrl.value);
  if (showChecking) {
    setStatus("checking", "正在检测", `正在访问 ${apiBaseUrl}/api/health`);
  }
  try {
    const response = await fetch(`${apiBaseUrl}/api/health`, {
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await response.json();
    setStatus("ok", "服务可用", payload.name ? `${payload.name} 已响应。` : "VRC API 已响应。");
  } catch (error) {
    setStatus("error", "服务不可用", error instanceof Error ? error.message : "无法连接 VRC API。");
  }
}

function normalizeBaseUrl(value) {
  const raw = String(value || "").trim() || DEFAULT_API_BASE_URL;
  return raw.replace(/\/+$/, "");
}

function setStatus(status, title, detail) {
  elements.statusDot.classList.toggle("ok", status === "ok");
  elements.statusDot.classList.toggle("error", status === "error");
  elements.healthTitle.textContent = title;
  elements.healthDetail.textContent = detail;
}

function formatError(error) {
  if (!(error instanceof Error)) return "无法启动本机服务";
  if (error.message.includes("Specified native messaging host not found")) {
    return "未安装 VRC Native Host";
  }
  return error.message || "无法启动本机服务";
}
