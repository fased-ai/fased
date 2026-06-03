import type { PluginInstallRecord } from "../config/types.plugins.js";
import { validateRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import type { PluginMarketplaceEntry } from "./marketplace.js";
import type { PluginUpdateOutcome } from "./update.js";

export type PluginMarketplaceSourceTrust = {
  source: PluginInstallRecord["source"];
  spec?: string;
  trusted: boolean;
  reason: string;
  integrityPinned: boolean;
  resolvedSpec?: string;
  resolvedIntegrity?: string;
};

export type PluginMarketplacePermissionDiff = {
  added: {
    channels: string[];
    providers: string[];
    tools: string[];
    skills: string[];
  };
  removed: {
    channels: string[];
    providers: string[];
    tools: string[];
    skills: string[];
  };
  changed: string[];
};

export type PluginMarketplaceUpdateReview = {
  currentVersion?: string;
  nextVersion?: string;
  sourceTrust: PluginMarketplaceSourceTrust;
  dependencyWarnings: string[];
  scriptWarnings: string[];
  runtimeWarnings: string[];
  scanWarnings: string[];
  permissionDiff: PluginMarketplacePermissionDiff;
  approvalRequired: boolean;
  reasons: string[];
};

function dedupeSorted(values: Iterable<string>): string[] {
  return [...new Set(values)]
    .map((value) => value.trim())
    .filter(Boolean)
    .toSorted((left, right) => left.localeCompare(right));
}

function diffLists(current: readonly string[], next: readonly string[]) {
  const currentSet = new Set(current);
  const nextSet = new Set(next);
  return {
    added: dedupeSorted(next.filter((value) => !currentSet.has(value))),
    removed: dedupeSorted(current.filter((value) => !nextSet.has(value))),
  };
}

function normalizeClawHubOrigin(value?: string): string | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

function formatMissingClawHubMetadata(install: PluginInstallRecord): string[] {
  const missing: string[] = [];
  if (!install.clawhubUrl) {
    missing.push("clawhubUrl");
  }
  if (!install.clawhubArtifactUrl) {
    missing.push("clawhubArtifactUrl");
  }
  if (!install.clawhubPackage) {
    missing.push("clawhubPackage");
  }
  if (!install.clawhubFamily) {
    missing.push("clawhubFamily");
  }
  if (!install.clawhubChannel) {
    missing.push("clawhubChannel");
  }
  if (!install.version) {
    missing.push("version");
  }
  if (!install.artifactKind) {
    missing.push("artifactKind");
  }
  if (!install.artifactFormat) {
    missing.push("artifactFormat");
  }
  if (install.artifactKind === "npm-pack") {
    if (!install.npmIntegrity && !install.npmShasum) {
      missing.push("npmIntegrity");
    }
    if (!install.npmTarballName) {
      missing.push("npmTarballName");
    }
  }
  if (install.artifactKind === "clawpack") {
    if (!install.clawpackSha256) {
      missing.push("clawpackSha256");
    }
    if (typeof install.clawpackSpecVersion !== "number") {
      missing.push("clawpackSpecVersion");
    }
    if (!install.clawpackManifestSha256) {
      missing.push("clawpackManifestSha256");
    }
    if (typeof install.clawpackSize !== "number") {
      missing.push("clawpackSize");
    }
  }
  return missing;
}

function isClawHubIntegrityPinned(install: PluginInstallRecord): boolean {
  if (!install.integrity) {
    return false;
  }
  if (install.artifactKind === "clawpack") {
    return Boolean(install.clawpackSha256);
  }
  if (install.artifactKind === "npm-pack") {
    return Boolean(install.npmIntegrity || install.npmShasum);
  }
  return true;
}

function resolveClawHubSourceTrust(
  install: PluginInstallRecord,
  outcome: PluginUpdateOutcome,
): PluginMarketplaceSourceTrust {
  const spec =
    install.clawhubPackage && install.version
      ? `${install.clawhubPackage}@${install.version}`
      : install.clawhubPackage;
  const origin = normalizeClawHubOrigin(install.clawhubUrl);
  const missingMetadata = formatMissingClawHubMetadata(install);
  const integrityPinned = isClawHubIntegrityPinned(install);
  let reason = "ClawHub source allowlisted, artifact pinned, and local review completed";
  let trusted = true;

  if (!origin) {
    trusted = false;
    reason = "ClawHub source is missing a valid registry URL";
  } else if (origin !== "https://clawhub.com") {
    trusted = false;
    reason = `ClawHub registry is not allowlisted: ${origin}`;
  } else if (missingMetadata.length > 0) {
    trusted = false;
    reason = `ClawHub source metadata is incomplete: ${missingMetadata.join(", ")}`;
  } else if (!integrityPinned) {
    trusted = false;
    reason = "ClawHub source is missing pinned artifact integrity";
  } else if (!outcome.packageReview) {
    trusted = false;
    reason = "ClawHub source requires local package review";
  } else if ((outcome.warnings ?? []).length > 0) {
    trusted = false;
    reason = "ClawHub source has local scan warnings";
  }

  return {
    source: "clawhub",
    spec,
    trusted,
    reason,
    integrityPinned,
    resolvedSpec: outcome.resolvedSpec,
    resolvedIntegrity: outcome.integrity,
  };
}

function resolveSourceTrust(
  install: PluginInstallRecord | undefined,
  outcome: PluginUpdateOutcome,
): PluginMarketplaceSourceTrust {
  if (!install) {
    return {
      source: "archive",
      trusted: false,
      reason: "missing install record",
      integrityPinned: false,
    };
  }
  if (install.source === "clawhub") {
    return resolveClawHubSourceTrust(install, outcome);
  }
  if (install.source !== "npm") {
    return {
      source: install.source,
      spec: install.spec,
      trusted: false,
      reason: `updates from ${install.source} sources require manual review`,
      integrityPinned: false,
      resolvedSpec: outcome.resolvedSpec,
      resolvedIntegrity: outcome.integrity,
    };
  }
  const spec = install.spec?.trim();
  const registrySpecError = spec ? validateRegistryNpmSpec(spec) : "missing npm spec";
  const integrityPinned = Boolean(install.integrity);
  return {
    source: "npm",
    spec,
    trusted: !registrySpecError,
    reason: !registrySpecError
      ? integrityPinned
        ? "npm registry source with pinned integrity"
        : "npm registry source without pinned integrity"
      : `untrusted npm spec: ${registrySpecError}`,
    integrityPinned,
    resolvedSpec: outcome.resolvedSpec,
    resolvedIntegrity: outcome.integrity,
  };
}

function buildPermissionDiff(
  entry: PluginMarketplaceEntry,
  outcome: PluginUpdateOutcome,
): PluginMarketplacePermissionDiff {
  const review = outcome.packageReview;
  const channels = diffLists(entry.channels, review?.channels ?? []);
  const providers = diffLists(entry.providers, review?.providers ?? []);
  const tools = diffLists(entry.toolNames, review?.tools ?? []);
  const skills = diffLists([], review?.skills ?? []);
  const changed: string[] = [];
  if (entry.kind && review?.kind && entry.kind !== review.kind) {
    changed.push(`kind: ${entry.kind} -> ${review.kind}`);
  }
  return {
    added: {
      channels: channels.added,
      providers: providers.added,
      tools: tools.added,
      skills: skills.added,
    },
    removed: {
      channels: channels.removed,
      providers: providers.removed,
      tools: tools.removed,
      skills: skills.removed,
    },
    changed,
  };
}

function hasAddedPermissionSurface(diff: PluginMarketplacePermissionDiff): boolean {
  return (
    diff.added.channels.length > 0 ||
    diff.added.providers.length > 0 ||
    diff.added.tools.length > 0 ||
    diff.added.skills.length > 0 ||
    diff.changed.length > 0
  );
}

export function buildPluginMarketplaceUpdateReview(params: {
  entry: PluginMarketplaceEntry;
  outcome: PluginUpdateOutcome;
}): PluginMarketplaceUpdateReview {
  const sourceTrust = resolveSourceTrust(params.entry.install, params.outcome);
  const dependencyWarnings = params.outcome.packageReview?.dependencyWarnings ?? [];
  const scriptWarnings = params.outcome.packageReview?.scriptWarnings ?? [];
  const runtimeWarnings = params.outcome.packageReview?.runtimeWarnings ?? [];
  const scanWarnings = params.outcome.warnings ?? [];
  const permissionDiff = buildPermissionDiff(params.entry, params.outcome);
  const reasons: string[] = [];
  if (!sourceTrust.trusted) {
    reasons.push(sourceTrust.reason);
  }
  if (!sourceTrust.integrityPinned) {
    reasons.push("source integrity is not pinned");
  }
  if (dependencyWarnings.length > 0) {
    reasons.push("package dependency manifest changed or requires review");
  }
  if (scriptWarnings.length > 0) {
    reasons.push("package declares npm scripts");
  }
  if (runtimeWarnings.length > 0) {
    reasons.push("plugin package exposes source-only TypeScript entries");
  }
  if (scanWarnings.length > 0) {
    reasons.push("scan warnings were reported");
  }
  if (hasAddedPermissionSurface(permissionDiff)) {
    reasons.push("plugin manifest surface expands or changes");
  }
  return {
    currentVersion: params.outcome.currentVersion,
    nextVersion: params.outcome.nextVersion,
    sourceTrust,
    dependencyWarnings,
    scriptWarnings,
    runtimeWarnings,
    scanWarnings,
    permissionDiff,
    approvalRequired: reasons.length > 0,
    reasons: dedupeSorted(reasons),
  };
}

export function formatPluginMarketplaceUpdateReviewWarnings(
  review: PluginMarketplaceUpdateReview,
): string[] {
  return [
    ...review.reasons.map((reason) => `Update review: ${reason}`),
    ...review.dependencyWarnings,
    ...review.scriptWarnings,
    ...review.runtimeWarnings,
    ...review.scanWarnings,
  ];
}
