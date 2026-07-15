import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ProviderType } from "./types.js";

const preferenceFile = join(homedir(), ".virtual-resource-console", "preferences.json");
const uiBackgroundImageFile = join(homedir(), ".virtual-resource-console", "appearance-background");

export type UiThemePreference = "graphite-sage" | "basalt-copper" | "mist-teal";
export type UiTonePreference = "system" | "light" | "dark";
export type UiBackgroundPreference = "default" | "solid" | "image";

export interface UiPreferences {
  theme: UiThemePreference;
  toneMode: UiTonePreference;
  accentColor: string;
  successColor: string;
  warningColor: string;
  dangerColor: string;
  backgroundMode: UiBackgroundPreference;
  backgroundColor: string;
  backgroundImageName: string;
  backgroundImageMime: string;
  backgroundImageUpdatedAt: string;
  backgroundOpacity: number;
  backgroundBlur: number;
  backgroundOverlay: number;
  showIconTooltips: boolean;
  truncateLongNames: boolean;
  throttleConsoleResize: boolean;
}

export interface ConnectionPreferences {
  selectedConnectionId: string;
  providerType: ProviderType;
  host: string;
  port: number;
  username: string;
  connectionName: string;
}

export interface AppPreferences {
  ui: UiPreferences;
  connection: ConnectionPreferences;
}

interface PreferenceFile {
  version: 1;
  ui: UiPreferences;
  connection: ConnectionPreferences;
}

const defaultUiPreferences: UiPreferences = {
  theme: "graphite-sage",
  toneMode: "light",
  accentColor: "#426b57",
  successColor: "#477a45",
  warningColor: "#b77935",
  dangerColor: "#a5483d",
  backgroundMode: "default",
  backgroundColor: "#edf1ee",
  backgroundImageName: "",
  backgroundImageMime: "",
  backgroundImageUpdatedAt: "",
  backgroundOpacity: 32,
  backgroundBlur: 0,
  backgroundOverlay: 8,
  showIconTooltips: true,
  truncateLongNames: true,
  throttleConsoleResize: true,
};

const defaultConnectionPreferences: ConnectionPreferences = {
  selectedConnectionId: "",
  providerType: "xenserver",
  host: "",
  port: 22,
  username: "root",
  connectionName: "",
};

export function getAppPreferences(): AppPreferences {
  const file = readPreferenceFile();
  writePreferenceFile(file);
  return {
    ui: file.ui,
    connection: file.connection,
  };
}

export function saveAppPreferences(input: Partial<{ ui: Partial<UiPreferences>; connection: Partial<ConnectionPreferences> }>): AppPreferences {
  const file = readPreferenceFile();
  if (input.ui) {
    file.ui = normalizeUiPreferences({
      ...file.ui,
      ...input.ui,
    });
  }
  if (input.connection) {
    file.connection = normalizeConnectionPreferences({
      ...file.connection,
      ...input.connection,
    });
  }
  writePreferenceFile(file);
  return {
    ui: file.ui,
    connection: file.connection,
  };
}

export function getUiPreferences(): UiPreferences {
  return readPreferenceFile().ui;
}

export function saveUiPreferences(input: Partial<UiPreferences>): UiPreferences {
  const file = readPreferenceFile();
  file.ui = normalizeUiPreferences({
    ...file.ui,
    ...input,
  });
  writePreferenceFile(file);
  return file.ui;
}

export function getConnectionPreferences(): ConnectionPreferences {
  const file = readPreferenceFile();
  writePreferenceFile(file);
  return file.connection;
}

export function saveConnectionPreferences(input: Partial<ConnectionPreferences>): ConnectionPreferences {
  const file = readPreferenceFile();
  file.connection = normalizeConnectionPreferences({
    ...file.connection,
    ...input,
  });
  writePreferenceFile(file);
  return file.connection;
}

export function getUiBackgroundImagePath(): string | null {
  return existsSync(uiBackgroundImageFile) ? uiBackgroundImageFile : null;
}

export function saveUiBackgroundImage(content: Buffer): void {
  ensurePreferenceDir();
  writeFileSync(uiBackgroundImageFile, content, { mode: 0o600 });
}

export function deleteUiBackgroundImage(): void {
  if (existsSync(uiBackgroundImageFile)) unlinkSync(uiBackgroundImageFile);
}

function readPreferenceFile(): PreferenceFile {
  ensurePreferenceDir();
  if (!existsSync(preferenceFile)) {
    return { version: 1, ui: defaultUiPreferences, connection: defaultConnectionPreferences };
  }
  try {
    const parsed = JSON.parse(readFileSync(preferenceFile, "utf8")) as Partial<PreferenceFile>;
    return {
      version: 1,
      ui: normalizeUiPreferences(parsed.ui ?? {}),
      connection: normalizeConnectionPreferences(parsed.connection ?? {}),
    };
  } catch {
    return { version: 1, ui: defaultUiPreferences, connection: defaultConnectionPreferences };
  }
}

function writePreferenceFile(file: PreferenceFile): void {
  ensurePreferenceDir();
  writeFileSync(preferenceFile, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
}

function ensurePreferenceDir(): void {
  mkdirSync(dirname(preferenceFile), { recursive: true, mode: 0o700 });
}

function normalizeUiPreferences(input: Partial<UiPreferences>): UiPreferences {
  const theme = input.theme === "basalt-copper" || input.theme === "mist-teal" || input.theme === "graphite-sage" ? input.theme : defaultUiPreferences.theme;
  const themeColors = semanticColorsForTheme(theme);
  return {
    theme,
    toneMode: input.toneMode === "system" || input.toneMode === "dark" || input.toneMode === "light" ? input.toneMode : defaultUiPreferences.toneMode,
    accentColor: normalizeHexColor(input.accentColor, themeColors.accentColor),
    successColor: normalizeHexColor(input.successColor, themeColors.successColor),
    warningColor: normalizeHexColor(input.warningColor, themeColors.warningColor),
    dangerColor: normalizeHexColor(input.dangerColor, themeColors.dangerColor),
    backgroundMode:
      input.backgroundMode === "solid" || input.backgroundMode === "image" || input.backgroundMode === "default"
        ? input.backgroundMode
        : defaultUiPreferences.backgroundMode,
    backgroundColor: normalizeHexColor(input.backgroundColor, defaultUiPreferences.backgroundColor),
    backgroundImageName: typeof input.backgroundImageName === "string" ? input.backgroundImageName.slice(0, 240) : defaultUiPreferences.backgroundImageName,
    backgroundImageMime: normalizeImageMime(input.backgroundImageMime),
    backgroundImageUpdatedAt: typeof input.backgroundImageUpdatedAt === "string" ? input.backgroundImageUpdatedAt.slice(0, 64) : defaultUiPreferences.backgroundImageUpdatedAt,
    backgroundOpacity: normalizeNumber(input.backgroundOpacity, 5, 60, defaultUiPreferences.backgroundOpacity),
    backgroundBlur: normalizeNumber(input.backgroundBlur, 0, 16, defaultUiPreferences.backgroundBlur),
    backgroundOverlay: normalizeNumber(input.backgroundOverlay, 0, 35, defaultUiPreferences.backgroundOverlay),
    showIconTooltips: typeof input.showIconTooltips === "boolean" ? input.showIconTooltips : defaultUiPreferences.showIconTooltips,
    truncateLongNames: typeof input.truncateLongNames === "boolean" ? input.truncateLongNames : defaultUiPreferences.truncateLongNames,
    throttleConsoleResize: typeof input.throttleConsoleResize === "boolean" ? input.throttleConsoleResize : defaultUiPreferences.throttleConsoleResize,
  };
}

function semanticColorsForTheme(theme: UiThemePreference): Pick<UiPreferences, "accentColor" | "successColor" | "warningColor" | "dangerColor"> {
  if (theme === "basalt-copper") {
    return { accentColor: "#9b5f35", successColor: "#4f7549", warningColor: "#b77935", dangerColor: "#a34f42" };
  }
  if (theme === "mist-teal") {
    return { accentColor: "#2f6f68", successColor: "#4d7a50", warningColor: "#ad7833", dangerColor: "#a3483f" };
  }
  return { accentColor: "#426b57", successColor: "#477a45", warningColor: "#b77935", dangerColor: "#a5483d" };
}

function normalizeHexColor(value: unknown, fallback: string): string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : fallback;
}

function normalizeNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
}

function normalizeImageMime(value: unknown): string {
  return value === "image/jpeg" || value === "image/png" || value === "image/webp" ? value : "";
}

function normalizeConnectionPreferences(input: Partial<ConnectionPreferences>): ConnectionPreferences {
  const providerType = normalizeProviderType(input.providerType);
  const port = Number(input.port);
  return {
    selectedConnectionId: typeof input.selectedConnectionId === "string" ? input.selectedConnectionId.trim() : defaultConnectionPreferences.selectedConnectionId,
    providerType,
    host: typeof input.host === "string" ? input.host.trim() : defaultConnectionPreferences.host,
    port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : defaultPortForProvider(providerType),
    username: typeof input.username === "string" && input.username.trim() ? input.username.trim() : defaultConnectionPreferences.username,
    connectionName: typeof input.connectionName === "string" ? input.connectionName.trim() : defaultConnectionPreferences.connectionName,
  };
}

function normalizeProviderType(value: unknown): ProviderType {
  return value === "vmware" || value === "proxmox" || value === "libvirt" || value === "xenserver" ? value : defaultConnectionPreferences.providerType;
}

function defaultPortForProvider(value: ProviderType): number {
  if (value === "proxmox") return 8006;
  return value === "vmware" ? 443 : 22;
}
