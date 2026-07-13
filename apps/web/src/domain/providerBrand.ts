import type { ProviderType } from "../types";

export interface ProviderBrand {
  type: ProviderType | "default";
  mark: string;
  consoleName: string;
  resourceName: string;
}

export function getProviderBrand(providerType?: ProviderType): ProviderBrand {
  switch (providerType) {
    case "vmware":
      return { type: "vmware", mark: "VMW", consoleName: "VMware Console", resourceName: "VMware" };
    case "proxmox":
      return { type: "proxmox", mark: "PVE", consoleName: "Proxmox VE Console", resourceName: "Proxmox VE" };
    case "xenserver":
      return { type: "xenserver", mark: "XEN", consoleName: "XenServer Console", resourceName: "XenServer" };
    default:
      return { type: "default", mark: "VRC", consoleName: "Virtual Console", resourceName: "虚拟化平台" };
  }
}
