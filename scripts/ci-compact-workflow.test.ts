import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

async function workflow(name: string) {
  const source = await readFile(resolve(repoRoot, `.github/workflows/${name}`), "utf8");
  return { source, document: parse(source) as { jobs?: Record<string, unknown> } };
}

describe("compact CI topology", () => {
  it("exposes exactly four ordinary PR jobs", async () => {
    const { document } = await workflow("pr.yml");
    expect(Object.keys(document.jobs ?? {})).toEqual([
      "classify",
      "selected-tests",
      "security",
      "checks",
    ]);
  });

  it("keeps PR security cheap and moves CodeQL out of the PR", async () => {
    const { document } = await workflow("pr.yml");
    const security = document.jobs?.security as {
      "timeout-minutes"?: number;
      steps?: Array<{
        name?: string;
        run?: string;
        uses?: string;
      }>;
    };

    expect(security["timeout-minutes"]).toBe(5);
    expect(security.steps?.map((step) => step.name)).toEqual(
      expect.arrayContaining(["Detect secrets and private keys", "Audit changed workflows"]),
    );
    expect(security.steps?.some((step) => step.uses?.startsWith("github/codeql-action/"))).toBe(
      false,
    );
  });

  it("uses bounded lifecycle regressions instead of the full workspace suite", async () => {
    const { document } = await workflow("pr.yml");
    const selected = document.jobs?.["selected-tests"] as {
      "timeout-minutes"?: number;
      steps?: Array<{ if?: string; name?: string; run?: string }>;
    };
    expect(selected["timeout-minutes"]).toBe(10);
    expect(selected.steps?.some((step) => step.name?.includes("full Node"))).toBe(false);
    expect(selected.steps?.some((step) => step.name?.includes("Build once"))).toBe(false);
    expect(selected.steps?.some((step) => step.name?.includes("package"))).toBe(false);
  });

  it("keeps the broad matrix outside pull requests", async () => {
    const { source } = await workflow("ci.yml");
    expect(source).not.toMatch(/^\s*pull_request:/mu);
    expect(source).toMatch(/^\s*schedule:/mu);
    expect(source).toMatch(/^\s*workflow_dispatch:/mu);
  });

  it("reuses exact protected PR evidence on main without rebuilding", async () => {
    const { document } = await workflow("main.yml");
    const jobs = document.jobs ?? {};
    expect(Object.keys(jobs)).toEqual(["checks"]);
    const checks = jobs.checks as {
      "timeout-minutes"?: number;
      steps?: Array<{ name?: string; run?: string }>;
    };
    expect(checks["timeout-minutes"]).toBe(3);
    expect(
      checks.steps?.find((step) => step.name === "Verify exact protected PR evidence")?.run,
    ).toBe("node scripts/ci-merged-main-reuse.mjs");
  });

  it("runs verified dependency remediation without the full Node suite", async () => {
    const { document } = await workflow("pr.yml");
    const classify = document.jobs?.classify as {
      outputs?: Record<string, string>;
    };
    const selected = document.jobs?.["selected-tests"] as {
      steps?: Array<{ if?: string; name?: string; run?: string }>;
    };
    const steps = selected.steps ?? [];
    const dependencySteps = steps.filter((step) => step.if?.includes("dependency_remediation"));

    expect(classify.outputs).toMatchObject({
      dependency_remediation: "${{ steps.scope.outputs.dependency_remediation }}",
      dependency_names_json: "${{ steps.scope.outputs.dependency_names_json }}",
    });
    expect(dependencySteps.map((step) => step.name)).toEqual([
      "Prove exact dependency remediation",
      "Audit complete dependency graph",
      "Verify frozen lockfile integrity",
      "Verify affected dependency paths and tests",
    ]);
    expect(dependencySteps.map((step) => step.run).join("\n")).toContain("pnpm why");
    expect(dependencySteps.map((step) => step.run).join("\n")).toContain("vitest run");
  });

  it("runs exact installer attestation verification without broad product lanes", async () => {
    const { document } = await workflow("pr.yml");
    const classify = document.jobs?.classify as { outputs?: Record<string, string> };
    const selected = document.jobs?.["selected-tests"] as {
      steps?: Array<{ if?: string; name?: string; run?: string }>;
    };
    const step = selected.steps?.find(
      (candidate) => candidate.name === "Verify release-attestation path",
    );

    expect(classify.outputs?.run_installer_release_verification).toBe(
      "${{ steps.scope.outputs.run_installer_release_verification }}",
    );
    expect(step?.if).toBe("needs.classify.outputs.run_installer_release_verification == 'true'");
    expect(step?.run).toContain("bash -n install.sh");
    expect(step?.run).toContain("scripts/install-release-pin.test.ts");
    expect(step?.run).toContain("scripts/generation-updater.test.ts");
    expect(step?.run).toContain("scripts/release-artifact-set.test.ts");
    expect(step?.run).toContain("scripts/hosted-security-boundary.test.ts");
  });

  it("does not install the workspace for an exact version-only PR", async () => {
    const { document } = await workflow("pr.yml");
    const selected = document.jobs?.["selected-tests"] as {
      steps?: Array<{ if?: string; name?: string; uses?: string }>;
    };
    const steps = selected.steps ?? [];

    expect(steps.find((step) => step.name === "Setup Node environment")?.if).toBe(
      "needs.classify.outputs.version_only != 'true'",
    );
    expect(
      steps.find((step) => step.name === "Setup Node.js for exact version-only validation")?.if,
    ).toBe("needs.classify.outputs.version_only == 'true'");
    expect(steps.find((step) => step.name === "Check documentation")?.if).toContain(
      "version_only != 'true'",
    );
  });
});
