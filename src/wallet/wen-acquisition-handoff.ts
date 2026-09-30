import { isValidSolanaAddress } from "./solana-address.js";
import type { readWenEconomyLocal } from "./wen-economy-read.js";

// A navigation request, never a quote, mandate, transaction or signer authorization.
export function buildWenAcquisitionHandoff(
  input: unknown,
  snapshot: Awaited<ReturnType<typeof readWenEconomyLocal>>,
  endpoint: string,
  nowMs = Date.now(),
) {
  const q = input as Record<string, unknown> | null;
  if (
    !q ||
    Object.keys(q).some((k) => !["owner", "action", "netAtoms", "nonce"].includes(k)) ||
    !isValidSolanaAddress(typeof q.owner === "string" ? q.owner : undefined) ||
    typeof q.owner !== "string" ||
    q.owner !== q.owner.trim() ||
    typeof q.action !== "string" ||
    !["buy", "bond"].includes(q.action) ||
    typeof q.netAtoms !== "string" ||
    !/^[1-9][0-9]{0,19}$/.test(q.netAtoms) ||
    BigInt(q.netAtoms) > 0xffffffffffffffffn ||
    (q.action === "bond"
      ? typeof q.nonce !== "string" ||
        !/^(0|[1-9][0-9]{0,19})$/.test(q.nonce) ||
        BigInt(q.nonce) > 0xffffffffffffffffn
      : q.nonce !== undefined)
  ) {
    throw Error("Invalid WEN acquisition request");
  }
  const url = new URL(endpoint);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw Error("WEN local terminal required");
  }
  if (
    !Number.isSafeInteger(nowMs) ||
    nowMs < snapshot.observedAtMs ||
    nowMs >= snapshot.expiresAtMs ||
    snapshot.signingEnabled ||
    !isValidSolanaAddress(snapshot.identity.genesis) ||
    !/^[a-z][a-z0-9-]{1,63}$/.test(snapshot.identity.economy) ||
    !/^[a-f0-9]{64}$/.test(snapshot.identity.program) ||
    !/^[a-f0-9]{64}$/.test(snapshot.identity.deployedBytesHash)
  ) {
    throw Error("Fresh pinned WEN snapshot required");
  }
  const request = {
    version: 1,
    action: q.action,
    owner: q.owner,
    economy: snapshot.identity.economy,
    genesis: snapshot.identity.genesis,
    program: snapshot.identity.program,
    deployedBytesHash: snapshot.identity.deployedBytesHash,
    netAtoms: q.netAtoms,
    ...(q.action === "bond" ? { nonce: q.nonce } : {}),
    issuedAtMs: nowMs,
    expiresAtMs: snapshot.expiresAtMs,
  };
  url.hash = new URLSearchParams({ "wen-request": JSON.stringify(request) }).toString();
  return Object.freeze({
    mode: "manual-owner-handoff" as const,
    signingEnabled: false as const,
    request: Object.freeze(request),
    url: url.href,
  });
}
