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

test("xenserver capacity only counts VM-disk repositories, excluding iso and udev", () => {
  const host = {
    id: "xenserver-12",
    providerId: "xenserver-12",
    name: "xenserver-12",
    address: "192.168.2.22",
    vendor: "XenServer",
    version: "7.1",
    status: "online" as const,
    cpuModel: "test",
    cpuSockets: 2,
    cpuCores: 48,
    memoryTotalBytes: 1534.6 * 1024 ** 3,
    memoryFreeBytes: 470.5 * 1024 ** 3,
  };
  const repositories = [
    { name: "SMB ISO 库", type: "iso", typeLabel: "ISO 镜像库", purposeLabel: "ISO 镜像", scopeLabel: "共享存储", mediaLabel: "不适用", physicalGiB: 100, usedGiB: 65.3, virtualGiB: 33.3, shared: true },
    { name: "Hardware HBA virtual disk storage", type: "lvmohba", typeLabel: "HBA 块存储", purposeLabel: "VM 磁盘", scopeLabel: "共享存储", mediaLabel: "平台未返回", physicalGiB: 29806, usedGiB: 28961.2, virtualGiB: 30982, shared: true },
    { name: "DVD drives", type: "udev", typeLabel: "可移动设备", purposeLabel: "可移动介质", scopeLabel: "本机存储", mediaLabel: "不适用", physicalGiB: 1, usedGiB: 1, virtualGiB: 1, shared: false },
    { name: "Local storage", type: "lvm", typeLabel: "LVM 块存储", purposeLabel: "VM 磁盘", scopeLabel: "本机存储", mediaLabel: "平台未返回", physicalGiB: 852.2, usedGiB: 203.6, virtualGiB: 400, shared: false },
  ];
  const result = summarizeResourceCapacity(
    "xenserver",
    [host],
    repositories,
    { memoryBytes: 1040 * 1024 ** 3, runningMemoryBytes: 1040 * 1024 ** 3, storageBytes: 28682 * 1024 ** 3 },
    "xenserver-12",
  );
  // 只统计 HBA(29806) + 本机 lvm(852.2)，排除 iso(100) 与 udev(1)
  assert.equal(result.storage.physicalTotalGiB, 30658.2);
  assert.equal(result.storage.physicalUsedGiB, 29164.8);
  assert.equal(result.storage.physicalFreeGiB, 1493.4);
  assert.equal(result.storage.vmConfigurableGiB, 1976.2);
  assert.equal(result.storage.physicalStatus, "danger");
});

test("proxmox capacity only counts storages that can host VM disks", () => {
  const host = {
    id: "pve-1",
    providerId: "pve-1",
    name: "pve-1",
    address: "192.168.2.20",
    vendor: "Proxmox VE",
    version: "8",
    status: "online" as const,
    cpuModel: "test",
    cpuSockets: 1,
    cpuCores: 16,
    memoryTotalBytes: 64 * 1024 ** 3,
    memoryFreeBytes: 32 * 1024 ** 3,
  };
  const repositories = [
    { name: "local-lvm", type: "lvmthin", typeLabel: "LVM Thin 存储", purposeLabel: "VM 磁盘", scopeLabel: "本机存储", mediaLabel: "平台未返回", physicalGiB: 900, usedGiB: 700, virtualGiB: null, shared: false, hostId: "pve-1", content: ["images", "rootdir"] },
    { name: "iso-store", type: "dir", typeLabel: "目录存储", purposeLabel: "ISO 镜像", scopeLabel: "本机存储", mediaLabel: "平台未返回", physicalGiB: 200, usedGiB: 120, virtualGiB: null, shared: false, hostId: "pve-1", content: ["iso"] },
    { name: "pbs-backup", type: "pbs", typeLabel: "Proxmox 备份存储", purposeLabel: "备份存储", scopeLabel: "共享存储", mediaLabel: "平台未返回", physicalGiB: 5000, usedGiB: 3000, virtualGiB: null, shared: true, hostId: "pve-1", content: ["backup"] },
    { name: "no-content", type: "dir", typeLabel: "目录存储", purposeLabel: "VM 磁盘", scopeLabel: "本机存储", mediaLabel: "平台未返回", physicalGiB: 100, usedGiB: 50, virtualGiB: null, shared: false, hostId: "pve-1" },
  ];
  const result = summarizeResourceCapacity(
    "proxmox",
    [host],
    repositories,
    { memoryBytes: 40 * 1024 ** 3, runningMemoryBytes: 20 * 1024 ** 3, storageBytes: 600 * 1024 ** 3 },
    "pve-1",
  );
  // 只统计 local-lvm(900) + no-content(100，未声明 content 按支持 VM 磁盘处理)，排除 iso-store 与 pbs-backup
  assert.equal(result.storage.physicalTotalGiB, 1000);
  assert.equal(result.storage.physicalUsedGiB, 750);
  assert.equal(result.storage.physicalFreeGiB, 250);
  assert.equal(result.storage.physicalStatus, "normal");
});

test("vmware capacity keeps all datastores as VM-disk capable", () => {
  const host = {
    id: "esxi-1",
    providerId: "esxi-1",
    name: "esxi-1",
    address: "192.168.2.17",
    vendor: "VMware",
    version: "8.0",
    status: "online" as const,
    cpuModel: "test",
    cpuSockets: 2,
    cpuCores: 32,
    memoryTotalBytes: 256 * 1024 ** 3,
    memoryFreeBytes: 128 * 1024 ** 3,
  };
  const repositories = [
    { name: "datastore1", type: "VMFS", typeLabel: "VMFS 数据存储", purposeLabel: "VM 磁盘", scopeLabel: "共享存储", mediaLabel: "平台未返回", physicalGiB: 2000, usedGiB: 1500, virtualGiB: null, shared: true },
    { name: "nfs-iso", type: "NFS", typeLabel: "NFS 数据存储", purposeLabel: "VM 磁盘", scopeLabel: "共享存储", mediaLabel: "平台未返回", physicalGiB: 500, usedGiB: 200, virtualGiB: null, shared: true },
  ];
  const result = summarizeResourceCapacity(
    "vmware",
    [host],
    repositories,
    { memoryBytes: 128 * 1024 ** 3, runningMemoryBytes: 64 * 1024 ** 3, storageBytes: 1600 * 1024 ** 3 },
    "esxi-1",
  );
  assert.equal(result.storage.physicalTotalGiB, 2500);
  assert.equal(result.storage.physicalUsedGiB, 1700);
  assert.equal(result.storage.physicalFreeGiB, 800);
  assert.equal(result.storage.physicalStatus, "normal");
});
