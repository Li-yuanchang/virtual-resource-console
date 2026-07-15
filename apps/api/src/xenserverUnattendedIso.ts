import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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
const centosKickstartIsoLabel = "VRCKS";

export type XenInstallMediaMode = "offline-iso" | "http-boot-iso" | "cdrom-http-ks";

interface SourceIsoInfo {
  srUuid: string;
  location: string;
  remotePath: string;
  mountDir: string;
  sizeBytes: number;
  volumeLabel: string;
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
  onProgress?: (message: string) => void;
}

export interface XenUnattendedIsoResult {
  isoId: string;
  isoName: string;
  registryId?: string;
}

// 默认复用 XenServer ISO SR 上的原始 ISO，只通过 HTTP 下发 Kickstart，避免每台 VM 重复生成和上传大 ISO。
export function resolveXenInstallMediaMode(): XenInstallMediaMode {
  const rawMode = process.env.VRC_XEN_INSTALL_MEDIA_MODE?.trim().toLowerCase() ?? "";
  if (rawMode === "offline" || rawMode === "offline-iso") return "offline-iso";
  if (rawMode === "http" || rawMode === "http-boot" || rawMode === "http-boot-iso") return "http-boot-iso";
  if (["cdrom-http-ks", "cdrom-plus-http-ks", "iso-http-ks", "raw-iso-http-ks"].includes(rawMode)) return "cdrom-http-ks";
  return "http-boot-iso";
}

export async function prepareXenCentosUnattendedIso(input: XenUnattendedIsoInput): Promise<XenUnattendedIsoResult> {
  ensureDir(cacheDir);
  ensureDir(generatedDir);
  input.onProgress?.("检查本地 ISO 生成工具");
  await assertIsoGeneratorAvailable();
  const mediaMode = resolveXenInstallMediaMode();
  input.onProgress?.("读取 XenServer 源 ISO 信息");
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
      input.onProgress?.("缓存源 ISO 并生成离线无人值守 ISO");
      const localSourceIso = await ensureLocalSourceIso(input.connection, source);
      await generateCentosOfflineUnattendedIso(localSourceIso, localOutputIso, input);
    } else {
      input.onProgress?.("缓存启动文件并生成 HTTP Boot ISO");
      const bootFiles = await ensureLocalBootFiles(input.connection, source);
      await generateCentosHttpBootIso(bootFiles, localOutputIso, input);
    }
    input.onProgress?.("上传无人值守 ISO 到 XenServer ISO SR");
    await uploadIso(input.connection, localOutputIso, remotePath);
    input.onProgress?.("扫描 ISO SR 并登记无人值守 ISO");
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

export async function prepareXenCentosKickstartIso(input: XenUnattendedIsoInput): Promise<XenUnattendedIsoResult> {
  ensureDir(generatedDir);
  input.onProgress?.("生成小型 Kickstart 启动 ISO");
  await assertIsoGeneratorAvailable();
  const source = await readSourceIsoInfo(input.connection, input.sourceIsoId, true);
  const isoName = `vrc-${safeFileName(input.vm.name)}-ks-${Date.now().toString(36)}.iso`;
  const remotePath = `${dirname(source.remotePath)}/${isoName}`;
  const registry = registerGeneratedIso({
    taskId: input.installSource?.taskId || input.installSource?.id || `xen-ks-${Date.now().toString(36)}`,
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
    const bootFiles = await ensureLocalBootLoaderFiles(input.connection, source);
    await generateCentosKickstartBootIso(bootFiles, source.volumeLabel, localOutputIso, input);
    input.onProgress?.("上传小型 Kickstart 启动 ISO 到 XenServer ISO SR");
    await uploadIso(input.connection, localOutputIso, remotePath);
    input.onProgress?.("扫描 ISO SR 并登记 Kickstart ISO");
    const isoId = await scanAndFindUploadedIso(input.connection, source.srUuid, isoName);
    await markGeneratedIsoOnXen(input.connection, {
      isoId,
      registryId: registry.id,
      taskId: registry.taskId,
      vmName: input.vm.name,
    });
    markGeneratedIsoUploaded(registry.id, {
      isoVdiUuid: isoId,
      message: "Kickstart 启动 ISO 已上传并登记",
    });
    return {
      isoId,
      isoName,
      registryId: registry.id,
    };
  } catch (error) {
    markGeneratedIsoStatus(registry.id, "failed", error instanceof Error ? error.message : "Kickstart 启动 ISO 生成失败");
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
      'volume_label="$(blkid -p -s LABEL -o value "$remote_path" 2>/dev/null || true)"',
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
      'printf "ISO\\t%s\\t%s\\t%s\\t%s\\t%s\\n" "$sr_uuid" "$location" "$remote_path" "$mount_dir" "$volume_label"',
    ].join("\n"),
  );
  const line = output.split(/\r?\n/).find((item) => item.startsWith("ISO\t"));
  const [, srUuid = "", location = "", remotePath = "", mountDir = "", volumeLabel = ""] = line?.split("\t") ?? [];
  if (!srUuid || !location || !remotePath) {
    throw new Error("未读取到 XenServer 源 ISO 文件路径，无法生成无人值守 ISO。");
  }
  return {
    srUuid,
    location,
    remotePath,
    mountDir,
    sizeBytes: Number(output.split(/\r?\n/).find((item) => item.startsWith("SIZE\t"))?.split("\t")[1]) || 0,
    volumeLabel: volumeLabel || "CentOS 7 x86_64",
  };
}

interface LocalBootFiles {
  isolinuxBin: string;
  vmlinuz: string;
  initrd: string;
}

interface LocalBootLoaderFiles {
  isolinuxBin: string;
  vmlinuz: string;
  initrd: string;
  isolinuxFiles: string[];
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
  };
  if (existsSync(files.isolinuxBin) && existsSync(files.vmlinuz) && existsSync(files.initrd)) {
    return files;
  }
  await downloadFile(connection, `${source.mountDir}/isolinux/isolinux.bin`, files.isolinuxBin);
  await downloadFirstExisting(connection, [`${source.mountDir}/images/pxeboot/vmlinuz`, `${source.mountDir}/isolinux/vmlinuz`], files.vmlinuz);
  await downloadFirstExisting(connection, [`${source.mountDir}/images/pxeboot/initrd.img`, `${source.mountDir}/isolinux/initrd.img`], files.initrd);
  return files;
}

async function ensureLocalBootLoaderFiles(connection: XenConnectionInput, source: SourceIsoInfo): Promise<LocalBootLoaderFiles> {
  const sourceKey = `${safeFileName(source.srUuid)}__${safeFileName(source.location)}__boot`;
  const localDir = join(cacheDir, sourceKey);
  if (existsSync(localDir) && !statSync(localDir).isDirectory()) {
    rmSync(localDir, { force: true });
  }
  ensureDir(localDir);
  const files = {
    isolinuxBin: join(localDir, "isolinux.bin"),
    vmlinuz: join(localDir, "vmlinuz"),
    initrd: join(localDir, "initrd.img"),
    isolinuxFiles: [] as string[],
  };
  const isolinuxFilesDir = join(localDir, "isolinux-files");
  ensureDir(isolinuxFilesDir);
  files.isolinuxFiles = listLocalFiles(isolinuxFilesDir);
  if (existsSync(files.isolinuxBin) && existsSync(files.vmlinuz) && existsSync(files.initrd) && files.isolinuxFiles.length) {
    return files;
  }
  await downloadFile(connection, `${source.mountDir}/isolinux/isolinux.bin`, files.isolinuxBin);
  await downloadFirstExisting(connection, [`${source.mountDir}/images/pxeboot/vmlinuz`, `${source.mountDir}/isolinux/vmlinuz`], files.vmlinuz);
  await downloadFirstExisting(connection, [`${source.mountDir}/images/pxeboot/initrd.img`, `${source.mountDir}/isolinux/initrd.img`], files.initrd);
  const isolinuxNames = await listRemoteIsolinuxFiles(connection, `${source.mountDir}/isolinux`);
  for (const name of isolinuxNames) {
    await downloadFile(connection, `${source.mountDir}/isolinux/${name}`, join(isolinuxFilesDir, name));
  }
  files.isolinuxFiles = listLocalFiles(isolinuxFilesDir);
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
  copyFileSync(bootFiles.isolinuxBin, join(isolinuxDir, "isolinux.bin"));
  copyFileSync(bootFiles.vmlinuz, join(isolinuxDir, "vmlinuz"));
  copyFileSync(bootFiles.initrd, join(isolinuxDir, "initrd.img"));
  copyFileSync(bootFiles.vmlinuz, join(pxebootDir, "vmlinuz"));
  copyFileSync(bootFiles.initrd, join(pxebootDir, "initrd.img"));
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
  append initrd=initrd.img inst.repo=${installUrls.repoUrl} inst.ks=${installUrls.ksUrl} rd.neednet=1 net.ifnames=0 biosdevname=0${macBinding} ip=${input.vm.ip}::${input.ipPool.gateway}:${netmask}:vrc:eth0:none bootdev=eth0 ksdevice=eth0
`;
  }
}

async function generateCentosKickstartBootIso(
  bootFiles: LocalBootLoaderFiles,
  sourceVolumeLabel: string,
  outputIso: string,
  input: XenUnattendedIsoInput,
): Promise<void> {
  const workDir = join(generatedDir, `${safeFileName(input.vm.name)}-ks-work`);
  const isolinuxDir = join(workDir, "isolinux");
  rmSync(workDir, { recursive: true, force: true });
  rmSync(outputIso, { force: true });
  ensureDir(workDir);
  ensureDir(isolinuxDir);
  for (const isolinuxFile of bootFiles.isolinuxFiles) {
    copyFileSync(isolinuxFile, join(isolinuxDir, isolinuxFile.split("/").pop() || "isolinux-file"));
  }
  copyFileSync(bootFiles.isolinuxBin, join(isolinuxDir, "isolinux.bin"));
  copyFileSync(bootFiles.vmlinuz, join(isolinuxDir, "vmlinuz"));
  copyFileSync(bootFiles.initrd, join(isolinuxDir, "initrd.img"));
  writeFileSync(join(workDir, "ks.cfg"), buildOfflineCentosKickstart(input), "utf8");
  writeFileSync(join(isolinuxDir, "isolinux.cfg"), buildKickstartBootIsolinuxConfig(input, sourceVolumeLabel), "utf8");
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
    centosKickstartIsoLabel,
    workDir,
  ]);
}

function buildKickstartBootIsolinuxConfig(input: XenUnattendedIsoInput, sourceVolumeLabel: string): string {
  const netmask = cidrToNetmask(input.ipPool.cidr) || "255.255.255.0";
  const macBinding = input.macAddress ? ` ifname=eth0:${input.macAddress}` : "";
  const stage2Label = escapeAnacondaLabel(sourceVolumeLabel);
  return `default linux
prompt 0
timeout 10
label linux
  menu label Install ${input.vm.name}
  kernel vmlinuz
  append initrd=initrd.img inst.stage2=hd:LABEL=${stage2Label} inst.ks=hd:LABEL=${centosKickstartIsoLabel}:/ks.cfg rd.neednet=1 net.ifnames=0 biosdevname=0${macBinding} ip=${input.vm.ip}::${input.ipPool.gateway}:${netmask}:vrc:eth0:none bootdev=eth0 ksdevice=eth0
`;
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

export function buildOfflineCentosKickstart(input: Pick<XenUnattendedIsoInput, "vm" | "ipPool">): string {
  const netmask = cidrToNetmask(input.ipPool.cidr) || "255.255.255.0";
  const dns = sanitizeKickstartValue(input.ipPool.dns[0] ?? "");
  const gateway = sanitizeKickstartValue(input.ipPool.gateway);
  const ip = sanitizeKickstartValue(input.vm.ip);
  const rootPassword = sanitizeKickstartValue(input.vm.rootPassword ?? "");
  const rootPasswordEntry = shellSingleQuote(`root:${rootPassword}`);
  const rootPasswordValue = shellSingleQuote(rootPassword || "changeme");
  const rootPasswordHashValue = md5Crypt(rootPassword || "changeme");
  const rootPasswordHash = shellSingleQuote(rootPasswordHashValue);
  const hostname = sanitizeKickstartValue(input.vm.name);
  return `#version=DEVEL
install
cdrom
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
%end
%post --nochroot --log=/tmp/vrc-kickstart-eject.log
eject /dev/sr0 >/dev/null 2>&1 || true
eject /dev/sr1 >/dev/null 2>&1 || true
%end
`;
}

async function uploadIso(connection: XenConnectionInput, localPath: string, remotePath: string): Promise<void> {
  try {
    await uploadFile(connection, localPath, remotePath);
  } catch (error) {
    await cleanupFailedGeneratedIsoUpload(connection, remotePath).catch(() => undefined);
    const sizeMiB = Math.ceil(statSync(localPath).size / 1024 / 1024);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`上传无人值守 ISO 失败：${detail}。目标 ISO SR 可能空间不足或 SMB 写入失败；本次 ISO 大小约 ${sizeMiB} MiB。`);
  }
}

async function cleanupFailedGeneratedIsoUpload(connection: XenConnectionInput, remotePath: string): Promise<void> {
  const fileName = remotePath.split("/").pop() ?? "";
  if (!fileName.startsWith("vrc-") || !fileName.endsWith(".iso")) return;
  await runRemoteCommand(
    connection,
    [
      `remote_path='${escapeShellValue(remotePath)}'`,
      'case "$remote_path" in */vrc-*.iso) rm -f "$remote_path" ;; esac',
    ].join("\n"),
  );
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

async function listRemoteIsolinuxFiles(connection: XenConnectionInput, remoteDir: string): Promise<string[]> {
  const output = await runRemoteCommand(
    connection,
    [
      `remote_dir='${escapeShellValue(remoteDir)}'`,
      'find "$remote_dir" -maxdepth 1 -type f -printf "%f\\n" 2>/dev/null || true',
    ].join("\n"),
  );
  return output
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter((item) => /^[A-Za-z0-9_.-]+$/.test(item));
}

function listLocalFiles(localDir: string): string[] {
  try {
    return readdirSync(localDir)
      .map((item) => join(localDir, item));
  } catch {
    return [];
  }
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

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120) || "unnamed";
}

function escapeShellValue(value: string): string {
  return value.replace(/'/g, "'\\''");
}
