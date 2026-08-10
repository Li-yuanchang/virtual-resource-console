import { runGuestShellCommand, type GuestStorageAccess } from "./guestStorage.js";
import type { VirtualizationProvider } from "./providers/provider.js";
import { vmSystemCredentialStore } from "./vmSystemCredentialStore.js";
import type {
  GuestBootEntry,
  GuestBootEntryList,
  GuestBootEntrySelection,
  VmNode,
  VmSystemCredentials,
  XenConnectionInput,
} from "./types.js";

/**
 * 读取虚拟机操作系统 GRUB 启动项（内核列表）的 Shell 脚本。
 *
 * 支持 GRUB2（/boot/grub2/grub.cfg 或 /boot/grub/grub.cfg，RHEL/CentOS 7+、
 * Debian/Ubuntu）与 GRUB1（/boot/grub/menu.lst 或 /boot/grub/grub.conf，
 * RHEL/CentOS 6）。GRUB2 通过 awk 维护 submenu 栈，子菜单项使用
 * "子菜单>条目" 的完整路径标题，保证 grub2-reboot 能按标题命中。
 *
 * 输出以制表符分隔的标记行：
 * - GRUBKIND<tab>grub1|grub2|unknown
 * - CONFIG<tab>检测到的配置文件绝对路径
 * - TOOL<tab>可用的一次性启动工具：grub2-reboot|grub-reboot|none
 * - DEFAULT<tab>grub.cfg / menu.lst 中的 default 值（数字、saved 或引号标题）
 * - SAVED<tab>grubenv 中 saved_entry / next_entry 的拼接值（GRUB2 存在 grub-env 工具时）
 * - ENTRY<tab>序号<tab>标题
 */
export const LIST_BOOT_ENTRIES_COMMAND = String.raw`
export LC_ALL=C
grub_cfg=""
grub_kind="unknown"
if [ -f /boot/grub2/grub.cfg ]; then
  grub_cfg="/boot/grub2/grub.cfg"
  grub_kind="grub2"
elif [ -f /boot/grub/grub.cfg ]; then
  grub_cfg="/boot/grub/grub.cfg"
  grub_kind="grub2"
elif [ -f /boot/grub/menu.lst ]; then
  grub_cfg="/boot/grub/menu.lst"
  grub_kind="grub1"
elif [ -f /boot/grub/grub.conf ]; then
  grub_cfg="/boot/grub/grub.conf"
  grub_kind="grub1"
fi
printf 'GRUBKIND\t%s\n' "$grub_kind"
printf 'CONFIG\t%s\n' "$grub_cfg"
tool="none"
if [ "$grub_kind" = "grub2" ]; then
  if command -v grub2-reboot >/dev/null 2>&1; then
    tool="grub2-reboot"
  elif command -v grub-reboot >/dev/null 2>&1; then
    tool="grub-reboot"
  fi
elif [ "$grub_kind" = "grub1" ]; then
  if command -v grub-reboot >/dev/null 2>&1; then
    tool="grub-reboot"
  fi
fi
printf 'TOOL\t%s\n' "$tool"
if [ -n "$grub_cfg" ]; then
  default_line="$(sed -n 's/^[[:space:]]*set[[:space:]]\+default=\(.*\)$/\1/p' "$grub_cfg" 2>/dev/null | tail -n 1)"
  if [ -z "$default_line" ]; then
    default_line="$(sed -n 's/^[[:space:]]*default=\(.*\)$/\1/p' "$grub_cfg" 2>/dev/null | tail -n 1)"
  fi
  printf 'DEFAULT\t%s\n' "$default_line"
  if [ "$grub_kind" = "grub2" ]; then
    if command -v grub2-editenv >/dev/null 2>&1; then
      printf 'SAVED\t%s\n' "$(grub2-editenv list 2>/dev/null | grep -E '^(saved_entry|next_entry)=' | tr '\n' ';')"
    elif command -v grub-editenv >/dev/null 2>&1; then
      printf 'SAVED\t%s\n' "$(grub-editenv list 2>/dev/null | grep -E '^(saved_entry|next_entry)=' | tr '\n' ';')"
    fi
  fi
fi
if [ "$grub_kind" = "grub2" ] && [ -n "$grub_cfg" ]; then
  awk -f /dev/stdin "$grub_cfg" <<'VRC_GRUB_AWK'
function push_block(kind) { stack[++sp] = kind }
function pop_block() { if (sp > 0) sp-- }
BEGIN { sp = 0; idx = 0 }
{
  line = $0
  sub(/^[ \t]+/, "", line)
  if (line ~ /^submenu[ \t]+/) {
    if (match(line, /'[^']*'|"[^"]*"/)) {
      push_block("submenu")
      subs[sp] = substr(line, RSTART + 1, RLENGTH - 2)
    }
    next
  }
  if (line ~ /^menuentry[ \t]+/) {
    if (match(line, /'[^']*'|"[^"]*"/)) {
      entry_title = substr(line, RSTART + 1, RLENGTH - 2)
      full = ""
      for (i = 1; i <= sp; i++) {
        if (stack[i] == "submenu") {
          if (full != "") full = full ">"
          full = full subs[i]
        }
      }
      if (full != "") entry_title = full ">" entry_title
      printf "ENTRY\t%d\t%s\n", idx, entry_title
      idx++
    }
    push_block("entry")
    next
  }
  if (line == "}") {
    pop_block()
    next
  }
}
VRC_GRUB_AWK
elif [ "$grub_kind" = "grub1" ] && [ -n "$grub_cfg" ]; then
  awk -f /dev/stdin "$grub_cfg" <<'VRC_GRUB_AWK'
BEGIN { idx = 0 }
{
  line = $0
  sub(/^[ \t]+/, "", line)
  if (line ~ /^title[ \t]+/) {
    sub(/^title[ \t]+/, "", line)
    printf "ENTRY\t%d\t%s\n", idx, line
    idx++
  }
}
VRC_GRUB_AWK
fi
true
`;

/**
 * 生成在虚拟机内设置"下一次启动使用指定 GRUB 启动项"的 Shell 脚本。
 *
 * GRUB2 使用 grub2-reboot（缺失时回退 grub-reboot）按完整标题设置一次性
 * saved_entry；GRUB1 使用 grub-reboot 按序号设置。设置成功后回读
 * grubenv / /boot/grub/default 校验并输出 SET 行，供调用方核对。
 *
 * @param selection 选择的启动项：index 为菜单序号，title 为菜单标题
 *                  （GRUB2 子菜单项为 "子菜单>条目" 完整路径），grubKind 为 GRUB 版本
 * @returns 需要在虚拟机内执行的 Shell 脚本
 */
export function buildSetBootEntryCommand(selection: GuestBootEntrySelection): string {
  const safeTitle = shellSingleQuote(selection.title);
  const script = String.raw`
export LC_ALL=C
if [ "$(id -u)" != "0" ]; then
  echo "设置一次性启动项需要 root 权限" >&2
  exit 6
fi
`;
  if (selection.grubKind === "grub2") {
    return script + String.raw`
if command -v grub2-reboot >/dev/null 2>&1; then
  grub2-reboot ${safeTitle}
else
  grub-reboot ${safeTitle}
fi
rc=$?
if [ $rc -ne 0 ]; then
  echo "设置一次性启动项失败：grub-reboot 退出码 $rc，请检查 grubenv 是否可写" >&2
  exit $rc
fi
env_out=""
if command -v grub2-editenv >/dev/null 2>&1; then
  env_out="$(grub2-editenv list 2>/dev/null | grep -E '^(saved_entry|next_entry)=' | tr '\n' ';')"
elif command -v grub-editenv >/dev/null 2>&1; then
  env_out="$(grub-editenv list 2>/dev/null | grep -E '^(saved_entry|next_entry)=' | tr '\n' ';')"
fi
printf 'SET\t%s\n' "$env_out"
`;
  }
  return script + String.raw`
grub-reboot ${selection.index}
rc=$?
if [ $rc -ne 0 ]; then
  echo "设置一次性启动项失败：grub-reboot 退出码 $rc，请确认 grub.conf 支持 savedefault" >&2
  exit $rc
fi
if [ -f /boot/grub/default ]; then
  printf 'SET\t%s\n' "$(cat /boot/grub/default 2>/dev/null)"
else
  printf 'SET\t\n'
fi
`;
}

/**
 * 解析读取启动项脚本的输出。
 *
 * @param output LIST_BOOT_ENTRIES_COMMAND 的标准输出
 * @returns 结构化的启动项列表，含 GRUB 版本、默认项、可用的一次性工具
 */
export function parseGuestBootEntries(output: string): GuestBootEntryList {
  let grubKind: GuestBootEntryList["grubKind"] = "unknown";
  let config = "";
  let oneTimeTool: GuestBootEntryList["oneTimeTool"] = "unknown";
  let defaultLine = "";
  let savedEntry = "";
  const rawEntries: Array<{ index: number; title: string }> = [];
  for (const line of output.split("\n")) {
    const [key, ...rest] = line.split("\t");
    const value = rest.join("\t");
    if (key === "GRUBKIND" && (value === "grub1" || value === "grub2" || value === "unknown")) grubKind = value;
    else if (key === "CONFIG") config = value;
    else if (key === "TOOL" && (value === "grub2-reboot" || value === "grub-reboot" || value === "none" || value === "unknown")) oneTimeTool = value;
    else if (key === "DEFAULT") defaultLine = value;
    else if (key === "SAVED") savedEntry = value;
    else if (key === "ENTRY") {
      const index = Number(rest[0]);
      const title = rest.slice(1).join("\t");
      if (Number.isInteger(index) && index >= 0 && title) rawEntries.push({ index, title });
    }
  }
  const defaultIndex = resolveDefaultIndex(grubKind, defaultLine, savedEntry, rawEntries);
  const entries: GuestBootEntry[] = rawEntries.map((entry) => ({
    ...entry,
    isDefault: entry.index === defaultIndex,
  }));
  return {
    grubKind,
    config,
    oneTimeTool,
    defaultIndex,
    savedEntry: savedEntry || undefined,
    entries,
    message: buildBootEntryMessage(grubKind, config, oneTimeTool, entries),
  };
}

/**
 * 计算当前默认启动项在列表中的序号。
 *
 * @param grubKind GRUB 版本
 * @param defaultLine grub.cfg / menu.lst 中的 default 值（数字、saved 或引号标题）
 * @param savedEntry grubenv 中 saved_entry / next_entry 的拼接值（GRUB2）
 * @param entries 已解析的启动项列表
 * @returns 默认启动项序号；无法确定时返回 null
 */
function resolveDefaultIndex(
  grubKind: GuestBootEntryList["grubKind"],
  defaultLine: string,
  savedEntry: string,
  entries: Array<{ index: number; title: string }>,
): number | null {
  if (grubKind === "grub1") {
    const numeric = Number(defaultLine.trim());
    return Number.isInteger(numeric) && numeric >= 0 ? numeric : null;
  }
  if (grubKind !== "grub2") return null;
  const trimmed = defaultLine.trim().replace(/^"|"$/g, "");
  const numeric = Number(trimmed);
  if (Number.isInteger(numeric) && numeric >= 0 && entries.some((entry) => entry.index === numeric)) {
    return numeric;
  }
  if (trimmed === "saved") {
    // saved_entry 可能是序号、标题或 grub-reboot 写入的 ">标题"（一次性标记）。
    const savedMatch = /(?:saved_entry|next_entry)=([^;]*)/.exec(savedEntry);
    if (!savedMatch) return null;
    const savedValue = savedMatch[1].replace(/^>/, "").trim();
    const savedNumeric = Number(savedValue);
    if (Number.isInteger(savedNumeric) && savedNumeric >= 0 && entries.some((entry) => entry.index === savedNumeric)) {
      return savedNumeric;
    }
    const match = entries.find((entry) => entry.title === savedValue);
    return match ? match.index : null;
  }
  if (trimmed) {
    const match = entries.find((entry) => entry.title === trimmed);
    return match ? match.index : null;
  }
  return null;
}

/**
 * 组装启动项列表的补充说明。
 *
 * @param grubKind GRUB 版本
 * @param config 检测到的配置文件路径
 * @param oneTimeTool 可用的一次性启动工具
 * @param entries 启动项列表
 * @returns 供前端展示的说明文案；无异常时返回空字符串
 */
function buildBootEntryMessage(
  grubKind: GuestBootEntryList["grubKind"],
  config: string,
  oneTimeTool: GuestBootEntryList["oneTimeTool"],
  entries: GuestBootEntry[],
): string {
  if (grubKind === "unknown" || !config) {
    return "未识别到 GRUB 配置文件，无法读取启动项；不指定启动项将按系统默认启动。";
  }
  if (!entries.length) {
    return "已识别到 GRUB 配置，但没有解析到可启动的内核条目；不指定启动项将按系统默认启动。";
  }
  if (oneTimeTool === "none") {
    return "系统缺少 grub2-reboot / grub-reboot 工具，无法设置一次性启动项；不指定启动项将按系统默认启动。";
  }
  return "";
}

/**
 * 读取虚拟机操作系统当前的 GRUB 启动项（内核列表）。
 *
 * @param access 访客访问上下文，复用系统磁盘检测的 SSH / guest agent 通道
 * @returns 结构化启动项列表
 */
export async function listGuestBootEntries(access: GuestStorageAccess): Promise<GuestBootEntryList> {
  const output = await runGuestShellCommand(access, LIST_BOOT_ENTRIES_COMMAND, 30_000);
  return parseGuestBootEntries(output);
}

/**
 * 在虚拟机内设置"下一次启动使用指定启动项"并执行回读校验。
 *
 * 只设置一次性启动项，不执行重启；调用方在设置成功后再提交
 * 关机 / 强制重启动作，保证虚拟机下一次启动进入所选内核。
 *
 * @param access 访客访问上下文
 * @param selection 选择的启动项（序号 + 标题 + GRUB 版本）
 * @returns 校验回读信息（grubenv / /boot/grub/default 内容），失败时抛出错误
 */
export async function setGuestBootEntry(access: GuestStorageAccess, selection: GuestBootEntrySelection): Promise<string> {
  const output = await runGuestShellCommand(access, buildSetBootEntryCommand(selection), 30_000);
  const setLine = output
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("SET\t"));
  const readback = setLine ? setLine.slice(4) : "";
  if (!setLine) {
    throw new Error("设置一次性启动项后未返回校验结果，已中止重启以避免进入错误内核。");
  }
  const normalizedTitle = selection.title.replace(/^>/, "");
  const verified = readback.includes(normalizedTitle) || (selection.grubKind === "grub1" && readback.includes(String(selection.index)));
  if (!verified) {
    throw new Error(`一次性启动项校验未通过（回读：${readback || "无"}），已中止重启；请先手动在虚拟机内确认 grubenv 可写后重试。`);
  }
  return readback;
}

/**
 * 组装读取虚拟机启动项所需的访客访问上下文。
 *
 * 复用系统凭据存储与 root 密码派生规则；未提供凭据时尝试使用已保存凭据，
 * 都没有时使用运行策略按 IP 派生的 root 密码。
 *
 * @param input 解析后的连接参数、虚拟机线索与临时系统凭据
 * @returns 可直接用于读取 / 设置启动项的访客访问上下文
 */
export async function resolveGuestBootAccess(input: {
  provider: VirtualizationProvider<XenConnectionInput>;
  connection: XenConnectionInput;
  vmId: string;
  connectionId?: string;
  vmHint?: VmNode;
  systemCredentials?: VmSystemCredentials;
}): Promise<GuestStorageAccess> {
  const vm = input.vmHint ?? (await findVm(input.provider, input.connection, input.vmId));
  const vmIp = vm.ipAddresses.find(isIpv4);
  if (!vmIp) {
    throw new Error("未读取到虚拟机 IPv4，无法连接虚拟机操作系统读取启动项。");
  }
  const systemCredentials = input.systemCredentials ?? (input.connectionId
    ? vmSystemCredentialStore.get(input.connectionId, input.vmId)
    : undefined);
  return {
    providerType: input.provider.type,
    platformConnection: input.connection,
    vmIp,
    username: systemCredentials?.username,
    password: systemCredentials?.password,
    jumpConnection: systemCredentials?.jump
      ? {
          host: systemCredentials.jump.host,
          port: systemCredentials.jump.port,
          username: systemCredentials.jump.username,
          password: systemCredentials.jump.password,
        }
      : undefined,
    executeCommand: input.provider.executeGuestCommand
      ? (command, timeoutMs) => input.provider.executeGuestCommand!(input.connection, input.vmId, command, timeoutMs)
      : undefined,
    allowSshFallback: Boolean(systemCredentials),
  };
}

/**
 * 按 providerId / id 查找虚拟机。
 *
 * @param provider 平台 Provider
 * @param connection 平台连接参数
 * @param vmId 虚拟机 UUID 或 providerId
 * @returns 匹配的虚拟机；未找到时抛出错误
 */
async function findVm(
  provider: VirtualizationProvider<XenConnectionInput>,
  connection: XenConnectionInput,
  vmId: string,
): Promise<VmNode> {
  const pageSize = 500;
  let page = 1;
  while (true) {
    const result = await provider.listVms(connection, { page, pageSize });
    const vm = result.items.find((item) => item.providerId === vmId || item.id === vmId);
    if (vm) return vm;
    if (page * result.pageSize >= result.total || !result.items.length) break;
    page += 1;
  }
  throw new Error(`未找到虚拟机：${vmId}`);
}

function isIpv4(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

/**
 * 使用单引号包裹 Shell 字符串并转义内部单引号。
 *
 * @param value 原始字符串
 * @returns 可直接嵌入 Shell 命令的单引号字面量
 */
function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
