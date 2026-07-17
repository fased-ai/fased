import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { withFileLock } from "../infra/file-lock.js";
import {
  broadcastReviewedSolanaTransaction,
  buildReviewedSolanaTransaction,
  computeReviewedSolanaRequestDigest,
  reconcileReviewedSolanaTransaction,
  validateReviewedSolanaSignedTransaction,
} from "./solana-reviewed-transaction.js";
import {
  WalletProviderError,
  type WalletProviderPrepareTxRequest,
} from "./wallet-provider-adapter.js";
import { ensureWalletStateDir } from "./wallet-runtime-config.js";

const STATE_FILE_NAME = "turnkey-reviews.v1.json";
const REVIEW_TTL_MS = 2 * 60 * 1000;
const STATE_FILE_MODE = 0o600;
const REVIEW_LOCK_OPTIONS = {
  retries: {
    retries: 80,
    factor: 1.15,
    minTimeout: 20,
    maxTimeout: 200,
    randomize: true,
  },
  stale: 30_000,
} as const;

type TurnkeyReviewStatus = "prepared" | "broadcasting" | "broadcast" | "failed" | "unknown";

type TurnkeyReviewRecord = {
  approvalRequestId?: string;
  preparedId: string;
  createdAt: string;
  expiresAt: string;
  status: TurnkeyReviewStatus;
  signer: string;
  requestDigest: string;
  intentDigest: string;
  unsignedTxBase64: string;
  messageBase64: string;
  recentBlockhash: string;
  lastValidBlockHeight: number;
  rpcUrlDigest: string;
  authorizationContextDigest: string;
  simulationUnitsConsumed?: number;
  txHash?: string;
  signedTxBase64?: string;
  failureReason?: string;
};

type TurnkeyReviewFile = {
  version: 1;
  reviews: TurnkeyReviewRecord[];
};

export type TurnkeyReviewedPrepareResult = {
  preparedId: string;
  signer: string;
  unsignedTxBase64: string;
  messageBase64: string;
  intentDigest: string;
  expiresAt: string;
  recentBlockhash: string;
  lastValidBlockHeight: number;
  simulation: { ok: true; unitsConsumed?: number };
};

let reviewStateLock: Promise<unknown> = Promise.resolve();

function statePath(env: NodeJS.ProcessEnv): string {
  return path.join(ensureWalletStateDir(env).rootDir, STATE_FILE_NAME);
}

function readFile(env: NodeJS.ProcessEnv): TurnkeyReviewFile {
  const filePath = statePath(env);
  if (!fs.existsSync(filePath)) {
    return { version: 1, reviews: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as TurnkeyReviewFile;
    if (parsed.version === 1 && Array.isArray(parsed.reviews)) {
      return parsed;
    }
  } catch {
    // Fail closed below.
  }
  throw new WalletProviderError({
    code: "wallet_provider_unavailable",
    message: "Turnkey reviewed transaction state is invalid; repair it before signing",
    retryable: false,
  });
}

function saveFile(file: TurnkeyReviewFile, env: NodeJS.ProcessEnv): void {
  const filePath = statePath(env);
  const temporary = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, "wx", STATE_FILE_MODE);
    fs.writeFileSync(descriptor, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, filePath);
    try {
      fs.chmodSync(filePath, STATE_FILE_MODE);
    } catch {
      // Best effort on filesystems without POSIX mode semantics.
    }
    try {
      const directory = fs.openSync(path.dirname(filePath), "r");
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    } catch {
      // Directory fsync is unavailable on some non-POSIX filesystems.
    }
  } catch (error) {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The rename may already have consumed the temporary path.
    }
    throw error;
  }
}

function secureEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

function normalizedRpcUrlDigest(rpcUrl: string): string {
  let normalized: string;
  try {
    const parsed = new URL(rpcUrl.trim());
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("unsupported protocol");
    }
    normalized = parsed.toString();
  } catch {
    throw new WalletProviderError({
      code: "wallet_provider_invalid_config",
      message: "Turnkey review requires a valid HTTP(S) Solana RPC URL",
    });
  }
  return digest(normalized);
}

function preparedIdentity(params: {
  approvalRequestId: string;
  requestDigest: string;
  rpcUrlDigest: string;
  authorizationContextDigest: string;
}): string {
  return digest(
    [
      "fased-turnkey-reviewed-v1",
      params.approvalRequestId,
      params.requestDigest,
      params.rpcUrlDigest,
      params.authorizationContextDigest,
    ].join("\0"),
  );
}

function toPrepareResult(record: TurnkeyReviewRecord): TurnkeyReviewedPrepareResult {
  return {
    preparedId: record.preparedId,
    signer: record.signer,
    unsignedTxBase64: record.unsignedTxBase64,
    messageBase64: record.messageBase64,
    intentDigest: record.intentDigest,
    expiresAt: record.expiresAt,
    recentBlockhash: record.recentBlockhash,
    lastValidBlockHeight: record.lastValidBlockHeight,
    simulation: {
      ok: true,
      ...(typeof record.simulationUnitsConsumed === "number" &&
      Number.isFinite(record.simulationUnitsConsumed)
        ? { unitsConsumed: record.simulationUnitsConsumed }
        : {}),
    },
  };
}

async function withReviewLock<T>(env: NodeJS.ProcessEnv, task: () => Promise<T>): Promise<T> {
  const run = async () =>
    await withFileLock(statePath(env), REVIEW_LOCK_OPTIONS, async () => await task());
  const current = reviewStateLock.then(run, run);
  reviewStateLock = current.then(
    () => undefined,
    () => undefined,
  );
  return await current;
}

export async function prepareTurnkeyReviewedTransaction(params: {
  request: WalletProviderPrepareTxRequest;
  signerAddress: string;
  rpcUrl: string;
  authorizationContext: string;
  env?: NodeJS.ProcessEnv;
}): Promise<TurnkeyReviewedPrepareResult> {
  const env = params.env ?? process.env;
  const approvalRequestId = params.request.requestId?.trim();
  if (!approvalRequestId) {
    throw new WalletProviderError({
      code: "wallet_provider_invalid_config",
      message: "Turnkey preparation requires a stable approval request ID",
    });
  }
  const requestDigest = computeReviewedSolanaRequestDigest({
    request: params.request,
    signer: params.signerAddress.trim(),
  });
  const expectedRpcUrlDigest = normalizedRpcUrlDigest(params.rpcUrl);
  const expectedAuthorizationContextDigest = digest(params.authorizationContext);
  const preparedId = preparedIdentity({
    approvalRequestId,
    requestDigest,
    rpcUrlDigest: expectedRpcUrlDigest,
    authorizationContextDigest: expectedAuthorizationContextDigest,
  });
  return await withReviewLock(env, async () => {
    const file = readFile(env);
    const existing = file.reviews.find(
      (review) =>
        review.approvalRequestId === approvalRequestId || review.preparedId === preparedId,
    );
    if (existing) {
      const sameImmutableRequest =
        existing.approvalRequestId === approvalRequestId &&
        secureEqual(existing.preparedId, preparedId) &&
        secureEqual(existing.signer, params.signerAddress.trim()) &&
        secureEqual(existing.requestDigest, requestDigest) &&
        secureEqual(existing.rpcUrlDigest, expectedRpcUrlDigest) &&
        secureEqual(existing.authorizationContextDigest, expectedAuthorizationContextDigest);
      if (!sameImmutableRequest) {
        throw new WalletProviderError({
          code: "wallet_provider_invalid_config",
          message:
            "Turnkey approval request ID is already bound to a different immutable transaction",
          retryable: false,
        });
      }
      if (existing.status === "failed") {
        throw new WalletProviderError({
          code: "wallet_provider_unavailable",
          message: `${existing.failureReason ?? "Turnkey reviewed transaction failed"}; create a new approval request`,
          retryable: false,
        });
      }
      if (existing.status === "prepared" && Date.parse(existing.expiresAt) <= Date.now()) {
        throw new WalletProviderError({
          code: "wallet_provider_invalid_config",
          message: "Turnkey prepared review expired; create a new approval request",
          retryable: false,
        });
      }
      return toPrepareResult(existing);
    }

    const prepared = await buildReviewedSolanaTransaction({
      request: params.request,
      signerAddress: params.signerAddress,
      rpcUrl: params.rpcUrl,
    });
    if (!secureEqual(prepared.signer, params.signerAddress.trim())) {
      throw new WalletProviderError({
        code: "wallet_provider_unavailable",
        message: "Turnkey transaction builder returned a different signer",
      });
    }
    const now = Date.now();
    const record: TurnkeyReviewRecord = {
      approvalRequestId,
      preparedId,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + REVIEW_TTL_MS).toISOString(),
      status: "prepared",
      signer: prepared.signer,
      requestDigest,
      intentDigest: prepared.intentDigest,
      unsignedTxBase64: prepared.unsignedTxBase64,
      messageBase64: prepared.messageBase64,
      recentBlockhash: prepared.recentBlockhash,
      lastValidBlockHeight: prepared.lastValidBlockHeight,
      rpcUrlDigest: expectedRpcUrlDigest,
      authorizationContextDigest: expectedAuthorizationContextDigest,
      simulationUnitsConsumed: prepared.simulation.unitsConsumed,
    };
    file.reviews.push(record);
    saveFile(file, env);
    return toPrepareResult(record);
  });
}

export async function executeTurnkeyReviewedTransaction(params: {
  preparedId: string;
  request: WalletProviderPrepareTxRequest;
  signerAddress: string;
  rpcUrl: string;
  authorizationContext: string;
  sign: (unsignedTxBase64: string) => Promise<string>;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  txHash: string;
  signer: string;
  intentDigest: string;
  idempotent: boolean;
}> {
  const env = params.env ?? process.env;
  const preparedId = params.preparedId.trim();
  if (!preparedId) {
    throw new WalletProviderError({
      code: "wallet_provider_invalid_config",
      message: "Turnkey send requires a prepared review ID",
    });
  }
  return await withReviewLock(env, async () => {
    const file = readFile(env);
    const review = file.reviews.find((record) => record.preparedId === preparedId);
    if (!review) {
      throw new WalletProviderError({
        code: "wallet_provider_invalid_config",
        message: "Turnkey prepared review is unknown; prepare and review the transaction again",
      });
    }
    if (review.status === "broadcast" && review.txHash) {
      return {
        txHash: review.txHash,
        signer: review.signer,
        intentDigest: review.intentDigest,
        idempotent: true,
      };
    }
    if (review.status === "broadcasting" || review.status === "unknown") {
      if (!review.txHash) {
        throw new WalletProviderError({
          code: "wallet_provider_ambiguous",
          message: "Turnkey broadcast is in progress or unknown; do not submit it again",
          retryable: false,
        });
      }
      let reconciled: Awaited<ReturnType<typeof reconcileReviewedSolanaTransaction>>;
      try {
        reconciled = await reconcileReviewedSolanaTransaction({
          rpcUrl: params.rpcUrl,
          expectedTxHash: review.txHash,
          lastValidBlockHeight: review.lastValidBlockHeight,
        });
      } catch {
        throw new WalletProviderError({
          code: "wallet_provider_ambiguous",
          message: `Turnkey broadcast remains unknown; reconcile signature ${review.txHash} before any new send`,
          retryable: false,
        });
      }
      if (reconciled.state === "landed") {
        review.status = "broadcast";
        saveFile(file, env);
        return {
          txHash: review.txHash,
          signer: review.signer,
          intentDigest: review.intentDigest,
          idempotent: true,
        };
      }
      if (reconciled.state === "failed" || reconciled.state === "expired") {
        review.status = "failed";
        review.failureReason =
          reconciled.state === "failed"
            ? reconciled.reason
            : `reviewed transaction expired at block height ${review.lastValidBlockHeight} without landing`;
        saveFile(file, env);
        throw new WalletProviderError({
          code: "wallet_provider_unavailable",
          message: `${review.failureReason}; prepare and review a new transaction`,
          retryable: false,
        });
      }
      throw new WalletProviderError({
        code: "wallet_provider_ambiguous",
        message: `Turnkey broadcast remains pending; reconcile signature ${review.txHash} before any new send`,
        retryable: false,
      });
    }
    if (review.status === "failed") {
      throw new WalletProviderError({
        code: "wallet_provider_unavailable",
        message: `${review.failureReason ?? "Turnkey reviewed transaction failed"}; prepare and review a new transaction`,
        retryable: false,
      });
    }
    if (Date.parse(review.expiresAt) <= Date.now()) {
      throw new WalletProviderError({
        code: "wallet_provider_invalid_config",
        message: "Turnkey prepared review expired; prepare and review a new transaction",
      });
    }
    const expectedRequestDigest = computeReviewedSolanaRequestDigest({
      request: params.request,
      signer: params.signerAddress,
    });
    if (
      (review.approvalRequestId !== undefined &&
        !secureEqual(review.approvalRequestId, params.request.requestId?.trim() ?? "")) ||
      !secureEqual(review.signer, params.signerAddress) ||
      !secureEqual(review.requestDigest, expectedRequestDigest) ||
      !secureEqual(review.rpcUrlDigest, normalizedRpcUrlDigest(params.rpcUrl)) ||
      !secureEqual(review.authorizationContextDigest, digest(params.authorizationContext))
    ) {
      throw new WalletProviderError({
        code: "wallet_provider_invalid_config",
        message: "Turnkey execution context does not match the immutable prepared review",
      });
    }
    const signedTxBase64 = await params.sign(review.unsignedTxBase64);
    const verified = validateReviewedSolanaSignedTransaction({
      unsignedTxBase64: review.unsignedTxBase64,
      signedTxBase64,
      signerAddress: review.signer,
    });
    review.status = "broadcasting";
    review.txHash = verified.txHash;
    review.signedTxBase64 = verified.signedBytes.toString("base64");
    saveFile(file, env);
    try {
      const txHash = await broadcastReviewedSolanaTransaction({
        rpcUrl: params.rpcUrl,
        signedTxBase64: review.signedTxBase64,
        expectedTxHash: verified.txHash,
      });
      review.status = "broadcast";
      review.txHash = txHash;
      saveFile(file, env);
      return {
        txHash,
        signer: review.signer,
        intentDigest: review.intentDigest,
        idempotent: false,
      };
    } catch (error) {
      review.status = "unknown";
      saveFile(file, env);
      throw error;
    }
  });
}
