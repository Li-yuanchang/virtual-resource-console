import type { FastifyInstance, FastifyRequest } from "fastify";
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
const maxUploadFiles = 8;

interface ConsoleUploadFieldMap {
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

export async function registerConsoleUploadRoutes(server: FastifyInstance): Promise<void> {
  server.post("/api/console/upload", async (request, reply) => {
    const { fields, files, tempDir } = await readMultipartUpload(request);
    try {
      const vmIp = normalizeVmIp(fields.vmIp);
      if (!vmIp) {
        return reply.code(400).send({ message: "缺少 VM IP，无法上传到虚拟机" });
      }
      if (!files.length) {
        return reply.code(400).send({ message: "没有收到可上传文件" });
      }

      const username = fields.username?.trim() || "root";
      const password = fields.password?.trim() || deriveRootPassword(vmIp);
      if (!password) {
        return reply.code(400).send({ message: "缺少 VM 登录密码，当前只支持按 IP 规则自动推导的 root 账号" });
      }

      const remoteDir = sanitizeRemoteDir(fields.remoteDir || uploadRoot);
      let uploaded: ConsoleUploadResult["uploaded"];
      try {
        uploaded = await uploadFilesToGuest(resolveUploadTransport(fields, vmIp), {
          username,
          password,
          remoteDir,
          files,
        });
      } catch (error) {
        return reply.code(resolveUploadErrorStatus(error)).send({ message: formatUploadError(error, vmIp) });
      }
      const result: ConsoleUploadResult = {
        message: `已上传 ${uploaded.length} 个文件到 ${remoteDir}`,
        uploaded,
      };
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
      if (["connectionId", "providerType", "vmIp", "vmName", "username", "password", "remoteDir"].includes(fieldName)) {
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
}

function resolveUploadTransport(fields: ConsoleUploadFieldMap, vmIp: string): UploadTransport {
  if (fields.connectionId && fields.providerType === "xenserver") {
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
      await execGuestCommand(client, `mkdir -p ${shellQuote(input.remoteDir)}`);
      const uploaded: ConsoleUploadResult["uploaded"] = [];
      for (const file of input.files) {
        const remotePath = `${input.remoteDir}/${file.safeName}`;
        await fastPut(sftp, file.localPath, remotePath);
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
              await execGuestCommand(client, `mkdir -p ${shellQuote(input.remoteDir)}`);
              const uploaded: ConsoleUploadResult["uploaded"] = [];
              for (const file of input.files) {
                const remotePath = `${input.remoteDir}/${file.safeName}`;
                await fastPut(sftp, file.localPath, remotePath);
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

function execGuestCommand(client: Client, command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
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
  });
}

function fastPut(sftp: SFTPWrapper, localPath: string, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.fastPut(localPath, remotePath, (error) => (error ? reject(error) : resolve()));
  });
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
