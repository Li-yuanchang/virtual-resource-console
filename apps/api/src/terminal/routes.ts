import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { Client, type ClientChannel, type ConnectConfig } from "ssh2";
import type { RawData, WebSocket } from "ws";
import { resolveEphemeralConnection } from "../ephemeralConnectionStore.js";
import type { InventoryCache } from "../inventoryCache.js";
import { resolveStoredConnection } from "../connectionStore.js";
import type { ProviderRegistry } from "../providers/provider.js";
import { vmSystemCredentialStore } from "../vmSystemCredentialStore.js";
import { selectTerminalStrategy } from "./strategy.js";
import type { TerminalSessionRequest, TerminalSessionResponse, TerminalRuntime } from "./contracts.js";
import type { ProviderType, VmNode, VmSystemCredentials, XenConnectionInput } from "../types.js";

interface TerminalSessionCredentialInput {
  username: string;
  password: string;
}

interface TerminalRequestBody extends Omit<TerminalSessionRequest, "hasSystemCredential" | "hasSerialDevice" | "runtime" | "guestIp"> {
  runtime?: TerminalRuntime;
  hostId?: string;
  guestPort?: number;
  credentials?: TerminalSessionCredentialInput;
}

interface PendingTerminalSession {
  request: Omit<TerminalRequestBody, "credentials">;
  credentials: VmSystemCredentials;
  guestIp: string;
  expiresAt: number;
}

interface TerminalQuery {
  sessionId?: string;
}

const TERMINAL_SESSION_TTL_MS = 60_000;
const terminalSessions = new Map<string, PendingTerminalSession>();

interface TerminalRouteDependencies {
  providers: ProviderRegistry;
  inventoryCache: InventoryCache;
}

/**
 * 注册统一终端会话入口。图形控制台继续由各 Provider 的 noVNC 路由处理；本路由只处理 SSH PTY 双向文本流。
 */
export async function registerTerminalRoutes(server: FastifyInstance, dependencies: TerminalRouteDependencies): Promise<void> {
  server.post("/api/terminal/session", async (request, reply) => {
    try {
      const body = normalizeRequest(request.body as Partial<TerminalRequestBody>);
      const resolved = await resolveTerminalTarget(body, dependencies);
      const credentials: VmSystemCredentials | undefined = body.credentials ?? vmSystemCredentialStore.get(body.connectionId, body.vmId);
      if (credentials?.jump) {
        return reply.code(409).send({
          message: "Linux CLI 暂未接入跳板机 SSH，请先使用可直连的系统账号。",
          code: "NO_TRANSPORT_AVAILABLE",
          retryable: false,
        });
      }
      const decision = selectTerminalStrategy({
        ...body,
        powerState: resolved.vm.powerState,
        guestOs: resolved.vm.guestOs ?? body.guestOs,
        guestIp: resolved.guestIp,
        runtime: body.runtime ?? "web",
        hasSystemCredential: Boolean(credentials),
        hasSerialDevice: false,
      });
      if (decision.failure || !decision.session) {
        return reply.code(409).send({
          message: decision.failure?.message || "当前没有可用的 Linux CLI 通道。",
          code: decision.failure?.code || "NO_TRANSPORT_AVAILABLE",
          retryable: decision.failure?.retryable ?? true,
          capabilities: decision.capabilities.capabilities,
        });
      }
      if (!credentials) throw new Error("终端登录凭据未就绪。");
      const sessionId = randomUUID();
      const expiresAt = Date.now() + TERMINAL_SESSION_TTL_MS;
      const { credentials: _credentials, ...sessionRequest } = body;
      terminalSessions.set(sessionId, { request: sessionRequest, credentials, guestIp: resolved.guestIp, expiresAt });
      cleanupSessions();
      const response: TerminalSessionResponse = {
        sessionId,
        connectionId: body.connectionId,
        vmId: body.vmId,
        runtime: body.runtime ?? "web",
        mode: decision.session.mode,
        transport: decision.session.transport,
        state: "created",
        expiresAt: new Date(expiresAt).toISOString(),
        websocketPath: `/api/terminal?sessionId=${encodeURIComponent(sessionId)}`,
      };
      return response;
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : "终端会话参数无效。" });
    }
  });

  server.get("/api/terminal", { websocket: true }, (socket, request) => {
    const sessionId = (request.query as TerminalQuery).sessionId;
    const pending = consumeSession(sessionId);
    if (!pending) {
      closeWithError(socket, "终端会话已失效，请重新打开 Linux CLI。", 4401);
      return;
    }

    const credentials = pending.credentials;

    const client = new Client();
    let shell: ClientChannel | null = null;
    let closed = false;
    const closeAll = () => {
      if (closed) return;
      closed = true;
      shell?.close();
      client.end();
    };

    socket.on("message", (message) => {
      const parsed = parseClientMessage(message);
      if (!parsed || closed) return;
      if (parsed.type === "input") shell?.write(parsed.data);
      if (parsed.type === "resize") shell?.setWindow(parsed.rows, parsed.cols, 0, 0);
    });
    socket.on("close", closeAll);
    socket.on("error", closeAll);

    // Some Linux images disable the SSH password method and expose the same
    // username/password flow through keyboard-interactive authentication.
    client.on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => {
      finish(prompts.map((prompt) => (prompt.echo ? credentials.username : credentials.password)));
    });

    client.on("ready", () => {
      client.shell({ term: "xterm-256color", cols: 80, rows: 24 }, (error, channel) => {
        if (error) {
          closeWithError(socket, "SSH 终端启动失败。", 1011);
          closeAll();
          return;
        }
        shell = channel;
        sendJson(socket, { type: "connected" });
        channel.on("data", (chunk: Buffer) => sendJson(socket, { type: "output", data: chunk.toString("utf8") }));
        channel.on("close", () => {
          sendJson(socket, { type: "exit", code: 0 });
          closeAll();
        });
      });
    });
    client.on("error", (error) => {
      const diagnostic = error as Error & { code?: string; level?: string; description?: string };
      server.log.warn(
        {
          vmId: pending.request.vmId,
          connectionId: pending.request.connectionId,
          guestIp: pending.guestIp,
          guestPort: configPort(pending.request.guestPort),
          username: credentials.username,
          errorCode: diagnostic.code,
          errorLevel: diagnostic.level,
          errorDescription: diagnostic.description,
          errorMessage: diagnostic.message,
        },
        "terminal ssh session failed",
      );
      closeWithError(socket, isAuthenticationFailure(diagnostic) ? "Login incorrect" : "SSH 连接失败，请检查虚拟机网络。", isAuthenticationFailure(diagnostic) ? 4403 : 1011);
      closeAll();
    });

    const port = configPort(pending.request.guestPort);
    const config: ConnectConfig = {
      host: pending.guestIp,
      port,
      username: credentials.username,
      password: credentials.password,
      tryKeyboard: true,
      keepaliveInterval: 15_000,
      keepaliveCountMax: 3,
      readyTimeout: 15_000,
    };
    client.connect(config);
  });
}

function normalizeRequest(input: Partial<TerminalRequestBody>): TerminalRequestBody {
  const providerType = input.providerType;
  if (!input.connectionId || !input.vmId || !providerType) throw new Error("终端参数不完整：缺少连接、VM 或平台。");
  const guestPort = normalizeGuestPort(input.guestPort);
  const credentials = normalizeSessionCredentials(input.credentials);
  return {
    connectionId: input.connectionId,
    vmId: input.vmId,
    providerType,
    mode: input.mode ?? "linux-cli",
    powerState: input.powerState ?? "unknown",
    guestOs: input.guestOs,
    runtime: input.runtime ?? "web",
    hostId: input.hostId,
    guestPort,
    ...(credentials ? { credentials } : {}),
  };
}

function normalizeSessionCredentials(value: unknown): TerminalSessionCredentialInput | undefined {
  if (value == null) return undefined;
  if (typeof value !== "object") throw new Error("终端登录凭据格式无效。");
  const input = value as Partial<TerminalSessionCredentialInput>;
  const username = typeof input.username === "string" ? input.username.trim() : "";
  const password = typeof input.password === "string" ? input.password : "";
  if (!username || username.length > 256) throw new Error("终端登录用户名无效。");
  if (!password || password.length > 1024) throw new Error("终端登录密码无效。");
  return { username, password };
}

function normalizeGuestPort(value: unknown): number | undefined {
  if (value == null) return undefined;
  const port = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("终端 SSH 端口无效。");
  return port;
}

async function resolveTerminalTarget(input: TerminalRequestBody, dependencies: TerminalRouteDependencies): Promise<{ vm: VmNode; guestIp: string }> {
  const stored = resolveEphemeralConnection(input.connectionId) ?? resolveStoredConnection(input.connectionId);
  if (stored.providerType !== input.providerType) throw new Error("终端平台与保存连接的平台不一致，请刷新后重试。");
  const connection: XenConnectionInput = {
    host: stored.host,
    port: stored.port,
    username: stored.username,
    password: stored.password,
  };
  const scope = {
    providerType: stored.providerType,
    connectionId: input.connectionId,
    host: connection.host,
    port: connection.port,
    username: connection.username,
    hostId: input.hostId,
  };
  const cachedVm = dependencies.inventoryCache.findVm(scope, input.vmId);
  const vm = cachedVm ?? await loadVmFromProvider(input, connection, dependencies.providers);
  const guestIp = vm.ipAddresses.find(isIpv4) ?? "";
  if (!guestIp) return { vm, guestIp: "" };
  return { vm, guestIp };
}

async function loadVmFromProvider(input: TerminalRequestBody, connection: XenConnectionInput, providers: ProviderRegistry): Promise<VmNode> {
  const provider = providers.get(input.providerType);
  const firstPage = await provider.listVms(connection, { hostId: input.hostId, page: 1, pageSize: 500 });
  const matched = firstPage.items.find((vm) => matchesVm(vm, input.vmId));
  if (matched) return matched;
  const pageCount = Math.ceil(firstPage.total / firstPage.pageSize);
  for (let page = 2; page <= pageCount; page += 1) {
    const nextPage = await provider.listVms(connection, { hostId: input.hostId, page, pageSize: firstPage.pageSize });
    const nextMatched = nextPage.items.find((vm) => matchesVm(vm, input.vmId));
    if (nextMatched) return nextMatched;
  }
  throw new Error("未在当前平台清单中找到目标虚拟机，请刷新列表后重试。");
}

function matchesVm(vm: VmNode, vmId: string): boolean {
  return vm.id === vmId || vm.providerId === vmId || vm.consoleRef === vmId;
}

function isIpv4(value: string | undefined): value is string {
  if (!value) return false;
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

function cleanupSessions() {
  const now = Date.now();
  for (const [sessionId, session] of terminalSessions) if (session.expiresAt <= now) terminalSessions.delete(sessionId);
}

function consumeSession(sessionId: string | undefined) {
  cleanupSessions();
  if (!sessionId) return null;
  const session = terminalSessions.get(sessionId);
  if (!session) return null;
  terminalSessions.delete(sessionId);
  return session;
}

function parseClientMessage(message: RawData): { type: "input"; data: string } | { type: "resize"; cols: number; rows: number } | null {
  try {
    const value = JSON.parse(message.toString()) as Record<string, unknown>;
    if (value.type === "input" && typeof value.data === "string" && value.data.length <= 16_384) return { type: "input", data: value.data };
    if (value.type === "resize" && isTerminalSize(value.cols) && isTerminalSize(value.rows)) return { type: "resize", cols: value.cols, rows: value.rows };
  } catch {
    return null;
  }
  return null;
}

function isTerminalSize(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= 1000;
}

function isAuthenticationFailure(error: Error & { level?: string }): boolean {
  return error.level === "client-authentication" || /authentication methods failed/i.test(error.message);
}

function configPort(value: number | undefined): number {
  return value ?? 22;
}

function sendJson(socket: WebSocket, value: unknown) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(value));
}

function closeWithError(socket: WebSocket, message: string, code: number) {
  if (socket.readyState === socket.OPEN) socket.close(code, message);
}
