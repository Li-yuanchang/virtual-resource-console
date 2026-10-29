import assert from "node:assert/strict";
import test from "node:test";
import {
  isCentosStream9Aarch64,
  resolveProxmoxArmDistribution,
  stripXenSpecificKernelArgs,
} from "../src/proxmoxUnattended.js";
import { buildOfflineCentosKickstart } from "../src/xenserverUnattendedIso.js";
import { isRhel9FamilyImage, isRocky9Image } from "../src/centosKickstart.js";

test("识别的 PVE ARM 发行版覆盖 openEuler / Kylin / CentOS Stream 9", () => {
  assert.equal(resolveProxmoxArmDistribution("CentOS-Stream-9-latest-aarch64-dvd1.iso"), "centos-stream9");
  assert.equal(resolveProxmoxArmDistribution("openEuler-22.03-LTS-SP4-aarch64-dvd.iso"), "openeuler");
  assert.equal(resolveProxmoxArmDistribution("Kylin-Server-V10-SP3-2403-Release-20240426-arm64.iso"), "kylin");
});

test("PVE ARM 不放行 x86_64 与旧世代 CentOS 镜像", () => {
  assert.equal(resolveProxmoxArmDistribution("CentOS-Stream-9-latest-x86_64-dvd1.iso"), undefined);
  assert.equal(resolveProxmoxArmDistribution("CentOS-7-x86_64-DVD-1511.iso"), undefined);
  assert.equal(resolveProxmoxArmDistribution("CentOS-Stream-8-aarch64-dvd1.iso"), undefined);
  assert.equal(resolveProxmoxArmDistribution("Rocky-9.6-aarch64-minimal.iso"), undefined);
});

test("CentOS Stream 9 判定不误伤其它镜像", () => {
  assert.equal(isCentosStream9Aarch64("CentOS-Stream-9-latest-aarch64-dvd1.iso"), true);
  assert.equal(isCentosStream9Aarch64("CentOS-Stream-9-latest-arm64-dvd1.iso"), true);
  assert.equal(isCentosStream9Aarch64("CentOS-9-aarch64-dvd.iso"), true);
  assert.equal(isCentosStream9Aarch64("CentOS-Stream-9-latest-x86_64-dvd1.iso"), false);
  assert.equal(isCentosStream9Aarch64("openEuler-22.03-LTS-SP4-aarch64-dvd.iso"), false);
});

test("RHEL9 语法判定覆盖 CentOS Stream 9，且不与 Xen 专属的 Rocky9 判定混用", () => {
  const centos9 = "CentOS-Stream-9-latest-aarch64-dvd1.iso";
  // 语法层必须按 RHEL9 处理，否则会生成已废弃的 auth 指令并在安装器中硬失败
  assert.equal(isRhel9FamilyImage(centos9), true);
  // Xen 4.4 硬件兼容策略只对 Rocky 9 成立，禁止外溢
  assert.equal(isRocky9Image(centos9), false);

  assert.equal(isRhel9FamilyImage("Rocky-9.6-x86_64-minimal.iso"), true);
  assert.equal(isRhel9FamilyImage("rhel-9.4-x86_64.iso"), true);
  assert.equal(isRhel9FamilyImage("almalinux-9.2-x86_64.iso"), true);
  assert.equal(isRhel9FamilyImage("oraclelinux-9.3-x86_64.iso"), true);
  // 旧世代仍走 CentOS 7 语法
  assert.equal(isRhel9FamilyImage("CentOS-7-x86_64-DVD-1511.iso"), false);
  assert.equal(isRhel9FamilyImage("CentOS-Stream-8-aarch64-dvd1.iso"), false);
  assert.equal(isRhel9FamilyImage("ubuntu-24.04-live-server-arm64.iso"), false);
});

test("CentOS Stream 9 的 PVE Kickstart 使用 RHEL9 语法：无 auth、无 LVM、rootpw --lock", () => {
  const kickstart = stripXenSpecificKernelArgs(
    buildOfflineCentosKickstart(
      {
        vm: { name: "c9", ip: "192.168.127.37", cpu: 8, memoryGiB: 32, diskGiB: 50, rootPassword: "Test#2026" },
        ipPool: {
          id: "p",
          name: "n",
          cidr: "192.168.127.0/24",
          gateway: "192.168.127.254",
          dns: ["202.102.152.3"],
          startHost: 20,
          endHost: 250,
        },
        sourceIsoName: "CentOS-Stream-9-latest-aarch64-dvd1.iso",
      },
      { monitoringTool: "proxmox", firmware: "uefi" },
    ),
  );

  // RHEL9 已删除 auth 指令：残留会让 Anaconda 依赖 authselect-compat 而硬失败
  assert.doesNotMatch(kickstart, /^auth\s/m);
  assert.doesNotMatch(kickstart, /authconfig/);
  // 非 LVM 平铺分区
  assert.doesNotMatch(kickstart, /^logvol/m);
  assert.doesNotMatch(kickstart, /^part pv\.01/m);
  assert.match(kickstart, /^part \/boot\/efi --fstype=efi --size=600/m);
  assert.match(kickstart, /^part \/boot --fstype=xfs --size=1024/m);
  assert.match(kickstart, /^part \/ --fstype=xfs --size=1 --grow/m);
  // root 口令由 %post chpasswd 写入
  assert.match(kickstart, /^rootpw --lock$/m);
  assert.match(kickstart, /chpasswd/);
  assert.doesNotMatch(kickstart, /rootpw --iscrypted/);
  // 静态网络与 PVE 监控代理
  assert.match(kickstart, /network --bootproto=static .*--ip=192\.168\.127\.37/);
  assert.match(kickstart, /qemu-guest-agent/);
});

test("PVE Kickstart 不携带 XenServer 专属内核参数", () => {
  const source = buildOfflineCentosKickstart(
    {
      vm: { name: "c9", ip: "192.168.127.37", cpu: 8, memoryGiB: 32, diskGiB: 50, rootPassword: "Test#2026" },
      ipPool: {
        id: "p",
        name: "n",
        cidr: "192.168.127.0/24",
        gateway: "192.168.127.254",
        dns: ["202.102.152.3"],
        startHost: 20,
        endHost: 250,
      },
      sourceIsoName: "CentOS-Stream-9-latest-aarch64-dvd1.iso",
    },
    { monitoringTool: "proxmox", firmware: "uefi" },
  );
  // 原始 RHEL9 %post 会写入 xen_nopv 等 Xen 4.4 参数
  assert.match(source, /xen_nopv/);

  const stripped = stripXenSpecificKernelArgs(source);
  assert.doesNotMatch(stripped, /xen_nopv/);
  assert.doesNotMatch(stripped, /xen_emul_unplug/);
  assert.doesNotMatch(stripped, /platform:device_id/);
  // 网络命名参数需要保留
  assert.match(stripped, /grubby --update-kernel=ALL --args='net\.ifnames=0 biosdevname=0'/);
});
