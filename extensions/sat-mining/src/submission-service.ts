import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import {
  callLocalSocketSigner,
  createSignerReviewApprovalRequest,
  type WalletProviderJupiterReviewV2,
} from "fased/plugin-sdk/sat-runtime";
import type { SatSignerAction } from "./signer-codec-manifest.js";
import { SAT_RUNTIME_PROTOCOL_GENERATION, type SatMiningStateIdentity } from "./state-identity.js";
import {
  buildSatSubmissionOperationKey,
  claimSatSubmission as claimUnboundSatSubmission,
  digestSatSubmissionIntent,
  updateSatSubmission as updateUnboundSatSubmission,
  waitForSatSubmissionLease as waitForUnboundSatSubmissionLease,
  type SatSubmissionSignerState,
} from "./submission-ledger.js";

const satSubmissionWorkflowStorage = new AsyncLocalStorage<string>();

export async function runWithSatSubmissionWorkflow<T>(
  workflowId: string,
  task: () => Promise<T>,
): Promise<T> {
  const normalized = workflowId.trim();
  if (!normalized || normalized.length > 240 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error("SAT submission idempotency key must contain 1-240 printable characters");
  }
  return await satSubmissionWorkflowStorage.run(normalized, task);
}

export type SatSubmissionSignerOperation = {
  requestId: string;
  state: "reserved" | "broadcast" | "confirmed" | "failed" | "unknown";
  signature?: string;
  error?: string;
};

export type SatSubmissionSemanticContext = {
  targetAuthority?: string;
  disputeAuthority?: string;
  intervalStartCycleId?: string;
  registryPageIndex?: string;
  minerAuthorities?: string[];
  permanentMiningIds?: string[];
  frontCycleIds?: string[];
  backCycleIds?: string[];
};

export type SatVNextKeeperAction =
  | "settleCyclePageV2"
  | "finalizeCycleSettlementV2"
  | "scoreCyclePageV2"
  | "distributeCyclePageV2";

export type SatSubmissionInstruction = {
  action: SatSignerAction | SatVNextKeeperAction;
  programId: string;
  dataBase64: string;
  satCommitment?: {
    reference: string;
    cluster: "local" | "devnet" | "mainnet-beta";
    protocolGeneration: string;
  };
  keys: Array<{
    pubkey: string;
    isSigner: boolean;
    isWritable: boolean;
  }>;
  addressLookupTables?: string[];
  context?: SatSubmissionSemanticContext;
};

export type SatSubmissionAction =
  | SatSignerAction
  | SatVNextKeeperAction
  | "cleanupBatch"
  | "create"
  | "extend"
  | "deactivate"
  | "close";

export type SatSubmissionOutcome = SatSubmissionSignerOperation & { signature: string };

const VAULT_BOND_ACTIONS = new Set<SatSignerAction>([
  "updateBondTierPolicy",
  "openBondPosition",
  "increaseBondPosition",
  "requestBondUnlock",
  "cancelBondUnlock",
  "finalizeBondUnlock",
  "syncBondStakingRewards",
  "syncBondStakingPosition",
  "claimBondStakingRewards",
  "claimUnallocatedStakingRewards",
]);

const REQUIRED_SAT_SIGNER_FEATURES = [
  "failClosedPolicies",
  "policyHashes",
  "durableCaps",
  "atomicIdempotency",
  "ambiguousBroadcastReconciliation",
  "signerOwnedKeys",
  "signerOwnedEncryptedSATCommitments",
  "typedSolanaTransactions",
  "typedSATActions",
] as const;

export async function requireTypedSatSignerCapabilities(
  socketPath: string,
  intentType:
    | "solana.satAction"
    | "solana.satKeeperAction"
    | "solana.satLookupTable"
    | "solana.vaultBondAction",
): Promise<void> {
  const result = await callLocalSocketSigner<{
    ready?: boolean;
    capabilities?: {
      protocol?: { current?: number; min?: number; max?: number };
      intentTypes?: string[];
      operationStates?: string[];
      features?: string[];
    };
  }>(socketPath, { op: "v2.capabilities" });
  const capabilities = result.capabilities;
  const protocol = capabilities?.protocol;
  const features = new Set(capabilities?.features ?? []);
  const states = new Set(capabilities?.operationStates ?? []);
  const missingFeatures = REQUIRED_SAT_SIGNER_FEATURES.filter((feature) => !features.has(feature));
  const missingStates = ["reserved", "broadcast", "confirmed", "failed", "unknown"].filter(
    (state) => !states.has(state),
  );
  const missingVaultReviewFeatures =
    intentType === "solana.vaultBondAction"
      ? [
          "signerOwnedReviewPrepareExecute",
          "exactPreparedTransactions",
          "reviewedVaultBondActions",
          "signerOwnedStateRecheck",
          "durableReviewAuthorization",
        ].filter((feature) => !features.has(feature))
      : [];
  const missingLookupFeatures =
    intentType === "solana.satLookupTable" && !features.has("typedSATAddressLookupTables")
      ? ["typedSATAddressLookupTables"]
      : [];
  const missingKeeperFeatures =
    intentType === "solana.satKeeperAction" && !features.has("signerOwnedKeeperFeePayer")
      ? ["signerOwnedKeeperFeePayer"]
      : [];
  if (
    result.ready !== true ||
    protocol?.current !== 2 ||
    typeof protocol.min !== "number" ||
    protocol.min > 2 ||
    typeof protocol.max !== "number" ||
    protocol.max < 2 ||
    !capabilities?.intentTypes?.includes(intentType) ||
    missingFeatures.length > 0 ||
    missingKeeperFeatures.length > 0 ||
    missingLookupFeatures.length > 0 ||
    (intentType === "solana.vaultBondAction" && !features.has("typedVaultBondActions")) ||
    missingVaultReviewFeatures.length > 0 ||
    missingStates.length > 0
  ) {
    throw new Error(
      `local-socket-signer does not support the required typed SAT protocol-v2 contract${
        missingFeatures.length > 0 ? `; missing features: ${missingFeatures.join(", ")}` : ""
      }${missingVaultReviewFeatures.length > 0 ? `; missing reviewed Vault features: ${missingVaultReviewFeatures.join(", ")}` : ""}${
        missingLookupFeatures.length > 0
          ? `; missing SAT lookup features: ${missingLookupFeatures.join(", ")}`
          : ""
      }${missingKeeperFeatures.length > 0 ? `; missing keeper features: ${missingKeeperFeatures.join(", ")}` : ""}${
        missingStates.length > 0 ? `; missing states: ${missingStates.join(", ")}` : ""
      }`,
    );
  }
}

async function reconcileTypedSatOperation(params: {
  socketPath: string;
  walletId: string;
  requestId: string;
  operation?: SatSubmissionSignerOperation;
}): Promise<SatSubmissionSignerOperation> {
  let operation =
    params.operation ??
    (await callLocalSocketSigner<SatSubmissionSignerOperation>(params.socketPath, {
      op: "v2.operation.get",
      walletId: params.walletId,
      request: { requestId: params.requestId },
    }));
  if (operation.state === "broadcast" || operation.state === "unknown") {
    try {
      operation = await callLocalSocketSigner<SatSubmissionSignerOperation>(params.socketPath, {
        op: "v2.operation.reconcile",
        walletId: params.walletId,
        request: { requestId: params.requestId },
      });
    } catch {
      // The durable signature and ambiguous state remain authoritative. Never
      // replace this with a second request ID or another broadcast attempt.
    }
  }
  return operation;
}

export function assertSatSignerOperationIdentity(
  operation: SatSubmissionSignerOperation,
  requestId: string,
): SatSubmissionSignerOperation {
  if (operation.requestId !== requestId) {
    throw new Error(
      `SAT signer returned request ${operation.requestId || "<empty>"} while reconciling ${requestId}`,
    );
  }
  return operation;
}

function signerStateForLedger(
  state: SatSubmissionSignerOperation["state"],
): SatSubmissionSignerState {
  return state;
}

type SatLookupTableAction = "create" | "extend" | "deactivate" | "close";

function assertSatLookupTableAction(value: string): asserts value is SatLookupTableAction {
  if (value !== "create" && value !== "extend" && value !== "deactivate" && value !== "close") {
    throw new Error(`unsupported SAT lookup-table action ${value}`);
  }
}

export class SatSubmissionUnresolvedError extends Error {
  readonly requestId: string;
  readonly signature?: string;

  constructor(params: { requestId: string; state: string; signature?: string; detail?: string }) {
    super(
      `SAT signer operation ${params.requestId} remains ${params.state}${
        params.signature ? ` with signature ${params.signature}` : ""
      }; it is unresolved and must be reconciled with the same idempotency key before any new submission${
        params.detail ? ` (${params.detail})` : ""
      }`,
    );
    this.name = "SatSubmissionUnresolvedError";
    this.requestId = params.requestId;
    this.signature = params.signature;
  }
}

export class SatSubmissionDefinitiveFailureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SatSubmissionDefinitiveFailureError";
  }
}

export async function executeTypedSatIntent(params: {
  socketPath: string;
  walletId: string;
  stateProgramId: string;
  action: SatSubmissionAction;
  instruction?: SatSubmissionInstruction;
  instructions?: SatSubmissionInstruction[];
  lookupTable?: {
    address: string;
    cycleId: string;
    pageIndex: string;
    recentSlot?: string;
    addresses?: string[];
    parent?: SatSubmissionInstruction;
  };
  cluster: "local" | "devnet" | "mainnet-beta";
  env: NodeJS.ProcessEnv;
  useKeeperFeePayer?: boolean;
}): Promise<SatSubmissionOutcome> {
  if (!params.stateProgramId.trim()) {
    throw new Error("typed SAT execution requires its canonical Mining program ID");
  }
  const stateIdentity: SatMiningStateIdentity = {
    cluster: params.cluster,
    programId: params.stateProgramId,
    protocolGeneration: SAT_RUNTIME_PROTOCOL_GENERATION,
    walletId: params.walletId,
  };
  const claimSatSubmission = (
    request: Omit<
      Parameters<typeof claimUnboundSatSubmission>[0],
      Exclude<keyof SatMiningStateIdentity, "walletId">
    >,
  ) => claimUnboundSatSubmission({ ...stateIdentity, ...request });
  const updateSatSubmission = (
    request: Omit<
      Parameters<typeof updateUnboundSatSubmission>[0],
      Exclude<keyof SatMiningStateIdentity, "walletId">
    >,
  ) => updateUnboundSatSubmission({ ...stateIdentity, ...request });
  const waitForSatSubmissionLease = (
    request: Omit<
      Parameters<typeof waitForUnboundSatSubmissionLease>[0],
      Exclude<keyof SatMiningStateIdentity, "walletId">
    >,
  ) => waitForUnboundSatSubmissionLease({ ...stateIdentity, ...request });
  const isLookupTable = params.lookupTable != null;
  const satCommitment = params.instruction?.satCommitment;
  if (
    satCommitment &&
    ((params.action !== "revealCycle" && params.action !== "revealCycleV2") ||
      params.instructions != null ||
      params.lookupTable != null)
  ) {
    throw new Error(
      "signer-owned SAT commitment references are valid only for one revealCycle generation",
    );
  }
  const isVaultBond =
    !isLookupTable &&
    params.action !== "cleanupBatch" &&
    VAULT_BOND_ACTIONS.has(params.action as SatSignerAction);
  const keeperCapability = params.useKeeperFeePayer
    ? await callLocalSocketSigner<{
        miningWalletId?: string;
        feePayerWalletId?: string;
        feePayerPublicKey?: string;
        state?: string;
      }>(params.socketPath, {
        op: "v2.keeperFeePayer.get",
        walletId: params.walletId,
      })
    : null;
  if (
    keeperCapability &&
    (keeperCapability.state !== "ready" ||
      keeperCapability.miningWalletId !== params.walletId ||
      !keeperCapability.feePayerWalletId?.trim() ||
      !keeperCapability.feePayerPublicKey?.trim())
  ) {
    throw new Error("native signer returned an invalid SAT keeper fee-payer capability");
  }
  const signerWalletId = keeperCapability?.feePayerWalletId?.trim() || params.walletId;
  const intentType = isLookupTable
    ? "solana.satLookupTable"
    : isVaultBond
      ? "solana.vaultBondAction"
      : keeperCapability
        ? "solana.satKeeperAction"
        : "solana.satAction";
  await requireTypedSatSignerCapabilities(params.socketPath, intentType);
  const intent = isLookupTable
    ? (() => {
        if (params.instruction || params.instructions || !params.lookupTable) {
          throw new Error("typed SAT lookup-table execution accepts only semantic lookup details");
        }
        const action = params.action;
        assertSatLookupTableAction(action);
        return {
          type: "solana.satLookupTable" as const,
          action,
          lookupTable: params.lookupTable,
        };
      })()
    : isVaultBond
      ? (() => {
          if (!params.instruction || params.instructions) {
            throw new Error("typed Vault bond execution requires exactly one semantic instruction");
          }
          return {
            type: "solana.vaultBondAction" as const,
            cluster: params.cluster,
            ...params.instruction,
          };
        })()
      : keeperCapability
        ? (() => {
            if (!params.instruction || params.instructions) {
              throw new Error(
                "typed SAT keeper execution requires exactly one semantic instruction",
              );
            }
            if (params.instruction.action !== params.action) {
              throw new Error("typed SAT keeper action does not match its semantic instruction");
            }
            return {
              type: "solana.satKeeperAction" as const,
              authorityWalletId: params.walletId,
              ...params.instruction,
            };
          })()
        : {
            type: "solana.satAction" as const,
            action: params.action,
            ...(params.instruction ?? {}),
            ...(params.instructions ? { instructions: params.instructions } : {}),
          };
  const policy = await callLocalSocketSigner<{ hash: string }>(params.socketPath, {
    op: "v2.policy.get",
    walletId: signerWalletId,
  });
  const intentDigest = digestSatSubmissionIntent({
    walletId: signerWalletId,
    policyHash: policy.hash,
    intent,
  });
  const operationKey = buildSatSubmissionOperationKey(intent);
  const workflowId =
    satSubmissionWorkflowStorage.getStore() ?? `derived:${operationKey}:${intentDigest}`;
  let claim = await claimSatSubmission({
    walletId: params.walletId,
    workflowId,
    operationKey,
    intentDigest,
    action: params.action,
    allowFailedRetry: isLookupTable,
    env: params.env,
  });
  if (!claim.claimed) {
    await waitForSatSubmissionLease({
      walletId: params.walletId,
      requestId: claim.record.requestId,
      env: params.env,
    });
    claim = await claimSatSubmission({
      walletId: params.walletId,
      workflowId,
      operationKey,
      intentDigest,
      action: params.action,
      allowFailedRetry: isLookupTable,
      env: params.env,
      owner: claim.owner,
    });
    if (!claim.claimed) {
      throw new Error(
        `SAT submission ${claim.record.requestId} could not acquire its durable execution lease`,
      );
    }
  }
  const requestId = claim.record.requestId;
  let resumedReviewedOperation: SatSubmissionSignerOperation | undefined;
  if (intent.type === "solana.vaultBondAction") {
    let reviewWasSigned = false;
    try {
      let review: WalletProviderJupiterReviewV2;
      try {
        review = await callLocalSocketSigner<WalletProviderJupiterReviewV2>(params.socketPath, {
          op: "v2.review.get",
          walletId: params.walletId,
          request: { requestId },
        });
      } catch (lookupError) {
        if (!String(lookupError).includes("signer review not found")) {
          throw lookupError;
        }
        review = await callLocalSocketSigner<WalletProviderJupiterReviewV2>(params.socketPath, {
          op: "v2.review.prepare",
          walletId: params.walletId,
          request: {
            requestId,
            policyHash: policy.hash,
            mode: "reviewed",
            intent,
          },
        });
      }
      if (
        review.requestId !== requestId ||
        review.policyHash !== policy.hash ||
        review.mode !== "reviewed" ||
        review.intentType !== intent.type ||
        !isDeepStrictEqual(review.semanticIntent, intent)
      ) {
        throw new Error(`Vault bond review ${requestId} does not match the exact SAT intent`);
      }
      if (review.state === "prepared") {
        const approval = createSignerReviewApprovalRequest({
          review,
          role: "vault",
          walletId: params.walletId,
          requestedBy: "sat-mining-vault",
          assetSymbol: "SAT",
          assetName: "SAT bond",
          memo: `Reviewed Vault bond action: ${intent.action}`,
          env: params.env,
        });
        await updateSatSubmission({
          walletId: params.walletId,
          requestId,
          intentDigest,
          state: "reserved",
          error: `review ${approval.id} pending`,
          owner: claim.owner,
          releaseLease: true,
          env: params.env,
        });
        throw new Error(
          `Vault bond review ${approval.id} is pending in Wallet Approvals for ${intent.action}; approve it there with the signer-owned passkey`,
        );
      }
      reviewWasSigned = true;
      resumedReviewedOperation = assertSatSignerOperationIdentity(
        await reconcileTypedSatOperation({
          socketPath: params.socketPath,
          walletId: params.walletId,
          requestId,
        }),
        requestId,
      );
    } catch (error) {
      await updateSatSubmission({
        walletId: params.walletId,
        requestId,
        intentDigest,
        state: reviewWasSigned ? "unknown" : "reserved",
        error: error instanceof Error ? error.message : String(error),
        owner: claim.owner,
        releaseLease: true,
        env: params.env,
      }).catch(() => undefined);
      throw error;
    }
  }
  const executeExactOrRecover = async (): Promise<SatSubmissionSignerOperation> => {
    try {
      return await callLocalSocketSigner<SatSubmissionSignerOperation>(params.socketPath, {
        op: "v2.execute",
        walletId: signerWalletId,
        request: {
          requestId,
          policyHash: policy.hash,
          intent,
        },
      });
    } catch (executeError) {
      try {
        return await callLocalSocketSigner<SatSubmissionSignerOperation>(params.socketPath, {
          op: "v2.operation.get",
          walletId: signerWalletId,
          request: { requestId },
        });
      } catch (lookupError) {
        const executeDetail =
          executeError instanceof Error ? executeError.message : String(executeError);
        const lookupDetail =
          lookupError instanceof Error ? lookupError.message : String(lookupError);
        const detail = `${executeDetail}; ${lookupDetail}`;
        const definitivePolicyRejection =
          /^policy denies operation /u.test(executeDetail) ||
          executeDetail ===
            "explicit positive solana:native policy is required for transaction fees and rent";
        if (definitivePolicyRejection && /signer operation not found/iu.test(lookupDetail)) {
          await updateSatSubmission({
            walletId: params.walletId,
            requestId,
            intentDigest,
            state: "failed",
            error: executeDetail,
            owner: claim.owner,
            releaseLease: true,
            env: params.env,
          });
          throw new SatSubmissionDefinitiveFailureError(executeDetail);
        }
        await updateSatSubmission({
          walletId: params.walletId,
          requestId,
          intentDigest,
          state:
            claim.record.state === "confirmed" || claim.record.state === "failed"
              ? claim.record.state
              : "unknown",
          ...(claim.record.signature ? { signature: claim.record.signature } : {}),
          error: detail,
          owner: claim.owner,
          releaseLease: true,
          env: params.env,
        });
        throw new SatSubmissionUnresolvedError({ requestId, state: "unknown", detail });
      }
    }
  };
  let operation: SatSubmissionSignerOperation;
  if (resumedReviewedOperation) {
    operation = resumedReviewedOperation;
  } else if (!claim.created) {
    const callerStateWasAmbiguous =
      claim.record.state === "broadcast" || claim.record.state === "unknown";
    try {
      operation = assertSatSignerOperationIdentity(
        await callLocalSocketSigner<SatSubmissionSignerOperation>(params.socketPath, {
          op: "v2.operation.get",
          walletId: signerWalletId,
          request: { requestId },
        }),
        requestId,
      );
      operation = assertSatSignerOperationIdentity(
        await reconcileTypedSatOperation({
          socketPath: params.socketPath,
          walletId: signerWalletId,
          requestId,
          operation,
        }),
        requestId,
      );
    } catch (lookupError) {
      if (claim.record.signature) {
        await updateSatSubmission({
          walletId: params.walletId,
          requestId,
          intentDigest,
          state: claim.record.state === "confirmed" ? "confirmed" : "unknown",
          signature: claim.record.signature,
          error: lookupError instanceof Error ? lookupError.message : String(lookupError),
          owner: claim.owner,
          releaseLease: true,
          env: params.env,
        });
        throw new SatSubmissionUnresolvedError({
          requestId,
          state: claim.record.state === "confirmed" ? "confirmed-but-unverified" : "unknown",
          signature: claim.record.signature,
          detail: lookupError instanceof Error ? lookupError.message : String(lookupError),
        });
      }
      if (claim.record.state === "failed" || claim.record.state === "confirmed") {
        const detail = lookupError instanceof Error ? lookupError.message : String(lookupError);
        await updateSatSubmission({
          walletId: params.walletId,
          requestId,
          intentDigest,
          state: claim.record.state,
          error: detail,
          owner: claim.owner,
          releaseLease: true,
          env: params.env,
        });
        if (claim.record.state === "failed") {
          throw new Error(claim.record.error || `SAT signer operation ${requestId} failed`);
        }
        throw new SatSubmissionUnresolvedError({
          requestId,
          state: "confirmed-without-signature",
          detail,
        });
      }
      operation = await executeExactOrRecover();
    }
    if (operation.state === "reserved" && !operation.signature) {
      if (callerStateWasAmbiguous) {
        const detail = `signer regressed to reserved after caller persisted ${claim.record.state}`;
        await updateSatSubmission({
          walletId: params.walletId,
          requestId,
          intentDigest,
          state: "unknown",
          ...(claim.record.signature ? { signature: claim.record.signature } : {}),
          error: detail,
          owner: claim.owner,
          releaseLease: true,
          env: params.env,
        });
        throw new SatSubmissionUnresolvedError({
          requestId,
          state: "unknown",
          signature: claim.record.signature,
          detail,
        });
      }
      operation = await executeExactOrRecover();
    }
  } else {
    operation = await executeExactOrRecover();
  }
  try {
    operation = assertSatSignerOperationIdentity(operation, requestId);
    operation = assertSatSignerOperationIdentity(
      await reconcileTypedSatOperation({
        socketPath: params.socketPath,
        walletId: signerWalletId,
        requestId,
        operation,
      }),
      requestId,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await updateSatSubmission({
      walletId: params.walletId,
      requestId,
      intentDigest,
      state:
        claim.record.state === "confirmed" || claim.record.state === "failed"
          ? claim.record.state
          : "unknown",
      ...(claim.record.signature ? { signature: claim.record.signature } : {}),
      error: detail,
      owner: claim.owner,
      releaseLease: true,
      env: params.env,
    });
    throw new SatSubmissionUnresolvedError({ requestId, state: "unknown", detail });
  }
  await updateSatSubmission({
    walletId: params.walletId,
    requestId,
    intentDigest,
    state: signerStateForLedger(operation.state),
    ...(operation.signature ? { signature: operation.signature } : {}),
    ...(operation.error ? { error: operation.error } : {}),
    owner: claim.owner,
    releaseLease: true,
    env: params.env,
  });
  if (operation.state === "failed") {
    throw new SatSubmissionDefinitiveFailureError(
      operation.error || `SAT signer operation ${requestId} failed`,
    );
  }
  if (operation.state !== "confirmed" || !operation.signature) {
    throw new SatSubmissionUnresolvedError({
      requestId,
      state: operation.state,
      signature: operation.signature,
      detail: operation.error,
    });
  }
  return { ...operation, signature: operation.signature };
}
