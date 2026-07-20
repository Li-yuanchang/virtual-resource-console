import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { VmNode } from "../src/types.js";

const testDataDir = mkdtempSync(join(tmpdir(), "vrc-power-state-"));
process.env.VRC_DATA_DIR = testDataDir;
const { observeVmPowerStates, recordVmShutdown, recordVmStarted, removeVmPowerState } = await import("../src/vmPowerStateStore.js");

test.after(() => rmSync(testDataDir, { recursive: true, force: true }));

test("does not invent history for a VM first observed as halted", () => {
  const [vm] = observeVmPowerStates("connection-a", [createVm("vm-1", "halted")], "2026-07-18T01:00:00.000Z");
  assert.equal(vm?.lastShutdownAt, undefined);
});

test("records an observed running-to-halted transition and clears it after restart", () => {
  observeVmPowerStates("connection-a", [createVm("vm-2", "running")], "2026-07-18T01:00:00.000Z");
  const [halted] = observeVmPowerStates("connection-a", [createVm("vm-2", "halted")], "2026-07-18T02:00:00.000Z");
  assert.equal(halted?.lastShutdownAt, "2026-07-18T02:00:00.000Z");

  const [restarted] = observeVmPowerStates("connection-a", [createVm("vm-2", "running")], "2026-07-18T03:00:00.000Z");
  assert.equal(restarted?.lastShutdownAt, undefined);
});

test("clears an exact VRC shutdown timestamp immediately after a successful start", () => {
  recordVmShutdown("connection-a", "vm-4", "2026-07-18T05:00:00.000Z");
  recordVmStarted("connection-a", "vm-4", "2026-07-18T05:10:00.000Z");

  const [running] = observeVmPowerStates("connection-a", [createVm("vm-4", "running")], "2026-07-18T05:11:00.000Z");
  assert.equal(running?.lastShutdownAt, undefined);
});

test("records successful VRC shutdowns exactly and removes deleted VM history", () => {
  recordVmShutdown("connection-a", "vm-3", "2026-07-18T04:00:00.000Z");
  const [halted] = observeVmPowerStates("connection-a", [createVm("vm-3", "halted")], "2026-07-18T04:01:00.000Z");
  assert.equal(halted?.lastShutdownAt, "2026-07-18T04:00:00.000Z");

  removeVmPowerState("connection-a", "vm-3");
  const persisted = JSON.parse(readFileSync(join(testDataDir, "vm-power-states.json"), "utf8")) as { records: Array<{ vmId: string }> };
  assert.equal(persisted.records.some((record) => record.vmId === "vm-3"), false);
});

function createVm(providerId: string, powerState: VmNode["powerState"]): VmNode {
  return {
    id: `connection-a:vm:${providerId}`,
    connectionId: "connection-a",
    providerId,
    name: providerId,
    powerState,
    cpuCount: 1,
    memoryBytes: 1024,
    ipAddresses: [],
    toolsStatus: "unknown",
    reclaimLevel: "P3",
    reclaimReason: "",
  };
}
