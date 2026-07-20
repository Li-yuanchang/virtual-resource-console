const bootstrapStartedAt = Date.now();
process.env.VRC_API_BOOTSTRAP_STARTED_AT = String(bootstrapStartedAt);

writeApiStartupLog("api bootstrap started", {
  spawnedDeltaMs: elapsedFromEnv("VRC_API_SPAWNED_AT"),
});

import("./index.js").catch((error) => {
  writeApiStartupLog("api bootstrap failed", {
    message: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});

function writeApiStartupLog(phase: string, detail: Record<string, unknown> = {}) {
  process.stdout.write(
    `${JSON.stringify({
      level: 30,
      time: Date.now(),
      pid: process.pid,
      msg: "api startup phase",
      phase,
      elapsedSinceBootstrapMs: Date.now() - bootstrapStartedAt,
      ...detail,
    })}\n`,
  );
}

function elapsedFromEnv(name: string) {
  const startedAt = Number(process.env[name] || 0);
  return Number.isFinite(startedAt) && startedAt > 0 ? Date.now() - startedAt : undefined;
}
