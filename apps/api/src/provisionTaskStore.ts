import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ProviderType,
  ProvisionTask,
  ProvisionTaskStep,
  ProvisionTaskStepKey,
  ProvisionTaskStepStatus,
  ProvisionTaskVm,
  VmProvisionPlanItem,
} from "./types.js";

const storeDir = join(homedir(), ".virtual-resource-console");
const storeFile = join(storeDir, "provision-tasks.json");
const provisionStepWeights: Record<ProvisionTaskStepKey, number> = {
  plan: 5,
  "publish-source": 10,
  "create-vm": 15,
  boot: 10,
  "fetch-source": 10,
  "install-guest": 20,
  "wait-network": 10,
  "verify-login": 10,
  finalize: 5,
  "guest-tools": 3,
  complete: 2,
};
const totalProgressWeight = Object.values(provisionStepWeights).reduce((sum, weight) => sum + weight, 0);
const taskListeners = new Map<string, Set<(task: ProvisionTask) => void>>();

type StoredProvisionTask = Omit<ProvisionTask, "eventSeq" | "progressPercent"> & Partial<Pick<ProvisionTask, "eventSeq" | "progressPercent">>;

interface TaskStoreFile {
  version: 1;
  tasks: StoredProvisionTask[];
}

interface CreateProvisionTaskInput {
  connectionId?: string;
  providerType: ProviderType;
  hostId?: string;
  environmentTemplateId?: string;
  title: string;
  planItems: VmProvisionPlanItem[];
}

const taskSteps: Array<Pick<ProvisionTaskStep, "key" | "name">> = [
  { key: "plan", name: "生成计划" },
  { key: "publish-source", name: "发布安装源" },
  { key: "create-vm", name: "创建 VM" },
  { key: "boot", name: "启动系统" },
  { key: "fetch-source", name: "拉取安装源" },
  { key: "install-guest", name: "安装系统" },
  { key: "wait-network", name: "等待网络" },
  { key: "verify-login", name: "验证登录" },
  { key: "finalize", name: "启动收尾" },
  { key: "guest-tools", name: "监控工具" },
  { key: "complete", name: "完成" },
];

export function createProvisionTask(input: CreateProvisionTaskInput): ProvisionTask {
  const now = new Date().toISOString();
  const task = normalizeProvisionTask({
    id: randomUUID(),
    connectionId: input.connectionId,
    providerType: input.providerType,
    hostId: input.hostId,
    environmentTemplateId: input.environmentTemplateId,
    title: input.title,
    status: "pending",
    currentStep: "plan",
    eventSeq: 1,
    message: "等待创建任务开始",
    createdAt: now,
    updatedAt: now,
    steps: taskSteps.map((step) => ({
      ...step,
      status: step.key === "plan" ? "success" : "pending",
      finishedAt: step.key === "plan" ? now : undefined,
    })),
    vms: input.planItems.map((item) => ({
      name: item.name,
      ip: item.ip,
      status: "pending",
      currentStep: "plan",
      message: "等待创建",
    })),
  });
  writeTasks([task, ...readTasks()]);
  emitProvisionTask(task);
  return task;
}

export function getProvisionTask(taskId: string): ProvisionTask | undefined {
  return readTasks().find((task) => task.id === taskId);
}

export function listProvisionTasks(limit = 50): ProvisionTask[] {
  return readTasks()
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, limit);
}

export function subscribeProvisionTask(taskId: string, listener: (task: ProvisionTask) => void): () => void {
  const listeners = taskListeners.get(taskId) ?? new Set<(task: ProvisionTask) => void>();
  listeners.add(listener);
  taskListeners.set(taskId, listeners);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) taskListeners.delete(taskId);
  };
}

export function markProvisionTaskStep(taskId: string, stepKey: ProvisionTaskStepKey, status: ProvisionTaskStepStatus, message?: string): ProvisionTask | undefined {
  const now = new Date().toISOString();
  // Step failure/warning is emitted first; only finishProvisionTask may close the task event stream.
  return patchProvisionTask(taskId, (task) => ({
    ...task,
    status: status === "running" ? "running" : task.status,
    currentStep: stepKey,
    message: message || task.message,
    updatedAt: now,
    finishedAt: task.finishedAt,
    steps: task.steps.map((step) =>
      step.key === stepKey
        ? {
            ...step,
            status,
            message,
            startedAt: status === "running" ? step.startedAt || now : step.startedAt,
            finishedAt: status === "success" || status === "warning" || status === "failed" || status === "skipped" ? now : step.finishedAt,
          }
        : step,
    ),
  }));
}

export function markProvisionTaskStepIfUnfinished(
  taskId: string,
  stepKey: ProvisionTaskStepKey,
  status: Exclude<ProvisionTaskStepStatus, "pending">,
  message?: string,
): ProvisionTask | undefined {
  const task = getProvisionTask(taskId);
  const step = task?.steps.find((item) => item.key === stepKey);
  if (!step || ["success", "warning", "failed", "skipped"].includes(step.status)) return task;
  return markProvisionTaskStep(taskId, stepKey, status, message);
}

export function updateProvisionTaskVms(taskId: string, vms: ProvisionTaskVm[], message?: string): ProvisionTask | undefined {
  const now = new Date().toISOString();
  return patchProvisionTask(taskId, (task) => ({
    ...task,
    vms,
    message: message || task.message,
    updatedAt: now,
  }));
}

export function updateProvisionTaskVm(taskId: string, vmName: string, patch: Partial<ProvisionTaskVm>, message?: string): ProvisionTask | undefined {
  const now = new Date().toISOString();
  return patchProvisionTask(taskId, (task) => ({
    ...task,
    vms: task.vms.map((vm) => {
      if (vm.name !== vmName) return vm;
      const nextVm = { ...vm, ...patch };
      const hasPackageProgress = Number(nextVm.installPackageDone) > 0 && Number(nextVm.installPackageTotal) > 0;
      return {
        ...nextVm,
        progressPercent:
          patch.progressPercent ??
          (hasPackageProgress ? vm.progressPercent : nextVm.status === "success" ? 100 : undefined),
      };
    }),
    message: message || task.message,
    updatedAt: now,
  }));
}

export function finishProvisionTask(taskId: string, status: "success" | "warning" | "failed", message: string): ProvisionTask | undefined {
  const now = new Date().toISOString();
  return patchProvisionTask(taskId, (task) => ({
    ...task,
    status,
    currentStep: status === "success" || status === "warning" ? "complete" : task.currentStep,
    message,
    updatedAt: now,
    finishedAt: now,
    steps: task.steps.map((step) =>
      step.key === "complete"
        ? {
            ...step,
            status,
            message,
            startedAt: step.startedAt || now,
            finishedAt: now,
          }
        : step,
    ),
    vms: task.vms.map((vm) => ({
      ...vm,
      status: vm.status === "success" || vm.status === "failed" ? vm.status : status,
      currentStep: vm.status === "success" || vm.status === "failed" ? vm.currentStep : status === "success" || status === "warning" ? "complete" : vm.currentStep,
      progressPercent:
        vm.status === "success" || vm.status === "failed"
          ? vm.progressPercent
          : status === "success" || status === "warning"
            ? 100
            : calculateProvisionStepProgress(vm.currentStep ?? task.currentStep, status),
      message: vm.message || message,
    })),
  }));
}

function patchProvisionTask(taskId: string, patcher: (task: ProvisionTask) => ProvisionTask): ProvisionTask | undefined {
  const tasks = readTasks();
  const index = tasks.findIndex((task) => task.id === taskId);
  if (index < 0) return undefined;
  const patched = patcher(tasks[index]);
  const updated = normalizeProvisionTask({
    ...patched,
    eventSeq: (tasks[index].eventSeq || 0) + 1,
  });
  tasks[index] = updated;
  writeTasks(tasks);
  emitProvisionTask(updated);
  return updated;
}

function readTasks(): ProvisionTask[] {
  if (!existsSync(storeFile)) return [];
  try {
    const parsed = JSON.parse(readFileSync(storeFile, "utf8")) as TaskStoreFile;
    return Array.isArray(parsed.tasks) ? parsed.tasks.map(normalizeProvisionTask) : [];
  } catch {
    return [];
  }
}

function writeTasks(tasks: ProvisionTask[]): void {
  if (!existsSync(storeDir)) mkdirSync(storeDir, { recursive: true });
  writeFileSync(storeFile, JSON.stringify({ version: 1, tasks: tasks.slice(0, 200) }, null, 2), "utf8");
}

function normalizeProvisionTask(task: StoredProvisionTask): ProvisionTask {
  const normalized = {
    ...task,
    eventSeq: task.eventSeq || 0,
  };
  return {
    ...normalized,
    progressPercent: calculateProvisionTaskProgress(normalized),
    vms: normalized.vms.map((vm) => ({
      ...vm,
      currentStep: vm.currentStep ?? normalized.currentStep,
      progressPercent: vm.progressPercent ?? (vm.status === "success" ? 100 : undefined),
    })),
  };
}

function calculateProvisionTaskProgress(task: StoredProvisionTask): number {
  if (task.status === "success" || task.status === "warning") return 100;
  const completedWeight = task.steps.reduce((sum, step) => {
    const weight = provisionStepWeights[step.key] ?? 0;
    if (step.status === "success" || step.status === "warning" || step.status === "skipped") return sum + weight;
    if (step.status === "running" || step.status === "failed") return sum + weight * 0.5;
    return sum;
  }, 0);
  const stepPercent = Math.round((completedWeight / totalProgressWeight) * 100);
  const vmProgressValues = task.vms
    .filter((vm) => Number(vm.installPackageDone) > 0 && Number(vm.installPackageTotal) > 0)
    .map((vm) => Number(vm.progressPercent))
    .filter(Number.isFinite);
  const vmAveragePercent = vmProgressValues.length
    ? Math.round(vmProgressValues.reduce((sum, value) => sum + value, 0) / vmProgressValues.length)
    : 0;
  const percent = Math.max(stepPercent, vmAveragePercent);
  return Math.max(0, Math.min(task.status === "failed" ? 99 : 100, percent));
}

function calculateProvisionStepProgress(stepKey: ProvisionTaskStepKey, status: ProvisionTask["status"]): number {
  if (status === "success" || status === "warning") return 100;
  const orderedKeys = taskSteps.map((step) => step.key);
  const currentIndex = Math.max(orderedKeys.indexOf(stepKey), 0);
  const completedBefore = orderedKeys.slice(0, currentIndex).reduce((sum, key) => sum + (provisionStepWeights[key] ?? 0), 0);
  const currentWeight = provisionStepWeights[stepKey] ?? 0;
  const runningWeight = status === "pending" ? 0 : currentWeight * 0.5;
  const percent = Math.round(((completedBefore + runningWeight) / totalProgressWeight) * 100);
  return Math.max(0, Math.min(status === "failed" ? 99 : 100, percent));
}

function emitProvisionTask(task: ProvisionTask): void {
  const listeners = taskListeners.get(task.id);
  if (!listeners?.size) return;
  for (const listener of listeners) {
    listener(task);
  }
}
