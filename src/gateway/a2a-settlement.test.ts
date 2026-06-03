import { describe, expect, it, vi } from "vitest";
import type { WalletSendApprovalPayload } from "../wallet/wallet-send-approvals.js";
import { extractA2aSettlementIntent, orchestrateA2aTaskSettlement } from "./a2a-settlement.js";

describe("extractA2aSettlementIntent", () => {
  it("extracts intent from paid task settlement fields", () => {
    const intent = extractA2aSettlementIntent({
      prompt: "paid task",
      invoiceRef: "inv-123",
      settlement: {
        chain: "solana",
        to: "So11111111111111111111111111111111111111112",
        amount: "42",
        program: "So11111111111111111111111111111111111111112",
      },
    });
    expect(intent).not.toBeNull();
    expect(intent?.invoiceId).toBe("inv-123");
    expect(intent?.payload).toEqual({
      chain: "solana",
      to: "So11111111111111111111111111111111111111112",
      amount: "42",
      program: "So11111111111111111111111111111111111111112",
      memo: "inv-123",
      providerId: undefined,
      walletId: undefined,
      walletName: undefined,
    });
  });

  it("returns null when chain or amount is missing", () => {
    expect(extractA2aSettlementIntent({ payment: { chain: "solana" } })).toBeNull();
    expect(extractA2aSettlementIntent({ payment: { amount: "1" } })).toBeNull();
  });

  it("extracts provider and wallet routing fields", () => {
    const intent = extractA2aSettlementIntent({
      providerId: "turnkey",
      wallet: {
        id: "w_treasury",
        name: "treasury-main",
      },
      payment: {
        chain: "solana",
        amount: "7",
        to: "So11111111111111111111111111111111111111112",
      },
    });
    expect(intent).not.toBeNull();
    expect(intent?.payload.providerId).toBe("turnkey");
    expect(intent?.payload.walletId).toBe("w_treasury");
    expect(intent?.payload.walletName).toBe("treasury-main");
  });

  it("maps canonical asset metadata into wallet routing fields", () => {
    const intent = extractA2aSettlementIntent({
      invoice: {
        chain: "solana",
        amount: 7,
        to: "So11111111111111111111111111111111111111112",
        asset: {
          kind: "spl-token",
          address: "So11111111111111111111111111111111111111112",
        },
      },
    });
    expect(intent).not.toBeNull();
    expect(intent?.payload.program).toBe("So11111111111111111111111111111111111111112");
  });

  it("accepts local-socket-signer provider id in settlement payloads", () => {
    const intent = extractA2aSettlementIntent({
      providerId: "local-socket-signer",
      payment: {
        chain: "solana",
        amount: "1",
        to: "So11111111111111111111111111111111111111112",
      },
    });
    expect(intent).not.toBeNull();
    expect(intent?.payload.providerId).toBe("local-socket-signer");
  });
});

describe("orchestrateA2aTaskSettlement", () => {
  it("returns queued for manual mode and forwards settlement context", async () => {
    const createOrExecute = vi.fn(
      async (params: {
        payload: WalletSendApprovalPayload;
        settlementContext?: { taskId: string; invoiceId?: string; senderHandle?: string };
      }) => {
        expect(params.payload.chain).toBe("solana");
        expect(params.payload.amount).toBe("100");
        expect(params.payload.providerId).toBe("turnkey");
        expect(params.payload.walletName).toBe("treasury-main");
        expect(params.settlementContext?.taskId).toBe("task-1");
        expect(params.settlementContext?.invoiceId).toBe("inv-1");
        return {
          ok: true as const,
          mode: "manual" as const,
          request: {
            id: "req-1",
          },
        };
      },
    );
    const result = await orchestrateA2aTaskSettlement({
      taskId: "task-1",
      senderHandle: "@verified@ff1.fased.app",
      taskInput: {
        prompt: "paid task",
        invoiceRef: "inv-1",
        providerId: "turnkey",
        walletName: "treasury-main",
        payment: {
          chain: "solana",
          amount: "100",
          to: "So11111111111111111111111111111111111111112",
        },
      },
      deps: {
        loadConfig: () => ({}) as never,
        resolveWalletRuntimeConfig: () =>
          ({
            enabled: true,
          }) as never,
        createOrExecuteWalletSend: createOrExecute as never,
      },
    });
    expect(result).toEqual({
      status: "queued",
      mode: "manual",
      requestId: "req-1",
      invoiceId: "inv-1",
      providerId: "turnkey",
      walletId: undefined,
      walletName: "treasury-main",
      chain: "solana",
      amount: "100",
    });
  });

  it("returns failed when send intent creation fails", async () => {
    const result = await orchestrateA2aTaskSettlement({
      taskId: "task-2",
      senderHandle: "@verified@ff1.fased.app",
      taskInput: {
        invoiceRef: "inv-2",
        payment: { chain: "solana", amount: "1", to: "dest" },
      },
      deps: {
        loadConfig: () => ({}) as never,
        resolveWalletRuntimeConfig: () =>
          ({
            enabled: true,
          }) as never,
        createOrExecuteWalletSend: (async () =>
          ({
            ok: false,
            code: "wallet_policy_rejected",
            message: "wallet policy rejected",
          }) as const) as never,
      },
    });
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("wallet policy rejected");
  });
});
