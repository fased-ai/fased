import { describe, expect, it } from "vitest";
import { createGatePlan } from "./gate-authority.mjs";

const t2FixturePaths = [
  "scripts/protected-local-t2-controller-worker.mjs",
  "scripts/protected-local-t2-supervisor-worker.mjs",
  "scripts/protected-local-t2-systemd-fixture.mjs",
  "scripts/protected-local-t2-systemd.test.ts",
  "scripts/test-protected-local-t2-systemd.sh",
];

describe("machine gate authority", () => {
  it("routes the exact T2 harness to contracts without product lanes", () => {
    const plan = createGatePlan(t2FixturePaths, { phase: "T2" });

    expect(plan).toMatchObject({
      authorityVersion: 2,
      phase: "T2",
      entryPoints: [],
      changeKind: "t2-fixture-only",
      manualReviewRequired: false,
      scope: {
        t2FixtureOnly: true,
        testOnly: true,
        fixtureOnly: true,
        productionChanged: false,
        runT2Contracts: true,
        runNode: false,
        runSigner: false,
        runHosting: false,
        runLocalFresh: false,
        runLocalUpdate: false,
      },
      acceptance: { L0: false, L1: false, H0: false, H1: false, H2: false },
    });
    expect(plan.planDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("keeps gate-authority plus T2-harness edits out of product lanes", () => {
    const plan = createGatePlan([...t2FixturePaths, "scripts/gate-authority.mjs"], {
      phase: "T2",
    });

    expect(plan.changeKind).toBe("gate-tooling-only");
    expect(plan.scope).toMatchObject({
      productionChanged: false,
      runCiContracts: true,
      runT2Contracts: true,
      runNode: false,
      runSigner: false,
      runHosting: false,
      runLocalFresh: false,
      runLocalUpdate: false,
    });
    expect(plan.acceptance).toEqual({ L0: false, L1: false, H0: false, H1: false, H2: false });
  });

  it("routes exact release promotion infrastructure without product lifecycle lanes", () => {
    const plan = createGatePlan([
      ".github/workflows/ci.yml",
      ".github/workflows/docker-release.yml",
      ".github/workflows/hosted-runtime-release.yml",
      "scripts/ci-private-route-status.mjs",
      "scripts/ci-private-route-status.test.ts",
      "scripts/release-artifact-set.mjs",
      "scripts/release-artifact-set.test.ts",
      "scripts/verify-release-gate-status.mjs",
      "scripts/verify-release-gate-status.test.ts",
      "scripts/gate-authority.mjs",
      "scripts/gate-authority.test.ts",
    ]);

    expect(plan.changeKind).toBe("ci-infrastructure-only");
    expect(plan.scope).toMatchObject({
      ciInfrastructureOnly: true,
      productionChanged: false,
      privilegeChanged: false,
      runCiContracts: true,
      runT2Contracts: false,
      runNode: false,
      runSigner: false,
      runHosting: false,
      runLocalFresh: false,
      runLocalUpdate: false,
    });
    expect(plan.acceptance).toEqual({ L0: false, L1: false, H0: false, H1: false, H2: false });
  });

  it("does not let an accompanying test broaden a production change", () => {
    const withoutTest = createGatePlan(["src/gateway/server.ts"]);
    const withTest = createGatePlan(["src/gateway/server.ts", "src/gateway/server.test.ts"]);

    expect(withTest.productionPaths).toEqual(["src/gateway/server.ts"]);
    expect(withTest.scope).toEqual(withoutTest.scope);
  });

  it("selects only L0 for the Local fresh entry point", () => {
    const plan = createGatePlan(["install.sh"], {
      phase: "T3",
      entryPoint: "local-fresh",
    });

    expect(plan.entryPoints).toEqual(["local-fresh"]);
    expect(plan.acceptance).toEqual({ L0: true, L1: false, H0: false, H1: false, H2: false });
  });

  it("selects T2 and L1, but keeps broad Node coverage for a non-allowlisted updater", () => {
    const plan = createGatePlan(["scripts/fased-managed-updater.mjs"], {
      phase: "T3",
      entryPoint: "local-update",
    });

    expect(plan.scope.privilegeChanged).toBe(true);
    expect(plan.scope.runT2Contracts).toBe(true);
    expect(plan.scope).toMatchObject({
      runNodeFocused: false,
      runNodeBuild: true,
      runNodePackaging: false,
      runNodeFull: true,
      runNativeSigner: false,
      runSignerIntegration: true,
      runPlatformBootstrap: false,
      runDocker: false,
      runCodeqlJavascript: true,
      runCodeqlGo: false,
      runCodeqlPython: false,
    });
    expect(plan.acceptance).toEqual({ L0: false, L1: true, H0: false, H1: false, H2: false });
  });

  it("routes the complete focused Local-update correction without L0, native signer, or Docker", () => {
    const plan = createGatePlan(
      [
        "scripts/protected-local-bootstrap.mjs",
        "scripts/protected-local-bootstrap.test.ts",
        "scripts/protected-local-supervisor-client-root-fixture.mjs",
        "scripts/test-protected-local-supervisor-client-root-fixture.sh",
        "src/wallet/wallet-runtime-config.ts",
        "src/wallet/wallet-application-state-permissions.test.ts",
      ],
      { phase: "T1", entryPoint: "local-update" },
    );

    expect(plan.scope).toMatchObject({
      runNodeFocused: true,
      runNodeBuild: true,
      runNodePackaging: false,
      runNodeFull: false,
      runNativeSigner: false,
      runSignerIntegration: true,
      runPlatformBootstrap: false,
      runDocker: false,
      runCodeqlJavascript: true,
      runCodeqlGo: false,
      runCodeqlPython: false,
      runT2Contracts: true,
      runLocalFresh: false,
      runLocalUpdate: true,
      runHosting: false,
    });
    expect(plan.acceptance).toEqual({ L0: false, L1: true, H0: false, H1: false, H2: false });
    expect(plan.affectedAcceptance).toEqual({
      L0: true,
      L1: true,
      H0: false,
      H1: false,
      H2: false,
    });
  });

  it("routes native signer changes through native and JavaScript integration independently", () => {
    const native = createGatePlan(["tools/fased-signerd/main.go"]);
    expect(native.scope).toMatchObject({
      runNode: false,
      runNodeBuild: false,
      runNodeFull: false,
      runSigner: true,
      runNativeSigner: true,
      runSignerIntegration: true,
      runCodeqlGo: true,
      runCodeqlJavascript: false,
    });

    const integration = createGatePlan(["scripts/protected-local-bootstrap.mjs"], {
      entryPoint: "local-update",
    });
    expect(integration.scope).toMatchObject({
      runSigner: true,
      runNativeSigner: false,
      runSignerIntegration: true,
      runSignerDarwinIntegration: false,
    });
  });

  it("routes Python without the Node matrix", () => {
    const plan = createGatePlan(["skills/example/tool.py"]);
    expect(plan.scope).toMatchObject({
      runNode: false,
      runNodeBuild: false,
      runNodeFull: false,
      runSkills: true,
      runCodeqlPython: true,
      runCodeqlJavascript: false,
    });
  });

  it("runs Docker validation when the Docker workflow itself changes", () => {
    const plan = createGatePlan([".github/workflows/docker-release.yml"]);
    expect(plan.scope).toMatchObject({
      ciInfrastructureOnly: true,
      runCiContracts: true,
      runDocker: true,
    });
  });

  it("runs JavaScript CodeQL for non-test CI authority code", () => {
    const plan = createGatePlan(["scripts/ci-private-route-status.mjs"]);
    expect(plan.scope).toMatchObject({
      ciInfrastructureOnly: true,
      runCiContracts: true,
      runCodeqlJavascript: true,
      runNodeFull: false,
    });
  });

  it("selects package, platform-bootstrap, Docker, and CodeQL lanes independently", () => {
    expect(createGatePlan(["package.json", "pnpm-lock.yaml"]).scope).toMatchObject({
      runNodeBuild: true,
      runNodePackaging: true,
      runNodeFull: true,
      runDocker: false,
    });
    expect(createGatePlan(["install.sh"], { entryPoint: "local-fresh" }).scope).toMatchObject({
      runPlatformBootstrap: true,
      runLocalFresh: true,
      runLocalUpdate: false,
    });
    expect(createGatePlan(["Dockerfile"]).scope).toMatchObject({
      runDocker: true,
    });
    expect(createGatePlan(["skills/example/tool.py"]).scope).toMatchObject({
      runCodeqlJavascript: false,
      runCodeqlGo: false,
      runCodeqlPython: true,
    });
  });

  it("does not mistake lifecycle container fixtures for product Docker changes", () => {
    expect(createGatePlan(["scripts/docker/protected-local-systemd/run.sh"]).scope.runDocker).toBe(
      false,
    );
  });

  it("keeps fresh Hosting H1 independent from existing Hosting H2", () => {
    const plan = createGatePlan(["install.sh"], {
      phase: "T3",
      entryPoint: "hosting-fresh",
    });

    expect(plan.acceptance).toEqual({ L0: false, L1: false, H0: true, H1: true, H2: false });
  });

  it("keeps existing Hosting H2 independent from fresh Hosting H1", () => {
    const plan = createGatePlan(["scripts/fased-host-updater.mjs"], {
      phase: "T3",
      entryPoint: "hosting-update",
    });

    expect(plan.acceptance).toEqual({ L0: false, L1: false, H0: true, H1: false, H2: true });
  });
});
