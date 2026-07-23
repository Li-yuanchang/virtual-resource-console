import { readFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";

test("boots Linux unattended installs from the generated auxiliary ISO", async () => {
  const source = await readFile(new URL("../src/xenserver.ts", import.meta.url), "utf8");
  const start = source.indexOf("elif should_use_unattended_install");
  const end = source.indexOf("else\n  xe vm-param-set uuid=\"$vm_uuid\" HVM-boot-policy", start);
  assert.ok(start >= 0 && end > start, "missing XenServer Linux unattended installation branch");
  const branch = source.slice(start, end);

  assert.match(branch, /boot_iso_uuid="\$VRC_ISO_UUID"/);
  assert.match(branch, /if \[ -n "\$VRC_AUX_ISO_UUID" \]; then/);
  assert.match(branch, /boot_iso_uuid="\$VRC_AUX_ISO_UUID"/);
  assert.match(branch, /attach_iso "\$vm_uuid" "\$boot_iso_uuid"/);
  assert.doesNotMatch(branch, /attach_iso "\$vm_uuid" "\$VRC_ISO_UUID"/);
});
