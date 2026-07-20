import assert from "node:assert/strict";
import test from "node:test";
import { validateProvisioningIpPool } from "../src/domain/ipPoolValidation.js";
import type { IpPoolConfig } from "../src/types.js";

const xenPool: IpPoolConfig = {
  id: "pool-127",
  name: "192.168.127 通用网段",
  cidr: "192.168.127.0/24",
  gateway: "192.168.127.254",
  dns: ["202.102.152.3"],
  startIp: "192.168.127.20",
  endIp: "192.168.127.250",
  reservedIps: [],
};

test("accepts a valid XenServer provisioning pool before ping", () => {
  assert.equal(validateProvisioningIpPool(xenPool, "xenserver"), "");
});

test("accepts a configured dot-254 gateway on a new subnet without code changes", () => {
  assert.equal(
    validateProvisioningIpPool(
      {
        ...xenPool,
        cidr: "10.20.30.0/24",
        gateway: "10.20.30.254",
        startIp: "10.20.30.20",
        endIp: "10.20.30.250",
      },
      "xenserver",
    ),
    "",
  );
});

test("blocks ping when the configured gateway is outside the pool subnet", () => {
  const message = validateProvisioningIpPool({ ...xenPool, gateway: "192.168.2.1" }, "xenserver");
  assert.match(message, /不属于 192\.168\.127\.0\/24/);
  assert.match(message, /设置 → IP 池/);
  assert.match(message, /PING IP/);
});

test("checks XenServer CIDR and DNS before ping", () => {
  assert.match(validateProvisioningIpPool({ ...xenPool, cidr: "192.168.127.0" }, "xenserver"), /有效 CIDR/);
  assert.match(validateProvisioningIpPool({ ...xenPool, dns: [] }, "xenserver"), /有效 DNS/);
});
