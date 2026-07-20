import { existsSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cleanupRegisteredProxmoxGeneratedIso } from "./proxmox.js";
import { cleanupRegisteredVmwareGeneratedIso } from "./vmware.js";
import { cleanupRegisteredXenGeneratedIso } from "./xenserverUnattendedIso.js";
import { listGeneratedIsos } from "./generatedIsoStore.js";
import type { GeneratedIsoRecord } from "./generatedIsoStore.js";
import { listProvisionTasks } from "./provisionTaskStore.js";
import type { ProviderType, XenConnectionInput } from "./types.js";

const defaultFailedRetentionMs = 7 * 24 * 60 * 60 * 1000;
const recentMutableRetentionMs = 60 * 60 * 1000;
const generatedDir = join(homedir(), ".virtual-resource-console", "generated-isos");

export type GeneratedIsoCleanupDecision = "eligible" | "retained" | "skipped" | "cleaned" | "failed";

export interface GeneratedIsoCleanupEntry {
  id: string;
  taskId: string;
  providerType: ProviderType;
  connectionId?: string;
  hostId?: string;
  vmName: string;
  vmIp?: string;
  isoName: string;
  isoPath: string;
  isoVdiUuid?: string;
  status: GeneratedIsoRecord["status"];
  createdAt: string;
  updatedAt: string;
  cleanupAfter?: string;
  decision: GeneratedIsoCleanupDecision;
  reason: string;
  localBytes: number;
}

export interface GeneratedIsoCleanupReport {
  generatedAt: string;
  retentionDays: number;
  summary: {
    total: number;
    eligible: number;
    retained: number;
    skipped: number;
    cleaned: number;
    failed: number;
    localBytes: number;
  };
  items: GeneratedIsoCleanupEntry[];
}

export interface GeneratedIsoCleanupOptions {
  execute?: boolean;
  includeUnexpiredFailed?: boolean;
  failedRetentionMs?: number;
  resolveConnection?: (record: GeneratedIsoRecord) => Promise<XenConnectionInput | undefined>;
  records?: GeneratedIsoRecord[];
  activeTaskIds?: Set<string>;
}

export async function inspectGeneratedIsoResidues(options: GeneratedIsoCleanupOptions = {}): Promise<GeneratedIsoCleanupReport> {
  return cleanupGeneratedIsoResidues({ ...options, execute: false });
}

export async function cleanupGeneratedIsoResidues(options: GeneratedIsoCleanupOptions = {}): Promise<GeneratedIsoCleanupReport> {
  const now = new Date();
  const records = (options.records ?? listGeneratedIsos()).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const activeTaskIds = options.activeTaskIds ?? resolveActiveTaskIds();
  const retentionMs = options.failedRetentionMs ?? defaultFailedRetentionMs;
  const items: GeneratedIsoCleanupEntry[] = [];
  for (const record of records) {
    const classified = classifyGeneratedIso(record, {
      now,
      activeTaskIds,
      retentionMs,
      includeUnexpiredFailed: options.includeUnexpiredFailed,
    });
    if (!options.execute || classified.decision !== "eligible") {
      items.push(classified);
      continue;
    }
    if (!options.resolveConnection) {
      items.push({ ...classified, decision: "failed", reason: "缺少连接解析器，无法执行远端清理" });
      continue;
    }
    const connection = await options.resolveConnection(record);
    if (!connection) {
      items.push({ ...classified, decision: "skipped", reason: "缺少连接信息，无法自动连接平台执行清理" });
      continue;
    }
    items.push(await cleanupOneGeneratedIso(record, connection, classified));
  }
  return buildGeneratedIsoCleanupReport(now, retentionMs, items);
}

export async function cleanupGeneratedIsoRecord(record: GeneratedIsoRecord, connection: XenConnectionInput): Promise<GeneratedIsoCleanupEntry> {
  return cleanupOneGeneratedIso(record, connection, classifyGeneratedIso(record, {
    now: new Date(),
    activeTaskIds: new Set(),
    retentionMs: 0,
    includeUnexpiredFailed: true,
  }));
}

function classifyGeneratedIso(
  record: GeneratedIsoRecord,
  input: {
    now: Date;
    activeTaskIds: Set<string>;
    retentionMs: number;
    includeUnexpiredFailed?: boolean;
  },
): GeneratedIsoCleanupEntry {
  const localBytes = localGeneratedIsoBytes(record);
  const base = toCleanupEntry(record, localBytes);
  if (record.status === "deleted") {
    return { ...base, decision: "skipped", reason: "登记记录已标记删除" };
  }
  if (input.activeTaskIds.has(record.taskId)) {
    return { ...base, decision: "skipped", reason: "创建任务仍在执行，禁止清理" };
  }
  if (!isSupportedProvider(record.providerType)) {
    return { ...base, decision: "skipped", reason: `当前平台暂不支持残留清理：${record.providerType}` };
  }
  if (!record.isoName.startsWith("vrc-") || !record.isoName.endsWith(".iso")) {
    return { ...base, decision: "skipped", reason: "登记文件不是 VRC 生成 ISO，禁止清理" };
  }
  if (!record.isoVdiUuid && record.providerType !== "proxmox") {
    return { ...base, decision: "skipped", reason: "缺少远端介质标识，无法验证后删除" };
  }
  const cleanupAfter = resolveCleanupAfter(record, input.retentionMs);
  if (record.status === "failed" && !input.includeUnexpiredFailed && cleanupAfter.getTime() > input.now.getTime()) {
    return {
      ...base,
      cleanupAfter: cleanupAfter.toISOString(),
      decision: "retained",
      reason: `失败任务保留到 ${formatDateTime(cleanupAfter)}，用于排查安装问题`,
    };
  }
  if (["creating", "uploaded", "attached"].includes(record.status) && ageMs(record.updatedAt, input.now) < recentMutableRetentionMs) {
    return { ...base, decision: "retained", reason: "近期生成记录仍可能被任务使用，暂不自动清理" };
  }
  if (!record.connectionId) {
    return { ...base, decision: "skipped", reason: "旧记录缺少连接 ID，不能猜测平台连接执行远端删除" };
  }
  return { ...base, cleanupAfter: cleanupAfter.toISOString(), decision: "eligible", reason: "满足 VRC 登记、任务结束、保留期和命名规则，可清理" };
}

async function cleanupOneGeneratedIso(
  record: GeneratedIsoRecord,
  connection: XenConnectionInput,
  classified: GeneratedIsoCleanupEntry,
): Promise<GeneratedIsoCleanupEntry> {
  try {
    if (record.providerType === "vmware") {
      await cleanupRegisteredVmwareGeneratedIso(connection, record.id);
    } else if (record.providerType === "proxmox") {
      await cleanupRegisteredProxmoxGeneratedIso(connection, record.id);
    } else if (record.providerType === "xenserver") {
      await cleanupRegisteredXenGeneratedIso(connection, record.id);
    }
    cleanupLocalGeneratedIso(record);
    return { ...classified, decision: "cleaned", reason: "已按登记记录完成远端和本地临时介质清理" };
  } catch (error) {
    return {
      ...classified,
      decision: "failed",
      reason: error instanceof Error ? error.message : "清理失败",
    };
  }
}

function toCleanupEntry(record: GeneratedIsoRecord, localBytes: number): GeneratedIsoCleanupEntry {
  return {
    id: record.id,
    taskId: record.taskId,
    providerType: record.providerType,
    connectionId: record.connectionId,
    hostId: record.hostId,
    vmName: record.vmName,
    vmIp: record.vmIp,
    isoName: record.isoName,
    isoPath: record.isoPath,
    isoVdiUuid: record.isoVdiUuid,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    cleanupAfter: record.cleanupAfter,
    decision: "skipped",
    reason: "",
    localBytes,
  };
}

function buildGeneratedIsoCleanupReport(now: Date, retentionMs: number, items: GeneratedIsoCleanupEntry[]): GeneratedIsoCleanupReport {
  const summary = {
    total: items.length,
    eligible: items.filter((item) => item.decision === "eligible").length,
    retained: items.filter((item) => item.decision === "retained").length,
    skipped: items.filter((item) => item.decision === "skipped").length,
    cleaned: items.filter((item) => item.decision === "cleaned").length,
    failed: items.filter((item) => item.decision === "failed").length,
    localBytes: items.reduce((sum, item) => sum + item.localBytes, 0),
  };
  return {
    generatedAt: now.toISOString(),
    retentionDays: Math.round(retentionMs / 24 / 60 / 60 / 1000),
    summary,
    items,
  };
}

function resolveActiveTaskIds(): Set<string> {
  return new Set(
    listProvisionTasks(200)
      .filter((task) => task.status === "pending" || task.status === "running")
      .map((task) => task.id),
  );
}

function resolveCleanupAfter(record: GeneratedIsoRecord, retentionMs: number): Date {
  const explicit = record.cleanupAfter ? new Date(record.cleanupAfter) : undefined;
  if (explicit && Number.isFinite(explicit.getTime())) return explicit;
  const base = new Date(record.updatedAt || record.createdAt);
  return new Date((Number.isFinite(base.getTime()) ? base.getTime() : Date.now()) + retentionMs);
}

function ageMs(value: string, now: Date): number {
  const date = new Date(value);
  return now.getTime() - (Number.isFinite(date.getTime()) ? date.getTime() : now.getTime());
}

function isSupportedProvider(providerType: ProviderType): boolean {
  return providerType === "xenserver" || providerType === "vmware" || providerType === "proxmox";
}

function localGeneratedIsoBytes(record: GeneratedIsoRecord): number {
  if (!isSafeGeneratedIsoName(record.isoName)) return 0;
  const localPath = join(generatedDir, record.isoName);
  try {
    return existsSync(localPath) ? statSync(localPath).size : 0;
  } catch {
    return 0;
  }
}

function cleanupLocalGeneratedIso(record: GeneratedIsoRecord): void {
  if (!isSafeGeneratedIsoName(record.isoName)) return;
  rmSync(join(generatedDir, record.isoName), { force: true });
}

function isSafeGeneratedIsoName(value: string): boolean {
  return /^vrc-[A-Za-z0-9_.-]+\.iso$/.test(value);
}

function formatDateTime(value: Date): string {
  return value.toLocaleString("zh-CN", { hour12: false });
}
