import { describe, expect, it, vi } from "vitest";
import { parseLocalSocketSignerRequest } from "./local-socket-signer-protocol.js";
import { callLocalSocketSigner } from "./providers/local-socket-signer-adapter.js";
import { prepareWenWithdrawalWithSigner } from "./wen-withdrawal-preparation.js";
vi.mock("./providers/local-socket-signer-adapter.js", () => ({ callLocalSocketSigner: vi.fn() }));
const intent = {
  descriptorSha256: "ab".repeat(32),
  capabilitySha256: "cd".repeat(32),
  genesis: "11111111111111111111111111111111",
  programId: "11111111111111111111111111111111",
  sale: "11111111111111111111111111111111",
  mint: "11111111111111111111111111111111",
  tokenAccount: "11111111111111111111111111111111",
  day: "1",
  expectedGross: "100",
  minimumNet: "97",
  maxFeeLamports: "5000",
  minFinalizedSlot: "100",
  expiresSlot: "200",
};
const preview = {
  operation: "withdraw",
  descriptorSha256: intent.descriptorSha256,
  status: "requires-signing-revalidation",
  signingEnabled: false,
  slot: "150",
  networkFeeLamports: "5000",
  computeUnits: "10000",
  messageSha256: "ef".repeat(32),
};
describe("withdrawal preparation socket contract", () => {
  it("routes a strict request and returns an immutable read-only preview", async () => {
    const request = { op: "v2.wenWithdrawal.prepare", walletId: "owner", request: intent };
    expect(parseLocalSocketSignerRequest(request)).toEqual(request);
    vi.mocked(callLocalSocketSigner).mockResolvedValue(preview);
    const result = await prepareWenWithdrawalWithSigner("/tmp/fixture.sock", "owner", intent);
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
    { computeUnits: "200001" },
    { slot: "18446744073709551616" },
    { rpcUrl: "https://unexpected.invalid" },
  ]) {
    it(`rejects response ${JSON.stringify(patch)}`, async () => {
      vi.mocked(callLocalSocketSigner).mockResolvedValue({ ...preview, ...patch });
      await expect(
        prepareWenWithdrawalWithSigner("/tmp/fixture.sock", "owner", intent),
      ).rejects.toThrow();
    });
  }
  for (const patch of [
    { minimumNet: "101" },
    { minimumNet: "0" },
    { day: "18446744073709551616" },
    { maxFeeLamports: "0" },
    { expiresSlot: "100" },
    { mint: "invalid" },
    { rpcUrl: "https://unexpected.invalid" },
  ]) {
    it(`rejects request ${JSON.stringify(patch)}`, () => {
      expect(() =>
        parseLocalSocketSignerRequest({
          op: "v2.wenWithdrawal.prepare",
          walletId: "owner",
          request: { ...intent, ...patch },
        }),
      ).toThrow();
    });
  }
  it("rejects ambiguous wallet identifiers", async () => {
    await expect(
      prepareWenWithdrawalWithSigner("/tmp/fixture.sock", " owner", intent),
    ).rejects.toThrow();
  });
});
