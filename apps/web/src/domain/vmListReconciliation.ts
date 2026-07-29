import type { VmNode, VmsResponse } from "../types";

export type VmRowActionState = {
  status: "pending" | "running" | "success" | "error";
};

export interface VmListReconciler {
  currentRevision(): number;
  reset(): void;
  markMutation(vm: Pick<VmNode, "providerId" | "id">): void;
  markDeleted(vm: Pick<VmNode, "providerId" | "id">): void;
  clearDeleteTombstone(vm: Pick<VmNode, "providerId" | "id">): void;
  reconcile(
    result: VmsResponse,
    currentItems: VmNode[],
    actionStates: Record<string, VmRowActionState>,
    requestRevision: number,
    background: boolean,
  ): VmsResponse;
}

export function createVmListReconciler(options: { tombstoneTtlMs?: number; now?: () => number } = {}): VmListReconciler {
  const tombstoneTtlMs = options.tombstoneTtlMs ?? 5 * 60 * 1000;
  const now = options.now ?? Date.now;
  const rowRevisions = new Map<string, number>();
  const deleteTombstones = new Map<string, number>();
  let revision = 0;

  function identityKeys(vm: Pick<VmNode, "providerId" | "id">) {
    return Array.from(new Set([vm.providerId, vm.id].filter(Boolean)));
  }

  function markMutation(vm: Pick<VmNode, "providerId" | "id">) {
    revision += 1;
    for (const key of identityKeys(vm)) rowRevisions.set(key, revision);
  }

  function hasActiveDeleteTombstone(vm: Pick<VmNode, "providerId" | "id">) {
    let active = false;
    for (const key of identityKeys(vm)) {
      const expiresAt = deleteTombstones.get(key);
      if (expiresAt == null) continue;
      if (expiresAt <= now()) deleteTombstones.delete(key);
      else active = true;
    }
    return active;
  }

  function rowRevision(vm: Pick<VmNode, "providerId" | "id">) {
    return Math.max(0, ...identityKeys(vm).map((key) => rowRevisions.get(key) ?? 0));
  }

  function actionStateProtectsRow(state: VmRowActionState | undefined) {
    return state?.status === "pending" || state?.status === "running" || state?.status === "success";
  }

  return {
    currentRevision: () => revision,
    reset() {
      revision = 0;
      rowRevisions.clear();
      deleteTombstones.clear();
    },
    markMutation,
    markDeleted(vm) {
      markMutation(vm);
      const expiresAt = now() + tombstoneTtlMs;
      for (const key of identityKeys(vm)) deleteTombstones.set(key, expiresAt);
    },
    clearDeleteTombstone(vm) {
      for (const key of identityKeys(vm)) deleteTombstones.delete(key);
    },
    reconcile(result, currentItems, actionStates, requestRevision, background) {
      const currentByKey = new Map<string, VmNode>();
      for (const vm of currentItems) {
        for (const key of identityKeys(vm)) currentByKey.set(key, vm);
      }

      const nextItems: VmNode[] = [];
      const includedKeys = new Set<string>();
      for (const remoteVm of result.items) {
        // A stale platform snapshot must not resurrect a VM after a confirmed local/SSE deletion.
        if (hasActiveDeleteTombstone(remoteVm)) continue;
        const currentVm = identityKeys(remoteVm).map((key) => currentByKey.get(key)).find(Boolean);
        const actionState = currentVm ? actionStates[currentVm.providerId || currentVm.id] : undefined;
        const changedAfterRequest = !!currentVm && rowRevision(currentVm) > requestRevision;
        const keepCurrent = !!currentVm && (changedAfterRequest || actionStateProtectsRow(actionState));
        const nextVm = keepCurrent ? currentVm : remoteVm;
        nextItems.push(nextVm);
        for (const key of identityKeys(nextVm)) includedKeys.add(key);
      }

      for (const currentVm of currentItems) {
        if (identityKeys(currentVm).some((key) => includedKeys.has(key))) continue;
        if (hasActiveDeleteTombstone(currentVm)) continue;
        const actionState = actionStates[currentVm.providerId || currentVm.id];
        const changedAfterRequest = rowRevision(currentVm) > requestRevision;
        if (background || changedAfterRequest || actionStateProtectsRow(actionState)) {
          nextItems.push(currentVm);
          for (const key of identityKeys(currentVm)) includedKeys.add(key);
        }
      }

      return {
        ...result,
        items: nextItems,
        total: Math.max(result.total + nextItems.length - result.items.length, nextItems.length, 0),
      };
    },
  };
}
