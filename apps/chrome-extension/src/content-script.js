const VRC_BRIDGE_REQUEST = "VRC_EXTENSION_CONNECTION_REQUEST";
const VRC_BRIDGE_RESPONSE = "VRC_EXTENSION_CONNECTION_RESPONSE";
const VRC_SESSION_PREFIX = "vrcLaunchConnection:";

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const message = event.data;
  if (!message || message.type !== VRC_BRIDGE_REQUEST || !message.requestId || !message.sessionId) return;
  void resolveLaunchConnection(message);
});

async function resolveLaunchConnection(message) {
  const requestId = String(message.requestId);
  const sessionId = String(message.sessionId);
  const expectedConnectionId = String(message.connectionId || "");
  try {
    const key = `${VRC_SESSION_PREFIX}${sessionId}`;
    const stored = await chrome.storage.session.get(key);
    const record = stored[key];
    if (!record) throw new Error("插件本地会话不存在，请从插件连接库重新打开。");
    if (record.expiresAt && Date.now() > Number(record.expiresAt)) {
      await chrome.storage.session.remove(key);
      throw new Error("插件本地会话已过期，请重新打开。");
    }
    if (expectedConnectionId && record.id !== expectedConnectionId) {
      throw new Error("插件本地会话与连接不匹配，请重新打开。");
    }
    window.postMessage(
      {
        type: VRC_BRIDGE_RESPONSE,
        requestId,
        ok: true,
        connection: {
          id: record.id,
          name: record.name,
          providerType: record.providerType,
          host: record.host,
          port: record.port,
          username: record.username,
          password: record.password,
        },
      },
      window.location.origin,
    );
  } catch (error) {
    window.postMessage(
      {
        type: VRC_BRIDGE_RESPONSE,
        requestId,
        ok: false,
        message: error instanceof Error ? error.message : "读取插件本地连接失败",
      },
      window.location.origin,
    );
  }
}
