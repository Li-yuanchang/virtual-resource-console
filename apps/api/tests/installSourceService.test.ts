import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  buildXenInstalledHook,
  isXenInstallHostInProvisioningNetwork,
  selectXenInstallHostAddress,
  shouldUseXenKickstart,
  summarizeXenProvisioningNetworkProbe,
  xenInstallRebootDirective,
} from "../src/installSourceService.js";
import type { VmProvisionRequest } from "../src/types.js";

test("physical DVD completion switches to disk boot and prepares guest tools", () => {
  const hook = buildXenInstalledHook("129.20_test");

  assert.match(hook, /HVM-boot-params:order=c/);
  assert.match(hook, /guest-tools\.iso/);
  assert.match(hook, /vbd-insert/);
  assert.match(hook, /vrc-install-complete=true/);
  assert.equal(spawnSync("sh", ["-n"], { input: hook, encoding: "utf8" }).status, 0);
});

test("physical DVD reboot keeps the host-switched tools media mounted", () => {
  assert.equal(xenInstallRebootDirective("host-dvd"), "reboot");
  assert.equal(xenInstallRebootDirective("iso-library"), "reboot --eject");
});

test("prefers an install-source address in the VM subnet", () => {
  assert.equal(
    selectXenInstallHostAddress(
      [
        { ip: "192.168.2.22", management: true },
        { ip: "192.168.127.10", management: false },
      ],
      "192.168.127.0/24",
      ["192.168.127.31"],
    ),
    "192.168.127.10",
  );
});

test("uses the target XenServer management address when VM and management networks are routed", () => {
  assert.equal(
    selectXenInstallHostAddress(
      [{ ip: "192.168.2.22", management: true }],
      "192.168.127.0/24",
      ["192.168.127.31"],
    ),
    "192.168.2.22",
  );
});

test("skips routed-network probing when the XenServer host already belongs to the VM CIDR", () => {
  assert.equal(isXenInstallHostInProvisioningNetwork("192.168.127.10", "192.168.127.0/24"), true);
  assert.equal(isXenInstallHostInProvisioningNetwork("192.168.2.22", "192.168.127.0/24"), false);
});

test("blocks provisioning when the target XenServer host has no route to the VM network", () => {
  const result = summarizeXenProvisioningNetworkProbe({
    cidr: "192.168.127.0/24",
    sampleIp: "192.168.127.31",
    installHost: "192.168.2.22",
    routeAvailable: false,
    gatewayReachable: false,
  });

  assert.equal(result.status, "unreachable");
  assert.match(result.message, /未找到.*路由/);
});

test("accepts a routed VM network when a configured or occupied address responds", () => {
  const result = summarizeXenProvisioningNetworkProbe({
    cidr: "192.168.127.0/24",
    sampleIp: "192.168.127.31",
    installHost: "192.168.2.22",
    routeAvailable: true,
    gatewayReachable: true,
    respondingTarget: "192.168.127.254",
  });

  assert.equal(result.status, "reachable");
  assert.equal(result.respondingTarget, "192.168.127.254");
});

test("allows provisioning with a warning when routing exists but ICMP is disabled", () => {
  const result = summarizeXenProvisioningNetworkProbe({
    cidr: "192.168.127.0/24",
    sampleIp: "192.168.127.31",
    installHost: "192.168.2.22",
    routeAvailable: true,
    gatewayReachable: false,
  });

  assert.equal(result.status, "route-only");
  assert.match(result.message, /允许继续创建/);
});


test("routes Rocky ISO installs to the XenServer kickstart install source", () => {
  const rocky = {
    providerType: "xenserver",
    sourceType: "iso",
    isoName: "Rocky-9.6-x86_64-minimal.iso",
    isoId: "rocky-9.6",
  } as unknown as VmProvisionRequest;

  assert.equal(shouldUseXenKickstart(rocky), true);
});

test("keeps non-RHEL ISO installs off the kickstart install source", () => {
  const windows = {
    providerType: "xenserver",
    sourceType: "iso",
    isoName: "windows_server_2012_r2.iso",
    isoId: "win-2012",
  } as unknown as VmProvisionRequest;

  assert.equal(shouldUseXenKickstart(windows), false);
});
