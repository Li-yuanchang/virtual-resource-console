export type RuntimeMode = "web" | "electron" | "chrome-native";

export interface PersistentConnectionPolicy {
  enabled: boolean;
  reason?: "shared-web" | "disabled-env";
}

export function normalizeRuntimeMode(value: string | undefined): RuntimeMode {
  if (value === "electron" || value === "chrome-native") return value;
  return "web";
}

export function resolvePersistentConnectionPolicy(
  mode: RuntimeMode,
  env: Partial<Record<"VRC_DISABLE_PERSISTENT_CONNECTIONS" | "VRC_SHARED_WEB_MODE", string | undefined>> = process.env,
): PersistentConnectionPolicy {
  if (isTruthyEnv(env.VRC_DISABLE_PERSISTENT_CONNECTIONS)) return { enabled: false, reason: "disabled-env" };
  if (isTruthyEnv(env.VRC_SHARED_WEB_MODE)) return { enabled: false, reason: "shared-web" };
  if (mode === "electron" || mode === "chrome-native") return { enabled: true };
  // local:start 也是 web runtime，但跑在用户本机时应读取本机连接配置。
  return { enabled: true };
}

function isTruthyEnv(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}
