import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { readLocalJsonConfig, resolveVrcConfigPath, writeLocalJsonConfig } from "../src/localConfigFile.js";

test("resolves a business-specific file override before the shared VRC data directory", () => {
  const previousDataDir = process.env.VRC_DATA_DIR;
  const previousConfigFile = process.env.VRC_TEST_CONFIG_FILE;
  try {
    process.env.VRC_DATA_DIR = join("runtime", "vrc-data");
    process.env.VRC_TEST_CONFIG_FILE = join("runtime", "custom", "test.json");

    assert.equal(resolveVrcConfigPath("test.json", "VRC_TEST_CONFIG_FILE"), resolve("runtime", "custom", "test.json"));
    delete process.env.VRC_TEST_CONFIG_FILE;
    assert.equal(resolveVrcConfigPath("test.json", "VRC_TEST_CONFIG_FILE"), join(resolve("runtime", "vrc-data"), "test.json"));
  } finally {
    restoreEnvironmentVariable("VRC_DATA_DIR", previousDataDir);
    restoreEnvironmentVariable("VRC_TEST_CONFIG_FILE", previousConfigFile);
  }
});

test("uses configured fallback behavior for missing and invalid JSON files", () => {
  const rootDir = mkdtempSync(join(tmpdir(), "vrc-local-config-"));
  const filePath = join(rootDir, "settings.json");
  try {
    assert.deepEqual(
      readLocalJsonConfig({
        filePath,
        label: "测试配置",
        normalize: (input) => input,
        onMissing: () => ({ enabled: false }),
      }),
      { enabled: false },
    );

    writeFileSync(filePath, "{invalid-json", "utf8");
    assert.deepEqual(
      readLocalJsonConfig({
        filePath,
        label: "测试配置",
        normalize: (input) => input,
        onInvalid: () => ({ enabled: true }),
      }),
      { enabled: true },
    );
    assert.throws(
      () =>
        readLocalJsonConfig({
          filePath,
          label: "测试配置",
          normalize: (input) => input,
        }),
      /测试配置文件格式不正确/,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("writes and replaces JSON without leaving temporary or backup files", () => {
  const rootDir = mkdtempSync(join(tmpdir(), "vrc-local-config-"));
  const filePath = join(rootDir, "nested", "settings.json");
  try {
    writeLocalJsonConfig(filePath, { version: 1, enabled: false });
    assert.equal(existsSync(filePath), true);
    assert.deepEqual(JSON.parse(readFileSync(filePath, "utf8")), { version: 1, enabled: false });

    writeLocalJsonConfig(filePath, { version: 2, enabled: true });
    assert.deepEqual(JSON.parse(readFileSync(filePath, "utf8")), { version: 2, enabled: true });
    assert.deepEqual(readdirSync(join(rootDir, "nested")), ["settings.json"]);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function restoreEnvironmentVariable(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
