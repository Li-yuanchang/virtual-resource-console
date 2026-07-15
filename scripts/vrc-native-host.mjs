#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = path.join(rootDir, ".runtime");
const logDir = path.join(runtimeDir, "logs");
const apiLogFile = path.join(logDir, "native-host-api.log");
const defaultBaseUrl = "http://127.0.0.1:3987";

mkdirSync(logDir, { recursive: true });

readNativeMessages(async (message) => {
  if (message?.type !== "start") {
    return { ok: false, message: "不支持的 Native Host 指令。" };
  }
  const preferredBaseUrl = normalizeBaseUrl(message.preferredBaseUrl || defaultBaseUrl);
  if (await isHealthy(preferredBaseUrl)) {
    return { ok: true, baseUrl: preferredBaseUrl, alreadyRunning: true };
  }
  await startRepoServer(preferredBaseUrl);
  const ready = await waitForHealth(preferredBaseUrl, 20000);
  return ready
    ? { ok: true, baseUrl: preferredBaseUrl, alreadyRunning: false }
    : { ok: false, message: `服务启动后未在 ${preferredBaseUrl}/api/health 返回健康状态。` };
});

function readNativeMessages(handler) {
  let buffer = Buffer.alloc(0);
  process.stdin.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const messageLength = buffer.readUInt32LE(0);
      if (buffer.length < messageLength + 4) return;
      const rawMessage = buffer.subarray(4, messageLength + 4).toString("utf8");
      buffer = buffer.subarray(messageLength + 4);
      void Promise.resolve()
        .then(() => handler(JSON.parse(rawMessage)))
        .then(writeNativeMessage)
        .catch((error) => writeNativeMessage({ ok: false, message: error instanceof Error ? error.message : "Native Host 执行失败。" }));
    }
  });
}

function writeNativeMessage(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  process.stdout.write(Buffer.concat([header, payload]));
}

async function startRepoServer(baseUrl) {
  const url = new URL(baseUrl);
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  const host = url.hostname === "localhost" ? "127.0.0.1" : url.hostname;
  const logStream = createWriteStream(apiLogFile, { flags: "a" });
  const child = spawn("npm", ["run", "start:server"], {
    cwd: rootDir,
    detached: true,
    env: {
      ...process.env,
      HOST: host,
      PORT: port,
    },
    stdio: ["ignore", logStream, logStream],
  });
  child.unref();
}

async function waitForHealth(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isHealthy(baseUrl)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

function isHealthy(baseUrl) {
  return new Promise((resolve) => {
    const request = http.get(`${baseUrl}/api/health`, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.setTimeout(1500, () => {
      request.destroy();
      resolve(false);
    });
    request.on("error", () => resolve(false));
  });
}

function normalizeBaseUrl(value) {
  return String(value || defaultBaseUrl).trim().replace(/\/+$/, "") || defaultBaseUrl;
}
