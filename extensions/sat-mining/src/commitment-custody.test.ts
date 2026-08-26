import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  allocateSignerOwnedSatCommitment,
  readSignerOwnedSatCommitmentBinding,
} from "./commitment-custody.js";

const callLocalSocketSigner = vi.fn();
const resolveSatCommitmentSignerContext = vi.fn(async () => ({
  socketPath: "/run/fased-signerd/signer.sock",
  walletId: "mining",
  authority: "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW", // pragma: allowlist secret
  cluster: "devnet" as const,
  programId: "EB4vLPuwkETenY7RxjEunneBuQoH8iMZdzrjqZDYvx75", // pragma: allowlist secret
}));

vi.mock("fased/plugin-sdk/sat-runtime", () => ({
  callLocalSocketSigner: (...args: unknown[]) => callLocalSocketSigner(...args),
}));

vi.mock("./solana-submit.js", () => ({
  resolveSatCommitmentSignerContext: (...args: unknown[]) =>
    resolveSatCommitmentSignerContext(...args),
}));

describe("signer-owned SAT commitment custody", () => {
  beforeEach(() => {
    callLocalSocketSigner.mockReset();
    resolveSatCommitmentSignerContext.mockClear();
  });

  it("asks the signer to allocate immutable material without returning the nonce", async () => {
    callLocalSocketSigner.mockResolvedValue({
      reference: `sha256:${"ab".repeat(32)}`,
      commitmentHex: "cd".repeat(32),
      cycleId: "123",
      committedLamports: "250000000",
      allocationCount: 25,
      protocolGeneration: "sat-v2",
    });
    const result = await allocateSignerOwnedSatCommitment({
      config: { enabled: true, network: "devnet", riskMode: "balanced", walletId: "mining" },
      cycleId: 123,
      committedLamports: 250_000_000,
      allocationFp: new Array(25).fill(40_000),
    });

    expect(result.reference).toBe(`sha256:${"ab".repeat(32)}`);
    expect(callLocalSocketSigner).toHaveBeenCalledWith(
      "/run/fased-signerd/signer.sock",
      expect.objectContaining({
        op: "v2.satCommitment.allocate",
        walletId: "mining",
        request: expect.objectContaining({
          protocolGeneration: "sat-v2",
          cycleId: "123",
          committedLamports: "250000000",
        }),
      }),
    );
    expect(JSON.stringify(result)).not.toContain("nonce");
  });

  it("recovers a public commitment pointer from signer-owned cycle identity", async () => {
    callLocalSocketSigner.mockResolvedValue({
      reference: `sha256:${"ab".repeat(32)}`,
      commitmentHex: "cd".repeat(32),
      cycleId: "123",
      committedLamports: "250000000",
      allocationCount: 25,
      protocolGeneration: "sat-v2",
    });
    const result = await readSignerOwnedSatCommitmentBinding({
      config: { enabled: true, network: "devnet", riskMode: "balanced", walletId: "mining" },
      cycleId: 123,
    });
    expect(result.reference).toBe(`sha256:${"ab".repeat(32)}`);
    expect(callLocalSocketSigner).toHaveBeenCalledWith(
      "/run/fased-signerd/signer.sock",
      expect.objectContaining({
        op: "v2.satCommitment.binding.get",
        request: expect.objectContaining({ cycleId: "123", protocolGeneration: "sat-v2" }),
      }),
    );
  });
});
