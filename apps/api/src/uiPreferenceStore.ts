import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getVrcDataFile } from "./appPaths.js";
import { readLocalJsonConfig, writeLocalJsonConfig } from "./localConfigFile.js";
import type { ProviderType } from "./types.js";
import { defaultPortForProvider } from "./providerCatalog.js";

const preferenceFile = getVrcDataFile("preferences.json");
const uiBackgroundImageFile = getVrcDataFile("appearance-background");

export type UiThemePreference = "graphite-sage" | "basalt-copper" | "mist-teal" | "prism-frost" | "aurora-mint" | "neon-carbon";
export type UiTonePreference = "system" | "light" | "dark";
export type UiBackgroundPreference = "default" | "solid" | "image";
export type UiFontPreference = "system" | "humanist" | "compact";
export type ConsoleThemePreference = "vrc" | "tokyo-night" | "catppuccin" | "dracula" | "nord" | "rose-pine" | "solarized" | "light";
export type ConsoleFontPreference = "system-mono" | "jetbrains" | "cascadia" | "menlo";

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
  uiFontPreset: UiFontPreference;
  uiFontSize: number;
  reduceMotion: boolean;
  consoleTheme: ConsoleThemePreference;
  consoleFontPreset: ConsoleFontPreference;
  consoleFontSize: number;
  consoleLineHeight: number;
  consoleCursorStyle: "block" | "underline" | "bar";
  consoleCursorBlink: boolean;
  consoleScaleMode: "local" | "remote";
  consoleQuality: "auto" | "high" | "smooth";
  consoleWatermarkEnabled: boolean;
  consoleWatermarkScope: "console" | "workspace";
  consoleWatermarkDensity: "sparse" | "standard" | "dense";
  consoleWatermarkOpacity: number;
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
  uiFontPreset: "system",
  uiFontSize: 12,
  reduceMotion: false,
  consoleTheme: "vrc",
  consoleFontPreset: "system-mono",
  consoleFontSize: 13,
  consoleLineHeight: 1.2,
  consoleCursorStyle: "block",
  consoleCursorBlink: true,
  consoleScaleMode: "local",
  consoleQuality: "auto",
  consoleWatermarkEnabled: true,
  consoleWatermarkScope: "console",
  consoleWatermarkDensity: "standard",
  consoleWatermarkOpacity: 12,
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
  const fallback = (): PreferenceFile => ({ version: 1, ui: defaultUiPreferences, connection: defaultConnectionPreferences });
  return readLocalJsonConfig({
    filePath: preferenceFile,
    label: "界面偏好配置",
    normalize: (input) => {
      const parsed = input as Partial<PreferenceFile>;
      return {
        version: 1,
        ui: normalizeUiPreferences(parsed.ui ?? {}),
        connection: normalizeConnectionPreferences(parsed.connection ?? {}),
      };
    },
    onMissing: fallback,
    onInvalid: fallback,
  });
}

function writePreferenceFile(file: PreferenceFile): void {
  writeLocalJsonConfig(preferenceFile, file);
}

function ensurePreferenceDir(): void {
  mkdirSync(dirname(preferenceFile), { recursive: true, mode: 0o700 });
}

function normalizeUiPreferences(input: Partial<UiPreferences>): UiPreferences {
  const theme = normalizeTheme(input.theme);
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
    uiFontPreset: normalizeUiFontPreset(input.uiFontPreset),
    uiFontSize: normalizeNumber(input.uiFontSize, 11, 13, defaultUiPreferences.uiFontSize),
    reduceMotion: typeof input.reduceMotion === "boolean" ? input.reduceMotion : defaultUiPreferences.reduceMotion,
    consoleTheme: normalizeConsoleTheme(input.consoleTheme),
    consoleFontPreset: normalizeConsoleFontPreset(input.consoleFontPreset),
    consoleFontSize: normalizeNumber(input.consoleFontSize, 11, 18, defaultUiPreferences.consoleFontSize),
    consoleLineHeight: normalizeDecimal(input.consoleLineHeight, 1.05, 1.6, defaultUiPreferences.consoleLineHeight),
    consoleCursorStyle:
      input.consoleCursorStyle === "underline" || input.consoleCursorStyle === "bar" || input.consoleCursorStyle === "block"
        ? input.consoleCursorStyle
        : defaultUiPreferences.consoleCursorStyle,
    consoleCursorBlink: typeof input.consoleCursorBlink === "boolean" ? input.consoleCursorBlink : defaultUiPreferences.consoleCursorBlink,
    consoleScaleMode: input.consoleScaleMode === "remote" ? "remote" : "local",
    consoleQuality: input.consoleQuality === "high" || input.consoleQuality === "smooth" ? input.consoleQuality : "auto",
    consoleWatermarkEnabled:
      typeof input.consoleWatermarkEnabled === "boolean" ? input.consoleWatermarkEnabled : defaultUiPreferences.consoleWatermarkEnabled,
    consoleWatermarkScope: input.consoleWatermarkScope === "workspace" ? "workspace" : "console",
    consoleWatermarkDensity:
      input.consoleWatermarkDensity === "sparse" || input.consoleWatermarkDensity === "dense" ? input.consoleWatermarkDensity : "standard",
    consoleWatermarkOpacity: normalizeNumber(
      input.consoleWatermarkOpacity,
      6,
      24,
      defaultUiPreferences.consoleWatermarkOpacity,
    ),
  };
}

function semanticColorsForTheme(theme: UiThemePreference): Pick<UiPreferences, "accentColor" | "successColor" | "warningColor" | "dangerColor"> {
  if (theme === "prism-frost") {
    return { accentColor: "#527fa8", successColor: "#46856e", warningColor: "#b17a35", dangerColor: "#ad5260" };
  }
  if (theme === "aurora-mint") {
    return { accentColor: "#397d78", successColor: "#4b8668", warningColor: "#b77734", dangerColor: "#b25355" };
  }
  if (theme === "neon-carbon") {
    return { accentColor: "#5d9fe3", successColor: "#64bd91", warningColor: "#d49a51", dangerColor: "#d36c7b" };
  }
  if (theme === "basalt-copper") {
    return { accentColor: "#9b5f35", successColor: "#4f7549", warningColor: "#b77935", dangerColor: "#a34f42" };
  }
  if (theme === "mist-teal") {
    return { accentColor: "#2f6f68", successColor: "#4d7a50", warningColor: "#ad7833", dangerColor: "#a3483f" };
  }
  return { accentColor: "#426b57", successColor: "#477a45", warningColor: "#b77935", dangerColor: "#a5483d" };
}

function normalizeTheme(value: unknown): UiThemePreference {
  return value === "basalt-copper" ||
    value === "mist-teal" ||
    value === "prism-frost" ||
    value === "aurora-mint" ||
    value === "neon-carbon" ||
    value === "graphite-sage"
    ? value
    : defaultUiPreferences.theme;
}

function normalizeConsoleTheme(value: unknown): ConsoleThemePreference {
  const legacyMap: Record<string, ConsoleThemePreference> = { classic: "vrc", slate: "tokyo-night", matrix: "nord", paper: "light" };
  const normalized = typeof value === "string" ? legacyMap[value] ?? value : value;
  return normalized === "vrc" || normalized === "tokyo-night" || normalized === "catppuccin" || normalized === "dracula" ||
    normalized === "nord" || normalized === "rose-pine" || normalized === "solarized" || normalized === "light"
    ? normalized
    : defaultUiPreferences.consoleTheme;
}

function normalizeConsoleFontPreset(value: unknown): ConsoleFontPreference {
  const normalized = value === "consolas" ? "cascadia" : value;
  return normalized === "jetbrains" || normalized === "menlo" || normalized === "cascadia" || normalized === "system-mono"
    ? normalized
    : defaultUiPreferences.consoleFontPreset;
}

function normalizeUiFontPreset(value: unknown): UiFontPreference {
  return value === "humanist" || value === "compact" || value === "system" ? value : defaultUiPreferences.uiFontPreset;
}

function normalizeHexColor(value: unknown, fallback: string): string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : fallback;
}

function normalizeNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
}

function normalizeDecimal(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number * 100) / 100)) : fallback;
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
