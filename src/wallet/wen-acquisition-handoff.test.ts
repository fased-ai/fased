import { expect, it } from "vitest";
import { buildWenAcquisitionHandoff } from "./wen-acquisition-handoff.js";
const owner = "C9y1TCfmUh3DbCpec1GvuuWdV4EYcE2N23tsgcUbgJ4N";
const snapshot = {
  identity: {
    economy: "sat-v1",
    genesis: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
    program: "a".repeat(64),
    mint: "b".repeat(64),
    deployedBytesHash: "c".repeat(64),
    deploymentSlot: "12",
    upgradeAuthority: null,
  },
  slot: "13",
  observedAtMs: 1000,
  expiresAtMs: 1200,
  rows: [],
  signingEnabled: false as const,
};
it("creates owner/size/deployment-bound navigation only for Buy and Bonds", () => {
  for (const action of ["buy", "bond"]) {
    const q = {
      owner,
      action,
      netAtoms: "100000000000",
      ...(action === "bond" ? { nonce: "123" } : {}),
    };
    const r = buildWenAcquisitionHandoff(q, snapshot, "http://127.0.0.1:3004/", 1100);
    expect(r.mode).toBe("manual-owner-handoff");
    expect(r.signingEnabled).toBe(false);
    const payload = JSON.parse(
      new URLSearchParams(new URL(r.url).hash.slice(1)).get("wen-request")!,
    );
    expect(payload.owner).toBe(owner);
    expect(payload.expiresAtMs).toBe(1200);
    expect(payload.program).toBe(snapshot.identity.program);
    expect(payload.netAtoms).toBe(q.netAtoms);
    expect(payload.nonce).toBe(action === "bond" ? "123" : undefined);
  }
});
it("rejects stale facts, invalid quantities, unexpected routes and caller authority", () => {
  const q = { owner, action: "buy", netAtoms: "1" };
  for (const bad of [
    { ...q, rpcUrl: "https://evil.invalid" },
    { ...q, netAtoms: "0" },
    { ...q, netAtoms: "18446744073709551616" },
    { ...q, owner: "invalid" },
    { ...q, nonce: "1" },
    { ...q, action: "bond" },
    { ...q, action: "bond", nonce: "18446744073709551616" },
  ]) {
    expect(() =>
      buildWenAcquisitionHandoff(bad, snapshot, "http://127.0.0.1:3004/", 1100),
    ).toThrow();
  }
  for (const url of [
    "https://evil.invalid/",
    "http://localhost:3004/",
    "http://127.0.0.1:3004/?rpc=evil",
    "http://owner@127.0.0.1:3004/",
  ]) {
    expect(() => buildWenAcquisitionHandoff(q, snapshot, url, 1100)).toThrow();
  }
  expect(() => buildWenAcquisitionHandoff(q, snapshot, "http://127.0.0.1:3004/", 1200)).toThrow();
});

it("rejects mismatched or unavailable deployment identities", () => {
  const input = { owner, action: "buy", netAtoms: "1" };
  for (const identity of [
    { ...snapshot.identity, genesis: "invalid" },
    { ...snapshot.identity, program: "invalid" },
    { ...snapshot.identity, deployedBytesHash: "invalid" },
    { ...snapshot.identity, economy: "invalid identity" },
  ]) {
    expect(() =>
      buildWenAcquisitionHandoff(input, { ...snapshot, identity }, "http://127.0.0.1:3004/", 1100),
    ).toThrow();
  }
});
