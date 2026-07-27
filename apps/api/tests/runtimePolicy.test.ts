import assert from "node:assert/strict";
import test from "node:test";
import type { IpPoolPolicy, RuntimeIpPoolPolicy } from "../src/ipPoolPolicy.js";
import { buildXenServerPolicyEnv, createRuntimePolicy, inferIpv4FromName, isManagedIpv4 } from "../src/runtimePolicy.js";

function createIpPool(prefix: string, overrides: Partial<RuntimeIpPoolPolicy> = {}): RuntimeIpPoolPolicy {
  return {
    id: `pool-${prefix.replaceAll(".", "-")}`,
    name: `${prefix} 网段`,
    prefix,
    gateway: `${prefix}.254`,
    startHost: 20,
    endHost: 250,
    ...overrides,
  };
}

function createIpPoolPolicy(ipPools: RuntimeIpPoolPolicy[]): IpPoolPolicy {
  return {
    defaultDns: ["202.102.152.3"],
    ipPools,
  };
}

test("derives short VM IP rules from IP pool prefixes", () => {
  const policy = createRuntimePolicy(
    createIpPoolPolicy([
      createIpPool("192.168.129", { hostPrefixes: ["192.168.129"] }),
      createIpPool("192.168.2"),
      createIpPool("192.168.127", { networkName: "Pool-wide network associated with eth1" }),
    ]),
  );

  assert.equal(policy.ipInference.shortIpBasePrefix, "192.168");
  assert.deepEqual(policy.ipInference.shortIpThirdOctets, ["2", "127", "129"]);
  assert.deepEqual(policy.ipInference.shortIpPrefixes, ["192.168.2", "192.168.127", "192.168.129"]);
  assert.equal(policy.ipInference.hostOnlyPrefix, "192.168.2");
  assert.doesNotMatch(policy.managedIpPattern ?? "", /\(\?:/);
  assert.equal(inferIpv4FromName("2.105-service", policy), "192.168.2.105");
  assert.equal(inferIpv4FromName("127-100-openEuler", policy), "192.168.127.100");
  assert.equal(inferIpv4FromName("129.88-linux", policy), "192.168.129.88");
  assert.equal(inferIpv4FromName("56_service", policy), "192.168.2.56");
});

test("automatically includes a newly added IP pool subnet", () => {
  const policy = createRuntimePolicy(
    createIpPoolPolicy([
      createIpPool("192.168.2"),
      createIpPool("192.168.127"),
      createIpPool("192.168.130"),
    ]),
  );

  assert.deepEqual(policy.ipInference.shortIpThirdOctets, ["2", "127", "130"]);
  assert.equal(inferIpv4FromName("130.66-new-segment", policy), "192.168.130.66");
  assert.equal(isManagedIpv4("192.168.130.66", policy), true);
  assert.equal(isManagedIpv4("192.168.129.66", policy), false);
});

test("uses full IP pool prefixes when pools span different base prefixes", () => {
  const policy = createRuntimePolicy(
    createIpPoolPolicy([
      createIpPool("192.168.127"),
      createIpPool("10.20.130"),
    ]),
  );

  assert.equal(policy.ipInference.shortIpBasePrefix, "");
  assert.deepEqual(policy.ipInference.shortIpThirdOctets, []);
  assert.equal(inferIpv4FromName("130.66-service", policy), "10.20.130.66");
  assert.equal(buildXenServerPolicyEnv(policy).VRC_SHORT_IP_PREFIXES, "10.20.130 192.168.127");
});

test("disables name inference when the IP pool file is unavailable", () => {
  const policy = createRuntimePolicy();

  assert.equal(policy.ipInference.enabled, false);
  assert.equal(policy.managedIpPattern, "");
  assert.equal(inferIpv4FromName("127.123_windows", policy), "");
});
