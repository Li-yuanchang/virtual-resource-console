import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProvisionExecutionStore, type ProvisionExecutionContext } from "../src/provisionExecutionStore.js";
import { resolveProvisionHardWaitMs } from "../src/provisioningVerifier.js";

function executionContext(): ProvisionExecutionContext {
  const now = new Date().toISOString();
  return {
    taskId: "task-1",
    connectionId: "connection-1",
    providerType: "xenserver",
    request: {
      providerType: "xenserver",
      connectionId: "connection-1",
      sourceType: "iso",
      isoId: "iso-1",
      vmNamePrefix: "vm",
      count: 1,
      autoStart: true,
      ipPool: {
        id: "pool-1",
        name: "test",
        cidr: "192.168.127.0/24",
        gateway: "192.168.127.254",
        dns: ["202.102.152.3"],
        startIp: "192.168.127.20",
        endIp: "192.168.127.250",
        reservedIps: [],
      },
      planItems: [{ name: "127.31_test", ip: "192.168.127.31", rootPassword: "root@127.31", cpu: 4, memoryGiB: 8, diskGiB: 100 }],
    },
    createdAt: now,
    updatedAt: now,
  };
}

test("provision execution context is encrypted and can be restored", () => {
  const rootDir = mkdtempSync(join(tmpdir(), "vrc-provision-store-"));
  try {
    const store = new ProvisionExecutionStore(rootDir);
    store.save(executionContext());
    const raw = readFileSync(join(rootDir, "provision-executions.json"), "utf8");
    assert.equal(raw.includes("root@127.31"), false);
    assert.equal(store.get("task-1")?.request.planItems[0].rootPassword, "root@127.31");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("provision execution context is updated and deleted by task ID", () => {
  const rootDir = mkdtempSync(join(tmpdir(), "vrc-provision-store-"));
  try {
    const store = new ProvisionExecutionStore(rootDir);
    const context = executionContext();
    store.save(context);
    store.save({ ...context, created: [{ id: "vm-1", providerId: "vm-1", name: "127.31_test", powerState: "running" }] });
    assert.equal(store.list().length, 1);
    assert.equal(store.get("task-1")?.created?.[0].providerId, "vm-1");
    assert.equal(store.delete("task-1"), true);
    assert.equal(store.get("task-1"), undefined);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("provision hard wait is opt-in and parsed as hours", () => {
  assert.equal(resolveProvisionHardWaitMs(undefined), undefined);
  assert.equal(resolveProvisionHardWaitMs("0"), undefined);
  assert.equal(resolveProvisionHardWaitMs("invalid"), undefined);
  assert.equal(resolveProvisionHardWaitMs("2"), 2 * 60 * 60 * 1000);
});
