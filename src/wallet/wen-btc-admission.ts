import { createHash } from "node:crypto";

export type WenBtcReviewPins = {
  artifactDigest: string;
  capabilityDigest: string;
  sourceDigest: string;
  contractDigest: string;
  accountOrderDigest: string;
};

// Read-only source admission. Pins must come from reviewed local configuration,
// never from the artifact being checked. This function grants no signer access.
export function inspectWenBtcReview(bytes: Uint8Array, pins: WenBtcReviewPins) {
  const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
  const fields = [
    "capabilityDigest",
    "sourceDigest",
    "contractDigest",
    "accountOrderDigest",
  ] as const;
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.length === 0 ||
    bytes.length > 16384 ||
    !pins ||
    ["artifactDigest", ...fields].some(
      (key) => !/^[0-9a-f]{64}$/.test(pins[key as keyof WenBtcReviewPins] ?? ""),
    )
  ) {
    throw new Error("Invalid WEN BTC review binding");
  }
  const snapshot = bytes.slice();
  if (hash(snapshot) !== pins.artifactDigest) {
    throw new Error("WEN BTC review artifact mismatch");
  }
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(snapshot));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid WEN BTC review artifact");
  }
  const v = value as Record<string, unknown>;
  if (
    v.schema !== "fased.wen-btc-subscription-acknowledgement-candidate.v1" ||
    v.state !== "SOURCE_REVIEW_ONLY" ||
    v.publicEntryEnabled !== false ||
    v.signingEnabled !== false ||
    v.legacyCapabilityReuse !== false ||
    v.deployment !== "NOT_BOUND" ||
    v.runtime !== "NOT_BOUND" ||
    v.ownerPermission !== "NOT_BOUND" ||
    v.portableClient !== "client/btc-subscription-client.mjs" ||
    !Array.isArray(v.operations) ||
    v.operations.length !== 2 ||
    v.operations[0] !== "acceptance" ||
    v.operations[1] !== "acquisition" ||
    fields.some((field) => v[field] !== pins[field])
  ) {
    throw new Error("Unsupported or mismatched WEN BTC review capability");
  }
  return Object.freeze({
    status: "SOURCE_REVIEW_ONLY" as const,
    signingEnabled: false as const,
    publicEntryEnabled: false as const,
    capabilityDigest: pins.capabilityDigest,
    operations: Object.freeze(["acceptance", "acquisition"] as const),
    missing: Object.freeze(["deployment", "installedRuntime", "ownerPermission"] as const),
  });
}
