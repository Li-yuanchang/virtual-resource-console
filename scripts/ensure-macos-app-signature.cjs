const { execFileSync, spawnSync } = require("node:child_process");
const path = require("node:path");

module.exports = async function ensureMacosAppSignature(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  try {
    execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "ignore" });
  } catch {
    execFileSync("codesign", ["--force", "--deep", "--sign", "-", "--timestamp=none", appPath], { stdio: "inherit" });
    execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "inherit" });
  }

  const signatureResult = spawnSync("codesign", ["-dv", "--verbose=4", appPath], { encoding: "utf8" });
  const signatureInfo = `${signatureResult.stdout || ""}${signatureResult.stderr || ""}`;

  // A real Developer ID signature already has a stable designated requirement.
  if (!signatureInfo.includes("Signature=adhoc")) {
    execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "inherit" });
    return;
  }

  const designatedRequirement = '=designated => identifier "com.virtualresource.console"';
  execFileSync(
    "codesign",
    ["--force", "--sign", "-", "--timestamp=none", "--requirements", designatedRequirement, appPath],
    { stdio: "inherit" },
  );
  execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", "--requirements", designatedRequirement, appPath], { stdio: "inherit" });
};
