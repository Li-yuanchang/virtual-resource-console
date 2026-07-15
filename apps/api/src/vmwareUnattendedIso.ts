import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { IpPoolConfig, VmProvisionPlanItem } from "./types.js";
import { buildOfflineCentosKickstart } from "./xenserverUnattendedIso.js";

const execFileAsync = promisify(execFile);
const storeDir = join(homedir(), ".virtual-resource-console");
const cacheDir = join(storeDir, "iso-cache");
const generatedDir = join(storeDir, "generated-isos");
const kickstartIsoLabel = "VRCKS";

export interface VmwareKickstartIsoInput {
  bootFiles: VmwareCentosBootFiles;
  vm: VmProvisionPlanItem;
  ipPool: IpPoolConfig;
}

export interface VmwareCentosBootFiles {
  isolinuxBin: string;
  vmlinuz: string;
  initrd: string;
  volumeLabel: string;
}

export interface VmwareKickstartIsoResult {
  localPath: string;
  isoName: string;
}

export async function ensureVmwareCentosBootFiles(input: {
  cacheKey: string;
  readRange: (start: number, end: number) => Promise<Buffer>;
}): Promise<VmwareCentosBootFiles> {
  const localDir = join(cacheDir, `vmware__${createHash("sha256").update(input.cacheKey).digest("hex").slice(0, 24)}__boot`);
  mkdirSync(localDir, { recursive: true });
  const files = {
    isolinuxBin: join(localDir, "isolinux.bin"),
    vmlinuz: join(localDir, "vmlinuz"),
    initrd: join(localDir, "initrd.img"),
  };
  const metadataPath = join(localDir, "source.json");
  if (existsSync(files.isolinuxBin) && existsSync(files.vmlinuz) && existsSync(files.initrd) && existsSync(metadataPath)) {
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as { volumeLabel?: string };
    return { ...files, volumeLabel: metadata.volumeLabel || "CentOS 7 x86_64" };
  }

  const sectorSize = 2048;
  const pvd = await input.readRange(16 * sectorSize, 17 * sectorSize - 1);
  if (pvd.subarray(1, 6).toString("ascii") !== "CD001") throw new Error("VMware 源 ISO 不是可识别的 ISO9660 镜像。");
  const volumeLabel = pvd.subarray(40, 72).toString("ascii").trim() || "CentOS 7 x86_64";
  const root = readDirectoryRecord(pvd, 156);
  const rootData = await input.readRange(root.extent * sectorSize, root.extent * sectorSize + root.size - 1);
  const isolinux = findDirectoryEntry(rootData, "ISOLINUX");
  if (!isolinux) throw new Error("VMware CentOS ISO 缺少 isolinux 目录。");
  const isolinuxData = await input.readRange(isolinux.extent * sectorSize, isolinux.extent * sectorSize + isolinux.size - 1);
  for (const [name, target] of [["ISOLINUX.BIN", files.isolinuxBin], ["VMLINUZ", files.vmlinuz], ["INITRD.IMG", files.initrd]] as const) {
    const entry = findDirectoryEntry(isolinuxData, name);
    if (!entry) throw new Error(`VMware CentOS ISO 缺少 ${name}。`);
    writeFileSync(target, await input.readRange(entry.extent * sectorSize, entry.extent * sectorSize + entry.size - 1));
  }
  writeFileSync(metadataPath, `${JSON.stringify({ cacheKey: input.cacheKey, volumeLabel }, null, 2)}\n`, "utf8");
  return { ...files, volumeLabel };
}

/**
 * Generates a small boot ISO with an embedded Kickstart file. The original DVD
 * remains the package source and is mounted as the VM's second CD drive.
 */
export async function generateVmwareCentosKickstartIso(input: VmwareKickstartIsoInput): Promise<VmwareKickstartIsoResult> {
  mkdirSync(generatedDir, { recursive: true });
  const isoName = `vrc-${safeFileName(input.vm.name)}-ks-${Date.now().toString(36)}.iso`;
  const localPath = join(generatedDir, isoName);
  const workDir = join(generatedDir, `${safeFileName(input.vm.name)}-vmware-ks-work`);
  const isolinuxDir = join(workDir, "isolinux");
  rmSync(workDir, { recursive: true, force: true });
  rmSync(localPath, { force: true });
  mkdirSync(workDir, { recursive: true });
  const xorriso = resolveXorrisoPath();
  try {
    mkdirSync(isolinuxDir, { recursive: true });
    copyFileSync(input.bootFiles.isolinuxBin, join(isolinuxDir, "isolinux.bin"));
    copyFileSync(input.bootFiles.vmlinuz, join(isolinuxDir, "vmlinuz"));
    copyFileSync(input.bootFiles.initrd, join(isolinuxDir, "initrd.img"));
    writeFileSync(join(workDir, "ks.cfg"), buildOfflineCentosKickstart(input), "utf8");
    writeFileSync(join(isolinuxDir, "isolinux.cfg"), buildBootConfig(input, input.bootFiles.volumeLabel), "utf8");
    await execFileAsync(xorriso, [
      "-as", "mkisofs", "-o", localPath,
      "-b", "isolinux/isolinux.bin", "-c", "isolinux/boot.cat",
      "-no-emul-boot", "-boot-load-size", "4", "-boot-info-table",
      "-R", "-J", "-V", kickstartIsoLabel, workDir,
    ]);
    return { localPath, isoName };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

export function removeLocalVmwareKickstartIso(localPath: string): void {
  if (basename(localPath).startsWith("vrc-") && localPath.startsWith(`${generatedDir}/`)) {
    rmSync(localPath, { force: true });
  }
}

function buildBootConfig(input: VmwareKickstartIsoInput, sourceVolumeLabel: string): string {
  const netmask = cidrToNetmask(input.ipPool.cidr) || "255.255.255.0";
  const stage2Label = sourceVolumeLabel.replace(/ /g, "\\x20");
  return `default linux
prompt 0
timeout 10
label linux
  kernel vmlinuz
  append initrd=initrd.img inst.stage2=hd:LABEL=${stage2Label} inst.ks=hd:LABEL=${kickstartIsoLabel}:/ks.cfg rd.neednet=1 net.ifnames=0 biosdevname=0 ip=${input.vm.ip}::${input.ipPool.gateway}:${netmask}:vrc:eth0:none bootdev=eth0 ksdevice=eth0
`;
}

function readDirectoryRecord(buffer: Buffer, offset: number): { extent: number; size: number; name: string } {
  const length = buffer[offset];
  if (!length || offset + length > buffer.length) throw new Error("VMware ISO9660 目录记录损坏。");
  const nameLength = buffer[offset + 32];
  return {
    extent: buffer.readUInt32LE(offset + 2),
    size: buffer.readUInt32LE(offset + 10),
    name: buffer.subarray(offset + 33, offset + 33 + nameLength).toString("ascii").replace(/;\d+$/, "").replace(/\.$/, ""),
  };
}

function findDirectoryEntry(buffer: Buffer, expectedName: string): { extent: number; size: number; name: string } | undefined {
  let offset = 0;
  while (offset < buffer.length) {
    const length = buffer[offset];
    if (!length) {
      offset = (Math.floor(offset / 2048) + 1) * 2048;
      continue;
    }
    const entry = readDirectoryRecord(buffer, offset);
    if (entry.name.toUpperCase() === expectedName.toUpperCase()) return entry;
    offset += length;
  }
  return undefined;
}

function resolveXorrisoPath(): string {
  for (const candidate of [process.env.VRC_XORRISO_PATH, "/opt/homebrew/bin/xorriso", "/usr/local/bin/xorriso", "/usr/bin/xorriso"] ) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  throw new Error("未找到 xorriso，无法生成 VMware 无人值守启动 ISO。");
}

function cidrToNetmask(cidr: string): string {
  const prefix = Number(cidr.split("/")[1]);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return "";
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return [24, 16, 8, 0].map((shift) => String((mask >>> shift) & 255)).join(".");
}

function safeFileName(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "vm";
}
