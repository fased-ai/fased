import { describe, expect, it } from "vitest";
import {
  classifyChangedPaths,
  detectDependencyRemediation,
  isInstallerReleaseVerificationChange,
  outputEntries,
} from "./ci-change-scope.mjs";
import { createGatePlan } from "./gate-authority.mjs";

describe("CI changed-surface classification", () => {
  it("selects the narrow installer release-verification lane only for a function-contained change", () => {
    const before = `prefix\n  root_owned_bundle_tree_is_secure() {\n  }\n    curl -q -fL --proto '=https' --tlsv1.2 "$release_url/fased-privileged-vex-v1.openvex.json" -o "$vex"\n    old hosting verifier\n    local manifest_selection=""\n      echo "Could not download the Local release attestation bundle." >&2\n      return 1\n    fi\n    old local verifier\n    local release_commit=""\nsuffix\n`;
    const after = `prefix\n  verify_release_attestation_source() {\n    corrected shared verifier\n  }\n\n  root_owned_bundle_tree_is_secure() {\n  }\n    curl -q -fL --proto '=https' --tlsv1.2 "$release_url/fased-privileged-vex-v1.openvex.json" -o "$vex"\n    corrected hosting verifier\n    local manifest_selection=""\n      echo "Could not download the Local release attestation bundle." >&2\n      return 1\n    fi\n    corrected local verifier\n    local release_commit=""\nsuffix\n`;
    const paths = [
      ".github/workflows/hosted-runtime-release.yml",
      "docs/maintainers/release-attestations.md",
      "install.sh",
      "scripts/ci-workflow-contract.test.ts",
      "scripts/docker/protected-local-systemd/run.sh",
      "scripts/generation-updater.mjs",
      "scripts/generation-updater.test.ts",
      "scripts/hosted-installer-artifact-layout.test.ts",
      "scripts/install-release-pin.test.ts",
      "scripts/release-artifact-set.mjs",
      "scripts/release-artifact-set.test.ts",
      "scripts/test-protected-local-systemd-container.sh",
    ];

    expect(isInstallerReleaseVerificationChange(paths, before, after)).toBe(true);
    expect(isInstallerReleaseVerificationChange(paths, before, `${after}outside`)).toBe(false);
    expect(isInstallerReleaseVerificationChange([...paths, "src/index.ts"], before, after)).toBe(
      false,
    );
    expect(
      isInstallerReleaseVerificationChange(
        paths.filter((path) => path !== "scripts/generation-updater.test.ts"),
        before,
        after,
      ),
    ).toBe(false);

    const output = outputEntries(createGatePlan(paths, { installerReleaseVerification: true }));
    expect(output).toMatchObject({
      run_installer_release_verification: "true",
      run_node_full: "false",
      run_node_build: "false",
      run_node_focused: "false",
      run_native_signer: "false",
      run_signer_integration: "false",
      run_local_fresh: "false",
      run_local_update: "false",
    });
  });

  it("automatically keeps a narrow updater change on the focused source lane", () => {
    const plan = createGatePlan(["scripts/fased-generation-updater-core.mjs"]);
    const output = outputEntries(plan);

    expect(output).toMatchObject({
      run_node_focused: "true",
      run_node_build: "false",
      run_node_full: "false",
      run_native_signer: "false",
      run_signer_integration: "false",
      run_local_fresh: "false",
      run_local_update: "false",
      run_codeql_javascript: "true",
      run_codeql_go: "false",
      run_codeql_python: "false",
      codeql_languages_json: '["javascript-typescript"]',
    });
  });

  it("routes the version-neutral lifecycle engine through focused Go security checks", () => {
    const plan = createGatePlan([
      "tools/fased-lifecycled/engine/target.go",
      "scripts/build-lifecycle-generation.mjs",
    ]);
    const output = outputEntries(plan);

    expect(output).toMatchObject({
      run_native_signer: "true",
      run_codeql_go: "true",
      run_codeql_javascript: "true",
      run_node_full: "false",
      run_local_update: "false",
      run_hosting_update: "false",
    });
  });

  it("keeps a Local-update PR on source contracts and defers packaged acceptance", () => {
    const plan = createGatePlan(
      [
        "scripts/fased-generation-updater-core.mjs",
        "scripts/generation-updater.mjs",
        "scripts/managed-runtime-layout.mjs",
        "scripts/managed-updater-bundle.v1.json",
      ],
      { phase: "T2" },
    );
    const output = outputEntries(plan);

    expect(output).toMatchObject({
      focused_local_update: "true",
      run_node: "true",
      run_node_focused: "true",
      run_node_build: "false",
      run_node_packaging: "false",
      run_node_full: "false",
      run_local_fresh: "false",
      run_local_update: "false",
      run_t2_contracts: "false",
      run_signer_integration: "false",
      run_macos_runtime: "false",
    });
  });

  it("keeps a release inventory correction on the focused PR lane", () => {
    const output = outputEntries(createGatePlan(["scripts/release-check.ts"]));

    expect(output).toMatchObject({
      focused_local_update: "false",
      run_node_focused: "true",
      run_node_build: "false",
      run_node_packaging: "false",
      run_node_full: "false",
      run_local_update: "false",
      run_hosting_update: "false",
      run_codeql_javascript: "true",
    });
  });

  it("keeps the complete updater and package-inventory diff on the focused PR lane", () => {
    const plan = createGatePlan(
      [
        ".github/workflows/ci.yml",
        "package.json",
        "scripts/ci-change-scope.mjs",
        "scripts/ci-change-scope.test.ts",
        "scripts/fased-generation-updater-core.mjs",
        "scripts/generation-updater.mjs",
        "scripts/gate-authority.mjs",
        "scripts/go-lifecycle-routing.test.ts",
        "scripts/managed-runtime-layout.mjs",
        "scripts/managed-runtime-layout.test.ts",
        "scripts/managed-updater-bundle.test.ts",
        "scripts/managed-updater-bundle.v1.json",
        "scripts/release-check.ts",
      ],
      { phase: "T1" },
    );
    const output = outputEntries(plan);

    expect(output).toMatchObject({
      focused_local_update: "true",
      run_dependency_integrity: "false",
      run_node_focused: "true",
      run_node_build: "false",
      run_node_packaging: "false",
      run_node_full: "false",
      run_signer_integration: "false",
      run_macos_runtime: "false",
      run_local_update: "false",
      run_ci_contracts: "true",
      run_t2_contracts: "false",
      run_codeql_javascript: "true",
    });
  });

  it("routes a content-verified dependency remediation without the full Node suite", () => {
    const plan = createGatePlan(["package.json", "pnpm-lock.yaml"]);
    const remediation = detectDependencyRemediation(plan, {}, () => ({
      remediations: [{ dependency: "nanoid", fromVersion: null, toVersion: "3.3.17" }],
    }));
    const output = outputEntries(plan, remediation);

    expect(output).toMatchObject({
      dependency_remediation: "true",
      dependency_names_json: '["nanoid"]',
      run_dependency_integrity: "true",
      run_node_build: "true",
      run_node_packaging: "false",
      run_node_full: "false",
    });
  });

  it("routes bounded workspace manifests through the same remediation lane", () => {
    const plan = createGatePlan(["package.json", "pnpm-lock.yaml", "ui/package.json"]);
    const remediation = detectDependencyRemediation(plan, {}, () => ({
      remediations: [
        { dependency: "dompurify", fromVersion: "3.4.11", toVersion: "3.4.13" },
        { dependency: "dompurify", fromVersion: "3.4.12", toVersion: "3.4.13" },
      ],
    }));
    const output = outputEntries(plan, remediation);

    expect(output).toMatchObject({
      dependency_remediation: "true",
      dependency_names_json: '["dompurify"]',
      run_node_build: "true",
      run_node_full: "false",
    });
  });

  it("retains broad checks when package changes fail content verification", () => {
    const plan = createGatePlan(["package.json", "pnpm-lock.yaml"]);
    const remediation = detectDependencyRemediation(plan, {}, () => {
      throw new Error("not an exact remediation");
    });
    const output = outputEntries(plan, remediation);

    expect(output).toMatchObject({
      dependency_remediation: "false",
      run_dependency_integrity: "true",
      run_node_build: "true",
      run_node_packaging: "true",
      run_node_full: "true",
    });
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

  it("exports exact changed test paths only for a test-only plan", () => {
    expect(
      outputEntries(
        createGatePlan([
          "src/gateway/server-methods/agent.test.ts",
          "ui/src/ui/views/instances.test.ts",
        ]),
      ),
    ).toMatchObject({
      changed_test_paths_json:
        '["src/gateway/server-methods/agent.test.ts","ui/src/ui/views/instances.test.ts"]',
      changed_ui_browser_tests: "false",
    });
    expect(outputEntries(createGatePlan(["ui/src/ui/views/nodes.browser.test.ts"]))).toMatchObject({
      changed_ui_browser_tests: "true",
    });
    expect(outputEntries(createGatePlan(["src/gateway/server.ts"])).changed_test_paths_json).toBe(
      "[]",
    );
  });

  it("exports the protected exact test for a federation permission correction", () => {
    const plan = createGatePlan([
      "src/federation/federation-state-permissions.ts",
      "src/federation/federation-state-permissions.test.ts",
    ]);
    expect(outputEntries(plan)).toMatchObject({
      changed_test_paths_json: '["src/federation/federation-state-permissions.test.ts"]',
      run_node_unit: "true",
      run_node_full: "false",
      run_node_build: "false",
      run_ui: "false",
      run_node_gateway: "false",
      run_node_extensions: "false",
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
    const paths = [
      "scripts/test-protected-local-systemd-container.sh",
      "scripts/docker/protected-local-systemd/Containerfile.ubuntu",
      "scripts/docker/protected-local-systemd/run.sh",
    ];
    expect(classifyChangedPaths(paths)).toMatchObject({
      ciInfrastructureOnly: false,
      fixtureOnly: true,
      runNode: false,
      runNodeBuild: false,
      runNodeFull: false,
      runHosting: false,
      runLocalFresh: true,
      runLocalUpdate: true,
      runCiContracts: false,
    });
    expect(outputEntries(createGatePlan(paths))).toMatchObject({
      fixture_only: "true",
      production_changed: "false",
      run_node_build: "false",
      run_local_fresh: "false",
      run_local_update: "false",
    });
  });

  it("routes the minimal T2 harness without product build or lifecycle lanes", () => {
    expect(
      classifyChangedPaths([
        "tools/fased-lifecycled/engine/target_test.go",
        "tools/fased-lifecycled/platform/target_adapter_test.go",
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
      "scripts/docker/hosting-systemd/go-cutover.sh",
      "scripts/test-go-hosting-systemd-container.sh",
    ]) {
      expect(classifyChangedPaths([path]), path).toMatchObject({
        fixtureOnly: true,
        runNode: false,
        runNodeBuild: false,
        runNodeFull: false,
        runHosting: true,
        runLocalFresh: false,
        runLocalUpdate: false,
        runUiMining: false,
      });
      expect(outputEntries(createGatePlan([path])), path).toMatchObject({
        fixture_only: "true",
        production_changed: "false",
        run_hosting: "false",
        run_hosting_fresh: "false",
        run_hosting_update: "false",
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
      runUi: true,
      runUiMining: false,
    });
    expect(classifyChangedPaths(["ui/src/ui/views/wallet.ts"])).toMatchObject({
      runNode: true,
      runUiMining: false,
    });
  });

  it("routes generated and handwritten macOS application changes to the supported app lane", () => {
    expect(
      classifyChangedPaths(["apps/macos/Sources/FasedAgentProtocol/Generated.swift"]),
    ).toMatchObject({
      runMacosApp: true,
    });
    expect(classifyChangedPaths(["apps/macos/Sources/App/Main.swift"])).toMatchObject({
      runMacosApp: true,
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
    expect(scope.runMacosApp).toBe(false);
  });

  it("keeps native Windows absent and mobile previews outside routine platform lanes", () => {
    const ios = classifyChangedPaths(["apps/ios/Sources/App/Main.swift"]);
    expect(ios).toMatchObject({
      changeKind: "experimental-mobile",
      experimentalMobileChanged: true,
      runMacosRuntime: false,
      runMacosApp: false,
    });
    expect(classifyChangedPaths(["src/daemon/launchd.ts"])).toMatchObject({
      runMacosRuntime: true,
      runMacosApp: false,
    });
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
        runMacosRuntime: true,
        runMacosApp: true,
        runUi: true,
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
