import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import Fastify from "fastify";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { registerProxmoxConsoleRoutes } from "./console/proxmoxConsole.js";
import { registerConsoleUploadRoutes } from "./console/upload.js";
import { registerVmwareConsoleRoutes } from "./console/vmwareConsole.js";
import { registerXenServerConsoleRoutes } from "./console/xenserverConsole.js";
import {
  deleteStoredConnection,
  listStoredConnections,
  markConnectionUsed,
  resolveStoredConnection,
  saveStoredConnection,
} from "./connectionStore.js";
import {
  createEphemeralConnection,
  deleteEphemeralConnection,
  listEphemeralConnections,
  markEphemeralConnectionUsed,
  resolveEphemeralConnection,
} from "./ephemeralConnectionStore.js";
import { InventoryCache } from "./inventoryCache.js";
import type { InventoryCacheScope } from "./inventoryCache.js";
import { listInventoryEventsAfter, publishInventoryEvent, subscribeInventoryEvents } from "./inventoryEvents.js";
import { cleanupXenInstallSources, publishXenInstallSources, registerInstallSourceRoutes, shouldUseXenKickstart } from "./installSourceService.js";
import { listIpLeases, releaseIpLeases, reserveIpLeases } from "./ipLeaseStore.js";
import { getIpPoolPolicy, saveIpPoolPolicy } from "./ipPoolPolicy.js";
import { buildIsoImageCacheKey, getIsoImageCache, saveIsoImageCache } from "./isoImageStore.js";
import { getGeneratedIso } from "./generatedIsoStore.js";
import { getProvisioningConfig, saveProvisioningConfig } from "./provisioningStore.js";
import {
  createProvisionTask,
  finishProvisionTask,
  getProvisionTask,
  listProvisionTasks,
  markProvisionTaskStep,
  subscribeProvisionTask,
  updateProvisionTaskVm,
  updateProvisionTaskVms,
} from "./provisionTaskStore.js";
import { runProvisioningVerifier } from "./provisioningVerifier.js";
import { ProviderRegistry } from "./providers/provider.js";
import type { VirtualizationProvider } from "./providers/provider.js";
import { cleanupRegisteredProxmoxGeneratedIso, ProxmoxProvider } from "./proxmox.js";
import { getRuntimePolicy } from "./runtimePolicy.js";
import {
  deleteUiBackgroundImage,
  getAppPreferences,
  getConnectionPreferences,
  getUiBackgroundImagePath,
  getUiPreferences,
  saveAppPreferences,
  saveConnectionPreferences,
  saveUiBackgroundImage,
  saveUiPreferences,
} from "./uiPreferenceStore.js";
import { cleanupRegisteredXenGeneratedIso, resolveXenInstallMediaMode } from "./xenserverUnattendedIso.js";
import type {
  HostNode,
  IsoImage,
  NetworkInterface,
  ProviderType,
  StorageRepository,
  VirtualDisk,
  VmInventorySummary,
  VmNode,
  VmProvisionRequest,
  VmScheduleTarget,
  XenConnectionInput,
} from "./types.js";
import { VmRenameConflictError, VmRenameValidationError } from "./vmRename.js";
import { cleanupRegisteredVmwareGeneratedIso, VmwareProvider } from "./vmware.js";
import { VmScheduleRunner } from "./vmScheduleRunner.js";
import {
  createVmSchedule,
  deleteVmSchedule,
  listVmSchedules,
  setVmScheduleEnabled,
  updateVmSchedule,
  VmScheduleConflictError,
} from "./vmScheduleStore.js";
import type { UpsertVmScheduleInput } from "./vmScheduleStore.js";
import { metricSamplesToVmSnapshots, XenServerProvider } from "./xenserver.js";

const server = Fastify({
  logger: {
    redact: ["req.body.password", "req.body.rootPassword", "req.body.planItems[*].rootPassword", "req.body.leases[*].rootPassword", "password", "rootPassword"],
  },
});

await server.register(cors, {
  origin: true,
});
await server.register(websocket, {
  options: {
    maxPayload: 16 * 1024 * 1024,
  },
});
await server.register(multipart, {
  limits: {
    files: 8,
    fileSize: 256 * 1024 * 1024,
  },
});

const providers = new ProviderRegistry();
providers.register(new XenServerProvider());
providers.register(new VmwareProvider());
providers.register(new ProxmoxProvider());
const vmScheduleRunner = new VmScheduleRunner(providers, server.log);
const inventoryCache = new InventoryCache();
const isoRefreshJobs = new Set<string>();
const vmScheduleTargetCacheTtlMs = 5 * 60_000;
let vmScheduleTargetCache: Awaited<ReturnType<typeof loadVmScheduleTargets>> | undefined;
let vmScheduleTargetCacheUpdatedAt = 0;
let vmScheduleTargetRefreshJob: Promise<Awaited<ReturnType<typeof loadVmScheduleTargets>>> | undefined;
let vmScheduleTargetCacheVersion = 0;

await registerXenServerConsoleRoutes(server);
await registerProxmoxConsoleRoutes(server);
await registerVmwareConsoleRoutes(server);
await registerConsoleUploadRoutes(server);
registerInstallSourceRoutes(server);

const execFileAsync = promisify(execFile);

interface HostInventoryCapability {
  collectHostInventory(connection: XenConnectionInput): Promise<{
    hosts: HostNode[];
    storage: StorageRepository[];
    networks: NetworkInterface[];
  }>;
}

const providerTypeSchema = z.enum(["xenserver", "vmware", "proxmox", "libvirt"]);
const uiPreferencesSchema = z.object({
  theme: z.enum(["graphite-sage", "basalt-copper", "mist-teal"]).optional(),
  toneMode: z.enum(["system", "light", "dark"]).optional(),
  accentColor: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
  successColor: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
  warningColor: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
  dangerColor: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
  backgroundMode: z.enum(["default", "solid", "image"]).optional(),
  backgroundColor: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
  backgroundOpacity: z.coerce.number().min(5).max(60).optional(),
  backgroundBlur: z.coerce.number().min(0).max(16).optional(),
  backgroundOverlay: z.coerce.number().min(0).max(35).optional(),
  showIconTooltips: z.boolean().optional(),
  truncateLongNames: z.boolean().optional(),
  throttleConsoleResize: z.boolean().optional(),
});
const connectionPreferencesSchema = z.object({
  selectedConnectionId: z.string().optional(),
  providerType: providerTypeSchema.optional(),
  host: z.string().optional(),
  port: z.coerce.number().int().positive().max(65535).optional(),
  username: z.string().optional(),
  connectionName: z.string().optional(),
});
const appPreferencesSchema = z.object({
  ui: uiPreferencesSchema.optional(),
  connection: connectionPreferencesSchema.optional(),
});

const connectionSchema = z.object({
  connectionId: z.string().optional(),
  providerType: providerTypeSchema.default("xenserver"),
  host: z.string().optional(),
  port: z.coerce.number().int().positive().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
});

const saveConnectionSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  providerType: providerTypeSchema.default("xenserver"),
  host: z.string().min(1),
  port: z.coerce.number().int().positive().optional(),
  username: z.string().min(1),
  password: z.string().min(1),
});

const deleteConnectionSchema = z.object({
  id: z.string().min(1),
});

const directConnectionSchema = z.object({
  providerType: z.enum(["xenserver", "vmware", "proxmox", "libvirt"]).default("xenserver"),
  host: z.string().min(1),
  port: z.coerce.number().int().positive().optional(),
  username: z.string().min(1),
  password: z.string().min(1),
});

const ephemeralConnectionSchema = directConnectionSchema.extend({
  name: z.string().optional(),
  ttlMinutes: z.coerce.number().int().positive().max(240).optional(),
});

const hostsSchema = connectionSchema.extend({
  poolId: z.string().optional(),
  forceRefresh: z.boolean().optional(),
});

const vmsSchema = connectionSchema.extend({
  poolId: z.string().optional(),
  hostId: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().default(100),
  keyword: z.string().optional(),
  forceRefresh: z.boolean().optional(),
});

const vmDisksSchema = connectionSchema.extend({
  vmId: z.string().min(1),
});

const vmActionSchema = connectionSchema.extend({
  vmId: z.string().min(1),
  hostId: z.string().optional(),
  action: z.enum(["start", "shutdown", "forceReboot", "delete"]),
  confirmToken: z.literal("CONFIRMED"),
});

const vmRenameSchema = connectionSchema.extend({
  vmId: z.string().min(1),
  hostId: z.string().optional(),
  currentName: z.string().min(1).max(128),
  newName: z.string().min(1).max(128),
  confirmToken: z.literal("CONFIRMED"),
});

const vmScheduleTargetSchema = z.object({
  vmId: z.string().min(1),
  name: z.string().min(1),
  connectionId: z.string().optional(),
  providerType: providerTypeSchema.optional(),
  connectionName: z.string().optional(),
  hostId: z.string().optional(),
  hostName: z.string().optional(),
  ip: z.string().optional(),
  guestOs: z.string().optional(),
  powerState: z.enum(["running", "halted", "stopped", "suspended", "unknown"]).optional(),
});

const vmScheduleSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    connectionId: z.string().min(1),
    providerType: providerTypeSchema,
    connectionName: z.string().optional(),
    hostId: z.string().optional(),
    hostName: z.string().optional(),
    action: z.enum(["start", "shutdown"]),
    cycle: z.enum(["once", "daily", "weekly"]),
    onceAt: z.string().optional(),
    executeTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    weekdays: z.array(z.coerce.number().int().min(1).max(7)).max(7).optional(),
    timezone: z.string().min(1).refine((value) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: value }).format();
        return true;
      } catch {
        return false;
      }
    }, "时区无效"),
    skipMatchingState: z.boolean().default(true),
    shutdownTimeoutMinutes: z.coerce.number().int().min(2).max(60).default(10),
    shutdownFallback: z.enum(["force", "fail"]).default("force"),
    conflictPolicy: z.enum(["block", "skip", "replace"]).default("block"),
    targets: z.array(vmScheduleTargetSchema).min(1).max(500),
    enabled: z.boolean().optional(),
    confirmToken: z.literal("CONFIRMED"),
  })
  .superRefine((value, context) => {
    if (value.cycle === "once" && !value.onceAt) {
      context.addIssue({ code: "custom", path: ["onceAt"], message: "单次任务必须填写执行时间" });
    }
    if (value.cycle !== "once" && !value.executeTime) {
      context.addIssue({ code: "custom", path: ["executeTime"], message: "循环任务必须填写执行时间" });
    }
    if (value.cycle === "weekly" && !value.weekdays?.length) {
      context.addIssue({ code: "custom", path: ["weekdays"], message: "每周任务至少选择一天" });
    }
  });

const vmScheduleIdSchema = z.object({ id: z.string().uuid() });
const vmScheduleEnabledSchema = z.object({ enabled: z.boolean() });
const vmScheduleQuerySchema = z.object({ connectionId: z.string().optional() });

const virtualDisksSchema = connectionSchema.extend({
  poolId: z.string().optional(),
  hostId: z.string().optional(),
});

const isoImagesSchema = connectionSchema.extend({
  poolId: z.string().optional(),
  hostId: z.string().optional(),
  forceRefresh: z.boolean().optional(),
});

const metricsSchema = connectionSchema.extend({
  targetType: z.enum(["host", "vm", "storage", "network"]).default("vm"),
  targetIds: z.array(z.string()).default([]),
});

const specTemplateSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  cpu: z.coerce.number().int().positive(),
  memoryGiB: z.coerce.number().int().positive(),
  systemDiskGiB: z.coerce.number().int().positive(),
  dataDiskGiB: z.coerce.number().int().min(0).default(0),
  description: z.string().optional(),
});

const ipPoolSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  cidr: z.string().default(""),
  gateway: z.string().default(""),
  dns: z.array(z.string()).default([]),
  startIp: z.string().default(""),
  endIp: z.string().default(""),
  reservedIps: z.array(z.string()).default([]),
  networkName: z.string().optional(),
  vlan: z.string().optional(),
});

const runtimeIpPoolPolicySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  prefix: z.string().min(1),
  gateway: z.string().min(1),
  dns: z.array(z.string()).optional(),
  startHost: z.coerce.number().int().min(1).max(254).optional(),
  endHost: z.coerce.number().int().min(1).max(254).optional(),
  hostPrefixes: z.array(z.string()).optional(),
  networkName: z.string().optional(),
  vlan: z.string().optional(),
});

const ipPoolPolicySchema = z.object({
  defaultDns: z.array(z.string()).default([]),
  ipPools: z.array(runtimeIpPoolPolicySchema).default([]),
});

const environmentTemplateSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  providerType: providerTypeSchema.optional(),
  sourceType: z.enum(["iso", "template"]).default("iso"),
  isoNamePattern: z.string().optional(),
  platformTemplateName: z.string().optional(),
  specId: z.string().min(1),
  ipPoolId: z.string().default(""),
  vmNamePrefix: z.string().min(1),
  autoStart: z.boolean().default(true),
  installStrategy: z.enum(["template-clone", "kickstart", "manual-iso"]).default("kickstart"),
  description: z.string().optional(),
});

const provisioningConfigSchema = z.object({
  environmentTemplates: z.array(environmentTemplateSchema).optional(),
  specTemplates: z.array(specTemplateSchema).optional(),
  ipPools: z.array(ipPoolSchema).optional(),
});

const ipProbeSchema = z.object({
  ips: z.array(z.string()).min(1).max(64),
  occupiedIps: z.array(z.string()).default([]),
  leasedIps: z.array(z.string()).default([]),
  timeoutMs: z.coerce.number().int().min(200).max(3000).default(900),
});

const reserveIpLeasesSchema = z.object({
  leases: z
    .array(
      z.object({
        ip: z.string().min(1),
        poolId: z.string().min(1),
        poolName: z.string().min(1),
        scopeKey: z.string().min(1),
        vmName: z.string().min(1),
        loginUsername: z.string().optional(),
        rootPassword: z.string().optional(),
      }),
    )
    .min(1)
    .max(50),
});

const releaseIpLeasesSchema = z.object({
  ips: z.array(z.string()).default([]),
  vmNames: z.array(z.string()).default([]),
  scopeKey: z.string().optional(),
});

const provisionVmItemSchema = z.object({
  name: z.string().min(1),
  ip: z.string().min(1),
  loginUsername: z.string().optional(),
  rootPassword: z.string().optional(),
  cpu: z.coerce.number().int().positive(),
  memoryGiB: z.coerce.number().int().positive(),
  diskGiB: z.coerce.number().int().positive(),
});

const provisionVmsSchema = connectionSchema.extend({
  hostId: z.string().optional(),
  environmentTemplateId: z.string().optional(),
  sourceType: z.enum(["iso", "template"]),
  installStrategy: z.enum(["template-clone", "kickstart", "manual-iso"]).optional(),
  isoId: z.string().optional(),
  isoName: z.string().optional(),
  templateName: z.string().optional(),
  specId: z.string().optional(),
  vmNamePrefix: z.string().min(1),
  count: z.coerce.number().int().positive().max(20),
  ipPool: ipPoolSchema,
  autoStart: z.boolean().default(false),
  planItems: z.array(provisionVmItemSchema).min(1).max(20),
  confirmToken: z.literal("CONFIRMED"),
});

const provisionPreflightSchema = provisionVmsSchema.omit({ confirmToken: true });

type ProvisionVmsInput = z.infer<typeof provisionVmsSchema>;
type ProvisionPreflightInput = z.infer<typeof provisionPreflightSchema>;

type PreflightStatus = "success" | "warning" | "error";

interface ProvisionPreflightCheck {
  key: string;
  label: string;
  status: PreflightStatus;
  message: string;
  details?: Record<string, unknown>;
}

server.get("/api/health", async () => ({
  ok: true,
  service: "virtual-resource-console-api",
  now: new Date().toISOString(),
  scheduleRunner: vmScheduleRunner.status(),
}));

server.get("/api/connections", async () => ({
  connections: [...listStoredConnections(), ...listEphemeralConnections()],
}));

server.get("/api/ephemeral-connections", async () => ({
  connections: listEphemeralConnections(),
}));

server.get("/api/preferences/ui", async () => ({
  preferences: getUiPreferences(),
}));

server.get("/api/preferences/ui/background-image", async (_request, reply) => {
  const imagePath = getUiBackgroundImagePath();
  const preferences = getUiPreferences();
  if (!imagePath || !preferences.backgroundImageMime) {
    return reply.status(404).send({ message: "尚未设置工作区背景图片" });
  }
  reply.header("Cache-Control", "private, max-age=31536000, immutable");
  reply.type(preferences.backgroundImageMime);
  return reply.send(createReadStream(imagePath));
});

server.get("/api/preferences", async () => ({
  preferences: getAppPreferences(),
}));

server.patch("/api/preferences", async (request, reply) => {
  const parsed = appPreferencesSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({
      message: "应用偏好配置格式不正确",
      issues: parsed.error.issues,
    });
  }
  return {
    preferences: saveAppPreferences(parsed.data),
  };
});

server.patch("/api/preferences/ui", async (request, reply) => {
  const parsed = uiPreferencesSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({
      message: "UI 偏好配置格式不正确",
      issues: parsed.error.issues,
    });
  }
  return {
    preferences: saveUiPreferences(parsed.data),
  };
});

server.post("/api/preferences/ui/background-image", async (request, reply) => {
  const file = await request.file({
    limits: {
      files: 1,
      fileSize: 16 * 1024 * 1024,
    },
  });
  if (!file) {
    return reply.status(400).send({ message: "请选择背景图片" });
  }
  if (file.mimetype !== "image/jpeg" && file.mimetype !== "image/png" && file.mimetype !== "image/webp") {
    return reply.status(400).send({ message: "背景图片仅支持 JPG、PNG 和 WebP" });
  }

  const content = await file.toBuffer();
  saveUiBackgroundImage(content);
  const updatedAt = new Date().toISOString();
  return {
    preferences: saveUiPreferences({
      backgroundMode: "image",
      backgroundImageName: path.basename(file.filename).slice(0, 240),
      backgroundImageMime: file.mimetype,
      backgroundImageUpdatedAt: updatedAt,
      backgroundOpacity: Math.max(getUiPreferences().backgroundOpacity, 32),
    }),
  };
});

server.delete("/api/preferences/ui/background-image", async () => {
  deleteUiBackgroundImage();
  return {
    preferences: saveUiPreferences({
      backgroundMode: "default",
      backgroundImageName: "",
      backgroundImageMime: "",
      backgroundImageUpdatedAt: "",
    }),
  };
});

server.get("/api/preferences/connection", async () => ({
  preferences: getConnectionPreferences(),
}));

server.patch("/api/preferences/connection", async (request, reply) => {
  const parsed = connectionPreferencesSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({
      message: "连接偏好配置格式不正确",
      issues: parsed.error.issues,
    });
  }
  return {
    preferences: saveConnectionPreferences(parsed.data),
  };
});

server.get("/api/provisioning/config", async () => ({
  config: getProvisioningConfig(),
}));

server.get("/api/runtime-policy", async () => ({
  policy: getRuntimePolicy(),
}));

server.get("/api/ip-pools/policy", async (_request, reply) => {
  try {
    return {
      policy: getIpPoolPolicy(),
    };
  } catch (error) {
    return reply.status(500).send({
      message: error instanceof Error ? error.message : "读取 IP 池配置失败",
    });
  }
});

server.patch("/api/ip-pools/policy", async (request, reply) => {
  const parsed = ipPoolPolicySchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({
      message: "IP 池配置格式不正确",
      issues: parsed.error.issues,
    });
  }
  try {
    return {
      policy: saveIpPoolPolicy(parsed.data),
    };
  } catch (error) {
    return reply.status(400).send({
      message: error instanceof Error ? error.message : "IP 池配置格式不正确",
    });
  }
});

server.post("/api/provisioning/config", async (request, reply) => {
  const parsed = provisioningConfigSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({
      message: "创建预设配置不完整",
      issues: parsed.error.issues,
    });
  }
  return {
    config: saveProvisioningConfig(parsed.data),
  };
});

server.get("/api/provisioning/ip-leases", async () => ({
  leases: listIpLeases(),
}));

server.post("/api/provisioning/ip-leases", async (request, reply) => {
  const parsed = reserveIpLeasesSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({
      message: "IP 预留参数不完整",
      issues: parsed.error.issues,
    });
  }
  return {
    leases: reserveIpLeases(parsed.data.leases),
  };
});

server.post("/api/provisioning/ip-leases/release", async (request, reply) => {
  const parsed = releaseIpLeasesSchema.safeParse(request.body);
  if (!parsed.success || (!parsed.data.ips.length && !parsed.data.vmNames.length)) {
    return reply.status(400).send({
      message: "请提供要释放的 IP 或 VM 名称。",
      issues: parsed.success ? undefined : parsed.error.issues,
    });
  }
  return {
    leases: releaseIpLeases(parsed.data),
  };
});

server.post("/api/provisioning/ip-probe", async (request, reply) => {
  const parsed = ipProbeSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({
      message: "IP 探测参数不完整",
      issues: parsed.error.issues,
    });
  }

  const occupiedIps = new Set(parsed.data.occupiedIps.filter(isIpv4));
  const leasedIps = new Set(parsed.data.leasedIps.filter(isIpv4));
  const uniqueIps = Array.from(new Set(parsed.data.ips.filter(isIpv4)));
  const results = await mapWithConcurrency(uniqueIps, 8, async (ip) => {
    if (occupiedIps.has(ip)) {
      return { ip, status: "occupied" as const, reason: "清单占用" };
    }
    if (leasedIps.has(ip)) {
      return { ip, status: "reserved" as const, reason: "已在本地 IP 池预留" };
    }
    const reachable = await pingIp(ip, parsed.data.timeoutMs);
    return {
      ip,
      status: reachable ? ("reachable" as const) : ("available" as const),
      reason: reachable ? "ping 有响应" : "ping 无响应",
    };
  });
  return {
    probedAt: new Date().toISOString(),
    results,
  };
});

server.get("/api/provisioning/tasks", async (request) => {
  const query = z
    .object({
      limit: z.coerce.number().int().min(1).max(200).default(50),
    })
    .safeParse(request.query);
  return {
    tasks: listProvisionTasks(query.success ? query.data.limit : 50),
  };
});

server.get("/api/provisioning/tasks/:taskId", async (request, reply) => {
  const params = z.object({ taskId: z.string().min(1) }).safeParse(request.params);
  if (!params.success) {
    return reply.status(400).send({ message: "任务 ID 不正确。" });
  }
  const task = getProvisionTask(params.data.taskId);
  if (!task) {
    return reply.status(404).send({ message: "未找到创建任务。" });
  }
  return { task };
});

server.get("/api/provisioning/tasks/:taskId/events", (request, reply) => {
  const params = z.object({ taskId: z.string().min(1) }).safeParse(request.params);
  if (!params.success) {
    return reply.status(400).send({ message: "任务 ID 不正确。" });
  }
  const task = getProvisionTask(params.data.taskId);
  if (!task) {
    return reply.status(404).send({ message: "未找到创建任务。" });
  }

  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const lastEventId = parseLastEventId(request.headers["last-event-id"]);
  const sendTask = (nextTask: typeof task) => {
    if (reply.raw.writableEnded || reply.raw.destroyed) return;
    reply.raw.write(`id: ${nextTask.eventSeq}\n`);
    reply.raw.write("event: task\n");
    reply.raw.write(`data: ${JSON.stringify({ task: nextTask })}\n\n`);
  };
  if (lastEventId == null || task.eventSeq > lastEventId) {
    sendTask(task);
  }

  const unsubscribe = subscribeProvisionTask(params.data.taskId, sendTask);
  const heartbeat = setInterval(() => {
    if (reply.raw.writableEnded || reply.raw.destroyed) return;
    reply.raw.write(": keep-alive\n\n");
  }, 15000);
  const cleanup = () => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  request.raw.once("close", cleanup);
});

server.get("/api/inventory/events", (request, reply) => {
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  reply.raw.write(": connected\n\n");

  const sendInventoryEvent = (event: ReturnType<typeof publishInventoryEvent>) => {
    if (reply.raw.writableEnded || reply.raw.destroyed) return;
    reply.raw.write(`id: ${event.eventSeq}\n`);
    reply.raw.write("event: inventory\n");
    reply.raw.write(`data: ${JSON.stringify({ event })}\n\n`);
  };
  for (const event of listInventoryEventsAfter(parseLastEventId(request.headers["last-event-id"]))) {
    sendInventoryEvent(event);
  }

  const unsubscribe = subscribeInventoryEvents(sendInventoryEvent);
  const heartbeat = setInterval(() => {
    if (reply.raw.writableEnded || reply.raw.destroyed) return;
    reply.raw.write(": keep-alive\n\n");
  }, 15000);
  const cleanup = () => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  request.raw.once("close", cleanup);
});

server.post("/api/provisioning/preflight", async (request, reply) => {
  const parsed = provisionPreflightSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({
      message: "创建预检参数不完整。",
      issues: parsed.error.issues,
    });
  }

  try {
    const resolved = resolveConnectionRequest(parsed.data);
    const provider = providers.get(resolved.providerType);
    const requestData = buildProvisionRequestData(parsed.data, resolved.providerType, resolved.connectionId, resolved.connection.host);
    const checks = await runProvisionPreflight(provider, resolved.connection, resolved.providerType, requestData, parsed.data);
    if (resolved.connectionId) markResolvedConnectionUsed(resolved.connectionId);
    return {
      checkedAt: new Date().toISOString(),
      ok: !checks.some((check) => check.status === "error"),
      checks,
    };
  } catch (error) {
    request.log.error({ error }, "failed to run provisioning preflight");
    return reply.status(502).send({
      message: toClientErrorMessage(error, "创建预检失败"),
    });
  }
});

server.post("/api/provisioning/vms", async (request, reply) => {
  const parsed = provisionVmsSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({
      message: "创建虚拟机参数不完整，或未完成二次确认。",
      issues: parsed.error.issues,
    });
  }

  try {
    const resolved = resolveConnectionRequest(parsed.data);
    const provider = providers.get(resolved.providerType);
    if (!provider.createVms) {
      return reply.status(501).send({
        message: `当前平台暂不支持一键创建虚拟机：${resolved.providerType}`,
      });
    }
    if (resolved.connectionId) markResolvedConnectionUsed(resolved.connectionId);
    const requestData = buildProvisionRequestData(parsed.data, resolved.providerType, resolved.connectionId, resolved.connection.host);
    const validationErrors = validateProvisionPlan(resolved.providerType, requestData, parsed.data);
    if (validationErrors.length) {
      return reply.status(400).send({
        message: validationErrors.join("；"),
      });
    }
    const task = createProvisionTask({
      connectionId: resolved.connectionId,
      providerType: resolved.providerType,
      hostId: parsed.data.hostId,
      environmentTemplateId: parsed.data.environmentTemplateId,
      title: `${providerLabel(resolved.providerType)} 创建 ${parsed.data.planItems.length} 台 VM`,
      planItems: parsed.data.planItems,
    });
    setTimeout(() => {
      void runProvisionTaskExecution({
        taskId: task.id,
        provider,
        connection: resolved.connection,
        request: requestData,
      }).catch((error) => {
        server.log.error({ error, taskId: task.id }, "failed to execute provisioning task");
        if (getProvisionTask(task.id)?.status !== "failed") {
          finishProvisionTask(task.id, "failed", toClientErrorMessage(error, "创建虚拟机失败"));
        }
      });
    }, 0);
    return reply.status(202).send({
      operatedAt: new Date().toISOString(),
      result: {
        accepted: true,
        providerType: resolved.providerType,
        message: "创建任务已提交，正在后台执行。",
        created: [],
        taskId: task.id,
      },
      task: getProvisionTask(task.id),
    });
  } catch (error) {
    request.log.error({ error }, "failed to accept virtual machine provisioning task");
    return reply.status(502).send({
      message: toClientErrorMessage(error, "提交创建任务失败"),
    });
  }
});

async function runProvisionTaskExecution(input: {
  taskId: string;
  provider: VirtualizationProvider<XenConnectionInput>;
  connection: XenConnectionInput;
  request: VmProvisionRequest;
}) {
  const taskStartedAt = Date.now();
  const timingContext = {
    taskId: input.taskId,
    providerType: input.request.providerType,
    hostId: input.request.hostId,
    vmCount: input.request.planItems.length,
  };
  server.log.info({ ...timingContext }, "provision task started");
  let executableRequest = input.request;
  // Provisioning 状态机先发布安装源，再交给平台 Provider 创建 VM。
  // 这样 XenServer/PVE/VMware 只替换执行策略，不改变任务生命周期。
  if (shouldUseXenKickstart(input.request)) {
    const phaseStartedAt = Date.now();
    markProvisionTaskStep(input.taskId, "publish-source", "running", "正在登记集中安装源和 Kickstart 地址");
    try {
      executableRequest = await publishXenInstallSources({
        connection: input.connection,
        request: input.request,
        taskId: input.taskId,
      });
      server.log.info({ ...timingContext, phase: "publish-source", elapsedMs: Date.now() - phaseStartedAt }, "provision phase timing");
      markProvisionTaskStep(input.taskId, "publish-source", "success", "集中安装源 URL 已发布，等待 VM 安装器拉取");
    } catch (error) {
      server.log.warn({ ...timingContext, phase: "publish-source", elapsedMs: Date.now() - phaseStartedAt, error }, "provision phase failed");
      markProvisionTaskStep(input.taskId, "publish-source", "failed", toClientErrorMessage(error, "发布安装源失败"));
      finishProvisionTask(input.taskId, "failed", toClientErrorMessage(error, "发布安装源失败"));
      await cleanupXenInstallSources(input.taskId);
      throw error;
    }
  } else {
    markProvisionTaskStep(input.taskId, "publish-source", "skipped", "当前策略不需要集中安装源");
  }

  markProvisionTaskStep(input.taskId, "create-vm", "running", "正在准备虚拟化平台创建 VM");
  if (!input.provider.createVms) {
    markProvisionTaskStep(input.taskId, "create-vm", "failed", `当前平台暂不支持一键创建虚拟机：${input.request.providerType}`);
    finishProvisionTask(input.taskId, "failed", `当前平台暂不支持一键创建虚拟机：${input.request.providerType}`);
    await cleanupXenInstallSources(input.taskId);
    return;
  }
  let result;
  try {
    const phaseStartedAt = Date.now();
    result = await input.provider.createVms(input.connection, { ...executableRequest, taskId: input.taskId }, {
      markStep: (stepKey, status, message) => {
        markProvisionTaskStep(input.taskId, stepKey, status, message);
      },
      updateVm: (vmName, patch, message) => {
        updateProvisionTaskVm(input.taskId, vmName, patch, message);
      },
      recordTiming: (phase, elapsedMs, details) => {
        server.log.info({ ...timingContext, phase, elapsedMs, details }, "provision provider timing");
      },
    });
    server.log.info({ ...timingContext, phase: "provider-create-vms", elapsedMs: Date.now() - phaseStartedAt }, "provision phase timing");
  } catch (error) {
    markProvisionTaskStep(input.taskId, "create-vm", "failed", toClientErrorMessage(error, "创建 VM 失败"));
    finishProvisionTask(input.taskId, "failed", toClientErrorMessage(error, "创建 VM 失败"));
    await cleanupXenInstallSources(input.taskId);
    throw error;
  }

  result.taskId = input.taskId;
  markProvisionTaskStep(input.taskId, "create-vm", "success", result.message);
  updateProvisionTaskVms(
    input.taskId,
    executableRequest.planItems.map((item) => {
      const created = result.created.find((vm) => vm.name === item.name);
      return {
        id: created?.id,
        providerId: created?.providerId,
        name: item.name,
        ip: item.ip,
        powerState: created?.powerState,
        status: executableRequest.autoStart ? "running" : "success",
        currentStep: executableRequest.autoStart ? "boot" : "create-vm",
        progressPercent: executableRequest.autoStart ? undefined : 100,
        message: executableRequest.autoStart ? "VM 已创建，等待系统启动验证" : "VM 已创建，未设置自动启动",
      };
    }),
  );
  invalidateInventoryCache(
    {
      connectionId: executableRequest.connectionId,
      providerType: executableRequest.providerType,
      connection: input.connection,
    },
    executableRequest.hostId,
  );
  scheduleInventoryRefresh({
    resolved: {
      connectionId: executableRequest.connectionId,
      providerType: executableRequest.providerType,
      connection: input.connection,
    },
    hostId: executableRequest.hostId,
    changedVmIds: result.created.map((vm) => vm.providerId || vm.id).filter(Boolean),
    changedVmNames: result.created.map((vm) => vm.name).filter(Boolean),
  });
  runProvisioningVerifier({
    taskId: input.taskId,
    connection: input.connection,
    request: executableRequest,
    created: result.created,
    onTiming: (phase, elapsedMs, details) => {
      server.log.info({ ...timingContext, phase, elapsedMs, details }, "provision verifier timing");
    },
    onComplete: async ({ status }) => {
      if (status !== "success") {
        server.log.warn({ ...timingContext }, "provision verifier failed; generated media retained for safe recovery");
        return;
      }
      await cleanupGeneratedIsos(input.connection, result.created);
      await cleanupXenInstallSources(input.taskId);
    },
  });
  server.log.info({ ...timingContext, phase: "submit-to-verifier", elapsedMs: Date.now() - taskStartedAt }, "provision task submitted to verifier");
}

async function cleanupGeneratedIsos(connection: XenConnectionInput, created: { generatedIsoRegistryId?: string; name?: string }[]): Promise<void> {
  for (const vm of created) {
    if (!vm.generatedIsoRegistryId) continue;
    try {
      const record = getGeneratedIso(vm.generatedIsoRegistryId);
      if (record?.providerType === "vmware") {
        await cleanupRegisteredVmwareGeneratedIso(connection, vm.generatedIsoRegistryId);
      } else if (record?.providerType === "proxmox") {
        await cleanupRegisteredProxmoxGeneratedIso(connection, vm.generatedIsoRegistryId);
      } else {
        await cleanupRegisteredXenGeneratedIso(connection, vm.generatedIsoRegistryId);
      }
      server.log.info({ vmName: vm.name, registryId: vm.generatedIsoRegistryId }, "cleaned generated iso");
    } catch (error) {
      server.log.warn({ vmName: vm.name, registryId: vm.generatedIsoRegistryId, error }, "failed to clean generated iso");
    }
  }
}

server.post("/api/connections", async (request, reply) => {
  const parsed = saveConnectionSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({
      message: "请填写连接名称、平台、Host、端口、用户名和密码",
      issues: parsed.error.issues,
    });
  }

  const data = {
    ...parsed.data,
    port: normalizeProviderPort(parsed.data.providerType, parsed.data.port),
  };
  const saved = saveStoredConnection(data);
  invalidateVmScheduleTargetCache();
  return { connection: saved };
});

server.post("/api/ephemeral-connections", async (request, reply) => {
  const parsed = ephemeralConnectionSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({
      message: "请填写临时连接名称、平台、Host、端口、用户名和密码",
      issues: parsed.error.issues,
    });
  }

  const connection = createEphemeralConnection({
    ...parsed.data,
    port: normalizeProviderPort(parsed.data.providerType, parsed.data.port),
  });
  return { connection };
});

server.delete("/api/connections/:id", async (request, reply) => {
  const parsed = deleteConnectionSchema.safeParse(request.params);
  if (!parsed.success) {
    return reply.status(400).send({
      message: "连接 ID 不完整",
      issues: parsed.error.issues,
    });
  }
  const deletedEphemeral = deleteEphemeralConnection(parsed.data.id);
  const deletedStored = deletedEphemeral ? false : deleteStoredConnection(parsed.data.id);
  if (deletedStored) invalidateVmScheduleTargetCache();
  return { deleted: deletedEphemeral || deletedStored };
});

server.delete("/api/ephemeral-connections/:id", async (request, reply) => {
  const parsed = deleteConnectionSchema.safeParse(request.params);
  if (!parsed.success) {
    return reply.status(400).send({
      message: "临时连接 ID 不完整",
      issues: parsed.error.issues,
    });
  }
  return {
    deleted: deleteEphemeralConnection(parsed.data.id),
  };
});

server.post("/api/connections/test", async (request, reply) => {
  const parsed = connectionSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({
      message: "请填写平台、Host、端口、用户名和密码",
      issues: parsed.error.issues,
    });
  }

  try {
    const resolved = resolveConnectionRequest(parsed.data);
    const provider = providers.get(resolved.providerType);
    const result = await provider.testConnection(resolved.connection);
    if (resolved.connectionId) markResolvedConnectionUsed(resolved.connectionId);
    return result;
  } catch (error) {
    request.log.error({ error }, "failed to test virtualization connection");
    return reply.status(502).send({
      message: toClientErrorMessage(error, "连接虚拟化平台失败"),
    });
  }
});

server.post("/api/inventory/pools", async (request, reply) => {
  const parsed = connectionSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({
      message: "请填写平台连接参数",
      issues: parsed.error.issues,
    });
  }

  try {
    const resolved = resolveConnectionRequest(parsed.data);
    const provider = providers.get(resolved.providerType);
    if (resolved.connectionId) markResolvedConnectionUsed(resolved.connectionId);
    return {
      collectedAt: new Date().toISOString(),
      pools: await provider.listPools(resolved.connection),
    };
  } catch (error) {
    request.log.error({ error }, "failed to list virtualization pools");
    return reply.status(502).send({
      message: toClientErrorMessage(error, "读取资源池失败"),
    });
  }
});

server.post("/api/inventory/hosts", async (request, reply) => {
  const parsed = hostsSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({
      message: "请填写平台连接参数",
      issues: parsed.error.issues,
    });
  }

  try {
    const resolved = resolveConnectionRequest(parsed.data);
    if (resolved.connectionId) markResolvedConnectionUsed(resolved.connectionId);
    const inventory = await loadHostInventoryCached(resolved, {
      poolId: parsed.data.poolId,
      forceRefresh: parsed.data.forceRefresh,
    });
    return {
      collectedAt: inventory.updatedAt,
      hosts: inventory.value.hosts,
      storage: inventory.value.storage,
      networks: inventory.value.networks,
      source: inventory.source,
      cacheUpdatedAt: inventory.updatedAt,
      refreshing: inventory.refreshing,
    };
  } catch (error) {
    request.log.error({ error }, "failed to list virtualization hosts");
    return reply.status(502).send({
      message: toClientErrorMessage(error, "读取物理机清单失败"),
    });
  }
});

server.post("/api/inventory/vms", async (request, reply) => {
  const parsed = vmsSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({
      message: "请填写平台连接参数",
      issues: parsed.error.issues,
    });
  }

  try {
    const resolved = resolveConnectionRequest(parsed.data);
    if (resolved.connectionId) markResolvedConnectionUsed(resolved.connectionId);
    const vms = await loadVmsCached(resolved, {
      poolId: parsed.data.poolId,
      hostId: parsed.data.hostId,
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      keyword: parsed.data.keyword,
      forceRefresh: parsed.data.forceRefresh,
    });
    return {
      collectedAt: vms.updatedAt,
      ...vms.value,
      source: vms.source,
      cacheUpdatedAt: vms.updatedAt,
      refreshing: vms.refreshing,
    };
  } catch (error) {
    request.log.error({ error }, "failed to list virtualization vms");
    return reply.status(502).send({
      message: toClientErrorMessage(error, "读取虚拟机清单失败"),
    });
  }
});

server.post("/api/inventory/vm-summary", async (request, reply) => {
  const parsed = vmsSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({
      message: "请填写平台连接参数",
      issues: parsed.error.issues,
    });
  }

  try {
    const resolved = resolveConnectionRequest(parsed.data);
    if (resolved.connectionId) markResolvedConnectionUsed(resolved.connectionId);
    const summary = await loadVmSummaryCached(resolved, {
      poolId: parsed.data.poolId,
      hostId: parsed.data.hostId,
      page: 1,
      pageSize: 500,
      forceRefresh: parsed.data.forceRefresh,
    });
    return {
      collectedAt: summary.updatedAt,
      summary: summary.value,
      source: summary.source,
      cacheUpdatedAt: summary.updatedAt,
      refreshing: summary.refreshing,
    };
  } catch (error) {
    request.log.error({ error }, "failed to summarize virtualization vms");
    return reply.status(502).send({
      message: toClientErrorMessage(error, "读取虚拟机汇总失败"),
    });
  }
});

server.post("/api/inventory/vm-disks", async (request, reply) => {
  const parsed = vmDisksSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({
      message: "请填写平台连接参数和 VM",
      issues: parsed.error.issues,
    });
  }

  try {
    const resolved = resolveConnectionRequest(parsed.data);
    const provider = providers.get(resolved.providerType);
    if (resolved.connectionId) markResolvedConnectionUsed(resolved.connectionId);
    return {
      collectedAt: new Date().toISOString(),
      disks: await provider.listVmDisks(resolved.connection, parsed.data.vmId),
    };
  } catch (error) {
    request.log.error({ error }, "failed to list vm disks");
    return reply.status(502).send({
      message: toClientErrorMessage(error, "读取虚拟机磁盘失败"),
    });
  }
});

server.post("/api/inventory/virtual-disks", async (request, reply) => {
  const parsed = virtualDisksSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({
      message: "请填写平台连接参数",
      issues: parsed.error.issues,
    });
  }

  try {
    const resolved = resolveConnectionRequest(parsed.data);
    const provider = providers.get(resolved.providerType);
    if (resolved.connectionId) markResolvedConnectionUsed(resolved.connectionId);
    return {
      collectedAt: new Date().toISOString(),
      disks: await provider.listVirtualDisks(resolved.connection, {
        poolId: parsed.data.poolId,
        hostId: parsed.data.hostId,
      }),
    };
  } catch (error) {
    request.log.error({ error }, "failed to list virtual disks");
    return reply.status(502).send({
      message: toClientErrorMessage(error, "读取虚拟磁盘失败"),
    });
  }
});

server.post("/api/inventory/iso-images", async (request, reply) => {
  const parsed = isoImagesSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({
      message: "请填写平台连接参数",
      issues: parsed.error.issues,
    });
  }

  try {
    const resolved = resolveConnectionRequest(parsed.data);
    const provider = providers.get(resolved.providerType);
    if (!provider.listIsoImages) {
      return {
        collectedAt: new Date().toISOString(),
        images: [] satisfies IsoImage[],
        source: "unsupported",
        refreshing: false,
      };
    }
    if (resolved.connectionId) markResolvedConnectionUsed(resolved.connectionId);
    const cacheKey = buildIsoImageCacheKey({
      providerType: resolved.providerType,
      connectionId: resolved.connectionId,
      host: resolved.connection.host,
      port: normalizeProviderPort(resolved.providerType, resolved.connection.port),
      username: resolved.connection.username,
      hostId: parsed.data.hostId,
    });
    const cached = getIsoImageCache(cacheKey);
    const scope = {
      poolId: parsed.data.poolId,
      hostId: parsed.data.hostId,
    };
    if (cached && !parsed.data.forceRefresh) {
      refreshIsoImagesInBackground(cacheKey, resolved, scope);
      return {
        collectedAt: cached.updatedAt,
        images: cached.images,
        source: "cache",
        cacheUpdatedAt: cached.updatedAt,
        refreshing: true,
      };
    }
    const refreshed = await refreshIsoImages(cacheKey, resolved, scope);
    return {
      collectedAt: refreshed.updatedAt,
      images: refreshed.images,
      source: "live",
      cacheUpdatedAt: refreshed.updatedAt,
      refreshing: false,
    };
  } catch (error) {
    request.log.error({ error }, "failed to list iso images");
    return reply.status(502).send({
      message: toClientErrorMessage(error, "读取系统镜像失败"),
    });
  }
});

server.post("/api/vms/action", async (request, reply) => {
  const parsed = vmActionSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({
      message: "VM 操作参数不完整，或未完成二次确认。",
      issues: parsed.error.issues,
    });
  }

  try {
    const resolved = resolveConnectionRequest(parsed.data);
    const provider = providers.get(resolved.providerType);
    if (!provider.performVmAction) {
      return reply.status(501).send({
        message: `当前平台暂不支持 VM ${vmActionLabel(parsed.data.action)}操作。`,
      });
    }
    if (resolved.connectionId) markResolvedConnectionUsed(resolved.connectionId);
    let vmNameForLeaseRelease = "";
    let vmIpsForLeaseRelease: string[] = [];
    if (parsed.data.action === "delete") {
      try {
        const vmPage = await provider.listVms(resolved.connection, { page: 1, pageSize: 500 });
        const vmForLeaseRelease = vmPage.items.find((vm) => vm.providerId === parsed.data.vmId);
        vmNameForLeaseRelease = vmForLeaseRelease?.name ?? "";
        vmIpsForLeaseRelease = vmForLeaseRelease?.ipAddresses ?? [];
      } catch {
        vmNameForLeaseRelease = "";
        vmIpsForLeaseRelease = [];
      }
    }
    const result = await provider.performVmAction(resolved.connection, parsed.data.vmId, parsed.data.action);
    invalidateInventoryCache(resolved, parsed.data.hostId);
    if (parsed.data.hostId) {
      if (parsed.data.action === "delete") {
        publishInventoryEvent({
          type: "vm.delete",
          connectionId: resolved.connectionId,
          providerType: resolved.providerType,
          hostId: parsed.data.hostId,
          vmId: parsed.data.vmId,
        });
      } else {
        publishInventoryEvent({
          type: "vm.patch",
          connectionId: resolved.connectionId,
          providerType: resolved.providerType,
          hostId: parsed.data.hostId,
          vmId: parsed.data.vmId,
          patch: {
            powerState: parsed.data.action === "shutdown" ? "halted" : "running",
          },
        });
      }
      scheduleInventoryRefresh({
        resolved,
        hostId: parsed.data.hostId,
        changedVmIds: parsed.data.action === "delete" ? [] : [parsed.data.vmId],
        deletedVmIds: parsed.data.action === "delete" ? [parsed.data.vmId] : [],
      });
    }
    const releasedLeases =
      parsed.data.action === "delete" && (vmNameForLeaseRelease || vmIpsForLeaseRelease.length)
        ? releaseIpLeases({
            ips: vmIpsForLeaseRelease,
            vmNames: vmNameForLeaseRelease ? [vmNameForLeaseRelease] : [],
          })
        : [];
    return {
      operatedAt: new Date().toISOString(),
      result,
      releasedLeases,
    };
  } catch (error) {
    request.log.error({ error }, "failed to perform vm action");
    return reply.status(502).send({
      message: toClientErrorMessage(error, `VM ${vmActionLabel(parsed.data.action)}失败`),
    });
  }
});

server.post("/api/vms/rename", async (request, reply) => {
  const parsed = vmRenameSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({
      message: "VM 改名参数不完整，或未完成确认。",
      issues: parsed.error.issues,
    });
  }

  try {
    const resolved = resolveConnectionRequest(parsed.data);
    const provider = providers.get(resolved.providerType);
    if (!provider.renameVm) {
      return reply.status(501).send({
        message: "当前平台暂不支持虚拟机改名。",
      });
    }
    if (resolved.connectionId) markResolvedConnectionUsed(resolved.connectionId);
    const result = await provider.renameVm(
      resolved.connection,
      parsed.data.vmId,
      parsed.data.currentName,
      parsed.data.newName,
    );
    invalidateInventoryCache(resolved, parsed.data.hostId);
    if (parsed.data.hostId) {
      publishInventoryEvent({
        type: "vm.patch",
        connectionId: resolved.connectionId,
        providerType: resolved.providerType,
        hostId: parsed.data.hostId,
        vmId: parsed.data.vmId,
        patch: {
          name: result.newName,
        },
      });
      scheduleInventoryRefresh({
        resolved,
        hostId: parsed.data.hostId,
        changedVmIds: [parsed.data.vmId],
        changedVmNames: [result.newName],
      });
    }
    return {
      operatedAt: new Date().toISOString(),
      result,
    };
  } catch (error) {
    request.log.error({ error }, "failed to rename vm");
    const statusCode = error instanceof VmRenameValidationError ? 400 : error instanceof VmRenameConflictError ? 409 : 502;
    return reply.status(statusCode).send({
      message: toClientErrorMessage(error, "虚拟机改名失败"),
    });
  }
});

server.get("/api/vm-schedules", async (request, reply) => {
  const parsed = vmScheduleQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    return reply.status(400).send({ message: "定时任务查询参数无效。", issues: parsed.error.issues });
  }
  return {
    tasks: listVmSchedules(parsed.data.connectionId),
    runner: vmScheduleRunner.status(),
  };
});

server.get("/api/vm-schedule-targets", async () => listVmScheduleTargets());

server.post("/api/vm-schedules", async (request, reply) => {
  const parsed = vmScheduleSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ message: "定时任务参数不完整。", issues: parsed.error.issues });
  }
  try {
    const { confirmToken: _confirmToken, ...rawInput } = parsed.data;
    const input = validateVmScheduleConnections(rawInput);
    const task = createVmSchedule(input);
    return reply.status(201).send({ task, runner: vmScheduleRunner.status() });
  } catch (error) {
    if (error instanceof VmScheduleConflictError) {
      return reply.status(409).send({ message: error.message, conflicts: error.conflicts });
    }
    request.log.error({ error }, "failed to create vm schedule");
    return reply.status(400).send({ message: toClientErrorMessage(error, "创建定时任务失败") });
  }
});

server.put("/api/vm-schedules/:id", async (request, reply) => {
  const params = vmScheduleIdSchema.safeParse(request.params);
  const parsed = vmScheduleSchema.safeParse(request.body);
  if (!params.success || !parsed.success) {
    return reply.status(400).send({
      message: "定时任务参数不完整。",
      issues: [...(params.success ? [] : params.error.issues), ...(parsed.success ? [] : parsed.error.issues)],
    });
  }
  try {
    const { confirmToken: _confirmToken, ...rawInput } = parsed.data;
    const input = validateVmScheduleConnections(rawInput);
    const task = updateVmSchedule(params.data.id, input);
    if (!task) return reply.status(404).send({ message: "未找到定时任务。" });
    return { task, runner: vmScheduleRunner.status() };
  } catch (error) {
    if (error instanceof VmScheduleConflictError) {
      return reply.status(409).send({ message: error.message, conflicts: error.conflicts });
    }
    request.log.error({ error }, "failed to update vm schedule");
    return reply.status(400).send({ message: toClientErrorMessage(error, "更新定时任务失败") });
  }
});

server.patch("/api/vm-schedules/:id/enabled", async (request, reply) => {
  const params = vmScheduleIdSchema.safeParse(request.params);
  const parsed = vmScheduleEnabledSchema.safeParse(request.body);
  if (!params.success || !parsed.success) {
    return reply.status(400).send({ message: "任务启停参数无效。" });
  }
  try {
    const task = setVmScheduleEnabled(params.data.id, parsed.data.enabled);
    if (!task) return reply.status(404).send({ message: "未找到定时任务。" });
    return { task, runner: vmScheduleRunner.status() };
  } catch (error) {
    return reply.status(400).send({ message: toClientErrorMessage(error, "更新任务状态失败") });
  }
});

server.delete("/api/vm-schedules/:id", async (request, reply) => {
  const params = vmScheduleIdSchema.safeParse(request.params);
  if (!params.success) return reply.status(400).send({ message: "任务 ID 无效。" });
  if (!deleteVmSchedule(params.data.id)) return reply.status(404).send({ message: "未找到定时任务。" });
  return { deleted: true, id: params.data.id };
});

server.post("/api/metrics/snapshot", async (request, reply) => {
  const parsed = metricsSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({
      message: "请填写平台连接参数",
      issues: parsed.error.issues,
    });
  }

  try {
    const resolved = resolveConnectionRequest(parsed.data);
    const provider = providers.get(resolved.providerType);
    const samples = await provider.collectMetrics(resolved.connection, {
      connectionId: resolved.connectionId,
      targetType: parsed.data.targetType,
      targetIds: parsed.data.targetIds,
    });
    if (resolved.connectionId) markResolvedConnectionUsed(resolved.connectionId);
    return {
      collectedAt: new Date().toISOString(),
      samples,
      metrics: metricSamplesToVmSnapshots(samples),
    };
  } catch (error) {
    request.log.error({ error }, "failed to collect metrics snapshot");
    return reply.status(502).send({
      message: toClientErrorMessage(error, "读取实时指标失败"),
    });
  }
});

registerWebStaticRoutes();

const port = Number(process.env.PORT ?? 3987);
const host = process.env.HOST ?? "0.0.0.0";

server.addHook("onClose", async () => {
  vmScheduleRunner.stop();
});
await server.listen({ host, port });
vmScheduleRunner.start();
void refreshVmScheduleTargetCache().catch((error) => server.log.warn({ error }, "vm schedule target cache warmup failed"));

function registerWebStaticRoutes() {
  const webDistDir = resolveWebDistDir();
  server.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/api") || (request.method !== "GET" && request.method !== "HEAD")) {
      return reply.status(404).send({ message: "未找到接口。" });
    }
    const staticResponse = await resolveStaticFile(webDistDir, request.url);
    if (!staticResponse.ok) {
      return reply.status(staticResponse.status).send({ message: staticResponse.message });
    }
    reply.type(staticResponse.contentType);
    if (staticResponse.cacheControl) {
      reply.header("Cache-Control", staticResponse.cacheControl);
    }
    return reply.send(createReadStream(staticResponse.filePath));
  });
}

function resolveWebDistDir() {
  if (process.env.VRC_WEB_DIST_DIR) {
    return path.resolve(process.env.VRC_WEB_DIST_DIR);
  }
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(currentDir, "../../web/dist");
}

async function resolveStaticFile(
  webDistDir: string,
  rawUrl: string,
): Promise<
  | { ok: true; filePath: string; contentType: string; cacheControl?: string }
  | { ok: false; status: number; message: string }
> {
  try {
    await access(webDistDir);
  } catch {
    return {
      ok: false,
      status: 404,
      message: `Web 静态资源不存在，请先执行 npm run build，或通过 VRC_WEB_DIST_DIR 指定 dist 目录：${webDistDir}`,
    };
  }

  const requestPath = parseStaticRequestPath(rawUrl);
  const relativePath = requestPath === "/" ? "index.html" : requestPath.slice(1);
  const filePath = path.resolve(webDistDir, relativePath);
  if (!isPathInside(filePath, webDistDir)) {
    return { ok: false, status: 403, message: "静态资源路径不允许访问。" };
  }

  const directFile = await findReadableFile(filePath);
  if (directFile) {
    return {
      ok: true,
      filePath: directFile,
      contentType: contentTypeForFile(directFile),
      cacheControl: requestPath.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    };
  }

  if (path.extname(requestPath)) {
    return { ok: false, status: 404, message: "静态资源不存在。" };
  }

  const indexFile = path.resolve(webDistDir, "index.html");
  const readableIndex = await findReadableFile(indexFile);
  if (!readableIndex) {
    return { ok: false, status: 404, message: "Web 入口文件不存在，请重新构建前端。" };
  }
  return {
    ok: true,
    filePath: readableIndex,
    contentType: "text/html; charset=utf-8",
    cacheControl: "no-cache",
  };
}

function parseStaticRequestPath(rawUrl: string) {
  try {
    return decodeURIComponent(new URL(rawUrl, "http://vrc.local").pathname);
  } catch {
    return "/";
  }
}

async function findReadableFile(filePath: string) {
  try {
    const fileStat = await stat(filePath);
    return fileStat.isFile() ? filePath : undefined;
  } catch {
    return undefined;
  }
}

function isPathInside(filePath: string, parentDir: string) {
  const relative = path.relative(parentDir, filePath);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function contentTypeForFile(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  const contentTypes: Record<string, string> = {
    ".css": "text/css; charset=utf-8",
    ".crx": "application/x-chrome-extension",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".xml": "application/xml; charset=utf-8",
  };
  return contentTypes[ext] ?? "application/octet-stream";
}

async function refreshIsoImages(
  cacheKey: string,
  resolved: { connectionId?: string; providerType: ProviderType; connection: XenConnectionInput },
  scope: { poolId?: string; hostId?: string },
) {
  const provider = providers.get(resolved.providerType);
  if (!provider.listIsoImages) {
    return saveIsoImageCache({
      key: cacheKey,
      providerType: resolved.providerType,
      connectionId: resolved.connectionId,
      hostId: scope.hostId,
      images: [],
    });
  }
  const images = await provider.listIsoImages(resolved.connection, scope);
  return saveIsoImageCache({
    key: cacheKey,
    providerType: resolved.providerType,
    connectionId: resolved.connectionId,
    hostId: scope.hostId,
    images,
  }, { merge: true });
}

function refreshIsoImagesInBackground(
  cacheKey: string,
  resolved: { connectionId?: string; providerType: ProviderType; connection: XenConnectionInput },
  scope: { poolId?: string; hostId?: string },
) {
  if (isoRefreshJobs.has(cacheKey)) return;
  isoRefreshJobs.add(cacheKey);
  void refreshIsoImages(cacheKey, resolved, scope)
    .catch((error) => {
      server.log.warn({ error, cacheKey }, "background iso image refresh failed");
    })
    .finally(() => {
      isoRefreshJobs.delete(cacheKey);
    });
}

function resolveConnectionRequest(input: z.infer<typeof connectionSchema>): {
  connectionId?: string;
  providerType: ProviderType;
  connection: XenConnectionInput;
} {
  if (input.connectionId) {
    const stored = resolveEphemeralConnection(input.connectionId) ?? resolveStoredConnection(input.connectionId);
    return {
      connectionId: input.connectionId,
      providerType: stored.providerType,
      connection: {
        host: stored.host,
        port: stored.port,
        username: stored.username,
        password: stored.password,
      },
    };
  }
  return {
    providerType: input.providerType,
    connection: toConnection(input),
  };
}

async function listVmScheduleTargets(): Promise<{
  targets: VmScheduleTarget[];
  errors: Array<{ connectionId: string; connectionName?: string; message: string }>;
}> {
  const cacheAge = Date.now() - vmScheduleTargetCacheUpdatedAt;
  if (vmScheduleTargetCache && cacheAge < vmScheduleTargetCacheTtlMs) return vmScheduleTargetCache;
  if (vmScheduleTargetCache) {
    void refreshVmScheduleTargetCache().catch((error) => server.log.warn({ error }, "vm schedule target cache refresh failed"));
    return vmScheduleTargetCache;
  }
  return refreshVmScheduleTargetCache();
}

function refreshVmScheduleTargetCache() {
  if (vmScheduleTargetRefreshJob) return vmScheduleTargetRefreshJob;
  const cacheVersion = vmScheduleTargetCacheVersion;
  vmScheduleTargetRefreshJob = loadVmScheduleTargets()
    .then((result) => {
      if (cacheVersion === vmScheduleTargetCacheVersion) {
        vmScheduleTargetCache = result;
        vmScheduleTargetCacheUpdatedAt = Date.now();
      }
      return result;
    })
    .finally(() => {
      vmScheduleTargetRefreshJob = undefined;
    });
  return vmScheduleTargetRefreshJob;
}

function invalidateVmScheduleTargetCache() {
  vmScheduleTargetCacheVersion += 1;
  vmScheduleTargetCache = undefined;
  vmScheduleTargetCacheUpdatedAt = 0;
}

async function loadVmScheduleTargets(): Promise<{
  targets: VmScheduleTarget[];
  errors: Array<{ connectionId: string; connectionName?: string; message: string }>;
}> {
  const connections = listStoredConnections();
  const results = await mapWithConcurrency(connections, 8, async (summary) => {
    try {
      const stored = resolveStoredConnection(summary.id);
      const provider = providers.get(stored.providerType);
      const connection: XenConnectionInput = {
        host: stored.host,
        port: stored.port,
        username: stored.username,
        password: stored.password,
      };
      const [hosts, vms] = await Promise.all([
        provider.listHosts(connection),
        listAllProviderVms(provider, connection),
      ]);
      const hostsById = new Map(hosts.flatMap((host) => [[host.id, host], [host.providerId, host]]));
      const onlyHost = hosts.length === 1 ? hosts[0] : undefined;
      const targets = vms.map<VmScheduleTarget>((vm) => {
        const matchedHost = vm.hostId ? hostsById.get(vm.hostId) : undefined;
        const host = matchedHost ?? onlyHost;
        const hostId = host?.providerId;
        return {
          vmId: vm.providerId || vm.id,
          name: vm.name,
          connectionId: summary.id,
          providerType: summary.providerType,
          connectionName: summary.name,
          hostId,
          hostName: host?.name,
          ip: vm.ipAddresses[0],
          guestOs: vm.guestOs,
          powerState: vm.powerState,
        };
      });
      return { targets, errors: [] as Array<{ connectionId: string; connectionName?: string; message: string }> };
    } catch (error) {
      return {
        targets: [] as VmScheduleTarget[],
        errors: [{
          connectionId: summary.id,
          connectionName: summary.name,
          message: toClientErrorMessage(error, "读取虚拟机目录失败"),
        }],
      };
    }
  });
  return {
    targets: results
      .flatMap((result) => result.targets)
      .sort((left, right) =>
        (left.connectionName ?? "").localeCompare(right.connectionName ?? "", "zh-CN", { numeric: true, sensitivity: "base" }) ||
        (left.hostName ?? "").localeCompare(right.hostName ?? "", "zh-CN", { numeric: true, sensitivity: "base" }) ||
        left.name.localeCompare(right.name, "zh-CN", { numeric: true, sensitivity: "base" }),
      ),
    errors: results.flatMap((result) => result.errors),
  };
}

function validateVmScheduleConnections(input: UpsertVmScheduleInput): UpsertVmScheduleInput {
  const primaryConnection = resolveStoredConnection(input.connectionId);
  if (primaryConnection.providerType !== input.providerType) {
    throw new Error("任务平台与主保存连接的平台不一致，请刷新后重试。");
  }
  const connectionCache = new Map([[primaryConnection.id, primaryConnection]]);
  const targets = input.targets.map((target) => {
    const explicitConnectionId = target.connectionId?.trim();
    const connectionId = explicitConnectionId || input.connectionId;
    let stored = connectionCache.get(connectionId);
    if (!stored) {
      stored = resolveStoredConnection(connectionId);
      connectionCache.set(connectionId, stored);
    }
    if (target.providerType && target.providerType !== stored.providerType) {
      throw new Error(`虚拟机“${target.name}”的平台类型与保存连接“${stored.name}”不一致。`);
    }
    const usesPrimaryConnection = connectionId === input.connectionId;
    return {
      ...target,
      connectionId,
      providerType: stored.providerType,
      connectionName: stored.name,
      hostId: target.hostId?.trim() || (usesPrimaryConnection ? input.hostId?.trim() : undefined),
      hostName: target.hostName?.trim() || (usesPrimaryConnection ? input.hostName?.trim() : undefined),
    };
  });
  return {
    ...input,
    connectionName: primaryConnection.name,
    targets,
  };
}

async function listAllProviderVms(
  provider: VirtualizationProvider<XenConnectionInput>,
  connection: XenConnectionInput,
): Promise<VmNode[]> {
  const firstPage = await provider.listVms(connection, { page: 1, pageSize: 500 });
  const items = [...firstPage.items];
  const pageCount = Math.ceil(firstPage.total / firstPage.pageSize);
  for (let page = 2; page <= pageCount; page += 1) {
    const nextPage = await provider.listVms(connection, { page, pageSize: firstPage.pageSize });
    items.push(...nextPage.items);
  }
  return items;
}

function markResolvedConnectionUsed(connectionId: string): void {
  if (markEphemeralConnectionUsed(connectionId)) return;
  markConnectionUsed(connectionId);
}

function toConnection(input: z.infer<typeof connectionSchema>): XenConnectionInput {
  if (!input.host || !input.username || !input.password) {
    throw new Error("请先选择已保存连接，或填写 Host、用户名和密码。");
  }
  return {
    host: input.host,
    port: normalizeProviderPort(input.providerType, input.port),
    username: input.username,
    password: input.password,
  };
}

function normalizeProviderPort(providerType: ProviderType, port: number | undefined): number {
  if (port) return port;
  if (providerType === "proxmox") return 8006;
  return providerType === "vmware" ? 443 : 22;
}

function hasHostInventory(provider: unknown): provider is HostInventoryCapability {
  return typeof provider === "object" && provider !== null && "collectHostInventory" in provider;
}

function buildInventoryCacheScope(
  resolved: ReturnType<typeof resolveConnectionRequest>,
  scope: Pick<InventoryCacheScope, "poolId" | "hostId" | "page" | "pageSize" | "keyword"> = {},
): InventoryCacheScope {
  return {
    providerType: resolved.providerType,
    connectionId: resolved.connectionId,
    host: resolved.connection.host,
    port: resolved.connection.port,
    username: resolved.connection.username,
    ...scope,
  };
}

function loadHostInventoryCached(
  resolved: ReturnType<typeof resolveConnectionRequest>,
  options: { poolId?: string; forceRefresh?: boolean } = {},
) {
  const provider = providers.get(resolved.providerType);
  const connection = resolved.connection;
  const cacheScope = buildInventoryCacheScope(resolved, { poolId: options.poolId });
  return inventoryCache.getHosts(
    cacheScope,
    async () => {
      const inventory = hasHostInventory(provider) ? await provider.collectHostInventory(connection) : undefined;
      return {
        hosts: inventory?.hosts ?? (await provider.listHosts(connection, { poolId: options.poolId })),
        storage: inventory?.storage ?? [],
        networks: inventory?.networks ?? [],
      };
    },
    Boolean(options.forceRefresh),
  );
}

function loadVmsCached(
  resolved: ReturnType<typeof resolveConnectionRequest>,
  options: { poolId?: string; hostId?: string; page: number; pageSize: number; keyword?: string; forceRefresh?: boolean },
) {
  const provider = providers.get(resolved.providerType);
  const cacheScope = buildInventoryCacheScope(resolved, {
    poolId: options.poolId,
    hostId: options.hostId,
    page: options.page,
    pageSize: options.pageSize,
    keyword: options.keyword,
  });
  return inventoryCache.getVmList(
    cacheScope,
    () =>
      provider.listVms(resolved.connection, {
        poolId: options.poolId,
        hostId: options.hostId,
        page: options.page,
        pageSize: options.pageSize,
        keyword: options.keyword,
      }),
    Boolean(options.forceRefresh),
  );
}

function loadVmSummaryCached(
  resolved: ReturnType<typeof resolveConnectionRequest>,
  options: { poolId?: string; hostId?: string; page: number; pageSize: number; forceRefresh?: boolean },
) {
  const provider = providers.get(resolved.providerType);
  const cacheScope = buildInventoryCacheScope(resolved, {
    poolId: options.poolId,
    hostId: options.hostId,
    page: options.page,
    pageSize: options.pageSize,
  });
  return inventoryCache.getVmSummary(
    cacheScope,
    async () => {
      const query = {
        poolId: options.poolId,
        hostId: options.hostId,
        page: options.page,
        pageSize: options.pageSize,
      };
      return provider.summarizeVms != null
        ? provider.summarizeVms(resolved.connection, query)
        : summarizeVmItems((await provider.listVms(resolved.connection, { ...query, keyword: undefined })).items);
    },
    Boolean(options.forceRefresh),
  );
}

function invalidateInventoryCache(resolved: ReturnType<typeof resolveConnectionRequest>, hostId?: string) {
  inventoryCache.invalidate(buildInventoryCacheScope(resolved, { hostId }));
}

function scheduleInventoryRefresh(input: {
  resolved: ReturnType<typeof resolveConnectionRequest>;
  hostId?: string;
  changedVmIds?: string[];
  changedVmNames?: string[];
  deletedVmIds?: string[];
}) {
  if (!input.hostId) return;
  setTimeout(() => {
    void refreshInventoryAndPublish(input).catch((error) => {
      server.log.warn({ error, hostId: input.hostId, connectionId: input.resolved.connectionId }, "background inventory refresh failed");
    });
  }, 1500);
}

async function refreshInventoryAndPublish(input: {
  resolved: ReturnType<typeof resolveConnectionRequest>;
  hostId?: string;
  changedVmIds?: string[];
  changedVmNames?: string[];
  deletedVmIds?: string[];
}) {
  const hostId = input.hostId;
  if (!hostId) return;
  const [hostsResult, summaryResult, vmsResult] = await Promise.allSettled([
    loadHostInventoryCached(input.resolved, { forceRefresh: true }),
    loadVmSummaryCached(input.resolved, { hostId, page: 1, pageSize: 500, forceRefresh: true }),
    loadVmsCached(input.resolved, { hostId, page: 1, pageSize: 500, forceRefresh: true }),
  ]);
  if (hostsResult.status === "fulfilled") {
    const host = hostsResult.value.value.hosts.find((item) => item.providerId === hostId || item.id === hostId);
    if (host) {
      publishInventoryEvent({
        type: "host.patch",
        connectionId: input.resolved.connectionId,
        providerType: input.resolved.providerType,
        hostId,
        patch: host,
      });
    }
  }
  if (summaryResult.status === "fulfilled") {
    publishInventoryEvent({
      type: "summary.patch",
      connectionId: input.resolved.connectionId,
      providerType: input.resolved.providerType,
      hostId,
      summary: summaryResult.value.value,
    });
  }
  if (vmsResult.status !== "fulfilled") return;
  const changedVmIds = new Set(input.changedVmIds ?? []);
  const changedVmNames = new Set(input.changedVmNames ?? []);
  for (const vm of vmsResult.value.value.items) {
    if (changedVmIds.has(vm.providerId) || changedVmIds.has(vm.id) || changedVmNames.has(vm.name)) {
      publishInventoryEvent({
        type: "vm.upsert",
        connectionId: input.resolved.connectionId,
        providerType: input.resolved.providerType,
        hostId,
        vm,
      });
    }
  }
  for (const vmId of input.deletedVmIds ?? []) {
    if (!vmsResult.value.value.items.some((vm) => vm.providerId === vmId || vm.id === vmId)) {
      publishInventoryEvent({
        type: "vm.delete",
        connectionId: input.resolved.connectionId,
        providerType: input.resolved.providerType,
        hostId,
        vmId,
      });
    }
  }
}

function summarizeVmItems(items: VmNode[]): VmInventorySummary {
  const runningItems = items.filter((vm) => vm.powerState === "running");
  return {
    total: items.length,
    running: runningItems.length,
    halted: items.filter((vm) => vm.powerState === "halted").length,
    vcpu: items.reduce((sum, vm) => sum + vm.cpuCount, 0),
    runningVcpu: runningItems.reduce((sum, vm) => sum + vm.cpuCount, 0),
    memoryBytes: items.reduce((sum, vm) => sum + vm.memoryBytes, 0),
    runningMemoryBytes: runningItems.reduce((sum, vm) => sum + vm.memoryBytes, 0),
    diskBytes: items.reduce((sum, vm) => sum + Math.max(vm.diskVirtualBytes ?? 0, 0), 0),
  };
}

function vmActionLabel(action: "start" | "shutdown" | "forceReboot" | "delete") {
  if (action === "start") return "开机";
  if (action === "shutdown") return "关机";
  if (action === "forceReboot") return "强制重启";
  return "删除";
}

function buildProvisionRequestData(
  input: ProvisionPreflightInput | ProvisionVmsInput,
  providerType: ProviderType,
  connectionId: string | undefined,
  connectionHost: string,
): VmProvisionRequest {
  return {
    connectionId,
    providerType,
    hostId: input.hostId,
    environmentTemplateId: input.environmentTemplateId,
    sourceType: input.sourceType,
    installStrategy: input.installStrategy,
    isoId: input.isoId,
    isoName: input.isoName,
    templateName: input.templateName,
    specId: input.specId,
    vmNamePrefix: input.vmNamePrefix,
    count: input.count,
    ipPool: {
      ...input.ipPool,
      id: input.ipPool.id || `provision-${input.hostId || connectionHost}`,
    },
    autoStart: input.autoStart,
    planItems: input.planItems,
  };
}

async function runProvisionPreflight(
  provider: VirtualizationProvider<XenConnectionInput>,
  connection: XenConnectionInput,
  providerType: ProviderType,
  request: VmProvisionRequest,
  raw: ProvisionPreflightInput,
): Promise<ProvisionPreflightCheck[]> {
  const startedAt = Date.now();
  const timingContext = {
    providerType,
    hostId: request.hostId,
    vmCount: request.planItems.length,
  };
  const checks: ProvisionPreflightCheck[] = [];
  const validationErrors = validateProvisionPlan(providerType, request, raw);
  checks.push({
    key: "plan",
    label: "创建计划",
    status: validationErrors.length ? "error" : "success",
    message: validationErrors.length ? validationErrors.join("；") : `计划创建 ${request.planItems.length} 台 VM`,
  });

  const inventory = hasHostInventory(provider) ? await provider.collectHostInventory(connection).catch(() => undefined) : undefined;
  const hosts = inventory?.hosts ?? (await provider.listHosts(connection, { hostId: request.hostId }).catch(() => []));
  const targetHost = request.hostId ? hosts.find((host) => host.providerId === request.hostId || host.id === request.hostId) : hosts[0];
  server.log.info({ ...timingContext, phase: "preflight-host-inventory", elapsedMs: Date.now() - startedAt }, "provision preflight timing");
  checks.push({
    key: "host",
    label: "物理机",
    status: targetHost ? "success" : "warning",
    message: targetHost ? `${targetHost.name || targetHost.address} 可读取` : "未读取到目标物理机，创建时仍会由平台返回最终结果",
    details: targetHost
      ? {
          name: targetHost.name,
          address: targetHost.address,
          cpuCores: targetHost.cpuCores,
          memoryFreeBytes: targetHost.memoryFreeBytes,
        }
      : undefined,
  });
  const currentVmsPromise = measureProvisionPreflightCheck(timingContext, "vm-list", () =>
    provider.listVms(connection, { hostId: request.hostId, page: 1, pageSize: 1000 }),
  );
  const isoChecksPromise = measureProvisionPreflightCheck(timingContext, "iso", () => runProvisionIsoPreflight(provider, connection, providerType, request));
  const currentVms = await currentVmsPromise;
  checks.push(
    await measureProvisionPreflightCheck(timingContext, "resource", () =>
      runProvisionResourcePreflight(request, targetHost, inventory?.storage ?? [], currentVms.items),
    ),
  );

  const isoChecks = await isoChecksPromise;
  checks.push(...isoChecks);
  checks.push(runInstallSourcePreflight(request));
  checks.push(await measureProvisionPreflightCheck(timingContext, "vm-name", async () => runProvisionVmConflictPreflight(request, currentVms.items)));
  checks.push(await measureProvisionPreflightCheck(timingContext, "ip-conflict", async () => runProvisionIpConflictPreflight(request, currentVms.items)));
  checks.push(runProvisionIpLeasePreflight(request));
  checks.push(await measureProvisionPreflightCheck(timingContext, "ip-ping", () => runProvisionIpReachabilityPreflight(request)));
  server.log.info({ ...timingContext, phase: "preflight-total", elapsedMs: Date.now() - startedAt }, "provision preflight timing");

  return checks;
}

async function measureProvisionPreflightCheck<T>(
  context: Record<string, unknown>,
  phase: string,
  worker: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await worker();
    server.log.info({ ...context, phase: `preflight-${phase}`, elapsedMs: Date.now() - startedAt }, "provision preflight timing");
    return result;
  } catch (error) {
    server.log.warn({ ...context, phase: `preflight-${phase}`, elapsedMs: Date.now() - startedAt, error }, "provision preflight failed");
    throw error;
  }
}

function runProvisionResourcePreflight(
  request: VmProvisionRequest,
  targetHost: HostNode | undefined,
  storage: StorageRepository[],
  currentVms: VmNode[],
): Promise<ProvisionPreflightCheck> {
  if (!targetHost) {
    return Promise.resolve({
      key: "resource",
      label: "资源容量",
      status: "warning",
      message: "未读取到目标物理机，无法校验内存和存储余量",
    });
  }

  const plannedCpu = request.planItems.reduce((sum, item) => sum + Math.max(Math.floor(item.cpu), 1), 0);
  const plannedMemoryBytes = request.planItems.reduce((sum, item) => sum + Math.max(Math.floor(item.memoryGiB), 1), 0) * 1024 ** 3;
  const plannedDiskGiB = request.planItems.reduce((sum, item) => sum + Math.max(Math.floor(item.diskGiB), 1), 0);
  const runningVcpu = currentVms
    .filter((vm) => vm.powerState === "running")
    .reduce((sum, vm) => sum + Math.max(vm.cpuCount || 0, 0), 0);
  const memoryFreeBytes = Math.max(targetHost.memoryFreeBytes ?? 0, 0);
  const targetStorage = storage.filter((item) => !item.hostId || item.hostId === targetHost.providerId || item.hostId === targetHost.id);
  const vmStorage = request.providerType === "proxmox"
    ? targetStorage.filter((item) => !item.content?.length || item.content.includes("images") || item.content.includes("rootdir"))
    : targetStorage;
  const storagePhysicalGiB = vmStorage.reduce((sum, item) => sum + positiveNumber(item.physicalGiB), 0);
  const storageUsedGiB = vmStorage.reduce((sum, item) => sum + positiveNumber(item.usedGiB), 0);
  const storageFreeGiB = Math.max(storagePhysicalGiB - storageUsedGiB, 0);
  const storageFreeByRepository = vmStorage.map((item) => ({
    name: item.name,
    freeGiB: Math.max(positiveNumber(item.physicalGiB) - positiveNumber(item.usedGiB), 0),
  }));
  const largestStorageFreeGiB = storageFreeByRepository.reduce((max, item) => Math.max(max, item.freeGiB), 0);

  const errors: string[] = [];
  const warnings: string[] = [];
  if (memoryFreeBytes < plannedMemoryBytes) {
    errors.push(`内存余量不足：剩余 ${formatBytes(memoryFreeBytes)}，计划新增 ${formatBytes(plannedMemoryBytes)}`);
  }
  if (request.providerType === "proxmox" && storagePhysicalGiB > 0 && largestStorageFreeGiB < plannedDiskGiB) {
    const capacity = storageFreeByRepository
      .sort((left, right) => right.freeGiB - left.freeGiB)
      .map((item) => `${item.name} ${formatNumber(item.freeGiB)} GiB`)
      .join("、");
    errors.push(`没有单个 PVE 存储可容纳计划磁盘 ${formatNumber(plannedDiskGiB)} GiB；当前余量：${capacity}`);
  } else if (storagePhysicalGiB > 0 && storageFreeGiB < plannedDiskGiB) {
    errors.push(`存储余量不足：剩余 ${formatNumber(storageFreeGiB)} GiB，计划新增 ${formatNumber(plannedDiskGiB)} GiB`);
  } else if (storagePhysicalGiB <= 0) {
    warnings.push("未读取到存储容量，无法校验硬盘余量");
  }

  return Promise.resolve({
    key: "resource",
    label: "资源容量",
    status: errors.length ? "error" : warnings.length ? "warning" : "success",
    message: errors.length ? errors.join("；") : warnings.length ? warnings.join("；") : "内存和存储容量检查通过",
    details: {
      cpuCores: Math.max(targetHost.cpuCores || 0, 0),
      runningVcpu,
      plannedCpu,
      memoryFreeBytes,
      plannedMemoryBytes,
      storageFreeGiB,
      largestStorageFreeGiB,
      storageFreeByRepository,
      plannedDiskGiB,
    },
  });
}

function runInstallSourcePreflight(request: VmProvisionRequest): ProvisionPreflightCheck {
  if (!shouldUseXenKickstart(request)) {
    return {
      key: "install-source",
      label: "安装源",
      status: "success",
      message: "当前策略不需要集中安装源",
    };
  }
  return {
    key: "install-source",
    label: "安装源",
    status: "success",
    message: "统一由目标 XenServer 物理机发布任务级安装源",
  };
}

async function runProvisionIsoPreflight(
  provider: VirtualizationProvider<XenConnectionInput>,
  connection: XenConnectionInput,
  providerType: ProviderType,
  request: VmProvisionRequest,
): Promise<ProvisionPreflightCheck[]> {
  if (request.sourceType !== "iso") {
    return [
      {
        key: "source",
        label: "克隆源",
        status: request.templateName ? "success" : "warning",
        message: request.templateName ? `克隆源：${request.templateName}` : "未选择克隆源",
      },
    ];
  }
  if (!provider.listIsoImages) {
    return [
      {
        key: "iso",
        label: "系统镜像",
        status: providerType === "xenserver" ? "error" : "warning",
        message: `${providerLabel(providerType)} 当前 Provider 未提供镜像读取能力`,
      },
    ];
  }
  const images = await provider.listIsoImages(connection, { hostId: request.hostId }).catch(() => []);
  const selected = images.find((image) => image.providerId === request.isoId || image.id === request.isoId || image.name === request.isoName);
  return [
    {
      key: "iso",
      label: "系统镜像",
      status: selected ? "success" : "error",
      message: selected ? `已找到镜像：${selected.name}` : `未找到所选镜像：${request.isoName || request.isoId || "未选择"}`,
      details: selected
        ? {
            id: selected.providerId,
            name: selected.name,
            storageRepository: selected.storageRepository,
            path: selected.path,
          }
        : { available: images.slice(0, 20).map((image) => image.name) },
    },
  ];
}

function runProvisionVmConflictPreflight(
  request: VmProvisionRequest,
  currentVms: VmNode[],
): Promise<ProvisionPreflightCheck> {
  const names = new Set(request.planItems.map((item) => item.name.trim()).filter(Boolean));
  const conflicts = currentVms.filter((vm) => names.has(vm.name)).map((vm) => `${vm.name} (${vm.powerState})`);
  return Promise.resolve({
    key: "vm-name",
    label: "VM 名称",
    status: conflicts.length ? "error" : "success",
    message: conflicts.length ? `发现同名 VM：${conflicts.join("、")}` : "未发现同名 VM",
  });
}

function runProvisionIpConflictPreflight(
  request: VmProvisionRequest,
  currentVms: VmNode[],
): Promise<ProvisionPreflightCheck> {
  const ips = new Set(request.planItems.map((item) => item.ip.trim()).filter(isIpv4));
  const conflicts = currentVms.flatMap((vm) =>
    vm.ipAddresses.filter((ip) => ips.has(ip)).map((ip) => `${ip}：${vm.name} (${vm.powerState})`),
  );
  return Promise.resolve({
    key: "ip",
    label: "IP 占用",
    status: conflicts.length ? "error" : "success",
    message: conflicts.length ? `发现已占用 IP：${conflicts.join("、")}` : "目标平台清单内未发现 IP 占用",
  });
}

function runProvisionIpLeasePreflight(request: VmProvisionRequest): ProvisionPreflightCheck {
  const targetIps = new Set(request.planItems.map((item) => item.ip.trim()).filter(isIpv4));
  const conflicts = listIpLeases()
    .filter((lease) => targetIps.has(lease.ip))
    .map((lease) => `${lease.ip}：${lease.vmName}`);
  return {
    key: "ip-lease",
    label: "本地 IP 租约",
    status: conflicts.length ? "error" : "success",
    message: conflicts.length ? `本地已预留：${conflicts.join("、")}` : "本地未发现 IP 预留冲突",
  };
}

async function runProvisionIpReachabilityPreflight(request: VmProvisionRequest): Promise<ProvisionPreflightCheck> {
  const ips = Array.from(new Set(request.planItems.map((item) => item.ip.trim()).filter(isIpv4)));
  const results = await mapWithConcurrency(ips, 8, async (ip) => ({
    ip,
    reachable: await pingIp(ip, 900),
  }));
  const reachableIps = results.filter((item) => item.reachable).map((item) => item.ip);
  return {
    key: "ip-ping",
    label: "IP 探测",
    status: reachableIps.length ? "warning" : "success",
    message: reachableIps.length ? `以下 IP ping 有响应：${reachableIps.join("、")}` : "目标 IP ping 无响应",
  };
}

function validateProvisionPlan(providerType: ProviderType, request: VmProvisionRequest, raw: { templateName?: string }): string[] {
  const errors: string[] = [];
  if (request.count !== request.planItems.length) {
    errors.push(`创建数量与 VM 计划不一致：数量 ${request.count}，计划 ${request.planItems.length} 台`);
  }
  const names = new Set<string>();
  const ips = new Set<string>();
  for (const item of request.planItems) {
    const name = item.name.trim();
    const ip = item.ip.trim();
    if (!name) errors.push("VM 名称不能为空");
    if (names.has(name)) errors.push(`VM 名称重复：${name}`);
    names.add(name);
    if (!isIpv4(ip)) errors.push(`VM IP 格式不正确：${ip || item.name}`);
    if (ips.has(ip)) errors.push(`VM IP 重复：${ip}`);
    ips.add(ip);
    if (request.autoStart && !item.rootPassword?.trim()) {
      errors.push(`缺少 ${item.name} 的登录密码，无法完成启动后的 SSH 验收`);
    }
  }
  if (providerType === "xenserver") {
    if (request.sourceType !== "iso") {
      errors.push("XenServer 当前一键安装必须使用 ISO/Kickstart 策略");
    }
    if (!request.isoId?.trim()) {
      errors.push("XenServer 一键安装必须选择系统 ISO");
    }
    if (!request.ipPool.gateway.trim() || !isIpv4(request.ipPool.gateway)) {
      errors.push("XenServer 一键安装必须配置有效网关");
    }
    if (!request.ipPool.dns.some((item) => isIpv4(item))) {
      errors.push("XenServer 一键安装必须配置有效 DNS");
    }
    if (!request.ipPool.cidr.includes("/")) {
      errors.push("XenServer 一键安装必须配置 CIDR，用于生成静态 IP 子网掩码");
    }
  }
  if ((providerType === "vmware" || providerType === "proxmox") && request.sourceType === "template" && !raw.templateName?.trim()) {
    errors.push(`${providerLabel(providerType)} 模板克隆必须选择克隆源`);
  }
  return Array.from(new Set(errors));
}

async function pingIp(ip: string, timeoutMs: number): Promise<boolean> {
  const args =
    process.platform === "win32"
      ? ["-n", "1", "-w", String(timeoutMs), ip]
      : process.platform === "darwin"
        ? ["-c", "1", "-W", String(timeoutMs), ip]
        : ["-c", "1", "-W", String(Math.max(1, Math.ceil(timeoutMs / 1000))), ip];
  try {
    await execFileAsync("ping", args, { timeout: timeoutMs + 500 });
    return true;
  } catch {
    return false;
  }
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await worker(items[index]);
      }
    }),
  );
  return results;
}

function isIpv4(value: string | undefined) {
  if (!value) return false;
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

function positiveNumber(value: number | undefined): number {
  return Number.isFinite(value) && value !== undefined && value > 0 ? value : 0;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(value);
}

function formatBytes(value: number): string {
  const gib = value / 1024 ** 3;
  if (gib >= 1) return `${formatNumber(gib)} GiB`;
  const mib = value / 1024 ** 2;
  return `${formatNumber(mib)} MiB`;
}

function parseLastEventId(value: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function ipv4ToNumber(ip: string): number {
  return ip.split(".").reduce((sum, part) => (sum << 8) + Number(part), 0) >>> 0;
}

function cidrContainsIp(cidr: string | undefined, ip: string): boolean {
  if (!cidr || !isIpv4(ip)) return false;
  const [network, rawPrefix] = cidr.split("/");
  if (!isIpv4(network)) return false;
  const prefix = Number(rawPrefix);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4ToNumber(network) & mask) === (ipv4ToNumber(ip) & mask);
}

function sameIpv4Subnet(left: string, right: string, prefix: number): boolean {
  return cidrContainsIp(`${left}/${prefix}`, right);
}

function providerLabel(providerType: ProviderType): string {
  if (providerType === "xenserver") return "XenServer";
  if (providerType === "vmware") return "VMware";
  if (providerType === "proxmox") return "Proxmox VE";
  return providerType;
}

function toClientErrorMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("未注册虚拟化平台 Provider")) {
    return `${message}。当前初版已接入 XenServer 和 VMware，PVE / libvirt 将按同一 Provider 接口接入。`;
  }
  if (message.includes("self-signed certificate") || message.includes("certificate")) {
    return "VMware HTTPS 证书校验失败。当前已按内网自签证书场景跳过校验，请确认目标地址和端口是否正确。";
  }
  if (message.includes("ECONNRESET") || message.includes("socket hang up")) {
    return "VMware API 连接被断开，请确认端口是否为 443，目标是否开启 ESXi/vCenter HTTPS API。";
  }
  if (message.includes("ToolsUnavailable") || message.includes("VMware Tools is not running")) {
    return "VMware Tools 未运行或未安装，无法执行优雅关机。请先在系统内关机，或安装/启动 VMware Tools 后再重试。";
  }
  if (message.includes("Proxmox VE")) {
    return message;
  }
  if (message.includes("All configured authentication methods failed") || message.includes("client-authentication")) {
    return "账号或密码认证失败。请确认密码没有少输、多输空格，或被浏览器自动填充覆盖。";
  }
  if (message.includes("Timed out while waiting for handshake") || message.includes("readyTimeout")) {
    return "SSH 握手超时，请确认主机地址、端口和网络连通。";
  }
  if (message.includes("ECONNREFUSED")) {
    return "SSH 端口被拒绝，请确认端口是否为 22。";
  }
  return message || fallback;
}
