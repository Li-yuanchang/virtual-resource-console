import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface RuntimePolicy {
  managedIpPattern?: string;
  ipInference: {
    enabled: boolean;
    shortIpBasePrefix?: string;
    shortIpThirdOctets: string[];
    hostOnlyPrefix?: string;
  };
  provisioning: {
    rootPasswordTemplate: string;
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
    rootPasswordTemplate: string;
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
    rootPasswordTemplate: "",
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
      rootPasswordTemplate:
        typeof input.provisioning?.rootPasswordTemplate === "string"
          ? input.provisioning.rootPasswordTemplate
          : defaultRuntimePolicy.provisioning.rootPasswordTemplate,
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

function isIpv4(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

function isValidHostOctet(value: string | undefined): boolean {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 255;
}
