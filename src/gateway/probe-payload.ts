import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  resolveRuntimeServiceVersion,
  resolveRuntimeSource,
  type RuntimeVersionEnv,
} from "../version.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const PROCESS_STARTED_AT = new Date(performance.timeOrigin).toISOString();

type GatewayProbeOptions = {
  env?: RuntimeVersionEnv;
  runtimeEntrypoint?: string;
  architecture?: NodeJS.Architecture;
  pid?: number;
  startedAt?: string;
};

type GatewayReadiness = {
  ready: boolean;
  failing: string[];
  uptimeMs: number;
};

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readBoundedJson(filePath: string): unknown {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024) {
    throw new Error(`unsafe Gateway generation metadata: ${path.basename(filePath)}`);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
}

function findManagedRuntimeRoot(entrypoint: string | undefined): string | null {
  if (!entrypoint) {
    return null;
  }
  let candidate: string;
  try {
    candidate = fs.realpathSync(entrypoint);
    if (!fs.statSync(candidate).isDirectory()) {
      candidate = path.dirname(candidate);
    }
  } catch {
    return null;
  }
  for (let depth = 0; depth < 8; depth += 1) {
    if (
      fs.existsSync(path.join(candidate, ".fased-hosted-runtime.json")) &&
      fs.existsSync(path.join(candidate, ".fased-hosted-release-v2.json")) &&
      fs.existsSync(path.join(candidate, ".fased-managed-updater-bundle.json")) &&
      fs.existsSync(path.join(candidate, "dist", "build-info.json"))
    ) {
      return fs.realpathSync(candidate);
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) {
      break;
    }
    candidate = parent;
  }
  return null;
}

export type GatewayGenerationReceipt = Readonly<{
  schemaVersion: 1;
  generationId: string;
  version: string;
  releaseCommit: string;
  manifestDigest: string;
  applicationDigest: string;
  dependencyDigest: string;
  dependencyHash: string;
  updaterBundleDigest: string;
  runtimeRootDigest: string;
}>;

export function resolveGatewayGenerationReceipt(
  runtimeEntrypoint = process.argv[1],
  architecture: NodeJS.Architecture = process.arch,
  env: RuntimeVersionEnv = process.env as RuntimeVersionEnv,
): GatewayGenerationReceipt | null {
  try {
    const runtimeRoot = findManagedRuntimeRoot(runtimeEntrypoint);
    if (!runtimeRoot) {
      return null;
    }
    const runtime = readBoundedJson(path.join(runtimeRoot, ".fased-hosted-runtime.json")) as {
      schemaVersion?: unknown;
      version?: unknown;
      commit?: unknown;
      dependencyHash?: unknown;
    };
    const build = readBoundedJson(path.join(runtimeRoot, "dist", "build-info.json")) as {
      version?: unknown;
      commit?: unknown;
    };
    const manifestPath = path.join(runtimeRoot, ".fased-hosted-release-v2.json");
    const manifestBytes = fs.readFileSync(manifestPath);
    const manifest = readBoundedJson(manifestPath) as {
      schemaVersion?: unknown;
      release?: { version?: unknown; commit?: unknown };
      application?: {
        linux?: Record<
          string,
          {
            artifact?: { sha256?: unknown };
            dependencies?: { sha256?: unknown; dependencyHash?: unknown };
          }
        >;
      };
    };
    const updater = readBoundedJson(
      path.join(runtimeRoot, ".fased-managed-updater-bundle.json"),
    ) as {
      schemaVersion?: unknown;
      architecture?: unknown;
      bundleDigest?: unknown;
      release?: { version?: unknown; commit?: unknown };
    };
    const applicationArchitecture = architecture === "x64" ? "x64" : architecture;
    const application = manifest.application?.linux?.[applicationArchitecture];
    const version = stringValue(runtime.version);
    const releaseCommit = stringValue(runtime.commit);
    const dependencyHash = stringValue(runtime.dependencyHash);
    const applicationSha256 = stringValue(application?.artifact?.sha256);
    const dependencySha256 = stringValue(application?.dependencies?.sha256);
    const updaterBundleDigest = stringValue(updater.bundleDigest);
    const generationId = stringValue(env.FASED_GENERATION_ID);
    if (
      runtime.schemaVersion !== 2 ||
      manifest.schemaVersion !== 2 ||
      updater.schemaVersion !== 2 ||
      !version ||
      !COMMIT_PATTERN.test(releaseCommit) ||
      !SHA256_PATTERN.test(dependencyHash) ||
      !SHA256_PATTERN.test(applicationSha256) ||
      !SHA256_PATTERN.test(dependencySha256) ||
      application?.dependencies?.dependencyHash !== dependencyHash ||
      build.version !== version ||
      build.commit !== releaseCommit ||
      manifest.release?.version !== version ||
      manifest.release?.commit !== releaseCommit ||
      updater.architecture !== architecture ||
      updater.release?.version !== version ||
      updater.release?.commit !== releaseCommit ||
      !/^sha256:[a-f0-9]{64}$/u.test(updaterBundleDigest) ||
      !/^sha256:[a-f0-9]{64}$/u.test(generationId)
    ) {
      return null;
    }
    return Object.freeze({
      schemaVersion: 1,
      generationId,
      version,
      releaseCommit,
      manifestDigest: sha256(manifestBytes),
      applicationDigest: `sha256:${applicationSha256}`,
      dependencyDigest: `sha256:${dependencySha256}`,
      dependencyHash,
      updaterBundleDigest,
      runtimeRootDigest: sha256(runtimeRoot),
    });
  } catch {
    return null;
  }
}

export function buildGatewayProbePayload(
  status: "live" | "ready",
  options: GatewayProbeOptions = {},
) {
  const env = options.env ?? (process.env as RuntimeVersionEnv);
  return {
    ok: true,
    status,
    version: resolveRuntimeServiceVersion(env, "dev"),
    runtimeSource: resolveRuntimeSource(env),
    pid: options.pid ?? process.pid,
  } as const;
}

export function buildGatewayReadinessPayload(
  readiness: GatewayReadiness,
  options: GatewayProbeOptions = {},
) {
  return Object.freeze({
    ...buildGatewayProbePayload("ready", options),
    ready: readiness.ready,
    failing: readiness.failing,
    uptimeMs: readiness.uptimeMs,
    startedAt: options.startedAt ?? PROCESS_STARTED_AT,
    generation: resolveGatewayGenerationReceipt(
      options.runtimeEntrypoint,
      options.architecture,
      env,
    ),
  });
}
