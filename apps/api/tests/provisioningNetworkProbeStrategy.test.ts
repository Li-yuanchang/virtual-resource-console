import assert from "node:assert/strict";
import test from "node:test";
import { resolveProvisioningNetworkProbeStrategy } from "../src/provisioningNetworkProbeStrategy.js";

const connection = { host: "192.0.2.1", port: 22, username: "root", password: "test" };

test("non-Xen providers use the normalized no-op network probe strategy", async () => {
  for (const providerType of ["vmware", "proxmox", "libvirt"] as const) {
    const result = await resolveProvisioningNetworkProbeStrategy(providerType).probe({
      connection,
      occupiedIps: [],
    });
    assert.equal(result, undefined);
  }
});
