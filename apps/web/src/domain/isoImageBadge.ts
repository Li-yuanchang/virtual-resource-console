import type { IsoImage } from "../types";
import { isoSourceLabel } from "./provisioningStrategies";

/** 方案 B 镜像卡片左侧徽标的系统族。dvd / tools 表示非操作系统介质。 */
export type IsoFamily = "centos" | "ubuntu" | "windows" | "kylin" | "macos" | "dvd" | "tools" | "iso";

export interface IsoBadge {
  /** 徽标文案，控制在 2-4 个字符以保证 30px 方块内可读。 */
  text: string;
  family: IsoFamily;
}

const FAMILY_BADGES: Record<IsoFamily, string> = {
  centos: "RH",
  ubuntu: "UB",
  windows: "WIN",
  kylin: "KY",
  macos: "MAC",
  dvd: "DVD",
  tools: "TL",
  iso: "ISO",
};

const FAMILY_MATCHERS: Array<[IsoFamily, RegExp]> = [
  ["windows", /windows|win(?:dows)?[-_ ]?(?:server|10|11|7|8)|winsrv|ms[-_ ]?server/i],
  ["ubuntu", /ubuntu/i],
  ["kylin", /kylin|uos|银河麒麟|麒麟/i],
  ["macos", /macos|mac[-_ ]?os|osx|os[-_ ]?x/i],
  ["centos", /centos|rocky|alma|rhel|red[-_ ]?hat|redhat|oracle[-_ ]?linux|scientific[-_ ]?linux|open(?:euler|suse)|sles|suse|debian|fedora/i],
];

/**
 * 从 ISO 名称推导系统族徽标。
 * 先按介质类型判定（工具盘 / 本机 DVD 上的非系统镜像降级为 DVD），再按名称匹配系统族。
 */
export function resolveIsoBadge(image: IsoImage): IsoBadge {
  if (image.sourceType === "tools") return { text: FAMILY_BADGES.tools, family: "tools" };
  const name = image.name ?? "";
  for (const [family, matcher] of FAMILY_MATCHERS) {
    if (matcher.test(name)) return { text: FAMILY_BADGES[family], family };
  }
  if (image.sourceType === "host-dvd") return { text: FAMILY_BADGES.dvd, family: "dvd" };
  return { text: FAMILY_BADGES.iso, family: "iso" };
}

/** 选项第二行：来源圆点的语义类名。共享库用主色，本机 DVD 用告警色，其余中性。 */
export function isoSourceDotClass(image: IsoImage): "shared" | "dvd" | "local" {
  if (image.sourceType === "host-dvd") return "dvd";
  return image.shared ? "shared" : "local";
}

/** 选项第二行文本：来源标签，与存储库/设备名去重，避免出现 “共享 ISO 库 · 共享 ISO 库”。 */
export function isoOptionSourceText(image: IsoImage): string {
  const label = isoSourceLabel(image);
  const repository = (image.storageRepository ?? "").trim();
  if (!repository || repository === label) return label;
  return `${label} · ${repository}`;
}

export interface IsoSearchResult {
  images: IsoImage[];
  /** 命中的过滤词片段数量，用于列表底部 “N 条匹配” 展示。 */
  matchedCount: number;
}

/**
 * 按关键字过滤镜像清单，不改变原有顺序。
 * 匹配范围：ISO 名称、存储库、来源标签，全部忽略大小写。
 */
export function filterIsoImages(images: IsoImage[], query: string): IsoSearchResult {
  const keyword = query.trim().toLowerCase();
  if (!keyword) return { images, matchedCount: images.length };
  const terms = keyword.split(/\s+/).filter(Boolean);
  const matched = images.filter((image) => {
    const haystack = `${image.name} ${image.storageRepository ?? ""} ${isoSourceLabel(image)} ${image.path ?? ""}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
  return { images: matched, matchedCount: matched.length };
}

/** 高亮命中片段：返回被关键字命中的文本片段，交给模板渲染 mark。 */
export function splitHighlightSegments(text: string, query: string): Array<{ text: string; matched: boolean }> {
  const keyword = query.trim();
  if (!keyword) return [{ text, matched: false }];
  const terms = keyword
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!terms.length) return [{ text, matched: false }];
  const pattern = new RegExp(`(${terms.join("|")})`, "gi");
  const segments: Array<{ text: string; matched: boolean }> = [];
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) segments.push({ text: text.slice(cursor, index), matched: false });
    segments.push({ text: match[0], matched: true });
    cursor = index + match[0].length;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), matched: false });
  return segments.length ? segments : [{ text, matched: false }];
}
