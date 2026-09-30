export type OwnerMarketApproval = {
  proofId: string;
  requestId: string;
  walletId: string;
  artifactDigest: string;
  expiresAt: string;
};

export function bindOwnerMarketApproval(
  value: unknown,
  expected: { requestId: string; walletId: string; artifactDigest: string; expiresAt: string },
  proofId: string,
): OwnerMarketApproval {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Error("Invalid owner confirmation");
  }
  const v = value as Record<string, unknown>;
  const expiry = typeof v.expiresAt === "string" ? Date.parse(v.expiresAt) : NaN;
  if (
    Object.keys(v).toSorted().join(",") !== "artifactDigest,expiresAt,proofId,requestId,walletId" ||
    !/^[A-Za-z0-9_-]{43}$/.test(proofId) ||
    v.proofId !== proofId ||
    v.requestId !== expected.requestId ||
    v.walletId !== expected.walletId ||
    v.artifactDigest !== expected.artifactDigest ||
    !Number.isFinite(expiry) ||
    expiry <= Date.now() ||
    expiry > Date.parse(expected.expiresAt)
  ) {
    throw Error("Owner confirmation expired or changed");
  }
  return structuredClone(v) as OwnerMarketApproval;
}
