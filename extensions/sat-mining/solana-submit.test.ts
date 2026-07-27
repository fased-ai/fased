import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AddressLookupTableProgram, PublicKey, SystemProgram } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  loadConfig,
  callLocalSocketSigner,
  createSignerReviewApprovalRequest,
  requireLocalSocketSignerPath,
  readWalletProviderRegistry,
  resolveWalletProviderId,
  loadWalletProviderSecret,
  inspectSatMinerCycleByAddress,
  inspectSatMinerCyclesByAddress,
  inspectSatAddressLookupTable,
  inspectSatChainSlot,
} = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  callLocalSocketSigner: vi.fn(),
  createSignerReviewApprovalRequest: vi.fn((params: { review: { requestId: string } }) => ({
    id: params.review.requestId,
  })),
  requireLocalSocketSignerPath: vi.fn(() => "/tmp/fased-test-signer.sock"),
  readWalletProviderRegistry: vi.fn(() => ({
    defaultWalletId: "solana-1",
    wallets: [
      {
        id: "solana-1",
        providerId: "local-socket-signer",
        addresses: { solana: "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW" }, // pragma: allowlist secret
      },
    ],
  })),
  resolveWalletProviderId: vi.fn(() => "local-socket-signer"),
  loadWalletProviderSecret: vi.fn(() => null),
  inspectSatMinerCycleByAddress: vi.fn(),
  inspectSatMinerCyclesByAddress: vi.fn(),
  inspectSatAddressLookupTable: vi.fn(),
  inspectSatChainSlot: vi.fn(),
}));

vi.mock("../../src/config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/config/config.js")>()),
  loadConfig,
}));

vi.mock("../../src/wallet/providers/local-socket-signer-adapter.js", () => ({
  callLocalSocketSigner,
  requireLocalSocketSignerPath,
}));

vi.mock("../../src/wallet/wallet-provider-registry.js", () => ({
  readWalletProviderRegistry,
  resolveWalletUserRole: (wallet?: { metadata?: { purpose?: string; role?: string } }) => {
    const role = wallet?.metadata?.purpose ?? wallet?.metadata?.role;
    return role === "agent" || role === "vault" || role === "mining" ? role : undefined;
  },
}));

vi.mock("../../src/wallet/wallet-provider-resolver.js", () => ({
  resolveWalletProviderId,
}));

vi.mock("../../src/wallet/wallet-send-approvals.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/wallet/wallet-send-approvals.js")>()),
  createSignerReviewApprovalRequest,
}));

vi.mock("../../src/wallet/wallet-secrets-store.js", () => ({
  loadWalletProviderSecret,
}));

vi.mock("./src/rpc-read.js", async () => {
  const actual = await vi.importActual<typeof import("./src/rpc-read.js")>("./src/rpc-read.js");
  return {
    ...actual,
    inspectSatMinerCycleByAddress,
    inspectSatMinerCyclesByAddress,
    inspectSatAddressLookupTable,
    inspectSatChainSlot,
  };
});

import {
  buildSatCycleCommitment,
  submitSatAbortEmptyCycle,
  submitSatClaimBondStakingRewards,
  submitSatClaimProtocolDistributorSat,
  submitSatClaimUnallocatedStakingRewards,
  submitSatCleanupDistributionLookupTable,
  submitSatCancelBondUnlock,
  submitSatCloseResolvedCleanupBatch,
  submitSatCloseResolvedCycleArtifacts,
  submitSatCloseResolvedCycleRegistryPage,
  submitSatCloseResolvedMinerCycleState,
  resolveSatValidatorAuthority,
  runWithSatSubmissionWorkflow,
  submitSatDepositMinerCapital,
  submitSatCommitCycle,
  submitSatDistributeCyclePage,
  submitSatFinalizeBondUnlock,
  submitSatFinalizeCycleSettlement,
  submitSatIncreaseBondPosition,
  submitSatInitMinerCapital,
  submitSatOpenBondPosition,
  submitSatSetActiveCommit,
  submitSatOpenCycle,
  submitSatRevealCycle,
  submitSatRefillRegistryReserveFromTreasury,
  submitSatReleaseUnrevealedCommit,
  submitSatRequestBondUnlock,
  submitSatScoreCyclePage,
  submitSatSealCycleEntropy,
  submitSatSettleCyclePage,
  submitSatSyncBondStakingPosition,
  submitSatSyncBondStakingRewards,
  submitSatTopUpRegistryReserve,
} from "./src/solana-submit.js";

const SAT_PROGRAM_ID_TEXT = "EB4vLPuwkETenY7RxjEunneBuQoH8iMZdzrjqZDYvx75";
const SAT_BOND_PROGRAM_ID_TEXT = "D1ySMMiJmvJRhJJKwYnc171w3g2JDPQnkgD8kGhaG4Vq";
const SAT_MINT_ADDRESS_TEXT = "2AhikHhzJdv6uve1yUBSUmhRKWaSfa7exrsDsfKjVFKa"; // pragma: allowlist secret
const SAT_MINT_PROGRAM_ID_TEXT = "8fb3Mpowe4pD6ed89gwm6gLuh8csPSrLi3hypcesqs5C";
const SAT_PROGRAM_ID = new PublicKey("EB4vLPuwkETenY7RxjEunneBuQoH8iMZdzrjqZDYvx75");
const SAT_BOND_PROGRAM_ID = new PublicKey("D1ySMMiJmvJRhJJKwYnc171w3g2JDPQnkgD8kGhaG4Vq");
const SIGNER = new PublicKey("8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW"); // pragma: allowlist secret
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const TEST_POLICY_HASH = `sha256:${"ab".repeat(32)}`;
const signerLookupBindings = new Map<string, string>();

function configureLocalSignerMock(addresses: { solana?: string } = { solana: SIGNER.toBase58() }) {
  callLocalSocketSigner.mockImplementation(
    async (
      _socketPath: string,
      payload: {
        op?: string;
        request?: {
          requestId?: string;
          cycleId?: string;
          pageIndex?: string;
          intent?: Record<string, unknown> & {
            type?: string;
            action?: string;
            lookupTable?: { address?: string; cycleId?: string; pageIndex?: string };
          };
        };
      },
    ) => {
      switch (payload.op) {
        case "v2.wallet.get":
          return { walletId: "solana-1", publicKey: addresses.solana };
        case "v2.capabilities":
          return {
            ready: true,
            capabilities: {
              protocol: { current: 2, min: 2, max: 2 },
              intentTypes: ["solana.satAction", "solana.satLookupTable", "solana.vaultBondAction"],
              operationStates: ["reserved", "broadcast", "confirmed", "failed", "unknown"],
              features: [
                "failClosedPolicies",
                "policyHashes",
                "durableCaps",
                "atomicIdempotency",
                "ambiguousBroadcastReconciliation",
                "signerOwnedKeys",
                "typedSolanaTransactions",
                "typedSATActions",
                "typedSATAddressLookupTables",
                "typedVaultBondActions",
                "signerOwnedReviewPrepareExecute",
                "exactPreparedTransactions",
                "reviewedVaultBondActions",
                "signerOwnedStateRecheck",
                "durableReviewAuthorization",
              ],
            },
          };
        case "v2.policy.get":
          return { hash: TEST_POLICY_HASH };
        case "v2.satLookup.binding.get": {
          const cycleId = payload.request?.cycleId ?? "";
          const pageIndex = payload.request?.pageIndex ?? "";
          const address = signerLookupBindings.get(`${cycleId}:${pageIndex}`);
          return { cycleId, pageIndex, ...(address ? { address } : {}), bound: Boolean(address) };
        }
        case "v2.execute": {
          const intent = payload.request?.intent;
          if (
            intent?.type === "solana.satLookupTable" &&
            intent.action === "create" &&
            intent.lookupTable?.address
          ) {
            signerLookupBindings.set(
              `${intent.lookupTable.cycleId}:${intent.lookupTable.pageIndex}`,
              intent.lookupTable.address,
            );
          }
          return {
            requestId: payload.request?.requestId ?? "sat-test-request",
            state: "confirmed",
            signature: "tx-submit-cycle",
          };
        }
        case "v2.review.get":
          throw new Error("signer review not found; review.prepare is required");
        case "v2.review.prepare":
          return {
            requestId: payload.request?.requestId ?? "vault-bond-review",
            walletId: "solana-1",
            intentType: payload.request?.intent?.type,
            semanticIntent: payload.request?.intent,
            mode: "reviewed",
            artifactKind: "solana-transaction",
            artifactDigest: `sha256:${"cd".repeat(32)}`,
            stateDigest: `sha256:${"ef".repeat(32)}`,
            policyHash: TEST_POLICY_HASH,
            state: "prepared",
          };
        default:
          throw new Error(`unexpected signer test op ${payload.op}`);
      }
    },
  );
}

function latestTypedSatRequest() {
  const payload = [...callLocalSocketSigner.mock.calls]
    .reverse()
    .map((call) => call[1])
    .find((candidate) => candidate?.op === "v2.execute");
  if (!payload || payload.op !== "v2.execute") {
    throw new Error("typed SAT v2.execute request was not captured");
  }
  const intent = payload.request.intent;
  return {
    op: payload.op,
    request: {
      ...intent,
      walletId: payload.walletId,
      ...(intent.action === "cleanupBatch" ? { purpose: "sat-cleanup" } : {}),
    },
  };
}

function encodeU64(value: number): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(BigInt(value));
  return out;
}

function findPda(...seeds: Buffer[]): string {
  return PublicKey.findProgramAddressSync(seeds, SAT_PROGRAM_ID)[0].toBase58();
}

function findBondPda(...seeds: Buffer[]): string {
  return PublicKey.findProgramAddressSync(seeds, SAT_BOND_PROGRAM_ID)[0].toBase58();
}

function findAta(owner: PublicKey, mint: PublicKey): string {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0].toBase58();
}

describe("SAT cycle transaction builders", () => {
  let stateDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    signerLookupBindings.clear();
    process.env.FASED_SAT_PROGRAM_ID = SAT_PROGRAM_ID_TEXT;
    process.env.FASED_SAT_BOND_PROGRAM_ID = SAT_BOND_PROGRAM_ID_TEXT;
    process.env.FASED_SAT_MINT_ADDRESS = SAT_MINT_ADDRESS_TEXT;
    process.env.FASED_SAT_MINT_PROGRAM_ID = SAT_MINT_PROGRAM_ID_TEXT;
    process.env.FASED_WALLET_LOCAL_SIGNER_SOCKET = "/tmp/fased-test-signer.sock";
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fased-sat-submission-test-"));
    process.env.FASED_STATE_DIR = stateDir;
    readWalletProviderRegistry.mockImplementation(() => ({
      defaultWalletId: "solana-1",
      wallets: [
        {
          id: "solana-1",
          providerId: "local-socket-signer",
          addresses: { solana: SIGNER.toBase58() },
        },
      ],
    }));
    resolveWalletProviderId.mockImplementation(() => "local-socket-signer");
    loadWalletProviderSecret.mockImplementation(() => null);
    loadConfig.mockReturnValue({
      plugins: {
        entries: {
          "sat-mining": {
            config: {
              walletId: "solana-1",
              network: "devnet",
            },
          },
        },
      },
    });
    configureLocalSignerMock();
    inspectSatChainSlot.mockResolvedValue(101);
    inspectSatAddressLookupTable.mockImplementation(
      async (_config: unknown, params: { address: string }) => {
        const lookupIntents = callLocalSocketSigner.mock.calls
          .map((call) => call[1])
          .filter(
            (payload) =>
              payload?.op === "v2.execute" &&
              payload?.request?.intent?.type === "solana.satLookupTable",
          )
          .map((payload) => payload.request.intent);
        if (!lookupIntents.some((intent) => intent.action === "create")) {
          return null;
        }
        return {
          address: params.address,
          authority: SIGNER.toBase58(),
          addresses: lookupIntents.flatMap((intent) => intent.lookupTable?.addresses ?? []),
          active: true,
          lastExtendedSlot: lookupIntents.some((intent) => intent.action === "extend") ? 100 : 99,
        };
      },
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.FASED_STATE_DIR;
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("defaults init miner capital authority to the configured signer address", async () => {
    await submitSatInitMinerCapital({} as never, {});

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(6);
    const request = latestTypedSatRequest();
    expect(request.request.action).toBe("initMinerCapital");
    expect(Buffer.from(request.request.dataBase64, "base64")).toEqual(
      Buffer.concat([Buffer.from([36]), SIGNER.toBuffer()]),
    );
    expect(request.request.keys).toEqual([
      { pubkey: SIGNER.toBase58(), isSigner: true, isWritable: true },
      {
        pubkey: findPda(Buffer.from("sat_miner_capital_state"), SIGNER.toBuffer()),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: SystemProgram.programId.toBase58(), isSigner: false, isWritable: false },
    ]);
  });

  it("fails closed before policy lookup when typed SAT capabilities are missing", async () => {
    callLocalSocketSigner.mockImplementation(
      async (_socketPath: string, payload: { op?: string }) => {
        if (payload.op === "v2.wallet.get") {
          return { walletId: "solana-1", publicKey: SIGNER.toBase58() };
        }
        if (payload.op === "v2.capabilities") {
          return {
            ready: true,
            capabilities: {
              protocol: { current: 2, min: 2, max: 2 },
              intentTypes: ["solana.nativeTransfer"],
              operationStates: ["reserved", "confirmed"],
              features: ["policyHashes"],
            },
          };
        }
        throw new Error(`unexpected signer test op ${payload.op}`);
      },
    );

    await expect(
      submitSatDepositMinerCapital({} as never, { lamports: 250_000_000 }),
    ).rejects.toThrow("required typed SAT protocol-v2 contract");
    expect(callLocalSocketSigner.mock.calls.map((call) => call[1]?.op)).toEqual([
      "v2.wallet.get",
      "v2.capabilities",
    ]);
  });

  it("reconciles the same durable request after an ambiguous execute transport result", async () => {
    const healthySignerCall = callLocalSocketSigner.getMockImplementation();
    let durableRequestId = "";
    let retrying = false;
    callLocalSocketSigner.mockImplementation(
      async (socketPath: string, payload: { op?: string; request?: { requestId?: string } }) => {
        if (payload.op === "v2.execute") {
          durableRequestId = String(payload.request?.requestId ?? "");
          throw new Error("socket closed after broadcast");
        }
        if (payload.op === "v2.operation.get" || payload.op === "v2.operation.reconcile") {
          expect(payload.request?.requestId).toBe(durableRequestId);
          if (retrying) {
            return {
              requestId: durableRequestId,
              state: "confirmed",
              signature: "ambiguous-sat-signature",
            };
          }
          return {
            requestId: durableRequestId,
            state: "unknown",
            signature: "ambiguous-sat-signature",
            error: "confirmation timeout",
          };
        }
        if (!healthySignerCall) {
          throw new Error("healthy signer mock is unavailable");
        }
        return await healthySignerCall(socketPath, payload);
      },
    );

    await expect(
      submitSatDepositMinerCapital({} as never, { lamports: 250_000_000 }),
    ).rejects.toThrow(/remains unknown.*unresolved/);
    retrying = true;
    await expect(
      submitSatDepositMinerCapital({} as never, { lamports: 250_000_000 }),
    ).resolves.toMatchObject({
      txHash: "ambiguous-sat-signature",
      signerState: "confirmed",
      requestId: durableRequestId,
    });
    expect(callLocalSocketSigner.mock.calls.map((call) => call[1]?.op)).toEqual([
      "v2.wallet.get",
      "v2.capabilities",
      "v2.policy.get",
      "v2.execute",
      "v2.operation.get",
      "v2.operation.reconcile",
      "v2.wallet.get",
      "v2.capabilities",
      "v2.policy.get",
      "v2.operation.get",
    ]);
    expect(
      callLocalSocketSigner.mock.calls.filter((call) => call[1]?.op === "v2.execute"),
    ).toHaveLength(1);
  });

  it("records a policy denial with no signer operation as a definitive failure", async () => {
    const healthySignerCall = callLocalSocketSigner.getMockImplementation();
    callLocalSocketSigner.mockImplementation(
      async (socketPath: string, payload: { op?: string }) => {
        if (payload.op === "v2.execute") {
          throw new Error(
            "policy denies operation sat.claimProtocolTreasury@EB4vLPuwkETenY7RxjEunneBuQoH8iMZdzrjqZDYvx75",
          );
        }
        if (payload.op === "v2.operation.get") {
          throw new Error("signer operation not found");
        }
        if (!healthySignerCall) {
          throw new Error("healthy signer mock is unavailable");
        }
        return await healthySignerCall(socketPath, payload);
      },
    );

    const submit = async () =>
      await runWithSatSubmissionWorkflow(
        "test:definitive-policy-denial",
        async () => await submitSatDepositMinerCapital({} as never, { lamports: 250_000_000 }),
      );
    await expect(submit()).rejects.toThrow(/^policy denies operation /u);
    await expect(submit()).rejects.toThrow(/^policy denies operation /u);
    expect(
      callLocalSocketSigner.mock.calls.filter((call) => call[1]?.op === "v2.execute"),
    ).toHaveLength(1);
  });

  it("never re-executes when an unknown caller record regresses to signer reserved", async () => {
    const healthySignerCall = callLocalSocketSigner.getMockImplementation();
    let durableRequestId = "";
    let retrying = false;
    callLocalSocketSigner.mockImplementation(
      async (socketPath: string, payload: { op?: string; request?: { requestId?: string } }) => {
        if (payload.op === "v2.execute") {
          durableRequestId = String(payload.request?.requestId ?? "");
          throw new Error("socket closed after possible broadcast");
        }
        if (payload.op === "v2.operation.get") {
          expect(payload.request?.requestId).toBe(durableRequestId);
          if (retrying) {
            return { requestId: durableRequestId, state: "reserved" };
          }
          throw new Error("signer lookup unavailable");
        }
        if (!healthySignerCall) {
          throw new Error("healthy signer mock is unavailable");
        }
        return await healthySignerCall(socketPath, payload);
      },
    );

    const submit = async () =>
      await runWithSatSubmissionWorkflow(
        "manual:deposit:ambiguous-without-signature",
        async () => await submitSatDepositMinerCapital({} as never, { lamports: 250_000_000 }),
      );
    await expect(submit()).rejects.toThrow(/remains unknown.*unresolved/);
    retrying = true;
    await expect(submit()).rejects.toThrow(/remains unknown.*regressed to reserved/);
    expect(
      callLocalSocketSigner.mock.calls.filter((call) => call[1]?.op === "v2.execute"),
    ).toHaveLength(1);
  });

  it("returns the exact confirmed operation for a repeated idempotency key without re-executing", async () => {
    const healthySignerCall = callLocalSocketSigner.getMockImplementation();
    let requestId = "";
    callLocalSocketSigner.mockImplementation(
      async (socketPath: string, payload: { op?: string; request?: { requestId?: string } }) => {
        if (payload.op === "v2.execute") {
          requestId = String(payload.request?.requestId ?? "");
          return { requestId, state: "confirmed", signature: "stable-confirmed-signature" };
        }
        if (payload.op === "v2.operation.get") {
          expect(payload.request?.requestId).toBe(requestId);
          return { requestId, state: "confirmed", signature: "stable-confirmed-signature" };
        }
        if (!healthySignerCall) {
          throw new Error("healthy signer mock is unavailable");
        }
        return await healthySignerCall(socketPath, payload);
      },
    );

    const submit = async () =>
      await runWithSatSubmissionWorkflow(
        "manual:deposit:stable-key",
        async () => await submitSatDepositMinerCapital({} as never, { lamports: 250_000_000 }),
      );
    const first = await submit();
    const repeated = await submit();

    expect(repeated).toEqual(first);
    expect(
      callLocalSocketSigner.mock.calls.filter((call) => call[1]?.op === "v2.execute"),
    ).toHaveLength(1);
    expect(
      callLocalSocketSigner.mock.calls.filter((call) => call[1]?.op === "v2.operation.get"),
    ).toHaveLength(1);
  });

  it("fails closed when a stable workflow key is reused with a different deposit intent", async () => {
    await runWithSatSubmissionWorkflow(
      "manual:deposit:collision",
      async () => await submitSatDepositMinerCapital({} as never, { lamports: 250_000_000 }),
    );

    await expect(
      runWithSatSubmissionWorkflow(
        "manual:deposit:collision",
        async () => await submitSatDepositMinerCapital({} as never, { lamports: 500_000_000 }),
      ),
    ).rejects.toThrow(/idempotency collision/);
    expect(
      callLocalSocketSigner.mock.calls.filter((call) => call[1]?.op === "v2.execute"),
    ).toHaveLength(1);
  });

  it("serializes concurrent exact workers and broadcasts only once", async () => {
    const healthySignerCall = callLocalSocketSigner.getMockImplementation();
    let requestId = "";
    let releaseExecute!: () => void;
    const executeGate = new Promise<void>((resolve) => {
      releaseExecute = resolve;
    });
    callLocalSocketSigner.mockImplementation(
      async (socketPath: string, payload: { op?: string; request?: { requestId?: string } }) => {
        if (payload.op === "v2.execute") {
          requestId = String(payload.request?.requestId ?? "");
          await executeGate;
          return { requestId, state: "confirmed", signature: "concurrent-signature" };
        }
        if (payload.op === "v2.operation.get") {
          return { requestId, state: "confirmed", signature: "concurrent-signature" };
        }
        if (!healthySignerCall) {
          throw new Error("healthy signer mock is unavailable");
        }
        return await healthySignerCall(socketPath, payload);
      },
    );
    const submit = async () =>
      await runWithSatSubmissionWorkflow(
        "worker:cycle:52:commit",
        async () => await submitSatDepositMinerCapital({} as never, { lamports: 250_000_000 }),
      );

    const first = submit();
    await vi.waitFor(() => {
      expect(
        callLocalSocketSigner.mock.calls.filter((call) => call[1]?.op === "v2.execute"),
      ).toHaveLength(1);
    });
    const concurrent = submit();
    releaseExecute();

    await expect(Promise.all([first, concurrent])).resolves.toEqual([
      expect.objectContaining({ txHash: "concurrent-signature" }),
      expect.objectContaining({ txHash: "concurrent-signature" }),
    ]);
    expect(
      callLocalSocketSigner.mock.calls.filter((call) => call[1]?.op === "v2.execute"),
    ).toHaveLength(1);
  });

  it("uses the reveal account order", async () => {
    const cycleId = 9_859_137;
    const intervalStartCycleId = 9_859_128;
    await submitSatRevealCycle({} as never, {
      cycleId,
      intervalStartCycleId,
      nonceBase64: Buffer.alloc(32, 7).toString("base64"),
      allocationFp: new Array(25).fill(40_000),
    });

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(4);
    const request = latestTypedSatRequest();
    expect(request?.op).toBe("v2.execute");
    expect(callLocalSocketSigner.mock.calls.map((call) => call[1]?.op)).toEqual([
      "v2.wallet.get",
      "v2.capabilities",
      "v2.policy.get",
      "v2.execute",
    ]);
    const executeEnvelope = callLocalSocketSigner.mock.calls[3]?.[1];
    expect(executeEnvelope).toMatchObject({
      op: "v2.execute",
      walletId: "solana-1",
      request: {
        policyHash: TEST_POLICY_HASH,
        intent: {
          type: "solana.satAction",
          action: "revealCycle",
          context: {
            intervalStartCycleId: String(intervalStartCycleId),
            registryPageIndex: "0",
          },
        },
      },
    });
    expect(executeEnvelope?.request?.requestId).toMatch(/^sat-v2-[0-9a-f]{48}$/);
    expect(
      callLocalSocketSigner.mock.calls.some((call) =>
        ["sendSolanaInstruction", "sendSolanaInstructions"].includes(call[1]?.op),
      ),
    ).toBe(false);

    expect(request?.request?.keys).toEqual([
      { pubkey: SIGNER.toBase58(), isSigner: true, isWritable: true },
      {
        pubkey: findPda(Buffer.from("sat_cycle_state"), encodeU64(cycleId)),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_cycle_registry_meta"), encodeU64(cycleId)),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_cycle_registry_page"), encodeU64(cycleId), encodeU64(0)),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_cycle_settlement_progress_v2"), encodeU64(cycleId)),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(
          Buffer.from("sat_miner_cycle_state"),
          SIGNER.toBuffer(),
          encodeU64(cycleId),
        ),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_miner_capital_state"), SIGNER.toBuffer()),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_unlock_interval_state"), encodeU64(intervalStartCycleId)),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_registry_reserve")),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: SystemProgram.programId.toBase58(),
        isSigner: false,
        isWritable: false,
      },
    ]);
  });

  it("passes the canonical SlotHashes sysvar when sealing cycle entropy", async () => {
    const cycleId = 9_859_137;
    const intervalStartCycleId = 9_859_128;
    await submitSatSealCycleEntropy({} as never, { cycleId, intervalStartCycleId });

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(4);
    const request = latestTypedSatRequest();
    expect(request?.op).toBe("v2.execute");
    expect(request?.request?.keys).toEqual([
      { pubkey: SIGNER.toBase58(), isSigner: true, isWritable: false },
      {
        pubkey: findPda(Buffer.from("sat_cycle_state"), encodeU64(cycleId)),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_unlock_interval_state"), encodeU64(intervalStartCycleId)),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: "SysvarS1otHashes111111111111111111111111111",
        isSigner: false,
        isWritable: false,
      },
    ]);
  });

  it("routes missed-reveal penalties through the fixed treasury accounts", async () => {
    const cycleId = 9_859_137;
    await submitSatReleaseUnrevealedCommit({} as never, {
      cycleId,
      minerAuthority: SIGNER.toBase58(),
    });

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(4);
    const request = latestTypedSatRequest();
    expect(request?.op).toBe("v2.execute");
    expect(request?.request?.keys).toEqual([
      { pubkey: SIGNER.toBase58(), isSigner: true, isWritable: false },
      {
        pubkey: findPda(Buffer.from("sat_cycle_state"), encodeU64(cycleId)),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(
          Buffer.from("sat_miner_cycle_state"),
          SIGNER.toBuffer(),
          encodeU64(cycleId),
        ),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_miner_capital_state"), SIGNER.toBuffer()),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_treasury_state")),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_treasury_vault")),
        isSigner: false,
        isWritable: true,
      },
    ]);
  });

  it("builds the permissionless empty-cycle abort with writable cycle state", async () => {
    const cycleId = 9_859_137;
    await submitSatAbortEmptyCycle({} as never, { cycleId });

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(4);
    const request = latestTypedSatRequest();
    expect(request?.op).toBe("v2.execute");
    expect(Buffer.from(request?.request?.dataBase64 ?? "", "base64")).toEqual(
      Buffer.concat([Buffer.from([94]), encodeU64(cycleId)]),
    );
    expect(request?.request?.keys).toEqual([
      { pubkey: SIGNER.toBase58(), isSigner: true, isWritable: false },
      {
        pubkey: findPda(Buffer.from("sat_cycle_state"), encodeU64(cycleId)),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_cycle_registry_meta"), encodeU64(cycleId)),
        isSigner: false,
        isWritable: true,
      },
    ]);
  });

  it("builds the protocol-domain commitment deterministically", () => {
    const commitment = buildSatCycleCommitment({
      authority: SIGNER.toBase58(),
      cycleId: 9_859_137,
      committedLamports: 250_000_000,
      nonce: Buffer.alloc(32, 7),
      allocationFp: new Array(25).fill(40_000),
      programId: SAT_PROGRAM_ID_TEXT,
    });

    expect(commitment).toHaveLength(32);
    expect(commitment.toString("hex")).toBe(
      buildSatCycleCommitment({
        authority: SIGNER.toBase58(),
        cycleId: 9_859_137,
        committedLamports: 250_000_000,
        nonce: Buffer.alloc(32, 7),
        allocationFp: new Array(25).fill(40_000),
        programId: SAT_PROGRAM_ID_TEXT,
      }).toString("hex"),
    );
  });

  it.each([
    ["open", () => submitSatOpenBondPosition({} as never, { amountRaw: 100_000_000_000 })],
    ["increase", () => submitSatIncreaseBondPosition({} as never, { amountRaw: 100_000_000_000 })],
    ["request unlock", () => submitSatRequestBondUnlock({} as never)],
    ["cancel unlock", () => submitSatCancelBondUnlock({} as never)],
    ["finalize unlock", () => submitSatFinalizeBondUnlock({} as never)],
    ["sync rewards", () => submitSatSyncBondStakingRewards({} as never)],
    ["sync position", () => submitSatSyncBondStakingPosition({} as never)],
    ["claim rewards", () => submitSatClaimBondStakingRewards({} as never)],
    [
      "claim unallocated rewards",
      () =>
        submitSatClaimUnallocatedStakingRewards({} as never, {
          recipientOwner: "AzXW61LgzhJTXN1so7rBR5auU2oCSzRyNEqFxPkZct3G", // pragma: allowlist secret
        }),
    ],
  ] as const)(
    "keeps Vault bond %s reviewed-only and never calls direct execute",
    async (_name, submit) => {
      await expect(submit()).rejects.toThrow("is pending in Wallet Approvals");
      expect(createSignerReviewApprovalRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          role: "vault",
          requestedBy: "sat-mining-vault",
        }),
      );
      expect(callLocalSocketSigner.mock.calls.map((call) => call[1].op)).toEqual([
        "v2.wallet.get",
        "v2.capabilities",
        "v2.policy.get",
        "v2.review.get",
        "v2.review.prepare",
      ]);
      expect(callLocalSocketSigner).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ op: "v2.execute" }),
      );
    },
  );

  it("resumes an approved Vault bond review without preparing or broadcasting it twice", async () => {
    const healthySignerCall = callLocalSocketSigner.getMockImplementation();
    let preparedReview: Record<string, unknown> | undefined;
    let approved = false;
    callLocalSocketSigner.mockImplementation(async (socketPath: string, payload: any) => {
      if (payload.op === "v2.review.get") {
        if (!preparedReview) {
          throw new Error("signer review not found; review.prepare is required");
        }
        return {
          ...preparedReview,
          state: approved ? "signed" : "prepared",
          ...(approved ? { signature: "vault-bond-signature" } : {}),
        };
      }
      if (payload.op === "v2.operation.get") {
        return {
          requestId: payload.request.requestId,
          state: "confirmed",
          signature: "vault-bond-signature",
        };
      }
      if (!healthySignerCall) {
        throw new Error("healthy signer mock missing");
      }
      const result = await healthySignerCall(socketPath, payload);
      if (payload.op === "v2.review.prepare") {
        preparedReview = result as Record<string, unknown>;
      }
      return result;
    });

    const submit = () =>
      runWithSatSubmissionWorkflow("vault-open-review-resume", () =>
        submitSatOpenBondPosition({} as never, { amountRaw: 100_000_000_000 }),
      );
    await expect(submit()).rejects.toThrow("is pending in Wallet Approvals");
    approved = true;
    const resumed = await submit();

    expect(resumed.txHash).toBe("vault-bond-signature");
    const operations = callLocalSocketSigner.mock.calls.map((call) => call[1].op);
    expect(operations.filter((op) => op === "v2.review.prepare")).toHaveLength(1);
    expect(operations.filter((op) => op === "v2.operation.get")).toHaveLength(1);
    expect(operations).not.toContain("v2.execute");
  });

  it("passes the bond program to the atomic protocol distributor claim", async () => {
    const distributor = findBondPda(Buffer.from("sat_bond_staking_distributor"));
    await submitSatClaimProtocolDistributorSat({} as never, { recipientOwner: distributor });

    const request = latestTypedSatRequest();
    expect(request?.request?.programId).toBe(SAT_PROGRAM_ID_TEXT);
    expect(Buffer.from(request?.request?.dataBase64 ?? "", "base64")).toEqual(Buffer.from([85]));
    expect(request?.request?.keys).toHaveLength(13);
    expect(request?.request?.keys?.[4]?.pubkey).toBe(distributor);
    expect(request?.request?.keys?.[12]).toEqual({
      pubkey: SAT_BOND_PROGRAM_ID_TEXT,
      isSigner: false,
      isWritable: false,
    });
  });

  it("marks the exact cycle state writable when closing resolved artifacts", async () => {
    const cycleId = 9_859_151;

    await submitSatCloseResolvedCycleArtifacts({} as never, { cycleId });

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(4);
    const request = latestTypedSatRequest();
    expect(request?.op).toBe("v2.execute");
    expect(request?.request?.keys).toEqual([
      { pubkey: SIGNER.toBase58(), isSigner: true, isWritable: true },
      {
        pubkey: findPda(Buffer.from("sat_cycle_state"), encodeU64(cycleId)),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_cycle_settlement_progress_v2"), encodeU64(cycleId)),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_cycle_registry_meta"), encodeU64(cycleId)),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_registry_reserve")),
        isSigner: false,
        isWritable: true,
      },
    ]);
  });

  it("includes the treasury vault when opening a cycle", async () => {
    const cycleId = 9_859_145;
    await submitSatOpenCycle({} as never, { cycleId });

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(4);
    const request = latestTypedSatRequest();
    expect(request?.op).toBe("v2.execute");
    expect(request?.request?.keys).toEqual([
      { pubkey: SIGNER.toBase58(), isSigner: true, isWritable: true },
      { pubkey: findPda(Buffer.from("sat_global_state")), isSigner: false, isWritable: true },
      {
        pubkey: findPda(Buffer.from("sat_cycle_state"), encodeU64(cycleId)),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_cycle_registry_meta"), encodeU64(cycleId)),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_treasury_state")),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_registry_reserve")),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: SystemProgram.programId.toBase58(),
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: findPda(Buffer.from("sat_treasury_vault")),
        isSigner: false,
        isWritable: true,
      },
    ]);
  });

  it("builds treasury-backed registry reserve refill with fixed protocol PDAs", async () => {
    await submitSatRefillRegistryReserveFromTreasury({} as never, {
      targetBalanceLamports: 1_000_000_000,
    });

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(4);
    const request = latestTypedSatRequest();
    expect(request?.op).toBe("v2.execute");
    expect(Buffer.from(request?.request?.dataBase64 ?? "", "base64")[0]).toBe(88);
    expect(request?.request?.keys).toEqual([
      { pubkey: SIGNER.toBase58(), isSigner: true, isWritable: true },
      { pubkey: findPda(Buffer.from("sat_treasury_state")), isSigner: false, isWritable: true },
      { pubkey: findPda(Buffer.from("sat_treasury_vault")), isSigner: false, isWritable: true },
      { pubkey: findPda(Buffer.from("sat_registry_reserve")), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId.toBase58(), isSigner: false, isWritable: false },
    ]);
  });

  it("tops up the registry reserve without invoking protocol genesis", async () => {
    await submitSatTopUpRegistryReserve({} as never, {
      targetBalanceLamports: 200_000_000,
    });

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(4);
    const request = latestTypedSatRequest();
    expect(request?.op).toBe("v2.execute");
    expect(Buffer.from(request?.request?.dataBase64 ?? "", "base64")).toEqual(
      Buffer.concat([Buffer.from([84]), encodeU64(200_000_000)]),
    );
    expect(request?.request?.keys).toEqual([
      { pubkey: SIGNER.toBase58(), isSigner: true, isWritable: true },
      { pubkey: findPda(Buffer.from("sat_registry_reserve")), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId.toBase58(), isSigner: false, isWritable: false },
    ]);
  });

  it("rejects reserve targets above the selected genesis profile", async () => {
    await expect(
      submitSatTopUpRegistryReserve({ network: "mainnet-beta" } as never, {
        targetBalanceLamports: 1_000_000_001,
      }),
    ).rejects.toThrow("mainnet-beta genesis maximum 1000000000");
    expect(callLocalSocketSigner).not.toHaveBeenCalled();
  });

  it("fails closed when the signer-owned wallet has no public key", async () => {
    const cycleId = 9_859_143;
    configureLocalSignerMock({});

    await expect(
      submitSatCommitCycle({} as never, {
        cycleId,
        commitmentHex: "11".repeat(32),
      }),
    ).rejects.toThrow("returned no Solana address");
    expect(callLocalSocketSigner.mock.calls.map((call) => call[1]?.op)).toEqual(["v2.wallet.get"]);
  });

  it("does not fall back to the registry address for validator authority resolution", async () => {
    configureLocalSignerMock({});

    await expect(resolveSatValidatorAuthority({} as never)).rejects.toThrow(
      "returned no Solana address",
    );
    expect(callLocalSocketSigner.mock.calls.map((call) => call[1]?.op)).toEqual([
      "v2.capabilities",
      "v2.wallet.get",
    ]);
  });

  it("uses the active SAT wallet attachment for deposit even when the loaded config is stale", async () => {
    loadConfig.mockReturnValueOnce({
      wallet: {
        provider: {
          id: "embedded-keystore",
        },
      },
    });

    await submitSatDepositMinerCapital(
      {
        walletId: "solana-1",
      } as never,
      { lamports: 250_000_000 },
    );

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(4);
    expect(callLocalSocketSigner.mock.calls[0]?.[1]).toEqual({
      op: "v2.wallet.get",
      walletId: "solana-1",
    });
    expect(latestTypedSatRequest()).toMatchObject({
      op: "v2.execute",
      request: {
        walletId: "solana-1",
      },
    });
  });

  it("uses config-scoped wallet env for VPS local-signer SAT deposits", async () => {
    loadConfig.mockReturnValueOnce({
      env: {
        vars: {
          FASED_CONFIG_ONLY_MARKER: "cfg-env",
        },
      },
      wallet: {
        provider: {
          id: "embedded-keystore",
        },
      },
    });
    readWalletProviderRegistry.mockImplementation((env?: NodeJS.ProcessEnv) => ({
      defaultWalletId: "solana-1",
      wallets:
        env?.FASED_CONFIG_ONLY_MARKER === "cfg-env"
          ? [
              {
                id: "solana-1",
                providerId: "local-socket-signer",
                addresses: { solana: SIGNER.toBase58() },
              },
            ]
          : [],
    }));
    resolveWalletProviderId.mockReturnValueOnce("embedded-keystore");

    await submitSatDepositMinerCapital(
      {
        walletId: "solana-1",
      } as never,
      { lamports: 250_000_000 },
    );

    expect(readWalletProviderRegistry).toHaveBeenCalledWith(
      expect.objectContaining({
        FASED_CONFIG_ONLY_MARKER: "cfg-env",
      }),
    );
    expect(callLocalSocketSigner).toHaveBeenCalledTimes(4);
    expect(loadWalletProviderSecret).not.toHaveBeenCalled();
    expect(latestTypedSatRequest()).toMatchObject({
      op: "v2.execute",
      request: {
        walletId: "solana-1",
      },
    });
  });

  it("does not infer local-socket-signer from a socket when the registry is missing", async () => {
    loadConfig.mockReturnValueOnce({
      env: {
        vars: {
          FASED_WALLET_LOCAL_SIGNER_SOCKET: "/tmp/fased-test-signer.sock",
          FASED_WALLET_SOLANA_KEYSTORE_PATH__SOLANA_1: "/tmp/keystore-solana-solana-1.v1.enc",
        },
      },
      wallet: {
        provider: {
          id: "embedded-keystore",
        },
      },
    });
    readWalletProviderRegistry.mockReturnValueOnce({
      defaultWalletId: "solana-1",
      wallets: [],
    });
    resolveWalletProviderId.mockReturnValueOnce("embedded-keystore");

    await expect(
      submitSatSetActiveCommit(
        {
          walletId: "solana-1",
        } as never,
        { lamports: 350_000_000 },
      ),
    ).rejects.toThrow("requires local-socket-signer");
    expect(callLocalSocketSigner).not.toHaveBeenCalled();
    expect(loadWalletProviderSecret).not.toHaveBeenCalled();
  });

  it("requires migration when the registry wallet still uses embedded-keystore", async () => {
    loadConfig.mockReturnValueOnce({
      env: {
        vars: {
          FASED_WALLET_LOCAL_SIGNER_SOCKET: "/tmp/fased-test-signer.sock",
          FASED_WALLET_SOLANA_KEYSTORE_PATH__SOLANA_1: "/tmp/keystore-solana-solana-1.v1.enc",
        },
      },
      wallet: {
        provider: {
          id: "embedded-keystore",
        },
      },
    });
    readWalletProviderRegistry.mockReturnValueOnce({
      defaultWalletId: "solana-1",
      wallets: [
        {
          id: "solana-1",
          providerId: "embedded-keystore",
          addresses: { solana: SIGNER.toBase58() },
        },
      ],
    });
    resolveWalletProviderId.mockReturnValueOnce("embedded-keystore");

    await expect(
      submitSatSetActiveCommit(
        {
          walletId: "solana-1",
        } as never,
        { lamports: 350_000_000 },
      ),
    ).rejects.toThrow("embedded-keystore was retired");
    expect(callLocalSocketSigner).not.toHaveBeenCalled();
    expect(loadWalletProviderSecret).not.toHaveBeenCalled();
  });

  it("uses the upgraded settleCyclePage progress PDA", async () => {
    const cycleId = 9_859_142;
    const minerAuthorities = [
      new PublicKey("Wmesty4ZT9XfG2BK5NfaTLyVvHyeG1DW2gZnwZQntuk"), // pragma: allowlist secret
      new PublicKey("4wxmFJm7xBkqLk7K3qn2gGw8v6SnM8j4rJz7s2p9dJQY"), // pragma: allowlist secret
    ];
    const minerCycleAccounts = minerAuthorities.map((authority) =>
      findPda(Buffer.from("sat_miner_cycle_state"), authority.toBuffer(), encodeU64(cycleId)),
    );
    inspectSatMinerCyclesByAddress.mockResolvedValueOnce(
      minerAuthorities.map((authority, index) => ({
        address: minerCycleAccounts[index],
        authority: authority.toBase58(),
        cycleId,
      })),
    );
    await submitSatSettleCyclePage({} as never, {
      cycleId,
      pageIndex: 0,
      chunkIndex: 0,
      minerCycleAccounts,
    });

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(4);
    const request = latestTypedSatRequest();
    expect(request?.op).toBe("v2.execute");

    expect(request?.request?.keys).toEqual([
      { pubkey: SIGNER.toBase58(), isSigner: true, isWritable: true },
      { pubkey: findPda(Buffer.from("sat_global_state")), isSigner: false, isWritable: false },
      {
        pubkey: findPda(Buffer.from("sat_cycle_state"), encodeU64(cycleId)),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_cycle_registry_meta"), encodeU64(cycleId)),
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: findPda(Buffer.from("sat_cycle_registry_page"), encodeU64(cycleId), encodeU64(0)),
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: findPda(Buffer.from("sat_cycle_settlement_progress_v2"), encodeU64(cycleId)),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_registry_reserve")),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_treasury_state")),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: SystemProgram.programId.toBase58(),
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: findPda(
          Buffer.from("sat_miner_cycle_state"),
          SIGNER.toBuffer(),
          encodeU64(cycleId),
        ),
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: findPda(Buffer.from("sat_miner_capital_state"), SIGNER.toBuffer()),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_rebate_vault")),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: minerCycleAccounts[0],
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: minerCycleAccounts[1],
        isSigner: false,
        isWritable: true,
      },
    ]);
  });

  it("uses the upgraded finalizeCycleSettlement progress PDA", async () => {
    const cycleId = 9_859_149;
    await submitSatFinalizeCycleSettlement({} as never, {
      cycleId,
      pageCount: 2,
    });

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(4);
    const request = latestTypedSatRequest();
    expect(request?.op).toBe("v2.execute");

    expect(request?.request?.keys).toEqual([
      { pubkey: SIGNER.toBase58(), isSigner: true, isWritable: true },
      { pubkey: findPda(Buffer.from("sat_global_state")), isSigner: false, isWritable: true },
      {
        pubkey: findPda(Buffer.from("sat_cycle_state"), encodeU64(cycleId)),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_cycle_settlement_progress_v2"), encodeU64(cycleId)),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_cycle_registry_meta"), encodeU64(cycleId)),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_treasury_state")),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(
          Buffer.from("sat_miner_cycle_state"),
          SIGNER.toBuffer(),
          encodeU64(cycleId),
        ),
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: findPda(Buffer.from("sat_miner_capital_state"), SIGNER.toBuffer()),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_rebate_vault")),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_cycle_registry_page"), encodeU64(cycleId), encodeU64(0)),
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: findPda(Buffer.from("sat_cycle_registry_page"), encodeU64(cycleId), encodeU64(1)),
        isSigner: false,
        isWritable: false,
      },
    ]);
  });

  it("closes resolved miner-cycle state for the target authority instead of assuming the executor", async () => {
    const cycleId = 9_859_160;
    const authority = "4wxmFJm7xBkqLk7K3qn2gGw8v6SnM8j4rJz7s2p9dJQY"; // pragma: allowlist secret
    await submitSatCloseResolvedMinerCycleState({} as never, {
      cycleId,
      authority,
    });

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(4);
    const request = latestTypedSatRequest();
    expect(request?.op).toBe("v2.execute");
    expect(request?.request?.keys).toEqual([
      { pubkey: SIGNER.toBase58(), isSigner: true, isWritable: true },
      {
        pubkey: findPda(Buffer.from("sat_cycle_state"), encodeU64(cycleId)),
        isSigner: false,
        isWritable: false,
      },
      { pubkey: authority, isSigner: false, isWritable: true },
      {
        pubkey: findPda(
          Buffer.from("sat_miner_cycle_state"),
          new PublicKey(authority).toBuffer(),
          encodeU64(cycleId),
        ),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(
          Buffer.from("sat_miner_capital_state"),
          new PublicKey(authority).toBuffer(),
        ),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_cycle_registry_meta"), encodeU64(cycleId)),
        isSigner: false,
        isWritable: true,
      },
    ]);
  });

  it("passes registry meta when closing a resolved registry page", async () => {
    const cycleId = 9_859_161;
    const pageIndex = 1;
    await submitSatCloseResolvedCycleRegistryPage({} as never, { cycleId, pageIndex });

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(4);
    const request = latestTypedSatRequest();
    expect(request?.op).toBe("v2.execute");
    expect(request?.request?.keys).toEqual([
      { pubkey: SIGNER.toBase58(), isSigner: true, isWritable: true },
      {
        pubkey: findPda(Buffer.from("sat_cycle_state"), encodeU64(cycleId)),
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: findPda(Buffer.from("sat_cycle_registry_meta"), encodeU64(cycleId)),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(
          Buffer.from("sat_cycle_registry_page"),
          encodeU64(cycleId),
          encodeU64(pageIndex),
        ),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_registry_reserve")),
        isSigner: false,
        isWritable: true,
      },
    ]);
  });

  it("submits cleanup close instructions as one sat-cleanup batch", async () => {
    const cycleId = 9_859_162;
    const authority = "4wxmFJm7xBkqLk7K3qn2gGw8v6SnM8j4rJz7s2p9dJQY";

    await submitSatCloseResolvedCleanupBatch({} as never, [
      { kind: "minerCycleState", cycleId, authority },
      { kind: "cycleRegistryPage", cycleId, pageIndex: 1 },
    ]);

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(4);
    const request = latestTypedSatRequest();
    expect(request?.op).toBe("v2.execute");
    expect(request?.request?.purpose).toBe("sat-cleanup");
    expect(request?.request?.instructions).toHaveLength(2);
    expect(request?.request?.instructions?.[0]?.dataBase64).toBe(
      Buffer.concat([Buffer.from([69]), encodeU64(cycleId)]).toString("base64"),
    );
    expect(request?.request?.instructions?.[1]?.dataBase64).toBe(
      Buffer.concat([Buffer.from([70]), encodeU64(cycleId), encodeU64(1)]).toString("base64"),
    );
  });

  it("uses the upgraded score/distribute progress PDA", async () => {
    const cycleId = 9_859_149;
    const minerAuthority = new PublicKey("Wmesty4ZT9XfG2BK5NfaTLyVvHyeG1DW2gZnwZQntuk"); // pragma: allowlist secret
    const minerCycleAccounts = [
      findPda(Buffer.from("sat_miner_cycle_state"), minerAuthority.toBuffer(), encodeU64(cycleId)),
    ];
    inspectSatMinerCyclesByAddress.mockResolvedValue([
      {
        address: minerCycleAccounts[0],
        authority: minerAuthority.toBase58(),
        cycleId,
        committedLamports: "250000000",
        claimableSatRaw: "0",
        claimableDetRebateLamports: "0",
        claimablePerfRebateLamports: "0",
        claimedSatRaw: "0",
        claimedDetRebateLamports: "0",
        claimedPerfRebateLamports: "0",
        validParticipation: true,
        capitalLockReleased: false,
      },
    ]);

    await submitSatScoreCyclePage({} as never, {
      cycleId,
      pageIndex: 1,
      chunkIndex: 0,
      minerCycleAccounts,
    });

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(4);
    let request = latestTypedSatRequest();
    expect(request?.op).toBe("v2.execute");
    expect(request?.request?.keys?.[0]).toEqual({
      pubkey: SIGNER.toBase58(),
      isSigner: true,
      isWritable: true,
    });
    expect(request?.request?.keys?.[3]?.pubkey).toBe(
      findPda(Buffer.from("sat_cycle_registry_page"), encodeU64(cycleId), encodeU64(1)),
    );
    expect(request?.request?.keys?.[4]?.pubkey).toBe(
      findPda(Buffer.from("sat_cycle_settlement_progress_v2"), encodeU64(cycleId)),
    );

    await submitSatDistributeCyclePage({} as never, {
      cycleId,
      pageIndex: 1,
      chunkIndex: 0,
      minerCycleAccounts,
    });

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(8);
    request = latestTypedSatRequest();
    expect(request?.op).toBe("v2.execute");
    expect(request?.request?.keys?.[0]).toEqual({
      pubkey: SIGNER.toBase58(),
      isSigner: true,
      isWritable: true,
    });
    expect(request?.request?.keys?.[3]?.pubkey).toBe(
      findPda(Buffer.from("sat_cycle_settlement_progress_v2"), encodeU64(cycleId)),
    );
    expect(request?.request?.keys).toEqual([
      { pubkey: SIGNER.toBase58(), isSigner: true, isWritable: true },
      {
        pubkey: findPda(Buffer.from("sat_cycle_state"), encodeU64(cycleId)),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_cycle_registry_page"), encodeU64(cycleId), encodeU64(1)),
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: findPda(Buffer.from("sat_cycle_settlement_progress_v2"), encodeU64(cycleId)),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_global_state")),
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: findPda(Buffer.from("sat_treasury_state")),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(
          Buffer.from("sat_miner_cycle_state"),
          SIGNER.toBuffer(),
          encodeU64(cycleId),
        ),
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: findPda(Buffer.from("sat_miner_capital_state"), SIGNER.toBuffer()),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_rebate_vault")),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_treasury_vault")),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: minerCycleAccounts[0],
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_miner_capital_state"), minerAuthority.toBuffer()),
        isSigner: false,
        isWritable: true,
      },
    ]);
  });

  it("creates, extends, activates, and uses one typed v0 lookup table for 16 miners", async () => {
    vi.stubEnv("FASED_SAT_ENABLE_ALT_V0", "1");
    const cycleId = 9_859_150;
    const minerCycleAccounts = Array.from({ length: 16 }, (_, index) =>
      new PublicKey(new Uint8Array(32).fill(index + 20)).toBase58(),
    );
    const authorities = Array.from({ length: 16 }, (_, index) =>
      new PublicKey(new Uint8Array(32).fill(index + 60)).toBase58(),
    );
    inspectSatMinerCyclesByAddress.mockResolvedValueOnce(
      minerCycleAccounts.map((address, index) => ({
        address,
        authority: authorities[index],
      })),
    );

    const submitted = await runWithSatSubmissionWorkflow(
      "test:distribution:16",
      async () =>
        await submitSatDistributeCyclePage({} as never, {
          cycleId,
          pageIndex: 0,
          chunkIndex: 0,
          minerCycleAccounts,
        }),
    );

    const executeIntents = callLocalSocketSigner.mock.calls
      .map((call) => call[1])
      .filter((payload) => payload?.op === "v2.execute")
      .map((payload) => payload.request.intent);
    const lookupIntents = executeIntents.filter(
      (intent) => intent.type === "solana.satLookupTable",
    );
    const [, expectedLookupTable] = AddressLookupTableProgram.createLookupTable({
      authority: SIGNER,
      payer: SIGNER,
      recentSlot: 100,
    });
    expect(lookupIntents.map((intent) => intent.action)).toEqual([
      "create",
      "extend",
      "extend",
      "extend",
    ]);
    expect(lookupIntents[0]).toMatchObject({
      lookupTable: { address: expectedLookupTable.toBase58(), recentSlot: "100" },
    });
    expect(lookupIntents.slice(1).map((intent) => intent.lookupTable.addresses.length)).toEqual([
      20, 20, 1,
    ]);
    const distribution = executeIntents.at(-1);
    expect(distribution).toMatchObject({
      type: "solana.satAction",
      action: "distributeCyclePage",
      addressLookupTables: [expectedLookupTable.toBase58()],
    });
    expect(submitted).toMatchObject({
      transactionVersion: "v0",
      lookupTableAddress: expectedLookupTable.toBase58(),
      lookupTableCreated: true,
      lookupTableExtended: true,
      lookupTableAddressCount: 41,
    });
    expect(submitted.lookupTableTransactionHashes).toHaveLength(4);
  });

  it("reuses the exact signer-owned table derived by another worker in the same slot", async () => {
    vi.stubEnv("FASED_SAT_ENABLE_ALT_V0", "1");
    const minerCycleAccounts = Array.from({ length: 16 }, (_, index) =>
      new PublicKey(new Uint8Array(32).fill(index + 20)).toBase58(),
    );
    const authorities = Array.from({ length: 16 }, (_, index) =>
      new PublicKey(new Uint8Array(32).fill(index + 60)).toBase58(),
    );
    inspectSatMinerCyclesByAddress.mockResolvedValueOnce(
      minerCycleAccounts.map((address, index) => ({
        address,
        authority: authorities[index],
      })),
    );
    const [, expectedLookupTable] = AddressLookupTableProgram.createLookupTable({
      authority: SIGNER,
      payer: SIGNER,
      recentSlot: 100,
    });
    signerLookupBindings.set("9859152:0", expectedLookupTable.toBase58());
    inspectSatAddressLookupTable.mockImplementation(
      async (_config: unknown, params: { address: string }) => {
        const lookupIntents = callLocalSocketSigner.mock.calls
          .map((call) => call[1])
          .filter(
            (payload) =>
              payload?.op === "v2.execute" &&
              payload?.request?.intent?.type === "solana.satLookupTable",
          )
          .map((payload) => payload.request.intent);
        return {
          address: params.address,
          authority: SIGNER.toBase58(),
          addresses: lookupIntents.flatMap((intent) => intent.lookupTable?.addresses ?? []),
          active: true,
          lastExtendedSlot: lookupIntents.some((intent) => intent.action === "extend") ? 100 : 99,
        };
      },
    );

    const submitted = await runWithSatSubmissionWorkflow(
      "test:distribution:reuse-derived",
      async () =>
        await submitSatDistributeCyclePage({} as never, {
          cycleId: 9_859_152,
          pageIndex: 0,
          chunkIndex: 0,
          minerCycleAccounts,
        }),
    );

    const lookupIntents = callLocalSocketSigner.mock.calls
      .map((call) => call[1])
      .filter(
        (payload) =>
          payload?.op === "v2.execute" &&
          payload?.request?.intent?.type === "solana.satLookupTable",
      )
      .map((payload) => payload.request.intent);
    expect(lookupIntents.some((intent) => intent.action === "create")).toBe(false);
    expect(lookupIntents.filter((intent) => intent.action === "extend")).toHaveLength(3);
    expect(submitted).toMatchObject({
      lookupTableAddress: expectedLookupTable.toBase58(),
      lookupTableCreated: false,
      lookupTableExtended: true,
    });
  });

  it("replaces an expired Gateway cache only after the signer reports no binding", async () => {
    vi.stubEnv("FASED_SAT_ENABLE_ALT_V0", "1");
    inspectSatChainSlot.mockResolvedValue(1_000);
    const minerCycleAccounts = Array.from({ length: 16 }, (_, index) =>
      new PublicKey(new Uint8Array(32).fill(index + 20)).toBase58(),
    );
    inspectSatMinerCyclesByAddress.mockResolvedValueOnce(
      minerCycleAccounts.map((address, index) => ({
        address,
        authority: new PublicKey(new Uint8Array(32).fill(index + 60)).toBase58(),
      })),
    );
    const [, expiredCachedLookupTable] = AddressLookupTableProgram.createLookupTable({
      authority: SIGNER,
      payer: SIGNER,
      recentSlot: 1,
    });
    const [, expectedFreshLookupTable] = AddressLookupTableProgram.createLookupTable({
      authority: SIGNER,
      payer: SIGNER,
      recentSlot: 999,
    });
    const onLookupTableResolved = vi.fn(async () => {});

    const submitted = await runWithSatSubmissionWorkflow(
      "test:distribution:expired-unbound-cache",
      async () =>
        await submitSatDistributeCyclePage({} as never, {
          cycleId: 9_859_157,
          pageIndex: 0,
          chunkIndex: 0,
          minerCycleAccounts,
          lookupTableAddress: expiredCachedLookupTable.toBase58(),
          onLookupTableResolved,
        }),
    );

    expect(submitted.lookupTableAddress).toBe(expectedFreshLookupTable.toBase58());
    expect(submitted.lookupTableAddress).not.toBe(expiredCachedLookupTable.toBase58());
    expect(onLookupTableResolved).toHaveBeenLastCalledWith(expectedFreshLookupTable.toBase58());
  });

  it("reconciles an unknown signer mutation before skipping its visible chain effect", async () => {
    vi.stubEnv("FASED_SAT_ENABLE_ALT_V0", "1");
    const cycleId = 9_859_158;
    const minerCycleAccounts = Array.from({ length: 16 }, (_, index) =>
      new PublicKey(new Uint8Array(32).fill(index + 20)).toBase58(),
    );
    inspectSatMinerCyclesByAddress.mockResolvedValueOnce(
      minerCycleAccounts.map((address, index) => ({
        address,
        authority: new PublicKey(new Uint8Array(32).fill(index + 60)).toBase58(),
      })),
    );
    const [, lookupTable] = AddressLookupTableProgram.createLookupTable({
      authority: SIGNER,
      payer: SIGNER,
      recentSlot: 100,
    });
    const lookupTableAddress = lookupTable.toBase58();
    const mutationRequestId = "lookup-visible-create-owner";
    const healthySignerCall = callLocalSocketSigner.getMockImplementation();
    if (!healthySignerCall) {
      throw new Error("healthy signer mock is unavailable");
    }
    let reconciled = false;
    callLocalSocketSigner.mockImplementation(async (...args: unknown[]) => {
      const payload = args[1] as {
        op?: string;
        request?: { cycleId?: string; requestId?: string };
      };
      if (payload.op === "v2.satLookup.binding.get") {
        return {
          cycleId: String(cycleId),
          pageIndex: "0",
          address: lookupTableAddress,
          bound: true,
          mutationRequestId,
          mutationState: reconciled ? "confirmed" : "unknown",
        };
      }
      if (payload.op === "v2.operation.reconcile") {
        expect(payload.request?.requestId).toBe(mutationRequestId);
        reconciled = true;
        return {
          requestId: mutationRequestId,
          state: "confirmed",
          signature: "visible-create-signature",
        };
      }
      return await healthySignerCall(...args);
    });
    inspectSatAddressLookupTable.mockImplementation(
      async (_config: unknown, params: { address: string }) => {
        const addresses = callLocalSocketSigner.mock.calls
          .map((call) => call[1]?.request?.intent)
          .filter(
            (intent) => intent?.type === "solana.satLookupTable" && intent.action === "extend",
          )
          .flatMap((intent) => intent.lookupTable?.addresses ?? []);
        return {
          address: params.address,
          authority: SIGNER.toBase58(),
          addresses,
          active: true,
          lastExtendedSlot: addresses.length > 0 ? 100 : 99,
        };
      },
    );

    const submitted = await runWithSatSubmissionWorkflow(
      "test:distribution:reconcile-visible-owner",
      async () =>
        await submitSatDistributeCyclePage({} as never, {
          cycleId,
          pageIndex: 0,
          chunkIndex: 0,
          minerCycleAccounts,
        }),
    );

    const payloads = callLocalSocketSigner.mock.calls.map((call) => call[1]);
    const reconcileIndex = payloads.findIndex(
      (payload) => payload?.op === "v2.operation.reconcile",
    );
    const extendIndex = payloads.findIndex(
      (payload) => payload?.op === "v2.execute" && payload.request?.intent?.action === "extend",
    );
    expect(reconciled).toBe(true);
    expect(reconcileIndex).toBeGreaterThanOrEqual(0);
    expect(extendIndex).toBeGreaterThan(reconcileIndex);
    expect(submitted.lookupTableAddress).toBe(lookupTableAddress);
  });

  it("advances to a different recent slot after a reverse address-binding collision", async () => {
    vi.stubEnv("FASED_SAT_ENABLE_ALT_V0", "1");
    const minerCycleAccounts = Array.from({ length: 16 }, (_, index) =>
      new PublicKey(new Uint8Array(32).fill(index + 20)).toBase58(),
    );
    inspectSatMinerCyclesByAddress.mockResolvedValueOnce(
      minerCycleAccounts.map((address, index) => ({
        address,
        authority: new PublicKey(new Uint8Array(32).fill(index + 60)).toBase58(),
      })),
    );
    const healthySignerCall = callLocalSocketSigner.getMockImplementation();
    if (!healthySignerCall) {
      throw new Error("healthy signer mock is unavailable");
    }
    let createAttempts = 0;
    let successfulCreate = false;
    callLocalSocketSigner.mockImplementation(async (...args: unknown[]) => {
      const payload = args[1] as {
        op?: string;
        request?: { requestId?: string; intent?: { type?: string; action?: string } };
      };
      if (
        payload.op === "v2.execute" &&
        payload.request?.intent?.type === "solana.satLookupTable" &&
        payload.request.intent.action === "create"
      ) {
        createAttempts += 1;
        if (createAttempts === 1) {
          return {
            requestId: payload.request.requestId,
            state: "failed",
            error: "SAT lookup-table address is already bound to another cycle and page",
          };
        }
        successfulCreate = true;
      }
      return await healthySignerCall(...args);
    });
    inspectSatAddressLookupTable.mockImplementation(
      async (_config: unknown, params: { address: string }) => {
        if (!successfulCreate) {
          return null;
        }
        const addresses = callLocalSocketSigner.mock.calls
          .map((call) => call[1]?.request?.intent)
          .filter(
            (intent) => intent?.type === "solana.satLookupTable" && intent.action === "extend",
          )
          .flatMap((intent) => intent.lookupTable?.addresses ?? []);
        return {
          address: params.address,
          authority: SIGNER.toBase58(),
          addresses,
          active: true,
          lastExtendedSlot: addresses.length > 0 ? 100 : 99,
        };
      },
    );

    const submitted = await runWithSatSubmissionWorkflow(
      "test:distribution:reverse-address-collision",
      async () =>
        await submitSatDistributeCyclePage({} as never, {
          cycleId: 9_859_159,
          pageIndex: 1,
          chunkIndex: 0,
          minerCycleAccounts,
        }),
    );
    const creates = callLocalSocketSigner.mock.calls
      .map((call) => call[1]?.request?.intent)
      .filter((intent) => intent?.type === "solana.satLookupTable" && intent.action === "create");
    expect(creates).toHaveLength(2);
    expect(creates.map((intent) => intent.lookupTable.recentSlot)).toEqual(["100", "99"]);
    expect(creates[0].lookupTable.address).not.toBe(creates[1].lookupTable.address);
    expect(submitted.lookupTableAddress).toBe(creates[1].lookupTable.address);
  });

  it("does not treat an ambiguous lookup-table creation as successful state reconciliation", async () => {
    vi.stubEnv("FASED_SAT_ENABLE_ALT_V0", "1");
    const minerCycleAccounts = Array.from({ length: 16 }, (_, index) =>
      new PublicKey(new Uint8Array(32).fill(index + 20)).toBase58(),
    );
    inspectSatMinerCyclesByAddress.mockResolvedValueOnce(
      minerCycleAccounts.map((address, index) => ({
        address,
        authority: new PublicKey(new Uint8Array(32).fill(index + 60)).toBase58(),
      })),
    );
    const healthySignerCall = callLocalSocketSigner.getMockImplementation();
    if (!healthySignerCall) {
      throw new Error("healthy signer mock is unavailable");
    }
    callLocalSocketSigner.mockImplementation(async (...args: unknown[]) => {
      const payload = args[1] as {
        op?: string;
        request?: { intent?: { type?: string; action?: string } };
      };
      if (
        payload.op === "v2.execute" &&
        payload.request?.intent?.type === "solana.satLookupTable" &&
        payload.request.intent.action === "create"
      ) {
        await healthySignerCall(...args);
        throw new Error("transport closed after possible lookup-table broadcast");
      }
      return await healthySignerCall(...args);
    });
    const onLookupTableResolved = vi.fn(async () => {});

    await expect(
      runWithSatSubmissionWorkflow("test:distribution:ambiguous-create", async () =>
        submitSatDistributeCyclePage({} as never, {
          cycleId: 9_859_153,
          pageIndex: 0,
          chunkIndex: 0,
          minerCycleAccounts,
          onLookupTableResolved,
        }),
      ),
    ).rejects.toThrow("remains unknown");
    expect(onLookupTableResolved).toHaveBeenCalledTimes(1);
    expect(onLookupTableResolved).toHaveBeenCalledWith(expect.any(String));
    expect(
      callLocalSocketSigner.mock.calls.some(
        (call) =>
          call[1]?.op === "v2.execute" &&
          call[1]?.request?.intent?.type === "solana.satAction" &&
          call[1]?.request?.intent?.action === "distributeCyclePage",
      ),
    ).toBe(false);
  });

  it("recovers a persisted lookup-table identity and replays the exact create after a crash", async () => {
    vi.stubEnv("FASED_SAT_ENABLE_ALT_V0", "1");
    const minerCycleAccounts = Array.from({ length: 16 }, (_, index) =>
      new PublicKey(new Uint8Array(32).fill(index + 20)).toBase58(),
    );
    inspectSatMinerCyclesByAddress.mockResolvedValue(
      minerCycleAccounts.map((address, index) => ({
        address,
        authority: new PublicKey(new Uint8Array(32).fill(index + 60)).toBase58(),
      })),
    );
    inspectSatChainSlot
      .mockResolvedValueOnce(101)
      .mockResolvedValueOnce(104)
      .mockResolvedValue(105);
    const healthySignerCall = callLocalSocketSigner.getMockImplementation();
    if (!healthySignerCall) {
      throw new Error("healthy signer mock is unavailable");
    }
    let firstCreateFailed = false;
    let successfulCreate = false;
    callLocalSocketSigner.mockImplementation(async (...args: unknown[]) => {
      const payload = args[1] as {
        op?: string;
        request?: { intent?: { type?: string; action?: string } };
      };
      if (
        payload.op === "v2.execute" &&
        payload.request?.intent?.type === "solana.satLookupTable" &&
        payload.request.intent.action === "create"
      ) {
        if (!firstCreateFailed) {
          firstCreateFailed = true;
          await healthySignerCall(...args);
          throw new Error("transport closed after possible lookup-table broadcast");
        }
        successfulCreate = true;
      }
      return await healthySignerCall(...args);
    });
    inspectSatAddressLookupTable.mockImplementation(
      async (_config: unknown, params: { address: string }) => {
        if (!successfulCreate) {
          return null;
        }
        const addresses = callLocalSocketSigner.mock.calls
          .map((call) => call[1]?.request?.intent)
          .filter((intent) => intent?.type === "solana.satLookupTable")
          .flatMap((intent) => intent.lookupTable?.addresses ?? []);
        return {
          address: params.address,
          authority: SIGNER.toBase58(),
          addresses,
          active: true,
          lastExtendedSlot: addresses.length > 0 ? 104 : 103,
        };
      },
    );
    let persistedLookupTable = "";
    const onLookupTableResolved = vi.fn(async (address: string) => {
      persistedLookupTable = address;
    });

    await expect(
      runWithSatSubmissionWorkflow("test:distribution:crash-before-create", async () =>
        submitSatDistributeCyclePage({} as never, {
          cycleId: 9_859_154,
          pageIndex: 0,
          chunkIndex: 0,
          minerCycleAccounts,
          onLookupTableResolved,
        }),
      ),
    ).rejects.toThrow("remains unknown");
    expect(persistedLookupTable).not.toBe("");

    const submitted = await runWithSatSubmissionWorkflow(
      "test:distribution:crash-before-create-retry",
      async () =>
        submitSatDistributeCyclePage({} as never, {
          cycleId: 9_859_154,
          pageIndex: 0,
          chunkIndex: 0,
          minerCycleAccounts,
          lookupTableAddress: persistedLookupTable,
          onLookupTableResolved,
        }),
    );
    const createIntents = callLocalSocketSigner.mock.calls
      .map((call) => call[1]?.request?.intent)
      .filter((intent) => intent?.type === "solana.satLookupTable" && intent.action === "create");
    expect(createIntents).toHaveLength(2);
    expect(createIntents[0].lookupTable).toMatchObject({
      address: persistedLookupTable,
      recentSlot: "100",
    });
    expect(createIntents[1].lookupTable).toEqual(createIntents[0].lookupTable);
    expect(submitted).toMatchObject({
      lookupTableAddress: persistedLookupTable,
      lookupTableCreated: true,
    });
  });

  it("retries a definitively failed lookup create under the same workflow and table identity", async () => {
    vi.stubEnv("FASED_SAT_ENABLE_ALT_V0", "1");
    const minerCycleAccounts = Array.from({ length: 16 }, (_, index) =>
      new PublicKey(new Uint8Array(32).fill(index + 20)).toBase58(),
    );
    inspectSatMinerCyclesByAddress.mockResolvedValue(
      minerCycleAccounts.map((address, index) => ({
        address,
        authority: new PublicKey(new Uint8Array(32).fill(index + 60)).toBase58(),
      })),
    );
    inspectSatChainSlot.mockImplementation(async () =>
      callLocalSocketSigner.mock.calls.some(
        (call) =>
          call[1]?.request?.intent?.type === "solana.satLookupTable" &&
          call[1]?.request?.intent?.action === "extend",
      )
        ? 102
        : 101,
    );
    const healthySignerCall = callLocalSocketSigner.getMockImplementation();
    if (!healthySignerCall) {
      throw new Error("healthy signer mock is unavailable");
    }
    let createAttempts = 0;
    let successfulCreate = false;
    const createRequestIds: string[] = [];
    callLocalSocketSigner.mockImplementation(async (...args: unknown[]) => {
      const payload = args[1] as {
        op?: string;
        request?: {
          requestId?: string;
          intent?: { type?: string; action?: string; lookupTable?: { address?: string } };
        };
      };
      if (
        payload.op === "v2.execute" &&
        payload.request?.intent?.type === "solana.satLookupTable" &&
        payload.request.intent.action === "create"
      ) {
        createAttempts += 1;
        createRequestIds.push(payload.request.requestId ?? "");
        await healthySignerCall(...args);
        if (createAttempts === 1) {
          return {
            requestId: payload.request.requestId,
            state: "failed",
            error: "pre-broadcast RPC preparation failed",
          };
        }
        successfulCreate = true;
      }
      return await healthySignerCall(...args);
    });
    inspectSatAddressLookupTable.mockImplementation(
      async (_config: unknown, params: { address: string }) => {
        if (!successfulCreate) {
          return null;
        }
        const addresses = callLocalSocketSigner.mock.calls
          .map((call) => call[1]?.request?.intent)
          .filter(
            (intent) => intent?.type === "solana.satLookupTable" && intent.action === "extend",
          )
          .flatMap((intent) => intent.lookupTable?.addresses ?? []);
        return {
          address: params.address,
          authority: SIGNER.toBase58(),
          addresses,
          active: true,
          lastExtendedSlot: addresses.length > 0 ? 101 : 100,
        };
      },
    );
    let persistedLookupTable = "";
    const onLookupTableResolved = vi.fn(async (address: string) => {
      persistedLookupTable = address;
    });
    const workflowId = "test:distribution:same-workflow-definitive-retry";

    await expect(
      runWithSatSubmissionWorkflow(workflowId, async () =>
        submitSatDistributeCyclePage({} as never, {
          cycleId: 9_859_156,
          pageIndex: 0,
          chunkIndex: 0,
          minerCycleAccounts,
          onLookupTableResolved,
        }),
      ),
    ).rejects.toThrow("pre-broadcast RPC preparation failed");

    const submitted = await runWithSatSubmissionWorkflow(workflowId, async () =>
      submitSatDistributeCyclePage({} as never, {
        cycleId: 9_859_156,
        pageIndex: 0,
        chunkIndex: 0,
        minerCycleAccounts,
        lookupTableAddress: persistedLookupTable,
        onLookupTableResolved,
      }),
    );
    const createIntents = callLocalSocketSigner.mock.calls
      .map((call) => call[1]?.request?.intent)
      .filter((intent) => intent?.type === "solana.satLookupTable" && intent.action === "create");
    expect(createRequestIds).toHaveLength(2);
    expect(createRequestIds[0]).not.toBe(createRequestIds[1]);
    expect(createIntents).toHaveLength(2);
    expect(createIntents[1].lookupTable).toEqual(createIntents[0].lookupTable);
    expect(createIntents[0].lookupTable.address).toBe(persistedLookupTable);
    expect(submitted.lookupTableAddress).toBe(persistedLookupTable);
  });

  it("fails closed for large distribution when typed ALT/v0 is not explicitly enabled", async () => {
    vi.stubEnv("FASED_SAT_ENABLE_ALT_V0", "");
    const minerCycleAccounts = Array.from({ length: 16 }, (_, index) =>
      new PublicKey(new Uint8Array(32).fill(index + 100)).toBase58(),
    );
    inspectSatMinerCyclesByAddress.mockResolvedValueOnce(
      minerCycleAccounts.map((address, index) => ({
        address,
        authority: new PublicKey(new Uint8Array(32).fill(index + 140)).toBase58(),
      })),
    );
    await expect(
      submitSatDistributeCyclePage({} as never, {
        cycleId: 9_859_151,
        pageIndex: 0,
        chunkIndex: 0,
        minerCycleAccounts,
      }),
    ).rejects.toThrow("SAT ALT/v0 support is disabled");
    expect(
      callLocalSocketSigner.mock.calls.some(
        (call) =>
          call[1]?.op === "v2.execute" &&
          call[1]?.request?.intent?.action === "distributeCyclePage",
      ),
    ).toBe(false);
  });

  it("uses the typed durable signer operation for lookup-table cleanup", async () => {
    vi.stubEnv("FASED_SAT_ENABLE_ALT_V0", "1");
    const lookupTableAddress = new PublicKey(new Uint8Array(32).fill(8)).toBase58();
    signerLookupBindings.set("9859155:0", lookupTableAddress);
    const result = await submitSatCleanupDistributionLookupTable({} as never, {
      cycleId: 9_859_155,
      pageIndex: 0,
      action: "deactivate",
    });
    const execute = callLocalSocketSigner.mock.calls
      .map((call) => call[1])
      .find(
        (payload) =>
          payload?.op === "v2.execute" &&
          payload?.request?.intent?.type === "solana.satLookupTable",
      );
    expect(execute?.request.intent).toEqual({
      type: "solana.satLookupTable",
      action: "deactivate",
      lookupTable: {
        address: lookupTableAddress,
        cycleId: "9859155",
        pageIndex: "0",
      },
    });
    expect(result).toMatchObject({
      lookupTable: lookupTableAddress,
      action: "deactivate",
      transactionHashes: ["tx-submit-cycle"],
      signerState: "confirmed",
    });
  });
});
