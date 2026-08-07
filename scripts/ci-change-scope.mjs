#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { classifyChangedPaths, createGatePlan, normalizeChangedPaths } from "./gate-authority.mjs";

export { classifyChangedPaths };

function trueString(value) {
  return value ? "true" : "false";
}

export function isDependencyRemediationRoute(plan, route) {
  if (route !== "dependency-remediation") {
    return false;
  }
  const paths = [...plan.paths].toSorted((left, right) => left.localeCompare(right));
  const exactPathSets = [
    ["package.json", "pnpm-lock.yaml"],
    ["extensions/zalo/package.json", "package.json", "pnpm-lock.yaml"],
  ];
  if (
    plan.entryPoint !== null ||
    plan.changeKind !== "production" ||
    plan.manualReviewRequired ||
    !exactPathSets.some((expected) => JSON.stringify(paths) === JSON.stringify(expected))
  ) {
    throw new Error(
      "ci-change-scope: trusted dependency-remediation route does not match an exact advisory plan",
    );
  }
  return true;
}

export function isFocusedLocalUpdateRoute(plan, route) {
  if (route !== "local-update") {
    return false;
  }
  if (
    plan.entryPoint !== "local-update" ||
    plan.entryPoints.length !== 1 ||
    plan.entryPoints[0] !== "local-update" ||
    plan.changeKind !== "production" ||
    plan.manualReviewRequired ||
    plan.scope.privilegeChanged !== true ||
    plan.scope.runNodeFocused !== true ||
    plan.scope.runLocalUpdate !== true ||
    plan.scope.runLocalFresh !== false ||
    plan.scope.runT2Contracts !== true ||
    plan.acceptance.L1 !== true ||
    plan.acceptance.L0 !== false
  ) {
    throw new Error(
      "ci-change-scope: trusted local-update route does not match an exact privileged Local-update plan",
    );
  }
  return true;
}

export function outputEntries(plan, options = {}) {
  const scope = plan.scope;
  const dependencyRemediation = isDependencyRemediationRoute(plan, options.route ?? "");
  const focusedLocalUpdate = isFocusedLocalUpdateRoute(plan, options.route ?? "");
  const runDependencyIntegrity =
    dependencyRemediation || (scope.runNodePackaging && !focusedLocalUpdate);
  const lane = (value) => !dependencyRemediation && value;
  const focusedLane = (value) => lane(value) && !focusedLocalUpdate;
  // The private route binds exact T1/T2 source evidence before the PR opens.
  // Packaged P1 stays at the immutable candidate boundary. Keep public PR CI on
  // focused source/security contracts without repeating privileged transactions.
  const prBuildLane = (value) => lane(value) && !focusedLocalUpdate;
  const prInstalledAcceptanceLane = (value) =>
    lane(value) && !focusedLocalUpdate && scope.productionChanged;
  const codeqlLanguages = [
    lane(scope.runCodeqlJavascript) && "javascript-typescript",
    lane(scope.runCodeqlGo) && "go",
    lane(scope.runCodeqlPython) && "python",
  ].filter(Boolean);
  return {
    authority_version: String(plan.authorityVersion),
    plan_digest: plan.planDigest,
    gate_plan_json: JSON.stringify(plan),
    changed_test_paths_json: JSON.stringify(plan.scope.testOnly ? plan.paths : []),
    changed_ui_browser_tests: trueString(
      plan.scope.testOnly && plan.paths.some((path) => /^ui\/.*\.browser\.test\.ts$/u.test(path)),
    ),
    phase: plan.phase,
    entry_points_json: JSON.stringify(plan.entryPoints),
    change_kind: plan.changeKind,
    manual_review_required: trueString(plan.manualReviewRequired),
    docs_only: trueString(scope.docsOnly),
    docs_changed: trueString(scope.docsChanged),
    version_only: trueString(scope.versionOnly),
    ci_infrastructure_only: trueString(scope.ciInfrastructureOnly),
    t2_fixture_only: trueString(scope.t2FixtureOnly),
    test_only: trueString(scope.testOnly),
    fixture_only: trueString(scope.fixtureOnly),
    production_changed: trueString(scope.productionChanged),
    privilege_changed: trueString(scope.privilegeChanged),
    reuse_pr_checks: trueString(scope.reusePrChecks),
    dependency_remediation: trueString(dependencyRemediation),
    focused_local_update: trueString(focusedLocalUpdate),
    run_dependency_integrity: trueString(runDependencyIntegrity),
    run_node: trueString(lane(scope.runNode)),
    run_node_focused: trueString(lane(scope.runNodeFocused || focusedLocalUpdate)),
    run_node_build: trueString(prBuildLane(scope.runNodeBuild)),
    run_node_packaging: trueString(focusedLane(scope.runNodePackaging)),
    run_node_full: trueString(focusedLane(scope.runNodeFull)),
    run_node_unit: trueString(focusedLane(scope.runNodeUnit)),
    run_node_gateway: trueString(focusedLane(scope.runNodeGateway)),
    run_node_extensions: trueString(focusedLane(scope.runNodeExtensions)),
    run_ui: trueString(focusedLane(scope.runUi)),
    run_macos_runtime: trueString(focusedLane(scope.runMacosRuntime)),
    run_macos_app: trueString(focusedLane(scope.runMacosApp)),
    experimental_mobile_changed: trueString(scope.experimentalMobileChanged),
    run_signer: trueString(focusedLane(scope.runSigner)),
    run_native_signer: trueString(focusedLane(scope.runNativeSigner)),
    run_signer_integration: trueString(focusedLane(scope.runSignerIntegration)),
    run_signer_darwin_integration: trueString(focusedLane(scope.runSignerDarwinIntegration)),
    run_platform_bootstrap: trueString(lane(scope.runPlatformBootstrap)),
    run_docker: trueString(lane(scope.runDocker)),
    run_codeql_javascript: trueString(lane(scope.runCodeqlJavascript)),
    run_codeql_go: trueString(lane(scope.runCodeqlGo)),
    run_codeql_python: trueString(lane(scope.runCodeqlPython)),
    codeql_languages_json: JSON.stringify(codeqlLanguages),
    run_hosting: trueString(prInstalledAcceptanceLane(scope.runHosting)),
    run_hosting_fresh: trueString(prInstalledAcceptanceLane(scope.runHostingFresh)),
    run_hosting_update: trueString(prInstalledAcceptanceLane(scope.runHostingUpdate)),
    run_local_fresh: trueString(prInstalledAcceptanceLane(scope.runLocalFresh)),
    run_local_update: trueString(prInstalledAcceptanceLane(scope.runLocalUpdate)),
    run_ci_contracts: trueString(scope.runCiContracts),
    run_t2_contracts: trueString(focusedLane(scope.runT2Contracts)),
    run_ui_mining: trueString(lane(scope.runUiMining)),
    run_skills: trueString(lane(scope.runSkills)),
    full_matrix: trueString(lane(scope.fullMatrix)),
  };
}

export function assertExpectedPlanDigest(plan, expectedDigest) {
  const expected = expectedDigest?.trim();
  if (!expected) {
    return;
  }
  if (plan.planDigest !== expected) {
    throw new Error(
      `ci-change-scope: trusted route plan digest mismatch: expected ${expected}, computed ${plan.planDigest}`,
    );
  }
}

function resolveDiffBase(env = process.env) {
  if (env.GITHUB_EVENT_NAME === "push") {
    const before = env.GITHUB_EVENT_BEFORE?.trim();
    if (before && !/^0+$/.test(before)) {
      return before;
    }
    return "HEAD^";
  }

  if (env.GITHUB_EVENT_NAME === "pull_request") {
    const baseRef = env.GITHUB_BASE_REF?.trim();
    if (baseRef) {
      try {
        return execFileSync("git", ["merge-base", `origin/${baseRef}`, "HEAD"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
      } catch {
        // Fall through to the event's immutable base SHA.
      }
    }
    const baseSha = env.GITHUB_BASE_SHA?.trim();
    if (baseSha) {
      return baseSha;
    }
  }

  return "HEAD^";
}

export function changedPathsFromGit(env = process.env) {
  const base = resolveDiffBase(env);
  const output = execFileSync("git", ["diff", "--name-only", base, "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return normalizeChangedPaths(output.split(/\r?\n/));
}

function main() {
  const fullMatrix = process.env.FULL_MATRIX === "true";
  const reusePrChecks = process.env.REUSE_PR_CHECKS === "true";
  const phase = process.env.GATE_PHASE || "T3";
  const entryPoint = process.env.GATE_ENTRY_POINT || null;
  let paths = [];
  let unknown = false;

  if (!fullMatrix && !reusePrChecks) {
    try {
      paths = changedPathsFromGit();
      unknown = paths.length === 0;
    } catch (error) {
      unknown = true;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`ci-change-scope: diff detection failed; enabling broad checks: ${message}`);
    }
  }

  const plan = createGatePlan(paths, {
    phase,
    entryPoint,
    fullMatrix,
    reusePrChecks,
    unknown,
  });
  assertExpectedPlanDigest(plan, process.env.GATE_EXPECTED_PLAN_DIGEST);
  const entries = outputEntries(plan, { route: process.env.GATE_ROUTE || "" });
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    throw new Error("ci-change-scope: GITHUB_OUTPUT is required");
  }
  for (const [name, value] of Object.entries(entries)) {
    appendFileSync(outputPath, `${name}=${value}\n`);
  }

  console.log(JSON.stringify({ paths, ...entries }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
