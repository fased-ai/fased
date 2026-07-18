import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import {
  callLocalSocketSigner,
  createSignerReviewApprovalRequest,
  LEGACY_EMBEDDED_KEYSTORE_MIGRATION_MESSAGE,
  loadConfig,
  readWalletProviderRegistry,
  requireLocalSocketSignerPath,
  resolveSatBondProgramIdFromEnv,
  resolveSatMintAddressFromEnv,
  resolveSatMintProgramIdFromEnv,
  resolveSatProgramIdFromEnv,
  resolveWalletProviderId,
  resolveWalletRuntimeConfig,
  type FasedAgentConfig,
  type WalletProviderJupiterReviewV2,
} from "fased/plugin-sdk/sat-runtime";
import type { SatMiningConfig } from "./config.js";
import { decodeHash32 } from "./hash-spec.js";
import {
  resolveSatGenesisProfileContract,
  SAT_BOND_INSTRUCTION_DISCRIMINATORS,
  SAT_INSTRUCTION_DISCRIMINATORS,
  SAT_PROTOCOL_CONSTANTS,
} from "./protocol-contract.js";
import {
  inspectSatAddressLookupTable,
  inspectSatChainSlot,
  inspectSatCycle,
  inspectSatCycleRegistryMeta,
  inspectSatMinerCyclesByAddress,
} from "./rpc-read.js";
import { resolveSatSignerCodec, type SatSignerAction } from "./signer-codec-manifest.js";
import {
  buildSatSubmissionOperationKey,
  claimSatSubmission,
  digestSatSubmissionIntent,
  updateSatSubmission,
  waitForSatSubmissionLease,
  type SatSubmissionSignerState,
} from "./submission-ledger.js";

const require = createRequire(import.meta.url);

const SAT_PROGRAM_ID = () => resolveSatProgramIdFromEnv(process.env);
const SAT_MINT_PROGRAM_ID = () => resolveSatMintProgramIdFromEnv(process.env);
const SAT_MINT_ADDRESS = () => resolveSatMintAddressFromEnv(process.env);
const SAT_ROUND_BUCKET_SEED = "sat_round_bucket";
const SAT_EPOCH_SEED = "sat_epoch";
const SAT_WALLET_EPOCH_SEED = "sat_wallet_epoch";
const SAT_ROUND_COMMIT_SEED = "sat_round_commit";
const SAT_ROUND_STATE_SEED = "sat_round_state";
const SAT_VALIDATOR_ATTESTATION_SEED = "sat_validator_attestation";
const SAT_DISPUTE_SEED = "sat_dispute";
const SAT_GLOBAL_STATE_SEED = "sat_global_state";
const SAT_CYCLE_STATE_SEED = "sat_cycle_state";
const SAT_CYCLE_REGISTRY_META_SEED = "sat_cycle_registry_meta";
const SAT_CYCLE_REGISTRY_PAGE_SEED = "sat_cycle_registry_page";
const SAT_MINER_CYCLE_STATE_SEED = "sat_miner_cycle_state";
const SAT_MINER_CAPITAL_STATE_SEED = "sat_miner_capital_state";
const SAT_BOND_POSITION_SEED = "sat_bond_position";
const SAT_BOND_TIER_POLICY_SEED = "sat_bond_tier_policy";
const SAT_BOND_STAKING_DISTRIBUTOR_SEED = "sat_bond_staking_distributor";
const SAT_BOND_STAKING_POSITION_SEED = "sat_bond_staking_position";
const SAT_TREASURY_STATE_SEED = "sat_treasury_state";
const SAT_REGISTRY_RESERVE_SEED = "sat_registry_reserve";
const SAT_REBATE_VAULT_SEED = "sat_rebate_vault";
const SAT_TREASURY_VAULT_SEED = "sat_treasury_vault";
const SAT_UNLOCK_INTERVAL_STATE_SEED = "sat_unlock_interval_state";
const SAT_CYCLE_REGISTRY_PAGE_CAPACITY = 64;
const MINING_POOL_SEED = "mining_pool";
const MINING_STAKE_SEED = "mining_stake";
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SLOT_HASHES_SYSVAR_ID = "SysvarS1otHashes111111111111111111111111111";
const SAT_DISTRIBUTION_LOOKUP_MIN_MINERS = 16;
const SAT_LOOKUP_TABLE_EXTEND_CHUNK_SIZE = 20;

const IX = SAT_INSTRUCTION_DISCRIMINATORS;

const BOND_IX = SAT_BOND_INSTRUCTION_DISCRIMINATORS;

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

function satSubmitDebug(message: string) {
  if (String(process.env.FASED_SAT_SUBMIT_DEBUG ?? "").trim() === "1") {
    console.error(message);
  }
}

type SolanaModuleLike = typeof import("@solana/web3.js");

type SolanaAccountMeta = {
  pubkey: import("@solana/web3.js").PublicKey;
  isSigner: boolean;
  isWritable: boolean;
};

type SatSignerSemanticContext = {
  targetAuthority?: string;
  disputeAuthority?: string;
  intervalStartCycleId?: string;
  registryPageIndex?: string;
  minerAuthorities?: string[];
  frontCycleIds?: string[];
  backCycleIds?: string[];
};

type SatResolvedInstruction = {
  keys: SolanaAccountMeta[];
  context?: SatSignerSemanticContext;
};

let solanaModulePromise: Promise<SolanaModuleLike> | null = null;

async function loadSolanaWeb3(): Promise<SolanaModuleLike> {
  solanaModulePromise ??= (async () => require("@solana/web3.js") as SolanaModuleLike)();
  return solanaModulePromise;
}

function loadConfigForSatRuntime(activeConfig?: SatMiningConfig): FasedAgentConfig {
  const cfg = loadConfig();
  if (!activeConfig) {
    return cfg;
  }
  const maybeFullConfig = activeConfig as unknown as { plugins?: unknown };
  if (
    maybeFullConfig.plugins &&
    typeof maybeFullConfig.plugins === "object" &&
    !Array.isArray(maybeFullConfig.plugins) &&
    "entries" in maybeFullConfig.plugins
  ) {
    return activeConfig as unknown as FasedAgentConfig;
  }
  return {
    ...cfg,
    plugins: {
      ...(cfg.plugins ?? {}),
      entries: {
        ...(cfg.plugins?.entries ?? {}),
        "sat-mining": {
          ...(cfg.plugins?.entries?.["sat-mining"] ?? {}),
          config: {
            ...(cfg.plugins?.entries?.["sat-mining"]?.config ?? {}),
            ...activeConfig,
          },
        },
      },
    },
  };
}

function resolveSatWalletId(cfg: FasedAgentConfig): string | undefined {
  const value = cfg.plugins?.entries?.["sat-mining"]?.config?.walletId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resolveSatCluster(cfg: FasedAgentConfig): "local" | "devnet" | "mainnet-beta" {
  const value = cfg.plugins?.entries?.["sat-mining"]?.config?.network;
  return value === "local" || value === "mainnet-beta" || value === "devnet" ? value : "devnet";
}

function resolveSatEffectiveEnv(cfg: FasedAgentConfig, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    ...(cfg.env?.vars ?? {}),
  } as NodeJS.ProcessEnv;
}

function resolveSatProviderId(cfg: FasedAgentConfig, env: NodeJS.ProcessEnv): string {
  const effectiveEnv = resolveSatEffectiveEnv(cfg, env);
  const walletId = resolveSatWalletId(cfg);
  const signerSocket = String(effectiveEnv.FASED_WALLET_LOCAL_SIGNER_SOCKET ?? "").trim();
  if (walletId) {
    const wallet = readWalletProviderRegistry(effectiveEnv).wallets.find(
      (entry) => entry.id === walletId,
    );
    if (wallet?.providerId === "embedded-keystore") {
      throw new Error(LEGACY_EMBEDDED_KEYSTORE_MIGRATION_MESSAGE);
    }
    if (wallet?.providerId && wallet.providerId !== "local-socket-signer") {
      return wallet.providerId;
    }
    if (wallet?.providerId === "local-socket-signer" && !signerSocket) {
      throw new Error(
        "SAT mining requires the actual protocol-v2 fased-signerd application socket; legacy keystore paths and backend sockets are not signer capability.",
      );
    }
    if (wallet?.providerId === "local-socket-signer") {
      return wallet.providerId;
    }
  }
  const providerId = resolveWalletProviderId(cfg, effectiveEnv);
  if (providerId === "local-socket-signer" && !signerSocket) {
    throw new Error(
      "SAT mining requires the actual protocol-v2 fased-signerd application socket; configure FASED_WALLET_LOCAL_SIGNER_SOCKET.",
    );
  }
  return providerId;
}

async function resolveSatLocalSignerAddress(
  cfg: FasedAgentConfig,
  env: NodeJS.ProcessEnv,
  errorMessage: string,
  verifyCapabilities = true,
): Promise<string> {
  const effectiveEnv = resolveSatEffectiveEnv(cfg, env);
  const walletId = resolveSatWalletId(cfg);
  if (!walletId) {
    throw new Error("SAT mining local signer address lookup requires an attached walletId");
  }
  const socketPath = requireLocalSocketSignerPath(effectiveEnv);
  if (verifyCapabilities) {
    await requireTypedSatSignerCapabilities(socketPath, "solana.satAction");
  }
  const result = await callLocalSocketSigner<{ publicKey?: string }>(socketPath, {
    op: "v2.wallet.get",
    walletId,
  });
  const signer = String(result.publicKey ?? "").trim();
  if (signer) {
    return signer;
  }
  throw new Error(errorMessage);
}

function encodeU64(value: number): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(BigInt(value));
  return out;
}

function encodeI64(value: number): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigInt64LE(BigInt(value));
  return out;
}

function encodePubkey(value: string): Buffer {
  const solana = require("@solana/web3.js") as SolanaModuleLike;
  return new solana.PublicKey(value).toBuffer();
}

function deriveAssociatedTokenAddress(
  solana: SolanaModuleLike,
  owner: import("@solana/web3.js").PublicKey,
  mint: import("@solana/web3.js").PublicKey,
) {
  return solana.PublicKey.findProgramAddressSync(
    [owner.toBuffer(), new solana.PublicKey(TOKEN_PROGRAM_ID).toBuffer(), mint.toBuffer()],
    new solana.PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
  )[0];
}

function walletIdEnvSuffix(walletId?: string): string | undefined {
  const normalized = String(walletId ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || undefined;
}

function walletEnvValue(env: NodeJS.ProcessEnv, baseKey: string, walletId?: string): string {
  const suffix = walletIdEnvSuffix(walletId);
  if (suffix) {
    const scoped = String(env[`${baseKey}__${suffix.toUpperCase()}`] ?? "").trim();
    if (scoped) {
      return scoped;
    }
  }
  return String(env[baseKey] ?? "").trim();
}

function hasDedicatedBondProgram(env: NodeJS.ProcessEnv): boolean {
  return resolveSatBondProgramIdFromEnv(env).trim().length > 0;
}

function assertDedicatedBondProgram(env: NodeJS.ProcessEnv): void {
  if (!hasDedicatedBondProgram(env)) {
    throw new Error("legacy monolithic SAT bond mode is disabled; set FASED_SAT_BOND_PROGRAM_ID");
  }
}

export async function resolveSatValidatorAuthority(_config: SatMiningConfig) {
  const cfg = loadConfigForSatRuntime(_config);
  const effectiveEnv = resolveSatEffectiveEnv(cfg, process.env);
  if (resolveSatProviderId(cfg, effectiveEnv) !== "local-socket-signer") {
    throw new Error(
      "SAT mining unattended signing currently requires local-socket-signer for validator authority resolution",
    );
  }
  return await resolveSatLocalSignerAddress(
    cfg,
    effectiveEnv,
    "local-socket-signer returned no Solana address",
  );
}

type SatInstructionSubmitSpec = {
  data: Buffer;
  programId?: string;
  addressLookupTables?: string[];
  manageAddressLookupTable?: { lookupTableAddress?: string };
  accountResolver: (
    solana: SolanaModuleLike,
    signer: import("@solana/web3.js").PublicKey,
  ) => Promise<SolanaAccountMeta[] | SatResolvedInstruction>;
};

type SatInstructionSubmitResult = {
  txHash: string;
  signer: string;
  signerState: SatSignerOperation["state"];
  requestId: string;
  transactionVersion: "legacy" | "v0";
  lookupTableAddress?: string;
  lookupTableCreated?: boolean;
  lookupTableExtended?: boolean;
  lookupTableAddressCount?: number;
  lookupTableTransactionHashes?: string[];
};

async function prepareLocalSignerSubmitContext(cfg: FasedAgentConfig, env: NodeJS.ProcessEnv) {
  const effectiveEnv = resolveSatEffectiveEnv(cfg, env);
  const solana = await loadSolanaWeb3();
  const walletId = resolveSatWalletId(cfg);
  const socketPath = requireLocalSocketSignerPath(effectiveEnv);
  const signerAddress = await resolveSatLocalSignerAddress(
    cfg,
    effectiveEnv,
    "local-socket-signer returned no Solana address for SAT mining wallet",
    false,
  );
  const signer = new solana.PublicKey(signerAddress);
  return { effectiveEnv, solana, walletId, socketPath, signerAddress, signer };
}

async function buildLocalSignerInstructionRequest(params: {
  solana: SolanaModuleLike;
  signer: import("@solana/web3.js").PublicKey;
  env: NodeJS.ProcessEnv;
  spec: SatInstructionSubmitSpec;
}) {
  const resolved = await params.spec.accountResolver(params.solana, params.signer);
  const keys = Array.isArray(resolved) ? resolved : resolved.keys;
  const context = Array.isArray(resolved) ? undefined : resolved.context;
  const programId = params.spec.programId ?? resolveSatProgramIdFromEnv(params.env);
  const mainProgramId = resolveSatProgramIdFromEnv(params.env);
  const bondProgramId = resolveSatBondProgramIdFromEnv(params.env).trim() || undefined;
  const codec = resolveSatSignerCodec({
    programId,
    mainProgramId,
    bondProgramId,
    data: params.spec.data,
  });
  satSubmitDebug(
    `[sat-submit-debug] action=${codec.action} data_len=${params.spec.data.length} disc=${params.spec.data[0] ?? -1} keys=${keys.length}`,
  );
  return {
    action: codec.action,
    programId,
    dataBase64: params.spec.data.toString("base64"),
    keys: keys.map((key) => ({
      pubkey: key.pubkey.toBase58(),
      isSigner: key.isSigner,
      isWritable: key.isWritable,
    })),
    ...(params.spec.addressLookupTables?.length
      ? { addressLookupTables: params.spec.addressLookupTables }
      : {}),
    ...(context ? { context } : {}),
  };
}

type SatSignerOperation = {
  requestId: string;
  state: "reserved" | "broadcast" | "confirmed" | "failed" | "unknown";
  signature?: string;
  error?: string;
};

const REQUIRED_SAT_SIGNER_FEATURES = [
  "failClosedPolicies",
  "policyHashes",
  "durableCaps",
  "atomicIdempotency",
  "ambiguousBroadcastReconciliation",
  "signerOwnedKeys",
  "typedSolanaTransactions",
  "typedSATActions",
] as const;

async function requireTypedSatSignerCapabilities(
  socketPath: string,
  intentType: "solana.satAction" | "solana.satLookupTable" | "solana.vaultBondAction",
) {
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
  if (
    result.ready !== true ||
    protocol?.current !== 2 ||
    typeof protocol.min !== "number" ||
    protocol.min > 2 ||
    typeof protocol.max !== "number" ||
    protocol.max < 2 ||
    !capabilities?.intentTypes?.includes(intentType) ||
    missingFeatures.length > 0 ||
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
      }${missingStates.length > 0 ? `; missing states: ${missingStates.join(", ")}` : ""}`,
    );
  }
}

async function reconcileTypedSatOperation(params: {
  socketPath: string;
  walletId: string;
  requestId: string;
  operation?: SatSignerOperation;
}) {
  let operation =
    params.operation ??
    (await callLocalSocketSigner<SatSignerOperation>(params.socketPath, {
      op: "v2.operation.get",
      walletId: params.walletId,
      request: { requestId: params.requestId },
    }));
  if (operation.state === "broadcast" || operation.state === "unknown") {
    try {
      operation = await callLocalSocketSigner<SatSignerOperation>(params.socketPath, {
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

function assertSatSignerOperationIdentity(
  operation: SatSignerOperation,
  requestId: string,
): SatSignerOperation {
  if (operation.requestId !== requestId) {
    throw new Error(
      `SAT signer returned request ${operation.requestId || "<empty>"} while reconciling ${requestId}`,
    );
  }
  return operation;
}

function signerStateForLedger(state: SatSignerOperation["state"]): SatSubmissionSignerState {
  return state;
}

type SatLookupTableAction = "create" | "extend" | "deactivate" | "close";

function assertSatLookupTableAction(value: string): asserts value is SatLookupTableAction {
  if (value !== "create" && value !== "extend" && value !== "deactivate" && value !== "close") {
    throw new Error(`unsupported SAT lookup-table action ${value}`);
  }
}

class SatSubmissionUnresolvedError extends Error {
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

async function executeTypedSatIntent(params: {
  socketPath: string;
  walletId: string;
  action: SatSignerAction | "cleanupBatch" | "create" | "extend" | "deactivate" | "close";
  instruction?: Awaited<ReturnType<typeof buildLocalSignerInstructionRequest>>;
  instructions?: Array<Awaited<ReturnType<typeof buildLocalSignerInstructionRequest>>>;
  lookupTable?: { address: string; recentSlot?: string; addresses?: string[] };
  cluster: "local" | "devnet" | "mainnet-beta";
  env: NodeJS.ProcessEnv;
}) {
  const isLookupTable = params.lookupTable != null;
  const isVaultBond =
    !isLookupTable &&
    params.action !== "cleanupBatch" &&
    VAULT_BOND_ACTIONS.has(params.action as SatSignerAction);
  const intentType = isLookupTable
    ? "solana.satLookupTable"
    : isVaultBond
      ? "solana.vaultBondAction"
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
      : {
          type: "solana.satAction" as const,
          action: params.action,
          ...(params.instruction ?? {}),
          ...(params.instructions ? { instructions: params.instructions } : {}),
        };
  const policy = await callLocalSocketSigner<{ hash: string }>(params.socketPath, {
    op: "v2.policy.get",
    walletId: params.walletId,
  });
  const intentDigest = digestSatSubmissionIntent({
    walletId: params.walletId,
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
  let resumedReviewedOperation: SatSignerOperation | undefined;
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
  const executeExactOrRecover = async (): Promise<SatSignerOperation> => {
    try {
      return await callLocalSocketSigner<SatSignerOperation>(params.socketPath, {
        op: "v2.execute",
        walletId: params.walletId,
        request: {
          requestId,
          policyHash: policy.hash,
          intent,
        },
      });
    } catch (executeError) {
      try {
        return await callLocalSocketSigner<SatSignerOperation>(params.socketPath, {
          op: "v2.operation.get",
          walletId: params.walletId,
          request: { requestId },
        });
      } catch (lookupError) {
        const detail = `${executeError instanceof Error ? executeError.message : String(executeError)}; ${
          lookupError instanceof Error ? lookupError.message : String(lookupError)
        }`;
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
  let operation: SatSignerOperation;
  if (resumedReviewedOperation) {
    operation = resumedReviewedOperation;
  } else if (!claim.created) {
    const callerStateWasAmbiguous =
      claim.record.state === "broadcast" || claim.record.state === "unknown";
    try {
      operation = assertSatSignerOperationIdentity(
        await callLocalSocketSigner<SatSignerOperation>(params.socketPath, {
          op: "v2.operation.get",
          walletId: params.walletId,
          request: { requestId },
        }),
        requestId,
      );
      operation = assertSatSignerOperationIdentity(
        await reconcileTypedSatOperation({
          socketPath: params.socketPath,
          walletId: params.walletId,
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
        walletId: params.walletId,
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
    throw new Error(operation.error || `SAT signer operation ${requestId} failed`);
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

type SatLookupSubmitContext = Awaited<ReturnType<typeof prepareLocalSignerSubmitContext>> & {
  walletId: string;
};

function assertSatLookupTableEnabled(env: NodeJS.ProcessEnv): void {
  if (String(env.FASED_SAT_ENABLE_ALT_V0 ?? "").trim() !== "1") {
    throw new Error("SAT ALT/v0 support is disabled; set FASED_SAT_ENABLE_ALT_V0=1");
  }
}

async function executeTypedSatLookupOperation(params: {
  context: SatLookupSubmitContext;
  cfg: FasedAgentConfig;
  action: "create" | "extend" | "deactivate" | "close";
  address: string;
  recentSlot?: number;
  addresses?: string[];
}) {
  return await executeTypedSatIntent({
    socketPath: params.context.socketPath,
    walletId: params.context.walletId,
    action: params.action,
    lookupTable: {
      address: params.address,
      ...(params.recentSlot == null ? {} : { recentSlot: String(params.recentSlot) }),
      ...(params.addresses?.length ? { addresses: params.addresses } : {}),
    },
    cluster: resolveSatCluster(params.cfg),
    env: params.context.effectiveEnv,
  });
}

async function readValidatedSatLookupTable(params: {
  config: SatMiningConfig;
  address: string;
  authority: string;
}) {
  const state = await inspectSatAddressLookupTable(params.config, { address: params.address });
  if (!state) {
    return null;
  }
  if (state.authority !== params.authority) {
    throw new Error("SAT distribution lookup table is not controlled by the Mining signer");
  }
  if (!state.active) {
    throw new Error("SAT distribution lookup table is not active");
  }
  return state;
}

async function waitForSatLookupTable(params: {
  config: SatMiningConfig;
  address: string;
  authority: string;
  requireNextSlot: boolean;
}) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    try {
      const state = await readValidatedSatLookupTable(params);
      if (state) {
        const currentSlot = await inspectSatChainSlot(params.config);
        if (!params.requireNextSlot || currentSlot > state.lastExtendedSlot) {
          return state;
        }
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `SAT distribution lookup table did not become active for use within 6s${
      lastError instanceof Error ? `: ${lastError.message}` : ""
    }`,
  );
}

async function ensureSatDistributionLookupTable(params: {
  context: SatLookupSubmitContext;
  cfg: FasedAgentConfig;
  config: SatMiningConfig;
  lookupTableAddress?: string;
  addresses: string[];
}) {
  assertSatLookupTableEnabled(params.context.effectiveEnv);
  const desiredAddresses = [...new Set(params.addresses.map((entry) => entry.trim()))].filter(
    Boolean,
  );
  if (desiredAddresses.length === 0 || desiredAddresses.length > 256) {
    throw new Error("SAT distribution lookup table requires 1-256 exact account addresses");
  }
  let lookupTable = params.lookupTableAddress?.trim() ?? "";
  let state = lookupTable
    ? await readValidatedSatLookupTable({
        config: params.config,
        address: lookupTable,
        authority: params.context.signerAddress,
      })
    : null;
  let created = false;
  const transactionHashes: string[] = [];
  if (!lookupTable) {
    const currentSlot = await inspectSatChainSlot(params.config);
    const recentSlot = Math.max(0, currentSlot - 1);
    const [, derivedAddress] = params.context.solana.AddressLookupTableProgram.createLookupTable({
      authority: params.context.signer,
      payer: params.context.signer,
      recentSlot,
    });
    lookupTable = derivedAddress.toBase58();
    state = await readValidatedSatLookupTable({
      config: params.config,
      address: lookupTable,
      authority: params.context.signerAddress,
    });
    if (!state) {
      try {
        const submitted = await executeTypedSatLookupOperation({
          context: params.context,
          cfg: params.cfg,
          action: "create",
          address: lookupTable,
          recentSlot,
        });
        transactionHashes.push(submitted.signature);
        created = true;
      } catch (error) {
        if (error instanceof SatSubmissionUnresolvedError) {
          throw error;
        }
        try {
          state = await waitForSatLookupTable({
            config: params.config,
            address: lookupTable,
            authority: params.context.signerAddress,
            requireNextSlot: false,
          });
        } catch {
          throw error;
        }
      }
      state ??= await waitForSatLookupTable({
        config: params.config,
        address: lookupTable,
        authority: params.context.signerAddress,
        requireNextSlot: false,
      });
    }
  }
  if (!state) {
    throw new Error("SAT distribution lookup table was not found at the confirmed commitment");
  }
  const existing = new Set(state.addresses);
  const missing = desiredAddresses.filter((entry) => !existing.has(entry));
  for (let offset = 0; offset < missing.length; offset += SAT_LOOKUP_TABLE_EXTEND_CHUNK_SIZE) {
    const addresses = missing.slice(offset, offset + SAT_LOOKUP_TABLE_EXTEND_CHUNK_SIZE);
    try {
      const submitted = await executeTypedSatLookupOperation({
        context: params.context,
        cfg: params.cfg,
        action: "extend",
        address: lookupTable,
        addresses,
      });
      transactionHashes.push(submitted.signature);
    } catch (error) {
      if (error instanceof SatSubmissionUnresolvedError) {
        throw error;
      }
      const concurrentState = await waitForSatLookupTable({
        config: params.config,
        address: lookupTable,
        authority: params.context.signerAddress,
        requireNextSlot: false,
      }).catch(() => null);
      if (
        !concurrentState ||
        addresses.some((address) => !concurrentState.addresses.includes(address))
      ) {
        throw error;
      }
    }
  }
  const ready = await waitForSatLookupTable({
    config: params.config,
    address: lookupTable,
    authority: params.context.signerAddress,
    requireNextSlot: true,
  });
  for (const address of desiredAddresses) {
    if (!ready.addresses.includes(address)) {
      throw new Error(`SAT distribution lookup table did not persist required account ${address}`);
    }
  }
  return {
    lookupTable,
    created,
    extended: missing.length > 0,
    addressCount: ready.addresses.length,
    transactionHashes,
  };
}

async function submitInstructionViaLocalSigner(
  params: {
    cfg: FasedAgentConfig;
    env: NodeJS.ProcessEnv;
  } & SatInstructionSubmitSpec,
): Promise<SatInstructionSubmitResult> {
  const context = await prepareLocalSignerSubmitContext(params.cfg, params.env);
  const baseRequest = await buildLocalSignerInstructionRequest({
    solana: context.solana,
    signer: context.signer,
    env: context.effectiveEnv,
    spec: params,
  });
  if (!context.walletId) {
    throw new Error("typed SAT signing requires an explicit mining walletId");
  }
  let managedLookupTable: Awaited<ReturnType<typeof ensureSatDistributionLookupTable>> | undefined;
  if (params.manageAddressLookupTable) {
    managedLookupTable = await ensureSatDistributionLookupTable({
      context: { ...context, walletId: context.walletId },
      cfg: params.cfg,
      config: params.cfg as unknown as SatMiningConfig,
      lookupTableAddress: params.manageAddressLookupTable.lookupTableAddress,
      addresses: baseRequest.keys.filter((key) => !key.isSigner).map((key) => key.pubkey),
    });
  }
  const request = managedLookupTable
    ? { ...baseRequest, addressLookupTables: [managedLookupTable.lookupTable] }
    : baseRequest;
  const submitted = await executeTypedSatIntent({
    socketPath: context.socketPath,
    walletId: context.walletId,
    action: request.action,
    instruction: request,
    cluster: resolveSatCluster(params.cfg),
    env: context.effectiveEnv,
  });
  return {
    txHash: submitted.signature,
    signer: context.signerAddress,
    signerState: submitted.state,
    requestId: submitted.requestId,
    ...(request.addressLookupTables?.length
      ? {
          transactionVersion: "v0" as const,
          lookupTableAddress: request.addressLookupTables[0],
        }
      : { transactionVersion: "legacy" as const }),
    ...(managedLookupTable
      ? {
          lookupTableCreated: managedLookupTable.created,
          lookupTableExtended: managedLookupTable.extended,
          lookupTableAddressCount: managedLookupTable.addressCount,
          lookupTableTransactionHashes: managedLookupTable.transactionHashes,
        }
      : {}),
  };
}

async function submitInstruction(
  params: {
    cfg: FasedAgentConfig;
    env: NodeJS.ProcessEnv;
  } & SatInstructionSubmitSpec,
) {
  const effectiveEnv = resolveSatEffectiveEnv(params.cfg, params.env);
  if (resolveSatProviderId(params.cfg, effectiveEnv) !== "local-socket-signer") {
    throw new Error("SAT mining unattended submission currently requires local-socket-signer");
  }
  return await submitInstructionViaLocalSigner({
    cfg: params.cfg,
    env: effectiveEnv,
    data: params.data,
    programId: params.programId,
    addressLookupTables: params.addressLookupTables,
    manageAddressLookupTable: params.manageAddressLookupTable,
    accountResolver: params.accountResolver,
  });
}

async function submitInstructionBatch(params: {
  cfg: FasedAgentConfig;
  env: NodeJS.ProcessEnv;
  purpose: "sat-cleanup";
  instructions: SatInstructionSubmitSpec[];
}) {
  if (params.instructions.length === 0) {
    throw new Error("SAT cleanup batch has no instructions");
  }
  if (params.instructions.length > 6) {
    throw new Error("SAT cleanup batch exceeds signer limit");
  }
  const effectiveEnv = resolveSatEffectiveEnv(params.cfg, params.env);
  if (resolveSatProviderId(params.cfg, effectiveEnv) !== "local-socket-signer") {
    throw new Error(
      "SAT mining unattended batch submission currently requires local-socket-signer",
    );
  }
  const context = await prepareLocalSignerSubmitContext(params.cfg, effectiveEnv);
  const instructions: Array<Awaited<ReturnType<typeof buildLocalSignerInstructionRequest>>> = [];
  for (const spec of params.instructions) {
    instructions.push(
      await buildLocalSignerInstructionRequest({
        solana: context.solana,
        signer: context.signer,
        env: context.effectiveEnv,
        spec,
      }),
    );
  }
  if (!context.walletId) {
    throw new Error("typed SAT cleanup signing requires an explicit mining walletId");
  }
  const submitted = await executeTypedSatIntent({
    socketPath: context.socketPath,
    walletId: context.walletId,
    action: "cleanupBatch",
    instructions,
    cluster: resolveSatCluster(params.cfg),
    env: context.effectiveEnv,
  });
  return {
    txHash: submitted.signature,
    signer: context.signerAddress,
    signerState: submitted.state,
    requestId: submitted.requestId,
    instructionCount: instructions.length,
  };
}

function buildInitializeCycleData(params: {
  epochId: number;
  microRoundId: number;
  bucketVersion: number;
  roundOpenTs: number;
  roundCloseTs: number;
  roundSeed: string;
  bucketHash: string;
}) {
  return Buffer.concat([
    Buffer.from([IX.initializeCycle]),
    encodeU64(params.epochId),
    encodeU64(params.microRoundId),
    encodeU64(params.bucketVersion),
    encodeI64(params.roundOpenTs),
    encodeI64(params.roundCloseTs),
    decodeHash32(params.roundSeed),
    decodeHash32(params.bucketHash),
  ]);
}

function buildOpenRoundData(params: Parameters<typeof buildInitializeCycleData>[0]) {
  return Buffer.concat([Buffer.from([IX.openRound]), buildInitializeCycleData(params).subarray(1)]);
}

function buildParticipationData(params: {
  epochId: number;
  microRoundId: number;
  bucketHash: string;
  allocationSum: number;
  allocationFp: number[];
  coordinationGroupHash: string;
  coordinationMessageRoot: string;
  coordinationPeerCount: number;
  coordinationIntent: number;
}) {
  if (params.allocationFp.length !== 25) {
    throw new Error(`expected 25 allocation buckets, got ${params.allocationFp.length}`);
  }
  return Buffer.concat([
    Buffer.from([IX.submitParticipation]),
    encodeU64(params.epochId),
    encodeU64(params.microRoundId),
    decodeHash32(params.bucketHash),
    encodeU64(params.allocationSum),
    Buffer.concat(
      params.allocationFp.map((value) => {
        const out = Buffer.alloc(4);
        out.writeUInt32LE(value);
        return out;
      }),
    ),
    decodeHash32(params.coordinationGroupHash),
    decodeHash32(params.coordinationMessageRoot),
    encodeU64(params.coordinationPeerCount),
    encodeU64(params.coordinationIntent),
  ]);
}

function buildFinalizeEpochData(params: {
  epochId: number;
  bucketRoot: string;
  scoreRoot: string;
}) {
  return Buffer.concat([
    Buffer.from([IX.finalizeEpoch]),
    encodeU64(params.epochId),
    decodeHash32(params.bucketRoot),
    decodeHash32(params.scoreRoot),
  ]);
}

function buildSubmitValidatorAttestationData(params: {
  epochId: number;
  microRoundId: number;
  decisionFlag: number;
  reasonCode: number;
  bucketRoot: string;
  scoreRoot: string;
  coordinationRoot: string;
  evidenceHash: string;
}) {
  const reasonCode = Buffer.alloc(2);
  reasonCode.writeUInt16LE(params.reasonCode);
  return Buffer.concat([
    Buffer.from([IX.submitValidatorAttestation]),
    encodeU64(params.epochId),
    encodeU64(params.microRoundId),
    encodeU64(params.decisionFlag),
    reasonCode,
    Buffer.alloc(6),
    decodeHash32(params.bucketRoot),
    decodeHash32(params.scoreRoot),
    decodeHash32(params.coordinationRoot),
    decodeHash32(params.evidenceHash),
  ]);
}

function buildOpenDisputeData(params: {
  epochId: number;
  microRoundId: number;
  reasonCode: number;
  evidenceHash: string;
  targetRoot: string;
}) {
  const reasonCode = Buffer.alloc(2);
  reasonCode.writeUInt16LE(params.reasonCode);
  return Buffer.concat([
    Buffer.from([IX.openDispute]),
    encodeU64(params.epochId),
    encodeU64(params.microRoundId),
    reasonCode,
    Buffer.alloc(6),
    decodeHash32(params.evidenceHash),
    decodeHash32(params.targetRoot),
  ]);
}

function buildClaimData(params: {
  epochId: number;
  microRoundId?: number;
  targetAuthority?: string;
}) {
  return Buffer.concat([
    Buffer.from([IX.claim]),
    encodeU64(params.epochId),
    encodeU64(params.microRoundId ?? 0),
    params.targetAuthority ? encodePubkey(params.targetAuthority) : Buffer.alloc(32),
  ]);
}

function buildMiningCrankData() {
  return Buffer.from([IX.miningCrank]);
}

function buildTopUpRegistryReserveData(params: { targetBalanceLamports: number }) {
  return Buffer.concat([
    Buffer.from([IX.topUpRegistryReserve]),
    encodeU64(params.targetBalanceLamports),
  ]);
}

function buildOpenCycleData(params: { cycleId: number }) {
  return Buffer.concat([Buffer.from([IX.openCycle]), encodeU64(params.cycleId)]);
}

function buildInitMinerCapitalData(params: { authority: string }) {
  return Buffer.concat([Buffer.from([IX.initMinerCapital]), encodePubkey(params.authority)]);
}

function buildDepositMinerCapitalData(params: { lamports: number }) {
  return Buffer.concat([Buffer.from([IX.depositMinerCapital]), encodeU64(params.lamports)]);
}

function buildWithdrawMinerCapitalData(params: { lamports: number }) {
  return Buffer.concat([Buffer.from([IX.withdrawMinerCapital]), encodeU64(params.lamports)]);
}

function buildSetActiveCommitData(params: { lamports: number }) {
  return Buffer.concat([Buffer.from([IX.setActiveCommit]), encodeU64(params.lamports)]);
}

function buildUpdateBondTierPolicyData(params: {
  updateAuthority: string;
  basicMinRaw: number;
  operatorMinRaw: number;
  unlockDelaySlots: number;
  scheduledEffectiveSlot?: number;
}) {
  return Buffer.concat([
    Buffer.from([BOND_IX.updateTierPolicy]),
    encodePubkey(params.updateAuthority),
    encodeU64(params.basicMinRaw),
    encodeU64(params.operatorMinRaw),
    encodeU64(params.unlockDelaySlots),
    encodeU64(params.scheduledEffectiveSlot ?? 0),
  ]);
}

function buildOpenBondPositionData(
  params: { amountRaw: number },
  env: NodeJS.ProcessEnv = process.env,
) {
  assertDedicatedBondProgram(env);
  return Buffer.concat([Buffer.from([BOND_IX.openBondPosition]), encodeU64(params.amountRaw)]);
}

function buildIncreaseBondPositionData(
  params: { amountRaw: number },
  env: NodeJS.ProcessEnv = process.env,
) {
  assertDedicatedBondProgram(env);
  return Buffer.concat([Buffer.from([BOND_IX.increaseBondPosition]), encodeU64(params.amountRaw)]);
}

function buildRequestBondUnlockData(env: NodeJS.ProcessEnv = process.env) {
  assertDedicatedBondProgram(env);
  return Buffer.from([BOND_IX.requestBondUnlock]);
}

function buildCancelBondUnlockData(env: NodeJS.ProcessEnv = process.env) {
  assertDedicatedBondProgram(env);
  return Buffer.from([BOND_IX.cancelBondUnlock]);
}

function buildFinalizeBondUnlockData(env: NodeJS.ProcessEnv = process.env) {
  assertDedicatedBondProgram(env);
  return Buffer.from([BOND_IX.finalizeBondUnlock]);
}

function buildSyncBondStakingRewardsData(env: NodeJS.ProcessEnv = process.env) {
  assertDedicatedBondProgram(env);
  return Buffer.from([BOND_IX.syncStakingRewards]);
}

function buildSyncBondStakingPositionData(env: NodeJS.ProcessEnv = process.env) {
  assertDedicatedBondProgram(env);
  return Buffer.from([BOND_IX.syncStakingPosition]);
}

function buildClaimBondStakingRewardsData(env: NodeJS.ProcessEnv = process.env) {
  assertDedicatedBondProgram(env);
  return Buffer.from([BOND_IX.claimStakingRewards]);
}

function buildClaimUnallocatedStakingRewardsData(env: NodeJS.ProcessEnv = process.env) {
  assertDedicatedBondProgram(env);
  return Buffer.from([BOND_IX.claimUnallocatedStakingRewards]);
}

function encodeAllocationFp(allocationFp: number[]): Buffer {
  if (allocationFp.length !== 25) {
    throw new Error(`expected 25 allocation buckets, got ${allocationFp.length}`);
  }
  return Buffer.concat(
    allocationFp.map((value) => {
      if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
        throw new Error(`invalid allocation bucket value: ${value}`);
      }
      const out = Buffer.alloc(4);
      out.writeUInt32LE(value);
      return out;
    }),
  );
}

export function buildSatCycleCommitment(params: {
  authority: string;
  cycleId: number;
  committedLamports: number;
  nonce: Buffer;
  allocationFp: number[];
  programId?: string;
}): Buffer {
  if (params.nonce.length !== 32) {
    throw new Error(`expected 32-byte cycle nonce, got ${params.nonce.length}`);
  }
  const allocation = encodeAllocationFp(params.allocationFp);
  return createHash("sha256")
    .update(
      Buffer.concat([
        Buffer.from("sat-cycle-commit-v1"),
        encodePubkey(params.programId ?? SAT_PROGRAM_ID()),
        encodePubkey(params.authority),
        encodeU64(params.cycleId),
        encodeU64(params.committedLamports),
        params.nonce,
        allocation,
      ]),
    )
    .digest();
}

function buildCommitCycleData(params: { cycleId: number; commitment: Buffer }) {
  if (params.commitment.length !== 32) {
    throw new Error(`expected 32-byte cycle commitment, got ${params.commitment.length}`);
  }
  return Buffer.concat([
    Buffer.from([IX.commitCycle]),
    encodeU64(params.cycleId),
    params.commitment,
  ]);
}

function buildCloseCommitPhaseData(params: { cycleId: number }) {
  return Buffer.concat([Buffer.from([IX.closeCommitPhase]), encodeU64(params.cycleId)]);
}

function buildSealCycleEntropyData(params: { cycleId: number }) {
  return Buffer.concat([Buffer.from([IX.sealCycleEntropy]), encodeU64(params.cycleId)]);
}

function buildRevealCycleData(params: { cycleId: number; nonce: Buffer; allocationFp: number[] }) {
  if (params.nonce.length !== 32) {
    throw new Error(`expected 32-byte cycle nonce, got ${params.nonce.length}`);
  }
  return Buffer.concat([
    Buffer.from([IX.revealCycle]),
    encodeU64(params.cycleId),
    params.nonce,
    encodeAllocationFp(params.allocationFp),
    Buffer.alloc(4),
  ]);
}

function buildReleaseUnrevealedCommitData(params: { cycleId: number; minerAuthority: string }) {
  return Buffer.concat([
    Buffer.from([IX.releaseUnrevealedCommit]),
    encodeU64(params.cycleId),
    encodePubkey(params.minerAuthority),
  ]);
}

function buildAbortEmptyCycleData(params: { cycleId: number }) {
  return Buffer.concat([Buffer.from([IX.abortEmptyCycle]), encodeU64(params.cycleId)]);
}

function buildClaimCycleRewardsData(params: { cycleId: number }) {
  return Buffer.concat([Buffer.from([IX.claimCycleRewards]), encodeU64(params.cycleId)]);
}

function buildRetargetUnlockData(params: { cycleId: number }) {
  return Buffer.concat([Buffer.from([IX.retargetUnlock]), encodeU64(params.cycleId)]);
}

function buildClaimCycleRewardsBatchData(params: { cycleIds: number[] }) {
  const header = Buffer.alloc(8);
  header.writeUInt8(params.cycleIds.length, 0);
  return Buffer.concat([
    Buffer.from([IX.claimCycleRewardsBatch]),
    header,
    ...params.cycleIds.map((cycleId) => encodeU64(cycleId)),
  ]);
}

function buildClaimProtocolTreasuryData() {
  return Buffer.from([IX.claimProtocolTreasury]);
}

function buildRefillRegistryReserveFromTreasuryData(params: { targetBalanceLamports: number }) {
  return Buffer.concat([
    Buffer.from([IX.refillRegistryReserveFromTreasury]),
    encodeU64(params.targetBalanceLamports),
  ]);
}

function buildClaimProtocolDistributorSatData() {
  return Buffer.from([IX.claimProtocolDistributorSat]);
}

function buildSettleCyclePageData(params: {
  cycleId: number;
  pageIndex: number;
  chunkIndex: number;
}) {
  return Buffer.concat([
    Buffer.from([IX.settleCyclePage]),
    encodeU64(params.cycleId),
    encodeU64(params.pageIndex),
    encodeU64(params.chunkIndex),
  ]);
}

function buildFinalizeCycleSettlementData(params: { cycleId: number }) {
  return Buffer.concat([Buffer.from([IX.finalizeCycleSettlement]), encodeU64(params.cycleId)]);
}

function buildScoreCyclePageData(params: {
  cycleId: number;
  pageIndex: number;
  chunkIndex: number;
}) {
  return Buffer.concat([
    Buffer.from([IX.scoreCyclePage]),
    encodeU64(params.cycleId),
    encodeU64(params.pageIndex),
    encodeU64(params.chunkIndex),
  ]);
}

function buildDistributeCyclePageData(params: {
  cycleId: number;
  pageIndex: number;
  chunkIndex: number;
}) {
  return Buffer.concat([
    Buffer.from([IX.distributeCyclePage]),
    encodeU64(params.cycleId),
    encodeU64(params.pageIndex),
    encodeU64(params.chunkIndex),
  ]);
}

function buildCloseResolvedMinerCycleStateData(params: { cycleId: number }) {
  return Buffer.concat([Buffer.from([IX.closeResolvedMinerCycleState]), encodeU64(params.cycleId)]);
}

function buildCloseResolvedCycleRegistryPageData(params: { cycleId: number; pageIndex: number }) {
  return Buffer.concat([
    Buffer.from([IX.closeResolvedCycleRegistryPage]),
    encodeU64(params.cycleId),
    encodeU64(params.pageIndex),
  ]);
}

function buildCloseResolvedCycleArtifactsData(params: { cycleId: number }) {
  return Buffer.concat([Buffer.from([IX.closeResolvedCycleArtifacts]), encodeU64(params.cycleId)]);
}

function buildCompactPendingCycleRangeData(params: {
  expectedFirstPendingCycleId: number;
  expectedLastPendingCycleId: number;
  frontCycleIds: number[];
  backCycleIds: number[];
}) {
  return Buffer.concat([
    Buffer.from([IX.compactPendingCycleRange]),
    encodeU64(params.expectedFirstPendingCycleId),
    encodeU64(params.expectedLastPendingCycleId),
    Buffer.from([params.frontCycleIds.length & 0xff, params.backCycleIds.length & 0xff]),
    Buffer.alloc(6),
  ]);
}

async function resolveSatCycleRegistryPageIndex(config: SatMiningConfig, cycleId: number) {
  const registryMeta = await inspectSatCycleRegistryMeta(config, { cycleId }).catch(() => null);
  return Math.floor((registryMeta?.participantCount ?? 0) / SAT_CYCLE_REGISTRY_PAGE_CAPACITY);
}

function buildResolveDisputeData(params: {
  epochId: number;
  microRoundId: number;
  statusFlag: number;
  targetAuthority: string;
}) {
  return Buffer.concat([
    Buffer.from([IX.resolveDispute]),
    encodeU64(params.epochId),
    encodeU64(params.microRoundId),
    encodeU64(params.statusFlag),
    encodePubkey(params.targetAuthority),
  ]);
}

function buildRepublishEpochRootsData(params: {
  epochId: number;
  bucketRoot: string;
  scoreRoot: string;
  coordinationRoot: string;
}) {
  return Buffer.concat([
    Buffer.from([IX.republishEpochRoots]),
    encodeU64(params.epochId),
    decodeHash32(params.bucketRoot),
    decodeHash32(params.scoreRoot),
    decodeHash32(params.coordinationRoot),
  ]);
}

export async function submitSatInitializeCycle(
  _config: SatMiningConfig,
  params: Parameters<typeof buildInitializeCycleData>[0],
) {
  const cfg = loadConfigForSatRuntime(_config);
  return submitInstruction({
    cfg,
    env: process.env,
    data: buildInitializeCycleData(params),
    accountResolver: async (solana, signer) => {
      const programId = new solana.PublicKey(SAT_PROGRAM_ID());
      const [satCycle] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_ROUND_BUCKET_SEED)],
        programId,
      );
      const [satEpoch] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_EPOCH_SEED), encodeU64(params.epochId)],
        programId,
      );
      return [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: satCycle, isSigner: false, isWritable: true },
        { pubkey: satEpoch, isSigner: false, isWritable: true },
        { pubkey: solana.SystemProgram.programId, isSigner: false, isWritable: false },
      ];
    },
  });
}

export async function submitSatValidatorAttestation(
  _config: SatMiningConfig,
  params: Parameters<typeof buildSubmitValidatorAttestationData>[0] & { targetAuthority?: string },
) {
  const cfg = loadConfigForSatRuntime(_config);
  return submitInstruction({
    cfg,
    env: process.env,
    data: buildSubmitValidatorAttestationData(params),
    accountResolver: async (solana, signer) => {
      const programId = new solana.PublicKey(SAT_PROGRAM_ID());
      const targetAuthority = params.targetAuthority?.trim()
        ? new solana.PublicKey(params.targetAuthority)
        : signer;
      const [satEpoch] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_EPOCH_SEED), encodeU64(params.epochId)],
        programId,
      );
      const [satValidatorAttestation] = solana.PublicKey.findProgramAddressSync(
        [
          Buffer.from(SAT_VALIDATOR_ATTESTATION_SEED),
          signer.toBuffer(),
          targetAuthority.toBuffer(),
          encodeU64(params.epochId),
          encodeU64(params.microRoundId),
        ],
        programId,
      );
      const [miningStake] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(MINING_STAKE_SEED), targetAuthority.toBuffer()],
        programId,
      );
      return {
        keys: [
          { pubkey: signer, isSigner: true, isWritable: true },
          { pubkey: satEpoch, isSigner: false, isWritable: true },
          { pubkey: satValidatorAttestation, isSigner: false, isWritable: true },
          { pubkey: miningStake, isSigner: false, isWritable: true },
          { pubkey: solana.SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        context: { targetAuthority: targetAuthority.toBase58() },
      };
    },
  });
}

export async function submitSatOpenDispute(
  _config: SatMiningConfig,
  params: Parameters<typeof buildOpenDisputeData>[0] & { targetAuthority?: string },
) {
  const cfg = loadConfigForSatRuntime(_config);
  return submitInstruction({
    cfg,
    env: process.env,
    data: buildOpenDisputeData(params),
    accountResolver: async (solana, signer) => {
      const programId = new solana.PublicKey(SAT_PROGRAM_ID());
      const targetAuthority = params.targetAuthority?.trim()
        ? new solana.PublicKey(params.targetAuthority)
        : signer;
      const [satEpoch] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_EPOCH_SEED), encodeU64(params.epochId)],
        programId,
      );
      const [satDispute] = solana.PublicKey.findProgramAddressSync(
        [
          Buffer.from(SAT_DISPUTE_SEED),
          signer.toBuffer(),
          targetAuthority.toBuffer(),
          encodeU64(params.epochId),
          encodeU64(params.microRoundId),
        ],
        programId,
      );
      const [miningStake] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(MINING_STAKE_SEED), targetAuthority.toBuffer()],
        programId,
      );
      return {
        keys: [
          { pubkey: signer, isSigner: true, isWritable: true },
          { pubkey: satEpoch, isSigner: false, isWritable: true },
          { pubkey: satDispute, isSigner: false, isWritable: true },
          { pubkey: miningStake, isSigner: false, isWritable: true },
          { pubkey: solana.SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        context: { targetAuthority: targetAuthority.toBase58() },
      };
    },
  });
}

export async function submitSatResolveDispute(
  _config: SatMiningConfig,
  params: Parameters<typeof buildResolveDisputeData>[0] & { disputeAuthority: string },
) {
  const cfg = loadConfigForSatRuntime(_config);
  return submitInstruction({
    cfg,
    env: process.env,
    data: buildResolveDisputeData(params),
    accountResolver: async (solana, signer) => {
      const programId = new solana.PublicKey(SAT_PROGRAM_ID());
      const disputeAuthority = new solana.PublicKey(params.disputeAuthority);
      const targetAuthority = new solana.PublicKey(params.targetAuthority);
      const [miningPool] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(MINING_POOL_SEED)],
        programId,
      );
      const [satEpoch] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_EPOCH_SEED), encodeU64(params.epochId)],
        programId,
      );
      const [satDispute] = solana.PublicKey.findProgramAddressSync(
        [
          Buffer.from(SAT_DISPUTE_SEED),
          disputeAuthority.toBuffer(),
          targetAuthority.toBuffer(),
          encodeU64(params.epochId),
          encodeU64(params.microRoundId),
        ],
        programId,
      );
      return {
        keys: [
          { pubkey: signer, isSigner: true, isWritable: true },
          { pubkey: miningPool, isSigner: false, isWritable: false },
          { pubkey: satEpoch, isSigner: false, isWritable: true },
          { pubkey: satDispute, isSigner: false, isWritable: true },
        ],
        context: { disputeAuthority: disputeAuthority.toBase58() },
      };
    },
  });
}

export async function submitSatRepublishEpochRoots(
  _config: SatMiningConfig,
  params: Parameters<typeof buildRepublishEpochRootsData>[0],
) {
  const cfg = loadConfigForSatRuntime(_config);
  return submitInstruction({
    cfg,
    env: process.env,
    data: buildRepublishEpochRootsData(params),
    accountResolver: async (solana, signer) => {
      const programId = new solana.PublicKey(SAT_PROGRAM_ID());
      const [miningPool] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(MINING_POOL_SEED)],
        programId,
      );
      const [satEpoch] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_EPOCH_SEED), encodeU64(params.epochId)],
        programId,
      );
      return [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: miningPool, isSigner: false, isWritable: false },
        { pubkey: satEpoch, isSigner: false, isWritable: true },
      ];
    },
  });
}

export async function submitSatTopUpRegistryReserve(
  _config: SatMiningConfig,
  params: { targetBalanceLamports: number },
) {
  const cfg = loadConfigForSatRuntime(_config);
  const targetBalanceLamports = Math.max(0, Math.floor(params.targetBalanceLamports));
  if (!Number.isSafeInteger(targetBalanceLamports)) {
    throw new Error("registry reserve target must be a safe integer lamport amount");
  }
  const profile = resolveSatGenesisProfileContract(_config.network);
  if (BigInt(targetBalanceLamports) > profile.registryReserveMaxLamports) {
    throw new Error(
      `registry reserve target exceeds ${profile.cluster} genesis maximum ${profile.registryReserveMaxLamports}`,
    );
  }
  return submitInstruction({
    cfg,
    env: process.env,
    data: buildTopUpRegistryReserveData({
      targetBalanceLamports,
    }),
    accountResolver: async (solana, signer) => {
      const programId = new solana.PublicKey(SAT_PROGRAM_ID());
      const [satRegistryReserve] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_REGISTRY_RESERVE_SEED)],
        programId,
      );
      return [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: satRegistryReserve, isSigner: false, isWritable: true },
        { pubkey: solana.SystemProgram.programId, isSigner: false, isWritable: false },
      ];
    },
  });
}

export async function submitSatOpenCycle(_config: SatMiningConfig, params: { cycleId: number }) {
  const cfg = loadConfigForSatRuntime(_config);
  return submitInstruction({
    cfg,
    env: process.env,
    data: buildOpenCycleData(params),
    accountResolver: async (solana, signer) => {
      const programId = new solana.PublicKey(SAT_PROGRAM_ID());
      const [satGlobalState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_GLOBAL_STATE_SEED)],
        programId,
      );
      const [satCycleState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_CYCLE_STATE_SEED), encodeU64(params.cycleId)],
        programId,
      );
      const [satCycleRegistryMeta] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_CYCLE_REGISTRY_META_SEED), encodeU64(params.cycleId)],
        programId,
      );
      const [satTreasuryState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_TREASURY_STATE_SEED)],
        programId,
      );
      const [satRegistryReserve] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_REGISTRY_RESERVE_SEED)],
        programId,
      );
      const [satTreasuryVault] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_TREASURY_VAULT_SEED)],
        programId,
      );
      return [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: satGlobalState, isSigner: false, isWritable: true },
        { pubkey: satCycleState, isSigner: false, isWritable: true },
        { pubkey: satCycleRegistryMeta, isSigner: false, isWritable: true },
        { pubkey: satTreasuryState, isSigner: false, isWritable: true },
        { pubkey: satRegistryReserve, isSigner: false, isWritable: true },
        { pubkey: solana.SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: satTreasuryVault, isSigner: false, isWritable: true },
      ];
    },
  });
}

export async function submitSatInitMinerCapital(
  _config: SatMiningConfig,
  params: { authority?: string },
) {
  const cfg = loadConfigForSatRuntime(_config);
  const effectiveEnv = resolveSatEffectiveEnv(cfg, process.env);
  const authority =
    params.authority?.trim() ||
    (await resolveSatLocalSignerAddress(
      cfg,
      effectiveEnv,
      "local-socket-signer returned no Solana address for SAT miner capital authority",
    ));
  return submitInstruction({
    cfg,
    env: effectiveEnv,
    data: buildInitMinerCapitalData({ authority }),
    accountResolver: async (solana, signer) => {
      const programId = new solana.PublicKey(SAT_PROGRAM_ID());
      const authorityKey = new solana.PublicKey(authority);
      const [satMinerCapitalState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_MINER_CAPITAL_STATE_SEED), authorityKey.toBuffer()],
        programId,
      );
      return [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: satMinerCapitalState, isSigner: false, isWritable: true },
        { pubkey: solana.SystemProgram.programId, isSigner: false, isWritable: false },
      ];
    },
  });
}

export async function submitSatDepositMinerCapital(
  _config: SatMiningConfig,
  params: { lamports: number },
) {
  const cfg = loadConfigForSatRuntime(_config);
  return submitInstruction({
    cfg,
    env: process.env,
    data: buildDepositMinerCapitalData(params),
    accountResolver: async (solana, signer) => {
      const programId = new solana.PublicKey(SAT_PROGRAM_ID());
      const [satMinerCapitalState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_MINER_CAPITAL_STATE_SEED), signer.toBuffer()],
        programId,
      );
      return [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: satMinerCapitalState, isSigner: false, isWritable: true },
        { pubkey: solana.SystemProgram.programId, isSigner: false, isWritable: false },
      ];
    },
  });
}

export async function submitSatWithdrawMinerCapital(
  _config: SatMiningConfig,
  params: { lamports: number },
) {
  const cfg = loadConfigForSatRuntime(_config);
  return submitInstruction({
    cfg,
    env: process.env,
    data: buildWithdrawMinerCapitalData(params),
    accountResolver: async (solana, signer) => {
      const programId = new solana.PublicKey(SAT_PROGRAM_ID());
      const [satMinerCapitalState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_MINER_CAPITAL_STATE_SEED), signer.toBuffer()],
        programId,
      );
      return [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: satMinerCapitalState, isSigner: false, isWritable: true },
        { pubkey: solana.SystemProgram.programId, isSigner: false, isWritable: false },
      ];
    },
  });
}

export async function submitSatSetActiveCommit(
  _config: SatMiningConfig,
  params: { lamports: number },
) {
  const cfg = loadConfigForSatRuntime(_config);
  return submitInstruction({
    cfg,
    env: process.env,
    data: buildSetActiveCommitData(params),
    accountResolver: async (solana, signer) => {
      const programId = new solana.PublicKey(SAT_PROGRAM_ID());
      const [satMinerCapitalState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_MINER_CAPITAL_STATE_SEED), signer.toBuffer()],
        programId,
      );
      return [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: satMinerCapitalState, isSigner: false, isWritable: true },
      ];
    },
  });
}

function resolveSatBondAccounts(
  solana: SolanaModuleLike,
  signer: import("@solana/web3.js").PublicKey,
  env: NodeJS.ProcessEnv = process.env,
) {
  const programId = new solana.PublicKey(resolveSatBondProgramIdFromEnv(env));
  const mint = new solana.PublicKey(SAT_MINT_ADDRESS());
  const [bondPosition] = solana.PublicKey.findProgramAddressSync(
    [Buffer.from(SAT_BOND_POSITION_SEED), signer.toBuffer()],
    programId,
  );
  const [bondTierPolicy] = solana.PublicKey.findProgramAddressSync(
    [Buffer.from(SAT_BOND_TIER_POLICY_SEED)],
    programId,
  );
  const [bondStakingDistributor] = solana.PublicKey.findProgramAddressSync(
    [Buffer.from(SAT_BOND_STAKING_DISTRIBUTOR_SEED)],
    programId,
  );
  const [bondStakingPosition] = solana.PublicKey.findProgramAddressSync(
    [Buffer.from(SAT_BOND_STAKING_POSITION_SEED), signer.toBuffer()],
    programId,
  );
  const signerTokenAccount = deriveAssociatedTokenAddress(solana, signer, mint);
  const bondVault = deriveAssociatedTokenAddress(solana, bondPosition, mint);
  const bondStakingRewardVault = deriveAssociatedTokenAddress(solana, bondStakingDistributor, mint);
  return {
    bondProgramId: programId,
    bondTierPolicy,
    bondPosition,
    bondStakingDistributor,
    bondStakingPosition,
    signerTokenAccount,
    bondVault,
    bondStakingRewardVault,
    mint,
    dedicated: hasDedicatedBondProgram(env),
  };
}

export async function submitSatUpdateBondTierPolicy(
  _config: SatMiningConfig,
  params: {
    updateAuthority?: string;
    basicMinRaw: number;
    operatorMinRaw: number;
    unlockDelaySlots: number;
    scheduledEffectiveSlot?: number;
  },
) {
  const cfg = loadConfigForSatRuntime(_config);
  const effectiveEnv = resolveSatEffectiveEnv(cfg, process.env);
  if (!hasDedicatedBondProgram(effectiveEnv)) {
    throw new Error("SAT bond tier policy update requires FASED_SAT_BOND_PROGRAM_ID");
  }
  const defaultUpdateAuthority = await resolveSatLocalSignerAddress(
    cfg,
    effectiveEnv,
    "local-socket-signer returned no Solana address for SAT bond policy authority",
  );
  return submitInstruction({
    cfg,
    env: effectiveEnv,
    data: buildUpdateBondTierPolicyData({
      ...params,
      updateAuthority: params.updateAuthority ?? defaultUpdateAuthority,
    }),
    programId: resolveSatBondProgramIdFromEnv(effectiveEnv),
    accountResolver: async (solana, signer) => {
      const { bondTierPolicy } = resolveSatBondAccounts(solana, signer, effectiveEnv);
      return [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: bondTierPolicy, isSigner: false, isWritable: true },
      ];
    },
  });
}

export async function submitSatOpenBondPosition(
  _config: SatMiningConfig,
  params: { amountRaw: number },
) {
  const cfg = loadConfigForSatRuntime(_config);
  const effectiveEnv = resolveSatEffectiveEnv(cfg, process.env);
  assertDedicatedBondProgram(effectiveEnv);
  return submitInstruction({
    cfg,
    env: effectiveEnv,
    data: buildOpenBondPositionData(params, effectiveEnv),
    programId: resolveSatBondProgramIdFromEnv(effectiveEnv),
    accountResolver: async (solana, signer) => {
      const { bondTierPolicy, bondPosition, signerTokenAccount, bondVault, mint } =
        resolveSatBondAccounts(solana, signer, effectiveEnv);
      const accounts = [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: bondTierPolicy, isSigner: false, isWritable: false },
      ];
      accounts.push(
        { pubkey: bondPosition, isSigner: false, isWritable: true },
        { pubkey: signerTokenAccount, isSigner: false, isWritable: true },
        { pubkey: bondVault, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: true },
        { pubkey: solana.SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: new solana.PublicKey(TOKEN_PROGRAM_ID), isSigner: false, isWritable: false },
        {
          pubkey: new solana.PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
          isSigner: false,
          isWritable: false,
        },
      );
      return accounts;
    },
  });
}

export async function submitSatIncreaseBondPosition(
  _config: SatMiningConfig,
  params: { amountRaw: number },
) {
  const cfg = loadConfigForSatRuntime(_config);
  const effectiveEnv = resolveSatEffectiveEnv(cfg, process.env);
  assertDedicatedBondProgram(effectiveEnv);
  return submitInstruction({
    cfg,
    env: effectiveEnv,
    data: buildIncreaseBondPositionData(params, effectiveEnv),
    programId: resolveSatBondProgramIdFromEnv(effectiveEnv),
    accountResolver: async (solana, signer) => {
      const { bondTierPolicy, bondPosition, signerTokenAccount, bondVault, mint } =
        resolveSatBondAccounts(solana, signer, effectiveEnv);
      const accounts = [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: bondTierPolicy, isSigner: false, isWritable: false },
      ];
      accounts.push(
        { pubkey: bondPosition, isSigner: false, isWritable: true },
        { pubkey: signerTokenAccount, isSigner: false, isWritable: true },
        { pubkey: bondVault, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: true },
        { pubkey: solana.SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: new solana.PublicKey(TOKEN_PROGRAM_ID), isSigner: false, isWritable: false },
        {
          pubkey: new solana.PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
          isSigner: false,
          isWritable: false,
        },
      );
      return accounts;
    },
  });
}

export async function submitSatRequestBondUnlock(_config: SatMiningConfig) {
  const cfg = loadConfigForSatRuntime(_config);
  const effectiveEnv = resolveSatEffectiveEnv(cfg, process.env);
  assertDedicatedBondProgram(effectiveEnv);
  return submitInstruction({
    cfg,
    env: effectiveEnv,
    data: buildRequestBondUnlockData(effectiveEnv),
    programId: resolveSatBondProgramIdFromEnv(effectiveEnv),
    accountResolver: async (solana, signer) => {
      const { bondTierPolicy, bondPosition, bondStakingDistributor, bondStakingPosition } =
        resolveSatBondAccounts(solana, signer, effectiveEnv);
      const accounts = [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: bondTierPolicy, isSigner: false, isWritable: false },
      ];
      accounts.push(
        { pubkey: bondPosition, isSigner: false, isWritable: true },
        { pubkey: bondStakingDistributor, isSigner: false, isWritable: true },
        { pubkey: bondStakingPosition, isSigner: false, isWritable: true },
      );
      return accounts;
    },
  });
}

export async function submitSatCancelBondUnlock(_config: SatMiningConfig) {
  const cfg = loadConfigForSatRuntime(_config);
  const effectiveEnv = resolveSatEffectiveEnv(cfg, process.env);
  assertDedicatedBondProgram(effectiveEnv);
  return submitInstruction({
    cfg,
    env: effectiveEnv,
    data: buildCancelBondUnlockData(effectiveEnv),
    programId: resolveSatBondProgramIdFromEnv(effectiveEnv),
    accountResolver: async (solana, signer) => {
      const { bondTierPolicy, bondPosition, bondStakingDistributor, bondStakingPosition } =
        resolveSatBondAccounts(solana, signer, effectiveEnv);
      const accounts = [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: bondTierPolicy, isSigner: false, isWritable: false },
      ];
      accounts.push(
        { pubkey: bondPosition, isSigner: false, isWritable: true },
        { pubkey: bondStakingDistributor, isSigner: false, isWritable: true },
        { pubkey: bondStakingPosition, isSigner: false, isWritable: true },
      );
      return accounts;
    },
  });
}

export async function submitSatFinalizeBondUnlock(_config: SatMiningConfig) {
  const cfg = loadConfigForSatRuntime(_config);
  const effectiveEnv = resolveSatEffectiveEnv(cfg, process.env);
  assertDedicatedBondProgram(effectiveEnv);
  return submitInstruction({
    cfg,
    env: effectiveEnv,
    data: buildFinalizeBondUnlockData(effectiveEnv),
    programId: resolveSatBondProgramIdFromEnv(effectiveEnv),
    accountResolver: async (solana, signer) => {
      const {
        bondTierPolicy,
        bondPosition,
        bondStakingDistributor,
        bondStakingPosition,
        signerTokenAccount,
        bondVault,
        mint,
      } = resolveSatBondAccounts(solana, signer, effectiveEnv);
      const accounts = [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: bondTierPolicy, isSigner: false, isWritable: false },
      ];
      accounts.push(
        { pubkey: bondPosition, isSigner: false, isWritable: true },
        { pubkey: bondStakingDistributor, isSigner: false, isWritable: true },
        { pubkey: bondStakingPosition, isSigner: false, isWritable: true },
        { pubkey: bondVault, isSigner: false, isWritable: true },
        { pubkey: signerTokenAccount, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: true },
        { pubkey: solana.SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: new solana.PublicKey(TOKEN_PROGRAM_ID), isSigner: false, isWritable: false },
        {
          pubkey: new solana.PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
          isSigner: false,
          isWritable: false,
        },
      );
      return accounts;
    },
  });
}

export async function submitSatSyncBondStakingRewards(_config: SatMiningConfig) {
  const cfg = loadConfigForSatRuntime(_config);
  const effectiveEnv = resolveSatEffectiveEnv(cfg, process.env);
  assertDedicatedBondProgram(effectiveEnv);
  return submitInstruction({
    cfg,
    env: effectiveEnv,
    data: buildSyncBondStakingRewardsData(effectiveEnv),
    programId: resolveSatBondProgramIdFromEnv(effectiveEnv),
    accountResolver: async (solana, signer) => {
      const { bondStakingDistributor, bondStakingRewardVault, mint } = resolveSatBondAccounts(
        solana,
        signer,
        effectiveEnv,
      );
      return [
        { pubkey: bondStakingDistributor, isSigner: false, isWritable: true },
        { pubkey: bondStakingRewardVault, isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
      ];
    },
  });
}

export async function submitSatSyncBondStakingPosition(_config: SatMiningConfig) {
  const cfg = loadConfigForSatRuntime(_config);
  const effectiveEnv = resolveSatEffectiveEnv(cfg, process.env);
  assertDedicatedBondProgram(effectiveEnv);
  return submitInstruction({
    cfg,
    env: effectiveEnv,
    data: buildSyncBondStakingPositionData(effectiveEnv),
    programId: resolveSatBondProgramIdFromEnv(effectiveEnv),
    accountResolver: async (solana, signer) => {
      const { bondTierPolicy, bondStakingDistributor, bondStakingPosition, bondPosition } =
        resolveSatBondAccounts(solana, signer, effectiveEnv);
      return [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: bondTierPolicy, isSigner: false, isWritable: false },
        { pubkey: bondStakingDistributor, isSigner: false, isWritable: true },
        { pubkey: bondStakingPosition, isSigner: false, isWritable: true },
        { pubkey: bondPosition, isSigner: false, isWritable: false },
        { pubkey: solana.SystemProgram.programId, isSigner: false, isWritable: false },
      ];
    },
  });
}

export async function submitSatClaimBondStakingRewards(_config: SatMiningConfig) {
  const cfg = loadConfigForSatRuntime(_config);
  const effectiveEnv = resolveSatEffectiveEnv(cfg, process.env);
  assertDedicatedBondProgram(effectiveEnv);
  return submitInstruction({
    cfg,
    env: effectiveEnv,
    data: buildClaimBondStakingRewardsData(effectiveEnv),
    programId: resolveSatBondProgramIdFromEnv(effectiveEnv),
    accountResolver: async (solana, signer) => {
      const {
        bondTierPolicy,
        bondStakingDistributor,
        bondStakingPosition,
        bondPosition,
        bondStakingRewardVault,
        signerTokenAccount,
        mint,
      } = resolveSatBondAccounts(solana, signer, effectiveEnv);
      return [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: bondTierPolicy, isSigner: false, isWritable: false },
        { pubkey: bondStakingDistributor, isSigner: false, isWritable: true },
        { pubkey: bondStakingPosition, isSigner: false, isWritable: true },
        { pubkey: bondPosition, isSigner: false, isWritable: false },
        { pubkey: bondStakingRewardVault, isSigner: false, isWritable: true },
        { pubkey: signerTokenAccount, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: true },
        { pubkey: solana.SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: new solana.PublicKey(TOKEN_PROGRAM_ID), isSigner: false, isWritable: false },
        {
          pubkey: new solana.PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
          isSigner: false,
          isWritable: false,
        },
      ];
    },
  });
}

export async function submitSatClaimUnallocatedStakingRewards(
  _config: SatMiningConfig,
  params: { recipientOwner: string },
) {
  const cfg = loadConfigForSatRuntime(_config);
  const effectiveEnv = resolveSatEffectiveEnv(cfg, process.env);
  assertDedicatedBondProgram(effectiveEnv);
  return submitInstruction({
    cfg,
    env: effectiveEnv,
    data: buildClaimUnallocatedStakingRewardsData(effectiveEnv),
    programId: resolveSatBondProgramIdFromEnv(effectiveEnv),
    accountResolver: async (solana, signer) => {
      const { bondStakingDistributor, bondStakingRewardVault, mint } = resolveSatBondAccounts(
        solana,
        signer,
        effectiveEnv,
      );
      const recipientOwner = new solana.PublicKey(params.recipientOwner);
      const recipientTokenAccount = deriveAssociatedTokenAddress(solana, recipientOwner, mint);
      return [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: bondStakingDistributor, isSigner: false, isWritable: true },
        { pubkey: bondStakingRewardVault, isSigner: false, isWritable: true },
        { pubkey: recipientTokenAccount, isSigner: false, isWritable: true },
        { pubkey: recipientOwner, isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: true },
        { pubkey: solana.SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: new solana.PublicKey(TOKEN_PROGRAM_ID), isSigner: false, isWritable: false },
        {
          pubkey: new solana.PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
          isSigner: false,
          isWritable: false,
        },
      ];
    },
  });
}

export async function submitSatCommitCycle(
  _config: SatMiningConfig,
  params: { cycleId: number; commitmentHex: string },
) {
  const cfg = loadConfigForSatRuntime(_config);
  const commitment = Buffer.from(params.commitmentHex, "hex");
  return submitInstruction({
    cfg,
    env: process.env,
    data: buildCommitCycleData({ cycleId: params.cycleId, commitment }),
    accountResolver: async (solana, signer) => {
      const programId = new solana.PublicKey(SAT_PROGRAM_ID());
      const [satCycleState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_CYCLE_STATE_SEED), encodeU64(params.cycleId)],
        programId,
      );
      const [satMinerCycleState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_MINER_CYCLE_STATE_SEED), signer.toBuffer(), encodeU64(params.cycleId)],
        programId,
      );
      const [satMinerCapitalState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_MINER_CAPITAL_STATE_SEED), signer.toBuffer()],
        programId,
      );
      return [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: satCycleState, isSigner: false, isWritable: true },
        { pubkey: satMinerCycleState, isSigner: false, isWritable: true },
        { pubkey: satMinerCapitalState, isSigner: false, isWritable: true },
        { pubkey: solana.SystemProgram.programId, isSigner: false, isWritable: false },
      ];
    },
  });
}

async function submitSatCyclePhaseInstruction(
  _config: SatMiningConfig,
  params: { cycleId: number; phase: "close" | "seal"; intervalStartCycleId?: number },
) {
  const cfg = loadConfigForSatRuntime(_config);
  return submitInstruction({
    cfg,
    env: process.env,
    data:
      params.phase === "close"
        ? buildCloseCommitPhaseData(params)
        : buildSealCycleEntropyData(params),
    accountResolver: async (solana, signer) => {
      const programId = new solana.PublicKey(SAT_PROGRAM_ID());
      const [satCycleState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_CYCLE_STATE_SEED), encodeU64(params.cycleId)],
        programId,
      );
      const accounts = [
        { pubkey: signer, isSigner: true, isWritable: false },
        { pubkey: satCycleState, isSigner: false, isWritable: true },
      ];
      let intervalStartCycleIdForSigner: number | undefined;
      if (params.phase === "seal") {
        const cycle =
          params.intervalStartCycleId == null
            ? await inspectSatCycle(_config, { cycleId: params.cycleId })
            : null;
        const intervalStartCycleId =
          params.intervalStartCycleId ?? cycle?.unlockIntervalStartCycleId;
        if (intervalStartCycleId == null || !Number.isSafeInteger(intervalStartCycleId)) {
          throw new Error(`SAT cycle ${params.cycleId} does not expose its unlock interval start`);
        }
        intervalStartCycleIdForSigner = intervalStartCycleId;
        const [satUnlockIntervalState] = solana.PublicKey.findProgramAddressSync(
          [Buffer.from(SAT_UNLOCK_INTERVAL_STATE_SEED), encodeU64(intervalStartCycleId)],
          programId,
        );
        accounts.push({
          pubkey: satUnlockIntervalState,
          isSigner: false,
          isWritable: true,
        });
        accounts.push({
          pubkey: new solana.PublicKey(SLOT_HASHES_SYSVAR_ID),
          isSigner: false,
          isWritable: false,
        });
      }
      return {
        keys: accounts,
        ...(intervalStartCycleIdForSigner == null
          ? {}
          : { context: { intervalStartCycleId: String(intervalStartCycleIdForSigner) } }),
      };
    },
  });
}

export async function submitSatCloseCommitPhase(
  _config: SatMiningConfig,
  params: { cycleId: number },
) {
  return submitSatCyclePhaseInstruction(_config, { ...params, phase: "close" });
}

export async function submitSatSealCycleEntropy(
  _config: SatMiningConfig,
  params: { cycleId: number; intervalStartCycleId?: number },
) {
  return submitSatCyclePhaseInstruction(_config, { ...params, phase: "seal" });
}

export async function submitSatReleaseUnrevealedCommit(
  _config: SatMiningConfig,
  params: { cycleId: number; minerAuthority: string },
) {
  const cfg = loadConfigForSatRuntime(_config);
  return submitInstruction({
    cfg,
    env: process.env,
    data: buildReleaseUnrevealedCommitData(params),
    accountResolver: async (solana, signer) => {
      const programId = new solana.PublicKey(SAT_PROGRAM_ID());
      const minerAuthority = new solana.PublicKey(params.minerAuthority);
      const [satCycleState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_CYCLE_STATE_SEED), encodeU64(params.cycleId)],
        programId,
      );
      const [satMinerCycleState] = solana.PublicKey.findProgramAddressSync(
        [
          Buffer.from(SAT_MINER_CYCLE_STATE_SEED),
          minerAuthority.toBuffer(),
          encodeU64(params.cycleId),
        ],
        programId,
      );
      const [satMinerCapitalState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_MINER_CAPITAL_STATE_SEED), minerAuthority.toBuffer()],
        programId,
      );
      const [satTreasuryState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_TREASURY_STATE_SEED)],
        programId,
      );
      const [satTreasuryVault] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_TREASURY_VAULT_SEED)],
        programId,
      );
      return [
        { pubkey: signer, isSigner: true, isWritable: false },
        { pubkey: satCycleState, isSigner: false, isWritable: true },
        { pubkey: satMinerCycleState, isSigner: false, isWritable: true },
        { pubkey: satMinerCapitalState, isSigner: false, isWritable: true },
        { pubkey: satTreasuryState, isSigner: false, isWritable: true },
        { pubkey: satTreasuryVault, isSigner: false, isWritable: true },
      ];
    },
  });
}

export async function submitSatAbortEmptyCycle(
  _config: SatMiningConfig,
  params: { cycleId: number },
) {
  const cfg = loadConfigForSatRuntime(_config);
  return submitInstruction({
    cfg,
    env: process.env,
    data: buildAbortEmptyCycleData(params),
    accountResolver: async (solana, signer) => {
      const programId = new solana.PublicKey(SAT_PROGRAM_ID());
      const [satCycleState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_CYCLE_STATE_SEED), encodeU64(params.cycleId)],
        programId,
      );
      const [satCycleRegistryMeta] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_CYCLE_REGISTRY_META_SEED), encodeU64(params.cycleId)],
        programId,
      );
      return [
        { pubkey: signer, isSigner: true, isWritable: false },
        { pubkey: satCycleState, isSigner: false, isWritable: true },
        { pubkey: satCycleRegistryMeta, isSigner: false, isWritable: true },
      ];
    },
  });
}

export async function submitSatRevealCycle(
  _config: SatMiningConfig,
  params: {
    cycleId: number;
    intervalStartCycleId?: number;
    nonceBase64: string;
    allocationFp: number[];
  },
) {
  const cfg = loadConfigForSatRuntime(_config);
  const nonce = Buffer.from(params.nonceBase64, "base64");
  return submitInstruction({
    cfg,
    env: process.env,
    data: buildRevealCycleData({ ...params, nonce }),
    accountResolver: async (solana, signer) => {
      const programId = new solana.PublicKey(SAT_PROGRAM_ID());
      const pageIndex = await resolveSatCycleRegistryPageIndex(_config, params.cycleId);
      const cycle =
        params.intervalStartCycleId == null
          ? await inspectSatCycle(_config, { cycleId: params.cycleId })
          : null;
      const intervalStartCycleId = params.intervalStartCycleId ?? cycle?.unlockIntervalStartCycleId;
      if (intervalStartCycleId == null || !Number.isSafeInteger(intervalStartCycleId)) {
        throw new Error(`SAT cycle ${params.cycleId} does not expose its unlock interval start`);
      }
      const [satCycleState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_CYCLE_STATE_SEED), encodeU64(params.cycleId)],
        programId,
      );
      const [satCycleRegistryMeta] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_CYCLE_REGISTRY_META_SEED), encodeU64(params.cycleId)],
        programId,
      );
      const [satCycleRegistryPage] = solana.PublicKey.findProgramAddressSync(
        [
          Buffer.from(SAT_CYCLE_REGISTRY_PAGE_SEED),
          encodeU64(params.cycleId),
          encodeU64(pageIndex),
        ],
        programId,
      );
      const [satCycleSettlementProgress] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from("sat_cycle_settlement_progress_v2"), encodeU64(params.cycleId)],
        programId,
      );
      const [satMinerCycleState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_MINER_CYCLE_STATE_SEED), signer.toBuffer(), encodeU64(params.cycleId)],
        programId,
      );
      const [satMinerCapitalState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_MINER_CAPITAL_STATE_SEED), signer.toBuffer()],
        programId,
      );
      const [satUnlockIntervalState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_UNLOCK_INTERVAL_STATE_SEED), encodeU64(intervalStartCycleId)],
        programId,
      );
      const [satRegistryReserve] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_REGISTRY_RESERVE_SEED)],
        programId,
      );
      return {
        keys: [
          { pubkey: signer, isSigner: true, isWritable: true },
          { pubkey: satCycleState, isSigner: false, isWritable: true },
          { pubkey: satCycleRegistryMeta, isSigner: false, isWritable: true },
          { pubkey: satCycleRegistryPage, isSigner: false, isWritable: true },
          { pubkey: satCycleSettlementProgress, isSigner: false, isWritable: true },
          { pubkey: satMinerCycleState, isSigner: false, isWritable: true },
          { pubkey: satMinerCapitalState, isSigner: false, isWritable: true },
          { pubkey: satUnlockIntervalState, isSigner: false, isWritable: true },
          { pubkey: satRegistryReserve, isSigner: false, isWritable: true },
          { pubkey: solana.SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        context: {
          intervalStartCycleId: String(intervalStartCycleId),
          registryPageIndex: String(pageIndex),
        },
      };
    },
  });
}

export async function submitSatSettleCyclePage(
  _config: SatMiningConfig,
  params: { cycleId: number; pageIndex: number; chunkIndex: number; minerCycleAccounts?: string[] },
) {
  const cfg = loadConfigForSatRuntime(_config);
  return submitInstruction({
    cfg,
    env: process.env,
    data: buildSettleCyclePageData(params),
    accountResolver: async (solana, signer) => {
      const programId = new solana.PublicKey(SAT_PROGRAM_ID());
      const [satGlobalState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_GLOBAL_STATE_SEED)],
        programId,
      );
      const [satCycleState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_CYCLE_STATE_SEED), encodeU64(params.cycleId)],
        programId,
      );
      const [satCycleRegistryMeta] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_CYCLE_REGISTRY_META_SEED), encodeU64(params.cycleId)],
        programId,
      );
      const [satCycleRegistryPage] = solana.PublicKey.findProgramAddressSync(
        [
          Buffer.from(SAT_CYCLE_REGISTRY_PAGE_SEED),
          encodeU64(params.cycleId),
          encodeU64(params.pageIndex),
        ],
        programId,
      );
      const [satCycleSettlementProgress] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from("sat_cycle_settlement_progress_v2"), encodeU64(params.cycleId)],
        programId,
      );
      const [satRegistryReserve] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_REGISTRY_RESERVE_SEED)],
        programId,
      );
      const [satTreasuryState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_TREASURY_STATE_SEED)],
        programId,
      );
      const [satSignerMinerCycleState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_MINER_CYCLE_STATE_SEED), signer.toBuffer(), encodeU64(params.cycleId)],
        programId,
      );
      const [satSignerMinerCapitalState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_MINER_CAPITAL_STATE_SEED), signer.toBuffer()],
        programId,
      );
      const [satRebateVault] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_REBATE_VAULT_SEED)],
        programId,
      );
      const accounts = [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: satGlobalState, isSigner: false, isWritable: false },
        { pubkey: satCycleState, isSigner: false, isWritable: true },
        { pubkey: satCycleRegistryMeta, isSigner: false, isWritable: false },
        { pubkey: satCycleRegistryPage, isSigner: false, isWritable: false },
        { pubkey: satCycleSettlementProgress, isSigner: false, isWritable: true },
        { pubkey: satRegistryReserve, isSigner: false, isWritable: true },
        { pubkey: satTreasuryState, isSigner: false, isWritable: true },
        { pubkey: solana.SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: satSignerMinerCycleState, isSigner: false, isWritable: false },
        { pubkey: satSignerMinerCapitalState, isSigner: false, isWritable: true },
        { pubkey: satRebateVault, isSigner: false, isWritable: true },
      ];
      for (const minerCycleAccount of params.minerCycleAccounts ?? []) {
        accounts.push({
          pubkey: new solana.PublicKey(minerCycleAccount),
          isSigner: false,
          isWritable: true,
        });
      }
      const minerCycleAddresses = params.minerCycleAccounts ?? [];
      const minerCycles =
        minerCycleAddresses.length > 0
          ? await inspectSatMinerCyclesByAddress(_config, {
              addresses: minerCycleAddresses,
            })
          : [];
      const minerAuthorities = minerCycles.map((entry, index) => {
        const authority = String(entry?.authority ?? "").trim();
        if (!authority) {
          throw new Error(
            `SAT settleCyclePage could not resolve miner authority for ${minerCycleAddresses[index]}`,
          );
        }
        return authority;
      });
      if (minerAuthorities.length !== minerCycleAddresses.length) {
        throw new Error("SAT settleCyclePage miner authority count mismatch");
      }
      return {
        keys: accounts,
        ...(minerAuthorities.length > 0 ? { context: { minerAuthorities } } : {}),
      };
    },
  });
}

export async function submitSatFinalizeCycleSettlement(
  _config: SatMiningConfig,
  params: { cycleId: number; pageCount: number },
) {
  const cfg = loadConfigForSatRuntime(_config);
  return submitInstruction({
    cfg,
    env: process.env,
    data: buildFinalizeCycleSettlementData(params),
    accountResolver: async (solana, signer) => {
      const programId = new solana.PublicKey(SAT_PROGRAM_ID());
      const [satGlobalState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_GLOBAL_STATE_SEED)],
        programId,
      );
      const [satCycleState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_CYCLE_STATE_SEED), encodeU64(params.cycleId)],
        programId,
      );
      const [satCycleSettlementProgress] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from("sat_cycle_settlement_progress_v2"), encodeU64(params.cycleId)],
        programId,
      );
      const [satCycleRegistryMeta] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_CYCLE_REGISTRY_META_SEED), encodeU64(params.cycleId)],
        programId,
      );
      const [satTreasuryState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_TREASURY_STATE_SEED)],
        programId,
      );
      const [satSignerMinerCycleState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_MINER_CYCLE_STATE_SEED), signer.toBuffer(), encodeU64(params.cycleId)],
        programId,
      );
      const [satSignerMinerCapitalState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_MINER_CAPITAL_STATE_SEED), signer.toBuffer()],
        programId,
      );
      const [satRebateVault] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_REBATE_VAULT_SEED)],
        programId,
      );
      const accounts = [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: satGlobalState, isSigner: false, isWritable: true },
        { pubkey: satCycleState, isSigner: false, isWritable: true },
        { pubkey: satCycleSettlementProgress, isSigner: false, isWritable: true },
        { pubkey: satCycleRegistryMeta, isSigner: false, isWritable: true },
        { pubkey: satTreasuryState, isSigner: false, isWritable: true },
        { pubkey: satSignerMinerCycleState, isSigner: false, isWritable: false },
        { pubkey: satSignerMinerCapitalState, isSigner: false, isWritable: true },
        { pubkey: satRebateVault, isSigner: false, isWritable: true },
      ];
      for (let pageIndex = 0; pageIndex < params.pageCount; pageIndex += 1) {
        const [satCycleRegistryPage] = solana.PublicKey.findProgramAddressSync(
          [
            Buffer.from(SAT_CYCLE_REGISTRY_PAGE_SEED),
            encodeU64(params.cycleId),
            encodeU64(pageIndex),
          ],
          programId,
        );
        accounts.push({ pubkey: satCycleRegistryPage, isSigner: false, isWritable: false });
      }
      return accounts;
    },
  });
}

export async function submitSatScoreCyclePage(
  _config: SatMiningConfig,
  params: { cycleId: number; pageIndex: number; chunkIndex: number; minerCycleAccounts?: string[] },
) {
  const cfg = loadConfigForSatRuntime(_config);
  return submitInstruction({
    cfg,
    env: process.env,
    data: buildScoreCyclePageData(params),
    accountResolver: async (solana, signer) => {
      const programId = new solana.PublicKey(SAT_PROGRAM_ID());
      const [satGlobalState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_GLOBAL_STATE_SEED)],
        programId,
      );
      const [satCycleState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_CYCLE_STATE_SEED), encodeU64(params.cycleId)],
        programId,
      );
      const [satCycleRegistryPage] = solana.PublicKey.findProgramAddressSync(
        [
          Buffer.from(SAT_CYCLE_REGISTRY_PAGE_SEED),
          encodeU64(params.cycleId),
          encodeU64(params.pageIndex),
        ],
        programId,
      );
      const [satCycleSettlementProgress] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from("sat_cycle_settlement_progress_v2"), encodeU64(params.cycleId)],
        programId,
      );
      const [satTreasuryState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_TREASURY_STATE_SEED)],
        programId,
      );
      const [satSignerMinerCycleState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_MINER_CYCLE_STATE_SEED), signer.toBuffer(), encodeU64(params.cycleId)],
        programId,
      );
      const [satSignerMinerCapitalState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_MINER_CAPITAL_STATE_SEED), signer.toBuffer()],
        programId,
      );
      const [satRebateVault] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_REBATE_VAULT_SEED)],
        programId,
      );
      const accounts = [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: satGlobalState, isSigner: false, isWritable: false },
        { pubkey: satCycleState, isSigner: false, isWritable: false },
        { pubkey: satCycleRegistryPage, isSigner: false, isWritable: false },
        { pubkey: satCycleSettlementProgress, isSigner: false, isWritable: true },
        { pubkey: satTreasuryState, isSigner: false, isWritable: true },
        { pubkey: satSignerMinerCycleState, isSigner: false, isWritable: false },
        { pubkey: satSignerMinerCapitalState, isSigner: false, isWritable: true },
        { pubkey: satRebateVault, isSigner: false, isWritable: true },
      ];
      for (const minerCycleAccount of params.minerCycleAccounts ?? []) {
        accounts.push({
          pubkey: new solana.PublicKey(minerCycleAccount),
          isSigner: false,
          isWritable: true,
        });
      }
      const minerCycleAddresses = params.minerCycleAccounts ?? [];
      const minerCycles =
        minerCycleAddresses.length > 0
          ? await inspectSatMinerCyclesByAddress(_config, {
              addresses: minerCycleAddresses,
            })
          : [];
      const minerAuthorities = minerCycles.map((entry, index) => {
        const authority = String(entry?.authority ?? "").trim();
        if (!authority) {
          throw new Error(
            `SAT scoreCyclePage could not resolve miner authority for ${minerCycleAddresses[index]}`,
          );
        }
        return authority;
      });
      if (minerAuthorities.length !== minerCycleAddresses.length) {
        throw new Error("SAT scoreCyclePage miner authority count mismatch");
      }
      return {
        keys: accounts,
        ...(minerAuthorities.length > 0 ? { context: { minerAuthorities } } : {}),
      };
    },
  });
}

export async function submitSatDistributeCyclePage(
  _config: SatMiningConfig,
  params: {
    cycleId: number;
    pageIndex: number;
    chunkIndex: number;
    minerCycleAccounts?: string[];
    lookupTableAddress?: string;
  },
) {
  const cfg = loadConfigForSatRuntime(_config);
  const lookupTableAddress = params.lookupTableAddress?.trim() ?? "";
  const requiresLookupTable =
    (params.minerCycleAccounts?.length ?? 0) >= SAT_DISTRIBUTION_LOOKUP_MIN_MINERS;
  return submitInstruction({
    cfg,
    env: process.env,
    data: buildDistributeCyclePageData(params),
    ...(lookupTableAddress || requiresLookupTable
      ? {
          manageAddressLookupTable: {
            ...(lookupTableAddress ? { lookupTableAddress } : {}),
          },
        }
      : {}),
    accountResolver: async (solana, signer) => {
      const programId = new solana.PublicKey(SAT_PROGRAM_ID());
      const [satCycleState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_CYCLE_STATE_SEED), encodeU64(params.cycleId)],
        programId,
      );
      const [satCycleRegistryPage] = solana.PublicKey.findProgramAddressSync(
        [
          Buffer.from(SAT_CYCLE_REGISTRY_PAGE_SEED),
          encodeU64(params.cycleId),
          encodeU64(params.pageIndex),
        ],
        programId,
      );
      const [satCycleSettlementProgress] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from("sat_cycle_settlement_progress_v2"), encodeU64(params.cycleId)],
        programId,
      );
      const [satGlobalState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_GLOBAL_STATE_SEED)],
        programId,
      );
      const [satTreasuryState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_TREASURY_STATE_SEED)],
        programId,
      );
      const [satSignerMinerCycleState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_MINER_CYCLE_STATE_SEED), signer.toBuffer(), encodeU64(params.cycleId)],
        programId,
      );
      const [satSignerMinerCapitalState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_MINER_CAPITAL_STATE_SEED), signer.toBuffer()],
        programId,
      );
      const [satRebateVault] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_REBATE_VAULT_SEED)],
        programId,
      );
      const [satTreasuryVault] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_TREASURY_VAULT_SEED)],
        programId,
      );
      const accounts = [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: satCycleState, isSigner: false, isWritable: true },
        { pubkey: satCycleRegistryPage, isSigner: false, isWritable: false },
        { pubkey: satCycleSettlementProgress, isSigner: false, isWritable: true },
        { pubkey: satGlobalState, isSigner: false, isWritable: false },
        { pubkey: satTreasuryState, isSigner: false, isWritable: true },
        { pubkey: satSignerMinerCycleState, isSigner: false, isWritable: false },
        { pubkey: satSignerMinerCapitalState, isSigner: false, isWritable: true },
        { pubkey: satRebateVault, isSigner: false, isWritable: true },
        { pubkey: satTreasuryVault, isSigner: false, isWritable: true },
      ];
      const minerCycleAccounts = params.minerCycleAccounts ?? [];
      const minerCycles =
        minerCycleAccounts.length > 0
          ? await inspectSatMinerCyclesByAddress(_config, {
              addresses: minerCycleAccounts,
            }).catch(() => [])
          : [];
      const minerAuthorities: string[] = [];
      for (const [index, minerCycleAccount] of minerCycleAccounts.entries()) {
        const satMinerCycleState = new solana.PublicKey(minerCycleAccount);
        const minerCycle = minerCycles[index] ?? null;
        const authorityKey = minerCycle?.authority
          ? new solana.PublicKey(minerCycle.authority)
          : null;
        if (!authorityKey) {
          throw new Error(
            `SAT distributeCyclePage could not resolve miner authority for ${minerCycleAccount}`,
          );
        }
        minerAuthorities.push(authorityKey.toBase58());
        const [satMinerCapitalState] = solana.PublicKey.findProgramAddressSync(
          [Buffer.from(SAT_MINER_CAPITAL_STATE_SEED), authorityKey.toBuffer()],
          programId,
        );
        accounts.push({ pubkey: satMinerCycleState, isSigner: false, isWritable: true });
        accounts.push({ pubkey: satMinerCapitalState, isSigner: false, isWritable: true });
      }
      return {
        keys: accounts,
        ...(minerAuthorities.length > 0 ? { context: { minerAuthorities } } : {}),
      };
    },
  });
}

export async function submitSatCleanupDistributionLookupTable(
  _config: SatMiningConfig,
  params: { lookupTableAddress: string; action: "deactivate" | "close" },
) {
  const cfg = loadConfigForSatRuntime(_config);
  const context = await prepareLocalSignerSubmitContext(cfg, process.env);
  assertSatLookupTableEnabled(context.effectiveEnv);
  if (!context.walletId) {
    throw new Error("typed SAT lookup-table cleanup requires an explicit mining walletId");
  }
  const lookupTable = params.lookupTableAddress.trim();
  if (!lookupTable) {
    throw new Error("SAT distribution lookup table address is required");
  }
  const submitted = await executeTypedSatLookupOperation({
    context: { ...context, walletId: context.walletId },
    cfg,
    action: params.action,
    address: lookupTable,
  });
  return {
    lookupTable,
    action: params.action,
    transactionHashes: [submitted.signature],
    signerState: submitted.state,
    requestId: submitted.requestId,
  };
}

export async function submitSatClaimCycleRewards(
  _config: SatMiningConfig,
  params: { cycleId: number },
) {
  const cfg = loadConfigForSatRuntime(_config);
  return submitInstruction({
    cfg,
    env: process.env,
    data: buildClaimCycleRewardsData(params),
    accountResolver: async (solana, signer) => {
      const programId = new solana.PublicKey(SAT_PROGRAM_ID());
      const [satGlobalState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_GLOBAL_STATE_SEED)],
        programId,
      );
      const [satCycleState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_CYCLE_STATE_SEED), encodeU64(params.cycleId)],
        programId,
      );
      const [satMinerCycleState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_MINER_CYCLE_STATE_SEED), signer.toBuffer(), encodeU64(params.cycleId)],
        programId,
      );
      const [satMinerCapitalState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_MINER_CAPITAL_STATE_SEED), signer.toBuffer()],
        programId,
      );
      const [treasury] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from("treasury")],
        programId,
      );
      const [satTreasuryState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_TREASURY_STATE_SEED)],
        programId,
      );
      const [satRebateVault] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_REBATE_VAULT_SEED)],
        programId,
      );
      const recipientAta = deriveAssociatedTokenAddress(
        solana,
        signer,
        new solana.PublicKey(SAT_MINT_ADDRESS()),
      );
      const [mintAuthority] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from("authority")],
        new solana.PublicKey(SAT_MINT_PROGRAM_ID()),
      );
      return [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: satGlobalState, isSigner: false, isWritable: true },
        { pubkey: satCycleState, isSigner: false, isWritable: true },
        { pubkey: satMinerCycleState, isSigner: false, isWritable: true },
        { pubkey: satMinerCapitalState, isSigner: false, isWritable: true },
        { pubkey: treasury, isSigner: false, isWritable: true },
        { pubkey: satTreasuryState, isSigner: false, isWritable: true },
        { pubkey: mintAuthority, isSigner: false, isWritable: true },
        { pubkey: new solana.PublicKey(SAT_MINT_ADDRESS()), isSigner: false, isWritable: true },
        { pubkey: recipientAta, isSigner: false, isWritable: true },
        { pubkey: solana.SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: new solana.PublicKey(TOKEN_PROGRAM_ID), isSigner: false, isWritable: false },
        {
          pubkey: new solana.PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
          isSigner: false,
          isWritable: false,
        },
        { pubkey: new solana.PublicKey(SAT_MINT_PROGRAM_ID()), isSigner: false, isWritable: false },
        { pubkey: satRebateVault, isSigner: false, isWritable: true },
      ];
    },
  });
}

export async function submitSatClaimCycleRewardsBatch(
  _config: SatMiningConfig,
  params: { cycleIds: number[] },
) {
  const cfg = loadConfigForSatRuntime(_config);
  return submitInstruction({
    cfg,
    env: process.env,
    data: buildClaimCycleRewardsBatchData(params),
    accountResolver: async (solana, signer) => {
      const programId = new solana.PublicKey(SAT_PROGRAM_ID());
      const [satGlobalState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_GLOBAL_STATE_SEED)],
        programId,
      );
      const [treasury] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from("treasury")],
        programId,
      );
      const [satTreasuryState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_TREASURY_STATE_SEED)],
        programId,
      );
      const [satMinerCapitalState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_MINER_CAPITAL_STATE_SEED), signer.toBuffer()],
        programId,
      );
      const [satRebateVault] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_REBATE_VAULT_SEED)],
        programId,
      );
      const mint = new solana.PublicKey(SAT_MINT_ADDRESS());
      const [mintAuthority] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from("authority")],
        new solana.PublicKey(SAT_MINT_PROGRAM_ID()),
      );
      const recipient = deriveAssociatedTokenAddress(solana, signer, mint);
      const accounts = [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: satGlobalState, isSigner: false, isWritable: false },
        { pubkey: treasury, isSigner: false, isWritable: true },
        { pubkey: satTreasuryState, isSigner: false, isWritable: true },
        { pubkey: satMinerCapitalState, isSigner: false, isWritable: true },
        { pubkey: mintAuthority, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: true },
        { pubkey: recipient, isSigner: false, isWritable: true },
      ];
      for (const cycleId of params.cycleIds) {
        const [satCycleState] = solana.PublicKey.findProgramAddressSync(
          [Buffer.from(SAT_CYCLE_STATE_SEED), encodeU64(cycleId)],
          programId,
        );
        const [satMinerCycleState] = solana.PublicKey.findProgramAddressSync(
          [Buffer.from(SAT_MINER_CYCLE_STATE_SEED), signer.toBuffer(), encodeU64(cycleId)],
          programId,
        );
        accounts.push({ pubkey: satCycleState, isSigner: false, isWritable: false });
        accounts.push({ pubkey: satMinerCycleState, isSigner: false, isWritable: true });
      }
      accounts.push({ pubkey: solana.SystemProgram.programId, isSigner: false, isWritable: false });
      accounts.push({
        pubkey: new solana.PublicKey(TOKEN_PROGRAM_ID),
        isSigner: false,
        isWritable: false,
      });
      accounts.push({
        pubkey: new solana.PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
        isSigner: false,
        isWritable: false,
      });
      accounts.push({
        pubkey: new solana.PublicKey(SAT_MINT_PROGRAM_ID()),
        isSigner: false,
        isWritable: false,
      });
      accounts.push({ pubkey: satRebateVault, isSigner: false, isWritable: true });
      return accounts;
    },
  });
}

export async function submitSatClaimProtocolTreasury(
  _config: SatMiningConfig,
  params: { recipientOwner: string },
) {
  const cfg = loadConfigForSatRuntime(_config);
  return submitInstruction({
    cfg,
    env: process.env,
    data: buildClaimProtocolTreasuryData(),
    accountResolver: async (solana, signer) => {
      const programId = new solana.PublicKey(SAT_PROGRAM_ID());
      const recipientOwner = new solana.PublicKey(params.recipientOwner);
      const [satGlobalState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_GLOBAL_STATE_SEED)],
        programId,
      );
      const [treasury] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from("treasury")],
        programId,
      );
      const [satTreasuryState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_TREASURY_STATE_SEED)],
        programId,
      );
      const [satTreasuryVault] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_TREASURY_VAULT_SEED)],
        programId,
      );
      const [satRegistryReserve] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_REGISTRY_RESERVE_SEED)],
        programId,
      );
      const [mintAuthority] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from("authority")],
        new solana.PublicKey(SAT_MINT_PROGRAM_ID()),
      );
      const recipientAta = deriveAssociatedTokenAddress(
        solana,
        recipientOwner,
        new solana.PublicKey(SAT_MINT_ADDRESS()),
      );
      return [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: satGlobalState, isSigner: false, isWritable: false },
        { pubkey: treasury, isSigner: false, isWritable: true },
        { pubkey: satTreasuryState, isSigner: false, isWritable: true },
        { pubkey: satTreasuryVault, isSigner: false, isWritable: true },
        { pubkey: satRegistryReserve, isSigner: false, isWritable: true },
        { pubkey: recipientOwner, isSigner: false, isWritable: true },
        { pubkey: mintAuthority, isSigner: false, isWritable: true },
        { pubkey: new solana.PublicKey(SAT_MINT_ADDRESS()), isSigner: false, isWritable: true },
        { pubkey: recipientAta, isSigner: false, isWritable: true },
        { pubkey: solana.SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: new solana.PublicKey(TOKEN_PROGRAM_ID), isSigner: false, isWritable: false },
        {
          pubkey: new solana.PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
          isSigner: false,
          isWritable: false,
        },
        { pubkey: new solana.PublicKey(SAT_MINT_PROGRAM_ID()), isSigner: false, isWritable: false },
      ];
    },
  });
}

export async function submitSatRefillRegistryReserveFromTreasury(
  _config: SatMiningConfig,
  params: { targetBalanceLamports?: number },
) {
  const cfg = loadConfigForSatRuntime(_config);
  const targetBalanceLamports =
    typeof params.targetBalanceLamports === "number" &&
    Number.isFinite(params.targetBalanceLamports)
      ? Math.max(0, Math.floor(params.targetBalanceLamports))
      : 0;
  return submitInstruction({
    cfg,
    env: process.env,
    data: buildRefillRegistryReserveFromTreasuryData({ targetBalanceLamports }),
    accountResolver: async (solana, signer) => {
      const programId = new solana.PublicKey(SAT_PROGRAM_ID());
      const [satTreasuryState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_TREASURY_STATE_SEED)],
        programId,
      );
      const [satTreasuryVault] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_TREASURY_VAULT_SEED)],
        programId,
      );
      const [satRegistryReserve] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_REGISTRY_RESERVE_SEED)],
        programId,
      );
      return [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: satTreasuryState, isSigner: false, isWritable: true },
        { pubkey: satTreasuryVault, isSigner: false, isWritable: true },
        { pubkey: satRegistryReserve, isSigner: false, isWritable: true },
        { pubkey: solana.SystemProgram.programId, isSigner: false, isWritable: false },
      ];
    },
  });
}

export async function submitSatClaimProtocolDistributorSat(
  _config: SatMiningConfig,
  params: { recipientOwner: string },
) {
  const cfg = loadConfigForSatRuntime(_config);
  const effectiveEnv = resolveSatEffectiveEnv(cfg, process.env);
  assertDedicatedBondProgram(effectiveEnv);
  return submitInstruction({
    cfg,
    env: effectiveEnv,
    data: buildClaimProtocolDistributorSatData(),
    accountResolver: async (solana, signer) => {
      const programId = new solana.PublicKey(resolveSatProgramIdFromEnv(effectiveEnv));
      const recipientOwner = new solana.PublicKey(params.recipientOwner);
      const [satGlobalState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_GLOBAL_STATE_SEED)],
        programId,
      );
      const [treasury] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from("treasury")],
        programId,
      );
      const [satTreasuryState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_TREASURY_STATE_SEED)],
        programId,
      );
      const [mintAuthority] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from("authority")],
        new solana.PublicKey(resolveSatMintProgramIdFromEnv(effectiveEnv)),
      );
      const recipientAta = deriveAssociatedTokenAddress(
        solana,
        recipientOwner,
        new solana.PublicKey(resolveSatMintAddressFromEnv(effectiveEnv)),
      );
      return [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: satGlobalState, isSigner: false, isWritable: false },
        { pubkey: treasury, isSigner: false, isWritable: true },
        { pubkey: satTreasuryState, isSigner: false, isWritable: true },
        { pubkey: recipientOwner, isSigner: false, isWritable: true },
        { pubkey: mintAuthority, isSigner: false, isWritable: true },
        {
          pubkey: new solana.PublicKey(resolveSatMintAddressFromEnv(effectiveEnv)),
          isSigner: false,
          isWritable: true,
        },
        { pubkey: recipientAta, isSigner: false, isWritable: true },
        { pubkey: solana.SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: new solana.PublicKey(TOKEN_PROGRAM_ID), isSigner: false, isWritable: false },
        {
          pubkey: new solana.PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
          isSigner: false,
          isWritable: false,
        },
        {
          pubkey: new solana.PublicKey(resolveSatMintProgramIdFromEnv(effectiveEnv)),
          isSigner: false,
          isWritable: false,
        },
        {
          pubkey: new solana.PublicKey(resolveSatBondProgramIdFromEnv(effectiveEnv)),
          isSigner: false,
          isWritable: false,
        },
      ];
    },
  });
}

export async function submitSatRetargetUnlock(
  _config: SatMiningConfig,
  params: { cycleId: number },
) {
  const cfg = loadConfigForSatRuntime(_config);
  return submitInstruction({
    cfg,
    env: process.env,
    data: buildRetargetUnlockData(params),
    accountResolver: async (solana, signer) => {
      const programId = new solana.PublicKey(SAT_PROGRAM_ID());
      const [satGlobalState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_GLOBAL_STATE_SEED)],
        programId,
      );
      const [satCycleState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_CYCLE_STATE_SEED), encodeU64(params.cycleId)],
        programId,
      );
      const intervalStartCycleId = Math.max(
        0,
        params.cycleId + 1 - SAT_PROTOCOL_CONSTANTS.cycleUnlockRetargetIntervalCycles,
      );
      const [satUnlockIntervalState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_UNLOCK_INTERVAL_STATE_SEED), encodeU64(intervalStartCycleId)],
        programId,
      );
      return [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: satGlobalState, isSigner: false, isWritable: true },
        { pubkey: satCycleState, isSigner: false, isWritable: false },
        { pubkey: satUnlockIntervalState, isSigner: false, isWritable: true },
      ];
    },
  });
}

function buildCloseResolvedMinerCycleStateSpec(params: {
  cycleId: number;
  authority: string;
}): SatInstructionSubmitSpec {
  return {
    data: buildCloseResolvedMinerCycleStateData(params),
    accountResolver: async (solana, signer) => {
      const programId = new solana.PublicKey(SAT_PROGRAM_ID());
      const minerAuthority = new solana.PublicKey(params.authority);
      const [satCycleState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_CYCLE_STATE_SEED), encodeU64(params.cycleId)],
        programId,
      );
      const [satMinerCycleState] = solana.PublicKey.findProgramAddressSync(
        [
          Buffer.from(SAT_MINER_CYCLE_STATE_SEED),
          minerAuthority.toBuffer(),
          encodeU64(params.cycleId),
        ],
        programId,
      );
      const [satMinerCapitalState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_MINER_CAPITAL_STATE_SEED), minerAuthority.toBuffer()],
        programId,
      );
      const [satCycleRegistryMeta] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_CYCLE_REGISTRY_META_SEED), encodeU64(params.cycleId)],
        programId,
      );
      return [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: satCycleState, isSigner: false, isWritable: false },
        { pubkey: minerAuthority, isSigner: false, isWritable: true },
        { pubkey: satMinerCycleState, isSigner: false, isWritable: true },
        { pubkey: satMinerCapitalState, isSigner: false, isWritable: true },
        { pubkey: satCycleRegistryMeta, isSigner: false, isWritable: true },
      ];
    },
  };
}

function buildCloseResolvedCycleRegistryPageSpec(params: {
  cycleId: number;
  pageIndex: number;
}): SatInstructionSubmitSpec {
  return {
    data: buildCloseResolvedCycleRegistryPageData(params),
    accountResolver: async (solana, signer) => {
      const programId = new solana.PublicKey(SAT_PROGRAM_ID());
      const [satCycleState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_CYCLE_STATE_SEED), encodeU64(params.cycleId)],
        programId,
      );
      const [satCycleRegistryMeta] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_CYCLE_REGISTRY_META_SEED), encodeU64(params.cycleId)],
        programId,
      );
      const [satCycleRegistryPage] = solana.PublicKey.findProgramAddressSync(
        [
          Buffer.from(SAT_CYCLE_REGISTRY_PAGE_SEED),
          encodeU64(params.cycleId),
          encodeU64(params.pageIndex),
        ],
        programId,
      );
      const [satRegistryReserve] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_REGISTRY_RESERVE_SEED)],
        programId,
      );
      return [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: satCycleState, isSigner: false, isWritable: false },
        { pubkey: satCycleRegistryMeta, isSigner: false, isWritable: true },
        { pubkey: satCycleRegistryPage, isSigner: false, isWritable: true },
        { pubkey: satRegistryReserve, isSigner: false, isWritable: true },
      ];
    },
  };
}

function buildCloseResolvedCycleArtifactsSpec(params: {
  cycleId: number;
}): SatInstructionSubmitSpec {
  return {
    data: buildCloseResolvedCycleArtifactsData(params),
    accountResolver: async (solana, signer) => {
      const programId = new solana.PublicKey(SAT_PROGRAM_ID());
      const [satCycleState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_CYCLE_STATE_SEED), encodeU64(params.cycleId)],
        programId,
      );
      const [satCycleSettlementProgress] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from("sat_cycle_settlement_progress_v2"), encodeU64(params.cycleId)],
        programId,
      );
      const [satCycleRegistryMeta] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_CYCLE_REGISTRY_META_SEED), encodeU64(params.cycleId)],
        programId,
      );
      const [satRegistryReserve] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_REGISTRY_RESERVE_SEED)],
        programId,
      );
      return [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: satCycleState, isSigner: false, isWritable: true },
        { pubkey: satCycleSettlementProgress, isSigner: false, isWritable: true },
        { pubkey: satCycleRegistryMeta, isSigner: false, isWritable: true },
        { pubkey: satRegistryReserve, isSigner: false, isWritable: true },
      ];
    },
  };
}

export async function submitSatCloseResolvedMinerCycleState(
  _config: SatMiningConfig,
  params: { cycleId: number; authority: string },
) {
  const cfg = loadConfigForSatRuntime(_config);
  return submitInstruction({
    cfg,
    env: process.env,
    ...buildCloseResolvedMinerCycleStateSpec(params),
  });
}

export async function submitSatCloseResolvedCycleRegistryPage(
  _config: SatMiningConfig,
  params: { cycleId: number; pageIndex: number },
) {
  const cfg = loadConfigForSatRuntime(_config);
  return submitInstruction({
    cfg,
    env: process.env,
    ...buildCloseResolvedCycleRegistryPageSpec(params),
  });
}

export async function submitSatCloseResolvedCycleArtifacts(
  _config: SatMiningConfig,
  params: { cycleId: number },
) {
  const cfg = loadConfigForSatRuntime(_config);
  return submitInstruction({
    cfg,
    env: process.env,
    ...buildCloseResolvedCycleArtifactsSpec(params),
  });
}

export type SatCloseResolvedCleanupBatchItem =
  | { kind: "minerCycleState"; cycleId: number; authority: string }
  | { kind: "cycleRegistryPage"; cycleId: number; pageIndex: number }
  | { kind: "cycleArtifacts"; cycleId: number };

export async function submitSatCloseResolvedCleanupBatch(
  _config: SatMiningConfig,
  items: SatCloseResolvedCleanupBatchItem[],
) {
  if (items.length === 0) {
    throw new Error("SAT cleanup batch has no items");
  }
  const cfg = loadConfigForSatRuntime(_config);
  return submitInstructionBatch({
    cfg,
    env: process.env,
    purpose: "sat-cleanup",
    instructions: items.map((item) => {
      switch (item.kind) {
        case "minerCycleState":
          return buildCloseResolvedMinerCycleStateSpec(item);
        case "cycleRegistryPage":
          return buildCloseResolvedCycleRegistryPageSpec(item);
        case "cycleArtifacts":
          return buildCloseResolvedCycleArtifactsSpec(item);
      }
    }),
  });
}

export async function submitSatCompactPendingCycleRange(
  _config: SatMiningConfig,
  params: {
    expectedFirstPendingCycleId: number;
    expectedLastPendingCycleId: number;
    frontCycleIds: number[];
    backCycleIds: number[];
  },
) {
  const cfg = loadConfigForSatRuntime(_config);
  return submitInstruction({
    cfg,
    env: process.env,
    data: buildCompactPendingCycleRangeData(params),
    accountResolver: async (solana, signer) => {
      const programId = new solana.PublicKey(SAT_PROGRAM_ID());
      const [satMinerCapitalState] = solana.PublicKey.findProgramAddressSync(
        [Buffer.from(SAT_MINER_CAPITAL_STATE_SEED), signer.toBuffer()],
        programId,
      );
      const accounts: SolanaAccountMeta[] = [
        { pubkey: signer, isSigner: true, isWritable: true },
        { pubkey: satMinerCapitalState, isSigner: false, isWritable: true },
      ];
      for (const cycleId of params.frontCycleIds) {
        const [satMinerCycleState] = solana.PublicKey.findProgramAddressSync(
          [Buffer.from(SAT_MINER_CYCLE_STATE_SEED), signer.toBuffer(), encodeU64(cycleId)],
          programId,
        );
        accounts.push({
          pubkey: satMinerCycleState,
          isSigner: false,
          isWritable: false,
        });
      }
      for (const cycleId of params.backCycleIds) {
        const [satMinerCycleState] = solana.PublicKey.findProgramAddressSync(
          [Buffer.from(SAT_MINER_CYCLE_STATE_SEED), signer.toBuffer(), encodeU64(cycleId)],
          programId,
        );
        accounts.push({
          pubkey: satMinerCycleState,
          isSigner: false,
          isWritable: false,
        });
      }
      return {
        keys: accounts,
        context: {
          frontCycleIds: params.frontCycleIds.map(String),
          backCycleIds: params.backCycleIds.map(String),
        },
      };
    },
  });
}
