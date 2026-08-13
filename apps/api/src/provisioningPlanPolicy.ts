import { getProvisioningConfig } from "./provisioningStore.js";
import { providerLabel } from "./providerCatalog.js";
import { matchesIsoNamePattern } from "./isoTemplateMatch.js";
import type { IsoImage, ProviderType, StorageRepository, VmProvisionRequest } from "./types.js";

export interface ProvisioningPlanValidationInput {
  request: VmProvisionRequest;
  templateName?: string;
}

export interface ProvisioningPlanPolicy {
  readonly providerType: ProviderType;
  readonly missingIsoStatus: "warning" | "error";
  readonly requiresSingleStorageCapacity: boolean;
  validate(input: ProvisioningPlanValidationInput): string[];
  selectVmStorage(storage: StorageRepository[]): StorageRepository[];
  installMediaError(image: IsoImage): string | undefined;
}

class StandardProvisioningPlanPolicy implements ProvisioningPlanPolicy {
  readonly missingIsoStatus = "warning" as const;
  readonly requiresSingleStorageCapacity: boolean = false;

  constructor(readonly providerType: ProviderType) {}

  validate(input: ProvisioningPlanValidationInput): string[] {
    if (input.request.sourceType === "template" && !input.templateName?.trim()) {
      return [`${providerLabel(this.providerType)} 模板克隆必须选择克隆源`];
    }
    if (input.request.sourceType === "iso" && input.request.installStrategy === "manual-iso") {
      return [`${providerLabel(this.providerType)} 尚未配置所选 ISO 的无人值守安装策略`];
    }
    return [];
  }

  selectVmStorage(storage: StorageRepository[]): StorageRepository[] {
    return storage;
  }

  installMediaError(): undefined {
    return undefined;
  }
}

class XenServerProvisioningPlanPolicy implements ProvisioningPlanPolicy {
  readonly providerType = "xenserver" as const;
  readonly missingIsoStatus = "error" as const;
  readonly requiresSingleStorageCapacity = false;

  validate({ request }: ProvisioningPlanValidationInput): string[] {
    const errors: string[] = [];
    if (request.sourceType !== "iso") errors.push("XenServer 当前一键安装必须使用 ISO/Kickstart 策略");
    if (!request.isoId?.trim()) errors.push("XenServer 一键安装必须选择系统 ISO");
    if (!request.ipPool.gateway.trim() || !isIpv4(request.ipPool.gateway)) errors.push("XenServer 一键安装必须配置有效网关");
    if (!request.ipPool.dns.some((item) => isIpv4(item))) errors.push("XenServer 一键安装必须配置有效 DNS");
    if (!request.ipPool.cidr.includes("/")) errors.push("XenServer 一键安装必须配置 CIDR，用于生成静态 IP 子网掩码");
    if (request.installStrategy === "windows-unattended") {
      const isoIdentity = `${request.isoName || ""} ${request.isoId || ""}`.toLowerCase();
      if (request.sourceType !== "iso") errors.push("Windows 无人值守必须使用 XenServer ISO 安装策略");
      if (!isoIdentity.includes("windows_server_2008_r2") && !isoIdentity.includes("windows_server_2012_r2")) {
        errors.push("Windows 无人值守当前仅支持已校验的 Windows Server 2008 R2 / 2012 R2 原版 ISO");
      }
    }
    if (request.installStrategy === "ubuntu-autoinstall") {
      const isoIdentity = `${request.isoName || ""} ${request.isoId || ""}`.toLowerCase();
      if (request.sourceType !== "iso") errors.push("Ubuntu 无人值守必须使用 XenServer ISO 安装策略");
      if (!isoIdentity.includes("ubuntu")) {
        errors.push("Ubuntu 无人值守必须选择 Ubuntu Desktop 原版 ISO（镜像名需包含 ubuntu，当前仅验证 Ubuntu 24.04 Desktop）");
      }
    }
    return errors;
  }

  selectVmStorage(storage: StorageRepository[]): StorageRepository[] {
    return storage;
  }

  installMediaError(image: IsoImage): string | undefined {
    return image.sourceType === "tools" ? `${image.name} 是监控工具盘，不能用于安装操作系统` : undefined;
  }
}

class ProxmoxProvisioningPlanPolicy extends StandardProvisioningPlanPolicy {
  override readonly requiresSingleStorageCapacity = true;

  constructor() {
    super("proxmox");
  }

  override validate(input: ProvisioningPlanValidationInput): string[] {
    const errors = super.validate(input);
    const { request } = input;
    if (request.installProfile === "desktop" && request.installStrategy !== "manual-iso") {
      if (request.installStrategy !== "kickstart" || request.sourceType !== "iso") {
        errors.push("桌面安装当前只支持 PVE ISO/Kickstart 策略");
      }
      const isoIdentity = `${request.isoName || ""} ${request.isoId || ""}`.toLowerCase();
      if (!isoIdentity.includes("kylin") || (!isoIdentity.includes("arm64") && !isoIdentity.includes("aarch64"))) {
        errors.push("PVE 桌面安装必须选择包含 UKUI 环境组的麒麟 ARM ISO");
      }
    }
    return errors;
  }

  override selectVmStorage(storage: StorageRepository[]): StorageRepository[] {
    return storage.filter((item) => !item.content?.length || item.content.includes("images") || item.content.includes("rootdir"));
  }
}

const policies = new Map<ProviderType, ProvisioningPlanPolicy>([
  ["xenserver", new XenServerProvisioningPlanPolicy()],
  ["vmware", new StandardProvisioningPlanPolicy("vmware")],
  ["proxmox", new ProxmoxProvisioningPlanPolicy()],
  ["libvirt", new StandardProvisioningPlanPolicy("libvirt")],
]);

export function validateProvisionPlan(providerType: ProviderType, request: VmProvisionRequest, raw: { templateName?: string }): string[] {
  const errors = validateCommonPlan(providerType, request);
  const policy = policies.get(providerType);
  if (!policy) errors.push(`未注册创建计划策略：${providerType}`);
  else errors.push(...policy.validate({ request, templateName: raw.templateName }));
  return Array.from(new Set(errors));
}

export function resolveProvisioningPlanPolicy(providerType: ProviderType): ProvisioningPlanPolicy {
  const policy = policies.get(providerType);
  if (!policy) throw new Error(`未注册创建计划策略：${providerType}`);
  return policy;
}

function validateCommonPlan(providerType: ProviderType, request: VmProvisionRequest): string[] {
  const errors: string[] = [];
  if (request.environmentTemplateId) {
    const template = getProvisioningConfig().environmentTemplates.find((item) => item.id === request.environmentTemplateId);
    if (!template) {
      errors.push(`系统环境不存在：${request.environmentTemplateId}`);
    } else {
      if (template.providerType && template.providerType !== providerType) errors.push(`系统环境与虚拟化平台不匹配：${template.name}`);
      if (template.sourceType !== request.sourceType) errors.push(`系统环境与安装来源不匹配：${template.name}`);
      if (request.installStrategy && template.installStrategy !== request.installStrategy) errors.push(`系统环境与安装策略不匹配：${template.name}`);
      const requestProfile = request.installProfile === "desktop" ? "desktop" : "server";
      if (template.installProfile !== requestProfile) errors.push(`系统环境与安装类型不匹配：${template.name}`);
      if (template.sourceType === "iso" && template.isoNamePattern) {
        if (!matchesIsoNamePattern({ name: request.isoName, id: request.isoId }, template.isoNamePattern)) {
          errors.push(`系统环境与镜像不匹配：${template.name} 需要 ${template.isoNamePattern}`);
        }
      }
    }
  }
  if (request.count !== request.planItems.length) errors.push(`创建数量与 VM 计划不一致：数量 ${request.count}，计划 ${request.planItems.length} 台`);
  const names = new Set<string>();
  const ips = new Set<string>();
  for (const item of request.planItems) {
    const name = item.name.trim();
    const ip = item.ip.trim();
    if (!name) errors.push("VM 名称不能为空");
    if (names.has(name)) errors.push(`VM 名称重复：${name}`);
    names.add(name);
    if (!isIpv4(ip)) errors.push(`VM IP 格式不正确：${ip || item.name}`);
    if (ips.has(ip)) errors.push(`VM IP 重复：${ip}`);
    ips.add(ip);
    if (request.autoStart && !item.rootPassword?.trim()) errors.push(`缺少 ${item.name} 的登录密码，无法完成启动后的账号验收`);
    if (request.installStrategy === "windows-unattended" && !isWindowsPasswordComplex(item.rootPassword || "")) {
      errors.push(`${item.name} 的 Administrator 密码至少 8 位，并需包含数字、特殊字符及大小写字母中的三类`);
    }
  }
  return errors;
}

function isWindowsPasswordComplex(password: string): boolean {
  const categories = [/[a-z]/.test(password), /[A-Z]/.test(password), /\d/.test(password), /[^A-Za-z0-9]/.test(password)].filter(Boolean).length;
  return password.length >= 8 && categories >= 3;
}

function isIpv4(value: string | undefined): boolean {
  if (!value) return false;
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}
