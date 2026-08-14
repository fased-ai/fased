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

describe("installer platform preflight", () => {
  it("keeps the public lifecycle installer Linux-only and rejects native Windows runtime", () => {
    expect(installer).toContain('case "$(uname -s)"');
    expect(installer).toContain("public lifecycle installation supports Linux only");
    expect(packageManifest.os).toEqual(["linux", "darwin"]);
    expect(launcher).toContain('if (process.platform === "win32")');
    expect(launcher).toContain("Native Windows is not a supported Fased runtime");
    expect(launcher).not.toContain("fased-launcher-runtime.mjs");
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
