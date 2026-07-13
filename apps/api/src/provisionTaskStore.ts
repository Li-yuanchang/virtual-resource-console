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

interface TaskStoreFile {
  version: 1;
  tasks: ProvisionTask[];
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
  const task: ProvisionTask = {
    id: randomUUID(),
    connectionId: input.connectionId,
    providerType: input.providerType,
    hostId: input.hostId,
    environmentTemplateId: input.environmentTemplateId,
    title: input.title,
    status: "pending",
    currentStep: "plan",
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
      message: "等待创建",
    })),
  };
  writeTasks([task, ...readTasks()]);
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

export function markProvisionTaskStep(taskId: string, stepKey: ProvisionTaskStepKey, status: ProvisionTaskStepStatus, message?: string): ProvisionTask | undefined {
  const now = new Date().toISOString();
  return patchProvisionTask(taskId, (task) => ({
    ...task,
    status: status === "failed" ? "failed" : status === "running" ? "running" : task.status,
    currentStep: stepKey,
    message: message || task.message,
    updatedAt: now,
    finishedAt: status === "failed" ? now : task.finishedAt,
    steps: task.steps.map((step) =>
      step.key === stepKey
        ? {
            ...step,
            status,
            message,
            startedAt: status === "running" ? step.startedAt || now : step.startedAt,
            finishedAt: status === "success" || status === "failed" || status === "skipped" ? now : step.finishedAt,
          }
        : step,
    ),
  }));
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

export function finishProvisionTask(taskId: string, status: "success" | "failed", message: string): ProvisionTask | undefined {
  const now = new Date().toISOString();
  return patchProvisionTask(taskId, (task) => ({
    ...task,
    status,
    currentStep: status === "success" ? "complete" : task.currentStep,
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
      message: vm.message || message,
    })),
  }));
}

function patchProvisionTask(taskId: string, patcher: (task: ProvisionTask) => ProvisionTask): ProvisionTask | undefined {
  const tasks = readTasks();
  const index = tasks.findIndex((task) => task.id === taskId);
  if (index < 0) return undefined;
  const updated = patcher(tasks[index]);
  tasks[index] = updated;
  writeTasks(tasks);
  return updated;
}

function readTasks(): ProvisionTask[] {
  if (!existsSync(storeFile)) return [];
  try {
    const parsed = JSON.parse(readFileSync(storeFile, "utf8")) as TaskStoreFile;
    return Array.isArray(parsed.tasks) ? parsed.tasks : [];
  } catch {
    return [];
  }
}

function writeTasks(tasks: ProvisionTask[]): void {
  if (!existsSync(storeDir)) mkdirSync(storeDir, { recursive: true });
  writeFileSync(storeFile, JSON.stringify({ version: 1, tasks: tasks.slice(0, 200) }, null, 2), "utf8");
}
