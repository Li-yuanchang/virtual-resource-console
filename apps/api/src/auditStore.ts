import { randomUUID } from "node:crypto";
import { readLocalJsonConfig, resolveVrcConfigPath, writeLocalJsonConfig } from "./localConfigFile.js";

/**
 * 操作审计持久化存储。
 *
 * 职责：把会改变状态或影响安全的操作（VM 开关/删除/改名/扩容、连接增删改、偏好与 IP 池配置、创建虚拟机、
 * 介质清理等）以追加方式写入本机 JSON 文件，供设置页"操作记录"面板查询；重启进程后记录仍然保留。
 *
 * 安全边界：审计记录只保存操作摘要（action、目标、请求摘要、命令、结果状态），
 * 请求摘要必须经 {@link redactAuditRequest} 脱敏后再写入，任何密码、密钥、token、系统凭据都不得落盘。
 * 写入失败只记录告警，不影响主流程。
 */

export type AuditStatus = "info" | "pending" | "success" | "warning" | "error";

export interface AuditRecord {
  id: string;
  time: string;
  title: string;
  action?: string;
  providerType?: string;
  connectionId?: string;
  connectionName?: string;
  target?: string;
  request?: string;
  command?: string;
  detail?: string;
  status: AuditStatus;
}

export interface AuditRecordInput {
  title: string;
  action?: string;
  providerType?: string;
  connectionId?: string;
  connectionName?: string;
  target?: string;
  request?: string;
  command?: string;
  detail?: string;
  status?: AuditStatus;
}

export interface AuditListOptions {
  limit?: number;
  status?: AuditStatus | "all";
  keyword?: string;
}

interface AuditStoreFile {
  version: 1;
  entries: AuditRecord[];
}

/** 审计文件最多保留的条数，超过后丢弃最旧的记录，避免文件无限增长。 */
const MAX_AUDIT_ENTRIES = 2000;

/** 命中即脱敏的敏感字段名；递归遍历，覆盖 planItems[*].rootPassword、leases[*].rootPassword 等嵌套结构。 */
const SENSITIVE_AUDIT_KEYS = new Set(["password", "rootPassword", "token", "csrf", "systemCredentials", "guestStorage"]);

export class AuditStore {
  private readonly filePath: string;
  private file: AuditStoreFile = { version: 1, entries: [] };
  private loaded = false;

  constructor(filePath = resolveVrcConfigPath("audit-log.json", "VRC_AUDIT_LOG_FILE")) {
    this.filePath = filePath;
  }

  /** 追加一条审计记录并持久化；返回写入后的记录。 */
  record(input: AuditRecordInput): AuditRecord {
    const entry: AuditRecord = {
      id: randomUUID(),
      time: new Date().toISOString(),
      title: input.title,
      status: input.status ?? "info",
      ...(input.action ? { action: input.action } : {}),
      ...(input.providerType ? { providerType: input.providerType } : {}),
      ...(input.connectionId ? { connectionId: input.connectionId } : {}),
      ...(input.connectionName ? { connectionName: input.connectionName } : {}),
      ...(input.target ? { target: input.target } : {}),
      ...(input.request ? { request: input.request } : {}),
      ...(input.command ? { command: input.command } : {}),
      ...(input.detail ? { detail: input.detail } : {}),
    };
    const file = this.read();
    file.entries.push(entry);
    if (file.entries.length > MAX_AUDIT_ENTRIES) {
      file.entries = file.entries.slice(file.entries.length - MAX_AUDIT_ENTRIES);
    }
    this.flush();
    return entry;
  }

  /** 按时间倒序返回审计记录（最新在前），支持 limit / status / keyword 过滤。 */
  list(options: AuditListOptions = {}): AuditRecord[] {
    let entries = this.read().entries;
    if (options.status && options.status !== "all") {
      entries = entries.filter((entry) => entry.status === options.status);
    }
    const keyword = options.keyword?.trim().toLowerCase();
    if (keyword) {
      entries = entries.filter((entry) =>
        [entry.title, entry.target, entry.detail, entry.request, entry.command, entry.action, entry.connectionName]
          .some((value) => !!value && value.toLowerCase().includes(keyword)),
      );
    }
    const limit = options.limit && options.limit > 0 ? Math.min(options.limit, MAX_AUDIT_ENTRIES) : 200;
    return [...entries].reverse().slice(0, limit);
  }

  /** 当前审计文件总条数。 */
  count(): number {
    return this.read().entries.length;
  }

  private read(): AuditStoreFile {
    if (this.loaded) return this.file;
    this.loaded = true;
    this.file = readLocalJsonConfig({
      filePath: this.filePath,
      label: "操作审计",
      onMissing: emptyAuditFile,
      onInvalid: emptyAuditFile,
      normalize: normalizeAuditFile,
    });
    return this.file;
  }

  private flush(): void {
    writeLocalJsonConfig(this.filePath, this.file);
  }
}

export const auditStore = new AuditStore();

/**
 * 递归脱敏请求摘要：删除/替换敏感字段值，避免密码、密钥、token 落入审计文件。
 *
 * @param payload 原始请求对象，允许为空。
 * @return 脱敏后的对象；非对象输入原样返回。
 */
export function redactAuditRequest(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  if (Array.isArray(payload)) return payload.map(redactAuditRequest);
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (SENSITIVE_AUDIT_KEYS.has(key)) {
      output[key] = "***";
      continue;
    }
    if (value && typeof value === "object") {
      output[key] = redactAuditRequest(value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

function emptyAuditFile(): AuditStoreFile {
  return { version: 1, entries: [] };
}

function normalizeAuditFile(input: unknown): AuditStoreFile {
  if (!input || typeof input !== "object") return emptyAuditFile();
  const candidate = input as Partial<AuditStoreFile>;
  if (candidate.version !== 1) return emptyAuditFile();
  return {
    version: 1,
    entries: Array.isArray(candidate.entries)
      ? candidate.entries.filter((entry): entry is AuditRecord => {
          return (
            !!entry &&
            typeof entry === "object" &&
            typeof (entry as AuditRecord).id === "string" &&
            typeof (entry as AuditRecord).time === "string" &&
            typeof (entry as AuditRecord).title === "string" &&
            typeof (entry as AuditRecord).status === "string"
          );
        })
      : [],
  };
}
