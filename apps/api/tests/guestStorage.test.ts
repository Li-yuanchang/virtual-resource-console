import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAddFilesystemCommand,
  buildExtendFilesystemCommand,
  linkGuestStorageToPlatformDisks,
  parseGuestStorageInventory,
} from "../src/guestStorage.js";
import type { VmDisk } from "../src/types.js";

const centosStorageOutput = `
__VRC_LSBLK__
NAME="xvda" KNAME="xvda" TYPE="disk" SIZE="150323855360" FSTYPE="" MOUNTPOINT="" PKNAME="" START=""
NAME="xvda1" KNAME="xvda1" TYPE="part" SIZE="524288000" FSTYPE="xfs" MOUNTPOINT="/boot" PKNAME="xvda" START="2048"
NAME="xvda2" KNAME="xvda2" TYPE="part" SIZE="106849894400" FSTYPE="LVM2_member" MOUNTPOINT="" PKNAME="xvda" START="1026048"
NAME="centos-root" KNAME="dm-0" TYPE="lvm" SIZE="53687091200" FSTYPE="xfs" MOUNTPOINT="/" PKNAME="xvda2" START=""
NAME="centos-home" KNAME="dm-2" TYPE="lvm" SIZE="45097156608" FSTYPE="xfs" MOUNTPOINT="/home" PKNAME="xvda2" START=""
__VRC_STARTS__
xvda1|2048
xvda2|1026048
__VRC_DF__
Filesystem 1B-blocks Used Available Use% Mounted on
/dev/mapper/centos-root 53660876800 901775360 52759101440 2% /
/dev/mapper/centos-home 45070942208 34603008 45036339200 1% /home
__VRC_PVS__
  /dev/xvda2|106849894400|0
__VRC_DIRS__
/mnt
/srv
`;

test("parses real CentOS LVM mount targets and safe empty directories", () => {
  const inventory = parseGuestStorageInventory("192.168.129.21", centosStorageOutput);

  assert.equal(inventory.supported, true);
  assert.deepEqual(inventory.disks, [{ path: "/dev/xvda", sizeBytes: 150323855360, filesystem: undefined, mountPath: undefined }]);
  assert.deepEqual(
    inventory.mounts.map((mount) => ({
      mountPath: mount.mountPath,
      source: mount.source,
      disk: mount.guestDiskPath,
      partition: mount.guestPartitionPath,
      logicalVolume: mount.logicalVolume,
    })),
    [
      { mountPath: "/", source: "/dev/mapper/centos-root", disk: "/dev/xvda", partition: "/dev/xvda2", logicalVolume: true },
      { mountPath: "/home", source: "/dev/mapper/centos-home", disk: "/dev/xvda", partition: "/dev/xvda2", logicalVolume: true },
    ],
  );
  assert.deepEqual(inventory.directories, [
    { path: "/mnt", state: "empty" },
    { path: "/srv", state: "empty" },
  ]);
  assert.ok(inventory.mounts.every((mount) => mount.pendingCapacityBytes > 39.5 * 1024 ** 3));
});

test("links XenServer disk 0 to xvda mount targets", () => {
  const inventory = parseGuestStorageInventory("192.168.129.21", centosStorageOutput);
  const platformDisk: VmDisk = {
    id: "vdi-0",
    vmId: "vm-1",
    providerId: "vdi-0",
    device: "0",
    name: "disk 0",
    virtualSizeBytes: 140 * 1024 ** 3,
  };

  const linked = linkGuestStorageToPlatformDisks(inventory, [platformDisk], "xenserver");

  assert.ok(linked.mounts.every((mount) => mount.platformDiskId === "vdi-0"));
});

test("builds separate commands for extending an LVM mount and formatting a new disk", () => {
  const inventory = parseGuestStorageInventory("192.168.129.21", centosStorageOutput);
  const extendCommand = buildExtendFilesystemCommand(inventory.mounts[0], 40 * 1024 ** 3);
  const addCommand = buildAddFilesystemCommand("/dev/xvdb", "/data");

  assert.match(extendCommand, /pvresize "\$partition"/);
  assert.match(extendCommand, /findmnt -n -o SOURCE --target "\$mount_path"/);
  assert.match(extendCommand, /lvextend -L \+40928M/);
  assert.match(extendCommand, /__VRC_PARTITION_REBOOT_REQUIRED__/);
  assert.doesNotMatch(extendCommand, /source='\/dev\/dm-/);
  assert.match(extendCommand, /xfs_growfs "\$mount_path"/);
  assert.match(addCommand, /parted -s "\$disk" mklabel gpt/);
  assert.match(addCommand, /mkfs\.xfs -f "\$partition"/);
  assert.match(addCommand, /UUID=\$uuid/);
  assert.match(addCommand, /mount "\$mount_path"/);
});
