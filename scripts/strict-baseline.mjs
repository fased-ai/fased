#!/usr/bin/env node

import {
  bucketForFile,
  parseTsgoErrors,
  runTsgo,
  summarizeErrors,
  writeTextArtifact,
} from "./strict-report-lib.mjs";

const { status, output } = runTsgo();
const errors = parseTsgoErrors(output);
const summary = summarizeErrors(errors);

const rawPath = writeTextArtifact("tsgo.txt", output);
const summaryLines = [
  "# Strict TypeScript Baseline",
  "",
  `Status: pnpm tsgo exited ${status}`,
  `Total parsed errors: ${errors.length}`,
  "",
  "## Buckets",
  "",
  ...summary.buckets.map(([bucket, count]) => `- ${bucket}: ${count}`),
  "",
  "## Top Files",
  "",
  ...summary.files
    .slice(0, 50)
    .map(([file, count]) => `- ${file}: ${count} (${bucketForFile(file)})`),
  "",
];
const summaryPath = writeTextArtifact("summary.md", `${summaryLines.join("\n")}\n`);

console.log(`Strict baseline captured: ${errors.length} parsed errors.`);
console.log(`Raw output: ${rawPath}`);
console.log(`Summary: ${summaryPath}`);
