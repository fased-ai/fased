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

  it("allows a combined broad-change security scan to finish", async () => {
    const { document } = await workflow("pr.yml");
    const security = document.jobs?.security as { "timeout-minutes"?: number };

    expect(security["timeout-minutes"]).toBe(15);
  });

  it("keeps the broad matrix outside pull requests", async () => {
    const { source } = await workflow("ci.yml");
    expect(source).not.toMatch(/^\s*pull_request:/mu);
    expect(source).toMatch(/^\s*schedule:/mu);
    expect(source).toMatch(/^\s*workflow_dispatch:/mu);
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
      "Audit production dependencies",
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
      (candidate) => candidate.name === "Verify Local release-attestation path",
    );

    expect(classify.outputs?.run_installer_release_verification).toBe(
      "${{ steps.scope.outputs.run_installer_release_verification }}",
    );
    expect(step?.if).toBe("needs.classify.outputs.run_installer_release_verification == 'true'");
    expect(step?.run).toContain("bash -n install.sh");
    expect(step?.run).toContain("scripts/install-release-pin.test.ts");
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
