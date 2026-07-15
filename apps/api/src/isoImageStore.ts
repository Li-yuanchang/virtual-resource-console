import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { IsoImage, ProviderType } from "./types.js";

const storeDir = join(homedir(), ".virtual-resource-console");
const storeFile = join(storeDir, "iso-images.json");

interface IsoImageCacheEntry {
  key: string;
  providerType: ProviderType;
  connectionId?: string;
  hostId?: string;
  images: IsoImage[];
  updatedAt: string;
}

interface IsoImageStoreFile {
  version: 1;
  entries: IsoImageCacheEntry[];
}

interface SaveIsoImageCacheOptions {
  merge?: boolean;
}

export function buildIsoImageCacheKey(input: { providerType: ProviderType; connectionId?: string; host: string; port: number; username: string; hostId?: string }): string {
  return [input.providerType, input.connectionId || `${input.host}:${input.port}:${input.username}`, input.hostId || "all"].join("::");
}

export function getIsoImageCache(key: string): IsoImageCacheEntry | undefined {
  return readStore().entries.find((item) => item.key === key);
}

export function saveIsoImageCache(input: Omit<IsoImageCacheEntry, "updatedAt">, options: SaveIsoImageCacheOptions = {}): IsoImageCacheEntry {
  const store = readStore();
  const index = store.entries.findIndex((item) => item.key === input.key);
  const current = index >= 0 ? normalizeEntry(store.entries[index]) : undefined;
  const now = new Date().toISOString();
  const entry: IsoImageCacheEntry = {
    ...input,
    images: options.merge && current ? mergeImages(current.images, input.images, now) : normalizeImages(input.images, now),
    updatedAt: now,
  };
  if (index >= 0) {
    store.entries[index] = entry;
  } else {
    store.entries.push(entry);
  }
  writeStore(store);
  return entry;
}

function mergeImages(cachedImages: IsoImage[], liveImages: IsoImage[], now: string): IsoImage[] {
  void cachedImages;
  // ISO 列表用于创建 VM 时选择安装源，刷新后已经不存在的镜像不应继续出现在下拉框。
  return normalizeImages(liveImages.map((image) => tagImageCacheState(image, now, true)), now);
}

function tagImageCacheState(image: IsoImage, now: string, seen: boolean): IsoImage {
  const previousMissingSince = typeof image.metadata?.missingSince === "string" ? image.metadata.missingSince : undefined;
  return {
    ...image,
    metadata: {
      ...image.metadata,
      firstCachedAt: typeof image.metadata?.firstCachedAt === "string" ? image.metadata.firstCachedAt : now,
      lastSeenAt: seen ? now : typeof image.metadata?.lastSeenAt === "string" ? image.metadata.lastSeenAt : undefined,
      missingSince: seen ? undefined : previousMissingSince || now,
      cacheState: seen ? "seen" : "notSeenInLastRefresh",
    },
  };
}

function normalizeImages(images: IsoImage[], now = new Date().toISOString()): IsoImage[] {
  const byId = new Map<string, IsoImage>();
  for (const image of images) {
    if (isVrcGeneratedIso(image)) continue;
    const key = getImageCacheKey(image);
    const id = image.id || image.providerId || key;
    byId.set(key, {
      ...image,
      id,
      providerId: image.providerId || key,
      name: image.name.trim(),
      storageRepository: image.storageRepository.trim(),
      path: image.path?.trim() || undefined,
      metadata: {
        ...image.metadata,
        firstCachedAt: typeof image.metadata?.firstCachedAt === "string" ? image.metadata.firstCachedAt : now,
        lastSeenAt: typeof image.metadata?.lastSeenAt === "string" ? image.metadata.lastSeenAt : now,
      },
    });
  }
  return Array.from(byId.values()).sort((left, right) =>
    `${left.storageRepository} ${left.name}`.localeCompare(`${right.storageRepository} ${right.name}`, "zh-CN", {
      numeric: true,
      sensitivity: "base",
    }),
  );
}

function isVrcGeneratedIso(image: IsoImage): boolean {
  const name = image.name?.trim() || "";
  const fileName = image.path?.trim().split("/").pop() || "";
  return name.startsWith("vrc-") || fileName.startsWith("vrc-");
}

function getImageCacheKey(image: IsoImage): string {
  return image.providerId || image.id || `${image.storageRepository}:${image.path || image.name}`;
}

function readStore(): IsoImageStoreFile {
  ensureStoreDir();
  if (!existsSync(storeFile)) {
    return { version: 1, entries: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(storeFile, "utf8")) as IsoImageStoreFile;
    return {
      version: 1,
      entries: Array.isArray(parsed.entries) ? parsed.entries.map(normalizeEntry) : [],
    };
  } catch {
    return { version: 1, entries: [] };
  }
}

function normalizeEntry(entry: IsoImageCacheEntry): IsoImageCacheEntry {
  return {
    key: entry.key,
    providerType: entry.providerType,
    connectionId: entry.connectionId,
    hostId: entry.hostId,
    images: normalizeImages(entry.images ?? []),
    updatedAt: entry.updatedAt || new Date(0).toISOString(),
  };
}

function writeStore(store: IsoImageStoreFile): void {
  ensureStoreDir();
  writeFileSync(storeFile, `${JSON.stringify({ version: 1, entries: store.entries.map(normalizeEntry) }, null, 2)}\n`, { mode: 0o600 });
}

function ensureStoreDir(): void {
  mkdirSync(dirname(storeFile), { recursive: true, mode: 0o700 });
}
