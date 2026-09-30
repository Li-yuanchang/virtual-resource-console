import assert from "node:assert/strict";
import test from "node:test";
import { buildIpArpConflictPreflightResult, buildIpLeasePreflightResult, buildIpReachabilityPreflightResult } from "../src/provisioningPreflight.js";

test("blocks VM creation when a candidate IP responds to ping", () => {
  assert.deepEqual(buildIpReachabilityPreflightResult(["192.168.2.33"]), {
    status: "error",
    message: "以下 IP ping 有响应，禁止创建：192.168.2.33",
  });
});

test("accepts candidate IPs only when none respond", () => {
  assert.deepEqual(buildIpReachabilityPreflightResult([]), {
    status: "success",
    // 不响应 ping 只说明没有 ICMP 回包，不能证明地址空闲。
    message: "目标 IP 无 ICMP 响应（不代表地址空闲，二层占用另由 ARP 检查判定）",
  });
});

test("blocks creation when a candidate IP answers ARP even though it ignores ICMP", () => {
  // 回归用例：192.168.2.66 曾被其他虚拟化平台的 guest 占用，该设备不响应 ping，
  // 旧的 ICMP 检查判定为空闲，导致无人值守安装走进 IP 冲突并在 %post 阶段失败。
  assert.deepEqual(
    buildIpArpConflictPreflightResult({ status: "checked", occupiedIps: ["192.168.2.66"], message: "" }),
    {
      status: "error",
      message: "以下 IP 在二层已被占用（ARP 有应答），禁止创建：192.168.2.66",
    },
  );
});

test("accepts a free address whose only neighbour-table trace is a stale entry", () => {
  // 回归用例：2.136 空闲却被拦截。旧探测把 ip neigh 的 STALE 当作占用，
  // 而 STALE 只表示"久未确认"，主机关机/下线后会长期残留，必须视为空闲。
  // 该用例锁定的是探测脚本的判定契约：只有 ARP 实测应答才算占用。
  assert.deepEqual(
    buildIpArpConflictPreflightResult({ status: "checked", occupiedIps: [], message: "" }),
    { status: "success", message: "候选 IP 二层无应答" },
  );
});

test("accepts candidate IPs when the ARP probe sees no reply", () => {
  assert.deepEqual(
    buildIpArpConflictPreflightResult({ status: "checked", occupiedIps: [], message: "" }),
    { status: "success", message: "候选 IP 二层无应答" },
  );
});

test("does not block creation when the ARP probe is unavailable", () => {
  // 宿主 arping 缺失或 SSH 抖动时退化为仅 ICMP 判定，不应阻断创建。
  assert.deepEqual(
    buildIpArpConflictPreflightResult({ status: "skipped", occupiedIps: [], message: "ARP 探测未返回结果，跳过该检查。" }),
    { status: "success", message: "ARP 探测未返回结果，跳过该检查。" },
  );
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
