import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const installer = fs.readFileSync(path.resolve(import.meta.dirname, "..", "install.sh"), "utf8");
const launcher = fs.readFileSync(path.resolve(import.meta.dirname, "..", "fased.mjs"), "utf8");
const packageManifest = JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, "..", "package.json"), "utf8"),
) as { os?: string[] };

describe("installer platform preflight", () => {
  it("rejects native Windows shells and directs users into WSL2", () => {
    expect(installer).toContain("MINGW*|MSYS*|CYGWIN*");
    expect(installer).toContain("Native Windows Node.js, PowerShell, Git Bash");
    expect(installer).toContain("Install Ubuntu in WSL2, enable systemd");
    expect(packageManifest.os).toEqual(["linux", "darwin"]);
    expect(launcher).toContain('if (process.platform === "win32")');
    expect(launcher).toContain("Native Windows is not a supported Fased runtime");
    expect(launcher.indexOf('if (process.platform === "win32")')).toBeLessThan(
      launcher.indexOf('import("./scripts/fased-launcher-runtime.mjs")'),
    );
  });

  it("rejects WSL1 and WSL2 without systemd before install state handling", () => {
    const validation = installer.indexOf("validate_install_platform\n");
    const stateHandling = installer.indexOf("set_installer_state_dir() {");
    expect(validation).toBeGreaterThanOrEqual(0);
    expect(validation).toBeLessThan(stateHandling);
    expect(installer).toContain("WSL1 is not supported");
    expect(installer).toContain("systemd=true");
    expect(installer).toContain("wsl --shutdown");
  });

  it("requires root Linux systemd and rejects WSL for Hosting", () => {
    expect(installer).toContain('if [[ "$HOSTING_REQUESTED" -eq 1 ]]');
    expect(installer).toContain("--hosting is for a Linux VPS, not WSL");
    expect(installer).toContain("--hosting must run as root");
    expect(installer).toContain("--hosting requires systemd as PID 1");
  });
});
