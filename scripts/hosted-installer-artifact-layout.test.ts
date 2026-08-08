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
    expect(files).toContain("scripts/privileged-release-evidence.mjs");
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
    expect(updater).toContain("PRIVILEGED_PROVENANCE_BUNDLE_NAME");
    expect(updater).toContain("verifyPrivilegedReleaseEvidence");
  });

  it("binds provenance, SPDX SBOM, and OpenVEX evidence into every privileged release", () => {
    const installer = fs.readFileSync(path.join(root, "install.sh"), "utf8");
    expect(releaseWorkflow).toContain("pnpm audit --prod --audit-level high");
    expect(releaseWorkflow).toContain("govulncheck@v1.1.4");
    expect(releaseWorkflow).toContain("scripts/privileged-release-evidence.mjs build");
    expect(releaseWorkflow).toContain("name: Attest privileged release provenance");
    expect(releaseWorkflow).toContain(
      "fased-privileged-provenance-v1.intoto.json.attestation.json",
    );
    expect(releaseWorkflow).toContain("fased-privileged-sbom-v1.spdx.json");
    expect(releaseWorkflow).toContain("fased-privileged-vex-v1.openvex.json");
    expect(installer).toContain('"$provenance" "$provenance_bundle" "$release_version"');
    expect(installer).toContain('"$evidence_node" "$evidence_verifier" verify');
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
      "for lifecycle_unit in fased-host-controller.service fased-host-updater.service; do",
    );
    expect(installer).toContain("Hosted lifecycle unit drop-in boundary is unsafe:");
    expect(installer).toContain(
      "ExecStart=$(command -v node) /opt/fased/host-controller/current/fased-host-updater.mjs --supervised --socket-path /run/fased-host-controller/controller.sock --socket-uid 0 --socket-gid 0",
    );
    expect(installer).toContain(
      "ProtectHome=read-only\n" +
        "ProtectSystem=strict\n" +
        "ReadWritePaths=/opt/fased/host-application /opt/fased/signer /var/lib/fased-host-updater /var/lib/fased-signer-update-gate /var/lib/fased-signerd /run/fased-host-controller /usr/local/libexec /etc/systemd/system ${target_home}/.fased",
    );
    expect(installer).toContain(
      "ReadOnlyPaths=/opt/fased/host-controller /var/lib/fased-host-updater/controller-version.json /var/lib/fased-host-updater/supervisor /etc/systemd/system/fased-host-controller.service /etc/systemd/system/fased-host-controller.service.d /etc/systemd/system/fased-host-updater.service /etc/systemd/system/fased-host-updater.service.d",
    );
    expect(installer).toContain(
      "ExecStart=$(command -v node) ${supervisor_path} --profile hosting --operator-uid ${operator_uid} --operator-gid ${operator_gid}",
    );
    expect(installer).toContain(
      "ReadWritePaths=/opt/fased/host-controller /var/lib/fased-host-updater/supervisor /run/fased-host-updater",
    );
    const sharedStateCreation =
      'install -d -m 2770 -o "$target_user" -g "$config_group" "${target_home}/.fased"';
    expect(installer).toContain(sharedStateCreation);
    expect(installer.indexOf(sharedStateCreation)).toBeLessThan(
      installer.indexOf("cat >/etc/systemd/system/fased-host-updater.service"),
    );
    const supervisorUnit = installer.slice(
      installer.indexOf("cat >/etc/systemd/system/fased-host-updater.service"),
      installer.indexOf("cat >/etc/systemd/system/fased-signerd.service"),
    );
    expect(supervisorUnit).not.toContain("ReadOnlyPaths=");
    expect(supervisorUnit).toContain("RestrictSUIDSGID=true");
    expect(supervisorUnit).toContain("CapabilityBoundingSet=CAP_CHOWN\nAmbientCapabilities=");
    const controllerUnit = installer.slice(
      installer.indexOf("cat >/etc/systemd/system/fased-host-controller.service"),
      installer.indexOf("cat >/etc/systemd/system/fased-host-updater.service"),
    );
    expect(controllerUnit).toContain("AmbientCapabilities=CAP_SETUID CAP_SETGID");
    expect(controllerUnit).not.toContain("RestrictSUIDSGID=true");
    expect(installer).toContain("ReadWritePaths=/opt/fased/host-controller");
    expect(installer).toContain("RestartSec=1");
    expect(installer).toContain("/var/lib/fased-host-updater/controller-version.json");
    expect(installer).toContain('node "$FASED_DIR/scripts/fased-host-updater.mjs" --self-check');
    expect(installer).toContain('node "$FASED_DIR/scripts/fased-host-updaterctl.mjs" --self-check');
    expect(installer).toContain(
      'node "$FASED_DIR/scripts/fased-lifecycle-supervisor.mjs" --self-check',
    );
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
      "install -m 0755 scripts/fased-lifecycle-supervisor.mjs dist-native/release/fased-lifecycle-supervisor.mjs",
    );
    expect(releaseWorkflow).toContain(
      "dist-native/release/fased-host-updater.mjs.attestation.json",
    );
    expect(releaseWorkflow).toContain(
      "dist-native/release/fased-host-updaterctl.mjs.attestation.json",
    );
    expect(releaseWorkflow).toContain(
      "dist-native/release/fased-lifecycle-supervisor.mjs.attestation.json",
    );
    expect(releaseWorkflow).toContain(
      "--output .artifacts/hosted-runtime/fased-lifecycle-trust-v1.json",
    );
    expect(
      releaseWorkflow.match(/--root-policy release\/lifecycle-trust\/root-v1\//gu),
    ).toHaveLength(1);
    expect(releaseWorkflow).toContain(
      "subject-path: .artifacts/hosted-runtime/fased-lifecycle-trust-v1.json",
    );
    expect(installer).toContain(
      '"$lifecycle_metadata" "$lifecycle_metadata_bundle" "$release_version"',
    );
    expect(installer).toContain("lifecycle_expires_epoch - lifecycle_issued_epoch > 34560000");
    expect(installer).toContain(
      'grep -Fxq "lifecycle_metadata_sha256=${lifecycle_metadata_digest}"',
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
    const installer = fs.readFileSync(path.join(root, "install.sh"), "utf8");
    expect(releaseWorkflow).toContain("node scripts/stamp-release-installer.mjs");
    expect(releaseWorkflow).toContain("--output dist-native/release/install.sh");
    expect(releaseWorkflow).not.toContain(
      'gh release upload "$GITHUB_REF_NAME" .artifacts/hosted-runtime/* --repo "$GITHUB_REPOSITORY" --clobber',
    );
    expect(installer).toContain('install_entry_release_identity="__FASED_RELEASE_IDENTITY__"');
    expect(installer).toContain("Refusing an unstamped streamed installer.");
    expect(releaseWorkflow).toContain("name: Attest root Hosting bootstrap");
    expect(releaseWorkflow).toContain("subject-path: dist-native/release/install.sh");
    expect(releaseWorkflow).toContain(
      '"${{ steps.attest-hosting-bootstrap.outputs.bundle-path }}"',
    );
    expect(releaseWorkflow).toContain("dist-native/release/install.sh.attestation.json");
    expect(releaseWorkflow).toContain('gh release create "$RELEASE_TAG"');
    expect(releaseWorkflow).toContain("--draft");
    expect(releaseWorkflow).toContain("release-artifact-set.mjs verify-assets");
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
    const validateJob = releaseWorkflow.slice(
      releaseWorkflow.indexOf("  validate:"),
      releaseWorkflow.indexOf("\n  linux:"),
    );
    expect(validateJob).toContain("fetch-depth: 0");
    expect(validateJob).toContain("name: Build exact candidate once");
    expect(validateJob).toContain("run: pnpm build");
    expect(releaseWorkflow).not.toContain("run: pnpm release:check");
    expect(releaseWorkflow).toContain("pnpm hosted:artifact:from-dist --output");
    expect(releaseWorkflow).not.toContain("run: pnpm hosted:artifact --output");
    expect(releaseWorkflow).toContain("needs: [validate, linux, signer]");
  });

  it("assembles protected-main candidates before owner-tagged publication", () => {
    expect(releaseWorkflow).toContain("name: Assemble offline-attested candidate");
    expect(releaseWorkflow).toContain("name: fased-hosting-candidate");
    expect(releaseWorkflow).toContain("fased-hosted-release-v2.json.attestation.json");
    expect(releaseWorkflow).toContain("name: Verify every staged candidate attestation offline");
    expect(releaseWorkflow).toContain('--source-ref "$GITHUB_REF"');
    expect(releaseWorkflow).toContain("--deny-self-hosted-runners");
    expect(releaseWorkflow).toContain(
      "if: startsWith(github.ref, 'refs/tags/v') || github.event_name == 'workflow_dispatch'",
    );
    expect(releaseWorkflow).toContain("name: Promote exact verified candidate bytes");
    expect(releaseWorkflow).toContain("environment: candidate-release");
    expect(releaseWorkflow).toContain("name: Reverify immutable candidate tag after P1");
  });

  it("publishes tagged prereleases as non-latest GitHub prereleases", () => {
    expect(releaseWorkflow).toContain('if [[ "$package_version" == *-* ]]');
    expect(releaseWorkflow).toContain("release_args+=(--prerelease)");
    expect(releaseWorkflow).toContain("make_latest=false");
    expect(releaseWorkflow).toContain('-f make_latest="$make_latest"');
    expect(releaseWorkflow).toContain('-F prerelease="$is_prerelease"');
    expect(releaseWorkflow).toContain(
      'test "$(jq -r .isPrerelease "$RUNNER_TEMP/published-release.json")" = "$is_prerelease"',
    );
  });

  it("runs the streamed bootstrap fixture without an external package mirror layer", () => {
    const dockerfile = fs.readFileSync(
      path.join(root, "scripts/docker/streamed-hosting-bootstrap/Dockerfile"),
      "utf8",
    );
    const fixture = fs.readFileSync(
      path.join(root, "scripts/docker/streamed-hosting-bootstrap/run.sh"),
      "utf8",
    );
    expect(dockerfile).not.toContain("apt-get");
    expect(dockerfile).not.toContain("install -y");
    expect(dockerfile).toContain("COPY run.sh");
    expect(fixture).toContain("release_installer=/tmp/fased-release-install.sh");
    expect(fixture).toContain(
      "release_marker='install_entry_release_identity=\"__FASED_RELEASE_IDENTITY__\"'",
    );
    expect(fixture).toContain('"$fixture/fased-lifecycle-trust-v1.json"');
    expect(fixture).toContain('"$fixture/fased-lifecycle-trust-v1.json.attestation.json"');
    expect(fixture).toContain('"$fixture/app/package/scripts/fased-lifecycle-supervisor.mjs"');
    expect(fixture).toContain('[[ "$(wc -l </tmp/fased-gh-verification.log)" -eq 3 ]]');
    expect(fixture).toContain('<"$release_installer"');
    expect(fixture).not.toContain("</repo/install.sh");
  });

  it("keeps candidate transport substitution fixture-owned and outside the product protocol", () => {
    const fixture = fs.readFileSync(
      path.join(root, "scripts/docker/protected-local-systemd/run.sh"),
      "utf8",
    );
    const supervisor = fs.readFileSync(
      path.join(root, "scripts/fased-lifecycle-supervisor.mjs"),
      "utf8",
    );
    const updater = fs.readFileSync(path.join(root, "scripts/fased-host-updater.mjs"), "utf8");
    expect(supervisor).toContain(
      'const RELEASE_BASE = "https://github.com/fased-ai/fased/releases/download"',
    );
    expect(updater).toContain(
      'const RELEASE_BASE = "https://github.com/fased-ai/fased/releases/download"',
    );
    expect(supervisor).not.toContain("FASED_HOSTED_ARTIFACT_BASE_URL");
    expect(updater).not.toContain("FASED_HOSTED_ARTIFACT_BASE_URL");
    expect(fixture).toContain("DefaultEnvironment=NODE_EXTRA_CA_CERTS=");
    expect(fixture).toContain("127.0.0.1 github.com");
    expect(fixture).toContain("/repo/scripts/privileged-release-evidence.mjs build");
    expect(fixture).toContain("/repo/scripts/build-lifecycle-trust-metadata.mjs");
    expect(fixture).toContain(
      "const releasePrefix = `/fased-ai/fased/releases/download/v${version}/`",
    );
    expect(fixture).not.toContain("/etc/fased/testing");
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
    const source = fs.readFileSync(path.join(root, "install.sh"), "utf8");
    const run = (args: string[], extraEnv: NodeJS.ProcessEnv = {}) => {
      const releaseIndex = args.indexOf("--release");
      const requested =
        releaseIndex >= 0 ? String(args[releaseIndex + 1] ?? "").replace(/^v/u, "") : "";
      const identity = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(requested)
        ? requested
        : "1.2.3";
      const input = source.replace(
        'install_entry_release_identity="__FASED_RELEASE_IDENTITY__"',
        `install_entry_release_identity="${identity}"`,
      );
      return spawnSync("bash", ["-s", "--", ...args], {
        encoding: "utf8",
        env: streamedHostingEnv(extraEnv),
        input,
        ...(typeof process.getuid === "function" && process.getuid() === 0
          ? { uid: 65534, gid: 65534 }
          : {}),
      });
    };

    const exact = run(["--hosting"]);
    expect(exact.status).toBe(1);
    expect(exact.stderr).not.toContain("accepts only the exact fresh-install selector");
    expect(exact.stderr).toMatch(
      /must start in the provider's root console|only for a fresh host/iu,
    );

    const exactStable = run(["--hosting", "--release", "v1.2.3", "--update-channel", "stable"]);
    expect(exactStable.status).toBe(1);
    expect(exactStable.stderr).not.toContain("accepts only the public one-command selector");
    expect(exactStable.stderr).toMatch(
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

    const mismatched = spawnSync(
      "bash",
      ["-s", "--", "--hosting", "--release", "v1.2.4", "--update-channel", "stable"],
      {
        encoding: "utf8",
        env: streamedHostingEnv(),
        input: source.replace(
          'install_entry_release_identity="__FASED_RELEASE_IDENTITY__"',
          'install_entry_release_identity="1.2.3"',
        ),
        ...(typeof process.getuid === "function" && process.getuid() === 0
          ? { uid: 65534, gid: 65534 }
          : {}),
      },
    );
    expect(mismatched.status).toBe(1);
    expect(mismatched.stderr).toContain(
      "The immutable installer identity does not match the requested release.",
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
    expect(installer).toContain(
      "Persistent installer state exists; fix the reported problem and rerun the same public --hosting command from the provider root console.",
    );
    expect(installer).not.toContain(
      "Persistent installer state exists; retry only with the exact tagged, attested repair procedure.",
    );
    expect(installer).not.toContain(
      "Streamed VPS Hosting is only for a fresh host; existing Fased state was found.",
    );
  });

  it("keeps the exact public fresh Hosting command as a literal CI contract", () => {
    const command =
      "curl -fsSL https://github.com/fased-ai/fased/releases/latest/download/install.sh \\\n" +
      "  | bash -s -- --hosting";
    expect(command).toBe(
      "curl -fsSL https://github.com/fased-ai/fased/releases/latest/download/install.sh \\\n" +
        "  | bash -s -- --hosting",
    );
    const installer = fs.readFileSync(path.join(root, "install.sh"), "utf8");
    const manifestVerification = installer.indexOf(
      '"$release_manifest" "$release_manifest_bundle" "$release_version"',
    );
    const signerDigestVerification = installer.indexOf('"$signer_actual" != "$signer_expected"');
    const mutation = installer.indexOf(
      "install -d -m 0700 -o root -g root /var/lib/fased-installer",
    );
    expect(installer).toContain(
      '"$asset" == "fased-hosted-app-v2-linux-${architecture}-v${release_version}.tar.gz"',
    );
    expect(installer).toContain('"$signer_asset" == "fased-signerd-${signer_platform}"');
    expect(installer).toContain(
      '"$release_manifest" "$release_manifest_bundle" "$release_version"',
    );
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
      "curl -fsSL https://github.com/fased-ai/fased/releases/latest/download/install.sh \\",
    );
    const advanced = vpsGuide.indexOf("<AccordionGroup>");
    expect(command).toBeGreaterThanOrEqual(0);
    expect(vpsGuide).toContain("| bash -s -- --hosting");
    expect(advanced).toBeGreaterThan(command);
  });
});
