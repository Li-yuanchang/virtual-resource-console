import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import {
  buildXenGuestArpProbeCommand,
  buildXenGuestMetricsProbeScript,
  buildXenGuestPingProbeCommand,
  canReadWinRmHttpResponse,
  hasWindowsRemoteInitializationTimedOut,
  isWinRmHttpResponse,
} from "../src/provisioningVerifier.js";

test("XenServer Guest Tools verification reads the supported guest-metrics reference", () => {
  const script = buildXenGuestMetricsProbeScript("vm-uuid");

  assert.match(script, /param-name=guest-metrics\b/);
  assert.doesNotMatch(script, /guest-metrics-uuid/);
  assert.match(script, /data-source=memory_internal_free/);
  assert.match(script, /printf 'READY\\n'/);
});

test("WinRM readiness requires an HTTP response instead of a connected transport", async () => {
  assert.equal(isWinRmHttpResponse("HTTP/1.1 405 Method Not Allowed\r\n"), true);
  assert.equal(isWinRmHttpResponse("HTTP/1.0 401 Unauthorized\r\n"), true);
  assert.equal(isWinRmHttpResponse(""), false);
  assert.equal(isWinRmHttpResponse("SSH-2.0-OpenSSH"), false);

  const server = createServer((socket) => {
    socket.once("data", () => socket.end("HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\n\r\n"));
  });
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    assert.equal(await canReadWinRmHttpResponse("127.0.0.1", address.port, 1000), true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("WinRM readiness rejects a closed direct port", async () => {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert.equal(await canReadWinRmHttpResponse("127.0.0.1", address.port, 200), false);
});

test("XenServer Windows readiness requires a bounded host-side ping", () => {
  assert.equal(buildXenGuestPingProbeCommand("192.168.2.234", 1500), "ping -c 1 -W 2 '192.168.2.234' >/dev/null 2>&1");
  assert.equal(buildXenGuestPingProbeCommand("192.168.2.234", 0), "ping -c 1 -W 1 '192.168.2.234' >/dev/null 2>&1");
  assert.equal(buildXenGuestPingProbeCommand("192.168.2.234'; touch /tmp/x", 1000).includes("'\\''"), true);
});

test("XenServer Windows progress uses a bounded route-aware ARP probe", () => {
  const command = buildXenGuestArpProbeCommand("192.168.2.32");
  assert.match(command, /ip route get '192\.168\.2\.32'/);
  assert.match(command, /arping -c 1 -w 2 -I "\$iface" '192\.168\.2\.32'/);
  assert.doesNotMatch(command, /\btimeout\b/);
  assert.equal(buildXenGuestArpProbeCommand("192.168.2.32'; touch /tmp/x").includes("'\\''"), true);
});

test("Windows remote initialization stops after the bounded online window", () => {
  const now = Date.parse("2026-07-20T12:00:00.000Z");
  assert.equal(hasWindowsRemoteInitializationTimedOut(undefined, now), false);
  assert.equal(hasWindowsRemoteInitializationTimedOut(now - 14 * 60 * 1000, now), false);
  assert.equal(hasWindowsRemoteInitializationTimedOut(now - 15 * 60 * 1000, now), true);
});
