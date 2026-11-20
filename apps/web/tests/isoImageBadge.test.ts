import assert from "node:assert/strict";
import test from "node:test";
import { filterIsoImages, isoOptionSourceText, isoSourceDotClass, resolveIsoBadge, splitHighlightSegments } from "../src/domain/isoImageBadge.js";
import type { IsoImage } from "../src/types.js";

function image(overrides: Partial<IsoImage>): IsoImage {
  return {
    id: "iso",
    providerId: "iso",
    name: "CentOS-7-x86_64-DVD-1511.iso",
    sourceType: "iso-library",
    storageRepository: "ISO-SR-NFS",
    shared: true,
    ...overrides,
  };
}

test("derives system family badge from ISO name", () => {
  assert.deepEqual(resolveIsoBadge(image({ name: "CentOS-7-x86_64-DVD-1511.iso" })), { text: "RH", family: "centos" });
  assert.deepEqual(resolveIsoBadge(image({ name: "Rocky-9.3-x86_64-dvd.iso" })), { text: "RH", family: "centos" });
  assert.deepEqual(resolveIsoBadge(image({ name: "ubuntu-22.04.3-desktop-amd64.iso" })), { text: "UB", family: "ubuntu" });
  assert.deepEqual(resolveIsoBadge(image({ name: "windows_server_2012_r2_x64_dvd.iso" })), { text: "WIN", family: "windows" });
  assert.deepEqual(resolveIsoBadge(image({ name: "Kylin-Server-10-SP3-x86_64.iso" })), { text: "KY", family: "kylin" });
  assert.deepEqual(resolveIsoBadge(image({ name: "macOS-Sonoma-14.iso" })), { text: "MAC", family: "macos" });
});

test("falls back to media-type badges for tools and unknown host DVD images", () => {
  assert.deepEqual(resolveIsoBadge(image({ name: "xs-tools.iso", sourceType: "tools" })), { text: "TL", family: "tools" });
  assert.deepEqual(resolveIsoBadge(image({ name: "data-disk.iso", sourceType: "host-dvd" })), { text: "DVD", family: "dvd" });
  assert.deepEqual(resolveIsoBadge(image({ name: "unknown-media.iso" })), { text: "ISO", family: "iso" });
});

test("windows matcher wins over the generic redhat family", () => {
  assert.equal(resolveIsoBadge(image({ name: "Windows-Server-2022-with-rhel-drivers.iso" })).family, "windows");
});

test("source dot reflects media source", () => {
  assert.equal(isoSourceDotClass(image({ sourceType: "host-dvd" })), "dvd");
  assert.equal(isoSourceDotClass(image({ shared: true })), "shared");
  assert.equal(isoSourceDotClass(image({ shared: false })), "local");
});

test("source text avoids repeating the label when repository equals it", () => {
  assert.equal(isoOptionSourceText(image({ storageRepository: "ISO-SR-NFS", shared: true })), "共享 ISO 库 · ISO-SR-NFS");
  assert.equal(isoOptionSourceText(image({ storageRepository: "共享 ISO 库", shared: true })), "共享 ISO 库");
  assert.equal(isoOptionSourceText(image({ storageRepository: "  ", shared: false })), "本地 ISO 库");
});

test("filters ISO images by name, repository, source and path", () => {
  const images = [
    image({ id: "a", name: "CentOS-7-x86_64-DVD-1511.iso" }),
    image({ id: "b", name: "ubuntu-22.04.3-desktop-amd64.iso" }),
    image({ id: "c", name: "windows_server_2012_r2.iso", storageRepository: "Local-SR-01", shared: false }),
  ];
  assert.deepEqual(filterIsoImages(images, "").images.map((item) => item.id), ["a", "b", "c"]);
  assert.deepEqual(filterIsoImages(images, "ubuntu").images.map((item) => item.id), ["b"]);
  assert.deepEqual(filterIsoImages(images, "  WINDOWS ").images.map((item) => item.id), ["c"]);
  assert.deepEqual(filterIsoImages(images, "local-sr").images.map((item) => item.id), ["c"]);
  assert.deepEqual(filterIsoImages(images, "本地").images.map((item) => item.id), ["c"]);
  assert.deepEqual(filterIsoImages(images, "server windows").images.map((item) => item.id), ["c"]);
  assert.equal(filterIsoImages(images, "no-such-iso").matchedCount, 0);
});

test("highlight segments mark every keyword occurrence case-insensitively", () => {
  assert.deepEqual(splitHighlightSegments("CentOS-7-CentOS.iso", "centos"), [
    { text: "CentOS", matched: true },
    { text: "-7-", matched: false },
    { text: "CentOS", matched: true },
    { text: ".iso", matched: false },
  ]);
  assert.deepEqual(splitHighlightSegments("plain.iso", ""), [{ text: "plain.iso", matched: false }]);
  assert.deepEqual(splitHighlightSegments("a+b.iso", "a+b"), [
    { text: "a+b", matched: true },
    { text: ".iso", matched: false },
  ]);
});
