import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  buildXenInstalledHook,
  buildXenIpArpProbeScript,
  isXenInstallHostInProvisioningNetwork,
  parseXenIpArpProbeOutput,
  selectXenInstallHostAddress,
  shouldUseXenKickstart,
  summarizeXenProvisioningNetworkProbe,
  xenInstallRebootDirective,
} from "../src/installSourceService.js";
import { buildBastionSshdBlock } from "../src/xenserverUnattendedIso.js";
import type { VmProvisionRequest } from "../src/types.js";

test("physical DVD completion switches to disk boot and prepares guest tools", () => {
  const hook = buildXenInstalledHook("129.20_test");

  // 必须是 dc（硬盘优先）：安装期用的是 cd，切回 dc 才能让重启进入系统盘而不是再次进安装器。
  // 旧断言 /order=c/ 是子串匹配，dc 里的 c 也会通过，因此漏掉了真实缺陷。
  assert.match(hook, /HVM-boot-params:order=dc /);
  assert.match(hook, /guest-tools\.iso/);
  assert.match(hook, /vbd-insert/);
  assert.match(hook, /vrc-install-complete=true/);
  assert.equal(spawnSync("sh", ["-n"], { input: hook, encoding: "utf8" }).status, 0);
});

test("installed boot ejects the installer ISO when no guest-tools media exists", () => {
  // 没有 Tools 光盘时必须弹出安装盘：否则光驱仍挂着安装 ISO，重启会被再次引导进安装器。
  const hook = buildXenInstalledHook("129.20_test");

  assert.match(hook, /elif \[ -n "\$cd_vbd" \]; then/);
  assert.match(hook, /vbd-eject uuid="\$cd_vbd"/);
  assert.equal(spawnSync("sh", ["-n"], { input: hook, encoding: "utf8" }).status, 0);
});

test("physical DVD reboot keeps the host-switched tools media mounted", () => {
  assert.equal(xenInstallRebootDirective("host-dvd"), "reboot");
  assert.equal(xenInstallRebootDirective("iso-library"), "reboot --eject");
});

test("bastion block writes AllowUsers with both the bastion and VRC source", () => {
  // 绑定堡垒机后 sshd 只放行白名单来源；白名单必须含 VRC 自身来源，
  // 否则安装收尾的 SSH 验证会被自己写的限制拦下，任务误判失败。
  const block = buildBastionSshdBlock(["192.168.130.3", "192.168.19.14"]);

  assert.match(block, /AllowUsers \*@192\.168\.130\.3 \*@192\.168\.19\.14/);
  assert.match(block, /UseDNS no/);
  // 只写配置不加锁：VRC 还要用这条通道验证登录，加锁在验证通过后。
  assert.doesNotMatch(block, /chattr \+i/);
  assert.equal(spawnSync("sh", ["-n"], { input: block, encoding: "utf8" }).status, 0);
});

test("bastion block is omitted when no allowlist is configured", () => {
  assert.equal(buildBastionSshdBlock([]), "");
  assert.equal(buildBastionSshdBlock(undefined), "");
});

test("bastion block drops invalid and duplicate addresses", () => {
  const block = buildBastionSshdBlock(["192.168.130.3", "not-an-ip", "999.1.1.1", "", "192.168.19.14", "192.168.130.3"]);

  assert.match(block, /AllowUsers \*@192\.168\.130\.3 \*@192\.168\.19\.14/);
  assert.doesNotMatch(block, /not-an-ip|999\.1\.1\.1/);
});

test("prefers an install-source address in the VM subnet", () => {
  assert.equal(
    selectXenInstallHostAddress(
      [
        { ip: "192.168.2.22", management: true },
        { ip: "192.168.127.10", management: false },
      ],
      "192.168.127.0/24",
      ["192.168.127.31"],
    ),
    "192.168.127.10",
  );
});

test("uses the target XenServer management address when VM and management networks are routed", () => {
  assert.equal(
    selectXenInstallHostAddress(
      [{ ip: "192.168.2.22", management: true }],
      "192.168.127.0/24",
      ["192.168.127.31"],
    ),
    "192.168.2.22",
  );
});

test("skips routed-network probing when the XenServer host already belongs to the VM CIDR", () => {
  assert.equal(isXenInstallHostInProvisioningNetwork("192.168.127.10", "192.168.127.0/24"), true);
  assert.equal(isXenInstallHostInProvisioningNetwork("192.168.2.22", "192.168.127.0/24"), false);
});

test("blocks provisioning when the target XenServer host has no route to the VM network", () => {
  const result = summarizeXenProvisioningNetworkProbe({
    cidr: "192.168.127.0/24",
    sampleIp: "192.168.127.31",
    installHost: "192.168.2.22",
    routeAvailable: false,
    gatewayReachable: false,
  });

  assert.equal(result.status, "unreachable");
  assert.match(result.message, /未找到.*路由/);
});

test("accepts a routed VM network when a configured or occupied address responds", () => {
  const result = summarizeXenProvisioningNetworkProbe({
    cidr: "192.168.127.0/24",
    sampleIp: "192.168.127.31",
    installHost: "192.168.2.22",
    routeAvailable: true,
    gatewayReachable: true,
    respondingTarget: "192.168.127.254",
  });

  assert.equal(result.status, "reachable");
  assert.equal(result.respondingTarget, "192.168.127.254");
});

test("allows provisioning with a warning when routing exists but ICMP is disabled", () => {
  const result = summarizeXenProvisioningNetworkProbe({
    cidr: "192.168.127.0/24",
    sampleIp: "192.168.127.31",
    installHost: "192.168.2.22",
    routeAvailable: true,
    gatewayReachable: false,
  });

  assert.equal(result.status, "route-only");
  assert.match(result.message, /允许继续创建/);
});


test("routes Rocky ISO installs to the XenServer kickstart install source", () => {
  const rocky = {
    providerType: "xenserver",
    sourceType: "iso",
    isoName: "Rocky-9.6-x86_64-minimal.iso",
    isoId: "rocky-9.6",
  } as unknown as VmProvisionRequest;

  assert.equal(shouldUseXenKickstart(rocky), true);
});

test("ARP probe script clears the stale neighbour entry before judging a free address", () => {
  // 回归用例：192.168.2.136 空闲却被判为占用。旧的探测把 ip neigh 的 STALE
  // 当成占用，而 STALE 只是"久未确认"，主机关机后会长期残留。
  const script = buildXenIpArpProbeScript({ candidates: ["192.168.2.136"], probeInterface: "xenbr0" });

  // 必须先删除历史邻居表项，再重新观测，否则历史记录会污染判定。
  assert.match(script, /ip neigh del "\$ip" dev "\$probe_iface"/);
  // 邻居表兜底只认刚建立的强状态，绝不能包含 STALE。
  assert.match(script, /grep -qE "REACHABLE\|DELAY\|PROBE"/);
  assert.doesNotMatch(script, /REACHABLE\|STALE/);
  assert.equal(spawnSync("sh", ["-n"], { input: script, encoding: "utf8" }).status, 0);
});

test("ARP probe script only counts a reply from the probed address itself", () => {
  // 网桥是共享广播域，arping 原始输出可能夹带其他主机的应答；
  // 只匹配 "Unicast reply" 会把空闲地址误判为占用，必须锚定到目标 IP。
  const script = buildXenIpArpProbeScript({ candidates: ["192.168.2.136"], probeInterface: "xenbr0" });

  assert.match(script, /grep -qF "Unicast reply from \$ip"/);
  assert.doesNotMatch(script, /grep -q "Unicast reply"$/m);
  assert.equal(spawnSync("sh", ["-n"], { input: script, encoding: "utf8" }).status, 0);
});

test("ARP probe output treats an unclassified address as skipped rather than occupied", () => {
  assert.deepEqual(parseXenIpArpProbeOutput(""), {
    status: "skipped",
    occupiedIps: [],
    message: "ARP 探测未返回结果，跳过该检查。",
  });
});

test("ARP probe output separates occupied from free addresses", () => {
  assert.deepEqual(parseXenIpArpProbeOutput("OCCUPIED\t192.168.2.66\nFREE\t192.168.2.136\n"), {
    status: "checked",
    occupiedIps: ["192.168.2.66"],
  });
});

test("ARP probe output reports a free address as available", () => {
  assert.deepEqual(parseXenIpArpProbeOutput("FREE\t192.168.2.136\n"), {
    status: "checked",
    occupiedIps: [],
  });
});

test("keeps non-RHEL ISO installs off the kickstart install source", () => {
  const windows = {
    providerType: "xenserver",
    sourceType: "iso",
    isoName: "windows_server_2012_r2.iso",
    isoId: "win-2012",
  } as unknown as VmProvisionRequest;

  assert.equal(shouldUseXenKickstart(windows), false);
});
