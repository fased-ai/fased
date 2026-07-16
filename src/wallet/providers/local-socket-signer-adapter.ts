import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { WalletChain } from "../../config/types.wallet.js";
import {
  parseLocalSocketSignerResponseEnvelope,
  validateLocalSocketSignerResult,
  type LocalSocketSignerRequest,
  type LocalSocketSignerOperationV2,
  type LocalSocketSignerPolicyV2,
} from "../local-socket-signer-protocol.js";
import { fetchSolanaMintInfoViaRpc, fetchSolanaNativeBalanceViaRpc } from "../solana-assets.js";
import {
  type WalletProviderAdapter,
  type WalletProviderAddressMap,
  type WalletProviderBalanceResult,
  type WalletProviderCapabilities,
  type WalletProviderHealth,
  type WalletProviderJupiterExecutionV2,
  type WalletProviderJupiterIntentV2,
  type WalletProviderJupiterReviewV2,
  type WalletProviderSignerReviewAuthorizationBeginV2,
  type WalletProviderSignerReviewAuthorizationFinishV2,
  type WalletProviderSignerReviewAuthorizationV2,
  type WalletProviderSignerTransactionEnvelopeV2,
  type WalletProviderTypedTransferIntentV2,
  type WalletProviderPrepareTxRequest,
  type WalletProviderPrepareTxResult,
  type WalletProviderSendTxRequest,
  type WalletProviderSendTxResult,
  type WalletProviderSignTxResult,
  WalletProviderError,
} from "../wallet-provider-adapter.js";
import {
  redactWalletDiagnosticText,
  walletDiagnosticErrorMessage,
  walletDiagnosticErrorString,
} from "../wallet-redaction.js";
import { ensureWalletStateDir } from "../wallet-runtime-config.js";

export type LocalSocketSignerHealthProbe = {
  ok: boolean;
  details?: string;
  readOnly?: boolean;
  keystoreType?: string;
  chains?: WalletChain[];
  ready?: boolean;
  capabilities?: {
    protocol: { current: 2; min: number; max: number };
    intentTypes: string[];
    operationStates: string[];
    features: string[];
  };
  policies?: Array<{
    walletId: string;
    role: "agent" | "mining" | "vault";
    version: number;
    hash: string;
  }>;
};

const MAX_SIGNER_RESPONSE_BYTES = 1 << 20;
const REQUIRED_PROTOCOL_V2_FEATURES = [
  "failClosedPolicies",
  "policyHashes",
  "durableCaps",
  "atomicIdempotency",
  "ambiguousBroadcastReconciliation",
  "signerOwnedKeys",
  "signerOwnedRPC",
  "typedSolanaTransactions",
  "signerOwnedWebAuthn",
  "singleUseReviewedAuthorization",
  "typedJupiterSemantics",
  "signerOwnedReviewPrepareExecute",
  "exactPreparedTransactions",
  "verifiedAddressLookupTables",
] as const;

const SIGNER_SOCKET_TIMEOUT_MS: Record<LocalSocketSignerRequest["op"], number> = {
  health: 2_000,
  "v2.capabilities": 2_000,
  "v2.policy.get": 5_000,
  "v2.policy.put": 5_000,
  "v2.wallet.get": 5_000,
  "v2.wallet.create": 10_000,
  "v2.wallet.import": 20_000,
  "v2.wallet.importLegacy": 30_000,
  "v2.wallet.reencrypt": 10_000,
  "v2.execute": 120_000,
  "v2.review.prepare": 15_000,
  "v2.review.execute": 120_000,
  "v2.review.authorization.begin": 15_000,
  "v2.review.authorization.finish": 30_000,
  "v2.operation.get": 5_000,
  "v2.operation.reconcile": 20_000,
  getAddresses: 10_000,
  getBalance: 15_000,
  prepareTx: 15_000,
  signTx: 20_000,
  sendTx: 120_000,
  sendSolanaInstruction: 120_000,
  sendSolanaInstructions: 120_000,
  custodyStatus: 5_000,
  unlockCustody: 10_000,
  lockCustody: 10_000,
};

export type LocalSocketSignerCallOptions = {
  timeoutMs?: number;
  maxResponseBytes?: number;
};

function signerTimeoutFor(payload: LocalSocketSignerRequest): number {
  return SIGNER_SOCKET_TIMEOUT_MS[payload.op] ?? 30_000;
}

export function assertSecureLocalSignerSocket(socketPath: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(socketPath);
  } catch (err) {
    throw new WalletProviderError({
      code: "wallet_provider_unavailable",
      message: `local-socket-signer socket is unavailable: ${walletDiagnosticErrorMessage(err)}`,
      cause: err,
    });
  }
  if (stat.isSymbolicLink() || !stat.isSocket()) {
    throw new WalletProviderError({
      code: "wallet_provider_invalid_config",
      message: "local-socket-signer path must be a Unix socket, not a symlink or file",
    });
  }
  const mode = stat.mode & 0o777;
  if ((mode & 0o007) !== 0) {
    throw new WalletProviderError({
      code: "wallet_provider_invalid_config",
      message: `local-socket-signer socket must not be world-accessible (mode ${mode.toString(8)})`,
    });
  }
  const uid = process.getuid?.();
  if (typeof uid !== "number") {
    return;
  }
  if (stat.uid === uid) {
    return;
  }
  const gid = process.getgid?.();
  const groups = new Set<number>([
    ...(typeof gid === "number" ? [gid] : []),
    ...(process.getgroups?.() ?? []),
  ]);
  const groupCanAccess = (mode & 0o070) !== 0 && groups.has(stat.gid);
  if (!groupCanAccess) {
    throw new WalletProviderError({
      code: "wallet_provider_invalid_config",
      message:
        "local-socket-signer socket must be owned by this user or by an accessible private group",
    });
  }
}

async function callSocket<T>(
  socketPath: string,
  payload: LocalSocketSignerRequest,
  options?: LocalSocketSignerCallOptions,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buf = "";
    let settled = false;
    const maxResponseBytes = options?.maxResponseBytes ?? MAX_SIGNER_RESPONSE_BYTES;
    const timeoutMs = options?.timeoutMs ?? signerTimeoutFor(payload);
    const finish = (err?: unknown, value?: T) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      if (!socket.destroyed) {
        socket.end();
      }
      if (err) {
        reject(err);
        return;
      }
      resolve(value as T);
    };
    const timer = setTimeout(() => {
      socket.destroy();
      finish(new Error(`local socket signer timeout after ${timeoutMs}ms for op=${payload.op}`));
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(payload)}\n`);
    });
    socket.on("data", (chunk: string) => {
      buf += chunk;
      if (Buffer.byteLength(buf, "utf8") > maxResponseBytes) {
        socket.destroy();
        finish(new Error(`local socket signer response exceeds ${maxResponseBytes} bytes`));
        return;
      }
      const idx = buf.indexOf("\n");
      if (idx < 0) {
        return;
      }
      const line = buf.slice(0, idx);
      try {
        const parsed = parseLocalSocketSignerResponseEnvelope(JSON.parse(line) as unknown);
        if (!parsed.ok) {
          finish(new Error(parsed.error || "local socket signer error"));
          return;
        }
        if (!validateLocalSocketSignerResult(payload.op, parsed.result)) {
          finish(new Error(`invalid local socket signer result for op=${payload.op}`));
          return;
        }
        finish(undefined, parsed.result as T);
      } catch (err) {
        finish(err);
      }
    });
    socket.on("error", (err) => finish(err));
  });
}

export async function callLocalSocketSigner<T>(
  socketPath: string,
  payload: LocalSocketSignerRequest,
  options?: LocalSocketSignerCallOptions,
): Promise<T> {
  return await callSocket<T>(socketPath, payload, options);
}

export async function probeLocalSocketSignerHealth(
  socketPath: string,
): Promise<LocalSocketSignerHealthProbe> {
  try {
    const result = await callSocket<{
      details?: string;
      readOnly?: boolean;
      keystoreType?: string;
      chains?: WalletChain[];
      ready?: boolean;
      capabilities?: LocalSocketSignerHealthProbe["capabilities"];
      policies?: LocalSocketSignerHealthProbe["policies"];
    }>(socketPath, { op: "health" });
    return {
      ok: true,
      details: result?.details ? redactWalletDiagnosticText(result.details) : undefined,
      readOnly: result?.readOnly,
      keystoreType: result?.keystoreType,
      chains: Array.isArray(result?.chains) ? result.chains : undefined,
      ready: result?.ready,
      capabilities: result?.capabilities,
      policies: result?.policies,
    };
  } catch (err) {
    return {
      ok: false,
      details: walletDiagnosticErrorMessage(err),
    };
  }
}

export class LocalSocketSignerAdapter implements WalletProviderAdapter {
  readonly id = "local-socket-signer" as const;
  readonly displayName = "Local Socket Signer";
  readonly capabilities: WalletProviderCapabilities = {
    custodyModel: "self-hosted",
    supportsCreateWallet: false,
    supportsPrepare: true,
    supportsSend: true,
    supportsRotateKeys: false,
    supportsResetKeys: false,
    supportsPasskeyGate: false,
    signingLocation: "server",
    supportsSignTransaction: false,
    supportsSignMessage: false,
    supportedExecutionModes: ["manual", "autonomous"],
    supportedChains: ["solana"],
  };

  constructor(
    private readonly socketPath: string,
    private readonly options?: {
      rpcUrl?: string;
      scopedWalletId?: string;
    },
  ) {}

  supportsChain(chain: WalletChain): boolean {
    return this.capabilities.supportedChains.includes(chain);
  }

  private async requireProtocolV2(intentType?: string): Promise<void> {
    const result = await callSocket<{
      ready?: boolean;
      capabilities?: LocalSocketSignerHealthProbe["capabilities"];
    }>(this.socketPath, { op: "v2.capabilities" });
    const capabilities = result.capabilities;
    const protocol = capabilities?.protocol;
    const missingFeatures = REQUIRED_PROTOCOL_V2_FEATURES.filter(
      (feature) => !capabilities?.features.includes(feature),
    );
    if (
      result.ready !== true ||
      !protocol ||
      protocol.current !== 2 ||
      protocol.min > 2 ||
      protocol.max < 2 ||
      missingFeatures.length > 0 ||
      (intentType && !capabilities?.intentTypes.includes(intentType))
    ) {
      throw new WalletProviderError({
        code: "wallet_provider_unavailable",
        message: `local-socket-signer protocol-v2 capability negotiation failed${missingFeatures.length > 0 ? `; missing ${missingFeatures.join(",")}` : ""}${intentType && !capabilities?.intentTypes.includes(intentType) ? `; unsupported intent ${intentType}` : ""}`,
      });
    }
  }

  async health(): Promise<WalletProviderHealth> {
    try {
      const details = await probeLocalSocketSignerHealth(this.socketPath);
      if (!details.ok) {
        throw new Error(details.details || "local socket signer unavailable");
      }
      return {
        ok: true,
        provider: this.id,
        configured: true,
        checkedAt: new Date().toISOString(),
        details:
          details?.details ??
          [
            details?.readOnly ? "read-only" : "read-write",
            details?.keystoreType ? `keystore=${details.keystoreType}` : "",
            Array.isArray(details?.chains) ? `chains=${details.chains.join(",")}` : "",
          ]
            .filter(Boolean)
            .join(" "),
      };
    } catch (err) {
      return {
        ok: false,
        provider: this.id,
        configured: Boolean(this.socketPath),
        checkedAt: new Date().toISOString(),
        details: walletDiagnosticErrorString(err),
      };
    }
  }

  async getAddresses(options?: { walletId?: string }): Promise<WalletProviderAddressMap> {
    const walletId = options?.walletId?.trim() || this.options?.scopedWalletId?.trim();
    if (!walletId) {
      throw new WalletProviderError({
        code: "wallet_provider_invalid_config",
        message: "local-socket-signer requires an explicit walletId",
      });
    }
    await this.requireProtocolV2();
    const wallet = await callSocket<{ publicKey: string }>(this.socketPath, {
      op: "v2.wallet.get",
      walletId,
    });
    return { solana: wallet.publicKey };
  }

  async getBalance(
    chain: WalletChain,
    options?: { walletId?: string },
  ): Promise<WalletProviderBalanceResult> {
    if (chain !== "solana") {
      throw new WalletProviderError({
        code: "wallet_provider_unsupported_chain",
        message: "local-socket-signer supports Solana only",
      });
    }
    const rpcUrl = this.options?.rpcUrl?.trim();
    if (!rpcUrl) {
      throw new WalletProviderError({
        code: "wallet_provider_invalid_config",
        message: "local-socket-signer balance lookup requires a Solana RPC URL",
      });
    }
    const address = (await this.getAddresses(options)).solana;
    if (!address) {
      throw new WalletProviderError({
        code: "wallet_provider_unavailable",
        message: "local-socket-signer wallet has no Solana address",
      });
    }
    const balance = await fetchSolanaNativeBalanceViaRpc({ rpcUrl, ownerAddress: address });
    if (balance === null) {
      throw new WalletProviderError({
        code: "wallet_provider_unavailable",
        message: "failed to resolve the signer wallet balance from Solana RPC",
      });
    }
    return { ok: true, chain, address, balance, unit: "lamports" };
  }

  async prepareTx(request: WalletProviderPrepareTxRequest): Promise<WalletProviderPrepareTxResult> {
    void request;
    throw new WalletProviderError({
      code: "wallet_provider_not_implemented",
      message: "local-socket-signer manual preparation requires signer protocol-v2 review.prepare",
    });
  }

  async sendTx(request: WalletProviderSendTxRequest): Promise<WalletProviderSendTxResult> {
    assertSecureLocalSignerSocket(this.socketPath);
    if (request.chain !== "solana") {
      throw new WalletProviderError({
        code: "wallet_provider_unsupported_chain",
        message: "local-socket-signer supports Solana only",
      });
    }
    if (request.serializedTxBase64?.trim() || request.memo?.trim()) {
      throw new WalletProviderError({
        code: "wallet_provider_invalid_config",
        message:
          "local-socket-signer accepts typed SOL/SPL intents, not serialized transactions or raw memos",
      });
    }
    return await this.executeTypedTransfer(request);
  }

  async signTx(request: WalletProviderSendTxRequest): Promise<WalletProviderSignTxResult> {
    void request;
    throw new WalletProviderError({
      code: "wallet_provider_not_implemented",
      message:
        "local-socket-signer raw transaction signing is disabled; use a typed signer-v2 operation",
    });
  }

  async prepareJupiterReview(request: {
    walletId: string;
    requestId: string;
    mode: "autonomous" | "reviewed";
    intent: WalletProviderJupiterIntentV2;
    transaction: WalletProviderSignerTransactionEnvelopeV2;
  }): Promise<WalletProviderJupiterReviewV2> {
    assertSecureLocalSignerSocket(this.socketPath);
    await this.requireProtocolV2(request.intent.type);
    const policy = await callSocket<LocalSocketSignerPolicyV2>(this.socketPath, {
      op: "v2.policy.get",
      walletId: request.walletId,
    });
    return await callSocket<WalletProviderJupiterReviewV2>(this.socketPath, {
      op: "v2.review.prepare",
      walletId: request.walletId,
      request: {
        requestId: request.requestId,
        policyHash: policy.hash,
        mode: request.mode,
        intent: request.intent,
        transaction: request.transaction,
      },
    });
  }

  async executeJupiterReview(request: {
    walletId: string;
    requestId: string;
    authorization?: WalletProviderSignerReviewAuthorizationV2;
  }): Promise<WalletProviderJupiterExecutionV2> {
    return await this.executeSignerReview(request);
  }

  async prepareTypedTransferReview(request: {
    walletId: string;
    requestId: string;
    destination: string;
    amount: string;
    mint?: string;
  }): Promise<WalletProviderJupiterReviewV2> {
    assertSecureLocalSignerSocket(this.socketPath);
    const mint = request.mint?.trim();
    let intent: WalletProviderTypedTransferIntentV2;
    if (mint) {
      const rpcUrl = this.options?.rpcUrl?.trim();
      if (!rpcUrl) {
        throw new WalletProviderError({
          code: "wallet_provider_invalid_config",
          message: "local-socket-signer SPL review requires a Solana RPC URL",
        });
      }
      const mintInfo = await fetchSolanaMintInfoViaRpc({ rpcUrl, mint });
      if (!mintInfo) {
        throw new WalletProviderError({
          code: "wallet_provider_unavailable",
          message: "failed to resolve SPL mint metadata for signer review",
        });
      }
      intent = {
        type: "solana.splTransferChecked",
        tokenProgram: mintInfo.tokenProgramId,
        mint,
        destination: request.destination,
        amount: request.amount,
      };
    } else {
      intent = {
        type: "solana.nativeTransfer",
        destination: request.destination,
        lamports: request.amount,
      };
    }
    await this.requireProtocolV2(intent.type);
    const policy = await callSocket<LocalSocketSignerPolicyV2>(this.socketPath, {
      op: "v2.policy.get",
      walletId: request.walletId,
    });
    return await callSocket<WalletProviderJupiterReviewV2>(this.socketPath, {
      op: "v2.review.prepare",
      walletId: request.walletId,
      request: {
        requestId: request.requestId,
        policyHash: policy.hash,
        mode: "reviewed",
        intent,
      },
    });
  }

  async executeSignerReview(request: {
    walletId: string;
    requestId: string;
    authorization?: WalletProviderSignerReviewAuthorizationV2;
  }): Promise<WalletProviderJupiterExecutionV2> {
    assertSecureLocalSignerSocket(this.socketPath);
    await this.requireProtocolV2();
    return await callSocket<WalletProviderJupiterExecutionV2>(this.socketPath, {
      op: "v2.review.execute",
      walletId: request.walletId,
      request: {
        requestId: request.requestId,
        ...(request.authorization ? { authorization: request.authorization } : {}),
      },
    });
  }

  async beginJupiterReviewAuthorization(request: {
    walletId: string;
    requestId: string;
  }): Promise<WalletProviderSignerReviewAuthorizationBeginV2> {
    return await this.beginSignerReviewAuthorization(request);
  }

  async beginSignerReviewAuthorization(request: {
    walletId: string;
    requestId: string;
  }): Promise<WalletProviderSignerReviewAuthorizationBeginV2> {
    assertSecureLocalSignerSocket(this.socketPath);
    await this.requireProtocolV2();
    return await callSocket<WalletProviderSignerReviewAuthorizationBeginV2>(this.socketPath, {
      op: "v2.review.authorization.begin",
      walletId: request.walletId,
      request: { requestId: request.requestId },
    });
  }

  async finishJupiterReviewAuthorization(request: {
    walletId: string;
    challengeId: string;
    credential: unknown;
  }): Promise<WalletProviderSignerReviewAuthorizationFinishV2> {
    return await this.finishSignerReviewAuthorization(request);
  }

  async finishSignerReviewAuthorization(request: {
    walletId: string;
    challengeId: string;
    credential: unknown;
  }): Promise<WalletProviderSignerReviewAuthorizationFinishV2> {
    assertSecureLocalSignerSocket(this.socketPath);
    await this.requireProtocolV2();
    return await callSocket<WalletProviderSignerReviewAuthorizationFinishV2>(this.socketPath, {
      op: "v2.review.authorization.finish",
      walletId: request.walletId,
      request: { challengeId: request.challengeId, credential: request.credential },
    });
  }

  private async executeTypedTransfer(
    request: WalletProviderSendTxRequest,
  ): Promise<WalletProviderSendTxResult> {
    const walletId = request.walletId?.trim() || this.options?.scopedWalletId?.trim();
    const requestId = request.requestId?.trim();
    const destination = request.to?.trim();
    const amount = request.amount?.trim();
    if (!walletId || !requestId || !destination || !amount) {
      throw new WalletProviderError({
        code: "wallet_provider_invalid_config",
        message:
          "local-socket-signer typed send requires walletId, stable requestId, destination, and raw-unit amount",
      });
    }
    const intentType = request.program?.trim()
      ? "solana.splTransferChecked"
      : "solana.nativeTransfer";
    await this.requireProtocolV2(intentType);
    // Resolve every dependency before execution. No fallible signer/RPC call may run after a
    // confirmed broadcast, because turning success into an error could induce a duplicate send.
    const wallet = await callSocket<{ publicKey: string }>(this.socketPath, {
      op: "v2.wallet.get",
      walletId,
    });
    const policy = await callSocket<LocalSocketSignerPolicyV2>(this.socketPath, {
      op: "v2.policy.get",
      walletId,
    });
    const mint = request.program?.trim();
    let intent: Extract<LocalSocketSignerRequest, { op: "v2.execute" }>["request"]["intent"];
    if (mint) {
      const rpcUrl = this.options?.rpcUrl?.trim();
      if (!rpcUrl) {
        throw new WalletProviderError({
          code: "wallet_provider_invalid_config",
          message: "local-socket-signer SPL send requires a Solana RPC URL",
        });
      }
      const mintInfo = await fetchSolanaMintInfoViaRpc({ rpcUrl, mint });
      if (!mintInfo) {
        throw new WalletProviderError({
          code: "wallet_provider_unavailable",
          message: "failed to resolve SPL mint metadata from Solana RPC",
        });
      }
      intent = {
        type: "solana.splTransferChecked",
        destination,
        tokenProgram: mintInfo.tokenProgramId,
        mint,
        amount,
      };
    } else {
      intent = { type: "solana.nativeTransfer", destination, lamports: amount };
    }
    const operation = await callSocket<LocalSocketSignerOperationV2>(this.socketPath, {
      op: "v2.execute",
      walletId,
      request: { requestId, policyHash: policy.hash, intent },
    });
    if (operation.state !== "confirmed" || !operation.signature) {
      const ambiguous = operation.state === "broadcast" || operation.state === "unknown";
      throw new WalletProviderError({
        code: ambiguous ? "wallet_provider_ambiguous" : "wallet_provider_unavailable",
        message: ambiguous
          ? `signer operation ${requestId} has an ambiguous ${operation.state} result; reconcile it before any new attempt`
          : `signer operation ${requestId} ended in state=${operation.state}${operation.error ? `: ${operation.error}` : ""}`,
        retryable: false,
      });
    }
    return {
      ok: true,
      chain: "solana",
      txHash: operation.signature,
      signer: wallet.publicKey,
      metadata: {
        provider: this.id,
        requestId: operation.requestId,
        intentDigest: operation.intentDigest,
        transactionDigest: operation.transactionDigest,
        policyHash: operation.policyHash,
        operationState: operation.state,
      },
    };
  }
}

export function resolveLocalSocketSignerPath(env: NodeJS.ProcessEnv): string {
  const socketPath = String(env.FASED_WALLET_LOCAL_SIGNER_SOCKET ?? "").trim();
  if (socketPath) {
    return socketPath;
  }
  return path.join(ensureWalletStateDir(env).rootDir, "local-signer.sock");
}

export function requireLocalSocketSignerPath(env: NodeJS.ProcessEnv): string {
  return resolveLocalSocketSignerPath(env);
}
