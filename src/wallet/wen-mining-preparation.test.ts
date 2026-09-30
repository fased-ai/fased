import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { callLocalSocketSigner } from "./providers/local-socket-signer-adapter.js";
import { prepareWenMiningWithSigner } from "./wen-mining-preparation.js";
vi.mock("./providers/local-socket-signer-adapter.js", () => ({ callLocalSocketSigner: vi.fn() }));
import { parseLocalSocketSignerRequest } from "./local-socket-signer-protocol.js";
import { bindWenMiningPreparation } from "./wen-mining-preparation-contract.js";
const { intent } = JSON.parse(
  readFileSync(
    new URL("../../tools/fased-signerd/testdata/wen-mining-candidate.json", import.meta.url),
    "utf8",
  ),
);
const preview = {
  status: "requires-signing-revalidation",
  signingEnabled: false,
  operation: intent.operation,
  entrySha256: intent.entrySha256,
  descriptorSha256: intent.descriptorSha256,
  messageSha256: "ab".repeat(32),
  slot: "150",
  networkFeeLamports: "5000",
  computeUnits: "10000",
};
describe("mining read-only preparation", () => {
  it("uses the local socket and returns only a bound preview", async () => {
    vi.mocked(callLocalSocketSigner).mockResolvedValue(preview);
    expect(await prepareWenMiningWithSigner("/tmp/test-only-signer.sock", "miner", intent)).toEqual(
      preview,
    );
    expect(callLocalSocketSigner).toHaveBeenCalledWith("/tmp/test-only-signer.sock", {
      op: "v2.wenMining.prepare",
      walletId: "miner",
      request: intent,
    });
  });
  it("binds the request and preview", () => {
    expect(
      parseLocalSocketSignerRequest({
        op: "v2.wenMining.prepare",
        walletId: "miner",
        request: intent,
      }).op,
    ).toBe("v2.wenMining.prepare");
    expect(bindWenMiningPreparation(preview, intent)).toEqual(preview);
  });
  for (const patch of [
    { signingEnabled: true },
    { slot: "99" },
    { slot: intent.expiresSlot },
    { networkFeeLamports: "5001" },
    { computeUnits: "200001" },
    { entrySha256: "cd".repeat(32) },
    { operation: "reveal" },
    { rpcUrl: "https://unexpected.invalid" },
    { slot: 150 },
  ]) {
    it(`rejects ${JSON.stringify(patch)}`, () => {
      expect(() => bindWenMiningPreparation({ ...preview, ...patch }, intent)).toThrow();
    });
  }
  it("rejects caller RPC configuration", () => {
    expect(() =>
      parseLocalSocketSignerRequest({
        op: "v2.wenMining.prepare",
        walletId: "miner",
        request: { ...intent, rpcUrl: "https://unexpected.invalid" },
      }),
    ).toThrow();
  });
});
