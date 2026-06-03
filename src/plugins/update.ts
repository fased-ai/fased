import fsSync from "node:fs";
import path from "node:path";
import type { FasedAgentConfig } from "../config/config.js";
import { openBoundaryFileSync } from "../infra/boundary-file-read.js";
import type { UpdateChannel } from "../infra/update-channels.js";
import { resolveUserPath } from "../utils.js";
import { resolveBundledPluginSources } from "./bundled-sources.js";
import {
  installPluginFromNpmSpec,
  resolvePluginInstallDir,
  type PluginInstallPackageReview,
} from "./install.js";
import { buildNpmResolutionInstallFields, recordPluginInstall } from "./installs.js";

export type PluginUpdateLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

export type PluginUpdateStatus = "updated" | "unchanged" | "skipped" | "error";

export type PluginUpdateOutcome = {
  pluginId: string;
  status: PluginUpdateStatus;
  message: string;
  currentVersion?: string;
  nextVersion?: string;
  resolvedSpec?: string;
  integrity?: string;
  warnings?: string[];
  packageReview?: PluginInstallPackageReview;
};

export type PluginUpdateSummary = {
  config: FasedAgentConfig;
  changed: boolean;
  outcomes: PluginUpdateOutcome[];
};

export type PluginUpdateIntegrityDriftParams = {
  pluginId: string;
  spec: string;
  expectedIntegrity: string;
  actualIntegrity: string;
  resolvedSpec?: string;
  resolvedVersion?: string;
  dryRun: boolean;
};

export type PluginChannelSyncSummary = {
  switchedToBundled: string[];
  switchedToNpm: string[];
  warnings: string[];
  errors: string[];
};

export type PluginChannelSyncResult = {
  config: FasedAgentConfig;
  changed: boolean;
  summary: PluginChannelSyncSummary;
};

type InstallIntegrityDrift = {
  spec: string;
  expectedIntegrity: string;
  actualIntegrity: string;
  resolution: {
    resolvedSpec?: string;
    version?: string;
  };
};

function parseNpmRegistrySpec(spec: string): { name: string; selector?: string } | null {
  const trimmed = spec.trim();
  if (!trimmed || /\s/.test(trimmed) || trimmed.includes("://") || trimmed.includes("#")) {
    return null;
  }
  const selectorAt = trimmed.startsWith("@")
    ? trimmed.lastIndexOf("@") > trimmed.indexOf("/")
      ? trimmed.lastIndexOf("@")
      : -1
    : trimmed.lastIndexOf("@");
  const name = selectorAt > 0 ? trimmed.slice(0, selectorAt) : trimmed;
  const selector = selectorAt > 0 ? trimmed.slice(selectorAt + 1) : undefined;
  const unscopedName = /^[a-z0-9][a-z0-9-._~]*$/;
  const scopedName = /^@[a-z0-9][a-z0-9-._~]*\/[a-z0-9][a-z0-9-._~]*$/;
  const validName = name.startsWith("@") ? scopedName.test(name) : unscopedName.test(name);
  if (!validName || selector === "") {
    return null;
  }
  return { name, selector };
}

function resolveDefaultNpmBetaTarget(spec: string): { name: string } | null {
  const parsed = parseNpmRegistrySpec(spec);
  if (!parsed) {
    return null;
  }
  if (!parsed.selector || parsed.selector.toLowerCase() === "latest") {
    return { name: parsed.name };
  }
  return null;
}

function resolveNpmUpdateSpecs(params: { recordSpec?: string; updateChannel?: UpdateChannel }): {
  installSpec?: string;
  recordSpec?: string;
  fallbackSpec?: string;
  fallbackLabel?: string;
} {
  const recordSpec = params.recordSpec?.trim();
  if (!recordSpec) {
    return {};
  }
  if (params.updateChannel !== "beta") {
    return { installSpec: recordSpec, recordSpec };
  }
  const betaTarget = resolveDefaultNpmBetaTarget(recordSpec);
  if (!betaTarget) {
    return { installSpec: recordSpec, recordSpec };
  }
  return {
    installSpec: `${betaTarget.name}@beta`,
    recordSpec,
    fallbackSpec: recordSpec,
    fallbackLabel: `${betaTarget.name}@beta`,
  };
}

function describeBetaNpmFallback(params: {
  pluginId: string;
  betaSpec?: string;
  fallbackSpec: string;
  result: { error: string };
}): string {
  const missingBeta =
    /\b(E404|ETARGET|notarget)\b|No matching version found|dist-tag|tag .*not found|not in this registry/i.test(
      params.result.error,
    );
  const reason = missingBeta ? "has no beta npm release" : "failed beta npm update";
  return `Plugin "${params.pluginId}" ${reason} for ${params.betaSpec ?? "the beta npm release"}; falling back to ${params.fallbackSpec}.`;
}

function npmUpdateFailureSpec(params: {
  effectiveSpec?: string;
  fallbackSpec?: string;
  usedFallback: boolean;
}): string {
  if (params.usedFallback && params.fallbackSpec) {
    return params.fallbackSpec;
  }
  return params.effectiveSpec ?? params.fallbackSpec ?? "unknown";
}

function formatUpdateError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function readInstalledPackageVersion(
  dir: string,
  opts?: { pluginId?: string; logger?: PluginUpdateLogger },
): Promise<string | undefined> {
  const manifestPath = path.join(dir, "package.json");
  const opened = openBoundaryFileSync({
    absolutePath: manifestPath,
    rootPath: dir,
    boundaryLabel: "installed plugin directory",
  });
  if (!opened.ok) {
    return undefined;
  }
  try {
    const raw = fsSync.readFileSync(opened.fd, "utf-8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch (err) {
    opts?.logger?.warn?.(
      `Could not inspect installed package for "${opts.pluginId ?? path.basename(dir)}": package.json is unreadable (${formatUpdateError(err)}). Continuing update with unknown current version.`,
    );
    return undefined;
  } finally {
    fsSync.closeSync(opened.fd);
  }
}

function pathsEqual(left?: string, right?: string): boolean {
  if (!left || !right) {
    return false;
  }
  return resolveUserPath(left) === resolveUserPath(right);
}

function buildLoadPathHelpers(existing: string[]) {
  let paths = [...existing];
  const resolveSet = () => new Set(paths.map((entry) => resolveUserPath(entry)));
  let resolved = resolveSet();
  let changed = false;

  const addPath = (value: string) => {
    const normalized = resolveUserPath(value);
    if (resolved.has(normalized)) {
      return;
    }
    paths.push(value);
    resolved.add(normalized);
    changed = true;
  };

  const removePath = (value: string) => {
    const normalized = resolveUserPath(value);
    if (!resolved.has(normalized)) {
      return;
    }
    paths = paths.filter((entry) => resolveUserPath(entry) !== normalized);
    resolved = resolveSet();
    changed = true;
  };

  return {
    addPath,
    removePath,
    get changed() {
      return changed;
    },
    get paths() {
      return paths;
    },
  };
}

function createPluginUpdateIntegrityDriftHandler(params: {
  pluginId: string;
  dryRun: boolean;
  logger: PluginUpdateLogger;
  onIntegrityDrift?: (params: PluginUpdateIntegrityDriftParams) => boolean | Promise<boolean>;
}) {
  return async (drift: InstallIntegrityDrift) => {
    const payload: PluginUpdateIntegrityDriftParams = {
      pluginId: params.pluginId,
      spec: drift.spec,
      expectedIntegrity: drift.expectedIntegrity,
      actualIntegrity: drift.actualIntegrity,
      resolvedSpec: drift.resolution.resolvedSpec,
      resolvedVersion: drift.resolution.version,
      dryRun: params.dryRun,
    };
    if (params.onIntegrityDrift) {
      return await params.onIntegrityDrift(payload);
    }
    params.logger.warn?.(
      `Integrity drift for "${params.pluginId}" (${payload.resolvedSpec ?? payload.spec}): expected ${payload.expectedIntegrity}, got ${payload.actualIntegrity}`,
    );
    return true;
  };
}

export async function updateNpmInstalledPlugins(params: {
  config: FasedAgentConfig;
  logger?: PluginUpdateLogger;
  pluginIds?: string[];
  skipIds?: Set<string>;
  updateChannel?: UpdateChannel;
  dryRun?: boolean;
  onIntegrityDrift?: (params: PluginUpdateIntegrityDriftParams) => boolean | Promise<boolean>;
}): Promise<PluginUpdateSummary> {
  const logger = params.logger ?? {};
  const installs = params.config.plugins?.installs ?? {};
  const targets = params.pluginIds?.length ? params.pluginIds : Object.keys(installs);
  const outcomes: PluginUpdateOutcome[] = [];
  let next = params.config;
  let changed = false;

  for (const pluginId of targets) {
    const warnings: string[] = [];
    const pluginLogger: PluginUpdateLogger = {
      info: (message) => logger.info?.(message),
      warn: (message) => {
        warnings.push(message);
        logger.warn?.(message);
      },
      error: (message) => logger.error?.(message),
    };

    if (params.skipIds?.has(pluginId)) {
      outcomes.push({
        pluginId,
        status: "skipped",
        message: `Skipping "${pluginId}" (already updated).`,
      });
      continue;
    }

    const record = installs[pluginId];
    if (!record) {
      outcomes.push({
        pluginId,
        status: "skipped",
        message: `No install record for "${pluginId}".`,
      });
      continue;
    }

    if (record.source !== "npm") {
      outcomes.push({
        pluginId,
        status: "skipped",
        message: `Skipping "${pluginId}" (source: ${record.source}).`,
      });
      continue;
    }

    const npmSpecs = resolveNpmUpdateSpecs({
      recordSpec: record.spec,
      updateChannel: params.updateChannel,
    });
    const effectiveSpec = npmSpecs.installSpec;
    const recordSpec = npmSpecs.recordSpec;
    const fallbackSpec = npmSpecs.fallbackSpec;
    const expectedIntegrity = effectiveSpec === record.spec ? record.integrity : undefined;
    const fallbackExpectedIntegrity = fallbackSpec === record.spec ? record.integrity : undefined;

    if (!effectiveSpec || !recordSpec) {
      outcomes.push({
        pluginId,
        status: "skipped",
        message: `Skipping "${pluginId}" (missing npm spec).`,
      });
      continue;
    }

    let installPath: string;
    try {
      installPath = record.installPath ?? resolvePluginInstallDir(pluginId);
    } catch (err) {
      outcomes.push({
        pluginId,
        status: "error",
        message: `Invalid install path for "${pluginId}": ${String(err)}`,
      });
      continue;
    }
    const currentVersion = await readInstalledPackageVersion(installPath, {
      pluginId,
      logger: pluginLogger,
    });

    if (params.dryRun) {
      let probe: Awaited<ReturnType<typeof installPluginFromNpmSpec>>;
      try {
        probe = await installPluginFromNpmSpec({
          spec: effectiveSpec,
          mode: "update",
          dryRun: true,
          expectedPluginId: pluginId,
          expectedIntegrity,
          onIntegrityDrift: createPluginUpdateIntegrityDriftHandler({
            pluginId,
            dryRun: true,
            logger: pluginLogger,
            onIntegrityDrift: params.onIntegrityDrift,
          }),
          logger: pluginLogger,
        });
      } catch (err) {
        outcomes.push({
          pluginId,
          status: "error",
          message: `Failed to check ${pluginId}: ${String(err)}`,
        });
        continue;
      }
      let usedNpmFallback = false;
      if (!probe.ok && fallbackSpec) {
        pluginLogger.warn?.(
          describeBetaNpmFallback({
            pluginId,
            betaSpec: npmSpecs.fallbackLabel ?? effectiveSpec,
            fallbackSpec,
            result: probe,
          }),
        );
        usedNpmFallback = true;
        probe = await installPluginFromNpmSpec({
          spec: fallbackSpec,
          mode: "update",
          dryRun: true,
          expectedPluginId: pluginId,
          expectedIntegrity: fallbackExpectedIntegrity,
          onIntegrityDrift: createPluginUpdateIntegrityDriftHandler({
            pluginId,
            dryRun: true,
            logger: pluginLogger,
            onIntegrityDrift: params.onIntegrityDrift,
          }),
          logger: pluginLogger,
        });
      }
      if (!probe.ok) {
        outcomes.push({
          pluginId,
          status: "error",
          message: `Failed to check ${pluginId}: npm install failed for ${npmUpdateFailureSpec({
            effectiveSpec,
            fallbackSpec,
            usedFallback: usedNpmFallback,
          })}: ${probe.error}`,
        });
        continue;
      }

      const nextVersion = probe.version ?? "unknown";
      const currentLabel = currentVersion ?? "unknown";
      if (currentVersion && probe.version && currentVersion === probe.version) {
        outcomes.push({
          pluginId,
          status: "unchanged",
          currentVersion: currentVersion ?? undefined,
          nextVersion: probe.version ?? undefined,
          resolvedSpec: probe.npmResolution?.resolvedSpec,
          integrity: probe.npmResolution?.integrity,
          warnings,
          packageReview: probe.review,
          message: `${pluginId} is up to date (${currentLabel}).`,
        });
      } else {
        outcomes.push({
          pluginId,
          status: "updated",
          currentVersion: currentVersion ?? undefined,
          nextVersion: probe.version ?? undefined,
          resolvedSpec: probe.npmResolution?.resolvedSpec,
          integrity: probe.npmResolution?.integrity,
          warnings,
          packageReview: probe.review,
          message: `Would update ${pluginId}: ${currentLabel} -> ${nextVersion}.`,
        });
      }
      continue;
    }

    let result: Awaited<ReturnType<typeof installPluginFromNpmSpec>>;
    try {
      result = await installPluginFromNpmSpec({
        spec: effectiveSpec,
        mode: "update",
        expectedPluginId: pluginId,
        expectedIntegrity,
        onIntegrityDrift: createPluginUpdateIntegrityDriftHandler({
          pluginId,
          dryRun: false,
          logger: pluginLogger,
          onIntegrityDrift: params.onIntegrityDrift,
        }),
        logger: pluginLogger,
      });
    } catch (err) {
      outcomes.push({
        pluginId,
        status: "error",
        message: `Failed to update ${pluginId}: ${String(err)}`,
      });
      continue;
    }
    let usedNpmFallback = false;
    if (!result.ok && fallbackSpec) {
      pluginLogger.warn?.(
        describeBetaNpmFallback({
          pluginId,
          betaSpec: npmSpecs.fallbackLabel ?? effectiveSpec,
          fallbackSpec,
          result,
        }),
      );
      usedNpmFallback = true;
      result = await installPluginFromNpmSpec({
        spec: fallbackSpec,
        mode: "update",
        expectedPluginId: pluginId,
        expectedIntegrity: fallbackExpectedIntegrity,
        onIntegrityDrift: createPluginUpdateIntegrityDriftHandler({
          pluginId,
          dryRun: false,
          logger: pluginLogger,
          onIntegrityDrift: params.onIntegrityDrift,
        }),
        logger: pluginLogger,
      });
    }
    if (!result.ok) {
      outcomes.push({
        pluginId,
        status: "error",
        message: `Failed to update ${pluginId}: npm install failed for ${npmUpdateFailureSpec({
          effectiveSpec,
          fallbackSpec,
          usedFallback: usedNpmFallback,
        })}: ${result.error}`,
      });
      continue;
    }

    const nextVersion =
      result.version ??
      (await readInstalledPackageVersion(result.targetDir, {
        pluginId,
        logger: pluginLogger,
      }));
    next = recordPluginInstall(next, {
      pluginId,
      source: "npm",
      spec: recordSpec,
      installPath: result.targetDir,
      version: nextVersion,
      ...buildNpmResolutionInstallFields(result.npmResolution),
    });
    changed = true;

    const currentLabel = currentVersion ?? "unknown";
    const nextLabel = nextVersion ?? "unknown";
    if (currentVersion && nextVersion && currentVersion === nextVersion) {
      outcomes.push({
        pluginId,
        status: "unchanged",
        currentVersion: currentVersion ?? undefined,
        nextVersion: nextVersion ?? undefined,
        resolvedSpec: result.npmResolution?.resolvedSpec,
        integrity: result.npmResolution?.integrity,
        warnings,
        packageReview: result.review,
        message: `${pluginId} already at ${currentLabel}.`,
      });
    } else {
      outcomes.push({
        pluginId,
        status: "updated",
        currentVersion: currentVersion ?? undefined,
        nextVersion: nextVersion ?? undefined,
        resolvedSpec: result.npmResolution?.resolvedSpec,
        integrity: result.npmResolution?.integrity,
        warnings,
        packageReview: result.review,
        message: `Updated ${pluginId}: ${currentLabel} -> ${nextLabel}.`,
      });
    }
  }

  return { config: next, changed, outcomes };
}

export async function syncPluginsForUpdateChannel(params: {
  config: FasedAgentConfig;
  channel: UpdateChannel;
  workspaceDir?: string;
  logger?: PluginUpdateLogger;
}): Promise<PluginChannelSyncResult> {
  const summary: PluginChannelSyncSummary = {
    switchedToBundled: [],
    switchedToNpm: [],
    warnings: [],
    errors: [],
  };
  const bundled = resolveBundledPluginSources({ workspaceDir: params.workspaceDir });
  if (bundled.size === 0) {
    return { config: params.config, changed: false, summary };
  }

  let next = params.config;
  const loadHelpers = buildLoadPathHelpers(next.plugins?.load?.paths ?? []);
  const installs = next.plugins?.installs ?? {};
  let changed = false;

  if (params.channel === "dev") {
    for (const [pluginId, record] of Object.entries(installs)) {
      const bundledInfo = bundled.get(pluginId);
      if (!bundledInfo) {
        continue;
      }

      loadHelpers.addPath(bundledInfo.localPath);

      const alreadyBundled =
        record.source === "path" && pathsEqual(record.sourcePath, bundledInfo.localPath);
      if (alreadyBundled) {
        continue;
      }

      next = recordPluginInstall(next, {
        pluginId,
        source: "path",
        sourcePath: bundledInfo.localPath,
        installPath: bundledInfo.localPath,
        spec: record.spec ?? bundledInfo.npmSpec,
        version: record.version,
      });
      summary.switchedToBundled.push(pluginId);
      changed = true;
    }
  } else {
    for (const [pluginId, record] of Object.entries(installs)) {
      const bundledInfo = bundled.get(pluginId);
      if (!bundledInfo) {
        continue;
      }

      if (record.source === "npm") {
        loadHelpers.removePath(bundledInfo.localPath);
        continue;
      }

      if (record.source !== "path") {
        continue;
      }
      if (!pathsEqual(record.sourcePath, bundledInfo.localPath)) {
        continue;
      }

      const spec = record.spec ?? bundledInfo.npmSpec;
      if (!spec) {
        summary.warnings.push(`Missing npm spec for ${pluginId}; keeping local path.`);
        continue;
      }

      let result: Awaited<ReturnType<typeof installPluginFromNpmSpec>>;
      try {
        result = await installPluginFromNpmSpec({
          spec,
          mode: "update",
          expectedPluginId: pluginId,
          logger: params.logger,
        });
      } catch (err) {
        summary.errors.push(`Failed to install ${pluginId}: ${String(err)}`);
        continue;
      }
      if (!result.ok) {
        summary.errors.push(`Failed to install ${pluginId}: ${result.error}`);
        continue;
      }

      next = recordPluginInstall(next, {
        pluginId,
        source: "npm",
        spec,
        installPath: result.targetDir,
        version: result.version,
        ...buildNpmResolutionInstallFields(result.npmResolution),
        sourcePath: undefined,
      });
      summary.switchedToNpm.push(pluginId);
      changed = true;
      loadHelpers.removePath(bundledInfo.localPath);
    }
  }

  if (loadHelpers.changed) {
    next = {
      ...next,
      plugins: {
        ...next.plugins,
        load: {
          ...next.plugins?.load,
          paths: loadHelpers.paths,
        },
      },
    };
    changed = true;
  }

  return { config: next, changed, summary };
}
