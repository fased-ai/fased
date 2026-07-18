#!/usr/bin/env node

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { parseTsgoErrors, runTsc, writeTextArtifact } from "./strict-report-lib.mjs";

const BASELINE_PATH = path.join(process.cwd(), "config", "typescript-noemit-baseline.json");
const WRITE = process.argv.includes("--write");
const require = createRequire(import.meta.url);
const TYPESCRIPT_VERSION = require("typescript/package.json").version;

function normalizeMessage(message) {
  const compact = message.replace(/\s+/g, " ").trim();
  return compact
    .split(process.cwd())
    .join("<repo>")
    .split(process.cwd().replaceAll("/", "\\"))
    .join("<repo>");
}

function identity(error) {
  return JSON.stringify([error.file, error.code, normalizeMessage(error.message)]);
}

function countsFor(errors) {
  const counts = new Map();
  for (const error of errors) {
    const key = identity(error);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function baselineDocument(errors) {
  const counts = countsFor(errors);
  const entries = [...counts.entries()]
    .map(([key, count]) => {
      const [file, code, message] = JSON.parse(key);
      return { file, code, message, count };
    })
    .toSorted(
      (left, right) =>
        left.file.localeCompare(right.file) ||
        left.code.localeCompare(right.code) ||
        left.message.localeCompare(right.message),
    );
  return {
    schemaVersion: 1,
    command: "pnpm exec tsc --noEmit --pretty false",
    typescript: TYPESCRIPT_VERSION,
    totalErrors: errors.length,
    errors: entries,
  };
}

const result = runTsc();
const errors = parseTsgoErrors(result.output);
writeTextArtifact("tsc-noemit.txt", result.output);

if (result.status !== 0 && errors.length === 0) {
  console.error(
    `TypeScript compiler failed without parseable diagnostics (status=${result.status}, signal=${result.signal ?? "none"}).`,
  );
  if (result.error) {
    console.error(String(result.error));
  }
  process.exit(1);
}

if (WRITE) {
  const document = baselineDocument(errors);
  fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(document, null, 2)}\n`);
  console.log(`Wrote ${errors.length} TypeScript diagnostics to ${BASELINE_PATH}.`);
  process.exit(0);
}

if (!fs.existsSync(BASELINE_PATH)) {
  console.error(`TypeScript baseline is missing: ${BASELINE_PATH}`);
  process.exit(1);
}

const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
if (baseline.schemaVersion !== 1 || !Array.isArray(baseline.errors)) {
  console.error("TypeScript baseline has an unsupported schema.");
  process.exit(1);
}
if (baseline.typescript !== TYPESCRIPT_VERSION) {
  console.error(
    `TypeScript baseline compiler mismatch: baseline=${baseline.typescript ?? "missing"}, installed=${TYPESCRIPT_VERSION}.`,
  );
  process.exit(1);
}

const allowed = new Map(
  baseline.errors.map((entry) => [
    JSON.stringify([entry.file, entry.code, entry.message]),
    Number(entry.count),
  ]),
);
const current = countsFor(errors);
const regressions = [];
for (const [key, count] of current) {
  const allowance = Number(allowed.get(key) ?? 0);
  if (count > allowance) {
    const [file, code, message] = JSON.parse(key);
    regressions.push({ file, code, message, count, allowance });
  }
}

if (regressions.length > 0) {
  console.error(
    `TypeScript no-emit baseline failed: ${regressions.length} new or increased diagnostic(s).`,
  );
  for (const regression of regressions.slice(0, 100)) {
    console.error(
      `${regression.file} ${regression.code} current=${regression.count} baseline=${regression.allowance}: ${regression.message}`,
    );
  }
  process.exit(1);
}

const resolved = Number(baseline.totalErrors ?? 0) - errors.length;
console.log(
  `TypeScript no-emit baseline passed: ${errors.length} current diagnostics, ${Math.max(0, resolved)} retired, 0 new.`,
);
