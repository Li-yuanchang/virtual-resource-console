import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { getVrcDataDir, getVrcDataFile } from "../src/appPaths.js";

test("resolves VRC data files from the runtime-provided cross-platform directory", () => {
  const previous = process.env.VRC_DATA_DIR;
  try {
    process.env.VRC_DATA_DIR = join("runtime", "vrc-user-data");
    assert.equal(getVrcDataDir(), resolve("runtime", "vrc-user-data"));
    assert.equal(getVrcDataFile("vm-system-credentials.json"), join(resolve("runtime", "vrc-user-data"), "vm-system-credentials.json"));
  } finally {
    if (previous === undefined) delete process.env.VRC_DATA_DIR;
    else process.env.VRC_DATA_DIR = previous;
  }
});

test("falls back to the current operating system user home outside Electron", () => {
  const previous = process.env.VRC_DATA_DIR;
  try {
    delete process.env.VRC_DATA_DIR;
    assert.equal(getVrcDataDir(), join(homedir(), ".virtual-resource-console"));
  } finally {
    if (previous === undefined) delete process.env.VRC_DATA_DIR;
    else process.env.VRC_DATA_DIR = previous;
  }
});
