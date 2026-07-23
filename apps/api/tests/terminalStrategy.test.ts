import assert from "node:assert/strict";
import test from "node:test";
import { selectTerminalStrategy } from "../src/terminal/index.js";

const baseInput = {
  connectionId: "connection-1",
  vmId: "vm-1",
  runtime: "web" as const,
  mode: "linux-cli" as const,
  powerState: "running" as const,
  guestOs: "CentOS 9",
  guestIp: "192.0.2.20",
  hasSystemCredential: true,
  hasSerialDevice: false,
};

test("uses the provider strategy to prefer Proxmox serial and falls back to SSH", () => {
  const serial = selectTerminalStrategy({ ...baseInput, providerType: "proxmox", mode: "serial-console", hasSerialDevice: true });
  assert.equal(serial.session?.transport, "serial-pty");

  const ssh = selectTerminalStrategy({ ...baseInput, providerType: "proxmox" });
  assert.equal(ssh.session?.transport, "ssh-pty");
});

test("XenServer and VMware use the common SSH baseline without platform branches in callers", () => {
  for (const providerType of ["xenserver", "vmware"] as const) {
    const result = selectTerminalStrategy({ ...baseInput, providerType });
    assert.equal(result.session?.mode, "linux-cli");
    assert.equal(result.session?.transport, "ssh-pty");
  }
});

test("returns structured, retryable failures for an unavailable guest network", () => {
  const result = selectTerminalStrategy({ ...baseInput, providerType: "xenserver", guestIp: undefined });
  assert.equal(result.session, undefined);
  assert.deepEqual(result.failure, {
    code: "GUEST_NETWORK_UNAVAILABLE",
    message: "尚未获取虚拟机 IP，暂时无法打开 Linux CLI。",
    retryable: true,
  });
});

test("requests interactive login when no saved or one-time credential is available", () => {
  const result = selectTerminalStrategy({ ...baseInput, providerType: "vmware", hasSystemCredential: false });
  assert.equal(result.session, undefined);
  assert.deepEqual(result.failure, {
    code: "SYSTEM_CREDENTIAL_REQUIRED",
    message: "请输入 Linux 登录账号和密码。",
    retryable: true,
  });
});

test("exposes capabilities separately from the requested session", () => {
  const result = selectTerminalStrategy({ ...baseInput, providerType: "proxmox", hasSerialDevice: false });
  assert.deepEqual(result.capabilities.capabilities.map((capability) => capability.mode), ["serial-console", "linux-cli"]);
  assert.equal(result.capabilities.capabilities[0]?.supported, false);
  assert.equal(result.capabilities.capabilities[0]?.reasonCode, "SERIAL_UNAVAILABLE");
  assert.equal(result.capabilities.capabilities[1]?.supported, true);
});

test("rejects runtimes that cannot carry an interactive terminal session", () => {
  const runtime = selectTerminalStrategy({ ...baseInput, providerType: "xenserver", runtime: "web" });
  assert.equal(runtime.failure, undefined);

  const unknown = selectTerminalStrategy({ ...baseInput, providerType: "libvirt", runtime: "chrome-extension" });
  assert.equal(unknown.session, undefined);
  assert.equal(unknown.failure?.code, "RUNTIME_NOT_ALLOWED");
});
