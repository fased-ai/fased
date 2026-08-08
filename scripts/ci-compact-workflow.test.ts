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

  it("runs common security and selected CodeQL languages in parallel", async () => {
    const { document } = await workflow("pr.yml");
    const classify = document.jobs?.classify as {
      outputs?: Record<string, string>;
      steps?: Array<{ id?: string; run?: string }>;
    };
    const security = document.jobs?.security as {
      "timeout-minutes"?: number;
      strategy?: { matrix?: { target?: string } };
      steps?: Array<{
        if?: string;
        name?: string;
        run?: string;
        with?: { "config-file"?: string; languages?: string };
      }>;
    };

    expect(classify.outputs?.security_targets_json).toBe(
      "${{ steps.security-matrix.outputs.targets_json }}",
    );
    expect(classify.steps?.find((step) => step.id === "security-matrix")?.run).toContain(
      '["common"] + $languages',
    );
    expect(security["timeout-minutes"]).toBe(20);
    expect(security.strategy?.matrix?.target).toBe(
      "${{ fromJSON(needs.classify.outputs.security_targets_json) }}",
    );
    expect(
      security.steps?.find((step) => step.name === "Initialize selected CodeQL languages")?.with
        ?.languages,
    ).toBe("${{ matrix.target }}");
    const focusedScope = security.steps?.find(
      (step) => step.name === "Build focused JavaScript CodeQL scope",
    );
    expect(focusedScope?.if).toBe("matrix.target == 'javascript-typescript'");
    expect(focusedScope?.run).toContain("git diff --name-only");
    expect(focusedScope?.run).toContain('scope="scripts"');
    expect(
      security.steps?.find((step) => step.name === "Initialize selected CodeQL languages")?.with?.[
        "config-file"
      ],
    ).toContain("codeql-pr-scope.yml");
  });

  it("uses bounded lifecycle regressions instead of the full workspace suite", async () => {
    const { document } = await workflow("pr.yml");
    const classify = document.jobs?.classify as { outputs?: Record<string, string> };
    const selected = document.jobs?.["selected-tests"] as {
      steps?: Array<{ if?: string; name?: string; run?: string }>;
    };
    const full = selected.steps?.find(
      (step) => step.name === "Run full Node tests when explicitly selected",
    );
    const lifecycle = selected.steps?.find(
      (step) => step.name === "Run lifecycle-engine regressions",
    );

    expect(classify.outputs?.run_local_update).toBe("${{ steps.scope.outputs.run_local_update }}");
    expect(full?.if).toContain("run_native_signer == 'true'");
    expect(full?.if).toContain("run_local_update == 'true'");
    expect(lifecycle?.if).toContain("run_node_full == 'true'");
    expect(lifecycle?.if).toContain("run_native_signer == 'true'");
    expect(lifecycle?.if).toContain("run_local_update == 'true'");
    expect(lifecycle?.run).toContain("scripts/generation-updater.test.ts");
    expect(lifecycle?.run).toContain("scripts/fased-managed-updater.test.ts");
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
