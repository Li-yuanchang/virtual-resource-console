import type {
  HostNode,
  NetworkInterface,
  PagedResult,
  ProviderType,
  StorageRepository,
  VmDisk,
  VmInventorySummary,
  VmNode,
  VmSearchIndexItem,
} from "./types.js";

export interface HostInventorySnapshot {
  hosts: HostNode[];
  storage: StorageRepository[];
  networks: NetworkInterface[];
}

export interface InventoryCacheScope {
  providerType: ProviderType;
  connectionId?: string;
  host: string;
  port: number;
  username: string;
  poolId?: string;
  hostId?: string;
  page?: number;
  pageSize?: number;
  keyword?: string;
  vmId?: string;
}

export interface InventoryCacheResult<T> {
  value: T;
  source: "cache" | "live";
  updatedAt: string;
  refreshing: boolean;
}

interface InventoryCacheEntry<T> {
  scope: InventoryCacheScope;
  value?: T;
  updatedAtMs: number;
  pending?: Promise<T>;
}

const HOST_TTL_MS = 60_000;
const VM_SUMMARY_TTL_MS = 30_000;
const VM_LIST_TTL_MS = 45_000;
const VM_DISK_TTL_MS = 30_000;
const VM_SEARCH_INDEX_TTL_MS = 60_000;

export class InventoryCache {
  private readonly hosts = new Map<string, InventoryCacheEntry<HostInventorySnapshot>>();
  private readonly vmSummaries = new Map<string, InventoryCacheEntry<VmInventorySummary>>();
  private readonly vmLists = new Map<string, InventoryCacheEntry<PagedResult<VmNode>>>();
  private readonly vmDisks = new Map<string, InventoryCacheEntry<VmDisk[]>>();
  private readonly vmSearchIndexes = new Map<string, InventoryCacheEntry<VmSearchIndexItem[]>>();

  getHosts(scope: InventoryCacheScope, loader: () => Promise<HostInventorySnapshot>, forceRefresh = false) {
    return this.getOrRefresh(this.hosts, buildInventoryCacheKey("hosts", scope), scope, HOST_TTL_MS, loader, forceRefresh);
  }

  seedHosts(scope: InventoryCacheScope, value: HostInventorySnapshot, updatedAtMs: number): void {
    const key = buildInventoryCacheKey("hosts", scope);
    if (this.hosts.has(key)) return;
    this.hosts.set(key, { scope, value, updatedAtMs });
  }

  getVmSummary(scope: InventoryCacheScope, loader: () => Promise<VmInventorySummary>, forceRefresh = false) {
    return this.getOrRefresh(this.vmSummaries, buildInventoryCacheKey("vm-summary", scope), scope, VM_SUMMARY_TTL_MS, loader, forceRefresh);
  }

  seedVmSummary(scope: InventoryCacheScope, value: VmInventorySummary, updatedAtMs: number): void {
    const key = buildInventoryCacheKey("vm-summary", scope);
    if (this.vmSummaries.has(key)) return;
    this.vmSummaries.set(key, { scope, value, updatedAtMs });
  }

  getVmList(scope: InventoryCacheScope, loader: () => Promise<PagedResult<VmNode>>, forceRefresh = false) {
    return this.getOrRefresh(this.vmLists, buildInventoryCacheKey("vms", scope), scope, VM_LIST_TTL_MS, loader, forceRefresh);
  }

  seedVmList(scope: InventoryCacheScope, value: PagedResult<VmNode>, updatedAtMs: number): void {
    const key = buildInventoryCacheKey("vms", scope);
    if (this.vmLists.has(key)) return;
    this.vmLists.set(key, { scope, value, updatedAtMs });
  }

  getVmDisks(scope: InventoryCacheScope, loader: () => Promise<VmDisk[]>, forceRefresh = false) {
    return this.getOrRefresh(this.vmDisks, buildInventoryCacheKey("vm-disks", scope), scope, VM_DISK_TTL_MS, loader, forceRefresh);
  }

  getVmSearchIndex(scope: InventoryCacheScope, loader: () => Promise<VmSearchIndexItem[]>, forceRefresh = false) {
    return this.getOrRefresh(
      this.vmSearchIndexes,
      buildInventoryCacheKey("vm-search-index", scope),
      scope,
      VM_SEARCH_INDEX_TTL_MS,
      loader,
      forceRefresh,
    );
  }

  seedVmSearchIndex(scope: InventoryCacheScope, value: VmSearchIndexItem[], updatedAtMs: number): void {
    const key = buildInventoryCacheKey("vm-search-index", scope);
    if (this.vmSearchIndexes.has(key)) return;
    this.vmSearchIndexes.set(key, { scope, value, updatedAtMs });
  }

  findVm(scope: InventoryCacheScope, vmId: string): VmNode | undefined {
    let matched: { vm: VmNode; updatedAtMs: number } | undefined;
    for (const entry of this.vmLists.values()) {
      if (!entry.value || !matchesScope(entry.scope, scope)) continue;
      const vm = entry.value.items.find((item) => item.providerId === vmId || item.id === vmId);
      if (vm && (!matched || entry.updatedAtMs > matched.updatedAtMs)) matched = { vm, updatedAtMs: entry.updatedAtMs };
    }
    return matched?.vm;
  }

  invalidate(scope: Partial<InventoryCacheScope>) {
    invalidateMatching(this.hosts, scope);
    invalidateMatching(this.vmSummaries, scope);
    invalidateMatching(this.vmLists, scope);
    invalidateMatching(this.vmDisks, scope);
    invalidateMatching(this.vmSearchIndexes, scope);
  }

  invalidateVmSearchIndex(scope: Partial<InventoryCacheScope>): void {
    invalidateMatching(this.vmSearchIndexes, scope);
  }

  private async getOrRefresh<T>(
    map: Map<string, InventoryCacheEntry<T>>,
    key: string,
    scope: InventoryCacheScope,
    ttlMs: number,
    loader: () => Promise<T>,
    forceRefresh: boolean,
  ): Promise<InventoryCacheResult<T>> {
    const now = Date.now();
    const existing = map.get(key);
    if (existing?.value && !forceRefresh) {
      const ageMs = now - existing.updatedAtMs;
      if (ageMs < ttlMs) {
        return {
          value: existing.value,
          source: "cache",
          updatedAt: new Date(existing.updatedAtMs).toISOString(),
          refreshing: false,
        };
      }
      if (!existing.pending) {
        const staleValue = existing.value;
        existing.pending = loader()
          .then((value) => {
            existing.value = value;
            existing.updatedAtMs = Date.now();
            return value;
          })
          .catch(() => staleValue)
          .finally(() => {
            existing.pending = undefined;
          });
      }
      return {
        value: existing.value,
        source: "cache",
        updatedAt: new Date(existing.updatedAtMs).toISOString(),
        refreshing: true,
      };
    }

    if (existing?.pending) {
      const value = await existing.pending;
      return {
        value,
        source: "live",
        updatedAt: new Date(existing.updatedAtMs).toISOString(),
        refreshing: false,
      };
    }

    const entry: InventoryCacheEntry<T> = existing ?? {
      scope,
      updatedAtMs: 0,
    };
    map.set(key, entry);
    entry.pending = loader()
      .then((value) => {
        entry.scope = scope;
        entry.value = value;
        entry.updatedAtMs = Date.now();
        return value;
      })
      .finally(() => {
        entry.pending = undefined;
      });
    const value = await entry.pending;
    return {
      value,
      source: "live",
      updatedAt: new Date(entry.updatedAtMs).toISOString(),
      refreshing: false,
    };
  }
}

function invalidateMatching<T>(map: Map<string, InventoryCacheEntry<T>>, scope: Partial<InventoryCacheScope>) {
  for (const [key, entry] of map) {
    if (matchesScope(entry.scope, scope)) {
      map.delete(key);
    }
  }
}

function matchesScope(entry: InventoryCacheScope, scope: Partial<InventoryCacheScope>) {
  if (scope.providerType && entry.providerType !== scope.providerType) return false;
  if (scope.connectionId && entry.connectionId !== scope.connectionId) return false;
  if (scope.host && entry.host !== scope.host) return false;
  if (scope.port && entry.port !== scope.port) return false;
  if (scope.username && entry.username !== scope.username) return false;
  if (scope.poolId && entry.poolId !== scope.poolId) return false;
  if (scope.hostId && entry.hostId !== scope.hostId) return false;
  return true;
}

function buildInventoryCacheKey(kind: string, scope: InventoryCacheScope) {
  return JSON.stringify({
    kind,
    providerType: scope.providerType,
    connectionId: scope.connectionId,
    host: scope.host,
    port: scope.port,
    username: scope.username,
    poolId: scope.poolId,
    hostId: scope.hostId,
    page: scope.page,
    pageSize: scope.pageSize,
    keyword: scope.keyword,
    vmId: scope.vmId,
  });
}
