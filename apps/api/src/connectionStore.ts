import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import type { ProviderType, XenConnectionInput } from "./types.js";

const storeDir = join(homedir(), ".virtual-resource-console");
const storeFile = join(storeDir, "connections.json");
const keyFile = join(storeDir, "key.bin");

export interface StoredConnectionSummary {
  id: string;
  name: string;
  providerType: ProviderType;
  host: string;
  port: number;
  username: string;
  readonly: boolean;
  createdAt: string;
  updatedAt: string;
  lastConnectedAt?: string;
}

interface StoredConnectionRecord extends StoredConnectionSummary {
  encryptedPassword: string;
}

interface StoreFile {
  version: 1;
  connections: StoredConnectionRecord[];
}

export interface SaveConnectionInput {
  id?: string;
  name?: string;
  providerType: ProviderType;
  host: string;
  port: number;
  username: string;
  password: string;
}

export function listStoredConnections(): StoredConnectionSummary[] {
  return readStore().connections.map(stripSecret);
}

export function saveStoredConnection(input: SaveConnectionInput): StoredConnectionSummary {
  const store = readStore();
  const now = new Date().toISOString();
  const id = input.id || randomUUID();
  const existingIndex = store.connections.findIndex((item) => item.id === id);
  const record: StoredConnectionRecord = {
    id,
    name: input.name?.trim() || `${input.providerType}:${input.host}`,
    providerType: input.providerType,
    host: input.host,
    port: input.port,
    username: input.username,
    readonly: true,
    createdAt: existingIndex >= 0 ? store.connections[existingIndex].createdAt : now,
    updatedAt: now,
    lastConnectedAt: existingIndex >= 0 ? store.connections[existingIndex].lastConnectedAt : undefined,
    encryptedPassword: encrypt(input.password),
  };

  if (existingIndex >= 0) {
    store.connections[existingIndex] = record;
  } else {
    store.connections.push(record);
  }
  writeStore(store);
  return stripSecret(record);
}

export function deleteStoredConnection(id: string): boolean {
  const store = readStore();
  const before = store.connections.length;
  store.connections = store.connections.filter((item) => item.id !== id);
  writeStore(store);
  return store.connections.length !== before;
}

export function resolveStoredConnection(id: string): XenConnectionInput & { providerType: ProviderType; id: string; name: string } {
  const record = readStore().connections.find((item) => item.id === id);
  if (!record) {
    throw new Error(`未找到保存的连接: ${id}`);
  }
  return {
    id: record.id,
    name: record.name,
    providerType: record.providerType,
    host: record.host,
    port: record.port,
    username: record.username,
    password: decrypt(record.encryptedPassword),
  };
}

export function markConnectionUsed(id: string): void {
  const store = readStore();
  const record = store.connections.find((item) => item.id === id);
  if (!record) return;
  record.lastConnectedAt = new Date().toISOString();
  record.updatedAt = record.lastConnectedAt;
  writeStore(store);
}

function stripSecret(record: StoredConnectionRecord): StoredConnectionSummary {
  const { encryptedPassword: _encryptedPassword, ...summary } = record;
  return summary;
}

function readStore(): StoreFile {
  ensureStoreDir();
  if (!existsSync(storeFile)) {
    return { version: 1, connections: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(storeFile, "utf8")) as StoreFile;
    return {
      version: 1,
      connections: Array.isArray(parsed.connections) ? parsed.connections : [],
    };
  } catch {
    return { version: 1, connections: [] };
  }
}

function writeStore(store: StoreFile): void {
  ensureStoreDir();
  writeFileSync(storeFile, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

function ensureStoreDir(): void {
  mkdirSync(dirname(storeFile), { recursive: true, mode: 0o700 });
}

function getKey(): Buffer {
  ensureStoreDir();
  if (!existsSync(keyFile)) {
    writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
  }
  const key = readFileSync(keyFile);
  if (key.length !== 32) {
    throw new Error("连接密钥文件无效，请检查 ~/.virtual-resource-console/key.bin");
  }
  return key;
}

function encrypt(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${encrypted.toString("base64")}`;
}

function decrypt(value: string): string {
  const [ivText, tagText, encryptedText] = value.split(".");
  if (!ivText || !tagText || !encryptedText) {
    throw new Error("保存的连接密码格式无效");
  }
  const decipher = createDecipheriv("aes-256-gcm", getKey(), Buffer.from(ivText, "base64"));
  decipher.setAuthTag(Buffer.from(tagText, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(encryptedText, "base64")), decipher.final()]).toString("utf8");
}
