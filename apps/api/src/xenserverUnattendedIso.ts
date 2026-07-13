import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { Client } from "ssh2";
import type { ConnectConfig, SFTPWrapper } from "ssh2";
import { getGeneratedIso, markGeneratedIsoStatus, markGeneratedIsoUploaded, registerGeneratedIso } from "./generatedIsoStore.js";
import type { IpPoolConfig, VmProvisionInstallSourceRef, VmProvisionPlanItem, XenConnectionInput } from "./types.js";

const execFileAsync = promisify(execFile);
const cacheDir = join(homedir(), ".virtual-resource-console", "iso-cache");
const generatedDir = join(homedir(), ".virtual-resource-console", "generated-isos");
const centosBootIsoLabel = "VRCCENTOS7";

export type XenInstallMediaMode = "offline-iso" | "http-boot-iso";

interface SourceIsoInfo {
  srUuid: string;
  location: string;
  remotePath: string;
  mountDir: string;
  sizeBytes: number;
}

export interface XenUnattendedIsoInput {
  connection: XenConnectionInput;
  sourceIsoId: string;
  sourceIsoName: string;
  hostId?: string;
  vm: VmProvisionPlanItem;
  ipPool: IpPoolConfig;
  macAddress?: string;
  installSource?: VmProvisionInstallSourceRef;
}

export interface XenUnattendedIsoResult {
  isoId: string;
  isoName: string;
  registryId?: string;
}

// 默认使用离线自包含 ISO，避免新 VM 安装阶段依赖开发机或临时 HTTP 地址。
export function resolveXenInstallMediaMode(): XenInstallMediaMode {
  const rawMode = process.env.VRC_XEN_INSTALL_MEDIA_MODE?.trim().toLowerCase();
  if (rawMode === "http" || rawMode === "http-boot" || rawMode === "http-boot-iso") return "http-boot-iso";
  return "offline-iso";
}

export async function prepareXenCentosUnattendedIso(input: XenUnattendedIsoInput): Promise<XenUnattendedIsoResult> {
  ensureDir(cacheDir);
  ensureDir(generatedDir);
  await assertIsoGeneratorAvailable();
  const mediaMode = resolveXenInstallMediaMode();
  const source = await readSourceIsoInfo(input.connection, input.sourceIsoId, mediaMode === "http-boot-iso");
  const isoName = `vrc-${safeFileName(input.vm.name)}-unattended-${Date.now().toString(36)}.iso`;
  const remotePath = `${dirname(source.remotePath)}/${isoName}`;
  const registry = registerGeneratedIso({
    taskId: input.installSource?.taskId || input.installSource?.id || `xen-offline-${Date.now().toString(36)}`,
    providerType: "xenserver",
    connectionId: undefined,
    hostId: input.hostId,
    vmName: input.vm.name,
    vmIp: input.vm.ip,
    sourceIsoId: input.sourceIsoId,
    sourceIsoName: input.sourceIsoName,
    isoSrUuid: source.srUuid,
    isoName,
    isoPath: remotePath,
  });
  try {
    const localOutputIso = join(generatedDir, isoName);
    if (mediaMode === "offline-iso") {
      const localSourceIso = await ensureLocalSourceIso(input.connection, source);
      await generateCentosOfflineUnattendedIso(localSourceIso, localOutputIso, input);
    } else {
      const bootFiles = await ensureLocalBootFiles(input.connection, source);
      await generateCentosHttpBootIso(bootFiles, localOutputIso, input);
    }
    await uploadIso(input.connection, localOutputIso, remotePath);
    const isoId = await scanAndFindUploadedIso(input.connection, source.srUuid, isoName);
    await markGeneratedIsoOnXen(input.connection, {
      isoId,
      registryId: registry.id,
      taskId: registry.taskId,
      vmName: input.vm.name,
    });
    markGeneratedIsoUploaded(registry.id, {
      isoVdiUuid: isoId,
      message: "无人值守 ISO 已上传并登记",
    });
    return {
      isoId,
      isoName,
      registryId: registry.id,
    };
  } catch (error) {
    markGeneratedIsoStatus(registry.id, "failed", error instanceof Error ? error.message : "无人值守 ISO 生成失败");
    throw error;
  }
}

export async function cleanupRegisteredXenGeneratedIso(connection: XenConnectionInput, registryId: string): Promise<void> {
  const record = getGeneratedIso(registryId);
  if (!record) throw new Error(`未找到生成 ISO 登记记录：${registryId}`);
  if (record.providerType !== "xenserver") throw new Error(`生成 ISO 不是 XenServer 类型：${registryId}`);
  if (!record.isoVdiUuid) throw new Error(`生成 ISO 尚未登记 VDI UUID：${registryId}`);
  await runRemoteCommand(
    connection,
    [
      `iso_uuid='${escapeShellValue(record.isoVdiUuid)}'`,
      `expected_name='${escapeShellValue(record.isoName)}'`,
      `expected_registry='${escapeShellValue(record.id)}'`,
      `expected_task='${escapeShellValue(record.taskId)}'`,
      'actual_name="$(xe vdi-param-get uuid="$iso_uuid" param-name=name-label 2>/dev/null)"',
      'actual_generated="$(xe vdi-param-get uuid="$iso_uuid" param-name=other-config param-key=vrc-generated 2>/dev/null)"',
      'actual_registry="$(xe vdi-param-get uuid="$iso_uuid" param-name=other-config param-key=vrc-registry-id 2>/dev/null)"',
      'actual_task="$(xe vdi-param-get uuid="$iso_uuid" param-name=other-config param-key=vrc-task-id 2>/dev/null)"',
      '[ "$actual_name" = "$expected_name" ] || { echo "生成 ISO 名称不匹配，拒绝删除" >&2; exit 8; }',
      '[ "$actual_generated" = "true" ] || { echo "VDI 缺少 vrc-generated 标记，拒绝删除" >&2; exit 8; }',
      '[ "$actual_registry" = "$expected_registry" ] || { echo "VDI registry 标记不匹配，拒绝删除" >&2; exit 8; }',
      '[ "$actual_task" = "$expected_task" ] || { echo "VDI task 标记不匹配，拒绝删除" >&2; exit 8; }',
      'attached="$(xe vbd-list vdi-uuid="$iso_uuid" currently-attached=true --minimal 2>/dev/null)"',
      '[ -z "$attached" ] || { echo "生成 ISO 仍被 VM 挂载，拒绝删除" >&2; exit 8; }',
      'xe vdi-destroy uuid="$iso_uuid"',
    ].join("\n"),
  );
  markGeneratedIsoStatus(registryId, "deleted", "生成 ISO 已按登记记录清理");
}

async function readSourceIsoInfo(connection: XenConnectionInput, sourceIsoId: string, mountForBootFiles: boolean): Promise<SourceIsoInfo> {
  const output = await runRemoteCommand(
    connection,
    [
      `iso_uuid='${escapeShellValue(sourceIsoId)}'`,
      'sr_uuid="$(xe vdi-param-get uuid="$iso_uuid" param-name=sr-uuid 2>/dev/null)"',
      'location="$(xe vdi-param-get uuid="$iso_uuid" param-name=location 2>/dev/null)"',
      'remote_path="/var/run/sr-mount/$sr_uuid/$location"',
      'mount_dir="/tmp/vrc-source-iso-$iso_uuid"',
      '[ -f "$remote_path" ] || { echo "未找到源 ISO 文件：$remote_path" >&2; exit 6; }',
      mountForBootFiles
        ? [
            'mkdir -p "$mount_dir"',
            'current_source="$(mount | awk -v dir="$mount_dir" \'$3 == dir {print $1; exit}\')"',
            '[ -z "$current_source" ] || [ "$current_source" = "$remote_path" ] || umount "$mount_dir" >/dev/null 2>&1 || true',
            'mountpoint -q "$mount_dir" || mount -o loop,ro "$remote_path" "$mount_dir"',
            '[ -f "$mount_dir/isolinux/isolinux.bin" ] || { echo "源 ISO 缺少 isolinux.bin" >&2; exit 6; }',
            '[ -f "$mount_dir/isolinux/vmlinuz" ] || [ -f "$mount_dir/images/pxeboot/vmlinuz" ] || { echo "源 ISO 缺少 vmlinuz" >&2; exit 6; }',
            '[ -f "$mount_dir/isolinux/initrd.img" ] || [ -f "$mount_dir/images/pxeboot/initrd.img" ] || { echo "源 ISO 缺少 initrd.img" >&2; exit 6; }',
          ].join("\n")
        : 'mount_dir=""',
      'printf "SIZE\\t%s\\n" "$(stat -c %s "$remote_path" 2>/dev/null || wc -c < "$remote_path")"',
      'printf "ISO\\t%s\\t%s\\t%s\\t%s\\n" "$sr_uuid" "$location" "$remote_path" "$mount_dir"',
    ].join("\n"),
  );
  const line = output.split(/\r?\n/).find((item) => item.startsWith("ISO\t"));
  const [, srUuid = "", location = "", remotePath = "", mountDir = ""] = line?.split("\t") ?? [];
  if (!srUuid || !location || !remotePath) {
    throw new Error("未读取到 XenServer 源 ISO 文件路径，无法生成无人值守 ISO。");
  }
  return {
    srUuid,
    location,
    remotePath,
    mountDir,
    sizeBytes: Number(output.split(/\r?\n/).find((item) => item.startsWith("SIZE\t"))?.split("\t")[1]) || 0,
  };
}

interface LocalBootFiles {
  isolinuxBin: string;
  vmlinuz: string;
  initrd: string;
  squashfs: string;
  treeInfo: string;
  discInfo: string;
  buildTag: string;
}

async function ensureLocalBootFiles(connection: XenConnectionInput, source: SourceIsoInfo): Promise<LocalBootFiles> {
  const sourceKey = `${safeFileName(source.srUuid)}__${safeFileName(source.location)}`;
  const localDir = join(cacheDir, sourceKey);
  if (existsSync(localDir) && !statSync(localDir).isDirectory()) {
    rmSync(localDir, { force: true });
  }
  ensureDir(localDir);
  const files = {
    isolinuxBin: join(localDir, "isolinux.bin"),
    vmlinuz: join(localDir, "vmlinuz"),
    initrd: join(localDir, "initrd.img"),
    squashfs: join(localDir, "squashfs.img"),
    treeInfo: join(localDir, ".treeinfo"),
    discInfo: join(localDir, ".discinfo"),
    buildTag: join(localDir, "CentOS_BuildTag"),
  };
  if (
    existsSync(files.isolinuxBin) &&
    existsSync(files.vmlinuz) &&
    existsSync(files.initrd) &&
    existsSync(files.squashfs) &&
    existsSync(files.treeInfo) &&
    existsSync(files.discInfo) &&
    existsSync(files.buildTag)
  ) {
    return files;
  }
  await downloadFile(connection, `${source.mountDir}/isolinux/isolinux.bin`, files.isolinuxBin);
  await downloadFirstExisting(connection, [`${source.mountDir}/images/pxeboot/vmlinuz`, `${source.mountDir}/isolinux/vmlinuz`], files.vmlinuz);
  await downloadFirstExisting(connection, [`${source.mountDir}/images/pxeboot/initrd.img`, `${source.mountDir}/isolinux/initrd.img`], files.initrd);
  await downloadFile(connection, `${source.mountDir}/LiveOS/squashfs.img`, files.squashfs);
  await downloadFile(connection, `${source.mountDir}/.treeinfo`, files.treeInfo);
  await downloadFile(connection, `${source.mountDir}/.discinfo`, files.discInfo);
  await downloadFile(connection, `${source.mountDir}/CentOS_BuildTag`, files.buildTag);
  return files;
}

async function generateCentosHttpBootIso(
  bootFiles: LocalBootFiles,
  outputIso: string,
  input: XenUnattendedIsoInput,
): Promise<void> {
  const workDir = join(generatedDir, `${safeFileName(input.vm.name)}-work`);
  const isolinuxDir = join(workDir, "isolinux");
  const pxebootDir = join(workDir, "images", "pxeboot");
  rmSync(workDir, { recursive: true, force: true });
  ensureDir(workDir);
  ensureDir(isolinuxDir);
  ensureDir(pxebootDir);
  ensureDir(join(workDir, "LiveOS"));
  copyFileSync(bootFiles.isolinuxBin, join(isolinuxDir, "isolinux.bin"));
  copyFileSync(bootFiles.vmlinuz, join(isolinuxDir, "vmlinuz"));
  copyFileSync(bootFiles.initrd, join(isolinuxDir, "initrd.img"));
  copyFileSync(bootFiles.vmlinuz, join(pxebootDir, "vmlinuz"));
  copyFileSync(bootFiles.initrd, join(pxebootDir, "initrd.img"));
  copyFileSync(bootFiles.squashfs, join(workDir, "LiveOS", "squashfs.img"));
  copyFileSync(bootFiles.treeInfo, join(workDir, ".treeinfo"));
  copyFileSync(bootFiles.discInfo, join(workDir, ".discinfo"));
  copyFileSync(bootFiles.buildTag, join(workDir, "CentOS_BuildTag"));
  const isolinuxPath = join(isolinuxDir, "isolinux.cfg");
  const installUrls = buildInstallUrls(input);
  writeFileSync(isolinuxPath, buildCentosIsolinuxConfig(), "utf8");
  const xorriso = resolveXorrisoPath();
  await execFileAsync(xorriso, [
    "-as",
    "mkisofs",
    "-o",
    outputIso,
    "-b",
    "isolinux/isolinux.bin",
    "-c",
    "isolinux/boot.cat",
    "-no-emul-boot",
    "-boot-load-size",
    "4",
    "-boot-info-table",
    "-R",
    "-J",
    "-V",
    centosBootIsoLabel,
    workDir,
  ]);

  function buildCentosIsolinuxConfig(): string {
    const netmask = cidrToNetmask(input.ipPool.cidr) || "255.255.255.0";
    const macBinding = input.macAddress ? ` ifname=eth0:${input.macAddress}` : "";
    return `default linux
prompt 0
timeout 10
label linux
  kernel vmlinuz
  append initrd=initrd.img inst.stage2=${installUrls.repoUrl} inst.ks=${installUrls.ksUrl} rd.neednet=1 net.ifnames=0 biosdevname=0${macBinding} ip=${input.vm.ip}::${input.ipPool.gateway}:${netmask}:vrc:eth0:none bootdev=eth0 ksdevice=eth0
`;
  }
}

function buildInstallUrls(input: XenUnattendedIsoInput): { repoUrl: string; ksUrl: string } {
  if (!input.installSource) {
    throw new Error("HTTP 启动 ISO 缺少集中安装源。");
  }
  return {
    repoUrl: input.installSource.repoUrl,
    ksUrl: input.installSource.ksUrl,
  };
}

async function ensureLocalSourceIso(connection: XenConnectionInput, source: SourceIsoInfo): Promise<string> {
  const sourceKey = `${safeFileName(source.srUuid)}__${safeFileName(source.location)}`;
  const localDir = join(cacheDir, sourceKey);
  ensureDir(localDir);
  const localIso = join(localDir, safeFileName(source.location));
  ensureDir(dirname(localIso));
  if (existsSync(localIso) && statSync(localIso).isFile()) {
    const localSize = statSync(localIso).size;
    if (!source.sizeBytes || localSize === source.sizeBytes) return localIso;
  }
  await downloadFile(connection, source.remotePath, localIso);
  return localIso;
}

// 基于原始 DVD ISO 增量写入 ks.cfg 和启动菜单，保留源 ISO 软件包仓库，避免下载 RPM 时依赖 VRC API。
async function generateCentosOfflineUnattendedIso(sourceIso: string, outputIso: string, input: XenUnattendedIsoInput): Promise<void> {
  const workDir = join(generatedDir, `${safeFileName(input.vm.name)}-offline-work`);
  rmSync(workDir, { recursive: true, force: true });
  rmSync(outputIso, { force: true });
  ensureDir(workDir);
  const volumeId = await readIsoVolumeId(sourceIso);
  const ksPath = join(workDir, "ks.cfg");
  const isolinuxPath = join(workDir, "isolinux.cfg");
  const grubPath = join(workDir, "grub.cfg");
  writeFileSync(ksPath, buildOfflineCentosKickstart(input), "utf8");
  writeFileSync(isolinuxPath, buildOfflineCentosIsolinuxConfig(input, volumeId), "utf8");
  writeFileSync(grubPath, buildOfflineCentosGrubConfig(input, volumeId), "utf8");
  const xorriso = resolveXorrisoPath();
  await execFileAsync(xorriso, [
    "-indev",
    sourceIso,
    "-outdev",
    outputIso,
    "-boot_image",
    "any",
    "replay",
    "-map",
    ksPath,
    "/ks.cfg",
    "-map",
    isolinuxPath,
    "/isolinux/isolinux.cfg",
    "-map",
    grubPath,
    "/EFI/BOOT/grub.cfg",
    "-commit",
  ]);
}

async function readIsoVolumeId(sourceIso: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(resolveXorrisoPath(), ["-indev", sourceIso, "-pvd_info"]);
    const line = stdout.split(/\r?\n/).find((item) => item.startsWith("Volume Id"));
    const value = line?.split(":").slice(1).join(":").trim();
    return value || "CentOS 7 x86_64";
  } catch {
    return "CentOS 7 x86_64";
  }
}

function buildOfflineCentosIsolinuxConfig(input: XenUnattendedIsoInput, volumeId: string): string {
  const netmask = cidrToNetmask(input.ipPool.cidr) || "255.255.255.0";
  const macBinding = input.macAddress ? ` ifname=eth0:${input.macAddress}` : "";
  const stage2Label = escapeAnacondaLabel(volumeId);
  return `default linux
prompt 0
timeout 10
label linux
  menu label Install ${input.vm.name}
  kernel vmlinuz
  append initrd=initrd.img inst.stage2=hd:LABEL=${stage2Label} inst.ks=cdrom:/ks.cfg rd.neednet=1 net.ifnames=0 biosdevname=0${macBinding} ip=${input.vm.ip}::${input.ipPool.gateway}:${netmask}:vrc:eth0:none bootdev=eth0 ksdevice=eth0
`;
}

function buildOfflineCentosGrubConfig(input: XenUnattendedIsoInput, volumeId: string): string {
  const netmask = cidrToNetmask(input.ipPool.cidr) || "255.255.255.0";
  const macBinding = input.macAddress ? ` ifname=eth0:${input.macAddress}` : "";
  const stage2Label = escapeAnacondaLabel(volumeId);
  return `set default="0"
set timeout=1
menuentry 'Install ${input.vm.name}' {
  linuxefi /images/pxeboot/vmlinuz inst.stage2=hd:LABEL=${stage2Label} inst.ks=cdrom:/ks.cfg rd.neednet=1 net.ifnames=0 biosdevname=0${macBinding} ip=${input.vm.ip}::${input.ipPool.gateway}:${netmask}:vrc:eth0:none bootdev=eth0 ksdevice=eth0
  initrdefi /images/pxeboot/initrd.img
}
`;
}

function buildOfflineCentosKickstart(input: XenUnattendedIsoInput): string {
  const netmask = cidrToNetmask(input.ipPool.cidr) || "255.255.255.0";
  const dns = sanitizeKickstartValue(input.ipPool.dns[0] ?? "");
  const gateway = sanitizeKickstartValue(input.ipPool.gateway);
  const ip = sanitizeKickstartValue(input.vm.ip);
  const rootPassword = sanitizeKickstartValue(input.vm.rootPassword ?? "");
  const hostname = sanitizeKickstartValue(input.vm.name);
  return `#version=DEVEL
install
cdrom
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

async function uploadIso(connection: XenConnectionInput, localPath: string, remotePath: string): Promise<void> {
  await uploadFile(connection, localPath, remotePath);
}

async function scanAndFindUploadedIso(connection: XenConnectionInput, srUuid: string, isoName: string): Promise<string> {
  const output = await runRemoteCommand(
    connection,
    [
      `sr_uuid='${escapeShellValue(srUuid)}'`,
      `iso_name='${escapeShellValue(isoName)}'`,
      'xe sr-scan uuid="$sr_uuid" >/dev/null',
      'for vdi in $(xe vdi-list sr-uuid="$sr_uuid" --minimal 2>/dev/null | tr "," " "); do',
      '  label="$(xe vdi-param-get uuid="$vdi" param-name=name-label 2>/dev/null)"',
      '  location="$(xe vdi-param-get uuid="$vdi" param-name=location 2>/dev/null)"',
      '  if [ "$label" = "$iso_name" ] || [ "$location" = "$iso_name" ]; then',
      '    printf "VDI\\t%s\\n" "$vdi"',
      "    exit 0",
      "  fi",
      "done",
      'echo "未找到已上传的无人值守 ISO：$iso_name" >&2',
      "exit 7",
    ].join("\n"),
  );
  const line = output.split(/\r?\n/).find((item) => item.startsWith("VDI\t"));
  const [, isoId = ""] = line?.split("\t") ?? [];
  if (!isoId) throw new Error(`未找到已上传的无人值守 ISO：${isoName}`);
  return isoId;
}

async function markGeneratedIsoOnXen(
  connection: XenConnectionInput,
  input: {
    isoId: string;
    registryId: string;
    taskId: string;
    vmName: string;
  },
): Promise<void> {
  await runRemoteCommand(
    connection,
    [
      `iso_uuid='${escapeShellValue(input.isoId)}'`,
      `registry_id='${escapeShellValue(input.registryId)}'`,
      `task_id='${escapeShellValue(input.taskId)}'`,
      `vm_name='${escapeShellValue(input.vmName)}'`,
      'xe vdi-param-set uuid="$iso_uuid" other-config:vrc-generated=true >/dev/null',
      'xe vdi-param-set uuid="$iso_uuid" other-config:vrc-registry-id="$registry_id" >/dev/null',
      'xe vdi-param-set uuid="$iso_uuid" other-config:vrc-task-id="$task_id" >/dev/null',
      'xe vdi-param-set uuid="$iso_uuid" other-config:vrc-vm-name="$vm_name" >/dev/null',
    ].join("\n"),
  );
}

function downloadFile(connection: XenConnectionInput, remotePath: string, localPath: string): Promise<void> {
  ensureDir(dirname(localPath));
  return withSftp(connection, (sftp) => new Promise((resolve, reject) => sftp.fastGet(remotePath, localPath, (error) => (error ? reject(error) : resolve()))));
}

async function downloadFirstExisting(connection: XenConnectionInput, remotePaths: string[], localPath: string): Promise<void> {
  let lastError: unknown;
  for (const remotePath of remotePaths) {
    try {
      await downloadFile(connection, remotePath, localPath);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`未找到可下载的启动文件：${remotePaths.join(", ")}`);
}

function uploadFile(connection: XenConnectionInput, localPath: string, remotePath: string): Promise<void> {
  return withSftp(connection, (sftp) => new Promise((resolve, reject) => sftp.fastPut(localPath, remotePath, (error) => (error ? reject(error) : resolve()))));
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

function resolveXorrisoPath(): string {
  if (existsSync("/opt/homebrew/bin/xorriso")) return "/opt/homebrew/bin/xorriso";
  if (existsSync("/usr/local/bin/xorriso")) return "/usr/local/bin/xorriso";
  return "xorriso";
}

async function assertIsoGeneratorAvailable(): Promise<void> {
  const xorriso = resolveXorrisoPath();
  try {
    await execFileAsync(xorriso, ["-version"]);
  } catch {
    throw new Error("本机缺少 xorriso，无法生成 XenServer 无人值守启动 ISO。请先安装 xorriso 后重试。");
  }
}

function cidrToNetmask(cidr: string | undefined): string {
  const bits = Number(cidr?.split("/")[1]);
  if (!Number.isFinite(bits) || bits < 0 || bits > 32) return "";
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return [24, 16, 8, 0].map((shift) => (mask >>> shift) & 255).join(".");
}

function escapeAnacondaLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/ /g, "\\x20");
}

function sanitizeKickstartValue(value: string): string {
  return value.replace(/[\r\n]/g, "").trim();
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120) || "unnamed";
}

function escapeShellValue(value: string): string {
  return value.replace(/'/g, "'\\''");
}
