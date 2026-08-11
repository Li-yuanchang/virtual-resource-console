import assert from "node:assert/strict";
import test from "node:test";
import {
  buildStartKernelReminder,
  cachedBootEntryKernelCount,
  rememberBootEntryKernelCount,
  type BootEntryStorage,
} from "../src/domain/bootEntryReminder.js";

function memoryStorage(initial: Record<string, string> = {}): BootEntryStorage {
  const data = new Map(Object.entries(initial));
  return {
    getItem(key: string) {
      return data.has(key) ? data.get(key)! : null;
    },
    setItem(key: string, value: string) {
      data.set(key, value);
    },
  };
}

test("remembers and reads back the kernel count for a vm", () => {
  const storage = memoryStorage();
  rememberBootEntryKernelCount("vm-1", 3, storage);
  const hit = cachedBootEntryKernelCount("vm-1", Date.now(), storage);
  assert.ok(hit);
  assert.equal(hit?.count, 3);
});

test("treats invalid or missing counts as no cache", () => {
  const storage = memoryStorage();
  assert.equal(cachedBootEntryKernelCount("vm-1", Date.now(), storage), null);
  rememberBootEntryKernelCount("vm-1", 0, storage);
  rememberBootEntryKernelCount("vm-1", -1, storage);
  assert.equal(cachedBootEntryKernelCount("vm-1", Date.now(), storage), null);
});

test("expires stale kernel counts after the ttl", () => {
  const at = 1_800_000_000_000;
  const storage = memoryStorage({
    "vrc.boot-entry.kernel-counts": JSON.stringify({ "vm-1": { count: 2, at } }),
  });
  assert.ok(cachedBootEntryKernelCount("vm-1", at + 1_000, storage));
  assert.equal(cachedBootEntryKernelCount("vm-1", at + 8 * 24 * 60 * 60 * 1000, storage), null);
});

test("ignores corrupted local cache", () => {
  const storage = memoryStorage({ "vrc.boot-entry.kernel-counts": "not-json{{" });
  assert.equal(cachedBootEntryKernelCount("vm-1", Date.now(), storage), null);
});

test("only appends the kernel reminder when more than one kernel is known", () => {
  const base = "影响范围：会占用目标物理机资源。";
  assert.equal(buildStartKernelReminder(base, null), base);
  assert.equal(buildStartKernelReminder(base, 1), base);
  const reminder = buildStartKernelReminder(base, 3);
  assert.ok(reminder.startsWith(base));
  assert.match(reminder, /3 个启动内核/);
  assert.match(reminder, /按系统默认内核启动/);
});
