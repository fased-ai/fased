#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { verifyRepositoryDependencyRemediation } from "./ci-dependency-integrity.mjs";
import {
  classifyChangedPaths,
  createGatePlan,
  isInstallerReleaseVerificationPath,
  normalizeChangedPaths,
} from "./gate-authority.mjs";

export { classifyChangedPaths };

function trueString(value) {
  return value ? "true" : "false";
}

export function detectDependencyRemediation(
  plan,
  env = process.env,
  verify = verifyRepositoryDependencyRemediation,
) {
  const paths = [...plan.paths].toSorted((left, right) => left.localeCompare(right));
  const manifestPaths = paths.filter(
    (path) => path === "package.json" || path.endsWith("/package.json"),
  );
  if (
    plan.changeKind !== "production" ||
    plan.manualReviewRequired ||
    manifestPaths.length < 1 ||
    manifestPaths.length > 8 ||
    !paths.includes("pnpm-lock.yaml") ||
    paths.length !== manifestPaths.length + 1 ||
    !paths.every((path) => path === "pnpm-lock.yaml" || manifestPaths.includes(path))
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
    const message = error instanceof Error ? error.message : String(error);
    console.error(`ci-change-scope: dependency remediation rejected: ${message}`);
    return Object.freeze({ dependencyRemediation: false, dependencyNames: [] });
  }
}

export function outputEntries(plan, options = {}) {
  const scope = plan.scope;
  const dependencyRemediation = options.dependencyRemediation === true;
  const dependencyNames = dependencyRemediation ? (options.dependencyNames ?? []) : [];
  const focusedNode = scope.runNodeFocused || scope.runInstallerReleaseVerification;
  const focusedCodeqlJavascript =
    scope.runCodeqlJavascript &&
    (scope.runNodeFocused || (plan.selectedTestPaths?.length ?? 0) > 0);
  const focusedLocalUpdate = focusedNode && scope.runLocalUpdate;
  const runDependencyIntegrity = dependencyRemediation || (scope.runNodePackaging && !focusedNode);
  const lane = (value) => !dependencyRemediation && value;
  const focusedLane = (value) => lane(value) && !focusedNode;
  // Packaged P1 stays at the immutable candidate boundary. Keep ordinary PR CI
  // on focused source/security contracts without repeating that transaction.
  const prBuildLane = (value) => lane(value) && !focusedNode;
  const prInstalledAcceptanceLane = (value) =>
    lane(value) && !focusedNode && scope.productionChanged;
  const codeqlLanguages = [
    lane(scope.runCodeqlJavascript) && "javascript-typescript",
    lane(scope.runCodeqlGo) && "go",
    lane(scope.runCodeqlPython) && "python",
  ].filter(Boolean);
  return {
    authority_version: String(plan.authorityVersion),
    plan_digest: plan.planDigest,
    gate_plan_json: JSON.stringify(plan),
    changed_test_paths_json: JSON.stringify(plan.selectedTestPaths ?? []),
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
    dependency_names_json: JSON.stringify(dependencyNames),
    focused_local_update: trueString(focusedLocalUpdate),
    run_dependency_integrity: trueString(runDependencyIntegrity),
    run_node: trueString(lane(scope.runNode)),
    run_node_focused: trueString(lane(scope.runNodeFocused || focusedLocalUpdate)),
    run_installer_release_verification: trueString(lane(scope.runInstallerReleaseVerification)),
    run_node_build: trueString(dependencyRemediation || prBuildLane(scope.runNodeBuild)),
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
    focused_codeql_javascript: trueString(lane(focusedCodeqlJavascript)),
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

function replaceInstallerRegion(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) {
    throw new Error(`installer ${label} region is missing`);
  }
  return `${source.slice(0, start + startMarker.length)}__FASED_${label}__\n${source.slice(end)}`;
}

function normalizeInstallerReleaseVerification(source) {
  const helperStart = source.indexOf("  verify_release_attestation_source() {\n");
  if (helperStart >= 0) {
    const helperEndMarker = "\n\n  root_owned_bundle_tree_is_secure() {";
    const helperEnd = source.indexOf(helperEndMarker, helperStart);
    if (helperEnd < 0) {
      throw new Error("installer shared release-verification helper is unterminated");
    }
    source = `${source.slice(0, helperStart)}${source.slice(helperEnd + 2)}`;
  }
  source = replaceInstallerRegion(
    source,
    '    curl -q -fL --proto \'=https\' --tlsv1.2 "$release_url/fased-privileged-vex-v1.openvex.json" -o "$vex"\n',
    '    local manifest_selection=""',
    "HOSTING_ATTESTATION_VERIFICATION",
  );
  return replaceInstallerRegion(
    source,
    '      echo "Could not download the Local release attestation bundle." >&2\n      return 1\n    fi\n',
    '    local release_commit=""',
    "LOCAL_ATTESTATION_VERIFICATION",
  );
}

export function isInstallerReleaseVerificationChange(paths, baseInstaller, headInstaller) {
  const normalized = normalizeChangedPaths(paths).toSorted((left, right) =>
    left.localeCompare(right),
  );
  if (
    !normalized.includes("install.sh") ||
    !normalized.includes("scripts/install-release-pin.test.ts") ||
    !normalized.every(isInstallerReleaseVerificationPath) ||
    (normalized.includes("scripts/generation-updater.mjs") &&
      !normalized.includes("scripts/generation-updater.test.ts")) ||
    (normalized.includes("scripts/release-artifact-set.mjs") &&
      !normalized.includes("scripts/release-artifact-set.test.ts")) ||
    baseInstaller === headInstaller
  ) {
    return false;
  }
  try {
    return (
      normalizeInstallerReleaseVerification(baseInstaller) ===
      normalizeInstallerReleaseVerification(headInstaller)
    );
  } catch {
    return false;
  }
}

export function detectInstallerReleaseVerification(paths, env = process.env) {
  const base = resolveDiffBase(env);
  try {
    const baseInstaller = execFileSync("git", ["show", `${base}:install.sh`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const headInstaller = readFileSync("install.sh", "utf8");
    return isInstallerReleaseVerificationChange(paths, baseInstaller, headInstaller);
  } catch {
    return false;
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
  const phase = "T3";
  const entryPoint = null;
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

  const installerReleaseVerification = detectInstallerReleaseVerification(paths);
  const plan = createGatePlan(paths, {
    phase,
    entryPoint,
    fullMatrix,
    reusePrChecks,
    unknown,
    installerReleaseVerification,
  });
  const remediation = detectDependencyRemediation(plan);
  const entries = outputEntries(plan, remediation);
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
