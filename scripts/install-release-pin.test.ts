import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const installer = fs.readFileSync(new URL("../install.sh", import.meta.url), "utf8");
const developerInstaller = fs.readFileSync(
  new URL("./install-development.sh", import.meta.url),
  "utf8",
);
const exactLocalCommit = "b".repeat(40);

function writeExecutable(filePath: string, source: string): void {
  fs.writeFileSync(filePath, source, { mode: 0o700 });
}

function resolveSystemCommand(command: string): string {
  for (const directory of ["/usr/bin", "/bin"]) {
    const candidate = path.join(directory, command);
    if (fs.existsSync(candidate)) {
      return fs.realpathSync(candidate);
    }
  }
  throw new Error(`missing fixture system command: ${command}`);
}

function createExactLocalBootstrapHarness(
  tempRoot: string,
  options: {
    uid: number;
    preinstallVerificationTools?: boolean;
    packageManager?: "apt-get" | "dnf" | "dnf5" | "brew";
    provideSudo?: boolean;
  },
): {
  binDir: string;
  installDir: string;
  standaloneInstaller: string;
} {
  const binDir = path.join(tempRoot, "bin");
  const installDir = path.join(tempRoot, "checkout");
  const standaloneDir = path.join(tempRoot, "standalone");
  const standaloneInstaller = path.join(standaloneDir, "install.sh");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(standaloneDir, { recursive: true });
  fs.copyFileSync(new URL("../install.sh", import.meta.url), standaloneInstaller);
  fs.chmodSync(standaloneInstaller, 0o700);

  for (const command of [
    "bash",
    "cat",
    "chmod",
    "dirname",
    "find",
    "grep",
    "mkdir",
    "mktemp",
    "readlink",
    "rm",
    "stat",
  ]) {
    const resolved = resolveSystemCommand(command);
    fs.symlinkSync(resolved, path.join(binDir, command));
  }

  writeExecutable(
    path.join(binDir, "id"),
    `#!/bin/bash
set -euo pipefail
if [[ "\${1:-}" == "-u" ]]; then
  printf '%s\\n' ${options.uid}
  exit 0
fi
exit 1
`,
  );
  writeExecutable(
    path.join(binDir, "apt-get"),
    `#!/bin/bash
exit 0
`,
  );
  const packageManager = options.packageManager ?? "apt-get";
  if (packageManager !== "apt-get") {
    fs.rmSync(path.join(binDir, "apt-get"));
    writeExecutable(
      path.join(binDir, packageManager),
      packageManager === "brew"
        ? `#!/bin/bash
set -euo pipefail
printf 'package-manager progress before verified commit\\n'
printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n'
cat >"$FASED_TEST_BIN/jq" <<'JQ'
#!/bin/bash
set -euo pipefail
if [[ "$*" == *tag_name* ]]; then
  printf 'v%s\\n' "$FASED_TEST_RELEASE"
elif [[ "\${FASED_TEST_MANIFEST_INVALID:-0}" == "1" ]]; then
  exit 41
else
  printf '%s\\n' "$FASED_TEST_COMMIT"
fi
JQ
cat >"$FASED_TEST_BIN/gh" <<'GH'
#!/bin/bash
set -euo pipefail
if [[ "\${1:-}" == "attestation" && "\${2:-}" == "verify" ]]; then
  [[ "\${FASED_TEST_ATTESTATION_FAIL:-0}" != "1" ]] || exit 42
  exit 0
fi
exit 1
GH
chmod 0700 "$FASED_TEST_BIN/jq" "$FASED_TEST_BIN/gh"
`
        : `#!/bin/bash
exit 0
`,
    );
  }
  writeExecutable(
    path.join(binDir, "curl"),
    `#!/bin/bash
set -euo pipefail
output=""
while (( $# > 0 )); do
  if [[ "$1" == "-o" ]]; then
    output="$2"
    shift 2
    continue
  fi
  shift
done
if [[ -z "$output" ]]; then
  printf '{"tag_name":"v%s"}\\n' "$FASED_TEST_RELEASE"
  exit 0
fi
mkdir -p "$(dirname "$output")"
printf '{}\\n' >"$output"
`,
  );
  writeExecutable(
    path.join(binDir, "git"),
    `#!/bin/bash
set -euo pipefail
if [[ "\${1:-}" == "clone" ]]; then
  destination="\${!#}"
  mkdir -p "$destination"
  cat >"$destination/install.sh" <<'INNER'
#!/bin/bash
set -euo pipefail
printf 'exact-local-inner-handoff %s\\n' "$*"
INNER
  chmod 0700 "$destination/install.sh"
  exit 0
fi
if [[ "\${1:-}" == "-C" && "\${3:-}" == "rev-parse" ]]; then
  printf '%s\\n' "\${FASED_TEST_TAG_COMMIT:-$FASED_TEST_COMMIT}"
  exit 0
fi
if [[ "\${1:-}" == "-C" && ( "\${3:-}" == "fetch" || "\${3:-}" == "checkout" ) ]]; then
  exit 0
fi
printf 'unexpected git invocation: %s\\n' "$*" >&2
exit 1
`,
  );
  if (options.provideSudo !== false) {
    writeExecutable(
      path.join(binDir, "sudo"),
      `#!/bin/bash
set -euo pipefail
printf 'package-manager progress before verified commit\\n'
printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n'
cat >"$FASED_TEST_BIN/jq" <<'JQ'
#!/bin/bash
set -euo pipefail
if [[ "$*" == *tag_name* ]]; then
  printf 'v%s\\n' "$FASED_TEST_RELEASE"
elif [[ "\${FASED_TEST_MANIFEST_INVALID:-0}" == "1" ]]; then
  exit 41
else
  printf '%s\\n' "$FASED_TEST_COMMIT"
fi
JQ
cat >"$FASED_TEST_BIN/gh" <<'GH'
#!/bin/bash
set -euo pipefail
if [[ "\${1:-}" == "attestation" && "\${2:-}" == "verify" ]]; then
  if [[ "\${3:-}" == "--help" ]]; then
    exit 0
  fi
  if [[ "\${FASED_TEST_ATTESTATION_FAIL:-0}" == "1" ]]; then
    exit 42
  fi
  exit 0
fi
exit 1
GH
chmod 0700 "$FASED_TEST_BIN/jq" "$FASED_TEST_BIN/gh"
`,
    );
  }

  if (options.preinstallVerificationTools) {
    writeExecutable(
      path.join(binDir, "jq"),
      `#!/bin/bash
set -euo pipefail
if [[ "$*" == *tag_name* ]]; then
  printf 'v%s\\n' "$FASED_TEST_RELEASE"
elif [[ "\${FASED_TEST_MANIFEST_INVALID:-0}" == "1" ]]; then
  exit 41
else
  printf '%s\\n' "$FASED_TEST_COMMIT"
fi
`,
    );
    writeExecutable(
      path.join(binDir, "gh"),
      `#!/bin/bash
set -euo pipefail
if [[ "\${1:-}" == "attestation" && "\${2:-}" == "verify" ]]; then
  if [[ "\${3:-}" == "--help" ]]; then
    exit 0
  fi
  if [[ "\${FASED_TEST_ATTESTATION_FAIL:-0}" == "1" ]]; then
    exit 42
  fi
  if [[ "\${FASED_TEST_ATTESTATION_MAIN_ONLY:-0}" == "1" && "$*" != *"--source-ref refs/heads/main"* ]]; then
    exit 43
  fi
  exit 0
fi
exit 1
`,
    );
  }

  return { binDir, installDir, standaloneInstaller };
}

function runExactLocalBootstrap(
  harness: ReturnType<typeof createExactLocalBootstrapHarness>,
  tempRoot: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
) {
  return spawnSync("/bin/bash", [harness.standaloneInstaller, ...args], {
    encoding: "utf8",
    env: {
      HOME: path.join(tempRoot, "home"),
      PATH: harness.binDir,
      FASED_TEST_BIN: harness.binDir,
      FASED_TEST_COMMIT: exactLocalCommit,
      FASED_TEST_RELEASE: "9.9.9-test.1",
      ...extraEnv,
    },
  });
}

describe("managed installer release pinning", () => {
  it("permits fresh stable or exact-release streamed Hosting and retains exact-tag repair", () => {
    expect(installer).toContain(
      'if [[ "$install_entry_is_stream" -eq 1 && "$install_entry_hosting" -eq 1 ]]',
    );
    expect(installer).toContain(
      "Streamed VPS Hosting accepts only the public one-command selector:",
    );
    expect(installer).toContain(
      "--hosting --release vX.Y.Z[-prerelease] --update-channel stable|beta",
    );
    expect(installer).toContain(
      "The same selector installs fresh or repairs an interrupted/completed installation",
    );
    expect(installer).toContain("Refusing Fased environment overrides during streamed VPS Hosting");
    expect(installer).toContain(
      'if [[ "$hosting_bootstrap" -eq 1 && "$hosting_repair_bootstrap" -eq 0 && -z "$hosting_release" ]]',
    );
    expect(installer).not.toContain("Refusing streamed VPS Hosting repair");
    expect(installer).toContain('hosting_release="latest"');
    expect(installer).toContain("bootstrap_hosting_attested_bundle");
    expect(installer).toContain(
      '"$release_manifest" "$release_manifest_bundle" "$release_version"',
    );
    expect(installer).toContain('"$actual" != "$expected"');
    expect(installer).toContain('"$dependency_actual" != "$dependency_expected"');
    expect(installer).toContain('"$signer_actual" != "$signer_expected"');
  });

  it("resolves a streamed fresh Local install to one stable release before cloning source", () => {
    const localReleaseStart = installer.indexOf(
      'if [[ "$hosting_bootstrap" -eq 0 && -z "$hosting_release" ]]',
    );
    const localReleaseEnd = installer.indexOf("\n  fi\n", localReleaseStart);
    const localReleaseResolver = installer.slice(localReleaseStart, localReleaseEnd);

    expect(installer).toContain('if [[ "$hosting_bootstrap" -eq 0 && -z "$hosting_release" ]]');
    expect(installer).toContain("resolve_public_latest_release_tag");
    expect(installer).not.toContain("gh release view --repo fased-ai/fased");
    expect(installer).toContain("install_current_github_cli_bootstrap");
    expect(localReleaseStart).toBeGreaterThanOrEqual(0);
    expect(localReleaseEnd).toBeGreaterThan(localReleaseStart);
    expect(localReleaseResolver).not.toContain("apt-get");
    expect(installer).toContain('hosting_release="$latest_local_tag"');
  });

  it("routes every stamped Local installer file through the verified bootstrap", () => {
    expect(installer).toContain("install_entry_local_file_bootstrap=0");
    expect(installer).toContain(
      'if [[ "$install_entry_is_stream" -eq 0 && "$install_entry_hosting" -eq 0',
    );
    expect(installer).toContain("install_entry_local_file_bootstrap=1");
    expect(installer).not.toContain("scripts/install-runtime-profile.sh");
    expect(installer).toContain(
      'if [[ "$install_entry_is_stream" -eq 1 || "$install_entry_local_file_bootstrap" -eq 1',
    );
  });

  it("drains a streamed installer before replacing its pipe reader", () => {
    const functionStart = installer.indexOf("  exec_bootstrapped_installer() {");
    const functionEnd = installer.indexOf(
      '\n\n  if [[ "$existing_local_state" -eq 1 ]]',
      functionStart,
    );
    expect(functionStart).toBeGreaterThanOrEqual(0);
    expect(functionEnd).toBeGreaterThan(functionStart);
    const handoffFunction = installer.slice(functionStart, functionEnd);
    expect(handoffFunction).toContain("cat >/dev/null");
    expect(handoffFunction).toContain('exec bash "$installer_path" "$@" < /dev/null');

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fased-local-stream-handoff-"));
    try {
      const inner = path.join(tempRoot, "inner.sh");
      const harness = path.join(tempRoot, "harness.sh");
      fs.writeFileSync(
        inner,
        "#!/usr/bin/env bash\nset -euo pipefail\nprintf 'handoff=%s\\n' \"$1\"\n",
        { mode: 0o700 },
      );
      fs.writeFileSync(
        harness,
        `#!/usr/bin/env bash
set -euo pipefail
install_entry_is_stream=1
${handoffFunction}
exec_bootstrapped_installer ${JSON.stringify(inner)} marker
`,
        { mode: 0o700 },
      );

      const result = spawnSync(
        "bash",
        [
          "-o",
          "pipefail",
          "-c",
          `dd if=/dev/zero bs=1048576 count=4 2>/dev/null | bash ${JSON.stringify(harness)}`,
        ],
        { encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("handoff=marker");
      expect(result.stderr).not.toContain("Broken pipe");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects a colliding fresh Local path before installing verification tools", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fased-local-path-collision-"));
    try {
      const harness = createExactLocalBootstrapHarness(tempRoot, { uid: 1000 });
      fs.mkdirSync(harness.installDir, { recursive: true });
      const result = runExactLocalBootstrap(harness, tempRoot, [
        "--local",
        "--release",
        "v9.9.9-test.1",
        "--update-channel",
        "beta",
        "--install-dir",
        harness.installDir,
      ]);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`Refusing to overwrite existing path: ${harness.installDir}`);
      expect(result.stdout).not.toContain("package-manager progress before verified commit");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("treats FASED_INSTALL_DIR as an explicit collision boundary", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fased-local-env-path-collision-"));
    try {
      const harness = createExactLocalBootstrapHarness(tempRoot, { uid: 1000 });
      fs.mkdirSync(harness.installDir, { recursive: true });
      const result = runExactLocalBootstrap(
        harness,
        tempRoot,
        ["--local", "--release", "v9.9.9-test.1", "--update-channel", "beta"],
        { FASED_INSTALL_DIR: harness.installDir },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`Refusing to overwrite existing path: ${harness.installDir}`);
      expect(result.stdout).not.toContain("package-manager progress before verified commit");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("routes pre-handoff Local state through the standard bootstrap without repair or onboarding", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fased-existing-local-state-"));
    try {
      const harness = createExactLocalBootstrapHarness(tempRoot, {
        uid: process.getuid?.() ?? 1000,
      });
      const home = path.join(tempRoot, "home");
      const stateDir = path.join(home, ".fased");
      fs.mkdirSync(path.join(home, "fased"), { recursive: true });
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, "fased.json"), "{}\n", { mode: 0o600 });
      fs.writeFileSync(
        path.join(stateDir, "install.json"),
        '{"schemaVersion":1,"profile":"local"}\n',
        { mode: 0o600 },
      );

      const result = runExactLocalBootstrap(harness, tempRoot, [
        "--local",
        "--release",
        "v9.9.9-test.1",
        "--update-channel",
        "beta",
        "--",
        "--non-interactive",
      ]);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("exact-local-inner-handoff");
      expect(result.stdout).toContain("--existing-local-bootstrap");
      expect(result.stdout).toMatch(/--existing-local-bootstrap -- --non-interactive/);
      expect(result.stdout).not.toContain("--repair-local");
      expect(result.stderr).toContain("Pre-handoff Local installation detected");
      expect(result.stderr).not.toContain(`Refusing to overwrite existing path: ${home}/fased`);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("directs an existing Protected Local installation to fased update without release work", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fased-existing-protected-local-"));
    try {
      const harness = createExactLocalBootstrapHarness(tempRoot, {
        uid: process.getuid?.() ?? 1000,
      });
      const stateDir = path.join(tempRoot, "home", ".fased");
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, "fased.json"), "{}\n", { mode: 0o600 });
      fs.writeFileSync(
        path.join(stateDir, "install.json"),
        '{"schemaVersion":2,"profile":"protected-local"}\n',
        { mode: 0o600 },
      );
      fs.writeFileSync(
        path.join(stateDir, "install-complete.json"),
        '{"schemaVersion":1,"onboardingCompleted":true}\n',
        { mode: 0o600 },
      );
      const generationDigest = "a".repeat(64);
      const generationDir = path.join(stateDir, "updater", "generations", generationDigest);
      fs.mkdirSync(generationDir, { recursive: true });
      for (const name of [
        "fased-managed-updater.mjs",
        "fased-generation-updater-core.mjs",
        "generation-updater.mjs",
        "hosted-release-manifest.mjs",
        "lifecycle-trust-crypto.mjs",
        "lifecycle-trust-policy.mjs",
        "lifecycle-trust-root.mjs",
        "lifecycle-trust-runtime.mjs",
        "managed-runtime-layout.mjs",
        "managed-updater-bundle.mjs",
        "managed-updater-bundle.v1.json",
        "managed-updater-generation.v1.json",
      ]) {
        fs.writeFileSync(path.join(generationDir, name), `${name}\n`);
      }
      fs.symlinkSync(
        path.join("generations", generationDigest),
        path.join(stateDir, "updater", "current"),
      );
      fs.mkdirSync(path.join(stateDir, "bin"), { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "bin", "fased"),
        '#!/bin/bash\nUPDATER_GENERATION="$STATE_DIR/updater/current/fased-managed-updater.mjs"\n',
        { mode: 0o700 },
      );

      const result = runExactLocalBootstrap(harness, tempRoot, [
        "--local",
        "--release",
        "v9.9.9-test.1",
        "--update-channel",
        "beta",
      ]);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain(
        "Existing Protected Local installation detected; use fased update.",
      );
      expect(result.stdout).not.toContain("exact-local-inner-handoff");
      expect(result.stdout).not.toContain("package-manager progress before verified commit");
      expect(fs.existsSync(harness.installDir)).toBe(false);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("routes an existing Protected Local installation with no complete updater generation through one standard handoff", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fased-protected-forward-handoff-"));
    try {
      const harness = createExactLocalBootstrapHarness(tempRoot, {
        uid: process.getuid?.() ?? 1000,
      });
      const stateDir = path.join(tempRoot, "home", ".fased");
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, "fased.json"), "{}\n", { mode: 0o600 });
      fs.writeFileSync(
        path.join(stateDir, "install.json"),
        '{"schemaVersion":2,"profile":"protected-local"}\n',
        { mode: 0o600 },
      );
      fs.writeFileSync(
        path.join(stateDir, "install-complete.json"),
        '{"schemaVersion":1,"onboardingCompleted":true}\n',
        { mode: 0o600 },
      );
      fs.mkdirSync(path.join(stateDir, "updater"), { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "updater", "fased-managed-updater.mjs"),
        'import "./missing-support.mjs";\n',
        { mode: 0o700 },
      );

      const result = runExactLocalBootstrap(harness, tempRoot, [
        "--local",
        "--release",
        "v9.9.9-test.1",
        "--update-channel",
        "beta",
      ]);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain(
        "Protected Local installation needs one verified lifecycle handoff; continuing without rerunning onboarding.",
      );
      expect(result.stdout).toContain("exact-local-inner-handoff");
      expect(result.stdout).toContain("--existing-local-bootstrap");
      expect(result.stdout).not.toContain("--repair-local");
      expect(result.stdout).not.toContain("--resume-local-onboarding");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("resumes onboarding without rebuilding an incomplete committed Protected Local topology", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fased-incomplete-protected-local-"));
    try {
      const harness = createExactLocalBootstrapHarness(tempRoot, {
        uid: process.getuid?.() ?? 1000,
      });
      const stateDir = path.join(tempRoot, "home", ".fased");
      fs.mkdirSync(path.join(tempRoot, "home", "fased"), { recursive: true });
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, "fased.json"), "{}\n", { mode: 0o600 });
      fs.writeFileSync(
        path.join(stateDir, "install.json"),
        '{"schemaVersion":2,"profile":"protected-local"}\n',
        { mode: 0o600 },
      );
      fs.writeFileSync(
        path.join(stateDir, "install-complete.json"),
        '{"schemaVersion":1,"onboardingCompleted":false}\n',
        { mode: 0o600 },
      );

      const result = runExactLocalBootstrap(harness, tempRoot, [
        "--local",
        "--release",
        "v9.9.9-test.1",
        "--update-channel",
        "beta",
      ]);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain(
        "Committed Protected Local services detected; resuming onboarding.",
      );
      expect(result.stdout).toContain("exact-local-inner-handoff");
      expect(result.stdout).toContain("--resume-local-onboarding");
      expect(result.stdout).not.toContain("--existing-local-bootstrap");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects unknown Local remnants before dependency or release work", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fased-unknown-local-state-"));
    try {
      const harness = createExactLocalBootstrapHarness(tempRoot, {
        uid: process.getuid?.() ?? 1000,
      });
      const stateDir = path.join(tempRoot, "home", ".fased");
      fs.mkdirSync(path.join(stateDir, "unknown"), { recursive: true });

      const result = runExactLocalBootstrap(harness, tempRoot, [
        "--local",
        "--release",
        "v9.9.9-test.1",
        "--update-channel",
        "beta",
      ]);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("not a recognized recoverable Fased installation");
      expect(result.stderr).toContain("No files were changed");
      expect(result.stdout).not.toContain("package-manager progress before verified commit");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("drains the public stream before entering a verified Hosting bundle", () => {
    const reuseStart = installer.indexOf(
      'echo "Reusing verified tagged Hosting bundle v${release_version} (${actual})."',
    );
    const reuseExec = installer.indexOf('exec bash "$existing_root/install.sh"', reuseStart);
    const freshStart = installer.indexOf(
      'echo "Verified tagged Hosting bundle v${release_version}; entering the root-owned installer."',
    );
    const freshExec = installer.indexOf('exec bash "$final_root/install.sh"', freshStart);

    expect(installer.slice(reuseStart, reuseExec)).toContain("drain_streamed_install_input");
    expect(installer.slice(freshStart, freshExec)).toContain("drain_streamed_install_input");
  });

  it("routes an unstamped contributor checkout to the developer installer", () => {
    expect(installer).toContain(
      'if [[ "$install_entry_is_stream" -eq 0 && -z "$install_entry_release_identity"',
    );
    expect(installer).toContain(
      'exec "$install_entry_source_dir/scripts/install-development.sh" "$@"',
    );
  });

  it("routes explicit source installation to the separate developer installer", () => {
    expect(installer).toContain('exec "$install_entry_source_dir/scripts/install-development.sh"');
    expect(installer).not.toContain("DIRTY_CHECKOUT_SOURCE_AUTO_SELECTED");
    expect(installer).not.toContain(
      "local checkout has changes; building and installing this checkout",
    );
    expect(developerInstaller).toContain('pnpm --dir "$repo_root" install --frozen-lockfile');
    expect(developerInstaller).toContain('exec "$HOME/.local/bin/fased" onboard --install-daemon');
    expect(installer).not.toContain("pnpm --silent run build:fast");
    expect(installer).not.toContain("pnpm --silent run ui:build");
    expect(installer).not.toContain("refresh_checkout_from_origin() {");
  });

  it("binds an exact Local repair checkout to the attested unified manifest commit", () => {
    expect(installer).toContain('local_bootstrap_release="${hosting_release#v}"');
    expect(installer).toContain("fased-hosted-release-v2.json.attestation.json");
    expect(installer).toContain('local_bootstrap_commit="$(resolve_attested_local_release_commit');
    expect(installer).toContain(
      '"refs/tags/v${local_bootstrap_release}:refs/fased-installer/v${local_bootstrap_release}"',
    );
    expect(installer).toContain('if [[ "$fetched_release_commit" != "$local_bootstrap_commit" ]]');
    expect(installer).toContain(
      'git -C "$install_base_dir" checkout --detach "$local_bootstrap_commit"',
    );
    expect(installer).toContain('fetched_release_commit=""');
    expect(installer).not.toContain('local fetched_release_commit=""');
  });

  it("routes a stamped Local installer through attested artifacts before any Git checkout", () => {
    expect(installer).toContain("materialize_attested_local_installer");
    expect(installer).toContain('verify_release_attestation_source "$installer" "$bundle"');
    expect(installer).toContain("run_attested_local_lifecycle");
    expect(installer).toContain(
      '"$signer_socket" == "/run/fased-local/$instance/application/app.sock"',
    );
    expect(installer).toContain('echo "Already current: $release_version"');
    expect(installer).toContain("Committed Local lifecycle could not complete onboarding.");
    expect(installer).not.toContain(
      '"$signer_socket" == "/run/fased-local/$instance/operator/operator.sock"',
    );
    expect(installer).toContain("--protected-local-root-bootstrap");
    expect(installer).toContain("--operation COMPLETE_ONBOARDING");
    expect(installer.indexOf("run_attested_local_lifecycle")).toBeLessThan(
      installer.indexOf("git clone --filter=blob:none --no-checkout"),
    );
  });

  it("keeps noisy verification-tool installation outside exact Local commit capture", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fased-exact-local-bootstrap-"));
    try {
      const harness = createExactLocalBootstrapHarness(tempRoot, { uid: 1000 });
      const result = runExactLocalBootstrap(harness, tempRoot, [
        "--local",
        "--release",
        "v9.9.9-test.1",
        "--update-channel",
        "beta",
        "--install-dir",
        harness.installDir,
      ]);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("package-manager progress before verified commit");
      expect(result.stdout).toContain("exact-local-inner-handoff");
      expect(result.stderr).not.toContain("Could not resolve the attested Local release commit");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it.each(["apt-get", "dnf", "dnf5", "brew"] as const)(
    "keeps noisy %s installation outside exact Local commit capture",
    (packageManager) => {
      const tempRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), `fased-${packageManager}-local-bootstrap-`),
      );
      try {
        const harness = createExactLocalBootstrapHarness(tempRoot, {
          uid: 1000,
          packageManager,
        });
        const result = runExactLocalBootstrap(harness, tempRoot, [
          "--local",
          "--release",
          "v9.9.9-test.1",
          "--update-channel",
          "beta",
          "--install-dir",
          harness.installDir,
        ]);

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("package-manager progress before verified commit");
        expect(result.stdout).toContain("exact-local-inner-handoff");
        expect(result.stderr).not.toContain("Could not resolve the attested Local release commit");
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    },
  );

  it.each([
    {
      label: "exact stable",
      release: "9.9.9",
      args: ["--release", "v9.9.9", "--update-channel", "stable"],
    },
    {
      label: "public stable selection",
      release: "9.9.9",
      args: ["--update-channel", "stable"],
    },
  ])("resolves $label through the same pure commit channel", ({ release, args }) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fased-stable-local-bootstrap-"));
    try {
      const harness = createExactLocalBootstrapHarness(tempRoot, { uid: 1000 });
      const result = runExactLocalBootstrap(
        harness,
        tempRoot,
        ["--local", ...args, "--install-dir", harness.installDir],
        { FASED_TEST_RELEASE: release },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("exact-local-inner-handoff");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("uses already-installed verification tools without package-manager output", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fased-warm-local-bootstrap-"));
    try {
      const harness = createExactLocalBootstrapHarness(tempRoot, {
        uid: 1000,
        preinstallVerificationTools: true,
      });
      const result = runExactLocalBootstrap(harness, tempRoot, [
        "--local",
        "--release",
        "v9.9.9-test.1",
        "--update-channel",
        "beta",
        "--install-dir",
        harness.installDir,
      ]);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).not.toContain("package-manager progress before verified commit");
      expect(result.stdout).toContain("exact-local-inner-handoff");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects a protected-main attestation even when release metadata names the commit", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fased-main-attested-local-"));
    try {
      const harness = createExactLocalBootstrapHarness(tempRoot, {
        uid: 1000,
        preinstallVerificationTools: true,
      });
      const result = runExactLocalBootstrap(
        harness,
        tempRoot,
        [
          "--repair-local",
          "--release",
          "v9.9.9-test.1",
          "--update-channel",
          "beta",
          "--install-dir",
          harness.installDir,
        ],
        { FASED_TEST_ATTESTATION_MAIN_ONLY: "1" },
      );

      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain("exact-local-inner-handoff");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("uses one tag-bound attestation policy for every release trust artifact", () => {
    expect(installer.match(/verify_release_attestation_source\(\)/gu)).toHaveLength(1);
    expect(installer.match(/verify_release_attestation_source \\\n/gu)).toHaveLength(3);
    expect(installer).toContain(
      'if ! verify_release_attestation_source "$manifest" "$bundle" "$release_version"; then',
    );
    expect(installer.match(/--source-ref "refs\/tags\/v\$\{release_version\}"/gu)).toHaveLength(1);
    expect(installer.match(/--source-ref "refs\/heads\/main"/gu)).toBeNull();
    expect(installer).not.toContain("for source_ref in");
  });

  it.each([
    { label: "sudo is unavailable", provideSudo: false, extraArgs: [] },
    {
      label: "automatic installation is disabled",
      provideSudo: true,
      extraArgs: ["--no-auto-install"],
    },
  ])(
    "fails without mutation when $label and verification tools are absent",
    ({ provideSudo, extraArgs }) => {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fased-no-tools-local-bootstrap-"));
      try {
        const harness = createExactLocalBootstrapHarness(tempRoot, { uid: 1000, provideSudo });
        const result = runExactLocalBootstrap(harness, tempRoot, [
          "--local",
          "--release",
          "v9.9.9-test.1",
          "--update-channel",
          "beta",
          "--install-dir",
          harness.installDir,
          ...extraArgs,
        ]);

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          "Local install requires GitHub CLI with attestation support and jq",
        );
        expect(fs.existsSync(harness.installDir)).toBe(false);
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    },
  );

  it("rejects Local installation as root before changing operator identity", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fased-root-local-bootstrap-"));
    try {
      const harness = createExactLocalBootstrapHarness(tempRoot, {
        uid: 0,
        preinstallVerificationTools: true,
      });
      const result = runExactLocalBootstrap(harness, tempRoot, [
        "--local",
        "--release",
        "v9.9.9-test.1",
        "--update-channel",
        "beta",
        "--install-dir",
        harness.installDir,
      ]);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Local installation must run from the intended non-root");
      expect(fs.existsSync(harness.installDir)).toBe(false);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("cleans exact Local verification state after attestation failure", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fased-local-attestation-failure-"));
    const verificationRoot = path.join(tempRoot, "verification-tmp");
    fs.mkdirSync(verificationRoot);
    try {
      const harness = createExactLocalBootstrapHarness(tempRoot, {
        uid: 1000,
        preinstallVerificationTools: true,
      });
      const result = runExactLocalBootstrap(
        harness,
        tempRoot,
        [
          "--local",
          "--release",
          "v9.9.9-test.1",
          "--update-channel",
          "beta",
          "--install-dir",
          harness.installDir,
        ],
        {
          TMPDIR: verificationRoot,
          FASED_TEST_ATTESTATION_FAIL: "1",
        },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Local release attestation verification failed");
      expect(fs.readdirSync(verificationRoot)).toEqual([]);
      expect(fs.existsSync(harness.installDir)).toBe(false);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects a malformed attested Local manifest and cleans verification state", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fased-invalid-local-manifest-"));
    const verificationRoot = path.join(tempRoot, "verification-tmp");
    fs.mkdirSync(verificationRoot);
    try {
      const harness = createExactLocalBootstrapHarness(tempRoot, {
        uid: 1000,
        preinstallVerificationTools: true,
      });
      const result = runExactLocalBootstrap(
        harness,
        tempRoot,
        [
          "--local",
          "--release",
          "v9.9.9-test.1",
          "--update-channel",
          "beta",
          "--install-dir",
          harness.installDir,
        ],
        {
          TMPDIR: verificationRoot,
          FASED_TEST_MANIFEST_INVALID: "1",
        },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "Attested release manifest does not bind one exact Local source commit",
      );
      expect(fs.readdirSync(verificationRoot)).toEqual([]);
      expect(fs.existsSync(harness.installDir)).toBe(false);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects a release tag commit that differs from the attested Local manifest", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fased-mixed-local-identity-"));
    try {
      const harness = createExactLocalBootstrapHarness(tempRoot, {
        uid: 1000,
        preinstallVerificationTools: true,
      });
      const result = runExactLocalBootstrap(
        harness,
        tempRoot,
        [
          "--local",
          "--release",
          "v9.9.9-test.1",
          "--update-channel",
          "beta",
          "--install-dir",
          harness.installDir,
        ],
        { FASED_TEST_TAG_COMMIT: "c".repeat(40) },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "Release tag commit does not match the attested unified release manifest",
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps attestation tooling on the public bootstrap path", () => {
    expect(installer).toContain("install_current_github_cli_bootstrap");
    expect(developerInstaller).not.toContain("install_current_github_cli_bootstrap");
  });

  it("permits prerelease Hosting only through an explicit beta update channel", () => {
    expect(installer).toContain("Hosting prerelease installation requires --update-channel beta.");
    expect(installer).toContain("Local prerelease installation requires --update-channel beta.");
    expect(installer).toContain('"$hosting_update_channel" =~ ^(stable|beta)$');
  });
});
