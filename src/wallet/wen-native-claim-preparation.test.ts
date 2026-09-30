import { describe, expect, it, vi } from "vitest";
import { parseLocalSocketSignerRequest } from "./local-socket-signer-protocol.js";
import { callLocalSocketSigner } from "./providers/local-socket-signer-adapter.js";
import { prepareWenNativeClaimWithSigner } from "./wen-native-claim-preparation.js";
vi.mock("./providers/local-socket-signer-adapter.js", () => ({ callLocalSocketSigner: vi.fn() }));
const intent = {
  descriptorSha256: "ab".repeat(32),
  capabilitySha256: "cd".repeat(32),
  genesis: "So11111111111111111111111111111111111111112",
  programId: "So11111111111111111111111111111111111111112",
  sale: "So11111111111111111111111111111111111111112",
  mint: "So11111111111111111111111111111111111111112",
  destination: "So11111111111111111111111111111111111111112",
  award: "3",
  from: "1",
  minimumReceived: "97",
  maxRentLamports: "1000",
  maxFeeLamports: "5000",
  minFinalizedSlot: "100",
  expiresSlot: "200",
};
const preview = {
  operation: "native-staking-claim",
  grossSatRaw: "100",
  transferFeeSatRaw: "3",
  netSatRaw: "97",
  rentLamports: "1000",
  descriptorSha256: intent.descriptorSha256,
  status: "requires-signing-revalidation",
  signingEnabled: false,
  slot: "150",
  networkFeeLamports: "5000",
  computeUnits: "10000",
  messageSha256: "ef".repeat(32),
};
describe("native claim preparation socket contract", () => {
  it("routes a strict request and returns an immutable read-only preview", async () => {
    const request = { op: "v2.wenNativeClaim.prepare", walletId: "owner", request: intent };
    expect(parseLocalSocketSignerRequest(request)).toEqual(request);
    vi.mocked(callLocalSocketSigner).mockResolvedValue(preview);
    const result = await prepareWenNativeClaimWithSigner("/tmp/fixture.sock", "owner", intent);
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
    { rentLamports: "1001" },
    { grossSatRaw: "99", netSatRaw: "96" },
    { transferFeeSatRaw: "2", netSatRaw: "98" },
    { grossSatRaw: "18446744073709551616" },
    { netSatRaw: 97 },
    { computeUnits: "200001" },
    { slot: "18446744073709551616" },
    { rpcUrl: "https://unexpected.invalid" },
  ]) {
    it(`rejects response ${JSON.stringify(patch)}`, async () => {
      vi.mocked(callLocalSocketSigner).mockResolvedValue({ ...preview, ...patch });
      await expect(
        prepareWenNativeClaimWithSigner("/tmp/fixture.sock", "owner", intent),
      ).rejects.toThrow();
    });
  }
  for (const patch of [
    { from: "2" },
    { minimumReceived: "0" },
    { award: "18446744073709551616" },
    { award: "03" },
    { maxRentLamports: "6500000" },
    { minFinalizedSlot: "0" },
    { destination: "11111111111111111111111111111111" },
    { maxFeeLamports: "0" },
    { expiresSlot: "100" },
    { mint: "invalid" },
    { rpcUrl: "https://unexpected.invalid" },
  ]) {
    it(`rejects request ${JSON.stringify(patch)}`, () => {
      expect(() =>
        parseLocalSocketSignerRequest({
          op: "v2.wenNativeClaim.prepare",
          walletId: "owner",
          request: { ...intent, ...patch },
        }),
      ).toThrow();
    });
  }
  it("rejects ambiguous wallet identifiers", async () => {
    await expect(
      prepareWenNativeClaimWithSigner("/tmp/fixture.sock", " owner", intent),
    ).rejects.toThrow();
  });
});
