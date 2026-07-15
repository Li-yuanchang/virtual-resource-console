import { mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(rootDir, "apps/chrome-extension/dist");
const releaseDir = path.join(rootDir, "release");
const zipPath = path.join(releaseDir, "virtual-resource-console-extension.zip");

await mkdir(releaseDir, { recursive: true });
await rm(zipPath, { force: true });

const result = spawnSync("zip", ["-qr", zipPath, "."], {
  cwd: distDir,
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log(`Chrome extension package: ${path.relative(rootDir, zipPath)}`);
