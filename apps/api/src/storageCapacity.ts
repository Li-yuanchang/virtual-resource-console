import type { CapacityBreakdown, HostNode, ProviderType, ResourceCapacitySummary, StorageRepository } from "./types.js";

export interface NativeStorageCapacity {
  physicalGiB: number;
  usedGiB: number;
  virtualGiB?: number | null;
}

/**
 * 判断存储池是否可承载虚拟机磁盘（即能否作为新虚拟机磁盘的分配目标）。
 * 与各平台预配选盘逻辑保持一致，避免把 ISO 镜像库、可移动介质、纯备份存储等
 * 不可分配 VM 磁盘的仓库混入“可分配容量”：
 * - xenserver：排除 iso / udev 类型（对应 find_sr 中 type=iso 跳过）；
 * - proxmox：仅保留 content 含 images / rootdir 的存储（对应 pickProxmoxVmStorage）；
 * - vmware：vSphere Datastore 无结构化“仅 ISO/仅备份”类型，全部视为可承载 VM 磁盘。
 *
 * @param providerType 平台类型。
 * @param repository 存储仓库（含 type、content 等平台原生元数据）。
 * @return true 表示该仓库可承载 VM 磁盘，应计入可分配容量；false 表示应排除。
 */
export function isVmDiskRepository(providerType: ProviderType, repository: StorageRepository): boolean {
  if (providerType === "xenserver") {
    const type = repository.type.trim().toLowerCase();
    // lvmohba / lvmoiscsi / lvm / ext / nfs / smb / cifs 等均可承载 VM 磁盘
    return type !== "" && type !== "iso" && type !== "udev";
  }
  if (providerType === "proxmox") {
    const content = repository.content ?? [];
    // PVE 未声明 content 时按 PVE 默认视为支持所有内容类型（与 storageSupportsContent 一致）
    if (content.length === 0) return true;
    const normalized = new Set(content.map((item) => item.trim().toLowerCase()));
    return normalized.has("images") || normalized.has("rootdir");
  }
  return true;
}

/**
 * Normalizes provider-native storage metrics into the shared inventory contract.
 * Missing provisioned capacity remains null instead of reusing physical usage.
 */
export function normalizeStorageCapacity(
  capacity: NativeStorageCapacity,
): Pick<StorageRepository, "physicalGiB" | "usedGiB" | "virtualGiB"> {
  return {
    physicalGiB: finiteCapacity(capacity.physicalGiB),
    usedGiB: finiteCapacity(capacity.usedGiB),
    virtualGiB: capacity.virtualGiB == null ? null : finiteCapacity(capacity.virtualGiB),
  };
}

/**
 * Builds the platform-neutral memory and storage values consumed by the resource UI.
 * Provider-specific collection stays inside each provider; this policy layer only
 * converts those native readings into the shared no-overcommit contract.
 * 存储侧只统计可承载 VM 磁盘的仓库（isVmDiskRepository），保证“剩余/可分配”口径
 * 反映真实可分配虚拟机磁盘的空间，而非全部存储池（含 ISO 库、可移动介质）的加总。
 */
export function summarizeResourceCapacity(
  providerType: ProviderType,
  hosts: HostNode[],
  repositories: StorageRepository[],
  vmConfigured: { memoryBytes: number; runningMemoryBytes?: number; storageBytes: number },
  hostId?: string,
): ResourceCapacitySummary {
  const policy = providerCapacityPolicies[providerType];
  const scopedHosts = hosts.filter((item) => !hostId || item.providerId === hostId);
  // 先按主机/节点范围过滤，再剔除不可承载 VM 磁盘的仓库
  const scopedRepositories = repositories.filter(
    (item) => (!hostId || !item.hostId || item.hostId === hostId) && isVmDiskRepository(providerType, item),
  );
  const memoryTotalBytes = scopedHosts.reduce((sum, item) => sum + finiteCapacity(item.memoryTotalBytes), 0);
  const memoryFreeBytes = scopedHosts.reduce((sum, item) => sum + finiteCapacity(item.memoryFreeBytes ?? 0), 0);

  const memoryTotalGiB = memoryTotalBytes / 1024 ** 3;
  const memoryUsedGiB = Math.max(memoryTotalBytes - memoryFreeBytes, 0) / 1024 ** 3;
  const memoryConfiguredGiB = vmConfigured.memoryBytes / 1024 ** 3;
  const runningMemoryConfiguredGiB = (vmConfigured.runningMemoryBytes ?? vmConfigured.memoryBytes) / 1024 ** 3;
  const memory = policy.summarize(memoryTotalGiB, memoryUsedGiB, memoryConfiguredGiB);
  const runningConfigured = Math.min(finiteCapacity(runningMemoryConfiguredGiB), finiteCapacity(memoryConfiguredGiB));
  const haltedConfigured = Math.max(finiteCapacity(memoryConfiguredGiB) - runningConfigured, 0);
  const guaranteedHeadroom = Math.max(memory.physicalFreeGiB - haltedConfigured, 0);
  const startupDeficit = Math.max(haltedConfigured - memory.physicalFreeGiB, 0);

  return {
    memory: {
      ...memory,
      allocatableGiB: roundGiB(guaranteedHeadroom),
      runningConfiguredGiB: roundGiB(runningConfigured),
      haltedConfiguredGiB: roundGiB(haltedConfigured),
      guaranteedHeadroomGiB: roundGiB(guaranteedHeadroom),
      startupDeficitGiB: roundGiB(startupDeficit),
      startupStatus: startupDeficit > 0 ? "at-risk" : "guaranteed",
    },
    storage: policy.summarize(
      scopedRepositories.reduce((sum, item) => sum + finiteCapacity(item.physicalGiB), 0),
      scopedRepositories.reduce((sum, item) => sum + finiteCapacity(item.usedGiB), 0),
      vmConfigured.storageBytes / 1024 ** 3,
    ),
  };
}

interface ProviderCapacityPolicy {
  summarize(physicalTotalGiB: number, physicalUsedGiB: number, vmConfiguredGiB: number): CapacityBreakdown;
}

const noOvercommitPolicy: ProviderCapacityPolicy = {
  summarize(physicalTotalGiB, physicalUsedGiB, vmConfiguredGiB) {
    const total = finiteCapacity(physicalTotalGiB);
    const used = finiteCapacity(physicalUsedGiB);
    const configured = finiteCapacity(vmConfiguredGiB);
    const physicalUsageRatio = total > 0 ? used / total : 0;
    const physicalFree = Math.max(total - used, 0);
    const configurable = Math.max(total - configured, 0);
    const overconfigured = Math.max(configured - total, 0);
    return {
      physicalTotalGiB: roundGiB(total),
      physicalUsedGiB: roundGiB(used),
      physicalFreeGiB: roundGiB(physicalFree),
      physicalStatus: physicalUsageRatio >= 0.95 ? "danger" : physicalUsageRatio >= 0.85 ? "warning" : "normal",
      vmConfiguredGiB: roundGiB(configured),
      vmConfigurableGiB: roundGiB(configurable),
      vmOverconfiguredGiB: roundGiB(overconfigured),
      vmStatus: overconfigured > 0 ? "overconfigured" : "within-capacity",
      allocatableGiB: roundGiB(Math.min(physicalFree, configurable)),
    };
  },
};

// The map is the backend policy boundary. Platforms can diverge here without changing the web contract.
const providerCapacityPolicies: Record<ProviderType, ProviderCapacityPolicy> = {
  xenserver: noOvercommitPolicy,
  vmware: noOvercommitPolicy,
  proxmox: noOvercommitPolicy,
  libvirt: noOvercommitPolicy,
};

function finiteCapacity(value: number): number {
  return Number.isFinite(value) ? Math.max(value, 0) : 0;
}

function roundGiB(value: number): number {
  return Math.round(value * 10) / 10;
}
