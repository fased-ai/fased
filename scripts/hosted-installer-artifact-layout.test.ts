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

function streamedHostingEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith("FASED_") ||
      /^(?:https?|all|no)_proxy$/iu.test(key) ||
      [
        "CURL_HOME",
        "CURL_CA_BUNDLE",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "GIT_SSL_NO_VERIFY",
        "GH_HOST",
        "GH_REPO",
        "GH_CONFIG_DIR",
        "TMPDIR",
        "LD_PRELOAD",
        "LD_LIBRARY_PATH",
        "BASH_ENV",
        "ENV",
        "CDPATH",
      ].includes(key)
    ) {
      delete env[key];
    }
  }
  return { ...env, ...extra };
}

describe("attested Hosting installer artifact layout", () => {
  it("ships the root bootstrap and fixed root-admin assets in the attested npm-derived app layer", () => {
    expect(files).toContain("install.sh");
    expect(files).toContain("scripts/fased-host-updater.mjs");
    expect(files).toContain("scripts/fased-host-updaterctl.mjs");
    expect(files).toContain("scripts/fased-signer-enroll-hosting.sh");
    expect(files).toContain("scripts/fased-signer-network-hosting.sh");
    expect(files).not.toContain("scripts/fased-signer-wallet-import-hosting.sh");
    expect(fs.existsSync(path.join(root, "scripts/fased-signer-wallet-import-hosting.sh"))).toBe(
      false,
    );
    expect(files).toContain("scripts/fased-signer-policy-hosting.sh");
    expect(files).toContain("scripts/install-runtime-profile.sh");
    expect(files).toContain("config/");
  });

  it("does not ship the retired app-visible root bootstrap daemon or client", () => {
    expect(files).not.toContain("scripts/fased-host-bootstrapd.mjs");
    expect(files).not.toContain("scripts/fased-host-bootstrapctl.mjs");
    expect(fs.existsSync(path.join(root, "scripts/fased-host-bootstrapd.mjs"))).toBe(false);
    expect(fs.existsSync(path.join(root, "scripts/fased-host-bootstrapctl.mjs"))).toBe(false);
  });

  it("keeps the legacy Local bridge separate from the unified Hosting app artifact", () => {
    const installer = fs.readFileSync(path.join(root, "install.sh"), "utf8");
    const builder = fs.readFileSync(
      path.join(root, "scripts/build-hosted-runtime-artifact.ts"),
      "utf8",
    );
    const runtimeInstaller = fs.readFileSync(
      path.join(root, "scripts/install-hosted-runtime.sh"),
      "utf8",
    );
    expect(installer).toContain('architecture="x64"\n        signer_platform="linux-amd64"');
    expect(installer).toContain('architecture="arm64"\n        signer_platform="linux-arm64"');
    expect(builder).toContain("fased-hosted-app-linux-${arch}-v${version}.tar.gz");
    expect(builder).toContain("fased-hosted-app-v2-linux-${arch}-v${version}.tar.gz");
    expect(builder).toContain("schemaVersion: 1, dependencyHash");
    expect(builder).toContain("app: { asset: unifiedAppAssetName, sha256: unifiedAppDigest }");
    expect(runtimeInstaller).toContain('if [[ "$PROFILE" == "hosting" ]]');
    expect(runtimeInstaller).toContain('APP_ASSET_NAME="${RELEASE_SELECTION[1]}"');
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

  it("accepts only the literal streamed fresh Hosting selector", () => {
    const input = fs.readFileSync(path.join(root, "install.sh"), "utf8");
    const run = (args: string[], extraEnv: NodeJS.ProcessEnv = {}) =>
      spawnSync("bash", ["-s", "--", ...args], {
        encoding: "utf8",
        env: streamedHostingEnv(extraEnv),
        input,
        ...(typeof process.getuid === "function" && process.getuid() === 0
          ? { uid: 65534, gid: 65534 }
          : {}),
      });

    const exact = run(["--hosting"]);
    expect(exact.status).toBe(1);
    expect(exact.stderr).not.toContain("accepts only the exact fresh-install selector");
    expect(exact.stderr).toMatch(
      /must start in the provider's root console|only for a fresh host/iu,
    );

    for (const args of [
      ["--repair-hosting"],
      ["--host-profile", "hosting"],
      ["--hosting", "--release", "v1.2.3"],
      ["--hosting", "--source-install"],
      ["--hosting", "--verified-hosting-bundle", "/tmp/caller"],
    ]) {
      const result = run(args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "Streamed VPS Hosting accepts only the exact fresh-install selector: --hosting",
      );
      expect(result.stderr).not.toContain("VPS Hosting bootstrap must start");
    }

    const unsafeEnvironment = run(["--hosting"], {
      FASED_INSTALL_REPO: "https://example.invalid/override.git",
    });
    expect(unsafeEnvironment.status).toBe(1);
    expect(unsafeEnvironment.stderr).toContain(
      "Refusing Fased environment overrides during streamed VPS Hosting",
    );
  });

  it("keeps the exact public fresh Hosting command as a literal CI contract", () => {
    const command =
      "curl -fsSL https://raw.githubusercontent.com/fased-ai/fased/main/install.sh \\\n" +
      "  | bash -s -- --hosting";
    expect(command).toBe(
      "curl -fsSL https://raw.githubusercontent.com/fased-ai/fased/main/install.sh \\\n" +
        "  | bash -s -- --hosting",
    );
    const installer = fs.readFileSync(path.join(root, "install.sh"), "utf8");
    const manifestVerification = installer.indexOf('gh attestation verify "$release_manifest"');
    const signerDigestVerification = installer.indexOf('"$signer_actual" != "$signer_expected"');
    const mutation = installer.indexOf(
      "install -d -m 0700 -o root -g root /var/lib/fased-installer",
    );
    expect(installer).toContain(
      '"$asset" == "fased-hosted-app-v2-linux-${architecture}-v${release_version}.tar.gz"',
    );
    expect(installer).toContain('"$signer_asset" == "fased-signerd-${signer_platform}"');
    expect(installer).toContain('--bundle "$release_manifest_bundle"');
    expect(manifestVerification).toBeGreaterThanOrEqual(0);
    expect(signerDigestVerification).toBeGreaterThan(manifestVerification);
    expect(mutation).toBeGreaterThan(signerDigestVerification);
    const codeowners = fs.readFileSync(path.join(root, ".github/CODEOWNERS"), "utf8");
    expect(codeowners).toContain("/install.sh @fcode-ai");
    expect(codeowners).toContain("/.github/workflows/hosted-runtime-release.yml @fcode-ai");
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

  it("does not document a mutable streamed Hosting resolver", () => {
    const docsRoot = path.join(root, "docs");
    const pending = [docsRoot];
    const streamedHostingOffenders: string[] = [];
    while (pending.length > 0) {
      const current = pending.pop();
      if (!current) {
        continue;
      }
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const absolutePath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          pending.push(absolutePath);
          continue;
        }
        if (!entry.isFile() || !/\.(?:md|mdx)$/.test(entry.name)) {
          continue;
        }
        const relativePath = path.relative(root, absolutePath);
        const contents = fs.readFileSync(absolutePath, "utf8");
        const codeBlocks =
          contents.match(/^[ \t]*```(?:bash|sh)[^\n]*\n[\s\S]*?^[ \t]*```[ \t]*$/gm) ?? [];
        for (const block of codeBlocks) {
          if (
            block.includes("raw.githubusercontent.com/fased-ai/fased") &&
            /--hosting\b/.test(block)
          ) {
            streamedHostingOffenders.push(`${relativePath}: ${block}`);
          }
        }
      }
    }
    expect(streamedHostingOffenders).toEqual([]);

    const vpsGuide = fs.readFileSync(path.join(root, "docs/install/vps.md"), "utf8");
    const verify = vpsGuide.indexOf('gh attestation verify "$BOOTSTRAP_DIR/install.sh"');
    const execute = vpsGuide.indexOf(
      'bash "$BOOTSTRAP_DIR/install.sh" --hosting --release "$RELEASE"',
    );
    expect(verify).toBeGreaterThanOrEqual(0);
    expect(execute).toBeGreaterThan(verify);
  });
});
