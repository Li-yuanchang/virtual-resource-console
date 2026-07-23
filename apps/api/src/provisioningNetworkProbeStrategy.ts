import { probeXenProvisioningNetwork } from "./installSourceService.js";
import type { ProviderType, XenConnectionInput } from "./types.js";

export interface ProvisioningNetworkProbeInput {
  connection: XenConnectionInput;
  hostId?: string;
  network?: {
    cidr: string;
    gateway: string;
    sampleIp: string;
  };
  occupiedIps: string[];
}

export interface ProvisioningNetworkProbeResult {
  status: "reachable" | "route-only" | "unreachable";
  message: string;
  installHost?: string;
  routeAvailable: boolean;
  gatewayReachable: boolean;
  respondingTarget?: string;
}

interface ProvisioningNetworkProbeStrategy {
  readonly providerType: ProviderType;
  probe(input: ProvisioningNetworkProbeInput): Promise<ProvisioningNetworkProbeResult | undefined>;
}

class NoopProvisioningNetworkProbeStrategy implements ProvisioningNetworkProbeStrategy {
  constructor(readonly providerType: ProviderType) {}

  async probe(): Promise<undefined> {
    return undefined;
  }
}

class XenServerProvisioningNetworkProbeStrategy implements ProvisioningNetworkProbeStrategy {
  readonly providerType = "xenserver" as const;

  async probe(input: ProvisioningNetworkProbeInput): Promise<ProvisioningNetworkProbeResult | undefined> {
    if (!input.hostId || !input.network) return undefined;
    return probeXenProvisioningNetwork({
      connection: input.connection,
      hostId: input.hostId,
      cidr: input.network.cidr,
      gateway: input.network.gateway,
      sampleIp: input.network.sampleIp,
      occupiedIps: input.occupiedIps,
    });
  }
}

const strategies = new Map<ProviderType, ProvisioningNetworkProbeStrategy>([
  ["xenserver", new XenServerProvisioningNetworkProbeStrategy()],
  ["vmware", new NoopProvisioningNetworkProbeStrategy("vmware")],
  ["proxmox", new NoopProvisioningNetworkProbeStrategy("proxmox")],
  ["libvirt", new NoopProvisioningNetworkProbeStrategy("libvirt")],
]);

export function resolveProvisioningNetworkProbeStrategy(providerType: ProviderType): ProvisioningNetworkProbeStrategy {
  const strategy = strategies.get(providerType);
  if (!strategy) throw new Error(`未注册创建网络探测策略：${providerType}`);
  return strategy;
}
