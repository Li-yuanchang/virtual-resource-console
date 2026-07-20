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
