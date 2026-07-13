import type { FastifyInstance, FastifyRequest } from "fastify";
import { XMLParser } from "fast-xml-parser";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import type { RawData, WebSocket } from "ws";
import { resolveStoredConnection } from "../connectionStore.js";
import type { XenConnectionInput } from "../types.js";
import { getXenConsoleLocation } from "../xenserver.js";

const XAPI_PORT = 443;
const XAPI_TIMEOUT_MS = 15_000;
const CONSOLE_CONNECT_TIMEOUT_MS = 20_000;
const MAX_CLOSE_REASON_BYTES = 110;

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
});

interface ConsoleQuery {
  connectionId?: string;
  vmId?: string;
}

interface XenConsoleSession {
  sessionId: string;
  consoleUrl: URL;
  logout(): Promise<void>;
}

export async function registerXenServerConsoleRoutes(server: FastifyInstance): Promise<void> {
  server.get("/api/console/xenserver", { websocket: true }, (socket, request) => {
    const pendingClientMessages: Buffer[] = [];
    let tunnel: Socket | null = null;
    let tunnelReady = false;
    let closed = false;
    let session: XenConsoleSession | null = null;

    socket.on("message", (message) => {
      const data = toBuffer(message);
      if (!data.length) return;
      if (tunnelReady && tunnel && !tunnel.destroyed) {
        tunnel.write(data);
      } else {
        pendingClientMessages.push(data);
      }
    });

    socket.on("close", () => {
      closed = true;
      cleanupTunnel(tunnel);
      void session?.logout();
    });

    socket.on("error", () => {
      closed = true;
      cleanupTunnel(tunnel);
      void session?.logout();
    });

    void openXenConsoleSession(request)
      .then(async (openedSession) => {
        if (closed) {
          await openedSession.logout();
          return;
        }
        session = openedSession;
        tunnel = await openConsoleTunnel(openedSession);
        if (closed) {
          cleanupTunnel(tunnel);
          await openedSession.logout();
          return;
        }
        tunnelReady = true;
        for (const message of pendingClientMessages.splice(0)) {
          tunnel.write(message);
        }
        tunnel.on("data", (chunk) => {
          if (socket.readyState === socket.OPEN) {
            socket.send(chunk, { binary: true });
          }
        });
        tunnel.on("close", () => {
          if (socket.readyState === socket.OPEN) {
            socket.close(1000, "XenServer 控制台连接已关闭");
          }
          void openedSession.logout();
        });
        tunnel.on("error", (error) => {
          server.log.warn({ error }, "xenserver console tunnel failed");
          closeWithError(socket, "XenServer 控制台流连接失败");
          void openedSession.logout();
        });
      })
      .catch((error) => {
        server.log.warn({ error }, "failed to open xenserver console");
        closeWithError(socket, error instanceof Error ? error.message : "XenServer 控制台打开失败");
      });
  });
}

async function openXenConsoleSession(request: FastifyRequest): Promise<XenConsoleSession> {
  const query = request.query as ConsoleQuery;
  if (!query.connectionId || !query.vmId) {
    throw new Error("控制台参数不完整：缺少连接或 VM。");
  }
  const stored = resolveStoredConnection(query.connectionId);
  if (stored.providerType !== "xenserver") {
    throw new Error("当前控制台代理只处理 XenServer。");
  }

  const connection: XenConnectionInput = {
    host: stored.host,
    port: stored.port,
    username: stored.username,
    password: stored.password,
  };
  const location = await getXenConsoleLocation(connection, query.vmId);
  if (!location) {
    throw new Error("未读取到 XenServer 控制台地址，请确认 VM 正在运行且存在 RFB 控制台。");
  }

  const consoleUrl = normalizeConsoleUrl(location, stored.host);
  const apiHost = consoleUrl.hostname || stored.host;
  const sessionId = await loginWithPassword({ ...connection, host: apiHost });

  return {
    sessionId,
    consoleUrl,
    logout: () => logoutSession(apiHost, sessionId),
  };
}

async function openConsoleTunnel(session: XenConsoleSession): Promise<Socket> {
  try {
    return await openConsoleTunnelOnce(session, false);
  } catch (error) {
    if (session.consoleUrl.protocol === "https:" && isUnsupportedTlsProtocol(error)) {
      return openConsoleTunnelOnce(session, true);
    }
    throw error;
  }
}

function openConsoleTunnelOnce(session: XenConsoleSession, forcePlainTcp: boolean): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const host = session.consoleUrl.hostname;
    const useTls = session.consoleUrl.protocol === "https:" && !forcePlainTcp;
    const defaultPort = session.consoleUrl.protocol === "https:" && !forcePlainTcp ? XAPI_PORT : 80;
    const port = Number(session.consoleUrl.port || defaultPort);
    const socket = useTls
      ? tlsConnect({
          host,
          port,
          servername: host,
          rejectUnauthorized: false,
        })
      : netConnect({ host, port });
    let handshake = Buffer.alloc(0);
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        socket.destroy();
        reject(new Error("XenServer 控制台流连接超时。"));
      }
    }, CONSOLE_CONNECT_TIMEOUT_MS);

    const sendConnectRequest = () => {
      const path = `${session.consoleUrl.pathname}${session.consoleUrl.search}`;
      socket.write(
        [
          `CONNECT ${path} HTTP/1.1`,
          `Host: ${session.consoleUrl.host}`,
          `Cookie: session_id=${session.sessionId}`,
          "Connection: keep-alive",
          "",
          "",
        ].join("\r\n"),
      );
    };
    if (useTls) {
      (socket as TLSSocket).once("secureConnect", sendConnectRequest);
    } else {
      socket.once("connect", sendConnectRequest);
    }

    socket.on("data", function onHandshakeData(chunk) {
      if (settled) return;
      handshake = Buffer.concat([handshake, chunk]);
      const headerEnd = handshake.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;

      const header = handshake.subarray(0, headerEnd).toString("latin1");
      const remaining = handshake.subarray(headerEnd + 4);
      const statusLine = header.split("\r\n")[0] ?? "";
      if (!/^HTTP\/1\.[01] 200\b/.test(statusLine)) {
        clearTimeout(timeout);
        settled = true;
        socket.destroy();
        reject(new Error(`XenServer 控制台握手失败：${statusLine || "无响应"}`));
        return;
      }

      clearTimeout(timeout);
      settled = true;
      socket.off("data", onHandshakeData);
      if (remaining.length) {
        socket.unshift(remaining);
      }
      resolve(socket);
    });

    socket.once("error", (error) => {
      if (!settled) {
        clearTimeout(timeout);
        settled = true;
        reject(error);
      }
    });
  });
}

async function loginWithPassword(input: XenConnectionInput): Promise<string> {
  try {
    return await callSessionLogin(input, [input.username, input.password, "1.0", "virtual-resource-console"]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!message.includes("MESSAGE_PARAMETER_COUNT_MISMATCH") && !message.includes("参数")) {
      throw error;
    }
    return callSessionLogin(input, [input.username, input.password]);
  }
}

async function callSessionLogin(input: XenConnectionInput, params: string[]): Promise<string> {
  const response = await xmlRpcRequest(input.host, buildXmlRpcRequest("session.login_with_password", params));
  const parsed = xmlParser.parse(response);
  const fault = parsed?.methodResponse?.fault;
  if (fault) {
    throw new Error(`XenAPI 登录失败：${readXmlRpcFault(fault)}`);
  }
  const value = parsed?.methodResponse?.params?.param?.value;
  const sessionId = readXenApiResultValue(value) || readXmlRpcScalar(value);
  if (!sessionId) {
    throw new Error("XenAPI 登录失败：未返回 session。");
  }
  return sessionId;
}

async function logoutSession(host: string, sessionId: string): Promise<void> {
  try {
    await xmlRpcRequest(host, buildXmlRpcRequest("session.logout", [sessionId]));
  } catch {
    // 控制台连接关闭时尽量回收 XenAPI session，失败不影响前端收尾。
  }
}

function xmlRpcRequest(host: string, body: string): Promise<string> {
  return xmlRpcRequestOnce(host, body, "https:").catch((error) => {
    if (isUnsupportedTlsProtocol(error)) {
      return xmlRpcRequestOnce(host, body, "http:");
    }
    throw error;
  });
}

function xmlRpcRequestOnce(host: string, body: string, protocol: "http:" | "https:"): Promise<string> {
  return new Promise((resolve, reject) => {
    const requestFactory = protocol === "https:" ? httpsRequest : httpRequest;
    const request = requestFactory(
      {
        host,
        port: protocol === "https:" ? XAPI_PORT : 80,
        method: "POST",
        path: "/",
        ...(protocol === "https:" ? { rejectUnauthorized: false } : {}),
        timeout: XAPI_TIMEOUT_MS,
        headers: {
          "Content-Type": "text/xml",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (response) => {
        let data = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          data += chunk;
        });
        response.on("end", () => {
          if ((response.statusCode ?? 0) >= 400) {
            reject(new Error(`XenAPI HTTP ${response.statusCode}`));
            return;
          }
          resolve(data);
        });
      },
    );
    request.on("timeout", () => {
      request.destroy(new Error("XenAPI 登录超时。"));
    });
    request.on("error", reject);
    request.end(body);
  });
}

function buildXmlRpcRequest(method: string, params: string[]): string {
  return [
    '<?xml version="1.0"?>',
    "<methodCall>",
    `<methodName>${escapeXml(method)}</methodName>`,
    "<params>",
    ...params.map((param) => `<param><value><string>${escapeXml(param)}</string></value></param>`),
    "</params>",
    "</methodCall>",
  ].join("");
}

function normalizeConsoleUrl(location: string, fallbackHost: string): URL {
  if (/^https?:\/\//i.test(location)) {
    return new URL(location);
  }
  const path = location.startsWith("/") ? location : `/${location}`;
  return new URL(`https://${fallbackHost}${path}`);
}

function readXmlRpcFault(fault: unknown): string {
  const text = JSON.stringify(fault);
  return text.length > 240 ? `${text.slice(0, 240)}...` : text;
}

function readXenApiResultValue(value: unknown): string {
  const struct = value && typeof value === "object" ? (value as Record<string, unknown>).struct : undefined;
  const members = struct && typeof struct === "object" ? (struct as Record<string, unknown>).member : undefined;
  const result = new Map<string, string>();
  for (const member of Array.isArray(members) ? members : members ? [members] : []) {
    if (!member || typeof member !== "object") continue;
    const record = member as Record<string, unknown>;
    const name = readXmlRpcScalar(record.name);
    const memberValue = readXmlRpcScalar(record.value);
    if (name) result.set(name, memberValue);
  }
  if (result.get("Status") && result.get("Status") !== "Success") {
    throw new Error(`XenAPI 返回失败：${result.get("ErrorDescription") || result.get("Status")}`);
  }
  return result.get("Value") ?? "";
}

function readXmlRpcScalar(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["string", "value", "#text"]) {
      const nested = record[key];
      const text = readXmlRpcScalar(nested);
      if (text) return text;
    }
  }
  return "";
}

function toBuffer(message: RawData): Buffer {
  if (Buffer.isBuffer(message)) return message;
  if (message instanceof ArrayBuffer) return Buffer.from(message);
  if (Array.isArray(message)) return Buffer.concat(message);
  return Buffer.from(message);
}

function cleanupTunnel(tunnel: Socket | null): void {
  if (tunnel && !tunnel.destroyed) {
    tunnel.destroy();
  }
}

function closeWithError(socket: WebSocket, message: string): void {
  if (socket.readyState !== socket.OPEN && socket.readyState !== socket.CONNECTING) return;
  socket.close(1011, truncateCloseReason(message));
}

function isUnsupportedTlsProtocol(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return message.includes("unsupported protocol") || message.includes("wrong version number") || message.includes("EPROTO");
}

function truncateCloseReason(message: string): string {
  const buffer = Buffer.from(message);
  if (buffer.length <= MAX_CLOSE_REASON_BYTES) return message;
  return buffer.subarray(0, MAX_CLOSE_REASON_BYTES).toString("utf8");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
