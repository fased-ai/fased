#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GROUPS = Object.freeze(["unit", "gateway", "extensions", "ui"]);
const ROUTABLE_TEST_RE = /\.test\.ts$/u;
const NON_ROUTINE_TEST_RE = /\.(?:e2e|live)\.test\.ts$/u;

function fail(message) {
  throw new Error(`ci-run-changed-tests: ${message}`);
}

function normalizePath(value) {
  if (typeof value !== "string") {
    fail("every changed test path must be a string");
  }
  const normalized = value.trim().replaceAll("\\", "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.split("/").includes("..") ||
    normalized.includes("\0")
  ) {
    fail(`unsafe changed test path ${JSON.stringify(value)}`);
  }
  if (!ROUTABLE_TEST_RE.test(normalized) || NON_ROUTINE_TEST_RE.test(normalized)) {
    fail(`non-routine or unclassified test path ${JSON.stringify(normalized)}`);
  }
  return normalized;
}

export function classifyChangedTestPath(value) {
  const path = normalizePath(value);
  if (path.startsWith("src/gateway/")) {
    return Object.freeze({ path, group: "gateway", kind: "gateway" });
  }
  if (path.startsWith("extensions/")) {
    return Object.freeze({ path, group: "extensions", kind: "extensions" });
  }
  if (path.startsWith("ui/")) {
    return Object.freeze({
      path,
      group: "ui",
      kind: path.endsWith(".browser.test.ts") ? "ui-browser" : "ui-node",
    });
  }
  if (/^(?:src|scripts|test)\//u.test(path)) {
    return Object.freeze({ path, group: "unit", kind: "unit" });
  }
  fail(`test path is outside the supported exact-test lanes: ${JSON.stringify(path)}`);
}

export function parseChangedTestPathsJson(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail("CHANGED_TEST_PATHS_JSON must be valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    fail("CHANGED_TEST_PATHS_JSON must be a non-empty array");
  }
  return [...new Set(parsed.map((entry) => normalizePath(entry)))].toSorted((left, right) =>
    left.localeCompare(right),
  );
}

function vitestCommand(config, paths, options = {}) {
  const cwd = options.cwd ?? repoRoot;
  const normalizedPaths = options.stripUiPrefix
    ? paths.map((path) => path.slice("ui/".length))
    : paths;
  return Object.freeze({
    file: "pnpm",
    args: [
      "exec",
      "vitest",
      "run",
      "--config",
      config,
      ...normalizedPaths,
      "--pool=forks",
      "--maxWorkers=2",
    ],
    cwd,
    paths,
  });
}

export function createChangedTestCommands(paths, group) {
  if (!GROUPS.includes(group)) {
    fail(`unknown group ${JSON.stringify(group)}; expected ${GROUPS.join(", ")}`);
  }
  const classified = paths.map((path) => classifyChangedTestPath(path));
  const selected = classified.filter((entry) => entry.group === group);
  if (selected.length === 0) {
    fail(`no changed tests belong to the ${group} lane`);
  }

  if (group === "unit") {
    return [
      vitestCommand(
        "vitest.config.ts",
        selected.map((entry) => entry.path),
      ),
    ];
  }
  if (group === "gateway") {
    return [
      vitestCommand(
        "vitest.gateway.config.ts",
        selected.map((entry) => entry.path),
      ),
    ];
  }
  if (group === "extensions") {
    return [
      vitestCommand(
        "vitest.extensions.config.ts",
        selected.map((entry) => entry.path),
      ),
    ];
  }

  const commands = [];
  const nodePaths = selected.filter((entry) => entry.kind === "ui-node").map((entry) => entry.path);
  const browserPaths = selected
    .filter((entry) => entry.kind === "ui-browser")
    .map((entry) => entry.path);
  if (nodePaths.length > 0) {
    commands.push(
      vitestCommand("vitest.changed-node.config.ts", nodePaths, {
        cwd: resolve(repoRoot, "ui"),
        stripUiPrefix: true,
      }),
    );
  }
  if (browserPaths.length > 0) {
    commands.push(
      vitestCommand("vitest.config.ts", browserPaths, {
        cwd: resolve(repoRoot, "ui"),
        stripUiPrefix: true,
      }),
    );
  }
  return commands;
}

function assertCheckedOutRegularFile(path) {
  const absolute = resolve(repoRoot, path);
  const repoRelative = relative(repoRoot, absolute);
  if (repoRelative.startsWith("..") || repoRelative === "") {
    fail(`test path escapes the repository: ${JSON.stringify(path)}`);
  }
  if (!lstatSync(absolute).isFile()) {
    fail(`changed test is not a regular file: ${JSON.stringify(path)}`);
  }
  const real = realpathSync(absolute);
  if (relative(repoRoot, real).startsWith("..")) {
    fail(`changed test resolves outside the repository: ${JSON.stringify(path)}`);
  }
}

function main() {
  const group = process.argv[2] ?? "";
  const paths = parseChangedTestPathsJson(process.env.CHANGED_TEST_PATHS_JSON ?? "");
  for (const path of paths) {
    assertCheckedOutRegularFile(path);
  }
  const commands = createChangedTestCommands(paths, group);
  for (const command of commands) {
    console.log(
      `ci-run-changed-tests: ${command.args.map((value) => JSON.stringify(value)).join(" ")}`,
    );
    execFileSync(command.file, command.args, {
      cwd: command.cwd,
      env: process.env,
      stdio: "inherit",
    });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
