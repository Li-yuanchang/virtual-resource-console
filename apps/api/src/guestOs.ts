const EMPTY_OS_VALUES = new Set(["", "-", "unknown", "other", "other install media", "<not in database>"]);

/**
 * Converts provider-specific guest OS strings into concise labels suitable for inventory tables.
 * Exact distribution data wins; kernel-only values are reduced to a conservative OS family.
 */
export function normalizeGuestOsLabel(value: unknown): string | undefined {
  const raw = String(value ?? "").replace(/\s+/g, " ").trim();
  if (EMPTY_OS_VALUES.has(raw.toLowerCase())) return undefined;

  const openEuler = raw.match(/open\s*euler(?:\s+release)?\s*([0-9]+(?:\.[0-9]+){0,2}(?:\s*LTS(?:-SP\d+)?)?)/i);
  if (openEuler) return `openEuler ${openEuler[1]}`;
  if (/open\s*euler/i.test(raw) || /(?:^|[-.])oe\d*(?:[.-]|$)/i.test(raw)) return "openEuler";

  const centos = raw.match(/centos(?:\s+linux)?(?:\s+release)?\s*([0-9]+(?:\.[0-9]+)*)?/i);
  if (centos) return joinVersion("CentOS", centos[1]);
  const rocky = raw.match(/rocky(?:\s+linux)?(?:\s+release)?\s*([0-9]+(?:\.[0-9]+)*)?/i);
  if (rocky) return joinVersion("Rocky Linux", rocky[1]);
  const alma = raw.match(/alma\s*linux(?:\s+release)?\s*([0-9]+(?:\.[0-9]+)*)?/i);
  if (alma) return joinVersion("AlmaLinux", alma[1]);
  const rhel = raw.match(/(?:red\s+hat(?:\s+enterprise\s+linux)?|rhel)(?:\s+server)?(?:\s+release)?\s*([0-9]+(?:\.[0-9]+)*)?/i);
  if (rhel) return joinVersion("RHEL", rhel[1]);

  const ubuntu = raw.match(/ubuntu(?:\s+linux)?\s*([0-9]+(?:\.[0-9]+){1,2})?/i);
  if (ubuntu) return joinVersion("Ubuntu", ubuntu[1]);
  const debian = raw.match(/debian(?:\s+gnu\/linux)?\s*([0-9]+(?:\.[0-9]+)*)?/i);
  if (debian) return joinVersion("Debian", debian[1]);
  const kylin = raw.match(/(?:neo\s*kylin|kylin)(?:\s+linux)?(?:\s+server)?\s*([vV]?[0-9]+(?:\.[0-9]+)*)?/i);
  if (kylin) return joinVersion(/neo/i.test(kylin[0]) ? "NeoKylin" : "Kylin", kylin[1]?.replace(/^v/i, ""));

  const windows = normalizeWindowsLabel(raw);
  if (windows) return windows;

  const enterpriseLinuxKernel = raw.match(/(?:^|[-.])el([7-9])(?:[._-]|$)/i);
  if (enterpriseLinuxKernel) return `CentOS / RHEL ${enterpriseLinuxKernel[1]}`;
  if (/^linux\s+\d/i.test(raw)) return "Linux";
  if (looksLikeKernelVersion(raw)) return "Linux";

  return raw
    .replace(/\s*\((?:32|64)-bit\)\s*/gi, " ")
    .replace(/\s+(?:guest|operating system)$/i, "")
    .replace(/\s+/g, " ")
    .trim() || undefined;
}

function joinVersion(label: string, version?: string): string {
  return version ? `${label} ${version}` : label;
}

function normalizeWindowsLabel(raw: string): string | undefined {
  if (!/windows/i.test(raw)) return undefined;
  const server = raw.match(/windows\s+server\s+(2003|2008(?:\s*R2)?|2012(?:\s*R2)?|2016|2019|2022|2025)/i);
  if (server) return `Windows Server ${server[1].replace(/\s+/g, " ")}`;
  const desktop = raw.match(/windows\s+(XP|Vista|7|8(?:\.1)?|10|11)/i);
  if (desktop) return `Windows ${desktop[1]}`;
  return "Windows";
}

function looksLikeKernelVersion(value: string): boolean {
  return /^(?:linux\s+)?\d+\.\d+\.\d+(?:[-._+][a-z0-9]+)+/i.test(value) || /\bx86_64\b|\baarch64\b/i.test(value);
}

/**
 * 从安装 ISO 文件名推导系统标识（如 "Rocky-9.6-x86_64-minimal.iso" → "Rocky Linux 9.6"）。
 * 仅命中已知发行版关键词才返回，避免把自定义 ISO 名当作系统名写进 VM 元数据；
 * 该结果只是占位，安装验收 SSH 探测到 /etc/os-release 真实系统后会覆盖。
 */
export function normalizeGuestOsLabelFromIsoName(isoName: string): string | undefined {
  const stem = String(isoName ?? "")
    .replace(/\.iso$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!stem) return undefined;
  const lowerStem = stem.toLowerCase();
  const knownKeywords = [
    "rocky", "centos", "rhel", "red hat", "alma", "fedora",
    "ubuntu", "debian", "kylin", "openeuler", "euleros",
    "windows", "suse", "opensuse", "sles", "oracle linux",
    "linux mint", "uos", "deepin",
  ];
  if (!knownKeywords.some((keyword) => lowerStem.includes(keyword))) return undefined;
  // 保留原名大小写（如 openEuler 的 LTS），关键词判定用 lowerStem 即可
  return normalizeGuestOsLabel(stem);
}
