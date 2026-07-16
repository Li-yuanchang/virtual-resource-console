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
    throw new Error(`IP 池配置文件不存在：${file}，请先复制 config/ip-pools.example.json 为 ip-pools.json`);
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
  return dedupeIpPools(input.map(normalizeIpPool).filter((item) => item.id && item.name && item.prefix && item.gateway));
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

function dedupeIpPools(input: RuntimeIpPoolPolicy[]): RuntimeIpPoolPolicy[] {
  const result = new Map<string, RuntimeIpPoolPolicy>();
  for (const pool of input) {
    const key = pool.prefix;
    if (!result.has(key)) result.set(key, pool);
  }
  return [...result.values()];
}

function toHostOctet(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 255 ? parsed : fallback;
}
