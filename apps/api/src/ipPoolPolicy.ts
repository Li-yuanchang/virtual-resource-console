import { readLocalJsonConfig, resolveVrcConfigPath, writeLocalJsonConfig } from "./localConfigFile.js";

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
  /**
   * 新建 VM 默认是否绑定堡垒机访问（创建弹框默认勾选，可单次取消）。
   * 缺省为 true：旧配置文件不含该字段时仍按默认开启处理。
   */
  bastionAccessEnabled: boolean;
  /**
   * 允许 SSH 登录 VM 的来源白名单，用于生成 sshd 的 AllowUsers。
   * 必须包含 VRC 自身的访问来源，否则安装收尾的 SSH 验证会被自己拦下。
   */
  bastionAllowFrom: string[];
  ipPools: RuntimeIpPoolPolicy[];
}

type IpPoolPolicyInput = Partial<{
  defaultDns: string[];
  bastionAccessEnabled: boolean;
  bastionAllowFrom: string[];
  ipPools: RuntimeIpPoolPolicy[];
}>;

export function getIpPoolPolicy(): IpPoolPolicy {
  return loadIpPoolPolicy();
}

export function saveIpPoolPolicy(input: IpPoolPolicyInput): IpPoolPolicy {
  const policy = normalizeIpPoolPolicy(input);
  writeLocalJsonConfig(getIpPoolPolicyPath(), policy);
  return policy;
}

export function getIpPoolPolicyPath(): string {
  return resolveVrcConfigPath("ip-pools.json", "VRC_IP_POOLS_FILE");
}

function loadIpPoolPolicy(): IpPoolPolicy {
  const file = getIpPoolPolicyPath();
  return readLocalJsonConfig({
    filePath: file,
    label: "IP 池配置",
    normalize: (input) => normalizeIpPoolPolicy(input as IpPoolPolicyInput),
    onMissing: () => {
      throw new Error(`IP 池配置文件不存在：${file}，请在设置页新增或导入 IP 池后保存`);
    },
  });
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
  // 堡垒机白名单：非法项直接报错，避免写进 sshd 后把自己锁在外面。
  const bastionAllowFrom = Array.isArray(input.bastionAllowFrom)
    ? Array.from(new Set(input.bastionAllowFrom.map(String).map((item) => item.trim()).filter(Boolean)))
    : [];
  const invalidAllowFrom = bastionAllowFrom.filter((item) => !isIpv4(item));
  if (invalidAllowFrom.length) {
    throw new Error(`堡垒机白名单格式不正确：${invalidAllowFrom.join("、")}`);
  }
  return {
    defaultDns,
    bastionAccessEnabled: input.bastionAccessEnabled !== false,
    bastionAllowFrom,
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
