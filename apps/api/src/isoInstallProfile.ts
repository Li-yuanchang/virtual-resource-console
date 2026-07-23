import type { EnvironmentProvisioningTemplate, IsoImage, IsoInstallProfileHint, ProviderType } from "./types.js";

const desktopMediaPattern = /(?:^|[-_.\s])(desktop|workstation|graphical|livegui)(?:[-_.\s]|$)/i;
const serverMediaPattern = /(?:^|[-_.\s])(server|minimal|netinst|core)(?:[-_.\s]|$)/i;

/** Resolves the default profile when a legacy client omits installProfile. */
export function defaultInstallProfileForIdentity(identity: string): "server" | "desktop" {
  return /windows_server_2008_r2|windows_server_2012_r2|winserver|windows/i.test(identity) ? "desktop" : "server";
}

/**
 * Adds normalized installation-profile hints to provider ISO inventory.
 *
 * Explicit media names are authoritative for single-purpose desktop/server images. Templates may
 * advertise both profiles for one installer, such as a Kylin Server ISO whose package metadata
 * also contains UKUI. The web client only renders this normalized result.
 */
export function attachIsoInstallProfileHints(
  providerType: ProviderType,
  images: IsoImage[],
  templates: EnvironmentProvisioningTemplate[],
): IsoImage[] {
  return images.map((image) => ({
    ...image,
    installProfileHint: resolveIsoInstallProfileHint(providerType, image, templates),
  }));
}

/** Resolves the profiles genuinely represented by an ISO name and its maintained templates. */
export function resolveIsoInstallProfileHint(
  providerType: ProviderType,
  image: IsoImage,
  templates: EnvironmentProvisioningTemplate[],
): IsoInstallProfileHint {
  const identity = `${image.name} ${image.id}`.toLowerCase();
  const templateProfiles = new Set(
    templates
      .filter((template) => (!template.providerType || template.providerType === providerType) && templateMatchesIso(template, identity))
      .map((template) => template.installProfile),
  );
  const windowsMedia = /windows|winserver/i.test(identity);
  const supportedWindowsMedia = /windows_server_2008_r2|windows_server_2012_r2/i.test(identity);

  if (desktopMediaPattern.test(identity)) {
    return { available: ["desktop"], recommended: "desktop", source: "media-name" };
  }
  if (windowsMedia && supportedWindowsMedia) {
    return { available: ["server", "desktop"], recommended: "desktop", source: "media-name" };
  }
  if (templateProfiles.size) {
    const available = (["server", "desktop"] as const).filter((profile) => templateProfiles.has(profile));
    return {
      available,
      recommended: available.includes("server") ? "server" : available[0] ?? "server",
      source: "template",
    };
  }
  if (serverMediaPattern.test(identity) || /windows|winserver/i.test(identity)) {
    return { available: ["server"], recommended: "server", source: "media-name" };
  }
  return { available: ["server"], recommended: "server", source: "default" };
}

function templateMatchesIso(template: EnvironmentProvisioningTemplate, isoIdentity: string): boolean {
  return template.sourceType === "iso" && !!template.isoNamePattern && isoIdentity.includes(template.isoNamePattern.toLowerCase());
}
