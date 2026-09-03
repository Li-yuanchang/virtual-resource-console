/**
 * Builds the IP-derived prefix used for default VM names.
 *
 * When all configured pools share the same first two IPv4 octets, the common
 * part is omitted so names remain compact without losing subnet information.
 */
export function vmNamePrefixFromIp(ip: string, poolPrefixes: string[]): string {
  if (!isIpv4(ip)) return "";
  const parts = ip.split(".");
  const ipPrefix = parts.slice(0, 3).join(".");
  const managedPrefixes = Array.from(new Set(poolPrefixes.filter(isIpv4Prefix)));
  const commonBase = commonBasePrefix(managedPrefixes);

  if (managedPrefixes.includes(ipPrefix) && commonBase && ipPrefix.startsWith(`${commonBase}.`)) {
    return `${parts[2]}.${parts[3]}_`;
  }
  return `${ip}_`;
}

/** Replaces either the full or compact IP prefix in an IP-derived VM name. */
export function replaceVmNameIpPrefix(name: string, ipPrefix: string): string {
  const existingPrefix = name.match(/^(?:(?:\d{1,3}\.){3}\d{1,3}|\d{1,3}\.\d{1,3})_/)?.[0];
  return existingPrefix ? `${ipPrefix}${name.slice(existingPrefix.length)}` : name;
}

function commonBasePrefix(prefixes: string[]): string {
  if (!prefixes.length) return "";
  const bases = prefixes.map((prefix) => prefix.split(".").slice(0, 2).join("."));
  return bases.every((base) => base === bases[0]) ? bases[0] : "";
}

function isIpv4Prefix(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 3 && parts.every(isIpv4Octet);
}

function isIpv4(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every(isIpv4Octet);
}

function isIpv4Octet(value: string): boolean {
  return /^\d{1,3}$/.test(value) && Number(value) >= 0 && Number(value) <= 255;
}
