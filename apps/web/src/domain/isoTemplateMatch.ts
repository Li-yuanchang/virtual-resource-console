import type { IsoImage } from "../types";

type IsoIdentityInput = Partial<Pick<IsoImage, "id" | "providerId" | "name" | "path" | "metadata">>;

export function matchesIsoNamePattern(image: IsoIdentityInput, pattern: string | undefined): boolean {
  if (!pattern?.trim()) return false;
  const identities = isoIdentityValues(image);
  const expected = pattern.trim().toLowerCase();
  if (identities.some((identity) => identity.toLowerCase().includes(expected))) return true;

  const normalizedExpected = normalizeIsoIdentity(expected);
  if (identities.some((identity) => normalizeIsoIdentity(identity).includes(normalizedExpected))) return true;

  return isCentos7Dvd1511Pattern(normalizedExpected) && identities.some(isCentos7HostDvdLabel);
}

function isoIdentityValues(image: IsoIdentityInput): string[] {
  return [
    image.name,
    image.id,
    image.providerId,
    image.path,
    typeof image.metadata?.volumeLabel === "string" ? image.metadata.volumeLabel : undefined,
  ].flatMap((value) => (value?.trim() ? [value.trim()] : []));
}

function normalizeIsoIdentity(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function isCentos7Dvd1511Pattern(value: string): boolean {
  return value.includes("centos 7 x86 64 dvd 1511");
}

function isCentos7HostDvdLabel(value: string): boolean {
  const normalized = normalizeIsoIdentity(value);
  // XenServer host DVD inventory exposes only the mounted media label, not the original ISO filename.
  return normalized === "centos 7 x86 64";
}
