import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { dirname, join, posix } from "node:path";
import { Client } from "ssh2";
import type { ConnectConfig, SFTPWrapper } from "ssh2";
import { markProvisionTaskStep } from "./provisionTaskStore.js";
import type { IpPoolConfig, ProviderType, VmProvisionInstallSourceRef, VmProvisionPlanItem, VmProvisionRequest, XenConnectionInput } from "./types.js";
import { resolveXenInstallMediaMode } from "./xenserverUnattendedIso.js";

// 集中安装源服务：只负责把无人值守安装需要的 ks.cfg/repo 发布成 VM 可访问的 HTTP URL。
// Provider 不能再回到“SSH 到每台宿主机并启动临时 HTTP 服务”的路径。
interface InstallSourceRecord {
  id: string;
  taskId: string;
  providerType: ProviderType;
  connection: XenConnectionInput;
  sourceIsoId: string;
  sourceIsoName: string;
  vm: VmProvisionPlanItem;
  ipPool: IpPoolConfig;
  repoUrl: string;
  ksUrl: string;
  installedUrl: string;
  sourceInfo?: XenSourceIsoInfo;
  createdAt: string;
  fetchedKickstart: boolean;
  startedPackageInstall: boolean;
  completedGuestInstall: boolean;
}

interface XenSourceIsoInfo {
  srUuid: string;
  location: string;
  remotePath: string;
  mountDir: string;
}

const installSourceRecords = new Map<string, InstallSourceRecord>();
const cacheRoot = join(homedir(), ".virtual-resource-console", "install-source-cache");

export function registerInstallSourceRoutes(server: FastifyInstance): void {
  // 这些路由由新 VM 的安装器直接访问，必须使用 VRC_INSTALL_SOURCE_BASE_URL 暴露在 VM 可达网络。
  server.get("/api/provisioning/install-source/:sourceId/ks.cfg", async (request, reply) => {
    const source = findInstallSource(getSourceId(request.params));
    if (!source) return reply.status(404).send({ message: "安装源不存在或已过期。" });
    reply.header("cache-control", "no-store");
    reply.type("text/plain; charset=utf-8");
    if (!source.fetchedKickstart) {
      source.fetchedKickstart = true;
      markProvisionTaskStep(source.taskId, "fetch-source", "success", "安装器已拉取 Kickstart 配置");
      markProvisionTaskStep(source.taskId, "install-guest", "running", "系统安装器正在读取软件包");
    }
    return buildKickstart(source);
  });

  server.get("/api/provisioning/install-source/:sourceId/installed", async (request, reply) => {
    const source = findInstallSource(getSourceId(request.params));
    if (!source) return reply.status(404).send({ message: "安装源不存在或已过期。" });
    if (!source.completedGuestInstall) {
      source.completedGuestInstall = true;
      markProvisionTaskStep(source.taskId, "install-guest", "success", "系统安装脚本已完成，准备从硬盘启动");
      markProvisionTaskStep(source.taskId, "wait-network", "running", "等待安装后系统重启并开放 SSH");
      await switchXenVmToDiskBoot(source);
    }
    return reply.status(204).send();
  });

  server.get("/api/provisioning/install-source/:sourceId/repo", async (request, reply) => {
    const source = findInstallSource(getSourceId(request.params));
    if (!source) return reply.status(404).send({ message: "安装源不存在或已过期。" });
    return sendRepoFile(source, ".treeinfo", request, reply);
  });

  server.get("/api/provisioning/install-source/:sourceId/repo/*", async (request, reply) => {
    const source = findInstallSource(getSourceId(request.params));
    if (!source) return reply.status(404).send({ message: "安装源不存在或已过期。" });
    const repoPath = getWildcardPath(request.params);
    return sendRepoFile(source, repoPath, request, reply);
  });
}

export async function publishXenInstallSources(input: {
  connection: XenConnectionInput;
  request: VmProvisionRequest;
  taskId: string;
}): Promise<VmProvisionRequest> {
  if (!shouldUseXenKickstart(input.request)) return input.request;
  if (!input.request.isoId) throw new Error("XenServer Kickstart 安装需要系统 ISO。");
  const baseUrl = resolveInstallSourcePublicBaseUrl();
  const planItems = input.request.planItems.map((vm, index) => {
    // 每台 VM 使用独立安装源 ID，便于后续按任务追踪、清理和审计。
    const id = `${input.taskId}-${index + 1}-${randomUUID().slice(0, 8)}`;
    const repoUrl = `${baseUrl}/api/provisioning/install-source/${encodeURIComponent(id)}/repo`;
    const ksUrl = `${baseUrl}/api/provisioning/install-source/${encodeURIComponent(id)}/ks.cfg`;
    const installedUrl = `${baseUrl}/api/provisioning/install-source/${encodeURIComponent(id)}/installed`;
    installSourceRecords.set(id, {
      id,
      taskId: input.taskId,
      providerType: "xenserver",
      connection: input.connection,
      sourceIsoId: input.request.isoId ?? "",
      sourceIsoName: input.request.isoName ?? "",
      vm,
      ipPool: input.request.ipPool,
      repoUrl,
      ksUrl,
      installedUrl,
      createdAt: new Date().toISOString(),
      fetchedKickstart: false,
      startedPackageInstall: false,
      completedGuestInstall: false,
    });
    return {
      ...vm,
      installSource: {
        id,
        taskId: input.taskId,
        repoUrl,
        ksUrl,
        installedUrl,
      },
    };
  });
  return {
    ...input.request,
    planItems,
  };
}

export function shouldUseXenKickstart(request: VmProvisionRequest): boolean {
  const sourceName = `${request.isoName ?? ""} ${request.templateName ?? ""} ${request.isoId ?? ""}`.toLowerCase();
  return (
    request.providerType === "xenserver" &&
    request.sourceType === "iso" &&
    sourceName.includes("centos") &&
    resolveXenInstallMediaMode() === "http-boot-iso"
  );
}

export function resolveInstallSourcePublicBaseUrl(): string {
  const configured = process.env.VRC_INSTALL_SOURCE_BASE_URL?.trim();
  const rawBaseUrl = configured || autoDetectInstallSourceBaseUrl();
  let url: URL;
  try {
    url = new URL(rawBaseUrl);
  } catch {
    throw new Error(`安装源公开地址格式不正确：${rawBaseUrl}`);
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("安装源公开地址必须是 HTTP/HTTPS。");
  }
  if (["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
    throw new Error("无人值守安装源不能使用 localhost/127.0.0.1，请配置 VRC_INSTALL_SOURCE_BASE_URL 为 VM 网络可访问地址。");
  }
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/$/, "")}`;
}

function autoDetectInstallSourceBaseUrl(): string {
  const port = process.env.PORT ?? "3987";
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        return `http://${address.address}:${port}`;
      }
    }
  }
  throw new Error("未配置 VRC_INSTALL_SOURCE_BASE_URL，且无法自动识别可被 VM 访问的本机 IP。");
}

async function sendRepoFile(source: InstallSourceRecord, repoPath: string, request: FastifyRequest, reply: FastifyReply) {
  const safePath = sanitizeRepoPath(repoPath);
  if (!safePath) return reply.status(400).send({ message: "安装源路径不合法。" });
  try {
    const localPath = await ensureRepoFileCached(source, safePath);
    if (!source.startedPackageInstall && safePath.startsWith("Packages/") && safePath.endsWith(".rpm")) {
      source.startedPackageInstall = true;
      markProvisionTaskStep(source.taskId, "install-guest", "running", "系统安装器正在安装软件包");
    }
    return sendStaticRepoFile(localPath, safePath, request, reply);
  } catch (error) {
    return reply.status(404).send({
      message: error instanceof Error ? error.message : "安装源文件不存在。",
    });
  }
}

function sendStaticRepoFile(localPath: string, safePath: string, request: FastifyRequest, reply: FastifyReply) {
  const { size } = statSync(localPath);
  const range = parseHttpRange(request.headers.range, size);
  reply.header("cache-control", "public, max-age=3600");
  reply.header("accept-ranges", "bytes");
  reply.type(contentTypeForPath(safePath));

  if (range) {
    const contentLength = range.end - range.start + 1;
    reply.status(206);
    reply.header("content-range", `bytes ${range.start}-${range.end}/${size}`);
    reply.header("content-length", String(contentLength));
    if (request.method === "HEAD") return reply.send();
    return reply.send(createReadStream(localPath, { start: range.start, end: range.end }));
  }

  reply.header("content-length", String(size));
  if (request.method === "HEAD") return reply.send();
  return reply.send(createReadStream(localPath));
}

function parseHttpRange(rangeHeader: string | undefined, size: number): { start: number; end: number } | undefined {
  if (!rangeHeader || !rangeHeader.startsWith("bytes=") || size <= 0) return undefined;
  const firstRange = rangeHeader.slice("bytes=".length).split(",")[0]?.trim();
  const match = firstRange?.match(/^(\d*)-(\d*)$/);
  if (!match) return undefined;
  const [, rawStart, rawEnd] = match;
  let start = rawStart ? Number(rawStart) : Number.NaN;
  let end = rawEnd ? Number(rawEnd) : size - 1;
  if (!rawStart && rawEnd) {
    const suffixLength = Number(rawEnd);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return undefined;
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= size) return undefined;
  return {
    start,
    end: Math.min(end, size - 1),
  };
}

async function ensureRepoFileCached(source: InstallSourceRecord, repoPath: string): Promise<string> {
  const localPath = join(cacheRoot, safePathSegment(source.id), repoPath);
  if (existsSync(localPath) && statSync(localPath).isFile()) return localPath;
  const sourceInfo = source.sourceInfo ?? (await readXenSourceIsoInfo(source.connection, source.sourceIsoId));
  source.sourceInfo = sourceInfo;
  mkdirSync(dirname(localPath), { recursive: true, mode: 0o700 });
  await downloadFile(source.connection, `${sourceInfo.mountDir}/${repoPath}`, localPath);
  return localPath;
}

async function switchXenVmToDiskBoot(source: InstallSourceRecord): Promise<void> {
  await runRemoteCommand(
    source.connection,
    [
      `vm_name='${escapeShellValue(source.vm.name)}'`,
      'vm_uuid="$(xe vm-list name-label="$vm_name" --minimal 2>/dev/null | tr "," " " | awk \'{print $1}\')"',
      '[ -n "$vm_uuid" ] || { echo "未找到已安装 VM：$vm_name" >&2; exit 6; }',
      'xe vm-param-set uuid="$vm_uuid" HVM-boot-params:order=c >/dev/null 2>&1 || true',
      'xe vm-param-set uuid="$vm_uuid" other-config:vrc-install-complete=true >/dev/null 2>&1 || true',
    ].join("\n"),
  );
}

async function readXenSourceIsoInfo(connection: XenConnectionInput, sourceIsoId: string): Promise<XenSourceIsoInfo> {
  const output = await runRemoteCommand(
    connection,
    [
      `iso_uuid='${escapeShellValue(sourceIsoId)}'`,
      'sr_uuid="$(xe vdi-param-get uuid="$iso_uuid" param-name=sr-uuid 2>/dev/null)"',
      'location="$(xe vdi-param-get uuid="$iso_uuid" param-name=location 2>/dev/null)"',
      'remote_path="/var/run/sr-mount/$sr_uuid/$location"',
      'mount_dir="/tmp/vrc-source-iso-$iso_uuid"',
      '[ -f "$remote_path" ] || { echo "未找到源 ISO 文件：$remote_path" >&2; exit 6; }',
      'mkdir -p "$mount_dir"',
      'current_source="$(mount | awk -v dir="$mount_dir" \'$3 == dir {print $1; exit}\')"',
      '[ -z "$current_source" ] || [ "$current_source" = "$remote_path" ] || umount "$mount_dir" >/dev/null 2>&1 || true',
      'mountpoint -q "$mount_dir" || mount -o loop,ro "$remote_path" "$mount_dir"',
      '[ -f "$mount_dir/.treeinfo" ] || [ -d "$mount_dir/repodata" ] || { echo "源 ISO 不是可用安装源：$remote_path" >&2; exit 6; }',
      'printf "ISO\\t%s\\t%s\\t%s\\t%s\\n" "$sr_uuid" "$location" "$remote_path" "$mount_dir"',
    ].join("\n"),
  );
  const line = output.split(/\r?\n/).find((item) => item.startsWith("ISO\t"));
  const [, srUuid = "", location = "", remotePath = "", mountDir = ""] = line?.split("\t") ?? [];
  if (!srUuid || !location || !remotePath || !mountDir) {
    throw new Error("未读取到 XenServer 源 ISO 文件路径，无法发布安装源。");
  }
  return { srUuid, location, remotePath, mountDir };
}

function buildKickstart(source: InstallSourceRecord): string {
  const netmask = cidrToNetmask(source.ipPool.cidr) || "255.255.255.0";
  const dns = sanitizeKickstartValue(source.ipPool.dns[0] ?? "");
  const gateway = sanitizeKickstartValue(source.ipPool.gateway);
  const ip = sanitizeKickstartValue(source.vm.ip);
  const rootPassword = sanitizeKickstartValue(source.vm.rootPassword ?? "");
  const hostname = sanitizeKickstartValue(source.vm.name);
  const installedUrl = sanitizeKickstartValue(source.installedUrl);
  return `#version=DEVEL
install
url --url="${source.repoUrl}"
lang en_US.UTF-8
keyboard us
timezone Asia/Shanghai --isUtc
rootpw --plaintext ${rootPassword}
auth --enableshadow --passalgo=sha512
selinux --disabled
firewall --disabled
firstboot --disabled
network --bootproto=static --device=eth0 --ip=${ip} --netmask=${netmask} --gateway=${gateway} --nameserver=${dns} --hostname=${hostname} --onboot=on --activate
bootloader --location=mbr
zerombr
clearpart --all --initlabel
autopart --type=lvm
reboot --eject
%packages
@core
net-tools
openssh-server
-dracut-config-rescue
%end
%post --nochroot
/usr/bin/python - <<'PY' || true
import urllib2
urllib2.urlopen('${installedUrl}', timeout=10).read()
PY
%end
%post
cat > /etc/sysconfig/network-scripts/ifcfg-eth0 <<'VRC_IFCFG'
TYPE=Ethernet
DEVICE=eth0
NAME=eth0
BOOTPROTO=none
ONBOOT=yes
IPADDR=${ip}
NETMASK=${netmask}
GATEWAY=${gateway}
DNS1=${dns}
DEFROUTE=yes
IPV6INIT=no
VRC_IFCFG
systemctl enable network || true
systemctl disable firewalld || true
systemctl enable sshd
%end
`;
}

function findInstallSource(sourceId: string): InstallSourceRecord | undefined {
  return installSourceRecords.get(sourceId);
}

function getSourceId(params: unknown): string {
  return typeof params === "object" && params !== null && "sourceId" in params ? String((params as { sourceId?: unknown }).sourceId ?? "") : "";
}

function getWildcardPath(params: unknown): string {
  return typeof params === "object" && params !== null && "*" in params ? String((params as { "*"?: unknown })["*"] ?? "") : "";
}

function sanitizeRepoPath(repoPath: string): string {
  const decoded = decodeURIComponent(repoPath || "");
  const normalized = posix.normalize(decoded).replace(/^\/+/, "");
  if (!normalized || normalized === "." || normalized.includes("..") || normalized.includes("\0")) return "";
  return normalized;
}

function safePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120) || "source";
}

function sanitizeKickstartValue(value: string): string {
  return value.replace(/[\r\n]/g, "").trim();
}

function contentTypeForPath(path: string): string {
  if (path.endsWith(".xml")) return "application/xml";
  if (path.endsWith(".gz")) return "application/gzip";
  if (path.endsWith(".bz2")) return "application/x-bzip2";
  if (path.endsWith(".rpm")) return "application/x-rpm";
  if (path.endsWith(".img")) return "application/octet-stream";
  if (path.endsWith(".iso")) return "application/octet-stream";
  return "text/plain; charset=utf-8";
}

function cidrToNetmask(cidr: string | undefined): string {
  const bits = Number(cidr?.split("/")[1]);
  if (!Number.isFinite(bits) || bits < 0 || bits > 32) return "";
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return [24, 16, 8, 0].map((shift) => (mask >>> shift) & 255).join(".");
}

function downloadFile(connection: XenConnectionInput, remotePath: string, localPath: string): Promise<void> {
  return withSftp(connection, (sftp) => new Promise((resolve, reject) => sftp.fastGet(remotePath, localPath, (error) => (error ? reject(error) : resolve()))));
}

function withSftp<T>(connection: XenConnectionInput, task: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const client = createClient();
    client
      .on("ready", () => {
        client.sftp((error, sftp) => {
          if (error) {
            client.end();
            reject(error);
            return;
          }
          task(sftp)
            .then(resolve, reject)
            .finally(() => {
              sftp.end();
              client.end();
            });
        });
      })
      .on("error", reject)
      .connect(sshOptions(connection));
  });
}

function runRemoteCommand(connection: XenConnectionInput, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = createClient();
    let stdout = "";
    let stderr = "";
    client
      .on("ready", () => {
        client.exec(command, (error, stream) => {
          if (error) {
            client.end();
            reject(error);
            return;
          }
          stream
            .on("close", (code: number) => {
              client.end();
              if (code !== 0) {
                reject(new Error(stderr || `XenServer command exited with code ${code}`));
                return;
              }
              resolve(stdout);
            })
            .on("data", (data: Buffer) => {
              stdout += data.toString("utf8");
            })
            .stderr.on("data", (data: Buffer) => {
              stderr += data.toString("utf8");
            });
        });
      })
      .on("error", reject)
      .connect(sshOptions(connection));
  });
}

function createClient(): Client {
  return new Client();
}

function sshOptions(connection: XenConnectionInput): ConnectConfig {
  return {
    host: connection.host,
    port: connection.port,
    username: connection.username,
    password: connection.password,
    readyTimeout: 15000,
    algorithms: {
      kex: ["diffie-hellman-group14-sha1", "diffie-hellman-group1-sha1", "diffie-hellman-group-exchange-sha1"],
      serverHostKey: ["ssh-rsa", "ssh-dss"],
    },
  };
}

function escapeShellValue(value: string): string {
  return value.replace(/'/g, "'\\''");
}
