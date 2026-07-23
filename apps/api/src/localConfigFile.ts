import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getVrcDataFile } from "./appPaths.js";

interface ReadLocalJsonConfigOptions<T> {
  filePath: string;
  label: string;
  normalize: (input: unknown) => T;
  onMissing?: () => T;
  onInvalid?: (error: unknown) => T;
}

export function resolveVrcConfigPath(filename: string, overrideEnvironmentVariable?: string): string {
  const configured = overrideEnvironmentVariable ? process.env[overrideEnvironmentVariable]?.trim() : "";
  return configured ? resolve(configured) : getVrcDataFile(filename);
}

export function readLocalJsonConfig<T>(options: ReadLocalJsonConfigOptions<T>): T {
  if (!existsSync(options.filePath)) {
    if (options.onMissing) return options.onMissing();
    throw new Error(`${options.label}文件不存在：${options.filePath}`);
  }
  try {
    return options.normalize(JSON.parse(readFileSync(options.filePath, "utf8")) as unknown);
  } catch (error) {
    if (options.onInvalid) return options.onInvalid(error);
    const detail = error instanceof Error ? error.message : "未知错误";
    throw new Error(`${options.label}文件格式不正确：${options.filePath}，${detail}`);
  }
}

export function writeLocalJsonConfig(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporaryFile, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  replaceFile(temporaryFile, filePath);
}

function replaceFile(temporaryFile: string, targetFile: string): void {
  try {
    renameSync(temporaryFile, targetFile);
    return;
  } catch (initialError) {
    if (!existsSync(targetFile)) {
      rmSync(temporaryFile, { force: true });
      throw initialError;
    }
  }

  const backupFile = `${targetFile}.bak`;
  rmSync(backupFile, { force: true });
  renameSync(targetFile, backupFile);
  try {
    renameSync(temporaryFile, targetFile);
    rmSync(backupFile, { force: true });
  } catch (error) {
    if (!existsSync(targetFile) && existsSync(backupFile)) renameSync(backupFile, targetFile);
    rmSync(temporaryFile, { force: true });
    throw error;
  }
}
