import assert from "node:assert/strict";
import test from "node:test";
import { resolvePreferredConsoleMode, resolveVmGraphConsoleTarget } from "../src/domain/consoleStrategies.js";
import type { StoredConnectionSummary, VmNode } from "../src/types.js";

function vm(input: Pick<VmNode, "guestOs"> & { metadata?: Record<string, unknown> }): VmNode {
  return {
    id: "vm-1",
    connectionId: "connection-1",
    providerId: "provider-vm-1",
    name: "test-vm",
    powerState: "running",
    cpuCount: 2,
    memoryBytes: 4 * 1024 ** 3,
    ipAddresses: ["192.168.1.10"],
    toolsStatus: "unknown",
    reclaimLevel: "P3",
    reclaimReason: "",
    ...input,
  };
}

test("opens a Linux guest without a desktop environment in CLI mode", () => {
  assert.equal(resolvePreferredConsoleMode(vm({ guestOs: "Linux" })), "cli");
  assert.equal(resolvePreferredConsoleMode(vm({ guestOs: "openEuler 24.03 LTS" })), "cli");
  assert.equal(resolvePreferredConsoleMode(vm({ guestOs: "CentOS Linux 7" })), "cli");
});

test("uses CLI only when inventory provides an explicit server or terminal signal", () => {
  assert.equal(resolvePreferredConsoleMode(vm({ guestOs: "CentOS Linux 7", metadata: { installProfile: "server" } })), "cli");
  assert.equal(resolvePreferredConsoleMode(vm({ guestOs: "openEuler", metadata: { consoleMode: "ssh-pty" } })), "cli");
});

test("keeps desktop guests on the platform console", () => {
  assert.equal(resolvePreferredConsoleMode(vm({ guestOs: "Ubuntu 24.04 Desktop" })), "graph");
  assert.equal(resolvePreferredConsoleMode(vm({ guestOs: "Kylin Linux Advanced Server with UKUI" })), "graph");
});

test("can force noVNC for a Linux guest while provisioning is still running", () => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: {
        protocol: "http:",
        hostname: "127.0.0.1",
        port: "5173",
      },
    },
  });
  const connection: StoredConnectionSummary = {
    id: "connection-1",
    name: "xenserver-1",
    providerType: "xenserver",
    host: "192.168.2.77",
    port: 22,
    username: "root",
    readonly: true,
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
  };
  const target = resolveVmGraphConsoleTarget({
    connection,
    vm: vm({ guestOs: "CentOS Linux 7", metadata: { installProfile: "server" } }),
    hostName: "xenserver-1",
    hostAddress: "192.168.2.77",
  });
  assert.equal(target?.mode, "novnc");
  assert.equal(target?.transport, "novnc");
  assert.equal(target?.consoleMode, "graph");
});
