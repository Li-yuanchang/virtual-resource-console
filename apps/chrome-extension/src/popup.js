const DEFAULT_SERVICE = {
  mode: "intranet",
  scheme: "http",
  host: "vrc-server",
  port: 3987,
};
const STORAGE_KEYS = {
  apiBaseUrl: "apiBaseUrl",
  service: "serviceSettings",
  connections: "localConnections",
};
const LAUNCH_SESSION_PREFIX = "vrcLaunchConnection:";
const PROVIDER_LABELS = {
  xenserver: "XenServer",
  vmware: "VMware",
  proxmox: "Proxmox VE",
  libvirt: "Libvirt",
};

const state = {
  service: { ...DEFAULT_SERVICE },
  connections: [],
  sessions: [],
  activeTab: "service",
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

init().catch((error) => {
  setStatus("error", "初始化失败", formatError(error));
});

async function init() {
  state.service = await loadServiceSettings();
  state.connections = await loadLocalConnections();
  bindCommonEvents();
  if (document.body.classList.contains("options-page")) {
    bindOptionsEvents();
    renderOptions();
  } else {
    renderPopup();
  }
  await checkHealth(false);
}

function bindCommonEvents() {
  $("#saveButton")?.addEventListener("click", async () => {
    readServiceFromPage();
    await saveServiceSettings();
    await checkHealth(true);
  });
  $("#checkButton")?.addEventListener("click", () => {
    readServiceFromPage();
    void checkHealth(true);
  });
  $("#openButton")?.addEventListener("click", async () => {
    readServiceFromPage();
    await saveServiceSettings();
    await chrome.tabs.create({ url: getBaseUrl() });
  });
  $("#startButton")?.addEventListener("click", () => {
    readServiceFromPage();
    void startLocalService();
  });
  $("#openOptionsButton")?.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });
}

function bindOptionsEvents() {
  $$(".mode-button").forEach((button) => {
    button.addEventListener("click", () => {
      state.service.mode = button.dataset.mode === "local" ? "local" : "intranet";
      if (state.service.mode === "local" && (!state.service.host || state.service.host === DEFAULT_SERVICE.host)) state.service.host = "127.0.0.1";
      if (state.service.mode === "intranet" && state.service.host === "127.0.0.1") state.service.host = DEFAULT_SERVICE.host;
      renderServiceFields();
    });
  });
  $$(".tab-button").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeTab = button.dataset.tab || "service";
      renderTabs();
    });
  });
  $("#addConnectionButton")?.addEventListener("click", () => {
    void addLocalConnection();
  });
  $("#clearSessionsButton")?.addEventListener("click", () => {
    void clearSessions();
  });
  $("#refreshSessionsButton")?.addEventListener("click", () => {
    void refreshSessions(true);
  });
  $("#connectionsTable")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const connection = state.connections.find((item) => item.id === button.dataset.id);
    if (!connection) return;
    if (button.dataset.action === "delete") void deleteLocalConnection(connection.id);
    if (button.dataset.action === "test") void testLocalConnection(connection);
    if (button.dataset.action === "open") void openConsoleWithConnection(connection);
  });
}

function renderPopup() {
  const apiBaseUrl = $("#apiBaseUrl");
  if (apiBaseUrl) apiBaseUrl.value = getBaseUrl();
  const vaultSummary = $("#vaultSummary");
  if (vaultSummary) vaultSummary.textContent = `${state.connections.length} 个连接 · 当前浏览器`;
}

function renderOptions() {
  renderServiceFields();
  renderTabs();
  renderConnectionTable();
}

function renderServiceFields() {
  const modeButtons = $$(".mode-button");
  modeButtons.forEach((button) => button.classList.toggle("active", button.dataset.mode === state.service.mode));
  setValue("#serviceScheme", state.service.scheme);
  setValue("#serviceHost", state.service.host);
  setValue("#servicePort", String(state.service.port));
  setValue("#apiBaseUrl", getBaseUrl());
  setValue("#baseUrlPreview", getBaseUrl());
}

function renderTabs() {
  $$(".tab-button").forEach((button) => button.classList.toggle("active", button.dataset.tab === state.activeTab));
  $$(".tab-panel").forEach((panel) => panel.classList.toggle("active", panel.dataset.panel === state.activeTab));
  if (state.activeTab === "vault") renderConnectionTable();
  if (state.activeTab === "sessions") renderSessions();
}

function renderConnectionTable() {
  const tbody = $("#connectionsTable tbody");
  if (!tbody) return;
  if (!state.connections.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-cell">当前浏览器还没有保存插件连接。</td></tr>`;
    return;
  }
  tbody.innerHTML = state.connections
    .map(
      (item) => `
        <tr>
          <td><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.username)} · ${escapeHtml(item.lastUsed || "未使用")}</span></td>
          <td>${PROVIDER_LABELS[item.providerType] || item.providerType}</td>
          <td>${escapeHtml(item.host)}:${item.port}</td>
          <td>local encrypted</td>
          <td><span class="plain-status ${item.status === "ready" ? "success" : "warning"}">${item.status === "ready" ? "可用" : "需验证"}</span></td>
          <td>
            <div class="table-actions">
              <button type="button" data-action="open" data-id="${item.id}">打开</button>
              <button type="button" data-action="test" data-id="${item.id}">检测</button>
              <button type="button" data-action="delete" data-id="${item.id}">删除</button>
            </div>
          </td>
        </tr>
      `,
    )
    .join("");
}

function renderSessions() {
  const list = $("#sessionsList");
  if (!list) return;
  if (!state.sessions.length) {
    list.innerHTML = `<div class="empty-note">共享 Web 不创建服务端临时连接；账号只在浏览器本地解密，并加密本次请求。</div>`;
    return;
  }
  list.innerHTML = state.sessions
    .map((item) => {
      const ttl = Math.max(0, Math.round((Date.parse(item.expiresAt) - Date.now()) / 60000));
      return `<article class="session-row"><span><strong>${escapeHtml(item.id)}</strong><small>${escapeHtml(item.name)} · ${escapeHtml(item.host)}:${item.port}</small></span><i>${ttl}m</i></article>`;
    })
    .join("");
}

function readServiceFromPage() {
  const apiBaseUrl = $("#apiBaseUrl");
  if (apiBaseUrl && !document.body.classList.contains("options-page")) {
    state.service = parseBaseUrl(apiBaseUrl.value);
    return;
  }
  const scheme = $("#serviceScheme")?.value === "https" ? "https" : "http";
  const host = ($("#serviceHost")?.value || state.service.host || DEFAULT_SERVICE.host).trim();
  const port = normalizePort($("#servicePort")?.value, DEFAULT_SERVICE.port);
  state.service = {
    mode: state.service.mode,
    scheme,
    host,
    port,
  };
  renderServiceFields();
}

async function loadServiceSettings() {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.service, STORAGE_KEYS.apiBaseUrl]);
  if (stored[STORAGE_KEYS.service]?.host) {
    return normalizeService(stored[STORAGE_KEYS.service]);
  }
  return parseBaseUrl(stored[STORAGE_KEYS.apiBaseUrl] || `${DEFAULT_SERVICE.scheme}://${DEFAULT_SERVICE.host}:${DEFAULT_SERVICE.port}`);
}

async function saveServiceSettings() {
  state.service = normalizeService(state.service);
  await chrome.storage.local.set({
    [STORAGE_KEYS.service]: state.service,
    [STORAGE_KEYS.apiBaseUrl]: getBaseUrl(),
  });
  setStatus("checking", "已保存", "服务地址仅保存到当前浏览器。");
}

async function loadLocalConnections() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.connections);
  const connections = stored[STORAGE_KEYS.connections];
  return Array.isArray(connections) ? connections : [];
}

async function saveLocalConnections() {
  await chrome.storage.local.set({ [STORAGE_KEYS.connections]: state.connections });
}

async function addLocalConnection() {
  readServiceFromPage();
  const masterPassword = getRequiredValue("#masterPassword", "请填写主密码");
  const plainPassword = getRequiredValue("#connectionPassword", "请填写连接密码");
  const host = getRequiredValue("#connectionHost", "请填写 Host");
  const providerType = $("#connectionProvider")?.value || "xenserver";
  const connection = {
    id: `local_${Date.now()}`,
    name: ($("#connectionName")?.value || `${PROVIDER_LABELS[providerType] || providerType}:${host}`).trim(),
    providerType,
    host,
    port: normalizePort($("#connectionPort")?.value, defaultPortForProvider(providerType)),
    username: ($("#connectionUsername")?.value || "root").trim(),
    encryptedPassword: await encryptSecret(plainPassword, masterPassword),
    status: "pending",
    lastUsed: "刚刚保存",
    createdAt: new Date().toISOString(),
  };
  state.connections = [connection, ...state.connections];
  await saveLocalConnections();
  setValue("#connectionPassword", "");
  renderConnectionTable();
  setStatus("ok", "已本地保存", "连接密码已用主密码加密，未上传到服务器。");
}

async function deleteLocalConnection(id) {
  state.connections = state.connections.filter((item) => item.id !== id);
  await saveLocalConnections();
  renderConnectionTable();
  setStatus("checking", "已删除", "只删除当前浏览器本地连接。");
}

async function testLocalConnection(connection) {
  try {
    const payload = await buildDirectConnectionPayload(connection);
    const response = await secureFetchJson(`${getBaseUrl()}/api/connections/test`, {
      method: "POST",
      body: payload,
    });
    markConnectionReady(connection.id);
    setStatus("ok", "连接可用", `${connection.name} 已通过加密请求检测。`);
    return response;
  } catch (error) {
    setStatus("error", "检测失败", formatError(error));
  }
}

async function openConsoleWithConnection(connection) {
  try {
    const payload = await buildDirectConnectionPayload(connection);
    const sessionId = createNonce();
    await chrome.storage.session.set({
      [`${LAUNCH_SESSION_PREFIX}${sessionId}`]: {
        id: connection.id,
        name: connection.name,
        ...payload,
        expiresAt: Date.now() + 10 * 60_000,
      },
    });
    markConnectionReady(connection.id);
    await chrome.tabs.create({
      url: `${getBaseUrl()}/?browserConnectionId=${encodeURIComponent(connection.id)}&browserSessionId=${encodeURIComponent(sessionId)}`,
    });
  } catch (error) {
    setStatus("error", "打开失败", formatError(error));
  }
}

async function buildDirectConnectionPayload(connection) {
  readServiceFromPage();
  await saveServiceSettings();
  const masterPassword = getRequiredValue("#masterPassword", "请先填写主密码解锁本地连接库");
  const password = await decryptSecret(connection.encryptedPassword, masterPassword);
  return {
    providerType: connection.providerType,
    host: connection.host,
    port: connection.port,
    username: connection.username,
    password,
  };
}

async function secureFetchJson(url, { method = "POST", body } = {}) {
  const requestInit = { method };
  if (body !== undefined) {
    requestInit.headers = { "Content-Type": "application/json" };
    requestInit.body = JSON.stringify(containsSensitiveField(body) ? await encryptRequestPayload(url, method, body) : body);
  }
  const response = await fetch(url, requestInit);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || `请求失败：HTTP ${response.status}`);
  return payload;
}

async function encryptRequestPayload(url, method, payload) {
  const keyInfo = await getTrustedRequestPublicKey(url);
  const aesKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const rawAesKey = await crypto.subtle.exportKey("raw", aesKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = {
    method: method.toUpperCase(),
    path: new URL(url).pathname,
    ts: Date.now(),
    nonce: createNonce(),
  };
  const encryptedBytes = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(stableJson(aad)), tagLength: 128 },
      aesKey,
      new TextEncoder().encode(JSON.stringify(payload)),
    ),
  );
  const publicKey = await crypto.subtle.importKey("jwk", keyInfo.publicKey, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
  const encryptedKey = new Uint8Array(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, rawAesKey));
  const tagStart = encryptedBytes.length - 16;
  return {
    encrypted: true,
    keyId: keyInfo.keyId,
    alg: "RSA-OAEP-256+A256GCM",
    iv: bytesToBase64Url(iv),
    encryptedKey: bytesToBase64Url(encryptedKey),
    ciphertext: bytesToBase64Url(encryptedBytes.slice(0, tagStart)),
    tag: bytesToBase64Url(encryptedBytes.slice(tagStart)),
    aad,
  };
}

async function getTrustedRequestPublicKey(url) {
  const baseUrl = new URL(url).origin;
  const response = await fetch(`${baseUrl}/api/crypto/public-key`, { cache: "no-store" });
  const keyInfo = await response.json();
  if (!response.ok) throw new Error(keyInfo.message || "读取 VRC API 加密公钥失败");
  const trustKey = `requestCryptoFingerprint:${baseUrl}`;
  const stored = await chrome.storage.local.get(trustKey);
  const trusted = stored[trustKey];
  if (!trusted) {
    await chrome.storage.local.set({ [trustKey]: keyInfo.fingerprint });
    return keyInfo;
  }
  if (trusted !== keyInfo.fingerprint) {
    throw new Error("VRC API 加密公钥指纹已变化，请确认服务器后重新信任。");
  }
  return keyInfo;
}

function containsSensitiveField(value) {
  if (Array.isArray(value)) return value.some((item) => containsSensitiveField(item));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, item]) => {
    if (["password", "rootpassword", "token", "secret", "privatekey"].includes(key.toLowerCase())) return true;
    return containsSensitiveField(item);
  });
}

function createNonce() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}

function bytesToBase64Url(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(index, index + chunkSize));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function markConnectionReady(id) {
  state.connections = state.connections.map((item) =>
    item.id === id
      ? {
          ...item,
          status: "ready",
          lastUsed: "刚刚",
        }
      : item,
  );
  void saveLocalConnections();
  renderConnectionTable();
}

async function refreshSessions(showStatus) {
  state.sessions = [];
  renderSessions();
  if (showStatus) setStatus("checking", "已停用", "共享 Web 不再创建服务端临时连接会话。");
}

async function clearSessions() {
  state.sessions = [];
  renderSessions();
  setStatus("checking", "无需清理", "共享 Web 不再创建服务端临时连接会话。");
}

async function checkHealth(showChecking) {
  readServiceFromPage();
  if (showChecking) setStatus("checking", "正在检测", `正在访问 ${getBaseUrl()}/api/health`);
  try {
    const response = await fetch(`${getBaseUrl()}/api/health`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    setStatus("ok", "服务可用", payload.service ? `${payload.service} 已响应。` : "VRC API 已响应。");
  } catch (error) {
    setStatus("error", "服务不可用", formatError(error));
  }
}

async function startLocalService() {
  setStatus("checking", "正在启动", "正在请求本机 VRC Native Host 启动服务。");
  try {
    const response = await sendNativeMessage({ type: "start", preferredBaseUrl: getBaseUrl() });
    if (!response?.ok) throw new Error(response?.message || "Native Host 未返回可用服务地址。");
    state.service = parseBaseUrl(response.baseUrl || "http://127.0.0.1:3987");
    await saveServiceSettings();
    renderServiceFields();
    renderPopup();
    await checkHealth(true);
  } catch (error) {
    await openProtocolFallback();
    setStatus("error", "需要本机组件或内网服务", `${formatError(error)}。已尝试唤起 vrc://start；如果没有安装客户端，请填写内网服务器地址。`);
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
    // Unknown protocols can be blocked by Chrome. The status text keeps the fallback actionable.
  }
}

async function encryptSecret(secret, masterPassword) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(masterPassword, salt);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(secret));
  return {
    algorithm: "AES-GCM",
    kdf: "PBKDF2-SHA256",
    iterations: 150000,
    salt: toBase64(salt),
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(encrypted)),
  };
}

async function decryptSecret(payload, masterPassword) {
  const salt = fromBase64(payload.salt);
  const iv = fromBase64(payload.iv);
  const key = await deriveAesKey(masterPassword, salt);
  try {
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, fromBase64(payload.ciphertext));
    return new TextDecoder().decode(decrypted);
  } catch {
    throw new Error("主密码不正确，无法解锁本地连接。");
  }
}

async function deriveAesKey(masterPassword, salt) {
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(masterPassword), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 150000, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function normalizeService(value) {
  return {
    mode: value.mode === "local" ? "local" : "intranet",
    scheme: value.scheme === "https" ? "https" : "http",
    host: String(value.host || DEFAULT_SERVICE.host).trim() || DEFAULT_SERVICE.host,
    port: normalizePort(value.port, DEFAULT_SERVICE.port),
  };
}

function parseBaseUrl(value) {
  try {
    const url = new URL(String(value || "").trim() || `${DEFAULT_SERVICE.scheme}://${DEFAULT_SERVICE.host}:${DEFAULT_SERVICE.port}`);
    return normalizeService({
      mode: url.hostname === "127.0.0.1" || url.hostname === "localhost" ? "local" : "intranet",
      scheme: url.protocol === "https:" ? "https" : "http",
      host: url.hostname,
      port: Number(url.port) || (url.protocol === "https:" ? 443 : 80),
    });
  } catch {
    return { ...DEFAULT_SERVICE };
  }
}

function getBaseUrl() {
  const service = normalizeService(state.service);
  return `${service.scheme}://${service.host}:${service.port}`;
}

function normalizePort(value, fallback) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback;
}

function defaultPortForProvider(providerType) {
  if (providerType === "vmware") return 443;
  if (providerType === "proxmox") return 8006;
  return 443;
}

function getRequiredValue(selector, message) {
  const value = ($(selector)?.value || "").trim();
  if (!value) throw new Error(message);
  return value;
}

function setValue(selector, value) {
  const element = $(selector);
  if (element) element.value = value;
}

function setStatus(status, title, detail) {
  const dot = $("#statusDot");
  dot?.classList.toggle("ok", status === "ok");
  dot?.classList.toggle("error", status === "error");
  dot?.classList.toggle("checking", status === "checking");
  const titleNode = $("#healthTitle");
  const detailNode = $("#healthDetail");
  if (titleNode) titleNode.textContent = title;
  if (detailNode) detailNode.textContent = detail;
}

async function readErrorMessage(response) {
  try {
    const payload = await response.json();
    return payload.message || `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

function formatError(error) {
  if (!(error instanceof Error)) return "操作失败";
  if (error.message.includes("Specified native messaging host not found")) return "未安装 VRC Native Host";
  return error.message || "操作失败";
}

function toBase64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(value) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
