import assert from "node:assert/strict";
import test from "node:test";
import { buildUbuntuAutoinstallUserData } from "../src/xenserverUnattendedIso.js";
import type { XenUnattendedIsoInput } from "../src/xenserverUnattendedIso.js";

function input(overrides: Partial<XenUnattendedIsoInput["vm"]> = {}): XenUnattendedIsoInput {
  return {
    connection: { host: "192.0.2.10", port: 22, username: "root", password: "not-used" },
    sourceIsoId: "source-iso",
    sourceIsoName: "ubuntu-24.04.1-desktop-amd64.iso",
    installProfile: "desktop",
    vm: {
      name: "ubu-test-vm",
      ip: "192.168.2.159",
      loginUsername: "ubu",
      rootPassword: "ignored-default-password",
      cpu: 4,
      memoryGiB: 8,
      diskGiB: 100,
      ...overrides,
    },
    ipPool: {
      id: "ubuntu-test",
      name: "Ubuntu test",
      cidr: "192.168.2.0/24",
      gateway: "192.168.2.254",
      dns: ["202.102.152.3"],
      startIp: "192.168.2.20",
      endIp: "192.168.2.250",
      reservedIps: [],
    },
    macAddress: "02:56:52:43:00:1f",
  };
}

test("Ubuntu autoinstall user-data 使用界面「新建用户名」且不落入自定义账号", () => {
  const userData = buildUbuntuAutoinstallUserData(input({ loginUsername: "ubu" }));
  assert.match(userData, /username: ubu/);
  assert.doesNotMatch(userData, /username: vrcadmin/);
  // 密码保持默认 SHA-512 crypt 哈希，不随界面密码调整。
  assert.match(userData, /password: "\$6\$vrcu24\$/);
  assert.match(userData, /hostname: ubu-test-vm/);
  assert.match(userData, /- 192\.168\.2\.159\/24/);
  assert.match(userData, /via: 192\.168\.2\.254/);
  assert.match(userData, /- 202\.102\.152\.3/);
});

test("Ubuntu autoinstall user-data 缺省新建用户名时回退 ubuntu", () => {
  const userData = buildUbuntuAutoinstallUserData(input({ loginUsername: "  " }));
  assert.match(userData, /username: ubuntu/);
  assert.doesNotMatch(userData, /username: vrcadmin/);
});
