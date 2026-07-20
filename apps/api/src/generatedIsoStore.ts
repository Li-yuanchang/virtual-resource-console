import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ProviderType } from "./types.js";

const storeDir = join(homedir(), ".virtual-resource-console");
const storeFile = join(storeDir, "generated-isos.json");
const failedGeneratedIsoRetentionMs = 7 * 24 * 60 * 60 * 1000;

export type GeneratedIsoStatus = "creating" | "uploaded" | "attached" | "installed" | "failed" | "deleted";

export interface GeneratedIsoRecord {
  id: string;
  taskId: string;
  providerType: ProviderType;
  connectionId?: string;
  hostId?: string;
  vmName: string;
  vmIp?: string;
  sourceIsoId: string;
  sourceIsoName: string;
  isoSrUuid: string;
  isoVdiUuid?: string;
  isoName: string;
  isoPath: string;
  status: GeneratedIsoStatus;
  createdAt: string;
  updatedAt: string;
  cleanupAfter?: string;
  deletedAt?: string;
  message?: string;
}

interface GeneratedIsoStoreFile {
  version: 1;
  records: GeneratedIsoRecord[];
}

export interface RegisterGeneratedIsoInput {
  taskId: string;
  providerType: ProviderType;
  connectionId?: string;
  hostId?: string;
  vmName: string;
  vmIp?: string;
  sourceIsoId: string;
  sourceIsoName: string;
  isoSrUuid: string;
  isoName: string;
  isoPath: string;
}

export function registerGeneratedIso(input: RegisterGeneratedIsoInput): GeneratedIsoRecord {
  const now = new Date().toISOString();
  const record: GeneratedIsoRecord = normalizeRecord({
    id: randomUUID(),
    ...input,
    status: "creating",
    createdAt: now,
    updatedAt: now,
  });
  const store = readStore();
  writeStore({ version: 1, records: [record, ...store.records] });
  return record;
}

export function markGeneratedIsoUploaded(id: string, input: { isoVdiUuid: string; message?: string }): GeneratedIsoRecord | undefined {
  return patchGeneratedIso(id, {
    isoVdiUuid: input.isoVdiUuid,
    status: "uploaded",
    message: input.message,
  });
}

export function markGeneratedIsoStatus(id: string, status: GeneratedIsoStatus, message?: string): GeneratedIsoRecord | undefined {
  return patchGeneratedIso(id, { status, message });
}

export function listGeneratedIsos(): GeneratedIsoRecord[] {
  return readStore().records;
}

export function getGeneratedIso(id: string): GeneratedIsoRecord | undefined {
  return readStore().records.find((record) => record.id === id);
}

function patchGeneratedIso(id: string, patch: Partial<GeneratedIsoRecord>): GeneratedIsoRecord | undefined {
  const store = readStore();
  const index = store.records.findIndex((record) => record.id === id);
  if (index < 0) return undefined;
  const previous = store.records[index];
  const cleanupAfter =
    patch.cleanupAfter ??
    (patch.status === "failed" && !previous.cleanupAfter
      ? new Date(Date.now() + failedGeneratedIsoRetentionMs).toISOString()
      : previous.cleanupAfter);
  const record = normalizeRecord({
    ...previous,
    ...patch,
    cleanupAfter,
    updatedAt: new Date().toISOString(),
    deletedAt: patch.status === "deleted" ? new Date().toISOString() : previous.deletedAt,
  });
  store.records[index] = record;
  writeStore(store);
  return record;
}

function normalizeRecord(record: GeneratedIsoRecord): GeneratedIsoRecord {
  return {
    id: record.id || randomUUID(),
    taskId: record.taskId?.trim() || "",
    providerType: record.providerType,
    connectionId: record.connectionId?.trim() || undefined,
    hostId: record.hostId?.trim() || undefined,
    vmName: record.vmName?.trim() || "",
    vmIp: record.vmIp?.trim() || undefined,
    sourceIsoId: record.sourceIsoId?.trim() || "",
    sourceIsoName: record.sourceIsoName?.trim() || "",
    isoSrUuid: record.isoSrUuid?.trim() || "",
    isoVdiUuid: record.isoVdiUuid?.trim() || undefined,
    isoName: record.isoName?.trim() || "",
    isoPath: record.isoPath?.trim() || "",
    status: record.status || "creating",
    createdAt: record.createdAt || new Date().toISOString(),
    updatedAt: record.updatedAt || record.createdAt || new Date().toISOString(),
    cleanupAfter: record.cleanupAfter,
    deletedAt: record.deletedAt,
    message: record.message?.trim() || undefined,
  };
}

function readStore(): GeneratedIsoStoreFile {
  ensureStoreDir();
  if (!existsSync(storeFile)) {
    return { version: 1, records: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(storeFile, "utf8")) as GeneratedIsoStoreFile;
    return {
      version: 1,
      records: Array.isArray(parsed.records) ? parsed.records.map(normalizeRecord) : [],
    };
  } catch {
    return { version: 1, records: [] };
  }
}

function writeStore(store: GeneratedIsoStoreFile): void {
  ensureStoreDir();
  writeFileSync(storeFile, `${JSON.stringify({ version: 1, records: store.records.map(normalizeRecord) }, null, 2)}\n`, { mode: 0o600 });
}

function ensureStoreDir(): void {
  mkdirSync(dirname(storeFile), { recursive: true, mode: 0o700 });
}
