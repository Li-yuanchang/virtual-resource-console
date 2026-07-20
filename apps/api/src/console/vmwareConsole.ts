import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import WebSocket, { type RawData } from "ws";
import { resolveConsoleConnection, type ConsoleConnectionInput } from "./connection.js";
import type { XenConnectionInput } from "../types.js";
import { VmwareSoapSession } from "../vmware.js";

const MAX_CLOSE_REASON_BYTES = 110;
const CONSOLE_SESSION_TTL_MS = 60_000;

interface ConsoleQuery {
  connectionId?: string;
  connection?: ConsoleConnectionInput;
  vmId?: string;
}

interface VmwareConsoleSession {
  connection: XenConnectionInput;
  ticket: string;
  expiresAt: number;
}

const consoleSessions = new Map<string, VmwareConsoleSession>();

export async function registerVmwareConsoleRoutes(server: FastifyInstance): Promise<void> {
  server.post("/api/console/vmware/session", async (request, reply) => {
    try {
      const session = await createVmwareConsoleSession(request);
      return {
        sessionId: session.sessionId,
        wsPath: `/api/console/vmware?sessionId=${encodeURIComponent(session.sessionId)}`,
        expiresAt: session.expiresAt,
      };
    } catch (error) {
      server.log.warn({ error }, "failed to prepare vmware console session");
      return reply.status(502).send({
        message: error instanceof Error ? error.message : "VMware 控制台会话准备失败",
      });
    }
  });

  server.get("/api/console/vmware", { websocket: true }, (socket, request) => {
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

    void openPreparedVmwareConsole(request)
      .then((opened) => {
        if (closed) {
          cleanupUpstream(opened);
          return;
        }
        upstream = opened;
        opened.on("open", () => {
          upstreamReady = true;
          for (const message of pendingClientMessages.splice(0)) {
            opened.send(message);
          }
        });
        opened.on("message", (data) => {
          if (socket.readyState === socket.OPEN) {
            socket.send(data, { binary: true });
          }
        });
        opened.on("close", () => {
          if (socket.readyState === socket.OPEN) {
            socket.close(1000, "VMware 控制台连接已关闭");
          }
        });
        opened.on("error", (error) => {
          server.log.warn({ error }, "vmware console websocket failed");
          closeWithError(socket, "VMware 控制台流连接失败");
        });
      })
      .catch((error) => {
        server.log.warn({ error }, "failed to open vmware console");
        closeWithError(socket, error instanceof Error ? error.message : "VMware 控制台打开失败");
      });
  });
}

async function createVmwareConsoleSession(request: FastifyRequest): Promise<{ sessionId: string; expiresAt: string }> {
  const body = request.body as ConsoleQuery | undefined;
  if ((!body?.connectionId && !body?.connection) || !body.vmId) {
    throw new Error("当前控制台会话只处理 VMware。");
  }
  const { connection } = resolveConsoleConnection(body, "vmware");
  const session = await VmwareSoapSession.login(connection);
  try {
    const ticket = await session.acquireWebMksTicket(body.vmId);
    const sessionId = randomUUID();
    const expiresAt = Date.now() + CONSOLE_SESSION_TTL_MS;
    consoleSessions.set(sessionId, {
      connection,
      ticket,
      expiresAt,
    });
    cleanupExpiredSessions();
    return {
      sessionId,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  } finally {
    await session.logout();
  }
}

async function openPreparedVmwareConsole(request: FastifyRequest): Promise<WebSocket> {
  cleanupExpiredSessions();
  const query = request.query as ConsoleQuery & { sessionId?: string };
  if (!query.sessionId) {
    throw new Error("控制台参数不完整：缺少 VMware 控制台会话。");
  }
  const session = consoleSessions.get(query.sessionId);
  if (!session) {
    throw new Error("VMware 控制台会话已过期，请重新打开控制台。");
  }
  consoleSessions.delete(query.sessionId);
  return connectVmwareWebMksWebSocket(session.connection, session.ticket);
}

function connectVmwareWebMksWebSocket(connection: XenConnectionInput, ticket: string): WebSocket {
  const port = connection.port || 443;
  const wsUrl = `wss://${connection.host}:${port}/ticket/${encodeURIComponent(ticket)}`;
  return new WebSocket(wsUrl, ["binary"], {
    rejectUnauthorized: false,
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
