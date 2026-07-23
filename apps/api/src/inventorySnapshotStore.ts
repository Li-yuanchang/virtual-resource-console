import type { HostInventorySnapshot, InventoryCacheScope } from "./inventoryCache.js";
import { readLocalJsonConfig, resolveVrcConfigPath, writeLocalJsonConfig } from "./localConfigFile.js";
import type { PagedResult, VmInventorySummary, VmNode } from "./types.js";

interface PersistedSnapshot<T> {
  updatedAt: string;
  value: T;
}

interface PersistedInventorySnapshotFile {
  version: 1;
  hosts: Record<string, PersistedSnapshot<HostInventorySnapshot>>;
  vmSummaries: Record<string, PersistedSnapshot<VmInventorySummary>>;
  vmLists: Record<string, PersistedSnapshot<PagedResult<VmNode>>>;
}

export interface InventorySnapshot<T> {
  value: T;
  updatedAtMs: number;
}

/**
 * Stores read-only inventory snapshots outside the program directory for fast cold-start rendering.
 * The file contains inventory data only and never stores connection passwords or request credentials.
 */
export class InventorySnapshotStore {
  private readonly filePath: string;
  private file: PersistedInventorySnapshotFile = emptySnapshotFile();
  private loaded = false;

  constructor(filePath = resolveVrcConfigPath("inventory-snapshots.json", "VRC_INVENTORY_SNAPSHOT_FILE")) {
    this.filePath = filePath;
  }

  getHosts(scope: InventoryCacheScope): InventorySnapshot<HostInventorySnapshot> | undefined {
    return toSnapshot(this.read().hosts[buildSnapshotKey("hosts", scope)]);
  }

  saveHosts(scope: InventoryCacheScope, value: HostInventorySnapshot, updatedAtMs = Date.now()): void {
    this.read().hosts[buildSnapshotKey("hosts", scope)] = persistedSnapshot(value, updatedAtMs);
    this.flush();
  }

  getVmSummary(scope: InventoryCacheScope): InventorySnapshot<VmInventorySummary> | undefined {
    return toSnapshot(this.read().vmSummaries[buildSnapshotKey("vm-summary", scope)]);
  }

  saveVmSummary(scope: InventoryCacheScope, value: VmInventorySummary, updatedAtMs = Date.now()): void {
    this.read().vmSummaries[buildSnapshotKey("vm-summary", scope)] = persistedSnapshot(value, updatedAtMs);
    this.flush();
  }

  getVmList(scope: InventoryCacheScope): InventorySnapshot<PagedResult<VmNode>> | undefined {
    return toSnapshot(this.read().vmLists[buildSnapshotKey("vms", scope)]);
  }

  saveVmList(scope: InventoryCacheScope, value: PagedResult<VmNode>, updatedAtMs = Date.now()): void {
    this.read().vmLists[buildSnapshotKey("vms", scope)] = persistedSnapshot(value, updatedAtMs);
    this.flush();
  }

  private read(): PersistedInventorySnapshotFile {
    if (this.loaded) return this.file;
    this.loaded = true;
    this.file = readLocalJsonConfig({
      filePath: this.filePath,
      label: "资源清单快照",
      onMissing: emptySnapshotFile,
      onInvalid: emptySnapshotFile,
      normalize: normalizeSnapshotFile,
    });
    return this.file;
  }

  private flush(): void {
    writeLocalJsonConfig(this.filePath, this.file);
  }
}

function buildSnapshotKey(kind: "hosts" | "vm-summary" | "vms", scope: InventoryCacheScope): string {
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

function persistedSnapshot<T>(value: T, updatedAtMs: number): PersistedSnapshot<T> {
  return { updatedAt: new Date(updatedAtMs).toISOString(), value };
}

function toSnapshot<T>(snapshot: PersistedSnapshot<T> | undefined): InventorySnapshot<T> | undefined {
  if (!snapshot) return undefined;
  const updatedAtMs = Date.parse(snapshot.updatedAt);
  if (!Number.isFinite(updatedAtMs)) return undefined;
  return { value: snapshot.value, updatedAtMs };
}

function emptySnapshotFile(): PersistedInventorySnapshotFile {
  return { version: 1, hosts: {}, vmSummaries: {}, vmLists: {} };
}

function normalizeSnapshotFile(input: unknown): PersistedInventorySnapshotFile {
  if (!input || typeof input !== "object") return emptySnapshotFile();
  const candidate = input as Partial<PersistedInventorySnapshotFile>;
  if (candidate.version !== 1) return emptySnapshotFile();
  return {
    version: 1,
    hosts: normalizeSnapshotRecord(candidate.hosts),
    vmSummaries: normalizeSnapshotRecord(candidate.vmSummaries),
    vmLists: normalizeSnapshotRecord(candidate.vmLists),
  };
}

function normalizeSnapshotRecord<T>(input: unknown): Record<string, PersistedSnapshot<T>> {
  if (!input || typeof input !== "object") return {};
  return Object.fromEntries(
    Object.entries(input).filter((entry): entry is [string, PersistedSnapshot<T>] => {
      const value = entry[1];
      return !!value && typeof value === "object" && typeof (value as PersistedSnapshot<T>).updatedAt === "string" && "value" in value;
    }),
  );
}
