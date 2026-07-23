import { access, stat } from "node:fs/promises";
import path from "node:path";
import { getVrcDataDir } from "./appPaths.js";

export interface DesktopUpdateStaticFile {
  filePath: string;
  contentType: string;
  cacheControl: string;
  size: number;
}

export function resolveDesktopUpdateDir(): string {
  const configured = process.env.VRC_DESKTOP_UPDATE_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(getVrcDataDir(), "desktop-updates");
}

export async function resolveDesktopUpdateFile(rawUrl: string, updateDir = resolveDesktopUpdateDir()): Promise<DesktopUpdateStaticFile | undefined> {
  const pathname = parsePathname(rawUrl);
  const encodedRelativePath = pathname.startsWith("/desktop-updates/") ? pathname.slice("/desktop-updates/".length) : "";
  if (!encodedRelativePath) return undefined;

  let relativePath: string;
  try {
    relativePath = decodeURIComponent(encodedRelativePath);
  } catch {
    return undefined;
  }
  if (!relativePath || relativePath.includes("\0")) return undefined;

  const filePath = path.resolve(updateDir, relativePath);
  if (!isPathInside(filePath, updateDir)) return undefined;
  try {
    await access(filePath);
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) return undefined;
    return {
      filePath,
      contentType: desktopUpdateContentType(filePath),
      cacheControl: isUpdateManifest(filePath) ? "no-cache, no-store, must-revalidate" : "public, max-age=31536000, immutable",
      size: fileStat.size,
    };
  } catch {
    return undefined;
  }
}

function parsePathname(rawUrl: string): string {
  try {
    return new URL(rawUrl, "http://vrc.local").pathname;
  } catch {
    return "";
  }
}

function isPathInside(filePath: string, parentDir: string): boolean {
  const relative = path.relative(parentDir, filePath);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isUpdateManifest(filePath: string): boolean {
  return /(?:^|[/\\])latest(?:-[a-z0-9_-]+)?\.ya?ml$/i.test(filePath);
}

function desktopUpdateContentType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".yml" || extension === ".yaml") return "text/yaml; charset=utf-8";
  if (extension === ".json") return "application/json; charset=utf-8";
  if (extension === ".zip") return "application/zip";
  if (extension === ".dmg") return "application/x-apple-diskimage";
  if (extension === ".exe") return "application/vnd.microsoft.portable-executable";
  return "application/octet-stream";
}
