#!/usr/bin/env node

import {
  normalizePath,
  parseTsgoErrors,
  runTsgo,
  writeTextArtifact,
} from "./strict-report-lib.mjs";

const DEFAULT_SCOPES = [
  "src/agents/fased-tools.ts",
  "src/agents/fased-tools.compat.ts",
  "src/agents/tools/marketplace-offer-draft-tool.ts",
  "src/agents/tools/marketplace-offer-draft-tool.test.ts",
  "src/agents/tools/mining-tool.ts",
  "src/cli/mining-cli.ts",
  "src/agents/tools/wallet-action-tool.ts",
  "src/agents/tools/wallet-tool.ts",
  "src/agents/tools/wallet-tool.test.ts",
  "src/agents/tools/wallet-action-tool.test.ts",
  "src/agents/tools/mining-tool.test.ts",
  "src/cli/mining-cli.actions.test.ts",
  "src/agents/fased-tools.test.ts",
  "ui/src/ui/views/federation.ts",
  "ui/src/ui/views/wallet.ts",
  "ui/src/ui/views/wallet.test.ts",
];

const scopes = (process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_SCOPES).map(
  (scope) => normalizePath(scope).replace(/\/$/, ""),
);

function isScopedFile(file) {
  const normalized = normalizePath(file);
  return scopes.some((scope) => normalized === scope || normalized.startsWith(`${scope}/`));
}

const { status, output } = runTsgo();
const errors = parseTsgoErrors(output);
const scopedErrors = errors.filter((error) => isScopedFile(error.file));
const report = [
  `pnpm tsgo exit status: ${status}`,
  `total parsed errors: ${errors.length}`,
  `scoped parsed errors: ${scopedErrors.length}`,
  "",
  ...scopedErrors.map((error) => error.raw),
].join("\n");

const reportPath = writeTextArtifact("scoped.txt", `${report}\n`);

if (scopedErrors.length > 0) {
  console.error(`Strict scoped check failed: ${scopedErrors.length} scoped errors.`);
  console.error(`Report: ${reportPath}`);
  for (const error of scopedErrors) {
    console.error(error.raw);
  }
  process.exit(1);
}

console.log(
  `Strict scoped check passed: 0 scoped errors (${errors.length} repo-wide parsed errors remain).`,
);
console.log(`Report: ${reportPath}`);
