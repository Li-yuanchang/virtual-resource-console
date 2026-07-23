import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { VmSystemCredentialStore } from "../src/vmSystemCredentialStore.js";

test("stores VM system credentials encrypted in the local VRC data directory", () => {
  const rootDir = mkdtempSync(join(tmpdir(), "vrc-system-credentials-"));
  try {
    const store = new VmSystemCredentialStore(rootDir);
    store.save("connection-1", "vm-1", {
      username: "root",
      password: "secret-password",
      jump: {
        host: "192.0.2.15",
        port: 22,
        username: "jump-user",
        password: "jump-password",
      },
    });

    assert.deepEqual(store.get("connection-1", "vm-1"), {
      username: "root",
      password: "secret-password",
      jump: {
        host: "192.0.2.15",
        port: 22,
        username: "jump-user",
        password: "jump-password",
      },
    });
    const file = readFileSync(join(rootDir, "vm-system-credentials.json"), "utf8");
    assert.doesNotMatch(file, /secret-password|jump-password|192\.0\.2\.15|jump-user|\"root\"/);
    assert.equal(store.get("connection-1", "vm-2"), undefined);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("updates and deletes credentials within one connection and VM scope", () => {
  const rootDir = mkdtempSync(join(tmpdir(), "vrc-system-credentials-"));
  try {
    const store = new VmSystemCredentialStore(rootDir);
    store.save("connection-1", "vm-1", { username: "root", password: "first" });
    store.save("connection-1", "vm-1", { username: "ops", password: "second" });

    assert.deepEqual(store.get("connection-1", "vm-1"), { username: "ops", password: "second" });
    assert.equal(store.delete("connection-1", "vm-1"), true);
    assert.equal(store.get("connection-1", "vm-1"), undefined);
    assert.equal(store.delete("connection-1", "vm-1"), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
