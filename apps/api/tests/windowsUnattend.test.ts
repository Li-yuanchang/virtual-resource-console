import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { XMLValidator } from "fast-xml-parser";
import {
  buildWindowsAutounattend,
  buildWindowsBootstrapScript,
  buildWindowsFirstLogonCommands,
  buildWindowsSetupCompleteScript,
  buildWindowsSpecializeBootstrapCommand,
  buildWindowsSpecializeRemoteAccessCommands,
  buildWindowsConfigIsoArgs,
  encodeWindowsUnattendPassword,
  resolveWindowsImageIndex,
} from "../src/xenserverUnattendedIso.js";
import type { XenUnattendedIsoInput } from "../src/xenserverUnattendedIso.js";

function input(isoName: string): XenUnattendedIsoInput {
  return {
    connection: { host: "192.0.2.10", port: 22, username: "root", password: "not-used" },
    sourceIsoId: "source-iso",
    sourceIsoName: isoName,
    vm: {
      name: "2.31_windows-test",
      ip: "192.168.2.31",
      rootPassword: "root@2.31",
      loginUsername: "Administrator",
      cpu: 4,
      memoryGiB: 8,
      diskGiB: 120,
    },
    ipPool: {
      id: "windows-test",
      name: "Windows test",
      cidr: "192.168.2.0/24",
      gateway: "192.168.2.254",
      dns: ["202.102.152.3"],
      startIp: "192.168.2.20",
      endIp: "192.168.2.250",
      reservedIps: [],
    },
    macAddress: "02:56:52:43:00:1f",
  };
}

test("builds Windows Server 2008 R2 Standard full-install answer media", () => {
  const xml = buildWindowsAutounattend(input("cn_windows_server_2008_r2_standard_enterprise_datacenter_and_web_with_sp1_x64_dvd_617598.iso"));
  assert.equal(XMLValidator.validate(xml), true);
  assert.match(xml, /<Value>1<\/Value>/);
  assert.match(xml, /<WillWipeDisk>true<\/WillWipeDisk>/);
  assert.match(xml, /<Username>Administrator<\/Username>/);
  assert.match(xml, /Microsoft-Windows-TCPIP/);
  assert.match(xml, /Microsoft-Windows-DNS-Client/);
  assert.match(xml, /Microsoft-Windows-Deployment/);
  assert.match(xml, /<Identifier>02-56-52-43-00-1F<\/Identifier>/);
  assert.match(xml, /<IpAddress[^>]*>192\.168\.2\.31\/24<\/IpAddress>/);
  assert.match(xml, /<NextHopAddress>192\.168\.2\.254<\/NextHopAddress>/);
  assert.match(xml, /<DNSServerSearchOrder>/);
  assert.match(xml, /VrcBootstrap\.cmd/);
  assert.doesNotMatch(xml, /root@2\.31/);
  assert.match(xml, new RegExp(`<Value>${encodeWindowsUnattendPassword("root@2.31", "AdministratorPassword")}<\\/Value><PlainText>false`));
  const commands = Array.from(xml.matchAll(/<CommandLine>([^<]+)<\/CommandLine>/g), (match) => match[1]);
  assert.equal(commands.length, 4);
  assert.equal(commands.every((command) => command.length <= 1024), true);
  assert.match(commands[0], /advfirewall set allprofiles state off/);
  assert.match(commands[0], /WinRM start= auto/);
  assert.match(commands[1], /VrcBootstrap\.cmd/);
  assert.match(commands[2], /C:\\ProgramData\\VRC\\VrcSetup\.ps1/);
  assert.match(commands[3], /Panther\\Unattend\.xml/);
  assert.doesNotMatch(xml, /-EncodedCommand/);
  assert.doesNotMatch(xml, /XenServer Tools/);
  const firstLogon = buildWindowsFirstLogonCommands(input("cn_windows_server_2008_r2_standard_enterprise_datacenter_and_web_with_sp1_x64_dvd_617598.iso"));
  assert.match(firstLogon.remoteAccess, /advfirewall set allprofiles state off/);
  assert.match(firstLogon.remoteAccess, /WinRM start= auto/);
  assert.match(firstLogon.configure, /VrcBootstrap\.cmd/);
  assert.doesNotMatch(firstLogon.configure, /Win32_LogicalDisk|Win32_CDROMDrive/);
  assert.match(firstLogon.launch, /if exist C:\\ProgramData\\VRC\\VrcSetup\.ps1 start "" \/b powershell\.exe/);
  assert.doesNotMatch(firstLogon.configure, /Basic="true"/);
  assert.match(firstLogon.cleanup, /Panther\\Unattend\.xml/);
});

test("stages Windows guest initialization during specialize instead of relying on desktop logon", () => {
  const command = buildWindowsSpecializeBootstrapCommand();
  const remoteAccess = buildWindowsSpecializeRemoteAccessCommands();
  const bootstrap = buildWindowsBootstrapScript();

  assert.match(command, /^cmd\.exe \/c for %d in/);
  assert.match(command, /VrcBootstrap\.cmd/);
  assert.ok(command.length < 260);
  assert.match(bootstrap, /copy \/y "%~dp0VrcSetup\.ps1" "%VRC_STATE%\\VrcSetup\.ps1"/);
  assert.match(bootstrap, /\/SC ONSTART \/RU SYSTEM/);
  assert.match(bootstrap, /start "" \/b powershell\.exe/);
  assert.doesNotMatch(bootstrap, /if errorlevel 1 exit \/b 11/);
  assert.equal(remoteAccess.length, 6);
  assert.equal(remoteAccess.every((item) => item.length < 260), true);
  assert.match(remoteAccess[0], /advfirewall set allprofiles state off/);
  assert.match(remoteAccess.join("\n"), /WinRM start= auto/);
  assert.match(remoteAccess.join("\n"), /name=VRC-ICMPv4-Echo/);
  assert.match(remoteAccess.join("\n"), /localport=3389/);
  assert.match(remoteAccess.join("\n"), /remoteip=any profile=any/);
});

test("keeps every Windows answer-file command within its schema field limit", () => {
  const xml = buildWindowsAutounattend(input("cn_windows_server_2008_r2_x64.iso"));
  const paths = Array.from(xml.matchAll(/<Path>([^<]+)<\/Path>/g), (match) => match[1]);
  const firstLogonCommands = Array.from(xml.matchAll(/<CommandLine>([^<]+)<\/CommandLine>/g), (match) => match[1]);

  assert.equal(paths.length, 7);
  assert.equal(paths.every((command) => command.length < 260), true);
  assert.equal(firstLogonCommands.length, 4);
  assert.equal(firstLogonCommands.every((command) => command.length < 1024), true);
});

test("builds local Windows setup and XenServer Tools installation workflow", () => {
  const script = buildWindowsSetupCompleteScript(input("cn_windows_server_2008_r2_x64.iso"));
  assert.match(script, /192\.168\.2\.31/);
  assert.match(script, /255\.255\.255\.0/);
  assert.match(script, /192\.168\.2\.254/);
  assert.match(script, /202\.102\.152\.3/);
  assert.match(script, /ForceGuest -Value 0/);
  assert.match(script, /LocalAccountTokenFilterPolicy/);
  assert.match(script, /advfirewall set allprofiles state off/);
  assert.match(script, /name=VRC-ICMPv4-Echo dir=in action=allow protocol=icmpv4:8,any remoteip=any profile=any/);
  assert.match(script, /name=VRC-RDP dir=in action=allow protocol=TCP localport=3389 remoteip=any profile=any/);
  assert.match(script, /fDenyTSConnections/);
  assert.match(script, /installwizard\.msi/);
  assert.match(script, /Win32_LogicalDisk/);
  assert.match(script, /Where-Object \{ \$_\.VolumeName \}/);
  assert.doesNotMatch(script, /MediaLoaded/);
  assert.match(script, /guest-setup\.lock/);
  assert.match(script, /FeatureName:NetFx3/);
  assert.match(script, /VRC enabled \.NET Framework 3\.5 for XenServer Tools/);
  assert.match(script, /interface ipv4 set address name=\$interfaceIndex/);
  assert.match(script, /\/passive/);
  assert.match(script, /REBOOT=ReallySuppress/);
  assert.match(script, /\/norestart/);
  assert.match(script, /WaitForExit\(1200000\)/);
  assert.doesNotMatch(script, /EnableStatic/);
  assert.doesNotMatch(script, /'\/qn'/);
  assert.match(script, /shutdown\.exe \/r/);
  assert.doesNotMatch(script, /Basic=["']true/);
});

test("selects the full Windows Server 2012 R2 Standard image", () => {
  assert.equal(resolveWindowsImageIndex("cn_windows_server_2012_r2_vl_with_update_x64_dvd_6052729(1).iso"), 2);
  assert.equal(resolveWindowsImageIndex("cn_windows_server_2008_r2_x64.iso"), 1);
  assert.equal(resolveWindowsImageIndex("cn_windows_server_2012_r2_vl_with_update_x64_dvd_6052729(1).iso", "server"), 1);
  assert.equal(resolveWindowsImageIndex("cn_windows_server_2008_r2_x64.iso", "server"), 2);
});

test("builds a small Windows answer ISO without copying the original DVD", () => {
  const args = buildWindowsConfigIsoArgs("/work/config-tree", "/generated/vrc-windows-config.iso", "WINDOWS_CONFIG");
  assert.deepEqual(args, [
    "makehybrid",
    "-o",
    "/generated/vrc-windows-config.iso",
    "/work/config-tree",
    "-iso",
    "-joliet",
    "-iso-volume-name",
    "WINDOWS_CONFIG",
    "-joliet-volume-name",
    "WINDOWS_CONFIG",
    "-ov",
  ]);
});

test("does not switch Windows installation to disk boot on a timer", () => {
  const script = buildWindowsSetupCompleteScript(input("cn_windows_server_2008_r2_x64.iso"));
  assert.match(script, /shutdown\.exe \/r/);
});

test("attaches Windows answer media with automatic devices and defers XenServer Tools", async () => {
  const source = await readFile(new URL("../src/xenserver.ts", import.meta.url), "utf8");
  const start = source.indexOf('elif [ "$VRC_INSTALL_MEDIA_MODE" = "windows-unattended" ]; then');
  const end = source.indexOf("elif should_use_unattended_install", start);
  assert.ok(start >= 0 && end > start, "missing XenServer Windows installation branch");
  const branch = source.slice(start, end);

  assert.match(source, /device=autodetect bootable="\$bootable" mode=RO type=CD/);
  assert.match(branch, /attach_iso_auto "\$vm_uuid" "\$VRC_ISO_UUID" true/);
  assert.match(branch, /attach_iso_auto "\$vm_uuid" "\$VRC_AUX_ISO_UUID" false/);
  assert.doesNotMatch(branch, /find_tools_iso|xs-tools\.iso|guest-tools\.iso|device=[345]/);
});
