import assert from "node:assert/strict";
import test from "node:test";
import { describeStorageRepository } from "../src/storageRepositoryProfile.js";

test("describes XenServer storage drivers without guessing physical media", () => {
  assert.deepEqual(describeStorageRepository("xenserver", { type: "lvmohba", shared: true }), {
    typeLabel: "HBA 块存储",
    purposeLabel: "VM 磁盘",
    scopeLabel: "共享存储",
    mediaLabel: "平台未返回",
  });
  assert.deepEqual(describeStorageRepository("xenserver", { type: "udev", shared: false }), {
    typeLabel: "可移动设备",
    purposeLabel: "可移动介质",
    scopeLabel: "本机存储",
    mediaLabel: "不适用",
  });
});

test("describes Proxmox mixed content through the shared repository contract", () => {
  assert.deepEqual(describeStorageRepository("proxmox", { type: "dir", shared: false, content: ["images", "iso", "backup"] }), {
    typeLabel: "目录存储",
    purposeLabel: "混合用途",
    scopeLabel: "本机存储",
    mediaLabel: "平台未返回",
  });
});
