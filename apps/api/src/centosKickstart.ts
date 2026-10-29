const mibPerGiB = 1024;
const bootMiB = 500;
const efiMiB = 600;
const swapMiB = 8192;
const minimumHomeMiB = 1024;
const minimumRootMiB = 20 * mibPerGiB;
const preferredRootMiB = 50 * mibPerGiB;
const partitioningReserveMiB = 512;

/**
 * 判断镜像名是否属于 RHEL 系（CentOS / Rocky / RHEL / AlmaLinux / Oracle Linux）。
 * XenServer 无人值守策略、集中安装源预检均以此识别可自动应答的 Linux 安装盘。
 */
export function isRedHatFamilyImage(name: string): boolean {
  return /rocky|centos|rhel|red hat|redhat|alma|oracle/i.test(name);
}

/**
 * 判断镜像名是否属于 Rocky Linux 9（当前老 Xen 环境唯一特殊处理的现代 RHEL）。
 * Rocky 9 内核 5.14 在 XenServer 6.5（Xen 4.4）上需要 xen_nopv 引导参数 + platform:device_id=0001，
 * 强制走模拟设备规避 PV 卡死（127.33 实测重启通过）；老 Xen 官方不支持 RHEL9 tools，
 * Rocky 9 不安装 xe-guest-utilities / xs-tools。RHEL/AlmaLinux/Oracle Linux/CentOS 均不套用该策略，避免一刀切。
 */
export function isRocky9Image(name: string): boolean {
  const normalized = String(name || "").toLowerCase();
  if (!normalized.includes("rocky")) return false;
  const versionMatch = normalized.match(/rocky[^0-9]*([0-9]+)/);
  const major = versionMatch ? Number(versionMatch[1]) : 0;
  return major === 9;
}

/**
 * 判断镜像名是否属于 RHEL 9 世代（Rocky 9 / CentOS Stream 9 / RHEL 9 / AlmaLinux 9 / Oracle Linux 9）。
 *
 * 与 {@link isRocky9Image} 的区别必须严格区分，不能互相替代：
 * - 本函数只决定 **kickstart 语法分支**：RHEL 9 的 Anaconda 已删除 `install` 与 `auth` 指令，
 *   保留 `auth` 会让 Anaconda 强依赖 `authselect-compat`（minimal 源不含该包），
 *   安装到 "Authconfig configuration" 任务直接硬失败（127.37 实测 SecurityInstallationError）。
 *   语法层统一走非 LVM 分区 + `rootpw --lock` + `%post chpasswd`。
 * - `isRocky9Image` 决定的是 **Xen 4.4 硬件兼容策略**（`xen_nopv` 模拟设备、不装 xe-tools），
 *   只对 Rocky 9 成立，禁止外溢到 CentOS/Alma/Oracle。
 *
 * 注意：CentOS Stream 9 的版本号位于 "stream" 之后，需单独匹配，不能只按 `centos*9` 判断，
 * 否则 `CentOS-Stream-8` 之类的旧版本会被误判。
 */
export function isRhel9FamilyImage(name: string): boolean {
  const normalized = String(name || "").toLowerCase();
  if (!isRedHatFamilyImage(normalized)) return false;
  if (/centos\s*stream[^0-9]*9/.test(normalized)) return true;
  if (/\bstream\b[^0-9]*9/.test(normalized) && normalized.includes("centos")) return true;
  const versionMatch = normalized.match(/(?:rocky|rhel|red hat|redhat|almalinux|alma|oraclelinux|oracle|centos)[^0-9]*([0-9]+)/);
  const major = versionMatch ? Number(versionMatch[1]) : 0;
  return major === 9;
}

export function buildCentosLvmPartitioning(
  diskGiB: number,
  options: { firmware?: "bios" | "uefi" } = {},
): string {
  const diskMiB = Math.max(Math.floor(diskGiB * mibPerGiB), 0);
  const firmwareReserveMiB = options.firmware === "uefi" ? efiMiB : 0;
  const availableRootMiB = diskMiB - bootMiB - firmwareReserveMiB - swapMiB - minimumHomeMiB - partitioningReserveMiB;
  const rootMiB = Math.min(preferredRootMiB, Math.max(minimumRootMiB, availableRootMiB));
  return `zerombr
clearpart --all --initlabel
${options.firmware === "uefi" ? `part /boot/efi --fstype=efi --size=${efiMiB} --fsoptions="umask=0077,shortname=winnt"\n` : ""}part /boot --fstype=xfs --size=${bootMiB}
part pv.01 --fstype=lvmpv --size=1 --grow
volgroup vrc --pesize=4096 pv.01
logvol / --fstype=xfs --name=root --vgname=vrc --size=${rootMiB}
logvol swap --fstype=swap --name=swap --vgname=vrc --size=${swapMiB}
logvol /home --fstype=xfs --name=home --vgname=vrc --size=${minimumHomeMiB} --grow`;
}

/**
 * 生成 Rocky 9 非 LVM 分区方案。
 * 该方案与在 XenServer 6.5 上验收通过的 127.33 一致：/boot 1G、swap 8G、/ 占满剩余空间，
 * 避免 LVM 在旧 Xen 环境下的额外复杂度。
 */
export function buildRedHatPlainPartitioning(
  _diskGiB: number,
  options: { firmware?: "bios" | "uefi" } = {},
): string {
  const efiPart = options.firmware === "uefi" ? `part /boot/efi --fstype=efi --size=${efiMiB} --fsoptions="umask=0077,shortname=winnt"\n` : "";
  return `zerombr
clearpart --all --initlabel
${efiPart}part /boot --fstype=xfs --size=1024
part swap --fstype=swap --size=8192
part / --fstype=xfs --size=1 --grow`;
}

/** Builds a non-interactive CentOS package selection that tolerates packages absent from older DVD media. */
export function buildCentosPackageSelection(
  additionalPackages: string[] = [],
  options: { environmentGroup?: string; excludeVmFirmware?: boolean } = {},
): string {
  const environmentGroup = options.environmentGroup?.trim();
  if (environmentGroup && !/^[A-Za-z0-9._-]+$/.test(environmentGroup)) {
    throw new Error(`Kickstart 软件环境组不合法：${environmentGroup}`);
  }
  return [
    "%packages --ignoremissing",
    environmentGroup ? `@^${environmentGroup}` : "@core",
    "net-tools",
    "openssh-server",
    ...additionalPackages.map((item) => item.trim()).filter(Boolean),
    // 虚拟机不需要固件驱动包。linux-firmware（约 476MB）/ iwl7260-firmware（约 61MB）是
    // 老 XenServer 6.5 rtl8139 网络在超大单文件传输时接收窗口冻结的最大触发源；
    // Rocky 9 HTTP 安装排除后，剩余最大 RPM 约 57MB（llvm-libs），可显著降低安装中断概率。
    ...(options.excludeVmFirmware ? ["-linux-firmware", "-iwl7260-firmware"] : []),
    "-dracut-config-rescue",
    "%end",
  ].join("\n");
}
