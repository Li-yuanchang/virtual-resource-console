import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { Client } from "ssh2";
import type { ConnectConfig, SFTPWrapper } from "ssh2";
import { buildCentosLvmPartitioning, buildCentosPackageSelection } from "./centosKickstart.js";
import { getVrcDataFile } from "./appPaths.js";
import { getGeneratedIso, markGeneratedIsoStatus, markGeneratedIsoUploaded, registerGeneratedIso } from "./generatedIsoStore.js";
import type { GeneratedIsoRecord } from "./generatedIsoStore.js";
import type { IpPoolConfig, VmProvisionInstallSourceRef, VmProvisionPlanItem, XenConnectionInput } from "./types.js";

const execFileAsync = promisify(execFile);
const cacheDir = getVrcDataFile("iso-cache");
const generatedDir = getVrcDataFile("generated-isos");
const centosBootIsoLabel = "VRCCENTOS7";
const centosKickstartIsoLabel = "VRCKS";
const windowsUnattendedIsoLabel = "VRCWIN";

export type XenInstallMediaMode = "offline-iso" | "http-boot-iso" | "cdrom-http-ks" | "native-http" | "windows-unattended";

interface SourceIsoInfo {
  srUuid: string;
  location: string;
  remotePath: string;
  mountDir: string;
  sizeBytes: number;
  volumeLabel: string;
}

export interface XenUnattendedIsoInput {
  connection: XenConnectionInput;
  connectionId?: string;
  taskId?: string;
  sourceIsoId: string;
  sourceIsoName: string;
  installProfile?: "server" | "desktop";
  hostId?: string;
  vm: VmProvisionPlanItem;
  ipPool: IpPoolConfig;
  macAddress?: string;
  installSource?: VmProvisionInstallSourceRef;
  onProgress?: (message: string) => void;
}

export interface XenUnattendedIsoResult {
  isoId: string;
  isoName: string;
  registryId?: string;
}

// 默认复用 XenServer ISO SR 上的原始 ISO，只通过 HTTP 下发 Kickstart，避免每台 VM 重复生成和上传大 ISO。
export function resolveXenInstallMediaMode(): XenInstallMediaMode {
  const rawMode = process.env.VRC_XEN_INSTALL_MEDIA_MODE?.trim().toLowerCase() ?? "";
  if (rawMode === "offline" || rawMode === "offline-iso") return "offline-iso";
  if (rawMode === "http" || rawMode === "http-boot" || rawMode === "http-boot-iso") return "http-boot-iso";
  if (["native-http", "xen-native-http", "eliloader"].includes(rawMode)) return "native-http";
  if (["cdrom-http-ks", "cdrom-plus-http-ks", "iso-http-ks", "raw-iso-http-ks"].includes(rawMode)) return "cdrom-http-ks";
  return "http-boot-iso";
}

export async function prepareXenCentosUnattendedIso(input: XenUnattendedIsoInput): Promise<XenUnattendedIsoResult> {
  ensureDir(cacheDir);
  ensureDir(generatedDir);
  input.onProgress?.("检查本地 ISO 生成工具");
  await assertIsoGeneratorAvailable();
  const mediaMode = resolveXenInstallMediaMode();
  input.onProgress?.("读取 XenServer 源 ISO 信息");
  const source = await readSourceIsoInfo(input.connection, input.sourceIsoId, mediaMode === "http-boot-iso");
  const isoName = `vrc-${safeFileName(input.vm.name)}-unattended-${Date.now().toString(36)}.iso`;
  const remotePath = `${dirname(source.remotePath)}/${isoName}`;
  const registry = registerGeneratedIso({
    taskId: input.taskId || input.installSource?.taskId || input.installSource?.id || `xen-offline-${Date.now().toString(36)}`,
    providerType: "xenserver",
    connectionId: input.connectionId,
    hostId: input.hostId,
    vmName: input.vm.name,
    vmIp: input.vm.ip,
    sourceIsoId: input.sourceIsoId,
    sourceIsoName: input.sourceIsoName,
    isoSrUuid: source.srUuid,
    isoName,
    isoPath: remotePath,
  });
  try {
    const localOutputIso = join(generatedDir, isoName);
    if (mediaMode === "offline-iso") {
      input.onProgress?.("缓存源 ISO 并生成离线无人值守 ISO");
      const localSourceIso = await ensureLocalSourceIso(input.connection, source);
      await generateCentosOfflineUnattendedIso(localSourceIso, localOutputIso, input);
    } else {
      input.onProgress?.("缓存启动文件并生成 HTTP Boot ISO");
      const bootFiles = await ensureLocalBootFiles(input.connection, source);
      await generateCentosHttpBootIso(bootFiles, localOutputIso, input);
    }
    input.onProgress?.("上传无人值守 ISO 到 XenServer ISO SR");
    await uploadIso(input.connection, localOutputIso, remotePath);
    input.onProgress?.("扫描 ISO SR 并登记无人值守 ISO");
    const isoId = await scanAndFindUploadedIso(input.connection, source.srUuid, isoName);
    await markGeneratedIsoOnXen(input.connection, {
      isoId,
      registryId: registry.id,
      taskId: registry.taskId,
      vmName: input.vm.name,
    });
    markGeneratedIsoUploaded(registry.id, {
      isoVdiUuid: isoId,
      message: "无人值守 ISO 已上传并登记",
    });
    return {
      isoId,
      isoName,
      registryId: registry.id,
    };
  } catch (error) {
    markGeneratedIsoStatus(registry.id, "failed", error instanceof Error ? error.message : "无人值守 ISO 生成失败");
    throw error;
  }
}

export async function prepareXenCentosKickstartIso(input: XenUnattendedIsoInput): Promise<XenUnattendedIsoResult> {
  ensureDir(generatedDir);
  input.onProgress?.("生成小型 Kickstart 启动 ISO");
  await assertIsoGeneratorAvailable();
  const source = await readSourceIsoInfo(input.connection, input.sourceIsoId, true);
  const isoName = `vrc-${safeFileName(input.vm.name)}-ks-${Date.now().toString(36)}.iso`;
  const remotePath = `${dirname(source.remotePath)}/${isoName}`;
  const registry = registerGeneratedIso({
    taskId: input.taskId || input.installSource?.taskId || input.installSource?.id || `xen-ks-${Date.now().toString(36)}`,
    providerType: "xenserver",
    connectionId: input.connectionId,
    hostId: input.hostId,
    vmName: input.vm.name,
    vmIp: input.vm.ip,
    sourceIsoId: input.sourceIsoId,
    sourceIsoName: input.sourceIsoName,
    isoSrUuid: source.srUuid,
    isoName,
    isoPath: remotePath,
  });
  try {
    const localOutputIso = join(generatedDir, isoName);
    const bootFiles = await ensureLocalBootLoaderFiles(input.connection, source);
    await generateCentosKickstartBootIso(bootFiles, source.volumeLabel, localOutputIso, input);
    input.onProgress?.("上传小型 Kickstart 启动 ISO 到 XenServer ISO SR");
    await uploadIso(input.connection, localOutputIso, remotePath);
    input.onProgress?.("扫描 ISO SR 并登记 Kickstart ISO");
    const isoId = await scanAndFindUploadedIso(input.connection, source.srUuid, isoName);
    await markGeneratedIsoOnXen(input.connection, {
      isoId,
      registryId: registry.id,
      taskId: registry.taskId,
      vmName: input.vm.name,
    });
    markGeneratedIsoUploaded(registry.id, {
      isoVdiUuid: isoId,
      message: "Kickstart 启动 ISO 已上传并登记",
    });
    return {
      isoId,
      isoName,
      registryId: registry.id,
    };
  } catch (error) {
    markGeneratedIsoStatus(registry.id, "failed", error instanceof Error ? error.message : "Kickstart 启动 ISO 生成失败");
    throw error;
  }
}

/**
 * Builds and uploads a small task-scoped Windows answer ISO.
 *
 * The original Windows DVD remains immutable in the XenServer ISO library. The answer ISO
 * contains only Autounattend.xml and the guest initialization bootstrap. XenServer must attach the original
 * DVD and this task media with automatically assigned CD devices; fixed legacy device numbers can
 * exist in XAPI while remaining invisible to Windows Setup. Tools media is mounted only after
 * WinRM becomes ready. This keeps the upload small and prevents source media duplication.
 */
export async function prepareXenWindowsUnattendIso(input: XenUnattendedIsoInput): Promise<XenUnattendedIsoResult> {
  ensureDir(generatedDir);
  input.onProgress?.("准备 Windows 无人值守启动 ISO");
  await assertIsoGeneratorAvailable();
  const source = await readSourceIsoInfo(input.connection, input.sourceIsoId, false);
  const isoName = `vrc-${safeFileName(input.vm.name)}-windows-config-${Date.now().toString(36)}.iso`;
  const remotePath = `${dirname(source.remotePath)}/${isoName}`;
  const registry = registerGeneratedIso({
    taskId: input.taskId || input.installSource?.taskId || input.installSource?.id || `xen-windows-${Date.now().toString(36)}`,
    providerType: "xenserver",
    connectionId: input.connectionId,
    hostId: input.hostId,
    vmName: input.vm.name,
    vmIp: input.vm.ip,
    sourceIsoId: input.sourceIsoId,
    sourceIsoName: input.sourceIsoName,
    isoSrUuid: source.srUuid,
    isoName,
    isoPath: remotePath,
  });
  const localOutputIso = join(generatedDir, isoName);
  const workDir = join(generatedDir, `${safeFileName(input.vm.name)}-windows-config-work`);
  try {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(localOutputIso, { force: true });
    ensureDir(workDir);
    input.onProgress?.("生成小型 Windows 配置 ISO");
    const answerFile = join(workDir, "Autounattend.xml");
    writeFileSync(answerFile, buildWindowsAutounattend(input), { encoding: "utf8", mode: 0o600 });
    writeFileSync(join(workDir, "VrcSetup.ps1"), buildWindowsSetupCompleteScript(input), { encoding: "utf8", mode: 0o600 });
    writeFileSync(join(workDir, "VrcBootstrap.cmd"), buildWindowsBootstrapScript(), { encoding: "ascii", mode: 0o600 });
    await generateWindowsConfigIso(workDir, localOutputIso);
    chmodSync(localOutputIso, 0o600);
    input.onProgress?.("上传小型 Windows 配置 ISO 到 XenServer ISO SR");
    await uploadIso(input.connection, localOutputIso, remotePath);
    input.onProgress?.("扫描 ISO SR 并登记 Windows 无人值守启动 ISO");
    const isoId = await scanAndFindUploadedIso(input.connection, source.srUuid, isoName);
    await markGeneratedIsoOnXen(input.connection, {
      isoId,
      registryId: registry.id,
      taskId: registry.taskId,
      vmName: input.vm.name,
    });
    markGeneratedIsoUploaded(registry.id, {
      isoVdiUuid: isoId,
      message: "小型 Windows 配置 ISO 已上传并登记",
    });
    return { isoId, isoName, registryId: registry.id };
  } catch (error) {
    markGeneratedIsoStatus(registry.id, "failed", error instanceof Error ? error.message : "Windows 无人值守启动 ISO 生成失败");
    throw error;
  } finally {
    rmSync(localOutputIso, { force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
}

/** Builds macOS hdiutil arguments for a small Windows answer ISO. */
export function buildWindowsConfigIsoArgs(sourceDir: string, outputIso: string, volumeLabel = windowsUnattendedIsoLabel): string[] {
  const label = volumeLabel || windowsUnattendedIsoLabel;
  return [
    "makehybrid",
    "-o",
    outputIso,
    sourceDir,
    "-iso",
    "-joliet",
    "-iso-volume-name",
    label,
    "-joliet-volume-name",
    label,
    "-ov",
  ];
}

/**
 * Emits a true UDF Windows ISO. macOS ships the required UDF writer; other API hosts must
 * provide an equivalent generator before Windows raw-ISO provisioning can be enabled.
 */
async function generateWindowsConfigIso(sourceDir: string, outputIso: string): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("Windows 配置 ISO 需要 ISO 生成器；当前仅配置 macOS hdiutil，请为该 API 主机配置 genisoimage。");
  }
  await execFileAsync("/usr/bin/hdiutil", buildWindowsConfigIsoArgs(sourceDir, outputIso));
}

/**
 * Generates the Windows Setup answer file for the known Server media supported by VRC.
 * Sensitive values use Windows SIM's reversible answer-file encoding; task-local answer files
 * and derivative media are removed after upload.
 */
export function buildWindowsAutounattend(input: XenUnattendedIsoInput): string {
  const password = input.vm.rootPassword?.trim() || "";
  if (!password) throw new Error("Windows 无人值守安装缺少 Administrator 密码。");
  const netmask = cidrToNetmask(input.ipPool.cidr);
  if (!netmask) throw new Error("Windows 无人值守安装缺少有效 CIDR 子网掩码。");
  const dns = input.ipPool.dns.find(Boolean)?.trim() || "";
  if (!dns) throw new Error("Windows 无人值守安装缺少 DNS。");
  const computerName = buildWindowsComputerName(input.vm.name, input.vm.ip);
  const macAddress = input.macAddress?.trim().toUpperCase();
  if (!macAddress) throw new Error("Windows 无人值守安装缺少固定网卡 MAC。");
  const interfaceIdentifier = macAddress.replace(/:/g, "-");
  const prefixLength = cidrPrefixLength(input.ipPool.cidr);
  if (prefixLength == null) throw new Error("Windows 无人值守安装缺少有效 CIDR 前缀长度。");
  const bootstrapCommand = buildWindowsSpecializeBootstrapCommand();
  const remoteAccessCommands = buildWindowsSpecializeRemoteAccessCommands();
  const firstLogonCommands = buildWindowsFirstLogonCommands(input);
  const specializeCommands = [
    ...remoteAccessCommands.map((path, index) => ({
      order: index + 1,
      description: `Enable VRC remote access ${index + 1}`,
      path,
    })),
    {
      order: remoteAccessCommands.length + 1,
      description: "Stage VRC guest initialization",
      path: bootstrapCommand,
    },
  ];
  const specializeCommandXml = specializeCommands
    .map(
      (command) => `<RunSynchronousCommand wcm:action="add" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">
        <Order>${command.order}</Order><Description>${xmlEscape(command.description)}</Description><Path>${xmlEscape(command.path)}</Path><WillReboot>Never</WillReboot>
      </RunSynchronousCommand>`,
    )
    .join("");
  const component = (name: string) => `processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS" name="${name}"`;
  return `<?xml version="1.0" encoding="utf-8"?>
<unattend xmlns="urn:schemas-microsoft-com:unattend">
  <settings pass="windowsPE">
    <component ${component("Microsoft-Windows-International-Core-WinPE")}>
      <SetupUILanguage><UILanguage>zh-CN</UILanguage></SetupUILanguage>
      <InputLocale>zh-CN</InputLocale><SystemLocale>zh-CN</SystemLocale><UILanguage>zh-CN</UILanguage><UserLocale>zh-CN</UserLocale>
    </component>
    <component ${component("Microsoft-Windows-Setup")}>
      <DiskConfiguration><Disk wcm:action="add" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State"><DiskID>0</DiskID><WillWipeDisk>true</WillWipeDisk><CreatePartitions><CreatePartition wcm:action="add"><Order>1</Order><Type>Primary</Type><Extend>true</Extend></CreatePartition></CreatePartitions><ModifyPartitions><ModifyPartition wcm:action="add"><Active>true</Active><Format>NTFS</Format><Label>Windows</Label><Letter>C</Letter><Order>1</Order><PartitionID>1</PartitionID></ModifyPartition></ModifyPartitions></Disk></DiskConfiguration>
      <ImageInstall><OSImage><InstallFrom><MetaData wcm:action="add" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State"><Key>/IMAGE/INDEX</Key><Value>${resolveWindowsImageIndex(input.sourceIsoName, input.installProfile)}</Value></MetaData></InstallFrom><InstallTo><DiskID>0</DiskID><PartitionID>1</PartitionID></InstallTo><WillShowUI>OnError</WillShowUI></OSImage></ImageInstall>
      <UserData><AcceptEula>true</AcceptEula><FullName>VRC</FullName><Organization>VRC</Organization></UserData>
    </component>
  </settings>
  <settings pass="specialize">
    <component ${component("Microsoft-Windows-Shell-Setup")}><ComputerName>${xmlEscape(computerName)}</ComputerName><TimeZone>China Standard Time</TimeZone></component>
    <component ${component("Microsoft-Windows-TCPIP")}>
      <Interfaces><Interface wcm:action="add" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">
        <Ipv4Settings><DhcpEnabled>false</DhcpEnabled><Metric>10</Metric><RouterDiscoveryEnabled>false</RouterDiscoveryEnabled></Ipv4Settings>
        <Identifier>${xmlEscape(interfaceIdentifier)}</Identifier>
        <UnicastIpAddresses><IpAddress wcm:action="add" wcm:keyValue="1">${xmlEscape(input.vm.ip)}/${prefixLength}</IpAddress></UnicastIpAddresses>
        <Routes><Route wcm:action="add"><Identifier>0</Identifier><Metric>10</Metric><NextHopAddress>${xmlEscape(input.ipPool.gateway)}</NextHopAddress><Prefix>0.0.0.0/0</Prefix></Route></Routes>
      </Interface></Interfaces>
    </component>
    <component ${component("Microsoft-Windows-DNS-Client")}>
      <Interfaces><Interface wcm:action="add" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">
        <Identifier>${xmlEscape(interfaceIdentifier)}</Identifier>
        <DNSServerSearchOrder><IpAddress wcm:action="add" wcm:keyValue="1">${xmlEscape(dns)}</IpAddress></DNSServerSearchOrder>
        <EnableAdapterDomainNameRegistration>true</EnableAdapterDomainNameRegistration>
      </Interface></Interfaces>
    </component>
    <component ${component("Microsoft-Windows-Deployment")}>
      <RunSynchronous>${specializeCommandXml}</RunSynchronous>
    </component>
  </settings>
  <settings pass="oobeSystem">
    <component ${component("Microsoft-Windows-International-Core")}><InputLocale>zh-CN</InputLocale><SystemLocale>zh-CN</SystemLocale><UILanguage>zh-CN</UILanguage><UserLocale>zh-CN</UserLocale></component>
    <component ${component("Microsoft-Windows-Shell-Setup")}>
      <AutoLogon><Password><Value>${encodeWindowsUnattendPassword(password, "Password")}</Value><PlainText>false</PlainText></Password><Enabled>true</Enabled><LogonCount>1</LogonCount><Username>Administrator</Username></AutoLogon>
      <UserAccounts><AdministratorPassword><Value>${encodeWindowsUnattendPassword(password, "AdministratorPassword")}</Value><PlainText>false</PlainText></AdministratorPassword></UserAccounts>
      <OOBE><HideEULAPage>true</HideEULAPage><NetworkLocation>Work</NetworkLocation><ProtectYourPC>3</ProtectYourPC><SkipMachineOOBE>true</SkipMachineOOBE><SkipUserOOBE>true</SkipUserOOBE></OOBE>
      <FirstLogonCommands>
        <SynchronousCommand wcm:action="add" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State"><Order>1</Order><Description>Enable VRC network access fallback</Description><CommandLine>${xmlEscape(firstLogonCommands.remoteAccess)}</CommandLine></SynchronousCommand>
        <SynchronousCommand wcm:action="add" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State"><Order>2</Order><Description>Configure VRC network and remote management</Description><CommandLine>${xmlEscape(firstLogonCommands.configure)}</CommandLine></SynchronousCommand>
        <SynchronousCommand wcm:action="add" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State"><Order>3</Order><Description>Retry VRC guest initialization</Description><CommandLine>${xmlEscape(firstLogonCommands.launch)}</CommandLine></SynchronousCommand>
        <SynchronousCommand wcm:action="add" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State"><Order>4</Order><Description>Remove VRC answer file</Description><CommandLine>${xmlEscape(firstLogonCommands.cleanup)}</CommandLine></SynchronousCommand>
      </FirstLogonCommands>
    </component>
  </settings>
</unattend>
`;
}

export interface WindowsFirstLogonCommands {
  remoteAccess: string;
  configure: string;
  launch: string;
  cleanup: string;
}

/**
 * Builds the short specialize-pass command that locates the task-scoped configuration CD.
 * The actual work stays in VrcBootstrap.cmd so Windows Setup command-length limits do not
 * become part of the guest initialization contract.
 */
export function buildWindowsSpecializeBootstrapCommand(): string {
  return 'cmd.exe /c for %d in (D E F G H I J K L M N O P Q R S T U V W X Y Z) do @if exist "%d:\\VrcBootstrap.cmd" call "%d:\\VrcBootstrap.cmd"';
}

/**
 * Builds the specialize-pass command that exposes only the remote services required by VRC.
 *
 * This command does not depend on the task configuration CD or PowerShell bootstrap. Keeping
 * it in the answer file ensures ICMP, WinRM, and RDP are available even when guest bootstrap
 * staging fails and lets the verifier report the actual later failure instead of waiting forever.
 */
export function buildWindowsSpecializeRemoteAccessCommands(): string[] {
  const commands = [
    "cmd.exe /d /c netsh advfirewall set allprofiles state off",
    "cmd.exe /d /c netsh advfirewall firewall add rule name=VRC-ICMPv4-Echo dir=in action=allow protocol=icmpv4:8,any remoteip=any profile=any",
    "cmd.exe /d /c sc.exe config WinRM start= auto & net start WinRM & winrm.cmd quickconfig -quiet",
    "cmd.exe /d /c netsh advfirewall firewall add rule name=VRC-WinRM dir=in action=allow protocol=TCP localport=5985 remoteip=any profile=any",
    'cmd.exe /d /c reg.exe add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server" /v fDenyTSConnections /t REG_DWORD /d 0 /f',
    "cmd.exe /d /c netsh advfirewall firewall add rule name=VRC-RDP dir=in action=allow protocol=TCP localport=3389 remoteip=any profile=any",
  ];
  assertWindowsSpecializeCommandLengths(commands);
  return commands;
}

/** Ensures every specialize command stays within Windows Server 2008 R2's Path limit. */
function assertWindowsSpecializeCommandLengths(commands: string[]): void {
  const overlong = commands.find((command) => command.length >= 260);
  if (overlong) throw new Error(`Windows Server 2008 R2 specialize 命令超过 259 字符限制：${overlong.length}`);
}

/**
 * Builds the task-local bootstrap stored beside Autounattend.xml.
 * It stages the PowerShell state machine before the first desktop login, registers the
 * boot retry, and launches it immediately as SYSTEM during the specialize pass.
 */
export function buildWindowsBootstrapScript(): string {
  return [
    "@echo off",
    "setlocal",
    'set "VRC_STATE=C:\\ProgramData\\VRC"',
    'if not exist "%VRC_STATE%" mkdir "%VRC_STATE%"',
    'copy /y "%~dp0VrcSetup.ps1" "%VRC_STATE%\\VrcSetup.ps1" >nul',
    "if errorlevel 1 exit /b 10",
    'schtasks.exe /Create /TN "VRC-Guest-Setup" /SC ONSTART /RU SYSTEM /RL HIGHEST /TR "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\\ProgramData\\VRC\\VrcSetup.ps1" /F >nul',
    'start "" /b powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%VRC_STATE%\\VrcSetup.ps1"',
    "exit /b 0",
    "",
  ].join("\r\n");
}

/**
 * Builds the task-local Windows guest initialization state machine.
 *
 * The script is launched by a persistent SYSTEM scheduled task during the specialize pass.
 * It may span the Xen Tools reboot, so Windows Setup itself never waits for network
 * configuration or a vendor installer. Failures are logged and retried at the next boot.
 */
export function buildWindowsSetupCompleteScript(input: XenUnattendedIsoInput): string {
  const netmask = cidrToNetmask(input.ipPool.cidr);
  if (!netmask) throw new Error("Windows 无人值守安装缺少有效 CIDR 子网掩码。");
  const dns = input.ipPool.dns.find(Boolean)?.trim() || "";
  if (!dns) throw new Error("Windows 无人值守安装缺少 DNS。");
  const macAddress = input.macAddress?.trim().toUpperCase();
  if (!macAddress) throw new Error("Windows 无人值守安装缺少固定网卡 MAC。");
  return String.raw`$ErrorActionPreference = 'Continue'
$taskName = 'VRC-Guest-Setup'
$stateDir = Join-Path $env:ProgramData 'VRC'
$toolsMarker = Join-Path $stateDir 'xen-tools-installed'
$completeMarker = Join-Path $stateDir 'guest-setup-complete'
$lockPath = Join-Path $stateDir 'guest-setup.lock'
$log = Join-Path $env:WINDIR 'Temp\vrc-setup.log'
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
try {
  $lock = [System.IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None')
} catch {
  exit 0
}
Start-Transcript -Path $log -Append | Out-Null
$mac = '${powershellQuote(macAddress)}'
$networkReady = $false
$networkDeadline = (Get-Date).AddMinutes(10)
do {
  $nic = Get-WmiObject Win32_NetworkAdapterConfiguration | Where-Object { $_.MACAddress -eq $mac } | Select-Object -First 1
  if (-not $nic) { $nic = Get-WmiObject Win32_NetworkAdapterConfiguration | Where-Object { $_.IPEnabled } | Select-Object -First 1 }
  if ($nic) {
    $interfaceIndex = [string]$nic.InterfaceIndex
    if (-not $interfaceIndex) { $interfaceIndex = [string]$nic.Index }
    if ($interfaceIndex) {
      & netsh interface ipv4 set address name=$interfaceIndex source=static address='${powershellQuote(input.vm.ip)}' mask='${powershellQuote(netmask)}' gateway='${powershellQuote(input.ipPool.gateway)}' gwmetric=1 | Out-Null
      & netsh interface ipv4 set dns name=$interfaceIndex source=static address='${powershellQuote(dns)}' register=primary validate=no | Out-Null
      $configured = Get-WmiObject Win32_NetworkAdapterConfiguration | Where-Object { $_.InterfaceIndex -eq [int]$interfaceIndex } | Select-Object -First 1
      $networkReady = [bool]($configured.IPAddress -contains '${powershellQuote(input.vm.ip)}')
    }
  }
  if (-not $networkReady) { Start-Sleep -Seconds 5 }
} while (-not $networkReady -and (Get-Date) -lt $networkDeadline)

& netsh advfirewall set allprofiles state off | Out-Null
Set-Service WinRM -StartupType Automatic
Start-Service WinRM
& winrm quickconfig -quiet

if ($networkReady) {
  New-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -Name LocalAccountTokenFilterPolicy -Value 1 -PropertyType DWord -Force | Out-Null
  Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Lsa' -Name ForceGuest -Value 0
  & netsh advfirewall firewall delete rule name=VRC-WinRM | Out-Null
  & netsh advfirewall firewall add rule name=VRC-WinRM dir=in action=allow protocol=TCP localport=5985 remoteip=any profile=any | Out-Null
  & netsh advfirewall firewall delete rule name=VRC-ICMPv4-Echo | Out-Null
  & netsh advfirewall firewall add rule name=VRC-ICMPv4-Echo dir=in action=allow protocol=icmpv4:8,any remoteip=any profile=any | Out-Null
  Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server' -Name fDenyTSConnections -Value 0
  & netsh advfirewall firewall delete rule name=VRC-RDP | Out-Null
  & netsh advfirewall firewall add rule name=VRC-RDP dir=in action=allow protocol=TCP localport=3389 remoteip=any profile=any | Out-Null
}

if (-not (Test-Path $toolsMarker)) {
  $netFx = Start-Process dism.exe -ArgumentList @('/online', '/Enable-Feature', '/FeatureName:NetFx3', '/NoRestart') -PassThru -Wait
  if ($netFx.ExitCode -eq 3010) {
    Stop-Transcript | Out-Null
    & shutdown.exe /r /t 5 /c 'VRC enabled .NET Framework 3.5 for XenServer Tools'
    exit 0
  }
  if ($netFx.ExitCode -ne 0) {
    throw ('Enabling .NET Framework 3.5 failed with exit code ' + $netFx.ExitCode)
  }
  $toolsDeadline = (Get-Date).AddMinutes(15)
  do {
    $installer = Get-WmiObject Win32_LogicalDisk -Filter 'DriveType=5' | Where-Object { $_.VolumeName } | ForEach-Object {
      $candidate = Join-Path ($_.DeviceID + '\') 'installwizard.msi'
      if (Test-Path $candidate) { Get-Item $candidate }
    } | Select-Object -First 1
    if ($installer) {
      $msiLog = Join-Path $env:WINDIR 'Temp\vrc-xen-tools-msi.log'
      # XenServer 6.5's launcher only starts its real installer at passive UI level; quiet UI is a no-op.
      $arguments = @('/i', ('"' + $installer.FullName + '"'), '/passive', '/norestart', 'REBOOT=ReallySuppress', '/L*v', ('"' + $msiLog + '"'))
      $process = Start-Process msiexec.exe -ArgumentList $arguments -PassThru
      if (-not $process.WaitForExit(1200000)) {
        $process.Kill()
        throw 'XenServer Tools installer timed out after 20 minutes.'
      }
      if ($process.ExitCode -eq 0 -or $process.ExitCode -eq 3010) {
        New-Item -ItemType File -Path $toolsMarker -Force | Out-Null
        Stop-Transcript | Out-Null
        & shutdown.exe /r /t 5 /c 'VRC XenServer Tools installed'
        exit 0
      }
      throw ('XenServer Tools installer failed with exit code ' + $process.ExitCode)
    }
    Start-Sleep -Seconds 5
  } while ((Get-Date) -lt $toolsDeadline)
}

if ((Test-Path $toolsMarker) -and $networkReady) {
  New-Item -ItemType File -Path $completeMarker -Force | Out-Null
  & schtasks.exe /Delete /TN $taskName /F | Out-Null
  Remove-Item 'C:\Windows\Panther\Unattend.xml','C:\Windows\Panther\Unattend\Unattend.xml' -Force -ErrorAction SilentlyContinue
}
Stop-Transcript | Out-Null
$lock.Dispose()
`;
}

/** Writes Windows SetupComplete entry points into the extracted Microsoft media tree. */
function writeWindowsSetupScripts(sourceTree: string, input: XenUnattendedIsoInput): void {
  const scriptsDir = join(sourceTree, "sources", "$OEM$", "$$", "Setup", "Scripts");
  ensureDir(scriptsDir);
  writeFileSync(join(scriptsDir, "VrcSetup.ps1"), buildWindowsSetupCompleteScript(input), { encoding: "utf8", mode: 0o600 });
  writeFileSync(
    join(scriptsDir, "SetupComplete.cmd"),
    "@echo off\r\nschtasks.exe /Create /TN \"VRC-Guest-Setup\" /SC ONSTART /RU SYSTEM /RL HIGHEST /TR \"powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\\Windows\\Setup\\Scripts\\VrcSetup.ps1\" /F >nul\r\nexit /b 0\r\n",
    { encoding: "ascii", mode: 0o600 },
  );
}

/**
 * Builds compact first-logon commands. The initialization task is started asynchronously so a
 * slow network driver or Xen Tools installer cannot hold the Windows first-use screen open.
 */
export function buildWindowsFirstLogonCommands(input: XenUnattendedIsoInput): WindowsFirstLogonCommands {
  void input;
  const remoteAccess = "cmd.exe /d /c netsh advfirewall set allprofiles state off & sc.exe config WinRM start= auto & net start WinRM & winrm.cmd quickconfig -quiet";
  const configure = buildWindowsSpecializeBootstrapCommand();
  const launch = 'cmd.exe /d /c if exist C:\\ProgramData\\VRC\\VrcSetup.ps1 start "" /b powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\\ProgramData\\VRC\\VrcSetup.ps1';
  const cleanup = "cmd.exe /c del /f /q C:\\Windows\\Panther\\Unattend.xml C:\\Windows\\Panther\\Unattend\\Unattend.xml 2>nul";
  const overlong = [remoteAccess, configure, launch, cleanup].find((command) => command.length >= 1024);
  if (overlong) {
    throw new Error(`Windows Server 2008 R2 首次登录命令超过 1023 字符限制：${overlong.length}`);
  }
  return { remoteAccess, configure, launch, cleanup };
}

function cidrPrefixLength(cidr: string): number | undefined {
  const raw = cidr.trim().split("/")[1];
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const prefix = Number(raw);
  return prefix >= 0 && prefix <= 32 ? prefix : undefined;
}

export function resolveWindowsImageIndex(isoName: string, installProfile: "server" | "desktop" = "desktop"): number {
  const desktop = installProfile === "desktop";
  if (/2012[_ -]?r2/i.test(isoName)) return desktop ? 2 : 1;
  if (/2008[_ -]?r2/i.test(isoName)) return desktop ? 1 : 2;
  return 1;
}

export function encodeWindowsUnattendPassword(password: string, elementName: "Password" | "AdministratorPassword"): string {
  return Buffer.from(`${password}${elementName}`, "utf16le").toString("base64");
}

export async function cleanupRegisteredXenGeneratedIso(connection: XenConnectionInput, registryId: string): Promise<void> {
  const record = getGeneratedIso(registryId);
  if (!record) throw new Error(`未找到生成 ISO 登记记录：${registryId}`);
  if (record.providerType !== "xenserver") throw new Error(`生成 ISO 不是 XenServer 类型：${registryId}`);
  if (!record.isoVdiUuid) throw new Error(`生成 ISO 尚未登记 VDI UUID：${registryId}`);
  const output = await runRemoteCommand(connection, buildXenGeneratedIsoCleanupScript(record));
  if (output.includes("VRC_REMOTE_VDI_MISSING")) {
    markGeneratedIsoStatus(registryId, "deleted", "远端 VDI 已不存在，已同步清理登记");
    return;
  }
  if (!output.includes("VRC_REMOTE_VDI_DELETED")) {
    throw new Error("XenServer 未返回生成 ISO 删除确认，拒绝更新本地登记状态");
  }
  markGeneratedIsoStatus(registryId, "deleted", "生成 ISO 已按登记记录清理");
}

export function buildXenGeneratedIsoCleanupScript(record: GeneratedIsoRecord): string {
  if (!record.isoVdiUuid) throw new Error(`生成 ISO 尚未登记 VDI UUID：${record.id}`);
  return [
    `iso_uuid='${escapeShellValue(record.isoVdiUuid)}'`,
    `expected_name='${escapeShellValue(record.isoName)}'`,
    `expected_path='${escapeShellValue(record.isoPath)}'`,
    `expected_registry='${escapeShellValue(record.id)}'`,
    `expected_task='${escapeShellValue(record.taskId)}'`,
    'vdi_uuid="$(xe vdi-list uuid="$iso_uuid" --minimal 2>/dev/null || true)"',
    'if [ -z "$vdi_uuid" ]; then printf "VRC_REMOTE_VDI_MISSING\\n"; exit 0; fi',
    'actual_name="$(xe vdi-param-get uuid="$iso_uuid" param-name=name-label 2>/dev/null)"',
    'actual_generated="$(xe vdi-param-get uuid="$iso_uuid" param-name=other-config param-key=vrc-generated 2>/dev/null)"',
    'actual_registry="$(xe vdi-param-get uuid="$iso_uuid" param-name=other-config param-key=vrc-registry-id 2>/dev/null)"',
    'actual_task="$(xe vdi-param-get uuid="$iso_uuid" param-name=other-config param-key=vrc-task-id 2>/dev/null)"',
    'actual_sr="$(xe vdi-param-get uuid="$iso_uuid" param-name=sr-uuid 2>/dev/null)"',
    'actual_location="$(xe vdi-param-get uuid="$iso_uuid" param-name=location 2>/dev/null)"',
    'actual_path="/var/run/sr-mount/$actual_sr/$actual_location"',
    '[ "$actual_name" = "$expected_name" ] || { echo "生成 ISO 名称不匹配，拒绝删除" >&2; exit 8; }',
    '[ "$actual_generated" = "true" ] || { echo "VDI 缺少 vrc-generated 标记，拒绝删除" >&2; exit 8; }',
    '[ "$actual_registry" = "$expected_registry" ] || { echo "VDI registry 标记不匹配，拒绝删除" >&2; exit 8; }',
    '[ "$actual_task" = "$expected_task" ] || { echo "VDI task 标记不匹配，拒绝删除" >&2; exit 8; }',
    '[ "$actual_path" = "$expected_path" ] || { echo "生成 ISO 远端路径不匹配，拒绝删除" >&2; exit 8; }',
    'attached="$(xe vbd-list vdi-uuid="$iso_uuid" currently-attached=true --minimal 2>/dev/null)"',
    '[ -z "$attached" ] || { echo "生成 ISO 仍被 VM 挂载，拒绝删除" >&2; exit 8; }',
    'xe vdi-destroy uuid="$iso_uuid"',
    '# 部分旧版 ISO SR 只注销 VDI；身份和完整路径均校验后再删除同一任务文件。',
    '[ ! -e "$actual_path" ] || rm -f -- "$actual_path"',
    'xe sr-scan uuid="$actual_sr" >/dev/null 2>&1 || true',
    'remaining_uuid="$(xe vdi-list uuid="$iso_uuid" --minimal 2>/dev/null || true)"',
    'remaining_name="$(xe vdi-list sr-uuid="$actual_sr" name-label="$expected_name" --minimal 2>/dev/null || true)"',
    '[ -z "$remaining_uuid" ] || { echo "删除后原 VDI UUID 仍存在" >&2; exit 9; }',
    '[ -z "$remaining_name" ] || { echo "删除后同名生成 ISO 仍存在" >&2; exit 9; }',
    '[ ! -e "$actual_path" ] || { echo "删除后生成 ISO 文件仍存在" >&2; exit 9; }',
    'printf "VRC_REMOTE_VDI_DELETED\\n"',
  ].join("\n");
}

async function readSourceIsoInfo(connection: XenConnectionInput, sourceIsoId: string, mountForBootFiles: boolean): Promise<SourceIsoInfo> {
  const output = await runRemoteCommand(
    connection,
    [
      `iso_uuid='${escapeShellValue(sourceIsoId)}'`,
      'sr_uuid="$(xe vdi-param-get uuid="$iso_uuid" param-name=sr-uuid 2>/dev/null)"',
      'location="$(xe vdi-param-get uuid="$iso_uuid" param-name=location 2>/dev/null)"',
      'remote_path="/var/run/sr-mount/$sr_uuid/$location"',
      'mount_dir="/tmp/vrc-source-iso-$iso_uuid"',
      '[ -f "$remote_path" ] || { echo "未找到源 ISO 文件：$remote_path" >&2; exit 6; }',
      'volume_label="$(blkid -p -s LABEL -o value "$remote_path" 2>/dev/null || true)"',
      mountForBootFiles
        ? [
            'mkdir -p "$mount_dir"',
            'current_source="$(mount | awk -v dir="$mount_dir" \'$3 == dir {print $1; exit}\')"',
            '[ -z "$current_source" ] || [ "$current_source" = "$remote_path" ] || umount "$mount_dir" >/dev/null 2>&1 || true',
            'mountpoint -q "$mount_dir" || mount -o loop,ro "$remote_path" "$mount_dir"',
            '[ -f "$mount_dir/isolinux/isolinux.bin" ] || { echo "源 ISO 缺少 isolinux.bin" >&2; exit 6; }',
            '[ -f "$mount_dir/isolinux/vmlinuz" ] || [ -f "$mount_dir/images/pxeboot/vmlinuz" ] || { echo "源 ISO 缺少 vmlinuz" >&2; exit 6; }',
            '[ -f "$mount_dir/isolinux/initrd.img" ] || [ -f "$mount_dir/images/pxeboot/initrd.img" ] || { echo "源 ISO 缺少 initrd.img" >&2; exit 6; }',
          ].join("\n")
        : 'mount_dir=""',
      'printf "SIZE\\t%s\\n" "$(stat -c %s "$remote_path" 2>/dev/null || wc -c < "$remote_path")"',
      'printf "ISO\\t%s\\t%s\\t%s\\t%s\\t%s\\n" "$sr_uuid" "$location" "$remote_path" "$mount_dir" "$volume_label"',
    ].join("\n"),
  );
  const line = output.split(/\r?\n/).find((item) => item.startsWith("ISO\t"));
  const [, srUuid = "", location = "", remotePath = "", mountDir = "", volumeLabel = ""] = line?.split("\t") ?? [];
  if (!srUuid || !location || !remotePath) {
    throw new Error("未读取到 XenServer 源 ISO 文件路径，无法生成无人值守 ISO。");
  }
  return {
    srUuid,
    location,
    remotePath,
    mountDir,
    sizeBytes: Number(output.split(/\r?\n/).find((item) => item.startsWith("SIZE\t"))?.split("\t")[1]) || 0,
    volumeLabel: volumeLabel || "CentOS 7 x86_64",
  };
}

interface LocalBootFiles {
  isolinuxBin: string;
  vmlinuz: string;
  initrd: string;
}

interface LocalBootLoaderFiles {
  isolinuxBin: string;
  vmlinuz: string;
  initrd: string;
  isolinuxFiles: string[];
}

async function ensureLocalBootFiles(connection: XenConnectionInput, source: SourceIsoInfo): Promise<LocalBootFiles> {
  const sourceKey = `${safeFileName(source.srUuid)}__${safeFileName(source.location)}`;
  const localDir = join(cacheDir, sourceKey);
  if (existsSync(localDir) && !statSync(localDir).isDirectory()) {
    rmSync(localDir, { force: true });
  }
  ensureDir(localDir);
  const files = {
    isolinuxBin: join(localDir, "isolinux.bin"),
    vmlinuz: join(localDir, "vmlinuz"),
    initrd: join(localDir, "initrd.img"),
  };
  if (existsSync(files.isolinuxBin) && existsSync(files.vmlinuz) && existsSync(files.initrd)) {
    return files;
  }
  await downloadFile(connection, `${source.mountDir}/isolinux/isolinux.bin`, files.isolinuxBin);
  await downloadFirstExisting(connection, [`${source.mountDir}/images/pxeboot/vmlinuz`, `${source.mountDir}/isolinux/vmlinuz`], files.vmlinuz);
  await downloadFirstExisting(connection, [`${source.mountDir}/images/pxeboot/initrd.img`, `${source.mountDir}/isolinux/initrd.img`], files.initrd);
  return files;
}

async function ensureLocalBootLoaderFiles(connection: XenConnectionInput, source: SourceIsoInfo): Promise<LocalBootLoaderFiles> {
  const sourceKey = `${safeFileName(source.srUuid)}__${safeFileName(source.location)}__boot`;
  const localDir = join(cacheDir, sourceKey);
  if (existsSync(localDir) && !statSync(localDir).isDirectory()) {
    rmSync(localDir, { force: true });
  }
  ensureDir(localDir);
  const files = {
    isolinuxBin: join(localDir, "isolinux.bin"),
    vmlinuz: join(localDir, "vmlinuz"),
    initrd: join(localDir, "initrd.img"),
    isolinuxFiles: [] as string[],
  };
  const isolinuxFilesDir = join(localDir, "isolinux-files");
  ensureDir(isolinuxFilesDir);
  files.isolinuxFiles = listLocalFiles(isolinuxFilesDir);
  if (existsSync(files.isolinuxBin) && existsSync(files.vmlinuz) && existsSync(files.initrd) && files.isolinuxFiles.length) {
    return files;
  }
  await downloadFile(connection, `${source.mountDir}/isolinux/isolinux.bin`, files.isolinuxBin);
  await downloadFirstExisting(connection, [`${source.mountDir}/images/pxeboot/vmlinuz`, `${source.mountDir}/isolinux/vmlinuz`], files.vmlinuz);
  await downloadFirstExisting(connection, [`${source.mountDir}/images/pxeboot/initrd.img`, `${source.mountDir}/isolinux/initrd.img`], files.initrd);
  const isolinuxNames = await listRemoteIsolinuxFiles(connection, `${source.mountDir}/isolinux`);
  for (const name of isolinuxNames) {
    await downloadFile(connection, `${source.mountDir}/isolinux/${name}`, join(isolinuxFilesDir, name));
  }
  files.isolinuxFiles = listLocalFiles(isolinuxFilesDir);
  return files;
}

async function generateCentosHttpBootIso(
  bootFiles: LocalBootFiles,
  outputIso: string,
  input: XenUnattendedIsoInput,
): Promise<void> {
  const workDir = join(generatedDir, `${safeFileName(input.vm.name)}-work`);
  const isolinuxDir = join(workDir, "isolinux");
  const pxebootDir = join(workDir, "images", "pxeboot");
  rmSync(workDir, { recursive: true, force: true });
  ensureDir(workDir);
  ensureDir(isolinuxDir);
  ensureDir(pxebootDir);
  copyFileSync(bootFiles.isolinuxBin, join(isolinuxDir, "isolinux.bin"));
  copyFileSync(bootFiles.vmlinuz, join(isolinuxDir, "vmlinuz"));
  copyFileSync(bootFiles.initrd, join(isolinuxDir, "initrd.img"));
  copyFileSync(bootFiles.vmlinuz, join(pxebootDir, "vmlinuz"));
  copyFileSync(bootFiles.initrd, join(pxebootDir, "initrd.img"));
  const isolinuxPath = join(isolinuxDir, "isolinux.cfg");
  const installUrls = buildInstallUrls(input);
  writeFileSync(isolinuxPath, buildCentosIsolinuxConfig(), "utf8");
  const xorriso = resolveXorrisoPath();
  await execFileAsync(xorriso, [
    "-as",
    "mkisofs",
    "-o",
    outputIso,
    "-b",
    "isolinux/isolinux.bin",
    "-c",
    "isolinux/boot.cat",
    "-no-emul-boot",
    "-boot-load-size",
    "4",
    "-boot-info-table",
    "-R",
    "-J",
    "-V",
    centosBootIsoLabel,
    workDir,
  ]);

  function buildCentosIsolinuxConfig(): string {
    const netmask = cidrToNetmask(input.ipPool.cidr) || "255.255.255.0";
    const macBinding = input.macAddress ? ` ifname=eth0:${input.macAddress}` : "";
    return `default linux
prompt 0
timeout 10
label linux
  kernel vmlinuz
  append initrd=initrd.img inst.repo=${installUrls.repoUrl} inst.ks=${installUrls.ksUrl} rd.neednet=1 net.ifnames=0 biosdevname=0${macBinding} ip=${input.vm.ip}::${input.ipPool.gateway}:${netmask}:vrc:eth0:none bootdev=eth0 ksdevice=eth0
`;
  }
}

async function generateCentosKickstartBootIso(
  bootFiles: LocalBootLoaderFiles,
  sourceVolumeLabel: string,
  outputIso: string,
  input: XenUnattendedIsoInput,
): Promise<void> {
  const workDir = join(generatedDir, `${safeFileName(input.vm.name)}-ks-work`);
  const isolinuxDir = join(workDir, "isolinux");
  rmSync(workDir, { recursive: true, force: true });
  rmSync(outputIso, { force: true });
  ensureDir(workDir);
  ensureDir(isolinuxDir);
  for (const isolinuxFile of bootFiles.isolinuxFiles) {
    copyFileSync(isolinuxFile, join(isolinuxDir, isolinuxFile.split("/").pop() || "isolinux-file"));
  }
  copyFileSync(bootFiles.isolinuxBin, join(isolinuxDir, "isolinux.bin"));
  copyFileSync(bootFiles.vmlinuz, join(isolinuxDir, "vmlinuz"));
  copyFileSync(bootFiles.initrd, join(isolinuxDir, "initrd.img"));
  writeFileSync(join(workDir, "ks.cfg"), buildOfflineCentosKickstart(input), "utf8");
  writeFileSync(join(isolinuxDir, "isolinux.cfg"), buildKickstartBootIsolinuxConfig(input, sourceVolumeLabel), "utf8");
  const xorriso = resolveXorrisoPath();
  await execFileAsync(xorriso, [
    "-as",
    "mkisofs",
    "-o",
    outputIso,
    "-b",
    "isolinux/isolinux.bin",
    "-c",
    "isolinux/boot.cat",
    "-no-emul-boot",
    "-boot-load-size",
    "4",
    "-boot-info-table",
    "-R",
    "-J",
    "-V",
    centosKickstartIsoLabel,
    workDir,
  ]);
}

function buildKickstartBootIsolinuxConfig(input: XenUnattendedIsoInput, sourceVolumeLabel: string): string {
  const netmask = cidrToNetmask(input.ipPool.cidr) || "255.255.255.0";
  const macBinding = input.macAddress ? ` ifname=eth0:${input.macAddress}` : "";
  const stage2Label = escapeAnacondaLabel(sourceVolumeLabel);
  return `default linux
prompt 0
timeout 10
label linux
  menu label Install ${input.vm.name}
  kernel vmlinuz
  append initrd=initrd.img inst.stage2=hd:LABEL=${stage2Label} inst.ks=hd:LABEL=${centosKickstartIsoLabel}:/ks.cfg rd.neednet=1 net.ifnames=0 biosdevname=0${macBinding} ip=${input.vm.ip}::${input.ipPool.gateway}:${netmask}:vrc:eth0:none bootdev=eth0 ksdevice=eth0
`;
}

function buildInstallUrls(input: XenUnattendedIsoInput): { repoUrl: string; ksUrl: string } {
  if (!input.installSource) {
    throw new Error("HTTP 启动 ISO 缺少集中安装源。");
  }
  return {
    repoUrl: input.installSource.repoUrl,
    ksUrl: input.installSource.ksUrl,
  };
}

async function ensureLocalSourceIso(connection: XenConnectionInput, source: SourceIsoInfo): Promise<string> {
  const sourceKey = `${safeFileName(source.srUuid)}__${safeFileName(source.location)}`;
  const localDir = join(cacheDir, sourceKey);
  ensureDir(localDir);
  const localIso = join(localDir, safeFileName(source.location));
  ensureDir(dirname(localIso));
  if (existsSync(localIso) && statSync(localIso).isFile()) {
    const localSize = statSync(localIso).size;
    if (!source.sizeBytes || localSize === source.sizeBytes) return localIso;
  }
  await downloadFile(connection, source.remotePath, localIso);
  return localIso;
}

// 基于原始 DVD ISO 增量写入 ks.cfg 和启动菜单，保留源 ISO 软件包仓库，避免下载 RPM 时依赖 VRC API。
async function generateCentosOfflineUnattendedIso(sourceIso: string, outputIso: string, input: XenUnattendedIsoInput): Promise<void> {
  const workDir = join(generatedDir, `${safeFileName(input.vm.name)}-offline-work`);
  rmSync(workDir, { recursive: true, force: true });
  rmSync(outputIso, { force: true });
  ensureDir(workDir);
  const volumeId = await readIsoVolumeId(sourceIso);
  const ksPath = join(workDir, "ks.cfg");
  const isolinuxPath = join(workDir, "isolinux.cfg");
  const grubPath = join(workDir, "grub.cfg");
  writeFileSync(ksPath, buildOfflineCentosKickstart(input), "utf8");
  writeFileSync(isolinuxPath, buildOfflineCentosIsolinuxConfig(input, volumeId), "utf8");
  writeFileSync(grubPath, buildOfflineCentosGrubConfig(input, volumeId), "utf8");
  const xorriso = resolveXorrisoPath();
  await execFileAsync(xorriso, [
    "-indev",
    sourceIso,
    "-outdev",
    outputIso,
    "-boot_image",
    "any",
    "replay",
    "-map",
    ksPath,
    "/ks.cfg",
    "-map",
    isolinuxPath,
    "/isolinux/isolinux.cfg",
    "-map",
    grubPath,
    "/EFI/BOOT/grub.cfg",
    "-commit",
  ]);
}

async function readIsoVolumeId(sourceIso: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(resolveXorrisoPath(), ["-indev", sourceIso, "-pvd_info"]);
    const line = stdout.split(/\r?\n/).find((item) => item.startsWith("Volume Id"));
    const value = line?.split(":").slice(1).join(":").trim();
    return value || "CentOS 7 x86_64";
  } catch {
    return "CentOS 7 x86_64";
  }
}

function buildOfflineCentosIsolinuxConfig(input: XenUnattendedIsoInput, volumeId: string): string {
  const netmask = cidrToNetmask(input.ipPool.cidr) || "255.255.255.0";
  const macBinding = input.macAddress ? ` ifname=eth0:${input.macAddress}` : "";
  const stage2Label = escapeAnacondaLabel(volumeId);
  return `default linux
prompt 0
timeout 10
label linux
  menu label Install ${input.vm.name}
  kernel vmlinuz
  append initrd=initrd.img inst.stage2=hd:LABEL=${stage2Label} inst.ks=cdrom:/ks.cfg rd.neednet=1 net.ifnames=0 biosdevname=0${macBinding} ip=${input.vm.ip}::${input.ipPool.gateway}:${netmask}:vrc:eth0:none bootdev=eth0 ksdevice=eth0
`;
}

function buildOfflineCentosGrubConfig(input: XenUnattendedIsoInput, volumeId: string): string {
  const netmask = cidrToNetmask(input.ipPool.cidr) || "255.255.255.0";
  const macBinding = input.macAddress ? ` ifname=eth0:${input.macAddress}` : "";
  const stage2Label = escapeAnacondaLabel(volumeId);
  return `set default="0"
set timeout=1
menuentry 'Install ${input.vm.name}' {
  linuxefi /images/pxeboot/vmlinuz inst.stage2=hd:LABEL=${stage2Label} inst.ks=cdrom:/ks.cfg rd.neednet=1 net.ifnames=0 biosdevname=0${macBinding} ip=${input.vm.ip}::${input.ipPool.gateway}:${netmask}:vrc:eth0:none bootdev=eth0 ksdevice=eth0
  initrdefi /images/pxeboot/initrd.img
}
`;
}

export function buildOfflineCentosKickstart(
  input: Pick<XenUnattendedIsoInput, "vm" | "ipPool">,
  options: {
    monitoringTool?: "proxmox" | "vmware";
    firmware?: "bios" | "uefi";
    packageEnvironment?: string;
    graphicalTarget?: boolean;
  } = {},
): string {
  const netmask = cidrToNetmask(input.ipPool.cidr) || "255.255.255.0";
  const dns = sanitizeKickstartValue(input.ipPool.dns[0] ?? "");
  const gateway = sanitizeKickstartValue(input.ipPool.gateway);
  const ip = sanitizeKickstartValue(input.vm.ip);
  const rootPassword = sanitizeKickstartValue(input.vm.rootPassword ?? "");
  const rootPasswordEntry = shellSingleQuote(`root:${rootPassword}`);
  const rootPasswordValue = shellSingleQuote(rootPassword || "changeme");
  const rootPasswordHashValue = md5Crypt(rootPassword || "changeme");
  const rootPasswordHash = shellSingleQuote(rootPasswordHashValue);
  const hostname = sanitizeKickstartValue(input.vm.name);
  const monitoringPackage = options.monitoringTool === "proxmox" ? "qemu-guest-agent" : options.monitoringTool === "vmware" ? "open-vm-tools" : "";
  const monitoringService = options.monitoringTool === "proxmox" ? "qemu-guest-agent" : options.monitoringTool === "vmware" ? "vmtoolsd" : "";
  return `#version=DEVEL
install
cdrom
lang en_US.UTF-8
keyboard us
timezone Asia/Shanghai --isUtc
rootpw --iscrypted ${rootPasswordHashValue}
auth --enableshadow --passalgo=sha512
selinux --disabled
firewall --disabled
firstboot --disabled
network --bootproto=static --device=eth0 --ip=${ip} --netmask=${netmask} --gateway=${gateway} --nameserver=${dns} --hostname=${hostname} --onboot=on --activate
bootloader --location=mbr
${buildCentosLvmPartitioning(input.vm.diskGiB, { firmware: options.firmware })}
reboot --eject
${buildCentosPackageSelection([monitoringPackage], { environmentGroup: options.packageEnvironment })}
%post --log=/root/vrc-kickstart-post.log
cat > /etc/sysconfig/network-scripts/ifcfg-eth0 <<'VRC_IFCFG'
TYPE=Ethernet
DEVICE=eth0
NAME=eth0
BOOTPROTO=none
ONBOOT=yes
IPADDR=${ip}
NETMASK=${netmask}
GATEWAY=${gateway}
DNS1=${dns}
DEFROUTE=yes
IPV6INIT=no
VRC_IFCFG
authconfig --enableshadow --passalgo=sha512 --update || true
printf '%s\\n' ${rootPasswordEntry} | chpasswd || true
printf '%s\\n' ${rootPasswordValue} | passwd --stdin root || true
usermod -p ${rootPasswordHash} root || true
passwd --unlock root || true
for key in PermitRootLogin PasswordAuthentication UsePAM; do
  case "$key" in
    PermitRootLogin) value=yes ;;
    PasswordAuthentication) value=yes ;;
    UsePAM) value=yes ;;
  esac
  if grep -Eq "^[#[:space:]]*$key[[:space:]]+" /etc/ssh/sshd_config; then
    sed -ri "s|^[#[:space:]]*$key[[:space:]]+.*|$key $value|" /etc/ssh/sshd_config
  else
    printf '%s %s\\n' "$key" "$value" >> /etc/ssh/sshd_config
  fi
done
systemctl enable network || true
systemctl disable firewalld || true
systemctl enable sshd
${monitoringService ? `systemctl enable ${monitoringService} || true` : ""}
${options.graphicalTarget ? "systemctl set-default graphical.target" : ""}
%end
%post --nochroot --log=/tmp/vrc-kickstart-eject.log
eject /dev/sr0 >/dev/null 2>&1 || true
eject /dev/sr1 >/dev/null 2>&1 || true
%end
`;
}

async function uploadIso(connection: XenConnectionInput, localPath: string, remotePath: string): Promise<void> {
  try {
    await uploadFile(connection, localPath, remotePath);
  } catch (error) {
    await cleanupFailedGeneratedIsoUpload(connection, remotePath).catch(() => undefined);
    const sizeMiB = Math.ceil(statSync(localPath).size / 1024 / 1024);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`上传无人值守 ISO 失败：${detail}。目标 ISO SR 可能空间不足或 SMB 写入失败；本次 ISO 大小约 ${sizeMiB} MiB。`);
  }
}

async function cleanupFailedGeneratedIsoUpload(connection: XenConnectionInput, remotePath: string): Promise<void> {
  const fileName = remotePath.split("/").pop() ?? "";
  if (!fileName.startsWith("vrc-") || !fileName.endsWith(".iso")) return;
  await runRemoteCommand(
    connection,
    [
      `remote_path='${escapeShellValue(remotePath)}'`,
      'case "$remote_path" in */vrc-*.iso) rm -f "$remote_path" ;; esac',
    ].join("\n"),
  );
}

async function scanAndFindUploadedIso(connection: XenConnectionInput, srUuid: string, isoName: string): Promise<string> {
  const output = await runRemoteCommand(
    connection,
    [
      `sr_uuid='${escapeShellValue(srUuid)}'`,
      `iso_name='${escapeShellValue(isoName)}'`,
      'xe sr-scan uuid="$sr_uuid" >/dev/null',
      'for vdi in $(xe vdi-list sr-uuid="$sr_uuid" --minimal 2>/dev/null | tr "," " "); do',
      '  label="$(xe vdi-param-get uuid="$vdi" param-name=name-label 2>/dev/null)"',
      '  location="$(xe vdi-param-get uuid="$vdi" param-name=location 2>/dev/null)"',
      '  if [ "$label" = "$iso_name" ] || [ "$location" = "$iso_name" ]; then',
      '    printf "VDI\\t%s\\n" "$vdi"',
      "    exit 0",
      "  fi",
      "done",
      'echo "未找到已上传的无人值守 ISO：$iso_name" >&2',
      "exit 7",
    ].join("\n"),
  );
  const line = output.split(/\r?\n/).find((item) => item.startsWith("VDI\t"));
  const [, isoId = ""] = line?.split("\t") ?? [];
  if (!isoId) throw new Error(`未找到已上传的无人值守 ISO：${isoName}`);
  return isoId;
}

async function markGeneratedIsoOnXen(
  connection: XenConnectionInput,
  input: {
    isoId: string;
    registryId: string;
    taskId: string;
    vmName: string;
  },
): Promise<void> {
  await runRemoteCommand(
    connection,
    [
      `iso_uuid='${escapeShellValue(input.isoId)}'`,
      `registry_id='${escapeShellValue(input.registryId)}'`,
      `task_id='${escapeShellValue(input.taskId)}'`,
      `vm_name='${escapeShellValue(input.vmName)}'`,
      'xe vdi-param-set uuid="$iso_uuid" other-config:vrc-generated=true >/dev/null',
      'xe vdi-param-set uuid="$iso_uuid" other-config:vrc-registry-id="$registry_id" >/dev/null',
      'xe vdi-param-set uuid="$iso_uuid" other-config:vrc-task-id="$task_id" >/dev/null',
      'xe vdi-param-set uuid="$iso_uuid" other-config:vrc-vm-name="$vm_name" >/dev/null',
    ].join("\n"),
  );
}

function downloadFile(connection: XenConnectionInput, remotePath: string, localPath: string): Promise<void> {
  ensureDir(dirname(localPath));
  return withSftp(connection, (sftp) => new Promise((resolve, reject) => sftp.fastGet(remotePath, localPath, (error) => (error ? reject(error) : resolve()))));
}

async function downloadFirstExisting(connection: XenConnectionInput, remotePaths: string[], localPath: string): Promise<void> {
  let lastError: unknown;
  for (const remotePath of remotePaths) {
    try {
      await downloadFile(connection, remotePath, localPath);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`未找到可下载的启动文件：${remotePaths.join(", ")}`);
}

async function listRemoteIsolinuxFiles(connection: XenConnectionInput, remoteDir: string): Promise<string[]> {
  const output = await runRemoteCommand(
    connection,
    [
      `remote_dir='${escapeShellValue(remoteDir)}'`,
      'find "$remote_dir" -maxdepth 1 -type f -printf "%f\\n" 2>/dev/null || true',
    ].join("\n"),
  );
  return output
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter((item) => /^[A-Za-z0-9_.-]+$/.test(item));
}

function listLocalFiles(localDir: string): string[] {
  try {
    return readdirSync(localDir)
      .map((item) => join(localDir, item));
  } catch {
    return [];
  }
}

function uploadFile(connection: XenConnectionInput, localPath: string, remotePath: string): Promise<void> {
  const expectedSize = statSync(localPath).size;
  return withSftp<void>(connection, (sftp) => new Promise<void>((resolve, reject) => {
    const fd = openSync(localPath, "r");
    const chunkSize = 4 * 1024 * 1024;
    const buffer = Buffer.allocUnsafe(chunkSize);
    let offset = 0;
    let handle: Buffer | undefined;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (handle) sftp.close(handle, () => undefined);
      closeSync(fd);
      error ? reject(error) : resolve();
    };
    const writeNext = () => {
      if (settled) return;
      const length = readSync(fd, buffer, 0, chunkSize, offset);
      if (!length) {
        finish();
        return;
      }
      const data = Buffer.from(buffer.subarray(0, length));
      const writeWithRetry = (attempt: number) => {
        const timer = setTimeout(() => {
          if (attempt >= 2) {
            finish(new Error(`SFTP 分块写入超时，偏移 ${offset}`));
            return;
          }
          writeWithRetry(attempt + 1);
        }, 60 * 1000);
        sftp.write(handle!, data, 0, data.length, offset, (error) => {
          clearTimeout(timer);
          if (error) {
            if (attempt >= 2) {
              finish(error);
              return;
            }
            writeWithRetry(attempt + 1);
            return;
          }
          offset += length;
          writeNext();
        });
      };
      writeWithRetry(0);
    };
    sftp.open(remotePath, "w", 0o600, (error, opened) => {
      if (error || !opened) {
        finish(error || new Error("无法打开 XenServer 远端 ISO 文件"));
        return;
      }
      handle = opened;
      writeNext();
    });
  })).then(async () => {
    const output = await runRemoteCommand(
      connection,
      `remote_path='${escapeShellValue(remotePath)}'; [ -f "$remote_path" ] && stat -c %s "$remote_path"`,
    );
    const actualSize = Number(output.trim());
    if (actualSize !== expectedSize) {
      throw new Error(`远端 ISO 大小不一致：${actualSize || "不存在"} != ${expectedSize}`);
    }
  });
}

function withSftp<T>(connection: XenConnectionInput, task: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const client = createClient();
    client
      .on("ready", () => {
        client.sftp((error, sftp) => {
          if (error) {
            client.end();
            reject(error);
            return;
          }
          task(sftp)
            .then(resolve, reject)
            .finally(() => {
              sftp.end();
              client.end();
            });
        });
      })
      .on("error", reject)
      .connect(sshOptions(connection));
  });
}

function runRemoteCommand(connection: XenConnectionInput, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = createClient();
    let stdout = "";
    let stderr = "";
    client
      .on("ready", () => {
        client.exec(command, (error, stream) => {
          if (error) {
            client.end();
            reject(error);
            return;
          }
          stream
            .on("close", (code: number) => {
              client.end();
              if (code !== 0) {
                reject(new Error(stderr || `XenServer command exited with code ${code}`));
                return;
              }
              resolve(stdout);
            })
            .on("data", (data: Buffer) => {
              stdout += data.toString("utf8");
            })
            .stderr.on("data", (data: Buffer) => {
              stderr += data.toString("utf8");
            });
        });
      })
      .on("error", reject)
      .connect(sshOptions(connection));
  });
}

function createClient(): Client {
  return new Client();
}

function sshOptions(connection: XenConnectionInput): ConnectConfig {
  return {
    host: connection.host,
    port: connection.port,
    username: connection.username,
    password: connection.password,
    readyTimeout: 15000,
    algorithms: {
      kex: ["diffie-hellman-group14-sha1", "diffie-hellman-group1-sha1", "diffie-hellman-group-exchange-sha1"],
      serverHostKey: ["ssh-rsa", "ssh-dss"],
    },
  };
}

function resolveXorrisoPath(): string {
  if (existsSync("/opt/homebrew/bin/xorriso")) return "/opt/homebrew/bin/xorriso";
  if (existsSync("/usr/local/bin/xorriso")) return "/usr/local/bin/xorriso";
  return "xorriso";
}

async function assertIsoGeneratorAvailable(): Promise<void> {
  const xorriso = resolveXorrisoPath();
  try {
    await execFileAsync(xorriso, ["-version"]);
  } catch {
    throw new Error("本机缺少 xorriso，无法生成 XenServer 无人值守启动 ISO。请先安装 xorriso 后重试。");
  }
}

function cidrToNetmask(cidr: string | undefined): string {
  const bits = Number(cidr?.split("/")[1]);
  if (!Number.isFinite(bits) || bits < 0 || bits > 32) return "";
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return [24, 16, 8, 0].map((shift) => (mask >>> shift) & 255).join(".");
}

function escapeAnacondaLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/ /g, "\\x20");
}

function sanitizeKickstartValue(value: string): string {
  return value.replace(/[\r\n]/g, "").trim();
}

function md5Crypt(password: string, salt = "vrcinst"): string {
  const magic = "$1$";
  const normalizedSalt = salt.replace(/^\$1\$/, "").split("$")[0].slice(0, 8);
  const passwordBuffer = Buffer.from(password, "utf8");
  const saltBuffer = Buffer.from(normalizedSalt, "utf8");
  let ctx = Buffer.concat([passwordBuffer, Buffer.from(magic), saltBuffer]);
  const alternate = createHash("md5").update(passwordBuffer).update(saltBuffer).update(passwordBuffer).digest();
  for (let remaining = passwordBuffer.length; remaining > 0; remaining -= 16) {
    ctx = Buffer.concat([ctx, alternate.subarray(0, Math.min(16, remaining))]);
  }
  for (let i = passwordBuffer.length; i > 0; i >>= 1) {
    ctx = Buffer.concat([ctx, Buffer.from([i & 1 ? 0 : passwordBuffer[0]])]);
  }
  let final = createHash("md5").update(ctx).digest();
  for (let i = 0; i < 1000; i += 1) {
    let loop = Buffer.alloc(0);
    loop = Buffer.concat([loop, i & 1 ? passwordBuffer : final]);
    if (i % 3) loop = Buffer.concat([loop, saltBuffer]);
    if (i % 7) loop = Buffer.concat([loop, passwordBuffer]);
    loop = Buffer.concat([loop, i & 1 ? final : passwordBuffer]);
    final = createHash("md5").update(loop).digest();
  }
  return `${magic}${normalizedSalt}$${toCrypt64(final)}`;
}

function toCrypt64(final: Buffer): string {
  const alphabet = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const encode = (value: number, length: number) => {
    let result = "";
    for (let i = 0; i < length; i += 1) {
      result += alphabet[value & 0x3f];
      value >>= 6;
    }
    return result;
  };
  return [
    encode((final[0] << 16) | (final[6] << 8) | final[12], 4),
    encode((final[1] << 16) | (final[7] << 8) | final[13], 4),
    encode((final[2] << 16) | (final[8] << 8) | final[14], 4),
    encode((final[3] << 16) | (final[9] << 8) | final[15], 4),
    encode((final[4] << 16) | (final[10] << 8) | final[5], 4),
    encode(final[11], 2),
  ].join("");
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120) || "unnamed";
}

function buildWindowsComputerName(vmName: string, ip: string): string {
  const suffix = ip.split(".").pop()?.replace(/\D/g, "") || "VM";
  const normalized = vmName.replace(/[^A-Za-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 10);
  return `${normalized || "VRC"}-${suffix}`.slice(0, 15);
}

function powershellQuote(value: string): string {
  return value.replace(/'/g, "''").replace(/[\r\n]/g, "");
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function escapeShellValue(value: string): string {
  return value.replace(/'/g, "'\\''");
}
