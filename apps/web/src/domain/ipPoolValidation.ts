import type { IpPoolConfig } from "../types";

/** Validates the network settings required before probing or provisioning addresses. */
export function validateProvisioningIpPool(pool: IpPoolConfig): string {
  if (!isIpv4(pool.startIp) || !isIpv4(pool.endIp)) return "请填写合法的 IP 池起止地址。";
  if (ipToNumber(pool.startIp) > ipToNumber(pool.endIp)) return "IP 池起始地址不能大于结束地址。";
  if (ipToNumber(pool.endIp) - ipToNumber(pool.startIp) + 1 > 1024) return "IP 池范围过大，当前限制在 1024 个地址以内。";
  if (pool.gateway && !isIpv4(pool.gateway)) return settingsMessage("网关地址格式不正确");

  if (!pool.gateway) return settingsMessage("无人值守安装必须配置网关");
  if (!isIpv4Cidr(pool.cidr)) return settingsMessage("无人值守安装必须配置有效 CIDR");
  if (!cidrContainsIp(pool.cidr, pool.startIp) || !cidrContainsIp(pool.cidr, pool.endIp)) {
    return settingsMessage(`IP 池范围不属于 ${pool.cidr}`);
  }
  if (!cidrContainsIp(pool.cidr, pool.gateway)) {
    return settingsMessage(`网关 ${pool.gateway} 不属于 ${pool.cidr}`);
  }
  if (!pool.dns.some(isIpv4)) return settingsMessage("无人值守安装必须配置有效 DNS");
  return "";
}

function settingsMessage(message: string): string {
  return `${message}。请到「设置 → IP 池」修改并保存后，再 PING IP。`;
}

function isIpv4Cidr(value: string): boolean {
  const [address, prefixText, extra] = value.split("/");
  const prefix = Number(prefixText);
  return !extra && isIpv4(address) && Number.isInteger(prefix) && prefix >= 0 && prefix <= 32;
}

function ipToNumber(ip: string): number {
  return ip.split(".").reduce((sum, part) => sum * 256 + Number(part), 0);
}

function cidrContainsIp(cidr: string, ip: string): boolean {
  const [baseIp, prefixText] = cidr.split("/");
  if (!isIpv4(baseIp) || !isIpv4(ip)) return false;
  const prefix = Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipToNumber(baseIp) & mask) === (ipToNumber(ip) & mask);
}

function isIpv4(value: string | undefined): boolean {
  if (!value) return false;
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}
