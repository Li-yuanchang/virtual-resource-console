import { getIpPoolPolicy } from "./ipPoolPolicy.js";
import type { IpPoolPolicy, RuntimeIpPoolPolicy } from "./ipPoolPolicy.js";

export interface RuntimePolicy {
  managedIpPattern?: string;
  ipInference: {
    enabled: boolean;
    shortIpBasePrefix?: string;
    shortIpThirdOctets: string[];
    shortIpPrefixes: string[];
    hostOnlyPrefix?: string;
  };
  provisioning: {
    rootPasswordTemplate: string;
    /** 新建 VM 默认是否绑定堡垒机访问限制（可在创建弹框中单次取消）。 */
    bastionAccessEnabled: boolean;
    /** 允许 SSH 登录 VM 的来源地址，用于生成 sshd 的 AllowUsers 白名单。 */
    bastionAllowFrom: string[];
  };
  xenserver: {
    networkDeviceRules: Array<{
      ipPrefix: string;
      device: string;
    }>;
  };
}

const defaultRootPasswordTemplate = "root@{third}.{fourth}";

// 堡垒机地址与 VRC 本机地址：绑定后 sshd 只放行这些来源，
// 必须包含 VRC 自身的访问来源，否则安装收尾的 SSH 验证会被自己拦掉。
const defaultBastionAllowFrom = ["192.168.130.3", "192.168.19.14"];

/**
 * Returns the runtime policy derived from the current IP pool configuration.
 * The policy is rebuilt on every call so IP pool edits take effect without restarting the API.
 *
 * @returns runtime policy used by VM IP inference and XenServer scripts
 */
export function getRuntimePolicy(): RuntimePolicy {
  try {
    return createRuntimePolicy(getIpPoolPolicy());
  } catch {
    return createRuntimePolicy();
  }
}

/**
 * Builds a runtime policy from the authoritative IP pool configuration.
 *
 * @param ipPoolPolicy normalized IP pool configuration; omitted when the IP pool file is unavailable
 * @returns runtime policy with managed ranges and short-name inference rules derived from IP pool prefixes
 */
export function createRuntimePolicy(ipPoolPolicy?: IpPoolPolicy): RuntimePolicy {
  const ipPools = ipPoolPolicy?.ipPools ?? [];
  const shortIpPrefixes = Array.from(new Set(ipPools.map((item) => item.prefix).filter(isIpv4Prefix))).sort(compareIpv4Prefixes);
  const shortIpBasePrefix = commonBasePrefix(shortIpPrefixes);
  const shortIpThirdOctets = shortIpBasePrefix
    ? shortIpPrefixes
        .filter((prefix) => prefix.startsWith(`${shortIpBasePrefix}.`))
        .map((prefix) => prefix.split(".")[2])
    : [];
  return {
    managedIpPattern: buildManagedIpPattern(shortIpPrefixes),
    ipInference: {
      enabled: shortIpPrefixes.length > 0,
      shortIpBasePrefix,
      shortIpThirdOctets,
      shortIpPrefixes,
      hostOnlyPrefix: selectHostOnlyPrefix(ipPools),
    },
    provisioning: {
      rootPasswordTemplate: defaultRootPasswordTemplate,
      // 优先用 IP 池配置（设置页可改）；旧配置文件缺字段时回落到默认值。
      bastionAccessEnabled: ipPoolPolicy?.bastionAccessEnabled ?? true,
      bastionAllowFrom: ipPoolPolicy?.bastionAllowFrom?.length
        ? [...ipPoolPolicy.bastionAllowFrom]
        : [...defaultBastionAllowFrom],
    },
    xenserver: {
      networkDeviceRules: [],
    },
  };
}

export function isManagedIpv4(ip: string, policy = getRuntimePolicy()): boolean {
  if (!isIpv4(ip)) return false;
  if (!policy.managedIpPattern) return true;
  try {
    return new RegExp(policy.managedIpPattern).test(ip);
  } catch {
    return true;
  }
}

export function inferIpv4FromName(name: string, policy = getRuntimePolicy()): string {
  const fullIp = name.match(/(?:^|[^0-9])((?:[0-9]{1,3}\.){3}[0-9]{1,3})(?:[^0-9]|$)/);
  if (fullIp?.[1] && isManagedIpv4(fullIp[1], policy)) return fullIp[1];
  if (!policy.ipInference.enabled) return "";

  const shortIp = name.match(/(?:^|[^0-9])(\d{1,3})[.-](\d{1,3})(?:[^0-9]|$)/);
  if (shortIp?.[1] && isValidHostOctet(shortIp[2])) {
    const matchingPrefix = policy.ipInference.shortIpPrefixes.find((prefix) => prefix.split(".")[2] === shortIp[1]);
    if (matchingPrefix) {
      const ip = `${matchingPrefix}.${shortIp[2]}`;
      if (isManagedIpv4(ip, policy)) return ip;
    }

    const basePrefix = policy.ipInference.shortIpBasePrefix?.trim();
    if (basePrefix && policy.ipInference.shortIpThirdOctets.includes(shortIp[1])) {
      const ip = `${basePrefix}.${shortIp[1]}.${shortIp[2]}`;
      if (isManagedIpv4(ip, policy)) return ip;
    }
  }

  const hostOnlyPrefix = policy.ipInference.hostOnlyPrefix?.trim();
  const hostOnly = name.match(/^(\d{1,3})(?:[^0-9.]|$)/);
  if (hostOnlyPrefix && hostOnly?.[1] && isValidHostOctet(hostOnly[1])) {
    const ip = `${hostOnlyPrefix}.${hostOnly[1]}`;
    if (isManagedIpv4(ip, policy)) return ip;
  }
  return "";
}

export function buildXenServerPolicyEnv(policy = getRuntimePolicy()): Record<string, string> {
  return {
    VRC_MANAGED_IP_PATTERN: policy.managedIpPattern ?? "",
    VRC_SHORT_IP_BASE_PREFIX: policy.ipInference.shortIpBasePrefix ?? "",
    VRC_SHORT_IP_THIRD_OCTETS: policy.ipInference.shortIpThirdOctets.join(" "),
    VRC_SHORT_IP_PREFIXES: policy.ipInference.shortIpPrefixes.join(" "),
    VRC_HOST_ONLY_PREFIX: policy.ipInference.hostOnlyPrefix ?? "",
    VRC_XENSERVER_NETWORK_RULES: "",
  };
}

function buildManagedIpPattern(prefixes: string[]): string {
  if (!prefixes.length) return "";
  const alternatives = prefixes.map((prefix) => prefix.replaceAll(".", "\\."));
  // XenServer 6.5 uses grep -E, which supports ordinary groups but not PCRE non-capturing groups.
  return `^(${alternatives.join("|")})\\.[0-9]{1,3}$`;
}

function commonBasePrefix(prefixes: string[]): string {
  if (!prefixes.length) return "";
  const bases = prefixes.map((prefix) => prefix.split(".").slice(0, 2).join("."));
  return bases.every((base) => base === bases[0]) ? bases[0] : "";
}

function selectHostOnlyPrefix(ipPools: RuntimeIpPoolPolicy[]): string {
  const genericPool =
    ipPools.find((item) => !item.hostPrefixes?.length && !item.networkName?.trim()) ??
    ipPools.find((item) => !item.hostPrefixes?.length) ??
    ipPools[0];
  return genericPool?.prefix ?? "";
}

function compareIpv4Prefixes(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index] - rightParts[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

function isIpv4Prefix(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 3 && parts.every(isIpv4Octet);
}

function isIpv4(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every(isIpv4Octet);
}

function isIpv4Octet(value: string): boolean {
  return /^\d{1,3}$/.test(value) && Number(value) >= 0 && Number(value) <= 255;
}

function isValidHostOctet(value: string | undefined): boolean {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 255;
}
