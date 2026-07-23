import {
  applyGuestStorageResize,
  buildGuestAuthenticationInventory,
  buildGuestOfflineInventory,
  buildGuestExecutionUnavailableInventory,
  inspectGuestStorage,
  isGuestAuthenticationError,
  isGuestAgentUnavailableError,
  linkGuestStorageToPlatformDisks,
  preflightGuestStorageResize,
  type GuestStorageAccess,
} from "./guestStorage.js";
import type { VirtualizationProvider } from "./providers/provider.js";
import { vmSystemCredentialStore } from "./vmSystemCredentialStore.js";
import type {
  GuestStorageInventory,
  VmDisk,
  VmNode,
  VmResizeExecutionRequest,
  VmResizeRequest,
  VmResizeResult,
  VmSystemCredentials,
  XenConnectionInput,
} from "./types.js";

interface VmResizeServiceInput {
  provider: VirtualizationProvider<XenConnectionInput>;
  connection: XenConnectionInput;
  vmId: string;
  connectionId?: string;
  vmHint?: VmNode;
  platformDisks?: VmDisk[];
  systemCredentials?: VmSystemCredentials;
  rememberSystemCredentials?: boolean;
}

interface ExecuteVmResizeInput extends VmResizeServiceInput {
  request: VmResizeRequest;
}

export class VmResizeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VmResizeValidationError";
  }
}

export async function inspectVmResizeStorage(input: VmResizeServiceInput): Promise<GuestStorageInventory> {
  const storedCredentials = !input.systemCredentials && input.connectionId
    ? vmSystemCredentialStore.get(input.connectionId, input.vmId)
    : undefined;
  const effectiveInput = {
    ...input,
    systemCredentials: input.systemCredentials ?? storedCredentials,
  };
  const context = await resolveStorageContext(effectiveInput);
  if (context.vm.powerState !== "running") {
    return buildGuestOfflineInventory(context.access.vmIp);
  }
  try {
    const inventory = await inspectGuestStorage(context.access);
    const linkedInventory = linkGuestStorageToPlatformDisks(inventory, context.platformDisks, input.provider.type);
    if (input.systemCredentials && input.rememberSystemCredentials && input.connectionId) {
      vmSystemCredentialStore.save(input.connectionId, input.vmId, input.systemCredentials);
    }
    return linkedInventory;
  } catch (error) {
    if (isGuestAuthenticationError(error)) {
      if (storedCredentials && input.connectionId) vmSystemCredentialStore.delete(input.connectionId, input.vmId);
      return buildGuestAuthenticationInventory(context.access.vmIp);
    }
    if (isGuestAgentUnavailableError(error) && !input.systemCredentials && !storedCredentials) {
      return buildGuestExecutionUnavailableInventory(
        context.access.vmIp,
        error instanceof Error ? `${error.message} 请开启 guest-exec，或提供虚拟机系统账号和密码改用 SSH；仅能通过 JumpServer 访问时请同时填写跳板连接。` : undefined,
      );
    }
    return buildGuestExecutionUnavailableInventory(
      context.access.vmIp,
      error instanceof Error ? `${error.message} 请检查直连或 JumpServer 路由后重试。` : undefined,
    );
  }
}

export async function executeVmResize(input: ExecuteVmResizeInput): Promise<VmResizeResult> {
  const { provider, connection, vmId, request } = input;
  if (!provider.resizeVm) throw new Error("当前平台暂未启用虚拟机扩容。");
  if (request.disk && !request.storageTarget) throw new VmResizeValidationError("磁盘扩容必须选择最终生效目录。");
  if (!request.disk && request.storageTarget) throw new VmResizeValidationError("生效目录必须与磁盘扩容同时提交。");

  let storageContext: Awaited<ReturnType<typeof resolveStorageContext>> | undefined;
  let storagePreflight: Awaited<ReturnType<typeof preflightGuestStorageResize>> | undefined;
  if (request.disk && request.storageTarget) {
    storageContext = await resolveStorageContext(input);
  }

  // 扩容入口统一要求 VM 已运行，避免绕过前端后对关机 VM 执行不完整的硬件或目录扩容。
  const currentVm = storageContext?.vm ?? await findVm(provider, connection, vmId);
  if (currentVm.powerState !== "running") {
    throw new VmResizeValidationError("虚拟机已关机，请先开机后再扩容；系统目录扩容需要读取操作系统当前挂载状态。");
  }
  if (storageContext && request.disk && request.storageTarget) {
    storagePreflight = await preflightGuestStorageResize(
      storageContext.access,
      request.disk,
      request.storageTarget,
      storageContext.platformDisks,
    );
  }

  const executionRequest: VmResizeExecutionRequest = {
    cpuCount: request.cpuCount,
    memoryBytes: request.memoryBytes,
    disk: request.disk,
    allowShutdown: request.allowShutdown,
    restartAfterResize: request.restartAfterResize,
    allowNoop: Boolean(request.disk && request.storageTarget),
  };
  const result = await provider.resizeVm(connection, vmId, executionRequest);
  if (request.disk && request.storageTarget && storageContext && storagePreflight) {
    result.storage = await applyGuestStorageResize({
      access: storageContext.access,
      disk: request.disk,
      target: request.storageTarget,
      restartAfterResize: request.restartAfterResize,
      preflight: storagePreflight,
    });
    result.message = result.storage.status === "completed"
      ? `${result.message}；${result.storage.message}`
      : result.storage.message;
  }
  return result;
}

async function resolveStorageContext(input: VmResizeServiceInput): Promise<{
  vm: VmNode;
  access: GuestStorageAccess;
  platformDisks: VmDisk[];
}> {
  const [vm, platformDisks] = await Promise.all([
    input.vmHint ? Promise.resolve(input.vmHint) : findVm(input.provider, input.connection, input.vmId),
    input.platformDisks ? Promise.resolve(input.platformDisks) : input.provider.listVmDisks(input.connection, input.vmId),
  ]);
  const vmIp = vm.ipAddresses.find(isIpv4);
  if (!vmIp) throw new Error("未读取到虚拟机 IPv4，无法识别系统磁盘与目录。");
  const systemCredentials = input.systemCredentials ?? (input.connectionId
    ? vmSystemCredentialStore.get(input.connectionId, input.vmId)
    : undefined);
  return {
    vm,
    platformDisks,
    access: {
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
    },
  };
}

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
