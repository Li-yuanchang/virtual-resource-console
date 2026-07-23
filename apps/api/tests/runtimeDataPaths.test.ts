import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("stores local configuration and encrypted connection data under VRC_DATA_DIR", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "vrc-runtime-data-"));
  const previousDataDir = process.env.VRC_DATA_DIR;
  try {
    process.env.VRC_DATA_DIR = dataDir;
    const [{ saveUiPreferences }, { saveProvisioningConfig }, { saveStoredConnection }] = await Promise.all([
      import("../src/uiPreferenceStore.js"),
      import("../src/provisioningStore.js"),
      import("../src/connectionStore.js"),
    ]);

    saveUiPreferences({ theme: "mist-teal" });
    saveProvisioningConfig({});
    saveStoredConnection({
      name: "path-test",
      providerType: "xenserver",
      host: "192.0.2.10",
      port: 22,
      username: "root",
      password: "temporary-test-value",
    });

    assert.equal(existsSync(join(dataDir, "preferences.json")), true);
    assert.equal(existsSync(join(dataDir, "provisioning.json")), true);
    assert.equal(existsSync(join(dataDir, "connections.json")), true);
    assert.equal(existsSync(join(dataDir, "key.bin")), true);
  } finally {
    if (previousDataDir === undefined) delete process.env.VRC_DATA_DIR;
    else process.env.VRC_DATA_DIR = previousDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  }
});
