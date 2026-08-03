import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

type WorkflowJob = {
  if?: string;
  needs?: string[];
  "timeout-minutes"?: number;
  steps?: Array<{
    env?: Record<string, string>;
    name?: string;
    run?: string;
    uses?: string;
    with?: Record<string, boolean | number | string>;
  }>;
};

type Workflow = {
  jobs?: Record<string, WorkflowJob>;
};

async function readWorkflow(path: string): Promise<Workflow> {
  return parse(await readFile(resolve(repoRoot, path), "utf8")) as Workflow;
}

describe("CI workflow routing", () => {
  it("uses one change-scope authority and one required aggregate", async () => {
    const workflow = await readWorkflow(".github/workflows/ci.yml");
    const jobs = workflow.jobs ?? {};

    expect(jobs["change-scope"]).toBeDefined();
    expect(jobs["docs-scope"]).toBeUndefined();
    expect(jobs["changed-scope"]).toBeUndefined();
    expect(jobs["android"]).toBeUndefined();
    expect(jobs["version-identity"]).toBeDefined();
    expect(jobs["ci-contracts"]).toBeDefined();
    expect(jobs["t2-contracts"]).toBeDefined();
    expect(jobs["hosting-lifecycle"]).toBeDefined();
    expect(jobs["protected-local-fixture-artifact"]).toBeDefined();
    expect(jobs["protected-local-rocky-lifecycle"]).toBeDefined();
    expect(jobs["protected-local-update-lifecycle"]).toBeDefined();

    const releaseCheck = jobs["release-check"];
    expect(
      releaseCheck?.steps?.find((step) => step.uses === "actions/checkout@v6")?.with?.[
        "fetch-depth"
      ],
    ).toBe(0);

    const protectedLocalUpdate = jobs["protected-local-update-lifecycle"];
    expect(protectedLocalUpdate?.needs).toEqual(
      expect.arrayContaining(["change-scope", "protected-local-fixture-artifact"]),
    );
    expect(protectedLocalUpdate?.if).toBe("needs.change-scope.outputs.run_local_update == 'true'");
    expect(protectedLocalUpdate?.["timeout-minutes"]).toBe(15);
    expect(
      protectedLocalUpdate?.steps?.find((step) => step.uses === "actions/checkout@v6")?.with?.[
        "fetch-depth"
      ],
    ).toBe(0);
    const localRecoveryT1 = protectedLocalUpdate?.steps?.find((step) =>
      String(step.run ?? "").includes("scripts/fased-local-recovery-pending.test.ts"),
    );
    const localSystemdFixture = protectedLocalUpdate?.steps?.find(
      (step) => step.env?.FASED_SYSTEMD_FIXTURE_SCENARIOS === "install",
    );
    expect(
      protectedLocalUpdate?.steps?.find((step) => step.uses === "./.github/actions/setup-node-env")
        ?.with?.["install-bun"],
    ).toBe("false");
    expect(localRecoveryT1?.run).toContain("pnpm exec vitest run");
    expect(localRecoveryT1?.run).toContain("--pool=forks");
    expect(localRecoveryT1?.run).toContain("--maxWorkers=1");
    expect(protectedLocalUpdate?.steps?.indexOf(localRecoveryT1)).toBeLessThan(
      protectedLocalUpdate?.steps?.indexOf(localSystemdFixture),
    );
    expect(localSystemdFixture?.run).toBe("bash scripts/test-protected-local-systemd-container.sh");

    const required = jobs["required-checks"];
    expect(required?.needs).toEqual(
      expect.arrayContaining([
        "change-scope",
        "ci-contracts",
        "t2-contracts",
        "version-identity",
        "hosting-lifecycle",
        "protected-local-fixture-artifact",
        "protected-local-rocky-lifecycle",
        "protected-local-update-lifecycle",
        "ui-mining",
        "checks-windows",
        "macos",
        "secrets",
      ]),
    );
    expect(required?.steps?.at(-1)?.run).toBe("node scripts/ci-required-gates.mjs");
    expect(required?.steps?.at(-1)?.env).toMatchObject({
      VERSION_ONLY: "${{ needs.change-scope.outputs.version_only }}",
      RUN_HOSTING: "${{ needs.change-scope.outputs.run_hosting }}",
      RUN_LOCAL_FRESH: "${{ needs.change-scope.outputs.run_local_fresh }}",
      RUN_LOCAL_UPDATE: "${{ needs.change-scope.outputs.run_local_update }}",
      RUN_CI_CONTRACTS: "${{ needs.change-scope.outputs.run_ci_contracts }}",
      RUN_T2_CONTRACTS: "${{ needs.change-scope.outputs.run_t2_contracts }}",
      RUN_UI_MINING: "${{ needs.change-scope.outputs.run_ui_mining }}",
      PROTECTED_LOCAL_ARTIFACT: "${{ needs.protected-local-fixture-artifact.result }}",
      PROTECTED_LOCAL_ROCKY: "${{ needs.protected-local-rocky-lifecycle.result }}",
      PROTECTED_LOCAL_UPDATE: "${{ needs.protected-local-update-lifecycle.result }}",
      T2_CONTRACTS: "${{ needs.t2-contracts.result }}",
    });
  });

  it("keeps expensive compatibility lanes opt-in or path-scoped", async () => {
    const workflow = await readWorkflow(".github/workflows/ci.yml");
    const jobs = workflow.jobs ?? {};

    expect(jobs["checks-windows"]?.if).toBe("needs.change-scope.outputs.full_matrix == 'true'");
    expect(jobs["ui"]?.if).toBe("needs.change-scope.outputs.full_matrix == 'true'");
    expect(jobs["macos"]?.if).toBe("needs.change-scope.outputs.run_macos == 'true'");
    expect(jobs["ui-mining"]?.if).toBe("needs.change-scope.outputs.run_ui_mining == 'true'");

    expect(jobs["hosting-lifecycle"]?.if).toBe("needs.change-scope.outputs.run_hosting == 'true'");
    expect(jobs["protected-local-lifecycle"]?.if).toBe(
      "needs.change-scope.outputs.run_local_fresh == 'true'",
    );
    expect(jobs["protected-local-rocky-lifecycle"]?.if).toContain(
      "needs.change-scope.outputs.full_matrix == 'true'",
    );
    expect(jobs["ci-contracts"]?.if).toBe("needs.change-scope.outputs.run_ci_contracts == 'true'");
    expect(jobs["t2-contracts"]?.if).toBe("needs.change-scope.outputs.run_t2_contracts == 'true'");

    const t2Commands = jobs["t2-contracts"]?.steps?.map((step) => step.run).filter(Boolean) ?? [];
    expect(t2Commands).toEqual(
      expect.arrayContaining([
        expect.stringContaining("pnpm exec oxfmt --check"),
        expect.stringContaining("scripts/protected-local-service-plan.test.ts"),
      ]),
    );
    expect(t2Commands.join("\n")).toContain("scripts/protected-local-t2-systemd.test.ts");
    expect(jobs["t2-contracts"]?.["timeout-minutes"]).toBe(5);

    for (const jobName of [
      "ci-contracts",
      "t2-contracts",
      "hosting-lifecycle",
      "protected-local-fixture-artifact",
      "protected-local-lifecycle",
      "protected-local-rocky-lifecycle",
      "protected-local-update-lifecycle",
    ]) {
      expect(jobs[jobName]?.["timeout-minutes"], jobName).toBeGreaterThan(0);
      expect(jobs[jobName]?.["timeout-minutes"], jobName).toBeLessThanOrEqual(15);
    }
  });

  it("keeps lifecycle fixtures out of the product Docker release workflow", async () => {
    const dockerWorkflow = await readFile(
      resolve(repoRoot, ".github/workflows/docker-release.yml"),
      "utf8",
    );

    expect(dockerWorkflow).not.toContain("scripts/docker/protected-local-systemd/**");
    expect(dockerWorkflow).not.toContain("scripts/docker/hosting-systemd/**");
    expect(dockerWorkflow).not.toContain("scripts/docker/streamed-hosting-bootstrap/**");
  });

  it("builds a non-publishing tag candidate and promotes only its exact verified bytes", async () => {
    const workflow = await readWorkflow(".github/workflows/hosted-runtime-release.yml");
    const jobs = workflow.jobs ?? {};
    const candidate = jobs["candidate"];
    const publish = jobs["publish"];

    expect(jobs["release-gate"]?.if).toBe("startsWith(github.ref, 'refs/tags/v')");
    expect(candidate?.if).toBe("startsWith(github.ref, 'refs/tags/v')");
    expect(candidate?.needs).toEqual(["validate", "linux", "signer"]);
    expect(publish?.if).toBe("github.event_name == 'workflow_dispatch'");

    const candidateText = candidate?.steps?.map((step) => step.run ?? "").join("\n") ?? "";
    const publishText = publish?.steps?.map((step) => step.run ?? "").join("\n") ?? "";
    expect(candidateText).toContain("release-artifact-set.mjs build");
    expect(candidateText).not.toContain("gh release create");
    expect(
      candidate?.steps?.find((step) => step.uses === "actions/upload-artifact@v4")?.with?.name,
    ).toBe("fased-hosting-candidate");

    const download = publish?.steps?.find((step) => step.uses === "actions/download-artifact@v4");
    expect(download?.with).toMatchObject({
      name: "fased-hosting-candidate",
      "run-id": "${{ inputs.candidate_run_id }}",
    });
    expect(publishText).toContain("--artifact-set-digest");
    expect(publishText).toContain("release-artifact-set.mjs verify-assets");
    expect(publishText).toContain('gh release create "$RELEASE_TAG"');
    expect(publishText).toContain("--draft");
    expect(publishText).toContain("select(.tag_name == env.RELEASE_TAG and .draft == true)");
    expect(publishText).toContain('"repos/$GITHUB_REPOSITORY/releases/$release_id"');
    expect(publishText).toContain("gh api --method DELETE");
    expect(publishText).toContain("existing_release_id");
    expect(publishText).not.toContain("gh release view");
    expect(publishText).not.toContain("releases/tags/$RELEASE_TAG");
    expect(publish?.steps?.some((step) => step.uses === "actions/attest@v4")).toBe(false);
    expect(publishText).not.toContain("hosted:artifact:build");
    expect(publishText).not.toContain("release-fased-signerd.sh");
  });

  it("selects beta for every prerelease target in the Protected Local fixture", async () => {
    const fixture = await readFile(
      resolve(repoRoot, "scripts/docker/protected-local-systemd/run.sh"),
      "utf8",
    );

    expect(fixture).toContain('if [[ "$version" == *-* ]]');
    expect(fixture).toContain("target_update_args=(--channel beta)");
    expect(fixture.match(/update "\$\{target_update_args\[@\]\}" --timeout/gu)).toHaveLength(3);
    expect(fixture).not.toContain("/etc/fased/testing");
    expect(fixture).toContain("/var/lib/fased-protected-local-fixture");
  });

  it("keeps stale-session update resolution bound to the exact fixture candidate", async () => {
    const fixture = await readFile(
      resolve(repoRoot, "scripts/docker/protected-local-systemd/run.sh"),
      "utf8",
    );
    const helperStart = fixture.indexOf("run_as_stale_operator() {");
    const helperEnd = fixture.indexOf("\n}", helperStart);
    expect(helperStart).toBeGreaterThanOrEqual(0);
    expect(helperEnd).toBeGreaterThan(helperStart);
    expect(fixture.slice(helperStart, helperEnd)).toContain(
      'npm_config_registry="http://127.0.0.1:$rpc_port"',
    );
  });
});
