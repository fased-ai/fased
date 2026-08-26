export const SAT_CURRENT_CAPITAL_GENERATION = 2;
export const SAT_LEGACY_CAPITAL_GENERATIONS = [1] as const;

export type SatCapitalGeneration = "absent" | "current" | "legacy" | "unknown";
export type SatCapitalMutationClass = "new-entry" | "drain";
export type SatHistoryGenerationAccess = "active" | "drain-only" | "view-only";

export function classifySatCapitalGeneration(
  version: number | null | undefined,
): SatCapitalGeneration {
  if (version === null) {
    return "absent";
  }
  if (!Number.isSafeInteger(version) || Number(version) < 0) {
    return "unknown";
  }
  if (version === SAT_CURRENT_CAPITAL_GENERATION) {
    return "current";
  }
  return SAT_LEGACY_CAPITAL_GENERATIONS.includes(
    version as (typeof SAT_LEGACY_CAPITAL_GENERATIONS)[number],
  )
    ? "legacy"
    : "unknown";
}

export function assertSatCapitalMutationAllowed(input: {
  version: number | null | undefined;
  mutation: SatCapitalMutationClass;
  action: string;
}): SatCapitalGeneration {
  const generation = classifySatCapitalGeneration(input.version);
  if (generation === "unknown") {
    throw new Error(
      `SAT ${input.action} is blocked because the miner capital account generation is unknown`,
    );
  }
  if (input.mutation === "new-entry" && generation === "legacy") {
    throw new Error(
      `SAT ${input.action} is blocked for legacy generation 1; only reveal, recovery, claims, cleanup, and capital withdrawal remain available`,
    );
  }
  return generation;
}

export function classifySatHistoryGenerationAccess(input: {
  network: string;
  protocolVersion?: string | null;
  activeProtocolVersion: string;
}): SatHistoryGenerationAccess {
  if (input.network === "legacy-unknown" || !String(input.protocolVersion ?? "").trim()) {
    return "view-only";
  }
  return input.protocolVersion === input.activeProtocolVersion ? "active" : "drain-only";
}
