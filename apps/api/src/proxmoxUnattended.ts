import { Client } from "ssh2";
import type { SFTPWrapper } from "ssh2";
import { buildOfflineCentosKickstart } from "./xenserverUnattendedIso.js";
import type { IpPoolConfig, VmProvisionPlanItem, XenConnectionInput } from "./types.js";

export interface ProxmoxKickstartArtifacts {
  isoName: string;
  isoPath: string;
  isoVolid: string;
  kernelPath: string;
  initrdPath: string;
  taskDir: string;
  sourceLabel: string;
}

export type ProxmoxArmDistribution = "openeuler" | "kylin";

export function resolveProxmoxArmDistribution(isoName: string): ProxmoxArmDistribution | undefined {
  const normalized = isoName.toLowerCase();
  if (normalized.includes("openeuler") && normalized.includes("aarch64")) return "openeuler";
  if (normalized.includes("kylin") && (normalized.includes("arm64") || normalized.includes("aarch64"))) return "kylin";
  return undefined;
}

export async function prepareProxmoxArmKickstartArtifacts(input: {
  connection: XenConnectionInput;
  taskId: string;
  sourceIsoVolid: string;
  vm: VmProvisionPlanItem;
  ipPool: IpPoolConfig;
}): Promise<ProxmoxKickstartArtifacts> {
  const sourceIsoName = sourceIsoFileName(input.sourceIsoVolid);
  const safeKey = safeFileName(`${input.taskId}-${input.vm.name}`);
  const taskDir = `/var/lib/vz/vrc-provision/${safeKey}`;
  const isoName = `vrc-${safeFileName(input.vm.name)}-ks-${Date.now().toString(36)}.iso`;
  const isoPath = `/var/lib/vz/template/iso/${isoName}`;
  const mountDir = `${taskDir}/source`;
  const configDir = `${taskDir}/config`;
  await runProxmoxHostCommand(input.connection, [
    "set -e",
    `task_dir='${escapeShellValue(taskDir)}'`,
    `mount_dir='${escapeShellValue(mountDir)}'`,
    `config_dir='${escapeShellValue(configDir)}'`,
    `source_iso='/var/lib/vz/template/iso/${escapeShellValue(sourceIsoName)}'`,
    "test -f \"$source_iso\"",
    "mkdir -p \"$mount_dir\" \"$config_dir\"",
    "mountpoint -q \"$mount_dir\" || mount -o loop,ro \"$source_iso\" \"$mount_dir\"",
    "test -f \"$mount_dir/images/pxeboot/vmlinuz\"",
    "test -f \"$mount_dir/images/pxeboot/initrd.img\"",
    "cp -f \"$mount_dir/images/pxeboot/vmlinuz\" \"$task_dir/vmlinuz\"",
    "cp -f \"$mount_dir/images/pxeboot/initrd.img\" \"$task_dir/initrd.img\"",
    "label=$(blkid -p -s LABEL -o value \"$source_iso\" 2>/dev/null || true)",
    "printf '%s' \"$label\" > \"$task_dir/source-label\"",
    "umount \"$mount_dir\"",
  ].join("\n"));
  const kickstart = buildProxmoxArmKickstart({
    vm: { ...input.vm, name: safeGuestHostname(input.vm.name) },
    ipPool: input.ipPool,
  });
  await writeProxmoxHostFile(input.connection, `${configDir}/ks.cfg`, kickstart);
  await runProxmoxHostCommand(input.connection, [
    "set -e",
    `task_dir='${escapeShellValue(taskDir)}'`,
    `config_dir='${escapeShellValue(configDir)}'`,
    `iso_path='${escapeShellValue(isoPath)}'`,
    "xz -dc \"$task_dir/initrd.img\" > \"$task_dir/initrd.raw\"",
    "(cd \"$config_dir\" && printf './ks.cfg\\n' | cpio -o -H newc 2>/dev/null) >> \"$task_dir/initrd.raw\"",
    "xz --check=crc32 -3 -c \"$task_dir/initrd.raw\" > \"$task_dir/initrd.with-ks.img\"",
    "mv -f \"$task_dir/initrd.with-ks.img\" \"$task_dir/initrd.img\"",
    "rm -f \"$task_dir/initrd.raw\"",
    "genisoimage -quiet -o \"$iso_path\" -V VRCKS -J -R \"$config_dir\"",
    "test -s \"$iso_path\"",
  ].join("\n"));
  const sourceLabel = (await runProxmoxHostCommand(input.connection, `cat '${escapeShellValue(taskDir)}/source-label'`)).trim();
  if (!sourceLabel) {
    await cleanupProxmoxKickstartArtifacts(input.connection, { isoPath, taskDir }).catch(() => undefined);
    throw new Error(`PVE 原版 ISO 缺少可识别卷标，无法生成安装启动参数：${sourceIsoName}`);
  }
  return {
    isoName,
    isoPath,
    isoVolid: `local:iso/${isoName}`,
    kernelPath: `${taskDir}/vmlinuz`,
    initrdPath: `${taskDir}/initrd.img`,
    taskDir,
    sourceLabel,
  };
}

function buildProxmoxArmKickstart(input: { vm: VmProvisionPlanItem; ipPool: IpPoolConfig }): string {
  return buildOfflineCentosKickstart(input)
    .replace(/^install\n/m, "")
    .replace(/^auth\s+.*\n/m, "")
    .replace(/^reboot --eject$/m, "poweroff");
}

export async function cleanupProxmoxKickstartArtifacts(
  connection: XenConnectionInput,
  input: { isoPath: string; taskDir: string },
): Promise<void> {
  if (!input.isoPath.startsWith("/var/lib/vz/template/iso/vrc-") || !input.isoPath.endsWith(".iso")) {
    throw new Error("PVE 临时 ISO 路径不属于受管目录，拒绝清理。");
  }
  if (!input.taskDir.startsWith("/var/lib/vz/vrc-provision/")) {
    throw new Error("PVE 临时任务目录不属于受管目录，拒绝清理。");
  }
  await runProxmoxHostCommand(connection, [
    `iso_path='${escapeShellValue(input.isoPath)}'`,
    `task_dir='${escapeShellValue(input.taskDir)}'`,
    "rm -f \"$iso_path\"",
    "rm -rf \"$task_dir\"",
  ].join("\n"));
}

export function buildProxmoxInstallerArgs(input: {
  artifacts: ProxmoxKickstartArtifacts;
  vm: VmProvisionPlanItem;
  ipPool: IpPoolConfig;
}): string {
  const netmask = cidrToNetmask(input.ipPool.cidr) || "255.255.255.0";
  const label = input.artifacts.sourceLabel.replace(/ /g, "\\x20");
  const append = [
    `inst.stage2=hd:LABEL=${label}`,
    "inst.ks=file:/ks.cfg",
    "rd.neednet=1",
    "net.ifnames=0",
    "biosdevname=0",
    `ip=${input.vm.ip}::${input.ipPool.gateway}:${netmask}:vrc:eth0:none`,
    "bootdev=eth0",
    "ksdevice=eth0",
    "console=tty0",
  ].join(" ");
  return `-kernel ${input.artifacts.kernelPath} -initrd ${input.artifacts.initrdPath} -append '${append}'`;
}

export function runProxmoxHostCommand(connection: XenConnectionInput, command: string): Promise<string> {
  return withSsh(connection, (client) => new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    client.exec(command, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      stream.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      stream.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      stream.on("close", (code: number) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(stderr.trim() || `PVE 宿主机命令失败：${code}`));
      });
    });
  }));
}

function writeProxmoxHostFile(connection: XenConnectionInput, remotePath: string, content: string): Promise<void> {
  return withSftp(connection, (sftp) => new Promise((resolve, reject) => {
    sftp.writeFile(remotePath, content, { mode: 0o600 }, (error) => error ? reject(error) : resolve());
  }));
}

function withSsh<T>(connection: XenConnectionInput, task: (client: Client) => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    client.on("ready", () => {
      task(client).then(resolve, reject).finally(() => client.end());
    }).on("error", reject).connect({
      host: connection.host,
      port: 22,
      username: connection.username,
      password: connection.password,
      readyTimeout: 15_000,
    });
  });
}

function withSftp<T>(connection: XenConnectionInput, task: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
  return withSsh(connection, (client) => new Promise((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error) reject(error);
      else task(sftp).then(resolve, reject);
    });
  }));
}

function sourceIsoFileName(volid: string): string {
  const marker = ":iso/";
  const index = volid.indexOf(marker);
  const name = index >= 0 ? volid.slice(index + marker.length) : "";
  if (!name || name.includes("/") || !name.toLowerCase().endsWith(".iso")) throw new Error(`PVE ISO 标识不合法：${volid}`);
  return name;
}

function safeGuestHostname(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63) || "vrc-vm";
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "task";
}

function escapeShellValue(value: string): string {
  return value.replace(/'/g, "'\\''");
}

function cidrToNetmask(cidr: string): string {
  const prefix = Number(cidr.split("/")[1]);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return "";
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return [24, 16, 8, 0].map((shift) => String((mask >>> shift) & 255)).join(".");
}
