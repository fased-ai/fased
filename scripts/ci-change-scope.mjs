#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { verifyRepositoryDependencyRemediation } from "./ci-dependency-integrity.mjs";

const laneManifest = Object.freeze({
  schemaVersion: 1,
  unknownPathPolicy: "reject",
  prForbiddenWork: ["build", "packaging", "full-node", "codeql", "docker", "macos", "candidate"],
  lanes: [
    {
      id: "documentation",
      prefixes: ["docs/", "changelog/"],
      suffixes: [".md", ".mdx"],
    },
    {
      id: "ci-contract",
      prefixes: [".github/", "git-hooks/"],
      exact: [".pre-commit-config.yaml", ".secrets.baseline", "zizmor.yml"],
      contains: ["ci-", "lifecycle-acceptance", "lifecycle-compatibility"],
    },
    {
      id: "lifecycle",
      prefixes: ["tools/fased-lifecycled/"],
      exact: [
        "install.sh",
        "scripts/fased-generation-updater-core.mjs",
        "scripts/generation-updater.mjs",
        "scripts/managed-runtime-layout.mjs",
        "scripts/managed-updater-bundle.mjs",
        "scripts/managed-updater-bundle.v1.json",
      ],
    },
    {
      id: "signer",
      prefixes: ["tools/fased-signerd/"],
      contains: ["signer"],
    },
    {
      id: "ui",
      prefixes: ["ui/"],
    },
    {
      id: "native",
      prefixes: ["apps/", "Swabble/", "shared/"],
      exact: ["appcast.xml"],
    },
    {
      id: "container",
      prefixes: ["deploy/", "release/"],
      exact: ["Dockerfile", "docker-compose.yml", "docker-setup.sh", "setup-podman.sh"],
    },
    {
      id: "skills",
      prefixes: ["skills/"],
    },
    {
      id: "tests",
      prefixes: ["test/", "fixtures/"],
      contains: [".test.", ".spec."],
      suffixes: ["_test.go"],
    },
    {
      id: "node",
      prefixes: ["src/", "extensions/", "packages/", "scripts/", "token/"],
      exact: [
        "fased.mjs",
        "package.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        "tsconfig.json",
        "tsconfig.plugin-sdk.dts.json",
        "tsdown.config.ts",
        "tsdown.plugin-sdk-dts.config.ts",
        "vitest.browser-cdp.config.ts",
        "vitest.config.ts",
        "vitest.e2e.config.ts",
        "vitest.extensions.config.ts",
        "vitest.gateway.config.ts",
        "vitest.live.config.ts",
        "vitest.loopback.config.ts",
        "vitest.unit.config.ts",
      ],
    },
    {
      id: "repository",
      prefixes: ["assets/", "config/", "tools/", "vendor/"],
      exact: [
        "AGENTS.md",
        "CONTRIBUTING.md",
        "LICENSE",
        "README.md",
        "SECURITY.md",
        "THIRD_PARTY_NOTICES.md",
        "pyproject.toml",
      ],
    },
  ],
});

function normalizePath(value) {
  return String(value ?? "")
    .trim()
    .replaceAll("\\", "/");
}

function matchesLane(path, lane) {
  return (
    lane.exact?.includes(path) === true ||
    lane.prefixes?.some((prefix) => path.startsWith(prefix)) === true ||
    lane.suffixes?.some((suffix) => path.endsWith(suffix)) === true ||
    lane.contains?.some((part) => path.includes(part)) === true
  );
}

export function validateLaneManifest(value = laneManifest) {
  if (value?.schemaVersion !== 1 || value?.unknownPathPolicy !== "reject") {
    throw new Error("ci-change-scope: unsupported lane manifest contract");
  }
  if (!Array.isArray(value.lanes) || value.lanes.length === 0) {
    throw new Error("ci-change-scope: at least one lane is required");
  }
  const ids = new Set();
  for (const lane of value.lanes) {
    if (!/^[a-z][a-z0-9-]*$/u.test(lane?.id ?? "") || ids.has(lane.id)) {
      throw new Error(`ci-change-scope: invalid or duplicate lane ${JSON.stringify(lane?.id)}`);
    }
    ids.add(lane.id);
    if (![lane.exact, lane.prefixes, lane.suffixes, lane.contains].some(Array.isArray)) {
      throw new Error(`ci-change-scope: lane ${lane.id} has no matchers`);
    }
  }
  return value;
}

export function classifyPaths(paths, value = laneManifest) {
  validateLaneManifest(value);
  const result = [];
  for (const candidate of [...new Set(paths.map(normalizePath).filter(Boolean))].toSorted(
    (left, right) => left.localeCompare(right),
  )) {
    if (candidate.startsWith("/") || candidate.split("/").includes("..")) {
      throw new Error(`ci-change-scope: unsafe path ${JSON.stringify(candidate)}`);
    }
    const lane = value.lanes.find((entry) => matchesLane(candidate, entry));
    if (!lane) {
      throw new Error(`ci-change-scope: unclassified path ${JSON.stringify(candidate)}`);
    }
    result.push(Object.freeze({ path: candidate, lane: lane.id }));
  }
  return Object.freeze(result);
}

const VERSION_ROOTS = new Set(["CHANGELOG.md", "package.json", "src/brand.ts"]);

function bool(value) {
  return value ? "true" : "false";
}

function isVersionPath(path) {
  if (VERSION_ROOTS.has(path)) {
    return true;
  }
  const parts = path.split("/");
  return (
    parts.length === 3 &&
    parts[0] === "extensions" &&
    (parts[2] === "CHANGELOG.md" || parts[2] === "package.json")
  );
}

function isRoutableTest(path) {
  return (
    (path.startsWith("src/") ||
      path.startsWith("scripts/") ||
      path.startsWith("test/") ||
      path.startsWith("extensions/") ||
      path.startsWith("ui/")) &&
    path.endsWith(".test.ts") &&
    !path.endsWith(".e2e.test.ts") &&
    !path.endsWith(".live.test.ts")
  );
}

function digest(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function fullMatrixPlan() {
  const enabled = {
    docsOnly: false,
    docsChanged: true,
    versionOnly: false,
    ciInfrastructureOnly: false,
    t2FixtureOnly: false,
    testOnly: false,
    fixtureOnly: false,
    productionChanged: true,
    privilegeChanged: true,
    reusePrChecks: false,
    runNode: true,
    runNodeFocused: false,
    runInstallerReleaseVerification: false,
    runNodeBuild: true,
    runNodePackaging: true,
    runNodeFull: true,
    runNodeUnit: false,
    runNodeGateway: false,
    runNodeExtensions: false,
    runUi: true,
    runMacosRuntime: true,
    runMacosApp: true,
    experimentalMobileChanged: true,
    runSigner: true,
    runNativeSigner: true,
    runSignerIntegration: true,
    runSignerDarwinIntegration: true,
    runPlatformBootstrap: true,
    runDocker: true,
    runCodeqlJavascript: true,
    runCodeqlGo: true,
    runCodeqlPython: true,
    runHosting: true,
    runHostingFresh: true,
    runHostingUpdate: true,
    runLocalFresh: true,
    runLocalUpdate: true,
    runCiContracts: true,
    runT2Contracts: true,
    runUiMining: true,
    runSkills: true,
    fullMatrix: true,
  };
  return Object.freeze({
    authorityVersion: 7,
    phase: "nightly",
    changeKind: "full-matrix",
    paths: [],
    lanes: [],
    selectedTestPaths: [],
    manualReviewRequired: false,
    ...enabled,
  });
}

export function classifyChangedPaths(inputPaths, options = {}) {
  if (options.fullMatrix === true || options.unknown === true || inputPaths.length === 0) {
    return fullMatrixPlan();
  }
  const classified = classifyPaths(inputPaths);
  const paths = classified.map(({ path }) => path);
  const lanes = [...new Set(classified.map(({ lane }) => lane))].toSorted((left, right) =>
    left.localeCompare(right),
  );
  const lane = (name) => lanes.includes(name);
  const deletedPaths = new Set((options.deletedPaths ?? []).map(normalizePath));
  const selectedTestPaths = paths
    .filter((path) => isRoutableTest(path) && !deletedPaths.has(path))
    .toSorted((left, right) => left.localeCompare(right));
  const docsOnly = lanes.every((name) => name === "documentation");
  const versionOnly =
    paths.includes("package.json") && paths.includes("src/brand.ts") && paths.every(isVersionPath);
  const testOnly = lanes.every((name) => name === "tests");
  const fixtureOnly = paths.every(
    (path) =>
      path.startsWith("fixtures/") ||
      path.startsWith("scripts/docker/") ||
      path.startsWith("scripts/test-"),
  );
  const ciInfrastructureOnly = lanes.every(
    (name) => name === "ci-contract" || name === "documentation",
  );
  const productionChanged = lanes.some(
    (name) => !["ci-contract", "documentation", "tests"].includes(name),
  );
  const lifecycle = lane("lifecycle");
  const signer = lane("signer");
  const installer = paths.includes("install.sh");
  const dependencyCandidate =
    paths.includes("pnpm-lock.yaml") &&
    paths.every(
      (path) =>
        path === "pnpm-lock.yaml" || path === "package.json" || path.endsWith("/package.json"),
    );

  if (
    productionChanged &&
    !versionOnly &&
    !lifecycle &&
    !signer &&
    !dependencyCandidate &&
    selectedTestPaths.length === 0
  ) {
    throw new Error(
      `ci-change-scope: production change has no directly changed focused test: ${JSON.stringify(paths)}`,
    );
  }

  const runNodeUnit = selectedTestPaths.some(
    (path) =>
      !path.startsWith("src/gateway/") &&
      !path.startsWith("extensions/") &&
      !path.startsWith("ui/"),
  );
  const runNodeGateway = selectedTestPaths.some((path) => path.startsWith("src/gateway/"));
  const runNodeExtensions = selectedTestPaths.some((path) => path.startsWith("extensions/"));
  const runUi = selectedTestPaths.some((path) => path.startsWith("ui/"));
  const plan = {
    authorityVersion: 7,
    phase: "T1",
    changeKind: versionOnly
      ? "version-only"
      : docsOnly
        ? "documentation-only"
        : ciInfrastructureOnly
          ? "ci-infrastructure-only"
          : testOnly
            ? "test-only"
            : productionChanged
              ? "production"
              : "repository",
    paths,
    lanes,
    selectedTestPaths,
    manualReviewRequired: false,
    docsOnly,
    docsChanged: lane("documentation"),
    versionOnly,
    ciInfrastructureOnly,
    t2FixtureOnly: false,
    testOnly,
    fixtureOnly,
    productionChanged,
    privilegeChanged: lifecycle || signer || installer,
    reusePrChecks: false,
    runNode: !versionOnly && (lane("node") || lifecycle || selectedTestPaths.length > 0),
    runNodeFocused: lifecycle && !installer,
    runInstallerReleaseVerification: installer,
    runNodeBuild: false,
    runNodePackaging: false,
    runNodeFull: false,
    runNodeUnit,
    runNodeGateway,
    runNodeExtensions,
    runUi,
    runMacosRuntime: false,
    runMacosApp: false,
    experimentalMobileChanged: lane("native"),
    runSigner: signer,
    runNativeSigner: signer || paths.some((path) => path.startsWith("tools/fased-lifecycled/")),
    runSignerIntegration: signer,
    runSignerDarwinIntegration: false,
    runPlatformBootstrap: false,
    runDocker: false,
    runCodeqlJavascript: false,
    runCodeqlGo: false,
    runCodeqlPython: false,
    runHosting: false,
    runHostingFresh: false,
    runHostingUpdate: false,
    runLocalFresh: false,
    runLocalUpdate: false,
    runCiContracts: lane("ci-contract"),
    runT2Contracts: false,
    runUiMining: runUi && paths.some((path) => path.includes("mining")),
    runSkills: lane("skills"),
    fullMatrix: false,
  };
  return Object.freeze({ ...plan, planDigest: digest(plan) });
}

export function detectDependencyRemediation(
  plan,
  env = process.env,
  verify = verifyRepositoryDependencyRemediation,
) {
  const manifests = plan.paths.filter(
    (path) => path === "package.json" || path.endsWith("/package.json"),
  );
  if (
    plan.changeKind !== "production" ||
    manifests.length < 1 ||
    manifests.length > 8 ||
    !plan.paths.includes("pnpm-lock.yaml") ||
    plan.paths.length !== manifests.length + 1
  ) {
    return Object.freeze({ dependencyRemediation: false, dependencyNames: [] });
  }
  try {
    const result = verify(env);
    return Object.freeze({
      dependencyRemediation: true,
      dependencyNames: [
        ...new Set(result.remediations.map(({ dependency }) => dependency)),
      ].toSorted((left, right) => left.localeCompare(right)),
    });
  } catch (error) {
    console.error(
      `ci-change-scope: dependency remediation rejected: ${error instanceof Error ? error.message : String(error)}`,
    );
    return Object.freeze({ dependencyRemediation: false, dependencyNames: [] });
  }
}

export function outputEntries(plan, options = {}) {
  const remediation = options.dependencyRemediation === true;
  const entries = {
    authority_version: String(plan.authorityVersion),
    plan_digest: plan.planDigest ?? digest(plan),
    gate_plan_json: JSON.stringify(plan),
    lanes_json: JSON.stringify(plan.lanes),
    changed_test_paths_json: JSON.stringify(plan.selectedTestPaths),
    changed_ui_browser_tests: bool(
      plan.selectedTestPaths.some((path) => path.endsWith(".browser.test.ts")),
    ),
    phase: plan.phase,
    entry_points_json: "[]",
    change_kind: plan.changeKind,
    manual_review_required: "false",
    dependency_remediation: bool(remediation),
    dependency_names_json: JSON.stringify(remediation ? (options.dependencyNames ?? []) : []),
    focused_local_update: bool(plan.runNodeFocused),
    run_dependency_integrity: bool(remediation || plan.runNodePackaging),
  };
  const mappings = {
    docs_only: "docsOnly",
    docs_changed: "docsChanged",
    version_only: "versionOnly",
    ci_infrastructure_only: "ciInfrastructureOnly",
    t2_fixture_only: "t2FixtureOnly",
    test_only: "testOnly",
    fixture_only: "fixtureOnly",
    production_changed: "productionChanged",
    privilege_changed: "privilegeChanged",
    reuse_pr_checks: "reusePrChecks",
    run_node: "runNode",
    run_node_focused: "runNodeFocused",
    run_installer_release_verification: "runInstallerReleaseVerification",
    run_node_build: "runNodeBuild",
    run_node_packaging: "runNodePackaging",
    run_node_full: "runNodeFull",
    run_node_unit: "runNodeUnit",
    run_node_gateway: "runNodeGateway",
    run_node_extensions: "runNodeExtensions",
    run_ui: "runUi",
    run_macos_runtime: "runMacosRuntime",
    run_macos_app: "runMacosApp",
    experimental_mobile_changed: "experimentalMobileChanged",
    run_signer: "runSigner",
    run_native_signer: "runNativeSigner",
    run_signer_integration: "runSignerIntegration",
    run_signer_darwin_integration: "runSignerDarwinIntegration",
    run_platform_bootstrap: "runPlatformBootstrap",
    run_docker: "runDocker",
    run_codeql_javascript: "runCodeqlJavascript",
    focused_codeql_javascript: "runCodeqlJavascript",
    run_codeql_go: "runCodeqlGo",
    run_codeql_python: "runCodeqlPython",
    run_hosting: "runHosting",
    run_hosting_fresh: "runHostingFresh",
    run_hosting_update: "runHostingUpdate",
    run_local_fresh: "runLocalFresh",
    run_local_update: "runLocalUpdate",
    run_ci_contracts: "runCiContracts",
    run_t2_contracts: "runT2Contracts",
    run_ui_mining: "runUiMining",
    run_skills: "runSkills",
    full_matrix: "fullMatrix",
  };
  for (const [output, key] of Object.entries(mappings)) {
    entries[output] = bool(plan[key]);
  }
  entries.codeql_languages_json = JSON.stringify(
    [
      plan.runCodeqlJavascript && "javascript-typescript",
      plan.runCodeqlGo && "go",
      plan.runCodeqlPython && "python",
    ].filter(Boolean),
  );
  return entries;
}

function resolveDiffBase(env = process.env) {
  if (env.GITHUB_EVENT_NAME === "pull_request") {
    const baseRef = env.GITHUB_BASE_REF?.trim();
    if (baseRef) {
      try {
        return execFileSync("git", ["merge-base", `origin/${baseRef}`, "HEAD"], {
          encoding: "utf8",
        }).trim();
      } catch {}
    }
    if (env.GITHUB_BASE_SHA?.trim()) {
      return env.GITHUB_BASE_SHA.trim();
    }
  }
  return env.GITHUB_EVENT_BEFORE?.trim() || "HEAD^";
}

export function changedPathsFromGit(env = process.env) {
  return execFileSync("git", ["diff", "--name-only", resolveDiffBase(env), "HEAD"], {
    encoding: "utf8",
  })
    .split(/\r?\n/u)
    .filter(Boolean);
}

export function deletedPathsFromGit(env = process.env) {
  return execFileSync(
    "git",
    ["diff", "--diff-filter=D", "--name-only", resolveDiffBase(env), "HEAD"],
    { encoding: "utf8" },
  )
    .split(/\r?\n/u)
    .filter(Boolean);
}

function main() {
  const fullMatrix = process.env.FULL_MATRIX === "true";
  const paths = fullMatrix ? [] : changedPathsFromGit();
  const deletedPaths = fullMatrix ? [] : deletedPathsFromGit();
  const plan = classifyChangedPaths(paths, {
    fullMatrix,
    unknown: paths.length === 0,
    deletedPaths,
  });
  const entries = outputEntries(plan, detectDependencyRemediation(plan));
  if (!process.env.GITHUB_OUTPUT) {
    throw new Error("ci-change-scope: GITHUB_OUTPUT is required");
  }
  for (const [name, value] of Object.entries(entries)) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  }
  console.log(JSON.stringify({ paths, ...entries }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
