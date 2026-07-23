import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { getVrcDataDir } from "./appPaths.js";

const storeDir = getVrcDataDir();
const storeFile = join(storeDir, "ip-leases.json");

export type IpLeaseStatus = "reserved" | "released";

export interface IpLease {
  id: string;
  ip: string;
  poolId: string;
  poolName: string;
  scopeKey: string;
  vmName: string;
  loginUsername?: string;
  rootPassword?: string;
  status: IpLeaseStatus;
  createdAt: string;
  updatedAt: string;
}

interface IpLeaseStoreFile {
  version: 1;
  leases: IpLease[];
}

export interface ReserveIpLeaseInput {
  ip: string;
  poolId: string;
  poolName: string;
  scopeKey: string;
  vmName: string;
  loginUsername?: string;
  rootPassword?: string;
}

export function listIpLeases(): IpLease[] {
  return readStore().leases.filter((item) => item.status !== "released").map(stripSensitiveLeaseFields);
}

export function reserveIpLeases(input: ReserveIpLeaseInput[]): IpLease[] {
  const store = readStore();
  const now = new Date().toISOString();
  const leaseByIp = new Map(store.leases.map((lease) => [lease.ip, lease]));
  const reserved = input.map((item) => {
    const current = leaseByIp.get(item.ip);
    const lease: IpLease = {
      id: current?.id ?? randomUUID(),
      ip: item.ip.trim(),
      poolId: item.poolId.trim(),
      poolName: item.poolName.trim(),
      scopeKey: item.scopeKey.trim(),
      vmName: item.vmName.trim(),
      loginUsername: item.loginUsername?.trim() || undefined,
      status: "reserved",
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    leaseByIp.set(lease.ip, lease);
    return lease;
  });
  writeStore({ version: 1, leases: Array.from(leaseByIp.values()).map(normalizeIpLease) });
  return reserved;
}

export function releaseIpLeases(input: { ips?: string[]; vmNames?: string[]; scopeKey?: string }): IpLease[] {
  const store = readStore();
  const now = new Date().toISOString();
  const ips = new Set((input.ips ?? []).map((item) => item.trim()).filter(Boolean));
  const vmNames = new Set((input.vmNames ?? []).map((item) => item.trim()).filter(Boolean));
  const released: IpLease[] = [];
  const leases = store.leases.map((lease) => {
    const scopeMatches = !input.scopeKey || lease.scopeKey === input.scopeKey;
    const matches = scopeMatches && ((ips.size > 0 && ips.has(lease.ip)) || (vmNames.size > 0 && vmNames.has(lease.vmName)));
    if (!matches || lease.status === "released") return lease;
    const updated = normalizeIpLease({
      ...lease,
      status: "released",
      rootPassword: undefined,
      updatedAt: now,
    });
    released.push(stripSensitiveLeaseFields(updated));
    return updated;
  });
  writeStore({ version: 1, leases });
  return released;
}

function normalizeIpLease(item: IpLease): IpLease {
  return {
    id: item.id || randomUUID(),
    ip: item.ip?.trim() || "",
    poolId: item.poolId?.trim() || "",
    poolName: item.poolName?.trim() || "",
    scopeKey: item.scopeKey?.trim() || "",
    vmName: item.vmName?.trim() || "",
    loginUsername: item.loginUsername?.trim() || undefined,
    rootPassword: item.status === "released" ? undefined : item.rootPassword?.trim() || undefined,
    status: item.status === "released" ? "released" : "reserved",
    createdAt: item.createdAt || new Date().toISOString(),
    updatedAt: item.updatedAt || item.createdAt || new Date().toISOString(),
  };
}

function stripSensitiveLeaseFields(item: IpLease): IpLease {
  const { rootPassword: _rootPassword, ...lease } = item;
  return lease;
}

function readStore(): IpLeaseStoreFile {
  ensureStoreDir();
  if (!existsSync(storeFile)) {
    return { version: 1, leases: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(storeFile, "utf8")) as IpLeaseStoreFile;
    return {
      version: 1,
      leases: Array.isArray(parsed.leases) ? parsed.leases.map(normalizeIpLease).filter((item) => item.ip) : [],
    };
  } catch {
    return { version: 1, leases: [] };
  }
}

function writeStore(store: IpLeaseStoreFile): void {
  ensureStoreDir();
  writeFileSync(storeFile, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

function ensureStoreDir(): void {
  mkdirSync(dirname(storeFile), { recursive: true, mode: 0o700 });
}
