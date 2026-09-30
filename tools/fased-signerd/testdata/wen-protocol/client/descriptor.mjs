// Pins are supplied by trusted application configuration, never by the same API
// supplying the descriptor. Hash binding is not chain deployment verification.
export async function bindDescriptor(bytes, expectedSha256) {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.length === 0 ||
    bytes.length > 32768 ||
    typeof expectedSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(expectedSha256)
  ) {
    throw new Error("invalid descriptor binding");
  }
  const snapshot = bytes.slice();
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", snapshot)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  if (digest !== expectedSha256) {
    throw new Error("descriptor digest mismatch");
  }
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(snapshot));
  const fields = [
    "$schema",
    "descriptorVersion",
    "stage",
    "source",
    "componentGenerations",
    "build",
    "interfaces",
    "deployment",
    "runtimeCompatibility",
    "publication",
    "receiptBinding",
    "descriptorDigest",
  ];
  const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  if (
    !object(value) ||
    Object.keys(value).toSorted().join(",") !== fields.toSorted().join(",") ||
    !["source", "componentGenerations", "build", "interfaces"].every(
      (k) => object(value[k]) && value[k].status === "BOUND",
    ) ||
    !["deployment", "runtimeCompatibility", "publication", "receiptBinding"].every(
      (k) =>
        object(value[k]) &&
        ["BOUND", "NOT_BOUND"].includes(value[k].status) &&
        typeof value[k].reason === "string" &&
        value[k].reason.length > 0,
    ) ||
    typeof value.descriptorDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(value.descriptorDigest)
  ) {
    throw new Error("invalid descriptor schema");
  }
  if (
    !value ||
    value.$schema !== "sat.release-descriptor.v2" ||
    value.descriptorVersion !== 2 ||
    value.stage !== "deployed-release" ||
    value.deployment?.status !== "BOUND" ||
    value.interfaces?.status !== "BOUND"
  ) {
    throw new Error("descriptor not deployment-bound");
  }
  const canonical = (v) =>
    Array.isArray(v)
      ? v.map(canonical)
      : object(v)
        ? Object.fromEntries(
            Object.keys(v)
              .toSorted()
              .map((k) => [k, canonical(v[k])]),
          )
        : v;
  const { descriptorDigest, ...payload } = value;
  const canonicalBytes = new TextEncoder().encode(JSON.stringify(canonical(payload)) + "\n");
  const internalDigest = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", canonicalBytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  if (descriptorDigest !== "sha256:" + internalDigest) {
    throw new Error("descriptor internal digest mismatch");
  }
  const freeze = (v) => {
    if (v && typeof v === "object") {
      Object.values(v).forEach(freeze);
      Object.freeze(v);
    }
    return v;
  };
  return freeze(value);
}

// Compares an RPC account snapshot against caller-owned expectations. Decoding
// and authenticating the expectations remain the planner's responsibility.
export function assertAccountSnapshot(actual, expected) {
  if (
    !actual ||
    !expected ||
    typeof expected.address !== "string" ||
    typeof expected.owner !== "string" ||
    typeof expected.executable !== "boolean" ||
    !(expected.data instanceof Uint8Array) ||
    actual.address !== expected.address ||
    actual.owner !== expected.owner ||
    actual.executable !== expected.executable ||
    !(actual.data instanceof Uint8Array) ||
    actual.data.length !== expected.data.length ||
    actual.data.some((byte, i) => byte !== expected.data[i])
  ) {
    throw new Error("account snapshot mismatch");
  }
}
