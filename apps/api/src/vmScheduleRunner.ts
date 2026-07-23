import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { getVrcDataFile } from "./appPaths.js";
import { markConnectionUsed, resolveStoredConnection } from "./connectionStore.js";
import type { ProviderRegistry } from "./providers/provider.js";
import type { VmNode, VmSchedule, VmScheduleLastRun, VmScheduleRunnerStatus, VmScheduleTarget, XenConnectionInput } from "./types.js";
import { claimVmScheduleRun, finishVmScheduleRun, listDueVmSchedules } from "./vmScheduleStore.js";

const leaseFile = getVrcDataFile("vm-schedule-runner.lock");
const leaseHeartbeatMs = 10_000;
const leaseStaleMs = 35_000;
const missedRunGraceMs = 5 * 60_000;

interface RunnerLease {
  instanceId: string;
  pid: number;
  mode: VmScheduleRunnerStatus["mode"];
  heartbeatAt: string;
}

interface RunnerLogger {
  info(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
  error(context: Record<string, unknown>, message: string): void;
}

export class VmScheduleRunner {
  private readonly instanceId = randomUUID();
  private readonly mode = normalizeRuntimeMode(process.env.VRC_RUNTIME_MODE);
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private ownsLease = false;

  constructor(
    private readonly providers: ProviderRegistry,
    private readonly logger: RunnerLogger,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), leaseHeartbeatMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.releaseLease();
  }

  status(): VmScheduleRunnerStatus {
    const lease = readLease();
    return {
      mode: lease?.mode ?? this.mode,
      owner: lease?.instanceId === this.instanceId,
      instanceId: lease?.instanceId,
      heartbeatAt: lease?.heartbeatAt,
    };
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      if (!this.acquireOrRenewLease()) return;
      const now = new Date();
      for (const task of listDueVmSchedules(now)) {
        await this.runDueTask(task, now);
      }
    } catch (error) {
      this.logger.error({ error }, "vm schedule runner tick failed");
    } finally {
      this.ticking = false;
    }
  }

  private async runDueTask(task: VmSchedule, now: Date): Promise<void> {
    const dueAt = task.nextRunAt;
    if (!dueAt) return;
    const claimed = claimVmScheduleRun(task.id, dueAt, now);
    if (!claimed) return;
    if (now.getTime() - new Date(dueAt).getTime() > missedRunGraceMs) {
      finishVmScheduleRun(task.id, {
        status: "skipped",
        startedAt: now.toISOString(),
        finishedAt: new Date().toISOString(),
        successCount: 0,
        failedCount: 0,
        skippedCount: task.targets.length,
        message: "VRC 服务未在执行窗口内运行，本次计划已跳过。",
      });
      this.logger.warn({ taskId: task.id, dueAt }, "missed vm schedule run skipped");
      return;
    }

    const startedAt = now.toISOString();
    try {
      const result = await this.executeTask(claimed, startedAt);
      finishVmScheduleRun(task.id, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "定时任务执行失败";
      finishVmScheduleRun(task.id, {
        status: "failed",
        startedAt,
        finishedAt: new Date().toISOString(),
        successCount: 0,
        failedCount: task.targets.length,
        skippedCount: 0,
        message,
      });
      this.logger.error({ error, taskId: task.id }, "vm schedule execution failed");
    }
  }

  private async executeTask(task: VmSchedule, startedAt: string): Promise<VmScheduleLastRun> {
    let successCount = 0;
    let failedCount = 0;
    let skippedCount = 0;
    const failures: string[] = [];
    const groups = groupTargets(task);

    for (const group of groups.values()) {
      let connectionResolved = false;
      try {
        const storedConnection = resolveStoredConnection(group.connectionId);
        connectionResolved = true;
        const mismatchedTarget = group.targets.find(
          (target) => target.providerType && target.providerType !== storedConnection.providerType,
        );
        if (mismatchedTarget) {
          throw new Error(`${mismatchedTarget.name} 的平台类型与保存连接不一致`);
        }
        const provider = this.providers.get(storedConnection.providerType);
        if (!provider.performVmAction) throw new Error("当前平台不支持虚拟机开关机操作。");
        const connection = toProviderConnection(storedConnection);
        const inventory = await listAllVms(provider, connection, group.hostId);
        const vmById = new Map(inventory.flatMap((vm) => [[vm.providerId, vm], [vm.id, vm]]));

        for (const target of group.targets) {
          const vm = vmById.get(target.vmId);
          if (!vm) {
            failedCount += 1;
            failures.push(`${target.name}：未找到虚拟机`);
            continue;
          }
          const alreadyMatches = task.action === "start" ? vm.powerState === "running" : vm.powerState === "halted" || vm.powerState === "stopped";
          if (alreadyMatches && task.skipMatchingState) {
            skippedCount += 1;
            continue;
          }
          try {
            const result = await provider.performVmAction(connection, target.vmId, task.action, {
              shutdownTimeoutMs: task.shutdownTimeoutMinutes * 60_000,
              forceOnShutdownFailure: task.shutdownFallback === "force",
            });
            if (!result.accepted) throw new Error(result.message || "平台未接受操作");
            successCount += 1;
          } catch (error) {
            failedCount += 1;
            failures.push(`${target.name}：${error instanceof Error ? error.message : "操作失败"}`);
          }
        }
      } catch (error) {
        failedCount += group.targets.length;
        const groupName = group.targets[0]?.connectionName || group.connectionId;
        failures.push(`${groupName}：${error instanceof Error ? error.message : "分组执行失败"}`);
        this.logger.error({ error, taskId: task.id, connectionId: group.connectionId, hostId: group.hostId }, "vm schedule target group failed");
      } finally {
        if (connectionResolved) {
          try {
            markConnectionUsed(group.connectionId);
          } catch (error) {
            this.logger.warn({ error, connectionId: group.connectionId }, "failed to update scheduled connection usage");
          }
        }
      }
    }

    const status: VmScheduleLastRun["status"] = failedCount === 0 ? "success" : successCount > 0 || skippedCount > 0 ? "partial" : "failed";
    const summary = `成功 ${successCount} 台，跳过 ${skippedCount} 台，失败 ${failedCount} 台`;
    const message = failures.length ? `${summary}；${failures.slice(0, 3).join("；")}` : summary;
    this.logger.info({ taskId: task.id, successCount, skippedCount, failedCount }, "vm schedule execution finished");
    return {
      status,
      startedAt,
      finishedAt: new Date().toISOString(),
      successCount,
      failedCount,
      skippedCount,
      message,
    };
  }

  private acquireOrRenewLease(): boolean {
    const now = new Date();
    const current = readLease();
    if (current?.instanceId === this.instanceId) {
      writeLease({ ...current, heartbeatAt: now.toISOString() });
      this.ownsLease = true;
      return true;
    }
    if (current && now.getTime() - new Date(current.heartbeatAt).getTime() <= leaseStaleMs) {
      this.ownsLease = false;
      return false;
    }
    if (current) {
      try {
        unlinkSync(leaseFile);
      } catch {
        this.ownsLease = false;
        return false;
      }
    }
    mkdirSync(dirname(leaseFile), { recursive: true, mode: 0o700 });
    let descriptor: number | undefined;
    try {
      descriptor = openSync(leaseFile, "wx", 0o600);
      const lease: RunnerLease = {
        instanceId: this.instanceId,
        pid: process.pid,
        mode: this.mode,
        heartbeatAt: now.toISOString(),
      };
      writeFileSync(descriptor, `${JSON.stringify(lease, null, 2)}\n`);
      this.ownsLease = true;
      this.logger.info({ mode: this.mode, instanceId: this.instanceId }, "vm schedule runner lease acquired");
      return true;
    } catch (error) {
      if (!isFileExistsError(error)) this.logger.warn({ error }, "vm schedule runner lease acquisition failed");
      this.ownsLease = false;
      return false;
    } finally {
      if (descriptor != null) closeSync(descriptor);
    }
  }

  private releaseLease(): void {
    if (!this.ownsLease) return;
    const current = readLease();
    if (current?.instanceId === this.instanceId) {
      try {
        unlinkSync(leaseFile);
      } catch {
        // 退出阶段不因锁文件清理失败阻塞 API 关闭。
      }
    }
    this.ownsLease = false;
  }
}

interface TargetGroup {
  connectionId: string;
  hostId?: string;
  targets: VmScheduleTarget[];
}

function groupTargets(task: VmSchedule): Map<string, TargetGroup> {
  const groups = new Map<string, TargetGroup>();
  for (const target of task.targets) {
    const connectionId = target.connectionId?.trim() || task.connectionId;
    const hostId = target.hostId?.trim() || (connectionId === task.connectionId ? task.hostId : undefined);
    const key = `${connectionId}\u0000${hostId ?? ""}`;
    const group = groups.get(key) ?? { connectionId, hostId, targets: [] };
    group.targets.push(target);
    groups.set(key, group);
  }
  return groups;
}

function toProviderConnection(stored: ReturnType<typeof resolveStoredConnection>): XenConnectionInput {
  return {
    host: stored.host,
    port: stored.port,
    username: stored.username,
    password: stored.password,
  };
}

async function listAllVms(
  provider: ReturnType<ProviderRegistry["get"]>,
  connection: XenConnectionInput,
  hostId?: string,
): Promise<VmNode[]> {
  const firstPage = await provider.listVms(connection, { hostId, page: 1, pageSize: 500 });
  const items = [...firstPage.items];
  const pageCount = Math.ceil(firstPage.total / firstPage.pageSize);
  for (let page = 2; page <= pageCount; page += 1) {
    const nextPage = await provider.listVms(connection, { hostId, page, pageSize: firstPage.pageSize });
    items.push(...nextPage.items);
  }
  return items;
}

function readLease(): RunnerLease | undefined {
  if (!existsSync(leaseFile)) return undefined;
  try {
    const lease = JSON.parse(readFileSync(leaseFile, "utf8")) as RunnerLease;
    return lease.instanceId && lease.heartbeatAt ? lease : undefined;
  } catch {
    return undefined;
  }
}

function writeLease(lease: RunnerLease): void {
  mkdirSync(dirname(leaseFile), { recursive: true, mode: 0o700 });
  const tempFile = `${leaseFile}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tempFile, `${JSON.stringify(lease, null, 2)}\n`, { mode: 0o600 });
  renameSync(tempFile, leaseFile);
}

function normalizeRuntimeMode(value?: string): VmScheduleRunnerStatus["mode"] {
  if (value === "electron" || value === "chrome-native") return value;
  return "web";
}

function isFileExistsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
