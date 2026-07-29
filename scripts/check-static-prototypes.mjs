import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = join(projectRoot, "apps/web");
const pages = readdirSync(webRoot).filter((name) => name.endsWith("-prototype.html")).sort();
const errors = [];

for (const page of pages) {
  const filePath = join(webRoot, page);
  const source = readFileSync(filePath, "utf8");

  if (/\b(?:vue|createApp|ElementPlus)\b/i.test(source)) {
    errors.push(`${page}: contains a Vue or Element Plus runtime reference`);
  }
  if (/src=["']\/src\/[^"']*-prototype\.ts/.test(source)) {
    errors.push(`${page}: still mounts a TypeScript prototype entry`);
  }

  for (const match of source.matchAll(/(?:src|href)=["']([^"'#?]+)["']/g)) {
    const reference = match[1];
    if (/^(?:data:|https?:|mailto:)/.test(reference)) continue;
    if (reference.startsWith("/")) {
      errors.push(`${page}: root-absolute resource path ${reference}`);
      continue;
    }
    const target = resolve(dirname(filePath), reference);
    if (!existsSync(target)) errors.push(`${page}: missing resource ${reference}`);
  }
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Checked ${pages.length} static prototype pages.`);
}
