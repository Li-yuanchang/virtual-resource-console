import type { ProviderType, StorageRepository } from "./types.js";

export interface NativeStorageRepositoryProfile {
  type: string;
  shared: boolean;
  content?: string[];
}

/**
 * Converts provider storage driver metadata into platform-neutral labels.
 * Media remains unknown unless the provider returns real device evidence;
 * storage names and driver types are not reliable SSD/HDD indicators.
 */
export function describeStorageRepository(
  providerType: ProviderType,
  repository: NativeStorageRepositoryProfile,
): Pick<StorageRepository, "typeLabel" | "purposeLabel" | "scopeLabel" | "mediaLabel"> {
  const type = repository.type.trim().toLowerCase();
  return {
    typeLabel: storageTypeLabel(providerType, type),
    purposeLabel: storagePurposeLabel(providerType, type, repository.content ?? []),
    scopeLabel: repository.shared ? "共享存储" : "本机存储",
    mediaLabel: type === "iso" || type === "udev" ? "不适用" : "平台未返回",
  };
}

function storageTypeLabel(providerType: ProviderType, type: string): string {
  if (providerType === "xenserver") {
    const xenLabels: Record<string, string> = {
      lvmohba: "HBA 块存储",
      lvmoiscsi: "iSCSI 块存储",
      lvm: "LVM 块存储",
      ext: "本地文件存储",
      nfs: "NFS 文件存储",
      iso: "ISO 镜像库",
      udev: "可移动设备",
      smb: "SMB 文件存储",
      cifs: "SMB 文件存储",
    };
    return xenLabels[type] ?? "其他存储池";
  }
  if (providerType === "proxmox") {
    const proxmoxLabels: Record<string, string> = {
      dir: "目录存储",
      lvm: "LVM 块存储",
      lvmthin: "LVM Thin 存储",
      zfspool: "ZFS 存储池",
      nfs: "NFS 文件存储",
      cifs: "SMB 文件存储",
      rbd: "Ceph RBD 存储",
      cephfs: "CephFS 存储",
      pbs: "Proxmox 备份存储",
    };
    return proxmoxLabels[type] ?? "其他存储池";
  }
  if (providerType === "vmware") {
    const vmwareLabels: Record<string, string> = {
      vmfs: "VMFS 数据存储",
      nfs: "NFS 数据存储",
      nfs41: "NFS 4.1 数据存储",
      vsan: "vSAN 数据存储",
      vvol: "vVol 数据存储",
    };
    return vmwareLabels[type] ?? "VMware 数据存储";
  }
  return "存储池";
}

function storagePurposeLabel(providerType: ProviderType, type: string, rawContent: string[]): string {
  if (providerType === "xenserver") {
    if (type === "iso") return "ISO 镜像";
    if (type === "udev") return "可移动介质";
    if (["lvmohba", "lvmoiscsi", "lvm", "ext", "nfs", "smb", "cifs"].includes(type)) return "VM 磁盘";
    return "其他用途";
  }
  if (providerType === "vmware") return "VM 磁盘";
  if (providerType === "proxmox") {
    const content = new Set(rawContent.map((item) => item.trim().toLowerCase()));
    const supportsVmDisks = content.has("images") || content.has("rootdir");
    const supportsIso = content.has("iso");
    const supportsBackup = content.has("backup");
    const purposeCount = Number(supportsVmDisks) + Number(supportsIso) + Number(supportsBackup);
    if (purposeCount > 1) return "混合用途";
    if (supportsVmDisks) return "VM 磁盘";
    if (supportsIso) return "ISO 镜像";
    if (supportsBackup) return "备份存储";
  }
  return "其他用途";
}
