import { Client } from "ssh2";
import type { ConnectConfig } from "ssh2";
import { listStoredConnections, resolveStoredConnection } from "./connectionStore.js";
import type { XenConnectionInput } from "./types.js";

/**
 * XenServer ISO 存储库健康检查与修复。
 *
 * 背景：SMB/CIFS 存储链路异常时，`ISOSR` 会在 `cifs_reconnect_tcon` 里死锁并进入
 * D（不可中断睡眠）状态。该状态收不到任何信号，同时它占住的 CIFS 会话又会阻塞
 * 后续所有新建连接，导致访问挂载点、`xe pbd-plug` 等操作全部卡住。
 *
 * 已实测有效的恢复顺序（顺序不能颠倒）：
 *   1) `umount -f -l`   先释放挂载点，解除内核等待
 *   2) `kill -9` D 状态进程  此时才能被真正终止，ISOSR 得以退出
 *   3) `pbd-unplug` + `pbd-plug`  重新建立 CIFS 会话
 */

export type IsoStorageNodeStatus = "healthy" | "stale" | "unmounted" | "unreachable" | "not-applicable";

export interface IsoStorageNodeReport {
  connectionId: string;
  host: string;
  hostName?: string;
  status: IsoStorageNodeStatus;
  /** CIFS 挂载点路径，未挂载时为 undefined。 */
  mountPath?: string;
  /** D（不可中断）状态进程数量，>0 说明存在内核级死锁。 */
  stuckProcessCount: number;
  /** D 状态进程的命令行摘要，便于人工判断影响范围。 */
  stuckProcesses: string[];
  /** SR 名称，用于展示与修复。 */
  srName?: string;
  /** 面向用户的诊断说明。 */
  message: string;
}

export interface IsoStorageScanReport {
  generatedAt: string;
  summary: {
    total: number;
    healthy: number;
    stale: number;
    unmounted: number;
    unreachable: number;
    notApplicable: number;
  };
  nodes: IsoStorageNodeReport[];
}

export interface IsoStorageRepairResult {
  connectionId: string;
  host: string;
  hostName?: string;
  repaired: boolean;
  message: string;
}

const sshReadyTimeoutMs = 12_000;
const commandTimeoutMs = 30_000;
/** D 状态进程只做展示，修复时统一清理，避免逐条匹配带来的歧义。 */
const maxReportedStuckProcesses = 5;

const XEN_SSH_ALGORITHMS: ConnectConfig["algorithms"] = {
  kex: ["diffie-hellman-group14-sha1", "diffie-hellman-group1-sha1", "diffie-hellman-group-exchange-sha1"],
  serverHostKey: ["ssh-rsa", "ssh-dss"],
};

function runXenCommand(connection: XenConnectionInput, command: string, timeoutMs = commandTimeoutMs): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => finish(new Error(`XenServer 命令执行超时（${Math.ceil(timeoutMs / 1000)} 秒）`)), timeoutMs);
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
              if (code !== 0) {
                finish(new Error(stderr.trim() || `XenServer 命令退出码 ${code}`));
                return;
              }
              finish();
            })
            .on("data", (data: Buffer) => {
              stdout += data.toString("utf8");
            })
            .stderr.on("data", (data: Buffer) => {
              stderr += data.toString("utf8");
            });
        });
      })
      .on("error", (error) => finish(error))
      .connect({
        host: connection.host,
        port: connection.port,
        username: connection.username,
        password: connection.password,
        readyTimeout: sshReadyTimeoutMs,
        keepaliveInterval: 5_000,
        keepaliveCountMax: 3,
        algorithms: XEN_SSH_ALGORITHMS,
      });
  });
}

/**
 * 只读扫描脚本：不执行任何挂载/卸载，仅采集挂载表、进程状态与 D 状态进程。
 * 探测挂载点可达性时必须限时（timeout），否则 CIFS 僵死会让探测本身卡住。
 */
export function buildIsoStorageProbeScript(): string {
  return String.raw`
set -u
# 1) 所有 CIFS 挂载点（可能有多个 SR）
printf 'CIFS_BEGIN\n'
grep -i ' cifs ' /proc/mounts 2>/dev/null | awk '{print $1"\t"$2}'
printf 'CIFS_END\n'
# 2) D（不可中断）状态进程
printf 'DSTUCK_BEGIN\n'
for pid in $(ps -eo pid,stat 2>/dev/null | awk '$2 ~ /^D/ {print $1}'); do
  cmdline="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | cut -c1-120)"
  [ -n "$cmdline" ] && printf '%s\t%s\n' "$pid" "$cmdline"
done | head -${maxReportedStuckProcesses}
printf 'DSTUCK_END\n'
# 3) SMB 类型 SR 名称（用于修复时的 SR 定位）
printf 'SR_BEGIN\n'
if command -v xe >/dev/null 2>&1; then
  for u in $(xe sr-list content-type=iso params=uuid --minimal 2>/dev/null | tr ',' ' '); do
    n="$(xe sr-param-get uuid=$u param-name=name-label 2>/dev/null)"
    case "$n" in *SMB*) printf '%s\t%s\n' "$u" "$n" ;; esac
  done
fi
printf 'SR_END\n'
`;
}

/** 探测每个 CIFS 挂载点是否可访问（限时，避免探测本身卡住）。 */
export function buildMountReachabilityProbeScript(mountPaths: string[]): string {
  const safe = mountPaths
    .map((path) => path.replace(/[^A-Za-z0-9._/-]/g, ""))
    .filter((path) => path.startsWith("/"))
    .map((path) => `'${path.replace(/'/g, `'\\''`)}'`)
    .join(" ");
  return String.raw`
set -u
for mp in ${safe}; do
  if command -v timeout >/dev/null 2>&1; then
    if timeout 5 ls "$mp" >/dev/null 2>&1; then printf 'REACH\t%s\tok\n' "$mp"; else printf 'REACH\t%s\tbad\n' "$mp"; fi
  else
    if ls "$mp" >/dev/null 2>&1; then printf 'REACH\t%s\tok\n' "$mp"; else printf 'REACH\t%s\tbad\n' "$mp"; fi
  fi
done
`;
}

export function parseSections(output: string): Record<string, string[]> {
  // FINAL 段由修复脚本输出（重挂后的 CIFS 挂载点列表），必须在此初始化，
  // 否则 repairIsoStorage 读取 .FINAL.length 会抛 TypeError 使修复接口 502。
  const sections: Record<string, string[]> = { CIFS: [], DSTUCK: [], SR: [], REACH: [], FINAL: [] };
  const names: Record<string, string> = {
    CIFS_BEGIN: "CIFS", CIFS_END: "CIFS",
    DSTUCK_BEGIN: "DSTUCK", DSTUCK_END: "DSTUCK",
    SR_BEGIN: "SR", SR_END: "SR",
    FINAL_BEGIN: "FINAL", FINAL_END: "FINAL",
  };
  let current = "";
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (line in names) {
      current = line.endsWith("_END") ? "" : names[line];
      continue;
    }
    if (line.startsWith("REACH\t")) {
      sections.REACH.push(line);
      continue;
    }
    if (line && current) sections[current].push(line);
  }
  return sections;
}

async function probeNode(summary: { id: string; host: string; name?: string }): Promise<IsoStorageNodeReport> {
  const resolved = resolveStoredConnection(summary.id);
  const base: IsoStorageNodeReport = {
    connectionId: summary.id,
    host: summary.host,
    hostName: summary.name,
    status: "unreachable",
    stuckProcessCount: 0,
    stuckProcesses: [],
    message: "",
  };
  if (!resolved) {
    return { ...base, status: "unreachable", message: "连接配置已删除，无法采集" };
  }
  const connection: XenConnectionInput = {
    host: resolved.host,
    port: resolved.port,
    username: resolved.username,
    password: resolved.password,
  };
  let output: string;
  try {
    output = await runXenCommand(connection, buildIsoStorageProbeScript());
  } catch (error) {
    return {
      ...base,
      status: "unreachable",
      message: `无法连接或采集失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const sections = parseSections(output);
  const stuck = sections.DSTUCK
    .map((line) => line.split("\t"))
    .filter((parts) => parts.length >= 2)
    .map((parts) => parts.slice(1).join("\t"));
  const cifsMounts = sections.CIFS
    .map((line) => line.split("\t"))
    .filter((parts) => parts.length >= 2)
    .map((parts) => ({ source: parts[0], mountPath: parts[1] }));
  const smbSr = sections.SR[0]?.split("\t") ?? [];
  const withStuck = { ...base, stuckProcessCount: stuck.length, stuckProcesses: stuck, srName: smbSr[1] || undefined };
  // 该宿主机根本没有 SMB ISO 库时（只有 DVD/Tools），不存在"未挂载"可修的问题，
  // 必须单独归类，否则会被误算进待修复节点，让修复按钮把无关机器也列进去。
  if (!smbSr.length && !cifsMounts.length) {
    return {
      ...withStuck,
      status: "not-applicable",
      message: stuck.length
        ? `未配置 SMB ISO 库，但存在 ${stuck.length} 个 D 状态进程`
        : "未配置 SMB ISO 库，无需检查",
    };
  }
  if (!cifsMounts.length) {
    return {
      ...withStuck,
      status: "unmounted",
      message: stuck.length
        ? `已配置 SMB ISO 库但未挂载，且存在 ${stuck.length} 个 D 状态进程，需要清理后才能重新挂载`
        : "已配置 SMB ISO 库但 CIFS 未挂载，SR 处于断开状态",
    };
  }
  // 逐个挂载点做限时可达性探测
  let reach: Record<string, string> = {};
  try {
    const reachOutput = await runXenCommand(connection, buildMountReachabilityProbeScript(cifsMounts.map((item) => item.mountPath)));
    reach = Object.fromEntries(
      reachOutput
        .split(/\r?\n/)
        .map((line) => line.split("\t"))
        .filter((parts) => parts[0] === "REACH" && parts.length >= 3)
        .map((parts) => [parts[1], parts[2]]),
    );
  } catch {
    // 探测失败本身视为不可达，交由统一判定
  }
  const target = cifsMounts.find((item) => item.source.includes("192.168.2.8")) ?? cifsMounts[0];
  const reachable = reach[target.mountPath] === "ok";
  if (reachable && !stuck.length) {
    return { ...withStuck, status: "healthy", mountPath: target.mountPath, message: "挂载正常，可读写目录" };
  }
  if (reachable && stuck.length) {
    return {
      ...withStuck,
      status: "stale",
      mountPath: target.mountPath,
      message: `目录可访问，但存在 ${stuck.length} 个 D 状态进程，存在死锁风险`,
    };
  }
  return {
    ...withStuck,
    status: "stale",
    mountPath: target.mountPath,
    message: stuck.length
      ? `CIFS 挂载僵死（${stuck.length} 个 D 状态进程），访问会阻塞`
      : "CIFS 挂载不可访问，需要重新挂载",
  };
}

/** 扫描所有 XenServer 连接的 ISO 存储库状态。 */
export async function scanIsoStorage(): Promise<IsoStorageScanReport> {
  const connections = listStoredConnections().filter((item) => item.providerType === "xenserver");
  const nodes: IsoStorageNodeReport[] = [];
  for (const connection of connections) {
    nodes.push(await probeNode(connection));
  }
  return {
    generatedAt: new Date().toISOString(),
    summary: {
      total: nodes.length,
      healthy: nodes.filter((item) => item.status === "healthy").length,
      stale: nodes.filter((item) => item.status === "stale").length,
      // unmounted 同样不可用（SR 未挂载就无法取 ISO），必须计入异常数，
      // 否则会出现"异常 0 个却显示修复 3 个"的矛盾。
      unmounted: nodes.filter((item) => item.status === "unmounted").length,
      unreachable: nodes.filter((item) => item.status === "unreachable").length,
      notApplicable: nodes.filter((item) => item.status === "not-applicable").length,
    },
    nodes,
  };
}

/**
 * 修复脚本：严格按「先卸载、再杀进程、最后重挂」的顺序执行。
 * 顺序颠倒会失败——先 kill 时 D 状态进程收不到信号，必须先 umount 解除内核等待。
 */
export function buildIsoStorageRepairScript(): string {
  return String.raw`
set -u
printf 'STEP unload\n'
for mp in $(grep -i ' cifs ' /proc/mounts 2>/dev/null | awk '{print $2}'); do
  umount -f -l "$mp" >/dev/null 2>&1 || true
done
sleep 1
printf 'STEP kill\n'
killed=0
for pid in $(ps -eo pid,stat 2>/dev/null | awk '$2 ~ /^D/ {print $1}'); do
  if kill -9 "$pid" >/dev/null 2>&1; then killed=$((killed + 1)); fi
done
sleep 2
remaining="$(ps -eo stat 2>/dev/null | grep -c '^D')"
printf 'KILLED\t%s\n' "$killed"
printf 'REMAINING\t%s\n' "$remaining"
printf 'STEP replug\n'
# 定位 SMB 类型的 ISO SR 对应 PBD 并重挂；unplug 失败（VDI 占用）不阻断 plug 尝试。
for u in $(xe sr-list content-type=iso params=uuid --minimal 2>/dev/null | tr ',' ' '); do
  n="$(xe sr-param-get uuid=$u param-name=name-label 2>/dev/null)"
  case "$n" in
    *SMB*)
      for p in $(xe pbd-list sr-uuid=$u params=uuid --minimal 2>/dev/null | tr ',' ' '); do
        xe pbd-unplug uuid=$p >/dev/null 2>&1 || true
        xe pbd-plug uuid=$p >/dev/null 2>&1 || true
        printf 'PLUGGED\t%s\t%s\n' "$n" "$p"
      done
      ;;
  esac
done
sleep 1
printf 'FINAL_BEGIN\n'
grep -i ' cifs ' /proc/mounts 2>/dev/null | awk '{print $2}'
printf 'FINAL_END\n'
`;
}

/** 对指定连接执行修复。仅处理 XenServer。 */
export async function repairIsoStorage(connectionIds: string[]): Promise<IsoStorageRepairResult[]> {
  const connections = listStoredConnections().filter((item) => item.providerType === "xenserver");
  const wanted = new Set(connectionIds);
  const results: IsoStorageRepairResult[] = [];
  for (const connection of connections) {
    if (wanted.size && !wanted.has(connection.id)) continue;
    const base = { connectionId: connection.id, host: connection.host, hostName: connection.name };
    const resolved = resolveStoredConnection(connection.id);
    if (!resolved) {
      results.push({ ...base, repaired: false, message: "连接配置已删除，无法修复" });
      continue;
    }
    const conn: XenConnectionInput = {
      host: resolved.host,
      port: resolved.port,
      username: resolved.username,
      password: resolved.password,
    };
    let output: string;
    try {
      output = await runXenCommand(conn, buildIsoStorageRepairScript(), 90_000);
    } catch (error) {
      results.push({
        ...base,
        repaired: false,
        message: `修复执行失败：${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    const remaining = Number(output.split(/\r?\n/).find((line) => line.startsWith("REMAINING\t"))?.split("\t")[1] ?? "-1");
    const finalMounts = parseSections(output).FINAL.length;
    const repaired = remaining === 0 && finalMounts > 0;
    results.push({
      ...base,
      repaired,
      message: repaired
        ? "已恢复：挂载点重新建立，无 D 状态进程"
        : `修复未完成：剩余 D 状态进程 ${remaining >= 0 ? remaining : "未知"}，挂载点 ${finalMounts} 个。可能被 VM 占用 VDI，需弹出光驱后重试`,
    });
  }
  return results;
}
