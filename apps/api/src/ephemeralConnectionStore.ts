import { randomUUID } from "node:crypto";
import type { StoredConnectionSummary } from "./connectionStore.js";
import type { ProviderType, XenConnectionInput } from "./types.js";

export interface EphemeralConnectionInput {
  name?: string;
  providerType: ProviderType;
  host: string;
  port: number;
  username: string;
  password: string;
  ttlMinutes?: number;
}

export interface EphemeralConnectionSummary extends StoredConnectionSummary {
  expiresAt: string;
  source: "chrome-extension";
}

interface EphemeralConnectionRecord extends EphemeralConnectionSummary {
  password: string;
}

const DEFAULT_TTL_MINUTES = 30;
const MAX_TTL_MINUTES = 240;
const ephemeralConnections = new Map<string, EphemeralConnectionRecord>();

export function createEphemeralConnection(input: EphemeralConnectionInput): EphemeralConnectionSummary {
  cleanupExpiredEphemeralConnections();
  const now = new Date();
  const ttlMinutes = Math.min(Math.max(input.ttlMinutes || DEFAULT_TTL_MINUTES, 1), MAX_TTL_MINUTES);
  const expiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000).toISOString();
  const record: EphemeralConnectionRecord = {
    id: `eph_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
    name: input.name?.trim() || `${input.providerType}:${input.host}`,
    providerType: input.providerType,
    host: input.host,
    port: input.port,
    username: input.username,
    password: input.password,
    readonly: true,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt,
    source: "chrome-extension",
  };
  ephemeralConnections.set(record.id, record);
  return stripSecret(record);
}

export function listEphemeralConnections(): EphemeralConnectionSummary[] {
  cleanupExpiredEphemeralConnections();
  return Array.from(ephemeralConnections.values()).map(stripSecret);
}

export function deleteEphemeralConnection(id: string): boolean {
  cleanupExpiredEphemeralConnections();
  return ephemeralConnections.delete(id);
}

export function resolveEphemeralConnection(id: string): (XenConnectionInput & { providerType: ProviderType; id: string; name: string }) | null {
  cleanupExpiredEphemeralConnections();
  const record = ephemeralConnections.get(id);
  if (!record) return null;
  return {
    id: record.id,
    name: record.name,
    providerType: record.providerType,
    host: record.host,
    port: record.port,
    username: record.username,
    password: record.password,
  };
}

export function markEphemeralConnectionUsed(id: string): boolean {
  cleanupExpiredEphemeralConnections();
  const record = ephemeralConnections.get(id);
  if (!record) return false;
  const now = new Date().toISOString();
  record.lastConnectedAt = now;
  record.updatedAt = now;
  return true;
}

function cleanupExpiredEphemeralConnections() {
  const now = Date.now();
  for (const [id, record] of ephemeralConnections.entries()) {
    if (Date.parse(record.expiresAt) <= now) {
      ephemeralConnections.delete(id);
    }
  }
}

function stripSecret(record: EphemeralConnectionRecord): EphemeralConnectionSummary {
  const { password: _password, ...summary } = record;
  return summary;
}
