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
      authorityVersion: 5,
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
      ".pre-commit-config.yaml",
      ".secrets.baseline",
      ".github/workflows/ci.yml",
      ".github/workflows/docker-release.yml",
      ".github/workflows/hosted-runtime-release.yml",
      "scripts/release-artifact-set.mjs",
      "scripts/release-artifact-set.test.ts",
      "scripts/hosted-installer-artifact-layout.test.ts",
      "scripts/gate-authority.mjs",
      "scripts/gate-authority.test.ts",
      "scripts/ci-run-changed-tests.mjs",
      "scripts/ci-run-changed-tests.test.ts",
      "ui/vitest.changed-node.config.ts",
      "docs/reference/ci.md",
      "AGENTS.md",
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
      runDocker: false,
      runCodeqlJavascript: false,
      runCodeqlGo: false,
      runCodeqlPython: false,
    });
    expect(plan.acceptance).toEqual({ L0: false, L1: false, H0: false, H1: false, H2: false });
  });

  it("routes lifecycle compatibility evidence without product or full Node lanes", () => {
    const plan = createGatePlan([
      "config/lifecycle-compatibility.v1.json",
      "scripts/lifecycle-compatibility-inventory.test.ts",
    ]);
    expect(plan.changeKind).toBe("ci-infrastructure-only");
    expect(plan.scope).toMatchObject({
      ciInfrastructureOnly: true,
      productionChanged: false,
      runCiContracts: true,
      runNode: false,
      runNodeBuild: false,
      runNodeFull: false,
      runLocalFresh: false,
      runLocalUpdate: false,
      runHosting: false,
    });
  });

  it("routes the packaged public-acquisition fixture through CI contracts only", () => {
    const plan = createGatePlan([
      "scripts/docker/protected-local-systemd/run.sh",
      "scripts/gate-authority.test.ts",
      "scripts/hosted-installer-artifact-layout.test.ts",
      "scripts/gate-authority.mjs",
    ]);

    expect(plan.changeKind).toBe("ci-infrastructure-only");
    expect(plan.scope).toMatchObject({
      ciInfrastructureOnly: true,
      productionChanged: false,
      runCiContracts: true,
      runNode: false,
      runNodeBuild: false,
      runNodeFull: false,
      runT2Contracts: false,
      runLocalFresh: false,
      runLocalUpdate: false,
      runHosting: false,
    });
  });

  it("keeps mixed lifecycle fixture and authority corrections source-only", () => {
    const plan = createGatePlan(
      [
        ".github/workflows/ci.yml",
        "config/lifecycle-compatibility.v1.json",
        "scripts/docker/protected-local-systemd/run.sh",
        "scripts/gate-authority.mjs",
      ],
      { phase: "T1", entryPoint: "local-update" },
    );
    expect(plan.changeKind).toBe("gate-tooling-only");
    expect(plan.scope).toMatchObject({
      productionChanged: false,
      privilegeChanged: false,
      runCiContracts: true,
      runNode: false,
      runNodeBuild: false,
      runNodeFull: false,
      runCodeqlJavascript: false,
      runLocalFresh: false,
      runLocalUpdate: true,
      runHosting: false,
    });
  });

  it("does not let an accompanying test broaden a production change", () => {
    const withoutTest = createGatePlan(["src/gateway/server.ts"]);
    const withTest = createGatePlan([
      "src/gateway/server.ts",
      "src/gateway/server-methods/agent.test.ts",
    ]);

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

  it("routes the root host updater through focused Node coverage", () => {
    const plan = createGatePlan(["scripts/fased-host-updater.mjs"], {
      phase: "T1",
      entryPoint: "local-update",
    });

    expect(plan.scope).toMatchObject({
      runNodeFocused: true,
      runNodeBuild: true,
      runNodeFull: false,
      runT2Contracts: true,
      runLocalUpdate: true,
    });
  });

  it("routes the unified updater contract and bundle through focused Node coverage", () => {
    const plan = createGatePlan([
      "package.json",
      "scripts/fased-managed-updater-core.mjs",
      "scripts/managed-runtime-layout.mjs",
      "scripts/managed-update-contract.mjs",
      "scripts/managed-updater-bundle.v1.json",
    ]);

    expect(plan.scope).toMatchObject({
      runNodeFocused: true,
      runNodeBuild: true,
      runNodePackaging: true,
      runNodeFull: false,
      runT2Contracts: true,
      runLocalUpdate: true,
      runHostingUpdate: true,
    });
  });

  it("routes a release inventory correction through focused Node coverage", () => {
    const plan = createGatePlan(["scripts/release-check.ts"]);

    expect(plan.scope).toMatchObject({
      privilegeChanged: false,
      runNodeFocused: true,
      runNodeBuild: true,
      runNodeFull: false,
      runLocalUpdate: false,
      runHostingUpdate: false,
    });
  });

  it("routes the complete focused Local-update correction without L0, native signer, or Docker", () => {
    const plan = createGatePlan(
      [
        "scripts/fased-lifecycle-supervisor.mjs",
        "scripts/fased-managed-updater-core.mjs",
        "scripts/fased-local-recovery-pending.test.ts",
        "scripts/protected-local-bootstrap.mjs",
        "scripts/protected-local-bootstrap.test.ts",
        "scripts/protected-local-service-plan.mjs",
        "scripts/protected-local-service-plan.test.ts",
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
      H0: true,
      H1: true,
      H2: true,
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

  it("keeps CI-only Docker workflow edits out of product Docker validation", () => {
    const plan = createGatePlan([".github/workflows/docker-release.yml"]);
    expect(plan.scope).toMatchObject({
      ciInfrastructureOnly: true,
      runCiContracts: true,
      runDocker: false,
    });
  });

  it("routes Dependabot policy through CI contracts without product lanes", () => {
    const plan = createGatePlan([".github/dependabot.yml"]);
    expect(plan.changeKind).toBe("ci-infrastructure-only");
    expect(plan.scope).toMatchObject({
      ciInfrastructureOnly: true,
      productionChanged: false,
      runCiContracts: true,
      runNode: false,
      runNodeBuild: false,
      runNodeFull: false,
      runDocker: false,
      runHosting: false,
      runLocalFresh: false,
      runLocalUpdate: false,
    });
  });

  it("keeps CI-only authority edits out of production CodeQL", () => {
    const plan = createGatePlan(["scripts/ci-change-scope.mjs"]);
    expect(plan.scope).toMatchObject({
      ciInfrastructureOnly: true,
      runCiContracts: true,
      runCodeqlJavascript: false,
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
    expect(createGatePlan(["scripts/docker/protected-local-systemd/run.sh"]).scope).toMatchObject({
      fixtureOnly: true,
      productionChanged: false,
      runNode: false,
      runNodeBuild: false,
      runNodeFull: false,
      runCodeqlJavascript: false,
      runDocker: false,
      runLocalFresh: true,
      runLocalUpdate: true,
    });
  });

  it("routes a lifecycle fixture with its exact regression test", () => {
    expect(
      createGatePlan([
        "scripts/docker/protected-local-systemd/run.sh",
        "scripts/managed-update-mode.test.ts",
      ]),
    ).toMatchObject({
      changeKind: "ci-infrastructure-only",
      scope: {
        ciInfrastructureOnly: true,
        productionChanged: false,
        runCiContracts: true,
        runNode: false,
        runNodeFull: false,
        runDocker: false,
      },
    });
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

  it("routes test-only changes to real subsystem tests without building", () => {
    expect(createGatePlan(["src/config/io.plugin-allowlist-repair.test.ts"]).scope).toMatchObject({
      testOnly: true,
      runNode: true,
      runNodeUnit: true,
      runNodeGateway: false,
      runNodeExtensions: false,
      runNodeBuild: false,
      runNodeFull: false,
      runCodeqlJavascript: false,
    });
    expect(createGatePlan(["src/gateway/server-methods/agent.test.ts"]).scope).toMatchObject({
      runNodeGateway: true,
      runNodeFull: false,
    });
    expect(createGatePlan(["extensions/telegram/src/channel.test.ts"]).scope).toMatchObject({
      runNodeExtensions: true,
      runNodeFull: false,
    });
    expect(createGatePlan(["ui/src/ui/navigation.test.ts"]).scope).toMatchObject({
      runUi: true,
      runNodeBuild: false,
      runNodeFull: false,
    });
  });

  it("routes UI tests that declare the installed jsdom environment", () => {
    const plan = createGatePlan(["ui/src/ui/app-chat.test.ts"]);
    expect(plan.scope).toMatchObject({
      testOnly: true,
      runUi: true,
      runNode: true,
      runNodeBuild: false,
      runNodeFull: false,
    });
    expect(plan.manualReviewRequired).toBe(false);
  });

  it("blocks test-looking files outside supported exact lanes with a precise error", () => {
    for (const path of [
      "apps/ios/Sources/App.test.ts",
      "vendor/example.test.ts",
      "packages/sdk/src/io.test.ts",
      "tests/io.test.ts",
      "src/config/io.spec.ts",
    ]) {
      expect(() => createGatePlan([path]), path).toThrow(
        /gate authority: classification blocked: no automatic test lane/u,
      );
    }
  });

  it("routes UI and supported macOS surfaces without unsupported platform lanes", () => {
    expect(createGatePlan(["ui/src/ui/views/wallet.ts"]).scope).toMatchObject({
      runUi: true,
      runNodeBuild: false,
      runNodeFull: false,
      runCodeqlJavascript: true,
    });
    expect(createGatePlan(["src/daemon/launchd.ts"]).scope).toMatchObject({
      runMacosRuntime: true,
      runMacosApp: false,
    });
    expect(createGatePlan(["apps/macos/Sources/App/Main.swift"]).scope).toMatchObject({
      runMacosRuntime: false,
      runMacosApp: true,
      experimentalMobileChanged: false,
    });
    const mobile = createGatePlan(["apps/ios/Sources/App/Main.swift"]);
    expect(mobile.changeKind).toBe("experimental-mobile");
    expect(mobile.manualReviewRequired).toBe(false);
    expect(mobile.scope).toMatchObject({
      runMacosRuntime: false,
      runMacosApp: false,
      experimentalMobileChanged: true,
    });
  });

  it("fails closed for a new unclassified production root", () => {
    expect(() => createGatePlan(["new-product/runtime.rs"])).toThrow(
      'gate authority: classification blocked: unclassified production paths ["new-product/runtime.rs"]',
    );
  });

  it("fails closed for unknown source types nested under known directories", () => {
    for (const path of [
      "src/new-security-boundary/config.xyz",
      "scripts/new-production-daemon.rb",
    ]) {
      expect(() => createGatePlan([path]), path).toThrow(
        /gate authority: classification blocked: unclassified production paths/u,
      );
    }
  });

  it("does not treat lookalike CI files as trusted CI infrastructure", () => {
    for (const path of ["scripts/gate-authority.mjs.evil", ".github/workflows/ci.yml.backup"]) {
      expect(() => createGatePlan([path]), path).toThrow(
        /gate authority: classification blocked: unclassified production paths/u,
      );
    }
  });

  it("routes known multi-entry-point changes automatically", () => {
    const plan = createGatePlan(["install.sh"]);
    expect(plan.affectedEntryPoints).toEqual([
      "local-fresh",
      "local-update",
      "hosting-fresh",
      "hosting-update",
    ]);
    expect(plan.manualReviewRequired).toBe(false);
  });

  it("automatically falls back to the full supported matrix when path evidence is missing", () => {
    expect(createGatePlan([]).scope.fullMatrix).toBe(true);
    expect(createGatePlan([]).manualReviewRequired).toBe(false);
    expect(createGatePlan([], { fullMatrix: true }).manualReviewRequired).toBe(false);
  });

  it("routes shared Local updater code through the supported macOS runtime lane", () => {
    for (const path of [
      "scripts/fased-managed-updater.mjs",
      "scripts/install-managed-runtime.mjs",
      "src/cli/daemon-cli/install.ts",
      "src/commands/daemon-install-helpers.ts",
      "src/commands/doctor-platform-notes.ts",
      "src/daemon/runtime-paths.ts",
      "src/infra/update-runner.ts",
    ]) {
      expect(createGatePlan([path]).scope.runMacosRuntime).toBe(true);
    }
  });

  it("routes the composite-action interpolation verifier through CI contracts", () => {
    const plan = createGatePlan(["scripts/check-composite-action-input-interpolation.py"]);
    expect(plan.changeKind).toBe("ci-infrastructure-only");
    expect(plan.manualReviewRequired).toBe(false);
    expect(plan.scope).toMatchObject({
      ciInfrastructureOnly: true,
      runCiContracts: true,
      runCodeqlPython: false,
    });
  });

  it("keeps Docker conditional during broad supported-platform runs", () => {
    expect(createGatePlan([], { fullMatrix: true }).scope.runDocker).toBe(false);
    expect(createGatePlan(["Dockerfile"]).scope.runDocker).toBe(true);
  });
});
