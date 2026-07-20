import assert from "node:assert/strict";
import test from "node:test";
import { inferIpv4FromName } from "../src/runtimePolicy.js";
import type { RuntimePolicy } from "../src/runtimePolicy.js";

const policy: RuntimePolicy = {
  managedIpPattern: "^192\\.168\\.(?:2|127)\\.",
  ipInference: {
    enabled: true,
    shortIpBasePrefix: "192.168",
    shortIpThirdOctets: ["2", "127"],
    hostOnlyPrefix: "192.168.2",
  },
  provisioning: { rootPasswordTemplate: "" },
  xenserver: { networkDeviceRules: [] },
};

test("infers short VM IPs separated by dots or hyphens", () => {
  assert.equal(inferIpv4FromName("2.105-service", policy), "192.168.2.105");
  assert.equal(inferIpv4FromName("2-32", policy), "192.168.2.32");
  assert.equal(inferIpv4FromName("127-100-openEuler", policy), "192.168.127.100");
});

test("keeps host-only VM names on the configured default subnet", () => {
  assert.equal(inferIpv4FromName("56_service", policy), "192.168.2.56");
  assert.equal(inferIpv4FromName("105service", policy), "192.168.2.105");
});
