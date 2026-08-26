#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Prints selected files as NUL-delimited tokens to stdout.
 *
 * Usage:
 *   node scripts/pre-commit/filter-staged-files.mjs lint -- <files...>
 *   node scripts/pre-commit/filter-staged-files.mjs format -- <files...>
 *
 * Keep this dependency-free: the pre-commit hook runs in many environments.
 */

const lintExts = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const formatExts = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".mdx"]);
const exactByteFormatPrefixes = ["extensions/sat-mining/protocol-generation/"];

export function selectStagedFiles(mode, files) {
  if (mode !== "lint" && mode !== "format") {
    throw new Error("mode must be lint or format");
  }

  return files.filter((filePath) => {
    const normalized = filePath.replaceAll("\\", "/").replace(/^\.\//u, "");
    if (
      mode === "format" &&
      exactByteFormatPrefixes.some((prefix) => normalized.startsWith(prefix))
    ) {
      return false;
    }
    const ext = path.extname(normalized).toLowerCase();
    return mode === "lint" ? lintExts.has(ext) : formatExts.has(ext);
  });
}

function main() {
  const mode = process.argv[2];
  const rawArgs = process.argv.slice(3);
  const files = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
  let selected;
  try {
    selected = selectStagedFiles(mode, files);
  } catch {
    process.stderr.write("usage: filter-staged-files.mjs <lint|format> -- <files...>\n");
    process.exitCode = 2;
    return;
  }

  for (const file of selected) {
    process.stdout.write(file);
    process.stdout.write("\0");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
