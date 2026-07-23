import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveDesktopUpdateDir, resolveDesktopUpdateFile } from "../src/desktopUpdateStatic.js";

test("resolves update manifests without cache and versioned packages with immutable cache", async () => {
  const updateDir = await mkdtemp(path.join(tmpdir(), "vrc-updates-"));
  try {
    await writeFile(path.join(updateDir, "latest-mac.yml"), "version: 0.1.38\n");
    await writeFile(path.join(updateDir, "VRC-0.1.38-arm64-mac.zip"), "zip");

    const manifest = await resolveDesktopUpdateFile("/desktop-updates/latest-mac.yml", updateDir);
    assert.equal(manifest?.contentType, "text/yaml; charset=utf-8");
    assert.equal(manifest?.cacheControl, "no-cache, no-store, must-revalidate");

    const archive = await resolveDesktopUpdateFile("/desktop-updates/VRC-0.1.38-arm64-mac.zip", updateDir);
    assert.equal(archive?.contentType, "application/zip");
    assert.equal(archive?.cacheControl, "public, max-age=31536000, immutable");
  } finally {
    await rm(updateDir, { recursive: true, force: true });
  }
});

test("rejects missing files and paths outside the update directory", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "vrc-updates-root-"));
  const updateDir = path.join(rootDir, "desktop-updates");
  try {
    await mkdir(updateDir);
    await writeFile(path.join(rootDir, "secret.txt"), "secret");
    assert.equal(await resolveDesktopUpdateFile("/desktop-updates/missing.yml", updateDir), undefined);
    assert.equal(await resolveDesktopUpdateFile("/desktop-updates/%2e%2e/secret.txt", updateDir), undefined);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("uses the configured update directory when provided", () => {
  const previous = process.env.VRC_DESKTOP_UPDATE_DIR;
  try {
    process.env.VRC_DESKTOP_UPDATE_DIR = "runtime/releases";
    assert.equal(resolveDesktopUpdateDir(), path.resolve("runtime/releases"));
  } finally {
    if (previous === undefined) delete process.env.VRC_DESKTOP_UPDATE_DIR;
    else process.env.VRC_DESKTOP_UPDATE_DIR = previous;
  }
});
