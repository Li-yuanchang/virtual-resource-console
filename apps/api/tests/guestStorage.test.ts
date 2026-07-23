import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAddFilesystemCommand,
  buildGuestAuthenticationInventory,
  buildGuestExecutionUnavailableInventory,
  buildExtendFilesystemCommand,
  isGuestAuthenticationError,
  isGuestAgentUnavailableError,
  linkGuestStorageToPlatformDisks,
  parseGuestStorageInventory,
  resolveGuestStorageTransport,
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

test("classifies Guest authentication failures without masking unrelated SSH errors", () => {
  const sshError = Object.assign(new Error("authentication failed"), { level: "client-authentication" });

  assert.equal(isGuestAuthenticationError(sshError), true);
  assert.equal(isGuestAuthenticationError(new Error("All configured authentication methods failed")), true);
  assert.equal(isGuestAuthenticationError(new Error("缺少虚拟机操作系统 SSH 密码，请配置运行策略")), true);
  assert.equal(isGuestAuthenticationError(new Error("SSH handshake timed out")), false);
});

test("requests one-time system credentials when backend default authentication fails", () => {
  const inventory = buildGuestAuthenticationInventory("192.0.2.10");

  assert.equal(inventory.supported, false);
  assert.equal(inventory.reasonCode, "SYSTEM_AUTHENTICATION_REQUIRED");
  assert.match(inventory.message, /Login|登录名/);
  assert.deepEqual(inventory.mounts, []);
});

test("classifies unavailable PVE guest agent separately from SSH authentication", () => {
  assert.equal(isGuestAgentUnavailableError(new Error("QEMU Guest Agent 未响应")), true);
  assert.equal(isGuestAgentUnavailableError(new Error("guest-exec 未启用")), true);
  assert.equal(isGuestAgentUnavailableError(new Error("SSH handshake timed out")), false);
  assert.equal(buildGuestExecutionUnavailableInventory("192.0.2.10").reasonCode, "SYSTEM_EXECUTION_UNAVAILABLE");
});

test("backend selects the system storage transport by provider", () => {
  assert.equal(resolveGuestStorageTransport("xenserver"), "platform-jump-ssh");
  assert.equal(resolveGuestStorageTransport("proxmox"), "direct-ssh");
  assert.equal(resolveGuestStorageTransport("vmware"), "direct-ssh");
  assert.equal(resolveGuestStorageTransport("proxmox", true), "configured-jump-ssh");
  assert.equal(resolveGuestStorageTransport("vmware", true), "configured-jump-ssh");
  assert.throws(() => resolveGuestStorageTransport("libvirt"), /未配置系统存储执行策略/);
});
