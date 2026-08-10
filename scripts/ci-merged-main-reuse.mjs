#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

export function pullRequestNumberFromSubject(subject) {
  const match = String(subject ?? "")
    .trim()
    .match(/\(#([1-9][0-9]*)\)$/);
  return match ? Number(match[1]) : null;
}

export function hasSuccessfulAggregateCheck(statusCheckRollup) {
  return Array.isArray(statusCheckRollup)
    ? statusCheckRollup.some(
        (check) =>
          check?.name === "checks" &&
          check?.workflowName === "PR" &&
          check?.status === "COMPLETED" &&
          check?.conclusion === "SUCCESS",
      )
    : false;
}

export function assessMergedPullRequest({ headSha, mainTree, pr, prTree }) {
  if (pr?.state !== "MERGED") {
    return "associated pull request is not merged";
  }
  if (pr?.mergeCommit?.oid !== headSha) {
    return "pull request merge commit does not match main";
  }
  if (!hasSuccessfulAggregateCheck(pr?.statusCheckRollup)) {
    return "pull request aggregate checks are not successful";
  }
  if (prTree !== mainTree) {
    return "tested pull request tree does not match merged main";
  }
  return null;
}

function writeOutputs(entries) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    throw new Error("ci-merged-main-reuse: GITHUB_OUTPUT is required");
  }
  for (const [name, value] of Object.entries(entries)) {
    const scalar =
      typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : "";
    const safeValue = scalar.replaceAll(/\r?\n/g, " ");
    appendFileSync(outputPath, `${name}=${safeValue}\n`);
  }
}

function skip(reason) {
  writeOutputs({
    reuse_pr_checks: "false",
    reason,
  });
  console.log(`ci-merged-main-reuse: full validation required: ${reason}`);
}

function main() {
  if (process.env.GITHUB_EVENT_NAME !== "push" || process.env.GITHUB_REF !== "refs/heads/main") {
    skip("not a main push");
    return;
  }

  const repository = process.env.GITHUB_REPOSITORY?.trim();
  const headSha = process.env.GITHUB_SHA?.trim();
  if (!repository || !/^[0-9a-f]{40}$/.test(headSha ?? "")) {
    skip("main push identity is unavailable");
    return;
  }

  try {
    const subject = run("git", ["log", "-1", "--format=%s", "HEAD"]);
    const prNumber = pullRequestNumberFromSubject(subject);
    if (!prNumber) {
      skip("main commit does not identify an associated pull request");
      return;
    }

    const pr = JSON.parse(
      run("gh", [
        "pr",
        "view",
        String(prNumber),
        "--repo",
        repository,
        "--json",
        "state,headRefOid,mergeCommit,statusCheckRollup",
      ]),
    );
    if (!/^[0-9a-f]{40}$/.test(pr?.headRefOid ?? "")) {
      skip("pull request head identity is unavailable");
      return;
    }

    run("git", [
      "fetch",
      "--no-tags",
      "--force",
      "origin",
      `refs/pull/${prNumber}/head:refs/remotes/origin/pr-reuse-${prNumber}`,
    ]);
    const prTree = run("git", ["rev-parse", `refs/remotes/origin/pr-reuse-${prNumber}^{tree}`]);
    const mainTree = run("git", ["rev-parse", "HEAD^{tree}"]);
    const reason = assessMergedPullRequest({ headSha, mainTree, pr, prTree });
    if (reason) {
      skip(reason);
      return;
    }

    writeOutputs({
      reuse_pr_checks: "true",
      pr_number: prNumber,
      pr_head: pr.headRefOid,
      pr_tree: prTree,
      main_tree: mainTree,
      reason: "tested pull request tree and aggregate checks match merged main",
    });
    console.log(`ci-merged-main-reuse: reusing PR #${prNumber} checks for tree ${mainTree}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    skip(`merge proof unavailable: ${message}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
