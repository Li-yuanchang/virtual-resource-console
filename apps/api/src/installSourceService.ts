import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { Client } from "ssh2";
import type { ConnectConfig, SFTPWrapper } from "ssh2";
import { buildCentosLvmPartitioning, buildCentosPackageSelection } from "./centosKickstart.js";
import { getVrcDataFile } from "./appPaths.js";
import { markProvisionTaskStep, updateProvisionTaskVm } from "./provisionTaskStore.js";
import type { IpPoolConfig, ProviderType, VmProvisionInstallSourceRef, VmProvisionPlanItem, VmProvisionRequest, XenConnectionInput } from "./types.js";
import { resolveXenInstallMediaMode, type XenInstallMediaMode } from "./xenserverUnattendedIso.js";

// XenServer 安装源编排：在目标物理机上按任务租约发布 ks.cfg/repo，并负责端口和残留清理。
interface InstallSourceRecord {
  id: string;
  taskId: string;
  providerType: ProviderType;
  connection: XenConnectionInput;
  sourceIsoId: string;
  sourceIsoName: string;
  installMediaMode: XenInstallMediaMode;
  vm: VmProvisionPlanItem;
  ipPool: IpPoolConfig;
  repoUrl: string;
  ksUrl: string;
  installedUrl: string;
  xenHostPort?: string;
  sourceInfo?: XenSourceIsoInfo;
  createdAt: string;
  fetchedKickstart: boolean;
  startedPackageInstall: boolean;
  packageTotal?: number;
  packageDone: number;
  packagePaths: Set<string>;
  completedGuestInstall: boolean;
}

interface XenSourceIsoInfo {
  srUuid: string;
  location: string;
  remotePath: string;
  mountDir: string;
  sourceType: "iso-library" | "host-dvd";
}

export interface XenInstallHostAddressCandidate {
  ip: string;
  management: boolean;
}

export interface XenProvisioningNetworkProbe {
  status: "reachable" | "route-only" | "unreachable";
  message: string;
  installHost?: string;
  routeAvailable: boolean;
  gatewayReachable: boolean;
  respondingTarget?: string;
}

const installSourceRecords = new Map<string, InstallSourceRecord>();
const xenHostInstallLeases = new Map<string, { connection: XenConnectionInput; port: string; sourceIds: string[]; vmCidr?: string }>();
const cacheRoot = getVrcDataFile("install-source-cache");
const xenHostInstallSourceStartPort = process.env.VRC_XEN_HOST_INSTALL_SOURCE_PORT?.trim() || "3988";
const xenHostInstallSourcePortCount = Number(process.env.VRC_XEN_HOST_INSTALL_SOURCE_PORT_COUNT ?? "20");
const xenHostInstallSourceRoot = process.env.VRC_XEN_HOST_INSTALL_SOURCE_ROOT?.trim() || "/var/run/vrc-install-source";

export function buildXenInstalledHook(vmName: string): string {
  return [
    "#!/bin/sh",
    "set -e",
    `vm_name='${escapeShellValue(vmName)}'`,
    'vm_uuid="$(xe vm-list name-label="$vm_name" --minimal 2>/dev/null | tr "," " " | awk \'{print $1}\')"',
    '[ -n "$vm_uuid" ] || { echo "未找到已安装 VM：$vm_name" >&2; exit 6; }',
    'xe vm-param-set uuid="$vm_uuid" HVM-boot-params:order=c >/dev/null',
    'tools_iso=""',
    'for candidate in $(xe cd-list --minimal 2>/dev/null | tr "," " "); do',
    '  label="$(xe vdi-param-get uuid="$candidate" param-name=name-label 2>/dev/null | tr -d "\\r\\n")"',
    '  if [ "$label" = "xs-tools.iso" ] || [ "$label" = "guest-tools.iso" ]; then tools_iso="$candidate"; break; fi',
    'done',
    'if [ -n "$tools_iso" ]; then',
    '  cd_vbd="$(xe vbd-list vm-uuid="$vm_uuid" type=CD --minimal 2>/dev/null | tr "," " " | awk \'{print $1}\')"',
    '  if [ -n "$cd_vbd" ]; then',
    '    current_vdi="$(xe vbd-param-get uuid="$cd_vbd" param-name=vdi-uuid 2>/dev/null | tr -d "\\r\\n")"',
    '    if [ "$current_vdi" != "$tools_iso" ]; then',
    '      xe vbd-eject uuid="$cd_vbd" >/dev/null 2>&1 || { xe vbd-unplug uuid="$cd_vbd" force=true >/dev/null 2>&1 || true; xe vbd-eject uuid="$cd_vbd" >/dev/null 2>&1 || true; }',
    '      xe vbd-insert uuid="$cd_vbd" vdi-uuid="$tools_iso" >/dev/null',
    '    fi',
    '  else',
    '    cd_vbd="$(xe vbd-create vm-uuid="$vm_uuid" vdi-uuid="$tools_iso" device=3 bootable=false mode=RO type=CD)"',
    '  fi',
    '  attached="$(xe vbd-param-get uuid="$cd_vbd" param-name=currently-attached 2>/dev/null | tr -d "\\r\\n")"',
    '  [ "$attached" = "true" ] || xe vbd-plug uuid="$cd_vbd" >/dev/null 2>&1 || true',
    '  xe vm-param-set uuid="$vm_uuid" other-config:vrc-tools-media-ready=true >/dev/null 2>&1 || true',
    'fi',
    'xe vm-param-set uuid="$vm_uuid" other-config:vrc-install-complete=true >/dev/null 2>&1 || true',
  ].join("\n");
}

export function xenInstallRebootDirective(sourceType: "iso-library" | "host-dvd"): "reboot" | "reboot --eject" {
  return sourceType === "host-dvd" ? "reboot" : "reboot --eject";
}

export function registerInstallSourceRoutes(server: FastifyInstance): void {
  // 保留兼容路由用于已有调用；XenServer 创建链路只使用目标物理机任务级安装源。
  server.get("/api/provisioning/install-source/:sourceId/ks.cfg", async (request, reply) => {
    const source = findInstallSource(getSourceId(request.params));
    if (!source) return reply.status(404).send({ message: "安装源不存在或已过期。" });
    reply.header("cache-control", "no-store");
    reply.type("text/plain; charset=utf-8");
    if (!source.fetchedKickstart) {
      source.fetchedKickstart = true;
      markProvisionTaskStep(source.taskId, "fetch-source", "success", "安装器已拉取 Kickstart 配置");
      markProvisionTaskStep(source.taskId, "install-guest", "running", "系统安装器正在读取软件包");
      updateProvisionTaskVm(source.taskId, source.vm.name, {
        status: "running",
        currentStep: "install-guest",
        message: "安装器已拉取 Kickstart 配置",
      });
    }
    return buildKickstart(source);
  });

  server.get("/api/provisioning/install-source/:sourceId/installed", async (request, reply) => {
    const source = findInstallSource(getSourceId(request.params));
    if (!source) return reply.status(404).send({ message: "安装源不存在或已过期。" });
    if (!source.completedGuestInstall) {
      await switchXenVmToDiskBoot(source);
      source.completedGuestInstall = true;
      markProvisionTaskStep(source.taskId, "install-guest", "success", "系统安装完成，已切换硬盘启动并准备 Tools");
      markProvisionTaskStep(source.taskId, "wait-network", "running", "等待系统盘启动并开放 SSH");
      updateProvisionTaskVm(source.taskId, source.vm.name, {
        status: "running",
        currentStep: "wait-network",
        message: "已切换硬盘启动并挂载 Tools，等待 SSH",
      });
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
  const sourceInfo = await readXenSourceIsoInfo(input.connection, input.request.isoId);
  const installMediaMode = sourceInfo.sourceType === "host-dvd" ? "native-http" : resolveXenInstallMediaMode();
  const hostLease = await allocateXenHostInstallSource(input.connection, input.request, input.taskId);
  if (!hostLease) {
    throw new Error("目标 XenServer 物理机没有可用于发布任务级安装源的 IPv4 地址。");
  }
  const planItems: VmProvisionPlanItem[] = [];
  for (const [index, vm] of input.request.planItems.entries()) {
    // 每台 VM 使用独立安装源 ID，便于后续按任务追踪、清理和审计。
    const id = `${input.taskId}-${index + 1}-${randomUUID().slice(0, 8)}`;
    const sourceBaseUrl = hostLease.baseUrl;
    const repoUrl = `${sourceBaseUrl}/${encodeURIComponent(id)}/repo`;
    const ksUrl = `${sourceBaseUrl}/${encodeURIComponent(id)}/ks.cfg`;
    const installedUrl = `${sourceBaseUrl}/${encodeURIComponent(id)}/installed`;
    const record: InstallSourceRecord = {
      id,
      taskId: input.taskId,
      providerType: "xenserver",
      connection: input.connection,
      sourceIsoId: input.request.isoId ?? "",
      sourceIsoName: input.request.isoName ?? "",
      installMediaMode,
      vm,
      ipPool: input.request.ipPool,
      repoUrl,
      ksUrl,
      installedUrl,
      xenHostPort: hostLease.port,
      sourceInfo,
      createdAt: new Date().toISOString(),
      fetchedKickstart: false,
      startedPackageInstall: false,
      packageDone: 0,
      packagePaths: new Set<string>(),
      completedGuestInstall: false,
    };
    installSourceRecords.set(id, record);
    xenHostInstallLeases.get(input.taskId)?.sourceIds.push(id);
    await publishKickstartToXenHost(input.connection, record);
    planItems.push({
      ...vm,
      installSource: {
        id,
        taskId: input.taskId,
        repoUrl,
        ksUrl,
        installedUrl,
      },
    });
  }
  return {
    ...input.request,
    planItems,
  };
}

export async function cleanupXenInstallSources(taskId: string): Promise<void> {
  const lease = xenHostInstallLeases.get(taskId);
  const sourceIds = Array.from(installSourceRecords.values())
    .filter((source) => source.taskId === taskId)
    .map((source) => source.id);
  for (const sourceId of sourceIds) {
    installSourceRecords.delete(sourceId);
  }
  if (!lease) return;
  xenHostInstallLeases.delete(taskId);
  await cleanupXenHostInstallSource(lease.connection, taskId, lease.port, Array.from(new Set([...lease.sourceIds, ...sourceIds])), lease.vmCidr).catch(() => undefined);
}

export function shouldUseXenKickstart(request: VmProvisionRequest): boolean {
  const sourceName = `${request.isoName ?? ""} ${request.templateName ?? ""} ${request.isoId ?? ""}`.toLowerCase();
  return (
    request.providerType === "xenserver" &&
    request.sourceType === "iso" &&
    sourceName.includes("centos") &&
    ["http-boot-iso", "cdrom-http-ks", "native-http"].includes(resolveXenInstallMediaMode())
  );
}

async function allocateXenHostInstallSource(
  connection: XenConnectionInput,
  request: VmProvisionRequest,
  taskId: string,
): Promise<{ baseUrl: string; port: string } | undefined> {
  if (!request.hostId) return undefined;
  const existingLease = xenHostInstallLeases.get(taskId);
  if (existingLease) {
    const installHost = await resolveXenHostInstallHost(connection, request);
    return installHost ? { baseUrl: `http://${installHost}:${existingLease.port}`, port: existingLease.port } : undefined;
  }
  const installHost = await resolveXenHostInstallHost(connection, request);
  if (!installHost) return undefined;
  const port = await allocateXenHostInstallSourcePort(connection, taskId);
  xenHostInstallLeases.set(taskId, { connection, port, sourceIds: [], vmCidr: request.ipPool.cidr?.trim() || undefined });
  return { baseUrl: `http://${installHost}:${port}`, port };
}

async function resolveXenHostInstallHost(connection: XenConnectionInput, request: VmProvisionRequest): Promise<string | undefined> {
  if (!request.hostId) return undefined;
  return findXenHostIpInVmNetwork(connection, request.hostId, request.ipPool.cidr, request.planItems.map((item) => item.ip)).catch(() => undefined);
}

async function allocateXenHostInstallSourcePort(connection: XenConnectionInput, taskId: string): Promise<string> {
  const output = await runRemoteCommand(
    connection,
    buildXenHostPortAllocationScript(taskId, Array.from(xenHostInstallLeases.keys()), xenHostInstallSourceStartPort, xenHostInstallSourcePortCount),
    45000,
    "allocate-xen-host-install-source-port",
  );
  const line = output.split(/\r?\n/).find((item) => item.startsWith("PORT\t"));
  const port = line?.split("\t")[1];
  if (!port) throw new Error("未能分配 XenServer Kickstart HTTP 端口。");
  return port;
}

async function findXenHostIpInVmNetwork(connection: XenConnectionInput, hostId: string, cidr: string | undefined, vmIps: string[]): Promise<string | undefined> {
  const output = await runRemoteCommand(
    connection,
    [
      `host_uuid='${escapeShellValue(hostId)}'`,
      'for pif_uuid in $(xe pif-list host-uuid="$host_uuid" --minimal 2>/dev/null | tr "," " "); do',
      '  device="$(xe pif-param-get uuid="$pif_uuid" param-name=device 2>/dev/null | tr -d "[:space:]")"',
      '  ip="$(xe pif-param-get uuid="$pif_uuid" param-name=IP 2>/dev/null | tr -d "[:space:]")"',
      '  management="$(xe pif-param-get uuid="$pif_uuid" param-name=management 2>/dev/null | tr -d "[:space:]")"',
      '  [ -n "$ip" ] && [ "$ip" != "<notindatabase>" ] && [ "$ip" != "<notinatabase>" ] && printf "IP\\t%s\\t%s\\n" "$ip" "$management"',
      '  for iface in "$device" "xenbr${device#eth}"; do',
      '    [ -n "$iface" ] || continue',
      '    ip -4 -o addr show dev "$iface" 2>/dev/null | awk \'{ split($4, a, "/"); if (a[1] != "") printf "IP\\t%s\\tfalse\\n", a[1] }\'',
      '  done',
      'done',
    ].join("\n"),
    45000,
    "find-xen-host-ip-in-vm-network",
  );
  const candidates = output
    .split(/\r?\n/)
    .filter((line) => line.startsWith("IP\t"))
    .map((line) => {
      const [, ip, management] = line.split("\t");
      return { ip, management: management === "true" };
    });
  return selectXenInstallHostAddress(candidates, cidr, vmIps);
}

/** Checks the target XenServer host route and ICMP reachability without changing host network state. */
export async function probeXenProvisioningNetwork(input: {
  connection: XenConnectionInput;
  hostId: string;
  cidr: string;
  gateway: string;
  sampleIp: string;
  occupiedIps: string[];
}): Promise<XenProvisioningNetworkProbe> {
  const installHost = await findXenHostIpInVmNetwork(input.connection, input.hostId, input.cidr, [input.sampleIp]);
  if (!installHost) {
    return {
      status: "unreachable",
      message: "目标 XenServer 物理机没有可用于发布安装源的 IPv4 地址。",
      routeAvailable: false,
      gatewayReachable: false,
    };
  }
  if (isXenInstallHostInProvisioningNetwork(installHost, input.cidr)) {
    return {
      status: "reachable",
      message: `目标宿主机 ${installHost} 与 ${input.cidr} 处于同一网段，已直接通过网络校验。`,
      installHost,
      routeAvailable: true,
      gatewayReachable: false,
    };
  }
  const pingTargets = Array.from(
    new Set([
      input.gateway,
      ...input.occupiedIps.filter((ip) => isIpv4(ip) && cidrContainsIp(input.cidr, ip)),
    ].filter(isIpv4)),
  ).slice(0, 4);
  const output = await runRemoteCommand(
    input.connection,
    [
      `route_target='${escapeShellValue(input.sampleIp)}'`,
      `ping_targets='${escapeShellValue(pingTargets.join(" "))}'`,
      'if ip route get "$route_target" >/dev/null 2>&1; then printf "ROUTE\\ttrue\\n"; else printf "ROUTE\\tfalse\\n"; fi',
      'if command -v ping >/dev/null 2>&1; then',
      '  for target in $ping_targets; do',
      '    if ping -c 1 -W 1 "$target" >/dev/null 2>&1; then printf "PING\\t%s\\n" "$target"; fi',
      '  done',
      'fi',
    ].join("\n"),
    15000,
    "probe-xen-provisioning-network",
  );
  const routeAvailable = output.split(/\r?\n/).some((line) => line === "ROUTE\ttrue");
  const respondingTarget = output
    .split(/\r?\n/)
    .find((line) => line.startsWith("PING\t"))
    ?.split("\t")[1];
  const gatewayReachable = output.split(/\r?\n/).some((line) => line === `PING\t${input.gateway}`);
  return summarizeXenProvisioningNetworkProbe({
    cidr: input.cidr,
    sampleIp: input.sampleIp,
    installHost,
    routeAvailable,
    gatewayReachable,
    respondingTarget,
  });
}

/** Returns whether the selected XenServer host address already belongs to the VM provisioning network. */
export function isXenInstallHostInProvisioningNetwork(installHost: string, cidr: string): boolean {
  return cidrContainsIp(cidr, installHost);
}

/** Converts route and ICMP evidence into the creation policy used by the API and UI. */
export function summarizeXenProvisioningNetworkProbe(input: {
  cidr: string;
  sampleIp: string;
  installHost: string;
  routeAvailable: boolean;
  gatewayReachable: boolean;
  respondingTarget?: string;
}): XenProvisioningNetworkProbe {
  if (!input.routeAvailable) {
    return {
      status: "unreachable",
      message: `目标宿主机 ${input.installHost} 未找到到 ${input.sampleIp} 的路由，请检查 IP 池 CIDR、网关和物理网络。`,
      installHost: input.installHost,
      routeAvailable: false,
      gatewayReachable: input.gatewayReachable,
    };
  }
  if (input.respondingTarget) {
    return {
      status: "reachable",
      message: `目标宿主机 ${input.installHost} 可路由至 ${input.cidr}，${input.respondingTarget} Ping 有响应。`,
      installHost: input.installHost,
      routeAvailable: true,
      gatewayReachable: input.gatewayReachable,
      respondingTarget: input.respondingTarget,
    };
  }
  return {
    status: "route-only",
    message: `目标宿主机 ${input.installHost} 已存在到 ${input.cidr} 的路由，但网关和现有节点未响应 ICMP；可能已禁用 Ping，允许继续创建。`,
    installHost: input.installHost,
    routeAvailable: true,
    gatewayReachable: false,
  };
}

/** Prefers a VM-subnet address and otherwise uses the target host management address on routed networks. */
export function selectXenInstallHostAddress(
  candidates: XenInstallHostAddressCandidate[],
  cidr: string | undefined,
  vmIps: string[],
): string | undefined {
  const unique = Array.from(
    candidates
      .filter((candidate) => isIpv4(candidate.ip))
      .reduce((items, candidate) => {
        const current = items.get(candidate.ip);
        items.set(candidate.ip, { ip: candidate.ip, management: Boolean(current?.management || candidate.management) });
        return items;
      }, new Map<string, XenInstallHostAddressCandidate>())
      .values(),
  );
  const sameSubnet = unique.find(
    (candidate) => (cidr && cidrContainsIp(cidr, candidate.ip)) || vmIps.some((vmIp) => sameIpv4Subnet(vmIp, candidate.ip, 24)),
  );
  return sameSubnet?.ip ?? unique.find((candidate) => candidate.management)?.ip ?? unique[0]?.ip;
}

async function publishKickstartToXenHost(connection: XenConnectionInput, source: InstallSourceRecord): Promise<void> {
  const sourceDir = `${xenHostInstallSourceRoot}/${source.id}`;
  console.info(`[install-source] publish start task=${source.taskId} source=${source.id} vm=${source.vm.name}`);
  const sourceInfo = source.sourceInfo ?? (await readXenSourceIsoInfo(connection, source.sourceIsoId));
  source.sourceInfo = sourceInfo;
  if (!source.xenHostPort) throw new Error("XenServer 物理机安装源缺少端口租约。");
  console.info(`[install-source] start xen host http task=${source.taskId} source=${source.id} port=${source.xenHostPort}`);
  await runRemoteCommand(
    connection,
    [
      `root_dir='${escapeShellValue(xenHostInstallSourceRoot)}'`,
      `source_dir='${escapeShellValue(sourceDir)}'`,
      `repo_dir='${escapeShellValue(sourceInfo.mountDir)}'`,
      `port='${escapeShellValue(source.xenHostPort)}'`,
      `task_id='${escapeShellValue(source.taskId)}'`,
      `allowed_cidr='${escapeShellValue(source.ipPool.cidr || "")}'`,
      'pid_file="$root_dir/ports/$port.pid"',
      'starter="/tmp/vrc-install-source-start-$port.sh"',
      'server_script="/tmp/vrc-install-source-http-$port.py"',
      'mkdir -p "$source_dir"',
      'printf "" > "$source_dir/installed"',
      "cat > \"$source_dir/installed-hook.sh\" <<'VRC_HOOK'",
      ...buildXenInstalledHook(source.vm.name).split("\n"),
      'VRC_HOOK',
      'chmod 700 "$source_dir/installed-hook.sh"',
      'rm -f "$source_dir/repo"',
      'ln -s "$repo_dir" "$source_dir/repo"',
      'if command -v python >/dev/null 2>&1; then py=python; else echo "XenServer 物理机缺少 python，无法提供 Kickstart HTTP 服务" >&2; exit 7; fi',
      'if [ -s "$pid_file" ] && kill -0 "$(cat "$pid_file")" >/dev/null 2>&1; then',
      '  :',
      'else',
      "  cat > \"$server_script\" <<'PYHTTP'",
      'import BaseHTTPServer, os, posixpath, urllib, mimetypes, subprocess, sys',
      'ROOT = os.path.abspath(sys.argv[1])',
      'PORT = int(sys.argv[2])',
      'class Handler(BaseHTTPServer.BaseHTTPRequestHandler):',
      '    server_version = "VRCInstallHTTP/1.0"',
      '    def translate_path(self, path):',
      '        path = path.split("?", 1)[0].split("#", 1)[0]',
      '        path = posixpath.normpath(urllib.unquote(path))',
      '        words = [w for w in path.split("/") if w and w not in (os.curdir, os.pardir)]',
      '        result = ROOT',
      '        for word in words:',
      '            result = os.path.join(result, word)',
      '        return result',
      '    def do_HEAD(self):',
      '        f = self.send_head()',
      '        if f: f.close()',
      '    def do_GET(self):',
      '        f = self.send_head()',
      '        if not f: return',
      '        try:',
      '            while True:',
      '                chunk = f.read(1024 * 256)',
      '                if not chunk: break',
      '                self.wfile.write(chunk)',
      '        except Exception:',
      '            pass',
      '        try:',
      '            f.close()',
      '        except Exception:',
      '            pass',
      '    def send_head(self):',
      '        path = self.translate_path(self.path)',
      '        if os.path.isdir(path):',
      '            path = os.path.join(path, "index.html")',
      '        if not os.path.isfile(path):',
      '            self.send_error(404, "File not found")',
      '            return None',
      '        if os.path.basename(path) == "installed":',
      '            hook = os.path.join(os.path.dirname(path), "installed-hook.sh")',
      '            lock = hook + ".done"',
      '            acquired = False',
      '            try:',
      '                fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0600)',
      '                os.close(fd)',
      '                acquired = True',
      '            except OSError:',
      '                pass',
      '            if acquired and os.path.isfile(hook):',
      '                if subprocess.call([hook]) != 0:',
      '                    try: os.unlink(lock)',
      '                    except OSError: pass',
      '                    self.send_error(500, "Install completion hook failed")',
      '                    return None',
      '        size = os.path.getsize(path)',
      '        start = 0',
      '        end = size - 1',
      '        status = 200',
      '        range_header = self.headers.get("Range")',
      '        if range_header and range_header.startswith("bytes="):',
      '            first = range_header[6:].split(",", 1)[0].strip()',
      '            parts = first.split("-", 1)',
      '            try:',
      '                if parts[0] == "":',
      '                    suffix = int(parts[1])',
      '                    start = max(size - suffix, 0)',
      '                else:',
      '                    start = int(parts[0])',
      '                if len(parts) > 1 and parts[1] != "":',
      '                    end = min(int(parts[1]), size - 1)',
      '                if start <= end and start < size:',
      '                    status = 206',
      '                else:',
      '                    start = 0; end = size - 1',
      '            except Exception:',
      '                start = 0; end = size - 1',
      '        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"',
      '        f = open(path, "rb")',
      '        f.seek(start)',
      '        self.send_response(status)',
      '        self.send_header("Content-Type", ctype)',
      '        self.send_header("Accept-Ranges", "bytes")',
      '        self.send_header("Content-Length", str(end - start + 1))',
      '        if status == 206:',
      '            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))',
      '        self.end_headers()',
      '        return f',
      'BaseHTTPServer.HTTPServer(("", PORT), Handler).serve_forever()',
      'PYHTTP',
      "  cat > \"$starter\" <<'EOF'",
      '#!/bin/sh',
      'cd "$1" || exit 7',
      'shift',
      'exec "$@"',
      'EOF',
      '  chmod 700 "$starter"',
      '  if command -v setsid >/dev/null 2>&1; then',
      '    setsid sh "$starter" "$root_dir" "$py" "$server_script" "$root_dir" "$port" </dev/null >/tmp/vrc-install-source-$port.log 2>&1 &',
      '  else',
      '    nohup sh "$starter" "$root_dir" "$py" "$server_script" "$root_dir" "$port" </dev/null >/tmp/vrc-install-source-$port.log 2>&1 &',
      '  fi',
      '  printf "%s\\n" "$!" > "$pid_file"',
      '  printf "%s\\n" "$task_id" > "$root_dir/ports/$port.owner"',
      '  sleep 0.5',
      'fi',
      '[ -s "$pid_file" ] && kill -0 "$(cat "$pid_file")" >/dev/null 2>&1 || { echo "XenServer 物理机 Kickstart HTTP 服务启动失败，详见 /tmp/vrc-install-source-$port.log" >&2; exit 7; }',
      'if [ -n "$allowed_cidr" ] && command -v iptables >/dev/null 2>&1; then',
      '  firewall_chain=INPUT',
      '  iptables -L RH-Firewall-1-INPUT -n >/dev/null 2>&1 && firewall_chain=RH-Firewall-1-INPUT',
      '  iptables -C "$firewall_chain" -p tcp -s "$allowed_cidr" --dport "$port" -j ACCEPT >/dev/null 2>&1 || iptables -I "$firewall_chain" 1 -p tcp -s "$allowed_cidr" --dport "$port" -j ACCEPT >/dev/null 2>&1 || true',
      'fi',
    ].join("\n"),
    45000,
    `publish-xen-host-http:${source.id}`,
  );
  console.info(`[install-source] upload kickstart task=${source.taskId} source=${source.id}`);
  await uploadTextFile(connection, `${sourceDir}/ks.cfg`, buildKickstart(source));
  console.info(`[install-source] publish ready task=${source.taskId} source=${source.id} url=${source.ksUrl}`);
}

function buildXenHostPortAllocationScript(taskId: string, activeTaskIds: string[], startPort: string, portCount: number): string {
  const safePortCount = Number.isFinite(portCount) && portCount > 0 ? Math.min(Math.floor(portCount), 100) : 20;
  return [
    `root_dir='${escapeShellValue(xenHostInstallSourceRoot)}'`,
    `task_id='${escapeShellValue(taskId)}'`,
    `active_task_ids='${escapeShellValue(activeTaskIds.join(" "))}'`,
    `start_port='${escapeShellValue(startPort)}'`,
    `port_count='${safePortCount}'`,
    'mkdir -p "$root_dir/ports"',
    'is_number() { case "$1" in ""|*[!0-9]*) return 1;; *) return 0;; esac; }',
    'is_vrc_pid() {',
    '  pid="$1"',
    '  port="$2"',
    '  [ -n "$pid" ] && kill -0 "$pid" >/dev/null 2>&1 || return 1',
    '  cmd="$(ps -p "$pid" -o args= 2>/dev/null || true)"',
    '  printf "%s" "$cmd" | grep -q "http.server\\|SimpleHTTPServer\\|vrc-install-source-http" || return 1',
    '  printf "%s" "$cmd" | grep -q "$port" || return 1',
    '  return 0',
    '}',
    'port_busy() {',
    '  port="$1"',
    '  (netstat -lnt 2>/dev/null || ss -lnt 2>/dev/null || true) | awk -v port="$port" \'{ n = split($4, address, ":"); if (address[n] == port) found=1 } END { exit found ? 0 : 1 }\'',
    '}',
    'is_active_task() {',
    '  needle="$1"',
    '  for active_task_id in $active_task_ids; do [ "$active_task_id" = "$needle" ] && return 0; done',
    '  return 1',
    '}',
    'has_task_sources() {',
    '  owner="$1"',
    '  find "$root_dir" -maxdepth 1 -type d -name "$owner-*" 2>/dev/null | grep -q .',
    '}',
    'for offset in $(seq 0 $((port_count - 1))); do',
    '  port=$((start_port + offset))',
    '  pid_file="$root_dir/ports/$port.pid"',
    '  owner_file="$root_dir/ports/$port.owner"',
    '  pid="$(cat "$pid_file" 2>/dev/null || true)"',
    '  owner="$(cat "$owner_file" 2>/dev/null || true)"',
    '  if [ "$owner" = "$task_id" ] && is_number "$pid" && is_vrc_pid "$pid" "$port"; then',
    '    printf "PORT\\t%s\\n" "$port"',
    '    exit 0',
    '  fi',
    '  if [ -n "$owner" ] && [ "$owner" != "$task_id" ] && is_number "$pid" && is_vrc_pid "$pid" "$port"; then',
    '    if ! is_active_task "$owner" && ! has_task_sources "$owner"; then',
    '      kill "$pid" >/dev/null 2>&1 || true',
    '      rm -f "$pid_file" "$owner_file"',
    '    else',
    '      continue',
    '    fi',
    '  fi',
    '  if [ -n "$owner" ] && is_number "$pid" && ! is_vrc_pid "$pid" "$port"; then',
    '    rm -f "$pid_file" "$owner_file"',
    '  fi',
    '  if port_busy "$port"; then',
    '    continue',
    '  fi',
    '  printf "%s\\n" "$task_id" > "$owner_file"',
    '  rm -f "$pid_file"',
    '  printf "PORT\\t%s\\n" "$port"',
    '  exit 0',
    'done',
    'echo "XenServer 物理机没有可用 Kickstart HTTP 端口；已避开非 VRC 占用端口和其他任务端口" >&2',
    'exit 8',
  ].join("\n");
}

async function cleanupXenHostInstallSource(connection: XenConnectionInput, taskId: string, port: string, sourceIds: string[], vmCidr?: string): Promise<void> {
  await runRemoteCommand(
    connection,
    [
      `root_dir='${escapeShellValue(xenHostInstallSourceRoot)}'`,
      `task_id='${escapeShellValue(taskId)}'`,
      `port='${escapeShellValue(port)}'`,
      `source_ids='${escapeShellValue(sourceIds.join(" "))}'`,
      `allowed_cidr='${escapeShellValue(vmCidr || "")}'`,
      'pid_file="$root_dir/ports/$port.pid"',
      'owner_file="$root_dir/ports/$port.owner"',
      'owner="$(cat "$owner_file" 2>/dev/null || true)"',
      'pid="$(cat "$pid_file" 2>/dev/null || true)"',
      'for source_id in $source_ids; do',
      '  case "$source_id" in *[!A-Za-z0-9_.-]*) continue;; esac',
      '  rm -rf "$root_dir/$source_id"',
      'done',
      '[ "$owner" = "$task_id" ] || exit 0',
      'if [ -n "$pid" ] && kill -0 "$pid" >/dev/null 2>&1; then',
      '  cmd="$(ps -p "$pid" -o args= 2>/dev/null || true)"',
      '  if printf "%s" "$cmd" | grep -q "http.server\\|SimpleHTTPServer\\|vrc-install-source-http" && printf "%s" "$cmd" | grep -q "$port"; then',
      '    kill "$pid" >/dev/null 2>&1 || true',
      '  fi',
      'fi',
      'if [ -n "$allowed_cidr" ] && command -v iptables >/dev/null 2>&1; then',
      '  firewall_chain=INPUT',
      '  iptables -L RH-Firewall-1-INPUT -n >/dev/null 2>&1 && firewall_chain=RH-Firewall-1-INPUT',
      '  while iptables -C "$firewall_chain" -p tcp -s "$allowed_cidr" --dport "$port" -j ACCEPT >/dev/null 2>&1; do',
      '    iptables -D "$firewall_chain" -p tcp -s "$allowed_cidr" --dport "$port" -j ACCEPT >/dev/null 2>&1 || break',
      '  done',
      'fi',
      'rm -f "$pid_file" "$owner_file"',
    ].join("\n"),
  );
}

async function sendRepoFile(source: InstallSourceRecord, repoPath: string, request: FastifyRequest, reply: FastifyReply) {
  const safePath = sanitizeRepoPath(repoPath);
  if (!safePath) return reply.status(400).send({ message: "安装源路径不合法。" });
  try {
    const localPath = await ensureRepoFileCached(source, safePath);
    if (isPackageRpmPath(safePath)) {
      await trackPackageInstallProgress(source, safePath);
    }
    return sendStaticRepoFile(localPath, safePath, request, reply);
  } catch (error) {
    return reply.status(404).send({
      message: error instanceof Error ? error.message : "安装源文件不存在。",
    });
  }
}

async function trackPackageInstallProgress(source: InstallSourceRecord, packagePath: string): Promise<void> {
  if (!source.startedPackageInstall) {
    source.startedPackageInstall = true;
    markProvisionTaskStep(source.taskId, "install-guest", "running", "系统安装器正在安装软件包");
  }
  if (source.packageTotal === undefined) {
    source.packageTotal = await countSourceRpms(source);
  }
  if (source.packagePaths.has(packagePath)) return;
  source.packagePaths.add(packagePath);
  source.packageDone = source.packagePaths.size;

  const progressPercent = packageInstallProgressPercent(source.packageDone, source.packageTotal);
  const totalText = source.packageTotal > 0 ? `/${source.packageTotal}` : "";
  const message = `系统安装器正在安装软件包 ${source.packageDone}${totalText}`;
  updateProvisionTaskVm(source.taskId, source.vm.name, {
    status: "running",
    currentStep: "install-guest",
    progressPercent,
    installPackageDone: source.packageDone,
    installPackageTotal: source.packageTotal,
    message,
  });
}

async function countSourceRpms(source: InstallSourceRecord): Promise<number> {
  try {
    const sourceInfo = source.sourceInfo ?? (await readXenSourceIsoInfo(source.connection, source.sourceIsoId));
    source.sourceInfo = sourceInfo;
    const output = await runRemoteCommand(
      source.connection,
      [
        `packages_dir='${escapeShellValue(`${sourceInfo.mountDir}/Packages`)}'`,
        '[ -d "$packages_dir" ] || { printf "0\\n"; exit 0; }',
        'find "$packages_dir" -type f -name "*.rpm" | wc -l',
      ].join("\n"),
    );
    const parsed = Number(output.trim().split(/\s+/)[0]);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
  } catch {
    return 0;
  }
}

function packageInstallProgressPercent(done: number, total: number): number {
  const installStartPercent = 50;
  const installEndPercent = 70;
  if (total <= 0) return installStartPercent;
  const ratio = Math.min(Math.max(done / total, 0), 1);
  return Math.round(installStartPercent + (installEndPercent - installStartPercent) * ratio);
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

export async function prepareXenVmForInstalledBoot(connection: XenConnectionInput, vmName: string): Promise<void> {
  await runRemoteCommand(
    connection,
    [
      `vm_name='${escapeShellValue(vmName)}'`,
      'vm_uuid="$(xe vm-list name-label="$vm_name" --minimal 2>/dev/null | tr "," " " | awk \'{print $1}\')"',
      '[ -n "$vm_uuid" ] || { echo "未找到已安装 VM：$vm_name" >&2; exit 6; }',
      'xe vm-param-set uuid="$vm_uuid" HVM-boot-params:order=c >/dev/null 2>&1 || true',
      'tools_iso=""',
      'for candidate in $(xe cd-list --minimal 2>/dev/null | tr "," " "); do',
      '  label="$(xe vdi-param-get uuid="$candidate" param-name=name-label 2>/dev/null | tr -d "\\r\\n")"',
      '  if [ "$label" = "xs-tools.iso" ] || [ "$label" = "guest-tools.iso" ]; then tools_iso="$candidate"; break; fi',
      'done',
      'if [ -n "$tools_iso" ]; then',
      '  cd_vbd="$(xe vbd-list vm-uuid="$vm_uuid" type=CD --minimal 2>/dev/null | tr "," " " | awk \'{print $1}\')"',
      '  if [ -n "$cd_vbd" ]; then',
      '    current_vdi="$(xe vbd-param-get uuid="$cd_vbd" param-name=vdi-uuid 2>/dev/null | tr -d "\\r\\n")"',
      '    if [ "$current_vdi" != "$tools_iso" ]; then',
      '      xe vbd-eject uuid="$cd_vbd" >/dev/null 2>&1 || { xe vbd-unplug uuid="$cd_vbd" force=true >/dev/null 2>&1 || true; xe vbd-eject uuid="$cd_vbd" >/dev/null 2>&1 || true; }',
      '      xe vbd-insert uuid="$cd_vbd" vdi-uuid="$tools_iso" >/dev/null',
      '    fi',
      '  else',
      '    cd_vbd="$(xe vbd-create vm-uuid="$vm_uuid" vdi-uuid="$tools_iso" device=3 bootable=false mode=RO type=CD)"',
      '  fi',
      '  attached="$(xe vbd-param-get uuid="$cd_vbd" param-name=currently-attached 2>/dev/null | tr -d "\\r\\n")"',
      '  [ "$attached" = "true" ] || xe vbd-plug uuid="$cd_vbd" >/dev/null 2>&1 || true',
      '  xe vm-param-set uuid="$vm_uuid" other-config:vrc-tools-media-ready=true >/dev/null 2>&1 || true',
      'fi',
      'xe vm-param-set uuid="$vm_uuid" other-config:vrc-install-complete=true >/dev/null 2>&1 || true',
    ].join("\n"),
  );
}

async function switchXenVmToDiskBoot(source: InstallSourceRecord): Promise<void> {
  await prepareXenVmForInstalledBoot(source.connection, source.vm.name);
}

async function readXenSourceIsoInfo(connection: XenConnectionInput, sourceIsoId: string): Promise<XenSourceIsoInfo> {
  const output = await runRemoteCommand(
    connection,
    [
      `iso_uuid='${escapeShellValue(sourceIsoId)}'`,
      'sr_uuid="$(xe vdi-param-get uuid="$iso_uuid" param-name=sr-uuid 2>/dev/null)"',
      'sr_type="$(xe sr-param-get uuid="$sr_uuid" param-name=type 2>/dev/null)"',
      'location="$(xe vdi-param-get uuid="$iso_uuid" param-name=location 2>/dev/null)"',
      'source_type="iso-library"',
      'if [ "$sr_type" = "udev" ] && printf "%s" "$location" | grep -q "^/dev/"; then source_type="host-dvd"; remote_path="$location"; else remote_path="/var/run/sr-mount/$sr_uuid/$location"; fi',
      'mount_dir="/tmp/vrc-source-iso-$iso_uuid"',
      '[ -e "$remote_path" ] || { echo "未找到源 ISO 介质：$remote_path" >&2; exit 6; }',
      'mkdir -p "$mount_dir"',
      'current_source="$(mount | awk -v dir="$mount_dir" \'$3 == dir {print $1; exit}\')"',
      '[ -z "$current_source" ] || [ "$current_source" = "$remote_path" ] || umount "$mount_dir" >/dev/null 2>&1 || true',
      'if ! mountpoint -q "$mount_dir"; then if [ "$source_type" = "host-dvd" ]; then mount -o ro "$remote_path" "$mount_dir"; else mount -o loop,ro "$remote_path" "$mount_dir"; fi; fi',
      '[ -f "$mount_dir/.treeinfo" ] || [ -d "$mount_dir/repodata" ] || { echo "源 ISO 不是可用安装源：$remote_path" >&2; exit 6; }',
      'printf "ISO\\t%s\\t%s\\t%s\\t%s\\t%s\\n" "$sr_uuid" "$location" "$remote_path" "$mount_dir" "$source_type"',
    ].join("\n"),
  );
  const line = output.split(/\r?\n/).find((item) => item.startsWith("ISO\t"));
  const [, srUuid = "", location = "", remotePath = "", mountDir = "", sourceType = "iso-library"] = line?.split("\t") ?? [];
  if (!srUuid || !location || !remotePath || !mountDir) {
    throw new Error("未读取到 XenServer 源 ISO 文件路径，无法发布安装源。");
  }
  return { srUuid, location, remotePath, mountDir, sourceType: sourceType === "host-dvd" ? "host-dvd" : "iso-library" };
}

function buildKickstart(source: InstallSourceRecord): string {
  const netmask = cidrToNetmask(source.ipPool.cidr) || "255.255.255.0";
  const dns = sanitizeKickstartValue(source.ipPool.dns[0] ?? "");
  const gateway = sanitizeKickstartValue(source.ipPool.gateway);
  const ip = sanitizeKickstartValue(source.vm.ip);
  const rootPassword = sanitizeKickstartValue(source.vm.rootPassword ?? "");
  const rootPasswordEntry = shellSingleQuote(`root:${rootPassword}`);
  const rootPasswordValue = shellSingleQuote(rootPassword || "changeme");
  const rootPasswordHashValue = md5Crypt(rootPassword || "changeme");
  const rootPasswordHash = shellSingleQuote(rootPasswordHashValue);
  const hostname = sanitizeKickstartValue(source.vm.name);
  const installedUrl = sanitizeKickstartValue(source.installedUrl);
  const installSourceLine = source.installMediaMode === "cdrom-http-ks" ? "cdrom" : `url --url="${source.repoUrl}"`;
  const rebootDirective = xenInstallRebootDirective(source.sourceInfo?.sourceType ?? "iso-library");
return `#version=DEVEL
install
text
${installSourceLine}
lang en_US.UTF-8
keyboard us
timezone Asia/Shanghai --isUtc
rootpw --iscrypted ${rootPasswordHashValue}
auth --enableshadow --passalgo=sha512
selinux --disabled
firewall --disabled
firstboot --disabled
network --bootproto=static --device=eth0 --ip=${ip} --netmask=${netmask} --gateway=${gateway} --nameserver=${dns} --hostname=${hostname} --onboot=on --activate
bootloader --location=mbr
${buildCentosLvmPartitioning(source.vm.diskGiB)}
${rebootDirective}
${buildCentosPackageSelection()}
%post --log=/root/vrc-kickstart-post.log
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
authconfig --enableshadow --passalgo=sha512 --update || true
printf '%s\\n' ${rootPasswordEntry} | chpasswd || true
printf '%s\\n' ${rootPasswordValue} | passwd --stdin root || true
usermod -p ${rootPasswordHash} root || true
passwd --unlock root || true
for key in PermitRootLogin PasswordAuthentication UsePAM; do
  case "$key" in
    PermitRootLogin) value=yes ;;
    PasswordAuthentication) value=yes ;;
    UsePAM) value=yes ;;
  esac
  if grep -Eq "^[#[:space:]]*$key[[:space:]]+" /etc/ssh/sshd_config; then
    sed -ri "s|^[#[:space:]]*$key[[:space:]]+.*|$key $value|" /etc/ssh/sshd_config
  else
    printf '%s %s\\n' "$key" "$value" >> /etc/ssh/sshd_config
  fi
done
systemctl enable network || true
systemctl disable firewalld || true
systemctl enable sshd
/usr/bin/python - <<'PY' || true
import urllib2
urllib2.urlopen('${installedUrl}', timeout=10).read()
PY
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

function isPackageRpmPath(path: string): boolean {
  return path.startsWith("Packages/") && path.endsWith(".rpm");
}

function safePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120) || "source";
}

function sanitizeKickstartValue(value: string): string {
  return value.replace(/[\r\n]/g, "").trim();
}

function md5Crypt(password: string, salt = "vrcinst"): string {
  const magic = "$1$";
  const normalizedSalt = salt.replace(/^\$1\$/, "").split("$")[0].slice(0, 8);
  const passwordBuffer = Buffer.from(password, "utf8");
  const saltBuffer = Buffer.from(normalizedSalt, "utf8");
  let ctx = Buffer.concat([passwordBuffer, Buffer.from(magic), saltBuffer]);
  const alternate = createHash("md5").update(passwordBuffer).update(saltBuffer).update(passwordBuffer).digest();
  for (let remaining = passwordBuffer.length; remaining > 0; remaining -= 16) {
    ctx = Buffer.concat([ctx, alternate.subarray(0, Math.min(16, remaining))]);
  }
  for (let i = passwordBuffer.length; i > 0; i >>= 1) {
    ctx = Buffer.concat([ctx, Buffer.from([i & 1 ? 0 : passwordBuffer[0]])]);
  }
  let final = createHash("md5").update(ctx).digest();
  for (let i = 0; i < 1000; i += 1) {
    let loop = Buffer.alloc(0);
    loop = Buffer.concat([loop, i & 1 ? passwordBuffer : final]);
    if (i % 3) loop = Buffer.concat([loop, saltBuffer]);
    if (i % 7) loop = Buffer.concat([loop, passwordBuffer]);
    loop = Buffer.concat([loop, i & 1 ? final : passwordBuffer]);
    final = createHash("md5").update(loop).digest();
  }
  return `${magic}${normalizedSalt}$${toCrypt64(final)}`;
}

function toCrypt64(final: Buffer): string {
  const alphabet = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const encode = (value: number, length: number) => {
    let result = "";
    for (let i = 0; i < length; i += 1) {
      result += alphabet[value & 0x3f];
      value >>= 6;
    }
    return result;
  };
  return [
    encode((final[0] << 16) | (final[6] << 8) | final[12], 4),
    encode((final[1] << 16) | (final[7] << 8) | final[13], 4),
    encode((final[2] << 16) | (final[8] << 8) | final[14], 4),
    encode((final[3] << 16) | (final[9] << 8) | final[15], 4),
    encode((final[4] << 16) | (final[10] << 8) | final[5], 4),
    encode(final[11], 2),
  ].join("");
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
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

function isIpv4(value: string | undefined): value is string {
  if (!value) return false;
  const parts = value.split(".");
  return (
    parts.length === 4 &&
    parts.every((part) => {
      if (!/^\d+$/.test(part)) return false;
      const parsed = Number(part);
      return parsed >= 0 && parsed <= 255 && String(parsed) === String(Number(part));
    })
  );
}

function cidrContainsIp(cidr: string, ip: string): boolean {
  const [baseIp, rawBits] = cidr.split("/");
  if (!isIpv4(baseIp) || !isIpv4(ip)) return false;
  const bits = Number(rawBits);
  if (!Number.isFinite(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToNumber(baseIp) & mask) === (ipv4ToNumber(ip) & mask);
}

function sameIpv4Subnet(left: string, right: string, bits: number): boolean {
  if (!isIpv4(left) || !isIpv4(right) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToNumber(left) & mask) === (ipv4ToNumber(right) & mask);
}

function ipv4ToNumber(ip: string): number {
  return ip
    .split(".")
    .map((part) => Number(part))
    .reduce((acc, part) => ((acc << 8) + part) >>> 0, 0);
}

function downloadFile(connection: XenConnectionInput, remotePath: string, localPath: string): Promise<void> {
  return withSftp(connection, (sftp) => new Promise((resolve, reject) => sftp.fastGet(remotePath, localPath, (error) => (error ? reject(error) : resolve()))));
}

function uploadTextFile(connection: XenConnectionInput, remotePath: string, content: string): Promise<void> {
  return withSftp(
    connection,
    (sftp) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`上传 Kickstart 文件超时：${remotePath}`)), 15000);
        sftp.writeFile(remotePath, content, { encoding: "utf8", mode: 0o644 }, (error) => {
          clearTimeout(timer);
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  );
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

function runRemoteCommand(connection: XenConnectionInput, command: string, timeoutMs = 45000, label = "remote-command"): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = createClient();
    let stdout = "";
    let stderr = "";
    let settled = false;
    const startedAt = Date.now();
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.end();
      callback();
    };
    const timer = setTimeout(() => {
      settle(() => reject(new Error(`XenServer command timed out in ${label} after ${timeoutMs}ms`)));
    }, timeoutMs);
    client
      .on("ready", () => {
        console.info(`[xen-ssh] start ${label}`);
        client.exec(command, (error, stream) => {
          if (error) {
            settle(() => reject(error));
            return;
          }
          stream
            .on("close", (code: number) => {
              console.info(`[xen-ssh] done ${label} code=${code} durationMs=${Date.now() - startedAt}`);
              if (code !== 0) {
                settle(() => reject(new Error(stderr || `XenServer command exited with code ${code}`)));
                return;
              }
              settle(() => resolve(stdout));
            })
            .on("data", (data: Buffer) => {
              stdout += data.toString("utf8");
            })
            .stderr.on("data", (data: Buffer) => {
              stderr += data.toString("utf8");
            });
        });
      })
      .on("error", (error) => {
        settle(() => reject(error));
      })
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
