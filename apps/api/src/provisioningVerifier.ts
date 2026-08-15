import { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { Client } from "ssh2";
import type { Algorithms } from "ssh2";
import { runCommand as runWinRmCommand } from "winrm-client";
import type { ProviderType, ProvisionTaskStepKey, VmProvisionCreatedVm, VmProvisionPlanItem, VmProvisionRequest, XenConnectionInput } from "./types.js";
import { startProxmoxVmFromDiskIfStopped } from "./proxmox.js";
import { isRocky9Image } from "./centosKickstart.js";
import { enableAndVerifyProxmoxGuestAgent } from "./proxmox.js";
import { verifyVmwareGuestTools } from "./vmware.js";
import { prepareXenVmForInstalledBoot } from "./installSourceService.js";
import { normalizeGuestOsLabel } from "./guestOs.js";
import { resolveGuestMonitoringPolicy } from "./guestMonitoringPolicy.js";
import { resolveProvisioningReadinessStrategy } from "./provisioningReadinessStrategy.js";
import type { ProvisioningReadinessResult } from "./provisioningReadinessStrategy.js";
import {
  finishProvisionTask,
  getProvisionTask,
  markProvisionTaskStep,
  markProvisionTaskStepIfUnfinished,
  updateProvisionTaskVm,
  updateProvisionTaskVms,
} from "./provisionTaskStore.js";

interface RunProvisioningVerifierInput {
  taskId: string;
  connection: XenConnectionInput;
  request: VmProvisionRequest;
  created: VmProvisionCreatedVm[];
  onTiming?: (phase: string, elapsedMs: number, details?: Record<string, unknown>) => void;
  onComplete?: (outcome: { status: "success" | "warning" | "failed" }) => void | Promise<void>;
}

interface GuestVerifyResult {
  item: VmProvisionPlanItem;
  vm?: VmProvisionCreatedVm;
  ok: boolean;
  message: string;
  /** SSH 登录时从 /etc/os-release 探测到的系统标识（如 Rocky Linux 9.6），用于写回 other-config:vrc-guest-os */
  guestOs?: string;
  reasonCode?: string;
  readiness?: Pick<ProvisioningReadinessResult, "state" | "networkVisible" | "ready">;
}

interface GuestTransport {
  sock?: Duplex;
  close: () => void;
}

const networkWaitMs = 45 * 60 * 1000;
const pveArmInstallWaitMs = 3 * 60 * 60 * 1000;
const networkProbeIntervalMs = 15 * 1000;
const sshVerifyTimeoutMs = 15 * 1000;
const sshLoginRetryIntervalMs = 20 * 1000;
const guestToolsMetricsSoftWaitMs = 6 * 60 * 1000;
const guestToolsMetricsProbeIntervalMs = 10 * 1000;
const windowsInstallWaitMs = 2 * 60 * 60 * 1000;
const windowsRemoteInitializationWaitMs = 15 * 60 * 1000;
const windowsWinRmPort = 5985;
const windowsWinRmReadyConfirmations = 3;

export function resolveProvisionHardWaitMs(value = process.env.VRC_PROVISION_HARD_WAIT_HOURS): number | undefined {
  if (!value?.trim()) return undefined;
  const hours = Number(value);
  return Number.isFinite(hours) && hours > 0 ? hours * 60 * 60 * 1000 : undefined;
}

function hardWaitDeadline(startedAt: number): number {
  const hardWaitMs = resolveProvisionHardWaitMs();
  return hardWaitMs ? startedAt + hardWaitMs : Number.POSITIVE_INFINITY;
}

export function runProvisioningVerifier(input: RunProvisioningVerifierInput): void {
  void verifyProvisioning(input)
    .catch((error) => {
      if (isProvisionTaskTerminal(input.taskId)) return;
      finishProvisionTask(input.taskId, "failed", error instanceof Error ? error.message : "创建验收失败");
    })
    .finally(() => {
      const taskStatus = getProvisionTask(input.taskId)?.status;
      const status = taskStatus === "success" || taskStatus === "warning" ? taskStatus : "failed";
      void input.onComplete?.({ status });
    });
}

async function verifyProvisioning(input: RunProvisioningVerifierInput): Promise<void> {
  markProvisionTaskStepIfUnfinished(input.taskId, "boot", "running", "VM 已创建，等待系统启动");
  updateProvisionTaskVms(
    input.taskId,
    input.request.planItems.map((item) => {
      const vm = input.created.find((created) => created.name === item.name);
      return {
        id: vm?.id,
        providerId: vm?.providerId,
        name: item.name,
        ip: item.ip,
        powerState: vm?.powerState,
        status: input.request.autoStart ? "running" : "success",
        currentStep: input.request.autoStart ? "boot" : "create-vm",
        progressPercent: input.request.autoStart ? undefined : 100,
        message: input.request.autoStart ? "等待系统启动" : "已创建，未设置自动启动",
      };
    }),
  );

  if (!input.request.autoStart) {
    markProvisionTaskStep(input.taskId, "boot", "skipped", "创建请求未启用自动启动");
    markProvisionTaskStepIfUnfinished(input.taskId, "fetch-source", "skipped", "创建请求未启用自动启动");
    markProvisionTaskStepIfUnfinished(input.taskId, "install-guest", "skipped", "创建请求未启用自动安装验收");
    markProvisionTaskStep(input.taskId, "wait-network", "skipped", "创建请求未启用自动启动");
    markProvisionTaskStep(input.taskId, "verify-login", "skipped", "创建请求未启用自动启动");
    markProvisionTaskStep(input.taskId, "finalize", "skipped", "创建请求未启用自动启动");
    markProvisionTaskStep(input.taskId, "guest-tools", "skipped", guestToolsMessage(input.request.providerType));
    markProvisionTaskStep(input.taskId, "complete", "success", "VM 已创建，未执行自动安装验收");
    finishProvisionTask(input.taskId, "success", "VM 已创建，未执行自动安装验收。");
    return;
  }

  markProvisionTaskStepIfUnfinished(input.taskId, "boot", "success", "VM 已启动");
  beginGuestInstallTracking(input);
  if (!input.request.planItems.some((item) => item.installSource) && input.request.sourceType !== "iso") {
    markProvisionTaskStep(input.taskId, "wait-network", "running", isWindowsUnattended(input.request) ? "等待 Windows 网络和 WinRM 就绪" : "等待 VM 网络和 SSH 端口就绪");
  }

  const waitNetworkStartedAt = Date.now();
  const networkResults = await waitForGuestNetwork(input);
  input.onTiming?.("verify-wait-network", Date.now() - waitNetworkStartedAt, {
    vmCount: input.request.planItems.length,
    failedCount: networkResults.filter((result) => !result.ok).length,
  });
  const failedNetwork = networkResults.filter((result) => !result.ok);
  updateProvisionTaskVms(
    input.taskId,
    networkResults.map((result) => ({
      id: input.created.find((vm) => vm.name === result.item.name)?.id,
      providerId: input.created.find((vm) => vm.name === result.item.name)?.providerId,
      name: result.item.name,
      ip: result.item.ip,
      status: result.ok ? "running" : result.readiness?.networkVisible ? "warning" : "failed",
      currentStep: "wait-network",
      message: result.message,
      reasonCode: result.reasonCode,
      readiness: result.readiness,
    })),
  );
  if (failedNetwork.length) {
    if (input.request.sourceType === "iso") {
      const windowsRemoteAcceptanceWarning = isWindowsUnattended(input.request)
        && failedNetwork.every((result) => result.readiness?.networkVisible);
      if (windowsRemoteAcceptanceWarning) {
        const warningMessage = failedNetwork.map((item) => item.message).join("；");
        markProvisionTaskStepIfUnfinished(input.taskId, "install-guest", "success", "Windows 已安装并启动");
        markProvisionTaskStep(input.taskId, "wait-network", "warning", warningMessage);
        markProvisionTaskStepIfUnfinished(input.taskId, "verify-login", "skipped", "远程管理未就绪，未执行登录验收");
        markProvisionTaskStepIfUnfinished(input.taskId, "finalize", "skipped", "远程管理未就绪，未执行启动收尾");
        markProvisionTaskStepIfUnfinished(input.taskId, "guest-tools", "skipped", "远程管理未就绪，未执行监控工具验收");
        finishProvisionTask(input.taskId, "warning", `Windows 已安装并进入系统，但远程管理验收未完成：${warningMessage}`);
        return;
      }
      markProvisionTaskStepIfUnfinished(input.taskId, "install-guest", "failed", failedNetwork.map((item) => item.message).join("；"));
      markProvisionTaskStepIfUnfinished(input.taskId, "wait-network", "skipped", "系统安装未完成，未进入网络验收");
      finishProvisionTask(input.taskId, "failed", isWindowsUnattended(input.request) ? "Windows 安装后未等到 WinRM 服务就绪。" : "系统安装后未等到 SSH 服务就绪。");
      return;
    }
    markProvisionTaskStep(input.taskId, "wait-network", "failed", failedNetwork.map((item) => item.message).join("；"));
    finishProvisionTask(input.taskId, "failed", "VM 创建后未等到网络就绪。");
    return;
  }

  completeGuestInstallTracking(input);
  markProvisionTaskStep(input.taskId, "wait-network", "running", isWindowsUnattended(input.request) ? "Windows 已启动，确认 WinRM 服务状态" : "系统已启动，确认 SSH 服务状态");
  markProvisionTaskStep(input.taskId, "wait-network", "success", isWindowsUnattended(input.request) ? "Windows WinRM 服务已就绪" : "VM SSH 端口已就绪");
  const readinessStrategy = resolveProvisioningReadinessStrategy(input.request.providerType);
  const windowsHostMetricsSetup = isWindowsUnattended(input.request) && readinessStrategy.windowsLoginMode === "host-metrics";
  if (windowsHostMetricsSetup) {
    markProvisionTaskStep(input.taskId, "verify-login", "skipped", "Windows 账户由本地 SetupComplete 写入，改由宿主机指标验收");
    updateProvisionTaskVms(
      input.taskId,
      input.request.planItems.map((item) => {
        const vm = input.created.find((created) => created.name === item.name);
        return {
          id: vm?.id,
          providerId: vm?.providerId,
          name: item.name,
          ip: item.ip,
          powerState: "running",
          status: "running",
          currentStep: "finalize",
          message: `Windows 网络已就绪，准备安装 ${resolveGuestMonitoringPolicy(input.request.providerType).label}`,
        };
      }),
    );
  } else {
    markProvisionTaskStep(input.taskId, "verify-login", "running", "验证系统账号密码和启动状态");
    const verifyLoginStartedAt = Date.now();
    const jumpHost = readinessStrategy.resolveJumpHost(input.connection);
    const loginResults = await Promise.all(input.request.planItems.map((item) =>
      isWindowsUnattended(input.request)
        ? verifyWindowsGuestLoginWithRetry(input.taskId, item, input.request.ipPool.gateway)
        : verifyGuestLoginWithRetry(input.taskId, item, jumpHost, input.request.ipPool.gateway),
    ));
    input.onTiming?.("verify-login", Date.now() - verifyLoginStartedAt, {
      vmCount: input.request.planItems.length,
      failedCount: loginResults.filter((result) => !result.ok).length,
    });
    const failedLogin = loginResults.filter((result) => !result.ok);
    updateProvisionTaskVms(
      input.taskId,
      loginResults.map((result) => {
        const vm = input.created.find((created) => created.name === result.item.name);
        return {
          id: vm?.id,
          providerId: vm?.providerId,
          name: result.item.name,
          ip: result.item.ip,
          powerState: "running",
          status: result.ok ? "success" : "failed",
          currentStep: result.ok ? "complete" : "verify-login",
          message: result.message,
        };
      }),
    );
    if (failedLogin.length) {
      markProvisionTaskStep(input.taskId, "verify-login", "failed", failedLogin.map((item) => item.message).join("；"));
      finishProvisionTask(input.taskId, "failed", "系统已启动但账号密码验证失败。");
      return;
    }
    markProvisionTaskStep(input.taskId, "verify-login", "success", isWindowsUnattended(input.request) ? "Administrator NTLM 登录验证通过" : "账号密码验证通过");
    if (input.request.providerType === "xenserver") {
      await writeXenVmGuestOsLabels(input, loginResults);
    }
  }

  markProvisionTaskStep(input.taskId, "finalize", "running", "收尾启动配置");
  const finalizeStartedAt = Date.now();
  if (windowsHostMetricsSetup) {
    await Promise.all(input.request.planItems.map((item) => prepareXenVmForInstalledBoot(input.connection, item.name)));
  }
  await finalizeVmBoot(input);
  input.onTiming?.("verify-finalize", Date.now() - finalizeStartedAt, {
    vmCount: input.request.planItems.length,
  });
  markProvisionTaskStep(input.taskId, "finalize", "success", readinessStrategy.finalizeSuccessMessage());
  markProvisionTaskStep(input.taskId, "guest-tools", "running", guestToolsMessage(input.request.providerType));
  const guestToolsStartedAt = Date.now();
  const guestToolsResults = await installGuestTools(input);
  input.onTiming?.("verify-guest-tools", Date.now() - guestToolsStartedAt, {
    vmCount: input.request.planItems.length,
    failedCount: guestToolsResults.filter((result) => !result.ok).length,
  });
  const failedGuestTools = guestToolsResults.filter((result) => !result.ok);
  for (const result of guestToolsResults) {
    updateProvisionTaskVm(input.taskId, result.item.name, {
      status: result.ok ? "success" : "warning",
      currentStep: result.ok ? "complete" : "guest-tools",
      progressPercent: result.ok ? 100 : 98,
      message: result.message,
    });
  }
  if (failedGuestTools.length) {
    const warningMessage = failedGuestTools.map((item) => item.message).join("；");
    markProvisionTaskStep(input.taskId, "guest-tools", "warning", warningMessage);
    finishProvisionTask(input.taskId, "warning", `系统创建完成，监控工具尚未生效：${warningMessage}`);
    return;
  }
  markProvisionTaskStep(input.taskId, "guest-tools", "success", guestToolsSuccessMessage(input.request.providerType));
  markProvisionTaskStep(input.taskId, "complete", "success", "VM 创建、系统启动和登录验证完成");
  finishProvisionTask(input.taskId, "success", "VM 创建、环境安装、系统启动和登录验证完成。");
}

function beginGuestInstallTracking(input: RunProvisioningVerifierInput): void {
  if (input.request.planItems.some((item) => item.installSource)) {
    markProvisionTaskStepIfUnfinished(input.taskId, "fetch-source", "running", "等待安装器拉取 Kickstart 配置");
    return;
  }
  if (input.request.sourceType === "iso") {
    markProvisionTaskStepIfUnfinished(input.taskId, "fetch-source", "skipped", "当前安装策略无独立安装源回调");
    markProvisionTaskStepIfUnfinished(input.taskId, "install-guest", "running", isWindowsUnattended(input.request) ? "等待 Windows Setup 完成并开放 WinRM" : "等待系统安装完成并开放 SSH");
    return;
  }
  markProvisionTaskStepIfUnfinished(input.taskId, "fetch-source", "skipped", "模板克隆不需要拉取安装源");
  markProvisionTaskStepIfUnfinished(input.taskId, "install-guest", "skipped", "模板克隆不需要执行系统安装");
}

function completeGuestInstallTracking(input: RunProvisioningVerifierInput): void {
  if (input.request.planItems.some((item) => item.installSource)) {
    markProvisionTaskStepIfUnfinished(input.taskId, "fetch-source", "success", "已通过系统启动确认安装源拉取完成");
    markProvisionTaskStepIfUnfinished(input.taskId, "install-guest", "success", isWindowsUnattended(input.request) ? "已通过 WinRM 就绪确认 Windows 安装完成" : "已通过 SSH 就绪确认系统安装完成");
    return;
  }
  if (input.request.sourceType === "iso") {
    markProvisionTaskStepIfUnfinished(
      input.taskId,
      "install-guest",
      "success",
      isWindowsUnattended(input.request) ? "已通过 WinRM 就绪确认 Windows 安装完成" : "已通过 SSH 就绪确认系统安装完成",
    );
  }
}

async function waitForGuestNetwork(input: RunProvisioningVerifierInput): Promise<GuestVerifyResult[]> {
  const startedAt = Date.now();
  const softDeadline = startedAt + resolveGuestNetworkWaitMs(input.request);
  const deadline = hardWaitDeadline(startedAt);
  const pending = new Map(input.request.planItems.map((item) => [item.name, item]));
  const readyStreaks = new Map<string, number>();
  const windowsNetworkStreaks = new Map<string, number>();
  const windowsNetworkVisibleSince = new Map<string, number>();
  const results: GuestVerifyResult[] = [];
  const readinessStrategy = resolveProvisioningReadinessStrategy(input.request.providerType);
  let attempt = 0;
  while (pending.size && Date.now() < deadline) {
    if (isProvisionTaskTerminal(input.taskId)) {
      throw new Error("创建任务已结束，停止后台安装验收");
    }
    attempt += 1;
    const restartedFromDisk = await startPoweredOffProxmoxGuests(input).catch(() => new Set<string>());
    const installingVms = await refreshXenHostInstallProgress(input).catch(() => new Set<string>());
    for (const item of Array.from(pending.values())) {
      const waitingOverlong = Date.now() >= softDeadline;
      const tracksIsoInstall = input.request.sourceType === "iso" && !isProvisionStepSuccessful(input.taskId, "install-guest");
      updateProvisionTaskVm(input.taskId, item.name, {
        status: "running",
        currentStep: tracksIsoInstall || installingVms.has(item.name) ? "install-guest" : "wait-network",
        message: waitingOverlong
          ? tracksIsoInstall
            ? `${isWindowsUnattended(input.request) ? "Windows" : "系统"}安装时间较长，后台继续等待启动 ${attempt}`
            : `等待系统网络时间较长，后台继续核验 ${attempt}`
          : restartedFromDisk.has(item.name)
          ? "安装器已关机，正在从系统盘启动"
          : tracksIsoInstall || installingVms.has(item.name)
            ? `${isWindowsUnattended(input.request) ? "Windows" : "系统"}安装中，等待${isWindowsUnattended(input.request) ? " WinRM" : " SSH"}就绪 ${attempt}`
            : isWindowsUnattended(input.request)
              ? `Windows 网络与 WinRM 探测中 ${attempt}`
              : `SSH 探测中 ${attempt}`,
      });
      // 网络阶段只确认目标服务响应；账号密码单独验收，避免把认证失败误报为网络超时。
      const windows = isWindowsUnattended(input.request);
      const jumpHost = readinessStrategy.resolveJumpHost(input.connection);
      const protocolReady = windows
        ? await canReadWinRmHttpResponse(item.ip, windowsWinRmPort, sshVerifyTimeoutMs, jumpHost)
        : await canReadGuestSshBanner(item.ip, 22, sshVerifyTimeoutMs, jumpHost);
      const arpVisible = windows && readinessStrategy.supportsHostArp && jumpHost && !protocolReady
        ? await canResolveGuestArpFromXenHost(item.ip, jumpHost)
        : false;
      const hostPingReady = windows && readinessStrategy.requiresWindowsHostPing && protocolReady && jumpHost
        ? await canPingGuestFromXenHost(item.ip, sshVerifyTimeoutMs, jumpHost)
        : false;
      const readiness = readinessStrategy.evaluate({ windows, protocolReady, arpVisible, hostPingReady });
      const windowsNetworkVisible = windows && readiness.networkVisible;
      const networkStreak = windowsNetworkVisible ? (windowsNetworkStreaks.get(item.name) ?? 0) + 1 : 0;
      windowsNetworkStreaks.set(item.name, networkStreak);
      if (windowsNetworkVisible && !windowsNetworkVisibleSince.has(item.name)) {
        windowsNetworkVisibleSince.set(item.name, resolvePersistedWindowsNetworkVisibleAt(input.taskId) ?? Date.now());
      } else if (!windowsNetworkVisible) {
        windowsNetworkVisibleSince.delete(item.name);
      }
      if (windows && networkStreak >= 2) {
        // ARP only proves that Windows has brought up its network stack. Setup can still be
        // rendering the installer, so do not close the install step until WinRM responds.
        const windowsSetupReady = readiness.state === "protocol-ready" || readiness.state === "ready";
        if (windowsSetupReady) {
          markProvisionTaskStepIfUnfinished(input.taskId, "install-guest", "success", "Windows 已完成安装阶段并开放 WinRM");
        }
        markProvisionTaskStepIfUnfinished(
          input.taskId,
          "wait-network",
          "running",
          windowsSetupReady ? "Windows IP 已上线，等待宿主机 Ping 验收" : "Windows 网络已上线，仍在等待安装完成并开放 WinRM",
        );
        updateProvisionTaskVm(input.taskId, item.name, {
          status: "running",
          currentStep: windowsSetupReady ? "wait-network" : "install-guest",
          message: windowsSetupReady ? `Windows 安装阶段已完成，等待宿主机 Ping 验收 ${attempt}` : `Windows 安装中，网络已上线，等待 WinRM 初始化 ${attempt}`,
          reasonCode: readiness.reasonCode,
          readiness: toTaskReadiness(readiness),
        });
      }
      // Linux ISO Kickstart（http-boot-iso / cdrom-http-ks / native-http）启动参数带 inst.sshd，
      // 安装器环境本身就会开放 sshd 并接受 kickstart 的 root 口令，直接把“SSH 可读”当作装好
      // 会把任务误判成 complete（127.37 实测：rpm 还没开始下载任务已报成功）。
      // 这类安装必须等安装器 %post 回调 installed 钩子（宿主机日志出现 INSTALLED、install-guest 成功）
      // 之后才接受 SSH；offline-iso 没有 installSource，不应用此门控，保持历史验收行为。
      const linuxIsoTrackedInstall =
        input.request.sourceType === "iso" &&
        !isWindowsUnattended(input.request) &&
        Boolean(item.installSource) &&
        tracksIsoInstall;
      const serviceReady = readiness.ready && !linuxIsoTrackedInstall;
      if (windows && readiness.state === "protocol-ready") {
        updateProvisionTaskVm(input.taskId, item.name, {
          status: "running",
          currentStep: "wait-network",
          message: "WinRM 已响应，等待宿主机 ping 验证",
          reasonCode: readiness.reasonCode,
          readiness: toTaskReadiness(readiness),
        });
      }
      const networkVisibleAt = windowsNetworkVisibleSince.get(item.name);
      if (windows && !serviceReady && readiness.state === "protocol-ready" && networkStreak >= 2 && hasWindowsRemoteInitializationTimedOut(networkVisibleAt)) {
        results.push({
          item,
          ok: false,
          message: `${item.name} (${item.ip}) WinRM 已响应，但宿主机 Ping 持续失败，请检查 Windows 防火墙 ICMP 规则`,
          reasonCode: "WINDOWS_ICMP_BLOCKED",
          readiness: toTaskReadiness(readiness),
        });
        pending.delete(item.name);
        continue;
      }
      const readyStreak = serviceReady ? (readyStreaks.get(item.name) ?? 0) + 1 : 0;
      readyStreaks.set(item.name, readyStreak);
      if (windows && serviceReady && readyStreak < windowsWinRmReadyConfirmations) {
        updateProvisionTaskVm(input.taskId, item.name, {
          status: "running",
          currentStep: "wait-network",
          message: `WinRM 已响应，继续确认服务稳定 ${readyStreak}/${windowsWinRmReadyConfirmations}`,
          reasonCode: readiness.reasonCode,
          readiness: toTaskReadiness(readiness),
        });
        continue;
      }
      if (serviceReady) {
        results.push({
          item,
          ok: true,
          message: windows ? "Windows WinRM 服务已就绪" : "VM SSH 服务已就绪",
          reasonCode: readiness.reasonCode,
          readiness: toTaskReadiness(readiness),
        });
        pending.delete(item.name);
      }
    }
    if (pending.size) await delay(networkProbeIntervalMs);
  }
  for (const item of pending.values()) {
    results.push({
      item,
      ok: false,
      message: `${item.name} (${item.ip}) 超时未响应${isWindowsUnattended(input.request) ? " WinRM 服务" : " SSH 服务"}`,
      reasonCode: "GUEST_OFFLINE",
      readiness: { state: "offline", networkVisible: false, ready: false },
    });
  }
  return results;
}

function toTaskReadiness(readiness: ProvisioningReadinessResult): GuestVerifyResult["readiness"] {
  return {
    state: readiness.state,
    networkVisible: readiness.networkVisible,
    ready: readiness.ready,
  };
}

function resolvePersistedWindowsNetworkVisibleAt(taskId: string): number | undefined {
  const installStep = getProvisionTask(taskId)?.steps.find((step) => step.key === "install-guest");
  if (installStep?.status !== "success" || !installStep.finishedAt) return undefined;
  const timestamp = Date.parse(installStep.finishedAt);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function isProvisionStepSuccessful(taskId: string, stepKey: ProvisionTaskStepKey): boolean {
  return getProvisionTask(taskId)?.steps.some((step) => step.key === stepKey && step.status === "success") ?? false;
}

/**
 * Decides whether an online Windows guest has exceeded the remote initialization window.
 *
 * @param networkVisibleAt timestamp when XenServer first confirmed the guest IP through ARP
 * @param now current timestamp used for deterministic tests
 * @return true when Ping/WinRM should be reported as a terminal initialization failure
 */
export function hasWindowsRemoteInitializationTimedOut(networkVisibleAt: number | undefined, now = Date.now()): boolean {
  return networkVisibleAt != null && now - networkVisibleAt >= windowsRemoteInitializationWaitMs;
}

async function startPoweredOffProxmoxGuests(input: RunProvisioningVerifierInput): Promise<Set<string>> {
  if (input.request.providerType !== "proxmox" || input.request.installStrategy !== "kickstart") return new Set();
  const restarted = new Set<string>();
  for (const vm of input.created) {
    const vmId = vm.id || vm.providerId;
    if (!vmId) continue;
    if (await startProxmoxVmFromDiskIfStopped(input.connection, vmId)) {
      restarted.add(vm.name);
    }
  }
  return restarted;
}

function resolveGuestNetworkWaitMs(request: VmProvisionRequest): number {
  if (isWindowsUnattended(request)) return windowsInstallWaitMs;
  if (request.providerType === "proxmox" && request.installStrategy === "kickstart") {
    return pveArmInstallWaitMs;
  }
  return networkWaitMs;
}

async function refreshXenHostInstallProgress(input: RunProvisioningVerifierInput): Promise<Set<string>> {
  if (input.request.providerType !== "xenserver") return new Set();
  const refs = input.request.planItems
    .map((item) => ({ item, source: item.installSource }))
    .filter((entry): entry is { item: VmProvisionPlanItem; source: NonNullable<VmProvisionPlanItem["installSource"]> } => Boolean(entry.source));
  if (!refs.length) return new Set();
  const probes = refs
    .map(({ item, source }) => {
      const port = parseInstallSourcePort(source.ksUrl);
      if (!port) return undefined;
      return {
        vmName: item.name,
        sourceId: source.id,
        port,
      };
    })
    .filter((item): item is { vmName: string; sourceId: string; port: string } => Boolean(item));
  if (!probes.length) return new Set();
  const output = await runHostCommand(
    input.connection,
    probes
      .map(
        (probe) => [
          `log_file='/tmp/vrc-install-source-${escapeShellValue(probe.port)}.log'`,
          `source_id='${escapeShellValue(probe.sourceId)}'`,
          `vm_name='${escapeShellValue(probe.vmName)}'`,
          '[ -f "$log_file" ] || exit 0',
          '{ grep -q "GET /$source_id/ks.cfg " "$log_file" && printf "FETCH\\t%s\\n" "$vm_name"; } || true',
          '{ grep -Eq "GET /$source_id/repo/Packages/.*\\.rpm " "$log_file" && printf "PACKAGE\\t%s\\n" "$vm_name"; } || true',
          '{ grep -q "GET /$source_id/installed " "$log_file" && printf "INSTALLED\\t%s\\n" "$vm_name"; } || true',
        ].join("\n"),
      )
      .join("\n"),
  );
  const fetched = new Set<string>();
  const installing = new Set<string>();
  const installed = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const [kind, vmName] = line.split("\t");
    if (kind === "FETCH" && vmName) fetched.add(vmName);
    if (kind === "PACKAGE" && vmName) installing.add(vmName);
    if (kind === "INSTALLED" && vmName) installed.add(vmName);
  }
  if (fetched.size === refs.length) {
    markProvisionTaskStepIfUnfinished(input.taskId, "fetch-source", "success", "安装器已拉取 Kickstart 配置");
  }
  if (installed.size === refs.length) {
    markProvisionTaskStepIfUnfinished(input.taskId, "install-guest", "success", "系统安装脚本已完成，等待 SSH 就绪");
    markProvisionTaskStep(input.taskId, "wait-network", "running", "等待安装后系统重启并开放 SSH");
  } else if (installing.size > 0) {
    markProvisionTaskStepIfUnfinished(input.taskId, "install-guest", "running", "系统安装器正在安装软件包");
  } else if (fetched.size > 0) {
    markProvisionTaskStepIfUnfinished(input.taskId, "install-guest", "running", "安装器已读取 Kickstart，等待请求软件包");
  }
  await Promise.all(
    [...installed].map((vmName) => prepareXenVmForInstalledBoot(input.connection, vmName)),
  );
  for (const vmName of installed) {
    updateProvisionTaskVm(input.taskId, vmName, {
      status: "running",
      currentStep: "wait-network",
      message: "系统安装脚本已完成，等待 SSH 就绪",
    });
  }
  for (const vmName of [...installing].filter((name) => !installed.has(name))) {
    updateProvisionTaskVm(input.taskId, vmName, {
      status: "running",
      currentStep: "install-guest",
      message: "系统安装器正在安装软件包",
    });
  }
  for (const vmName of [...fetched].filter((name) => !installing.has(name) && !installed.has(name))) {
    updateProvisionTaskVm(input.taskId, vmName, {
      status: "running",
      currentStep: "install-guest",
      message: "安装器已读取 Kickstart，等待请求软件包",
    });
  }
  return new Set([...installing, ...fetched].filter((vmName) => !installed.has(vmName)));
}

function parseInstallSourcePort(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  } catch {
    return undefined;
  }
}

async function verifyGuestLogin(item: VmProvisionPlanItem, jumpHost?: XenConnectionInput, gateway?: string): Promise<GuestVerifyResult> {
  let transport: GuestTransport;
  try {
    transport = await openGuestTransport(item.ip, 22, jumpHost);
  } catch (error) {
    return { item, ok: false, message: `${item.name} SSH 跳板连接失败：${error instanceof Error ? error.message : String(error)}` };
  }
  return new Promise((resolve) => {
    const username = item.loginUsername || "root";
    const client = new Client();
    let settled = false;
    const finish = (ok: boolean, message: string, guestOs?: string) => {
      if (settled) return;
      settled = true;
      client.end();
      transport.close();
      resolve({ item, ok, message, guestOs });
    };
    client
      .on("ready", () => {
        const gatewayProbe = gateway?.trim()
          ? `; echo VRC_GATEWAY_CHECK; ping -c 2 -W 2 ${escapeShellArg(gateway.trim())} >/dev/null 2>&1`
          : "";
        // Linux ISO 无人值守启动参数带 inst.sshd，Anaconda 安装器环境本身会开 sshd 且接受
        // kickstart 的 root 口令。离线安装阶段直接能 SSH 登录，但系统还没装完，绝不能放行。
        // /run/install、/run/rootfsbase、/tmp/anaconda.log 都是安装器环境的特征标记，
        // 命中即返回非零（retryable），直到重装完成后目标系统 sshd 起来才视为登录成功。
        const installerProbe = `if [ -d /run/install ] || [ -d /run/rootfsbase ] || [ -e /tmp/anaconda.log ]; then printf 'VRC_INSTALLER_RUNNING\\n'; exit 3; fi`;
        client.exec(`${installerProbe}; cat /etc/os-release 2>/dev/null | head -5; uname -r${gatewayProbe}`, (error, stream) => {
          if (error) {
            finish(false, `${item.name} SSH 已连接但命令执行失败`);
            return;
          }
          let stdout = "";
          let stderr = "";
          stream
            .on("close", (code: number) => {
              const output = stdout.trim().split(/\r?\n/).filter((line) => line !== "VRC_GATEWAY_CHECK" && line !== "VRC_INSTALLER_RUNNING" && Boolean(line)).slice(0, 2).join(" · ");
              if (stdout.includes("VRC_INSTALLER_RUNNING")) {
                finish(false, `${item.name} 安装器仍在运行（SSH 来自 Anaconda 环境，系统尚未安装完成），继续等待`);
                return;
              }
              // 从 /etc/os-release 解析 PRETTY_NAME，作为平台“系统”列的标识来源（other-config:vrc-guest-os）。
              // 只在登录验证通过时携带；安装器环境探测到 VRC_INSTALLER_RUNNING 时不会走到这里。
              let detectedGuestOs: string | undefined;
              if (code === 0) {
                const osReleaseLine = stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => line.startsWith("PRETTY_NAME="));
                if (osReleaseLine) {
                  const prettyName = osReleaseLine.replace(/^PRETTY_NAME=/, "").replace(/^["']|["']$/g, "").trim();
                  detectedGuestOs = normalizeGuestOsLabel(prettyName);
                }
              }
              finish(
                code === 0,
                code === 0
                  ? `登录验证通过：${output || "系统已响应"}`
                  : stderr.trim() || `${item.name} 登录成功但网关 ${gateway || ""} 不可达`,
                detectedGuestOs,
              );
            })
            .on("data", (chunk: Buffer) => {
              stdout += chunk.toString("utf8");
            })
            .stderr.on("data", (chunk: Buffer) => {
              stderr += chunk.toString("utf8");
            });
        });
      })
      .on("error", (error) => {
        finish(false, `${item.name} 登录失败：${error.message}`);
      })
      .connect({
        host: item.ip,
        port: 22,
        sock: transport.sock,
        username,
        password: item.rootPassword,
        readyTimeout: sshVerifyTimeoutMs,
        algorithms: buildGuestSshAlgorithms(),
      });
  });
}

async function writeXenVmGuestOsLabels(input: RunProvisioningVerifierInput, loginResults: GuestVerifyResult[]): Promise<void> {
  // 平台“系统”列读 other-config:vrc-guest-os；无人值守 ISO 安装基于 “Other install media” 模板，
  // 不写该字段就显示 “-”。这里用 SSH 验证时从 /etc/os-release 探测到的真实系统标识补齐：
  // 字段为空或为创建时 ISO 名占位（source=iso）时覆盖；人工/模板既有的标识（source 非 iso）保留。
  const commands = loginResults
    .map((result) => {
      if (!result.ok || !result.guestOs) return undefined;
      const vm = input.created.find((created) => created.name === result.item.name);
      const vmId = vm?.id || vm?.providerId;
      if (!vmId) return undefined;
      const label = result.guestOs;
      return [
        `vm_uuid='${escapeShellValue(vmId)}'`,
        `os_label='${escapeShellValue(label)}'`,
        '[ -n "$vm_uuid" ] || exit 0',
        'existing="$(xe vm-param-get uuid="$vm_uuid" param-name=other-config param-key=vrc-guest-os 2>/dev/null | tr -d "\r\n")"',
        'source="$(xe vm-param-get uuid="$vm_uuid" param-name=other-config param-key=vrc-guest-os-source 2>/dev/null | tr -d "\r\n")"',
        // 占位（source=iso，创建时按 ISO 名预写）或字段为空时，用 SSH 探测到的真实系统覆盖；
        // 人工/模板既有的标识（source 非 iso）保留，避免覆盖更准确的手工设置。
        'if [ -z "$existing" ] || [ "$existing" = "<not in database>" ] || [ "$source" = "iso" ]; then',
        '  xe vm-param-set uuid="$vm_uuid" other-config:vrc-guest-os="$os_label" >/dev/null 2>&1 || true',
        '  xe vm-param-set uuid="$vm_uuid" other-config:vrc-guest-os-source=ssh >/dev/null 2>&1 || true',
        'fi',
      ].join("\n");
    })
    .filter((command): command is string => Boolean(command));
  if (!commands.length) return;
  try {
    await runHostCommand(input.connection, commands.join("\n"));
  } catch (error) {
    console.warn(`[provision] 写入 vrc-guest-os 失败（不影响安装结果）：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function verifyWindowsGuestLogin(item: VmProvisionPlanItem, gateway?: string): Promise<GuestVerifyResult> {
  const computerName = windowsComputerName(item);
  const username = `${computerName}\\${item.loginUsername || "Administrator"}`;
  try {
    const gatewayCheck = gateway?.trim() ? ` & ping -n 2 ${windowsCmdArg(gateway.trim())}` : "";
    const output = await runWinRmCommand(`cmd /c "hostname & ver${gatewayCheck}"`, item.ip, username, item.rootPassword || "", windowsWinRmPort);
    const summary = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 2).join(" · ");
    return { item, ok: true, message: `Administrator 登录验证通过：${summary || computerName}` };
  } catch {
    return { item, ok: false, message: `${item.name} Administrator NTLM 登录验证失败` };
  }
}

async function verifyWindowsGuestLoginWithRetry(
  taskId: string,
  item: VmProvisionPlanItem,
  gateway?: string,
): Promise<GuestVerifyResult> {
  const startedAt = Date.now();
  const softDeadline = startedAt + networkWaitMs;
  const deadline = hardWaitDeadline(startedAt);
  let attempt = 0;
  let lastResult: GuestVerifyResult | undefined;
  while (Date.now() < deadline) {
    attempt += 1;
    updateProvisionTaskVm(taskId, item.name, {
      status: "running",
      currentStep: "verify-login",
      message: Date.now() >= softDeadline ? `Windows 登录验证时间较长，后台继续核验 ${attempt}` : `Administrator NTLM 登录验证 ${attempt}`,
    });
    lastResult = await verifyWindowsGuestLogin(item, gateway);
    if (lastResult.ok) return lastResult;
    await delay(sshLoginRetryIntervalMs);
  }
  return lastResult ?? { item, ok: false, message: `${item.name} 超时未通过 Administrator 登录验证` };
}

async function verifyGuestLoginWithRetry(
  taskId: string,
  item: VmProvisionPlanItem,
  jumpHost?: XenConnectionInput,
  gateway?: string,
): Promise<GuestVerifyResult> {
  const startedAt = Date.now();
  const softDeadline = startedAt + networkWaitMs;
  const deadline = hardWaitDeadline(startedAt);
  let lastResult: GuestVerifyResult | undefined;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    updateProvisionTaskVm(taskId, item.name, {
      status: "running",
      currentStep: "verify-login",
      message: Date.now() >= softDeadline ? `登录验证等待时间较长，后台继续核验 ${attempt}` : `SSH 登录验证 ${attempt}`,
    });
    lastResult = await verifyGuestLogin(item, jumpHost, gateway);
    if (lastResult.ok) return lastResult;
    await delay(sshLoginRetryIntervalMs);
  }
  return {
    item,
    ok: false,
    message: lastResult?.message || `${item.name} 超时未通过 SSH 登录验证`,
  };
}

async function finalizeVmBoot(input: RunProvisioningVerifierInput): Promise<void> {
  if (input.request.providerType !== "xenserver") return;
  const commands = input.created
    .map((vm) => vm.id || vm.providerId)
    .filter(Boolean)
    .map(
      (vmId) => `
vm_uuid='${escapeShellValue(vmId)}'
xe vm-param-set uuid="$vm_uuid" HVM-boot-params:order=c >/dev/null 2>&1 || true
for vbd in $(xe vbd-list vm-uuid="$vm_uuid" type=CD --minimal 2>/dev/null | tr ',' ' '); do
  vdi="$(xe vbd-param-get uuid="$vbd" param-name=vdi-uuid 2>/dev/null | tr -d '\\r\\n')"
  label="$(xe vdi-param-get uuid="$vdi" param-name=name-label 2>/dev/null | tr -d '\\r\\n')"
  if [ "$label" = "xs-tools.iso" ] || [ "$label" = "guest-tools.iso" ]; then
    continue
  fi
  attached="$(xe vbd-param-get uuid="$vbd" param-name=currently-attached 2>/dev/null | tr -d '\\r\\n')"
  if [ "$attached" = "true" ]; then
    xe vbd-eject uuid="$vbd" >/dev/null 2>&1 || true
  fi
done
`,
    );
  if (!commands.length) return;
  await runHostCommand(input.connection, commands.join("\n"));
}

async function installGuestTools(input: RunProvisioningVerifierInput): Promise<GuestVerifyResult[]> {
  if (input.request.providerType !== "xenserver") {
    return installPackageGuestMonitoringTools(input);
  }
  // Rocky 9：老 XenServer 6.5（Xen 4.4）官方不支持 RHEL9 tools，EPEL 的 xe-guest-utilities 即使装上
  // PV 驱动也起不来，重启即卡死。Rocky 9 已用 xen_nopv 走模拟设备，直接跳过工具安装；
  // CentOS 7 / Ubuntu / Windows 保持原有路径，避免一刀切影响老系统。
  const rocky9 = isRocky9Image(input.request.isoName ?? "");
  const results: GuestVerifyResult[] = [];
  for (const item of input.request.planItems) {
    const vm = input.created.find((created) => created.name === item.name);
    if (!vm) {
      results.push({ item, ok: false, message: `${item.name} 未找到已创建 VM，无法安装 xs-tools` });
      continue;
    }
    if (isWindowsUnattended(input.request)) {
      results.push(await installWindowsXenTools(input, item, vm));
      continue;
    }
    if (rocky9) {
      // 老 Xen 官方不支持 RHEL9 tools，跳过安装视为通过；Rocky 9 走 xen_nopv 模拟设备，无需 guest 内工具。
      updateProvisionTaskVm(input.taskId, item.name, {
        status: "running",
        currentStep: "guest-tools",
        message: "Rocky 9 走 xen_nopv 模拟设备，跳过 XenServer Tools 安装",
      });
      results.push({ item, vm, ok: true, message: `${item.name} Rocky 9 走 xen_nopv 模拟设备，跳过 xs-tools 安装` });
      continue;
    }
    try {
      let serviceReady = await isXenGuestToolsServiceReadyInGuest(item, input.connection);
      if (!serviceReady) {
        updateProvisionTaskVm(input.taskId, item.name, {
          status: "running",
          currentStep: "guest-tools",
          message: "正在挂载 XenServer xs-tools.iso",
        });
        await attachXenToolsIso(input.connection, vm.id || vm.providerId);
        updateProvisionTaskVm(input.taskId, item.name, {
          status: "running",
          currentStep: "guest-tools",
          message: "正在 guest 内安装 XenServer xs-tools",
        });
        try {
          await installXenToolsInGuest(item, input.connection);
        } catch (installError) {
          serviceReady = await isXenGuestToolsServiceReadyInGuest(item, input.connection);
          if (!serviceReady) throw installError;
        }
        if (!serviceReady) {
          updateProvisionTaskVm(input.taskId, item.name, {
            status: "running",
            currentStep: "guest-tools",
            message: "XenServer Tools 已安装，正在重启 Guest 使工具生效",
          });
          await rebootXenGuestAndWait(input.taskId, item, input.connection, input.request.ipPool.gateway);
        }
      } else {
        updateProvisionTaskVm(input.taskId, item.name, {
          status: "running",
          currentStep: "guest-tools",
          message: "已检测到 XenServer Tools，正在验证平台指标",
        });
      }
      await verifyXenGuestToolsServiceInGuest(item, input.connection);
      updateProvisionTaskVm(input.taskId, item.name, {
        status: "running",
        currentStep: "guest-tools",
        message: "Guest Tools 服务已启动，等待 XenServer 回报指标",
      });
      await verifyXenGuestToolsOnHost(input.taskId, item, input.connection, vm.id || vm.providerId);
      updateProvisionTaskVm(input.taskId, item.name, {
        status: "running",
        currentStep: "guest-tools",
        message: "xs-tools 安装完成，正在弹出工具 ISO",
      });
      await ejectVmCdrom(input.connection, vm.id || vm.providerId);
      results.push({ item, vm, ok: true, message: `${item.name} xs-tools 已安装` });
    } catch (error) {
      await ejectVmCdrom(input.connection, vm.id || vm.providerId).catch(() => undefined);
      results.push({
        item,
        vm,
        ok: false,
        message: `${item.name} xs-tools 安装失败：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return results;
}

async function installPackageGuestMonitoringTools(input: RunProvisioningVerifierInput): Promise<GuestVerifyResult[]> {
  const policy = resolveGuestMonitoringPolicy(input.request.providerType);
  if (!policy.guestInstallCommand) {
    return input.request.planItems.map((item) => ({ item, ok: true, message: `${policy.label} 无需额外安装` }));
  }
  const results: GuestVerifyResult[] = [];
  for (const item of input.request.planItems) {
    const vm = input.created.find((created) => created.name === item.name);
    if (!vm) {
      results.push({ item, ok: false, message: `${item.name} 未找到已创建 VM，无法安装 ${policy.label}` });
      continue;
    }
    updateProvisionTaskVm(input.taskId, item.name, {
      status: "running",
      currentStep: "guest-tools",
      message: `正在安装 ${policy.label}`,
    });
    try {
      await runGuestCommand(item, policy.guestInstallCommand, 10 * 60 * 1000);
      if (policy.platformVerification === "pve-agent") {
        await enableAndVerifyProxmoxGuestAgent(input.connection, vm.id || vm.providerId);
      } else if (policy.platformVerification === "vmware-tools") {
        await verifyVmwareGuestTools(input.connection, vm.id || vm.providerId);
      }
      results.push({ item, vm, ok: true, message: `${item.name} ${policy.label} 已安装并通过平台验证` });
    } catch (error) {
      results.push({
        item,
        vm,
        ok: false,
        message: `${item.name} ${policy.label} 安装或验证失败：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return results;
}

/**
 * Mounts the host-specific Tools media and verifies the Guest-reported platform metrics.
 *
 * Windows Server 2008 R2 local-account NTLM behavior varies by WinRM implementation. The
 * task-scoped SYSTEM bootstrap is therefore the only Tools installer; WinRM remains a readiness
 * signal and must not become a second installation path that can terminate verification early.
 */
async function installWindowsXenTools(
  input: RunProvisioningVerifierInput,
  item: VmProvisionPlanItem,
  vm: VmProvisionCreatedVm,
): Promise<GuestVerifyResult> {
  const vmId = vm.id || vm.providerId;
  try {
    const hostToolsReady = await isXenGuestToolsReadyOnHost(input.connection, vmId);
    if (!hostToolsReady) {
      updateProvisionTaskVm(input.taskId, item.name, {
        status: "running",
        currentStep: "guest-tools",
        message: "正在挂载 XenServer Tools，等待 Windows 登录态脚本安装",
      });
      await attachXenToolsIso(input.connection, vmId);
      updateProvisionTaskVm(input.taskId, item.name, {
        status: "running",
        currentStep: "guest-tools",
        message: "Tools 光盘已挂载，等待 Windows 登录态脚本安装并重启",
      });
    }
    await verifyXenGuestToolsOnHost(input.taskId, item, input.connection, vmId, 45 * 60 * 1000);
    await ejectVmCdrom(input.connection, vmId);
    return { item, vm, ok: true, message: `${item.name} Windows XenServer Tools 已安装并通过平台验证` };
  } catch (error) {
    // Windows 初始化任务可能还要跨重启继续读取 Tools 盘；验收失败不能先弹盘。
    // 由任务成功收尾或明确终止清理统一卸载，避免把重试链路截断。
    return {
      item,
      vm,
      ok: false,
      message: `${item.name} Windows XenServer Tools 安装失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function isXenGuestToolsReadyOnHost(connection: XenConnectionInput, vmId: string): Promise<boolean> {
  const output = await runHostCommand(connection, buildXenGuestMetricsProbeScript(vmId));
  return output.split(/\r?\n/).includes("READY");
}

async function attachXenToolsIso(connection: XenConnectionInput, vmId: string): Promise<void> {
  await runHostCommand(
    connection,
    `
vm_uuid='${escapeShellValue(vmId)}'
tools_iso=""
for candidate in $(xe cd-list --minimal 2>/dev/null | tr ',' ' '); do
  label="$(xe vdi-param-get uuid="$candidate" param-name=name-label 2>/dev/null | tr -d '\r\n')"
  if [ "$label" = "xs-tools.iso" ]; then tools_iso="$candidate"; break; fi
done
[ -n "$tools_iso" ] || for candidate in $(xe cd-list --minimal 2>/dev/null | tr ',' ' '); do
  label="$(xe vdi-param-get uuid="$candidate" param-name=name-label 2>/dev/null | tr -d '\r\n')"
  if [ "$label" = "guest-tools.iso" ]; then tools_iso="$candidate"; break; fi
done
[ -n "$tools_iso" ] || { echo "未找到 xs-tools.iso" >&2; exit 7; }
cd_vbd="$(xe vbd-list vm-uuid="$vm_uuid" type=CD --minimal 2>/dev/null | tr ',' ' ' | awk '{print $1}')"
if [ -n "$cd_vbd" ]; then
  current_vdi="$(xe vbd-param-get uuid="$cd_vbd" param-name=vdi-uuid 2>/dev/null | tr -d '\r\n')"
  if [ "$current_vdi" != "$tools_iso" ]; then
    xe vbd-unplug uuid="$cd_vbd" force=true >/dev/null 2>&1 || true
    xe vbd-eject uuid="$cd_vbd" >/dev/null 2>&1 || true
    xe vbd-insert uuid="$cd_vbd" vdi-uuid="$tools_iso" >/dev/null
  fi
else
  cd_vbd="$(xe vbd-create vm-uuid="$vm_uuid" vdi-uuid="$tools_iso" device=3 bootable=false mode=RO type=CD)"
fi
if [ "$(xe vbd-param-get uuid="$cd_vbd" param-name=currently-attached 2>/dev/null | tr -d '\r\n')" != "true" ]; then
  xe vbd-plug uuid="$cd_vbd" >/dev/null
fi
[ "$(xe vbd-param-get uuid="$cd_vbd" param-name=empty 2>/dev/null | tr -d '\r\n')" = "false" ] || { echo "xs-tools 光驱插入后仍为空" >&2; exit 8; }
`,
  );
}

async function ejectVmCdrom(connection: XenConnectionInput, vmId: string): Promise<void> {
  await runHostCommand(
    connection,
    `
vm_uuid='${escapeShellValue(vmId)}'
for vbd in $(xe vbd-list vm-uuid="$vm_uuid" type=CD --minimal 2>/dev/null | tr ',' ' '); do
  xe vbd-eject uuid="$vbd" >/dev/null 2>&1 || true
done
`,
  );
}

async function installXenToolsInGuest(item: VmProvisionPlanItem, jumpHost: XenConnectionInput): Promise<void> {
  await runGuestCommand(
    item,
    buildXenToolsGuestInstallCommand(),
    10 * 60 * 1000,
    jumpHost,
  );
}

export function buildXenToolsGuestInstallCommand(): string {
  return `
set -e
mkdir -p /mnt/xs-tools
for attempt in $(seq 1 20); do
  mountpoint -q /mnt/xs-tools && break
  for device in /dev/cdrom /dev/sr0 /dev/xvdd; do
    [ -e "$device" ] || continue
    mount "$device" /mnt/xs-tools >/dev/null 2>&1 && break
  done
  mountpoint -q /mnt/xs-tools && break
  sleep 1
done
mountpoint -q /mnt/xs-tools || { echo "guest 未识别 xs-tools 光驱介质" >&2; exit 7; }
installer="$(find /mnt/xs-tools -maxdepth 3 -type f \\( -name install.sh -o -name xe-guest-utilities*.rpm \\) | head -1)"
[ -n "$installer" ] || { echo "xs-tools ISO 中未找到 Linux 安装器" >&2; exit 7; }
case "$installer" in
  *.rpm)
    rpm -Uvh --replacepkgs "$installer"
    ;;
  *)
    sh "$installer" -n || printf 'y\\n' | sh "$installer"
    ;;
esac
sync
umount /mnt/xs-tools >/dev/null 2>&1 || true
if command -v systemctl >/dev/null 2>&1; then
  systemctl restart xe-linux-distribution >/dev/null 2>&1 || true
  systemctl restart xe-daemon >/dev/null 2>&1 || true
fi
rpm -qa | grep -Eiq 'xe-guest|xe-linux|xenserver.*tool|guest.*util' || pgrep -f 'xe-daemon|xe-linux' >/dev/null || { echo "xs-tools 安装后未检测到工具包或守护进程" >&2; exit 8; }
`;
}

async function rebootXenGuestAndWait(
  taskId: string,
  item: VmProvisionPlanItem,
  jumpHost: XenConnectionInput,
  gateway?: string,
): Promise<void> {
  await runGuestCommand(
    item,
    "nohup sh -c 'sleep 2; /sbin/reboot' >/dev/null 2>&1 &",
    30_000,
    jumpHost,
  );
  const startedAt = Date.now();
  const softDeadline = startedAt + 10 * 60 * 1000;
  const deadline = hardWaitDeadline(startedAt);
  let observedOffline = false;
  while (Date.now() < deadline) {
    const sshReady = await canReadGuestSshBanner(item.ip, 22, sshVerifyTimeoutMs, jumpHost);
    if (!sshReady) {
      observedOffline = true;
    } else if (observedOffline) {
      const login = await verifyGuestLogin(item, jumpHost, gateway);
      if (login.ok) return;
    }
    updateProvisionTaskVm(taskId, item.name, {
      status: "running",
      currentStep: "guest-tools",
      message: Date.now() >= softDeadline
        ? "Guest 重启等待时间较长，后台继续核验"
        : observedOffline
          ? "Guest 已重启，等待 SSH 和 Tools 服务"
          : "等待 Guest 进入重启",
    });
    await delay(3_000);
  }
  throw new Error(`${item.name} 安装 XenServer Tools 后重启超时`);
}

async function verifyXenGuestToolsOnHost(
  taskId: string,
  item: VmProvisionPlanItem,
  connection: XenConnectionInput,
  vmId: string,
  maxWaitMs?: number,
): Promise<void> {
  const startedAt = Date.now();
  const configuredDeadline = hardWaitDeadline(startedAt);
  const deadline = maxWaitMs ? Math.min(configuredDeadline, startedAt + maxWaitMs) : configuredDeadline;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    const output = await runHostCommand(connection, buildXenGuestToolsProgressProbeScript(vmId, item.ip));
    if (output.split(/\r?\n/).includes("READY")) return;
    const elapsedMs = Date.now() - startedAt;
    updateProvisionTaskVm(taskId, item.name, {
      status: "running",
      currentStep: "guest-tools",
      progressPercent: Math.min(99, 90 + Math.floor(elapsedMs / 60_000)),
      message: summarizeXenGuestToolsProgress(output, attempt, elapsedMs),
    });
    await delay(guestToolsMetricsProbeIntervalMs);
  }
  throw new Error(maxWaitMs ? "XenServer 未在 45 分钟内回报 Windows Guest Metrics" : "XenServer 未在任务硬时限内回报 Guest Metrics");
}

export function buildXenGuestToolsProgressProbeScript(vmId: string, guestIp: string): string {
  return String.raw`
vm_uuid='${escapeShellValue(vmId)}'
guest_ip='${escapeShellValue(guestIp)}'
clean_one_line() {
  tr '\n' ' ' | sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//'
}
power_state="$(xe vm-param-get uuid="$vm_uuid" param-name=power-state 2>/dev/null | clean_one_line)"
printf 'POWER\t%s\n' "$power_state"
guest_metrics="$(xe vm-param-get uuid="$vm_uuid" param-name=guest-metrics 2>/dev/null | clean_one_line)"
if [ -n "$guest_metrics" ] && [ "$guest_metrics" != "<not in database>" ]; then
  pv_drivers="$(xe vm-guest-metrics-param-get uuid="$guest_metrics" param-name=PV-drivers-detected 2>/dev/null | clean_one_line)"
  printf 'GUEST_METRICS\t%s\tPV=%s\n' "$guest_metrics" "$pv_drivers"
  if [ "$pv_drivers" = "true" ]; then
    printf 'READY\n'
    exit 0
  fi
else
  printf 'GUEST_METRICS\tmissing\n'
fi
guest_memory="$(xe vm-data-source-query uuid="$vm_uuid" data-source=memory_internal_free 2>/dev/null | clean_one_line)"
if printf '%s' "$guest_memory" | grep -Eq '^[0-9]+([.][0-9]+)?$'; then
  printf 'DATA_SOURCE\tmemory_internal_free\n'
  printf 'READY\n'
  exit 0
fi
[ -n "$guest_memory" ] && printf 'DATA_SOURCE\t%s\n' "$guest_memory"
cd_state="empty"
for vbd in $(xe vbd-list vm-uuid="$vm_uuid" type=CD --minimal 2>/dev/null | tr ',' ' '); do
  empty="$(xe vbd-param-get uuid="$vbd" param-name=empty 2>/dev/null | clean_one_line)"
  if [ "$empty" = "false" ]; then
    vdi="$(xe vbd-param-get uuid="$vbd" param-name=vdi-uuid 2>/dev/null | clean_one_line)"
    label="$(xe vdi-param-get uuid="$vdi" param-name=name-label 2>/dev/null | clean_one_line)"
    cd_state="$label"
    break
  fi
done
printf 'CD\t%s\n' "$cd_state"
if [ -n "$guest_ip" ]; then
  if ping -c 1 -W 2 "$guest_ip" >/dev/null 2>&1; then
    printf 'PING\tok\n'
  else
    printf 'PING\tfail\n'
  fi
  if command -v nc >/dev/null 2>&1; then
    nc -z -w 2 "$guest_ip" 5985 >/dev/null 2>&1 && printf 'WINRM\tok\n' || printf 'WINRM\tfail\n'
  elif command -v timeout >/dev/null 2>&1; then
    timeout 2 bash -c "cat < /dev/null > /dev/tcp/$guest_ip/5985" >/dev/null 2>&1 && printf 'WINRM\tok\n' || printf 'WINRM\tfail\n'
  else
    printf 'WINRM\tunknown\n'
  fi
fi
`;
}

function summarizeXenGuestToolsProgress(output: string, attempt: number, elapsedMs: number): string {
  const state = parseProbeState(output);
  const details: string[] = [];
  if (state.POWER && state.POWER !== "running") details.push(`VM ${state.POWER}`);
  details.push(state.PING === "ok" ? "系统网络可达" : state.PING === "fail" ? "等待系统网络" : "等待系统响应");
  if (state.WINRM === "ok") details.push("WinRM 已响应");
  else if (state.WINRM === "fail") details.push("WinRM 未响应");
  if (state.CD && state.CD !== "empty") details.push(`${state.CD} 已挂载`);
  else details.push("等待 Tools 光盘");
  if (state.GUEST_METRICS?.startsWith("missing")) details.push("Guest 指标未回报");
  else if (state.GUEST_METRICS) details.push("Guest Metrics 已创建");
  const prefix = elapsedMs >= guestToolsMetricsSoftWaitMs ? "监控工具耗时较长，继续核验" : "监控工具安装核验中";
  return `${prefix}：${details.join("，")}（${attempt}）`;
}

function parseProbeState(output: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const [key, ...rest] = line.split("\t");
    if (!key || !rest.length) continue;
    result[key] = rest.join(" ");
  }
  return result;
}

export function buildXenGuestMetricsProbeScript(vmId: string): string {
  return String.raw`
vm_uuid='${escapeShellValue(vmId)}'
# XenServer 7.x exposes the VM_guest_metrics reference through guest-metrics.
guest_metrics="$(xe vm-param-get uuid="$vm_uuid" param-name=guest-metrics 2>/dev/null | tr -d '\r\n')"
if [ -n "$guest_metrics" ] && [ "$guest_metrics" != "<not in database>" ]; then
  pv_drivers="$(xe vm-guest-metrics-param-get uuid="$guest_metrics" param-name=PV-drivers-detected 2>/dev/null | tr -d '\r\n')"
  if [ "$pv_drivers" = "true" ]; then
    printf 'READY\n'
    exit 0
  fi
fi
# XenServer 6.5 may omit the guest-metrics reference. A current numeric
# memory_internal_free value is the minimum Guest-specific evidence we accept;
# the VM-level last-updated timestamp alone can be stale and is not sufficient.
guest_memory="$(xe vm-data-source-query uuid="$vm_uuid" data-source=memory_internal_free 2>/dev/null | tr -d '\r\n')"
if printf '%s' "$guest_memory" | grep -Eq '^[0-9]+([.][0-9]+)?$'; then
  printf 'READY\n'
fi
`;
}

async function verifyXenGuestToolsServiceInGuest(item: VmProvisionPlanItem, jumpHost: XenConnectionInput): Promise<void> {
  await runGuestCommand(
    item,
    `rpm -qa | grep -Eiq 'xe-guest|xe-linux|xenserver.*tool|guest.*util' && pgrep -f 'xe-daemon|xe-linux' >/dev/null`,
    30_000,
    jumpHost,
  );
}

async function isXenGuestToolsServiceReadyInGuest(item: VmProvisionPlanItem, jumpHost: XenConnectionInput): Promise<boolean> {
  try {
    await verifyXenGuestToolsServiceInGuest(item, jumpHost);
    return true;
  } catch {
    return false;
  }
}

async function runGuestCommand(item: VmProvisionPlanItem, command: string, timeoutMs: number, jumpHost?: XenConnectionInput): Promise<string> {
  const transport = await openGuestTransport(item.ip, 22, jumpHost);
  return new Promise((resolve, reject) => {
    const client = new Client();
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => finish(new Error(`guest command timed out after ${timeoutMs}ms`)), timeoutMs);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.end();
      transport.close();
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
                finish(new Error(stderr || `guest command exited: ${code}`));
                return;
              }
              finish();
            })
            .on("data", (chunk: Buffer) => {
              stdout += chunk.toString("utf8");
            })
            .stderr.on("data", (chunk: Buffer) => {
              stderr += chunk.toString("utf8");
            });
        });
      })
      .on("error", finish)
      .connect({
        host: item.ip,
        port: 22,
        sock: transport.sock,
        username: item.loginUsername || "root",
        password: item.rootPassword || "",
        readyTimeout: sshVerifyTimeoutMs,
        algorithms: buildGuestSshAlgorithms(),
      });
  });
}

/**
 * Builds the SSH algorithm policy shared by login verification and Guest command execution.
 * Modern algorithms are preferred while legacy entries keep CentOS 7-era guests compatible.
 *
 * @return a fresh ssh2 algorithm configuration safe to pass to each client connection
 */
export function buildGuestSshAlgorithms(): Algorithms {
  return {
    kex: [
      "curve25519-sha256",
      "curve25519-sha256@libssh.org",
      "ecdh-sha2-nistp256",
      "ecdh-sha2-nistp384",
      "ecdh-sha2-nistp521",
      "diffie-hellman-group14-sha256",
      "diffie-hellman-group14-sha1",
      "diffie-hellman-group1-sha1",
      "diffie-hellman-group-exchange-sha1",
    ],
    serverHostKey: ["rsa-sha2-512", "rsa-sha2-256", "ssh-ed25519", "ecdsa-sha2-nistp256", "ssh-rsa", "ssh-dss"],
  };
}

function runHostCommand(connection: XenConnectionInput, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let stdout = "";
    let stderr = "";
    client
      .on("ready", () => {
        client.exec(command, (error, stream) => {
          if (error) {
            client.end();
            reject(error);
            return;
          }
          stream
            .on("close", (code: number) => {
              client.end();
              if (code !== 0) {
                reject(new Error(stderr || `XenServer 收尾命令退出：${code}`));
                return;
              }
              resolve(stdout);
            })
            .on("data", (chunk: Buffer) => {
              stdout += chunk.toString("utf8");
            })
            .stderr.on("data", (chunk: Buffer) => {
              stderr += chunk.toString("utf8");
            });
        });
      })
      .on("error", reject)
      .connect({
        host: connection.host,
        port: connection.port,
        username: connection.username,
        password: connection.password,
        readyTimeout: 15000,
        algorithms: {
          kex: ["diffie-hellman-group14-sha1", "diffie-hellman-group1-sha1", "diffie-hellman-group-exchange-sha1"],
          serverHostKey: ["ssh-rsa", "ssh-dss"],
        },
      });
  });
}

function canReadSshBanner(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("data", (chunk) => finish(chunk.toString("utf8").startsWith("SSH-")));
    socket.once("end", () => finish(false));
    socket.once("close", () => finish(false));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

async function canReadGuestSshBanner(host: string, port: number, timeoutMs: number, jumpHost?: XenConnectionInput): Promise<boolean> {
  if (!jumpHost) return canReadSshBanner(host, port, timeoutMs);
  let transport: GuestTransport;
  try {
    transport = await openGuestTransport(host, port, jumpHost);
  } catch {
    return false;
  }
  if (!transport.sock) {
    transport.close();
    return false;
  }
  return new Promise((resolve) => {
    const socket = transport.sock as Duplex;
    let settled = false;
    const timer = setTimeout(() => finish(false), timeoutMs);
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      transport.close();
      resolve(ok);
    };
    socket.once("data", (chunk) => finish(chunk.toString("utf8").startsWith("SSH-")));
    socket.once("end", () => finish(false));
    socket.once("close", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

export async function canReadWinRmHttpResponse(host: string, port: number, timeoutMs: number, jumpHost?: XenConnectionInput): Promise<boolean> {
  let transport: GuestTransport;
  try {
    transport = await Promise.race([
      jumpHost ? openGuestTransport(host, port, jumpHost) : openDirectGuestTransport(host, port),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("port probe timeout")), timeoutMs)),
    ]);
  } catch {
    return false;
  }
  if (!transport.sock) {
    transport.close();
    return false;
  }
  return new Promise((resolve) => {
    const socket = transport.sock as Duplex;
    let settled = false;
    const timer = setTimeout(() => finish(false), timeoutMs);
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      transport.close();
      resolve(ok);
    };
    socket.once("data", (chunk) => finish(isWinRmHttpResponse(chunk.toString("utf8"))));
    socket.once("end", () => finish(false));
    socket.once("close", () => finish(false));
    socket.once("error", () => finish(false));
    socket.write(`OPTIONS /wsman HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  });
}

/**
 * Verifies Windows ICMP reachability from the target XenServer host.
 *
 * The guest and XenServer management network may differ from the API host network, so the
 * authoritative ping probe must run on the host that owns the VM.
 *
 * @param host Guest IPv4 address. Must not be empty.
 * @param timeoutMs Maximum wait in milliseconds; rounded up to whole seconds for XenServer ping.
 * @param jumpHost XenServer SSH connection used only to run the bounded read-only probe.
 * @return `true` when the XenServer host receives an ICMP Echo reply; otherwise `false`.
 */
export async function canPingGuestFromXenHost(host: string, timeoutMs: number, jumpHost: XenConnectionInput): Promise<boolean> {
  try {
    await runHostCommand(jumpHost, buildXenGuestPingProbeCommand(host, timeoutMs));
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks whether the target XenServer can resolve the Windows guest through ARP.
 *
 * ARP is used only as an intermediate state signal: it proves the configured guest IP is active
 * on the local network, but it never replaces the final ICMP and WinRM checks.
 *
 * @param host Guest IPv4 address. Must not be empty.
 * @param jumpHost XenServer SSH connection used to run the bounded read-only probe.
 * @return `true` when the host receives an ARP reply; otherwise `false`.
 */
export async function canResolveGuestArpFromXenHost(host: string, jumpHost: XenConnectionInput): Promise<boolean> {
  try {
    await runHostCommand(jumpHost, buildXenGuestArpProbeCommand(host));
    return true;
  } catch {
    return false;
  }
}

/**
 * Builds a bounded ARP probe using the route-selected XenServer interface.
 *
 * @param host Guest IPv4 address. Shell quoting prevents the address from becoming command syntax.
 * @return Shell command that succeeds only when the local XenServer network receives an ARP reply.
 */
export function buildXenGuestArpProbeCommand(host: string): string {
  const escapedHost = escapeShellArg(host);
  return `iface=$(ip route get ${escapedHost} 2>/dev/null | sed -n 's/.* dev \\([^ ]*\\).*/\\1/p' | head -1); [ -n "$iface" ] && arping -c 1 -w 2 -I "$iface" ${escapedHost} >/dev/null 2>&1`;
}

/**
 * Builds the bounded XenServer-side ICMP readiness probe.
 *
 * @param host Guest IPv4 address. Shell quoting prevents the address from becoming command syntax.
 * @param timeoutMs Maximum wait in milliseconds; values below one second use one second.
 * @return Shell command that succeeds only after one ICMP Echo reply.
 */
export function buildXenGuestPingProbeCommand(host: string, timeoutMs: number): string {
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  return `ping -c 1 -W ${timeoutSeconds} ${escapeShellArg(host)} >/dev/null 2>&1`;
}

function openGuestTransport(host: string, port: number, jumpHost?: XenConnectionInput): Promise<GuestTransport> {
  if (!jumpHost) return openDirectGuestTransport(host, port);
  return openDirectGuestTransport(host, port).catch(() => openJumpGuestTransport(host, port, jumpHost));
}

export function isWinRmHttpResponse(value: string): boolean {
  return /^HTTP\/1\.[01]\s+\d{3}\b/.test(value);
}

function isProvisionTaskTerminal(taskId: string): boolean {
  const status = getProvisionTask(taskId)?.status;
  return status === "success" || status === "warning" || status === "failed";
}

function openDirectGuestTransport(host: string, port: number): Promise<GuestTransport> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(sshVerifyTimeoutMs);
    socket.once("connect", () => {
      if (settled) return;
      settled = true;
      socket.setTimeout(0);
      resolve({
        sock: socket,
        close: () => socket.destroy(),
      });
    });
    socket.once("timeout", () => fail(new Error(`${host}:${port} 直连超时`)));
    socket.once("error", fail);
    socket.connect(port, host);
  });
}

function openJumpGuestTransport(host: string, port: number, jumpHost: XenConnectionInput): Promise<GuestTransport> {
  return new Promise((resolve, reject) => {
    const jumpClient = new Client();
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      jumpClient.end();
      reject(error);
    };
    jumpClient
      .on("ready", () => {
        jumpClient.forwardOut("127.0.0.1", 0, host, port, (error, stream) => {
          if (error) {
            fail(error);
            return;
          }
          settled = true;
          resolve({
            sock: stream,
            close: () => jumpClient.end(),
          });
        });
      })
      .on("error", fail)
      .connect({
        host: jumpHost.host,
        port: jumpHost.port,
        username: jumpHost.username,
        password: jumpHost.password,
        readyTimeout: sshVerifyTimeoutMs,
        algorithms: {
          kex: ["diffie-hellman-group14-sha1", "diffie-hellman-group1-sha1", "diffie-hellman-group-exchange-sha1"],
          serverHostKey: ["ssh-rsa", "ssh-dss"],
        },
      });
  });
}

function escapeShellValue(value: string): string {
  return value.replace(/'/g, "'\\''");
}

function escapeShellArg(value: string): string {
  return `'${escapeShellValue(value)}'`;
}

function isWindowsUnattended(request: VmProvisionRequest): boolean {
  return request.installStrategy === "windows-unattended";
}

function windowsComputerName(item: VmProvisionPlanItem): string {
  const suffix = item.ip.split(".").pop()?.replace(/\D/g, "") || "VM";
  const normalized = item.name.replace(/[^A-Za-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 10);
  return `${normalized || "VRC"}-${suffix}`.slice(0, 15);
}

function windowsCmdArg(value: string): string {
  return value.replace(/[^0-9A-Za-z.:-]/g, "");
}

function guestToolsMessage(providerType: ProviderType): string {
  return `正在安装并验证 ${resolveGuestMonitoringPolicy(providerType).label}`;
}

function guestToolsSuccessMessage(providerType: ProviderType): string {
  return `${resolveGuestMonitoringPolicy(providerType).label} 已安装并通过平台验证`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
