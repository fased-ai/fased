#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const RELEASE_GATE_CONTEXT = "fased/lifecycle-release-gate";
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const ACTOR_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const ACTIONS = new Set(["tag", "github-release"]);

function fail(message) {
  throw new Error(message);
}

export function parseGateDescription(description) {
  const match = /^r=([a-f0-9]{64});e=([^;]+);a=([a-z-]+)$/u.exec(description || "");
  if (!match) {
    fail("release gate status description is malformed");
  }
  const receiptDigest = `sha256:${match[1]}`;
  const expiresAt = new Date(match[2]);
  if (!DIGEST_PATTERN.test(receiptDigest) || Number.isNaN(expiresAt.getTime())) {
    fail("release gate status receipt or expiry is invalid");
  }
  return { receiptDigest, expiresAt, actions: match[3].split(",") };
}

export function verifyReleaseGateStatus(statuses, options) {
  if (!Array.isArray(statuses)) {
    fail("commit statuses must be an array");
  }
  if (!COMMIT_PATTERN.test(options.commit || "")) {
    fail("expected commit is invalid");
  }
  if (!ACTIONS.has(options.action)) {
    fail("expected release action is invalid");
  }
  if (!ACTOR_PATTERN.test(options.trustedActor || "")) {
    fail("trusted release actor is invalid");
  }
  if (!REPOSITORY_PATTERN.test(options.repository || "")) {
    fail("expected repository is invalid");
  }
  if (options.receiptDigest && !DIGEST_PATTERN.test(options.receiptDigest)) {
    fail("expected receipt digest is invalid");
  }
  if (
    options.action === "github-release" &&
    !DIGEST_PATTERN.test(options.artifactSetDigest || "")
  ) {
    fail("GitHub Release authorization requires the exact artifact-set digest");
  }
  const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
  if (Number.isNaN(now.getTime())) {
    fail("verification time is invalid");
  }
  const candidates = statuses
    .filter(
      (status) =>
        status?.context === RELEASE_GATE_CONTEXT &&
        status?.sha === options.commit &&
        status?.state === "success",
    )
    .toSorted((left, right) => Number(right.id || 0) - Number(left.id || 0));
  if (candidates.length === 0) {
    fail("exact commit has no successful lifecycle release gate status");
  }
  const status = candidates[0];
  if (status.creator?.login !== options.trustedActor) {
    fail("release gate status actor is not trusted");
  }
  const parsed = parseGateDescription(status.description);
  if (parsed.actions.length !== 1 || parsed.actions[0] !== options.action) {
    fail("release gate status does not authorize exactly the requested action");
  }
  if (options.receiptDigest && parsed.receiptDigest !== options.receiptDigest) {
    fail("release gate status receipt digest mismatch");
  }
  const target = new URL(status.target_url || "");
  const [owner, repository] = options.repository.split("/");
  if (
    target.protocol !== "https:" ||
    target.hostname !== "github.com" ||
    target.pathname !== `/${owner}/${repository}/commit/${options.commit}` ||
    [...target.searchParams.keys()].join(",") !== "fased-artifact-set" ||
    !DIGEST_PATTERN.test(`sha256:${target.searchParams.get("fased-artifact-set") || ""}`)
  ) {
    fail("release gate status target does not bind the exact commit and artifact set");
  }
  const artifactSetDigest = `sha256:${target.searchParams.get("fased-artifact-set")}`;
  if (options.artifactSetDigest && artifactSetDigest !== options.artifactSetDigest) {
    fail("release gate status artifact-set digest mismatch");
  }
  const createdAt = new Date(status.created_at);
  if (
    Number.isNaN(createdAt.getTime()) ||
    createdAt.getTime() > now.getTime() + 5 * 60 * 1000 ||
    parsed.expiresAt.getTime() <= now.getTime() ||
    parsed.expiresAt.getTime() <= createdAt.getTime()
  ) {
    fail("release gate status timing is invalid or expired");
  }
  return {
    statusId: status.id,
    commit: options.commit,
    action: options.action,
    actor: options.trustedActor,
    receiptDigest: parsed.receiptDigest,
    artifactSetDigest,
    expiresAt: parsed.expiresAt.toISOString(),
  };
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      fail(`invalid argument: ${key ?? ""}`);
    }
    if (values.has(key)) {
      fail(`duplicate argument: ${key}`);
    }
    values.set(key, value);
  }
  for (const key of ["--statuses", "--commit", "--action", "--trusted-actor", "--repository"]) {
    if (!values.has(key)) {
      fail(`missing ${key}`);
    }
  }
  return {
    statuses: path.resolve(values.get("--statuses")),
    commit: values.get("--commit"),
    action: values.get("--action"),
    trustedActor: values.get("--trusted-actor"),
    repository: values.get("--repository"),
    receiptDigest: values.get("--receipt-digest") ?? null,
    artifactSetDigest: values.get("--artifact-set-digest") ?? null,
    now: values.get("--now") ?? undefined,
  };
}

function main(argv) {
  const options = parseArgs(argv);
  const statuses = JSON.parse(fs.readFileSync(options.statuses, "utf8"));
  process.stdout.write(`${JSON.stringify(verifyReleaseGateStatus(statuses, options))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`verify-release-gate-status: ${error.message}\n`);
    process.exitCode = 1;
  }
}
