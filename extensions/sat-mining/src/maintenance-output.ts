export type SatMaintenanceCleanupResultSummary = {
  step?: string;
  txHash?: string;
  instructionCount?: number;
  authority?: string;
  authorities?: string[];
  pageIndex?: number;
  pageIndexes?: number[];
};

export type SatMaintenanceCleanupResultPayload = {
  cleanupResults?: SatMaintenanceCleanupResultSummary[];
  cleanupResultsTruncated?: number;
};

const DEFAULT_CLEANUP_RESULT_LIMIT = 12;

const asTrimmedString = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

const asSafeInteger = (value: unknown): number | undefined => {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    return undefined;
  }
  return value;
};

const asStringList = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entries = value
    .map((entry) => asTrimmedString(entry))
    .filter((entry): entry is string => Boolean(entry));
  return entries.length > 0 ? entries : undefined;
};

const asIntegerList = (value: unknown): number[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entries = value
    .map((entry) => asSafeInteger(entry))
    .filter((entry): entry is number => entry !== undefined);
  return entries.length > 0 ? entries : undefined;
};

const summarizeCleanupResult = (
  result: Record<string, unknown>,
): SatMaintenanceCleanupResultSummary | null => {
  const summary: SatMaintenanceCleanupResultSummary = {};
  const step = asTrimmedString(result.step);
  const txHash = asTrimmedString(result.txHash);
  const authority = asTrimmedString(result.authority);
  const instructionCount = asSafeInteger(result.instructionCount);
  const pageIndex = asSafeInteger(result.pageIndex);
  const authorities = asStringList(result.authorities);
  const pageIndexes = asIntegerList(result.pageIndexes);

  if (step) summary.step = step;
  if (txHash) summary.txHash = txHash;
  if (instructionCount !== undefined) summary.instructionCount = instructionCount;
  if (authority) summary.authority = authority;
  if (authorities) summary.authorities = authorities;
  if (pageIndex !== undefined) summary.pageIndex = pageIndex;
  if (pageIndexes) summary.pageIndexes = pageIndexes;

  return Object.keys(summary).length > 0 ? summary : null;
};

export const summarizeSatMaintenanceCleanupResults = (
  results: Array<Record<string, unknown>>,
  limit = DEFAULT_CLEANUP_RESULT_LIMIT,
): SatMaintenanceCleanupResultPayload => {
  const safeLimit = Math.max(0, Math.min(DEFAULT_CLEANUP_RESULT_LIMIT, Math.floor(limit)));
  if (safeLimit <= 0 || results.length === 0) {
    return {};
  }
  const cleanupResults = results
    .slice(0, safeLimit)
    .map((result) => summarizeCleanupResult(result))
    .filter((result): result is SatMaintenanceCleanupResultSummary => Boolean(result));
  if (cleanupResults.length === 0) {
    return {};
  }
  return {
    cleanupResults,
    ...(results.length > safeLimit ? { cleanupResultsTruncated: results.length - safeLimit } : {}),
  };
};
