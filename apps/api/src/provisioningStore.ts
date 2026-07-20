import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { EnvironmentProvisioningTemplate, IpPoolConfig, ProvisioningConfig, ProvisioningSpecTemplate } from "./types.js";
import { getVrcDataFile } from "./appPaths.js";

const storeFile = getVrcDataFile("provisioning.json");

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
        ipPoolId: "",
        vmNamePrefix: "centos7",
        autoStart: true,
        installStrategy: "kickstart",
        installProfile: "server",
        description: "按 IP 池生成 root 密码，执行无人值守安装并验收 SSH 启动。",
      },
      {
        id: "xenserver-windows-2008-r2-standard",
        name: "XenServer Windows Server 2008 R2 标准环境",
        providerType: "xenserver",
        sourceType: "iso",
        isoNamePattern: "cn_windows_server_2008_r2_standard_enterprise_datacenter_and_web_with_sp1_x64_dvd_617598.iso",
        specId: "windows-standard",
        ipPoolId: "",
        vmNamePrefix: "win2008",
        autoStart: true,
        installStrategy: "windows-unattended",
        installProfile: "server",
        description: "使用任务级 Windows 无人值守启动 ISO 和 XenServer Tools 完成自动安装与验收。",
      },
      {
        id: "xenserver-windows-2012-r2-standard",
        name: "XenServer Windows Server 2012 R2 标准环境",
        providerType: "xenserver",
        sourceType: "iso",
        isoNamePattern: "cn_windows_server_2012_r2_vl_with_update_x64_dvd_6052729(1).iso",
        specId: "windows-standard",
        ipPoolId: "",
        vmNamePrefix: "win2012",
        autoStart: true,
        installStrategy: "windows-unattended",
        installProfile: "server",
        description: "使用任务级 Windows 无人值守启动 ISO 和 XenServer Tools 完成自动安装与验收。",
      },
      {
        id: "vmware-centos7-standard",
        name: "VMware CentOS 7 标准环境",
        providerType: "vmware",
        sourceType: "iso",
        isoNamePattern: "CentOS-7-x86_64-DVD-1511.iso",
        specId: "linux-standard",
        ipPoolId: "",
        vmNamePrefix: "vmware-linux",
        autoStart: true,
        installStrategy: "kickstart",
        installProfile: "server",
        description: "使用 ESXi Datastore 原版 ISO 与任务级 Kickstart 启动 ISO 执行无人值守安装。",
      },
      {
        id: "pve-openeuler-kickstart-standard",
        name: "PVE openEuler ARM 标准环境",
        providerType: "proxmox",
        sourceType: "iso",
        isoNamePattern: "openEuler-22.03-LTS-SP4-aarch64-dvd.iso",
        specId: "linux-standard",
        ipPoolId: "",
        vmNamePrefix: "openeuler",
        autoStart: true,
        installStrategy: "kickstart",
        installProfile: "server",
        description: "使用 PVE 宿主机原版 openEuler ARM ISO 与任务级 Kickstart 介质执行无人值守安装。",
      },
      {
        id: "pve-kylin-kickstart-standard",
        name: "PVE Kylin Server ARM 标准环境",
        providerType: "proxmox",
        sourceType: "iso",
        isoNamePattern: "Kylin-Server-V10-SP3-2403-Release-20240426-arm64.iso",
        specId: "linux-standard",
        ipPoolId: "",
        vmNamePrefix: "kylin",
        autoStart: true,
        installStrategy: "kickstart",
        installProfile: "server",
        description: "使用 PVE 宿主机原版 Kylin Server ARM ISO 与任务级 Kickstart 介质执行无人值守安装。",
      },
      {
        id: "pve-kylin-kickstart-desktop",
        name: "PVE Kylin ARM 桌面环境",
        providerType: "proxmox",
        sourceType: "iso",
        isoNamePattern: "Kylin-Server-V10-SP3-2403-Release-20240426-arm64.iso",
        specId: "linux-standard",
        ipPoolId: "",
        vmNamePrefix: "kylin-desktop",
        autoStart: true,
        installStrategy: "kickstart",
        installProfile: "desktop",
        description: "按所选麒麟 ISO 的桌面环境组安装 UKUI 图形界面。",
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
  const migrated = current.filter((item) => item.id !== "vmware-linux-clone-standard" && item.id !== "pve-linux-cloudinit-standard");
  const existingIds = new Set(migrated.map((item) => item.id));
  return [...migrated, ...defaults.filter((item) => !existingIds.has(item.id))];
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
    ipPoolId: normalizeTemplateIpPoolId(item.ipPoolId),
    vmNamePrefix: item.vmNamePrefix?.trim() || "vm",
    autoStart: item.autoStart !== false,
    installStrategy:
      item.installStrategy === "template-clone" || item.installStrategy === "windows-unattended" || item.installStrategy === "manual-iso"
        ? item.installStrategy
        : "kickstart",
    installProfile: item.installProfile === "desktop" ? "desktop" : "server",
    description: item.description?.trim() || undefined,
  };
}

function normalizeTemplateIpPoolId(value: string | undefined): string {
  const ipPoolId = value?.trim() || "";
  return ipPoolId === "xenserver-192-168-127" ? "" : ipPoolId;
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
