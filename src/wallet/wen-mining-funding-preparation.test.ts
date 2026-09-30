import { describe, expect, it, vi } from "vitest";
import { parseLocalSocketSignerRequest } from "./local-socket-signer-protocol.js";
import { callLocalSocketSigner } from "./providers/local-socket-signer-adapter.js";
import { prepareWenMiningFundingWithSigner } from "./wen-mining-funding-preparation.js";
vi.mock("./providers/local-socket-signer-adapter.js", () => ({ callLocalSocketSigner: vi.fn() }));
const intent = {
  descriptorSha256: "ab".repeat(32),
  capabilitySha256: "cd".repeat(32),
  genesis: "So11111111111111111111111111111111111111112",
  programId: "So11111111111111111111111111111111111111112",
  sale: "So11111111111111111111111111111111111111112",
  vaultId: "So11111111111111111111111111111111111111112",
  nonce: "42",
  amount: "6000",
  deadline: "100",
  maxFeeLamports: "5000",
  minFinalizedSlot: "100",
  expiresSlot: "200",
};
const preview = {
  operation: "portfolio-mining-funding",
  capitalLamports: "6000",
  rentLamports: "0",
  descriptorSha256: intent.descriptorSha256,
  status: "requires-signing-revalidation",
  signingEnabled: false,
  slot: "150",
  networkFeeLamports: "5000",
  computeUnits: "10000",
  messageSha256: "ef".repeat(32),
};
describe("mining funding preparation socket contract", () => {
  it("routes a strict request and returns an immutable read-only preview", async () => {
    const request = { op: "v2.wenMiningFunding.prepare", walletId: "owner", request: intent };
    expect(parseLocalSocketSignerRequest(request)).toEqual(request);
    vi.mocked(callLocalSocketSigner).mockResolvedValue(preview);
    const result = await prepareWenMiningFundingWithSigner("/tmp/fixture.sock", "owner", intent);
    expect(result).toEqual(preview);
    expect(Object.isFrozen(result)).toBe(true);
    expect(callLocalSocketSigner).toHaveBeenCalledWith("/tmp/fixture.sock", request);
  });
  for (const patch of [
    { signingEnabled: true },
    { descriptorSha256: "00".repeat(32) },
    { slot: "99" },
    { slot: "200" },
    { networkFeeLamports: "5001" },
    { rentLamports: "1" },
    { capitalLamports: "5999" },
    { capitalLamports: 6000 },
    { networkFeeLamports: "0" },
    { computeUnits: "200001" },
    { slot: "18446744073709551616" },
    { rpcUrl: "https://unexpected.invalid" },
  ]) {
    it(`rejects response ${JSON.stringify(patch)}`, async () => {
      vi.mocked(callLocalSocketSigner).mockResolvedValue({ ...preview, ...patch });
      await expect(
        prepareWenMiningFundingWithSigner("/tmp/fixture.sock", "owner", intent),
      ).rejects.toThrow();
    });
  }
  for (const patch of [
    { amount: "0" },
    { nonce: "18446744073709551616" },
    { nonce: "042" },
    { deadline: "9223372036854775808" },
    { deadline: "0" },
    { maxFeeLamports: "6500001" },
    { minFinalizedSlot: "0" },
    { vaultId: "11111111111111111111111111111111" },
    { maxFeeLamports: "0" },
    { expiresSlot: "100" },
    { programId: "invalid" },
    { rpcUrl: "https://unexpected.invalid" },
  ]) {
    it(`rejects request ${JSON.stringify(patch)}`, () => {
      expect(() =>
        parseLocalSocketSignerRequest({
          op: "v2.wenMiningFunding.prepare",
          walletId: "owner",
          request: { ...intent, ...patch },
        }),
      ).toThrow();
    });
  }
  it("rejects ambiguous wallet identifiers", async () => {
    await expect(
      prepareWenMiningFundingWithSigner("/tmp/fixture.sock", " owner", intent),
    ).rejects.toThrow();
  });
});
