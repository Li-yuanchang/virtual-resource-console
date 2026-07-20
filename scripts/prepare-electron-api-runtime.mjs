import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const apiPackageFile = path.join(repoRoot, "apps", "api", "package.json");
const runtimeRoot = path.join(repoRoot, "apps", "electron", ".api-runtime");
const runtimePackageFile = path.join(runtimeRoot, "package.json");
const markerFile = path.join(runtimeRoot, ".dependencies.json");
const runtimeNodeModules = path.join(runtimeRoot, "node_modules");

const apiPackage = JSON.parse(readFileSync(apiPackageFile, "utf8"));
const dependencies = apiPackage.dependencies ?? {};
const dependencyMarker = JSON.stringify({ dependencies }, null, 2);

mkdirSync(runtimeRoot, { recursive: true });

if (existsSync(runtimeNodeModules) && existsSync(markerFile) && readFileSync(markerFile, "utf8") === dependencyMarker) {
  console.log(`[electron-api-runtime] already prepared: ${runtimeNodeModules}`);
  process.exit(0);
}

rmSync(runtimeNodeModules, { recursive: true, force: true });
writeFileSync(
  runtimePackageFile,
  `${JSON.stringify(
    {
      name: "@vrc/electron-api-runtime",
      private: true,
      type: "module",
      dependencies,
    },
    null,
    2,
  )}\n`,
);

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
execFileSync(
  npmCommand,
  ["install", "--omit=dev", "--omit=optional", "--package-lock=false", "--no-audit", "--no-fund"],
  {
    cwd: runtimeRoot,
    stdio: "inherit",
  },
);
writeFileSync(markerFile, dependencyMarker);
console.log(`[electron-api-runtime] prepared: ${runtimeNodeModules}`);
