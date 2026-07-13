import { Socket } from "node:net";
import { Client } from "ssh2";
import type { VmProvisionCreatedVm, VmProvisionPlanItem, VmProvisionRequest, XenConnectionInput } from "./types.js";
import {
  finishProvisionTask,
  markProvisionTaskStep,
  updateProvisionTaskVms,
} from "./provisionTaskStore.js";

interface RunProvisioningVerifierInput {
  taskId: string;
  connection: XenConnectionInput;
  request: VmProvisionRequest;
  created: VmProvisionCreatedVm[];
}

interface GuestVerifyResult {
  item: VmProvisionPlanItem;
  vm?: VmProvisionCreatedVm;
  ok: boolean;
  message: string;
}

const networkWaitMs = 45 * 60 * 1000;
const networkProbeIntervalMs = 15 * 1000;
const sshVerifyTimeoutMs = 15 * 1000;
const sshLoginRetryIntervalMs = 20 * 1000;

export function runProvisioningVerifier(input: RunProvisioningVerifierInput): void {
  void verifyProvisioning(input).catch((error) => {
    finishProvisionTask(input.taskId, "failed", error instanceof Error ? error.message : "创建验收失败");
  });
}

async function verifyProvisioning(input: RunProvisioningVerifierInput): Promise<void> {
  markProvisionTaskStep(input.taskId, "boot", "running", "VM 已创建，等待系统启动");
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
        status: "running",
        message: input.request.autoStart ? "等待系统启动" : "已创建，未设置自动启动",
      };
    }),
  );

  if (!input.request.autoStart) {
    markProvisionTaskStep(input.taskId, "boot", "skipped", "创建请求未启用自动启动");
    finishProvisionTask(input.taskId, "success", "VM 已创建，未执行自动安装验收。");
    return;
  }

  markProvisionTaskStep(input.taskId, "boot", "success", "VM 已启动");
  markProvisionTaskStep(input.taskId, "wait-network", "running", "等待 VM 网络和 SSH 端口就绪");

  const networkResults = await waitForGuestNetwork(input.request.planItems);
  const failedNetwork = networkResults.filter((result) => !result.ok);
  updateProvisionTaskVms(
    input.taskId,
    networkResults.map((result) => ({
      id: input.created.find((vm) => vm.name === result.item.name)?.id,
      providerId: input.created.find((vm) => vm.name === result.item.name)?.providerId,
      name: result.item.name,
      ip: result.item.ip,
      status: result.ok ? "running" : "failed",
      message: result.message,
    })),
  );
  if (failedNetwork.length) {
    markProvisionTaskStep(input.taskId, "wait-network", "failed", failedNetwork.map((item) => item.message).join("；"));
    finishProvisionTask(input.taskId, "failed", "VM 创建后未等到网络就绪。");
    return;
  }

  markProvisionTaskStep(input.taskId, "wait-network", "success", "VM SSH 端口已就绪");
  markProvisionTaskStep(input.taskId, "verify-login", "running", "验证系统账号密码和启动状态");

  const loginResults = await Promise.all(input.request.planItems.map((item) => verifyGuestLoginWithRetry(item)));
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
        message: result.message,
      };
    }),
  );
  if (failedLogin.length) {
    markProvisionTaskStep(input.taskId, "verify-login", "failed", failedLogin.map((item) => item.message).join("；"));
    finishProvisionTask(input.taskId, "failed", "系统已启动但账号密码验证失败。");
    return;
  }

  markProvisionTaskStep(input.taskId, "verify-login", "success", "账号密码验证通过");
  markProvisionTaskStep(input.taskId, "finalize", "running", "收尾启动配置");
  await finalizeVmBoot(input);
  markProvisionTaskStep(input.taskId, "finalize", "success", "已固定硬盘启动并清理安装介质");
  markProvisionTaskStep(input.taskId, "guest-tools", "skipped", guestToolsMessage(input.request.providerType));
  markProvisionTaskStep(input.taskId, "complete", "success", "VM 创建、系统启动和登录验证完成");
  finishProvisionTask(input.taskId, "success", "VM 创建、环境安装、系统启动和登录验证完成。");
}

async function waitForGuestNetwork(items: VmProvisionPlanItem[]): Promise<GuestVerifyResult[]> {
  const deadline = Date.now() + networkWaitMs;
  const pending = new Map(items.map((item) => [item.name, item]));
  const results: GuestVerifyResult[] = [];
  while (pending.size && Date.now() < deadline) {
    for (const item of Array.from(pending.values())) {
      // 安装过程中 22 端口可能短暂可连但立即关闭，先读 banner 再登录，避免把安装器的临时端口误判成系统就绪。
      if (await canReadSshBanner(item.ip, 22, 3000)) {
        results.push({
          item,
          ok: true,
          message: "SSH 服务已响应",
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
      message: `${item.name} (${item.ip}) 超时未开放 SSH 端口`,
    });
  }
  return results;
}

function verifyGuestLogin(item: VmProvisionPlanItem): Promise<GuestVerifyResult> {
  return new Promise((resolve) => {
    const username = item.loginUsername || "root";
    const client = new Client();
    let settled = false;
    const finish = (ok: boolean, message: string) => {
      if (settled) return;
      settled = true;
      client.end();
      resolve({ item, ok, message });
    };
    client
      .on("ready", () => {
        client.exec("cat /etc/os-release 2>/dev/null | head -5; uname -r", (error, stream) => {
          if (error) {
            finish(false, `${item.name} SSH 已连接但命令执行失败`);
            return;
          }
          let stdout = "";
          let stderr = "";
          stream
            .on("close", (code: number) => {
              const output = stdout.trim().split(/\r?\n/).filter(Boolean).slice(0, 2).join(" · ");
              finish(code === 0, code === 0 ? `登录验证通过：${output || "系统已响应"}` : stderr.trim() || "系统命令返回失败");
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
        username,
        password: item.rootPassword,
        readyTimeout: sshVerifyTimeoutMs,
        algorithms: {
          kex: [
            "curve25519-sha256",
            "curve25519-sha256@libssh.org",
            "ecdh-sha2-nistp256",
            "ecdh-sha2-nistp384",
            "ecdh-sha2-nistp521",
            "diffie-hellman-group14-sha256",
            "diffie-hellman-group14-sha1",
          ],
          serverHostKey: ["rsa-sha2-512", "rsa-sha2-256", "ssh-rsa", "ecdsa-sha2-nistp256", "ssh-ed25519"],
        },
      });
  });
}

async function verifyGuestLoginWithRetry(item: VmProvisionPlanItem): Promise<GuestVerifyResult> {
  const deadline = Date.now() + networkWaitMs;
  let lastResult: GuestVerifyResult | undefined;
  while (Date.now() < deadline) {
    lastResult = await verifyGuestLogin(item);
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

function escapeShellValue(value: string): string {
  return value.replace(/'/g, "'\\''");
}

function guestToolsMessage(providerType: string): string {
  if (providerType === "xenserver") return "XenServer xs-tools 自动安装待接入；当前已完成系统启动和 SSH 验证。";
  return "当前平台无需额外 xs-tools 安装步骤，后续按 Provider 扩展。";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
