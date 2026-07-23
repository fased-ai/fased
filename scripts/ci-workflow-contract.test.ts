import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

type WorkflowJob = {
  if?: string;
  needs?: string[];
  steps?: Array<{ env?: Record<string, string>; run?: string }>;
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

    const required = jobs["required-checks"];
    expect(required?.needs).toEqual(
      expect.arrayContaining([
        "change-scope",
        "version-identity",
        "hosting-lifecycle",
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
});
