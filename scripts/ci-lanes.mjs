#!/usr/bin/env node

import { readFileSync } from "node:fs";

const manifest = JSON.parse(
  readFileSync(new URL("../config/ci-lanes.v1.json", import.meta.url), "utf8"),
);

function normalize(value) {
  return String(value ?? "")
    .trim()
    .replaceAll("\\", "/");
}

function matches(path, lane) {
  return (
    lane.exact?.includes(path) === true ||
    lane.prefixes?.some((prefix) => path.startsWith(prefix)) === true ||
    lane.suffixes?.some((suffix) => path.endsWith(suffix)) === true ||
    lane.contains?.some((part) => path.includes(part)) === true
  );
}

export function validateLaneManifest(value = manifest) {
  if (value?.schemaVersion !== 1 || value?.unknownPathPolicy !== "reject") {
    throw new Error("ci-lanes: unsupported manifest contract");
  }
  if (!Array.isArray(value.lanes) || value.lanes.length === 0) {
    throw new Error("ci-lanes: at least one lane is required");
  }
  const ids = new Set();
  for (const lane of value.lanes) {
    if (!/^[a-z][a-z0-9-]*$/u.test(lane?.id ?? "") || ids.has(lane.id)) {
      throw new Error(`ci-lanes: invalid or duplicate lane ${JSON.stringify(lane?.id)}`);
    }
    ids.add(lane.id);
    if (![lane.exact, lane.prefixes, lane.suffixes, lane.contains].some(Array.isArray)) {
      throw new Error(`ci-lanes: lane ${lane.id} has no matchers`);
    }
  }
  return value;
}

export function classifyPaths(paths, value = manifest) {
  validateLaneManifest(value);
  const result = [];
  for (const candidate of [...new Set(paths.map(normalize).filter(Boolean))].toSorted()) {
    if (candidate.startsWith("/") || candidate.split("/").includes("..")) {
      throw new Error(`ci-lanes: unsafe path ${JSON.stringify(candidate)}`);
    }
    const lane = value.lanes.find((entry) => matches(candidate, entry));
    if (!lane) {
      throw new Error(`ci-lanes: unclassified path ${JSON.stringify(candidate)}`);
    }
    result.push(Object.freeze({ path: candidate, lane: lane.id }));
  }
  return Object.freeze(result);
}

export function laneIds(paths, value = manifest) {
  return [...new Set(classifyPaths(paths, value).map(({ lane }) => lane))].toSorted();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify({ lanes: laneIds(process.argv.slice(2)) }));
}
