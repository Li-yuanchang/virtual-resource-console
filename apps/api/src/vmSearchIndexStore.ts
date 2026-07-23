import type { InventoryCacheScope } from "./inventoryCache.js";
import { readLocalJsonConfig, resolveVrcConfigPath, writeLocalJsonConfig } from "./localConfigFile.js";
import type { VmSearchIndexItem } from "./types.js";

interface PersistedVmSearchIndexEntry {
  providerType: InventoryCacheScope["providerType"];
  connectionId?: string;
  host: string;
  port: number;
  username: string;
  poolId?: string;
  updatedAt: string;
  items: VmSearchIndexItem[];
}

interface PersistedVmSearchIndexFile {
  version: 1;
  entries: Record<string, PersistedVmSearchIndexEntry>;
}

export interface VmSearchIndexSnapshot {
  items: VmSearchIndexItem[];
  updatedAtMs: number;
}

/**
 * Persists the read-only VM search index so a process restart can serve a stale snapshot immediately.
 * Passwords and VM detail fields are intentionally excluded; the snapshot is only a search hint.
 */
export class VmSearchIndexStore {
  private readonly filePath: string;
  private entries = new Map<string, PersistedVmSearchIndexEntry>();
  private loaded = false;

  constructor(filePath = resolveVrcConfigPath("vm-search-index.json", "VRC_VM_SEARCH_INDEX_FILE")) {
    this.filePath = filePath;
  }

  get(scope: InventoryCacheScope): VmSearchIndexSnapshot | undefined {
    this.ensureLoaded();
    const entry = this.entries.get(buildVmSearchIndexKey(scope));
    if (!entry) return undefined;
    const updatedAtMs = Date.parse(entry.updatedAt);
    if (!Number.isFinite(updatedAtMs)) return undefined;
    return {
      items: entry.items,
      updatedAtMs,
    };
  }

  save(scope: InventoryCacheScope, items: VmSearchIndexItem[], updatedAtMs = Date.now()): void {
    this.ensureLoaded();
    this.entries.set(buildVmSearchIndexKey(scope), {
      providerType: scope.providerType,
      connectionId: scope.connectionId,
      host: scope.host,
      port: scope.port,
      username: scope.username,
      poolId: scope.poolId,
      updatedAt: new Date(updatedAtMs).toISOString(),
      items: items.map(normalizeVmSearchIndexItem).filter((item) => item.providerId),
    });
    writeLocalJsonConfig(this.filePath, {
      version: 1,
      entries: Object.fromEntries(this.entries),
    } satisfies PersistedVmSearchIndexFile);
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    const file = readLocalJsonConfig<PersistedVmSearchIndexFile>({
      filePath: this.filePath,
      label: "VM 搜索索引",
      onMissing: () => ({ version: 1, entries: {} }),
      onInvalid: () => ({ version: 1, entries: {} }),
      normalize: normalizeVmSearchIndexFile,
    });
    this.entries = new Map(Object.entries(file.entries));
  }
}

function buildVmSearchIndexKey(scope: InventoryCacheScope): string {
  return JSON.stringify({
    providerType: scope.providerType,
    connectionId: scope.connectionId,
    host: scope.host,
    port: scope.port,
    username: scope.username,
    poolId: scope.poolId,
  });
}

function normalizeVmSearchIndexFile(input: unknown): PersistedVmSearchIndexFile {
  if (!input || typeof input !== "object") return { version: 1, entries: {} };
  const candidate = input as Partial<PersistedVmSearchIndexFile>;
  if (candidate.version !== 1 || !candidate.entries || typeof candidate.entries !== "object") {
    return { version: 1, entries: {} };
  }
  const entries = Object.fromEntries(
    Object.entries(candidate.entries)
      .map(([key, value]) => [key, normalizeVmSearchIndexEntry(value)] as const)
      .filter(([, value]) => value !== undefined),
  ) as Record<string, PersistedVmSearchIndexEntry>;
  return { version: 1, entries };
}

function normalizeVmSearchIndexEntry(input: unknown): PersistedVmSearchIndexEntry | undefined {
  if (!input || typeof input !== "object") return undefined;
  const candidate = input as Partial<PersistedVmSearchIndexEntry>;
  if (
    typeof candidate.providerType !== "string" ||
    typeof candidate.host !== "string" ||
    typeof candidate.port !== "number" ||
    typeof candidate.username !== "string" ||
    typeof candidate.updatedAt !== "string" ||
    !Array.isArray(candidate.items)
  ) {
    return undefined;
  }
  const items = candidate.items.map(normalizeVmSearchIndexItem).filter((item) => item.providerId);
  return {
    providerType: candidate.providerType as InventoryCacheScope["providerType"],
    connectionId: typeof candidate.connectionId === "string" ? candidate.connectionId : undefined,
    host: candidate.host,
    port: candidate.port,
    username: candidate.username,
    poolId: typeof candidate.poolId === "string" ? candidate.poolId : undefined,
    updatedAt: candidate.updatedAt,
    items,
  };
}

function normalizeVmSearchIndexItem(input: unknown): VmSearchIndexItem {
  const candidate = input && typeof input === "object" ? (input as Partial<VmSearchIndexItem>) : {};
  return {
    providerId: typeof candidate.providerId === "string" ? candidate.providerId : "",
    hostId: typeof candidate.hostId === "string" ? candidate.hostId : undefined,
    name: typeof candidate.name === "string" ? candidate.name : "",
    ipAddresses: Array.isArray(candidate.ipAddresses)
      ? candidate.ipAddresses.filter((item): item is string => typeof item === "string")
      : [],
  };
}
