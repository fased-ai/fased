import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

type WorkflowJob = {
  if?: string;
  needs?: string[];
  steps?: Array<{
    env?: Record<string, string>;
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
    expect(jobs["hosting-lifecycle"]).toBeDefined();
    expect(jobs["protected-local-update-lifecycle"]).toBeDefined();

    const protectedLocalUpdate = jobs["protected-local-update-lifecycle"];
    expect(protectedLocalUpdate?.needs).toEqual(
      expect.arrayContaining(["change-scope", "hosting-lifecycle"]),
    );
    expect(protectedLocalUpdate?.if).toBe("needs.change-scope.outputs.run_hosting == 'true'");
    expect(
      protectedLocalUpdate?.steps?.find((step) => step.uses === "actions/checkout@v6")?.with?.[
        "fetch-depth"
      ],
    ).toBe(0);
    expect(
      protectedLocalUpdate?.steps?.find(
        (step) => step.env?.FASED_SYSTEMD_FIXTURE_SCENARIOS === "install",
      )?.run,
    ).toBe("bash scripts/test-protected-local-systemd-container.sh");

    const required = jobs["required-checks"];
    expect(required?.needs).toEqual(
      expect.arrayContaining([
        "change-scope",
        "version-identity",
        "hosting-lifecycle",
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
      RUN_UI_MINING: "${{ needs.change-scope.outputs.run_ui_mining }}",
      PROTECTED_LOCAL_UPDATE: "${{ needs.protected-local-update-lifecycle.result }}",
    });
  });

  it("keeps expensive compatibility lanes opt-in or path-scoped", async () => {
    const workflow = await readWorkflow(".github/workflows/ci.yml");
    const jobs = workflow.jobs ?? {};

    expect(jobs["checks-windows"]?.if).toBe("needs.change-scope.outputs.full_matrix == 'true'");
    expect(jobs["ui"]?.if).toBe("needs.change-scope.outputs.full_matrix == 'true'");
    expect(jobs["macos"]?.if).toBe("needs.change-scope.outputs.run_macos == 'true'");
    expect(jobs["ui-mining"]?.if).toBe("needs.change-scope.outputs.run_ui_mining == 'true'");
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
