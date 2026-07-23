import assert from "node:assert/strict";
import test from "node:test";
import { ProvisionRecoveryVmMissingError, resolveProvisionRecoveryVms } from "../src/provisionRecovery.js";
import type { VirtualizationProvider } from "../src/providers/provider.js";
import type { ProvisionTask, VmProvisionRequest, XenConnectionInput } from "../src/types.js";

const connection: XenConnectionInput = { host: "192.0.2.10", port: 22, username: "root", password: "secret" };
const request: VmProvisionRequest = {
  connectionId: "connection-1",
  providerType: "xenserver",
  hostId: "host-1",
  sourceType: "iso",
  vmNamePrefix: "vm",
  count: 1,
  autoStart: true,
  ipPool: {
    id: "pool-1",
    name: "test",
    cidr: "192.168.127.0/24",
    gateway: "192.168.127.254",
    dns: ["202.102.152.3"],
    startIp: "192.168.127.20",
    endIp: "192.168.127.250",
    reservedIps: [],
  },
  planItems: [{ name: "127.31_test", ip: "192.168.127.31", rootPassword: "root@127.31", cpu: 4, memoryGiB: 8, diskGiB: 100 }],
};

function task(providerId?: string): ProvisionTask {
  return {
    id: "task-1",
    connectionId: "connection-1",
    providerType: "xenserver",
    hostId: "host-1",
    title: "test",
    status: "running",
    currentStep: "install-guest",
    progressPercent: 50,
    eventSeq: 1,
    message: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    steps: [],
    vms: [{ name: "127.31_test", ip: "192.168.127.31", providerId, status: "running" }],
  };
}

function provider(listVms: VirtualizationProvider<XenConnectionInput>["listVms"]): VirtualizationProvider<XenConnectionInput> {
  return {
    type: "xenserver",
    listVms,
  } as VirtualizationProvider<XenConnectionInput>;
}

test("recovery validates a saved VM UUID against live inventory", async () => {
  let listCalls = 0;
  const recovered = await resolveProvisionRecoveryVms({
    task: task("vm-1"),
    context: { request },
    connection,
    provider: provider(async () => {
      listCalls += 1;
      return {
        page: 1,
        pageSize: 1000,
        total: 1,
        items: [{
          id: "provider:vm-1",
          connectionId: "connection-1",
          providerId: "vm-1",
          name: "127.31_test",
          powerState: "running",
          cpuCount: 4,
          memoryBytes: 8 * 1024 ** 3,
          ipAddresses: ["192.168.127.31"],
          toolsStatus: "unknown",
          reclaimLevel: "P3",
          reclaimReason: "test",
        }],
      };
    }),
  });
  assert.equal(listCalls, 1);
  assert.equal(recovered[0].providerId, "vm-1");
});

test("recovery rejects a missing saved UUID instead of adopting a same-name replacement", async () => {
  await assert.rejects(
    resolveProvisionRecoveryVms({
      task: task("deleted-vm"),
      context: { request },
      connection,
      provider: provider(async () => ({
        page: 1,
        pageSize: 1000,
        total: 1,
        items: [{
          id: "provider:new-vm",
          connectionId: "connection-1",
          providerId: "new-vm",
          name: "127.31_test",
          powerState: "running",
          cpuCount: 4,
          memoryBytes: 8 * 1024 ** 3,
          ipAddresses: ["192.168.127.31"],
          toolsStatus: "unknown",
          reclaimLevel: "P3",
          reclaimReason: "test",
        }],
      })),
    }),
    ProvisionRecoveryVmMissingError,
  );
});

test("recovery accepts only one exact VM name match", async () => {
  const recoveredNames: string[] = [];
  const recovered = await resolveProvisionRecoveryVms({
    task: task(),
    context: { request },
    connection,
    provider: provider(async () => ({
      page: 1,
      pageSize: 100,
      total: 1,
      items: [{
        id: "provider:vm-2",
        connectionId: "connection-1",
        providerId: "vm-2",
        name: "127.31_test",
        powerState: "running",
        cpuCount: 4,
        memoryBytes: 8 * 1024 ** 3,
        ipAddresses: ["192.168.127.31"],
        toolsStatus: "unknown",
        reclaimLevel: "P3",
        reclaimReason: "test",
      }],
    })),
    onRecoveredVm: (name) => recoveredNames.push(name),
  });
  assert.deepEqual(recoveredNames, ["127.31_test"]);
  assert.equal(recovered[0].providerId, "vm-2");
});
