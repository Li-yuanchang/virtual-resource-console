import type { ProviderType } from "./types.js";

const providerNameLimits: Record<ProviderType, number> = {
  xenserver: 128,
  vmware: 80,
  proxmox: 63,
  libvirt: 128,
};

const proxmoxDnsNamePattern = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;

export class VmRenameValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VmRenameValidationError";
  }
}

export class VmRenameConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VmRenameConflictError";
  }
}

export interface NormalizedVmRenameInput {
  currentName: string;
  newName: string;
}

/**
 * Validates and normalizes VM display names before a provider mutation.
 *
 * @param providerType virtualization platform whose naming rules apply; must be a registered provider type.
 * @param currentName display name observed by the caller; must be non-empty and is used for optimistic concurrency.
 * @param newName requested platform display name; surrounding whitespace is removed and platform limits are enforced.
 * @return normalized current and requested names; throws {@link VmRenameValidationError} for invalid input.
 */
export function normalizeVmRenameInput(
  providerType: ProviderType,
  currentName: string,
  newName: string,
): NormalizedVmRenameInput {
  const normalizedCurrentName = currentName.trim();
  const normalizedNewName = newName.trim();
  if (!normalizedCurrentName) throw new VmRenameValidationError("当前虚拟机名称不能为空，请刷新列表后重试。");
  if (!normalizedNewName) throw new VmRenameValidationError("请输入新的虚拟机名称。");
  if (/[\u0000-\u001f\u007f]/.test(normalizedNewName)) {
    throw new VmRenameValidationError("虚拟机名称不能包含控制字符或换行。");
  }
  const maxLength = providerNameLimits[providerType];
  if (Array.from(normalizedNewName).length > maxLength) {
    throw new VmRenameValidationError(`虚拟机名称不能超过 ${maxLength} 个字符。`);
  }
  if (normalizedCurrentName === normalizedNewName) {
    throw new VmRenameValidationError("新名称不能与当前名称相同。");
  }
  if (providerType === "proxmox" && !proxmoxDnsNamePattern.test(normalizedNewName)) {
    throw new VmRenameValidationError("Proxmox VE 名称只能使用字母、数字、点或连字符，且首尾必须为字母或数字。");
  }
  if (providerType === "libvirt") {
    throw new VmRenameValidationError("KVM/libvirt 当前版本暂不支持虚拟机改名。");
  }
  return {
    currentName: normalizedCurrentName,
    newName: normalizedNewName,
  };
}

/**
 * Protects a rename from overwriting a concurrent platform-side name change.
 *
 * @param actualName current name read directly from the virtualization platform; must be the latest observed value.
 * @param expectedName name submitted by the client from its inventory row; must match exactly.
 * @return void; throws {@link VmRenameConflictError} when the platform value has changed.
 */
export function assertVmRenameCurrentName(actualName: string, expectedName: string): void {
  if (actualName.trim() === expectedName.trim()) return;
  throw new VmRenameConflictError(`虚拟机名称已变更为“${actualName.trim() || "未命名"}”，请刷新列表后重试。`);
}

/**
 * Rejects another VM with the requested display name inside the provider-specific lookup scope.
 *
 * @param duplicateFound whether another VM in the resolved provider scope already has the requested name.
 * @param scopeLabel user-facing provider scope, such as current pool, folder, or PVE node; must be non-empty.
 * @param newName normalized requested display name; must be non-empty.
 * @return void; throws {@link VmRenameConflictError} when a duplicate exists.
 */
export function assertVmRenameNameAvailable(duplicateFound: boolean, scopeLabel: string, newName: string): void {
  if (!duplicateFound) return;
  throw new VmRenameConflictError(`${scopeLabel}内已存在名为“${newName}”的虚拟机。`);
}
