import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionDir = path.join(rootDir, "apps/chrome-extension");
const sourceDir = path.join(extensionDir, "src");
const distDir = path.join(extensionDir, "dist");
const packageJsonPath = path.join(extensionDir, "package.json");
const manifestPath = path.join(distDir, "manifest.json");

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });
await cp(sourceDir, distDir, { recursive: true });

const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
manifest.version = packageJson.version;
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Chrome extension built: ${path.relative(rootDir, distDir)}`);
