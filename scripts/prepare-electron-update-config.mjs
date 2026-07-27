import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const outputDir = path.join(repoRoot, "apps", "electron", ".update-config");
const outputFile = path.join(outputDir, "update-config.json");

const updateUrl = readUpdateUrl();

mkdirSync(outputDir, { recursive: true });
writeFileSync(outputFile, `${JSON.stringify({ url: updateUrl }, null, 2)}\n`);
console.log(updateUrl ? "[electron-update-config] local update URL configured" : "[electron-update-config] no local update URL configured");

function readUpdateUrl() {
  const envUrl = process.env.VRC_UPDATE_URL?.trim();
  if (envUrl) return envUrl;

  const localJsonUrl = readJsonUrl(path.join(repoRoot, "apps", "electron", "update-config.local.json"));
  if (localJsonUrl) return localJsonUrl;

  const envFileUrl = readEnvFileUrl(path.join(repoRoot, ".env.local"));
  if (envFileUrl) return envFileUrl;

  return "";
}

function readJsonUrl(file) {
  try {
    if (!existsSync(file)) return "";
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const url = typeof parsed === "string" ? parsed : parsed?.url ?? parsed?.updateUrl;
    return typeof url === "string" ? url.trim() : "";
  } catch {
    return "";
  }
}

function readEnvFileUrl(file) {
  try {
    if (!existsSync(file)) return "";
    const line = readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((item) => item.trim())
      .find((item) => item && !item.startsWith("#") && item.startsWith("VRC_UPDATE_URL="));
    if (!line) return "";
    return line.slice("VRC_UPDATE_URL=".length).trim().replace(/^['"]|['"]$/g, "");
  } catch {
    return "";
  }
}
