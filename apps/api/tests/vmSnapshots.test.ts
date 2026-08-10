import assert from "node:assert/strict";
import test from "node:test";
import { parseVmSnapshots as parseXenSnapshots } from "../src/xenserver.js";
import { collectVmSnapshots } from "../src/vmware.js";
import { parseVmSnapshots as parseProxmoxSnapshots } from "../src/proxmox.js";

test("XenServer parses snapshot rows into VmSnapshot list", () => {
  const output = [
    "SNAP\tsnap-1\tvm-uuid-1\t基础快照\t2026-08-01T02:00:00.000Z",
    "SNAP\tsnap-2\tvm-uuid-1\t恢复点\t2026-08-02T03:30:00.000Z",
    "SNAP\tsnap-3\t\t<not in database>",
  ].join("\n");
  const snapshots = parseXenSnapshots(output, "vm-uuid-1");
  assert.equal(snapshots.length, 3);
  assert.deepEqual(
    snapshots.map((item) => ({ id: item.id, vmId: item.vmId, name: item.name, createdAt: item.createdAt })),
    [
      { id: "snap-1", vmId: "vm-uuid-1", name: "基础快照", createdAt: "2026-08-01T02:00:00.000Z" },
      { id: "snap-2", vmId: "vm-uuid-1", name: "恢复点", createdAt: "2026-08-02T03:30:00.000Z" },
      { id: "snap-3", vmId: "vm-uuid-1", name: "snap-3", createdAt: undefined },
    ],
  );
});

test("XenServer snapshot parser ignores unrelated lines", () => {
  const output = ["SNAP\tsnap-1\tvm-uuid-1\t基础快照\t2026-08-01T02:00:00.000Z", "DISK\tdisk-1\tvm-uuid-1", "unknown line"].join("\n");
  assert.equal(parseXenSnapshots(output, "vm-uuid-1").length, 1);
});

test("VMware collects root and child snapshots recursively", () => {
  const rootSnapshotList = {
    VirtualMachineSnapshotTree: [
      {
        snapshot: { "@type": "VirtualMachineSnapshot", "#text": "snapshot-11" },
        name: "基础快照",
        description: "",
        createTime: "2026-08-01T02:00:00Z",
        state: "poweredOn",
        quiesced: "false",
        childSnapshotList: {
          VirtualMachineSnapshotTree: {
            snapshot: { "@type": "VirtualMachineSnapshot", "#text": "snapshot-12" },
            name: "子快照",
            createTime: "2026-08-02T03:00:00Z",
          },
        },
      },
      {
        snapshot: { "@type": "VirtualMachineSnapshot", "#text": "snapshot-13" },
        name: "独立快照",
        createTime: "2026-08-03T04:00:00Z",
      },
    ],
  };
  const snapshots = collectVmSnapshots(rootSnapshotList, "vm-100", "provider-vm-100");
  assert.deepEqual(
    snapshots.map((item) => ({ id: item.id, vmId: item.vmId, providerId: item.providerId, name: item.name, createdAt: item.createdAt })),
    [
      { id: "snapshot-11", vmId: "vm-100", providerId: "snapshot-11", name: "基础快照", createdAt: "2026-08-01T02:00:00Z" },
      { id: "snapshot-12", vmId: "vm-100", providerId: "snapshot-12", name: "子快照", createdAt: "2026-08-02T03:00:00Z" },
      { id: "snapshot-13", vmId: "vm-100", providerId: "snapshot-13", name: "独立快照", createdAt: "2026-08-03T04:00:00Z" },
    ],
  );
});

test("VMware returns empty list when VM has no snapshot tree", () => {
  assert.deepEqual(collectVmSnapshots(undefined, "vm-100", "provider-vm-100"), []);
  assert.deepEqual(collectVmSnapshots({ VirtualMachineSnapshotTree: [] }, "vm-100", "provider-vm-100"), []);
});

test("Proxmox parses snapshot entries and excludes the current placeholder", () => {
  const entries = [
    { name: "current", description: "当前状态", snaptime: 1754200000, parent: "", type: "" },
    { name: "snap-a", description: "第一个快照", snaptime: 1754100000, parent: "current", type: "snapshot" },
    { name: "snap-b", description: "", snaptime: 1754200000, parent: "snap-a", type: "vmstate" },
  ];
  const snapshots = parseProxmoxSnapshots(entries, "pve1:101");
  assert.deepEqual(
    snapshots.map((item) => ({ id: item.id, vmId: item.vmId, name: item.name, createdAt: item.createdAt })),
    [
      { id: "snap-a", vmId: "pve1:101", name: "第一个快照", createdAt: "2025-08-02T02:00:00.000Z" },
      { id: "snap-b", vmId: "pve1:101", name: "snap-b", createdAt: "2025-08-03T05:46:40.000Z" },
    ],
  );
});

test("Proxmox snapshot parser tolerates malformed entries", () => {
  assert.deepEqual(parseProxmoxSnapshots([{ name: "current" }, { name: "" }, null as never], "pve1:101"), []);
});
