import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { EnvironmentProvisioningTemplate, IpPoolConfig, ProvisioningConfig, ProvisioningSpecTemplate } from "./types.js";

const storeDir = join(homedir(), ".virtual-resource-console");
const storeFile = join(storeDir, "provisioning.json");

interface ProvisioningStoreFile {
  version: 1;
  config: ProvisioningConfig;
}

type ProvisioningSpecTemplateInput = Omit<ProvisioningSpecTemplate, "id"> & { id?: string };
type EnvironmentProvisioningTemplateInput = Omit<EnvironmentProvisioningTemplate, "id"> & { id?: string };
type IpPoolConfigInput = Omit<IpPoolConfig, "id"> & { id?: string };

interface ProvisioningConfigInput {
  environmentTemplates?: EnvironmentProvisioningTemplateInput[];
  specTemplates?: ProvisioningSpecTemplateInput[];
  ipPools?: IpPoolConfigInput[];
}

export function getProvisioningConfig(): ProvisioningConfig {
  const store = readStore();
  return normalizeProvisioningConfig(store.config);
}

export function saveProvisioningConfig(input: ProvisioningConfigInput): ProvisioningConfig {
  const current = getProvisioningConfig();
  const config = normalizeProvisioningConfig({
    environmentTemplates: input.environmentTemplates ?? current.environmentTemplates,
    specTemplates: input.specTemplates ?? current.specTemplates,
    ipPools: input.ipPools ?? current.ipPools,
  });
  writeStore({ version: 1, config });
  return config;
}

function defaultProvisioningConfig(): ProvisioningConfig {
  return {
    environmentTemplates: [
      {
        id: "xenserver-centos7-standard",
        name: "XenServer CentOS 7 标准环境",
        providerType: "xenserver",
        sourceType: "iso",
        isoNamePattern: "CentOS-7-x86_64-DVD-1511.iso",
        specId: "linux-standard",
        ipPoolId: "xenserver-192-168-127",
        vmNamePrefix: "centos7",
        autoStart: true,
        installStrategy: "kickstart",
        description: "按 IP 池生成 root 密码，执行无人值守安装并验收 SSH 启动。",
      },
      {
        id: "vmware-linux-clone-standard",
        name: "VMware Linux 克隆环境",
        providerType: "vmware",
        sourceType: "template",
        specId: "linux-standard",
        ipPoolId: "",
        vmNamePrefix: "vmware-linux",
        autoStart: true,
        installStrategy: "template-clone",
        description: "使用克隆源生成 VM，写入规格、静态 IP，并验收 SSH 启动。",
      },
      {
        id: "pve-linux-cloudinit-standard",
        name: "PVE Linux cloud-init 环境",
        providerType: "proxmox",
        sourceType: "template",
        specId: "linux-standard",
        ipPoolId: "",
        vmNamePrefix: "pve-linux",
        autoStart: true,
        installStrategy: "template-clone",
        description: "使用 cloud-init 克隆源生成 VM，写入规格、静态 IP，并验收 SSH 启动。",
      },
    ],
    specTemplates: [
      {
        id: "linux-small",
        name: "Linux 2C4G",
        cpu: 2,
        memoryGiB: 4,
        systemDiskGiB: 80,
        dataDiskGiB: 0,
        description: "轻量服务或测试环境",
      },
      {
        id: "linux-standard",
        name: "Linux 4C8G",
        cpu: 4,
        memoryGiB: 8,
        systemDiskGiB: 100,
        dataDiskGiB: 0,
        description: "常规业务服务",
      },
      {
        id: "windows-standard",
        name: "Windows 4C8G",
        cpu: 4,
        memoryGiB: 8,
        systemDiskGiB: 120,
        dataDiskGiB: 0,
        description: "Windows Server 常规规格",
      },
    ],
    ipPools: [],
  };
}

function normalizeProvisioningConfig(input: {
  environmentTemplates?: Array<EnvironmentProvisioningTemplate | EnvironmentProvisioningTemplateInput>;
  specTemplates: Array<ProvisioningSpecTemplate | ProvisioningSpecTemplateInput>;
  ipPools: Array<IpPoolConfig | IpPoolConfigInput>;
}): ProvisioningConfig {
  const defaults = defaultProvisioningConfig();
  return {
    environmentTemplates: mergeDefaultEnvironmentTemplates(
      input.environmentTemplates?.length ? input.environmentTemplates.map(normalizeEnvironmentTemplate) : defaults.environmentTemplates,
      defaults.environmentTemplates,
    ),
    specTemplates: input.specTemplates.length ? input.specTemplates.map(normalizeSpecTemplate) : defaults.specTemplates,
    ipPools: input.ipPools.map(normalizeIpPool),
  };
}

function mergeDefaultEnvironmentTemplates(
  current: EnvironmentProvisioningTemplate[],
  defaults: EnvironmentProvisioningTemplate[],
): EnvironmentProvisioningTemplate[] {
  const existingIds = new Set(current.map((item) => item.id));
  return [...current, ...defaults.filter((item) => !existingIds.has(item.id))];
}

function normalizeEnvironmentTemplate(
  item: EnvironmentProvisioningTemplate | EnvironmentProvisioningTemplateInput,
): EnvironmentProvisioningTemplate {
  return {
    id: item.id || randomUUID(),
    name: item.name?.trim() || "未命名创建模板",
    providerType: item.providerType,
    sourceType: item.sourceType === "template" ? "template" : "iso",
    isoNamePattern: item.isoNamePattern?.trim() || undefined,
    platformTemplateName: item.platformTemplateName?.trim() || undefined,
    specId: item.specId?.trim() || "linux-standard",
    ipPoolId: item.ipPoolId?.trim() || "",
    vmNamePrefix: item.vmNamePrefix?.trim() || "vm",
    autoStart: item.autoStart !== false,
    installStrategy:
      item.installStrategy === "template-clone" || item.installStrategy === "manual-iso" ? item.installStrategy : "kickstart",
    description: item.description?.trim() || undefined,
  };
}

function normalizeSpecTemplate(item: ProvisioningSpecTemplate | ProvisioningSpecTemplateInput): ProvisioningSpecTemplate {
  return {
    id: item.id || randomUUID(),
    name: item.name?.trim() || "未命名规格",
    cpu: positiveInteger(item.cpu, 1),
    memoryGiB: positiveInteger(item.memoryGiB, 1),
    systemDiskGiB: positiveInteger(item.systemDiskGiB, 20),
    dataDiskGiB: Math.max(Number(item.dataDiskGiB) || 0, 0),
    description: item.description?.trim() || undefined,
  };
}

function normalizeIpPool(item: IpPoolConfig | IpPoolConfigInput): IpPoolConfig {
  return {
    id: item.id || randomUUID(),
    name: item.name?.trim() || item.cidr || "未命名 IP 池",
    cidr: item.cidr?.trim() || "",
    gateway: item.gateway?.trim() || "",
    dns: item.dns.map((value) => value.trim()).filter(Boolean),
    startIp: item.startIp?.trim() || "",
    endIp: item.endIp?.trim() || "",
    reservedIps: Array.from(new Set(item.reservedIps.map((value) => value.trim()).filter(Boolean))),
    networkName: item.networkName?.trim() || undefined,
    vlan: item.vlan?.trim() || undefined,
  };
}

function positiveInteger(value: number, fallback: number): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readStore(): ProvisioningStoreFile {
  ensureStoreDir();
  if (!existsSync(storeFile)) {
    return { version: 1, config: defaultProvisioningConfig() };
  }
  try {
    const parsed = JSON.parse(readFileSync(storeFile, "utf8")) as ProvisioningStoreFile;
    return {
      version: 1,
      config: normalizeProvisioningConfig(parsed.config ?? defaultProvisioningConfig()),
    };
  } catch {
    return { version: 1, config: defaultProvisioningConfig() };
  }
}

function writeStore(store: ProvisioningStoreFile): void {
  ensureStoreDir();
  writeFileSync(storeFile, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

function ensureStoreDir(): void {
  mkdirSync(dirname(storeFile), { recursive: true, mode: 0o700 });
}
