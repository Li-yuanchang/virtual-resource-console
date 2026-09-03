import assert from "node:assert/strict";
import test from "node:test";
import { replaceVmNameIpPrefix, vmNamePrefixFromIp } from "../src/domain/vmNamePrefix.js";

test("uses the compact subnet-host form for a newly configured 192.168 pool", () => {
  const pools = ["192.168.2", "192.168.127", "192.168.129", "192.168.140"];

  assert.equal(vmNamePrefixFromIp("192.168.140.20", pools), "140.20_");
});

test("keeps the full IP in VM names when configured pools do not share a base prefix", () => {
  assert.equal(vmNamePrefixFromIp("192.168.140.20", ["192.168.140", "10.20.30"]), "192.168.140.20_");
});

test("does not restore a deleted common prefix when synchronizing an IP-derived VM name", () => {
  assert.equal(replaceVmNameIpPrefix("140.20_application", "140.20_"), "140.20_application");
  assert.equal(replaceVmNameIpPrefix("192.168.140.20_application", "140.20_"), "140.20_application");
});
