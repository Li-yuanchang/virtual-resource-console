import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { buildIsoStorageProbeScript, buildIsoStorageRepairScript, buildMountReachabilityProbeScript } from "../src/isoStorageHealthService.js";

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
