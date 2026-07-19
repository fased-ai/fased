import { createRequire } from "node:module";
import process from "node:process";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";

export type RuntimeKind = "node" | "unknown";

type Semver = {
  major: number;
  minor: number;
  patch: number;
};

const MIN_NODE: Semver = { major: 22, minor: 14, patch: 0 };
const require = createRequire(import.meta.url);

export type RuntimeDetails = {
  kind: RuntimeKind;
  version: string | null;
  execPath: string | null;
  pathEnv: string;
  platform?: NodeJS.Platform;
  sqliteAvailable?: boolean;
};

const SEMVER_RE = /(\d+)\.(\d+)\.(\d+)/;

export function parseSemver(version: string | null): Semver | null {
  if (!version) {
    return null;
  }
  const match = version.match(SEMVER_RE);
  if (!match) {
    return null;
  }
  const [, major, minor, patch] = match;
  return {
    major: Number.parseInt(major, 10),
    minor: Number.parseInt(minor, 10),
    patch: Number.parseInt(patch, 10),
  };
}

export function isAtLeast(version: Semver | null, minimum: Semver): boolean {
  if (!version) {
    return false;
  }
  if (version.major !== minimum.major) {
    return version.major > minimum.major;
  }
  if (version.minor !== minimum.minor) {
    return version.minor > minimum.minor;
  }
  return version.patch >= minimum.patch;
}

export function detectRuntime(): RuntimeDetails {
  const kind: RuntimeKind = process.versions?.node ? "node" : "unknown";
  const version = process.versions?.node ?? null;

  return {
    kind,
    version,
    execPath: process.execPath ?? null,
    pathEnv: process.env.PATH ?? "(not set)",
    platform: process.platform,
    sqliteAvailable: kind === "node" ? detectNodeSqliteSupport() : false,
  };
}

function detectNodeSqliteSupport(): boolean {
  try {
    require("node:sqlite");
    return true;
  } catch {
    return false;
  }
}

export function runtimeSatisfies(details: RuntimeDetails): boolean {
  const platform = details.platform ?? process.platform;
  if (platform === "win32") {
    return false;
  }
  const parsed = parseSemver(details.version);
  if (details.kind === "node") {
    return isAtLeast(parsed, MIN_NODE) && details.sqliteAvailable !== false;
  }
  return false;
}

export function isSupportedNodeVersion(version: string | null): boolean {
  return isAtLeast(parseSemver(version), MIN_NODE);
}

export function assertSupportedRuntime(
  runtime: RuntimeEnv = defaultRuntime,
  details: RuntimeDetails = detectRuntime(),
): void {
  if (runtimeSatisfies(details)) {
    return;
  }

  const platform = details.platform ?? process.platform;
  if (platform === "win32") {
    runtime.error(
      [
        "Native Windows is not a supported Fased runtime.",
        "Install Ubuntu in WSL2, enable systemd, and run Fased inside the Ubuntu shell.",
        "PowerShell is supported only for installing WSL2 or connecting to a remote Linux VPS.",
        "Guide: https://docs.fased.ai/platforms/windows",
      ].join("\n"),
    );
    runtime.exit(1);
    return;
  }

  const versionLabel = details.version ?? "unknown";
  const runtimeLabel =
    details.kind === "unknown" ? "unknown runtime" : `${details.kind} ${versionLabel}`;
  const execLabel = details.execPath ?? "unknown";

  runtime.error(
    [
      "fased requires Node 24 recommended, or Node >=22.14.0 with node:sqlite.",
      `Detected: ${runtimeLabel} (exec: ${execLabel}).`,
      ...(details.kind === "node" && details.sqliteAvailable === false
        ? ["Detected Node cannot load the built-in node:sqlite module."]
        : []),
      `PATH searched: ${details.pathEnv}`,
      "Install Node: https://nodejs.org/en/download",
      "Upgrade Node and re-run fased.",
    ].join("\n"),
  );
  runtime.exit(1);
}
