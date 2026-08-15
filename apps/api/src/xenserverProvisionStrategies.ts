import type { ProvisionProgressReporter } from "./providers/provider.js";
import {
  prepareXenCentosUnattendedIso,
  prepareXenUbuntuAutoinstallIso,
  prepareXenWindowsUnattendIso,
  resolveXenInstallMediaMode,
} from "./xenserverUnattendedIso.js";
import type { XenInstallMediaMode, XenUnattendedIsoInput, XenUnattendedIsoResult } from "./xenserverUnattendedIso.js";
import type { IsoImage, VmProvisionPlanItem, VmProvisionRequest, XenConnectionInput } from "./types.js";
import { isRedHatFamilyImage } from "./centosKickstart.js";

export interface XenInstallStrategyContext {
  connection: XenConnectionInput;
  request: VmProvisionRequest;
  item: VmProvisionPlanItem;
  sourceIsoName: string;
  sourceType: IsoImage["sourceType"];
  macAddress: string;
  reporter?: ProvisionProgressReporter;
}

export interface XenPreparedInstallMedia {
  installMediaMode: XenInstallMediaMode;
  unattended: boolean;
  requiresInstallSource: boolean;
  originalIsoId: string;
  originalIsoName: string;
  auxiliaryIsoId?: string;
  auxiliaryIsoName?: string;
  generatedIsoRegistryId?: string;
}

interface XenInstallStrategy {
  id: string;
  matches(context: XenInstallStrategyContext): boolean;
  prepare(context: XenInstallStrategyContext): Promise<XenPreparedInstallMedia>;
}

class XenInstallStrategyRegistry {
  private readonly strategies: XenInstallStrategy[] = [];

  register(strategy: XenInstallStrategy): void {
    this.strategies.push(strategy);
  }

  resolve(context: XenInstallStrategyContext): XenInstallStrategy {
    const strategy = this.strategies.find((candidate) => candidate.matches(context));
    if (!strategy) throw new Error(`XenServer 未找到匹配的安装策略：${context.sourceIsoName}`);
    return strategy;
  }
}

const xenInstallStrategies = new XenInstallStrategyRegistry();

xenInstallStrategies.register({
  id: "windows-config-iso",
  matches: ({ request, sourceIsoName }) => request.sourceType === "iso" && request.installStrategy === "windows-unattended" && isWindowsImage(sourceIsoName),
  prepare: async (context) => {
    const generated = await prepareWindowsConfigIso(context);
    return {
      installMediaMode: "windows-unattended",
      unattended: true,
      requiresInstallSource: false,
      originalIsoId: context.request.isoId || "",
      originalIsoName: context.sourceIsoName,
      auxiliaryIsoId: generated.isoId,
      auxiliaryIsoName: generated.isoName,
      generatedIsoRegistryId: generated.registryId,
    };
  },
});

xenInstallStrategies.register({
  id: "redhat-kickstart",
  matches: ({ request, sourceIsoName }) => request.sourceType === "iso" && isRedHatFamilyImage(sourceIsoName),
  prepare: async (context) => {
    const mediaMode = resolveCentosMediaMode(context);
    const generated = shouldPrepareXenSmallIso(mediaMode)
      ? await prepareCentosSmallIso(context)
      : undefined;
    return {
      installMediaMode: mediaMode,
      unattended: true,
      requiresInstallSource: mediaMode === "native-http" || mediaMode === "http-boot-iso" || mediaMode === "cdrom-http-ks",
      originalIsoId: context.request.isoId || "",
      originalIsoName: context.sourceIsoName,
      auxiliaryIsoId: generated?.isoId,
      auxiliaryIsoName: generated?.isoName,
      generatedIsoRegistryId: generated?.registryId,
    };
  },
});

xenInstallStrategies.register({
  id: "ubuntu-autoinstall",
  matches: ({ request, sourceIsoName }) => request.sourceType === "iso" && request.installStrategy === "ubuntu-autoinstall" && isUbuntuImage(sourceIsoName),
  prepare: async (context) => {
    const generated = await prepareUbuntuAutoinstallIso(context);
    return {
      installMediaMode: "ubuntu-autoinstall",
      unattended: true,
      requiresInstallSource: false,
      originalIsoId: context.request.isoId || "",
      originalIsoName: context.sourceIsoName,
      auxiliaryIsoId: generated.isoId,
      auxiliaryIsoName: generated.isoName,
      generatedIsoRegistryId: generated.registryId,
    };
  },
});

xenInstallStrategies.register({
  id: "manual-iso",
  matches: () => true,
  prepare: async ({ request, sourceIsoName }) => ({
    installMediaMode: resolveXenInstallMediaMode(),
    unattended: false,
    requiresInstallSource: false,
    originalIsoId: request.isoId || "",
    originalIsoName: sourceIsoName,
  }),
});

export function resolveXenInstallStrategy(context: XenInstallStrategyContext): XenInstallStrategy {
  return xenInstallStrategies.resolve(context);
}

export async function prepareXenInstallMedia(context: XenInstallStrategyContext): Promise<XenPreparedInstallMedia> {
  return resolveXenInstallStrategy(context).prepare(context);
}

function isWindowsImage(name: string): boolean {
  return /windows|winserver|win[_ -]?server/i.test(name);
}

function isUbuntuImage(name: string): boolean {
  return /ubuntu/i.test(name);
}

function resolveCentosMediaMode(context: XenInstallStrategyContext): XenInstallMediaMode {
  return context.sourceType === "host-dvd" ? "native-http" : resolveXenInstallMediaMode();
}

function shouldPrepareXenSmallIso(mode: XenInstallMediaMode): boolean {
  return mode === "http-boot-iso" || mode === "offline-iso";
}

async function prepareWindowsConfigIso(context: XenInstallStrategyContext): Promise<XenUnattendedIsoResult> {
  return prepareXenWindowsUnattendIso(toIsoInput(context));
}

async function prepareCentosSmallIso(context: XenInstallStrategyContext): Promise<XenUnattendedIsoResult> {
  return prepareXenCentosUnattendedIso(toIsoInput(context));
}

async function prepareUbuntuAutoinstallIso(context: XenInstallStrategyContext): Promise<XenUnattendedIsoResult> {
  return prepareXenUbuntuAutoinstallIso(toIsoInput(context));
}

function toIsoInput(context: XenInstallStrategyContext): XenUnattendedIsoInput {
  return {
    connection: context.connection,
    connectionId: context.request.connectionId,
    taskId: context.request.taskId,
    sourceIsoId: context.request.isoId || "",
    sourceIsoName: context.sourceIsoName,
    installProfile: context.request.installProfile ?? (isWindowsImage(context.sourceIsoName) || isUbuntuImage(context.sourceIsoName) ? "desktop" : "server"),
    hostId: context.request.hostId,
    vm: context.item,
    ipPool: context.request.ipPool,
    macAddress: context.macAddress,
    installSource: context.item.installSource,
    onProgress: (message) => {
      context.reporter?.markStep("create-vm", "running", `${context.item.name}：${message}`);
      context.reporter?.updateVm(context.item.name, {
        status: "running",
        currentStep: "create-vm",
        message,
      });
    },
  };
}
