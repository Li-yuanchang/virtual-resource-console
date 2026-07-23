import assert from "node:assert/strict";
import test from "node:test";
import type { VirtualizationProvider } from "../src/providers/provider.js";
import type { VmResizeExecutionRequest, XenConnectionInput } from "../src/types.js";
import { executeVmResize, inspectVmResizeStorage, VmResizeValidationError } from "../src/vmResizeService.js";

const connection: XenConnectionInput = {
  host: "192.0.2.10",
  port: 22,
  username: "platform-user",
  password: "platform-password",
};

test("backend strips UI intent down to one provider execution request", async () => {
  let received: VmResizeExecutionRequest | undefined;
  const provider = {
    type: "xenserver",
    listVms: async () => ({
      items: [{ providerId: "vm-1", id: "vm-1", name: "vm-1", powerState: "running", ipAddresses: [] }],
      page: 1,
      pageSize: 500,
      total: 1,
    }),
    resizeVm: async (_connection: XenConnectionInput, vmId: string, request: VmResizeExecutionRequest) => {
      received = request;
      return {
        vmId,
        name: "vm-1",
        accepted: true,
        previousCpuCount: 2,
        cpuCount: request.cpuCount ?? 2,
        previousMemoryBytes: 4 * 1024 ** 3,
        memoryBytes: request.memoryBytes ?? 4 * 1024 ** 3,
        disks: [],
        stopped: false,
        restarted: false,
        message: "扩容完成",
      };
    },
  } as unknown as VirtualizationProvider<XenConnectionInput>;

  await executeVmResize({
    provider,
    connection,
    vmId: "vm-1",
    systemCredentials: {
      username: "root",
      password: "one-time-password",
    },
    request: {
      cpuCount: 4,
      allowShutdown: true,
      restartAfterResize: true,
    },
  });

  assert.equal(received?.cpuCount, 4);
  assert.equal(received?.allowShutdown, true);
  assert.equal("storageTarget" in (received as object), false);
  assert.equal("systemCredentials" in (received as object), false);
  assert.equal("password" in (received as object), false);
});

test("backend rejects every resize request for a powered-off VM before provider mutation", async () => {
  let mutated = false;
  const provider = {
    type: "vmware",
    listVms: async () => ({
      items: [{ providerId: "vm-off", id: "vm-off", name: "vm-off", powerState: "halted", ipAddresses: [] }],
      page: 1,
      pageSize: 500,
      total: 1,
    }),
    resizeVm: async () => {
      mutated = true;
      throw new Error("must not run");
    },
  } as unknown as VirtualizationProvider<XenConnectionInput>;

  await assert.rejects(
    executeVmResize({
      provider,
      connection,
      vmId: "vm-off",
      request: { cpuCount: 8, allowShutdown: true, restartAfterResize: true },
    }),
    (error: unknown) => error instanceof VmResizeValidationError && /虚拟机已关机，请先开机后再扩容/.test(error.message),
  );
  assert.equal(mutated, false);
});

test("backend rejects disk intent without a final system directory before provider mutation", async () => {
  let mutated = false;
  const provider = {
    type: "proxmox",
    resizeVm: async () => {
      mutated = true;
      throw new Error("must not run");
    },
  } as unknown as VirtualizationProvider<XenConnectionInput>;

  await assert.rejects(
    executeVmResize({
      provider,
      connection,
      vmId: "vm-1",
      request: {
        disk: { mode: "extend", diskId: "disk-1", sizeBytes: 120 * 1024 ** 3 },
        allowShutdown: true,
        restartAfterResize: true,
      },
    }),
    /必须选择最终生效目录/,
  );
  assert.equal(mutated, false);
});

test("backend rejects a system directory without a disk action", async () => {
  const provider = {
    type: "vmware",
    resizeVm: async () => {
      throw new Error("must not run");
    },
  } as unknown as VirtualizationProvider<XenConnectionInput>;

  await assert.rejects(
    executeVmResize({
      provider,
      connection,
      vmId: "vm-1",
      request: {
        storageTarget: { mountPath: "/data" },
        allowShutdown: true,
        restartAfterResize: true,
      },
    }),
    /必须与磁盘扩容同时提交/,
  );
});

test("does not attempt guest SSH inspection for a powered-off VM", async () => {
  let guestCommandCalled = false;
  const provider = {
    type: "vmware",
    listVms: async () => ({
      items: [{ providerId: "vm-1", id: "vm-1", name: "vm-1", powerState: "halted", ipAddresses: ["192.0.2.20"] }],
      page: 1,
      pageSize: 500,
      total: 1,
    }),
    listVmDisks: async () => [],
    executeGuestCommand: async () => {
      guestCommandCalled = true;
      throw new Error("SSH must not be attempted for a powered-off VM");
    },
  } as unknown as VirtualizationProvider<XenConnectionInput>;

  const inventory = await inspectVmResizeStorage({
    provider,
    connection,
    vmId: "vm-1",
  });

  assert.equal(guestCommandCalled, false);
  assert.equal(inventory.supported, false);
  assert.equal(inventory.reasonCode, "GUEST_OFFLINE");
  assert.match(inventory.message, /已关机/);
});
