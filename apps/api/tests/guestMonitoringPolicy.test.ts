import assert from "node:assert/strict";
import test from "node:test";
import { resolveGuestMonitoringPolicy } from "../src/guestMonitoringPolicy.js";
import { buildOfflineCentosKickstart } from "../src/xenserverUnattendedIso.js";
import { buildGuestSshAlgorithms, buildXenToolsGuestInstallCommand } from "../src/provisioningVerifier.js";

test("selects provider-specific guest monitoring tools", () => {
  assert.equal(resolveGuestMonitoringPolicy("xenserver").hostPreparation, "xen-tools-iso");
  assert.equal(resolveGuestMonitoringPolicy("proxmox").packageName, "qemu-guest-agent");
  assert.equal(resolveGuestMonitoringPolicy("proxmox").platformVerification, "pve-agent");
  assert.equal(resolveGuestMonitoringPolicy("vmware").packageName, "open-vm-tools");
  assert.equal(resolveGuestMonitoringPolicy("vmware").platformVerification, "vmware-tools");
});

test("monitoring package commands install, enable and verify the process", () => {
  const pveCommand = resolveGuestMonitoringPolicy("proxmox").guestInstallCommand ?? "";
  assert.match(pveCommand, /dnf -y install/);
  assert.match(pveCommand, /systemctl enable/);
  assert.match(pveCommand, /systemctl restart --no-block/);
  assert.match(pveCommand, /systemctl is-active --quiet/);
  assert.match(pveCommand, /pgrep/);
});

test("embeds platform monitoring packages into unattended kickstart", () => {
  const input = {
    vm: { name: "test", ip: "192.168.2.30", rootPassword: "secret", cpu: 2, memoryGiB: 4, diskGiB: 40 },
    ipPool: {
      id: "pool",
      name: "pool",
      cidr: "192.168.2.0/24",
      gateway: "192.168.2.254",
      dns: ["202.102.152.3"],
      startIp: "192.168.2.20",
      endIp: "192.168.2.250",
      reservedIps: [],
    },
  };
  const pveKickstart = buildOfflineCentosKickstart(input, { monitoringTool: "proxmox" });
  const vmwareKickstart = buildOfflineCentosKickstart(input, { monitoringTool: "vmware" });
  assert.match(pveKickstart, /qemu-guest-agent/);
  assert.match(vmwareKickstart, /open-vm-tools/);
  assert.match(pveKickstart, /%packages --ignoremissing/);
  assert.doesNotMatch(pveKickstart, /cloud-utils-growpart/);
});

test("builds an EFI-aware kickstart for Proxmox ARM guests", () => {
  const input = {
    vm: { name: "test", ip: "192.168.2.30", rootPassword: "secret", cpu: 2, memoryGiB: 4, diskGiB: 60 },
    ipPool: {
      id: "pool",
      name: "pool",
      cidr: "192.168.2.0/24",
      gateway: "192.168.2.254",
      dns: ["202.102.152.3"],
      startIp: "192.168.2.20",
      endIp: "192.168.2.250",
      reservedIps: [],
    },
  };

  const kickstart = buildOfflineCentosKickstart(input, { monitoringTool: "proxmox", firmware: "uefi" });

  assert.match(kickstart, /part \/boot\/efi --fstype=efi --size=600/);
});

test("builds a Kylin UKUI desktop kickstart without changing the server profile", () => {
  const input = {
    vm: { name: "kylin-desktop", ip: "192.168.2.35", rootPassword: "secret", cpu: 4, memoryGiB: 8, diskGiB: 100 },
    ipPool: {
      id: "pool",
      name: "pool",
      cidr: "192.168.2.0/24",
      gateway: "192.168.2.254",
      dns: ["202.102.152.3"],
      startIp: "192.168.2.20",
      endIp: "192.168.2.250",
      reservedIps: [],
    },
  };

  const desktopKickstart = buildOfflineCentosKickstart(input, {
    monitoringTool: "proxmox",
    firmware: "uefi",
    packageEnvironment: "kylin-desktop-environment",
    graphicalTarget: true,
  });
  const serverKickstart = buildOfflineCentosKickstart(input, { monitoringTool: "proxmox", firmware: "uefi" });

  assert.match(desktopKickstart, /@\^kylin-desktop-environment/);
  assert.match(desktopKickstart, /systemctl set-default graphical\.target/);
  assert.match(serverKickstart, /^@core$/m);
  assert.doesNotMatch(serverKickstart, /graphical\.target/);
});

test("runs XenServer Tools installer non-interactively", () => {
  const command = buildXenToolsGuestInstallCommand();
  assert.match(command, /sh "\$installer" -n/);
  assert.match(command, /printf 'y\\n'/);
  assert.match(command, /xe-guest/);
  assert.match(command, /\/dev\/xvdd/);
});

test("uses one SSH policy for modern ARM guests and legacy CentOS guests", () => {
  const algorithms = buildGuestSshAlgorithms();

  assert.ok(algorithms.kex.includes("curve25519-sha256"));
  assert.ok(algorithms.kex.includes("diffie-hellman-group14-sha1"));
  assert.ok(algorithms.serverHostKey.includes("rsa-sha2-512"));
  assert.ok(algorithms.serverHostKey.includes("ssh-rsa"));
});


test("routes Rocky 9 unattended to the Rocky 9 kickstart with Xen PV compatibility", () => {
  const input = {
    vm: { name: "rocky9", ip: "192.168.127.33", rootPassword: "secret", cpu: 8, memoryGiB: 16, diskGiB: 500 },
    ipPool: {
      id: "pool",
      name: "pool",
      cidr: "192.168.127.0/24",
      gateway: "192.168.127.254",
      dns: ["202.102.152.3"],
      startIp: "192.168.127.20",
      endIp: "192.168.127.250",
      reservedIps: [],
    },
    sourceIsoName: "Rocky-9.6-x86_64-minimal.iso",
  };
  const kickstart = buildOfflineCentosKickstart(input);

  assert.match(kickstart, /rootpw --lock/);
  assert.doesNotMatch(kickstart, /rootpw --iscrypted/);
  assert.match(kickstart, /part \/boot --fstype=xfs --size=1024/);
  assert.doesNotMatch(kickstart, /logvol/);
  assert.doesNotMatch(kickstart, /ifcfg-eth0/);
  assert.doesNotMatch(kickstart, /systemctl enable network/);
  // Rocky 9 使用 BLS 引导，必须用 grubby 把 xen_nopv 写入每个启动项，否则首次重启不带
  // xen_nopv 会在 "Probing EDD" 卡死（127.33 实测根因）；xen_nopv 让内核走模拟设备，不装 tools。
  assert.match(kickstart, /grubby --update-kernel=ALL --args='xen_nopv/);
  assert.match(kickstart, /xen_nopv/);
  assert.match(kickstart, /notsc clocksource=hpet acpi_skip_timer_override/);
  assert.match(kickstart, /nmcli con up eth0/);
  assert.match(kickstart, /chpasswd/);
});

test("keeps CentOS 7 unattended on the legacy LVM kickstart", () => {
  const input = {
    vm: { name: "centos7", ip: "192.168.127.34", rootPassword: "secret", cpu: 4, memoryGiB: 8, diskGiB: 120 },
    ipPool: {
      id: "pool",
      name: "pool",
      cidr: "192.168.127.0/24",
      gateway: "192.168.127.254",
      dns: ["202.102.152.3"],
      startIp: "192.168.127.20",
      endIp: "192.168.127.250",
      reservedIps: [],
    },
    sourceIsoName: "CentOS-7-x86_64-DVD-1511.iso",
  };
  const kickstart = buildOfflineCentosKickstart(input);

  assert.match(kickstart, /rootpw --iscrypted/);
  assert.match(kickstart, /logvol \/ --fstype=xfs/);
  assert.match(kickstart, /ifcfg-eth0/);
  assert.doesNotMatch(kickstart, /xen_nopv/);
  assert.match(kickstart, /systemctl enable network/);
});
