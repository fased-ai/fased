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
      authorityVersion: 1,
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
      ".github/workflows/hosted-runtime-release.yml",
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

  it("selects T2 and L1, but not L0 or Hosting, for privileged Local update", () => {
    const plan = createGatePlan(["scripts/fased-managed-updater.mjs"], {
      phase: "T3",
      entryPoint: "local-update",
    });

    expect(plan.scope.privilegeChanged).toBe(true);
    expect(plan.scope.runT2Contracts).toBe(true);
    expect(plan.acceptance).toEqual({ L0: false, L1: true, H0: false, H1: false, H2: false });
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
