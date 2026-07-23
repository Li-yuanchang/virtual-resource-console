import assert from "node:assert/strict";
import test from "node:test";
import { InventoryCache, type InventoryCacheScope } from "../src/inventoryCache.js";
import type { VmDisk, VmNode } from "../src/types.js";

const scope: InventoryCacheScope = {
  providerType: "proxmox",
  connectionId: "connection-1",
  host: "192.0.2.10",
  port: 8006,
  username: "root@pam",
};

const vm: VmNode = {
  id: "vm-1",
  connectionId: "connection-1",
  providerId: "proxmox:pve:101",
  name: "vm-1",
  powerState: "running",
  cpuCount: 2,
  memoryBytes: 4 * 1024 ** 3,
  ipAddresses: ["192.0.2.101"],
  toolsStatus: "installed",
  reclaimLevel: "KEEP",
  reclaimReason: "test",
};

test("deduplicates concurrent VM disk reads for one connection and VM", async () => {
  const cache = new InventoryCache();
  let loads = 0;
  const disk: VmDisk = {
    id: "disk-1",
    vmId: vm.providerId,
    providerId: "disk-1",
    device: "scsi0",
    name: "disk-1",
    virtualSizeBytes: 100 * 1024 ** 3,
  };
  const loader = async () => {
    loads += 1;
    await Promise.resolve();
    return [disk];
  };

  const [left, right] = await Promise.all([
    cache.getVmDisks({ ...scope, vmId: vm.providerId }, loader),
    cache.getVmDisks({ ...scope, vmId: vm.providerId }, loader),
  ]);

  assert.equal(loads, 1);
  assert.deepEqual(left.value, [disk]);
  assert.deepEqual(right.value, [disk]);
});

test("reuses the latest cached VM row as a read-only resize hint", async () => {
  const cache = new InventoryCache();
  await cache.getVmList(
    { ...scope, page: 1, pageSize: 100 },
    async () => ({ items: [vm], page: 1, pageSize: 100, total: 1 }),
  );

  assert.equal(cache.findVm({ ...scope, vmId: vm.providerId }, vm.providerId)?.ipAddresses[0], "192.0.2.101");
});
