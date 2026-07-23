import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(rootDir, "apps", "electron", "dist");
const windowsOutputPattern = /^(?:win-unpacked|latest\.yml|builder-(?:debug|effective-config)\.(?:yml|yaml)|VRC(?: Setup)? .*\.exe|VRC-.*-win\.zip)$/i;

for (const entry of await readdir(outputDir).catch(() => [])) {
  if (!windowsOutputPattern.test(entry)) continue;
  await rm(path.join(outputDir, entry), { recursive: true, force: true });
  console.log(`Removed stale Windows output: ${entry}`);
}
