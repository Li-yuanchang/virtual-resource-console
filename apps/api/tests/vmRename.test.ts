import assert from "node:assert/strict";
import test from "node:test";
import {
  assertVmRenameCurrentName,
  assertVmRenameNameAvailable,
  normalizeVmRenameInput,
  VmRenameConflictError,
  VmRenameValidationError,
} from "../src/vmRename.js";

test("normalizes XenServer and VMware display names", () => {
  assert.deepEqual(normalizeVmRenameInput("xenserver", " old-vm ", " new-vm "), {
    currentName: "old-vm",
    newName: "new-vm",
  });
  assert.deepEqual(normalizeVmRenameInput("vmware", "prod-api-01", "prod-api-primary"), {
    currentName: "prod-api-01",
    newName: "prod-api-primary",
  });
});

test("rejects unchanged, empty, overlong, and control-character names", () => {
  assert.throws(() => normalizeVmRenameInput("xenserver", "vm-01", "vm-01"), VmRenameValidationError);
  assert.throws(() => normalizeVmRenameInput("vmware", "vm-01", "   "), VmRenameValidationError);
  assert.throws(() => normalizeVmRenameInput("vmware", "vm-01", "x".repeat(81)), VmRenameValidationError);
  assert.throws(() => normalizeVmRenameInput("xenserver", "vm-01", "new\nname"), VmRenameValidationError);
});

test("enforces Proxmox VE dns-name rules", () => {
  assert.equal(normalizeVmRenameInput("proxmox", "vm-301", "ops-monitor-01").newName, "ops-monitor-01");
  assert.throws(() => normalizeVmRenameInput("proxmox", "vm-301", "运维监控"), VmRenameValidationError);
  assert.throws(() => normalizeVmRenameInput("proxmox", "vm-301", "-ops-monitor"), VmRenameValidationError);
  assert.throws(() => normalizeVmRenameInput("proxmox", "vm-301", "ops_monitor"), VmRenameValidationError);
});

test("rejects unsupported libvirt rename", () => {
  assert.throws(() => normalizeVmRenameInput("libvirt", "vm-01", "vm-02"), VmRenameValidationError);
});

test("detects concurrent changes and provider-scope duplicates", () => {
  assert.doesNotThrow(() => assertVmRenameCurrentName("vm-01", "vm-01"));
  assert.throws(() => assertVmRenameCurrentName("vm-02", "vm-01"), VmRenameConflictError);
  assert.doesNotThrow(() => assertVmRenameNameAvailable(false, "当前资源池", "vm-02"));
  assert.throws(() => assertVmRenameNameAvailable(true, "当前资源池", "vm-02"), VmRenameConflictError);
});
