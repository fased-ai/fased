import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

describe("version-neutral lifecycle acceptance", () => {
  it("requires explicit public predecessor identities and has no private-RC scenario", async () => {
    const wrapper = await readFile(
      resolve(repoRoot, "scripts/test-lifecycle-local-acceptance.sh"),
      "utf8",
    );
    const fixture = await readFile(
      resolve(repoRoot, "scripts/docker/protected-local-systemd/lifecycle-acceptance.sh"),
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
    expect(fixture).toContain(
      '"beta/current/release-index.json": "fased-branch-release-index.json"',
    );
    expect(fixture).toContain('metadata.startsWith("beta/assets/")');
    expect(fixture).toContain('grep -F "fased-lifecycled: ROLLED_BACK:"');
    expect(fixture).not.toContain("target release failed and was rolled back");
  });

  it("binds candidate P1 to an explicit supported public predecessor", async () => {
    const source = await readFile(
      resolve(repoRoot, ".github/workflows/hosted-runtime-release.yml"),
      "utf8",
    );
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
    expect(workflow.on?.workflow_dispatch?.inputs).toHaveProperty("owner_predecessor_version");
    expect(workflow.on?.workflow_dispatch?.inputs).not.toHaveProperty("predecessor_scenario");
    const update = workflow.jobs?.["p1-local-update"]?.steps?.find((candidate) =>
      candidate.name?.includes("supported-stable update P1"),
    );
    const fresh = workflow.jobs?.["p1-local-fresh"]?.steps?.find((candidate) =>
      candidate.name?.includes("fresh Local P1"),
    );
    expect(update?.env).toMatchObject({
      FASED_SYSTEMD_FIXTURE_SCENARIOS: "${{ steps.p1-scenario.outputs.scenarios }}",
      FASED_SYSTEMD_FIXTURE_MANAGED_PREDECESSOR_VERSION: "${{ matrix.predecessor }}",
    });
    expect(workflow.jobs?.["p1-local-update"]?.strategy?.matrix?.predecessor).toBe(
      "${{ fromJSON(needs.preflight.outputs.p1_predecessors) }}",
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
    expect(wrapper).toContain("copy_branch_x64_fixture_aliases()");
    expect(wrapper).toContain('cp --reflink=auto "$signer_source"');
    expect(wrapper).toContain("branch-x64 artifacts are fixture-only and cannot be published");
    expect(wrapper).not.toContain(
      "FASED_SIGNER_TARGETS=linux/amd64,linux/arm64,darwin/amd64,darwin/arm64",
    );
    expect(wrapper).not.toContain("FASED_LIFECYCLE_TARGETS=linux/amd64,linux/arm64");
    expect(wrapper).toContain("clear_branch_fixture_native_outputs()");
    expect(wrapper).toContain("-name 'fased-signerd-*'");
    expect(wrapper).toContain("-name 'fased-lifecycled-*'");
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
    expect(wrapper).toContain(
      "Parallel protected Local proof stopped on the first failed scenario.",
    );
    expect(wrapper).toContain('FIXTURE_SOURCE_COMMIT="$COMMIT"');
    expect(wrapper).toContain('git -C "$ROOT_DIR" merge-base --is-ancestor "$COMMIT" HEAD');
    expect(wrapper).toContain('git -C "$ROOT_DIR" archive "$FIXTURE_SOURCE_COMMIT"');
    expect(wrapper).toContain("Branch artifact reuse rejected product changes:");
    const capsuleWrapper = await readFile(
      resolve(repoRoot, "scripts/prepare-branch-predecessor-capsule.sh"),
      "utf8",
    );
    expect(capsuleWrapper).toContain('FIXTURE_COMMIT="$(git -C "$ROOT_DIR" rev-parse HEAD)"');
    expect(capsuleWrapper).toContain("Predecessor capsule reuse rejected product changes:");
    expect(capsuleWrapper).toContain("$FIXTURE_COMMIT-$FIXTURE_TREE");
    expect(wrapper).not.toContain(":/repo:");
  });
});
