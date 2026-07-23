import assert from "node:assert/strict";
import test from "node:test";
import { buildProxmoxGuestExecBody, parseProxmoxVmDisks } from "../src/proxmox.js";
import { vmwareAddDiskSpec, vmwareEditDiskSpec, type VmwareDiskInfo } from "../src/vmware.js";
import { assertXenResizeApplied } from "../src/xenserver.js";
import type { VmDisk, VmResizeResult } from "../src/types.js";

test("XenServer resize rejects a successful command when the target VDI size did not change", () => {
  const disk = xenDisk(100);
  const result = xenResizeResult([disk]);

  assert.throws(
    () =>
      assertXenResizeApplied(
        {
          disk: { mode: "extend", diskId: disk.id, sizeBytes: 120 * 1024 ** 3 },
          allowShutdown: false,
          restartAfterResize: true,
        },
        [disk],
        result,
      ),
    /磁盘扩容未生效/,
  );
});

test("XenServer resize accepts an online VDI after the platform reports the target size", () => {
  const diskBefore = xenDisk(100);
  const diskAfter = xenDisk(120);

  assert.doesNotThrow(() =>
    assertXenResizeApplied(
      {
        disk: { mode: "extend", diskId: diskBefore.id, sizeBytes: 120 * 1024 ** 3 },
        allowShutdown: false,
        restartAfterResize: true,
      },
      [diskBefore],
      xenResizeResult([diskAfter]),
    ),
  );
});

test("PVE resize inventory excludes install media and cloud-init disks", () => {
  const disks = parseProxmoxVmDisks(
    {
      scsi2: "local:iso/CentOS-7.iso,media=cdrom,size=3.4G",
      ide0: "local:cloudinit",
      scsi1: "local-lvm:vm-100-disk-1,size=20G",
      scsi0: "local-lvm:vm-100-disk-0,size=100G",
    },
    "node-a:100",
  );

  assert.deepEqual(
    disks.map((disk) => ({ device: disk.device, sizeGiB: disk.virtualSizeBytes / 1024 ** 3 })),
    [
      { device: "scsi0", sizeGiB: 100 },
      { device: "scsi1", sizeGiB: 20 },
    ],
  );
});

test("PVE Guest Agent encodes command as the documented command array", () => {
  const body = buildProxmoxGuestExecBody("printf '%s' ok");
  assert.deepEqual(JSON.parse(body.get("command") || "null"), ["sh", "-lc", "printf '%s' ok"]);
  assert.equal(body.has("command[0]"), false);
  assert.equal(body.has("args[0]"), false);
});

test("VMware original disk resize preserves device placement and uses KiB capacity", () => {
  const disk = vmwareDisk({ key: 2000, controllerKey: 1000, unitNumber: 0, backingFileName: "[datastore-a] vm/vm.vmdk" });
  const xml = vmwareEditDiskSpec(disk, 120 * 1024 ** 3);

  assert.match(xml, /<operation>edit<\/operation>/);
  assert.match(xml, /<key>2000<\/key>/);
  assert.match(xml, /<controllerKey>1000<\/controllerKey>/);
  assert.match(xml, /<unitNumber>0<\/unitNumber>/);
  assert.match(xml, /<capacityInKB>125829120<\/capacityInKB>/);
  assert.match(xml, /\[datastore-a\] vm\/vm\.vmdk/);
});

test("VMware new disk resize selects the next non-reserved controller unit", () => {
  const disks = [
    vmwareDisk({ key: 2000, controllerKey: 1000, unitNumber: 0 }),
    vmwareDisk({ key: 2001, controllerKey: 1000, unitNumber: 1 }),
  ];
  const xml = vmwareAddDiskSpec(disks, "datastore-a", 20 * 1024 ** 3, "data disk");

  assert.match(xml, /<operation>add<\/operation>/);
  assert.match(xml, /<fileOperation>create<\/fileOperation>/);
  assert.match(xml, /<controllerKey>1000<\/controllerKey>/);
  assert.match(xml, /<unitNumber>2<\/unitNumber>/);
  assert.match(xml, /<capacityInKB>20971520<\/capacityInKB>/);
  assert.match(xml, /<fileName>\[datastore-a\]<\/fileName>/);
});

function vmwareDisk(overrides: Partial<VmwareDiskInfo>): VmwareDiskInfo {
  return {
    id: "vm-1:disk:2000",
    name: "Hard disk 1",
    device: "2000",
    virtualSizeBytes: 100 * 1024 ** 3,
    storageRepository: "datastore-a",
    key: 2000,
    controllerKey: 1000,
    unitNumber: 0,
    backingFileName: "[datastore-a] vm/vm.vmdk",
    diskMode: "persistent",
    thinProvisioned: true,
    eagerlyScrub: false,
    ...overrides,
  };
}

function xenDisk(sizeGiB: number): VmDisk {
  return {
    id: "xen-vdi-1",
    vmId: "xen-vm-1",
    providerId: "xen-vdi-1",
    device: "0",
    name: "disk 0",
    virtualSizeBytes: sizeGiB * 1024 ** 3,
    storageRepositoryId: "xen-sr-1",
    storageRepository: "Local storage",
  };
}

function xenResizeResult(disks: VmDisk[]): VmResizeResult {
  return {
    vmId: "xen-vm-1",
    name: "test-vm",
    accepted: true,
    previousCpuCount: 4,
    cpuCount: 4,
    previousMemoryBytes: 8 * 1024 ** 3,
    memoryBytes: 8 * 1024 ** 3,
    disks,
    stopped: false,
    restarted: false,
    message: "扩容完成：test-vm",
  };
}
