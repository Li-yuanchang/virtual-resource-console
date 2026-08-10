import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSetBootEntryCommand,
  LIST_BOOT_ENTRIES_COMMAND,
  parseGuestBootEntries,
} from "../src/vmBootEntry.js";

test("parses GRUB2 menu entries with submenu full paths and saved default", () => {
  const output = [
    "GRUBKIND\tgrub2",
    "CONFIG\t/boot/grub2/grub.cfg",
    "TOOL\tgrub2-reboot",
    "DEFAULT\tsaved",
    "SAVED\tsaved_entry=CentOS Linux (3.10.0-1160.99.1.el7.x86_64) 7 (Core);next_entry=;",
    'ENTRY\t0\tCentOS Linux (3.10.0-1160.99.1.el7.x86_64) 7 (Core)',
    "ENTRY\t1\tCentOS Linux (3.10.0-1160.99.1.el7.x86_64) 7 (Core) with Linux 3.10.0-1160.99.1.el7.x86_64>CentOS Linux (3.10.0-1160.99.1.el7.x86_64) 7 (Core) (3.10.0-1160.99.1.el7.x86_64)",
  ].join("\n");
  const parsed = parseGuestBootEntries(output);
  assert.equal(parsed.grubKind, "grub2");
  assert.equal(parsed.oneTimeTool, "grub2-reboot");
  assert.equal(parsed.entries.length, 2);
  assert.equal(parsed.entries[0].title, "CentOS Linux (3.10.0-1160.99.1.el7.x86_64) 7 (Core)");
  assert.equal(parsed.entries[0].isDefault, true);
  assert.equal(parsed.entries[1].index, 1);
  assert.ok(parsed.entries[1].title.includes(">"), "submenu child should use full path title");
  assert.equal(parsed.entries[1].isDefault, false);
  assert.equal(parsed.defaultIndex, 0);
  assert.equal(parsed.message, "");
});

test("parses GRUB2 one-shot saved_entry marker prefixed with >", () => {
  const output = [
    "GRUBKIND\tgrub2",
    "CONFIG\t/boot/grub2/grub.cfg",
    "TOOL\tgrub2-reboot",
    "DEFAULT\tsaved",
    "SAVED\tsaved_entry=>CentOS Linux (3.10.0-1160.99.1.el7.x86_64) 7 (Core);",
    "ENTRY\t0\tCentOS Linux (3.10.0-1160.99.1.el7.x86_64) 7 (Core)",
    "ENTRY\t1\tCentOS Linux (3.10.0-1160.99.1.el7.x86_64) 7 (Core) (rescue)",
  ].join("\n");
  const parsed = parseGuestBootEntries(output);
  assert.equal(parsed.defaultIndex, 0);
  assert.equal(parsed.entries[0].isDefault, true);
});

test("parses GRUB1 menu.lst with numeric default", () => {
  const output = [
    "GRUBKIND\tgrub1",
    "CONFIG\t/boot/grub/menu.lst",
    "TOOL\tgrub-reboot",
    "DEFAULT\t1",
    "ENTRY\t0\tCentOS 6 (2.6.32-642.el6.x86_64)",
    "ENTRY\t1\tCentOS 6 (2.6.32-696.el6.x86_64)",
  ].join("\n");
  const parsed = parseGuestBootEntries(output);
  assert.equal(parsed.grubKind, "grub1");
  assert.equal(parsed.defaultIndex, 1);
  assert.equal(parsed.entries[1].isDefault, true);
  assert.equal(parsed.entries[0].isDefault, false);
});

test("reports unknown grub with a guidance message", () => {
  const parsed = parseGuestBootEntries("GRUBKIND\tunknown\nCONFIG\t\nTOOL\tnone\nDEFAULT\t\n");
  assert.equal(parsed.grubKind, "unknown");
  assert.equal(parsed.entries.length, 0);
  assert.ok(parsed.message.includes("未识别到 GRUB 配置文件"));
});

test("reports missing one-time tool with a guidance message", () => {
  const output = [
    "GRUBKIND\tgrub2",
    "CONFIG\t/boot/grub2/grub.cfg",
    "TOOL\tnone",
    "DEFAULT\tsaved",
    "ENTRY\t0\tCentOS Linux (3.10.0-1160.99.1.el7.x86_64) 7 (Core)",
  ].join("\n");
  const parsed = parseGuestBootEntries(output);
  assert.equal(parsed.oneTimeTool, "none");
  assert.ok(parsed.message.includes("缺少 grub2-reboot / grub-reboot 工具"));
});

test("builds a grub2 one-shot command with shell-safe title quoting", () => {
  const command = buildSetBootEntryCommand({
    index: 1,
    title: "CentOS Linux (3.10.0-1160.99.1.el7.x86_64) 7 (Core) with Linux 3.10.0-1160.99.1.el7.x86_64>CentOS Linux (3.10.0-1160.99.1.el7.x86_64) 7 (Core)",
    grubKind: "grub2",
  });
  assert.match(command, /grub2-reboot 'CentOS Linux \(3\.10\.0-1160\.99\.1\.el7\.x86_64\) 7 \(Core\)/);
  assert.match(command, /grub2-editenv list/);
  assert.match(command, /SET\\t/);
});

test("builds a grub2 one-shot command escaping embedded single quotes", () => {
  const command = buildSetBootEntryCommand({ index: 0, title: "Kernel with 'special' name", grubKind: "grub2" });
  assert.match(command, /grub2-reboot 'Kernel with '\\''special'\\'' name'/);
});

test("builds a grub1 one-shot command with entry index", () => {
  const command = buildSetBootEntryCommand({ index: 1, title: "CentOS 6 (2.6.32-696.el6.x86_64)", grubKind: "grub1" });
  assert.match(command, /grub-reboot 1/);
  assert.match(command, /\/boot\/grub\/default/);
});

test("grub2 list script contains an awk heredoc with submenu stack tracking", () => {
  assert.match(LIST_BOOT_ENTRIES_COMMAND, /awk -f \/dev\/stdin/);
  assert.match(LIST_BOOT_ENTRIES_COMMAND, /VRC_GRUB_AWK/);
  assert.match(LIST_BOOT_ENTRIES_COMMAND, /\/boot\/grub2\/grub\.cfg/);
  assert.match(LIST_BOOT_ENTRIES_COMMAND, /\/boot\/grub\/menu\.lst/);
  assert.match(LIST_BOOT_ENTRIES_COMMAND, /push_block\("submenu"\)/);
});
