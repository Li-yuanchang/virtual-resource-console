import type { HostNode, IpPoolConfig, IpPoolPolicy, IsoImage, ProviderType, RuntimePolicy } from "../types";

export interface ProvisioningConnectionScope {
  id: string;
  providerType: ProviderType;
  host: string;
  port: number;
  username: string;
}

export interface ProvisioningStrategy {
  readonly type: ProviderType;
  readonly label: string;
  scopeKey(connection: ProvisioningConnectionScope, host: HostNode | null): string;
  installIsoImages(images: IsoImage[]): IsoImage[];
  sortIsoImages(images: IsoImage[]): IsoImage[];
  defaultIsoId(images: IsoImage[]): string;
  defaultSpecId(specs: Array<{ id: string; name: string }>): string;
  defaultVmNamePrefix(connection: ProvisioningConnectionScope, host: HostNode | null): string;
  defaultIpPools(connection: ProvisioningConnectionScope, host: HostNode | null, policy: IpPoolPolicy): IpPoolConfig[];
  deriveRootPassword(ip: string, policy: RuntimePolicy): string;
  accountPolicy(source: ProvisioningInstallStepSource): ProvisioningAccountPolicy;
}

export interface ProvisioningInstallStepSource {
  isoName: string;
  toolsIsoName?: string;
}

export interface ProvisioningAccountPolicy {
  mode: "root" | "named-user";
  label: string;
  defaultUsername: string;
  requiresUsername: boolean;
  passwordLabel: string;
  hint: string;
}

export interface IsoSourceGroup {
  label: "共享 ISO 库" | "本地 ISO 库" | "本机 DVD" | "工具盘";
  options: IsoImage[];
}

const strategies: Record<ProviderType, ProvisioningStrategy> = {
  xenserver: {
    type: "xenserver",
    label: "XenServer",
    scopeKey(connection, host) {
      return buildProvisioningScopeKey(connection, host);
    },
    installIsoImages(images) {
      return installableIsoImages(images);
    },
    sortIsoImages(images) {
      return sortIsoImages(images, ["CentOS-7-x86_64-DVD-1511.iso"], ["xs-tools.iso"]);
    },
    defaultIsoId(images) {
      return findPreferredIso(images, ["CentOS-7-x86_64-DVD-1511.iso", "CentOS-7-x86_64-DVD"])?.id ?? sortIsoImages(images)[0]?.id ?? "";
    },
    defaultSpecId(specs) {
      return findPreferredSpec(specs, ["Linux 4C8G", "linux-standard"])?.id ?? specs[0]?.id ?? "";
    },
    defaultVmNamePrefix(connection, host) {
      return `${host?.name || connection.host}-centos7`;
    },
    defaultIpPools(connection, host, policy) {
      return defaultPolicyIpPools(connection, host, policy);
    },
    deriveRootPassword(ip, policy) {
      return derivePasswordFromTemplate(ip, policy);
    },
    accountPolicy(source) {
      return resolveLinuxAccountPolicy(source.isoName);
    },
  },
  vmware: {
    type: "vmware",
    label: "VMware",
    scopeKey(connection, host) {
      return buildProvisioningScopeKey(connection, host);
    },
    installIsoImages(images) {
      return installableIsoImages(images);
    },
    sortIsoImages(images) {
      return sortIsoImages(images);
    },
    defaultIsoId(images) {
      return sortIsoImages(images)[0]?.id ?? "";
    },
    defaultSpecId(specs) {
      return specs[0]?.id ?? "";
    },
    defaultVmNamePrefix(connection, host) {
      return `${host?.name || connection.host}-vm`;
    },
    defaultIpPools(connection, host, policy) {
      return defaultPolicyIpPools(connection, host, policy);
    },
    deriveRootPassword(ip, policy) {
      return derivePasswordFromTemplate(ip, policy);
    },
    accountPolicy(source) {
      return resolveLinuxAccountPolicy(source.isoName);
    },
  },
  proxmox: {
    type: "proxmox",
    label: "Proxmox VE",
    scopeKey(connection, host) {
      return buildProvisioningScopeKey(connection, host);
    },
    installIsoImages(images) {
      return installableIsoImages(images);
    },
    sortIsoImages(images) {
      return sortIsoImages(images);
    },
    defaultIsoId(images) {
      return sortIsoImages(images)[0]?.id ?? "";
    },
    defaultSpecId(specs) {
      return specs[0]?.id ?? "";
    },
    defaultVmNamePrefix(connection, host) {
      return `${host?.name || connection.host}-vm`;
    },
    defaultIpPools(connection, host, policy) {
      return defaultPolicyIpPools(connection, host, policy);
    },
    deriveRootPassword(ip, policy) {
      return derivePasswordFromTemplate(ip, policy);
    },
    accountPolicy(source) {
      return resolveLinuxAccountPolicy(source.isoName);
    },
  },
  libvirt: {
    type: "libvirt",
    label: "KVM/libvirt",
    scopeKey(connection, host) {
      return buildProvisioningScopeKey(connection, host);
    },
    installIsoImages(images) {
      return installableIsoImages(images);
    },
    sortIsoImages(images) {
      return sortIsoImages(images);
    },
    defaultIsoId(images) {
      return sortIsoImages(images)[0]?.id ?? "";
    },
    defaultSpecId(specs) {
      return specs[0]?.id ?? "";
    },
    defaultVmNamePrefix(connection, host) {
      return `${host?.name || connection.host}-vm`;
    },
    defaultIpPools(connection, host, policy) {
      return defaultPolicyIpPools(connection, host, policy);
    },
    deriveRootPassword(ip, policy) {
      return derivePasswordFromTemplate(ip, policy);
    },
    accountPolicy(source) {
      return resolveLinuxAccountPolicy(source.isoName);
    },
  },
};

export function resolveProvisioningStrategy(providerType: ProviderType): ProvisioningStrategy {
  return strategies[providerType] ?? strategies.libvirt;
}

export function buildProvisioningScopeKey(connection: ProvisioningConnectionScope, host: HostNode | null): string {
  const hostKey = host?.providerId || host?.id || connection.host;
  const connectionKey = connection.id || `${connection.providerType}:${connection.host}:${connection.port}:${connection.username}`;
  return `${connection.providerType}::${connectionKey}::${hostKey}`;
}

function installableIsoImages(images: IsoImage[]): IsoImage[] {
  return images.filter((image) => image.sourceType !== "tools");
}

export function isoSourceLabel(image: IsoImage): IsoSourceGroup["label"] {
  if (image.sourceType === "host-dvd") return "本机 DVD";
  if (image.sourceType === "tools") return "工具盘";
  return image.shared ? "共享 ISO 库" : "本地 ISO 库";
}

export function groupIsoImagesBySource(images: IsoImage[]): IsoSourceGroup[] {
  const groups = new Map<IsoSourceGroup["label"], IsoImage[]>();
  for (const image of images) {
    const label = isoSourceLabel(image);
    const options = groups.get(label) ?? [];
    options.push(image);
    groups.set(label, options);
  }
  const order: IsoSourceGroup["label"][] = ["共享 ISO 库", "本地 ISO 库", "本机 DVD", "工具盘"];
  return Array.from(groups, ([label, options]) => ({ label, options })).sort(
    (left, right) => order.indexOf(left.label) - order.indexOf(right.label),
  );
}

function sortIsoImages(images: IsoImage[], preferredNames: string[] = [], trailingNames: string[] = []): IsoImage[] {
  return [...images].sort((left, right) => {
    const leftRank = isoRank(left.name, preferredNames, trailingNames);
    const rightRank = isoRank(right.name, preferredNames, trailingNames);
    if (leftRank !== rightRank) return leftRank - rightRank;
    const repositoryCompare = `${left.storageRepository} ${left.name}`.localeCompare(`${right.storageRepository} ${right.name}`, "zh-CN", {
      numeric: true,
      sensitivity: "base",
    });
    if (repositoryCompare !== 0) return repositoryCompare;
    return (left.path ?? left.providerId).localeCompare(right.path ?? right.providerId, "zh-CN", {
      numeric: true,
      sensitivity: "base",
    });
  });
}

function isoRank(name: string, preferredNames: string[], trailingNames: string[]) {
  const normalizedName = name.toLowerCase();
  if (preferredNames.some((item) => normalizedName.includes(item.toLowerCase()))) return 0;
  if (trailingNames.some((item) => normalizedName.includes(item.toLowerCase()))) return 2;
  return 1;
}

function findPreferredIso(images: IsoImage[], preferredNames: string[]) {
  return images.find((image) => preferredNames.some((name) => image.name.toLowerCase().includes(name.toLowerCase())));
}

function findPreferredSpec(specs: Array<{ id: string; name: string }>, preferredNames: string[]) {
  return specs.find((spec) => preferredNames.some((name) => `${spec.id} ${spec.name}`.toLowerCase().includes(name.toLowerCase())));
}

function buildStaticIpPool(id: string, name: string, prefix: string, gateway: string, dns: string[] = ["1.1.1.1"], startHost = 20, endHost = 250): IpPoolConfig {
  return {
    id,
    name,
    cidr: `${prefix}.0/24`,
    gateway,
    dns,
    startIp: `${prefix}.${startHost}`,
    endIp: `${prefix}.${endHost}`,
    reservedIps: [gateway],
  };
}

function defaultPolicyIpPools(connection: ProvisioningConnectionScope, host: HostNode | null, policy: IpPoolPolicy): IpPoolConfig[] {
  const hostIp = host?.address || connection.host;
  const hostPrefix = ipPrefix(hostIp);
  const pools = policy.ipPools.length
    ? [...policy.ipPools].sort((left, right) => ipPoolMatchRank(left.hostPrefixes, hostPrefix) - ipPoolMatchRank(right.hostPrefixes, hostPrefix))
    : [];
  return pools.map((item) => ({
    ...buildStaticIpPool(
      item.id,
      item.name,
      item.prefix,
      item.gateway,
      item.dns?.length ? item.dns : policy.defaultDns,
      item.startHost,
      item.endHost,
    ),
    networkName: item.networkName,
    vlan: item.vlan,
  })).map((pool) => ({
    ...pool,
    reservedIps: Array.from(new Set([...pool.reservedIps, ...(hostPrefix === ipPrefix(pool.startIp) ? [hostIp] : [])].filter(isIpv4))),
  }));
}

function ipPoolMatchRank(hostPrefixes: string[] | undefined, hostPrefix: string) {
  if (hostPrefixes?.includes(hostPrefix)) return 0;
  if (!hostPrefixes?.length) return 1;
  return 2;
}

function derivePasswordFromTemplate(ip: string, policy: RuntimePolicy) {
  const template = policy.provisioning.rootPasswordTemplate;
  if (!template) return "";
  const parts = ip.split(".");
  if (parts.length !== 4) return "";
  return template
    .replaceAll("{first}", parts[0])
    .replaceAll("{second}", parts[1])
    .replaceAll("{third}", parts[2])
    .replaceAll("{fourth}", parts[3])
    .replaceAll("{ip}", ip);
}

function resolveLinuxAccountPolicy(isoName: string): ProvisioningAccountPolicy {
  const normalized = isoName.toLowerCase();
  if (normalized.includes("windows") || normalized.includes("winserver")) {
    return {
      mode: "named-user",
      label: "登录账号",
      defaultUsername: "Administrator",
      requiresUsername: false,
      passwordLabel: "Administrator 密码",
      hint: "Windows Server 使用内置 Administrator 账号。",
    };
  }
  if (normalized.includes("ubuntu")) {
    return {
      mode: "named-user",
      label: "新建用户名",
      defaultUsername: "ubuntu",
      requiresUsername: true,
      passwordLabel: "登录密码",
      hint: "Ubuntu 安装需要创建普通用户。",
    };
  }
  return {
    mode: "root",
    label: "登录账号",
    defaultUsername: "root",
    requiresUsername: false,
    passwordLabel: "root 密码",
    hint: "CentOS / RHEL 默认按 root 账号处理。",
  };
}

function ipPrefix(ip: string) {
  const parts = ip.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
    return "";
  }
  return `${parts[0]}.${parts[1]}.${parts[2]}`;
}

function isIpv4(value: string | undefined) {
  if (!value) return false;
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}
