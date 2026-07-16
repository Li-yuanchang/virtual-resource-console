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
  sortIsoImages(images: IsoImage[]): IsoImage[];
  defaultIsoId(images: IsoImage[]): string;
  defaultSpecId(specs: Array<{ id: string; name: string }>): string;
  defaultVmNamePrefix(connection: ProvisioningConnectionScope, host: HostNode | null): string;
  defaultIpPools(connection: ProvisioningConnectionScope, host: HostNode | null, policy: IpPoolPolicy): IpPoolConfig[];
  deriveRootPassword(ip: string, policy: RuntimePolicy): string;
  accountPolicy(source: ProvisioningInstallStepSource): ProvisioningAccountPolicy;
  installSteps(source: ProvisioningInstallStepSource): ProvisioningInstallStep[];
}

export interface ProvisioningInstallStepSource {
  isoName: string;
  toolsIsoName?: string;
}

export interface ProvisioningInstallStep {
  title: string;
  detail: string;
}

export interface ProvisioningAccountPolicy {
  mode: "root" | "named-user";
  label: string;
  defaultUsername: string;
  requiresUsername: boolean;
  passwordLabel: string;
  hint: string;
}

const strategies: Record<ProviderType, ProvisioningStrategy> = {
  xenserver: {
    type: "xenserver",
    label: "XenServer",
    scopeKey(connection, host) {
      return buildProvisioningScopeKey(connection, host);
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
    installSteps(source) {
      const account = resolveLinuxAccountPolicy(source.isoName);
      return [
        {
          title: "创建 VM 并挂载系统 ISO",
          detail: `使用 ${source.isoName || "CentOS-7-x86_64-DVD-1511.iso"} 作为安装介质。`,
        },
        {
          title: "安装系统并配置网络",
          detail: "从 IP 池分配未被任何 VM 占用过的地址，网关和 DNS 按模板配置写入。",
        },
        {
          title: account.mode === "root" ? "设置 root 默认密码" : "创建登录用户",
          detail: account.mode === "root" ? "按环境模板生成初始 root 口令，创建后应及时变更。" : "安装时创建普通登录用户，初始口令由环境模板生成。",
        },
        {
          title: "系统安装完成后重启",
          detail: "首次进入系统后确认网络与 root 登录可用。",
        },
        {
          title: "挂载 XenServer Tools 并重启",
          detail: `选择 ${source.toolsIsoName || "xs-tools.iso"}，安装监控工具后再次重启。`,
        },
        {
          title: "验收账号与监控状态",
          detail: "测试 root 密码、IP 连通性，并确认 XenServer 能读取监控指标。",
        },
      ];
    },
  },
  vmware: {
    type: "vmware",
    label: "VMware",
    scopeKey(connection, host) {
      return buildProvisioningScopeKey(connection, host);
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
    installSteps(source) {
      return genericInstallSteps(source);
    },
  },
  proxmox: {
    type: "proxmox",
    label: "Proxmox VE",
    scopeKey(connection, host) {
      return buildProvisioningScopeKey(connection, host);
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
    installSteps(source) {
      return genericInstallSteps(source);
    },
  },
  libvirt: {
    type: "libvirt",
    label: "KVM/libvirt",
    scopeKey(connection, host) {
      return buildProvisioningScopeKey(connection, host);
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
    installSteps(source) {
      return genericInstallSteps(source);
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

function genericInstallSteps(source: ProvisioningInstallStepSource): ProvisioningInstallStep[] {
  const account = resolveLinuxAccountPolicy(source.isoName);
  return [
    {
      title: "创建 VM",
      detail: "按所选规格、网络和存储生成创建计划。",
    },
    {
      title: "挂载安装介质",
      detail: source.isoName ? `使用 ${source.isoName} 作为安装介质。` : "等待选择 ISO 或模板来源。",
    },
    {
      title: "配置系统网络",
      detail: "使用 IP 池中的未占用地址、网关和 DNS 完成网络配置。",
    },
    {
      title: account.mode === "root" ? "启动并验收" : "创建用户并验收",
      detail:
        account.mode === "root"
          ? "开机后打开控制台确认账号、网络和平台监控状态。"
          : "安装时创建普通登录用户，开机后确认账号、网络和平台监控状态。",
    },
  ];
}

function resolveLinuxAccountPolicy(isoName: string): ProvisioningAccountPolicy {
  const normalized = isoName.toLowerCase();
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
