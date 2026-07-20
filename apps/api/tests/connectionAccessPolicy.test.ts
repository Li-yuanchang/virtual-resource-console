import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRuntimeMode, resolvePersistentConnectionPolicy } from "../src/connectionAccessPolicy.js";

test("keeps local web runtime persistent connections enabled by default", () => {
  const policy = resolvePersistentConnectionPolicy("web", {});
  assert.equal(policy.enabled, true);
  assert.equal(policy.reason, undefined);
});

test("disables persistent connections in explicit shared web mode", () => {
  const policy = resolvePersistentConnectionPolicy("web", { VRC_SHARED_WEB_MODE: "true" });
  assert.equal(policy.enabled, false);
  assert.equal(policy.reason, "shared-web");
});

test("disables persistent connections with explicit disable env", () => {
  const policy = resolvePersistentConnectionPolicy("electron", { VRC_DISABLE_PERSISTENT_CONNECTIONS: "1" });
  assert.equal(policy.enabled, false);
  assert.equal(policy.reason, "disabled-env");
});

test("normalizes unsupported runtime as web", () => {
  assert.equal(normalizeRuntimeMode("electron"), "electron");
  assert.equal(normalizeRuntimeMode("chrome-native"), "chrome-native");
  assert.equal(normalizeRuntimeMode("desktop"), "web");
  assert.equal(normalizeRuntimeMode(undefined), "web");
});
