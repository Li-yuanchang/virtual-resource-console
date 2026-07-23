import assert from "node:assert/strict";
import test from "node:test";
import { validateProvisionPlan } from "../src/provisioningPlanPolicy.js";
import type { ProviderType, VmProvisionRequest } from "../src/types.js";

function request(providerType: ProviderType): VmProvisionRequest {
  return {
    providerType,
    sourceType: "template",
    templateName: "base-template",
    specId: "spec",
    vmNamePrefix: "vm",
    count: 1,
    ipPool: { id: "pool", name: "pool", cidr: "192.0.2.0/24", gateway: "192.0.2.254", dns: ["192.0.2.254"], startIp: "192.0.2.10", endIp: "192.0.2.20", reservedIps: [] },
    autoStart: false,
    planItems: [{ name: "vm-1", ip: "192.0.2.10", cpu: 2, memoryGiB: 4, diskGiB: 40 }],
  };
}

test("platform-specific plan validation is selected by provider policy", () => {
  assert.equal(validateProvisionPlan("vmware", request("vmware"), { templateName: "base-template" }).length, 0);
  assert.match(validateProvisionPlan("xenserver", request("xenserver"), { templateName: "base-template" }).join("；"), /ISO\/Kickstart/);
  assert.match(validateProvisionPlan("proxmox", request("proxmox"), {}).join("；"), /克隆源/);
});

test("manual ISO fallback is allowed only where the provider has a registered strategy", () => {
  const pveRequest: VmProvisionRequest = {
    ...request("proxmox"),
    sourceType: "iso",
    templateName: undefined,
    installStrategy: "manual-iso",
    installProfile: "desktop",
    isoId: "local:iso/ubuntu-desktop.iso",
    isoName: "ubuntu-20.04.6-desktop-amd64.iso",
  };
  const xenRequest: VmProvisionRequest = {
    ...pveRequest,
    providerType: "xenserver",
    isoId: "iso-uuid",
  };

  assert.match(validateProvisionPlan("proxmox", pveRequest, {}).join("；"), /尚未配置所选 ISO/);
  assert.equal(validateProvisionPlan("xenserver", xenRequest, {}).length, 0);
});
