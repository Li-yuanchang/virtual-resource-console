import assert from "node:assert/strict";
import test from "node:test";
import type { MetricSample } from "../src/types.js";
import { metricSamplesToVmSnapshots } from "../src/xenserver.js";

function sample(
  metric: MetricSample["metric"],
  value: number,
  source: MetricSample["source"],
  guestStatus: NonNullable<MetricSample["guestTelemetry"]>["status"],
): MetricSample {
  return {
    id: `sample-${metric}-${source}`,
    connectionId: "connection-1",
    targetType: "vm",
    targetId: "vm-1",
    metric,
    value,
    unit: metric === "cpu_usage" ? "ratio" : metric.startsWith("disk_") || metric.startsWith("memory_") ? "bytes" : "bytes_per_sec",
    source,
    guestTelemetry: {
      status: guestStatus,
      method: source === "guest-agent" ? "qemu-guest-agent" : source === "guest-tools" ? "vmware-tools" : "unknown",
      message: guestStatus,
    },
    sampledAt: "2026-07-16T00:00:00.000Z",
  };
}

test("prefers Guest metric sources over hypervisor capacity samples", () => {
  const [snapshot] = metricSamplesToVmSnapshots([
    sample("disk_used", 40, "guest-agent", "available"),
    sample("disk_total", 100, "hypervisor", "probing"),
    sample("memory_used", 60, "guest-tools", "available"),
    sample("memory_total", 100, "hypervisor", "unknown"),
  ]);

  assert.equal(snapshot.metricSources.disk, "guest-agent");
  assert.equal(snapshot.metricSources.memory, "guest-tools");
  assert.equal(snapshot.guestTelemetry.status, "available");
});

test("keeps hypervisor-only metrics available when Guest telemetry is unavailable", () => {
  const [snapshot] = metricSamplesToVmSnapshots([
    sample("cpu_usage", 0.25, "hypervisor", "unavailable"),
    sample("disk_total", 100, "hypervisor", "unavailable"),
    sample("net_rx", 1024, "hypervisor", "unavailable"),
  ]);

  assert.equal(snapshot.cpuUsage, 0.25);
  assert.equal(snapshot.diskTotalBytes, 100);
  assert.equal(snapshot.networkRxRate, 1024);
  assert.deepEqual(snapshot.metricSources, {
    cpu: "hypervisor",
    disk: "hypervisor",
    network: "hypervisor",
  });
  assert.equal(snapshot.guestTelemetry.status, "unavailable");
});
