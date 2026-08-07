import { readFile, readdir } from "node:fs/promises";
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
    if?: string;
    id?: string;
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

async function readFocusedLocalUpdateProductionPaths(): Promise<string[]> {
  const source = await readFile(resolve(repoRoot, "scripts/gate-authority.mjs"), "utf8");
  const allowlist = source.match(
    /const LOCAL_UPDATE_FOCUSED_PRODUCTION_PATHS = new Set\(\[([\s\S]*?)\]\);/u,
  );
  expect(allowlist, "focused Local-update allowlist is missing").not.toBeNull();
  return [...(allowlist?.[1] ?? "").matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
}

async function listFiles(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const child = resolve(path, entry.name);
      return entry.isDirectory() ? listFiles(child) : [child];
    }),
  );
  return files.flat();
}

function usesAction(step: { uses?: string }, action: string): boolean {
  return step.uses?.startsWith(`${action}@`) === true;
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
    expect(jobs["node-focused"]).toBeDefined();
    expect(jobs["hosting-lifecycle"]).toBeDefined();
    expect(jobs["protected-local-fixture-artifact"]).toBeDefined();
    expect(jobs["protected-local-rocky-lifecycle"]).toBeDefined();
    expect(jobs["protected-local-update-lifecycle"]).toBeDefined();

    const releaseCheck = jobs["release-check"];
    expect(
      releaseCheck?.steps?.find((step) => usesAction(step, "actions/checkout"))?.with?.[
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
      protectedLocalUpdate?.steps?.find((step) => usesAction(step, "actions/checkout"))?.with?.[
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
        "node-focused",
        "node-unit",
        "node-gateway",
        "node-extensions",
        "dependency-integrity",
        "version-identity",
        "hosting-lifecycle",
        "protected-local-fixture-artifact",
        "protected-local-rocky-lifecycle",
        "protected-local-update-lifecycle",
        "ui-mining",
        "ui",
        "macos-runtime",
        "macos-app",
        "signer-integration",
        "signer-darwin-integration",
        "platform-bootstrap-audit",
        "docker-amd64",
        "docker-arm64",
        "codeql-javascript",
        "codeql-go",
        "codeql-python",
        "secrets",
      ]),
    );
    expect(required?.steps?.at(-1)?.run).toBe("node scripts/ci-required-gates.mjs");
    expect(required?.steps?.at(-1)?.env).toMatchObject({
      VERSION_ONLY: "${{ needs.change-scope.outputs.version_only }}",
      MANUAL_REVIEW_REQUIRED: "${{ needs.change-scope.outputs.manual_review_required }}",
      RUN_HOSTING: "${{ needs.change-scope.outputs.run_hosting }}",
      RUN_LOCAL_FRESH: "${{ needs.change-scope.outputs.run_local_fresh }}",
      RUN_LOCAL_UPDATE: "${{ needs.change-scope.outputs.run_local_update }}",
      RUN_CI_CONTRACTS: "${{ needs.change-scope.outputs.run_ci_contracts }}",
      RUN_T2_CONTRACTS: "${{ needs.change-scope.outputs.run_t2_contracts }}",
      RUN_NODE_FOCUSED: "${{ needs.change-scope.outputs.run_node_focused }}",
      RUN_NODE_UNIT: "${{ needs.change-scope.outputs.run_node_unit }}",
      RUN_NODE_GATEWAY: "${{ needs.change-scope.outputs.run_node_gateway }}",
      RUN_NODE_EXTENSIONS: "${{ needs.change-scope.outputs.run_node_extensions }}",
      RUN_DEPENDENCY_INTEGRITY: "${{ needs.change-scope.outputs.run_dependency_integrity }}",
      RUN_NODE_BUILD: "${{ needs.change-scope.outputs.run_node_build }}",
      RUN_NODE_PACKAGING: "${{ needs.change-scope.outputs.run_node_packaging }}",
      RUN_NODE_FULL: "${{ needs.change-scope.outputs.run_node_full }}",
      RUN_NATIVE_SIGNER: "${{ needs.change-scope.outputs.run_native_signer }}",
      RUN_SIGNER_INTEGRATION: "${{ needs.change-scope.outputs.run_signer_integration }}",
      RUN_SIGNER_DARWIN_INTEGRATION:
        "${{ needs.change-scope.outputs.run_signer_darwin_integration }}",
      RUN_PLATFORM_BOOTSTRAP: "${{ needs.change-scope.outputs.run_platform_bootstrap }}",
      RUN_DOCKER: "${{ needs.change-scope.outputs.run_docker }}",
      RUN_CODEQL_JAVASCRIPT: "${{ needs.change-scope.outputs.run_codeql_javascript }}",
      RUN_CODEQL_GO: "${{ needs.change-scope.outputs.run_codeql_go }}",
      RUN_CODEQL_PYTHON: "${{ needs.change-scope.outputs.run_codeql_python }}",
      RUN_UI_MINING: "${{ needs.change-scope.outputs.run_ui_mining }}",
      RUN_UI: "${{ needs.change-scope.outputs.run_ui }}",
      RUN_MACOS_RUNTIME: "${{ needs.change-scope.outputs.run_macos_runtime }}",
      RUN_MACOS_APP: "${{ needs.change-scope.outputs.run_macos_app }}",
      PROTECTED_LOCAL_ARTIFACT: "${{ needs.protected-local-fixture-artifact.result }}",
      PROTECTED_LOCAL_ROCKY: "${{ needs.protected-local-rocky-lifecycle.result }}",
      PROTECTED_LOCAL_UPDATE: "${{ needs.protected-local-update-lifecycle.result }}",
      T2_CONTRACTS: "${{ needs.t2-contracts.result }}",
      FOCUSED_TESTS: "${{ needs.node-focused.result }}",
      NODE_UNIT_TESTS: "${{ needs.node-unit.result }}",
      NODE_GATEWAY_TESTS: "${{ needs.node-gateway.result }}",
      NODE_EXTENSION_TESTS: "${{ needs.node-extensions.result }}",
      DEPENDENCY_INTEGRITY: "${{ needs.dependency-integrity.result }}",
      SIGNER_INTEGRATION: "${{ needs.signer-integration.result }}",
      SIGNER_DARWIN_INTEGRATION: "${{ needs.signer-darwin-integration.result }}",
      PLATFORM_BOOTSTRAP: "${{ needs.platform-bootstrap-audit.result }}",
      DOCKER_AMD64: "${{ needs.docker-amd64.result }}",
      DOCKER_ARM64: "${{ needs.docker-arm64.result }}",
      CODEQL_JAVASCRIPT: "${{ needs.codeql-javascript.result }}",
      CODEQL_GO: "${{ needs.codeql-go.result }}",
      CODEQL_PYTHON: "${{ needs.codeql-python.result }}",
      UI: "${{ needs.ui.result }}",
      MACOS_RUNTIME: "${{ needs.macos-runtime.result }}",
      MACOS_APP: "${{ needs.macos-app.result }}",
    });
  });

  it("classifies PRs from protected-base policy without private release state", async () => {
    const workflow = await readWorkflow(".github/workflows/ci.yml");
    const jobs = workflow.jobs ?? {};
    const scopeSteps = jobs["change-scope"]?.steps ?? [];
    const privateRoute = scopeSteps.find((step) => step.id === "private-route");
    const authorityCheckout = scopeSteps.find((step) => step.name === "Checkout trusted authority");
    const scope = scopeSteps.find((step) => step.id === "scope");

    expect(privateRoute).toBeUndefined();
    expect(authorityCheckout?.with).toMatchObject({
      ref: "${{ github.event.pull_request.base.sha || github.sha }}",
      path: ".ci-authority",
    });
    expect(scope?.run).toBe("node .ci-authority/scripts/ci-change-scope.mjs");
    expect(scope?.env).not.toHaveProperty("GATE_ROUTE");
    expect(scope?.env).not.toHaveProperty("GATE_PHASE");
    expect(scope?.env).not.toHaveProperty("GATE_ENTRY_POINT");
    expect(scope?.env).not.toHaveProperty("GATE_EXPECTED_PLAN_DIGEST");
    const ciContractCommand =
      jobs["ci-contracts"]?.steps?.find(
        (step) => step.name === "Check CI routing and gate contracts",
      )?.run ?? "";
    expect(ciContractCommand).not.toContain("scripts/ci-private-route-status.test.ts");

    const focused = jobs["node-focused"];
    expect(focused?.if).toBe("needs.change-scope.outputs.run_node_focused == 'true'");
    const focusedCommands = focused?.steps?.map((step) => step.run ?? "").join("\n") ?? "";
    expect(focusedCommands).toContain("scripts/protected-local-bootstrap.test.ts");
    expect(focusedCommands).toContain("scripts/fased-local-recovery-pending.test.ts");
    expect(focusedCommands).toContain("src/wallet/wallet-application-state-permissions.test.ts");
    expect(focusedCommands).toContain("test-protected-local-supervisor-client-root-fixture.sh");

    for (const [jobName, group] of [
      ["node-unit", "unit"],
      ["node-gateway", "gateway"],
      ["node-extensions", "extensions"],
    ] as const) {
      const job = jobs[jobName];
      expect(
        job?.steps?.some((step) => step.run === `node scripts/ci-run-changed-tests.mjs ${group}`),
      ).toBe(true);
    }

    expect(jobs["checks"]?.if).toBe("needs.change-scope.outputs.run_node_full == 'true'");
    expect(jobs["build-artifacts"]?.if).toContain("run_node_build");
    expect(jobs["release-check"]?.if).toBe(
      "needs.change-scope.outputs.run_node_packaging == 'true'",
    );
    expect(jobs["packed-core-smoke"]?.if).toBe(
      "needs.change-scope.outputs.run_node_packaging == 'true'",
    );

    const dependency = jobs["dependency-integrity"];
    expect(dependency?.if).toBe("needs.change-scope.outputs.run_dependency_integrity == 'true'");
    expect(dependency?.["timeout-minutes"]).toBeLessThanOrEqual(3);
    const dependencyCommands = dependency?.steps?.map((step) => step.run ?? "").join("\n") ?? "";
    expect(dependencyCommands).toContain("node scripts/ci-dependency-integrity.mjs");
    expect(dependencyCommands).toContain("pnpm install --lockfile-only");
    expect(dependencyCommands).toContain("pnpm audit --prod --audit-level high");

    const secretsCommands = jobs["secrets"]?.steps?.map((step) => step.run ?? "").join("\n") ?? "";
    expect(secretsCommands).not.toContain("pnpm-audit-prod");
    expect(secretsCommands).not.toContain("pnpm audit");

    expect(jobs["signer-platform"]?.if).toBe(
      "needs.change-scope.outputs.run_native_signer == 'true'",
    );
    expect(jobs["signer-integration"]?.if).toBe(
      "needs.change-scope.outputs.run_signer_integration == 'true'",
    );
    expect(jobs["signer-darwin-integration"]?.if).toBe(
      "needs.change-scope.outputs.run_signer_darwin_integration == 'true'",
    );
    const darwinSignerSetupGo = jobs["signer-darwin-integration"]?.steps?.find(
      (step) => step.name === "Setup Go",
    );
    expect(darwinSignerSetupGo?.uses).toBe(
      "actions/setup-go@924ae3a1cded613372ab5595356fb5720e22ba16",
    );
    expect(darwinSignerSetupGo?.with?.["go-version-file"]).toBe("tools/fased-signerd/go.mod");

    for (const jobName of ["protected-local-lifecycle", "protected-local-update-lifecycle"]) {
      const fixture = jobs[jobName]?.steps?.find(
        (step) => step.env?.FASED_SYSTEMD_FIXTURE_PREINSTALLED_TOOLS !== undefined,
      );
      expect(fixture?.env?.FASED_SYSTEMD_FIXTURE_PREINSTALLED_TOOLS, jobName).toBe("1");
    }
    const bootstrap = jobs["platform-bootstrap-audit"];
    expect(bootstrap?.if).toBe("needs.change-scope.outputs.run_platform_bootstrap == 'true'");
    expect(
      bootstrap?.steps?.find(
        (step) => step.env?.FASED_SYSTEMD_FIXTURE_PREINSTALLED_TOOLS !== undefined,
      )?.env?.FASED_SYSTEMD_FIXTURE_PREINSTALLED_TOOLS,
    ).toBe("0");

    expect(jobs["docker-amd64"]?.if).toBe("needs.change-scope.outputs.run_docker == 'true'");
    expect(jobs["docker-arm64"]?.if).toBe("needs.change-scope.outputs.run_docker == 'true'");
    expect(jobs["codeql-javascript"]?.if).toBe(
      "needs.change-scope.outputs.run_codeql_javascript == 'true'",
    );
    expect(jobs["codeql-javascript"]?.["timeout-minutes"]).toBeGreaterThanOrEqual(20);
    const javascriptSteps = jobs["codeql-javascript"]?.steps ?? [];
    const focusedInit = javascriptSteps.find(
      (step) => step.name === "Initialize focused Local-update CodeQL",
    );
    const fullInit = javascriptSteps.find((step) => step.name === "Initialize full CodeQL");
    expect(focusedInit?.if).toBe("needs.change-scope.outputs.focused_local_update == 'true'");
    expect(fullInit?.if).toBe("needs.change-scope.outputs.focused_local_update != 'true'");
    const focusedConfig = parse(String(focusedInit?.with?.config ?? "")) as {
      paths?: string[];
    };
    const coveredRoots = focusedConfig.paths ?? [];
    for (const sourcePath of await readFocusedLocalUpdateProductionPaths()) {
      if (!/\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/u.test(sourcePath)) {
        continue;
      }
      expect(
        coveredRoots.some(
          (root) => sourcePath === root || sourcePath.startsWith(`${root.replace(/\/$/u, "")}/`),
        ),
        `focused CodeQL does not cover ${sourcePath}`,
      ).toBe(true);
    }
    expect(jobs["codeql-go"]?.if).toBe("needs.change-scope.outputs.run_codeql_go == 'true'");
    expect(jobs["codeql-python"]?.if).toBe(
      "needs.change-scope.outputs.run_codeql_python == 'true'",
    );
  });

  it("keeps expensive compatibility lanes opt-in or path-scoped", async () => {
    const workflow = await readWorkflow(".github/workflows/ci.yml");
    const jobs = workflow.jobs ?? {};

    expect(jobs["checks-windows"]).toBeUndefined();
    expect(jobs["ios"]).toBeUndefined();
    expect(jobs["android"]).toBeUndefined();
    expect(jobs["ui"]?.if).toBe("needs.change-scope.outputs.run_ui == 'true'");
    expect(jobs["macos-runtime"]?.if).toBe(
      "needs.change-scope.outputs.run_macos_runtime == 'true'",
    );
    expect(jobs["macos-app"]?.if).toBe("needs.change-scope.outputs.run_macos_app == 'true'");
    expect(jobs["ui-mining"]?.if).toBe("needs.change-scope.outputs.run_ui_mining == 'true'");
    const uiCommands = jobs["ui"]?.steps?.map((step) => step.run ?? "").join("\n") ?? "";
    expect(uiCommands).toContain("node scripts/ci-run-changed-tests.mjs ui");
    expect(uiCommands).toContain("pnpm ui:build");
    expect(uiCommands).toContain("pnpm test:ui");

    const macosRuntimeCommands =
      jobs["macos-runtime"]?.steps?.map((step) => step.run ?? "").join("\n") ?? "";
    expect(macosRuntimeCommands).toContain("src/daemon/launchd.test.ts");
    expect(macosRuntimeCommands).not.toMatch(/(^|\s)pnpm test($|\s)/u);
    const macosAppCommands =
      jobs["macos-app"]?.steps?.map((step) => step.run ?? "").join("\n") ?? "";
    expect(macosAppCommands).toContain("swift build --package-path apps/macos");
    expect(macosAppCommands).toContain("swift test --package-path apps/macos");

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

  it("keeps auxiliary compatibility workflows off unrelated pull requests", async () => {
    const formal = await readFile(
      resolve(repoRoot, ".github/workflows/formal-conformance.yml"),
      "utf8",
    );
    const install = await readFile(
      resolve(repoRoot, ".github/workflows/install-smoke.yml"),
      "utf8",
    );
    const sanity = await readFile(
      resolve(repoRoot, ".github/workflows/workflow-sanity.yml"),
      "utf8",
    );

    expect(formal).not.toContain("  pull_request:");
    expect(formal).toContain("  schedule:");
    expect(formal).toContain("  workflow_dispatch:");
    expect(install).not.toContain("  pull_request:");
    expect(install).not.toContain("  push:");
    expect(install).toContain("  workflow_dispatch:");
    expect(sanity).not.toContain("  pull_request:");
    expect(sanity).not.toContain("  push:");
    expect(sanity).toContain("  workflow_dispatch:");
  });

  it("pins every third-party Action to an immutable commit", async () => {
    const githubRoot = resolve(repoRoot, ".github");
    const files = (await listFiles(githubRoot)).filter((path) => /\.ya?ml$/u.test(path));
    const violations: string[] = [];

    for (const path of files) {
      const source = await readFile(path, "utf8");
      for (const match of source.matchAll(/^\s*uses:\s*([^\s#]+)/gmu)) {
        const reference = match[1] ?? "";
        if (!reference.startsWith("./") && !/@[0-9a-f]{40}$/u.test(reference)) {
          violations.push(`${path.slice(repoRoot.length + 1)}: ${reference}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("keeps lifecycle fixtures out of the product Docker release workflow", async () => {
    const dockerWorkflow = await readFile(
      resolve(repoRoot, ".github/workflows/docker-release.yml"),
      "utf8",
    );

    expect(dockerWorkflow).not.toContain("scripts/docker/protected-local-systemd/**");
    expect(dockerWorkflow).not.toContain("scripts/docker/hosting-systemd/**");
    expect(dockerWorkflow).not.toContain("scripts/docker/streamed-hosting-bootstrap/**");
    expect(dockerWorkflow).not.toContain("pull_request:");
  });

  it("keeps Docker validation-only without an exact Docker release receipt", async () => {
    const dockerWorkflow = await readFile(
      resolve(repoRoot, ".github/workflows/docker-release.yml"),
      "utf8",
    );

    expect(dockerWorkflow).not.toMatch(/\n\s+push:\s*\n\s+tags:/u);
    expect(dockerWorkflow).not.toContain("packages: write");
    expect(dockerWorkflow).not.toContain("push-by-digest=true");
    expect(dockerWorkflow).not.toContain("push=true");
    expect(dockerWorkflow).not.toContain("imagetools create");
    expect(dockerWorkflow).not.toContain("gh release create");
    expect(dockerWorkflow).not.toContain("gh release upload");
  });

  it("builds a non-publishing tag candidate and promotes only its exact verified bytes", async () => {
    const workflow = await readWorkflow(".github/workflows/hosted-runtime-release.yml");
    const jobs = workflow.jobs ?? {};
    const candidate = jobs["candidate"];
    const publish = jobs["publish"];

    expect(jobs["release-gate"]?.if).toBe(
      "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')",
    );
    expect(candidate?.if).toBe(
      "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')",
    );
    expect(candidate?.needs).toEqual(["validate", "linux", "signer"]);
    expect(publish?.if).toBe("github.event_name == 'workflow_dispatch'");
    expect(workflow.concurrency?.group).toBe(
      "hosted-runtime-release-${{ inputs.release_tag || github.ref_name }}",
    );

    const candidateText = candidate?.steps?.map((step) => step.run ?? "").join("\n") ?? "";
    const publishText = publish?.steps?.map((step) => step.run ?? "").join("\n") ?? "";
    const releaseGateText =
      jobs["release-gate"]?.steps?.map((step) => step.run ?? "").join("\n") ?? "";
    expect(releaseGateText).toContain('--trusted-actor-id "$TRUSTED_RELEASE_ACTOR_ID"');
    expect(releaseGateText).toContain('--release-tag "$GITHUB_REF_NAME"');
    expect(candidateText).toContain("release-artifact-set.mjs build");
    expect(candidateText).not.toContain("gh release create");
    expect(
      candidate?.steps?.find((step) => usesAction(step, "actions/upload-artifact"))?.with?.name,
    ).toBe("fased-hosting-candidate");

    const download = publish?.steps?.find((step) => usesAction(step, "actions/download-artifact"));
    expect(download?.with).toMatchObject({
      name: "fased-hosting-candidate",
      "run-id": "${{ inputs.candidate_run_id }}",
    });
    expect(publishText).toContain("--artifact-set-digest");
    expect(publishText).toContain('--trusted-actor-id "$TRUSTED_RELEASE_ACTOR_ID"');
    expect(publishText).toContain('--release-tag "$RELEASE_TAG"');
    expect(publishText).toContain("release-artifact-set.mjs verify-assets");
    expect(publishText).toContain('gh release create "$RELEASE_TAG"');
    expect(publishText).toContain('.artifacts/hosted-runtime/* "${release_args[@]}"');
    expect(publishText).toContain("--verify-tag");
    expect(publishText).toContain("--draft");
    expect(publishText).toContain("release_args+=(--prerelease)");
    expect(publishText).not.toContain("gh release upload");
    expect(publishText).toContain("cleanup_draft");
    expect(publishText).toContain("--method DELETE");
    expect(publishText).toContain("--method PATCH");
    expect(publishText.indexOf("release-artifact-set.mjs verify-assets")).toBeLessThan(
      publishText.indexOf("--method PATCH"),
    );
    expect(publishText).toContain("existing_release_id");
    expect(publishText).not.toContain("gh release view");
    expect(publishText).toContain("releases/$release_id");
    expect(publish?.steps?.some((step) => usesAction(step, "actions/attest"))).toBe(false);
    expect(publishText).not.toContain("hosted:artifact:build");
    expect(publishText).not.toContain("release-fased-signerd.sh");
  });

  it("keeps Hosted Runtime Release as the sole GitHub Release publisher", async () => {
    const dockerWorkflow = await readFile(
      resolve(repoRoot, ".github/workflows/docker-release.yml"),
      "utf8",
    );
    const hostedWorkflow = await readFile(
      resolve(repoRoot, ".github/workflows/hosted-runtime-release.yml"),
      "utf8",
    );

    expect(dockerWorkflow).not.toContain("gh release create");
    expect(dockerWorkflow).not.toContain("gh release upload");
    expect(hostedWorkflow).toContain('gh release create "$RELEASE_TAG"');
  });

  it("selects beta for every prerelease target in the Protected Local fixture", async () => {
    const fixture = await readFile(
      resolve(repoRoot, "scripts/docker/protected-local-systemd/run.sh"),
      "utf8",
    );

    expect(fixture).toContain('if [[ "$version" == *-* ]]');
    expect(fixture).toContain("target_update_args=(--channel beta)");
    expect(fixture.match(/update "\$\{target_update_args\[@\]\}" --timeout/gu)).toHaveLength(5);
    expect(fixture).not.toContain("/etc/fased/testing");
    expect(fixture).toContain("/var/lib/fased-protected-local-fixture");
    expect(fixture).toContain(
      'if [[ "$phase" == "modern-update" || "$phase" == "legacy-takeover" ]]',
    );
    expect(fixture).toContain("run_target_update() {");
    expect(fixture).toContain('if [[ "$phase" == "legacy-takeover" ]]');
    expect(fixture).toContain(
      "modern packaged Protected Local rollback, retry, restart, preservation, and no-op passed",
    );
    expect(fixture).toContain(
      "legacy packaged Protected Local takeover, rollback, retry, restart, preservation, and no-op passed",
    );
  });

  it("allows the legacy operator runtime only before takeover", async () => {
    const fixture = await readFile(
      resolve(repoRoot, "scripts/docker/protected-local-systemd/run.sh"),
      "utf8",
    );
    const resolverStart = fixture.indexOf("resolve_predecessor_runtime() {");
    const resolverEnd = fixture.indexOf("\n}", resolverStart);
    expect(resolverStart).toBeGreaterThanOrEqual(0);
    expect(resolverEnd).toBeGreaterThan(resolverStart);
    const resolver = fixture.slice(resolverStart, resolverEnd);
    expect(resolver).toContain('if [[ "$phase" == "legacy-takeover" ]]');
    expect(resolver).toContain('"$state/runtime/releases/"*');
    expect(resolver).toContain('resolve_protected_runtime "$instance"');

    expect(fixture).toContain('runtime="$(resolve_predecessor_runtime "$phase" "$instance")"');
    expect(fixture).toContain('runtime="$(resolve_protected_runtime "$instance")"');
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
