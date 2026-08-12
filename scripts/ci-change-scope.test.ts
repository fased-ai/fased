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
    expect(classifyChangedPaths(["scripts/fased-managed-updater.mjs"])).toMatchObject({
      runNodeFocused: true,
      runInstallerReleaseVerification: false,
      runNodeBuild: false,
      runLocalUpdate: false,
      runHostingUpdate: false,
    });
    expect(classifyChangedPaths(["install.sh"])).toMatchObject({
      runInstallerReleaseVerification: true,
      runNodeBuild: false,
    });
  });

  it("fails an unknown path and production code without a focused test", () => {
    expect(() => classifyChangedPaths(["new-product/runtime.rs"])).toThrow(/unclassified path/u);
    expect(() => classifyChangedPaths(["src/gateway/server.ts"])).toThrow(
      /no directly changed focused test/u,
    );
  });

  it("recognizes the exact version-only set", () => {
    expect(
      classifyChangedPaths([
        "package.json",
        "src/brand.ts",
        "CHANGELOG.md",
        "extensions/telegram/package.json",
        "extensions/telegram/CHANGELOG.md",
      ]),
    ).toMatchObject({ versionOnly: true, runNode: false });
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
  });

  it("uses the complete matrix only for nightly", () => {
    const plan = classifyChangedPaths([], { fullMatrix: true });
    expect(plan).toMatchObject({
      phase: "nightly",
      fullMatrix: true,
      runNodeFull: true,
      runNodeBuild: true,
      runCodeqlJavascript: true,
      runDocker: true,
      runMacosRuntime: true,
    });
  });
});
