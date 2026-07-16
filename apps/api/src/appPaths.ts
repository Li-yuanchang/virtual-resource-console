import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function getVrcDataDir(): string {
  const configured = process.env.VRC_DATA_DIR?.trim();
  return configured ? resolve(configured) : join(homedir(), ".virtual-resource-console");
}

export function getVrcDataFile(filename: string): string {
  return join(getVrcDataDir(), filename);
}
