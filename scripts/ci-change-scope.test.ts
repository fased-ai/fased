import { describe, expect, it } from "vitest";
import {
  assertExpectedPlanDigest,
  classifyChangedPaths,
  outputEntries,
} from "./ci-change-scope.mjs";
import { createGatePlan } from "./gate-authority.mjs";

describe("CI changed-surface classification", () => {
  it("serializes granular Node, signer, Docker, bootstrap, and CodeQL outputs", () => {
    const plan = createGatePlan(["scripts/protected-local-bootstrap.mjs"], {
      entryPoint: "local-update",
    });
    const output = outputEntries(plan);

    expect(output).toMatchObject({
      run_node_focused: "true",
      run_node_build: "true",
      run_node_full: "false",
      run_native_signer: "false",
      run_signer_integration: "true",
      run_local_fresh: "false",
      run_local_update: "true",
      run_codeql_javascript: "true",
      run_codeql_go: "false",
      run_codeql_python: "false",
      codeql_languages_json: '["javascript-typescript"]',
    });
  });

  it("rejects a trusted private route bound to a different public plan", () => {
    const plan = createGatePlan(["scripts/protected-local-bootstrap.mjs"], {
      entryPoint: "local-update",
    });
    expect(() => assertExpectedPlanDigest(plan, plan.planDigest)).not.toThrow();
    expect(() => assertExpectedPlanDigest(plan, `sha256:${"0".repeat(64)}`)).toThrow(
      /trusted route plan digest mismatch/u,
    );
  });

  it("keeps documentation-only changes lightweight", () => {
    expect(classifyChangedPaths(["docs/start/install.md", "README.md"])).toMatchObject({
      docsOnly: true,
      docsChanged: true,
      versionOnly: false,
      runNode: false,
      runSigner: false,
      runHosting: false,
      runLocalFresh: false,
      runLocalUpdate: false,
      runCiContracts: false,
      runUiMining: false,
    });
  });

  it("recognizes the exact release-version file set", () => {
    expect(
      classifyChangedPaths([
        "package.json",
        "src/brand.ts",
        "CHANGELOG.md",
        "extensions/telegram/package.json",
        "extensions/telegram/CHANGELOG.md",
      ]),
    ).toMatchObject({
      docsOnly: false,
      docsChanged: true,
      versionOnly: true,
      runNode: false,
      runSigner: false,
      runHosting: false,
      runLocalFresh: false,
      runLocalUpdate: false,
      runCiContracts: false,
      runUiMining: false,
    });
  });

  it("runs only narrow contract checks for CI-routing infrastructure", () => {
    expect(
      classifyChangedPaths([
        ".github/workflows/ci.yml",
        "scripts/ci-change-scope.mjs",
        "scripts/ci-change-scope.test.ts",
        "scripts/ci-merged-main-reuse.mjs",
        "scripts/ci-merged-main-reuse.test.ts",
        "scripts/ci-required-gates.mjs",
        "scripts/ci-required-gates.test.ts",
        "scripts/ci-workflow-contract.test.ts",
      ]),
    ).toMatchObject({
      ciInfrastructureOnly: true,
      runNode: false,
      runSigner: false,
      runHosting: false,
      runLocalFresh: false,
      runLocalUpdate: false,
      runCiContracts: true,
      runUiMining: false,
    });
  });

  it("routes Protected Local fixture changes without running Hosting", () => {
    expect(
      classifyChangedPaths([
        "scripts/test-protected-local-systemd-container.sh",
        "scripts/docker/protected-local-systemd/Containerfile.ubuntu",
        "scripts/docker/protected-local-systemd/run.sh",
      ]),
    ).toMatchObject({
      ciInfrastructureOnly: false,
      runNode: true,
      runHosting: false,
      runLocalFresh: true,
      runLocalUpdate: true,
      runCiContracts: false,
    });
  });

  it("routes the minimal T2 harness without product build or lifecycle lanes", () => {
    expect(
      classifyChangedPaths([
        "scripts/protected-local-t2-controller-worker.mjs",
        "scripts/protected-local-t2-supervisor-worker.mjs",
        "scripts/protected-local-t2-systemd-fixture.mjs",
        "scripts/protected-local-t2-systemd.test.ts",
        "scripts/test-protected-local-t2-systemd.sh",
      ]),
    ).toMatchObject({
      changeKind: "t2-fixture-only",
      t2FixtureOnly: true,
      runT2Contracts: true,
      runNode: false,
      runSigner: false,
      runHosting: false,
      runLocalFresh: false,
      runLocalUpdate: false,
    });
  });

  it("reuses green PR checks only for a separately proven merged-main tree", () => {
    expect(
      classifyChangedPaths(["src/gateway/server.ts"], {
        reusePrChecks: true,
      }),
    ).toMatchObject({
      reusePrChecks: true,
      runNode: false,
      runSigner: false,
      runHosting: false,
      runLocalFresh: false,
      runLocalUpdate: false,
      fullMatrix: false,
    });
  });

  it("rejects a version-only classification when source code is mixed in", () => {
    expect(
      classifyChangedPaths(["package.json", "src/brand.ts", "src/gateway/server.ts"]),
    ).toMatchObject({
      versionOnly: false,
      runNode: true,
    });
  });

  it("separates Hosting, Local fresh, and Local update lifecycle paths", () => {
    for (const path of [
      "scripts/docker/streamed-hosting-bootstrap/run.sh",
      "scripts/docker/hosting-systemd/run.sh",
      "scripts/test-hosting-systemd-container.sh",
    ]) {
      expect(classifyChangedPaths([path]), path).toMatchObject({
        runNode: true,
        runHosting: true,
        runLocalFresh: false,
        runLocalUpdate: false,
        runUiMining: false,
      });
    }

    expect(classifyChangedPaths(["scripts/fased-host-updater.mjs"])).toMatchObject({
      runNode: true,
      runHosting: true,
      runLocalFresh: false,
      runLocalUpdate: true,
      runUiMining: false,
    });

    expect(classifyChangedPaths(["scripts/fased-managed-updater.mjs"])).toMatchObject({
      runHosting: true,
      runLocalFresh: false,
      runLocalUpdate: true,
    });
    expect(classifyChangedPaths(["scripts/protected-local-bootstrap.mjs"])).toMatchObject({
      runHosting: false,
      runLocalFresh: true,
      runLocalUpdate: true,
    });
    expect(classifyChangedPaths(["src/wizard/onboarding.ts"])).toMatchObject({
      runHosting: true,
      runLocalFresh: true,
      runLocalUpdate: false,
    });
    expect(classifyChangedPaths(["install.sh"])).toMatchObject({
      runHosting: true,
      runLocalFresh: true,
      runLocalUpdate: true,
    });
    expect(classifyChangedPaths(["src/agents/agent.ts"])).toMatchObject({
      runNode: true,
      runHosting: false,
      runLocalFresh: false,
      runLocalUpdate: false,
    });
  });

  it("does not turn documentation contract files into a full Node run", () => {
    expect(classifyChangedPaths(["scripts/docs-product-contract.mjs"])).toMatchObject({
      docsOnly: true,
      docsChanged: true,
      runNode: false,
    });
  });

  it("runs Mining browser checks only for Mining-facing paths", () => {
    expect(classifyChangedPaths(["ui/src/ui/views/mining.ts"])).toMatchObject({
      runNode: true,
      runUiMining: true,
    });
    expect(classifyChangedPaths(["ui/src/ui/views/wallet.ts"])).toMatchObject({
      runNode: true,
      runUiMining: false,
    });
  });

  it("keeps generated signer protocol changes off the macOS app lane", () => {
    expect(
      classifyChangedPaths(["apps/macos/Sources/FasedAgentProtocol/Generated.swift"]),
    ).toMatchObject({
      runMacos: false,
    });
    expect(classifyChangedPaths(["apps/macos/Sources/App/Main.swift"])).toMatchObject({
      runMacos: true,
    });
  });

  it.each([
    "install.sh",
    "scripts/fased-managed-updater.mjs",
    "scripts/protected-local-bootstrap.mjs",
    "scripts/install-managed-runtime.mjs",
    "src/wallet/native-signer-operator-client.ts",
    "src/wallet/providers/local-socket-signer-adapter.ts",
    "src/wizard/onboarding.wallet.ts",
  ])("runs native signer platforms for Local lifecycle change %s", (changedPath) => {
    const scope = classifyChangedPaths([changedPath]);

    expect(scope.runSigner).toBe(true);
    expect(scope.runMacos).toBe(false);
  });

  it("enables every supported lane for a manual full matrix or failed diff", () => {
    for (const scope of [
      classifyChangedPaths([], { fullMatrix: true }),
      classifyChangedPaths([], { unknown: true }),
    ]) {
      expect(scope).toMatchObject({
        docsOnly: false,
        versionOnly: false,
        runNode: true,
        runMacos: true,
        runSigner: true,
        runHosting: true,
        runLocalFresh: true,
        runLocalUpdate: true,
        runCiContracts: true,
        runUiMining: true,
        runSkills: true,
        fullMatrix: true,
      });
    }
  });
});
