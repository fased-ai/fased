import { deriveSessionTotalTokens, type NormalizedUsage } from "../../agents/usage.js";
import { incrementCompactionCount } from "./session-updates.js";
import { persistSessionUsageUpdate } from "./session-usage.js";

type PersistRunSessionUsageParams = Parameters<typeof persistSessionUsageUpdate>[0];

type IncrementRunCompactionCountParams = Omit<
  Parameters<typeof incrementCompactionCount>[0],
  "tokensAfter"
> & {
  compactionTokensAfter?: number;
  lastCallUsage?: NormalizedUsage;
  contextTokensUsed?: number;
};

function resolvePositiveTokenCount(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

export async function persistRunSessionUsage(params: PersistRunSessionUsageParams): Promise<void> {
  await persistSessionUsageUpdate(params);
}

export async function incrementRunCompactionCount(
  params: IncrementRunCompactionCountParams,
): Promise<number | undefined> {
  const tokensAfterCompaction =
    resolvePositiveTokenCount(params.compactionTokensAfter) ??
    (params.lastCallUsage
      ? deriveSessionTotalTokens({
          usage: params.lastCallUsage,
          contextTokens: params.contextTokensUsed,
        })
      : undefined);
  return incrementCompactionCount({
    sessionEntry: params.sessionEntry,
    sessionStore: params.sessionStore,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    tokensAfter: tokensAfterCompaction,
  });
}
