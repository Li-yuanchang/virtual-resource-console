/** Returns true when an XenServer ISO is a guest-tools disc rather than an operating-system installer. */
export function isXenGuestToolsIsoName(value: unknown): boolean {
  const name = String(value ?? "").trim().split("/").pop() ?? "";
  return /^(?:xs-tools|guest-tools)(?:-[^/]*)?\.iso$/i.test(name);
}
