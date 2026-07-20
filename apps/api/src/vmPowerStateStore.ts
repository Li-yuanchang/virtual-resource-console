import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getVrcDataFile } from "./appPaths.js";
import type { PowerState, VmNode } from "./types.js";

interface VmPowerStateRecord {
  scopeKey: string;
  vmId: string;
  lastPowerState: PowerState;
  lastShutdownAt?: string;
  updatedAt: string;
}

interface VmPowerStateStoreFile {
  version: 1;
  records: VmPowerStateRecord[];
}

const storeFile = getVrcDataFile("vm-power-states.json");

/**
 * Adds the active shutdown timestamp to halted inventory rows and records running-to-halted transitions.
 * A VM first discovered as halted is not assigned a fabricated time, and any running observation clears stale history.
 */
export function observeVmPowerStates(scopeKey: string, vms: VmNode[], observedAt = new Date().toISOString()): VmNode[] {
  const store = readStore();
  const records = new Map(store.records.map((record) => [recordKey(record.scopeKey, record.vmId), record]));
  let changed = false;

  const decorated = vms.map((vm) => {
    const key = recordKey(scopeKey, vm.providerId);
    const current = records.get(key);
    const transitionedToHalted = current?.lastPowerState === "running" && isHalted(vm.powerState);
    const lastShutdownAt = vm.powerState === "running" ? undefined : transitionedToHalted ? observedAt : current?.lastShutdownAt;
    if (!current || current.lastPowerState !== vm.powerState || current.lastShutdownAt !== lastShutdownAt) {
      records.set(key, {
        scopeKey,
        vmId: vm.providerId,
        lastPowerState: vm.powerState,
        lastShutdownAt,
        updatedAt: observedAt,
      });
      changed = true;
    }
    const { lastShutdownAt: _providerShutdownAt, ...vmWithoutShutdownAt } = vm;
    return lastShutdownAt ? { ...vmWithoutShutdownAt, lastShutdownAt } : vmWithoutShutdownAt;
  });

  if (changed) writeStore({ version: 1, records: Array.from(records.values()) });
  return decorated;
}

/** Records an exact successful shutdown initiated through VRC. */
export function recordVmShutdown(scopeKey: string, vmId: string, shutdownAt = new Date().toISOString()): void {
  const store = readStore();
  const records = new Map(store.records.map((record) => [recordKey(record.scopeKey, record.vmId), record]));
  records.set(recordKey(scopeKey, vmId), {
    scopeKey,
    vmId,
    lastPowerState: "halted",
    lastShutdownAt: shutdownAt,
    updatedAt: shutdownAt,
  });
  writeStore({ version: 1, records: Array.from(records.values()) });
}

/** Clears the active shutdown timestamp after a successful start or reboot initiated through VRC. */
export function recordVmStarted(scopeKey: string, vmId: string, startedAt = new Date().toISOString()): void {
  const store = readStore();
  const records = new Map(store.records.map((record) => [recordKey(record.scopeKey, record.vmId), record]));
  records.set(recordKey(scopeKey, vmId), {
    scopeKey,
    vmId,
    lastPowerState: "running",
    updatedAt: startedAt,
  });
  writeStore({ version: 1, records: Array.from(records.values()) });
}

/** Removes state history after the VM has been deleted. */
export function removeVmPowerState(scopeKey: string, vmId: string): void {
  const store = readStore();
  const records = store.records.filter((record) => record.scopeKey !== scopeKey || record.vmId !== vmId);
  if (records.length !== store.records.length) writeStore({ version: 1, records });
}

function isHalted(value: PowerState): boolean {
  return value === "halted" || value === "stopped";
}

function recordKey(scopeKey: string, vmId: string): string {
  return `${scopeKey}\u0000${vmId}`;
}

function readStore(): VmPowerStateStoreFile {
  if (!existsSync(storeFile)) return { version: 1, records: [] };
  try {
    const parsed = JSON.parse(readFileSync(storeFile, "utf8")) as Partial<VmPowerStateStoreFile>;
    return {
      version: 1,
      records: Array.isArray(parsed.records) ? parsed.records.filter(isValidRecord) : [],
    };
  } catch {
    return { version: 1, records: [] };
  }
}

function isValidRecord(value: unknown): value is VmPowerStateRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<VmPowerStateRecord>;
  return Boolean(record.scopeKey && record.vmId && record.lastPowerState && record.updatedAt);
}

function writeStore(store: VmPowerStateStoreFile): void {
  mkdirSync(dirname(storeFile), { recursive: true, mode: 0o700 });
  writeFileSync(storeFile, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}
