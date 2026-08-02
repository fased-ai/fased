#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { classifyChangedPaths, createGatePlan, normalizeChangedPaths } from "./gate-authority.mjs";

export { classifyChangedPaths };

function trueString(value) {
  return value ? "true" : "false";
}

function outputEntries(plan) {
  const scope = plan.scope;
  return {
    authority_version: String(plan.authorityVersion),
    plan_digest: plan.planDigest,
    gate_plan_json: JSON.stringify(plan),
    phase: plan.phase,
    entry_points_json: JSON.stringify(plan.entryPoints),
    affected_entry_points_json: JSON.stringify(plan.affectedEntryPoints),
    change_kind: plan.changeKind,
    manual_review_required: trueString(plan.manualReviewRequired),
    docs_only: trueString(scope.docsOnly),
    docs_changed: trueString(scope.docsChanged),
    version_only: trueString(scope.versionOnly),
    ci_infrastructure_only: trueString(scope.ciInfrastructureOnly),
    lifecycle_gate_enforcement_only: trueString(scope.lifecycleGateEnforcementOnly),
    t2_fixture_only: trueString(scope.t2FixtureOnly),
    test_only: trueString(scope.testOnly),
    fixture_only: trueString(scope.fixtureOnly),
    production_changed: trueString(scope.productionChanged),
    privilege_changed: trueString(scope.privilegeChanged),
    reuse_pr_checks: trueString(scope.reusePrChecks),
    run_node: trueString(scope.runNode),
    run_macos: trueString(scope.runMacos),
    run_signer: trueString(scope.runSigner),
    run_hosting: trueString(scope.runHosting),
    run_hosting_fresh: trueString(scope.runHostingFresh),
    run_hosting_update: trueString(scope.runHostingUpdate),
    run_local_fresh: trueString(scope.runLocalFresh),
    run_local_update: trueString(scope.runLocalUpdate),
    run_ci_contracts: trueString(scope.runCiContracts),
    run_t2_contracts: trueString(scope.runT2Contracts),
    run_ui_mining: trueString(scope.runUiMining),
    run_skills: trueString(scope.runSkills),
    full_matrix: trueString(scope.fullMatrix),
  };
}

function gitMergeBase(ref) {
  return execFileSync("git", ["merge-base", ref, "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

export function resolveDiffBase(env = process.env, mergeBase = gitMergeBase) {
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
        return mergeBase(`origin/${baseRef}`);
      } catch {
        // Fall through to the event's immutable base SHA.
      }
    }
    const baseSha = env.GITHUB_BASE_SHA?.trim();
    if (baseSha) {
      return baseSha;
    }
  }

  if (env.GITHUB_EVENT_NAME === "workflow_dispatch") {
    try {
      return mergeBase("origin/main");
    } catch {
      return "HEAD^";
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

export function assertResolvedScope(plan, failOnManualReview) {
  if (failOnManualReview && plan.manualReviewRequired) {
    throw new Error(
      "ci-change-scope: ambiguous lifecycle scope requires an explicit workflow_dispatch entry_point or full_matrix",
    );
  }
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
  const entries = outputEntries(plan);
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    throw new Error("ci-change-scope: GITHUB_OUTPUT is required");
  }
  for (const [name, value] of Object.entries(entries)) {
    appendFileSync(outputPath, `${name}=${value}\n`);
  }

  console.log(JSON.stringify({ paths, ...entries }, null, 2));
  assertResolvedScope(plan, process.env.FAIL_ON_MANUAL_REVIEW === "true");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
