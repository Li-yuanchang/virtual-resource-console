import { randomUUID } from "node:crypto";
import { resolveStoredConnection } from "../connectionStore.js";
import type { ProviderType, XenConnectionInput } from "../types.js";

export interface ConsoleConnectionInput {
  providerType?: ProviderType;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
}

export interface ConsoleConnectionPayload {
  connectionId?: string;
  connection?: ConsoleConnectionInput;
}

export interface ResolvedConsoleConnection {
  connectionId?: string;
  providerType: ProviderType;
  connection: XenConnectionInput;
}

interface ConsoleLaunchSession<T> {
  value: T;
  expiresAt: number;
}

const launchSessionTtlMs = 60_000;

export function createConsoleLaunchSession<T>(store: Map<string, ConsoleLaunchSession<T>>, value: T): { sessionId: string; expiresAt: string } {
  cleanupConsoleLaunchSessions(store);
  const sessionId = randomUUID();
  const expiresAt = Date.now() + launchSessionTtlMs;
  store.set(sessionId, { value, expiresAt });
  return { sessionId, expiresAt: new Date(expiresAt).toISOString() };
}

export function consumeConsoleLaunchSession<T>(store: Map<string, ConsoleLaunchSession<T>>, sessionId: string | undefined): T | null {
  cleanupConsoleLaunchSessions(store);
  if (!sessionId) return null;
  const session = store.get(sessionId);
  if (!session) return null;
  store.delete(sessionId);
  return session.value;
}

export function cleanupConsoleLaunchSessions<T>(store: Map<string, ConsoleLaunchSession<T>>): void {
  const now = Date.now();
  for (const [sessionId, session] of store) {
    if (session.expiresAt <= now) store.delete(sessionId);
  }
}

export function resolveConsoleConnection(payload: ConsoleConnectionPayload, expectedProviderType: ProviderType): ResolvedConsoleConnection {
  if (payload.connection) {
    const connection = payload.connection;
    const providerType = connection.providerType ?? expectedProviderType;
    if (providerType !== expectedProviderType) {
      throw new Error(`当前控制台只处理 ${providerLabel(expectedProviderType)}。`);
    }
    if (!connection.host || !connection.username || !connection.password) {
      throw new Error("控制台连接参数不完整：缺少 Host、账号或密码。");
    }
    return {
      providerType,
      connection: {
        host: connection.host,
        port: connection.port ?? defaultProviderPort(providerType),
        username: connection.username,
        password: connection.password,
      },
    };
  }
  if (!payload.connectionId) {
    throw new Error("控制台参数不完整：缺少连接。");
  }
  const stored = resolveStoredConnection(payload.connectionId);
  if (stored.providerType !== expectedProviderType) {
    throw new Error(`当前控制台只处理 ${providerLabel(expectedProviderType)}。`);
  }
  return {
    connectionId: payload.connectionId,
    providerType: stored.providerType,
    connection: {
      host: stored.host,
      port: stored.port,
      username: stored.username,
      password: stored.password,
    },
  };
}

function defaultProviderPort(providerType: ProviderType): number {
  if (providerType === "proxmox") return 8006;
  if (providerType === "vmware") return 443;
  return 22;
}

function providerLabel(providerType: ProviderType): string {
  if (providerType === "proxmox") return "Proxmox VE";
  if (providerType === "vmware") return "VMware";
  if (providerType === "xenserver") return "XenServer";
  return providerType;
}
