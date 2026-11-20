import assert from "node:assert/strict";
import test from "node:test";
import { inspectGeneratedIsoResidues } from "../src/generatedIsoCleanupService.js";
import type { GeneratedIsoRecord } from "../src/generatedIsoStore.js";
import { buildXenGeneratedIsoCleanupScript } from "../src/xenserverUnattendedIso.js";

function generatedIsoRecord(input: Partial<GeneratedIsoRecord>): GeneratedIsoRecord {
  return {
    id: input.id ?? "record-1",
    taskId: input.taskId ?? "task-1",
    providerType: input.providerType ?? "xenserver",
    connectionId: input.connectionId ?? "connection-1",
    hostId: input.hostId ?? "host-1",
    vmName: input.vmName ?? "2.32_test",
    vmIp: input.vmIp ?? "192.168.2.32",
    sourceIsoId: input.sourceIsoId ?? "source-iso",
    sourceIsoName: input.sourceIsoName ?? "CentOS.iso",
    isoSrUuid: input.isoSrUuid ?? "sr-1",
    isoVdiUuid: input.isoVdiUuid ?? "vdi-1",
    isoName: input.isoName ?? "vrc-2.32-test.iso",
    isoPath: input.isoPath ?? "/generated/vrc-2.32-test.iso",
    status: input.status ?? "uploaded",
    createdAt: input.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-01-01T00:00:00.000Z",
    cleanupAfter: input.cleanupAfter,
    deletedAt: input.deletedAt,
    message: input.message,
  };
}

test("maintenance report excludes deleted generated ISO tombstones", async () => {
  const active = generatedIsoRecord({ id: "active" });
  const deleted = generatedIsoRecord({
    id: "deleted",
    status: "deleted",
    deletedAt: "2026-01-02T00:00:00.000Z",
  });

  const report = await inspectGeneratedIsoResidues({
    records: [deleted, active],
    activeTaskIds: new Set(),
    failedRetentionMs: 0,
  });

  assert.equal(report.summary.total, 1);
  assert.equal(report.summary.eligible, 1);
  assert.deepEqual(report.items.map((item) => item.id), ["active"]);
});

test("XenServer cleanup script validates exact identity, path, attachment and post-delete residue", () => {
  const record = generatedIsoRecord({
    id: "registry-123",
    taskId: "task-456",
    isoVdiUuid: "12345678-1234-1234-1234-123456789abc",
    isoName: "vrc-2.32-test.iso",
    isoPath: "/var/run/sr-mount/sr-1/vrc-2.32-test.iso",
  });

  const script = buildXenGeneratedIsoCleanupScript(record);

  assert.match(script, /vrc-generated/);
  assert.match(script, /vrc-registry-id/);
  assert.match(script, /vrc-task-id/);
  assert.match(script, /actual_path.*expected_path/);
  assert.match(script, /currently-attached=true/);
  assert.match(script, /xe vdi-destroy uuid="\$iso_uuid"/);
  assert.match(script, /xe sr-scan uuid="\$actual_sr"/);
  assert.match(script, /remaining_uuid/);
  assert.match(script, /remaining_name/);
  assert.match(script, /VRC_REMOTE_VDI_DELETED/);
  const lines = script.split("\n");
  assert.equal(lines[0], "iso_uuid='12345678-1234-1234-1234-123456789abc'");
  assert.match(lines[5] ?? "", /^vdi_uuid=/);
});

/** 相对当前时间的 ISO 时间戳：分类逻辑内部使用真实 now，测试数据必须相对当前时刻构造。 */
function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

test("classifies interrupted registrations older than 24h as orphan and purgeable", async () => {
  // 生成中断的记录永远拿不到 isoVdiUuid，远端无从校验；旧逻辑会永久停在 skipped，
  // 用户以为清理功能失效。超过 24 小时后必须归为 orphan，允许只删本地登记。
  // 工厂对 isoVdiUuid 用 ?? 兜底成 vdi-1，必须先构造再展开覆盖，
  // 否则"生成中断未写标识"这个真实场景根本覆盖不到。
  const stale = {
    ...generatedIsoRecord({ id: "stale", status: "creating", updatedAt: hoursAgo(96) }),
    isoVdiUuid: undefined,
  };
  const report = await inspectGeneratedIsoResidues({ records: [stale], activeTaskIds: new Set() });

  assert.equal(report.items[0].decision, "orphan");
  assert.match(report.items[0].reason, /只能删除本地登记/);
  assert.equal(report.summary.orphan, 1);
});

test("keeps recently interrupted registrations pending instead of orphan", async () => {
  // 24 小时内的生成中断可能仍在进行，不能提前判为孤儿。
  const fresh = {
    ...generatedIsoRecord({ id: "fresh", status: "creating", updatedAt: hoursAgo(2) }),
    isoVdiUuid: undefined,
  };
  const report = await inspectGeneratedIsoResidues({ records: [fresh], activeTaskIds: new Set() });

  assert.equal(report.items[0].decision, "skipped");
  assert.equal(report.summary.orphan, 0);
});

test("classifies records without a resolvable connection as orphan", async () => {
  // 连接被删除后无法远端校验，同样永久滞留，应归入可清理的孤儿。
  const record = {
    ...generatedIsoRecord({ id: "no-conn", updatedAt: hoursAgo(96) }),
    connectionId: undefined,
  };
  const report = await inspectGeneratedIsoResidues({ records: [record], activeTaskIds: new Set() });

  assert.equal(report.items[0].decision, "orphan");
  assert.match(report.items[0].reason, /连接/);
});
