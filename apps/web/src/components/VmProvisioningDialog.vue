<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import type { ITheme } from "@xterm/xterm";
import { ArrowDown, ArrowUp, Close, Loading, WarningFilled } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import ConsoleDialog from "./ConsoleDialog.vue";
import VrcOverflowTooltip from "./VrcOverflowTooltip.vue";
import type {
  HostNode,
  IpLease,
  IpLeasesResponse,
  EnvironmentProvisioningTemplate,
  IpPoolPolicy,
  IpPoolPolicyResponse,
  NetworkInterface,
  IpPoolConfig,
  IpProbeResponse,
  IpProbeResult,
  ProvisioningNetworkProbeResult,
  IsoImage,
  IsoImagesResponse,
  ProviderType,
  ProvisionTask,
  ProvisionTaskStep,
  ProvisionTaskVm,
  ProvisioningConfig,
  ProvisioningConfigResponse,
  ProvisioningSpecTemplate,
  RuntimePolicy,
  RuntimePolicyResponse,
  StorageRepository,
  VmNode,
  VmCreateRequest,
} from "../types";
import type { VmConsoleTarget } from "../domain/consoleStrategies";
import { validateProvisioningIpPool } from "../domain/ipPoolValidation";
import { getProviderBrand } from "../domain/providerBrand";
import { groupIsoImagesBySource, isoSourceLabel, resolveProvisioningStrategy } from "../domain/provisioningStrategies";
import { secureJsonRequest } from "../domain/secureRequest";

interface StorageTotals {
  usedGiB: number;
  physicalGiB: number;
  usagePercent: number;
}

interface ActivityPayload {
  title: string;
  detail?: string;
  target?: string;
  status: "info" | "pending" | "success" | "warning" | "error";
}

interface VmDraftOverride {
  name?: string;
  ip?: string;
  cpu?: number;
  memoryGiB?: number;
  diskGiB?: number;
  rootPassword?: string;
  loginUsername?: string;
}

interface ProvisioningProgressState {
  title: string;
  message: string;
  status: "running" | "success" | "warning" | "error";
}

interface ProvisioningProgressStep {
  key: string;
  name: string;
  status: ProvisionTaskStep["status"];
  message?: string;
}

interface ProvisionConsoleTargetItem {
  key: string;
  name: string;
  ip?: string;
  status: ProvisionTaskVm["status"];
  message?: string;
  progressPercent?: number;
  currentStep?: ProvisionTaskVm["currentStep"];
  installPackageDone?: number;
  installPackageTotal?: number;
  target: VmConsoleTarget | null;
}

const IP_CANDIDATE_PREVIEW_LIMIT = 48;
const VRC_TOAST_DURATION_MS = 3000;
const SUPPORTED_WINDOWS_ISO_PATTERN = /windows_server_2008_r2|windows_server_2012_r2/i;

function defaultRuntimePolicy(): RuntimePolicy {
  return {
    managedIpPattern: "",
    ipInference: {
      enabled: true,
      shortIpBasePrefix: "",
      shortIpThirdOctets: [],
      shortIpPrefixes: [],
      hostOnlyPrefix: "",
    },
    provisioning: {
      rootPasswordTemplate: "",
    },
    xenserver: {
      networkDeviceRules: [],
    },
  };
}

function defaultIpPoolPolicy(): IpPoolPolicy {
  return {
    defaultDns: ["1.1.1.1"],
    ipPools: [],
  };
}

const props = defineProps<{
  visible: boolean;
  connection: {
    id: string;
    providerType: ProviderType;
    host: string;
    port: number;
    username: string;
    password?: string;
  };
  host: HostNode | null;
  networks: NetworkInterface[];
  vms: VmNode[];
  reservedIps: string[];
  storageTotals: StorageTotals;
  submitting: boolean;
  progress: ProvisioningProgressState | null;
  provisionTask: ProvisionTask | null;
  consoleAvailable?: boolean;
  consoleTarget?: VmConsoleTarget | null;
  provisionConsoleTargets?: ProvisionConsoleTargetItem[];
  terminalFontFamily?: string;
  terminalFontSize?: number;
  terminalLineHeight?: number;
  terminalCursorStyle?: "block" | "underline" | "bar";
  terminalCursorBlink?: boolean;
  terminalTheme?: ITheme;
  displayScaleMode?: "local" | "remote";
  displayQuality?: "auto" | "high" | "smooth";
  throttleResize?: boolean;
  watermarkEnabled?: boolean;
  watermarkDensity?: "sparse" | "standard" | "dense";
  watermarkOpacity?: number;
  watermarkText?: string;
}>();

const emit = defineEmits<{
  "update:visible": [value: boolean];
  activity: [payload: ActivityPayload];
  "open-iso-detail": [];
  "select-console-target": [value: ProvisionConsoleTargetItem];
  submit: [payload: VmCreateRequest];
}>();

const visibleModel = computed({
  get: () => props.visible,
  set: (value: boolean) => emit("update:visible", value),
});

const provisioningConfig = ref<ProvisioningConfig>({ environmentTemplates: [], specTemplates: [], ipPools: [] });
const runtimePolicy = ref<RuntimePolicy>(defaultRuntimePolicy());
const ipPoolPolicy = ref<IpPoolPolicy>(defaultIpPoolPolicy());
const isoImages = ref<IsoImage[]>([]);
const toolsIsoImage = ref<IsoImage | null>(null);
const loadingProvisioningConfig = ref(false);
const loadingIsoImages = ref(false);
const loadingIpLeases = ref(false);
const initializingProvisioningDialog = ref(false);
const probingIps = ref(false);
const ipCandidateFilter = ref<"available" | "all">("available");
const ipCandidateFilterOptions = [
  { label: "可用", value: "available" },
  { label: "全部", value: "all" },
];
const ipLeases = ref<IpLease[]>([]);
const ipProbeResults = ref<Record<string, IpProbeResult>>({});
const provisioningNetworkProbe = ref<ProvisioningNetworkProbeResult | null>(null);
let ipProbeTimer: ReturnType<typeof setTimeout> | undefined;
let dialogSessionId = 0;
const provisioningStrategy = computed(() => resolveProvisioningStrategy(props.connection.providerType));
const currentScopeKey = computed(() => provisioningStrategy.value.scopeKey(props.connection, props.host));
const environmentTemplateOptions = computed(() =>
  provisioningConfig.value.environmentTemplates.filter((item) => !item.providerType || item.providerType === props.connection.providerType),
);
const selectedEnvironmentTemplate = computed(
  () => environmentTemplateOptions.value.find((item) => item.id === provisioningForm.environmentTemplateId) ?? null,
);
const strategyIpPools = computed(() => provisioningStrategy.value.defaultIpPools(props.connection, props.host, ipPoolPolicy.value));
const provisioningPoolOptions = computed(() => {
  const pools = new Map<string, IpPoolConfig>();
  for (const pool of strategyIpPools.value) pools.set(pool.id, pool);
  return Array.from(pools.values());
});
const provisioningForm = reactive({
  environmentTemplateId: "",
  installProfile: "server" as "server" | "desktop",
  sourceType: "iso" as ProvisioningSourceType,
  isoId: "",
  templateName: "",
  specId: "",
  vmNamePrefix: "vm",
  count: 1,
  cpu: 4,
  memoryGiB: 8,
  systemDiskGiB: 100,
  dataDiskGiB: 0,
  ipPoolId: "",
  poolName: "",
  cidr: "",
  gateway: "",
  dnsText: "",
  startIp: "",
  endIp: "",
  reservedIpsText: "",
  networkName: "",
  vlan: "",
  preferredIp: "",
  rootPassword: "",
  loginUsername: "",
  autoStart: true,
});

const selectedProvisioningSpec = computed(() => provisioningConfig.value.specTemplates.find((item) => item.id === provisioningForm.specId) ?? null);
const selectedProvisioningPool = computed(() => provisioningPoolOptions.value.find((item) => item.id === provisioningForm.ipPoolId) ?? null);
const selectedIsoImage = computed(() => isoImages.value.find((item) => item.id === provisioningForm.isoId) ?? isoImages.value[0] ?? null);
const installProfileOptions = computed(() => {
  const image = selectedIsoImage.value;
  if (!image) return [{ label: "CLI", value: "server" as const }];
  const availableProfiles = isSupportedWindowsIso(image)
    ? (["server", "desktop"] as const)
    : (image.installProfileHint?.available ?? ["server"]);
  return availableProfiles.map((profile) => ({
    label: profile === "desktop" ? "Desktop" : "CLI",
    value: profile,
  }));
});
const effectiveInstallStrategy = computed(() => {
  if (selectedEnvironmentTemplate.value?.installStrategy) return selectedEnvironmentTemplate.value.installStrategy;
  if (props.connection.providerType === "xenserver" && provisioningForm.sourceType === "iso" && isSupportedWindowsIso(selectedIsoImage.value)) {
    return "windows-unattended";
  }
  return "manual-iso";
});
const templateIsoMismatchMessage = computed(() => {
  const template = selectedEnvironmentTemplate.value;
  const image = selectedIsoImage.value;
  if (provisioningForm.sourceType !== "iso" || !template?.isoNamePattern || !image) return "";
  const expected = template.isoNamePattern.toLowerCase();
  const actual = `${image.name} ${image.id}`.toLowerCase();
  return actual.includes(expected) ? "" : `系统环境与镜像不匹配：${template.name} 需要 ${template.isoNamePattern}`;
});
const isoOptionGroups = computed(() => groupIsoImagesBySource(isoImages.value));
const selectedToolsIsoImage = computed(() => toolsIsoImage.value);
const provisioningAccountPolicy = computed(() =>
  provisioningStrategy.value.accountPolicy({
    isoName: selectedIsoImage.value?.name ?? "",
    toolsIsoName: selectedToolsIsoImage.value?.name,
  }),
);
const provisioningOccupiedIps = computed(() => {
  const ips = new Set<string>();
  for (const ip of props.reservedIps) {
    if (isIpv4(ip)) ips.add(ip);
  }
  for (const vm of props.vms) {
    for (const ip of vm.ipAddresses) {
      if (isIpv4(ip)) ips.add(ip);
    }
  }
  return ips;
});
const provisioningLeasedIps = computed(() => new Set(ipLeases.value.filter((item) => item.status === "reserved").map((item) => item.ip)));
const rawProvisioningAvailableIps = computed(() => {
  const pool = currentProvisioningPoolDraft();
  const reserved = new Set(pool.reservedIps.filter(isIpv4));
  return enumerateIpRange(pool.startIp, pool.endIp).filter(
    (ip) => !reserved.has(ip) && !provisioningOccupiedIps.value.has(ip) && !provisioningLeasedIps.value.has(ip),
  );
});
const provisioningAvailableIps = computed(() => {
  return rawProvisioningAvailableIps.value.filter((ip) => ipProbeResults.value[ip]?.status === "available");
});
const allIpCandidates = computed(() => enumerateIpRange(currentProvisioningPoolDraft().startIp, currentProvisioningPoolDraft().endIp));
const visibleIpCandidates = computed(() => {
  const source = ipCandidateFilter.value === "available" ? provisioningAvailableIps.value : allIpCandidates.value;
  return source.slice(0, IP_CANDIDATE_PREVIEW_LIMIT);
});
const provisioningPoolError = computed(() =>
  validateProvisioningIpPool(currentProvisioningPoolDraft()),
);
const provisioningNetworkError = computed(() =>
  provisioningNetworkProbe.value?.status === "unreachable" ? provisioningNetworkProbe.value.message : "",
);
const provisioningCandidateError = computed(() => provisioningPoolError.value || provisioningNetworkError.value);
const ipCandidateEmptyText = computed(() =>
  ipCandidateFilter.value === "available" ? "暂无可用 IP，可切换全部查看占用情况。" : "当前 IP 池没有可展示的候选地址。",
);
const isSingleDraftMode = computed(() => (provisioningPlan.value?.items.length ?? Math.max(Math.floor(provisioningForm.count), 1)) <= 1);
const preferredIpProbeResult = computed(() => (isIpv4(provisioningForm.preferredIp) ? ipProbeResults.value[provisioningForm.preferredIp] : undefined));
const effectiveProvisioningSpec = computed<ProvisioningSpecTemplate>(() => {
  const fallback = selectedProvisioningSpec.value ?? provisioningConfig.value.specTemplates[0];
  return {
    id: fallback?.id ?? "custom",
    name: fallback?.name ?? "自定义规格",
    cpu: Math.max(Math.floor(Number(provisioningForm.cpu) || 0), 1),
    memoryGiB: Math.max(Number(provisioningForm.memoryGiB) || 0, 1),
    systemDiskGiB: Math.max(Number(provisioningForm.systemDiskGiB) || 0, 1),
    dataDiskGiB: 0,
    description: fallback?.description,
  };
});
const storageFreeGiB = computed(() => Math.max(props.storageTotals.physicalGiB - props.storageTotals.usedGiB, 0));
const runningVcpuForCreate = computed(() =>
  props.vms.filter((vm) => vm.powerState === "running").reduce((sum, vm) => sum + vm.cpuCount, 0),
);
const provisioningPlan = computed(() => buildProvisioningPlan());
const provisioningWarnings = computed(() => provisioningPlan.value?.warnings ?? []);
const blockingProvisioningWarnings = computed(() => provisioningWarnings.value.filter((warning) => warning.severity === "blocking"));
const advisoryProvisioningWarnings = computed(() => provisioningWarnings.value.filter((warning) => warning.severity === "advisory"));
const blockingWarningSummary = computed(() => summarizeProvisioningWarnings(blockingProvisioningWarnings.value));
const cpuResourceCheckText = computed(
  () => `${props.host ? `${formatNumber(props.host.cpuCores)} 个物理核心` : "-"} · 运行 ${formatNumber(runningVcpuForCreate.value)} vCPU · 本次 ${provisioningPlan.value?.items.reduce((sum, item) => sum + item.cpu, 0) ?? 0} vCPU`,
);
const memoryResourceCheckText = computed(
  () => `${props.host ? formatBytes(props.host.memoryFreeBytes ?? 0) : "-"} · 本次 ${formatNumber(provisioningPlan.value?.items.reduce((sum, item) => sum + item.memoryGiB, 0) ?? 0)} GiB`,
);
const storageResourceCheckText = computed(
  () => `${formatNumber(storageFreeGiB.value)} GiB · 本次 ${formatNumber(provisioningPlan.value?.items.reduce((sum, item) => sum + item.systemDiskGiB + item.dataDiskGiB, 0) ?? 0)} GiB`,
);
const provisioningStatusText = computed(() => {
  if (canSubmit.value) return "可提交创建";
  if (provisioningPoolError.value) return "IP 池配置异常";
  if (provisioningNetworkError.value) return "创建网络异常";
  return blockingWarningSummary.value || "待完成校验";
});
const provisioningStatusTooltip = computed(() => {
  const messages = blockingProvisioningWarnings.value.map((warning) => warning.message);
  return messages.length ? messages.join("；") : provisioningStatusText.value;
});
const canSubmit = computed(
  () =>
    !!provisioningPlan.value &&
    !probingIps.value &&
    blockingProvisioningWarnings.value.length === 0,
);
const activeProgressSteps = computed<ProvisioningProgressStep[]>(() => {
  const task = props.provisionTask;
  if (!task) {
    return [{
      key: "submit",
      name: props.progress?.title ?? "提交任务",
      status: props.progress?.status === "error"
        ? "failed"
        : props.progress?.status === "warning"
          ? "warning"
          : props.progress?.status === "success"
            ? "success"
            : "running",
      message: props.progress?.message,
    }];
  }
  const submitStep: ProvisioningProgressStep = {
    key: "submit",
    name: "提交任务",
    status: "success",
    message: "创建任务已提交",
  };
  return [submitStep, ...task.steps.map((step) => ({
    key: step.key,
    name: step.name,
    status: step.status,
    message: step.message,
  }))];
});
const activeProgressPercent = computed(() => {
  const explicitPercent = Number((props.provisionTask as (ProvisionTask & { progressPercent?: number }) | null)?.progressPercent);
  if (Number.isFinite(explicitPercent)) return Math.min(100, Math.max(0, Math.round(explicitPercent)));
  const steps = activeProgressSteps.value;
  if (!steps.length) return 0;
  const finished = steps.filter((step) => step.status === "success" || step.status === "warning" || step.status === "skipped").length;
  const runningBonus = steps.some((step) => step.status === "running") ? 0.45 : 0;
  return Math.min(100, Math.round(((finished + runningBonus) / steps.length) * 100));
});
const activeProgressVisible = computed(() => props.submitting || !!props.progress || !!props.provisionTask);
const provisioningFormLocked = computed(() => activeProgressVisible.value);
const activeProgressMessage = computed(() => props.progress?.message || props.provisionTask?.message || "等待任务状态");
const isProvisionTaskMode = computed(() => !!props.provisionTask);
const isProvisionTaskTerminal = computed(() => ["success", "warning", "failed"].includes(props.provisionTask?.status ?? ""));
const terminalNoticeDismissed = ref(false);
const showTerminalNotice = computed(
  () => isProvisionTaskTerminal.value && props.provisionTask?.status !== "success" && !terminalNoticeDismissed.value,
);
const provisionPlanAsideText = computed(() => {
  if (isProvisionTaskMode.value) return activeProgressMessage.value;
  if (!canSubmit.value) return `阻断项 ${blockingProvisioningWarnings.value.length} 个`;
  return "控制台窗口只在用户打开后出现";
});
const targetHostSummary = computed(() => {
  if (!props.host) return "未选择目标物理机";
  return `${props.host.name} · ${props.host.address || props.connection.host} · ${providerLabel(props.connection.providerType)}`;
});
const passwordManuallyEdited = ref(false);
const advisoryWarningsAcknowledged = ref(false);
const vmDraftOverrides = reactive<Record<number, VmDraftOverride>>({});
const activeDraftIndex = ref(0);
const expandedProvisionSections = ref<Array<"network">>([]);
const activeProvisioningPlanItem = computed(() => provisioningPlan.value?.items[activeDraftIndex.value] ?? null);
const activeIpCandidateText = computed(() => {
  const count = provisioningPlan.value?.items.length ?? Math.max(Math.floor(provisioningForm.count), 1);
  const ip = activeProvisioningPlanItem.value?.ip || provisioningForm.preferredIp;
  if (count > 1) return `当前第 ${activeDraftIndex.value + 1} 台${ip ? ` ${ip}` : " 待分配"}`;
  return ip ? `当前 ${ip}` : loadingIpLeases.value ? "读取 IP 池文件中" : `本地预留 ${provisioningLeasedIps.value.size} 个`;
});

watch(
  () => props.visible,
  (visible) => {
    if (visible) {
      const sessionId = ++dialogSessionId;
      void openDialog(sessionId);
    } else {
      dialogSessionId += 1;
      if (ipProbeTimer) clearTimeout(ipProbeTimer);
      initializingProvisioningDialog.value = false;
      resetProvisioningSession();
    }
  },
  { immediate: true },
);

watch(
  () => [props.provisionTask?.id ?? "", props.provisionTask?.status ?? ""] as const,
  ([taskId, status], [previousTaskId, previousStatus]) => {
    if (taskId !== previousTaskId || status !== previousStatus) terminalNoticeDismissed.value = false;
  },
);

watch(
  () => currentScopeKey.value,
  () => {
    isoImages.value = [];
    toolsIsoImage.value = null;
    if (props.visible) {
      void loadIsoImages();
    }
  },
);

watch(
  () => props.host?.providerId,
  () => {
    if (props.visible) {
      initializeProvisioningForm();
      scheduleIpProbe();
    }
  },
);

watch(
  () => provisioningForm.sourceType,
  (sourceType) => {
    if (props.visible && sourceType === "iso" && !provisioningForm.isoId) {
      provisioningForm.isoId = selectedIsoImage.value?.id ?? "";
    }
  },
);

watch(
  () => isoImages.value.map((item) => item.id).join("|"),
  () => {
    if (props.visible && provisioningForm.sourceType === "iso") {
      const current = isoImages.value.find((item) => item.id === provisioningForm.isoId);
      if (!current) provisioningForm.isoId = provisioningStrategy.value.defaultIsoId(isoImages.value);
    }
  },
);

watch(
  () => provisioningWarnings.value.map((warning) => warning.message).join("|"),
  () => {
    advisoryWarningsAcknowledged.value = false;
  },
);

watch(
  () => provisioningForm.preferredIp,
  () => {
    syncRootPasswordDefault();
  },
);

watch(
  () => Math.max(Math.floor(provisioningForm.count), 1),
  (count) => {
    activeDraftIndex.value = clampDraftIndex(activeDraftIndex.value, count);
  },
);

watch(
  () =>
    [
      provisioningForm.reservedIpsText,
      Array.from(provisioningOccupiedIps.value).sort().join("|"),
      Array.from(provisioningLeasedIps.value).sort().join("|"),
    ].join("::"),
  () => {
    if (props.visible) scheduleIpProbe();
  },
);

watch(
  () => [
    provisioningForm.ipPoolId,
    provisioningForm.cidr,
    provisioningForm.gateway,
    provisioningForm.startIp,
    provisioningForm.endIp,
  ].join("::"),
  () => {
    provisioningNetworkProbe.value = null;
    ipProbeResults.value = {};
    if (props.visible) scheduleIpProbe();
  },
);

function resetProvisioningSession() {
  if (ipProbeTimer) {
    clearTimeout(ipProbeTimer);
    ipProbeTimer = undefined;
  }
  probingIps.value = false;
  loadingProvisioningConfig.value = false;
  loadingIsoImages.value = false;
  loadingIpLeases.value = false;
  passwordManuallyEdited.value = false;
  advisoryWarningsAcknowledged.value = false;
  activeDraftIndex.value = 0;
  expandedProvisionSections.value = [];
  ipProbeResults.value = {};
  provisioningNetworkProbe.value = null;
  ipCandidateFilter.value = "available";
  isoImages.value = [];
  toolsIsoImage.value = null;
  ipLeases.value = [];
  for (const key of Object.keys(vmDraftOverrides)) {
    delete vmDraftOverrides[Number(key)];
  }
  Object.assign(provisioningForm, {
    sourceType: defaultSourceType(),
    environmentTemplateId: "",
    installProfile: "server",
    isoId: "",
    templateName: "",
    specId: "",
    vmNamePrefix: "vm",
    count: 1,
    cpu: 4,
    memoryGiB: 8,
    systemDiskGiB: 100,
    dataDiskGiB: 0,
    ipPoolId: "",
    poolName: "",
    cidr: "",
    gateway: "",
    dnsText: "",
    startIp: "",
    endIp: "",
    reservedIpsText: "",
    networkName: "",
    vlan: "",
    preferredIp: "",
    rootPassword: "",
    loginUsername: "",
    autoStart: true,
  });
}

function isActiveDialogSession(sessionId: number) {
  return props.visible && sessionId === dialogSessionId;
}

function isProvisionSectionExpanded(section: "network") {
  return expandedProvisionSections.value.includes(section);
}

function toggleProvisionSection(section: "network") {
  expandedProvisionSections.value = isProvisionSectionExpanded(section)
    ? expandedProvisionSections.value.filter((item) => item !== section)
    : [...expandedProvisionSections.value, section];
}

function handleProvisionPanelDoubleClick(event: MouseEvent) {
  const target = event.target;
  if (target instanceof Element && target.closest("button")) return;
  toggleProvisionSection("network");
}

async function openDialog(sessionId: number) {
  resetProvisioningSession();
  initializingProvisioningDialog.value = true;
  await Promise.all([loadRuntimePolicy(sessionId), loadIpPoolPolicy(sessionId), loadProvisioningConfig(sessionId), loadIsoImages(sessionId), loadIpLeases(sessionId)]);
  if (!isActiveDialogSession(sessionId)) return;
  initializeProvisioningForm();
  initializingProvisioningDialog.value = false;
  scheduleIpProbe(0);
}

async function loadRuntimePolicy(sessionId = dialogSessionId) {
  try {
    const result = await postJson<RuntimePolicyResponse>("/api/runtime-policy", undefined, "GET");
    if (!isActiveDialogSession(sessionId)) return;
    runtimePolicy.value = result.policy;
  } catch {
    if (!isActiveDialogSession(sessionId)) return;
    runtimePolicy.value = defaultRuntimePolicy();
  }
}

async function loadIpPoolPolicy(sessionId = dialogSessionId) {
  try {
    const result = await postJson<IpPoolPolicyResponse>("/api/ip-pools/policy", undefined, "GET");
    if (!isActiveDialogSession(sessionId)) return;
    ipPoolPolicy.value = result.policy;
  } catch (error) {
    if (!isActiveDialogSession(sessionId)) return;
    ipPoolPolicy.value = defaultIpPoolPolicy();
    showMessage(error instanceof Error ? error.message : "读取 IP 池文件失败", "error");
  }
}

function handleIpPoolPolicyUpdated(event: Event) {
  const policy = (event as CustomEvent<IpPoolPolicy>).detail;
  if (!policy?.ipPools?.length) return;
  ipPoolPolicy.value = policy;
  if (!props.visible) return;
  selectProvisioningPool(provisioningForm.ipPoolId, { scheduleProbe: true });
}

onMounted(() => {
  window.addEventListener("vrc:ip-pool-policy-updated", handleIpPoolPolicyUpdated);
});

onBeforeUnmount(() => {
  window.removeEventListener("vrc:ip-pool-policy-updated", handleIpPoolPolicyUpdated);
});

async function loadProvisioningConfig(sessionId = dialogSessionId) {
  loadingProvisioningConfig.value = true;
  try {
    const result = await postJson<ProvisioningConfigResponse>("/api/provisioning/config", undefined, "GET");
    if (!isActiveDialogSession(sessionId)) return;
    provisioningConfig.value = result.config;
  } catch (error) {
    if (!isActiveDialogSession(sessionId)) return;
    showMessage(error instanceof Error ? error.message : "读取创建预设失败", "error");
  } finally {
    if (isActiveDialogSession(sessionId)) loadingProvisioningConfig.value = false;
  }
}

async function loadIsoImages(sessionId = dialogSessionId, options: { forceRefresh?: boolean } = {}) {
  const payload = buildConnectionPayload();
  if (!payload || !props.host || !isActiveDialogSession(sessionId)) return;
  if (loadingIsoImages.value) return;
  const hostName = props.host.name;
  const hostId = props.host.providerId;

  loadingIsoImages.value = true;
  emit("activity", {
    title: "读取系统镜像",
    target: hostName,
    detail: `${providerLabel(props.connection.providerType)} · ISO 清单`,
    status: "pending",
  });
  try {
    const result = await postJson<IsoImagesResponse>("/api/inventory/iso-images", {
      ...payload,
      hostId,
      forceRefresh: options.forceRefresh,
    });
    if (!isActiveDialogSession(sessionId)) return;
    toolsIsoImage.value = result.images.find((image) => image.sourceType === "tools") ?? null;
    isoImages.value = provisioningStrategy.value.sortIsoImages(provisioningStrategy.value.installIsoImages(result.images));
    const imageSummary = `${isoImages.value.length} 个系统 ISO${toolsIsoImage.value ? " · Tools 已读取" : ""}`;
    emit("activity", {
      title: result.source === "cache" ? "系统镜像缓存已加载" : "系统镜像读取完成",
      target: hostName,
      detail: result.refreshing ? `${imageSummary} · 后台刷新中` : imageSummary,
      status: "success",
    });
  } catch (error) {
    if (!isActiveDialogSession(sessionId)) return;
    const message = error instanceof Error ? error.message : "读取系统镜像失败";
    showMessage(message, "error");
    emit("activity", {
      title: "读取系统镜像失败",
      target: hostName,
      detail: message,
      status: "error",
    });
  } finally {
    if (isActiveDialogSession(sessionId)) loadingIsoImages.value = false;
  }
}

function handleIsoSelectVisibleChange(open: boolean) {
  if (!open || provisioningForm.sourceType !== "iso") return;
  if (!isoImages.value.length && !loadingIsoImages.value) {
    void loadIsoImages(dialogSessionId, { forceRefresh: true });
  }
}

function isoOptionDescription(image: IsoImage) {
  if (image.sourceType === "host-dvd") {
    const deviceName = typeof image.metadata?.deviceName === "string" ? image.metadata.deviceName.trim() : "";
    return `${deviceName || "物理光驱"} · ${formatBytes(image.sizeBytes ?? 0)}`;
  }
  return `${image.storageRepository || isoSourceLabel(image)} · ${formatBytes(image.sizeBytes ?? 0)}`;
}

async function loadIpLeases(sessionId = dialogSessionId) {
  loadingIpLeases.value = true;
  try {
    const result = await postJson<IpLeasesResponse>("/api/provisioning/ip-leases", undefined, "GET");
    if (!isActiveDialogSession(sessionId)) return;
    ipLeases.value = result.leases;
  } catch (error) {
    if (!isActiveDialogSession(sessionId)) return;
    showMessage(error instanceof Error ? error.message : "读取 IP 池文件失败", "error");
  } finally {
    if (isActiveDialogSession(sessionId)) loadingIpLeases.value = false;
  }
}

function initializeProvisioningForm() {
  if (!environmentTemplateOptions.value.some((item) => item.id === provisioningForm.environmentTemplateId)) {
    provisioningForm.environmentTemplateId = environmentTemplateOptions.value[0]?.id ?? "";
  }
  applyEnvironmentTemplate();
  provisioningForm.sourceType = selectedEnvironmentTemplate.value?.sourceType ?? defaultSourceType();
  const specExists = provisioningConfig.value.specTemplates.some((item) => item.id === provisioningForm.specId);
  if (!provisioningForm.specId || !specExists) {
    provisioningForm.specId = provisioningStrategy.value.defaultSpecId(provisioningConfig.value.specTemplates);
  }
  applyProvisioningSpec();
  if (!selectedProvisioningPool.value || !provisioningForm.startIp) {
    selectProvisioningPool(provisioningForm.ipPoolId || selectedEnvironmentTemplate.value?.ipPoolId);
  }
  applyAccountPolicyDefault();
  if (!provisioningForm.vmNamePrefix || provisioningForm.vmNamePrefix === "vm") {
    provisioningForm.vmNamePrefix = provisioningStrategy.value.defaultVmNamePrefix(props.connection, props.host);
  }
  syncRootPasswordDefault();
}

watch(
  () => provisioningForm.environmentTemplateId,
  () => {
    if (!props.visible) return;
    applyEnvironmentTemplate();
    scheduleIpProbe();
  },
);

watch(
  () => provisioningForm.sourceType,
  (sourceType) => {
    if (!props.visible) return;
    if (sourceType !== "iso") return;
    provisioningForm.isoId = provisioningStrategy.value.defaultIsoId(isoImages.value);
    applyAccountPolicyDefault();
  },
);

watch(
  () => provisioningForm.isoId,
  () => {
    if (!props.visible) return;
    provisioningForm.installProfile = recommendedInstallProfile(selectedIsoImage.value);
    syncEnvironmentTemplateToIso();
    applyAccountPolicyDefault();
    applyVmNamePrefixDefault();
  },
);

watch(
  () => provisioningForm.installProfile,
  () => {
    if (!props.visible) return;
    syncEnvironmentTemplateToIso();
  },
);

function applyProvisioningSpec() {
  const spec = selectedProvisioningSpec.value;
  if (!spec) return;
  provisioningForm.cpu = spec.cpu;
  provisioningForm.memoryGiB = spec.memoryGiB;
  provisioningForm.systemDiskGiB = spec.systemDiskGiB + spec.dataDiskGiB;
  provisioningForm.dataDiskGiB = 0;
}

function applyEnvironmentTemplate() {
  const template = selectedEnvironmentTemplate.value;
  if (!template) return;
  provisioningForm.sourceType = template.sourceType;
  provisioningForm.templateName = template.platformTemplateName ?? "";
  provisioningForm.specId = template.specId || provisioningStrategy.value.defaultSpecId(provisioningConfig.value.specTemplates);
  applyProvisioningSpec();
  selectProvisioningPool(template.ipPoolId);
  provisioningForm.vmNamePrefix = template.vmNamePrefix;
  provisioningForm.autoStart = template.autoStart;
  provisioningForm.installProfile = template.installProfile;
  if (template.sourceType === "iso") {
    provisioningForm.isoId = resolveTemplateIsoId(template);
  }
  applyAccountPolicyDefault(true);
  applyVmNamePrefixDefault();
  syncRootPasswordDefault(true);
}

function syncEnvironmentTemplateToIso() {
  if (provisioningForm.sourceType !== "iso" || !selectedIsoImage.value) return;
  const matchingTemplates = environmentTemplateOptions.value.filter((template) => templateMatchesIso(template, selectedIsoImage.value!));
  if (!matchingTemplates.length) {
    provisioningForm.environmentTemplateId = "";
    return;
  }
  const template = matchingTemplates.find((item) => item.installProfile === provisioningForm.installProfile);
  if (!template) {
    // The selected profile is authoritative. Older config files may not have a matching
    // Desktop template; keep the normalized profile and let the provider strategy infer it.
    provisioningForm.environmentTemplateId = "";
    return;
  }
  if (provisioningForm.environmentTemplateId !== template.id) {
    provisioningForm.environmentTemplateId = template.id;
  }
}

function templateMatchesIso(template: EnvironmentProvisioningTemplate, image: IsoImage) {
  if (template.sourceType !== "iso" || !template.isoNamePattern) return false;
  return `${image.name} ${image.id}`.toLowerCase().includes(template.isoNamePattern.toLowerCase());
}

function isSupportedWindowsIso(image: IsoImage | null | undefined): boolean {
  if (!image) return false;
  return SUPPORTED_WINDOWS_ISO_PATTERN.test(`${image.name} ${image.id}`);
}

function recommendedInstallProfile(image: IsoImage | null | undefined): "server" | "desktop" {
  if (isSupportedWindowsIso(image)) return "desktop";
  return image?.installProfileHint?.recommended ?? "server";
}

function applyProvisioningPool() {
  if (provisioningFormLocked.value) return;
  selectProvisioningPool(provisioningForm.ipPoolId, { scheduleProbe: true });
}

function selectProvisioningPool(preferredPoolId?: string, options: { scheduleProbe?: boolean } = {}) {
  if (provisioningFormLocked.value) return;
  const pool = findProvisioningPool(preferredPoolId);
  provisioningForm.ipPoolId = pool?.id ?? "";
  if (pool) {
    applyProvisioningPoolDraft(pool);
  } else {
    clearProvisioningPoolDraft();
  }
  if (options.scheduleProbe) scheduleIpProbe();
}

function findProvisioningPool(preferredPoolId?: string) {
  const pools = provisioningPoolOptions.value;
  if (preferredPoolId) {
    const preferredPool = pools.find((item) => item.id === preferredPoolId);
    if (preferredPool) return preferredPool;
  }
  return pools[0] ?? null;
}

function applyProvisioningPoolDraft(pool: IpPoolConfig) {
  provisioningForm.poolName = pool.name;
  provisioningForm.cidr = pool.cidr;
  provisioningForm.gateway = pool.gateway;
  provisioningForm.dnsText = pool.dns.join(", ");
  provisioningForm.startIp = pool.startIp;
  provisioningForm.endIp = pool.endIp;
  provisioningForm.reservedIpsText = pool.reservedIps.join(", ");
  provisioningForm.networkName = pool.networkName ?? "";
  provisioningForm.vlan = pool.vlan ?? "";
  provisioningForm.preferredIp = "";
}

function clearProvisioningPoolDraft() {
  provisioningForm.poolName = "";
  provisioningForm.cidr = "";
  provisioningForm.gateway = "";
  provisioningForm.dnsText = "";
  provisioningForm.startIp = "";
  provisioningForm.endIp = "";
  provisioningForm.reservedIpsText = "";
  provisioningForm.networkName = "";
  provisioningForm.vlan = "";
  provisioningForm.preferredIp = "";
}

function buildProvisioningPlan(): ProvisioningPlanResult | null {
  const spec = effectiveProvisioningSpec.value;
  const pool = currentProvisioningPoolDraft();
  const poolError = provisioningCandidateError.value;
  const source = provisioningSourceLabel();

  const count = Math.max(Math.floor(provisioningForm.count), 1);
  const warnings: ProvisioningWarning[] = [];
  const overrideIps = new Set(
    Array.from({ length: count }, (_, index) => vmDraftOverrides[index]?.ip?.trim() ?? "")
      .filter(isIpv4),
  );
  const overrideIpCount = Array.from({ length: count }, (_, index) => vmDraftOverrides[index]?.ip?.trim() ?? "")
    .filter(isIpv4)
    .length;
  const availableIps = poolError ? [] : provisioningAvailableIps.value.filter((ip) => !overrideIps.has(ip));
  let nextAvailableIpIndex = 0;
  if (poolError) warnings.push(blockingProvisioningWarning(poolError, "IP_POOL_INVALID"));
  if (provisioningNetworkProbe.value?.status === "route-only") {
    warnings.push(advisoryProvisioningWarning(provisioningNetworkProbe.value.message, "NETWORK_ROUTE_ONLY"));
  }
  if (!source) warnings.push(blockingProvisioningWarning(provisioningForm.sourceType === "iso" ? "未读取到可用 ISO，当前仅能先生成 IP 预览。" : "请填写克隆源名称。", "SOURCE_REQUIRED"));
  if (templateIsoMismatchMessage.value) warnings.push(blockingProvisioningWarning(templateIsoMismatchMessage.value, "SOURCE_TEMPLATE_MISMATCH"));
  if (provisioningAccountPolicy.value.requiresUsername && !provisioningForm.loginUsername.trim()) warnings.push(blockingProvisioningWarning("请填写新建登录用户名。", "LOGIN_USERNAME_REQUIRED"));
  if (provisioningForm.preferredIp && preferredIpProbeResult.value?.status !== "available") {
    warnings.push(blockingProvisioningWarning(`分配 IP ${provisioningForm.preferredIp} 未确认可用。`, "PREFERRED_IP_UNAVAILABLE"));
  }
  if (!poolError && probingIps.value) warnings.push(blockingProvisioningWarning("IP ping 探测中，完成后才会生成可提交预案。", "IP_PROBE_RUNNING"));
  const autoAssignedCount = count - overrideIpCount;
  if (!poolError && !probingIps.value && availableIps.length < autoAssignedCount) warnings.push(blockingProvisioningWarning(`IP 池可用 IP 不足：需要 ${count} 个，仍缺 ${autoAssignedCount - availableIps.length} 个。`, "IP_POOL_EXHAUSTED"));
  if (!props.vms.length) {
    warnings.push(advisoryProvisioningWarning("当前 VM 清单未完整加载，IP 占用判断可能不完整。", "VM_INVENTORY_INCOMPLETE"));
  }
  if (provisioningForm.sourceType === "iso" && effectiveInstallStrategy.value === "manual-iso") {
    warnings.push(advisoryProvisioningWarning("手动 ISO 模式只挂载安装介质，系统安装需在控制台内完成。", "MANUAL_ISO_INSTALL"));
  }
  const items = Array.from({ length: count }, (_, index) => {
    const override = vmDraftOverrides[index] ?? {};
    const ip = override.ip?.trim() || availableIps[nextAvailableIpIndex++] || "";
    const cpu = Math.max(Math.floor(Number(override.cpu ?? spec.cpu) || 0), 1);
    const memoryGiB = Math.max(Number(override.memoryGiB ?? spec.memoryGiB) || 0, 1);
    const systemDiskGiB = Math.max(Number(override.diskGiB ?? spec.systemDiskGiB) || 0, 1);
    const rootPassword =
      override.rootPassword?.trim() ||
      (passwordManuallyEdited.value && provisioningForm.rootPassword.trim()
        ? provisioningForm.rootPassword.trim()
        : ip
          ? provisioningStrategy.value.deriveRootPassword(ip, runtimePolicy.value)
          : provisioningForm.rootPassword.trim());
    return {
      name: resolveVmNameForAssignedIp(override.name, ip, index),
      ip,
      rootPassword,
      loginUsername: override.loginUsername?.trim() || resolveLoginUsername(),
      source: source || "待选择 ISO",
      cpu,
      memoryGiB,
      systemDiskGiB,
      dataDiskGiB: 0,
    };
  });
  const assignedIpIndexes = new Map<string, number>();
  for (const [index, item] of items.entries()) {
    const status = item.ip ? ipProbeResults.value[item.ip]?.status : undefined;
    if (!item.ip || status !== "available") warnings.push(blockingProvisioningWarning(`第 ${index + 1} 台 IP 未确认可用。`, "PLAN_IP_UNAVAILABLE"));
    if (item.ip) {
      const previousIndex = assignedIpIndexes.get(item.ip);
      if (previousIndex !== undefined) {
        warnings.push(blockingProvisioningWarning(`第 ${previousIndex + 1} 台和第 ${index + 1} 台使用了相同 IP ${item.ip}。`, "PLAN_IP_DUPLICATED"));
      } else {
        assignedIpIndexes.set(item.ip, index);
      }
    }
  }
  warnings.push(...resourcePlanWarnings(items));
  const readyItems = items.filter((item) => item.ip && ipProbeResults.value[item.ip]?.status === "available");

  return {
    items,
    warnings,
    summary: `${readyItems.length} / ${count} 台 · ${items.reduce((sum, item) => sum + item.cpu, 0)} vCPU · ${formatNumber(items.reduce((sum, item) => sum + item.memoryGiB, 0))} GiB 内存 · ${formatNumber(items.reduce((sum, item) => sum + item.systemDiskGiB + item.dataDiskGiB, 0))} GiB 磁盘`,
  };
}

function provisioningSourceLabel() {
  if (provisioningForm.sourceType === "template") return provisioningForm.templateName.trim();
  return selectedIsoImage.value?.name ?? "";
}

function resolveTemplateIsoId(template: EnvironmentProvisioningTemplate) {
  if (!template.isoNamePattern) return provisioningStrategy.value.defaultIsoId(isoImages.value);
  const pattern = template.isoNamePattern.toLowerCase();
  return (
    isoImages.value.find((image) => image.name.toLowerCase() === pattern)?.id ??
    isoImages.value.find((image) => image.name.toLowerCase().includes(pattern))?.id ??
    provisioningStrategy.value.defaultIsoId(isoImages.value)
  );
}

function installStrategyLabel(template: EnvironmentProvisioningTemplate | null) {
  if (!template) return "未选择";
  if (template.installStrategy === "template-clone") return "克隆安装";
  if (template.installStrategy === "kickstart") return template.installProfile === "desktop" ? "无人值守 · 桌面" : "无人值守";
  if (template.installStrategy === "windows-unattended") return "Windows 无人值守";
  return "手动 ISO";
}

function clampDraftIndex(index: number, count = Math.max(Math.floor(provisioningForm.count), 1)) {
  return Math.min(Math.max(Math.floor(index), 0), Math.max(count - 1, 0));
}

function setActiveDraftIndex(index: number) {
  activeDraftIndex.value = clampDraftIndex(index, provisioningPlan.value?.items.length ?? Math.max(Math.floor(provisioningForm.count), 1));
  provisioningForm.preferredIp = provisioningPlan.value?.items[activeDraftIndex.value]?.ip ?? "";
}

function findPlanIpIndex(ip: string, exceptIndex?: number) {
  return provisioningPlan.value?.items.findIndex((item, index) => item.ip === ip && index !== exceptIndex) ?? -1;
}

function setVmDraftOverride(index: number, field: keyof VmDraftOverride, value: string | number | undefined) {
  if (provisioningFormLocked.value) return;
  if (!vmDraftOverrides[index]) vmDraftOverrides[index] = {};
  if (typeof value === "string") {
    vmDraftOverrides[index][field] = value as never;
  } else if (typeof value === "number" && Number.isFinite(value)) {
    vmDraftOverrides[index][field] = value as never;
  } else {
    delete vmDraftOverrides[index][field];
  }
}

function setVmDraftText(index: number, field: "name" | "ip" | "rootPassword" | "loginUsername", value: string | number) {
  if (provisioningFormLocked.value) return;
  setActiveDraftIndex(index);
  setVmDraftOverride(index, field, String(value));
  if (field === "ip") {
    const name = vmDraftOverrides[index]?.name?.trim();
    if (!name) setVmDraftOverride(index, "name", defaultVmNameForIp(String(value), index));
    provisioningForm.preferredIp = String(value);
  }
}

function setVmDraftNumber(index: number, field: "cpu" | "memoryGiB" | "diskGiB", value: number | undefined) {
  if (provisioningFormLocked.value) return;
  setActiveDraftIndex(index);
  setVmDraftOverride(index, field, value);
}

function resetVmDraftOverride(index: number) {
  delete vmDraftOverrides[index];
}

function progressStepText(status: ProvisionTaskStep["status"]) {
  if (status === "success") return "完成";
  if (status === "running") return "执行中";
  if (status === "warning") return "有告警";
  if (status === "failed") return "失败";
  if (status === "skipped") return "跳过";
  return "等待";
}

function workflowStepClass(status: ProvisionTaskStep["status"]) {
  if (status === "success") return "step-success";
  if (status === "running") return "step-running";
  if (status === "warning") return "step-warning";
  if (status === "failed") return "step-failed";
  if (status === "skipped") return "step-skipped";
  return "step-pending";
}

function workflowStepProgress(step: ProvisioningProgressStep) {
  if (step.status === "success" || step.status === "warning" || step.status === "skipped") return 100;
  if (step.status === "failed") return Math.max(12, activeProgressPercent.value);
  if (step.status !== "running") return 0;
  const taskPercent = Number(props.provisionTask?.progressPercent);
  if (props.provisionTask?.currentStep === step.key && Number.isFinite(taskPercent)) {
    return Math.min(92, Math.max(12, Math.round(taskPercent)));
  }
  return 46;
}

function provisionVmStatusText(status: ProvisionTaskVm["status"]) {
  if (status === "success") return "完成";
  if (status === "running") return "执行中";
  if (status === "warning") return "有告警";
  if (status === "failed") return "失败";
  return "等待";
}

function vmTaskStatusClass(status: ProvisionTaskVm["status"]) {
  if (status === "running") return ["vm-action-state-running", "vm-action-type-shutdown", "is-action-busy"];
  if (status === "success") return ["vm-action-state-success", "vm-action-type-start"];
  if (status === "warning") return ["vm-action-state-warning"];
  if (status === "failed") return ["vm-action-state-error", "vm-action-type-delete"];
  return ["vm-action-state-pending"];
}

function provisionVmProgressText(vm: ProvisionTaskVm) {
  const packageDone = Number(vm.installPackageDone);
  const packageTotal = Number(vm.installPackageTotal);
  if (Number.isFinite(packageDone) && packageDone > 0 && Number.isFinite(packageTotal) && packageTotal > 0) {
    return `安装包 ${packageDone}/${packageTotal} · ${Math.round(vm.progressPercent ?? 0)}%`;
  }
  return vm.message || progressStepText(vm.status === "failed" ? "failed" : vm.status === "warning" ? "warning" : vm.status === "success" ? "success" : vm.status === "running" ? "running" : "pending");
}

function provisionPlanItemStatusText(item: ProvisioningPlanItem) {
  if (!item.ip) return "待分配";
  const status = ipProbeResults.value[item.ip]?.status;
  if (status === "available") return "可提交创建";
  if (status === "reachable") return "IP 有响应";
  if (status === "occupied") return "IP 已占用";
  if (status === "reserved") return "IP 已预留";
  return probingIps.value ? "探测中" : "待探测";
}

function submitProvisioning() {
  if (props.submitting) return;
  const spec = effectiveProvisioningSpec.value;
  const plan = provisioningPlan.value;
  if (!spec || !plan) {
    showMessage("请先完成预览配置。", "error");
    return;
  }
  if (blockingProvisioningWarnings.value.length) {
    showMessage(blockingWarningSummary.value || "存在阻断项，处理后才能创建。", "warning");
    return;
  }
  const acknowledgementWarnings = advisoryProvisioningWarnings.value;
  if (acknowledgementWarnings.length && !advisoryWarningsAcknowledged.value) {
    advisoryWarningsAcknowledged.value = true;
    showMessage(summarizeProvisioningWarnings(acknowledgementWarnings), "info");
    return;
  }
  emit("submit", {
    ...buildVmCreateConnectionPayload(),
    providerType: props.connection.providerType,
    hostId: props.host?.providerId,
    scopeKey: currentScopeKey.value,
    environmentTemplateId: provisioningForm.environmentTemplateId || undefined,
    sourceType: provisioningForm.sourceType,
    installStrategy: effectiveInstallStrategy.value,
    installProfile: provisioningForm.installProfile,
    isoId: provisioningForm.sourceType === "iso" ? provisioningForm.isoId || selectedIsoImage.value?.id || undefined : undefined,
    isoName: provisioningForm.sourceType === "iso" ? selectedIsoImage.value?.name : undefined,
    templateName: provisioningForm.sourceType === "template" ? provisioningForm.templateName.trim() : undefined,
    specId: spec.id,
    vmNamePrefix: provisioningForm.vmNamePrefix.trim(),
    count: Math.max(Math.floor(provisioningForm.count), 1),
    ipPool: currentProvisioningPoolDraft(),
    autoStart: provisioningForm.autoStart,
    planItems: plan.items.map((item) => ({
      name: item.name,
      ip: item.ip,
      loginUsername: item.loginUsername,
      rootPassword: item.rootPassword,
      cpu: item.cpu,
      memoryGiB: item.memoryGiB,
      diskGiB: item.systemDiskGiB + item.dataDiskGiB,
    })),
  });
}

function resourcePlanWarnings(items: ProvisioningPlanItem[]): ProvisioningWarning[] {
  const warnings: ProvisioningWarning[] = [];
  const host = props.host;
  if (!host) return [blockingProvisioningWarning("未选择目标物理机。", "HOST_REQUIRED")];
  const memoryFree = Math.max(host.memoryFreeBytes ?? 0, 0);
  const freeStorageGiB = storageFreeGiB.value;
  const newMemoryBytes = items.reduce((sum, item) => sum + item.memoryGiB, 0) * 1024 ** 3;
  const newDiskGiB = items.reduce((sum, item) => sum + item.systemDiskGiB + item.dataDiskGiB, 0);

  if (memoryFree < newMemoryBytes) warnings.push(blockingProvisioningWarning(`内存余量不足：剩余 ${formatBytes(memoryFree)}，计划新增 ${formatBytes(newMemoryBytes)}。`, "MEMORY_CAPACITY_INSUFFICIENT"));
  if (freeStorageGiB < newDiskGiB) warnings.push(blockingProvisioningWarning(`存储余量不足：剩余 ${formatNumber(freeStorageGiB)} GiB，计划新增 ${formatNumber(newDiskGiB)} GiB。`, "STORAGE_CAPACITY_INSUFFICIENT"));
  return warnings;
}

function blockingProvisioningWarning(message: string, code: string): ProvisioningWarning {
  return { code, message, severity: "blocking" };
}

function advisoryProvisioningWarning(message: string, code: string): ProvisioningWarning {
  return { code, message, severity: "advisory" };
}

function summarizeProvisioningWarnings(warnings: ProvisioningWarning[]) {
  if (!warnings.length) return "";
  const [first] = warnings;
  return warnings.length === 1 ? first.message : `${first.message} 等 ${warnings.length} 项`;
}

function currentProvisioningPoolDraft(): IpPoolConfig {
  return {
    id: provisioningForm.ipPoolId || `draft-${props.host?.providerId || "host"}`,
    name: provisioningForm.poolName.trim() || "默认 IP 池",
    cidr: provisioningForm.cidr.trim(),
    gateway: provisioningForm.gateway.trim(),
    dns: splitIpList(provisioningForm.dnsText),
    startIp: provisioningForm.startIp.trim(),
    endIp: provisioningForm.endIp.trim(),
    reservedIps: splitIpList(provisioningForm.reservedIpsText),
    networkName: provisioningForm.networkName.trim() || undefined,
    vlan: provisioningForm.vlan.trim() || undefined,
  };
}

function applyAccountPolicyDefault(force = false) {
  const policy = provisioningAccountPolicy.value;
  if (!policy.requiresUsername) {
    provisioningForm.loginUsername = policy.defaultUsername;
    return;
  }
  if (force || !provisioningForm.loginUsername || provisioningForm.loginUsername === "root") {
    provisioningForm.loginUsername = policy.defaultUsername;
  }
}

function applyVmNamePrefixDefault(force = false) {
  const nextPrefix = defaultVmNamePrefixForIso();
  const current = provisioningForm.vmNamePrefix.trim();
  const templateManagedPrefix = environmentTemplateOptions.value.some((template) => template.vmNamePrefix === current);
  const managedPrefixPattern = /(?:^|-)(centos7|ubuntu|win2008|win2012)$/i;
  if (force || !current || current === "vm" || templateManagedPrefix || managedPrefixPattern.test(current)) {
    provisioningForm.vmNamePrefix = nextPrefix;
  }
}

function handleRootPasswordInput() {
  passwordManuallyEdited.value = true;
}

function syncRootPasswordDefault(force = false) {
  if (!force && passwordManuallyEdited.value) return;
  const ip = provisioningForm.preferredIp;
  if (!isIpv4(ip)) return;
  provisioningForm.rootPassword = provisioningStrategy.value.deriveRootPassword(ip, runtimePolicy.value);
}

function defaultVmNamePrefixForIso() {
  const base = props.host?.name || props.connection.host || "vm";
  const isoName = selectedIsoImage.value?.name.toLowerCase() ?? "";
  if (isoName.includes("ubuntu")) return `${base}-ubuntu`;
  if (isoName.includes("centos")) return `${base}-centos7`;
  return provisioningStrategy.value.defaultVmNamePrefix(props.connection, props.host);
}

function defaultSourceType(): ProvisioningSourceType {
  return "iso";
}

function resolveLoginUsername() {
  const policy = provisioningAccountPolicy.value;
  return policy.requiresUsername ? provisioningForm.loginUsername.trim() : policy.defaultUsername;
}

function scheduleIpProbe(delay = 350, sessionId = dialogSessionId) {
  if (!isActiveDialogSession(sessionId) || initializingProvisioningDialog.value) return;
  if (ipProbeTimer) clearTimeout(ipProbeTimer);
  ipProbeTimer = setTimeout(() => {
    ipProbeTimer = undefined;
    void probeProvisioningIps(sessionId, false);
  }, delay);
}

async function probeProvisioningIps(sessionId = dialogSessionId, notifyValidationError = true) {
  if (!isActiveDialogSession(sessionId) || initializingProvisioningDialog.value || probingIps.value || provisioningFormLocked.value) return;
  const poolError = provisioningPoolError.value;
  if (poolError) {
    ipProbeResults.value = {};
    provisioningNetworkProbe.value = null;
    if (notifyValidationError) showMessage(poolError, "error");
    return;
  }
  const ips = Array.from(new Set([...rawProvisioningAvailableIps.value.slice(0, IP_CANDIDATE_PREVIEW_LIMIT), provisioningForm.preferredIp].filter(isIpv4)));
  if (!ips.length) {
    ipProbeResults.value = {};
    provisioningNetworkProbe.value = null;
    return;
  }
  probingIps.value = true;
  provisioningNetworkProbe.value = null;
  try {
    const connectionPayload = buildConnectionPayload();
    const pool = currentProvisioningPoolDraft();
    const result = await postJson<IpProbeResponse>("/api/provisioning/ip-probe", {
      ...(connectionPayload ?? {}),
      ips,
      occupiedIps: Array.from(provisioningOccupiedIps.value),
      leasedIps: Array.from(provisioningLeasedIps.value),
      timeoutMs: 900,
      hostId: props.host?.providerId,
      network: pool.cidr && isIpv4(pool.gateway) && ips[0]
        ? {
            cidr: pool.cidr,
            gateway: pool.gateway,
            sampleIp: ips[0],
          }
        : undefined,
    });
    if (!isActiveDialogSession(sessionId)) return;
    provisioningNetworkProbe.value = result.network ?? null;
    if (result.network?.status === "unreachable") {
      ipProbeResults.value = {};
      provisioningForm.preferredIp = "";
      if (notifyValidationError) showMessage(result.network.message, "error");
      return;
    }
    ipProbeResults.value = {
      ...ipProbeResults.value,
      ...Object.fromEntries(result.results.map((item) => [item.ip, item])),
    };
    syncPreferredIpAfterProbe(result.results);
  } catch (error) {
    if (!isActiveDialogSession(sessionId)) return;
    provisioningNetworkProbe.value = null;
    ipProbeResults.value = {};
    showMessage(error instanceof Error ? error.message : "IP ping 探测失败", "error");
  } finally {
    if (isActiveDialogSession(sessionId)) probingIps.value = false;
  }
}

function syncPreferredIpAfterProbe(results: IpProbeResult[]) {
  if (provisioningForm.preferredIp) return;
  const firstAvailable = results.find((item) => item.status === "available")?.ip ?? provisioningAvailableIps.value[0] ?? "";
  provisioningForm.preferredIp = firstAvailable;
  syncRootPasswordDefault();
}

function ipCandidateClass(ip: string) {
  const activeIp = activeProvisioningPlanItem.value?.ip || provisioningForm.preferredIp;
  const usedIndex = findPlanIpIndex(ip, activeDraftIndex.value);
  return {
    [`status-${ipProbeResults.value[ip]?.status ?? "pending"}`]: true,
    selected: activeIp === ip,
    "is-used-in-plan": usedIndex >= 0,
  };
}

function ipCandidateStatusText(ip: string) {
  const usedIndex = findPlanIpIndex(ip, activeDraftIndex.value);
  if (usedIndex >= 0) return `第 ${usedIndex + 1} 台`;
  const status = ipProbeResults.value[ip]?.status;
  if (status === "available") return "可用";
  if (status === "reachable") return "有响应";
  if (status === "reserved") return "已预留";
  if (status === "occupied") return "占用";
  if (provisioningOccupiedIps.value.has(ip)) return "占用";
  if (provisioningLeasedIps.value.has(ip)) return "已预留";
  return probingIps.value ? "探测中" : "待探测";
}

function selectIpCandidate(ip: string) {
  if (provisioningFormLocked.value) return;
  const status = ipProbeResults.value[ip]?.status;
  if (status !== "available") {
    showMessage(`${ip} ${ipCandidateStatusText(ip)}，不能分配给新环境。`, "warning");
    return;
  }
  const targetIndex = clampDraftIndex(activeDraftIndex.value, provisioningPlan.value?.items.length ?? Math.max(Math.floor(provisioningForm.count), 1));
  const usedIndex = findPlanIpIndex(ip, targetIndex);
  if (usedIndex >= 0) {
    showMessage(`${ip} 已用于第 ${usedIndex + 1} 台，请先调整该行 IP。`, "warning");
    return;
  }
  setActiveDraftIndex(targetIndex);
  setVmDraftOverride(targetIndex, "ip", ip);
  const name = vmDraftOverrides[targetIndex]?.name?.trim();
  if (!name) setVmDraftOverride(targetIndex, "name", defaultVmNameForIp(ip, targetIndex));
  provisioningForm.preferredIp = ip;
  syncRootPasswordDefault();
}

function defaultVmNameForIp(ip: string, index: number) {
  const ipPrefix = vmNamePrefixFromIp(ip);
  if (ipPrefix) return ipPrefix;
  const base = provisioningForm.vmNamePrefix.trim() || "vm";
  return `${base}-${String(index + 1).padStart(2, "0")}`;
}

function resolveVmNameForAssignedIp(name: string | undefined, ip: string, index: number) {
  const currentName = name?.trim();
  if (!currentName) return defaultVmNameForIp(ip, index);
  const assignedPrefix = vmNamePrefixFromIp(ip);
  if (!assignedPrefix) return currentName;
  const currentIpPrefix = currentName.match(/^(?:\d{1,3}\.){1,3}\d{1,3}_/)?.[0];
  // The IP-derived prefix remains authoritative while the user-owned suffix is preserved.
  return currentIpPrefix ? `${assignedPrefix}${currentName.slice(currentIpPrefix.length)}` : currentName;
}

function vmNamePrefixFromIp(ip: string) {
  if (!isIpv4(ip)) return "";
  const parts = ip.split(".");
  const subnet = parts[2];
  const host = parts[3];
  if ((subnet === "2" || subnet === "127" || subnet === "129") && host) return `${subnet}.${host}_`;
  return `${ip}_`;
}

function splitIpList(value: string) {
  return value
    .split(/[\s,，;；]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function enumerateIpRange(startIp: string, endIp: string) {
  if (!isIpv4(startIp) || !isIpv4(endIp)) return [];
  const start = ipToNumber(startIp);
  const end = ipToNumber(endIp);
  if (start > end || end - start > 1024) return [];
  const ips: string[] = [];
  for (let value = start; value <= end; value += 1) {
    ips.push(numberToIp(value));
  }
  return ips;
}

function ipToNumber(ip: string) {
  return ip.split(".").reduce((sum, part) => sum * 256 + Number(part), 0);
}

function numberToIp(value: number) {
  return [24, 16, 8, 0].map((shift) => String((value >>> shift) & 255)).join(".");
}

function isIpv4(value: string | undefined) {
  if (!value) return false;
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

function formatBytes(value: number) {
  if (!Number.isFinite(value)) return "-";
  const gib = value / 1024 / 1024 / 1024;
  if (gib >= 1) return `${formatNumber(gib)} GiB`;
  return `${formatNumber(value / 1024 / 1024)} MiB`;
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(value);
}

function providerLabel(value: ProviderType) {
  return getProviderBrand(value).resourceName;
}

function showMessage(message: string, type: "success" | "error" | "warning" | "info") {
  if (type === "error") {
    ElMessage.error({ message, duration: VRC_TOAST_DURATION_MS, showClose: false });
  } else if (type === "success") {
    ElMessage.success({ message, duration: VRC_TOAST_DURATION_MS, showClose: false });
  } else if (type === "warning") {
    ElMessage.warning({ message, duration: VRC_TOAST_DURATION_MS, showClose: false });
  } else {
    ElMessage.info({ message, duration: VRC_TOAST_DURATION_MS, showClose: false });
  }
}

function buildConnectionPayload() {
  if (props.connection.password?.trim()) {
    return {
      providerType: props.connection.providerType,
      host: props.connection.host.trim(),
      port: props.connection.port,
      username: props.connection.username.trim(),
      password: props.connection.password.trim(),
    };
  }
  if (!props.connection.id) return null;
  return {
    connectionId: props.connection.id,
    providerType: props.connection.providerType,
  };
}

function buildVmCreateConnectionPayload(): Pick<VmCreateRequest, "connectionId" | "providerType" | "host" | "port" | "username" | "password"> {
  if (props.connection.password?.trim()) {
    return {
      providerType: props.connection.providerType,
      host: props.connection.host.trim(),
      port: props.connection.port,
      username: props.connection.username.trim(),
      password: props.connection.password.trim(),
    };
  }
  return {
    connectionId: props.connection.id,
    providerType: props.connection.providerType,
  };
}

async function postJson<T>(url: string, payload: unknown, method = "POST"): Promise<T> {
  return secureJsonRequest<T>(url, payload, method);
}

interface ProvisioningPlanItem {
  name: string;
  ip: string;
  loginUsername: string;
  rootPassword: string;
  source: string;
  cpu: number;
  memoryGiB: number;
  systemDiskGiB: number;
  dataDiskGiB: number;
}

interface ProvisioningPlanResult {
  items: ProvisioningPlanItem[];
  warnings: ProvisioningWarning[];
  summary: string;
}

interface ProvisioningWarning {
  code: string;
  message: string;
  severity: "blocking" | "advisory";
}

type ProvisioningSourceType = "iso" | "template";
</script>

<template>
  <el-dialog v-model="visibleModel" width="1260px" class="provision-dialog" top="3vh" :close-on-click-modal="false">
    <template #header>
      <div class="provision-dialog-title">
        <div>
          <strong>创建虚拟机</strong>
          <span>{{ targetHostSummary }} · 先生成创建预案，再提交创建任务</span>
        </div>
      </div>
    </template>

    <section
      class="quick-provision vrc-scroll-container"
      :class="{
        'is-single-draft': isSingleDraftMode,
        'has-task-footer': activeProgressVisible,
        'is-form-locked': provisioningFormLocked,
      }"
    >
      <div class="resource-check-grid compact provision-resource-checks">
        <VrcOverflowTooltip :content="cpuResourceCheckText" class="resource-check" tabindex="0">
          <span>CPU</span>
          <strong data-overflow-target>{{ cpuResourceCheckText }}</strong>
        </VrcOverflowTooltip>
        <VrcOverflowTooltip :content="memoryResourceCheckText" class="resource-check" tabindex="0">
          <span>内存可用</span>
          <strong data-overflow-target>{{ memoryResourceCheckText }}</strong>
        </VrcOverflowTooltip>
        <VrcOverflowTooltip :content="storageResourceCheckText" class="resource-check" tabindex="0">
          <span>存储可用</span>
          <strong data-overflow-target>{{ storageResourceCheckText }}</strong>
        </VrcOverflowTooltip>
        <VrcOverflowTooltip
          :content="provisioningStatusTooltip"
          placement="bottom-end"
          class="resource-check"
          :class="{ 'is-blocking': blockingProvisioningWarnings.length > 0 }"
          tabindex="0"
        >
          <span>预案状态</span>
          <strong data-overflow-target>{{ provisioningStatusText }}</strong>
        </VrcOverflowTooltip>
      </div>

      <div class="provision-full-grid">
        <div class="provision-main-stack">
          <section class="quick-form-card provision-section">
            <div class="provision-section-head">
              <strong>创建参数</strong>
              <span>来源、规格和账号策略按当前预设生成</span>
            </div>
            <label v-if="provisioningForm.sourceType === 'iso'" class="form-field iso-field">
              <span>系统镜像</span>
              <el-select
                v-model="provisioningForm.isoId"
                placeholder="选择 ISO"
                filterable
                :loading="loadingIsoImages"
                :disabled="provisioningFormLocked"
                popper-class="vrc-provision-select-dropdown vrc-provision-iso-dropdown"
                placement="bottom-start"
                :offset="0"
                :show-arrow="false"
                :fallback-placements="['bottom-start', 'top-start']"
                loading-text="正在读取镜像资源"
                no-data-text="当前平台未读到 ISO"
                @visible-change="handleIsoSelectVisibleChange"
              >
                <el-option-group v-for="group in isoOptionGroups" :key="group.label" :label="group.label">
                  <el-option v-for="image in group.options" :key="image.id" :label="image.name" :value="image.id">
                    <span class="option-title">{{ image.name }}</span>
                    <small class="option-subtitle">{{ isoOptionDescription(image) }}</small>
                  </el-option>
                </el-option-group>
              </el-select>
            </label>
            <label v-else class="form-field iso-field">
              <span>克隆源</span>
              <el-input v-model="provisioningForm.templateName" placeholder="用于克隆的基础虚拟机名称" :disabled="provisioningFormLocked" />
            </label>
            <div class="form-field source-mode-field">
              <span>安装类型</span>
              <el-segmented
                v-if="installProfileOptions.length > 1"
                v-model="provisioningForm.installProfile"
                class="provision-profile-segmented"
                :options="installProfileOptions"
                :disabled="provisioningFormLocked"
              />
              <strong v-else>{{ installProfileOptions[0]?.label ?? "CLI" }}</strong>
            </div>

            <label class="form-field compact">
              <span>CPU</span>
              <el-input-number v-model="provisioningForm.cpu" :min="1" :max="256" controls-position="right" :disabled="provisioningFormLocked" />
            </label>
            <label class="form-field compact">
              <span>内存 GiB</span>
              <el-input-number v-model="provisioningForm.memoryGiB" :min="1" :max="2048" controls-position="right" :disabled="provisioningFormLocked" />
            </label>
            <label class="form-field compact">
              <span>虚拟硬盘 GiB</span>
              <el-input-number v-model="provisioningForm.systemDiskGiB" :min="1" :max="65535" controls-position="right" :disabled="provisioningFormLocked" />
            </label>
            <label class="form-field compact">
              <span>创建台数</span>
              <el-input-number v-model="provisioningForm.count" class="provision-count-input" :min="1" :max="20" controls-position="right" :disabled="provisioningFormLocked" />
            </label>

            <label class="form-field">
              <span>名称备注</span>
              <el-input v-model="provisioningForm.vmNamePrefix" placeholder="无 IP 时兜底，例如 test" :disabled="provisioningFormLocked" />
            </label>
            <label class="form-field">
              <span>{{ provisioningAccountPolicy.label }}</span>
              <el-input v-if="provisioningAccountPolicy.requiresUsername" v-model="provisioningForm.loginUsername" placeholder="例如 ubuntu" :disabled="provisioningFormLocked" />
              <el-input v-else :model-value="provisioningAccountPolicy.defaultUsername" readonly :disabled="provisioningFormLocked" />
            </label>
            <el-checkbox v-model="provisioningForm.autoStart" class="provision-auto-start" :disabled="provisioningFormLocked">创建后启动并打开控制台</el-checkbox>
          </section>
        </div>

        <aside class="provision-side-stack">
          <section class="provision-side-panel is-collapsible" :class="{ 'is-expanded': isProvisionSectionExpanded('network') }">
            <div
              class="provision-panel-toggle"
              role="group"
              aria-label="网络配置与 IP 池"
              title="双击展开或收起"
              @dblclick="handleProvisionPanelDoubleClick"
            >
              <span class="provision-panel-title">
                <strong>网络配置 / IP 池</strong>
                <small>{{ selectedProvisioningPool?.name ?? (provisioningForm.poolName || "使用默认 IP 池") }}</small>
              </span>
              <span class="provision-panel-meta">
                {{ provisioningForm.startIp && provisioningForm.endIp ? `${provisioningForm.startIp} - ${provisioningForm.endIp}` : "未配置地址范围" }}
              </span>
              <button
                class="provision-network-action"
                type="button"
                :aria-busy="probingIps"
                :aria-label="probingIps ? '正在 PING IP' : 'PING IP'"
                :disabled="initializingProvisioningDialog || probingIps || provisioningFormLocked"
                @click.stop="probeProvisioningIps()"
              >
                <el-icon v-if="probingIps" class="provision-network-action-icon" aria-hidden="true"><Loading /></el-icon>
                <span>PING IP</span>
              </button>
              <button
                class="provision-collapse-action"
                type="button"
                :aria-label="isProvisionSectionExpanded('network') ? '收起网络配置' : '展开网络配置'"
                :aria-expanded="isProvisionSectionExpanded('network')"
                :title="isProvisionSectionExpanded('network') ? '收起' : '展开'"
                @click="toggleProvisionSection('network')"
              >
                <el-icon>
                  <ArrowUp v-if="isProvisionSectionExpanded('network')" />
                  <ArrowDown v-else />
                </el-icon>
              </button>
            </div>

            <div v-if="isProvisionSectionExpanded('network')" class="provision-panel-body">
              <div class="provision-inline-actions">
                <el-segmented v-model="ipCandidateFilter" class="ip-candidate-filter" :options="ipCandidateFilterOptions" aria-label="候选 IP 筛选" />
              </div>
              <el-select
                v-model="provisioningForm.ipPoolId"
                placeholder="选择已保存 IP 池"
                clearable
                :disabled="provisioningFormLocked"
                popper-class="vrc-provision-select-dropdown vrc-provision-ip-pool-dropdown"
                fit-input-width
                placement="bottom-start"
                :offset="0"
                :show-arrow="false"
                :fallback-placements="['bottom-start', 'top-start']"
                @change="applyProvisioningPool"
              >
                <el-option v-for="pool in provisioningPoolOptions" :key="pool.id" :label="pool.name" :value="pool.id">
                  <span>{{ pool.name }}</span>
                  <small class="option-subtitle">{{ pool.startIp }} - {{ pool.endIp }}</small>
                </el-option>
              </el-select>
              <div class="ip-pool-grid compact">
                <el-input v-model="provisioningForm.cidr" placeholder="CIDR，例如 192.0.2.0/24" :disabled="provisioningFormLocked" />
                <el-input v-model="provisioningForm.gateway" placeholder="网关" :disabled="provisioningFormLocked" />
                <el-input v-model="provisioningForm.dnsText" placeholder="DNS，逗号分隔" :disabled="provisioningFormLocked" />
                <el-input v-model="provisioningForm.reservedIpsText" placeholder="保留 IP，逗号或换行分隔" :disabled="provisioningFormLocked" />
              </div>
              <div class="provision-actions">
                <span>可用 {{ provisioningAvailableIps.length }} 个 · 已占用 {{ provisioningOccupiedIps.size }} 个 · 关机 VM 也计入占用</span>
              </div>
              <div class="ip-candidates">
                <div class="ip-candidates-head">
                  <strong>候选 IP</strong>
                  <span>{{ activeIpCandidateText }}</span>
                </div>
                <div v-if="provisioningCandidateError" class="ip-candidate-validation-error" role="alert">
                  <el-icon><WarningFilled /></el-icon>
                  <span>
                    <strong>{{ provisioningPoolError ? "IP 池配置不可用" : "创建网络不可用" }}</strong>
                    <small>{{ provisioningCandidateError }}</small>
                  </span>
                </div>
                <template v-else-if="visibleIpCandidates.length">
                  <div v-if="provisioningNetworkProbe?.status === 'route-only'" class="ip-candidate-network-warning" role="status">
                    {{ provisioningNetworkProbe.message }}
                  </div>
                  <div class="ip-candidate-list">
                    <button v-for="ip in visibleIpCandidates" :key="ip" type="button" class="ip-candidate" :class="ipCandidateClass(ip)" :disabled="provisioningFormLocked" @click="selectIpCandidate(ip)">
                      <strong>{{ ip }}</strong>
                      <small>{{ ipCandidateStatusText(ip) }}</small>
                    </button>
                  </div>
                </template>
                <small v-else>{{ ipCandidateEmptyText }}</small>
              </div>
            </div>
          </section>

        </aside>

        <section class="vm-draft-panel provision-draft-full">
          <div class="provision-plan-head vm-plan-head">
            <div>
              <h3>{{ isProvisionTaskMode ? "VM 创建明细" : "生成创建预案" }}</h3>
              <span>{{ isProvisionTaskMode ? "VM 创建后表单锁定，只保留对象状态和验收进度" : provisioningPlan?.summary ?? "请先完成目标、来源、规格和 IP 池配置" }}</span>
            </div>
            <span class="provision-plan-status">{{ provisionPlanAsideText }}</span>
          </div>
          <div v-if="isProvisionTaskMode" class="vm-task-table">
            <div class="vm-task-row vm-task-header">
              <span>序号</span>
              <span>名称</span>
              <span>IP</span>
              <span>状态</span>
              <span>当前进度</span>
            </div>
            <div class="vm-task-body vrc-scroll-container">
              <div v-for="(vm, index) in provisionTask?.vms ?? []" :key="`${vm.name}:${vm.ip ?? index}`" class="vm-task-row">
                <span class="vm-draft-index">{{ index + 1 }}</span>
                <strong>{{ vm.name }}</strong>
                <span>{{ vm.ip || "-" }}</span>
                <span class="vm-task-status vm-state-inline" :class="vmTaskStatusClass(vm.status)">
                  <template v-if="vm.status === 'running'">
                    <span class="vm-action-stage-copy">{{ provisionVmStatusText(vm.status) }}</span>
                    <span class="vm-action-stage-dots" aria-hidden="true"><i></i><i></i><i></i></span>
                  </template>
                  <template v-else>
                    <span class="state-text">{{ provisionVmStatusText(vm.status) }}</span>
                  </template>
                </span>
                <span>{{ provisionVmProgressText(vm) }}</span>
              </div>
            </div>
          </div>
          <section v-if="isProvisionTaskMode" class="provision-inline-console-panel">
            <ConsoleDialog
              v-if="consoleTarget"
              embedded
              :visible="true"
              :target="consoleTarget"
              :provision-task="provisionTask"
              :provision-targets="provisionConsoleTargets ?? []"
              :terminal-font-family="terminalFontFamily"
              :terminal-font-size="terminalFontSize"
              :terminal-line-height="terminalLineHeight"
              :terminal-cursor-style="terminalCursorStyle"
              :terminal-cursor-blink="terminalCursorBlink"
              :terminal-theme="terminalTheme"
              :display-scale-mode="displayScaleMode"
              :display-quality="displayQuality"
              :throttle-resize="throttleResize"
              :watermark-enabled="watermarkEnabled"
              :watermark-density="watermarkDensity"
              :watermark-opacity="watermarkOpacity"
              :watermark-text="watermarkText"
              @select-provision-target="emit('select-console-target', $event)"
            />
            <div v-else class="provision-inline-console-empty">
              <strong>控制台准备中</strong>
              <span>{{ consoleAvailable ? "正在选择可用控制台目标" : "等待 VM 网络和控制台入口就绪" }}</span>
            </div>
            <div v-if="showTerminalNotice" class="provision-terminal-notice" :class="`status-${provisionTask?.status ?? 'warning'}`">
              <div><strong>{{ provisionTask?.status === "warning" ? "系统已启动，存在告警" : "创建任务异常结束" }}</strong><span>{{ provisionTask?.message || "请查看任务步骤和当前控制台。" }}</span></div>
              <button type="button" title="关闭提醒" aria-label="关闭任务提醒" @click="terminalNoticeDismissed = true"><el-icon><Close /></el-icon></button>
            </div>
          </section>
          <div
            v-else
            class="vm-plan-list-table"
            :class="{ 'is-static-body': (provisioningPlan?.items.length ?? 0) <= 3 }"
            :style="{ height: `${Math.min(160, 34 + (provisioningPlan?.items.length ?? 0) * 42)}px` }"
          >
            <div class="vm-plan-list-row vm-plan-list-header">
              <span>序号</span>
              <span>名称</span>
              <span>IP</span>
              <span>CPU</span>
              <span>内存</span>
              <span>磁盘</span>
              <span>密码</span>
            </div>
            <div class="vm-plan-list-body vrc-scroll-container">
              <div
                v-for="(item, index) in provisioningPlan?.items ?? []"
                :key="index"
                class="vm-plan-list-row"
                :class="{ 'is-active-draft': activeDraftIndex === index }"
                @click="setActiveDraftIndex(index)"
              >
                <span class="vm-draft-index">{{ index + 1 }}</span>
                <el-input class="vm-plan-inline-input" :model-value="item.name" :disabled="provisioningFormLocked" @focus="setActiveDraftIndex(index)" @update:model-value="setVmDraftText(index, 'name', $event)" />
                <el-input class="vm-plan-inline-input" :model-value="item.ip" placeholder="待分配" :disabled="provisioningFormLocked" @focus="setActiveDraftIndex(index)" @update:model-value="setVmDraftText(index, 'ip', $event)" />
                <el-input-number class="vm-plan-inline-number" :model-value="item.cpu" :min="1" :max="256" controls-position="right" :disabled="provisioningFormLocked" @focus="setActiveDraftIndex(index)" @update:model-value="setVmDraftNumber(index, 'cpu', $event)" />
                <el-input-number class="vm-plan-inline-number" :model-value="item.memoryGiB" :min="1" :max="2048" controls-position="right" :disabled="provisioningFormLocked" @focus="setActiveDraftIndex(index)" @update:model-value="setVmDraftNumber(index, 'memoryGiB', $event)" />
                <el-input-number class="vm-plan-inline-number" :model-value="item.systemDiskGiB + item.dataDiskGiB" :min="1" :max="65535" controls-position="right" :disabled="provisioningFormLocked" @focus="setActiveDraftIndex(index)" @update:model-value="setVmDraftNumber(index, 'diskGiB', $event)" />
                <el-input class="vm-plan-inline-input" :model-value="item.rootPassword" show-password :disabled="provisioningFormLocked" @focus="setActiveDraftIndex(index)" @update:model-value="setVmDraftText(index, 'rootPassword', $event)" />
              </div>
            </div>
          </div>
        </section>
      </div>
    </section>
    <template #footer>
      <div class="provision-dialog-footer" :class="{ 'has-task-bar': activeProgressVisible }">
        <section v-if="activeProgressVisible" class="footer-workflow" :class="`status-${progress?.status ?? provisionTask?.status ?? 'running'}`">
          <div class="footer-workflow-strip">
            <span
              v-for="step in activeProgressSteps"
              :key="step.key"
              class="footer-workflow-step"
              :class="workflowStepClass(step.status)"
              :style="{ '--step-progress': `${workflowStepProgress(step)}%` }"
              :title="step.message || step.name"
            >
              <span class="footer-workflow-step-name">{{ step.name }}</span>
              <span class="footer-workflow-step-state">
                {{ progressStepText(step.status) }}
              </span>
              <span class="footer-workflow-meter" aria-hidden="true"><i></i></span>
            </span>
          </div>
        </section>
        <div v-if="!activeProgressVisible" class="provision-footer-actions">
          <el-button :disabled="submitting" @click="visibleModel = false">取消</el-button>
          <el-button class="quick-install-button" type="primary" :loading="submitting" :disabled="submitting" @click="submitProvisioning">
            创建虚拟机
          </el-button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>
