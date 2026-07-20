import assert from "node:assert/strict";
import test from "node:test";
import { groupIsoImagesBySource, resolveProvisioningStrategy } from "../src/domain/provisioningStrategies.js";
import type { IsoImage } from "../src/types.js";

const images: IsoImage[] = [
  {
    id: "dvd",
    providerId: "dvd",
    name: "CentOS 7 x86_64",
    sourceType: "host-dvd",
    storageRepository: "DVD drives",
    shared: false,
  },
  {
    id: "tools",
    providerId: "tools",
    name: "guest-tools.iso",
    sourceType: "tools",
    storageRepository: "XenServer Tools",
    shared: true,
  },
  {
    id: "shared",
    providerId: "shared",
    name: "CentOS-7-x86_64-DVD-1511.iso",
    sourceType: "iso-library",
    storageRepository: "ISO Library",
    shared: true,
  },
];

test("groups install media by stable source type", () => {
  assert.deepEqual(
    groupIsoImagesBySource(images).map((group) => ({ label: group.label, ids: group.options.map((item) => item.id) })),
    [
      { label: "共享 ISO 库", ids: ["shared"] },
      { label: "本机 DVD", ids: ["dvd"] },
      { label: "工具盘", ids: ["tools"] },
    ],
  );
});

test("keeps XenServer tools out of operating-system choices", () => {
  const installImages = resolveProvisioningStrategy("xenserver").installIsoImages(images);
  assert.deepEqual(installImages.map((image) => image.id), ["dvd", "shared"]);
});
