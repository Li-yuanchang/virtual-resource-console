import assert from "node:assert/strict";
import test from "node:test";
import { defaultInstallProfileForIdentity, resolveIsoInstallProfileHint } from "../src/isoInstallProfile.js";
import type { EnvironmentProvisioningTemplate, IsoImage } from "../src/types.js";

function image(name: string): IsoImage {
  return { id: name, providerId: name, name, storageRepository: "iso" };
}

const kylinTemplates: EnvironmentProvisioningTemplate[] = [
  {
    id: "kylin-server",
    name: "Kylin server",
    providerType: "proxmox",
    sourceType: "iso",
    isoNamePattern: "Kylin-Server.iso",
    specId: "linux",
    ipPoolId: "",
    vmNamePrefix: "kylin",
    autoStart: true,
    installStrategy: "kickstart",
    installProfile: "server",
  },
  {
    id: "kylin-desktop",
    name: "Kylin desktop",
    providerType: "proxmox",
    sourceType: "iso",
    isoNamePattern: "Kylin-Server.iso",
    specId: "linux",
    ipPoolId: "",
    vmNamePrefix: "kylin",
    autoStart: true,
    installStrategy: "kickstart",
    installProfile: "desktop",
  },
];

test("detects an Ubuntu desktop ISO from the media identity", () => {
  assert.deepEqual(
    resolveIsoInstallProfileHint("xenserver", image("ubuntu-20.04.6-desktop-amd64.iso"), []),
    { available: ["desktop"], recommended: "desktop", source: "media-name" },
  );
});

test("exposes both profiles when maintained templates share one installer", () => {
  assert.deepEqual(
    resolveIsoInstallProfileHint("proxmox", image("Kylin-Server.iso"), kylinTemplates),
    { available: ["server", "desktop"], recommended: "server", source: "template" },
  );
});

test("keeps an explicit server installer on the CLI profile", () => {
  assert.deepEqual(
    resolveIsoInstallProfileHint("proxmox", image("ubuntu-22.04-live-server-amd64.iso"), []),
    { available: ["server"], recommended: "server", source: "media-name" },
  );
});

test("exposes CLI and Desktop for supported Windows Server media", () => {
  assert.deepEqual(
    resolveIsoInstallProfileHint(
      "xenserver",
      image("cn_windows_server_2012_r2_vl_with_update_x64_dvd_6052729(1).iso"),
      [],
    ),
    { available: ["server", "desktop"], recommended: "desktop", source: "media-name" },
  );
});

test("defaults omitted Windows install profiles to Desktop while Linux stays CLI", () => {
  assert.equal(defaultInstallProfileForIdentity("cn_windows_server_2008_r2_x64.iso"), "desktop");
  assert.equal(defaultInstallProfileForIdentity("Windows Server 2012 R2"), "desktop");
  assert.equal(defaultInstallProfileForIdentity("CentOS-7-x86_64-DVD.iso"), "server");
});
