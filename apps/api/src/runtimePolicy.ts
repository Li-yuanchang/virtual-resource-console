import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderType } from "./types.js";

export interface RuntimeIpPoolPolicy {
  id: string;
  name: string;
  prefix: string;
  gateway: string;
  dns?: string[];
  startHost?: number;
  endHost?: number;
  networkName?: string;
  vlan?: string;
}

export interface RuntimePolicy {
  managedIpPattern?: string;
  ipInference: {
    enabled: boolean;
    shortIpBasePrefix?: string;
    shortIpThirdOctets: string[];
    hostOnlyPrefix?: string;
  };
  provisioning: {
    defaultDns: string[];
    rootPasswordTemplate: string;
    providerIpPools: Partial<Record<ProviderType, RuntimeIpPoolPolicy[]>>;
  };
  xenserver: {
    networkDeviceRules: Array<{
      ipPrefix: string;
      device: string;
    }>;
  };
}

type RuntimePolicyInput = Partial<{
  managedIpPattern: string;
  ipInference: Partial<RuntimePolicy["ipInference"]>;
  provisioning: Partial<{
    defaultDns: string[];
    rootPasswordTemplate: string;
    providerIpPools: Partial<Record<ProviderType, RuntimeIpPoolPolicy[]>>;
  }>;
  xenserver: Partial<RuntimePolicy["xenserver"]>;
}>;

const defaultRuntimePolicy: RuntimePolicy = {
  managedIpPattern: "",
  ipInference: {
    enabled: true,
    shortIpBasePrefix: "",
    shortIpThirdOctets: [],
    hostOnlyPrefix: "",
  },
  provisioning: {
    defaultDns: ["1.1.1.1"],
    rootPasswordTemplate: "",
    providerIpPools: {
      xenserver: [
        {
          id: "xenserver-example-a",
          name: "XenServer 示例网段 A",
          prefix: "192.0.2",
          gateway: "192.0.2.254",
        },
        {
          id: "xenserver-example-b",
          name: "XenServer 示例网段 B",
          prefix: "198.51.100",
          gateway: "198.51.100.254",
        },
      ],
      vmware: [
        {
          id: "vmware-example-a",
          name: "VMware 示例网段 A",
          prefix: "192.0.2",
          gateway: "192.0.2.254",
        },
        {
          id: "vmware-example-b",
          name: "VMware 示例网段 B",
          prefix: "198.51.100",
          gateway: "198.51.100.254",
        },
      ],
      proxmox: [
        {
          id: "proxmox-example-a",
          name: "PVE 示例网段 A",
          prefix: "192.0.2",
          gateway: "192.0.2.254",
        },
        {
          id: "proxmox-example-b",
          name: "PVE 示例网段 B",
          prefix: "198.51.100",
          gateway: "198.51.100.254",
        },
      ],
      libvirt: [
        {
          id: "libvirt-example-a",
          name: "KVM 示例网段 A",
          prefix: "192.0.2",
          gateway: "192.0.2.254",
        },
        {
          id: "libvirt-example-b",
          name: "KVM 示例网段 B",
          prefix: "198.51.100",
          gateway: "198.51.100.254",
        },
      ],
    },
  },
  xenserver: {
    networkDeviceRules: [],
  },
};

let cachedPolicy: RuntimePolicy | null = null;

export function getRuntimePolicy(): RuntimePolicy {
  if (cachedPolicy) return cachedPolicy;
  cachedPolicy = loadRuntimePolicy();
  return cachedPolicy;
}

export function getRuntimePolicyPath(): string {
  return process.env.VRC_RUNTIME_POLICY_FILE?.trim() || join(homedir(), ".virtual-resource-console", "runtime-policy.json");
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

  const thirdOctets = policy.ipInference.shortIpThirdOctets.filter(Boolean).join("|");
  const basePrefix = policy.ipInference.shortIpBasePrefix?.trim();
  if (thirdOctets && basePrefix) {
    const shortIp = name.match(new RegExp(`(?:^|[^0-9])((?:${thirdOctets})\\.(\\d{1,3}))(?:[^0-9]|$)`));
    if (shortIp?.[1] && isValidHostOctet(shortIp[2])) {
      const ip = `${basePrefix}.${shortIp[1]}`;
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
    VRC_HOST_ONLY_PREFIX: policy.ipInference.hostOnlyPrefix ?? "",
    VRC_XENSERVER_NETWORK_RULES: policy.xenserver.networkDeviceRules.map((item) => `${item.ipPrefix}|${item.device}`).join("\n"),
  };
}

function loadRuntimePolicy(): RuntimePolicy {
  const file = getRuntimePolicyPath();
  if (!existsSync(file)) return defaultRuntimePolicy;
  try {
    const input = JSON.parse(readFileSync(file, "utf8")) as RuntimePolicyInput;
    return normalizeRuntimePolicy(input);
  } catch {
    return defaultRuntimePolicy;
  }
}

function normalizeRuntimePolicy(input: RuntimePolicyInput): RuntimePolicy {
  return {
    managedIpPattern: typeof input.managedIpPattern === "string" ? input.managedIpPattern.trim() : defaultRuntimePolicy.managedIpPattern,
    ipInference: {
      enabled: input.ipInference?.enabled ?? defaultRuntimePolicy.ipInference.enabled,
      shortIpBasePrefix: input.ipInference?.shortIpBasePrefix?.trim() ?? defaultRuntimePolicy.ipInference.shortIpBasePrefix,
      shortIpThirdOctets: Array.isArray(input.ipInference?.shortIpThirdOctets)
        ? input.ipInference.shortIpThirdOctets.map(String).map((item) => item.trim()).filter(Boolean)
        : defaultRuntimePolicy.ipInference.shortIpThirdOctets,
      hostOnlyPrefix: input.ipInference?.hostOnlyPrefix?.trim() ?? defaultRuntimePolicy.ipInference.hostOnlyPrefix,
    },
    provisioning: {
      defaultDns: input.provisioning?.defaultDns?.length
        ? input.provisioning.defaultDns.map(String).map((item) => item.trim()).filter(Boolean)
        : defaultRuntimePolicy.provisioning.defaultDns,
      rootPasswordTemplate:
        typeof input.provisioning?.rootPasswordTemplate === "string"
          ? input.provisioning.rootPasswordTemplate
          : defaultRuntimePolicy.provisioning.rootPasswordTemplate,
      providerIpPools: {
        ...defaultRuntimePolicy.provisioning.providerIpPools,
        ...normalizeProviderIpPools(input.provisioning?.providerIpPools),
      },
    },
    xenserver: {
      networkDeviceRules: Array.isArray(input.xenserver?.networkDeviceRules)
        ? input.xenserver.networkDeviceRules
            .map((item) => ({
              ipPrefix: String(item.ipPrefix ?? "").trim(),
              device: String(item.device ?? "").trim(),
            }))
            .filter((item) => item.ipPrefix && item.device)
        : defaultRuntimePolicy.xenserver.networkDeviceRules,
    },
  };
}

function normalizeProviderIpPools(input: Partial<Record<ProviderType, RuntimeIpPoolPolicy[]>> | undefined) {
  if (!input || typeof input !== "object") return {};
  const result: Partial<Record<ProviderType, RuntimeIpPoolPolicy[]>> = {};
  for (const providerType of ["xenserver", "vmware", "proxmox", "libvirt"] as const) {
    const pools = input[providerType];
    if (!Array.isArray(pools)) continue;
    result[providerType] = pools
      .map((item) => ({
        id: String(item.id ?? "").trim(),
        name: String(item.name ?? "").trim(),
        prefix: String(item.prefix ?? "").trim(),
        gateway: String(item.gateway ?? "").trim(),
        dns: Array.isArray(item.dns) ? item.dns.map(String).map((dns) => dns.trim()).filter(Boolean) : undefined,
        startHost: toHostOctet(item.startHost, 20),
        endHost: toHostOctet(item.endHost, 250),
        networkName: item.networkName?.trim(),
        vlan: item.vlan?.trim(),
      }))
      .filter((item) => item.id && item.name && item.prefix && item.gateway);
  }
  return result;
}

function toHostOctet(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 255 ? parsed : fallback;
}

function isIpv4(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

function isValidHostOctet(value: string | undefined): boolean {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 255;
}
