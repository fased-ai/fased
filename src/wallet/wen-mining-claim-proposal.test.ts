import { afterEach, expect, it, vi } from "vitest";
import { parseLocalSocketSignerRequest } from "./local-socket-signer-protocol.js";
import { callLocalSocketSigner } from "./providers/local-socket-signer-adapter.js";
import {
  bindWenMiningClaimProposal,
  validateWenMiningClaimProposalRequest,
} from "./wen-mining-claim-proposal-contract.js";
import { proposeWenMiningClaimWithSigner } from "./wen-mining-claim-proposal.js";
vi.mock("./providers/local-socket-signer-adapter.js", () => ({ callLocalSocketSigner: vi.fn() }));
const input = () => ({
  base: {
    operation: "sol",
    descriptorSha256: "a".repeat(64),
    capabilitySha256: "b".repeat(64),
    accountStateSha256: "c".repeat(64),
    genesis: "genesis",
    programId: "program",
    economy: "economy",
    id: "1",
    nonce: "2",
    ordinal: "0",
    expectedGross: "100",
    minimumReceived: "100",
    maxFeeLamports: "5000",
    minFinalizedSlot: "100",
    expiresSlot: "132",
  },
  reviewSha256: "d".repeat(64),
  minFinalizedSlot: "101",
  expiresSlot: "133",
});
const response = () => ({
  intent: {
    ...input().base,
    accountStateSha256: "e".repeat(64),
    minFinalizedSlot: "101",
    expiresSlot: "133",
  },
  baseReviewSha256: input().reviewSha256,
  observedSlot: 102,
  signingEnabled: false,
});
afterEach(() => vi.resetAllMocks());
it("binds refreshed state to unchanged admitted rights and owned request bytes", async () => {
  const request = input();
  vi.mocked(callLocalSocketSigner).mockImplementation(async () => {
    request.base.economy = "changed";
    return response();
  });
  expect(await proposeWenMiningClaimWithSigner("/fixture.sock", "miner", request)).toEqual(
    response(),
  );
  const sent = vi.mocked(callLocalSocketSigner).mock.calls[0][1];
  expect(parseLocalSocketSignerRequest(sent).op).toBe("v2.wenMining.claim.propose");
  expect(sent).toEqual({ op: "v2.wenMining.claim.propose", walletId: "miner", request: input() });
});
it.each([
  "economy",
  "programId",
  "genesis",
  "id",
  "nonce",
  "ordinal",
  "expectedGross",
  "minimumReceived",
  "maxFeeLamports",
  "descriptorSha256",
  "capabilitySha256",
  "minFinalizedSlot",
  "expiresSlot",
])("rejects changed %s", (key) => {
  const result = response();
  Object.assign(result.intent, { [key]: "9" });
  expect(() =>
    bindWenMiningClaimProposal(result, validateWenMiningClaimProposalRequest(input())),
  ).toThrow();
});
it.each([
  { signingEnabled: true },
  { baseReviewSha256: "f".repeat(64) },
  { observedSlot: 100 },
  { observedSlot: 134 },
  { observedSlot: Number.MAX_SAFE_INTEGER + 1 },
])("rejects unbound response %j", (change) => {
  expect(() =>
    bindWenMiningClaimProposal(
      { ...response(), ...change },
      validateWenMiningClaimProposalRequest(input()),
    ),
  ).toThrow();
});
it("rejects unexpected destination and invalid or retrograde bounds", () => {
  expect(() =>
    bindWenMiningClaimProposal(
      { ...response(), intent: { ...response().intent, destination: "other" } },
      validateWenMiningClaimProposalRequest(input()),
    ),
  ).toThrow();
  for (const change of [
    { minFinalizedSlot: "99" },
    { expiresSlot: "134" },
    { expiresSlot: "18446744073709551616" },
  ]) {
    expect(() => validateWenMiningClaimProposalRequest({ ...input(), ...change })).toThrow();
  }
});
it("enforces SAT net fees without losing integer precision", () => {
  const value = input();
  Object.assign(value.base, {
    operation: "sat",
    destination: "ata",
    expectedGross: "18446744073709551615",
    minimumReceived: "17893341751498265066",
  });
  expect(() => validateWenMiningClaimProposalRequest(value)).not.toThrow();
  value.base.minimumReceived = "18446744073709551615";
  expect(() => validateWenMiningClaimProposalRequest(value)).toThrow();
});
it("rejects invalid wallet before contacting signer", async () => {
  await expect(
    proposeWenMiningClaimWithSigner("/fixture.sock", " miner", input()),
  ).rejects.toThrow();
  expect(callLocalSocketSigner).not.toHaveBeenCalled();
});

it("rejects excessive fees and oversized requests before RPC", async () => {
  for (const base of [
    { ...input().base, maxFeeLamports: "6500001" },
    { ...input().base, economy: "x".repeat(8192) },
  ]) {
    await expect(
      proposeWenMiningClaimWithSigner("/fixture.sock", "miner", { ...input(), base }),
    ).rejects.toThrow();
  }
  expect(callLocalSocketSigner).not.toHaveBeenCalled();
});
