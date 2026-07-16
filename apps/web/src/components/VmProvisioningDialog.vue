<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { ArrowDown, ArrowUp, Loading } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import ConsoleDialog from "./ConsoleDialog.vue";
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
import type { NoVncVmConsoleTarget } from "../domain/consoleStrategies";
import { resolveProvisioningStrategy } from "../domain/provisioningStrategies";

interface StorageTotals {
  usedGiB: number;
  physicalGiB: number;
  virtualGiB: number;
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
  status: "running" | "success" | "error";
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
  target: NoVncVmConsoleTarget | null;
}

const PROVISION_FOOTER_STEPS = [
  { key: "submit", name: "提交任务" },
  { key: "plan", name: "生成计划" },
  { key: "publish-source", name: "发布安装源" },
  { key: "create-vm", name: "创建 VM" },
  { key: "boot", name: "启动系统" },
  { key: "fetch-source", name: "拉取安装源" },
  { key: "install-guest", name: "安装系统" },
  { key: "wait-network", name: "等待网络" },
  { key: "verify-login", name: "验证登录" },
  { key: "finalize", name: "启动收尾" },
  { key: "guest-tools", name: "监控工具" },
  { key: "complete", name: "完成" },
] satisfies Array<{ key: string; name: string }>;

const IP_CANDIDATE_PREVIEW_LIMIT = 48;
const VRC_TOAST_DURATION_MS = 3000;

function defaultRuntimePolicy(): RuntimePolicy {
  return {
    managedIpPattern: "",
    ipInference: {
      enabled: true,
      shortIpBasePrefix: "",
      shortIpThirdOctets: [],
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
  consoleTarget?: NoVncVmConsoleTarget | null;
  provisionConsoleTargets?: ProvisionConsoleTargetItem[];
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
const loadingProvisioningConfig = ref(false);
const loadingIsoImages = ref(false);
const loadingIpLeases = ref(false);
const probingIps = ref(false);
const ipCandidateFilter = ref<"available" | "all">("available");
const ipLeases = ref<IpLease[]>([]);
const ipProbeResults = ref<Record<string, IpProbeResult>>({});
let ipProbeTimer: ReturnType<typeof setTimeout> | undefined;
let dialogSessionId = 0;
const provisioningStrategy = computed(() => resolveProvisioningStrategy(props.connection.providerType));
const currentScopeKey = computed(() => provisioningStrategy.value.scopeKey(props.connection, props.host));
const environmentTemplateOptions = computed(() =>
  provisioningConfig.value.environmentTemplates.filter((item) => !item.providerType || item.providerType === props.connection.providerType),
);
const selectedEnvironmentTemplate = computed(
  () => environmentTemplateOptions.value.find((item) => item.id === provisioningForm.environmentTemplateId) ?? environmentTemplateOptions.value[0] ?? null,
);
const strategyIpPools = computed(() => provisioningStrategy.value.defaultIpPools(props.connection, props.host, ipPoolPolicy.value));
const provisioningPoolOptions = computed(() => {
  const pools = new Map<string, IpPoolConfig>();
  for (const pool of strategyIpPools.value) pools.set(pool.id, pool);
  return Array.from(pools.values());
});
const provisioningForm = reactive({
  environmentTemplateId: "",
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
const selectedToolsIsoImage = computed(() => isoImages.value.find((item) => /(^|[^a-z])xs-tools\.iso$/i.test(item.name)) ?? null);
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
  const probedAvailable = rawProvisioningAvailableIps.value.filter((ip) => ipProbeResults.value[ip]?.status === "available");
  return orderAvailableIps(probedAvailable);
});
const allIpCandidates = computed(() => enumerateIpRange(currentProvisioningPoolDraft().startIp, currentProvisioningPoolDraft().endIp));
const visibleIpCandidates = computed(() => {
  const source = ipCandidateFilter.value === "available" ? provisioningAvailableIps.value : allIpCandidates.value;
  return source.slice(0, IP_CANDIDATE_PREVIEW_LIMIT);
});
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
const provisioningWarnings = computed(() => categorizeProvisioningWarnings(provisioningPlan.value?.warnings ?? []));
const blockingProvisioningWarnings = computed(() => provisioningWarnings.value.filter((warning) => warning.severity === "blocking"));
const advisoryProvisioningWarnings = computed(() => provisioningWarnings.value.filter((warning) => warning.severity === "advisory"));
const blockingWarningSummary = computed(() => summarizeProvisioningWarnings(blockingProvisioningWarnings.value));
const canSubmit = computed(
  () =>
    !!provisioningPlan.value &&
    !probingIps.value &&
    blockingProvisioningWarnings.value.length === 0,
);
const activeProgressSteps = computed<ProvisioningProgressStep[]>(() => {
  const task = props.provisionTask;
  if (!task) {
    return PROVISION_FOOTER_STEPS.map((step, index) => ({
      key: step.key,
      name: index === 0 ? props.progress?.title ?? step.name : step.name,
      status:
        index === 0
          ? props.progress?.status === "error"
            ? "failed"
            : props.progress?.status === "success"
              ? "success"
              : "running"
          : "pending",
      message: index === 0 ? props.progress?.message : undefined,
    }));
  }
  const stepMap = new Map(task.steps.map((step) => [step.key, step]));
  const submitStep: ProvisioningProgressStep = {
    key: "submit",
    name: "提交任务",
    status: task.steps.some((step) => step.status === "running") || task.status === "success" ? "success" : task.status === "failed" ? "failed" : "running",
    message: task.message,
  };
  const steps = PROVISION_FOOTER_STEPS.map((step) => {
    if (step.key === "submit") return submitStep;
    const taskStep = stepMap.get(step.key as ProvisionTaskStep["key"]);
    return {
      key: step.key,
      name: taskStep?.name ?? step.name,
      status: taskStep?.status ?? "pending",
      message: taskStep?.message,
    };
  });
  const createdWithoutAutoStart = task.status === "success" && task.steps.some((step) => step.key === "boot" && step.status === "skipped");
  if (createdWithoutAutoStart) {
    return steps.map((step) => (["boot", "fetch-source", "install-guest", "wait-network", "verify-login", "finalize", "guest-tools"].includes(step.key) ? { ...step, status: "skipped" } : step));
  }
  return steps;
});
const activeProgressPercent = computed(() => {
  const explicitPercent = Number((props.provisionTask as (ProvisionTask & { progressPercent?: number }) | null)?.progressPercent);
  if (Number.isFinite(explicitPercent)) return Math.min(100, Math.max(0, Math.round(explicitPercent)));
  const steps = activeProgressSteps.value;
  if (!steps.length) return 0;
  const finished = steps.filter((step) => step.status === "success" || step.status === "skipped").length;
  const runningBonus = steps.some((step) => step.status === "running") ? 0.45 : 0;
  return Math.min(100, Math.round(((finished + runningBonus) / steps.length) * 100));
});
const activeProgressVisible = computed(() => props.submitting || !!props.progress || !!props.provisionTask);
const provisioningFormLocked = computed(() => activeProgressVisible.value);
const activeProgressMessage = computed(() => props.progress?.message || props.provisionTask?.message || "等待任务状态");
const isProvisionTaskMode = computed(() => !!props.provisionTask);
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
const expandedProvisionSections = ref<Array<"network">>([]);

watch(
  () => props.visible,
  (visible) => {
    if (visible) {
      const sessionId = ++dialogSessionId;
      void openDialog(sessionId);
    } else {
      dialogSessionId += 1;
      if (ipProbeTimer) clearTimeout(ipProbeTimer);
      resetProvisioningSession();
    }
  },
);

watch(
  () => currentScopeKey.value,
  () => {
    isoImages.value = [];
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
  () =>
    [
      provisioningForm.startIp,
      provisioningForm.endIp,
      provisioningForm.preferredIp,
      provisioningForm.reservedIpsText,
      provisioningForm.count,
      provisioningForm.loginUsername,
      Array.from(provisioningOccupiedIps.value).sort().join("|"),
      Array.from(provisioningLeasedIps.value).sort().join("|"),
    ].join("::"),
  () => {
    if (props.visible) scheduleIpProbe();
  },
);

function resetProvisioningSession() {
  if (ipProbeTimer) {
    clearTimeout(ipProbeTimer);
    ipProbeTimer = undefined;
  }
  probingIps.value = false;
  loadingIsoImages.value = false;
  loadingIpLeases.value = false;
  passwordManuallyEdited.value = false;
  advisoryWarningsAcknowledged.value = false;
  expandedProvisionSections.value = [];
  ipProbeResults.value = {};
  ipCandidateFilter.value = "available";
  isoImages.value = [];
  ipLeases.value = [];
  for (const key of Object.keys(vmDraftOverrides)) {
    delete vmDraftOverrides[Number(key)];
  }
  Object.assign(provisioningForm, {
    sourceType: defaultSourceType(),
    environmentTemplateId: "",
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
  await Promise.all([loadRuntimePolicy(sessionId), loadIpPoolPolicy(sessionId), loadProvisioningConfig(sessionId), loadIsoImages(sessionId), loadIpLeases(sessionId)]);
  if (!props.visible || sessionId !== dialogSessionId) return;
  initializeProvisioningForm();
  scheduleIpProbe(0);
}

async function loadRuntimePolicy(sessionId?: number) {
  try {
    const result = await postJson<RuntimePolicyResponse>("/api/runtime-policy", undefined, "GET");
    if (!props.visible || (sessionId !== undefined && sessionId !== dialogSessionId)) return;
    runtimePolicy.value = result.policy;
  } catch {
    runtimePolicy.value = defaultRuntimePolicy();
  }
}

async function loadIpPoolPolicy(sessionId?: number) {
  try {
    const result = await postJson<IpPoolPolicyResponse>("/api/ip-pools/policy", undefined, "GET");
    if (!props.visible || (sessionId !== undefined && sessionId !== dialogSessionId)) return;
    ipPoolPolicy.value = result.policy;
  } catch (error) {
    ipPoolPolicy.value = defaultIpPoolPolicy();
    showMessage(error instanceof Error ? error.message : "读取 IP 池文件失败", "error");
  }
}

function handleIpPoolPolicyUpdated(event: Event) {
  const policy = (event as CustomEvent<IpPoolPolicy>).detail;
  if (!policy?.ipPools?.length) return;
  ipPoolPolicy.value = policy;
  if (!props.visible) return;
  const selectedPool = selectedProvisioningPool.value;
  if (selectedPool) {
    applyProvisioningPoolDraft(selectedPool);
    scheduleIpProbe();
    return;
  }
  provisioningForm.ipPoolId = provisioningPoolOptions.value[0]?.id ?? "";
  applyProvisioningPool();
}

onMounted(() => {
  window.addEventListener("vrc:ip-pool-policy-updated", handleIpPoolPolicyUpdated);
});

onBeforeUnmount(() => {
  window.removeEventListener("vrc:ip-pool-policy-updated", handleIpPoolPolicyUpdated);
});

async function loadProvisioningConfig(sessionId?: number) {
  loadingProvisioningConfig.value = true;
  try {
    const result = await postJson<ProvisioningConfigResponse>("/api/provisioning/config", undefined, "GET");
    if (!props.visible || (sessionId !== undefined && sessionId !== dialogSessionId)) return;
    provisioningConfig.value = result.config;
  } catch (error) {
    showMessage(error instanceof Error ? error.message : "读取创建预设失败", "error");
  } finally {
    loadingProvisioningConfig.value = false;
  }
}

async function loadIsoImages(sessionId?: number, options: { forceRefresh?: boolean } = {}) {
  const payload = buildConnectionPayload();
  if (!payload || !props.host) return;
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
    if (!props.visible || (sessionId !== undefined && sessionId !== dialogSessionId)) return;
    isoImages.value = provisioningStrategy.value.sortIsoImages(result.images);
    emit("activity", {
      title: result.source === "cache" ? "系统镜像缓存已加载" : "系统镜像读取完成",
      target: hostName,
      detail: result.refreshing ? `${result.images.length} 个 ISO · 后台刷新中` : `${result.images.length} 个 ISO`,
      status: "success",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "读取系统镜像失败";
    showMessage(message, "error");
    emit("activity", {
      title: "读取系统镜像失败",
      target: hostName,
      detail: message,
      status: "error",
    });
  } finally {
    loadingIsoImages.value = false;
  }
}

function handleIsoSelectVisibleChange(open: boolean) {
  if (!open || provisioningForm.sourceType !== "iso") return;
  if (!isoImages.value.length && !loadingIsoImages.value) {
    void loadIsoImages(undefined, { forceRefresh: true });
  }
}

async function loadIpLeases(sessionId?: number) {
  loadingIpLeases.value = true;
  try {
    const result = await postJson<IpLeasesResponse>("/api/provisioning/ip-leases", undefined, "GET");
    if (sessionId !== undefined && (!props.visible || sessionId !== dialogSessionId)) return;
    ipLeases.value = result.leases;
  } catch (error) {
    showMessage(error instanceof Error ? error.message : "读取 IP 池文件失败", "error");
  } finally {
    loadingIpLeases.value = false;
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
  const poolExists = provisioningPoolOptions.value.some((item) => item.id === provisioningForm.ipPoolId);
  if (!provisioningForm.ipPoolId || !poolExists) {
    provisioningForm.ipPoolId = provisioningPoolOptions.value[0]?.id ?? "";
    applyProvisioningPool();
  } else if (!provisioningForm.startIp && selectedProvisioningPool.value) {
    applyProvisioningPool();
  }
  if (provisioningForm.sourceType === "iso") {
    provisioningForm.isoId = provisioningStrategy.value.defaultIsoId(isoImages.value);
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
    if (sourceType !== "iso") return;
    provisioningForm.isoId = provisioningStrategy.value.defaultIsoId(isoImages.value);
    applyAccountPolicyDefault();
  },
);

watch(
  () => provisioningForm.isoId,
  () => {
    applyAccountPolicyDefault();
    applyVmNamePrefixDefault();
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
  const pool = provisioningPoolOptions.value.find((item) => item.id === template.ipPoolId);
  if (pool) {
    provisioningForm.ipPoolId = pool.id;
    applyProvisioningPoolDraft(pool);
  }
  provisioningForm.vmNamePrefix = template.vmNamePrefix;
  provisioningForm.autoStart = template.autoStart;
  if (template.sourceType === "iso") {
    provisioningForm.isoId = resolveTemplateIsoId(template);
  }
  applyAccountPolicyDefault(true);
  applyVmNamePrefixDefault();
  syncRootPasswordDefault(true);
}

function applyProvisioningPool() {
  if (provisioningFormLocked.value) return;
  const pool = selectedProvisioningPool.value;
  if (!pool) return;
  applyProvisioningPoolDraft(pool);
  scheduleIpProbe();
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

function buildProvisioningPlan(): ProvisioningPlanResult | null {
  const spec = effectiveProvisioningSpec.value;
  const pool = currentProvisioningPoolDraft();
  const poolError = validateIpPool(pool);
  const source = provisioningSourceLabel();

  const count = Math.max(Math.floor(provisioningForm.count), 1);
  const warnings: string[] = [];
  const availableIps = poolError ? [] : provisioningAvailableIps.value.slice(0, count);
  if (poolError) warnings.push(poolError);
  if (!source) warnings.push(provisioningForm.sourceType === "iso" ? "未读取到可用 ISO，当前仅能先生成 IP 预览。" : "请填写克隆源名称。");
  if (provisioningAccountPolicy.value.requiresUsername && !provisioningForm.loginUsername.trim()) warnings.push("请填写新建登录用户名。");
  if (provisioningForm.preferredIp && preferredIpProbeResult.value?.status !== "available") {
    warnings.push(`分配 IP ${provisioningForm.preferredIp} 未确认可用。`);
  }
  if (!poolError && probingIps.value) warnings.push("IP ping 探测中，完成后才会生成可提交预案。");
  if (!poolError && !probingIps.value && availableIps.length < count) warnings.push(`IP 池可用 IP 不足：需要 ${count} 个，仅找到 ${availableIps.length} 个。`);
  if (!props.vms.length) {
    warnings.push("当前 VM 清单未完整加载，IP 占用判断可能不完整。");
  }
  if (provisioningForm.sourceType === "iso" && selectedEnvironmentTemplate.value?.installStrategy === "manual-iso") {
    warnings.push("PVE ISO 安装介质会随虚拟机挂载，系统安装需在控制台内完成。");
  }
  const items = Array.from({ length: count }, (_, index) => {
    const override = vmDraftOverrides[index] ?? {};
    const ip = override.ip?.trim() || availableIps[index] || "";
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
      name: override.name?.trim() || defaultVmNameForIp(ip, index),
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
  for (const [index, item] of items.entries()) {
    const status = item.ip ? ipProbeResults.value[item.ip]?.status : undefined;
    if (!item.ip || status !== "available") warnings.push(`第 ${index + 1} 台 IP 未确认可用。`);
  }
  warnings.push(...resourcePlanWarnings(items));
  const readyItems = items.filter((item) => item.ip && ipProbeResults.value[item.ip]?.status === "available");

  return {
    items,
    warnings,
    summary: `${readyItems.length} / ${count} 台 · ${items.reduce((sum, item) => sum + item.cpu, 0)} vCPU · ${formatNumber(items.reduce((sum, item) => sum + item.memoryGiB, 0))} GiB 内存 · ${formatNumber(items.reduce((sum, item) => sum + item.systemDiskGiB + item.dataDiskGiB, 0))} GiB 磁盘`,
  };
}

function orderAvailableIps(ips: string[]) {
  if (!provisioningForm.preferredIp || !ips.includes(provisioningForm.preferredIp)) return ips;
  return [provisioningForm.preferredIp, ...ips.filter((ip) => ip !== provisioningForm.preferredIp)];
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
  if (template.installStrategy === "kickstart") return "无人值守";
  return "手动 ISO";
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
  setVmDraftOverride(index, field, String(value));
  if (field === "ip") {
    const name = vmDraftOverrides[index]?.name?.trim();
    if (!name) setVmDraftOverride(index, "name", defaultVmNameForIp(String(value), index));
  }
}

function setVmDraftNumber(index: number, field: "cpu" | "memoryGiB" | "diskGiB", value: number | undefined) {
  if (provisioningFormLocked.value) return;
  setVmDraftOverride(index, field, value);
}

function resetVmDraftOverride(index: number) {
  delete vmDraftOverrides[index];
}

function progressStepText(status: ProvisionTaskStep["status"]) {
  if (status === "success") return "完成";
  if (status === "running") return "执行中";
  if (status === "failed") return "失败";
  if (status === "skipped") return "跳过";
  return "等待";
}

function workflowStepClass(status: ProvisionTaskStep["status"]) {
  if (status === "success") return "step-success";
  if (status === "running") return "step-running";
  if (status === "failed") return "step-failed";
  if (status === "skipped") return "step-skipped";
  return "step-pending";
}

function workflowStepProgress(step: ProvisioningProgressStep) {
  if (step.status === "success" || step.status === "skipped") return 100;
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
  if (status === "failed") return "失败";
  return "等待";
}

function vmTaskStatusClass(status: ProvisionTaskVm["status"]) {
  if (status === "running") return ["vm-action-state-running", "vm-action-type-shutdown", "is-action-busy"];
  if (status === "success") return ["vm-action-state-success", "vm-action-type-start"];
  if (status === "failed") return ["vm-action-state-error", "vm-action-type-delete"];
  return ["vm-action-state-pending"];
}

function provisionVmProgressText(vm: ProvisionTaskVm) {
  const packageDone = Number(vm.installPackageDone);
  const packageTotal = Number(vm.installPackageTotal);
  if (Number.isFinite(packageDone) && packageDone > 0 && Number.isFinite(packageTotal) && packageTotal > 0) {
    return `安装包 ${packageDone}/${packageTotal} · ${Math.round(vm.progressPercent ?? 0)}%`;
  }
  return vm.message || progressStepText(vm.status === "failed" ? "failed" : vm.status === "success" ? "success" : vm.status === "running" ? "running" : "pending");
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
    connectionId: props.connection.id,
    providerType: props.connection.providerType,
    hostId: props.host?.providerId,
    scopeKey: currentScopeKey.value,
    environmentTemplateId: provisioningForm.environmentTemplateId || undefined,
    sourceType: provisioningForm.sourceType,
    installStrategy: selectedEnvironmentTemplate.value?.installStrategy,
    isoId: provisioningForm.sourceType === "iso" ? provisioningForm.isoId || selectedIsoImage.value?.id || undefined : undefined,
    isoName: provisioningForm.sourceType === "iso" ? selectedIsoImage.value?.name : undefined,
    templateName: provisioningForm.sourceType === "template" ? provisioningForm.templateName.trim() : undefined,
    specId: spec.id,
    spec: {
      cpu: spec.cpu,
      memoryGiB: spec.memoryGiB,
      systemDiskGiB: spec.systemDiskGiB,
      dataDiskGiB: spec.dataDiskGiB,
    },
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

function resourcePlanWarnings(items: ProvisioningPlanItem[]) {
  const warnings: string[] = [];
  const host = props.host;
  if (!host) return ["未选择目标物理机。"];
  const memoryFree = Math.max(host.memoryFreeBytes ?? 0, 0);
  const freeStorageGiB = storageFreeGiB.value;
  const newMemoryBytes = items.reduce((sum, item) => sum + item.memoryGiB, 0) * 1024 ** 3;
  const newDiskGiB = items.reduce((sum, item) => sum + item.systemDiskGiB + item.dataDiskGiB, 0);

  if (memoryFree < newMemoryBytes) warnings.push(`内存余量不足：剩余 ${formatBytes(memoryFree)}，计划新增 ${formatBytes(newMemoryBytes)}。`);
  if (freeStorageGiB < newDiskGiB) warnings.push(`存储余量不足：剩余 ${formatNumber(freeStorageGiB)} GiB，计划新增 ${formatNumber(newDiskGiB)} GiB。`);
  return warnings;
}

function categorizeProvisioningWarnings(warnings: string[]): ProvisioningWarning[] {
  return warnings.map((message) => ({
    message,
    severity: isBlockingProvisioningWarning(message) ? "blocking" : "advisory",
  }));
}

function summarizeProvisioningWarnings(warnings: ProvisioningWarning[]) {
  if (!warnings.length) return "";
  const [first] = warnings;
  return warnings.length === 1 ? first.message : `${first.message} 等 ${warnings.length} 项`;
}

function isBlockingProvisioningWarning(message: string) {
  if (message.startsWith("当前 VM 清单未完整加载")) return false;
  return /不足|未选择|未读取|探测中|未确认|不能|请填写|请改用|格式不正确|起始地址不能|范围过大|未选择目标物理机/.test(message);
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
  const managedPrefixPattern = /-(centos7|ubuntu)$/i;
  if (force || !current || current === "vm" || managedPrefixPattern.test(current)) {
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

function validateIpPool(pool: IpPoolConfig) {
  if (!isIpv4(pool.startIp) || !isIpv4(pool.endIp)) return "请填写合法的 IP 池起止地址。";
  if (ipToNumber(pool.startIp) > ipToNumber(pool.endIp)) return "IP 池起始地址不能大于结束地址。";
  if (enumerateIpRange(pool.startIp, pool.endIp).length > 1024) return "IP 池范围过大，第一版限制在 1024 个地址以内。";
  if (pool.gateway && !isIpv4(pool.gateway)) return "网关地址格式不正确。";
  return "";
}

function scheduleIpProbe(delay = 350) {
  if (ipProbeTimer) clearTimeout(ipProbeTimer);
  ipProbeTimer = setTimeout(() => {
    void probeProvisioningIps();
  }, delay);
}

async function probeProvisioningIps() {
  if (provisioningFormLocked.value) return;
  const ips = Array.from(new Set([...rawProvisioningAvailableIps.value.slice(0, IP_CANDIDATE_PREVIEW_LIMIT), provisioningForm.preferredIp].filter(isIpv4)));
  if (!ips.length) {
    ipProbeResults.value = {};
    return;
  }
  probingIps.value = true;
  try {
    const result = await postJson<IpProbeResponse>("/api/provisioning/ip-probe", {
      ips,
      occupiedIps: Array.from(provisioningOccupiedIps.value),
      leasedIps: Array.from(provisioningLeasedIps.value),
      timeoutMs: 900,
    });
    ipProbeResults.value = {
      ...ipProbeResults.value,
      ...Object.fromEntries(result.results.map((item) => [item.ip, item])),
    };
    syncPreferredIpAfterProbe(result.results);
  } catch (error) {
    showMessage(error instanceof Error ? error.message : "IP ping 探测失败", "error");
  } finally {
    probingIps.value = false;
  }
}

function syncPreferredIpAfterProbe(results: IpProbeResult[]) {
  if (provisioningForm.preferredIp) return;
  const firstAvailable = results.find((item) => item.status === "available")?.ip ?? provisioningAvailableIps.value[0] ?? "";
  provisioningForm.preferredIp = firstAvailable;
  syncRootPasswordDefault();
}

function ipCandidateClass(ip: string) {
  return {
    [`status-${ipProbeResults.value[ip]?.status ?? "pending"}`]: true,
    selected: provisioningForm.preferredIp === ip,
  };
}

function ipCandidateStatusText(ip: string) {
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
  provisioningForm.preferredIp = ip;
  syncRootPasswordDefault();
}

function defaultVmNameForIp(ip: string, index: number) {
  const ipPrefix = vmNamePrefixFromIp(ip);
  if (ipPrefix) return ipPrefix;
  const base = provisioningForm.vmNamePrefix.trim() || "vm";
  return `${base}-${String(index + 1).padStart(2, "0")}`;
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
  if (value === "xenserver") return "XenServer";
  if (value === "vmware") return "VMware";
  if (value === "proxmox") return "Proxmox VE";
  return "KVM/libvirt";
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
  if (!props.connection.id) return null;
  return {
    connectionId: props.connection.id,
    providerType: props.connection.providerType,
  };
}

async function postJson<T>(url: string, payload: unknown, method = "POST"): Promise<T> {
  const init: RequestInit = { method };
  if (payload !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(payload);
  }
  const response = await fetch(url, init);
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.message || "请求失败");
  }
  return result as T;
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
  warnings: string[];
  summary: string;
}

interface ProvisioningWarning {
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
        <span class="resource-check">
          <span>CPU</span>
          <strong>{{ host ? `${formatNumber(host.cpuCores)} 个物理核心` : "-" }} · 运行 {{ formatNumber(runningVcpuForCreate) }} vCPU · 本次 {{ provisioningPlan?.items.reduce((sum, item) => sum + item.cpu, 0) ?? 0 }} vCPU</strong>
        </span>
        <span class="resource-check">
          <span>内存可用</span>
          <strong>{{ host ? formatBytes(host.memoryFreeBytes ?? 0) : "-" }} · 本次 {{ formatNumber(provisioningPlan?.items.reduce((sum, item) => sum + item.memoryGiB, 0) ?? 0) }} GiB</strong>
        </span>
        <span class="resource-check">
          <span>存储可用</span>
          <strong>{{ formatNumber(storageFreeGiB) }} GiB · 本次 {{ formatNumber(provisioningPlan?.items.reduce((sum, item) => sum + item.systemDiskGiB + item.dataDiskGiB, 0) ?? 0) }} GiB</strong>
        </span>
        <span class="resource-check" :class="{ 'is-blocking': blockingProvisioningWarnings.length > 0 }">
          <span>预案状态</span>
          <strong>{{ canSubmit ? "可提交创建" : blockingWarningSummary || "待完成校验" }}</strong>
        </span>
      </div>

      <div class="provision-full-grid">
        <div class="provision-main-stack">
          <section class="quick-form-card provision-section">
            <div class="provision-section-head">
              <strong>创建参数</strong>
              <span>来源、规格和账号策略按当前预设生成</span>
            </div>
            <label class="form-field source-field">
              <span>创建来源</span>
              <el-select
                v-model="provisioningForm.environmentTemplateId"
                placeholder="选择本系统模板"
                popper-class="vrc-provision-select-dropdown"
                fit-input-width
                placement="bottom-start"
                :fallback-placements="['bottom-start', 'top-start']"
                :disabled="provisioningFormLocked"
              >
                <el-option v-for="template in environmentTemplateOptions" :key="template.id" :label="template.name" :value="template.id">
                  <span>{{ template.name }}</span>
                  <small class="option-subtitle">{{ installStrategyLabel(template) }} · {{ template.description || "按模板生成创建参数" }}</small>
                </el-option>
              </el-select>
            </label>
            <div class="form-field source-mode-field">
              <span>安装策略</span>
              <strong>{{ installStrategyLabel(selectedEnvironmentTemplate) }}</strong>
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
                fit-input-width
                placement="bottom-start"
                :fallback-placements="['bottom-start', 'top-start']"
                loading-text="正在读取镜像资源"
                no-data-text="当前平台未读到 ISO"
                @visible-change="handleIsoSelectVisibleChange"
              >
                <el-option v-for="image in isoImages" :key="image.id" :label="image.name" :value="image.id">
                  <span>{{ image.name }}</span>
                  <small class="option-subtitle">{{ image.storageRepository }} · {{ formatBytes(image.sizeBytes ?? 0) }}</small>
                </el-option>
              </el-select>
            </label>
            <label v-else class="form-field iso-field">
              <span>克隆源</span>
              <el-input v-model="provisioningForm.templateName" placeholder="用于克隆的基础虚拟机名称" :disabled="provisioningFormLocked" />
            </label>

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
              <button class="provision-network-action" type="button" :disabled="probingIps || provisioningFormLocked" @click.stop="probeProvisioningIps">
                <el-icon v-if="probingIps" class="inline-loading"><Loading /></el-icon>
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
                <div class="ip-candidate-filter" role="group" aria-label="候选 IP 筛选">
                  <button type="button" :class="{ active: ipCandidateFilter === 'available' }" @click="ipCandidateFilter = 'available'">可用</button>
                  <button type="button" :class="{ active: ipCandidateFilter === 'all' }" @click="ipCandidateFilter = 'all'">全部</button>
                </div>
              </div>
              <el-select
                v-model="provisioningForm.ipPoolId"
                placeholder="选择已保存 IP 池"
                clearable
                :disabled="provisioningFormLocked"
                popper-class="vrc-provision-select-dropdown"
                fit-input-width
                placement="bottom-start"
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
                  <span>{{ provisioningForm.preferredIp ? `首选 ${ provisioningForm.preferredIp }` : loadingIpLeases ? "读取 IP 池文件中" : `本地预留 ${ provisioningLeasedIps.size } 个` }}</span>
                </div>
                <div v-if="visibleIpCandidates.length" class="ip-candidate-list">
                  <button v-for="ip in visibleIpCandidates" :key="ip" type="button" class="ip-candidate" :class="ipCandidateClass(ip)" :disabled="provisioningFormLocked" @click="selectIpCandidate(ip)">
                    <strong>{{ ip }}</strong>
                    <small>{{ ipCandidateStatusText(ip) }}</small>
                  </button>
                </div>
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
              @select-provision-target="emit('select-console-target', $event)"
            />
            <div v-else class="provision-inline-console-empty">
              <strong>控制台准备中</strong>
              <span>{{ consoleAvailable ? "正在选择可用控制台目标" : "等待 VM 网络和控制台入口就绪" }}</span>
            </div>
          </section>
          <div
            v-else
            class="vm-plan-list-table"
            :style="{ height: `${Math.min(158, 32 + (provisioningPlan?.items.length ?? 0) * 42)}px` }"
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
              <div v-for="(item, index) in provisioningPlan?.items ?? []" :key="index" class="vm-plan-list-row">
                <span class="vm-draft-index">{{ index + 1 }}</span>
                <el-input class="vm-plan-inline-input" :model-value="item.name" :disabled="provisioningFormLocked" @update:model-value="setVmDraftText(index, 'name', $event)" />
                <el-input class="vm-plan-inline-input" :model-value="item.ip" placeholder="待分配" :disabled="provisioningFormLocked" @update:model-value="setVmDraftText(index, 'ip', $event)" />
                <el-input-number class="vm-plan-inline-number" :model-value="item.cpu" :min="1" :max="256" controls-position="right" :disabled="provisioningFormLocked" @update:model-value="setVmDraftNumber(index, 'cpu', $event)" />
                <el-input-number class="vm-plan-inline-number" :model-value="item.memoryGiB" :min="1" :max="2048" controls-position="right" :disabled="provisioningFormLocked" @update:model-value="setVmDraftNumber(index, 'memoryGiB', $event)" />
                <el-input-number class="vm-plan-inline-number" :model-value="item.systemDiskGiB + item.dataDiskGiB" :min="1" :max="65535" controls-position="right" :disabled="provisioningFormLocked" @update:model-value="setVmDraftNumber(index, 'diskGiB', $event)" />
                <el-input class="vm-plan-inline-input" :model-value="item.rootPassword" show-password :disabled="provisioningFormLocked" @update:model-value="setVmDraftText(index, 'rootPassword', $event)" />
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
                <template v-if="step.status === 'running'">
                  <span>{{ progressStepText(step.status) }}</span>
                  <span class="vm-action-stage-dots" aria-hidden="true"><i></i><i></i><i></i></span>
                </template>
                <template v-else>{{ progressStepText(step.status) }}</template>
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
