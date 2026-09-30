export interface IpReachabilityPreflightResult {
  status: "success" | "error";
  message: string;
}

export interface IpLeasePreflightResult {
  status: "success" | "error";
  message: string;
}

/**
 * Converts live IP reachability results into a blocking provisioning decision.
 * A responding address is treated as occupied because VRC must never assign it to a new VM.
 *
 * @param reachableIps unique IPv4 addresses that responded during the live ping probe; an empty array is allowed
 * @return blocking error details when any address responds, otherwise a successful availability result
 */
export function buildIpReachabilityPreflightResult(reachableIps: string[]): IpReachabilityPreflightResult {
  return reachableIps.length
    ? {
        status: "error",
        message: `以下 IP ping 有响应，禁止创建：${reachableIps.join("、")}`,
      }
    : {
        status: "success",
        // 明确本检查只覆盖 ICMP：不响应 ping 不等于地址空闲，二层占用由 ARP 检查负责。
        message: "目标 IP 无 ICMP 响应（不代表地址空闲，二层占用另由 ARP 检查判定）",
      };
}

/**
 * Converts layer-2 ARP probe results into a blocking provisioning decision.
 *
 * Unlike ICMP, a live NIC always answers ARP, so this catches devices that drop ping — most notably
 * guests on other virtualization platforms sharing the same subnet, which is exactly the case that
 * silently passed the ping-only check and then failed the install with an IP conflict.
 *
 * @param result ARP probe outcome, including the probed addresses that answered
 * @return blocking error details when any address is taken, otherwise a successful availability result
 */
export function buildIpArpConflictPreflightResult(result: {
  status: "checked" | "skipped";
  occupiedIps: string[];
  message: string;
}): IpReachabilityPreflightResult {
  if (result.status === "skipped") {
    return { status: "success", message: result.message };
  }
  return result.occupiedIps.length
    ? {
        status: "error",
        message: `以下 IP 在二层已被占用（ARP 有应答），禁止创建：${result.occupiedIps.join("、")}`,
      }
    : { status: "success", message: "候选 IP 二层无应答" };
}

/**
 * Distinguishes a plan's own pre-reserved IP from a lease held by another VM.
 *
 * The UI reserves candidate IPs immediately before submitting the create request. Treating
 * every reservation as a conflict would make that valid workflow fail its server-side replayed
 * preflight. A reservation is owned only when both IP and exact VM name match the plan item.
 *
 * @param planItems requested VM names and IPv4 addresses; empty values are ignored
 * @param leases active local leases with their owning VM names
 * @return blocking conflict details, or a success result that acknowledges owned reservations
 */
export function buildIpLeasePreflightResult(
  planItems: Array<{ ip: string; name: string }>,
  leases: Array<{ ip: string; vmName: string }>,
): IpLeasePreflightResult {
  const owners = new Map(planItems.map((item) => [item.ip.trim(), item.name.trim()]));
  const conflicts = leases
    .filter((lease) => {
      const requestedOwner = owners.get(lease.ip);
      return requestedOwner !== undefined && requestedOwner !== lease.vmName;
    })
    .map((lease) => `${lease.ip}：${lease.vmName}`);
  if (conflicts.length) {
    return {
      status: "error",
      message: `本地已预留：${conflicts.join("、")}`,
    };
  }
  const ownedCount = leases.filter((lease) => owners.get(lease.ip) === lease.vmName).length;
  return {
    status: "success",
    message: ownedCount ? `已确认当前创建计划的 IP 预留：${ownedCount} 个` : "本地未发现 IP 预留冲突",
  };
}
