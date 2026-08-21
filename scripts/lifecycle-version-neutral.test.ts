import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const fixtureOnlyHelper = resolve(repoRoot, "scripts/lifecycle-fixture-only-paths.sh");
const local0ReceiptInventoryHelper = resolve(repoRoot, "scripts/local0-receipt-inventory.sh");

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

describe("version-neutral lifecycle acceptance", () => {
  it("uses one cached tag-free LOCAL0 driver before release allocation", async () => {
    const local0 = await readFile(resolve(repoRoot, "scripts/run-lifecycle-local0.sh"), "utf8");

    expect(local0).toContain('MODE="all"');
    expect(local0).toContain('identity_key="${commit}-${tree}-${lockfile_digest#sha256:}"');
    expect(local0).toContain('failure_marker="$CACHE_ROOT/failures/$identity_key.json"');
    expect(local0).toContain('install -m 0600 "$aggregate_receipt" "$failure_marker"');
    expect(local0).toContain('rm -f -- "$failure_marker"');
    expect(local0).toContain("scripts/prepare-candidate-fixture-trust.sh");
    expect(local0).toContain("scripts/test-lifecycle-local-acceptance.sh");
    expect(local0).toContain("scripts/test-lifecycle-hosting-acceptance.sh");
    expect(local0).toContain("local-canonical-managed");
    expect(local0).toContain("completeLocal0");
    expect(local0).toContain("validate_receipt_set");
    expect(local0).toContain("fixtureOnlyDescendant");
    expect(local0).toContain("artifact_product_commit");
    expect(local0).toContain("crosses the fixture-only reuse boundary");
    expect(local0).not.toContain("merge-base --is-ancestor");
    expect(local0).toContain('source "$ROOT_DIR/scripts/lifecycle-fixture-only-paths.sh"');
    expect(local0).toContain('source "$ROOT_DIR/scripts/local0-receipt-inventory.sh"');
    expect(local0).toContain('.evidenceClass == "PASS" and .commit == $commit');
    expect(local0).toContain(
      "LOCAL0 refused a false PASS without every exact verified child receipt.",
    );
    expect(local0).toContain("all) run_concurrent ;;");
    expect(local0).not.toMatch(/all\)\s+run_serial\s+run_concurrent/);
    expect(local0).toContain("--lane is valid only with --mode serial.");
    expect(local0).not.toMatch(/\bnpm (?:install|pack|publish|view)\b/u);
  });

  it("counts only primary lifecycle acceptance receipts", async () => {
    const receipts = await mkdtemp(join(tmpdir(), "fased-local0-receipts-"));
    try {
      await writeFile(
        resolve(receipts, "accepted.json"),
        JSON.stringify({ role: "fased-lifecycle-acceptance-receipt", evidenceClass: "PASS" }),
      );
      await writeFile(
        resolve(receipts, "accepted.json.runtime-processes.json"),
        JSON.stringify({ role: "fased-runtime-process-evidence", schemaVersion: 1 }),
      );
      await writeFile(
        resolve(receipts, "failed.partial.json"),
        JSON.stringify({ role: "fased-lifecycle-acceptance-receipt", evidenceClass: "FAIL" }),
      );

      const result = execFileSync(
        "bash",
        [
          "-c",
          'source "$1"; while IFS= read -r -d "" receipt; do basename "$receipt"; done < <(local0_acceptance_receipt_paths "$2")',
          "bash",
          local0ReceiptInventoryHelper,
          receipts,
        ],
        { encoding: "utf8" },
      );
      expect(result.trim()).toBe("accepted.json");
    } finally {
      await rm(receipts, { recursive: true, force: true });
    }
  });

  it("accepts content-equivalent squash trees and rejects product differences", async () => {
    const repo = await mkdtemp(join(tmpdir(), "fased-squash-artifact-reuse-"));
    try {
      git(repo, "init", "--quiet");
      git(repo, "config", "user.name", "Fased Fixture Test");
      git(repo, "config", "user.email", "fixture@example.invalid");
      await mkdir(resolve(repo, ".github/workflows"), { recursive: true });
      await mkdir(resolve(repo, "src"), { recursive: true });
      await mkdir(resolve(repo, "scripts"), { recursive: true });
      await writeFile(
        resolve(repo, ".github/workflows/hosted-runtime-release.yml"),
        "publication fixture v1\n",
      );
      await writeFile(resolve(repo, "src/product.txt"), "identical product bytes\n");
      await writeFile(resolve(repo, "scripts/run-lifecycle-local0.sh"), "fixture v1\n");
      git(repo, "add", ".");
      git(repo, "commit", "--quiet", "-m", "product artifact source");
      const productCommit = git(repo, "rev-parse", "HEAD");

      git(repo, "checkout", "--quiet", "--orphan", "squashed-main");
      git(repo, "rm", "-r", "-f", "--quiet", ".");
      await mkdir(resolve(repo, ".github/workflows"), { recursive: true });
      await mkdir(resolve(repo, "src"), { recursive: true });
      await mkdir(resolve(repo, "scripts"), { recursive: true });
      await writeFile(
        resolve(repo, ".github/workflows/hosted-runtime-release.yml"),
        "publication fixture v2\n",
      );
      await writeFile(resolve(repo, "src/product.txt"), "identical product bytes\n");
      await writeFile(resolve(repo, "scripts/run-lifecycle-local0.sh"), "fixture v2\n");
      await writeFile(resolve(repo, "scripts/local0-receipt-inventory.sh"), "fixture helper\n");
      git(repo, "add", ".");
      git(repo, "commit", "--quiet", "-m", "squashed fixture correction");
      const squashCommit = git(repo, "rev-parse", "HEAD");

      expect(
        spawnSync("git", ["-C", repo, "merge-base", "--is-ancestor", productCommit, squashCommit])
          .status,
      ).not.toBe(0);
      const allowed = spawnSync(
        "bash",
        [
          "-c",
          'source "$1"; lifecycle_unexpected_fixture_changes "$2" "$3" "$4"',
          "bash",
          fixtureOnlyHelper,
          repo,
          productCommit,
          squashCommit,
        ],
        { encoding: "utf8" },
      );
      expect(allowed.status).toBe(0);
      expect(allowed.stdout).toBe("");

      await writeFile(resolve(repo, "src/product.txt"), "changed product bytes\n");
      git(repo, "add", "src/product.txt");
      git(repo, "commit", "--quiet", "-m", "product change");
      const changedCommit = git(repo, "rev-parse", "HEAD");
      const rejected = spawnSync(
        "bash",
        [
          "-c",
          'source "$1"; lifecycle_unexpected_fixture_changes "$2" "$3" "$4"',
          "bash",
          fixtureOnlyHelper,
          repo,
          productCommit,
          changedCommit,
        ],
        { encoding: "utf8" },
      );
      expect(rejected.status).toBe(0);
      expect(rejected.stdout.trim()).toBe("src/product.txt");

      const invalidIdentity = spawnSync(
        "bash",
        [
          "-c",
          'source "$1"; lifecycle_unexpected_fixture_changes "$2" "$3" "$4"',
          "bash",
          fixtureOnlyHelper,
          repo,
          productCommit,
          "0000000000000000000000000000000000000000",
        ],
        { encoding: "utf8" },
      );
      expect(invalidIdentity.status).not.toBe(0);
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  });

  it("requires explicit public predecessor identities and has no private-RC scenario", async () => {
    const wrapper = await readFile(
      resolve(repoRoot, "scripts/test-lifecycle-local-acceptance.sh"),
      "utf8",
    );
    const fixture = await readFile(
      resolve(repoRoot, "scripts/docker/protected-local-systemd/lifecycle-acceptance.sh"),
      "utf8",
    );
    const hostingWrapper = await readFile(
      resolve(repoRoot, "scripts/test-lifecycle-hosting-acceptance.sh"),
      "utf8",
    );
    const fixtureOnlyPaths = await readFile(
      resolve(repoRoot, "scripts/lifecycle-fixture-only-paths.sh"),
      "utf8",
    );

    for (const source of [wrapper, fixture]) {
      expect(source).not.toMatch(/0\.1\.76-rc\./u);
      expect(source).not.toContain("legacy-takeover");
      expect(source).not.toContain("modern-update");
    }
    expect(wrapper).toContain("FASED_SYSTEMD_FIXTURE_MANAGED_PREDECESSOR_VERSION");
    expect(wrapper).toContain("managed-update");
    expect(fixture).toContain('--gateway-port "$gateway_port" \\\n      --local \\\n      --');
    expect(fixture).toContain('"fased-release-index-v1.json": "fased-branch-release-index.json"');
    expect(fixture).toContain(
      '"fased-release-index-v1.json.attestation.json": "fased-branch-delegation.json"',
    );
    expect(fixture).not.toContain("beta/current/release-index.json");
    expect(fixture).not.toContain('metadata.startsWith("beta/assets/")');
    expect(fixture).toContain('grep -F "fased-lifecycled: ROLLED_BACK:"');
    expect(fixture).not.toContain("target release failed and was rolled back");
    expect(fixture).toContain('if [[ "$predecessor_class" == "canonical-managed" ]]');
    expect(fixture).toContain('wait_for_gateway_version "$predecessor_version" managed-package');
    expect(fixture).toContain('local expected_source="${2:-go-lifecycle}"');
    expect(fixture).toContain('systemctl enable --now "$predecessor_service"');
    expect(fixture).toContain('user_systemctl enable --now "$predecessor_service"');
    expect(fixture).toContain('setfacl --no-mask --modify "user:$gateway_uid:--x"');
    expect(fixture).toContain('usermod -a -G "fsgw-$instance,fsop-$instance" "fssg-$instance"');
    expect(fixture).toContain('"../../dependencies/$dependency_hash/node_modules"');
    expect(fixture).toContain('"$dependency_root/.fased-dependency-layer.json"');
    expect(fixture).toContain('--arg archiveSHA256 "sha256:$dependency_digest"');
    expect(fixture).toContain('chmod 0644 \\\n    "$generation_root/inventory.json"');
    expect(fixture).toContain('--home-dir "/var/lib/fased-local/$instance"');
    expect(fixture).toContain('--home-dir "/var/lib/fased-local/$instance/signer"');
    expect(fixture).toContain('test -f "$state/bin/fased" && test ! -L "$state/bin/fased"');
    expect(fixture).toContain('chmod 0755 "$state/bin/fased"');
    expect(wrapper).toContain(
      'FIXTURE_PREINSTALLED_TOOLS_DIR="$FIXTURE_TOOLS_DIR/preinstalled-tools"',
    );
    expect(wrapper).toContain('GH_BIN="$(command -v gh || true)"');
    expect(wrapper).toContain(
      '-v "$FIXTURE_PREINSTALLED_TOOLS_DIR:/fixture-preinstalled-tools:ro,z"',
    );
    expect(fixture).toContain(
      "install -m 0755 -o root -g root /fixture-preinstalled-tools/gh /usr/bin/gh",
    );
    expect(fixture).toContain('test "$(stat -c \'%U:%G:%a\' /usr/bin/gh)" = "root:root:755"');
    expect(fixture).toContain("the one-time in-place takeover");
    expect(fixture).toContain("if run_target_installer \\");
    for (const source of [wrapper, hostingWrapper]) {
      expect(source).toContain('source "$ROOT_DIR/scripts/lifecycle-fixture-only-paths.sh"');
      expect(source).toContain("lifecycle_unexpected_fixture_changes");
    }
    expect(fixtureOnlyPaths).toContain("lifecycle-d8-contract|lifecycle-version-neutral");
    expect(fixtureOnlyPaths).toContain("npm-free-managed-lifecycle-contract");
    expect(fixtureOnlyPaths).toContain("docs/maintainers/codex-skills/fased-release-manager/");
    expect(fixtureOnlyPaths).toContain("scripts/run-lifecycle-local0\\.sh");
    expect(fixtureOnlyPaths).toContain("Containerfile\\.(ubuntu|rocky)");
  });

  it("binds candidate P1 to an explicit supported public predecessor", async () => {
    const source = await readFile(resolve(repoRoot, ".github/workflows/pre-tag-p1.yml"), "utf8");
    const workflow = parse(source) as {
      on?: { workflow_dispatch?: { inputs?: Record<string, unknown> } };
      jobs?: Record<
        string,
        {
          steps?: Array<{ env?: Record<string, string>; name?: string }>;
          strategy?: { matrix?: { predecessor?: string } };
        }
      >;
    };
    expect(workflow.on?.workflow_dispatch?.inputs).toHaveProperty("predecessor_version");
    expect(workflow.on?.workflow_dispatch?.inputs).toHaveProperty("managed_predecessor_version");
    expect(workflow.on?.workflow_dispatch?.inputs).not.toHaveProperty("owner_predecessor_version");
    expect(workflow.on?.workflow_dispatch?.inputs).not.toHaveProperty("predecessor_scenario");
    const update = workflow.jobs?.["local-update"]?.steps?.find((candidate) =>
      candidate.name?.includes("Local update entrypoint"),
    );
    const fresh = workflow.jobs?.["local-fresh"]?.steps?.find((candidate) =>
      candidate.name?.includes("fresh Local entrypoint"),
    );
    expect(update?.env).toMatchObject({
      FASED_SYSTEMD_FIXTURE_SCENARIOS: "${{ steps.scenario.outputs.scenarios }}",
      FASED_SYSTEMD_FIXTURE_MANAGED_PREDECESSOR_VERSION: "${{ matrix.predecessor.version }}",
      FASED_SYSTEMD_FIXTURE_MANAGED_PREDECESSOR_CLASS:
        "${{ matrix.predecessor.installationClass }}",
    });
    expect(workflow.jobs?.["local-update"]?.strategy?.matrix?.predecessor).toBe(
      "${{ fromJSON(needs.preflight.outputs.local_predecessors) }}",
    );
    expect(fresh?.env).toMatchObject({
      FASED_SYSTEMD_FIXTURE_SCENARIOS: "fresh-install",
    });
  });

  it("builds branch proof artifacts for Linux x64 without compiling release platforms", async () => {
    const wrapper = await readFile(
      resolve(repoRoot, "scripts/test-lifecycle-local-acceptance.sh"),
      "utf8",
    );
    expect(wrapper).toContain(
      'ARTIFACT_PROFILE="${FASED_SYSTEMD_FIXTURE_ARTIFACT_PROFILE:-branch-x64}"',
    );
    expect(wrapper).toContain('FASED_SIGNER_TARGETS="linux/amd64"');
    expect(wrapper).toContain('FASED_LIFECYCLE_TARGETS="linux/amd64"');
    expect(wrapper).not.toContain("copy_branch_x64_fixture_aliases()");
    expect(wrapper).not.toContain('cp --reflink=auto "$signer_source"');
    expect(wrapper).not.toContain("fased-signerd-darwin-amd64");
    expect(wrapper).not.toContain("fased-signerd-linux-arm64");
    expect(wrapper).toContain("build-native-release-assets.sh");
    expect(wrapper).not.toContain("--profile branch-x64");
    expect(wrapper).toContain('"$PUBLIC_ACQUISITION" == "1" && "$BUILD_ONLY" == "0"');
    expect(wrapper).toContain("branch-x64 artifacts are fixture-only and cannot be published");
    expect(wrapper).not.toContain(
      "FASED_SIGNER_TARGETS=linux/amd64,linux/arm64,darwin/amd64,darwin/arm64",
    );
    expect(wrapper).not.toContain("FASED_LIFECYCLE_TARGETS=linux/amd64,linux/arm64");
    expect(wrapper).toContain("clear_branch_fixture_native_outputs()");
    expect(wrapper).toContain("-name 'fased-signerd-*'");
    expect(wrapper).toContain("-name 'fased-lifecycled-*'");
    expect(wrapper).toContain("-name 'fased-bootstrap-*'");
    expect(wrapper.indexOf("clear_branch_fixture_native_outputs\n")).toBeLessThan(
      wrapper.indexOf('FASED_SIGNER_TARGETS="linux/amd64"'),
    );
  });

  it("reuses immutable proof inputs and runs isolated Local scenarios fail-fast in parallel", async () => {
    const wrapper = await readFile(
      resolve(repoRoot, "scripts/test-lifecycle-local-acceptance.sh"),
      "utf8",
    );

    expect(wrapper).toContain("FASED_SYSTEMD_FIXTURE_ARTIFACT_CACHE_DIR");
    expect(wrapper).toContain("FASED_SYSTEMD_FIXTURE_PREDECESSOR_CAPSULE_DIR");
    expect(wrapper).toContain('artifact_cache_key="${COMMIT}-${TREE}-${LOCKFILE_DIGEST#sha256:}"');
    expect(wrapper).toContain("branch artifact cache hit:");
    expect(wrapper).toContain("Candidate P1 requires capsule descriptor and archive attestations.");
    expect(wrapper).toContain("fased-predecessor-capsule-branch-proof");
    expect(wrapper).toContain(
      'PARALLEL_SCENARIOS="${FASED_SYSTEMD_FIXTURE_PARALLEL_SCENARIOS:-1}"',
    );
    expect(wrapper).toContain('wait -n -p completed_pid "${fixture_pids[@]}"');
    expect(wrapper).toContain("FASED_LIFECYCLE_FIXTURE_START_LOCK");
    expect(wrapper).toContain('flock "$start_lock_fd"');
    expect(wrapper).toContain('exec {image_cache_lock_fd}>"${archive}.lock"');
    expect(wrapper).toContain("preserved failed fixture support directory:");
    expect(wrapper).toContain("trap 'exit 143' TERM");
    expect(wrapper).toContain(
      "Parallel protected Local proof stopped on the first failed scenario.",
    );
    expect(wrapper).toContain('FIXTURE_SOURCE_COMMIT="$COMMIT"');
    expect(wrapper).not.toContain("merge-base --is-ancestor");
    const hostingWrapper = await readFile(
      resolve(repoRoot, "scripts/test-lifecycle-hosting-acceptance.sh"),
      "utf8",
    );
    expect(hostingWrapper).not.toContain("merge-base --is-ancestor");
    expect(wrapper).toContain('git -C "$ROOT_DIR" archive "$FIXTURE_SOURCE_COMMIT"');
    expect(wrapper).toContain("Branch artifact reuse rejected product changes:");
    const capsuleWrapper = await readFile(
      resolve(repoRoot, "scripts/prepare-branch-predecessor-capsule.sh"),
      "utf8",
    );
    expect(capsuleWrapper).toContain('FIXTURE_COMMIT="$(git -C "$ROOT_DIR" rev-parse HEAD)"');
    expect(capsuleWrapper).toContain("Predecessor capsule reuse rejected product changes:");
    expect(capsuleWrapper).toContain('source "$ROOT_DIR/scripts/lifecycle-fixture-only-paths.sh"');
    expect(capsuleWrapper).toContain("lifecycle_unexpected_fixture_changes");
    expect(capsuleWrapper).not.toContain("merge-base --is-ancestor");
    expect(capsuleWrapper).toContain("$FIXTURE_COMMIT-$FIXTURE_TREE");
    expect(capsuleWrapper).toContain("--pattern fased-lifecycled-linux-amd64");
    expect(capsuleWrapper).toContain(
      '--lifecycle-binary "$source_dir/fased-lifecycled-linux-amd64"',
    );
    expect(wrapper).not.toContain(":/repo:");
  });
});
