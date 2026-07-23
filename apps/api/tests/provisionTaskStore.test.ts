import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWindowsRemoteAcceptanceWarning } from "../src/provisionTaskStore.js";
import type { ProvisionTask } from "../src/types.js";

function windowsRemoteTimeoutTask(): ProvisionTask {
  return {
    id: "task-1",
    providerType: "xenserver",
    title: "Windows create",
    status: "failed",
    currentStep: "wait-network",
    eventSeq: 1,
    progressPercent: 82,
    message: "Windows 安装后未等到 WinRM 服务就绪。",
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:15:00.000Z",
    finishedAt: "2026-07-20T00:15:00.000Z",
    steps: [
      { key: "install-guest", name: "安装系统", status: "success" },
      { key: "wait-network", name: "等待网络", status: "skipped" },
      { key: "verify-login", name: "验证登录", status: "pending" },
      { key: "finalize", name: "启动收尾", status: "pending" },
      { key: "guest-tools", name: "监控工具", status: "pending" },
      { key: "complete", name: "完成", status: "failed" },
    ],
    vms: [{
      name: "2.32_windows",
      ip: "192.168.2.32",
      status: "failed",
      currentStep: "wait-network",
      message: "Windows 已启动，但 WinRM 未就绪",
      reasonCode: "WINDOWS_REMOTE_INIT_TIMEOUT",
      readiness: { state: "network-visible", networkVisible: true, ready: false },
    }],
  };
}

test("normalizes an installed Windows guest with incomplete WinRM acceptance to warning", () => {
  const normalized = normalizeWindowsRemoteAcceptanceWarning(windowsRemoteTimeoutTask());

  assert.equal(normalized.status, "warning");
  assert.equal(normalized.currentStep, "complete");
  assert.equal(normalized.progressPercent, 100);
  assert.equal(normalized.steps.find((step) => step.key === "wait-network")?.status, "warning");
  assert.equal(normalized.steps.find((step) => step.key === "complete")?.status, "warning");
  assert.equal(normalized.vms[0]?.status, "warning");
  assert.match(normalized.message, /已安装并进入系统/);
});

test("keeps a genuinely offline Windows installation failure unchanged", () => {
  const task = windowsRemoteTimeoutTask();
  task.vms[0] = {
    ...task.vms[0],
    reasonCode: "GUEST_OFFLINE",
    readiness: { state: "offline", networkVisible: false, ready: false },
  };

  assert.strictEqual(normalizeWindowsRemoteAcceptanceWarning(task), task);
});
