import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCentosLvmPartitioning,
  buildCentosPackageSelection,
  buildRedHatPlainPartitioning,
  isRocky9Image,
  isRedHatFamilyImage,
} from "../src/centosKickstart.js";

test("allocates the remaining CentOS disk capacity to home", () => {
  const partitioning = buildCentosLvmPartitioning(120);

  assert.match(partitioning, /logvol \/ .*--size=51200/);
  assert.match(partitioning, /logvol swap .*--size=8192/);
  assert.match(partitioning, /logvol \/home .*--size=1024 --grow/);
  assert.doesNotMatch(partitioning, /autopart/);
});

test("keeps a usable root volume for compact CentOS disks", () => {
  const partitioning = buildCentosLvmPartitioning(40);
  const rootSize = Number(partitioning.match(/logvol \/ .*--size=(\d+)/)?.[1]);

  assert.ok(rootSize >= 20 * 1024);
  assert.ok(rootSize < 50 * 1024);
  assert.match(partitioning, /part pv\.01 .*--grow/);
});

test("adds an EFI system partition and reserves its capacity for UEFI guests", () => {
  const partitioning = buildCentosLvmPartitioning(60, { firmware: "uefi" });
  const rootSize = Number(partitioning.match(/logvol \/ .*--size=(\d+)/)?.[1]);

  assert.match(partitioning, /part \/boot\/efi --fstype=efi --size=600/);
  assert.ok(rootSize < 50 * 1024);
  assert.match(partitioning, /part \/boot --fstype=xfs --size=500/);
});

test("uses an ISO environment group for desktop package selection", () => {
  const packages = buildCentosPackageSelection(["qemu-guest-agent"], {
    environmentGroup: "kylin-desktop-environment",
  });

  assert.match(packages, /@\^kylin-desktop-environment/);
  assert.match(packages, /qemu-guest-agent/);
  assert.doesNotMatch(packages, /^@core$/m);
  assert.throws(
    () => buildCentosPackageSelection([], { environmentGroup: "desktop\n%post" }),
    /软件环境组不合法/,
  );
});


test("identifies RHEL-family images for unattended kickstart", () => {
  assert.equal(isRedHatFamilyImage("Rocky-9.6-x86_64-minimal.iso"), true);
  assert.equal(isRedHatFamilyImage("CentOS-7-x86_64-DVD-1511.iso"), true);
  assert.equal(isRedHatFamilyImage("rhel-8.10-x86_64.iso"), true);
  assert.equal(isRedHatFamilyImage("almalinux-9.2-x86_64.iso"), true);
  assert.equal(isRedHatFamilyImage("oraclelinux-9.3-x86_64.iso"), true);
  assert.equal(isRedHatFamilyImage("ubuntu-24.04-desktop-amd64.iso"), false);
  assert.equal(isRedHatFamilyImage("windows_server_2012_r2.iso"), false);
});

test("only Rocky 9 images receive the Xen guest-tools / device 0001 policy", () => {
  assert.equal(isRocky9Image("Rocky-9.6-x86_64-minimal.iso"), true);
  assert.equal(isRocky9Image("rockylinux-9.2-x86_64.iso"), true);
  assert.equal(isRocky9Image("Rocky-8.10-x86_64.iso"), false);
  assert.equal(isRocky9Image("rhel-8.10-x86_64.iso"), false);
  assert.equal(isRocky9Image("rhel-9.4-x86_64.iso"), false);
  assert.equal(isRocky9Image("almalinux-9.2-x86_64.iso"), false);
  assert.equal(isRocky9Image("oraclelinux-9.3-x86_64.iso"), false);
  assert.equal(isRocky9Image("CentOS-7-x86_64-DVD-1511.iso"), false);
  assert.equal(isRocky9Image("CentOS-8-x86_64.iso"), false);
});

test("builds non-LVM partitioning for modern RHEL (matches 127.33 verified layout)", () => {
  const partitioning = buildRedHatPlainPartitioning(500);

  assert.match(partitioning, /part \/boot --fstype=xfs --size=1024/);
  assert.match(partitioning, /part swap --fstype=swap --size=8192/);
  assert.match(partitioning, /part \/ --fstype=xfs --size=1 --grow/);
  assert.doesNotMatch(partitioning, /logvol/);
  assert.doesNotMatch(partitioning, /pv\.01/);
});

test("adds an EFI system partition for modern RHEL UEFI guests", () => {
  const partitioning = buildRedHatPlainPartitioning(500, { firmware: "uefi" });

  assert.match(partitioning, /part \/boot\/efi --fstype=efi --size=600/);
  assert.match(partitioning, /part \/boot --fstype=xfs --size=1024/);
});
