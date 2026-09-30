import { describe, it, expect, vi, afterEach } from "vitest";
import { callLocalSocketSigner } from "./providers/local-socket-signer-adapter.js";
import {
  bindWenMiningRecoveryResult,
  validateWenMiningRecoveryRequest,
} from "./wen-mining-recovery-contract.js";
import { recoverWenMiningWithSigner, scheduleWenMiningRecovery } from "./wen-mining-recovery.js";
vi.mock("./providers/local-socket-signer-adapter.js", () => ({ callLocalSocketSigner: vi.fn() }));
const pins = {
  ProgramID: "program",
  Genesis: "genesis",
  DescriptorSHA256: "ab".repeat(32),
  CapabilitySHA256: "cd".repeat(32),
  CodeSHA256: "ef".repeat(32),
  DeploymentSlot: 1,
  UpgradeAuthority: null,
};
const request = () =>
  validateWenMiningRecoveryRequest({
    cursor: "",
    limit: 1,
    operation: "sol",
    pins,
    descriptor: "e30=",
    minFinalizedSlot: "100",
    expiresSlot: "132",
    maxFeeLamports: "5000",
    maxSlotLag: "2",
  });
const empty = () => ({
  items: [],
  nextCursor: "",
  scanComplete: true,
  scanned: 0,
  signingEnabled: false,
});
afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
});
describe("review-only mining recovery", () => {
  it("calls only recovery with owned request bytes", async () => {
    const input = request();
    vi.mocked(callLocalSocketSigner).mockImplementation(async () => {
      input.pins.ProgramID = "changed";
      return empty();
    });
    expect(await recoverWenMiningWithSigner("/socket", "miner", input)).toEqual(empty());
    expect(callLocalSocketSigner).toHaveBeenCalledWith(
      "/socket",
      expect.objectContaining({
        op: "v2.wenMining.claim.recover",
        request: expect.objectContaining({
          pins: expect.objectContaining({ ProgramID: "program" }),
        }),
      }),
      expect.anything(),
    );
  });
  for (const mode of ["signing", "unknown", "cursor", "count", "unsafe"]) {
    it(`rejects ${mode}`, () => {
      const out: Record<string, unknown> = empty();
      if (mode === "signing") {
        out.signingEnabled = true;
      }
      if (mode === "unknown") {
        out.install = true;
      }
      if (mode === "cursor") {
        out.nextCursor = "admission.json";
      }
      if (mode === "count") {
        out.scanned = 2;
      }
      if (mode === "unsafe") {
        out.scanned = Number.MAX_SAFE_INTEGER + 1;
      }
      expect(() => bindWenMiningRecoveryResult(out, request(), "miner")).toThrow();
    });
  }
  it("rejects malformed bounds before transport", async () => {
    await expect(
      recoverWenMiningWithSigner("/socket", "miner", { ...request(), expiresSlot: "0132" }),
    ).rejects.toThrow();
    expect(callLocalSocketSigner).not.toHaveBeenCalled();
  });
  it("schedules sequential fresh bounds and propagates cursor", async () => {
    vi.useFakeTimers();
    const first = { ...empty(), scanComplete: false, scanned: 1, nextCursor: "admission.json" };
    vi.mocked(callLocalSocketSigner).mockResolvedValueOnce(first).mockResolvedValueOnce(empty());
    const source = vi.fn(async () => request());
    const loop = scheduleWenMiningRecovery("/socket", "miner", {
      ticks: 2,
      intervalMs: 5000,
      signal: new AbortController().signal,
      request: source,
    });
    expect((await loop.next()).value).toEqual(first);
    const next = loop.next();
    expect(callLocalSocketSigner).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await next).value).toEqual(empty());
    expect(source).toHaveBeenCalledTimes(2);
    const secondCall = vi.mocked(callLocalSocketSigner).mock.calls[1][1];
    expect(secondCall.op).toBe("v2.wenMining.claim.recover");
    if (secondCall.op !== "v2.wenMining.claim.recover") {
      throw Error("Unexpected recovery operation");
    }
    expect(secondCall.request).toMatchObject({
      cursor: "admission.json",
    });
    expect((await loop.next()).done).toBe(true);
  });
  it("suppresses in-flight results after cancellation", async () => {
    const controller = new AbortController();
    vi.mocked(callLocalSocketSigner).mockImplementation(async () => {
      controller.abort();
      return empty();
    });
    const loop = scheduleWenMiningRecovery("/socket", "miner", {
      ticks: 2,
      intervalMs: 5000,
      signal: controller.signal,
      request: async () => request(),
    });
    await expect(loop.next()).rejects.toThrow();
    expect(callLocalSocketSigner).toHaveBeenCalledTimes(1);
  });
  it("does not start when cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const loop = scheduleWenMiningRecovery("/socket", "miner", {
      ticks: 1,
      intervalMs: 5000,
      signal: controller.signal,
      request: async () => request(),
    });
    await expect(loop.next()).rejects.toThrow();
    expect(callLocalSocketSigner).not.toHaveBeenCalled();
  });
});

describe("draft binding", () => {
  for (const mode of ["valid", "wallet", "pins", "amount", "unsafe-slot"]) {
    it(mode, () => {
      const input = request();
      const intent = {
        operation: "sol",
        descriptorSha256: pins.DescriptorSHA256,
        capabilitySha256: pins.CapabilitySHA256,
        accountStateSha256: "11".repeat(32),
        genesis: pins.Genesis,
        programId: pins.ProgramID,
        economy: "economy",
        id: "1",
        nonce: "2",
        ordinal: "0",
        expectedGross: "100",
        minimumReceived: "100",
        maxFeeLamports: "5000",
        minFinalizedSlot: "101",
        expiresSlot: "132",
      };
      const item = {
        entry: "entry",
        status: "requires-review",
        proposal: { intent, observedSlot: 101, status: "requires-review", signingEnabled: false },
        reviewDraft: {
          review: {
            version: 1,
            walletId: "miner",
            walletPublicKey: "owner",
            intent: structuredClone(intent),
            pins: structuredClone(input.pins),
            maxTotalCostLamports: 5000,
            maxSlotLag: 2,
          },
          descriptor: input.descriptor,
        },
      };
      if (mode === "wallet") {
        item.reviewDraft.review.walletId = "other";
      }
      if (mode === "pins") {
        item.reviewDraft.review.pins.CodeSHA256 = "22".repeat(32);
      }
      if (mode === "amount") {
        item.reviewDraft.review.intent.expectedGross = "999";
      }
      if (mode === "unsafe-slot") {
        item.proposal.observedSlot = Number.MAX_SAFE_INTEGER + 1;
      }
      const out = { ...empty(), scanned: 1, items: [item] };
      if (mode === "valid") {
        expect(bindWenMiningRecoveryResult(out, input, "miner")).toEqual(out);
      } else {
        expect(() => bindWenMiningRecoveryResult(out, input, "miner")).toThrow();
      }
    });
  }
});

it("accepts literal admission cursors and rejects lookalikes", () => {
  for (const cursor of ["admission.json", `admission-${"ab".repeat(32)}.json`]) {
    expect(validateWenMiningRecoveryRequest({ ...request(), cursor }).cursor).toBe(cursor);
  }
  for (const cursor of ["admissionXjson", "admission\\xjson", "../admission.json"]) {
    expect(() => validateWenMiningRecoveryRequest({ ...request(), cursor })).toThrow();
  }
});

it("cancels a stuck provider without contacting signer", async () => {
  const controller = new AbortController();
  let providerSignal: AbortSignal | undefined;
  const loop = scheduleWenMiningRecovery("/socket", "miner", {
    ticks: 1,
    intervalMs: 5000,
    signal: controller.signal,
    request: async (signal) => {
      providerSignal = signal;
      return await new Promise(() => {});
    },
  });
  const next = loop.next();
  const rejected = expect(next).rejects.toThrow();
  await Promise.resolve();
  await Promise.resolve();
  controller.abort();
  await rejected;
  expect(providerSignal?.aborted).toBe(true);
  expect(callLocalSocketSigner).not.toHaveBeenCalled();
});
it("times out fresh-bound reads and suppresses their late result", async () => {
  vi.useFakeTimers();
  let release!: (value: ReturnType<typeof request>) => void;
  const loop = scheduleWenMiningRecovery("/socket", "miner", {
    ticks: 1,
    intervalMs: 5000,
    signal: new AbortController().signal,
    request: async () =>
      await new Promise((resolve) => {
        release = resolve;
      }),
  });
  const rejected = expect(loop.next()).rejects.toThrow("provider timed out");
  await vi.advanceTimersByTimeAsync(10_000);
  await rejected;
  release(request());
  await Promise.resolve();
  expect(callLocalSocketSigner).not.toHaveBeenCalled();
});
