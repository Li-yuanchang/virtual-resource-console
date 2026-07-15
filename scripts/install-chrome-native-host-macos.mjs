import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hostPath = path.join(rootDir, "scripts", "vrc-native-host.mjs");
const manifestDir = path.join(process.env.HOME || "", "Library/Application Support/Google/Chrome/NativeMessagingHosts");
const manifestPath = path.join(manifestDir, "com.virtualresource.console.json");

const manifest = {
  name: "com.virtualresource.console",
  description: "Virtual Resource Console native launcher",
  path: hostPath,
  type: "stdio",
  allowed_origins: ["chrome-extension://nmnnabfmhipigdohpkigkafkchimnfih/"],
};

await mkdir(manifestDir, { recursive: true });
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(`Chrome Native Messaging Host installed: ${manifestPath}`);
