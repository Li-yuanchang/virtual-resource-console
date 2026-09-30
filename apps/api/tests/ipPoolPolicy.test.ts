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

test("defaults bastion binding to enabled for legacy config files", () => {
  // 旧配置文件不含 bastion 字段：应按默认开启处理，避免升级后默默失效。
  const dataDir = mkdtempSync(join(tmpdir(), "vrc-bastion-"));
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
          { id: "p", name: "n", prefix: "192.168.2", gateway: "192.168.2.254", startHost: 30, endHost: 250 },
        ],
      })}\n`,
    );

    const policy = getIpPoolPolicy();

    assert.equal(policy.bastionAccessEnabled, true);
    assert.deepEqual(policy.bastionAllowFrom, []);
  } finally {
    if (previousDataDir === undefined) delete process.env.VRC_DATA_DIR;
    else process.env.VRC_DATA_DIR = previousDataDir;
    if (previousPoolsFile === undefined) delete process.env.VRC_IP_POOLS_FILE;
    else process.env.VRC_IP_POOLS_FILE = previousPoolsFile;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("rejects a bastion allowlist entry that is not an IPv4 address", () => {
  // 非法地址写进 sshd 会把白名单弄坏，必须在保存前报错。
  const dataDir = mkdtempSync(join(tmpdir(), "vrc-bastion-bad-"));
  const previousDataDir = process.env.VRC_DATA_DIR;
  try {
    process.env.VRC_DATA_DIR = dataDir;
    assert.throws(
      () =>
        saveIpPoolPolicy({
          defaultDns: ["202.102.152.3"],
          bastionAccessEnabled: true,
          bastionAllowFrom: ["192.168.130.3", "not-an-ip"],
          ipPools: [
            { id: "p", name: "n", prefix: "192.168.2", gateway: "192.168.2.254", startHost: 30, endHost: 250 },
          ],
        }),
      /\u767d\u540d\u5355\u683c\u5f0f\u4e0d\u6b63\u786e/,
    );
  } finally {
    if (previousDataDir === undefined) delete process.env.VRC_DATA_DIR;
    else process.env.VRC_DATA_DIR = previousDataDir;
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
