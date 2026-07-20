import assert from "node:assert/strict";
import test from "node:test";
import { vmPowerActionRowPatch } from "../src/domain/vmPowerState.js";

test("shutdown immediately records the operation time in the VM row", () => {
  assert.deepEqual(vmPowerActionRowPatch("shutdown", "2026-07-19T05:00:00.000Z"), {
    powerState: "halted",
    lastShutdownAt: "2026-07-19T05:00:00.000Z",
  });
});

test("start and reboot immediately clear the active shutdown time", () => {
  assert.deepEqual(vmPowerActionRowPatch("start", "2026-07-19T05:10:00.000Z"), {
    powerState: "running",
    lastShutdownAt: null,
  });
  assert.deepEqual(vmPowerActionRowPatch("forceReboot", "2026-07-19T05:20:00.000Z"), {
    powerState: "running",
    lastShutdownAt: null,
  });
});
