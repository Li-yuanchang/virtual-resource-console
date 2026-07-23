import type { ProviderType } from "../types";

export interface ProviderBrand {
  type: ProviderType | "default";
  mark: string;
  consoleName: string;
  resourceName: string;
}

const providerBrands: Record<ProviderType, ProviderBrand> = {
  xenserver: { type: "xenserver", mark: "XEN", consoleName: "XenServer Console", resourceName: "XenServer" },
  vmware: { type: "vmware", mark: "VMW", consoleName: "VMware Console", resourceName: "VMware" },
  proxmox: { type: "proxmox", mark: "PVE", consoleName: "Proxmox VE Console", resourceName: "Proxmox VE" },
  libvirt: { type: "libvirt", mark: "KVM", consoleName: "KVM Console", resourceName: "KVM/libvirt" },
};

export function getProviderBrand(providerType?: ProviderType): ProviderBrand {
  return providerType
    ? providerBrands[providerType]
    : { type: "default", mark: "VRC", consoleName: "Virtual Console", resourceName: "虚拟化平台" };
}
