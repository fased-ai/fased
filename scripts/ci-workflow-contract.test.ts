import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

type WorkflowStep = {
  env?: Record<string, string>;
  name?: string;
  run?: string;
};

type WorkflowJob = {
  steps?: WorkflowStep[];
  "timeout-minutes"?: number;
};

type Workflow = {
  name?: string;
  on?: Record<string, unknown>;
  jobs?: Record<string, WorkflowJob>;
};

async function workflow(path: string): Promise<Workflow> {
  return parse(await readFile(resolve(repoRoot, path), "utf8")) as Workflow;
}

async function text(path: string): Promise<string> {
  return readFile(resolve(repoRoot, path), "utf8");
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(resolve(repoRoot, path));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function jobText(job: WorkflowJob | undefined): string {
  return JSON.stringify(job ?? {});
}

describe("lean CI and release workflow contracts", () => {
  it("keeps pull requests on one compact changed-surface gate", async () => {
    const value = await workflow(".github/workflows/pr.yml");
    expect(Object.keys(value.jobs ?? {}).toSorted()).toEqual([
      "checks",
      "classify",
      "docker-owned",
      "macos-owned",
      "security",
      "selected-tests",
    ]);
    expect(value.jobs?.["selected-tests"]?.["timeout-minutes"]).toBe(10);
    expect(value.jobs?.security?.["timeout-minutes"]).toBe(5);
    const source = await text(".github/workflows/pr.yml");
    expect(source).toContain("ci-run-changed-tests.mjs");
    expect(source).not.toContain("build-linux-x64-release-artifact.sh");
    expect(source).not.toContain("run-lifecycle-local0.sh");
    expect(source).not.toContain("test-lifecycle-hosting-acceptance.sh");
    expect(source).not.toContain("codeql-action");
    expect(value.jobs?.["docker-owned"]?.["timeout-minutes"]).toBe(12);
    expect(value.jobs?.["macos-owned"]?.["timeout-minutes"]).toBe(20);
    expect(jobText(value.jobs?.["docker-owned"])).toContain(
      "needs.classify.outputs.run_docker == 'true'",
    );
    expect(jobText(value.jobs?.["macos-owned"])).toContain(
      "needs.classify.outputs.run_macos_runtime == 'true'",
    );
  });

  it("runs broad diagnostics weekly or manually, never as a protected PR gate", async () => {
    const value = await workflow(".github/workflows/ci.yml");
    expect(value.name).toBe("Weekly Diagnostics");
    expect(value.on).toHaveProperty("schedule");
    expect(value.on).toHaveProperty("workflow_dispatch");
    expect(value.on).not.toHaveProperty("pull_request");
    expect(value.on).not.toHaveProperty("push");
    const source = await text(".github/workflows/ci.yml");
    expect(source).toContain('cron: "19 7 * * 0"');
    expect(source).toContain(
      "FULL_MATRIX: ${{ github.event_name == 'schedule' || inputs.full_matrix == true }}",
    );
    expect(source).toContain("codeql-javascript:");
    expect(source).toContain("docker-amd64:");
    expect(source).toContain("macos-runtime:");
    expect(source).not.toContain("run_local_fresh");
    expect(source).not.toContain("run_local_update");
    expect(source).not.toContain("run_platform_bootstrap");
  });

  it("uses the standalone Linux-x64 builder for the optional archive diagnostic", async () => {
    const value = await workflow(".github/workflows/ci.yml");
    const source = await text(".github/workflows/ci.yml");
    const proof = value.jobs?.["archive-branch-proof"];
    const build = proof?.steps?.find(
      (step) => step.name === "Build exact candidate generation archive once",
    );
    expect(proof?.["timeout-minutes"]).toBe(30);
    expect(build?.run).toContain("scripts/build-linux-x64-release-artifact.sh");
    expect(build?.run).not.toContain("test-lifecycle-local-acceptance.sh");
    expect(source).toContain('--workflow-run-id "$GITHUB_RUN_ID"');
    expect(source).not.toContain("38085632");
    expect(jobText(proof)).not.toContain("runtime_builder_changed");
    expect(jobText(proof)).not.toContain("native_helper_changed");
  });

  it("removes the pre-candidate, P1, and reusable-gate workflow chain", async () => {
    for (const removed of [
      ".github/workflows/pre-candidate.yml",
      ".github/workflows/pre-tag-p1.yml",
      ".github/workflows/release-gate-verify.yml",
    ]) {
      expect(await exists(removed), removed).toBe(false);
    }
  });

  it("uses a metadata-only idempotent public promotion retry", async () => {
    const value = await workflow(".github/workflows/hosted-runtime-promote.yml");
    const source = await text(".github/workflows/hosted-runtime-promote.yml");
    expect(Object.keys(value.jobs ?? {})).toEqual(["promote"]);
    expect(value.jobs?.promote?.["timeout-minutes"]).toBe(5);
    expect(source).toContain("Read and verify immutable public release metadata");
    expect(source).toContain("release-attestation-identity.mjs resolve");
    expect(source).toContain("Advance or confirm the signed channel");
    expect(source).toContain("fased-public-channel-promotion");
    expect(source).not.toContain("build-linux-x64-release-artifact.sh");
    expect(source).not.toContain("finalize-pretag-candidate.sh");
    expect(source).not.toContain("actions/attest");
    expect(source).not.toContain("actions/download-artifact");
    expect(source).not.toContain("setup-node-env");
    expect(source).not.toContain("setup-go");
  });

  it("builds, attests, and publishes once from the owner tag", async () => {
    const value = await workflow(".github/workflows/hosted-runtime-release.yml");
    const source = await text(".github/workflows/hosted-runtime-release.yml");
    const artifactBuilder = await text("scripts/build-linux-x64-release-artifact.sh");
    const channelScript = await text("scripts/publish-lifecycle-channel.sh");
    expect(Object.keys(value.jobs ?? {})).toEqual(["release"]);
    expect(value.jobs?.release?.["timeout-minutes"]).toBe(25);
    expect(value.jobs?.release?.environment).toBeUndefined();
    expect(source).toContain("attestations: write");
    const releaseText = jobText(value.jobs?.release);
    expect(source).toContain("Resolve exact next signed channel identity");
    expect(source).toContain("ci-version-identity.mjs --inventory-only");
    expect(source).toContain("verify-next-release-sequence.mjs");
    expect(source).toContain("run Hosted Runtime Promote instead");
    expect(source).toContain("scripts/build-linux-x64-release-artifact.sh");
    expect(source).toContain("scripts/finalize-pretag-candidate.sh");
    expect(source.match(/actions\/attest@/gu)?.length).toBe(11);
    expect(source).toContain("Verify every official attestation is tag-bound");
    expect(source).toContain("Verify staged set with production bootstrap trust policy");
    expect(source).not.toContain("prepare_run_id");
    expect(source).not.toContain("inputs.phase");
    expect(source).not.toContain("actions/download-artifact");
    expect(source).not.toContain("build-linux-arm64-release-supplement.sh");
    expect(source).not.toContain("build-darwin-release-supplement.sh");
    expect(source).toContain("Verify candidate and owner-created immutable tag");
    expect(source).toContain(
      "Owner-created annotated tag $tag is required before release publication.",
    );
    expect(source).toContain('"refs/tags/$tag^{}"');
    expect(source).not.toContain('git tag -a "$tag"');
    expect(source).not.toContain('git push origin "refs/tags/$tag"');
    expect(source).toContain("gh release create");
    expect(source).toContain("publish-lifecycle-channel.sh");
    expect(source).toContain("release-phase-timings.mjs");
    expect(source).toContain("phaseTimings:$timings[0].phases");
    expect(source).toContain('schemaVersion:2,role:"fased-candidate-publication"');
    for (const phase of ["attestation", "upload", "channelAdvancement"]) {
      expect(source).toContain(phase);
    }
    for (const phase of ["nodeBuild", "goBuild", "packaging"]) {
      expect(artifactBuilder).toContain(`record_phase start ${phase}`);
      expect(artifactBuilder).toContain(`record_phase finish ${phase}`);
    }
    expect(source).not.toContain("pre_candidate_run_id");
    expect(source).not.toContain("pre_tag_p1_run_id");
    expect(source).not.toContain("release-gate-verify.yml");
    expect(source).not.toContain("test-lifecycle-local-acceptance.sh");
    expect(source).not.toContain("test-lifecycle-hosting-acceptance.sh");
    expect(releaseText.match(/build-linux-x64-release-artifact\.sh/gu)?.length).toBe(1);
    expect(releaseText.match(/actions\/attest@/gu)?.length).toBe(11);
    expect(channelScript).toContain('--source-ref "$attestation_source_ref"');
    expect(channelScript).toContain('--source-digest "$attestation_source_digest"');
    expect(channelScript).toContain("verify_historical_index_attestation");
    expect(channelScript).toContain('if cmp -s "$index" "$current_index"; then');
  });

  it("reuses the setup-go build cache during exact Linux assembly", async () => {
    const builder = await text("scripts/build-linux-x64-release-artifact.sh");
    expect(builder).toContain('go_cache="${GOCACHE:-}"');
    expect(builder).toContain('go_cache="$("$GO_BIN" env GOCACHE)"');
    expect(builder).not.toContain("fased-release-go-cache");
  });

  it("removes replay workflows and simulated Local acceptance", async () => {
    for (const removed of [
      ".github/workflows/candidate-p1-replay.yml",
      ".github/workflows/candidate-publication-replay.yml",
      "scripts/run-lifecycle-local0.sh",
      "scripts/test-lifecycle-local-acceptance.sh",
      "scripts/docker/protected-local-systemd/lifecycle-acceptance.sh",
      "scripts/prepare-candidate-fixture-trust.sh",
    ]) {
      expect(await exists(removed), removed).toBe(false);
    }
  });

  it("keeps merged-main verification as evidence reuse", async () => {
    const value = await workflow(".github/workflows/main.yml");
    expect(Object.keys(value.jobs ?? {})).toEqual(["checks"]);
    expect(value.jobs?.checks?.["timeout-minutes"]).toBe(3);
    const source = await text(".github/workflows/main.yml");
    expect(source).toContain("ci-merged-main-reuse.mjs");
    expect(source).not.toContain("pnpm install");
    expect(source).not.toContain("go test");
  });
});
