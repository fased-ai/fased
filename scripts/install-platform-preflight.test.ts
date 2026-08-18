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
    const verification = installer.indexOf('echo "Fased: verifying public command..."');
    const completion = installer.indexOf('echo "Fased: installation complete."');
    expect(verification).toBeGreaterThan(0);
    expect(verification).toBeLessThan(completion);
    expect(installer).toContain('cd /tmp && test "$(command -v fased)" = /usr/local/bin/fased');
    expect(installer).toContain("fased status");
    expect(installer).toContain('fased update --channel "$2" --tag "$1"');
    expect(installer).toContain('/usr/sbin/runuser -u "$operator_user"');
    expect(installer).toContain("PATH=/usr/local/bin:/usr/bin:/bin");
    expect(installer).toContain("printf '%s\\n' \"$update_output\"");
    expect(installer).toContain('grep -Fqx "Already current: $release" <<<"$update_output"');
    expect(installer).toContain('/bin/bash -c "$command_probe" fased "$release" "$channel"');
  });
  it("keeps the public lifecycle installer Linux-only and rejects native Windows runtime", () => {
    expect(installer).toContain('case "$(uname -s)"');
    expect(installer).toContain("public lifecycle installation supports Linux only");
    expect(packageManifest.os).toEqual(["linux", "darwin"]);
    expect(launcher).toContain('if (process.platform === "win32")');
    expect(launcher).toContain("Native Windows is not a supported Fased runtime");
    expect(launcher).not.toContain("fased-launcher-runtime.mjs");
  });

  it("rejects deferred architectures before lifecycle acquisition or privileged mutation", () => {
    const architecturePreflight = installer.indexOf('case "$(uname -m)"');
    const acquisition = installer.indexOf("Fased: acquiring verified lifecycle bootstrap");
    const privilegedInstall = installer.indexOf('install -d -m 0755 "$bootstrap_dir"');

    expect(installer).toContain("first managed lifecycle release supports Linux x86_64 only");
    expect(installer).not.toContain('aarch64|arm64) arch="arm64"');
    expect(architecturePreflight).toBeGreaterThan(0);
    expect(architecturePreflight).toBeLessThan(acquisition);
    expect(architecturePreflight).toBeLessThan(privilegedInstall);
  });

  it("does not build or advertise deferred managed release platforms", () => {
    expect(releaseWorkflow).not.toContain("- arch: arm64");
    expect(releaseWorkflow).not.toContain("ubuntu-24.04-arm");
    expect(releaseWorkflow).not.toContain("fased-bootstrap-linux-arm64");
    expect(signerRelease).toContain('TARGETS="${FASED_SIGNER_TARGETS:-linux/amd64}"');
    expect(lifecycleRelease).toContain('TARGETS="${FASED_LIFECYCLE_TARGETS:-linux/amd64}"');
    for (const page of platformClaims) {
      expect(page).not.toContain("tagged ARM64 runtime");
      expect(page).not.toContain("Auto-install supports common Linux families");
      expect(page).not.toContain("Installs the `fased` CLI on request");
      expect(page).not.toContain("**Fased runs on this Windows PC:** install");
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
    expect(installer).toContain('bootstrap_asset="fased-bootstrap-linux-${arch}"');
    expect(installer).toContain("bootstrap digest mismatch");
    expect(installer).toContain("bootstrap_args=(\n  install");
    expect(installer).toContain('"${root_command[@]}" "$bootstrap" "${bootstrap_args[@]}"');
  });

  it("reuses only the exact protected bootstrap and reports installer timing and transfer evidence", () => {
    expect(installer).toContain("require_protected_bootstrap_ancestry() {");
    expect(installer).toContain(
      'for directory in / /opt /opt/fased /opt/fased/lifecycle "$bootstrap_dir"',
    );
    expect(installer).toContain(`[[ "$(stat -c '%U' "$directory")" == "root" ]]`);
    expect(installer).toContain("(( (8#${mode: -3} & 8#022) == 0 ))");
    expect(installer).toContain("require_protected_bootstrap_ancestry &&");
    expect(installer).toContain('test ! -L "$bootstrap"');
    expect(installer).toContain('"$(stat -c \'%U:%G:%a:%h\' "$bootstrap")" == "root:root:555:1"');
    expect(installer).toContain('installed_sha256="$(sha256sum "$bootstrap")"');
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
