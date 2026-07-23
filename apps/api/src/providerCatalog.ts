import type { ProviderDescriptor, ProviderType } from "./types.js";

const unsupportedLibvirt = {
  supported: false,
  reasonCode: "PROVIDER_NOT_REGISTERED",
  message: "KVM/libvirt Provider 尚未接入当前服务",
} as const;

const descriptors: Record<ProviderType, ProviderDescriptor> = {
  xenserver: {
    type: "xenserver",
    label: "XenServer",
    defaultPort: 22,
    networkInterfaceLabel: "PIF",
    capabilities: {
      inventory: { supported: true },
      isoLibrary: {
        supported: true,
        emptyMessage: "未读取到本机 DVD 或 XenServer ISO 库",
        actionHint: "请检查物理光驱介质及 NFS/SMB ISO Library",
      },
      vmCreate: { supported: true },
      vmRename: {
        supported: true,
        maxLength: 128,
        duplicateScope: "当前资源池",
        effect: "更新平台清单中的虚拟机显示名称",
      },
      vmResize: { supported: true },
      vmConsole: { supported: true },
      provisioningNetworkProbe: { supported: true },
    },
  },
  vmware: {
    type: "vmware",
    label: "VMware",
    defaultPort: 443,
    networkInterfaceLabel: "VMkernel 网卡",
    capabilities: {
      inventory: { supported: true },
      isoLibrary: {
        supported: true,
        emptyMessage: "未在 Datastore Browser 中搜索到 ISO",
        actionHint: "请确认数据存储权限和镜像目录",
      },
      vmCreate: { supported: true },
      vmRename: {
        supported: true,
        maxLength: 80,
        duplicateScope: "当前 VM 文件夹",
        effect: "只修改 vSphere 清单名称，不移动数据存储目录，也不重命名 VMX/VMDK 文件",
      },
      vmResize: { supported: true },
      vmConsole: { supported: true },
      provisioningNetworkProbe: { supported: true },
    },
  },
  proxmox: {
    type: "proxmox",
    label: "Proxmox VE",
    defaultPort: 8006,
    networkInterfaceLabel: "网络接口",
    capabilities: {
      inventory: { supported: true },
      isoLibrary: {
        supported: true,
        emptyMessage: "未读取到启用 ISO 内容类型的存储",
        actionHint: "请确认目标 PVE 存储已启用 content=iso",
      },
      vmCreate: { supported: true },
      vmRename: {
        supported: true,
        maxLength: 63,
        pattern: "^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$",
        patternMessage: "Proxmox VE 名称只能使用字母、数字、点或连字符，且首尾必须为字母或数字",
        duplicateScope: "当前 PVE 节点",
        effect: "更新 QEMU 配置名称，VMID 保持不变",
      },
      vmResize: { supported: true },
      vmConsole: { supported: true },
      provisioningNetworkProbe: { supported: true },
    },
  },
  libvirt: {
    type: "libvirt",
    label: "KVM/libvirt",
    defaultPort: 22,
    networkInterfaceLabel: "网络接口",
    capabilities: {
      inventory: { ...unsupportedLibvirt },
      isoLibrary: {
        ...unsupportedLibvirt,
        emptyMessage: "当前服务未启用 KVM/libvirt 镜像读取能力",
      },
      vmCreate: { ...unsupportedLibvirt },
      vmRename: {
        ...unsupportedLibvirt,
        maxLength: 128,
        duplicateScope: "当前虚拟化主机",
        effect: "当前版本不执行改名",
      },
      vmResize: { ...unsupportedLibvirt },
      vmConsole: { ...unsupportedLibvirt },
      provisioningNetworkProbe: { ...unsupportedLibvirt },
    },
  },
};

export function listProviderDescriptors(): ProviderDescriptor[] {
  return Object.values(descriptors).map(cloneProviderDescriptor);
}

export function getProviderDescriptor(providerType: ProviderType): ProviderDescriptor {
  return cloneProviderDescriptor(descriptors[providerType]);
}

export function defaultPortForProvider(providerType: ProviderType): number {
  return descriptors[providerType].defaultPort;
}

export function providerLabel(providerType: ProviderType): string {
  return descriptors[providerType].label;
}

function cloneProviderDescriptor(descriptor: ProviderDescriptor): ProviderDescriptor {
  return {
    ...descriptor,
    capabilities: {
      ...descriptor.capabilities,
      inventory: { ...descriptor.capabilities.inventory },
      isoLibrary: { ...descriptor.capabilities.isoLibrary },
      vmCreate: { ...descriptor.capabilities.vmCreate },
      vmRename: { ...descriptor.capabilities.vmRename },
      vmResize: { ...descriptor.capabilities.vmResize },
      vmConsole: { ...descriptor.capabilities.vmConsole },
      provisioningNetworkProbe: { ...descriptor.capabilities.provisioningNetworkProbe },
    },
  };
}
