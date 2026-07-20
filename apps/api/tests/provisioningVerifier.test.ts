import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import { buildXenGuestMetricsProbeScript, canReadWinRmHttpResponse, isWinRmHttpResponse } from "../src/provisioningVerifier.js";

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
