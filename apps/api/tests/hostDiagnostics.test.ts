import assert from "node:assert/strict";
import test from "node:test";
import { parseHostDiagnostics } from "../src/xenserver.js";
import { buildVmwareHostDiagnostics } from "../src/vmware.js";

const HEALTHY_OUTPUT = [
  "META\thost-1\txenserver-5\t192.168.2.11\t6.5",
  "ROOT\t/dev/sda1\t10240000\t7372800\t2867200\t72%\t/",
  "DELETED_SUMMARY\t0\t0",
  "OVS\t2\t2\topenvswitch is running",
  "BRIDGE\txenbr0\t4\t3",
  "BRIDGE\txenbr1\t2\t2",
  "SR_DIAG\tsr-1\tLocal storage\tlvm\tok",
  "SR_DIAG\tsr-2\tISO Library\tiso\tok",
  "VIF\tvif-1\t74\t02:16:3e:02:5a:01\tPool-wide network associated with eth0\ttrue\txenbr0",
  "PING\t192.168.2.91\t3\t3\t0\trtt min/avg/max/mdev = 0.2/0.3/0.5/0.1 ms",
].join("\n");

test("parses a healthy host as low risk with all checks ok", () => {
  const report = parseHostDiagnostics(HEALTHY_OUTPUT, { hostId: "host-1", vmId: "vm-1", vmName: "2.91", vmIp: "192.168.2.91" });
  assert.equal(report.hostName, "xenserver-5");
  assert.equal(report.hostAddress, "192.168.2.11");
  assert.equal(report.platformVersion, "6.5");
  assert.equal(report.conclusion.riskLevel, "low");
  const byKey = new Map(report.checks.map((check) => [check.key, check]));
  assert.equal(byKey.get("root-partition")?.status, "ok");
  assert.equal(byKey.get("deleted-open-files")?.status, "ok");
  assert.equal(byKey.get("ovs-service")?.status, "ok");
  assert.equal(byKey.get("bridges")?.status, "ok");
  assert.equal(byKey.get("storage-repositories")?.status, "ok");
  assert.equal(byKey.get("vif-bridge")?.status, "ok");
  assert.equal(byKey.get("vm-ping")?.status, "ok");
  assert.deepEqual(report.repairActions, []);
});

test("marks root partition warn at 88% and error at 96%", () => {
  const warn = parseHostDiagnostics(HEALTHY_OUTPUT.replace("72%", "88%"), {});
  assert.equal(warn.checks.find((check) => check.key === "root-partition")?.status, "warn");
  assert.equal(warn.conclusion.riskLevel, "medium");
  assert.ok(warn.repairActions.some((action) => action.key === "repair-root-partition"));

  const error = parseHostDiagnostics(HEALTHY_OUTPUT.replace("72%", "96%"), {});
  assert.equal(error.checks.find((check) => check.key === "root-partition")?.status, "error");
  assert.equal(error.conclusion.riskLevel, "high");
  assert.equal(error.conclusion.faultPoint, "根分区空间");
});

test("flags deleted open files as warn with evidence", () => {
  const output = [
    "META\thost-1\txenserver-5\t192.168.2.11\t6.5",
    "ROOT\t/dev/sda1\t10240000\t7372800\t2867200\t72%\t/",
    "DELETED_SUMMARY\t2\t524288000",
    "DELETED_FILE\t1234\t524288000\t/var/log/messages (deleted)",
    "OVS\t2\t2\topenvswitch is running",
    "BRIDGE\txenbr0\t4\t3",
  ].join("\n");
  const report = parseHostDiagnostics(output, {});
  const check = report.checks.find((item) => item.key === "deleted-open-files");
  assert.equal(check?.status, "warn");
  assert.equal(check?.summary, "2 个已删除但仍被占用的文件，合计 500 MB");
  assert.ok(report.repairActions.some((action) => action.key === "repair-deleted-open-files"));
});

test("flags VIF missing bridge as error and emits attach command suggestion", () => {
  const output = [
    "META\thost-1\txenserver-5\t192.168.2.11\t6.5",
    "ROOT\t/dev/sda1\t10240000\t7372800\t2867200\t72%\t/",
    "DELETED_SUMMARY\t0\t0",
    "OVS\t2\t2\topenvswitch is running",
    "BRIDGE\txenbr0\t4\t2",
    "VIF\tvif-1\t74\t02:16:3e:02:5a:01\tPool-wide network associated with eth0\ttrue\t",
    "PING\t192.168.2.91\t3\t0\t100\t",
  ].join("\n");
  const report = parseHostDiagnostics(output, { hostId: "host-1", vmId: "vm-1", vmIp: "192.168.2.91" });
  const vifCheck = report.checks.find((item) => item.key === "vif-bridge");
  assert.equal(vifCheck?.status, "error");
  const pingCheck = report.checks.find((item) => item.key === "vm-ping");
  assert.equal(pingCheck?.status, "error");
  assert.equal(report.conclusion.riskLevel, "high");
  const attach = report.repairActions.find((action) => action.key === "repair-vif-bridge");
  assert.ok(attach);
  assert.ok(attach.commands.includes("ovs-vsctl add-port xenbr0 vif74.0"));
  assert.ok(attach.verificationCommands.includes("ovs-vsctl iface-to-br vif74.0"));
});

test("reports unknown when OVS data and bridge data are both missing", () => {
  const output = [
    "META\thost-1\txenserver-5\t192.168.2.11\t6.5",
    "ROOT\t/dev/sda1\t10240000\t7372800\t2867200\t72%\t/",
    "DELETED_SUMMARY\t0\t0",
    "OVS\t0\t0\t",
  ].join("\n");
  const report = parseHostDiagnostics(output, {});
  const ovs = report.checks.find((item) => item.key === "ovs-service");
  assert.equal(ovs?.status, "unknown");
  const bridge = report.checks.find((item) => item.key === "bridges");
  assert.equal(bridge?.status, "unknown");
  assert.equal(report.conclusion.riskLevel, "low");
});


const VMWARE_INPUT = { host: "192.168.2.17", port: 443, username: "administrator@vsphere.local", password: "x" };

const HEALTHY_VMWARE = {
  host: {
    name: "esxi-01",
    connectionState: "connected",
    productFullName: "VMware ESXi 8.0",
    cpuModel: "Intel Xeon Silver 4314",
    cpuUsageMhz: 4000,
    cpuMhz: 2400,
    numCpuCores: 16,
    memoryTotalBytes: 64 * 1024 ** 3,
    memoryUsageMb: 8192,
    pnics: [
      { device: "vmnic0", linked: true },
      { device: "vmnic1", linked: true },
    ],
    vmknicIps: ["192.168.2.17"],
  },
  datastores: [{ name: "datastore1", capacityBytes: 2 * 1024 ** 4, freeSpaceBytes: 1 * 1024 ** 4, accessible: true, type: "VMFS" }],
  services: [
    { key: "hostd", label: "Host Agent", running: true, policy: "automatic" },
    { key: "vpxa", label: "VMware vCenter Agent", running: true, policy: "automatic" },
  ],
  sensors: [{ name: "CPU0 Temp", health: "green", sensorType: "temperature", currentReading: "42", baseUnits: "Celsius" }],
  storageStatus: [{ name: "mpx.vmhba0:C0:T0:L0", health: "green" }],
  vm: {
    name: "win-01",
    powerState: "poweredOn",
    toolsStatus: "toolsOk",
    guestIp: "192.168.2.91",
    guestNics: [{ deviceName: "vmnic0", network: "VM Network", connected: true, ipAddresses: ["192.168.2.91"] }],
  },
};

test("builds a healthy vmware host as low risk with all checks ok", () => {
  const report = buildVmwareHostDiagnostics(VMWARE_INPUT, { hostId: "host-1", vmId: "vm-1" }, HEALTHY_VMWARE);
  assert.equal(report.providerType, "vmware");
  assert.equal(report.supported, true);
  assert.equal(report.hostName, "esxi-01");
  assert.equal(report.hostAddress, "192.168.2.17");
  assert.equal(report.conclusion.riskLevel, "low");
  const byKey = new Map(report.checks.map((check) => [check.key, check]));
  assert.equal(byKey.get("node-load")?.status, "ok");
  assert.equal(byKey.get("datastore-usage")?.status, "ok");
  assert.equal(byKey.get("storage-health")?.status, "ok");
  assert.equal(byKey.get("esx-services")?.status, "ok");
  assert.equal(byKey.get("sensor-health")?.status, "ok");
  assert.equal(byKey.get("network-vmk")?.status, "ok");
  assert.equal(byKey.get("vm-link")?.status, "ok");
  assert.deepEqual(report.repairActions, []);
});

test("flags high datastore usage and stopped core services as errors", () => {
  const data = {
    ...HEALTHY_VMWARE,
    datastores: [{ name: "datastore1", capacityBytes: 1000, freeSpaceBytes: 10, accessible: true, type: "VMFS" }],
    services: [
      { key: "hostd", label: "Host Agent", running: false, policy: "automatic" },
      { key: "vpxa", label: "VMware vCenter Agent", running: false, policy: "automatic" },
    ],
  };
  const report = buildVmwareHostDiagnostics(VMWARE_INPUT, {}, data);
  assert.equal(report.checks.find((check) => check.key === "datastore-usage")?.status, "error");
  assert.equal(report.checks.find((check) => check.key === "esx-services")?.status, "error");
  assert.equal(report.conclusion.riskLevel, "high");
  assert.equal(report.conclusion.faultPoint, "数据存储空间");
  assert.ok(report.repairActions.some((action) => action.key === "repair-datastore-usage"));
  assert.ok(report.repairActions.some((action) => action.key === "repair-esx-services"));
});

test("flags red hardware sensors and yellow storage health", () => {
  const data = {
    ...HEALTHY_VMWARE,
    sensors: [
      { name: "CPU0 Temp", health: "red", sensorType: "temperature", currentReading: "95", baseUnits: "Celsius" },
      { name: "Fan1", health: "green", sensorType: "fan" },
    ],
    storageStatus: [{ name: "disk0", health: "yellow" }],
  };
  const report = buildVmwareHostDiagnostics(VMWARE_INPUT, {}, data);
  assert.equal(report.checks.find((check) => check.key === "sensor-health")?.status, "error");
  assert.equal(report.checks.find((check) => check.key === "storage-health")?.status, "warn");
  assert.equal(report.conclusion.riskLevel, "high");
  assert.ok(report.repairActions.some((action) => action.key === "repair-sensor-health"));
});

test("marks vm-link warn when the vm is powered off", () => {
  const data = {
    ...HEALTHY_VMWARE,
    vm: { name: "win-01", powerState: "poweredOff", toolsStatus: "toolsNotRunning", guestIp: "", guestNics: [] },
  };
  const report = buildVmwareHostDiagnostics(VMWARE_INPUT, { vmId: "vm-1" }, data);
  assert.equal(report.checks.find((check) => check.key === "vm-link")?.status, "warn");
  assert.equal(report.conclusion.riskLevel, "medium");
});

test("reports unknown checks when no host evidence is collected", () => {
  const report = buildVmwareHostDiagnostics(VMWARE_INPUT, {}, { datastores: [], services: [], sensors: [], storageStatus: [] });
  assert.ok(report.checks.length > 0);
  assert.ok(report.checks.every((check) => check.status === "unknown"));
  assert.equal(report.conclusion.riskLevel, "none");
});
