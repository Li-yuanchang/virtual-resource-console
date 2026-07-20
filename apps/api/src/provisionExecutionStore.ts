import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ProviderType, VmProvisionCreatedVm, VmProvisionRequest } from "./types.js";

export interface ProvisionExecutionContext {
  taskId: string;
  connectionId: string;
  providerType: ProviderType;
  request: VmProvisionRequest;
  created?: VmProvisionCreatedVm[];
  createdAt: string;
  updatedAt: string;
}

interface StoredProvisionExecution {
  taskId: string;
  connectionId: string;
  providerType: ProviderType;
  encryptedPayload: string;
  createdAt: string;
  updatedAt: string;
}

interface ProvisionExecutionStoreFile {
  version: 1;
  executions: StoredProvisionExecution[];
}

/**
 * Stores resumable provisioning inputs encrypted at rest for local/Electron runtimes.
 * This is not used by shared Web mode, where server-side credential persistence is forbidden.
 */
export class ProvisionExecutionStore {
  private readonly storeFile: string;
  private readonly keyFile: string;

  constructor(rootDir = join(homedir(), ".virtual-resource-console")) {
    this.storeFile = join(rootDir, "provision-executions.json");
    this.keyFile = join(rootDir, "key.bin");
  }

  /**
   * Creates or replaces the encrypted execution context for a task.
   *
   * @param context complete resumable task input; must include a persistent connection ID
   * @return the normalized context written to disk
   */
  save(context: ProvisionExecutionContext): ProvisionExecutionContext {
    const store = this.readStore();
    const current = store.executions.find((item) => item.taskId === context.taskId);
    const now = new Date().toISOString();
    const normalized: ProvisionExecutionContext = {
      ...context,
      createdAt: current?.createdAt || context.createdAt || now,
      updatedAt: now,
    };
    const record: StoredProvisionExecution = {
      taskId: normalized.taskId,
      connectionId: normalized.connectionId,
      providerType: normalized.providerType,
      encryptedPayload: this.encrypt(JSON.stringify(normalized)),
      createdAt: normalized.createdAt,
      updatedAt: normalized.updatedAt,
    };
    const index = store.executions.findIndex((item) => item.taskId === normalized.taskId);
    if (index >= 0) store.executions[index] = record;
    else store.executions.push(record);
    this.writeStore(store);
    return normalized;
  }

  /**
   * Reads and decrypts one resumable execution context.
   *
   * @param taskId provisioning task UUID; must not be empty
   * @return decrypted context, or undefined when no context exists or the record is invalid
   */
  get(taskId: string): ProvisionExecutionContext | undefined {
    const record = this.readStore().executions.find((item) => item.taskId === taskId);
    return record ? this.decryptRecord(record) : undefined;
  }

  /**
   * Lists every valid resumable execution context.
   *
   * @return decrypted contexts; corrupt records are omitted and left for manual diagnosis
   */
  list(): ProvisionExecutionContext[] {
    return this.readStore().executions
      .map((record) => this.decryptRecord(record))
      .filter((item): item is ProvisionExecutionContext => Boolean(item));
  }

  /**
   * Deletes a terminal task's encrypted execution context.
   *
   * @param taskId provisioning task UUID to remove
   * @return true when a record was removed
   */
  delete(taskId: string): boolean {
    const store = this.readStore();
    const before = store.executions.length;
    store.executions = store.executions.filter((item) => item.taskId !== taskId);
    if (store.executions.length !== before) this.writeStore(store);
    return store.executions.length !== before;
  }

  private decryptRecord(record: StoredProvisionExecution): ProvisionExecutionContext | undefined {
    try {
      const parsed = JSON.parse(this.decrypt(record.encryptedPayload)) as ProvisionExecutionContext;
      if (!parsed.taskId || !parsed.connectionId || !parsed.request?.planItems?.length) return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }

  private readStore(): ProvisionExecutionStoreFile {
    this.ensureStoreDir();
    if (!existsSync(this.storeFile)) return { version: 1, executions: [] };
    try {
      const parsed = JSON.parse(readFileSync(this.storeFile, "utf8")) as ProvisionExecutionStoreFile;
      return { version: 1, executions: Array.isArray(parsed.executions) ? parsed.executions : [] };
    } catch {
      return { version: 1, executions: [] };
    }
  }

  private writeStore(store: ProvisionExecutionStoreFile): void {
    this.ensureStoreDir();
    writeFileSync(this.storeFile, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  }

  private ensureStoreDir(): void {
    mkdirSync(dirname(this.storeFile), { recursive: true, mode: 0o700 });
  }

  private getKey(): Buffer {
    this.ensureStoreDir();
    if (!existsSync(this.keyFile)) writeFileSync(this.keyFile, randomBytes(32), { mode: 0o600 });
    const key = readFileSync(this.keyFile);
    if (key.length !== 32) throw new Error("任务恢复密钥文件无效，请检查 ~/.virtual-resource-console/key.bin");
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
    if (!ivText || !tagText || !encryptedText) throw new Error("任务恢复密文格式无效");
    const decipher = createDecipheriv("aes-256-gcm", this.getKey(), Buffer.from(ivText, "base64"));
    decipher.setAuthTag(Buffer.from(tagText, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(encryptedText, "base64")), decipher.final()]).toString("utf8");
  }
}

export const provisionExecutionStore = new ProvisionExecutionStore();
