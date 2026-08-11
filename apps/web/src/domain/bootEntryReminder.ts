/**
 * 启动内核提醒的本地缓存与文案。
 *
 * 虚拟机 GRUB 内核列表只能在虚拟机运行时（重启 / 选择内核流程）读取，而“开机”
 * 时虚拟机处于关机状态无法连接，因此把最近一次读到的内核数量缓存在本机
 * （localStorage，只存数量、不存任何凭据），供开机确认弹窗决定是否需要附加
 * “多个内核按默认启动”的提醒。缓存读成功即刷新，过期后不再提醒。
 */

const CACHE_KEY = "vrc.boot-entry.kernel-counts";
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface BootEntryKernelCountSnapshot {
  count: number;
  at: number;
}

/** 可注入的存储（测试用内存存储；运行时用 localStorage）。 */
export type BootEntryStorage = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): BootEntryStorage | null {
  return typeof localStorage !== "undefined" ? localStorage : null;
}

/**
 * 记录某虚拟机最近读到的内核数量，并写回本地缓存。
 *
 * @param vmId 虚拟机 providerId
 * @param count 内核数量（读取成功时的 entries.length）
 * @param storage 存储实现，缺省使用 localStorage
 */
export function rememberBootEntryKernelCount(
  vmId: string,
  count: number,
  storage: BootEntryStorage | null = defaultStorage(),
): void {
  if (!vmId || !Number.isInteger(count) || count <= 0 || !storage) return;
  const snapshot = loadKernelCounts(storage);
  snapshot[vmId] = { count, at: Date.now() };
  try {
    storage.setItem(CACHE_KEY, JSON.stringify(snapshot));
  } catch {
    // 本地写入失败只影响缓存，不影响功能
  }
}

/**
 * 读取某虚拟机近期缓存的内核数量；超过 TTL 或不存在时返回 null。
 *
 * @param vmId 虚拟机 providerId
 * @param now 当前时间戳（测试可注入）
 * @param storage 存储实现，缺省使用 localStorage
 * @returns 缓存快照（count + 记录时间）；无缓存或已过期返回 null
 */
export function cachedBootEntryKernelCount(
  vmId: string,
  now = Date.now(),
  storage: BootEntryStorage | null = defaultStorage(),
): BootEntryKernelCountSnapshot | null {
  if (!vmId || !storage) return null;
  const hit = loadKernelCounts(storage)[vmId];
  if (!hit || !Number.isInteger(hit.count)) return null;
  if (now - hit.at > CACHE_TTL_MS) return null;
  return hit;
}

/**
 * 组装开机确认文案：内核数量未知或只有一个时不附加提醒，多于一个时附加。
 *
 * @param base 开机影响范围文案
 * @param kernelCount 缓存到的内核数量，未知为 null
 * @returns 确认弹窗详情文案（可能含换行提醒）
 */
export function buildStartKernelReminder(base: string, kernelCount: number | null): string {
  if (!kernelCount || kernelCount <= 1) return base;
  return `${base}\n提示：该虚拟机有 ${kernelCount} 个启动内核，本次将按系统默认内核启动；如需指定下次启动内核，请开机后使用「重启」操作选择内核。`;
}

function loadKernelCounts(
  storage: BootEntryStorage | null,
): Record<string, BootEntryKernelCountSnapshot> {
  if (!storage) return {};
  try {
    const raw = storage.getItem(CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, BootEntryKernelCountSnapshot>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
