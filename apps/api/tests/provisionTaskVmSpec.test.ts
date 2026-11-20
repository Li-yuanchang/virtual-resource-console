import assert from "node:assert/strict";
import test from "node:test";
import { mergeProvisionTaskVms, normalizeWindowsRemoteAcceptanceWarning } from "../src/provisionTaskStore.js";
import type { ProvisionTask } from "../src/types.js";

function buildTask(vms: ProvisionTask["vms"]): ProvisionTask {
  return {
    id: "task-1",
    providerType: "xenserver",
    title: "创建 VM",
    status: "running",
    currentStep: "publish-source",
    progressPercent: 10,
    eventSeq: 3,
    message: "正在创建",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    steps: [],
    vms,
  };
}

test("task normalization keeps submitted VM specs visible while creating", () => {
  // 任务执行期间表单会锁定，规格必须随任务保留；
  // 归一化步骤不能把 cpu/memoryGiB/diskGiB 丢掉，否则界面只能显示状态而看不到配置。
  const normalized = normalizeWindowsRemoteAcceptanceWarning(
    buildTask([
      {
        name: "2.62_ces",
        ip: "192.168.2.62",
        status: "running",
        cpu: 2,
        memoryGiB: 2,
        diskGiB: 50,
      },
    ]),
  );

  assert.equal(normalized.vms[0].cpu, 2);
  assert.equal(normalized.vms[0].memoryGiB, 2);
  assert.equal(normalized.vms[0].diskGiB, 50);
  assert.equal(normalized.vms[0].name, "2.62_ces");
  assert.equal(normalized.vms[0].ip, "192.168.2.62");
});

test("historical tasks without specs stay renderable as empty values", () => {
  // 旧任务没有规格字段，界面需按 "-" 降级显示，而不是报错或显示 0。
  const normalized = normalizeWindowsRemoteAcceptanceWarning(
    buildTask([{ name: "legacy-vm", status: "success" }]),
  );

  assert.equal(normalized.vms[0].cpu, undefined);
  assert.equal(normalized.vms[0].memoryGiB, undefined);
  assert.equal(normalized.vms[0].diskGiB, undefined);
});

test("batch VM updates keep specs the caller does not resend", () => {
  // 验收阶段（provisioningVerifier）只重建进度字段，不会重发规格。
  // 批量更新必须与已有记录合并，否则 cpu/memory/disk 会被冲掉，界面只剩 "-"。
  const merged = mergeProvisionTaskVms(
    [{ name: "2.62_ces", ip: "192.168.2.62", status: "pending", cpu: 2, memoryGiB: 2, diskGiB: 50 }],
    [{ name: "2.62_ces", ip: "192.168.2.62", status: "running", currentStep: "wait-network" }],
  );

  assert.equal(merged.length, 1);
  assert.equal(merged[0].cpu, 2);
  assert.equal(merged[0].memoryGiB, 2);
  assert.equal(merged[0].diskGiB, 50);
  // 调用方提供的新值应覆盖旧值。
  assert.equal(merged[0].status, "running");
  assert.equal(merged[0].currentStep, "wait-network");
});

test("batch VM updates tolerate new VMs and missing previous records", () => {
  // 首次出现或历史缺失的 VM 不应报错，原样保留调用方提供的内容。
  const merged = mergeProvisionTaskVms(
    [{ name: "known-vm", status: "pending", cpu: 4 }],
    [
      { name: "known-vm", status: "running" },
      { name: "new-vm", status: "pending", cpu: 8 },
    ],
  );

  assert.equal(merged.length, 2);
  assert.equal(merged[0].cpu, 4);
  assert.equal(merged[1].name, "new-vm");
  assert.equal(merged[1].cpu, 8);
});
