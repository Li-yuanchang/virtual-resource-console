import type {
  HostDiagnosticCheck,
  HostDiagnosticRepairAction,
  HostDiagnosticStatus,
} from "./types.js";

/**
 * 宿主机只读诊断的公共能力：风险结论生成、修复动作模板与通用格式化。
 * 各平台 Provider（XenServer / Proxmox VE / VMware）只负责采集各自平台的只读证据，
 * 再调用本模块统一产出 conclusion / repairActions，保证跨平台结论口径一致。
 */

export interface HostDiagnosticFinding {
  key: string;
  label: string;
}

export interface HostDiagnosticConclusion {
  summary: string;
  faultPoint?: string;
  impact?: string;
  riskLevel: "none" | "low" | "medium" | "high";
}

/**
 * 根据检查项集合生成统一的结论。
 * 优先级：存在 error 检查 → high；存在 warn → medium；全部 unknown → none；否则 low。
 * 故障点取第一个 error / warn 检查项，仅用于提示，不替代具体证据。
 *
 * @param checks 平台采集到的检查项，可为空数组（视为未能采集足够数据）。
 * @return 与 HostDiagnosticsResult.conclusion 结构一致的结论对象。
 */
export function concludeHostDiagnostics(checks: HostDiagnosticCheck[]): HostDiagnosticConclusion {
  const errorChecks = checks.filter((check) => check.status === "error");
  const warnChecks = checks.filter((check) => check.status === "warn");
  const unknownOnly = checks.length > 0 && checks.every((check) => check.status === "unknown");
  const riskLevel = errorChecks.length > 0 ? "high" : warnChecks.length > 0 ? "medium" : unknownOnly ? "none" : "low";
  const faultPoint = errorChecks[0]?.label ?? warnChecks[0]?.label;
  return {
    summary:
      riskLevel === "high" ? "宿主机存在异常项，建议优先处理以下故障点" :
      riskLevel === "medium" ? "宿主机存在需要关注的项目" :
      riskLevel === "low" ? "宿主机各项检查正常" :
      "未能采集到足够的宿主机诊断数据",
    ...(faultPoint ? { faultPoint } : {}),
    ...(faultPoint ? { impact: `${faultPoint} 异常可能影响宿主机或该 VM 的网络 / 存储可用性` } : {}),
    riskLevel,
  };
}

/**
 * 为需要关注的检查项生成建议修复动作。
 * 修复动作只作为命令文本返回，调用方不得在本模块内执行任何变更操作。
 *
 * @param findings 需要关注（error / warn）的检查项列表。
 * @param suggestions key → 建议命令模板；模板中的 {placeholder} 会在按序提供参数时被替换。
 * @return 建议修复动作列表；无需要关注项时返回空数组。
 */
export function buildDiagnosticRepairActions(
  findings: HostDiagnosticFinding[],
  suggestions: Record<string, { label: string; description: string; scopeNote: string; commands: string[]; verificationCommands: string[] }>,
): HostDiagnosticRepairAction[] {
  const actions: HostDiagnosticRepairAction[] = [];
  for (const finding of findings) {
    const template = suggestions[finding.key];
    if (!template) continue;
    actions.push({
      key: `repair-${finding.key}`,
      label: template.label,
      description: template.description,
      recommended: true,
      scopeNote: template.scopeNote,
      commands: [...template.commands],
      verificationCommands: [...template.verificationCommands],
    });
  }
  return actions;
}

/**
 * 计算 used / total 的百分比，输入非法时返回 null。
 *
 * @param used 已用量（与 total 同单位）。
 * @param total 总量；<= 0 视为无效。
 * @return 0-100 的百分比，或 null 表示无法计算。
 */
export function percentOf(used: number | undefined, total: number | undefined): number | null {
  if (used == null || total == null || !Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return null;
  const percent = (used / total) * 100;
  return Math.min(Math.max(percent, 0), 100);
}

/**
 * 根据百分比给出统一的状态口径：>= 95 为 error，>= 85 为 warn，否则 ok。
 *
 * @param percent 0-100 的百分比，null 表示无法采集。
 * @return 对应的检查状态。
 */
export function statusForPercent(percent: number | null): HostDiagnosticStatus {
  if (percent == null) return "unknown";
  return percent >= 95 ? "error" : percent >= 85 ? "warn" : "ok";
}

/**
 * 将字节数格式化为人类可读字符串。
 *
 * @param bytes 字节数。
 * @return 如 "1.5 GB"；非正数返回 "0 B"。
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}
