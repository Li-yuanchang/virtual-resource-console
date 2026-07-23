import type { VirtualizationProvider } from "./providers/provider.js";
import type {
  ProvisionTask,
  ProvisionTaskVm,
  VmProvisionCreatedVm,
  VmProvisionRequest,
  XenConnectionInput,
} from "./types.js";

export interface ProvisionRecoveryContext {
  request: VmProvisionRequest;
  created?: VmProvisionCreatedVm[];
}

/**
 * Signals that a task's persisted VM UUID no longer exists on the platform.
 * Recovery must stop in this case instead of attaching the old task to a new VM
 * that happens to reuse the same name or IP address.
 */
export class ProvisionRecoveryVmMissingError extends Error {
  constructor(taskId: string, vmName: string, providerId: string) {
    super(`任务 ${taskId} 记录的 VM 已不存在：${vmName} (${providerId})`);
    this.name = "ProvisionRecoveryVmMissingError";
  }
}

/**
 * Resolves existing VMs for an interrupted task without issuing a create operation.
 * Saved UUIDs take precedence; exact-name lookup is limited to the crash window before
 * the returned UUID reached the local task store.
 *
 * @param input persisted task, execution context, provider and local connection
 * @return one existing platform VM for every requested plan item
 */
export async function resolveProvisionRecoveryVms(input: {
  task: ProvisionTask;
  context: ProvisionRecoveryContext;
  provider: VirtualizationProvider<XenConnectionInput>;
  connection: XenConnectionInput;
  onRecoveredVm?: (vmName: string, patch: Partial<ProvisionTaskVm>) => void;
}): Promise<VmProvisionCreatedVm[]> {
  const created: VmProvisionCreatedVm[] = [];
  let inventoryPromise: ReturnType<typeof input.provider.listVms> | undefined;
  const loadInventory = () => {
    inventoryPromise ??= input.provider.listVms(input.connection, {
      hostId: input.context.request.hostId,
      page: 1,
      pageSize: 1000,
    });
    return inventoryPromise;
  };
  for (const item of input.context.request.planItems) {
    const savedCreated = input.context.created?.find((vm) => vm.name === item.name);
    const taskVm = input.task.vms.find((vm) => vm.name === item.name);
    const providerId = savedCreated?.providerId || savedCreated?.id || taskVm?.providerId || taskVm?.id;
    if (providerId) {
      const page = await loadInventory();
      const matched = page.items.find((vm) => vm.providerId === providerId);
      if (!matched) {
        throw new ProvisionRecoveryVmMissingError(input.task.id, item.name, providerId);
      }
      created.push({
        id: savedCreated?.id || providerId,
        providerId,
        name: item.name,
        powerState: matched.powerState,
        ip: item.ip,
        macAddress: savedCreated?.macAddress,
        generatedIsoRegistryId: savedCreated?.generatedIsoRegistryId,
      });
      continue;
    }
    const page = await loadInventory();
    const matches = page.items.filter((vm) => vm.name === item.name);
    if (matches.length !== 1) {
      throw new Error(
        matches.length
          ? `任务 ${input.task.id} 无法按名称唯一确认 VM：${item.name}`
          : `任务 ${input.task.id} 尚未找到已创建 VM：${item.name}`,
      );
    }
    const matched = matches[0];
    input.onRecoveredVm?.(item.name, {
      id: matched.providerId,
      providerId: matched.providerId,
      powerState: matched.powerState,
      status: "running",
      message: "服务恢复后已按完整名称确认现有 VM",
    });
    created.push({
      id: matched.providerId,
      providerId: matched.providerId,
      name: item.name,
      powerState: matched.powerState,
      ip: item.ip,
    });
  }
  return created;
}
