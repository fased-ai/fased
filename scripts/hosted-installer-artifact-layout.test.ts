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
    expect(files).toContain("scripts/fased-signer-owner-hosting.sh");
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
    expect(runtimeInstaller).toContain('"$RELEASE_URL/${RELEASE_MANIFEST_NAME}.attestation.json"');
    expect(runtimeInstaller).toContain('--bundle "$RELEASE_MANIFEST_BUNDLE_PATH"');
    expect(runtimeInstaller).toContain('APP_ASSET_NAME="${RELEASE_SELECTION[1]}"');
    const manifestBoundAsset = runtimeInstaller.slice(
      runtimeInstaller.indexOf("download_manifest_bound_asset()"),
      runtimeInstaller.indexOf("archive_entry_is_safe()"),
    );
    expect(manifestBoundAsset).not.toContain("gh attestation verify");
  });

  it("keeps root updater verification anonymous through published offline bundles", () => {
    const updater = fs.readFileSync(path.join(root, "scripts/fased-host-updater.mjs"), "utf8");
    expect(updater).toContain(
      "const RELEASE_MANIFEST_BUNDLE_NAME = `${RELEASE_MANIFEST_NAME}.attestation.json`",
    );
    expect(updater).toContain(
      'const SIGNER_ATTESTATION_BUNDLE_NAME = "fased-signerd-release.attestation.json"',
    );
    expect(updater).toContain('"--bundle",\n    bundlePath');
    expect(updater).toContain("`${releaseUrl}/${RELEASE_MANIFEST_BUNDLE_NAME}`");
    expect(updater).toContain("`${releaseUrl}/${SIGNER_ATTESTATION_BUNDLE_NAME}`");
  });

  it("publishes and installs an atomically selected root-controller generation", () => {
    const installer = fs.readFileSync(path.join(root, "install.sh"), "utf8");
    const updater = fs.readFileSync(path.join(root, "scripts/fased-host-updater.mjs"), "utf8");
    expect(installer).toContain(
      "install -d -m 0755 -o root -g root /opt/fased\n" +
        "  install -d -m 0755 -o root -g root /opt/fased/signer",
    );
    expect(installer).toContain("/opt/fased/host-controller/releases/v${version}");
    expect(installer).toContain(".controller-generation-${version}-$$");
    expect(installer).toContain(
      "Existing host controller generation v${version} is not the exact immutable release.",
    );
    expect(installer).toContain("Refusing to replace non-symlink host controller current path.");
    expect(installer).toContain(
      "ExecStart=$(command -v node) /opt/fased/host-controller/current/fased-host-updater.mjs",
    );
    expect(installer).toContain(
      "ProtectHome=read-only\n" +
        "ProtectSystem=strict\n" +
        "ReadWritePaths=/opt/fased/host-controller /opt/fased/signer /var/lib/fased-host-updater /var/lib/fased-signer-update-gate /var/lib/fased-signerd /run/fased-host-updater /etc/systemd/system ${target_home}/.fased",
    );
    const sharedStateCreation =
      'install -d -m 2770 -o "$target_user" -g "$config_group" "${target_home}/.fased"';
    expect(installer).toContain(sharedStateCreation);
    expect(installer.indexOf(sharedStateCreation)).toBeLessThan(
      installer.indexOf("cat >/etc/systemd/system/fased-host-updater.service"),
    );
    expect(installer).toContain("ReadWritePaths=/opt/fased/host-controller");
    expect(installer).toContain("RestartSec=1");
    expect(installer).toContain("/var/lib/fased-host-updater/controller-version.json");
    expect(installer).toContain('node "$FASED_DIR/scripts/fased-host-updater.mjs" --self-check');
    expect(installer).toContain('node "$FASED_DIR/scripts/fased-host-updaterctl.mjs" --self-check');
    expect(updater).toContain(
      "const CONTROLLER_SERVER_BUNDLE_NAME = `${CONTROLLER_SERVER_NAME}.attestation.json`",
    );
    expect(updater).toContain(
      "const CONTROLLER_CLIENT_BUNDLE_NAME = `${CONTROLLER_CLIENT_NAME}.attestation.json`",
    );
    expect(updater).toContain("context.stageControllerRelease(request.version, context)");
    expect(releaseWorkflow).toContain(
      "install -m 0755 scripts/fased-host-updater.mjs dist-native/release/fased-host-updater.mjs",
    );
    expect(releaseWorkflow).toContain(
      "install -m 0755 scripts/fased-host-updaterctl.mjs dist-native/release/fased-host-updaterctl.mjs",
    );
    expect(releaseWorkflow).toContain(
      "dist-native/release/fased-host-updater.mjs.attestation.json",
    );
    expect(releaseWorkflow).toContain(
      "dist-native/release/fased-host-updaterctl.mjs.attestation.json",
    );
    expect(updater).toContain('process.argv[2] === "--self-check"');
    expect(fs.readFileSync(path.join(root, "scripts/fased-host-updaterctl.mjs"), "utf8")).toContain(
      'process.argv[2] === "--self-check"',
    );
  });

  it("requires every root updater client invocation to name an explicit transaction phase", () => {
    const client = path.join(root, "scripts", "fased-host-updaterctl.mjs");
    for (const args of [["1.2.3"], ["1.2.3", "--full"]]) {
      const result = spawnSync(process.execPath, [client, ...args], {
        encoding: "utf8",
        env: streamedHostingEnv(),
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("unsupported signer updater control mode");
    }
  });

  it("uses the correct GitHub CLI repository setup for DNF4 and DNF5", () => {
    const installer = fs.readFileSync(path.join(root, "install.sh"), "utf8");
    expect(installer.match(/dnf5 install -y dnf5-plugins/g)).toHaveLength(2);
    expect(installer.match(/dnf5 config-manager addrepo/g)).toHaveLength(2);
    expect(
      installer.match(/--from-repofile=https:\/\/cli\.github\.com\/packages\/rpm\/gh-cli\.repo/g),
    ).toHaveLength(2);
    expect(installer.match(/dnf install -y 'dnf-command\(config-manager\)'/g)).toHaveLength(2);
    expect(installer.match(/dnf config-manager --add-repo/g)).toHaveLength(2);
  });

  it("does not replace minimal RHEL command packages during bootstrap", () => {
    const installer = fs.readFileSync(path.join(root, "install.sh"), "utf8");
    expect(installer).toContain("command -v curl >/dev/null 2>&1 || packages+=(curl)");
    expect(installer).toContain("command -v tar >/dev/null 2>&1 || packages+=(tar)");
    expect(installer).toContain('run_as_root "$dnf_cmd" install -y "${rpm_packages[@]}"');
    expect(installer).not.toMatch(/dnf5? install -y curl ca-certificates/u);
    expect(installer).not.toContain("dnf install -y curl ca-certificates tar coreutils");
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
    const installerReference = fs.readFileSync(
      path.join(root, "docs/install/installer.md"),
      "utf8",
    );
    expect(installerReference).toContain("install.sh.attestation.json");
    expect(installerReference).toContain('--bundle "$BOOTSTRAP_DIR/install.sh.attestation.json"');
    expect(installerReference).toContain('--source-ref "refs/tags/${RELEASE}"');
    expect(installerReference).toContain("--deny-self-hosted-runners");
  });

  it("validates once while packaging native hosted artifacts in parallel", () => {
    expect(releaseWorkflow.match(/run: pnpm release:check/g)).toHaveLength(1);
    expect(releaseWorkflow).toContain("run: pnpm hosted:artifact:build --output");
    expect(releaseWorkflow).not.toContain("run: pnpm hosted:artifact --output");
    expect(releaseWorkflow).toContain("needs: [validate, linux, signer]");
  });

  it("assembles offline-attested workflow-dispatch candidates without publishing them", () => {
    expect(releaseWorkflow).toContain("name: Assemble offline-attested candidate");
    expect(releaseWorkflow).toContain("if: github.event_name == 'workflow_dispatch'");
    expect(releaseWorkflow).toContain("fased-hosting-candidate-${{ github.sha }}");
    expect(releaseWorkflow).toContain("fased-hosted-release-v2.json.attestation.json");
    expect(releaseWorkflow).toContain("stablePublication: false");
    expect(releaseWorkflow).toContain("name: Verify every staged candidate attestation offline");
    expect(releaseWorkflow).toContain('--source-ref "$GITHUB_REF"');
    expect(releaseWorkflow).toContain("--deny-self-hosted-runners");
    expect(releaseWorkflow).toContain(
      "if: startsWith(github.ref, 'refs/tags/v') || github.event_name == 'workflow_dispatch'",
    );
    expect(releaseWorkflow).toContain(
      "name: Publish verified runtime assets\n    if: startsWith(github.ref, 'refs/tags/v')",
    );
  });

  it("publishes tagged prereleases as non-latest GitHub prereleases", () => {
    expect(releaseWorkflow).toContain('if [[ "$package_version" == *-* ]]');
    expect(releaseWorkflow).toContain("release_args+=(--prerelease --latest=false)");
    expect(releaseWorkflow).toContain("--json isPrerelease --jq .isPrerelease");
    expect(releaseWorkflow).toContain('test "$is_prerelease" = "true"');
  });

  it("runs the streamed bootstrap fixture without an external package mirror layer", () => {
    const dockerfile = fs.readFileSync(
      path.join(root, "scripts/docker/streamed-hosting-bootstrap/Dockerfile"),
      "utf8",
    );
    expect(dockerfile).not.toContain("apt-get");
    expect(dockerfile).not.toContain("install -y");
    expect(dockerfile).toContain("COPY run.sh");
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

  it("accepts the stable and exact-release streamed fresh Hosting selectors", () => {
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

    const exactPrerelease = run([
      "--hosting",
      "--release",
      "v1.2.3-rc.1",
      "--update-channel",
      "beta",
    ]);
    expect(exactPrerelease.status).toBe(1);
    expect(exactPrerelease.stderr).not.toContain("accepts only the public one-command selector");
    expect(exactPrerelease.stderr).toMatch(
      /must start in the provider's root console|only for a fresh host/iu,
    );

    for (const args of [
      ["--repair-hosting"],
      ["--host-profile", "hosting"],
      ["--hosting", "--release", "v1.2.3"],
      ["--hosting", "--release", "v1.2.3-rc.1", "--update-channel", "stable"],
      ["--hosting", "--release", "not-a-release", "--update-channel", "beta"],
      ["--hosting", "--source-install"],
      ["--hosting", "--verified-hosting-bundle", "/tmp/caller"],
    ]) {
      const result = run(args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "Streamed VPS Hosting accepts only the public one-command selector:",
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

  it("reuses the one-command Hosting bootstrap for interrupted or completed repairs", () => {
    const installer = fs.readFileSync(path.join(root, "install.sh"), "utf8");
    expect(installer).toContain("install_entry_existing_hosting_state=0");
    expect(installer).toContain("install_entry_completed_hosting_repair=1");
    expect(installer).toContain('verified_inner_args[$inner_arg_index]="--repair-hosting"');
    expect(installer).toContain(
      "Interrupted VPS Hosting setup detected; resuming through a newly verified release bundle.",
    );
    expect(installer).not.toContain(
      "Streamed VPS Hosting is only for a fresh host; existing Fased state was found.",
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

  it("documents the literal fresh Hosting command before Advanced verification", () => {
    const vpsGuide = fs.readFileSync(path.join(root, "docs/install/vps.md"), "utf8");
    const command = vpsGuide.indexOf(
      "curl -fsSL https://raw.githubusercontent.com/fased-ai/fased/main/install.sh \\",
    );
    const advanced = vpsGuide.indexOf("<AccordionGroup>");
    expect(command).toBeGreaterThanOrEqual(0);
    expect(vpsGuide).toContain("| bash -s -- --hosting");
    expect(advanced).toBeGreaterThan(command);
  });
});
