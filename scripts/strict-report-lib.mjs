import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const STRICT_ARTIFACT_DIR = path.join(process.cwd(), ".artifacts", "strict");

const TSGO_ERROR_RE = /^(.+?\.(?:c|m)?tsx?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;

export function runTsgo() {
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const result = spawnSync(command, ["tsgo"], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
  });
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

export function runTsc() {
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const result = spawnSync(command, ["exec", "tsc", "--noEmit", "--pretty", "false"], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
    env: {
      ...process.env,
      NODE_OPTIONS: "--max-old-space-size=6144",
    },
  });
  return {
    status: result.status ?? 1,
    signal: result.signal ?? null,
    error: result.error ?? null,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

export function ensureStrictArtifactDir() {
  fs.mkdirSync(STRICT_ARTIFACT_DIR, { recursive: true });
}

export function normalizePath(filePath) {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function parseTsgoErrors(output) {
  return output
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(TSGO_ERROR_RE);
      if (!match) {
        return null;
      }
      return {
        file: normalizePath(match[1]),
        line: Number(match[2]),
        column: Number(match[3]),
        code: match[4],
        message: match[5],
        raw: line,
      };
    })
    .filter(Boolean);
}

export function bucketForFile(file) {
  const normalized = normalizePath(file);
  const segments = normalized.split("/");
  if (normalized.startsWith("extensions/")) {
    return segments.slice(0, 2).join("/");
  }
  if (normalized.startsWith("ui/")) {
    return "ui";
  }
  if (normalized.startsWith("src/agents/acp") || normalized.startsWith("src/acp")) {
    return "acp";
  }
  if (normalized.startsWith("src/config/")) {
    return "config";
  }
  if (normalized.startsWith("src/")) {
    return segments.slice(0, 2).join("/");
  }
  return segments[0] || "unknown";
}

export function summarizeErrors(errors) {
  const buckets = new Map();
  const files = new Map();
  for (const error of errors) {
    const bucket = bucketForFile(error.file);
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
    files.set(error.file, (files.get(error.file) ?? 0) + 1);
  }
  return {
    buckets: [...buckets.entries()].toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    files: [...files.entries()].toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
  };
}

export function writeTextArtifact(name, content) {
  ensureStrictArtifactDir();
  const target = path.join(STRICT_ARTIFACT_DIR, name);
  fs.writeFileSync(target, content);
  return target;
}
