import assert from "node:assert/strict";
import test from "node:test";
import { buildIpLeasePreflightResult, buildIpReachabilityPreflightResult } from "../src/provisioningPreflight.js";

test("blocks VM creation when a candidate IP responds to ping", () => {
  assert.deepEqual(buildIpReachabilityPreflightResult(["192.168.2.33"]), {
    status: "error",
    message: "以下 IP ping 有响应，禁止创建：192.168.2.33",
  });
});

test("accepts candidate IPs only when none respond", () => {
  assert.deepEqual(buildIpReachabilityPreflightResult([]), {
    status: "success",
    message: "目标 IP ping 无响应",
  });
});

test("accepts an IP lease owned by the same create-plan VM", () => {
  assert.deepEqual(
    buildIpLeasePreflightResult(
      [{ ip: "192.168.2.234", name: "2.234_windows-unattended-test" }],
      [{ ip: "192.168.2.234", vmName: "2.234_windows-unattended-test" }],
    ),
    {
      status: "success",
      message: "已确认当前创建计划的 IP 预留：1 个",
    },
  );
});

test("blocks an IP lease owned by another VM", () => {
  assert.deepEqual(
    buildIpLeasePreflightResult(
      [{ ip: "192.168.2.234", name: "2.234_windows-unattended-test" }],
      [{ ip: "192.168.2.234", vmName: "existing-vm" }],
    ),
    {
      status: "error",
      message: "本地已预留：192.168.2.234：existing-vm",
    },
  );
});
