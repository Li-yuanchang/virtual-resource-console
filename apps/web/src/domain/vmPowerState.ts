import type { VmNode, VmPowerAction } from "../types";

/** Builds the immediate table-row patch after a VM power action succeeds. */
export function vmPowerActionRowPatch(action: VmPowerAction, operatedAt: string): Partial<VmNode> {
  if (action === "shutdown") {
    return {
      powerState: "halted",
      lastShutdownAt: operatedAt,
    };
  }
  if (action === "start" || action === "forceReboot") {
    return {
      powerState: "running",
      lastShutdownAt: null,
    };
  }
  return {};
}
