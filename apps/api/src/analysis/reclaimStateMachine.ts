import type { VmSummary } from "../types.js";

type ReclaimState = "POWERED_OFF" | "NO_TELEMETRY" | "LOW_ACTIVITY_HIGH_VALUE" | "LOW_ACTIVITY" | "ACTIVE";

interface ReclaimAssessment {
  reclaimLevel: VmSummary["reclaimLevel"];
  reclaimReason: string;
}

interface ReclaimTransition {
  state: ReclaimState;
  guard: (vm: VmSummary) => boolean;
  assessment: (vm: VmSummary) => ReclaimAssessment;
}

const LOW_CPU_THRESHOLD = 0.01;
const LOW_IO_THRESHOLD_BYTES_PER_SECOND = 1024;
const HIGH_VALUE_MEMORY_GIB = 16;
const HIGH_VALUE_DISK_GIB = 300;

const transitions: ReclaimTransition[] = [
  {
    state: "POWERED_OFF",
    guard: (vm) => vm.powerState === "halted",
    assessment: () => ({ reclaimLevel: "P0", reclaimReason: "当前关机，优先进入人工确认回收池" }),
  },
  {
    state: "NO_TELEMETRY",
    guard: (vm) => !hasTelemetry(vm),
    assessment: () => ({ reclaimLevel: "P3", reclaimReason: "缺少实时指标，上报不足，需人工确认" }),
  },
  {
    state: "LOW_ACTIVITY_HIGH_VALUE",
    guard: (vm) => isLowActivity(vm) && isHighValue(vm),
    assessment: () => ({ reclaimLevel: "P1", reclaimReason: "当前 CPU 与 IO 都很低，且资源占用较高，建议进入连续采样观察" }),
  },
  {
    state: "LOW_ACTIVITY",
    guard: (vm) => isLowActivity(vm),
    assessment: () => ({ reclaimLevel: "P2", reclaimReason: "当前 CPU 与 IO 都很低，建议进入连续采样观察" }),
  },
  {
    state: "ACTIVE",
    guard: () => true,
    assessment: () => ({ reclaimLevel: "KEEP", reclaimReason: "当前存在资源活动，暂不建议回收" }),
  },
];

export function assessVmReclaim(vm: VmSummary): ReclaimAssessment {
  const transition = transitions.find((item) => item.guard(vm));
  if (!transition) {
    return { reclaimLevel: "P3", reclaimReason: "状态机未命中，需人工确认" };
  }
  return transition.assessment(vm);
}

function hasTelemetry(vm: VmSummary): boolean {
  return vm.cpuUsage !== null || vm.diskReadRate !== null || vm.diskWriteRate !== null || vm.networkRxRate !== null || vm.networkTxRate !== null;
}

function isLowActivity(vm: VmSummary): boolean {
  const cpu = vm.cpuUsage ?? 0;
  const io = (vm.diskReadRate ?? 0) + (vm.diskWriteRate ?? 0) + (vm.networkRxRate ?? 0) + (vm.networkTxRate ?? 0);
  return cpu < LOW_CPU_THRESHOLD && io < LOW_IO_THRESHOLD_BYTES_PER_SECOND;
}

function isHighValue(vm: VmSummary): boolean {
  return vm.memoryGiB >= HIGH_VALUE_MEMORY_GIB || vm.diskTotalGiB >= HIGH_VALUE_DISK_GIB;
}
