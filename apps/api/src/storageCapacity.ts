import type { CapacityBreakdown, HostNode, ProviderType, ResourceCapacitySummary, StorageRepository } from "./types.js";

export interface NativeStorageCapacity {
  physicalGiB: number;
  usedGiB: number;
  virtualGiB?: number | null;
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
  const scopedRepositories = repositories.filter((item) => !hostId || !item.hostId || item.hostId === hostId);
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
