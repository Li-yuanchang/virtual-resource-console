import type { ProviderType } from "./types.js";

export interface GuestMonitoringPolicy {
  providerType: ProviderType;
  label: string;
  packageName?: string;
  serviceName?: string;
  processName?: string;
  guestInstallCommand?: string;
  hostPreparation: "xen-tools-iso" | "pve-agent-config" | "none";
  platformVerification: "xenserver-tools" | "pve-agent" | "vmware-tools" | "none";
}

const policies: Partial<Record<ProviderType, GuestMonitoringPolicy>> = {
  xenserver: {
    providerType: "xenserver",
    label: "XenServer Guest Tools",
    hostPreparation: "xen-tools-iso",
    platformVerification: "xenserver-tools",
  },
  proxmox: packagePolicy("proxmox", "qemu-guest-agent", "qemu-guest-agent", "qemu-ga", "pve-agent-config", "pve-agent"),
  vmware: packagePolicy("vmware", "open-vm-tools", "vmtoolsd", "vmtoolsd", "none", "vmware-tools"),
};

export function resolveGuestMonitoringPolicy(providerType: ProviderType): GuestMonitoringPolicy {
  return policies[providerType] ?? {
    providerType,
    label: "Guest 监控工具",
    hostPreparation: "none",
    platformVerification: "none",
  };
}

function packagePolicy(
  providerType: ProviderType,
  packageName: string,
  serviceName: string,
  processName: string,
  hostPreparation: GuestMonitoringPolicy["hostPreparation"],
  platformVerification: GuestMonitoringPolicy["platformVerification"],
): GuestMonitoringPolicy {
  return {
    providerType,
    label: packageName,
    packageName,
    serviceName,
    processName,
    hostPreparation,
    platformVerification,
    guestInstallCommand: buildPackageInstallCommand(packageName, serviceName, processName),
  };
}

function buildPackageInstallCommand(packageName: string, serviceName: string, processName: string): string {
  return `
set -e
package='${packageName}'
if command -v rpm >/dev/null 2>&1; then
  rpm -q "$package" >/dev/null 2>&1 || {
    if command -v dnf >/dev/null 2>&1; then dnf -y install "$package"; else yum -y install "$package"; fi
  }
elif command -v dpkg-query >/dev/null 2>&1; then
  dpkg-query -W "$package" >/dev/null 2>&1 || { apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y "$package"; }
else
  echo "无法识别 Guest 包管理器，不能安装 $package" >&2
  exit 7
fi
if command -v systemctl >/dev/null 2>&1; then
  systemctl enable '${serviceName}' >/dev/null 2>&1 || true
  systemctl restart --no-block '${serviceName}'
  for attempt in $(seq 1 20); do
    systemctl is-active --quiet '${serviceName}' && break
    sleep 1
  done
  systemctl is-active --quiet '${serviceName}'
else
  service '${serviceName}' restart
fi
pgrep -x '${processName}' >/dev/null || pgrep -f '${processName}' >/dev/null || { echo "${packageName} 进程未运行" >&2; exit 8; }
`;
}
