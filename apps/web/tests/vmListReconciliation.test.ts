import assert from "node:assert/strict";
import test from "node:test";
import { createVmListReconciler } from "../src/domain/vmListReconciliation.js";
import type { VmNode, VmsResponse } from "../src/types.js";

function vm(id: string, powerState: VmNode["powerState"]): VmNode {
  return {
    id,
    providerId: id,
    name: `vm-${id}`,
    powerState,
    cpuCount: 2,
    memoryBytes: 2 * 1024 ** 3,
    ipAddresses: [],
  };
}

function response(items: VmNode[]): VmsResponse {
  return {
    collectedAt: "2026-07-28T00:00:00.000Z",
    items,
    page: 1,
    pageSize: 500,
    total: items.length,
  };
}

test("does not resurrect a deleted VM from a stale list response", () => {
  const reconciler = createVmListReconciler();
  const deleted = vm("deleted", "halted");
  const requestRevision = reconciler.currentRevision();
  reconciler.markDeleted(deleted);

  const result = reconciler.reconcile(response([deleted]), [], {}, requestRevision, true);

  assert.deepEqual(result.items, []);
  assert.equal(result.total, 0);
});

test("preserves a row changed after the list request started", () => {
  const reconciler = createVmListReconciler();
  const halted = vm("power", "halted");
  const running = vm("power", "running");
  const requestRevision = reconciler.currentRevision();
  reconciler.markMutation(running);

  const result = reconciler.reconcile(response([halted]), [running], {}, requestRevision, true);

  assert.equal(result.items[0]?.powerState, "running");
});

test("preserves pending, running, and successful operation rows", () => {
  for (const status of ["pending", "running", "success"] as const) {
    const reconciler = createVmListReconciler();
    const current = vm(status, "running");
    const stale = vm(status, "halted");
    const result = reconciler.reconcile(response([stale]), [current], { [status]: { status } }, reconciler.currentRevision(), true);
    assert.equal(result.items[0]?.powerState, "running");
  }
});

test("keeps rows omitted from a background revalidation snapshot", () => {
  const reconciler = createVmListReconciler();
  const current = vm("background", "running");

  const result = reconciler.reconcile(response([]), [current], {}, reconciler.currentRevision(), true);

  assert.deepEqual(result.items, [current]);
});

test("allows a foreground authoritative snapshot to remove an unprotected row", () => {
  const reconciler = createVmListReconciler();
  const current = vm("foreground", "halted");

  const result = reconciler.reconcile(response([]), [current], {}, reconciler.currentRevision(), false);

  assert.deepEqual(result.items, []);
});

test("allows an SSE upsert to restore a tombstoned VM", () => {
  const reconciler = createVmListReconciler();
  const recreated = vm("recreated", "running");
  reconciler.markDeleted(recreated);
  reconciler.clearDeleteTombstone(recreated);
  reconciler.markMutation(recreated);

  const result = reconciler.reconcile(response([recreated]), [recreated], {}, reconciler.currentRevision(), true);

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.powerState, "running");
});

test("expires delete tombstones for later authoritative reconciliation", () => {
  let now = 1_000;
  const reconciler = createVmListReconciler({ tombstoneTtlMs: 100, now: () => now });
  const deleted = vm("expired", "halted");
  reconciler.markDeleted(deleted);
  now += 101;

  const result = reconciler.reconcile(response([deleted]), [], {}, reconciler.currentRevision(), false);

  assert.equal(result.items.length, 1);
});
