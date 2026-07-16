import type { HostNode, NetworkInterface, PagedResult, ProviderType, StorageRepository, VmInventorySummary, VmNode } from "./types.js";

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

export class InventoryCache {
  private readonly hosts = new Map<string, InventoryCacheEntry<HostInventorySnapshot>>();
  private readonly vmSummaries = new Map<string, InventoryCacheEntry<VmInventorySummary>>();
  private readonly vmLists = new Map<string, InventoryCacheEntry<PagedResult<VmNode>>>();

  getHosts(scope: InventoryCacheScope, loader: () => Promise<HostInventorySnapshot>, forceRefresh = false) {
    return this.getOrRefresh(this.hosts, buildInventoryCacheKey("hosts", scope), scope, HOST_TTL_MS, loader, forceRefresh);
  }

  getVmSummary(scope: InventoryCacheScope, loader: () => Promise<VmInventorySummary>, forceRefresh = false) {
    return this.getOrRefresh(this.vmSummaries, buildInventoryCacheKey("vm-summary", scope), scope, VM_SUMMARY_TTL_MS, loader, forceRefresh);
  }

  getVmList(scope: InventoryCacheScope, loader: () => Promise<PagedResult<VmNode>>, forceRefresh = false) {
    return this.getOrRefresh(this.vmLists, buildInventoryCacheKey("vms", scope), scope, VM_LIST_TTL_MS, loader, forceRefresh);
  }

  invalidate(scope: Partial<InventoryCacheScope>) {
    invalidateMatching(this.hosts, scope);
    invalidateMatching(this.vmSummaries, scope);
    invalidateMatching(this.vmLists, scope);
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
        existing.pending = loader()
          .then((value) => {
            existing.value = value;
            existing.updatedAtMs = Date.now();
            return value;
          })
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
  });
}
