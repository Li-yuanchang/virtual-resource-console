import type { ProviderType, StoredConnectionSummary, VmNode } from "../types";

export interface NoVncVmConsoleTarget {
  mode: "novnc";
  wsUrl?: string;
  prepareUrl?: string;
  connectionId?: string;
  vmId?: string;
  label: string;
  title: string;
  vmName: string;
  vmIp?: string;
  hostName?: string;
  hostAddress?: string;
  powerStateLabel?: string;
  cpuText?: string;
  memoryText?: string;
  diskText?: string;
  providerType: ProviderType;
  aspectRatio?: number;
}

export type VmConsoleTarget = NoVncVmConsoleTarget;

export interface VmConsoleContext {
  connection: Pick<StoredConnectionSummary, "id" | "providerType" | "host" | "port" | "username">;
  vm: VmNode;
  hostName?: string;
  hostAddress?: string;
}

interface VmConsoleStrategy {
  readonly type: ProviderType;
  resolve(context: VmConsoleContext): VmConsoleTarget | null;
}

const strategies: VmConsoleStrategy[] = [
  {
    type: "vmware",
    resolve({ connection, vm }) {
      const managedObjectId = getMetadataString(vm, "managedObjectId");
      if (!connection.id || !managedObjectId || vm.powerState !== "running") return null;
      return {
        mode: "novnc",
        prepareUrl: "/api/console/vmware/session",
        wsUrl: buildApiWebSocketUrl("/api/console/vmware"),
        label: "打开控制台",
        title: "打开 VMware WebMKS 控制台",
        vmName: vm.name,
        ...buildConsoleSummary({ vm, hostName: connection.host, hostAddress: connection.host }),
        providerType: "vmware",
        aspectRatio: 4 / 3,
        connectionId: connection.id,
        vmId: managedObjectId,
      };
    },
  },
  {
    type: "proxmox",
    resolve({ connection, vm }) {
      const [node, vmid] = parseProxmoxVmId(vm.providerId);
      if (!connection.id || !node || !vmid || vm.powerState !== "running") return null;
      return {
        mode: "novnc",
        prepareUrl: "/api/console/proxmox/session",
        wsUrl: buildApiWebSocketUrl("/api/console/proxmox"),
        label: "打开控制台",
        title: "打开 Proxmox VE noVNC 控制台",
        vmName: vm.name,
        ...buildConsoleSummary({ vm, hostName: connection.host, hostAddress: connection.host }),
        providerType: "proxmox",
        aspectRatio: 4 / 3,
        connectionId: connection.id,
        vmId: vm.providerId,
      };
    },
  },
  {
    type: "xenserver",
    resolve({ connection, vm }) {
      if (!connection.id || vm.powerState !== "running") return null;
      return {
        mode: "novnc",
        wsUrl: buildApiWebSocketUrl(
          `/api/console/xenserver?connectionId=${encodeURIComponent(connection.id)}&vmId=${encodeURIComponent(vm.providerId)}`,
        ),
        label: "打开控制台",
        title: "打开 XenServer noVNC 控制台",
        vmName: vm.name,
        ...buildConsoleSummary({ vm, hostName: connection.host, hostAddress: connection.host }),
        providerType: "xenserver",
        aspectRatio: 4 / 3,
        connectionId: connection.id,
        vmId: vm.providerId,
      };
    },
  },
  {
    type: "libvirt",
    resolve() {
      return null;
    },
  },
];

export function resolveVmConsoleTarget(context: VmConsoleContext): VmConsoleTarget | null {
  const target = strategies.find((strategy) => strategy.type === context.connection.providerType)?.resolve(context) ?? null;
  if (!target) return null;
  return {
    ...target,
    ...buildConsoleSummary(context),
  };
}

function buildConsoleSummary(context: Pick<VmConsoleContext, "vm" | "hostName" | "hostAddress">) {
  return {
    vmIp: context.vm.ipAddresses[0] || "-",
    hostName: context.hostName || context.hostAddress || "-",
    hostAddress: context.hostAddress,
    powerStateLabel: powerStateLabel(context.vm.powerState),
    cpuText: context.vm.cpuCount > 0 ? `${context.vm.cpuCount}C` : "-",
    memoryText: formatBytes(context.vm.memoryBytes),
    diskText: formatBytes(context.vm.diskVirtualBytes ?? 0),
  };
}

function powerStateLabel(value: VmNode["powerState"]) {
  if (value === "running") return "运行中";
  if (value === "halted" || value === "stopped") return "已关机";
  if (value === "suspended") return "已暂停";
  return "未知";
}

function formatBytes(value: number) {
  if (!Number.isFinite(value)) return "-";
  const gib = value / 1024 / 1024 / 1024;
  if (gib >= 1) return `${formatNumber(gib)}GiB`;
  return `${formatNumber(value / 1024 / 1024)}MiB`;
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(value);
}

function parseProxmoxVmId(providerId: string): [string, string] {
  const parts = providerId.split(":");
  if (parts.length < 2) return ["", ""];
  return [parts[0], parts[1]];
}

function getMetadataString(vm: VmNode, key: string): string {
  const value = vm.metadata?.[key];
  return typeof value === "string" ? value : "";
}

function buildApiWebSocketUrl(path: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.hostname || "127.0.0.1";
  const port = window.location.port === "5173" ? "3987" : window.location.port;
  const authority = port ? `${host}:${port}` : host;
  return `${protocol}//${authority}${path}`;
}
