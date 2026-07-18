import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
  files?: string[];
};
const files = new Set(manifest.files ?? []);
const releaseWorkflow = fs.readFileSync(
  path.join(root, ".github/workflows/hosted-runtime-release.yml"),
  "utf8",
);

describe("attested Hosting installer artifact layout", () => {
  it("ships the root bootstrap and fixed root-admin assets in the attested npm-derived app layer", () => {
    expect(files).toContain("install.sh");
    expect(files).toContain("scripts/fased-host-updater.mjs");
    expect(files).toContain("scripts/fased-host-updaterctl.mjs");
    expect(files).toContain("scripts/fased-signer-enroll-hosting.sh");
    expect(files).toContain("scripts/fased-signer-network-hosting.sh");
    expect(files).toContain("scripts/fased-signer-policy-hosting.sh");
    expect(files).toContain("config/");
  });

  it("does not ship the retired app-visible root bootstrap daemon or client", () => {
    expect(files).not.toContain("scripts/fased-host-bootstrapd.mjs");
    expect(files).not.toContain("scripts/fased-host-bootstrapctl.mjs");
    expect(fs.existsSync(path.join(root, "scripts/fased-host-bootstrapd.mjs"))).toBe(false);
    expect(fs.existsSync(path.join(root, "scripts/fased-host-bootstrapctl.mjs"))).toBe(false);
  });

  it("uses architecture names that match the release artifact builder", () => {
    const installer = fs.readFileSync(path.join(root, "install.sh"), "utf8");
    const builder = fs.readFileSync(
      path.join(root, "scripts/build-hosted-runtime-artifact.ts"),
      "utf8",
    );
    expect(installer).toContain('x86_64|amd64) architecture="x64"');
    expect(installer).toContain('aarch64|arm64) architecture="arm64"');
    expect(builder).toContain("fased-hosted-app-linux-${arch}-v${version}.tar.gz");
  });

  it("publishes install.sh as its own pre-execution attested release asset", () => {
    expect(releaseWorkflow).toContain("install -m 0755 install.sh dist-native/release/install.sh");
    expect(releaseWorkflow).toContain("name: Attest root Hosting bootstrap");
    expect(releaseWorkflow).toContain("subject-path: dist-native/release/install.sh");
    expect(releaseWorkflow).toContain(
      '"${{ steps.attest-hosting-bootstrap.outputs.bundle-path }}"',
    );
    expect(releaseWorkflow).toContain("dist-native/release/install.sh.attestation.json");
    expect(releaseWorkflow).toContain(
      'gh release upload "$GITHUB_REF_NAME" .artifacts/hosted-runtime/*',
    );
    const vpsGuide = fs.readFileSync(path.join(root, "docs/install/vps.md"), "utf8");
    expect(vpsGuide).toContain("install.sh.attestation.json");
    expect(vpsGuide).toContain('--bundle "$BOOTSTRAP_DIR/install.sh.attestation.json"');
    expect(vpsGuide).toContain('--source-ref "refs/tags/${RELEASE}"');
    expect(vpsGuide).toContain("--deny-self-hosted-runners");
  });

  it("dispatches standalone Hosting execution through the attested bundle bootstrap", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fased-hosting-bootstrap-dispatch-"));
    try {
      const standaloneInstaller = path.join(tempRoot, "install.sh");
      const fakeBin = path.join(tempRoot, "bin");
      fs.mkdirSync(fakeBin);
      fs.copyFileSync(path.join(root, "install.sh"), standaloneInstaller);
      fs.chmodSync(standaloneInstaller, 0o700);
      fs.writeFileSync(path.join(fakeBin, "id"), "#!/bin/sh\nprintf '1000\\n'\n", {
        mode: 0o700,
      });

      const result = spawnSync(
        "bash",
        [standaloneInstaller, "--hosting", "--release", "v1.2.3", "--no-auto-install"],
        {
          encoding: "utf8",
          env: { ...process.env, PATH: `${fakeBin}:/usr/bin:/bin` },
        },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "VPS Hosting bootstrap must start in the provider's root console",
      );
      expect(result.stderr).not.toContain("Refusing to load privileged Hosting assets");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("installs Tailscale through signature-enforcing package repositories", () => {
    const installer = fs.readFileSync(path.join(root, "install.sh"), "utf8");
    expect(installer).not.toMatch(/tailscale\.com\/install\.sh[^\n]*\|/);
    expect(installer).toContain(".tailscale-keyring.list");
    expect(installer).toContain("signed-by=${keyring_path}");
    expect(installer).toContain("APT::Get::AllowUnauthenticated=false");
    expect(installer).toContain("repo_gpgcheck=1");
    expect(installer).toContain("gpgcheck=1");
    expect(installer).toContain("https://pkgs.tailscale.com/stable/");
  });

  it("keeps the generated root maintenance helper syntactically valid", () => {
    const installer = fs.readFileSync(path.join(root, "install.sh"), "utf8");
    const startMarker = `cat >"$helper_path" <<'EOF'\n`;
    const endMarker = `\nEOF\n  chmod 755 "$helper_path"`;
    const start = installer.indexOf(startMarker);
    const end = installer.indexOf(endMarker, start + startMarker.length);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const helper = installer.slice(start + startMarker.length, end);
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fased-host-maintenance-syntax-"));
    try {
      const helperPath = path.join(tempRoot, "fased-host-maintenance");
      fs.writeFileSync(helperPath, helper, { mode: 0o700 });
      const syntax = spawnSync("bash", ["-n", helperPath], { encoding: "utf8" });
      expect(syntax.status, syntax.stderr).toBe(0);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("does not document a raw-pipe Hosting or Hosting-repair bootstrap", () => {
    const activeInstallDocs = [
      "docs/install/index.md",
      "docs/install/installer.md",
      "docs/install/updating.md",
      "docs/install/vps.md",
    ];
    const offenders: string[] = [];
    for (const relativePath of activeInstallDocs) {
      const contents = fs.readFileSync(path.join(root, relativePath), "utf8");
      const codeBlocks =
        contents.match(/^[ \t]*```(?:bash|sh)[^\n]*\n[\s\S]*?^[ \t]*```[ \t]*$/gm) ?? [];
      for (const block of codeBlocks) {
        if (
          block.includes("raw.githubusercontent.com/fased-ai/fased") &&
          /--(?:repair-)?hosting\b/.test(block)
        ) {
          offenders.push(`${relativePath}: ${block}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
