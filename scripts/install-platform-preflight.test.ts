import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const installer = fs.readFileSync(path.join(root, "install.sh"), "utf8");
const developmentInstaller = fs.readFileSync(
  path.join(root, "scripts/install-development.sh"),
  "utf8",
);
const launcher = fs.readFileSync(path.join(root, "fased.mjs"), "utf8");
const packageManifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
  os?: string[];
};
const installerReference = fs.readFileSync(
  path.join(root, "docs", "install", "installer.md"),
  "utf8",
);
const platformClaims = [
  "docs/start/setup-matrix.md",
  "docs/platforms/index.md",
  "docs/platforms/linux.md",
  "docs/platforms/windows.md",
  "docs/platforms/oracle.md",
  "docs/platforms/raspberry-pi.md",
  "docs/platforms/macos.md",
  "docs/platforms/mac/bundled-gateway.md",
].map((relative) => fs.readFileSync(path.join(root, relative), "utf8"));
const publicInstallClaims = [
  "docs/index.md",
  "docs/start/getting-started.md",
  "docs/start/fased.md",
  "docs/start/onboarding-overview.md",
  "docs/start/agent-wallet-mining-walkthrough.md",
  "docs/start/wizard.md",
  "docs/install/updating.md",
  "docs/install/uninstall.md",
  "docs/platforms/index.md",
  "docs/platforms/windows.md",
].map((relative) => fs.readFileSync(path.join(root, relative), "utf8"));
const releaseWorkflow = fs.readFileSync(
  path.join(root, ".github", "workflows", "hosted-runtime-release.yml"),
  "utf8",
);
const signerRelease = fs.readFileSync(
  path.join(root, "scripts", "release-fased-signerd.sh"),
  "utf8",
);
const lifecycleRelease = fs.readFileSync(
  path.join(root, "scripts", "release-fased-lifecycled.sh"),
  "utf8",
);

describe("installer platform preflight", () => {
  it("fails closed before completion unless the public command works from another directory", () => {
    const verification = installer.indexOf("verify_public_command() {");
    const completion = installer.indexOf(
      'print_installer_stage "Installation complete: ${release}"',
    );
    expect(verification).toBeGreaterThan(0);
    expect(verification).toBeLessThan(completion);
    expect(installer).toContain('cd /tmp && test "$(command -v fased)" = /usr/local/bin/fased');
    expect(installer).toContain("fased status");
    expect(installer).toContain('fased update --channel "$2" --tag "$1"');
    expect(installer).toContain('/usr/sbin/runuser -u "$operator_user"');
    expect(installer).toContain("PATH=/usr/local/bin:/usr/bin:/bin");
    expect(installer).toContain("printf '%s\\n' \"$update_output\" >&2");
    expect(installer).toContain('grep -Fqx "Already current: $release" <<<"$update_output"');
    expect(installer).toContain('/bin/bash -c "$command_probe" fased "$release" "$channel"');
  });
  it("supports managed Linux and macOS while rejecting native Windows runtime", () => {
    expect(installer).toContain('case "$(uname -s)"');
    expect(installer).toContain("managed lifecycle installation supports Linux and macOS");
    expect(packageManifest.os).toEqual(["linux", "darwin"]);
    expect(launcher).toContain('if (process.platform === "win32")');
    expect(launcher).toContain("Native Windows is not a supported Fased runtime");
    expect(launcher).not.toContain("fased-launcher-runtime.mjs");
  });

  it("accepts only Ubuntu WSL2 Local with systemd and Linux-owned state", () => {
    const acquisition = installer.indexOf(
      'print_installer_stage "Installing ${profile} release ${release}..."',
    );
    for (const predicate of [
      "managed_wsl2=1",
      "Ubuntu WSL2 supports the Local profile only",
      "WSL1 is unsupported; install Ubuntu on WSL2",
      "managed WSL2 Local currently requires the Ubuntu distribution",
      '[[ "$pid1" == "systemd" ]]',
      '[[ "$record_name" == "$operator_user" && "$operator_home" == /home/*',
    ]) {
      const position = installer.indexOf(predicate);
      expect(position).toBeGreaterThan(0);
      expect(position).toBeLessThan(acquisition);
    }
    expect(installer).toContain("not a Windows-mounted path such as /mnt/c");
    expect(installer).toContain("managed Ubuntu WSL2 Local currently supports x86_64 only");
  });

  it("keeps Linux arm64 Local-only until Hosting has literal acceptance", () => {
    expect(installer).toContain("Linux arm64 is Local-only");
    expect(installer).toContain('[[ "$profile" != "hosting" || "$arch" == "x64" ]]');
  });

  it("selects x64 and arm64 before lifecycle acquisition or privileged mutation", () => {
    const architecturePreflight = installer.indexOf('case "$(uname -m)"');
    const acquisition = installer.indexOf(
      'print_installer_stage "Installing ${profile} release ${release}..."',
    );
    const privilegedInstall = installer.indexOf('install -d -m 0755 "$bootstrap_dir"');

    expect(installer).toContain('aarch64|arm64) arch="arm64"');
    expect(installer).toContain("supports x86_64 and arm64");
    expect(architecturePreflight).toBeGreaterThan(0);
    expect(architecturePreflight).toBeLessThan(acquisition);
    expect(architecturePreflight).toBeLessThan(privilegedInstall);
  });

  it("frames public installer stages instead of emitting loose phase logs", () => {
    expect(installer).toContain("print_installer_stage()");
    expect(installer).toContain("╭─ FASED INSTALL");
    expect(installer).toContain(
      'print_installer_stage "Installing ${profile} release ${release}..."',
    );
    expect(installer).toContain('print_installer_stage "Installation complete: ${release}"');
    expect(installer).not.toContain('echo "Fased: applying ${profile} release ${release}..."');
    expect(installer).not.toContain('print_installer_stage "Verifying public command..."');
  });

  it("builds Linux arm64 and native macOS supplements", () => {
    expect(releaseWorkflow).toContain("ubuntu-24.04-arm");
    expect(releaseWorkflow).toContain("build-linux-arm64-release-supplement.sh");
    expect(releaseWorkflow).toContain("build-darwin-release-supplement.sh");
    expect(releaseWorkflow).toContain("macos-15-intel");
    expect(releaseWorkflow).toContain("macos-15");
    expect(installer).toContain('bootstrap_asset="fased-bootstrap-${operating_system}-${arch}"');
    expect(installer).toContain("macOS supports the Local profile only");
    expect(signerRelease).toContain('TARGETS="${FASED_SIGNER_TARGETS:-linux/amd64}"');
    expect(lifecycleRelease).toContain('TARGETS="${FASED_LIFECYCLE_TARGETS:-linux/amd64}"');
    for (const page of platformClaims) {
      expect(page).not.toContain("tagged ARM64 runtime");
      expect(page).not.toContain("Auto-install supports common Linux families");
      expect(page).not.toContain("Installs the `fased` CLI on request");
      expect(page).not.toContain("**Fased runs on this Windows PC:** install");
    }
    for (const page of publicInstallClaims) {
      expect(page).not.toContain("Run in macOS Terminal, a Linux terminal, or Ubuntu WSL2");
      expect(page).not.toContain("The current public Windows path runs inside WSL2");
      expect(page).not.toContain("macOS Terminal, Windows WSL2 Ubuntu, or Linux terminal");
      expect(page).not.toContain("Fedora and RHEL-family systems are hosted targets");
      expect(page).not.toContain("managed Ubuntu WSL2 installation are deferred");
      expect(page).not.toContain("Managed WSL2 Local installation is deferred");
    }
  });

  it("states the unavoidable first-shell trust boundary without overstating the stamped digest", () => {
    expect(installerReference).toContain("first shell execution trusts WebPKI");
    expect(installerReference).toMatch(/cannot authenticate\s+the shell itself/u);
    expect(installerReference).toContain("exact-tag procedure");
    expect(installerReference).toContain("run npm/pnpm");
  });

  it("delegates an unstamped checkout only to the explicit developer installer", () => {
    expect(installer).toContain('exec "$repo_root/scripts/install-development.sh" "$@"');
    expect(installer).toContain("refusing an unstamped streamed installer");
    expect(developmentInstaller).toContain("Builds the current contributor checkout");
    expect(developmentInstaller).toContain("for tool in node pnpm; do");
  });

  it("binds public installation to the stamped immutable release and channel", () => {
    expect(installer).toContain('install_entry_release_identity="__FASED_RELEASE_IDENTITY__"');
    expect(installer).toContain("requested release differs from this immutable installer");
    expect(installer).toContain('[[ "$channel" == "stable" || "$channel" == "beta" ]]');
    expect(installer).toContain("prereleases require beta");
  });

  it("downloads one stamped Go bootstrap and executes the public lifecycle boundary", () => {
    expect(installer).toContain('bootstrap_asset="fased-bootstrap-${operating_system}-${arch}"');
    expect(installer).toContain("bootstrap digest mismatch");
    expect(installer).toContain("bootstrap_args=(\n  install");
    expect(installer).toContain('"${root_command[@]}" "$bootstrap" "${bootstrap_args[@]}"');
  });

  it("reuses only the exact protected bootstrap and reports installer timing and transfer evidence", () => {
    expect(installer).toContain("require_protected_bootstrap_ancestry() {");
    expect(installer).toContain(
      'local directories=(/ /opt /opt/fased /opt/fased/lifecycle "$bootstrap_dir")',
    );
    expect(installer).toContain(
      'directories=(/ /Library /Library/FasedLifecycle "$bootstrap_dir")',
    );
    expect(installer).toContain(`[[ "$(stat -c '%U' "$directory")" == "root" ]]`);
    expect(installer).toContain("(( (8#${mode: -3} & 8#022) == 0 ))");
    expect(installer).toContain("protected_bootstrap_is_safe ||");
    expect(installer).toContain('test ! -L "$bootstrap"');
    expect(installer).toContain("root:wheel:555:1");
    expect(installer).toContain('installed_sha256="$(sha256_file "$bootstrap")"');
    expect(installer).toContain('bootstrap_cache_hit="true"');
    expect(installer).toContain("--write-out '%{size_download} %{time_total}\\n'");
    expect(installer).toContain("Installer performance: total=");
    expect(installer).toContain("transferred=%sB cache-hit=%s");
    expect(installer).toContain('"$bootstrap_transferred_bytes" "$bootstrap_cache_hit"');
  });

  it("does not install Node, pnpm, npm, Corepack, or Git on the public path", () => {
    for (const residue of [
      "npm install",
      "pnpm install",
      "corepack enable",
      "apt-get",
      "dnf install",
      "git clone",
    ]) {
      expect(installer).not.toContain(residue);
    }
    expect(developmentInstaller).toContain('pnpm --dir "$repo_root" install --frozen-lockfile');
  });
});
