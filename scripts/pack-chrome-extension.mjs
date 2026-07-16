import { mkdir, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(rootDir, "apps/chrome-extension/dist");
const releaseDir = path.join(rootDir, "release");
const packageJsonPath = path.join(rootDir, "apps/chrome-extension/package.json");
const zipPath = path.join(releaseDir, "virtual-resource-console-extension.zip");
const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
const versionedZipPath = path.join(releaseDir, `virtual-resource-console-extension-${packageJson.version}.zip`);

await mkdir(releaseDir, { recursive: true });
await rm(zipPath, { force: true });
await rm(versionedZipPath, { force: true });

for (const targetPath of [zipPath, versionedZipPath]) {
  const result = spawnSync("zip", ["-qr", targetPath, "."], {
    cwd: distDir,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  console.log(`Chrome extension package: ${path.relative(rootDir, targetPath)}`);
}
