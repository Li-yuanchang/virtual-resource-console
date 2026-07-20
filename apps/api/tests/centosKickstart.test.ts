import assert from "node:assert/strict";
import test from "node:test";
import { buildCentosLvmPartitioning, buildCentosPackageSelection } from "../src/centosKickstart.js";

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
