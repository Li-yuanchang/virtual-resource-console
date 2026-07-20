import type { FastifyInstance, FastifyRequest } from "fastify";
import { request as httpsRequest } from "node:https";
import { randomUUID } from "node:crypto";
import WebSocket, { type RawData } from "ws";
import { resolveConsoleConnection, type ConsoleConnectionInput } from "./connection.js";
import type { XenConnectionInput } from "../types.js";

const PROXMOX_TIMEOUT_MS = 18_000;
const MAX_CLOSE_REASON_BYTES = 110;
const CONSOLE_SESSION_TTL_MS = 60_000;

interface ConsoleQuery {
  connectionId?: string;
  connection?: ConsoleConnectionInput;
  vmId?: string;
}

interface ProxmoxLogin {
  ticket: string;
  csrf: string;
}

interface ProxmoxResponse<T> {
  data: T;
  errors?: unknown;
}

interface ProxmoxVncProxy {
  port: string | number;
  ticket: string;
  cert?: string;
  user?: string;
  upid?: string;
}

interface ProxmoxConsoleSession {
  connection: XenConnectionInput;
  login: ProxmoxLogin;
  node: string;
  vmid: string;
  port: string;
  ticket: string;
  expiresAt: number;
}

const consoleSessions = new Map<string, ProxmoxConsoleSession>();

export async function registerProxmoxConsoleRoutes(server: FastifyInstance): Promise<void> {
  server.post("/api/console/proxmox/session", async (request, reply) => {
    try {
      const session = await createProxmoxConsoleSession(request);
      return {
        sessionId: session.sessionId,
        wsPath: `/api/console/proxmox?sessionId=${encodeURIComponent(session.sessionId)}`,
        password: session.password,
        expiresAt: session.expiresAt,
      };
    } catch (error) {
      server.log.warn({ error }, "failed to prepare proxmox console session");
      return reply.status(502).send({
        message: error instanceof Error ? error.message : "Proxmox VE 控制台会话准备失败",
      });
    }
  });

  server.get("/api/console/proxmox", { websocket: true }, (socket, request) => {
    const pendingClientMessages: Buffer[] = [];
    let upstream: WebSocket | null = null;
    let upstreamReady = false;
    let closed = false;

    socket.on("message", (message) => {
      const data = toBuffer(message);
      if (!data.length) return;
      if (upstreamReady && upstream?.readyState === WebSocket.OPEN) {
        upstream.send(data);
      } else {
        pendingClientMessages.push(data);
      }
    });

    socket.on("close", () => {
      closed = true;
      cleanupUpstream(upstream);
    });

    socket.on("error", () => {
      closed = true;
      cleanupUpstream(upstream);
    });

    void openProxmoxConsole(request)
      .then((opened) => {
        if (closed) {
          cleanupUpstream(opened);
          return;
        }
        upstream = opened;
        upstream.on("open", () => {
          upstreamReady = true;
          for (const message of pendingClientMessages.splice(0)) {
            upstream?.send(message);
          }
        });
        upstream.on("message", (data) => {
          if (socket.readyState === socket.OPEN) {
            socket.send(data, { binary: true });
          }
        });
        upstream.on("close", () => {
          if (socket.readyState === socket.OPEN) {
            socket.close(1000, "Proxmox VE 控制台连接已关闭");
          }
        });
        upstream.on("error", (error) => {
          server.log.warn({ error }, "proxmox console websocket failed");
          closeWithError(socket, "Proxmox VE 控制台流连接失败");
        });
      })
      .catch((error) => {
        server.log.warn({ error }, "failed to open proxmox console");
        closeWithError(socket, error instanceof Error ? error.message : "Proxmox VE 控制台打开失败");
      });
  });
}

async function openProxmoxConsole(request: FastifyRequest): Promise<WebSocket> {
  const query = request.query as ConsoleQuery;
  if ("sessionId" in query && typeof query.sessionId === "string") {
    return openPreparedProxmoxConsole(query.sessionId);
  }
  if ((!query.connectionId && !query.connection) || !query.vmId) {
    throw new Error("控制台参数不完整：缺少连接或 VM。");
  }
  const [node, vmid] = parseProxmoxVmId(query.vmId);
  if (!node || !vmid) {
    throw new Error("Proxmox VE VM 标识无效。");
  }

  const resolved = resolveConsoleConnection(query, "proxmox");
  const connection: XenConnectionInput = {
    ...resolved.connection,
    username: normalizeUsername(resolved.connection.username),
  };
  const login = await loginProxmox(connection);
  const proxy = await createProxmoxVncProxy(connection, login, node, vmid);
  return connectProxmoxVncWebSocket(connection, login, node, vmid, String(proxy.port), proxy.ticket);
}

async function createProxmoxConsoleSession(request: FastifyRequest): Promise<{ sessionId: string; password: string; expiresAt: string }> {
  const body = request.body as ConsoleQuery | undefined;
  if (!body?.connectionId || !body.vmId) {
    if (!body?.connection || !body.vmId) throw new Error("控制台参数不完整：缺少连接或 VM。");
  }
  const [node, vmid] = parseProxmoxVmId(body.vmId);
  if (!node || !vmid) {
    throw new Error("Proxmox VE VM 标识无效。");
  }
  const resolved = resolveConsoleConnection(body, "proxmox");
  const connection: XenConnectionInput = {
    ...resolved.connection,
    username: normalizeUsername(resolved.connection.username),
  };
  const login = await loginProxmox(connection);
  const proxy = await createProxmoxVncProxy(connection, login, node, vmid);
  if (!proxy.ticket || !proxy.port) {
    throw new Error("Proxmox VE 未返回 VNC 控制台 ticket。");
  }
  const sessionId = randomUUID();
  const expiresAt = Date.now() + CONSOLE_SESSION_TTL_MS;
  consoleSessions.set(sessionId, {
    connection,
    login,
    node,
    vmid,
    port: String(proxy.port),
    ticket: proxy.ticket,
    expiresAt,
  });
  cleanupExpiredSessions();
  return {
    sessionId,
    password: proxy.ticket,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

function openPreparedProxmoxConsole(sessionId: string): WebSocket {
  cleanupExpiredSessions();
  const session = consoleSessions.get(sessionId);
  if (!session) {
    throw new Error("Proxmox VE 控制台会话已过期，请重新打开控制台。");
  }
  consoleSessions.delete(sessionId);
  return connectProxmoxVncWebSocket(session.connection, session.login, session.node, session.vmid, session.port, session.ticket);
}

function createProxmoxVncProxy(
  connection: XenConnectionInput,
  login: ProxmoxLogin,
  node: string,
  vmid: string,
): Promise<ProxmoxVncProxy> {
  return proxmoxRequest<ProxmoxVncProxy>(
    connection,
    "POST",
    `/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(vmid)}/vncproxy`,
    "",
    login,
  );
}

function connectProxmoxVncWebSocket(
  connection: XenConnectionInput,
  login: ProxmoxLogin,
  node: string,
  vmid: string,
  vncPort: string,
  ticket: string,
): WebSocket {
  const port = connection.port || 8006;
  const params = new URLSearchParams({
    port: vncPort,
    vncticket: ticket,
  });
  const wsUrl = `wss://${connection.host}:${port}/api2/json/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(vmid)}/vncwebsocket?${params.toString()}`;
  return new WebSocket(wsUrl, {
    rejectUnauthorized: false,
    headers: {
      Cookie: `PVEAuthCookie=${login.ticket}`,
    },
  });
}

function cleanupExpiredSessions(): void {
  const now = Date.now();
  for (const [sessionId, session] of consoleSessions) {
    if (session.expiresAt <= now) {
      consoleSessions.delete(sessionId);
    }
  }
}

async function loginProxmox(input: XenConnectionInput): Promise<ProxmoxLogin> {
  const body = new URLSearchParams({
    username: normalizeUsername(input.username),
    password: input.password,
  }).toString();
  const response = await proxmoxRequest<{ ticket: string; CSRFPreventionToken?: string }>(input, "POST", "/access/ticket", body, undefined);
  return {
    ticket: response.ticket,
    csrf: response.CSRFPreventionToken ?? "",
  };
}

function proxmoxRequest<T>(
  input: XenConnectionInput,
  method: "GET" | "POST",
  path: string,
  body: string | undefined,
  login: ProxmoxLogin | undefined,
): Promise<T> {
  const port = input.port || 8006;
  const requestPath = `/api2/json${path}`;
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: input.host,
        port,
        path: requestPath,
        method,
        rejectUnauthorized: false,
        timeout: PROXMOX_TIMEOUT_MS,
        headers: {
          ...(body !== undefined
            ? {
                "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
                "Content-Length": Buffer.byteLength(body),
              }
            : {}),
          ...(login
            ? {
                Cookie: `PVEAuthCookie=${login.ticket}`,
                ...(login.csrf ? { CSRFPreventionToken: login.csrf } : {}),
              }
            : {}),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => {
          try {
            const parsed = text ? (JSON.parse(text) as ProxmoxResponse<T>) : ({ data: undefined } as ProxmoxResponse<T>);
            if ((res.statusCode ?? 500) >= 400) {
              reject(new Error(`Proxmox VE API HTTP ${res.statusCode}: ${JSON.stringify(parsed.errors ?? parsed.data ?? {})}`));
              return;
            }
            resolve(parsed.data);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("连接 Proxmox VE API 超时，请确认 8006 端口和网络连通。"));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function normalizeUsername(username: string): string {
  return username.includes("@") ? username : `${username}@pam`;
}

function parseProxmoxVmId(providerId: string): [string, string] {
  const parts = providerId.split(":");
  if (parts.length < 2) return ["", ""];
  return [parts[0], parts[1]];
}

function toBuffer(message: RawData): Buffer {
  if (Buffer.isBuffer(message)) return message;
  if (message instanceof ArrayBuffer) return Buffer.from(message);
  if (Array.isArray(message)) return Buffer.concat(message);
  return Buffer.from(message);
}

function cleanupUpstream(upstream: WebSocket | null): void {
  if (upstream && upstream.readyState !== WebSocket.CLOSED) {
    upstream.close();
  }
}

function closeWithError(socket: WebSocket, message: string): void {
  if (socket.readyState !== socket.OPEN && socket.readyState !== socket.CONNECTING) return;
  socket.close(1011, truncateCloseReason(message));
}

function truncateCloseReason(message: string): string {
  const buffer = Buffer.from(message);
  if (buffer.length <= MAX_CLOSE_REASON_BYTES) return message;
  return buffer.subarray(0, MAX_CLOSE_REASON_BYTES).toString("utf8");
}
