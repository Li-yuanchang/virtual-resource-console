import { Client } from "ssh2";
import type { ConnectConfig } from "ssh2";
import { getRuntimePolicy } from "./runtimePolicy.js";
import type {
  GuestStorageInventory,
  GuestStorageMount,
  ProviderType,
  VmDisk,
  VmResizeDiskRequest,
  VmResizeStorageResult,
  VmResizeStorageTarget,
  XenConnectionInput,
} from "./types.js";

const guestReadyTimeoutMs = 6_000;
const guestCommandTimeoutMs = 45_000;
const guestReconnectTimeoutMs = 120_000;
const diskSizeToleranceBytes = 128 * 1024 ** 2;
const filesystemSizeToleranceBytes = 512 * 1024 ** 2;
const guestPartitionRebootMarker = "__VRC_PARTITION_REBOOT_REQUIRED__";

const inspectStorageCommand = String.raw`
export LC_ALL=C
printf '%s\n' '__VRC_LSBLK__'
lsblk -b -P -o NAME,KNAME,TYPE,SIZE,FSTYPE,MOUNTPOINT,PKNAME 2>/dev/null || exit 21
printf '%s\n' '__VRC_STARTS__'
for partition_file in /sys/class/block/*/partition; do
  [ -f "$partition_file" ] || continue
  block_dir="$(dirname "$partition_file")"
  block_name="$(basename "$block_dir")"
  start_sectors="$(cat "$block_dir/start" 2>/dev/null || printf '0')"
  printf '%s|%s\n' "$block_name" "$start_sectors"
done
printf '%s\n' '__VRC_DF__'
df -B1 -P 2>/dev/null || true
printf '%s\n' '__VRC_PVS__'
pvs --noheadings --units b --nosuffix --separator '|' -o pv_name,pv_size,pv_free 2>/dev/null || true
printf '%s\n' '__VRC_DIRS__'
for root in /data /mnt /srv /opt; do
  [ -d "$root" ] || continue
  [ -z "$(ls -A "$root" 2>/dev/null)" ] && printf '%s\n' "$root"
done
true
`;

export interface GuestStorageAccess {
  providerType: ProviderType;
  platformConnection: XenConnectionInput;
  vmIp: string;
  username?: string;
  password?: string;
  jumpConnection?: XenConnectionInput;
  executeCommand?: (command: string, timeoutMs: number) => Promise<string>;
  allowSshFallback?: boolean;
}

interface BlockRow {
  name: string;
  kname: string;
  type: string;
  sizeBytes: number;
  filesystem: string;
  mountPath: string;
  parentKname: string;
  startBytes: number;
}

interface PhysicalVolumeRow {
  path: string;
  sizeBytes: number;
  freeBytes: number;
}

export interface GuestStoragePreflight {
  inventory: GuestStorageInventory;
  mount?: GuestStorageMount;
  platformDisk?: VmDisk;
}

export type GuestStorageTransport = "platform-jump-ssh" | "configured-jump-ssh" | "direct-ssh";

export function resolveGuestStorageTransport(providerType: ProviderType, hasConfiguredJump = false): GuestStorageTransport {
  if (hasConfiguredJump) return "configured-jump-ssh";
  if (providerType === "xenserver") return "platform-jump-ssh";
  if (providerType === "proxmox" || providerType === "vmware") return "direct-ssh";
  throw new Error(`当前平台未配置系统存储执行策略：${providerType}`);
}

export function isGuestAuthenticationError(error: unknown): boolean {
  if (error && typeof error === "object" && "level" in error && error.level === "client-authentication") return true;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("All configured authentication methods failed")
    || message.includes("缺少虚拟机操作系统 SSH 密码");
}

export function isGuestAgentUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:QEMU Guest Agent|guest agent|guest-exec).*(?:不可用|未运行|未响应|未返回|未启用|禁用|not running|not available|disabled|timeout)/i.test(message);
}

export function buildGuestAuthenticationInventory(vmIp: string): GuestStorageInventory {
  return {
    vmIp,
    supported: false,
    reasonCode: "SYSTEM_AUTHENTICATION_REQUIRED",
    message: "后端默认凭据无法登录虚拟机操作系统，请提供系统登录名和密码；仅能通过 JumpServer 访问时请同时填写跳板连接。",
    disks: [],
    mounts: [],
    directories: [],
  };
}

export function buildGuestOfflineInventory(vmIp: string): GuestStorageInventory {
  return {
    vmIp,
    supported: false,
    reasonCode: "GUEST_OFFLINE",
    message: "虚拟机当前已关机，无法读取操作系统磁盘与目录。平台硬件可以离线调整；按现有目录扩容请先开机后重试。",
    disks: [],
    mounts: [],
    directories: [],
  };
}

export function buildGuestExecutionUnavailableInventory(vmIp: string, detail?: string): GuestStorageInventory {
  return {
    vmIp,
    supported: false,
    reasonCode: "SYSTEM_EXECUTION_UNAVAILABLE",
    message: detail || "系统执行通道不可用；请提供虚拟机系统账号和密码改用 SSH，仅能通过 JumpServer 访问时请同时填写跳板连接。",
    disks: [],
    mounts: [],
    directories: [],
  };
}

export async function inspectGuestStorage(access: GuestStorageAccess): Promise<GuestStorageInventory> {
  const output = await runGuestCommand(access, inspectStorageCommand, guestCommandTimeoutMs);
  return parseGuestStorageInventory(access.vmIp, output);
}

export function parseGuestStorageInventory(vmIp: string, output: string): GuestStorageInventory {
  const sections = splitSections(output);
  const starts = new Map(sections.starts.map(parsePartitionStart).filter((row): row is [string, number] => Boolean(row)));
  const rows = sections.lsblk
    .map(parseLsblkRow)
    .filter((row): row is BlockRow => Boolean(row))
    .map((row) => ({ ...row, startBytes: (starts.get(row.kname) || 0) * 512 }));
  const rowByKname = new Map(rows.map((row) => [row.kname, row]));
  const dfByMount = parseDfRows(sections.df);
  const physicalVolumes = new Map(sections.pvs.map(parsePhysicalVolumeRow).filter((row): row is PhysicalVolumeRow => Boolean(row)).map((row) => [row.path, row]));
  const disks = rows
    .filter((row) => row.type === "disk")
    .map((row) => ({
      path: `/dev/${row.kname}`,
      sizeBytes: row.sizeBytes,
      filesystem: row.filesystem || undefined,
      mountPath: row.mountPath || undefined,
    }))
    .sort((left, right) => left.path.localeCompare(right.path, "en", { numeric: true }));
  const mounts = rows
    .filter((row) => isSupportedMount(row.mountPath, row.filesystem))
    .map((row) => toGuestStorageMount(row, rowByKname, physicalVolumes, dfByMount.get(row.mountPath)))
    .filter((mount): mount is GuestStorageMount => Boolean(mount))
    .sort((left, right) => mountPriority(left.mountPath) - mountPriority(right.mountPath) || left.mountPath.localeCompare(right.mountPath));
  const directories = Array.from(new Set(sections.directories.map(normalizeMountPath).filter((path) => isAllowedMountPath(path))))
    .filter((path) => !mounts.some((mount) => mount.mountPath === path))
    .map((path) => ({ path, state: "empty" as const }));
  return {
    vmIp,
    supported: disks.length > 0,
    message: disks.length ? `已读取 ${disks.length} 块磁盘、${mounts.length} 个可扩容目录` : "虚拟机操作系统未返回可识别的块设备",
    disks,
    mounts,
    directories,
  };
}

export function linkGuestStorageToPlatformDisks(
  inventory: GuestStorageInventory,
  platformDisks: VmDisk[],
  providerType: ProviderType,
): GuestStorageInventory {
  const linkedMounts = inventory.mounts.map((mount) => ({
    ...mount,
    platformDiskId: resolvePlatformDiskId(mount.guestDiskPath, inventory, platformDisks, providerType),
  }));
  return { ...inventory, mounts: linkedMounts };
}

export async function preflightGuestStorageResize(
  access: GuestStorageAccess,
  disk: VmResizeDiskRequest,
  target: VmResizeStorageTarget,
  platformDisks: VmDisk[],
): Promise<GuestStoragePreflight> {
  const inventory = linkGuestStorageToPlatformDisks(await inspectGuestStorage(access), platformDisks, access.providerType);
  if (!inventory.supported) throw new Error(inventory.message);
  if (disk.mode === "extend") {
    const platformDisk = platformDisks.find((item) => item.id === disk.diskId || item.providerId === disk.diskId);
    if (!platformDisk) throw new Error("扩展原盘失败：目标磁盘不属于当前虚拟机。");
    const mount = inventory.mounts.find(
      (item) =>
        item.mountPath === normalizeMountPath(target.mountPath) &&
        item.platformDiskId === disk.diskId,
    );
    if (!mount) throw new Error("所选目录与目标虚拟磁盘不匹配，请刷新系统存储信息后重新选择。");
    await runGuestCommand(access, buildGuestToolPreflightCommand("extend", mount), guestCommandTimeoutMs);
    return { inventory, mount, platformDisk };
  }
  const mountPath = normalizeMountPath(target.mountPath);
  assertSafeNewMountPath(mountPath);
  await runGuestCommand(access, buildMountPathPreflightCommand(mountPath), guestCommandTimeoutMs);
  await runGuestCommand(access, buildGuestToolPreflightCommand("add"), guestCommandTimeoutMs);
  return { inventory };
}

export async function applyGuestStorageResize(input: {
  access: GuestStorageAccess;
  disk: VmResizeDiskRequest;
  target: VmResizeStorageTarget;
  restartAfterResize: boolean;
  preflight: GuestStoragePreflight;
}): Promise<VmResizeStorageResult> {
  const { access, disk, target, restartAfterResize, preflight } = input;
  const mountPath = normalizeMountPath(target.mountPath);
  try {
    await waitForGuestStorage(access);
    if (disk.mode === "extend") {
      if (!preflight.mount) throw new Error("扩展原盘缺少系统挂载信息。");
      if (!preflight.platformDisk) throw new Error("扩展原盘缺少平台磁盘信息。");
      await waitForGuestDiskSize(access, preflight.mount.guestDiskPath, disk.sizeBytes);
      const platformIncreaseBytes = Math.max(0, disk.sizeBytes - preflight.platformDisk.virtualSizeBytes);
      const guestIncreaseBytes = platformIncreaseBytes + preflight.mount.pendingCapacityBytes;
      if (guestIncreaseBytes <= diskSizeToleranceBytes) {
        throw new Error(`虚拟机操作系统未发现可分配到 ${mountPath} 的新增容量。`);
      }
      await extendGuestFilesystem(access, preflight.mount, guestIncreaseBytes, restartAfterResize);
    } else {
      const inventoryAfter = await rescanAndInspectGuestStorage(access, preflight.inventory.disks.length + 1);
      const newDisk = resolveNewGuestDisk(preflight.inventory, inventoryAfter, disk.sizeBytes);
      if (!newDisk) throw new Error("虚拟机操作系统未识别到本次新增的虚拟磁盘。");
      await runGuestCommand(access, buildAddFilesystemCommand(newDisk.path, mountPath), guestCommandTimeoutMs);
    }
    const verified = await inspectGuestStorage(access);
    const mount = verified.mounts.find((item) => item.mountPath === mountPath);
    if (!mount) throw new Error(`操作系统回读未发现挂载目录 ${mountPath}。`);
    if (disk.mode === "extend" && preflight.mount && preflight.platformDisk) {
      const platformIncreaseBytes = Math.max(0, disk.sizeBytes - preflight.platformDisk.virtualSizeBytes);
      const expectedIncreaseBytes = platformIncreaseBytes + preflight.mount.pendingCapacityBytes;
      const expectedMinimumBytes = preflight.mount.sizeBytes + Math.max(0, expectedIncreaseBytes - filesystemSizeToleranceBytes);
      if (mount.sizeBytes < expectedMinimumBytes) {
        throw new Error(
          `操作系统容量回读未达目标：${mountPath} 当前 ${formatGiB(mount.sizeBytes)} GiB，预期至少 ${formatGiB(expectedMinimumBytes)} GiB。`,
        );
      }
    }
    if (disk.mode === "add" && mount.sizeBytes < disk.sizeBytes - filesystemSizeToleranceBytes) {
      throw new Error(
        `新磁盘容量回读未达目标：${mountPath} 当前 ${formatGiB(mount.sizeBytes)} GiB，虚拟磁盘 ${formatGiB(disk.sizeBytes)} GiB。`,
      );
    }
    return {
      status: "completed",
      mountPath,
      sizeBytes: mount.sizeBytes,
      message: `系统内容量已生效：${mountPath}`,
    };
  } catch (error) {
    return {
      status: "failed",
      mountPath,
      message: `虚拟硬件已扩容，但系统内容量自动生效失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function splitSections(output: string): { lsblk: string[]; starts: string[]; df: string[]; pvs: string[]; directories: string[] } {
  const sections = { lsblk: [] as string[], starts: [] as string[], df: [] as string[], pvs: [] as string[], directories: [] as string[] };
  let current: keyof typeof sections | "" = "";
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "__VRC_LSBLK__") current = "lsblk";
    else if (line === "__VRC_STARTS__") current = "starts";
    else if (line === "__VRC_DF__") current = "df";
    else if (line === "__VRC_PVS__") current = "pvs";
    else if (line === "__VRC_DIRS__") current = "directories";
    else if (line && current) sections[current].push(line);
  }
  return sections;
}

function parsePartitionStart(line: string): [string, number] | null {
  const [name = "", start = ""] = line.split("|");
  const startSectors = parsePositiveNumber(start);
  return /^[A-Za-z0-9._-]+$/.test(name) && startSectors > 0 ? [name, startSectors] : null;
}

function parsePhysicalVolumeRow(line: string): PhysicalVolumeRow | null {
  const [path = "", size = "", free = ""] = line.split("|").map((value) => value.trim());
  if (!path.startsWith("/dev/")) return null;
  return {
    path,
    sizeBytes: parsePositiveNumber(size),
    freeBytes: parsePositiveNumber(free),
  };
}

function parseLsblkRow(line: string): BlockRow | null {
  const fields = parsePairs(line);
  const kname = fields.KNAME || fields.NAME;
  if (!kname || !fields.TYPE) return null;
  return {
    name: fields.NAME || kname,
    kname,
    type: fields.TYPE,
    sizeBytes: parsePositiveNumber(fields.SIZE),
    filesystem: fields.FSTYPE || "",
    mountPath: fields.MOUNTPOINT || "",
    parentKname: fields.PKNAME || "",
    startBytes: 0,
  };
}

function parsePairs(line: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of line.matchAll(/([A-Z0-9_]+)="((?:\\.|[^"])*)"/g)) {
    result[match[1]] = match[2].replace(/\\x20/g, " ").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return result;
}

function parseDfRows(lines: string[]): Map<string, { source: string; sizeBytes: number; usedBytes: number; availableBytes: number }> {
  const result = new Map<string, { source: string; sizeBytes: number; usedBytes: number; availableBytes: number }>();
  for (const line of lines) {
    if (line.startsWith("Filesystem")) continue;
    const columns = line.split(/\s+/);
    if (columns.length < 6) continue;
    const mountPath = columns.slice(5).join(" ");
    result.set(mountPath, {
      source: columns[0],
      sizeBytes: parsePositiveNumber(columns[1]),
      usedBytes: parsePositiveNumber(columns[2]),
      availableBytes: parsePositiveNumber(columns[3]),
    });
  }
  return result;
}

function toGuestStorageMount(
  row: BlockRow,
  rowByKname: Map<string, BlockRow>,
  physicalVolumes: Map<string, PhysicalVolumeRow>,
  usage?: { source: string; sizeBytes: number; usedBytes: number; availableBytes: number },
): GuestStorageMount | null {
  const ancestors: BlockRow[] = [];
  const visited = new Set<string>();
  let current: BlockRow | undefined = row;
  while (current && !visited.has(current.kname)) {
    ancestors.push(current);
    visited.add(current.kname);
    current = current.parentKname ? rowByKname.get(current.parentKname) : undefined;
  }
  const disk = ancestors.find((item) => item.type === "disk");
  if (!disk) return null;
  const partition = ancestors.find((item) => item.type === "part");
  const logicalVolume = row.type === "lvm" || row.kname.startsWith("dm-");
  const partitionPath = partition ? `/dev/${partition.kname}` : undefined;
  const physicalVolume = partitionPath ? physicalVolumes.get(partitionPath) : undefined;
  const filesystemSizeBytes = usage?.sizeBytes || row.sizeBytes;
  const pendingCapacityBytes = logicalVolume
    ? Math.max(0, disk.sizeBytes - (partition?.startBytes || 0) - (partition?.sizeBytes || disk.sizeBytes)) +
      Math.max(0, (partition?.sizeBytes || 0) - (physicalVolume?.sizeBytes || partition?.sizeBytes || 0)) +
      (physicalVolume?.freeBytes || 0)
    : Math.max(0, disk.sizeBytes - (partition?.startBytes || 0) - (partition?.sizeBytes || disk.sizeBytes)) +
      Math.max(0, (partition?.sizeBytes || disk.sizeBytes) - filesystemSizeBytes);
  return {
    mountPath: row.mountPath,
    // dm-N is an unstable kernel alias and is not a valid lvextend target on older LVM releases.
    source: usage?.source || `/dev/${row.kname}`,
    filesystem: row.filesystem.toLowerCase(),
    sizeBytes: filesystemSizeBytes,
    usedBytes: usage?.usedBytes || 0,
    availableBytes: usage?.availableBytes || 0,
    guestDiskPath: `/dev/${disk.kname}`,
    guestPartitionPath: partitionPath,
    guestPartitionSizeBytes: partition?.sizeBytes,
    logicalVolume,
    pendingCapacityBytes,
  };
}

function resolvePlatformDiskId(
  guestDiskPath: string,
  inventory: GuestStorageInventory,
  platformDisks: VmDisk[],
  providerType: ProviderType,
): string | undefined {
  const guestDisk = inventory.disks.find((disk) => disk.path === guestDiskPath);
  if (!guestDisk) return undefined;
  if (providerType === "xenserver") {
    const guestIndex = guestDiskIndex(guestDiskPath);
    const exact = platformDisks.find((disk) => Number(disk.device) === guestIndex);
    if (exact) return exact.id;
  }
  const sizeMatches = platformDisks.filter((disk) => Math.abs(disk.virtualSizeBytes - guestDisk.sizeBytes) <= diskSizeToleranceBytes);
  if (sizeMatches.length === 1) return sizeMatches[0].id;
  const guestIndex = guestDiskIndex(guestDiskPath);
  if (guestIndex < 0) return undefined;
  const orderedPlatformDisks = [...platformDisks].sort((left, right) => diskOrder(left) - diskOrder(right));
  return orderedPlatformDisks[guestIndex]?.id;
}

function guestDiskIndex(path: string): number {
  const name = path.replace(/^\/dev\//, "");
  const letterMatch = name.match(/^(?:xvd|sd|vd)([a-z]+)$/);
  if (letterMatch) return alphaIndex(letterMatch[1]);
  const nvmeMatch = name.match(/^nvme\d+n(\d+)$/);
  if (nvmeMatch) return Math.max(0, Number(nvmeMatch[1]) - 1);
  return -1;
}

function alphaIndex(value: string): number {
  let result = 0;
  for (const char of value) result = result * 26 + char.charCodeAt(0) - 96;
  return result - 1;
}

function diskOrder(disk: VmDisk): number {
  const numeric = disk.device.match(/(\d+)$/)?.[1] || disk.name.match(/(\d+)$/)?.[1];
  return numeric ? Number(numeric) : Number.MAX_SAFE_INTEGER;
}

function buildMountPathPreflightCommand(mountPath: string): string {
  const path = shellQuote(mountPath);
  return String.raw`
set -eu
path=${path}
if mountpoint -q "$path" 2>/dev/null; then
  echo "目标目录已挂载：$path" >&2
  exit 31
fi
if [ -e "$path" ]; then
  [ -d "$path" ] || { echo "目标路径不是目录：$path" >&2; exit 32; }
  [ -z "$(ls -A "$path" 2>/dev/null)" ] || { echo "目标目录不是空目录：$path" >&2; exit 33; }
fi
`;
}

function buildGuestToolPreflightCommand(mode: "extend" | "add", mount?: GuestStorageMount): string {
  const required = mode === "add"
    ? ["lsblk", "parted", "partprobe", "mkfs.xfs", "blkid", "mount"]
    : [
        "lsblk",
        "partprobe",
        ...(mount?.logicalVolume ? ["pvresize", "lvextend", "findmnt"] : []),
        ...(mount?.filesystem === "xfs" ? ["xfs_growfs"] : ["resize2fs"]),
      ];
  const requiredList = required.map(shellQuote).join(" ");
  const partitionToolCheck = mode === "extend" && mount?.guestPartitionPath
    ? "command -v growpart >/dev/null 2>&1 || command -v parted >/dev/null 2>&1 || command -v sfdisk >/dev/null 2>&1 || { echo '操作系统缺少 growpart/parted/sfdisk' >&2; exit 35; }"
    : "true";
  return String.raw`
set -eu
for tool in ${requiredList}; do
  command -v "$tool" >/dev/null 2>&1 || { echo "操作系统缺少自动存储工具：$tool" >&2; exit 34; }
done
${partitionToolCheck}
`;
}

export function buildExtendFilesystemCommand(mount: GuestStorageMount, increaseBytes = 0): string {
  const disk = shellQuote(mount.guestDiskPath);
  const partition = mount.guestPartitionPath ? shellQuote(mount.guestPartitionPath) : "";
  const source = shellQuote(mount.source);
  const mountPath = shellQuote(mount.mountPath);
  const partitionNumber = mount.guestPartitionPath ? partitionIndex(mount.guestPartitionPath) : 0;
  const lvmIncreaseMiB = Math.max(1, Math.floor(increaseBytes / 1024 ** 2) - 32);
  return String.raw`
set -eu
disk=${disk}
partition=${partition || "''"}
source=${source}
mount_path=${mountPath}
if [ -n "$partition" ]; then
  disk_bytes="$(blockdev --getsize64 "$disk")"
  partition_bytes="$(blockdev --getsize64 "$partition")"
  partition_name="${mount.guestPartitionPath?.replace(/^\/dev\//, "") ?? ""}"
  partition_start_sectors="$(cat "/sys/class/block/$partition_name/start" 2>/dev/null || printf '0')"
  partition_start_bytes=$((partition_start_sectors * 512))
  if [ $((partition_start_bytes + partition_bytes)) -lt $((disk_bytes - ${diskSizeToleranceBytes})) ]; then
    if command -v growpart >/dev/null 2>&1 && growpart "$disk" ${partitionNumber}; then
      true
    elif command -v parted >/dev/null 2>&1 && parted help resizepart 2>&1 | grep -q resizepart; then
      parted -s "$disk" resizepart ${partitionNumber} 100%
    elif command -v sfdisk >/dev/null 2>&1; then
      last_partition="$(lsblk -nr -o NAME,TYPE "$disk" | awk '$2 == "part" { print $1 }' | tail -n 1)"
      [ "$last_partition" = "$partition_name" ] || { echo "仅允许扩展磁盘末尾分区：$partition" >&2; exit 46; }
      table_type="$(parted -m -s "$disk" unit s print 2>/dev/null | sed -n '2p' | cut -d: -f6)"
      [ "$table_type" = "msdos" ] || { echo "当前旧版工具不支持自动扩展 $table_type 分区表" >&2; exit 47; }
      entry="$(sfdisk -d "$disk" | grep "^$partition :" | head -n 1)"
      start_sector="$(printf '%s\n' "$entry" | sed -n 's/.*start= *\([0-9]*\).*/\1/p')"
      partition_id="$(printf '%s\n' "$entry" | sed -n 's/.*Id= *\([0-9A-Fa-f]*\).*/\1/p')"
      total_sectors="$(blockdev --getsz "$disk")"
      [ -n "$start_sector" ] && [ -n "$partition_id" ] && [ "$total_sectors" -gt "$start_sector" ] || {
        echo "无法读取目标分区边界，已停止扩容" >&2
        exit 48
      }
      new_partition_sectors=$((total_sectors - start_sector))
      backup_dir="/var/lib/vrc/storage-backups"
      mkdir -p "$backup_dir"
      backup_file="$backup_dir/$(basename "$disk")-$(date +%Y%m%d%H%M%S).sfdisk"
      sfdisk -d "$disk" > "$backup_file"
      if ! printf '%s,%s,%s\n' "$start_sector" "$new_partition_sectors" "$partition_id" |
        sfdisk -uS --no-reread -N ${partitionNumber} "$disk" >/dev/null; then
        true
      fi
      updated_entry="$(sfdisk -d "$disk" | grep "^$partition :" | head -n 1)"
      updated_sectors="$(printf '%s\n' "$updated_entry" | sed -n 's/.*size= *\([0-9]*\).*/\1/p')"
      [ -n "$updated_sectors" ] && [ "$updated_sectors" -ge "$new_partition_sectors" ] || {
        echo "目标分区表写入校验失败，备份位于 $backup_file" >&2
        exit 49
      }
    else
      echo "操作系统缺少可用的分区扩展工具" >&2
      exit 41
    fi
    partprobe "$disk" 2>/dev/null || true
    partx -u "$disk" 2>/dev/null || true
    udevadm settle 2>/dev/null || true
    partition_bytes="$(blockdev --getsize64 "$partition")"
    if [ $((partition_start_bytes + partition_bytes)) -lt $((disk_bytes - ${diskSizeToleranceBytes})) ]; then
      printf '%s\n' '${guestPartitionRebootMarker}'
      exit 0
    fi
  fi
fi
if ${mount.logicalVolume ? "true" : "false"}; then
  [ -n "$partition" ] || { echo "LVM 未识别到物理分区" >&2; exit 42; }
  pvresize "$partition"
  mounted_source="$(findmnt -n -o SOURCE --target "$mount_path" 2>/dev/null | head -n 1)"
  [ -n "$mounted_source" ] || { echo "无法读取挂载目录 $mount_path 对应的逻辑卷" >&2; exit 44; }
  source="$mounted_source"
  lvextend -L +${lvmIncreaseMiB}M "$source"
fi
case ${shellQuote(mount.filesystem)} in
  xfs) xfs_growfs "$mount_path" ;;
  ext2|ext3|ext4) resize2fs "$source" ;;
  *) echo "不支持自动扩容的文件系统：${mount.filesystem}" >&2; exit 43 ;;
esac
`;
}

async function extendGuestFilesystem(
  access: GuestStorageAccess,
  mount: GuestStorageMount,
  increaseBytes: number,
  allowRestart: boolean,
): Promise<void> {
  const command = buildExtendFilesystemCommand(mount, increaseBytes);
  const firstOutput = await runGuestCommand(access, command, guestCommandTimeoutMs);
  if (!firstOutput.includes(guestPartitionRebootMarker)) return;
  if (!allowRestart) {
    throw new Error("虚拟机操作系统内核需要重启后才能识别新分区容量。请允许自动重启后重试。");
  }
  await restartGuest(access);
  const secondOutput = await runGuestCommand(access, command, guestCommandTimeoutMs);
  if (secondOutput.includes(guestPartitionRebootMarker)) {
    throw new Error("虚拟机操作系统重启后仍未识别新分区容量，已停止文件系统变更。");
  }
}

async function restartGuest(access: GuestStorageAccess): Promise<void> {
  await runGuestCommand(
    access,
    "nohup sh -c 'sleep 2; /sbin/reboot' >/dev/null 2>&1 & printf '%s\\n' '__VRC_REBOOTING__'",
    guestCommandTimeoutMs,
  );
  const disconnectDeadline = Date.now() + 45_000;
  let disconnected = false;
  while (Date.now() < disconnectDeadline) {
    await delay(2_000);
    try {
      await runGuestCommand(access, "true", 5_000);
    } catch {
      disconnected = true;
      break;
    }
  }
  if (!disconnected) throw new Error("虚拟机操作系统已提交重启，但 SSH 在 45 秒内未中断。");
  await waitForGuestStorage(access);
}

export function buildAddFilesystemCommand(diskPath: string, mountPath: string): string {
  const disk = shellQuote(diskPath);
  const path = shellQuote(mountPath);
  const partition = shellQuote(`${diskPath}${/\d$/.test(diskPath) ? "p" : ""}1`);
  return String.raw`
set -eu
disk=${disk}
partition=${partition}
mount_path=${path}
[ -b "$disk" ] || { echo "新增磁盘设备不存在：$disk" >&2; exit 51; }
[ -z "$(lsblk -n -o FSTYPE "$disk" 2>/dev/null | tr -d '[:space:]')" ] || { echo "新增磁盘已有文件系统，拒绝格式化" >&2; exit 52; }
parted -s "$disk" mklabel gpt mkpart primary 1MiB 100%
partprobe "$disk" 2>/dev/null || true
udevadm settle 2>/dev/null || true
for attempt in $(seq 1 20); do [ -b "$partition" ] && break; sleep 1; done
[ -b "$partition" ] || { echo "新增磁盘分区未出现：$partition" >&2; exit 53; }
mkfs.xfs -f "$partition"
mkdir -p "$mount_path"
uuid="$(blkid -s UUID -o value "$partition")"
[ -n "$uuid" ] || { echo "无法读取新文件系统 UUID" >&2; exit 54; }
backup="/etc/fstab.vrc-$(date +%Y%m%d%H%M%S)"
cp -a /etc/fstab "$backup"
line="UUID=$uuid $mount_path xfs defaults,nofail 0 2"
grep -Fq "UUID=$uuid " /etc/fstab || printf '%s\n' "$line" >> /etc/fstab
if ! mount "$mount_path"; then
  cp -a "$backup" /etc/fstab
  echo "新磁盘写入 fstab 后挂载失败，已恢复 fstab" >&2
  exit 55
fi
`;
}

async function waitForGuestStorage(access: GuestStorageAccess): Promise<GuestStorageInventory> {
  const deadline = Date.now() + guestReconnectTimeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await inspectGuestStorage(access);
    } catch (error) {
      lastError = error;
      await delay(3_000);
    }
  }
  throw new Error(`等待虚拟机操作系统 SSH 恢复超时：${lastError instanceof Error ? lastError.message : "连接不可用"}`);
}

async function waitForGuestDiskSize(access: GuestStorageAccess, diskPath: string, targetBytes: number): Promise<void> {
  const deadline = Date.now() + 60_000;
  const blockName = diskPath.replace(/^\/dev\//, "");
  while (Date.now() < deadline) {
    const output = await runGuestCommand(
      access,
      `echo 1 > /sys/class/block/${shellBare(blockName)}/device/rescan 2>/dev/null || true; blockdev --getsize64 ${shellQuote(diskPath)} 2>/dev/null || true`,
      guestCommandTimeoutMs,
    );
    if (parsePositiveNumber(output.trim().split(/\r?\n/).at(-1)) >= targetBytes - diskSizeToleranceBytes) return;
    await delay(2_000);
  }
  throw new Error(`虚拟机操作系统未回读到 ${diskPath} 的新容量。`);
}

async function rescanAndInspectGuestStorage(access: GuestStorageAccess, expectedDiskCount: number): Promise<GuestStorageInventory> {
  await runGuestCommand(
    access,
    "for host in /sys/class/scsi_host/host*; do echo '- - -' > \"$host/scan\" 2>/dev/null || true; done; udevadm settle 2>/dev/null || true",
    guestCommandTimeoutMs,
  );
  const deadline = Date.now() + 30_000;
  let latest = await inspectGuestStorage(access);
  while (Date.now() < deadline) {
    if (latest.disks.length >= expectedDiskCount) return latest;
    await delay(2_000);
    latest = await inspectGuestStorage(access);
  }
  return latest;
}

function resolveNewGuestDisk(before: GuestStorageInventory, after: GuestStorageInventory, expectedSizeBytes: number) {
  const existing = new Set(before.disks.map((disk) => disk.path));
  const candidates = after.disks.filter(
    (disk) =>
      !existing.has(disk.path) &&
      !disk.filesystem &&
      !disk.mountPath &&
      Math.abs(disk.sizeBytes - expectedSizeBytes) <= diskSizeToleranceBytes,
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}

function runGuestCommand(access: GuestStorageAccess, command: string, timeoutMs: number): Promise<string> {
  if (access.executeCommand) {
    return access.executeCommand(command, timeoutMs).catch((error) => {
      // Only an explicitly supplied VM credential may opt into SSH fallback.
      if (!access.allowSshFallback) throw error;
      return runGuestSshCommand(access, command, timeoutMs);
    });
  }
  return runGuestSshCommand(access, command, timeoutMs);
}

function runGuestSshCommand(access: GuestStorageAccess, command: string, timeoutMs: number): Promise<string> {
  const credentials = resolveGuestCredentials(access);
  const transport = resolveGuestStorageTransport(access.providerType, Boolean(access.jumpConnection));
  if (transport === "direct-ssh") {
    return executeSshCommand(
      {
        host: access.vmIp,
        port: 22,
        username: credentials.username,
        password: credentials.password,
        readyTimeout: guestReadyTimeoutMs,
        algorithms: guestSshAlgorithms(),
      },
      command,
      timeoutMs,
    );
  }
  const jumpConnection = transport === "configured-jump-ssh" ? access.jumpConnection : access.platformConnection;
  if (!jumpConnection) throw new Error("缺少 JumpServer 连接参数。");
  return executeJumpSshCommand(jumpConnection, access.vmIp, credentials, command, timeoutMs);
}

function executeJumpSshCommand(
  jumpConnection: XenConnectionInput,
  vmIp: string,
  credentials: { username: string; password: string },
  command: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const jumpClient = new Client();
    let settled = false;
    const finish = (error?: Error, value?: string) => {
      if (settled) return;
      settled = true;
      jumpClient.end();
      if (error) reject(error);
      else resolve(value ?? "");
    };
    jumpClient
      .on("ready", () => {
        jumpClient.forwardOut("127.0.0.1", 0, vmIp, 22, (error, stream) => {
          if (error) {
            finish(new Error(`JumpServer 无法访问虚拟机 ${vmIp}:22：${error.message}`));
            return;
          }
          executeSshCommand(
            {
              sock: stream,
              username: credentials.username,
              password: credentials.password,
              readyTimeout: guestReadyTimeoutMs,
              algorithms: guestSshAlgorithms(),
            },
            command,
            timeoutMs,
          ).then((value) => finish(undefined, value), (commandError) => finish(toError(commandError)));
        });
      })
      .on("error", (error) => finish(new Error(`JumpServer 连接失败：${error.message}`)))
      .connect({
        host: jumpConnection.host,
        port: jumpConnection.port,
        username: jumpConnection.username,
        password: jumpConnection.password,
        readyTimeout: guestReadyTimeoutMs,
        algorithms: guestSshAlgorithms(),
      });
  });
}

function executeSshCommand(config: ConnectConfig, command: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => finish(new Error(`操作系统命令执行超时（${Math.ceil(timeoutMs / 1000)} 秒）`)), timeoutMs);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.end();
      if (error) reject(error);
      else resolve(stdout);
    };
    client
      .on("ready", () => {
        client.exec(command, (error, stream) => {
          if (error) {
            finish(error);
            return;
          }
          stream
            .on("close", (code: number) => {
              if (code !== 0) finish(new Error(stderr.trim() || `操作系统命令退出：${code}`));
              else finish();
            })
            .on("data", (chunk: Buffer) => {
              stdout += chunk.toString("utf8");
            })
            .stderr.on("data", (chunk: Buffer) => {
              stderr += chunk.toString("utf8");
            });
        });
      })
      .on("error", (error) => finish(error))
      .connect(config);
  });
}

function resolveGuestCredentials(access: GuestStorageAccess): { username: string; password: string } {
  const username = access.username?.trim() || "root";
  const password = access.password?.trim() || deriveRootPassword(access.vmIp);
  if (!password) throw new Error("缺少虚拟机操作系统 SSH 密码，请在运行策略中配置 root 密码规则或提交临时密码。");
  return { username, password };
}

function deriveRootPassword(ip: string): string {
  const template = getRuntimePolicy().provisioning.rootPasswordTemplate;
  const parts = ip.split(".");
  if (!template || parts.length !== 4) return "";
  return template
    .replaceAll("{first}", parts[0])
    .replaceAll("{second}", parts[1])
    .replaceAll("{third}", parts[2])
    .replaceAll("{fourth}", parts[3])
    .replaceAll("{ip}", ip);
}

function guestSshAlgorithms(): ConnectConfig["algorithms"] {
  return {
    kex: [
      "curve25519-sha256",
      "curve25519-sha256@libssh.org",
      "ecdh-sha2-nistp256",
      "diffie-hellman-group14-sha256",
      "diffie-hellman-group14-sha1",
      "diffie-hellman-group-exchange-sha1",
      "diffie-hellman-group1-sha1",
    ],
    serverHostKey: ["rsa-sha2-512", "rsa-sha2-256", "ssh-rsa", "ecdsa-sha2-nistp256", "ssh-ed25519", "ssh-dss"],
  };
}

function assertSafeNewMountPath(path: string): void {
  if (!isAllowedMountPath(path)) throw new Error("挂载目录仅允许位于 /data、/mnt、/srv 或 /opt 下。");
}

function isAllowedMountPath(path: string): boolean {
  return /^\/(?:data|mnt|srv|opt)(?:\/[A-Za-z0-9._-]+)*$/.test(path);
}

function normalizeMountPath(value: string): string {
  const path = value.trim().replace(/\/{2,}/g, "/").replace(/\/$/, "");
  return path || "/";
}

function isSupportedFilesystem(filesystem: string): boolean {
  return ["xfs", "ext2", "ext3", "ext4"].includes(filesystem.toLowerCase());
}

function isSupportedMount(path: string, filesystem: string): boolean {
  if (!path.startsWith("/") || ["/boot", "/boot/efi"].includes(path)) return false;
  return isSupportedFilesystem(filesystem);
}

function mountPriority(path: string): number {
  if (path === "/") return 0;
  if (path === "/home") return 1;
  return 10;
}

function partitionIndex(path: string): number {
  const match = path.match(/(?:p)?(\d+)$/);
  const value = Number(match?.[1] ?? 0);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`无法识别分区编号：${path}`);
  return value;
}

function parsePositiveNumber(value: string | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function formatGiB(value: number): string {
  return (value / 1024 ** 3).toFixed(1);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shellBare(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new Error("块设备名称不安全。");
  return value;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function formatErrorMessage(error: unknown): string {
  return toError(error).message || String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
