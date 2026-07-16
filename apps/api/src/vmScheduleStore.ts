import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  ProviderType,
  VmSchedule,
  VmScheduleAction,
  VmScheduleConflictPolicy,
  VmScheduleCycle,
  VmScheduleFallback,
  VmScheduleLastRun,
  VmScheduleTarget,
} from "./types.js";

const storeDir = join(homedir(), ".virtual-resource-console");
const storeFile = join(storeDir, "vm-schedules.json");
const writeLockFile = join(storeDir, "vm-schedules.write.lock");
const writeLockTimeoutMs = 2_000;
const staleWriteLockMs = 10_000;

interface VmScheduleStoreFile {
  version: 1;
  tasks: VmSchedule[];
}

export interface UpsertVmScheduleInput {
  name: string;
  connectionId: string;
  providerType: ProviderType;
  connectionName?: string;
  hostId?: string;
  hostName?: string;
  action: VmScheduleAction;
  cycle: VmScheduleCycle;
  onceAt?: string;
  executeTime?: string;
  weekdays?: number[];
  timezone: string;
  skipMatchingState: boolean;
  shutdownTimeoutMinutes: number;
  shutdownFallback: VmScheduleFallback;
  conflictPolicy: VmScheduleConflictPolicy;
  targets: VmScheduleTarget[];
  enabled?: boolean;
}

export class VmScheduleConflictError extends Error {
  constructor(readonly conflicts: VmSchedule[]) {
    super(`发现 ${conflicts.length} 个时间和目标虚拟机重叠的定时任务。`);
    this.name = "VmScheduleConflictError";
  }
}

export function listVmSchedules(connectionId?: string): VmSchedule[] {
  return readStore()
    .tasks
    .filter((task) => !connectionId || task.targets.some((target) => targetConnectionId(task, target) === connectionId))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function getVmSchedule(taskId: string): VmSchedule | undefined {
  return readStore().tasks.find((task) => task.id === taskId);
}

export function createVmSchedule(input: UpsertVmScheduleInput): VmSchedule {
  return withStoreLock(() => {
    const store = readStore();
    const now = new Date();
    const normalizedInput = normalizeInput(input);
    const conflicts = findConflicts(store.tasks, normalizedInput);
    const targets = resolveConflictTargets(store, conflicts, normalizedInput);
    const timestamp = now.toISOString();
    const task: VmSchedule = {
      id: randomUUID(),
      ...normalizedInput,
      targets,
      enabled: normalizedInput.enabled ?? true,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    task.nextRunAt = task.enabled ? calculateNextRunAt(task, now) : undefined;
    if (task.enabled && !task.nextRunAt) {
      throw new Error("单次任务的执行时间必须晚于当前时间。");
    }
    store.tasks.unshift(task);
    writeStore(store);
    return task;
  });
}

export function updateVmSchedule(taskId: string, input: UpsertVmScheduleInput): VmSchedule | undefined {
  return withStoreLock(() => {
    const store = readStore();
    const index = store.tasks.findIndex((task) => task.id === taskId);
    if (index < 0) return undefined;
    const existing = store.tasks[index];
    const normalizedInput = normalizeInput(input);
    const conflicts = findConflicts(store.tasks, normalizedInput, taskId);
    const targets = resolveConflictTargets(store, conflicts, normalizedInput);
    const task: VmSchedule = {
      ...existing,
      ...normalizedInput,
      id: existing.id,
      targets,
      enabled: normalizedInput.enabled ?? existing.enabled,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
      lastRun: existing.lastRun,
    };
    task.nextRunAt = task.enabled ? calculateNextRunAt(task, new Date()) : undefined;
    if (task.enabled && !task.nextRunAt) {
      throw new Error("单次任务的执行时间必须晚于当前时间。");
    }
    store.tasks[index] = task;
    writeStore(store);
    return task;
  });
}

export function setVmScheduleEnabled(taskId: string, enabled: boolean): VmSchedule | undefined {
  return withStoreLock(() => {
    const store = readStore();
    const task = store.tasks.find((item) => item.id === taskId);
    if (!task) return undefined;
    task.enabled = enabled;
    task.updatedAt = new Date().toISOString();
    task.nextRunAt = enabled ? calculateNextRunAt(task, new Date()) : undefined;
    if (enabled && !task.nextRunAt) {
      throw new Error("单次任务的执行时间已过，不能重新启用。");
    }
    writeStore(store);
    return task;
  });
}

export function deleteVmSchedule(taskId: string): boolean {
  return withStoreLock(() => {
    const store = readStore();
    const before = store.tasks.length;
    store.tasks = store.tasks.filter((task) => task.id !== taskId);
    if (store.tasks.length === before) return false;
    writeStore(store);
    return true;
  });
}

export function listDueVmSchedules(now = new Date()): VmSchedule[] {
  const nowMs = now.getTime();
  return readStore().tasks.filter((task) => task.enabled && task.nextRunAt && new Date(task.nextRunAt).getTime() <= nowMs);
}

export function claimVmScheduleRun(taskId: string, expectedNextRunAt: string, startedAt = new Date()): VmSchedule | undefined {
  return withStoreLock(() => {
    const store = readStore();
    const task = store.tasks.find((item) => item.id === taskId);
    if (!task?.enabled || task.nextRunAt !== expectedNextRunAt) return undefined;
    const dueAt = new Date(expectedNextRunAt);
    task.lastRun = {
      status: "running",
      startedAt: startedAt.toISOString(),
      successCount: 0,
      failedCount: 0,
      skippedCount: 0,
      message: "任务正在执行",
    };
    task.updatedAt = startedAt.toISOString();
    if (task.cycle === "once") {
      task.enabled = false;
      task.nextRunAt = undefined;
    } else {
      task.nextRunAt = calculateNextRunAt(task, new Date(dueAt.getTime() + 1_000));
      task.enabled = Boolean(task.nextRunAt);
    }
    writeStore(store);
    return task;
  });
}

export function finishVmScheduleRun(taskId: string, lastRun: VmScheduleLastRun): VmSchedule | undefined {
  return withStoreLock(() => {
    const store = readStore();
    const task = store.tasks.find((item) => item.id === taskId);
    if (!task) return undefined;
    task.lastRun = lastRun;
    task.updatedAt = lastRun.finishedAt ?? new Date().toISOString();
    writeStore(store);
    return task;
  });
}

export function calculateNextRunAt(task: Pick<VmSchedule, "cycle" | "onceAt" | "executeTime" | "weekdays" | "timezone">, after: Date): string | undefined {
  if (task.cycle === "once") {
    if (!task.onceAt) return undefined;
    const parts = parseLocalDateTime(task.onceAt);
    if (!parts) return undefined;
    const candidate = zonedLocalToUtc(parts, task.timezone);
    return candidate.getTime() > after.getTime() ? candidate.toISOString() : undefined;
  }

  const time = parseExecuteTime(task.executeTime);
  if (!time) return undefined;
  const localNow = zonedParts(after, task.timezone);
  const allowedWeekdays = task.cycle === "weekly" ? new Set(task.weekdays ?? []) : undefined;
  for (let dayOffset = 0; dayOffset <= 8; dayOffset += 1) {
    const date = addLocalDays(localNow, dayOffset);
    const weekday = isoWeekday(date.year, date.month, date.day);
    if (allowedWeekdays && !allowedWeekdays.has(weekday)) continue;
    const candidate = zonedLocalToUtc({ ...date, hour: time.hour, minute: time.minute, second: 0 }, task.timezone);
    if (candidate.getTime() > after.getTime()) return candidate.toISOString();
  }
  return undefined;
}

function normalizeInput(input: UpsertVmScheduleInput): UpsertVmScheduleInput {
  const targets = Array.from(
    new Map(
      input.targets
        .filter((target) => target.vmId.trim())
        .map((target) => {
          const normalized = normalizeTarget(target, input);
          return [targetKey(normalized.connectionId ?? input.connectionId, normalized.vmId), normalized] as const;
        }),
    ).values(),
  );
  if (!targets.length) throw new Error("至少选择一台目标虚拟机。");
  return {
    ...input,
    name: input.name.trim(),
    connectionId: input.connectionId.trim(),
    connectionName: input.connectionName?.trim() || undefined,
    hostId: input.hostId?.trim() || undefined,
    hostName: input.hostName?.trim() || undefined,
    executeTime: input.executeTime?.slice(0, 5),
    weekdays: Array.from(new Set(input.weekdays ?? [])).filter((day) => day >= 1 && day <= 7).sort((left, right) => left - right),
    shutdownTimeoutMinutes: Math.min(Math.max(Math.round(input.shutdownTimeoutMinutes), 2), 60),
    targets,
  };
}

function findConflicts(tasks: VmSchedule[], input: UpsertVmScheduleInput, excludedTaskId?: string): VmSchedule[] {
  const targetKeys = new Set(input.targets.map((target) => targetKey(target.connectionId ?? input.connectionId, target.vmId)));
  const signature = scheduleSignature(input);
  return tasks.filter(
    (task) =>
      task.id !== excludedTaskId &&
      task.enabled &&
      scheduleSignature(task) === signature &&
      task.targets.some((target) => targetKeys.has(scheduleTargetKey(task, target))),
  );
}

function resolveConflictTargets(store: VmScheduleStoreFile, conflicts: VmSchedule[], input: UpsertVmScheduleInput): VmScheduleTarget[] {
  if (!conflicts.length) return input.targets;
  if (input.conflictPolicy === "block") throw new VmScheduleConflictError(conflicts);
  const conflictingTargetKeys = new Set(conflicts.flatMap((task) => task.targets.map((target) => scheduleTargetKey(task, target))));
  if (input.conflictPolicy === "skip") {
    const targets = input.targets.filter((target) => !conflictingTargetKeys.has(targetKey(target.connectionId ?? input.connectionId, target.vmId)));
    if (!targets.length) throw new Error("所有目标虚拟机都与现有任务冲突，没有可创建的对象。");
    return targets;
  }
  const replacementKeys = new Set(input.targets.map((target) => targetKey(target.connectionId ?? input.connectionId, target.vmId)));
  const now = new Date().toISOString();
  for (const conflict of conflicts) {
    conflict.targets = conflict.targets.filter((target) => !replacementKeys.has(scheduleTargetKey(conflict, target)));
    conflict.updatedAt = now;
  }
  store.tasks = store.tasks.filter((task) => task.targets.length > 0);
  return input.targets;
}

function scheduleSignature(task: Pick<VmSchedule, "cycle" | "onceAt" | "executeTime" | "weekdays" | "timezone"> | UpsertVmScheduleInput): string {
  if (task.cycle === "once") return `once|${task.timezone}|${task.onceAt ?? ""}`;
  if (task.cycle === "daily") return `daily|${task.timezone}|${task.executeTime ?? ""}`;
  return `weekly|${task.timezone}|${task.executeTime ?? ""}|${[...(task.weekdays ?? [])].sort().join(",")}`;
}

function normalizeTarget(target: VmScheduleTarget, task: Pick<UpsertVmScheduleInput, "connectionId" | "providerType" | "connectionName" | "hostId" | "hostName">): VmScheduleTarget {
  const connectionId = target.connectionId?.trim() || task.connectionId.trim();
  const usesTaskConnection = connectionId === task.connectionId;
  return {
    ...target,
    vmId: target.vmId.trim(),
    name: target.name.trim() || target.vmId.trim(),
    connectionId,
    providerType: target.providerType ?? task.providerType,
    connectionName: target.connectionName?.trim() || (usesTaskConnection ? task.connectionName?.trim() : undefined),
    hostId: target.hostId?.trim() || (usesTaskConnection ? task.hostId?.trim() : undefined),
    hostName: target.hostName?.trim() || (usesTaskConnection ? task.hostName?.trim() : undefined),
  };
}

function normalizeStoredTask(task: VmSchedule): VmSchedule {
  return {
    ...task,
    targets: task.targets.map((target) => normalizeTarget(target, task)),
  };
}

function targetConnectionId(task: Pick<VmSchedule, "connectionId">, target: VmScheduleTarget): string {
  return target.connectionId?.trim() || task.connectionId;
}

function scheduleTargetKey(task: Pick<VmSchedule, "connectionId">, target: VmScheduleTarget): string {
  return targetKey(targetConnectionId(task, target), target.vmId);
}

function targetKey(connectionId: string, vmId: string): string {
  return `${connectionId}\u0000${vmId.trim()}`;
}

function parseLocalDateTime(value: string): ZonedDateParts | undefined {
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return undefined;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? 0),
  };
}

function parseExecuteTime(value?: string): { hour: number; minute: number } | undefined {
  const match = value?.match(/^(\d{2}):(\d{2})$/);
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return undefined;
  return { hour, minute };
}

interface ZonedDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedParts(date: Date, timezone: string): ZonedDateParts {
  const values: Record<string, number> = {};
  for (const part of new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date)) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  };
}

function zonedLocalToUtc(parts: ZonedDateParts, timezone: string): Date {
  const targetMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  let candidateMs = targetMs;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const actual = zonedParts(new Date(candidateMs), timezone);
    const actualMs = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    candidateMs += targetMs - actualMs;
  }
  return new Date(candidateMs);
}

function addLocalDays(parts: ZonedDateParts, dayOffset: number): Pick<ZonedDateParts, "year" | "month" | "day"> {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + dayOffset));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function isoWeekday(year: number, month: number, day: number): number {
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

function readStore(): VmScheduleStoreFile {
  ensureStoreDir();
  if (!existsSync(storeFile)) return { version: 1, tasks: [] };
  try {
    const parsed = JSON.parse(readFileSync(storeFile, "utf8")) as Partial<VmScheduleStoreFile>;
    return { version: 1, tasks: Array.isArray(parsed.tasks) ? parsed.tasks.map(normalizeStoredTask) : [] };
  } catch {
    return { version: 1, tasks: [] };
  }
}

function writeStore(store: VmScheduleStoreFile): void {
  ensureStoreDir();
  const tempFile = `${storeFile}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tempFile, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  renameSync(tempFile, storeFile);
}

function ensureStoreDir(): void {
  mkdirSync(dirname(storeFile), { recursive: true, mode: 0o700 });
}

function withStoreLock<T>(operation: () => T): T {
  ensureStoreDir();
  const startedAt = Date.now();
  let descriptor: number | undefined;
  while (descriptor == null) {
    try {
      descriptor = openSync(writeLockFile, "wx", 0o600);
      writeFileSync(descriptor, `${process.pid}\n`);
    } catch (error) {
      if (!isFileExistsError(error)) throw error;
      if (isStaleWriteLock()) {
        try {
          unlinkSync(writeLockFile);
        } catch {
          // 另一个进程已接管或释放锁，继续竞争。
        }
        continue;
      }
      if (Date.now() - startedAt >= writeLockTimeoutMs) throw new Error("定时任务存储正在被其他进程更新，请稍后重试。");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    return operation();
  } finally {
    closeSync(descriptor);
    try {
      unlinkSync(writeLockFile);
    } catch {
      // 锁文件已被清理时不影响本次写入结果。
    }
  }
}

function isStaleWriteLock(): boolean {
  try {
    return Date.now() - statSync(writeLockFile).mtimeMs > staleWriteLockMs;
  } catch {
    return false;
  }
}

function isFileExistsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
