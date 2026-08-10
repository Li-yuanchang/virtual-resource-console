import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AuditStore, redactAuditRequest } from "../src/auditStore.js";

test("redacts sensitive fields recursively including nested arrays", () => {
  const payload = {
    host: "192.168.1.10",
    username: "root",
    password: "secret-1",
    rootPassword: "secret-2",
    csrf: "csrf-token",
    token: "abc",
    planItems: [{ rootPassword: "secret-3", cpu: 2 }],
    leases: [{ guestStorage: { username: "admin", password: "secret-4" }, ip: "10.0.0.1" }],
    systemCredentials: { username: "admin", password: "secret-5" },
    keep: "visible",
  };
  const redacted = redactAuditRequest(payload) as Record<string, unknown>;
  assert.equal(redacted.password, "***");
  assert.equal(redacted.rootPassword, "***");
  assert.equal(redacted.csrf, "***");
  assert.equal(redacted.token, "***");
  assert.equal(redacted.keep, "visible");
  assert.equal((redacted.planItems as Array<Record<string, unknown>>)[0]?.rootPassword, "***");
  assert.equal((redacted.leases as Array<Record<string, unknown>>)[0]?.guestStorage, "***");
  assert.equal((redacted.systemCredentials as Record<string, unknown>), "***");
});

test("redactAuditRequest passes through scalars and arrays", () => {
  assert.equal(redactAuditRequest("plain"), "plain");
  assert.deepEqual(redactAuditRequest(["a", { password: "x" }]), ["a", { password: "***" }]);
});

test("AuditStore records, lists newest-first and filters by status and keyword", () => {
  const dir = mkdtempSync(join(tmpdir(), "vrc-audit-test-"));
  const file = join(dir, "audit-log.json");
  const store = new AuditStore(file);
  try {
    store.record({ title: "开机 VM-1", status: "success", action: "vm.start", target: "VM-1" });
    store.record({ title: "删除连接", status: "error", action: "connection.delete", target: "测试连接" });
    store.record({ title: "改名 VM-2", status: "success", action: "vm.rename", target: "VM-2" });

    const all = store.list();
    assert.equal(all.length, 3);
    assert.equal(all[0]?.title, "改名 VM-2");

    const errors = store.list({ status: "error" });
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.action, "connection.delete");

    const matched = store.list({ keyword: "VM-1" });
    assert.equal(matched.length, 1);
    assert.equal(matched[0]?.title, "开机 VM-1");

    const limited = store.list({ limit: 2 });
    assert.equal(limited.length, 2);
    assert.equal(store.count(), 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AuditStore persists records to disk and reloads them", () => {
  const dir = mkdtempSync(join(tmpdir(), "vrc-audit-test-"));
  const file = join(dir, "audit-log.json");
  const first = new AuditStore(file);
  first.record({ title: "清理介质", status: "success", action: "maintenance.cleanup", target: "iso-1" });
  const second = new AuditStore(file);
  try {
    assert.equal(second.count(), 1);
    assert.equal(second.list()[0]?.title, "清理介质");
    const raw = JSON.parse(readFileSync(file, "utf8")) as { version: number; entries: unknown[] };
    assert.equal(raw.version, 1);
    assert.ok(Array.isArray(raw.entries));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AuditStore caps entries at the maximum and drops the oldest", () => {
  const dir = mkdtempSync(join(tmpdir(), "vrc-audit-test-"));
  const file = join(dir, "audit-log.json");
  const store = new AuditStore(file);
  try {
    for (let index = 0; index < 2020; index += 1) {
      store.record({ title: `记录-${index}` });
    }
    assert.equal(store.count(), 2000);
    const all = store.list();
    assert.equal(all[0]?.title, "记录-2019");
    assert.ok(!all.some((entry) => entry.title === "记录-0"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
