import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getVrcDataDir } from "./appPaths.js";
import { readLocalJsonConfig, writeLocalJsonConfig } from "./localConfigFile.js";
import type { VmSystemCredentials } from "./types.js";

interface StoredVmSystemCredential {
  connectionId: string;
  vmId: string;
  encryptedPayload: string;
  updatedAt: string;
}

interface VmSystemCredentialStoreFile {
  version: 1;
  credentials: StoredVmSystemCredential[];
}

export class VmSystemCredentialStore {
  private readonly storeFile: string;
  private readonly keyFile: string;

  constructor(rootDir = getVrcDataDir()) {
    this.storeFile = join(rootDir, "vm-system-credentials.json");
    this.keyFile = join(rootDir, "key.bin");
  }

  save(connectionId: string, vmId: string, credentials: VmSystemCredentials): void {
    const store = this.readStore();
    const record: StoredVmSystemCredential = {
      connectionId,
      vmId,
      encryptedPayload: this.encrypt(JSON.stringify(credentials)),
      updatedAt: new Date().toISOString(),
    };
    const index = store.credentials.findIndex((item) => item.connectionId === connectionId && item.vmId === vmId);
    if (index >= 0) store.credentials[index] = record;
    else store.credentials.push(record);
    this.writeStore(store);
  }

  get(connectionId: string, vmId: string): VmSystemCredentials | undefined {
    const record = this.readStore().credentials.find((item) => item.connectionId === connectionId && item.vmId === vmId);
    if (!record) return undefined;
    try {
      const credentials = JSON.parse(this.decrypt(record.encryptedPayload)) as Partial<VmSystemCredentials>;
      if (typeof credentials.username !== "string" || !credentials.username || typeof credentials.password !== "string" || !credentials.password) {
        return undefined;
      }
      const jump = normalizeJumpCredentials(credentials.jump);
      return {
        username: credentials.username,
        password: credentials.password,
        ...(jump ? { jump } : {}),
      };
    } catch {
      return undefined;
    }
  }

  delete(connectionId: string, vmId: string): boolean {
    const store = this.readStore();
    const before = store.credentials.length;
    store.credentials = store.credentials.filter((item) => item.connectionId !== connectionId || item.vmId !== vmId);
    if (store.credentials.length !== before) this.writeStore(store);
    return store.credentials.length !== before;
  }

  private readStore(): VmSystemCredentialStoreFile {
    return readLocalJsonConfig({
      filePath: this.storeFile,
      label: "虚拟机系统凭据配置",
      normalize: (input) => {
        const parsed = input as Partial<VmSystemCredentialStoreFile>;
        return { version: 1, credentials: Array.isArray(parsed.credentials) ? parsed.credentials : [] };
      },
      onMissing: () => ({ version: 1, credentials: [] }),
      onInvalid: () => ({ version: 1, credentials: [] }),
    });
  }

  private writeStore(store: VmSystemCredentialStoreFile): void {
    writeLocalJsonConfig(this.storeFile, store);
  }

  private ensureStoreDir(): void {
    mkdirSync(dirname(this.storeFile), { recursive: true, mode: 0o700 });
  }

  private getKey(): Buffer {
    this.ensureStoreDir();
    if (!existsSync(this.keyFile)) writeFileSync(this.keyFile, randomBytes(32), { mode: 0o600 });
    const key = readFileSync(this.keyFile);
    if (key.length !== 32) throw new Error("系统凭据加密密钥无效，请检查本机 VRC 数据目录中的 key.bin");
    return key;
  }

  private encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.getKey(), iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return `${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${encrypted.toString("base64")}`;
  }

  private decrypt(value: string): string {
    const [ivText, tagText, encryptedText] = value.split(".");
    if (!ivText || !tagText || !encryptedText) throw new Error("系统凭据密文格式无效");
    const decipher = createDecipheriv("aes-256-gcm", this.getKey(), Buffer.from(ivText, "base64"));
    decipher.setAuthTag(Buffer.from(tagText, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(encryptedText, "base64")), decipher.final()]).toString("utf8");
  }
}

function normalizeJumpCredentials(value: VmSystemCredentials["jump"]): VmSystemCredentials["jump"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (typeof value.host !== "string" || !value.host.trim()) return undefined;
  if (!Number.isInteger(value.port) || value.port <= 0 || value.port > 65535) return undefined;
  if (typeof value.username !== "string" || !value.username.trim()) return undefined;
  if (typeof value.password !== "string" || !value.password) return undefined;
  return {
    host: value.host.trim(),
    port: value.port,
    username: value.username.trim(),
    password: value.password,
  };
}

export const vmSystemCredentialStore = new VmSystemCredentialStore();
