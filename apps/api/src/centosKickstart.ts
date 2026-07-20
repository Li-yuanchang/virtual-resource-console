const mibPerGiB = 1024;
const bootMiB = 500;
const efiMiB = 600;
const swapMiB = 8192;
const minimumHomeMiB = 1024;
const minimumRootMiB = 20 * mibPerGiB;
const preferredRootMiB = 50 * mibPerGiB;
const partitioningReserveMiB = 512;

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

/** Builds a non-interactive CentOS package selection that tolerates packages absent from older DVD media. */
export function buildCentosPackageSelection(
  additionalPackages: string[] = [],
  options: { environmentGroup?: string } = {},
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
    "-dracut-config-rescue",
    "%end",
  ].join("\n");
}
