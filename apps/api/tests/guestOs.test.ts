import assert from "node:assert/strict";
import test from "node:test";
import { normalizeGuestOsLabel } from "../src/guestOs.js";

test("formats exact guest distributions as concise inventory labels", () => {
  assert.equal(normalizeGuestOsLabel("CentOS Linux release 7.2.1511 (Core)"), "CentOS 7.2.1511");
  assert.equal(normalizeGuestOsLabel("openEuler release 22.03 LTS-SP3"), "openEuler 22.03 LTS-SP3");
  assert.equal(normalizeGuestOsLabel("Ubuntu Linux (64-bit)"), "Ubuntu");
  assert.equal(normalizeGuestOsLabel("Microsoft Windows Server 2019 (64-bit)"), "Windows Server 2019");
});

test("reduces kernel-only values without inventing an exact distribution", () => {
  assert.equal(normalizeGuestOsLabel("3.10.0-327.el7.x86_64"), "CentOS / RHEL 7");
  assert.equal(normalizeGuestOsLabel("5.15.0-91-generic x86_64"), "Linux");
  assert.equal(normalizeGuestOsLabel("Linux 2.6+"), "Linux");
  assert.equal(normalizeGuestOsLabel("<not in database>"), undefined);
  assert.equal(normalizeGuestOsLabel("Other install media"), undefined);
});
