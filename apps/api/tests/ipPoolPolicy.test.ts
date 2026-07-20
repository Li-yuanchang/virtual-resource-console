import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getIpPoolPolicy, saveIpPoolPolicy } from "../src/ipPoolPolicy.js";

test("preserves imported IP pool gateway values", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "vrc-ip-pools-"));
  const previousDataDir = process.env.VRC_DATA_DIR;
  const previousPoolsFile = process.env.VRC_IP_POOLS_FILE;
  try {
    delete process.env.VRC_IP_POOLS_FILE;
    process.env.VRC_DATA_DIR = dataDir;
    writeFileSync(
      join(dataDir, "ip-pools.json"),
      `${JSON.stringify({
        defaultDns: ["202.102.152.3"],
        ipPools: [
          {
            id: "pool-192-168-127",
            name: "192.168.127 通用网段",
            prefix: "192.168.127",
            gateway: "192.168.127.1",
            startHost: 20,
            endHost: 250,
          },
        ],
      })}\n`,
    );

    const policy = getIpPoolPolicy();

    assert.equal(policy.ipPools[0].gateway, "192.168.127.1");
  } finally {
    if (previousDataDir === undefined) {
      delete process.env.VRC_DATA_DIR;
    } else {
      process.env.VRC_DATA_DIR = previousDataDir;
    }
    if (previousPoolsFile === undefined) {
      delete process.env.VRC_IP_POOLS_FILE;
    } else {
      process.env.VRC_IP_POOLS_FILE = previousPoolsFile;
    }
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("rejects invalid IP pool policy before storing it", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "vrc-ip-pools-"));
  const previousDataDir = process.env.VRC_DATA_DIR;
  const previousPoolsFile = process.env.VRC_IP_POOLS_FILE;
  try {
    delete process.env.VRC_IP_POOLS_FILE;
    process.env.VRC_DATA_DIR = dataDir;

    assert.throws(
      () =>
        saveIpPoolPolicy({
          defaultDns: ["202.102.152.3"],
          ipPools: [
            {
              id: "pool-192-168-127",
              name: "192.168.127 通用网段",
              prefix: "192.168.127",
              gateway: "192.168.2.254",
              startHost: 20,
              endHost: 250,
            },
          ],
        }),
      /网关必须属于本网段/,
    );
  } finally {
    if (previousDataDir === undefined) {
      delete process.env.VRC_DATA_DIR;
    } else {
      process.env.VRC_DATA_DIR = previousDataDir;
    }
    if (previousPoolsFile === undefined) {
      delete process.env.VRC_IP_POOLS_FILE;
    } else {
      process.env.VRC_IP_POOLS_FILE = previousPoolsFile;
    }
    rmSync(dataDir, { recursive: true, force: true });
  }
});
