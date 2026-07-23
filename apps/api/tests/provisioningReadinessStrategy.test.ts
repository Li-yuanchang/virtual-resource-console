import assert from "node:assert/strict";
import test from "node:test";
import { resolveProvisioningReadinessStrategy } from "../src/provisioningReadinessStrategy.js";

test("XenServer normalizes ARP, WinRM and host Ping into readiness states", () => {
  const strategy = resolveProvisioningReadinessStrategy("xenserver");
  assert.equal(strategy.usesHostTunnel, true);
  assert.equal(strategy.windowsLoginMode, "host-metrics");
  assert.deepEqual(
    strategy.evaluate({ windows: true, protocolReady: false, arpVisible: true, hostPingReady: false }),
    { state: "network-visible", reasonCode: "GUEST_NETWORK_VISIBLE", networkVisible: true, ready: false },
  );
  assert.deepEqual(
    strategy.evaluate({ windows: true, protocolReady: true, arpVisible: true, hostPingReady: false }),
    { state: "protocol-ready", reasonCode: "GUEST_PROTOCOL_READY", networkVisible: true, ready: false },
  );
  assert.deepEqual(
    strategy.evaluate({ windows: true, protocolReady: true, arpVisible: true, hostPingReady: true }),
    { state: "ready", reasonCode: "GUEST_READY", networkVisible: true, ready: true },
  );
});

test("PVE and VMware expose the same readiness shape without XenServer-only signals", () => {
  for (const providerType of ["proxmox", "vmware"] as const) {
    const strategy = resolveProvisioningReadinessStrategy(providerType);
    assert.equal(strategy.usesHostTunnel, false);
    assert.equal(strategy.windowsLoginMode, "guest-credentials");
    assert.deepEqual(
      strategy.evaluate({ windows: true, protocolReady: true, arpVisible: false, hostPingReady: false }),
      { state: "ready", reasonCode: "GUEST_READY", networkVisible: true, ready: true },
    );
  }
});
