import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionDir = path.join(rootDir, "apps/chrome-extension");
const sourceDir = path.join(extensionDir, "src");
const distDir = path.join(extensionDir, "dist");

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });
await cp(sourceDir, distDir, { recursive: true });

console.log(`Chrome extension built: ${path.relative(rootDir, distDir)}`);
