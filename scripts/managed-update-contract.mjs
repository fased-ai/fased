export const MANAGED_UPDATE_CONTRACT_SCHEMA_VERSION = 1;

const ROOT_PROFILES = new Set(["hosting", "protected-local"]);
const CONTROL_GENERATION_CONFLICTS = new Set([
  "last_success_mismatch",
  "last_success_unreadable",
  "runtime_manifest_mismatch",
  "stable_updater_mismatch",
]);
const CUSTODY_GENERATION_CONFLICTS = new Set([
  "signer_identity_unreadable",
  "signer_manifest_mismatch",
  "signer_version_mismatch",
]);

export function isRootManagedProfile(profile) {
  return ROOT_PROFILES.has(profile);
}

function adapterFor(profile) {
  if (profile === "hosting") {
    return "hosting-systemd";
  }
  if (profile === "protected-local" || profile === "local") {
    return "local-systemd";
  }
  if (profile === "source") {
    return "portable-development";
  }
  return null;
}

function plan(profile, operation, mutationOwner, reason) {
  return Object.freeze({
    schemaVersion: MANAGED_UPDATE_CONTRACT_SCHEMA_VERSION,
    profile,
    adapter: adapterFor(profile),
    operation,
    mutationOwner,
    reason,
  });
}

/**
 * Select one lifecycle operation and mutation owner before update-side writes.
 * Compatibility is based on manifest topology and capabilities, never an RC.
 */
export function selectManagedUpdatePlan({ profile, migration, consistencyReasons = [] } = {}) {
  if (isRootManagedProfile(profile)) {
    return plan(profile, "update", "target-controller", "canonical_root_profile");
  }
  if (profile === "source") {
    return plan(
      profile,
      "update",
      "portable-development-coordinator",
      "development_source_profile",
    );
  }
  if (profile !== "local") {
    return plan(String(profile || "unknown"), "repair", "none", "unsupported_managed_profile");
  }
  if (!migration || typeof migration !== "object") {
    return plan(profile, "repair", "none", "migration_state_missing");
  }

  const reasons = new Set(
    Array.isArray(consistencyReasons)
      ? consistencyReasons.filter((reason) => typeof reason === "string")
      : [],
  );
  const controlConflict = [...CONTROL_GENERATION_CONFLICTS].some((reason) => reasons.has(reason));
  const custodyConflict = [...CUSTODY_GENERATION_CONFLICTS].some((reason) => reasons.has(reason));
  if (controlConflict && custodyConflict) {
    return plan(profile, "repair", "none", "mixed_control_and_custody_generations");
  }
  if (migration.required && !migration.supported) {
    return plan(profile, "repair", "none", String(migration.reason || "migration_unavailable"));
  }
  if (migration.required) {
    return plan(profile, "bootstrap-protected", "target-controller", "supported_local_bridge");
  }
  return plan(
    profile,
    "update",
    "portable-development-coordinator",
    "canonical_portable_local_profile",
  );
}

export function legacyModeForManagedUpdatePlan(selected) {
  if (selected.operation === "repair") {
    return "repair-required";
  }
  if (selected.operation === "bootstrap-protected") {
    return "migrate-to-protected";
  }
  if (selected.mutationOwner === "target-controller") {
    return "root-managed";
  }
  return "portable-managed";
}
