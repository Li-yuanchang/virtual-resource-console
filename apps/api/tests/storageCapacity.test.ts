import assert from "node:assert/strict";
import test from "node:test";
import { normalizeStorageCapacity, summarizeResourceCapacity } from "../src/storageCapacity.js";

test("keeps provider-native virtual allocation when the platform supplies it", () => {
  assert.deepEqual(normalizeStorageCapacity({ physicalGiB: 1000, usedGiB: 600, virtualGiB: 850 }), {
    physicalGiB: 1000,
    usedGiB: 600,
    virtualGiB: 850,
  });
});

test("does not substitute physical usage for missing virtual allocation", () => {
  assert.deepEqual(normalizeStorageCapacity({ physicalGiB: 1000, usedGiB: 600 }), {
    physicalGiB: 1000,
    usedGiB: 600,
    virtualGiB: null,
  });
});

test("normalizes invalid capacity values without changing the contract shape", () => {
  assert.deepEqual(normalizeStorageCapacity({ physicalGiB: Number.NaN, usedGiB: -1, virtualGiB: Number.POSITIVE_INFINITY }), {
    physicalGiB: 0,
    usedGiB: 0,
    virtualGiB: 0,
  });
});

test("summarizes physical and VM-configured memory and storage for one host", () => {
  assert.deepEqual(
    summarizeResourceCapacity(
      "proxmox",
      [
        {
          id: "pve-a",
          providerId: "pve-a",
          name: "pve-a",
          address: "192.0.2.10",
          vendor: "Proxmox",
          version: "8",
          status: "online",
          cpuModel: "test",
          cpuSockets: 2,
          cpuCores: 48,
          memoryTotalBytes: 188.5 * 1024 ** 3,
          memoryFreeBytes: 98 * 1024 ** 3,
        },
      ],
      [
        { name: "local", type: "lvmthin", typeLabel: "LVM Thin 存储", purposeLabel: "VM 磁盘", scopeLabel: "本机存储", mediaLabel: "平台未返回", physicalGiB: 986.6, usedGiB: 815.9, virtualGiB: null, shared: false, hostId: "pve-a" },
        { name: "other", type: "lvmthin", typeLabel: "LVM Thin 存储", purposeLabel: "VM 磁盘", scopeLabel: "本机存储", mediaLabel: "平台未返回", physicalGiB: 500, usedGiB: 100, virtualGiB: null, shared: false, hostId: "pve-b" },
      ],
      { memoryBytes: 104 * 1024 ** 3, runningMemoryBytes: 64 * 1024 ** 3, storageBytes: 700 * 1024 ** 3 },
      "pve-a",
    ),
    {
      memory: {
        physicalTotalGiB: 188.5,
        physicalUsedGiB: 90.5,
        physicalFreeGiB: 98,
        physicalStatus: "normal",
        vmConfiguredGiB: 104,
        vmConfigurableGiB: 84.5,
        vmOverconfiguredGiB: 0,
        vmStatus: "within-capacity",
        allocatableGiB: 58,
        runningConfiguredGiB: 64,
        haltedConfiguredGiB: 40,
        guaranteedHeadroomGiB: 58,
        startupDeficitGiB: 0,
        startupStatus: "guaranteed",
      },
      storage: {
        physicalTotalGiB: 986.6,
        physicalUsedGiB: 815.9,
        physicalFreeGiB: 170.7,
        physicalStatus: "normal",
        vmConfiguredGiB: 700,
        vmConfigurableGiB: 286.6,
        vmOverconfiguredGiB: 0,
        vmStatus: "within-capacity",
        allocatableGiB: 170.7,
      },
    },
  );
});

test("reports physical pressure and VM overconfiguration without hiding the excess", () => {
  assert.deepEqual(
    summarizeResourceCapacity(
      "xenserver",
      [
        {
          id: "host-a",
          providerId: "host-a",
          name: "host-a",
          address: "192.0.2.20",
          vendor: "XenServer",
          version: "8",
          status: "online",
          cpuModel: "test",
          cpuSockets: 1,
          cpuCores: 16,
          memoryTotalBytes: 32 * 1024 ** 3,
          memoryFreeBytes: 1 * 1024 ** 3,
        },
      ],
      [
        { name: "vm-sr", type: "lvm", typeLabel: "LVM 块存储", purposeLabel: "VM 磁盘", scopeLabel: "本机存储", mediaLabel: "平台未返回", physicalGiB: 100, usedGiB: 96, virtualGiB: 120, shared: false, hostId: "host-a" },
      ],
      { memoryBytes: 44 * 1024 ** 3, runningMemoryBytes: 31 * 1024 ** 3, storageBytes: 120 * 1024 ** 3 },
      "host-a",
    ),
    {
      memory: {
        physicalTotalGiB: 32,
        physicalUsedGiB: 31,
        physicalFreeGiB: 1,
        physicalStatus: "danger",
        vmConfiguredGiB: 44,
        vmConfigurableGiB: 0,
        vmOverconfiguredGiB: 12,
        vmStatus: "overconfigured",
        allocatableGiB: 0,
        runningConfiguredGiB: 31,
        haltedConfiguredGiB: 13,
        guaranteedHeadroomGiB: 0,
        startupDeficitGiB: 12,
        startupStatus: "at-risk",
      },
      storage: {
        physicalTotalGiB: 100,
        physicalUsedGiB: 96,
        physicalFreeGiB: 4,
        physicalStatus: "danger",
        vmConfiguredGiB: 120,
        vmConfigurableGiB: 0,
        vmOverconfiguredGiB: 20,
        vmStatus: "overconfigured",
        allocatableGiB: 0,
      },
    },
  );
});

test("keeps halted VM memory released while reporting its future startup demand", () => {
  const result = summarizeResourceCapacity(
    "xenserver",
    [
      {
        id: "xenserver-1",
        providerId: "xenserver-1",
        name: "xenserver-1",
        address: "192.168.2.77",
        vendor: "XenServer",
        version: "6.5",
        status: "online",
        cpuModel: "test",
        cpuSockets: 1,
        cpuCores: 56,
        memoryTotalBytes: 191.8 * 1024 ** 3,
        memoryFreeBytes: 83.7 * 1024 ** 3,
      },
    ],
    [],
    { memoryBytes: 186 * 1024 ** 3, runningMemoryBytes: 108 * 1024 ** 3, storageBytes: 0 },
    "xenserver-1",
  );

  assert.equal(result.memory.physicalFreeGiB, 83.7);
  assert.equal(result.memory.haltedConfiguredGiB, 78);
  assert.equal(result.memory.guaranteedHeadroomGiB, 5.7);
  assert.equal(result.memory.startupDeficitGiB, 0);
  assert.equal(result.memory.startupStatus, "guaranteed");
});
