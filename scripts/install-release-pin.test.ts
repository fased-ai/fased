import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { stampReleaseInstaller } from "./stamp-release-installer.mjs";

const root = path.resolve(import.meta.dirname, "..");
const installerPath = path.join(root, "install.sh");

describe("public installer release pinning", () => {
  it("keeps one immutable release marker and two architecture bootstrap digests", async () => {
    const installer = await fsp.readFile(installerPath, "utf8");
    expect(installer.match(/__FASED_RELEASE_IDENTITY__/gu)).toHaveLength(2);
    expect(installer.match(/__FASED_BOOTSTRAP_SHA256_X64__/gu)).toHaveLength(1);
    expect(installer.match(/__FASED_BOOTSTRAP_SHA256_ARM64__/gu)).toHaveLength(1);
    expect(installer).toContain('[[ "$release" == "$install_entry_release_identity" ]]');
  });

  it("stamps exact static bootstrap identities and remains valid shell", async () => {
    const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-public-installer-"));
    const x64 = path.join(fixture, "bootstrap-x64");
    const arm64 = path.join(fixture, "bootstrap-arm64");
    const output = path.join(fixture, "install.sh");
    await fsp.writeFile(x64, "x64");
    await fsp.writeFile(arm64, "arm64");
    await stampReleaseInstaller({
      source: installerPath,
      output,
      version: "1.2.3-rc.4",
      bootstrapX64: x64,
      bootstrapArm64: arm64,
    });
    const stamped = await fsp.readFile(output, "utf8");
    expect(stamped).toContain('install_entry_release_identity="1.2.3-rc.4"');
    expect(stamped).not.toContain("__FASED_BOOTSTRAP_SHA256_");
    expect(spawnSync("bash", ["-n", output], { encoding: "utf8" }).status).toBe(0);
  });

  it("keeps source installation explicit and outside the stamped public route", async () => {
    const installer = await fsp.readFile(installerPath, "utf8");
    const developer = await fsp.readFile(path.join(root, "scripts/install-development.sh"), "utf8");
    expect(installer).toContain('exec "$repo_root/scripts/install-development.sh" "$@"');
    expect(installer).not.toContain("pnpm");
    expect(developer).toContain("pnpm");
  });

  it("contains no dynamic trust-tool or source-checkout fallback", async () => {
    const installer = await fsp.readFile(installerPath, "utf8");
    for (const forbidden of [
      "install_current_github_cli_bootstrap",
      "install_root_controlled_bootstrap_node",
      "deb.nodesource.com",
      "rpm.nodesource.com",
      "git clone",
      "generation-updater.mjs",
    ]) {
      expect(installer).not.toContain(forbidden);
    }
  });
});
