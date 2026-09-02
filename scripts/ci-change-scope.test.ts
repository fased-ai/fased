import { describe, expect, it } from "vitest";
import {
  classifyChangedPaths,
  detectDependencyRemediation,
  outputEntries,
} from "./ci-change-scope.mjs";

describe("lean CI changed-surface classification", () => {
  it("keeps docs and CI contracts out of product work", () => {
    expect(classifyChangedPaths(["docs/reference/ci.md"])).toMatchObject({
      changeKind: "documentation-only",
      runNode: false,
      runCiContracts: false,
      runNodeBuild: false,
      runNodeFull: false,
      runCodeqlJavascript: false,
    });
    expect(
      classifyChangedPaths([".github/workflows/pr.yml", "scripts/ci-change-scope.mjs"]),
    ).toMatchObject({
      changeKind: "ci-infrastructure-only",
      runCiContracts: true,
      runNode: false,
    });
  });

  it("routes directly changed tests without builds or CodeQL", () => {
    const plan = classifyChangedPaths([
      "src/federation/federation-state-permissions.ts",
      "src/federation/federation-state-permissions.test.ts",
    ]);
    expect(plan).toMatchObject({
      selectedTestPaths: ["src/federation/federation-state-permissions.test.ts"],
      runNodeUnit: true,
      runNodeBuild: false,
      runNodeFull: false,
      runCodeqlJavascript: false,
    });
  });

  it("does not route deleted tests as runnable files", () => {
    const plan = classifyChangedPaths(["scripts/removed.test.ts", "scripts/retained.test.ts"], {
      deletedPaths: ["scripts/removed.test.ts"],
    });
    expect(plan).toMatchObject({
      selectedTestPaths: ["scripts/retained.test.ts"],
      runNodeUnit: true,
    });
  });

  it("uses the focused lifecycle lane without candidate work", () => {
    expect(
      classifyChangedPaths(["scripts/npm-free-managed-lifecycle-contract.test.ts"]),
    ).toMatchObject({
      runNodeFocused: true,
      runInstallerReleaseVerification: false,
      runNodeBuild: false,
    });
    expect(classifyChangedPaths(["install.sh"])).toMatchObject({
      runInstallerReleaseVerification: true,
      runNodeBuild: false,
    });
  });

  it("selects platform checks only for their owned paths", () => {
    expect(classifyChangedPaths(["Dockerfile"])).toMatchObject({
      runDocker: true,
      runMacosRuntime: false,
      runMacosApp: false,
    });
    expect(classifyChangedPaths(["apps/macos/Sources/Fased/App.swift"])).toMatchObject({
      runDocker: false,
      runMacosApp: true,
    });
    expect(classifyChangedPaths(["src/daemon/launchd.ts"])).toMatchObject({
      runMacosRuntime: true,
    });
    expect(classifyChangedPaths(["tools/fased-signerd/v2_schema.go"])).toMatchObject({
      runSignerDarwinIntegration: true,
    });
    expect(classifyChangedPaths(["tools/fased-evm-signerd/keystore.go"])).toMatchObject({
      privilegeChanged: true,
      runNativeSigner: true,
      runSignerDarwinIntegration: true,
      runSignerIntegration: true,
    });
    expect(() => classifyChangedPaths(["release/channel-policy.json"])).toThrow(
      /no directly changed focused test/u,
    );
    expect(() => classifyChangedPaths(["deploy/hosting/fly.toml"])).toThrow(
      /no directly changed focused test/u,
    );
    expect(classifyChangedPaths(["docs/launchd.md"])).toMatchObject({
      docsOnly: true,
      runMacosRuntime: false,
    });
    expect(() => classifyChangedPaths(["apps/ios/Sources/App.swift"])).toThrow(
      /mobile-owned change requires a dedicated focused route/u,
    );
  });

  it("fails an unknown path and production code without a focused test", () => {
    expect(() => classifyChangedPaths(["new-product/runtime.rs"])).toThrow(/unclassified path/u);
    expect(() => classifyChangedPaths(["src/gateway/server.ts"])).toThrow(
      /no directly changed focused test/u,
    );
  });

  it("requires release identity changes to include a focused changed surface", () => {
    expect(() =>
      classifyChangedPaths([
        "package.json",
        "src/brand.ts",
        "CHANGELOG.md",
        "extensions/telegram/package.json",
        "extensions/telegram/CHANGELOG.md",
      ]),
    ).toThrow(/no directly changed focused test/u);
  });

  it("keeps dependency remediation bounded", () => {
    const plan = classifyChangedPaths(["package.json", "pnpm-lock.yaml"]);
    const remediation = detectDependencyRemediation(plan, {}, () => ({
      remediations: [{ dependency: "nanoid" }],
    }));
    expect(outputEntries(plan, remediation)).toMatchObject({
      dependency_remediation: "true",
      dependency_names_json: '["nanoid"]',
      run_node_build: "false",
      run_node_full: "false",
      run_codeql_javascript: "false",
    });
    expect(outputEntries(plan, remediation)).not.toHaveProperty("run_platform_bootstrap");
    for (const ghost of [
      "t2_fixture_only",
      "experimental_mobile_changed",
      "run_signer",
      "run_hosting_fresh",
      "run_hosting_update",
    ]) {
      expect(outputEntries(plan, remediation)).not.toHaveProperty(ghost);
    }
  });

  it("uses the complete matrix only for weekly or manual diagnostics", () => {
    const plan = classifyChangedPaths([], { fullMatrix: true });
    expect(plan).toMatchObject({
      phase: "weekly",
      fullMatrix: true,
      runNodeFull: true,
      runNodeBuild: true,
      runCodeqlJavascript: true,
      runDocker: true,
      runMacosRuntime: true,
    });
  });
});
