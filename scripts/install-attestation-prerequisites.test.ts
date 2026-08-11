import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const installer = fs.readFileSync(path.resolve(import.meta.dirname, "..", "install.sh"), "utf8");

function shellFunction(name: string): string {
  const start = installer.indexOf(`${name}() {`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = installer.indexOf("\n  }\n", start);
  expect(end).toBeGreaterThan(start);
  return installer.slice(start, end + 5);
}

describe("official release attestation prerequisites", () => {
  it("automatically provisions a current GitHub CLI on macOS through Homebrew", () => {
    const fn = shellFunction("install_current_github_cli_bootstrap");
    expect(fn).toContain("brew install gh || brew upgrade gh");
    expect(fn).toContain("gh attestation verify --help");
  });

  it("does not silently skip attestation verification when auto-install is disabled", () => {
    const fn = shellFunction("install_current_github_cli_bootstrap");
    expect(fn).toContain('[[ "$auto_install" -eq 1 ]] || return 1');
    expect(fn).toContain("return 1");
  });

  it("provisions a compatible root-controlled Node before release evidence verification", () => {
    const selector = shellFunction("select_root_controlled_bootstrap_node");
    const installerFn = shellFunction("install_root_controlled_bootstrap_node");
    const bootstrapStart = installer.indexOf("  bootstrap_hosting_attested_bundle() {");
    const bootstrapEnd = installer.indexOf('\n  if [[ "$hosting_bootstrap"', bootstrapStart);
    const bootstrap = installer.slice(bootstrapStart, bootstrapEnd);

    expect(selector).toContain("/usr/bin/node-24");
    expect(selector).toContain("/usr/bin/node24");
    expect(selector).toContain("/usr/bin/node-22");
    expect(selector).toContain("/usr/bin/nodejs");
    expect(selector).toContain('require("node:sqlite")');
    expect(selector).toContain("a === 22 && b < 14");
    expect(installerFn).toContain("https://deb.nodesource.com/setup_24.x");
    expect(installerFn).toContain("https://rpm.nodesource.com/setup_24.x");
    for (const manager of ["apt-get", "zypper", "apk", "pacman"]) {
      expect(installerFn).toContain(`command -v ${manager}`);
    }
    expect(installerFn).toContain("for package_manager in dnf5 dnf yum");

    const provision = bootstrap.indexOf("install_root_controlled_bootstrap_node");
    const evidenceDownload = bootstrap.indexOf(
      '"$release_url/fased-privileged-release-evidence.mjs"',
    );
    const evidenceVerify = bootstrap.indexOf('"$evidence_node" "$evidence_verifier" verify');
    expect(provision).toBeGreaterThanOrEqual(0);
    expect(evidenceDownload).toBeGreaterThan(provision);
    expect(evidenceVerify).toBeGreaterThan(evidenceDownload);
    expect(bootstrap).toContain(
      'lifecycle_node="$(select_root_controlled_bootstrap_node 2>/dev/null || true)"',
    );
  });

  it("stages the Go bootstrap on a root-owned executable hierarchy rather than /run", () => {
    const prepare = shellFunction("prepare_lifecycle_bootstrap_exec_root");
    const bootstrapStart = installer.indexOf("  bootstrap_hosting_attested_bundle() {");
    const bootstrapEnd = installer.indexOf('\n  if [[ "$hosting_bootstrap"', bootstrapStart);
    const bootstrap = installer.slice(bootstrapStart, bootstrapEnd);

    expect(prepare).toContain('local parent="/usr/local/libexec"');
    expect(prepare).toContain('local root="${parent}/fased-installer"');
    expect(prepare).toContain('install -d -m 0700 -o root -g root "$root"');
    expect(prepare).toContain('[[ -d "$root" && ! -L "$root" ]]');
    expect(prepare).toContain('[[ "$owner" == "0" && "$mode" == "700" ]]');
    expect(bootstrap).toContain('lifecycle_exec_root="$(prepare_lifecycle_bootstrap_exec_root)"');
  });

  it("keeps normal Hosting prerequisite and artifact output concise", () => {
    const githubCli = shellFunction("install_current_github_cli_bootstrap");
    const nodeInstaller = shellFunction("install_root_controlled_bootstrap_node");
    const bootstrapStart = installer.indexOf("  bootstrap_hosting_attested_bundle() {");
    const bootstrapEnd = installer.indexOf('\n  if [[ "$hosting_bootstrap"', bootstrapStart);
    const bootstrap = installer.slice(bootstrapStart, bootstrapEnd);

    expect(githubCli).toContain("apt-get update -qq");
    expect(githubCli).toContain("apt-get install -y -qq gh");
    expect(nodeInstaller).toContain("apt-get install -y -qq nodejs");
    expect(nodeInstaller).toContain('bash "$setup_script" \\\n          >/dev/null');
    expect(bootstrap).not.toContain("curl -q -fL ");
    expect(bootstrap).toContain("curl -q -fsSL ");
  });
});
