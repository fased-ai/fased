#!/usr/bin/env node

import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { ENTRY_POINTS, PHASES } from "./gate-authority.mjs";

export const ROUTE_STATUS_CONTEXT = "fased/private-change-gate";

const GIT_ID_RE = /^[a-f0-9]{40,64}$/u;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/u;
const MAX_ROUTE_LIFETIME_MS = 60 * 60 * 1000;

function fail(message) {
  throw new Error(`trusted CI route: ${message}`);
}

function absentRoute() {
  return { status: "absent", entryPoint: null };
}

function exactSearchParams(url) {
  const keys = [...url.searchParams.keys()];
  const expected = ["base", "entry", "expires", "fased-ci-route", "phase", "plan", "receipt"];
  if (
    keys.length !== expected.length ||
    new Set(keys).size !== keys.length ||
    keys.toSorted((left, right) => left.localeCompare(right)).join("\0") !== expected.join("\0")
  ) {
    fail("target URL parameters are not the exact v1 schema");
  }
}

function normalizeActorLogin(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function resolveTrustedCiRoute({
  statuses,
  repo,
  headCommit,
  baseCommit,
  trustedActorLogin,
  trustedActorId,
  now = new Date(),
}) {
  if (!Array.isArray(statuses)) {
    fail("GitHub statuses response is not an array");
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repo ?? "")) {
    fail("repository is invalid");
  }
  if (!GIT_ID_RE.test(headCommit ?? "") || !GIT_ID_RE.test(baseCommit ?? "")) {
    fail("head or base identity is invalid");
  }
  const actorLogin = normalizeActorLogin(trustedActorLogin);
  const actorId = Number(trustedActorId);
  if (!actorLogin || !Number.isSafeInteger(actorId) || actorId <= 0) {
    return absentRoute();
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    fail("current time is invalid");
  }

  const trusted = statuses
    .filter(
      (status) =>
        status?.context === ROUTE_STATUS_CONTEXT &&
        normalizeActorLogin(status?.creator?.login) === actorLogin &&
        Number(status?.creator?.id) === actorId,
    )
    .toSorted((left, right) => Number(right?.id ?? 0) - Number(left?.id ?? 0));
  const status = trusted[0];
  if (!status) {
    return absentRoute();
  }

  // `success` is the one-shot merge capability and `error` is its revocation.
  // Neither is reusable routing authority.
  if (status.state === "success" || status.state === "error") {
    return absentRoute();
  }
  if (status.state !== "pending") {
    fail("newest trusted status is not pending");
  }
  if (!Number.isSafeInteger(Number(status.id)) || Number(status.id) <= 0) {
    fail("status id is invalid");
  }

  let target;
  try {
    target = new URL(status.target_url);
  } catch {
    fail("target URL is invalid");
  }
  if (
    target.protocol !== "https:" ||
    target.hostname !== "github.com" ||
    target.username ||
    target.password ||
    target.hash
  ) {
    fail("target URL origin is invalid");
  }
  const expectedPath = `/${repo}/commit/${headCommit}`;
  if (target.pathname !== expectedPath) {
    fail("target URL does not bind the exact repository head");
  }
  exactSearchParams(target);
  if (target.searchParams.get("fased-ci-route") !== "v1") {
    fail("route schema is unsupported");
  }

  const entryPoint = target.searchParams.get("entry");
  const phase = target.searchParams.get("phase");
  const targetBase = target.searchParams.get("base");
  const plan = target.searchParams.get("plan");
  const receipt = target.searchParams.get("receipt");
  const expires = target.searchParams.get("expires");
  if (!ENTRY_POINTS.includes(entryPoint)) {
    fail("entry point is unsupported");
  }
  if (!PHASES.includes(phase)) {
    fail("phase is unsupported");
  }
  if (targetBase !== baseCommit) {
    fail("route base does not equal the pull-request base");
  }
  if (!SHA256_HEX_RE.test(plan ?? "") || !SHA256_HEX_RE.test(receipt ?? "")) {
    fail("plan or receipt digest is invalid");
  }
  const expiresAt = Date.parse(expires ?? "");
  if (!Number.isFinite(expiresAt) || new Date(expiresAt).toISOString() !== expires) {
    fail("expiry is not canonical ISO UTC");
  }
  const remaining = expiresAt - now.getTime();
  if (remaining <= 0 || remaining > MAX_ROUTE_LIFETIME_MS) {
    fail("receipt is expired or overlong");
  }
  const expectedDescription = `route:${entryPoint};r=${receipt.slice(0, 16)}`;
  if (status.description !== expectedDescription) {
    fail("description does not bind the receipt");
  }

  return {
    status: "selected",
    entryPoint,
    phase,
    planDigest: `sha256:${plan}`,
    receiptDigest: `sha256:${receipt}`,
    statusId: Number(status.id),
  };
}

async function fetchCommitStatuses({ repo, headCommit, token, fetchImpl = fetch }) {
  const response = await fetchImpl(
    `https://api.github.com/repos/${repo}/commits/${headCommit}/statuses?per_page=100`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!response.ok) {
    throw new Error(`GitHub statuses request returned ${response.status}`);
  }
  return response.json();
}

function writeOutputs(route, outputPath) {
  if (!outputPath) {
    throw new Error("ci-private-route-status: GITHUB_OUTPUT is required");
  }
  const entries = {
    route_status: route.status,
    gate_entry_point: route.entryPoint ?? "",
    gate_phase: route.phase ?? "",
    expected_plan_digest: route.planDigest ?? "",
    private_receipt_digest: route.receiptDigest ?? "",
  };
  for (const [name, value] of Object.entries(entries)) {
    appendFileSync(outputPath, `${name}=${value}\n`);
  }
  return entries;
}

export async function main(env = process.env, dependencies = {}) {
  let route = absentRoute();
  if (env.GITHUB_EVENT_NAME === "pull_request") {
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
    const repo = env.GITHUB_REPOSITORY;
    const headCommit = event?.pull_request?.head?.sha;
    const baseCommit = event?.pull_request?.base?.sha;
    const token = env.GH_TOKEN || env.GITHUB_TOKEN;
    const trustedActorLogin = env.FASED_PRIVATE_STATUS_ACTOR;
    const trustedActorId = env.FASED_PRIVATE_STATUS_ACTOR_ID;
    if (token && trustedActorLogin && trustedActorId) {
      try {
        const statuses = await (dependencies.fetchCommitStatuses ?? fetchCommitStatuses)({
          repo,
          headCommit,
          token,
        });
        route = resolveTrustedCiRoute({
          statuses,
          repo,
          headCommit,
          baseCommit,
          trustedActorLogin,
          trustedActorId,
        });
      } catch (error) {
        if (String(error?.message ?? error).startsWith("trusted CI route:")) {
          throw error;
        }
        console.warn(`ci-private-route-status: unavailable; using broad routing: ${error.message}`);
      }
    } else {
      console.warn(
        "ci-private-route-status: trusted actor configuration absent; using broad routing",
      );
    }
  }
  const entries = writeOutputs(route, env.GITHUB_OUTPUT);
  console.log(JSON.stringify(entries));
  return route;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`ci-private-route-status: ${error.message}`);
    process.exitCode = 1;
  });
}
