import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getVrcDataFile } from "./appPaths.js";

export interface RuntimeIpPoolPolicy {
  id: string;
  name: string;
  prefix: string;
  gateway: string;
  dns?: string[];
  startHost?: number;
  endHost?: number;
  hostPrefixes?: string[];
  networkName?: string;
  vlan?: string;
}

export interface IpPoolPolicy {
  defaultDns: string[];
  ipPools: RuntimeIpPoolPolicy[];
}

type IpPoolPolicyInput = Partial<{
  defaultDns: string[];
  ipPools: RuntimeIpPoolPolicy[];
}>;

export function getIpPoolPolicy(): IpPoolPolicy {
  return loadIpPoolPolicy();
}

export function saveIpPoolPolicy(input: IpPoolPolicyInput): IpPoolPolicy {
  const policy = normalizeIpPoolPolicy(input);
  const file = getIpPoolPolicyPath();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(policy, null, 2)}\n`, { mode: 0o600 });
  return policy;
}

export function getIpPoolPolicyPath(): string {
  return process.env.VRC_IP_POOLS_FILE?.trim() || getVrcDataFile("ip-pools.json");
}

function loadIpPoolPolicy(): IpPoolPolicy {
  const file = getIpPoolPolicyPath();
  if (!existsSync(file)) {
    throw new Error(`IP 池配置文件不存在：${file}，请在设置页新增或导入 IP 池后保存`);
  }
  try {
    const input = JSON.parse(readFileSync(file, "utf8")) as IpPoolPolicyInput;
    return normalizeIpPoolPolicy(input);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("IP 池配置文件")) throw error;
    const detail = error instanceof Error ? error.message : "未知错误";
    throw new Error(`IP 池配置文件格式不正确：${file}，${detail}`);
  }
}

function normalizeIpPoolPolicy(input: IpPoolPolicyInput): IpPoolPolicy {
  const defaultDns = Array.isArray(input.defaultDns) ? input.defaultDns.map(String).map((item) => item.trim()).filter(Boolean) : [];
  if (!defaultDns.length) {
    throw new Error("IP 池配置缺少 defaultDns");
  }
  const invalidDns = defaultDns.filter((item) => !isIpv4(item));
  if (invalidDns.length) {
    throw new Error(`默认 DNS 格式不正确：${invalidDns.join("、")}`);
  }
  const ipPools = normalizeIpPools(input.ipPools);
  if (!ipPools.length) {
    throw new Error("IP 池配置缺少 ipPools");
  }
  return {
    defaultDns,
    ipPools,
  };
}

function normalizeIpPools(input: RuntimeIpPoolPolicy[] | undefined): RuntimeIpPoolPolicy[] {
  if (!Array.isArray(input)) return [];
  const ipPools = input.map(normalizeIpPool);
  validateIpPools(ipPools);
  return ipPools;
}

function normalizeIpPool(item: RuntimeIpPoolPolicy): RuntimeIpPoolPolicy {
  return {
    id: String(item.id ?? "").trim(),
    name: String(item.name ?? "").trim(),
    prefix: String(item.prefix ?? "").trim(),
    gateway: String(item.gateway ?? "").trim(),
    dns: Array.isArray(item.dns) ? item.dns.map(String).map((dns) => dns.trim()).filter(Boolean) : undefined,
    startHost: toHostOctet(item.startHost, 20),
    endHost: toHostOctet(item.endHost, 250),
    hostPrefixes: Array.isArray(item.hostPrefixes) ? item.hostPrefixes.map(String).map((value) => value.trim()).filter(Boolean) : undefined,
    networkName: item.networkName?.trim(),
    vlan: item.vlan?.trim(),
  };
}

function validateIpPools(ipPools: RuntimeIpPoolPolicy[]): void {
  const ids = new Set<string>();
  const prefixes = new Set<string>();
  for (const pool of ipPools) {
    if (!pool.id) throw new Error("IP 池 ID 不能为空");
    if (ids.has(pool.id)) throw new Error(`IP 池 ID 重复：${pool.id}`);
    ids.add(pool.id);
    if (!pool.name) throw new Error(`IP 池名称不能为空：${pool.id}`);
    if (!isIpv4Prefix(pool.prefix)) throw new Error(`IP 池网段格式不正确：${pool.name}`);
    if (prefixes.has(pool.prefix)) throw new Error(`IP 池网段重复：${pool.prefix}`);
    prefixes.add(pool.prefix);
    if (!isIpv4(pool.gateway)) throw new Error(`IP 池网关格式不正确：${pool.name}`);
    if (!pool.gateway.startsWith(`${pool.prefix}.`)) {
      throw new Error(`IP 池网关必须属于本网段：${pool.name}，网段 ${pool.prefix}，网关 ${pool.gateway}`);
    }
    if ((pool.startHost ?? 20) > (pool.endHost ?? 250)) {
      throw new Error(`IP 池起始尾号不能大于结束尾号：${pool.name}`);
    }
    const invalidDns = (pool.dns ?? []).filter((item) => !isIpv4(item));
    if (invalidDns.length) throw new Error(`IP 池 DNS 格式不正确：${pool.name}，${invalidDns.join("、")}`);
    const invalidHostPrefixes = (pool.hostPrefixes ?? []).filter((item) => !isIpv4Prefix(item));
    if (invalidHostPrefixes.length) {
      throw new Error(`适用物理机网段格式不正确：${pool.name}，${invalidHostPrefixes.join("、")}`);
    }
  }
}

function toHostOctet(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 255 ? parsed : fallback;
}

function isIpv4Prefix(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 3 && parts.every((part) => isIpv4Octet(part));
}

function isIpv4(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => isIpv4Octet(part));
}

function isIpv4Octet(value: string): boolean {
  return /^\d{1,3}$/.test(value) && Number(value) >= 0 && Number(value) <= 255;
}
