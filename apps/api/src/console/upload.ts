import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Client } from "ssh2";
import type { ConnectConfig, SFTPWrapper } from "ssh2";
import { resolveStoredConnection } from "../connectionStore.js";
import { getRuntimePolicy } from "../runtimePolicy.js";
import type { XenConnectionInput } from "../types.js";

const uploadRoot = "/tmp/vrc-uploads";
const uploadReadyTimeoutMs = 15_000;
const uploadOperationTimeoutMs = 20_000;
const minFileUploadTimeoutMs = 60_000;
const fileUploadTimeoutPerMiBMs = 2_500;
const maxUploadFiles = 8;
const uploadProgressRetentionMs = 5 * 60_000;

interface ConsoleUploadRouteOptions {
  persistentConnectionsEnabled: boolean;
}

interface ConsoleUploadFieldMap {
  uploadId?: string;
  connectionId?: string;
  providerType?: string;
  vmIp?: string;
  vmName?: string;
  username?: string;
  password?: string;
  remoteDir?: string;
}

interface LocalUploadFile {
  originalName: string;
  safeName: string;
  localPath: string;
  size: number;
}

interface ConsoleUploadResult {
  message: string;
  uploaded: Array<{
    name: string;
    remotePath: string;
    size: number;
  }>;
}

type ConsoleUploadProgressStage = "queued" | "receiving" | "connecting" | "preparing" | "uploading" | "completed" | "failed";

interface ConsoleUploadProgressEvent {
  uploadId: string;
  seq: number;
  stage: ConsoleUploadProgressStage;
  message: string;
  percent?: number;
  bytesTransferred?: number;
  totalBytes?: number;
  speedBytesPerSecond?: number;
  fileName?: string;
  remotePath?: string;
  createdAt: string;
}

interface ConsoleUploadProgressState {
  uploadId: string;
  seq: number;
  listeners: Set<(event: ConsoleUploadProgressEvent) => void>;
  lastEvent?: ConsoleUploadProgressEvent;
  expireTimer?: NodeJS.Timeout;
  startedAt: number;
  lastBytesTransferred: number;
  lastProgressAt: number;
  lastPublishedAt: number;
}

type UploadProgressReporter = (event: Omit<ConsoleUploadProgressEvent, "uploadId" | "seq" | "createdAt">) => void;

const uploadProgressStates = new Map<string, ConsoleUploadProgressState>();

export async function registerConsoleUploadRoutes(server: FastifyInstance, options: ConsoleUploadRouteOptions): Promise<void> {
  server.get("/api/console/upload/:uploadId/events", (request, reply) => {
    const params = request.params as { uploadId?: string };
    const uploadId = normalizeUploadId(params.uploadId);
    if (!uploadId) {
      return reply.status(400).send({ message: "上传 ID 不正确" });
    }

    const state = getUploadProgressState(uploadId);
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const sendProgress = (event: ConsoleUploadProgressEvent) => {
      if (reply.raw.writableEnded || reply.raw.destroyed) return;
      reply.raw.write(`id: ${event.seq}\n`);
      reply.raw.write("event: progress\n");
      reply.raw.write(`data: ${JSON.stringify({ progress: event })}\n\n`);
    };
    state.listeners.add(sendProgress);
    if (state.lastEvent) {
      sendProgress(state.lastEvent);
    } else {
      publishUploadProgress(uploadId, { stage: "queued", message: "等待浏览器开始上传" });
    }
    const heartbeat = setInterval(() => {
      if (reply.raw.writableEnded || reply.raw.destroyed) return;
      reply.raw.write(": keep-alive\n\n");
    }, 15000);
    const cleanup = () => {
      clearInterval(heartbeat);
      state.listeners.delete(sendProgress);
      scheduleUploadProgressCleanup(uploadId);
    };
    request.raw.once("close", cleanup);
    return undefined;
  });

  server.post("/api/console/upload", async (request, reply) => {
    const { fields, files, tempDir } = await readMultipartUpload(request);
    const uploadId = normalizeUploadId(fields.uploadId) || randomUUID();
    const reportProgress = createUploadProgressReporter(uploadId);
    try {
      const vmIp = normalizeVmIp(fields.vmIp);
      if (!vmIp) {
        reportProgress({ stage: "failed", message: "缺少 VM IP，无法上传到虚拟机" });
        return reply.code(400).send({ message: "缺少 VM IP，无法上传到虚拟机" });
      }
      if (!files.length) {
        reportProgress({ stage: "failed", message: "没有收到可上传文件" });
        return reply.code(400).send({ message: "没有收到可上传文件" });
      }

      const username = fields.username?.trim() || "root";
      const password = fields.password?.trim() || deriveRootPassword(vmIp);
      if (!password) {
        reportProgress({ stage: "failed", message: "缺少 VM 登录密码，当前只支持按 IP 规则自动推导的 root 账号" });
        return reply.code(400).send({ message: "缺少 VM 登录密码，当前只支持按 IP 规则自动推导的 root 账号" });
      }

      const remoteDir = sanitizeRemoteDir(fields.remoteDir || uploadRoot);
      let uploaded: ConsoleUploadResult["uploaded"];
      try {
        reportProgress({
          stage: "connecting",
          message: `正在连接 VM ${vmIp} 的 SSH/SFTP`,
          percent: 0,
          totalBytes: files.reduce((total, file) => total + file.size, 0),
        });
        uploaded = await uploadFilesToGuest(resolveUploadTransport(fields, vmIp, options), {
          username,
          password,
          remoteDir,
          files,
          progress: reportProgress,
        });
      } catch (error) {
        reportProgress({ stage: "failed", message: formatUploadError(error, vmIp) });
        return reply.code(resolveUploadErrorStatus(error)).send({ message: formatUploadError(error, vmIp) });
      }
      const result: ConsoleUploadResult = {
        message: `已上传 ${uploaded.length} 个文件到 ${remoteDir}`,
        uploaded,
      };
      reportProgress({
        stage: "completed",
        message: result.message,
        percent: 100,
        bytesTransferred: files.reduce((total, file) => total + file.size, 0),
        totalBytes: files.reduce((total, file) => total + file.size, 0),
      });
      return result;
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
}

async function readMultipartUpload(request: FastifyRequest): Promise<{
  fields: ConsoleUploadFieldMap;
  files: LocalUploadFile[];
  tempDir: string;
}> {
  const tempDir = await createUploadTempDir();
  const fields: ConsoleUploadFieldMap = {};
  const files: LocalUploadFile[] = [];

  for await (const part of request.parts()) {
    if (part.type === "field") {
      const fieldName = part.fieldname as keyof ConsoleUploadFieldMap;
      if (["uploadId", "connectionId", "providerType", "vmIp", "vmName", "username", "password", "remoteDir"].includes(fieldName)) {
        fields[fieldName] = String(part.value ?? "");
      }
      continue;
    }

    if (part.type !== "file" || part.fieldname !== "files") {
      part.file.resume();
      continue;
    }
    if (files.length >= maxUploadFiles) {
      part.file.resume();
      continue;
    }
    const safeName = sanitizeFileName(part.filename || "upload.bin");
    const localPath = join(tempDir, `${files.length + 1}-${safeName}`);
    let size = 0;
    part.file.on("data", (chunk: Buffer) => {
      size += chunk.length;
    });
    await pipeline(part.file, createWriteStream(localPath, { mode: 0o600 }));
    files.push({
      originalName: part.filename || safeName,
      safeName,
      localPath,
      size,
    });
  }

  return { fields, files, tempDir };
}

async function createUploadTempDir() {
  const tempDir = join(tmpdir(), `vrc-console-upload-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(tempDir, { recursive: true, mode: 0o700 });
  return tempDir;
}

type UploadTransport =
  | {
      type: "direct";
      host: string;
    }
  | {
      type: "jump";
      host: string;
      jumpConnection: XenConnectionInput;
    };

interface UploadGuestInput {
  username: string;
  password: string;
  remoteDir: string;
  files: LocalUploadFile[];
  progress?: UploadProgressReporter;
}

function resolveUploadTransport(fields: ConsoleUploadFieldMap, vmIp: string, options: ConsoleUploadRouteOptions): UploadTransport {
  if (fields.connectionId && fields.providerType === "xenserver") {
    if (!options.persistentConnectionsEnabled) {
      throw new Error("共享 Web 模式没有服务器保存连接，文件上传不能通过保存连接跳板。请使用 VM 可直连 IP，或在桌面/本地模式使用连接跳板。");
    }
    return {
      type: "jump",
      host: vmIp,
      jumpConnection: resolveStoredConnection(fields.connectionId),
    };
  }
  return {
    type: "direct",
    host: vmIp,
  };
}

async function uploadFilesToGuest(transport: UploadTransport, input: UploadGuestInput): Promise<ConsoleUploadResult["uploaded"]> {
  if (transport.type === "jump") {
    return uploadFilesToGuestByJumpHost(transport, input);
  }
  return withGuestSftp(
    {
      host: transport.host,
      port: 22,
      username: input.username,
      password: input.password,
      readyTimeout: uploadReadyTimeoutMs,
      algorithms: guestSshAlgorithms(),
    },
    async (client, sftp) => {
      input.progress?.({ stage: "preparing", message: `正在确认远端目录 ${input.remoteDir}` });
      await ensureRemoteDir(sftp, input.remoteDir);
      const uploaded: ConsoleUploadResult["uploaded"] = [];
      for (const file of input.files) {
        const remotePath = `${input.remoteDir}/${file.safeName}`;
        await fastPut(sftp, file, remotePath, input.progress);
        uploaded.push({
          name: file.originalName,
          remotePath,
          size: file.size,
        });
      }
      return uploaded;
    },
  );
}

function uploadFilesToGuestByJumpHost(transport: Extract<UploadTransport, { type: "jump" }>, input: UploadGuestInput): Promise<ConsoleUploadResult["uploaded"]> {
  return new Promise((resolve, reject) => {
    const jumpClient = new Client();
    let settled = false;
    const finish = (error?: Error, value?: ConsoleUploadResult["uploaded"]) => {
      if (settled) return;
      settled = true;
      jumpClient.end();
      if (error) {
        reject(error);
      } else {
        resolve(value ?? []);
      }
    };
    jumpClient
      .on("ready", () => {
        jumpClient.forwardOut("127.0.0.1", 0, transport.host, 22, (error, stream) => {
          if (error) {
            finish(error);
            return;
          }
          withGuestSftp(
            {
              sock: stream,
              username: input.username,
              password: input.password,
              readyTimeout: uploadReadyTimeoutMs,
              algorithms: guestSshAlgorithms(),
            },
            async (client, sftp) => {
              input.progress?.({ stage: "preparing", message: `正在确认远端目录 ${input.remoteDir}` });
              await ensureRemoteDir(sftp, input.remoteDir);
              const uploaded: ConsoleUploadResult["uploaded"] = [];
              for (const file of input.files) {
                const remotePath = `${input.remoteDir}/${file.safeName}`;
                await fastPut(sftp, file, remotePath, input.progress);
                uploaded.push({
                  name: file.originalName,
                  remotePath,
                  size: file.size,
                });
              }
              return uploaded;
            },
          )
            .then((result) => finish(undefined, result))
            .catch((uploadError: unknown) => finish(uploadError instanceof Error ? uploadError : new Error("隧道上传失败")));
        });
      })
      .on("error", (error) => finish(error))
      .connect({
        host: transport.jumpConnection.host,
        port: transport.jumpConnection.port,
        username: transport.jumpConnection.username,
        password: transport.jumpConnection.password,
        readyTimeout: uploadReadyTimeoutMs,
        algorithms: guestSshAlgorithms(),
      });
  });
}

function withGuestSftp<T>(config: ConnectConfig, task: (client: Client, sftp: SFTPWrapper) => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    const finish = (error?: Error, value?: T) => {
      if (settled) return;
      settled = true;
      client.end();
      if (error) {
        reject(error);
      } else {
        resolve(value as T);
      }
    };
    client
      .on("ready", () => {
        client.sftp((error, sftp) => {
          if (error) {
            finish(error);
            return;
          }
          task(client, sftp)
            .then((result) => {
              sftp.end();
              finish(undefined, result);
            })
            .catch((taskError: unknown) => {
              sftp.end();
              finish(taskError instanceof Error ? taskError : new Error("文件上传失败"));
            });
        });
      })
      .on("error", (error) => {
        finish(error);
      })
      .connect(config);
  });
}

function ensureRemoteDir(sftp: SFTPWrapper, remoteDir: string): Promise<void> {
  const parts = remoteDir.split("/").filter(Boolean);
  let current = "";
  return parts.reduce<Promise<void>>(async (previous, part) => {
    await previous;
    current = `${current}/${part}`;
    await ensureRemoteDirSegment(sftp, current);
  }, Promise.resolve());
}

function ensureRemoteDirSegment(sftp: SFTPWrapper, remoteDir: string): Promise<void> {
  return withTimeout(new Promise((resolve, reject) => {
    sftp.stat(remoteDir, (statError, stats) => {
      if (!statError) {
        if (stats.isDirectory()) {
          resolve();
        } else {
          reject(new Error(`${remoteDir} 已存在但不是目录`));
        }
        return;
      }
      sftp.mkdir(remoteDir, (mkdirError) => {
        if (mkdirError && !/failure/i.test(mkdirError.message)) {
          reject(mkdirError);
          return;
        }
        resolve();
      });
    });
  }), uploadOperationTimeoutMs, `创建远端目录 ${remoteDir} 超时`);
}

function execGuestCommand(client: Client, command: string): Promise<void> {
  return withTimeout(new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      stream.resume();
      let stderr = "";
      stream
        .on("close", (code: number) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(stderr.trim() || `远端命令失败：${code}`));
          }
        })
        .stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
    });
  }), uploadOperationTimeoutMs, "远端命令执行超时");
}

function fastPut(sftp: SFTPWrapper, file: LocalUploadFile, remotePath: string, progress?: UploadProgressReporter): Promise<void> {
  const timeoutMs = resolveFileUploadTimeoutMs(file.size);
  let lastProgressBytes = 0;
  let lastProgressReportAt = 0;
  return withTimeout(new Promise((resolve, reject) => {
    progress?.({
      stage: "uploading",
      message: `正在写入 ${file.originalName}`,
      percent: 0,
      bytesTransferred: 0,
      totalBytes: file.size,
      fileName: file.originalName,
      remotePath,
    });
    sftp.fastPut(
      file.localPath,
      remotePath,
      {
        step: (bytesTransferred, _chunk, totalBytes) => {
          if (bytesTransferred === lastProgressBytes && bytesTransferred !== totalBytes) return;
          const now = Date.now();
          const isFinalStep = bytesTransferred >= totalBytes;
          if (!isFinalStep && now - lastProgressReportAt < 300) return;
          lastProgressBytes = bytesTransferred;
          lastProgressReportAt = now;
          progress?.({
            stage: "uploading",
            message: `正在写入 ${file.originalName}`,
            percent: totalBytes > 0 ? Math.min(99, Math.round((bytesTransferred / totalBytes) * 100)) : undefined,
            bytesTransferred,
            totalBytes,
            fileName: file.originalName,
            remotePath,
          });
        },
      },
      (error) => {
        if (error) {
          reject(error);
          return;
        }
        progress?.({
          stage: "uploading",
          message: `${file.originalName} 写入完成`,
          percent: 100,
          bytesTransferred: file.size,
          totalBytes: file.size,
          fileName: file.originalName,
          remotePath,
        });
        resolve();
      },
    );
  }), timeoutMs, `SFTP 写入 ${file.originalName} 超时`);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function resolveFileUploadTimeoutMs(size: number) {
  const mib = Math.max(1, Math.ceil(size / 1024 / 1024));
  return Math.max(minFileUploadTimeoutMs, mib * fileUploadTimeoutPerMiBMs);
}

function normalizeUploadId(value?: string) {
  const candidate = value?.trim();
  if (!candidate) return "";
  return /^[\w-]{8,80}$/.test(candidate) ? candidate : "";
}

function getUploadProgressState(uploadId: string) {
  let state = uploadProgressStates.get(uploadId);
  if (!state) {
    state = {
      uploadId,
      seq: 0,
      listeners: new Set(),
      startedAt: Date.now(),
      lastBytesTransferred: 0,
      lastProgressAt: Date.now(),
      lastPublishedAt: 0,
    };
    uploadProgressStates.set(uploadId, state);
  }
  if (state.expireTimer) {
    clearTimeout(state.expireTimer);
    state.expireTimer = undefined;
  }
  return state;
}

function createUploadProgressReporter(uploadId: string): UploadProgressReporter {
  getUploadProgressState(uploadId);
  return (event) => publishUploadProgress(uploadId, event);
}

function publishUploadProgress(uploadId: string, event: Omit<ConsoleUploadProgressEvent, "uploadId" | "seq" | "createdAt">) {
  const state = getUploadProgressState(uploadId);
  const now = Date.now();
  const bytesTransferred = event.bytesTransferred ?? state.lastBytesTransferred;
  const deltaBytes = bytesTransferred - state.lastBytesTransferred;
  const deltaMs = now - state.lastProgressAt;
  const speedBytesPerSecond = event.speedBytesPerSecond ?? (deltaBytes > 0 && deltaMs > 0 ? Math.round((deltaBytes / deltaMs) * 1000) : undefined);

  state.lastBytesTransferred = bytesTransferred;
  state.lastProgressAt = now;
  state.seq += 1;
  state.lastPublishedAt = now;
  const progressEvent: ConsoleUploadProgressEvent = {
    uploadId,
    seq: state.seq,
    createdAt: new Date(now).toISOString(),
    ...event,
    bytesTransferred: event.bytesTransferred,
    speedBytesPerSecond,
  };
  state.lastEvent = progressEvent;
  for (const listener of state.listeners) listener(progressEvent);
  if (event.stage === "completed" || event.stage === "failed") scheduleUploadProgressCleanup(uploadId);
}

function scheduleUploadProgressCleanup(uploadId: string) {
  const state = uploadProgressStates.get(uploadId);
  if (!state || state.expireTimer) return;
  state.expireTimer = setTimeout(() => {
    uploadProgressStates.delete(uploadId);
  }, uploadProgressRetentionMs);
}

function guestSshAlgorithms(): ConnectConfig["algorithms"] {
  return {
    kex: [
      "curve25519-sha256",
      "curve25519-sha256@libssh.org",
      "ecdh-sha2-nistp256",
      "ecdh-sha2-nistp384",
      "ecdh-sha2-nistp521",
      "diffie-hellman-group14-sha256",
      "diffie-hellman-group14-sha1",
    ],
    serverHostKey: ["rsa-sha2-512", "rsa-sha2-256", "ssh-rsa", "ecdsa-sha2-nistp256", "ssh-ed25519"],
  };
}

function resolveUploadErrorStatus(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (/handshake|timed out|timeout|connect|no route|unreachable|channel open failure/i.test(message)) return 504;
  if (/authentication|All configured authentication methods failed|permission/i.test(message)) return 401;
  return 502;
}

function formatUploadError(error: unknown, vmIp: string) {
  const message = error instanceof Error ? error.message : "未知错误";
  if (/handshake|timed out|timeout|connect|no route|unreachable|channel open failure/i.test(message)) {
    return `无法连接 VM ${vmIp} 的 SSH 端口，文件上传需要 VM 已开机且 SSH 可达`;
  }
  if (/authentication|All configured authentication methods failed|permission/i.test(message)) {
    return `VM ${vmIp} SSH 登录失败，请确认 root 密码规则或后续配置账号`;
  }
  return `文件上传失败：${message}`;
}

function normalizeVmIp(value?: string) {
  const candidate = value?.trim();
  if (!candidate || candidate === "-") return "";
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(candidate) ? candidate : "";
}

function deriveRootPassword(ip: string) {
  const template = getRuntimePolicy().provisioning.rootPasswordTemplate;
  if (!template) return "";
  const parts = ip.split(".");
  if (parts.length !== 4) return "";
  return template
    .replaceAll("{first}", parts[0])
    .replaceAll("{second}", parts[1])
    .replaceAll("{third}", parts[2])
    .replaceAll("{fourth}", parts[3])
    .replaceAll("{ip}", ip);
}

function sanitizeFileName(name: string) {
  const safeName = basename(name).replace(/[^\w.\-()[\]\u4e00-\u9fa5]+/g, "_").replace(/^_+|_+$/g, "");
  return safeName || "upload.bin";
}

function sanitizeRemoteDir(value: string) {
  const normalized = value.trim() || uploadRoot;
  if (!normalized.startsWith("/")) return uploadRoot;
  if (normalized.includes("..")) return uploadRoot;
  return normalized.replace(/\/+$/g, "") || uploadRoot;
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
