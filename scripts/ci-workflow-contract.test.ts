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

  it("keeps pre-candidate metadata-only and binds real Hosting staging", async () => {
    const value = await workflow(".github/workflows/pre-candidate.yml");
    const source = await text(".github/workflows/pre-candidate.yml");
    const dispatch = value.on?.workflow_dispatch as { inputs?: Record<string, unknown> };
    expect(dispatch.inputs).toHaveProperty("hosting_staging_receipt_sha256");
    expect(dispatch.inputs).toHaveProperty("hosting_staging_receipt_json");
    expect(dispatch.inputs).not.toHaveProperty("local0_receipt_sha256");
    expect(source).toContain("hostingStagingReceiptDigest=");
    expect(source).toContain("validateHostingStagingReadiness");
    expect(source).toContain('sha256sum "$staging_receipt"');
    expect(source).toContain(".artifacts/pre-candidate/hosting-staging-receipt.json");
    expect(source).not.toContain("local0ReceiptDigest=");
    expect(source).not.toContain("pnpm install --frozen-lockfile");
    expect(source).not.toContain("pnpm build");
  });

  it("builds one Linux-x64 artifact in pre-tag without fixture execution", async () => {
    const value = await workflow(".github/workflows/pre-tag-p1.yml");
    const source = await text(".github/workflows/pre-tag-p1.yml");
    expect(Object.keys(value.jobs ?? {}).toSorted()).toEqual([
      "candidate",
      "evidence",
      "preflight",
    ]);
    expect(value.jobs?.candidate?.["timeout-minutes"]).toBe(20);
    expect(source).toContain("scripts/build-linux-x64-release-artifact.sh");
    expect(source).toContain('.profile == "linux-x64" and .publishable == false');
    expect(source).toContain("scripts/finalize-pretag-candidate.sh");
    expect(source).toContain("product.sha256");
    expect(source).toContain('staging_receipt="$evidence_dir/hosting-staging-receipt.json"');
    expect(source).not.toContain("test-lifecycle-local-acceptance.sh");
    expect(source).not.toContain("test-lifecycle-hosting-acceptance.sh");
    expect(source).not.toContain("prepare-candidate-fixture-trust.sh");
  });

  it("attests and publishes pre-tag product bytes without rebuilding or reinstalling", async () => {
    const value = await workflow(".github/workflows/hosted-runtime-release.yml");
    const source = await text(".github/workflows/hosted-runtime-release.yml");
    const finalizeText = jobText(value.jobs?.["finalize-candidate"]);
    const publishText = jobText(value.jobs?.publish);
    const stage = value.jobs?.["finalize-candidate"]?.steps?.find(
      (step) => step.name === "Verify and stage only the pre-tag product bytes",
    );
    const identity = value.jobs?.preflight?.steps?.find(
      (step) => step.name === "Verify exact immutable tagged candidate identity",
    );
    const bind = value.jobs?.["finalize-candidate"]?.steps?.find(
      (step) => step.name === "Bind and verify the final candidate artifact set",
    );
    const descriptor = value.jobs?.["finalize-candidate"]?.steps?.find(
      (step) => step.name === "Stage and verify the final candidate descriptor",
    );
    const publishIdentity = value.jobs?.publish?.steps?.find(
      (step) => step.name === "Verify exact candidate identity",
    );
    const publishTag = value.jobs?.publish?.steps?.find(
      (step) => step.name === "Reverify immutable candidate tag before publication",
    );
    const channelWitness = value.jobs?.["refresh-root-head"]?.steps?.find(
      (step) => step.name === "Prepare current channel root-head statement",
    );
    expect(stage?.env?.PRE_TAG_P1_RUN_ID).toBe("${{ inputs.pre_tag_p1_run_id }}");
    expect(stage?.run).toContain('--workflow-run-id "$PRE_TAG_P1_RUN_ID"');
    expect(identity?.run).toContain('test "$GITHUB_REF" = "refs/heads/main"');
    expect(identity?.run).toContain('git merge-base --is-ancestor "$SOURCE_COMMIT" "$remote_main"');
    expect(identity?.run).toContain(".github/workflows/hosted-runtime-release.yml");
    expect(identity?.run).toContain("scripts/ci-workflow-contract.test.ts");
    expect(identity?.run).not.toContain('test "$GITHUB_REF" = "refs/tags/v$RELEASE_VERSION"');
    expect(finalizeText).toContain("product.sha256");
    expect(source).toContain('staging_receipt="$evidence_dir/hosting-staging-receipt.json"');
    expect(finalizeText).toContain("release-artifact-set.mjs verify");
    expect(bind?.run).toContain('product_source_ref="refs/tags/v$RELEASE_VERSION"');
    expect(bind?.run).toContain('--source-ref "$product_source_ref"');
    expect(bind?.run).toContain('--source-ref "$GITHUB_REF"');
    expect(bind?.run).toContain('--source-digest "$GITHUB_SHA"');
    expect(descriptor?.run).toContain('--source-ref "$GITHUB_REF"');
    expect(descriptor?.run).toContain('--source-digest "$GITHUB_SHA"');
    expect(descriptor?.run).toContain('--source-ref "refs/tags/v$RELEASE_VERSION"');
    expect(finalizeText).toContain('--source-digest \\"$GITHUB_SHA\\"');
    expect(finalizeText).not.toContain('--source-digest \\"$SOURCE_COMMIT\\"');
    expect(publishIdentity?.run).toContain('--source-ref "refs/tags/v$RELEASE_VERSION"');
    expect(publishIdentity?.run).toContain('--source-ref "$GITHUB_REF"');
    expect(publishIdentity?.run).toContain('--source-digest "$GITHUB_SHA"');
    expect(publishTag?.env?.SOURCE_COMMIT).toBe("${{ inputs.source_commit }}");
    expect(publishTag?.run).toContain('test "$remote_tag_commit" = "$SOURCE_COMMIT"');
    expect(publishTag?.run).not.toContain('test "$remote_tag_commit" = "$GITHUB_SHA"');
    expect(channelWitness?.run).toContain('--source-ref "$GITHUB_REF"');
    expect(channelWitness?.run).toContain('--source-digest "$GITHUB_SHA"');
    expect(finalizeText).not.toContain("pnpm install");
    expect(finalizeText).not.toContain("pnpm build");
    expect(finalizeText).not.toContain("go build");
    expect(finalizeText).not.toContain("finalize-pretag-candidate.sh");
    expect(publishText).not.toContain("pnpm install");
    expect(publishText).not.toContain("pnpm build");
    expect(publishText).not.toContain("go build");
    expect(publishText).toContain("gh release create");
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
