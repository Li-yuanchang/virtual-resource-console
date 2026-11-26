import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { buildIsoStorageProbeScript, buildIsoStorageRepairScript, buildMountReachabilityProbeScript, parseSections } from "../src/isoStorageHealthService.js";

test("iso storage repair runs unload before kill before replug", () => {
  const script = buildIsoStorageRepairScript();

  // 顺序是本次故障的核心：D 状态进程收不到 kill 信号，
  // 必须先 umount -f -l 解除内核等待，kill 才会生效，最后才能重挂 SR。
  const unloadAt = script.indexOf("STEP unload");
  const killAt = script.indexOf("STEP kill");
  const replugAt = script.indexOf("STEP replug");
  assert.ok(unloadAt > -1 && killAt > unloadAt && replugAt > killAt, "必须按 unload → kill → replug 顺序执行");
  assert.match(script, /umount -f -l "\$mp"/);
  assert.match(script, /kill -9 "\$pid"/);
  assert.match(script, /xe pbd-plug uuid=\$p/);
  assert.equal(spawnSync("sh", ["-n"], { input: script, encoding: "utf8" }).status, 0);
});

test("iso storage repair only reattaches SMB type ISO repositories", () => {
  const script = buildIsoStorageRepairScript();

  // 只处理 SMB 类型的 ISO SR，避免动到 DVD drives / XenServer Tools 等其它 ISO 存储。
  assert.match(script, /content-type=iso/);
  assert.match(script, /\*SMB\*\)/);
  assert.equal(spawnSync("sh", ["-n"], { input: script, encoding: "utf8" }).status, 0);
});

test("iso storage probe is read-only and bounds mount reachability checks", () => {
  const script = buildIsoStorageProbeScript();

  // 扫描必须只读：不能出现任何挂载/卸载动作。
  assert.doesNotMatch(script, /umount/);
  assert.doesNotMatch(script, /mount -o/);
  assert.match(script, /DSTUCK_BEGIN/);
  assert.match(script, /CIFS_BEGIN/);
  assert.equal(spawnSync("sh", ["-n"], { input: script, encoding: "utf8" }).status, 0);

  // 可达性探测必须限时，否则 CIFS 僵死会让探测本身卡住。
  const reach = buildMountReachabilityProbeScript(["/var/run/sr-mount/abc"]);
  assert.match(reach, /timeout 5 ls/);
  assert.equal(spawnSync("sh", ["-n"], { input: reach, encoding: "utf8" }).status, 0);
});

test("mount reachability probe rejects unsafe paths", () => {
  // 路径做白名单过滤，只允许绝对路径与安全字符，避免注入。
  const script = buildMountReachabilityProbeScript(["/var/run/sr-mount/ok", "rm -rf /", "/tmp/$(id)"]);
  assert.match(script, /'\/var\/run\/sr-mount\/ok'/);
  assert.doesNotMatch(script, /rm -rf/);
  assert.doesNotMatch(script, /\$\(id\)/);
  assert.equal(spawnSync("sh", ["-n"], { input: script, encoding: "utf8" }).status, 0);
});

test("nodes without any SMB ISO repository are not classified as repairable", () => {
  // 某些 XenServer 只挂了 DVD drives / XenServer Tools，本来就没有 SMB ISO 库。
  // 这类节点不能算"未挂载"（那会让修复按钮把无关机器也列进去），必须单列为无此库。
  const script = buildIsoStorageProbeScript();
  assert.match(script, /SR_BEGIN/);
  assert.match(script, /content-type=iso/);
  // 扫描脚本必须能区分"有 SMB SR"和"完全没有 SMB SR"
  assert.match(script, /\*SMB\*\)/);
});

test("parseSections captures the FINAL mount list emitted by the repair script", () => {
  // 回归防护：修复脚本输出 FINAL_BEGIN/FINAL_END 段，repairIsoStorage 依赖
  // parseSections(output).FINAL.length 判断是否真的重挂成功。
  // 之前该段未在 sections 初始化，读取 .FINAL.length 抛 TypeError，
  // 导致修复接口 502，且多节点修复会在第一个节点后中断。
  const output = [
    "STEP unload",
    "STEP kill",
    "KILLED\t0",
    "REMAINING\t0",
    "STEP replug",
    "PLUGGED\tSMB ISO 库 (1)\tpbd-uuid-1",
    "FINAL_BEGIN",
    "/var/run/sr-mount/4cf55811-d981-98d6-8b9c-91e807a4a8da",
    "FINAL_END",
  ].join("\n");

  const sections = parseSections(output);
  assert.ok(Array.isArray(sections.FINAL), "FINAL 段必须存在，否则 .length 读取会抛异常");
  assert.equal(sections.FINAL.length, 1);
  assert.equal(sections.FINAL[0], "/var/run/sr-mount/4cf55811-d981-98d6-8b9c-91e807a4a8da");
});

test("parseSections reports an empty FINAL list when remount produced no mount point", () => {
  // 修复失败（例如 VDI 被 VM 光驱占用）时 FINAL 段为空，
  // 此时 repaired 必须为 false 而不是崩溃。
  const output = ["REMAINING\t0", "FINAL_BEGIN", "FINAL_END"].join("\n");
  const sections = parseSections(output);
  assert.equal(sections.FINAL.length, 0);
});
