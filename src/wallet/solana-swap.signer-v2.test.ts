import { PublicKey } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exactJupiterTokenAccount,
  fetchJupiterSwapOrder,
  prepareSolanaSwapSignerReview,
  reviewedSolanaSwapOrderFromPayload,
  resolveSolanaSwapMinimumOutput,
  SOLANA_NATIVE_MINT,
  validateSolanaSwapRoutePolicy,
} from "./solana-swap.js";
import type { ResolvedWalletRuntimeConfig } from "./wallet-runtime-config.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("typed Jupiter signer flow", () => {
  it("derives a wrapped-SOL token account instead of treating the owner as a token account", async () => {
    const owner = new PublicKey(new Uint8Array(32).fill(7)).toBase58();
    const account = await exactJupiterTokenAccount({
      rpcUrl: "https://rpc.invalid",
      owner,
      mint: SOLANA_NATIVE_MINT,
    });
    expect(account).not.toBe(owner);
    expect(() => new PublicKey(account)).not.toThrow();
  });

  it("routes review preparation only through signer-v2 review.prepare", async () => {
    const owner = new PublicKey(new Uint8Array(32).fill(8)).toBase58();
    const prepare = vi.fn(async (request: { requestId: string; intent: unknown }) => ({
      requestId: request.requestId,
      walletId: "agent",
      intentType: "solana.jupiter.swap" as const,
      intentDigest: `sha256:${"a".repeat(64)}`,
      policyHash: `sha256:${"b".repeat(64)}`,
      mode: "autonomous" as const,
      nonce: "c".repeat(64),
      semanticIntent: request.intent as never,
      issuedAt: "2026-07-16T12:00:00Z",
      state: "prepared" as const,
      preparedAt: "2026-07-16T12:00:00Z",
      expiresAt: "2026-07-16T12:15:00Z",
      updatedAt: "2026-07-16T12:00:00Z",
    }));
    const signTx = vi.fn();
    const sendTx = vi.fn();
    const provider = {
      prepareJupiterReview: prepare,
      signTx,
      sendTx,
    } as never;
    const order = {
      ok: true as const,
      transaction: Buffer.from("unsigned").toString("base64"),
      inputMint: SOLANA_NATIVE_MINT,
      outputMint: SOLANA_NATIVE_MINT,
      inAmount: "100",
      outAmount: "95",
      otherAmountThreshold: "90",
      raw: {},
    };
    await prepareSolanaSwapSignerReview({
      provider,
      walletId: "agent",
      owner,
      order,
      inspection: {
        ok: true,
        signer: owner,
        programIds: ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"],
        routeProgramIds: [],
        writableAccounts: [owner],
        usesAddressLookupTables: false,
      },
      rpcUrl: "https://rpc.invalid",
      mode: "autonomous",
    });
    expect(prepare).toHaveBeenCalledOnce();
    expect(signTx).not.toHaveBeenCalled();
    expect(sendTx).not.toHaveBeenCalled();
  });

  it("rejects a Jupiter order that changes the requested exact input", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              transaction: Buffer.from("tx").toString("base64"),
              inAmount: "101",
              outAmount: "95",
              otherAmountThreshold: "90",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    await expect(
      fetchJupiterSwapOrder({
        inputMint: SOLANA_NATIVE_MINT,
        outputMint: new PublicKey(new Uint8Array(32).fill(9)).toBase58(),
        amount: "100",
      }),
    ).rejects.toThrow(/changed the requested exact input/);
  });

  it("derives the reviewed minimum output when Swap v2 omits otherAmountThreshold", () => {
    expect(
      resolveSolanaSwapMinimumOutput({
        ok: true,
        inputMint: SOLANA_NATIVE_MINT,
        outputMint: new PublicKey(new Uint8Array(32).fill(11)).toBase58(),
        inAmount: "100",
        outAmount: "101",
        slippageBps: 100,
        raw: {},
      }),
    ).toBe("100");
  });

  it("persists and reuses the exact reviewed transaction", () => {
    const payload = {
      chain: "solana" as const,
      actionKind: "solana_swap" as const,
      walletId: "agent",
      amount: "100",
      inputMint: SOLANA_NATIVE_MINT,
      outputMint: new PublicKey(new Uint8Array(32).fill(10)).toBase58(),
      outAmount: "95",
      otherAmountThreshold: "90",
      jupiterRequestId: "quote-1",
      serializedTxBase64: Buffer.from("reviewed-transaction").toString("base64"),
    };
    expect(reviewedSolanaSwapOrderFromPayload(payload)).toMatchObject({
      transaction: payload.serializedTxBase64,
      inAmount: "100",
      otherAmountThreshold: "90",
      requestId: "quote-1",
    });
  });

  it("fails closed when the configured Solana program allowlist is empty", () => {
    const config = {
      policy: { solana: { allowPrograms: [] } },
    } as unknown as ResolvedWalletRuntimeConfig;
    expect(
      validateSolanaSwapRoutePolicy({ config, routeProgramIds: ["route-program"] }),
    ).toMatchObject({ ok: false, code: "wallet_swap_program_allowlist_required" });
  });
});
