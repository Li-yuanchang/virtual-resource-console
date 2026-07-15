import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NODE_VERSION = process.env.VRC_NODE_RUNTIME_VERSION || "22.13.1";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const runtimeRoot = path.join(repoRoot, "apps", "electron", ".runtime");
const cacheDir = path.join(runtimeRoot, "cache");

const targetSpecs = {
  "darwin-arm64": {
    archive: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
    folder: `node-v${NODE_VERSION}-darwin-arm64`,
  },
  "darwin-x64": {
    archive: `node-v${NODE_VERSION}-darwin-x64.tar.gz`,
    folder: `node-v${NODE_VERSION}-darwin-x64`,
  },
  "win-x64": {
    archive: `node-v${NODE_VERSION}-win-x64.zip`,
    folder: `node-v${NODE_VERSION}-win-x64`,
  },
};

const requestedTargets = process.argv.slice(2);
const targets = requestedTargets.length ? requestedTargets : [defaultTarget()];

mkdirSync(cacheDir, { recursive: true });

for (const target of targets) {
  const spec = targetSpecs[target];
  if (!spec) {
    throw new Error(`Unsupported Electron Node runtime target: ${target}`);
  }
  prepareRuntime(target, spec);
}
pruneUnrequestedRuntimes(targets);

function defaultTarget() {
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  }
  if (process.platform === "win32") {
    return "win-x64";
  }
  throw new Error(`No default Electron Node runtime target for ${process.platform}/${process.arch}`);
}

function prepareRuntime(target, spec) {
  const targetDir = path.join(runtimeRoot, `node-${target}`);
  const executable = target.startsWith("win-") ? path.join(targetDir, "node.exe") : path.join(targetDir, "bin", "node");
  if (existsSync(executable)) {
    console.log(`[electron-runtime] ${target} already prepared: ${executable}`);
    return;
  }

  const archivePath = path.join(cacheDir, spec.archive);
  const url = `https://nodejs.org/dist/v${NODE_VERSION}/${spec.archive}`;
  if (!existsSync(archivePath)) {
    console.log(`[electron-runtime] downloading ${url}`);
    execFileSync("curl", ["-fL", url, "-o", archivePath], { stdio: "inherit" });
  }

  const tempDir = path.join(runtimeRoot, `.extract-${target}`);
  rmSync(tempDir, { recursive: true, force: true });
  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(tempDir, { recursive: true });

  if (spec.archive.endsWith(".zip")) {
    execFileSync("unzip", ["-q", archivePath, "-d", tempDir], { stdio: "inherit" });
  } else {
    execFileSync("tar", ["-xzf", archivePath, "-C", tempDir], { stdio: "inherit" });
  }

  const extractedRoot = path.join(tempDir, spec.folder);
  const sourceRoot = existsSync(extractedRoot) ? extractedRoot : path.join(tempDir, readdirSync(tempDir)[0] ?? "");
  cpSync(sourceRoot, targetDir, { recursive: true });
  rmSync(tempDir, { recursive: true, force: true });
  console.log(`[electron-runtime] prepared ${target}: ${targetDir}`);
}

function pruneUnrequestedRuntimes(targetsToKeep) {
  const keep = new Set(targetsToKeep.map((target) => `node-${target}`));
  for (const name of readdirSync(runtimeRoot)) {
    if (!name.startsWith("node-") || keep.has(name)) continue;
    rmSync(path.join(runtimeRoot, name), { recursive: true, force: true });
    console.log(`[electron-runtime] pruned ${name}`);
  }
}
