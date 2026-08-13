import { readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

type WorkflowJob = {
  if?: string;
  needs?: string[];
  permissions?: Record<string, string>;
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
  concurrency?: {
    "cancel-in-progress"?: boolean;
    group?: string;
  };
  jobs?: Record<string, WorkflowJob>;
};

async function readWorkflow(path: string): Promise<Workflow> {
  return parse(await readFile(resolve(repoRoot, path), "utf8")) as Workflow;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
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

    expect(workflow.concurrency).toEqual({
      group: "ci-${{ github.workflow }}-${{ github.event_name }}-${{ github.ref }}",
      "cancel-in-progress": false,
    });

    expect(jobs["change-scope"]).toBeDefined();
    expect(jobs["docs-scope"]).toBeUndefined();
    expect(jobs["changed-scope"]).toBeUndefined();
    expect(jobs["android"]).toBeUndefined();
    expect(jobs["version-identity"]).toBeDefined();
    expect(
      jobs["version-identity"]?.steps?.find(
        (step) => step.name === "Validate exact version-only diff",
      )?.run,
    ).toBe("node scripts/ci-version-identity.mjs --allow-published-base-restore");
    expect(jobs["ci-contracts"]).toBeDefined();
    expect(jobs["t2-contracts"]).toBeDefined();
    expect(jobs["node-focused"]).toBeDefined();
    expect(jobs["hosting-lifecycle"]).toBeDefined();
    expect(jobs["protected-local-fixture-artifact"]).toBeDefined();
    expect(jobs["protected-local-rocky-lifecycle"]).toBeDefined();
    expect(jobs["protected-local-update-lifecycle"]).toBeDefined();

    const fixtureArtifact = jobs["protected-local-fixture-artifact"];
    const fixtureArtifactBuild = fixtureArtifact?.steps?.find(
      (step) => step.name === "Build one exact fixture artifact",
    );
    expect(fixtureArtifactBuild?.run).toBe("bash scripts/test-lifecycle-local-acceptance.sh");
    expect(fixtureArtifactBuild?.env).toMatchObject({
      FASED_SYSTEMD_FIXTURE_BUILD_ONLY: "1",
      FASED_SYSTEMD_FIXTURE_OUTPUT_DIR: "${{ runner.temp }}/protected-local-artifact",
    });

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
      String(step.run ?? "").includes("scripts/go-lifecycle-routing.test.ts"),
    );
    const localSystemdFixture = protectedLocalUpdate?.steps?.find(
      (step) => step.env?.FASED_SYSTEMD_FIXTURE_SCENARIOS === "managed-update",
    );
    expect(
      protectedLocalUpdate?.steps?.find((step) => step.uses === "./.github/actions/setup-node-env")
        ?.with?.["install-bun"],
    ).toBe("false");
    expect(localRecoveryT1?.run).toContain("pnpm exec vitest run");
    expect(protectedLocalUpdate?.steps?.indexOf(localRecoveryT1)).toBeLessThan(
      protectedLocalUpdate?.steps?.indexOf(localSystemdFixture),
    );
    expect(localSystemdFixture?.run).toBe("bash scripts/test-lifecycle-local-acceptance.sh");
    expect(localSystemdFixture?.env).toMatchObject({
      FASED_SYSTEMD_FIXTURE_MANAGED_PREDECESSOR_VERSION: "0.1.75",
    });

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
      DEPENDENCY_REMEDIATION: "${{ needs.change-scope.outputs.dependency_remediation }}",
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
    expect(focusedCommands).toContain("scripts/go-lifecycle-routing.test.ts");
    expect(focusedCommands).toContain("scripts/fased-managed-updater-fixed-client.test.ts");
    expect(focusedCommands).toContain("src/wallet/wallet-application-state-permissions.test.ts");

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
    const focusedInit = javascriptSteps.find((step) => step.name === "Initialize focused CodeQL");
    const fullInit = javascriptSteps.find((step) => step.name === "Initialize full CodeQL");
    expect(focusedInit?.if).toBe("needs.change-scope.outputs.focused_codeql_javascript == 'true'");
    expect(fullInit?.if).toBe("needs.change-scope.outputs.focused_codeql_javascript != 'true'");
    const focusedConfig = parse(String(focusedInit?.with?.config ?? "")) as {
      paths?: string[];
    };
    const coveredRoots = focusedConfig.paths ?? [];
    expect(coveredRoots).toEqual(
      expect.arrayContaining([
        "src/commands/wallet.ts",
        "src/federation/federation-state-permissions.ts",
      ]),
    );
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
      expect.arrayContaining([expect.stringContaining("go -C tools/fased-lifecycled test")]),
    );
    expect(t2Commands.join("\n")).toContain("./platform");
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

  it("keeps Bun and Docker tooling out of the ordinary PR lane", async () => {
    const pr = await readFile(resolve(repoRoot, ".github/workflows/pr.yml"), "utf8");
    const setup = await readFile(
      resolve(repoRoot, ".github/actions/setup-node-env/action.yml"),
      "utf8",
    );

    expect(pr).not.toContain("docker/setup-buildx-action");
    expect(pr).not.toContain("docker/build-push-action");
    expect(pr).not.toContain("docker/login-action");
    expect(pr).toContain('install-bun: "false"');
    expect(setup).toMatch(/install-bun:[\s\S]*?default: "false"/u);
  });

  it("keeps full Node, builds, packaging, and CodeQL off the PR runner", async () => {
    const workflow = await readWorkflow(".github/workflows/pr.yml");
    const selected = workflow.jobs?.["selected-tests"]?.steps ?? [];
    const security = workflow.jobs?.security?.steps ?? [];

    expect(selected.some((step) => step.name?.includes("full Node"))).toBe(false);
    expect(selected.some((step) => step.name?.includes("Build once"))).toBe(false);
    expect(selected.some((step) => step.name?.includes("package"))).toBe(false);
    expect(security.some((step) => step.uses?.startsWith("github/codeql-action/"))).toBe(false);
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

  it("builds once from the immutable owner tag authorized by the lifecycle root", async () => {
    const workflow = await readWorkflow(".github/workflows/hosted-runtime-release.yml");
    const jobs = workflow.jobs ?? {};
    const candidate = jobs["candidate"];
    const p1Fresh = jobs["p1-local-fresh"];
    const p1Update = jobs["p1-local-update"];
    const p1Hosting = jobs["p1-hosting"];
    const predecessorCapsules = jobs["predecessor-capsules"];
    const tagReady = jobs["tag-ready"];
    const publish = jobs["publish"];
    const preflightText = jobs["preflight"]?.steps?.map((step) => step.run ?? "").join("\n") ?? "";
    const buildText = jobs["build"]?.steps?.map((step) => step.run ?? "").join("\n") ?? "";
    const linuxText = jobs["linux"]?.steps?.map((step) => step.run ?? "").join("\n") ?? "";
    const signerText = jobs["signer"]?.steps?.map((step) => step.run ?? "").join("\n") ?? "";

    expect(workflow.on).not.toHaveProperty("push");
    expect(workflow.on.workflow_dispatch.inputs.pre_candidate_run_id.required).toBe(true);
    expect(workflow.on.workflow_dispatch.inputs.pre_tag_p1_run_id.required).toBe(true);
    expect(workflow.on.workflow_dispatch.inputs.owner_predecessor_version.required).toBe(true);
    expect(jobs["release-gate"]).toBeUndefined();
    expect(jobs["build"]?.needs).toBe("preflight");
    expect(jobs["signer"]?.needs).toBe("preflight");
    expect(jobs["linux"]?.needs).toEqual(["build", "signer"]);
    expect(candidate?.needs).toEqual(["preflight", "build", "linux", "signer"]);
    expect(jobs["p1"]).toBeUndefined();
    expect(p1Fresh?.needs).toEqual(["preflight", "candidate"]);
    expect(p1Update?.needs).toEqual(["preflight", "candidate", "predecessor-capsules"]);
    expect(p1Hosting?.needs).toEqual(["preflight", "candidate", "predecessor-capsules"]);
    expect(predecessorCapsules?.needs).toEqual(["preflight"]);
    expect(predecessorCapsules?.permissions).toMatchObject({
      attestations: "write",
      "id-token": "write",
    });
    expect(tagReady).toBeUndefined();
    expect(publish?.needs).toEqual([
      "candidate",
      "p1-local-fresh",
      "p1-local-update",
      "p1-hosting",
    ]);
    expect(publish?.environment).toBe("candidate-release");
    expect(workflow.concurrency?.group).toBe(
      "hosted-runtime-release-${{ inputs.release_version }}-${{ inputs.source_commit }}",
    );

    const candidateText = candidate?.steps?.map((step) => step.run ?? "").join("\n") ?? "";
    const candidateStepNames = candidate?.steps?.map((step) => step.name) ?? [];
    const p1FreshText = p1Fresh?.steps?.map((step) => step.run ?? "").join("\n") ?? "";
    const p1UpdateText = p1Update?.steps?.map((step) => step.run ?? "").join("\n") ?? "";
    const p1HostingText = p1Hosting?.steps?.map((step) => step.run ?? "").join("\n") ?? "";
    const publishText = publish?.steps?.map((step) => step.run ?? "").join("\n") ?? "";
    const candidateDownloads = candidate?.steps?.filter((step) =>
      usesAction(step, "actions/download-artifact"),
    );
    expect(candidateDownloads?.map((step) => step.with?.pattern ?? step.with?.name)).toEqual([
      "fased-hosted-runtime-*",
      "fased-signerd-release",
    ]);
    expect(candidateStepNames).toContain("Setup Node.js");
    expect(candidateStepNames).toContain("Setup Go");
    expect(candidateStepNames).toContain("Setup pnpm + cache store");
    expect(candidateStepNames).toContain("Install exact frozen dependencies");
    expect(candidateStepNames.indexOf("Install exact frozen dependencies")).toBeLessThan(
      candidateStepNames.indexOf("Assemble candidate release manifest"),
    );
    expect(candidateText).toContain("pnpm install --frozen-lockfile");
    expect(candidateText).toContain("release-artifact-set.mjs build");
    expect(candidateText).toContain("build-lifecycle-release-index.mjs");
    expect(candidateText).toContain("fased-lifecycle-root-v1.json");
    expect(candidateText).toContain("fased-release-index-v1.json");
    expect(candidateText).toContain("fased-release-index-v1.json.attestation.json");
    expect(candidateText.indexOf("build-lifecycle-release-index.mjs")).toBeLessThan(
      candidateText.indexOf("release-artifact-set.mjs build"),
    );
    expect(
      candidate?.steps?.find((step) => step.name === "Attest production lifecycle release index")
        ?.with?.["subject-path"],
    ).toBe(".artifacts/hosted-runtime/fased-release-index-v1.json");
    expect(preflightText).not.toContain("pnpm build");
    expect(buildText).toContain("pnpm build");
    expect(preflightText).toContain('test "$GITHUB_REF" = "refs/tags/v$RELEASE_VERSION"');
    expect(preflightText).toContain(
      'git ls-remote --exit-code --tags origin "refs/tags/v$RELEASE_VERSION"',
    );
    expect(preflightText).toContain('test "$remote_tag" = "$SOURCE_COMMIT"');
    expect(preflightText).not.toContain("Candidate tag already exists before packaged P1");
    expect(preflightText).toContain("node scripts/ci-version-identity.mjs --allow-exact-tag");
    expect(buildText).toContain("pnpm check:plugin-sdk:types");
    expect(buildText).toContain("node --import tsx scripts/release-check.ts");
    expect(buildText).toContain("pnpm release:validate-dist:packed");
    expect(buildText).not.toContain("pnpm release:check");
    expect(buildText).not.toContain("pnpm signer:protocol:check");
    expect(buildText).not.toContain("pnpm sat:signer-codecs:check");
    expect(buildText).not.toContain("pnpm test:signer:compat");
    expect(buildText).not.toContain("pnpm test:local-source-update-compat");
    expect(buildText).not.toContain("pnpm test:managed-updater");
    expect(preflightText).toContain(".mainRunId");
    expect(preflightText).toContain(".mainChecksJobId");
    expect(preflightText).toContain("actions/jobs/$main_checks_job_id");
    expect(preflightText).toContain('.path == ".github/workflows/main.yml"');
    expect(
      jobs["preflight"]?.steps?.some((step) => step.name === "Verify immutable pre-candidate pass"),
    ).toBe(true);
    expect(
      jobs["preflight"]?.steps?.some(
        (step) => step.name === "Verify immutable protected pre-tag P1 pass",
      ),
    ).toBe(true);
    expect(preflightText).toContain('.path == ".github/workflows/pre-tag-p1.yml"');
    expect(preflightText).toContain("fased-pre-tag-p1-evidence");
    expect(preflightText).toContain("pnpm audit --prod --audit-level high");
    expect(
      jobs["build"]?.steps?.some((step) => step.name === "Install exact frozen dependencies"),
    ).toBe(true);
    expect(linuxText).toContain("hosted:artifact:from-dist");
    const linuxStepNames = jobs["linux"]?.steps?.map((step) => step.name) ?? [];
    expect(linuxStepNames.indexOf("Download exact native lifecycle assets")).toBeLessThan(
      linuxStepNames.indexOf("Restore executable modes on exact native lifecycle assets"),
    );
    expect(linuxText).toContain('test ! -L "$executable"');
    expect(linuxText).toContain('chmod 0755 "$executable"');
    expect(
      jobs["linux"]?.steps?.some((step) => step.name === "Assemble exact lifecycle generation"),
    ).toBe(false);
    expect(candidateText).toContain("assemble-lifecycle-generation.mjs");
    expect(candidateText).toContain('--inventory-tool "$inventory_tool"');
    expect(candidateText).toContain(
      'inventory_tool=".artifacts/hosted-runtime/fased-lifecycled-linux-amd64"',
    );
    expect(candidateText).toContain("--runtime-archive");
    expect(candidateText).toContain("fased-hosted-app-v2-linux-");
    expect(candidateText).toContain("--dependency-archive");
    expect(candidateText).toContain("fased-hosted-deps-linux-");
    expect(candidateText).toContain("--release-manifest");
    expect(candidateText.indexOf("build-hosted-release-manifest.mjs")).toBeLessThan(
      candidateText.indexOf("assemble-lifecycle-generation.mjs"),
    );
    expect(signerText).toContain("release-fased-lifecycled.sh");
    expect(signerText).toContain("fased-lifecycled-checksums.txt");
    expect(linuxText).not.toContain("hosted:artifact:build");
    expect(candidateText).toContain('--source-ref "$GITHUB_REF"');
    expect(candidateText).not.toContain("refs/heads/main");
    expect(candidateText).toContain("--tree");
    expect(candidateText).toContain("--lockfile-digest");
    expect(candidateText).toContain("--workflow-run-attempt");
    expect(publishText).not.toContain("--workflow-run-attempt");
    expect(candidateText).not.toContain("gh release create");
    expect(
      candidate?.steps?.find((step) => usesAction(step, "actions/upload-artifact"))?.with?.name,
    ).toBe("fased-hosting-candidate");

    for (const p1 of [p1Fresh, p1Update, p1Hosting]) {
      expect(
        p1?.steps?.find((step) => usesAction(step, "actions/download-artifact"))?.with,
      ).toMatchObject({ name: "fased-hosting-candidate" });
    }
    expect(p1FreshText).toContain("test-lifecycle-local-acceptance.sh");
    expect(p1FreshText).not.toContain("test-lifecycle-hosting-acceptance.sh");
    expect(p1UpdateText).toContain("test-lifecycle-local-acceptance.sh");
    expect(p1UpdateText).not.toContain("test-lifecycle-hosting-acceptance.sh");
    expect(p1HostingText).toContain("test-lifecycle-hosting-acceptance.sh");
    expect(p1HostingText).not.toContain("test-lifecycle-local-acceptance.sh");
    expect(
      p1Fresh?.steps?.find((step) => step.name === "Run packaged fresh Local P1")?.env,
    ).toMatchObject({
      FASED_SYSTEMD_FIXTURE_SCENARIOS: "fresh-install",
      FASED_SYSTEMD_FIXTURE_PUBLIC_ACQUISITION: "1",
    });
    expect(
      p1Update?.steps?.find((step) => step.name === "Run packaged supported-stable update P1")?.env,
    ).toMatchObject({
      FASED_SYSTEMD_FIXTURE_SCENARIOS: "${{ steps.p1-scenario.outputs.scenarios }}",
      FASED_SYSTEMD_FIXTURE_MANAGED_PREDECESSOR_VERSION: "${{ matrix.predecessor }}",
      FASED_SYSTEMD_FIXTURE_PUBLIC_ACQUISITION: "1",
    });
    expect(p1Update?.strategy).toMatchObject({
      "fail-fast": false,
      matrix: { predecessor: "${{ fromJSON(needs.preflight.outputs.p1_predecessors) }}" },
    });
    expect(
      p1Update?.steps?.find((step) => step.name === "Derive exact predecessor topology")?.env,
    ).toMatchObject({ GH_TOKEN: "${{ github.token }}" });
    expect(preflightText).toContain("ownerPredecessorVersion");
    expect(preflightText).toContain("[$stable,$owner] | unique");
    expect(p1Update?.steps?.some((step) => usesAction(step, "actions/cache"))).toBe(true);
    expect(publishText).not.toContain("git tag");
    expect(publishText).not.toContain("git push origin");
    expect(publishText).toContain("git ls-remote --exit-code --tags origin");
    expect(publishText).toContain('--source-ref "$GITHUB_REF"');
    expect(publishText).not.toContain("refs/heads/main");
    expect(publishText.indexOf("git ls-remote --exit-code --tags origin")).toBeLessThan(
      publishText.indexOf('gh release create "$RELEASE_TAG"'),
    );
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

  it("binds pre-candidate evidence before a version is allocated", async () => {
    const workflow = await readWorkflow(".github/workflows/pre-candidate.yml");
    const validate = workflow.jobs?.validate;
    const commands = validate?.steps?.map((step) => step.run ?? "").join("\n") ?? "";

    expect(workflow.on).not.toHaveProperty("push");
    expect(workflow.on).not.toHaveProperty("pull_request");
    expect(workflow.on).toHaveProperty("workflow_dispatch");
    expect(workflow.on.workflow_dispatch.inputs.owner_predecessor_version.required).toBe(true);
    expect(workflow.on.workflow_dispatch.inputs.release_sequence.required).toBe(true);
    expect(workflow.on.workflow_dispatch.inputs.security_epoch.required).toBe(true);
    expect(validate?.["timeout-minutes"]).toBeLessThanOrEqual(5);
    expect(commands).toContain("pnpm install --frozen-lockfile");
    expect(commands).toContain("actions/workflows/main.yml/runs?head_sha=$SOURCE_COMMIT");
    expect(commands).toContain('.name == "checks" and .conclusion == "success"');
    expect(commands).toContain("mainRunId");
    expect(commands).toContain("mainChecksJobId");
    expect(commands).not.toContain("pnpm release:check");
    expect(commands).not.toMatch(/(^|\s)pnpm build($|\s)/u);
    expect(commands).not.toContain("pnpm signer:protocol:check");
    expect(commands).not.toContain("pnpm sat:signer-codecs:check");
    expect(commands).not.toContain("pnpm check:dependency-ownership");
    expect(commands).not.toContain("pnpm test:signer:compat");
    expect(commands).not.toContain("pnpm test:local-source-update-compat");
    expect(commands).not.toContain("pnpm test:managed-updater");
    expect(commands).not.toContain("pnpm check:plugin-sdk:types");
    expect(commands).not.toContain("scripts/release-check.ts");
    expect(commands).not.toContain("pnpm release:validate-dist:packed");
    expect(commands).toContain("--verify-public-github");
    expect(commands).toContain("lockfileDigest");
    expect(commands).toContain("ownerPredecessorVersion");
    expect(commands).toContain("schemaVersion:3");
    expect(commands).toContain("releaseSequence");
    expect(commands).toContain("securityEpoch");
    expect(
      validate?.steps?.find((step) => usesAction(step, "actions/upload-artifact"))?.with?.name,
    ).toBe("fased-pre-candidate-evidence");
  });

  it("runs candidate-shaped Local and Hosting P1 before the immutable tag", async () => {
    const workflow = await readWorkflow(".github/workflows/pre-tag-p1.yml");
    const jobs = workflow.jobs ?? {};
    const preflight = jobs.preflight;
    const candidate = jobs.candidate;
    const localFresh = jobs["local-fresh"];
    const localUpdate = jobs["local-update"];
    const hosting = jobs.hosting;
    const evidence = jobs.evidence;
    const candidateBuild = candidate?.steps?.find(
      (step) => step.name === "Build exact non-publishable x64 artifact once",
    );
    const hostingRun = hosting?.steps?.find((step) => step.name === "Run exact Hosting entrypoint");
    const predecessorTopology = localUpdate?.steps?.find(
      (step) => step.name === "Derive exact predecessor topology",
    );
    const allText = Object.values(jobs)
      .flatMap((job) => job.steps ?? [])
      .map((step) => step.run ?? "")
      .join("\n");

    expect(workflow.on).toEqual({
      workflow_dispatch: expect.any(Object),
    });
    expect(workflow.on.workflow_dispatch.inputs.pre_candidate_run_id.required).toBe(true);
    expect(preflight?.["timeout-minutes"]).toBeLessThanOrEqual(5);
    expect(candidate?.needs).toEqual(["preflight"]);
    expect(localFresh?.needs).toEqual(["preflight", "candidate"]);
    expect(localUpdate?.needs).toEqual(["preflight", "candidate"]);
    expect(hosting?.needs).toEqual(["preflight", "candidate"]);
    expect(evidence?.needs).toEqual([
      "preflight",
      "candidate",
      "local-fresh",
      "local-update",
      "hosting",
    ]);
    expect(allText).toContain('test "$GITHUB_REF" = "refs/heads/main"');
    expect(allText).toContain("node scripts/ci-version-identity.mjs");
    expect(allText).toContain('! gh api "repos/$GITHUB_REPOSITORY/git/ref/tags/v$RELEASE_VERSION"');
    expect(candidateBuild?.env).toMatchObject({
      FASED_LIFECYCLE_RELEASE_SEQUENCE: "${{ needs.preflight.outputs.release_sequence }}",
      FASED_LIFECYCLE_SECURITY_EPOCH: "${{ needs.preflight.outputs.security_epoch }}",
      FASED_SYSTEMD_FIXTURE_BUILD_ONLY: "1",
    });
    expect(allText).toContain("scripts/prepare-candidate-fixture-trust.sh");
    expect(allText).toContain("fased-pre-tag-candidate-raw");
    expect(predecessorTopology?.env).toMatchObject({
      GH_TOKEN: "${{ github.token }}",
    });
    expect(allText).toContain("bash scripts/test-lifecycle-local-acceptance.sh");
    expect(allText).toContain("bash scripts/test-lifecycle-hosting-acceptance.sh");
    expect(hostingRun?.env).toMatchObject({
      FASED_HOSTING_SYSTEMD_FIXTURE_SCENARIOS: "fresh-install,managed-update",
    });
    expect(allText).not.toContain("gh release create");
    expect(allText).not.toContain("git tag");
    expect(allText).not.toContain("git push");
    expect(
      evidence?.steps?.find((step) => usesAction(step, "actions/upload-artifact"))?.with?.name,
    ).toBe("fased-pre-tag-p1-evidence");
  });

  it("keeps every GitHub Release publisher behind immutable evidence and protection", async () => {
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
    expect(hostedWorkflow).toContain("environment: candidate-release");
    const replayPath = resolve(repoRoot, ".github/workflows/candidate-p1-replay.yml");
    expect(await exists(replayPath)).toBe(true);
    const replay = await readWorkflow(".github/workflows/candidate-p1-replay.yml");
    const replayText = await readFile(replayPath, "utf8");
    expect(replay.on).toHaveProperty("workflow_dispatch");
    expect(replay.on.workflow_dispatch.inputs.source_run_id.required).toBe(true);
    expect(replay.on.workflow_dispatch.inputs.candidate_descriptor_sha256.required).toBe(true);
    expect(
      replay.jobs?.verify?.steps?.find((step) => usesAction(step, "actions/download-artifact"))
        ?.with,
    ).toMatchObject({
      name: "fased-hosting-candidate",
      "run-id": "${{ inputs.source_run_id }}",
    });
    expect(replayText).toContain("scripts/prepare-candidate-fixture-trust.sh");
    expect(replayText).toContain('.conclusion == "failure"');
    for (const jobName of ["local-fresh", "local-update", "hosting"] as const) {
      const checkout = replay.jobs?.[jobName]?.steps?.find((step) =>
        usesAction(step, "actions/checkout"),
      );
      expect(checkout?.with?.["fetch-depth"]).toBe(0);
    }
    expect(replayText).not.toContain("pnpm build");
    expect(replayText).not.toContain("gh release create");
    expect(replayText).not.toContain("git tag");
    expect(replayText).not.toContain("contents: write");

    const publicationReplayPath = resolve(
      repoRoot,
      ".github/workflows/candidate-publication-replay.yml",
    );
    expect(await exists(publicationReplayPath)).toBe(true);
    const publicationReplay = await readWorkflow(
      ".github/workflows/candidate-publication-replay.yml",
    );
    const publicationReplayText = await readFile(publicationReplayPath, "utf8");
    expect(publicationReplay.on.workflow_dispatch.inputs).toMatchObject({
      source_run_id: { required: true },
      p1_replay_run_id: { required: true },
      candidate_descriptor_sha256: { required: true },
      release_version: { required: true },
      source_commit: { required: true },
      predecessor_version: { required: true },
      owner_predecessor_version: { required: true },
    });
    expect(publicationReplay.permissions).toMatchObject({ actions: "read", contents: "read" });
    expect(publicationReplay.jobs?.publish).toMatchObject({
      needs: "verify",
      environment: "candidate-release",
      permissions: { actions: "read", contents: "write" },
    });
    expect(publicationReplayText).toContain("fased-hosting-candidate");
    expect(publicationReplayText).toContain("fased-p1-replay-*-receipts");
    expect(publicationReplayText).toContain("scripts/lifecycle-receipt-verifier.mjs");
    expect(publicationReplayText).toContain("local_receipt_count=0");
    expect(publicationReplayText).toContain('test -f "$local_receipts/ubuntu-fresh-install.json"');
    expect(publicationReplayText).toContain('"$local_receipts/ubuntu-managed-update.json"');
    expect(publicationReplayText).toContain('-eq "$local_receipt_count"');
    expect(publicationReplayText).not.toContain("1 + 3 *");
    expect(publicationReplayText).toContain("scripts/release-artifact-set.mjs verify");
    expect(publicationReplayText).toContain("scripts/privileged-release-evidence.mjs verify");
    expect(publicationReplayText).toContain('gh release create "$RELEASE_TAG" "$candidate"/*');
    expect(publicationReplayText).toContain("run-id: ${{ inputs.source_run_id }}");
    expect(
      publicationReplay.jobs?.publish?.steps?.find((step) =>
        usesAction(step, "actions/download-artifact"),
      )?.with,
    ).toMatchObject({
      name: "fased-hosting-candidate",
      "run-id": "${{ inputs.source_run_id }}",
    });
    expect(publicationReplayText).not.toContain("pnpm build");
    expect(publicationReplayText).not.toContain("go build");
    expect(publicationReplayText).not.toContain("git tag");
  });

  it("selects beta for every prerelease target in the Protected Local fixture", async () => {
    const fixture = await readFile(
      resolve(repoRoot, "scripts/docker/protected-local-systemd/lifecycle-acceptance.sh"),
      "utf8",
    );

    expect(fixture).toContain('if [[ "$version" == *-* ]]');
    expect(fixture).toContain('target_update_args=(--channel "$target_channel" --tag "$version")');
    expect(fixture.match(/update "\$\{target_update_args\[@\]\}" --timeout/gu)).toHaveLength(3);
    expect(fixture).not.toContain("/etc/fased/testing");
    expect(fixture).toContain("/var/lib/fased-protected-local-fixture");
    expect(fixture).toContain('if [[ "$phase" == "managed-update" ]]');
    expect(fixture).toContain("run_target_installer() {");
    expect(fixture).toContain('/bin/bash "$candidate_installer"');
    expect(fixture).toContain(
      'grep -F "Already current: $version" /tmp/managed-installer-noop.out',
    );
    expect(fixture).toContain("materialize_predecessor_wallet_registry_fixture");
    expect(fixture).toContain('managed_current_link="/opt/fased/local/$instance/current"');
    expect(fixture).not.toContain("/opt/fased/local/$instance/application/current");
    expect(fixture).toContain(
      "managed packaged Protected Local rollback, retry, restart, preservation, and no-op passed",
    );
    expect(fixture).not.toContain("legacy-takeover");
    expect(fixture).not.toContain("modern-update");
    expect(fixture).toContain("install -m 0700 -o testop -g testop /artifacts/install.sh");
    expect(fixture).toContain("install -m 0644 /artifacts/fased-hosted-release-v2.json");
    expect(fixture).toContain('if [[ "$public_acquisition" == "1" ]]');
    expect(fixture).not.toContain("EOF_FIXTURE_GH");
    expect(fixture).toContain("lifecycle-installed-state-capsule.mjs");
    expect(fixture).toContain("lifecycle-receipt-verifier.mjs");
    expect(fixture).toContain('FASED_HOSTED_ARTIFACT_BASE_URL="http://127.0.0.1:$rpc_port"');
    const containerFixture = await readFile(
      resolve(repoRoot, "scripts/test-lifecycle-local-acceptance.sh"),
      "utf8",
    );
    expect(containerFixture).toContain('"install_entry_release_identity=\\"${VERSION}\\""');
    expect(containerFixture).toContain("FASED_SYSTEMD_FIXTURE_PREDECESSOR_CAPSULE_DIR");
    expect(containerFixture).toContain(".release.commit == $commit");
    expect(containerFixture).toContain('bash "$ROOT_DIR/scripts/release-fased-lifecycled.sh"');
    expect(containerFixture).toContain('node "$ROOT_DIR/scripts/stamp-release-installer.mjs"');
    expect(containerFixture).toContain(
      'node "$ROOT_DIR/scripts/build-hosted-release-manifest.mjs"',
    );
    expect(containerFixture).toContain(
      'node "$ROOT_DIR/scripts/privileged-release-evidence.mjs" build',
    );
    expect(containerFixture).toContain(
      'node "$ROOT_DIR/scripts/build-lifecycle-trust-metadata.mjs"',
    );
    expect(containerFixture).toContain(
      'node "$ROOT_DIR/scripts/assemble-lifecycle-generation.mjs"',
    );
    expect(containerFixture).toContain('--runtime-archive "$ARTIFACT_DIR/$x64_app"');
    expect(containerFixture).toContain('--dependency-archive "$ARTIFACT_DIR/$x64_dependency"');
    expect(containerFixture).toContain('node "$ROOT_DIR/scripts/release-artifact-set.mjs" build');
    expect(containerFixture).toContain('--source-ref "refs/tags/v${VERSION}"');
    expect(containerFixture).toContain(
      '"$ARTIFACT_DIR/fased-hosting-candidate.json.attestation.json"',
    );
  });

  it("keeps the managed predecessor runtime inside the root-controlled store", async () => {
    const fixture = await readFile(
      resolve(repoRoot, "scripts/docker/protected-local-systemd/lifecycle-acceptance.sh"),
      "utf8",
    );
    const resolverStart = fixture.indexOf("resolve_predecessor_runtime() {");
    const resolverEnd = fixture.indexOf("\n}", resolverStart);
    expect(resolverStart).toBeGreaterThanOrEqual(0);
    expect(resolverEnd).toBeGreaterThan(resolverStart);
    const resolver = fixture.slice(resolverStart, resolverEnd);
    expect(resolver).toContain('test "$phase" = "managed-update"');
    expect(resolver).toContain('resolve_protected_runtime "$instance"');
    expect(resolver).not.toContain('"$state/runtime/releases/"*');

    expect(fixture).toContain('runtime="$(resolve_predecessor_runtime "$phase" "$instance")"');
    expect(fixture).toContain('runtime="$(resolve_protected_runtime "$instance")"');
  });

  it("keeps stale-session update resolution bound to the exact fixture candidate", async () => {
    const fixture = await readFile(
      resolve(repoRoot, "scripts/docker/protected-local-systemd/lifecycle-acceptance.sh"),
      "utf8",
    );
    const helperStart = fixture.indexOf("run_as_stale_operator() {");
    const helperEnd = fixture.indexOf("\n}", helperStart);
    expect(helperStart).toBeGreaterThanOrEqual(0);
    expect(helperEnd).toBeGreaterThan(helperStart);
    expect(fixture.slice(helperStart, helperEnd)).toContain(
      'npm_config_registry="http://127.0.0.1:$rpc_port"',
    );
    expect(fixture.slice(helperStart, helperEnd)).toContain(
      'FASED_HOSTED_ARTIFACT_BASE_URL="http://127.0.0.1:$rpc_port"',
    );
  });
});
