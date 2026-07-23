import assert from "node:assert/strict";
import test from "node:test";
import { defaultPortForProvider, getProviderDescriptor, listProviderDescriptors } from "../src/providerCatalog.js";

test("provider catalog exposes one normalized descriptor for every provider type", () => {
  const descriptors = listProviderDescriptors();
  assert.deepEqual(descriptors.map((item) => item.type).sort(), ["libvirt", "proxmox", "vmware", "xenserver"]);
  assert.equal(defaultPortForProvider("vmware"), 443);
  assert.equal(defaultPortForProvider("proxmox"), 8006);
  assert.equal(defaultPortForProvider("xenserver"), 22);
});

test("provider capability descriptors are returned as defensive copies", () => {
  const first = getProviderDescriptor("proxmox");
  first.capabilities.vmRename.maxLength = 1;
  assert.equal(getProviderDescriptor("proxmox").capabilities.vmRename.maxLength, 63);
  assert.equal(getProviderDescriptor("libvirt").capabilities.vmResize.supported, false);
});
