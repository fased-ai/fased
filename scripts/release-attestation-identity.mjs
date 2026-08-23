#!/usr/bin/env node

import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

function fail(message) {
  throw new Error(message);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

export function resolveReleaseAttestationIdentity(bundleValue, repository) {
  if (!REPOSITORY_PATTERN.test(repository)) {
    fail("repository identity is invalid");
  }
  const bundle = object(bundleValue, "attestation bundle");
  const envelope = object(bundle.dsseEnvelope, "attestation envelope");
  if (typeof envelope.payload !== "string" || envelope.payload.length === 0) {
    fail("attestation payload is missing");
  }
  let statement;
  try {
    statement = object(
      JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8")),
      "attestation statement",
    );
  } catch (error) {
    fail(
      `attestation payload is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const predicate = object(statement.predicate, "attestation predicate");
  const buildDefinition = object(predicate.buildDefinition, "attestation build definition");
  const workflow = object(
    object(buildDefinition.externalParameters, "attestation external parameters").workflow,
    "attestation workflow",
  );
  const sourceRef = "refs/heads/main";
  const workflowPath = ".github/workflows/hosted-runtime-release.yml";
  const repositoryUrl = `https://github.com/${repository}`;
  if (
    statement.predicateType !== "https://slsa.dev/provenance/v1" ||
    buildDefinition.buildType !== "https://actions.github.io/buildtypes/workflow/v1" ||
    workflow.repository !== repositoryUrl ||
    workflow.ref !== sourceRef ||
    workflow.path !== workflowPath
  ) {
    fail("attestation does not identify the protected release workflow on main");
  }
  const sourceUri = `git+${repositoryUrl}@${sourceRef}`;
  const sourceDigests = (
    Array.isArray(buildDefinition.resolvedDependencies) ? buildDefinition.resolvedDependencies : []
  )
    .filter((dependency) => dependency?.uri === sourceUri)
    .map((dependency) => dependency?.digest?.gitCommit);
  if (
    sourceDigests.length !== 1 ||
    typeof sourceDigests[0] !== "string" ||
    !COMMIT_PATTERN.test(sourceDigests[0])
  ) {
    fail("attestation has no unique protected-main source digest");
  }
  const runDetails = object(predicate.runDetails, "attestation run details");
  const builder = object(runDetails.builder, "attestation builder");
  if (builder.id !== `${repositoryUrl}/${workflowPath}@${sourceRef}`) {
    fail("attestation builder identity is invalid");
  }
  const invocationId = object(runDetails.metadata, "attestation run metadata").invocationId;
  const escapedRepository = repository.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const invocationMatch = new RegExp(
    `^https://github\\.com/${escapedRepository}/actions/runs/([1-9][0-9]*)/attempts/([1-9][0-9]*)$`,
    "u",
  ).exec(invocationId);
  if (!invocationMatch) {
    fail("attestation invocation identity is invalid");
  }
  return {
    sourceRef,
    sourceDigest: sourceDigests[0],
    workflowPath,
    workflowRunId: invocationMatch[1],
    workflowRunAttempt: Number.parseInt(invocationMatch[2], 10),
  };
}

async function main() {
  const [command, bundleFlag, bundlePath, repositoryFlag, repository] = process.argv.slice(2);
  if (
    command !== "resolve" ||
    bundleFlag !== "--bundle" ||
    !bundlePath ||
    repositoryFlag !== "--repository" ||
    !repository
  ) {
    fail(
      "usage: release-attestation-identity.mjs resolve --bundle <path> --repository <owner/name>",
    );
  }
  const bundle = JSON.parse(await fs.readFile(bundlePath, "utf8"));
  process.stdout.write(
    `${JSON.stringify(resolveReleaseAttestationIdentity(bundle, repository))}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
