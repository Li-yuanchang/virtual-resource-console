import { createHash } from "node:crypto";
import { extractFile } from "@electron/asar";
import { createReadStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { copyFile, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const electronDir = path.join(rootDir, "apps", "electron");
const electronPackage = JSON.parse(await readFile(path.join(electronDir, "package.json"), "utf8"));
const apiPackage = JSON.parse(await readFile(path.join(rootDir, "apps", "api", "package.json"), "utf8"));
const version = electronPackage.version;
const outputDir = path.join(rootDir, "release", `online-update-${version}`);
const updateDir = path.join(outputDir, "desktop-updates");
const appArchive = path.join(outputDir, `vrc-server-app-${version}.tar.gz`);
const apiRuntimeDir = path.join(electronDir, ".api-runtime");
const apiRuntimeNodeModules = path.join(apiRuntimeDir, "node_modules");
const windowsAsarPath = path.join(electronDir, "dist", "win-unpacked", "resources", "app.asar");

const updateArtifacts = [
  "latest-mac.yml",
  `VRC-${version}-arm64-mac.zip`,
  `VRC-${version}-arm64-mac.zip.blockmap`,
  `VRC-${version}-arm64.dmg`,
  `VRC-${version}-arm64.dmg.blockmap`,
  "latest.yml",
  `VRC Setup ${version}.exe`,
  `VRC ${version}.exe`,
  `VRC-${version}-win.zip`,
];

for (const relativePath of ["apps/api/dist/index.js", "apps/web/dist/index.html", ...updateArtifacts.map((name) => `apps/electron/dist/${name}`)]) {
  if (!existsSync(path.join(rootDir, relativePath))) throw new Error(`发布文件不存在，请先完成构建：${relativePath}`);
}

assertWindowsEmbeddedVersion();

const runtimeResult = spawnSync(process.execPath, [path.join(rootDir, "scripts", "prepare-electron-api-runtime.mjs")], {
  cwd: rootDir,
  stdio: "inherit",
});
if (runtimeResult.status !== 0) throw new Error("API 生产依赖准备失败");
for (const dependency of Object.keys(apiPackage.dependencies ?? {})) {
  const packageFile = path.join(apiRuntimeNodeModules, ...dependency.split("/"), "package.json");
  if (!existsSync(packageFile)) throw new Error(`API 生产依赖未进入发布包：${dependency}`);
}

mkdirSync(updateDir, { recursive: true });
for (const artifact of updateArtifacts) {
  await copyFile(path.join(electronDir, "dist", artifact), path.join(updateDir, artifact));
}

const tarResult = spawnSync("tar", ["-czf", appArchive, "apps/api/dist", "apps/web/dist", "-C", path.relative(rootDir, apiRuntimeDir), "node_modules"], {
  cwd: rootDir,
  stdio: "inherit",
});
if (tarResult.status !== 0) throw new Error("服务器应用增量包生成失败");

const checksumLines = [];
for (const artifact of updateArtifacts) {
  const filePath = path.join(updateDir, artifact);
  checksumLines.push(`${await sha256(filePath)}  desktop-updates/${artifact}`);
}
checksumLines.push(`${await sha256(appArchive)}  ${path.basename(appArchive)}`);
writeFileSync(path.join(outputDir, "SHA256SUMS"), `${checksumLines.join("\n")}\n`);

const totalBytes = (await Promise.all(updateArtifacts.map((artifact) => stat(path.join(updateDir, artifact))))).reduce((sum, item) => sum + item.size, 0);
console.log(`Server app archive: ${path.relative(rootDir, appArchive)}`);
console.log(`Desktop update directory: ${path.relative(rootDir, updateDir)}`);
console.log(`Desktop update size: ${(totalBytes / 1024 / 1024).toFixed(1)} MiB`);

function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(filePath)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")));
  });
}

function assertWindowsEmbeddedVersion() {
  if (!existsSync(windowsAsarPath)) {
    throw new Error("Windows 打包目录缺少 resources/app.asar，请先重新执行 dist:win");
  }
  let embeddedPackage;
  try {
    embeddedPackage = JSON.parse(extractFile(windowsAsarPath, "package.json").toString("utf8"));
  } catch (error) {
    throw new Error(`无法读取 Windows app.asar 内的 package.json：${error instanceof Error ? error.message : String(error)}`);
  }
  if (embeddedPackage.version !== version) {
    throw new Error(`Windows 打包版本不一致：package.json=${version}，app.asar=${embeddedPackage.version || "缺失"}；请清理后重新执行 dist:win`);
  }
}
