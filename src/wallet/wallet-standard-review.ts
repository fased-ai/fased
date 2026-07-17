import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { withFileLock } from "../infra/file-lock.js";
import { fetchSolanaRpc } from "./solana-assets.js";
import {
  broadcastReviewedSolanaTransaction,
  buildReviewedSolanaTransaction,
  computeReviewedSolanaRequestDigest,
  reconcileReviewedSolanaTransaction,
  validateReviewedSolanaSignedTransaction,
} from "./solana-reviewed-transaction.js";
import { WalletProviderError } from "./wallet-provider-adapter.js";
import { ensureWalletStateDir } from "./wallet-runtime-config.js";
import type { WalletSendApprovalPayload } from "./wallet-send-approvals.js";

const REVIEW_FILE_NAME = "wallet-standard-reviews.v1.json";
const REVIEW_TTL_MS = 2 * 60 * 1000;
const REVIEW_FILE_MODE = 0o600;
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
const SOLANA_MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOLANA_DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1";

type WalletStandardReviewStatus = "prepared" | "broadcasting" | "broadcast" | "failed" | "unknown";

type WalletStandardReviewRecord = {
  requestId: string;
  preparedId: string;
  createdAt: string;
  expiresAt: string;
  status: WalletStandardReviewStatus;
  signer: string;
  requestDigest: string;
  intentDigest: string;
  unsignedTxBase64: string;
  messageBase64: string;
  recentBlockhash: string;
  lastValidBlockHeight: number;
  chain: "solana:mainnet" | "solana:devnet";
  rpcUrlDigest: string;
  simulationUnitsConsumed?: number;
  txHash?: string;
  signedTxBase64?: string;
  failureReason?: string;
};

type WalletStandardReviewFile = {
  version: 1;
  reviews: WalletStandardReviewRecord[];
};

export type WalletStandardReviewPrepareResult = {
  requestId: string;
  preparedId: string;
  signer: string;
  unsignedTxBase64: string;
  messageBase64: string;
  intentDigest: string;
  expiresAt: string;
  chain: "solana:mainnet" | "solana:devnet";
  simulation: { ok: true; unitsConsumed?: number };
};

let reviewStateLock: Promise<unknown> = Promise.resolve();

function reviewPath(env: NodeJS.ProcessEnv): string {
  return path.join(ensureWalletStateDir(env).rootDir, REVIEW_FILE_NAME);
}

function readFile(env: NodeJS.ProcessEnv): WalletStandardReviewFile {
  const filePath = reviewPath(env);
  if (!fs.existsSync(filePath)) {
    return { version: 1, reviews: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as WalletStandardReviewFile;
    if (parsed.version === 1 && Array.isArray(parsed.reviews)) {
      return parsed;
    }
  } catch {
    // Treat corrupt state as unavailable rather than trusting partial authorization data.
  }
  throw new WalletProviderError({
    code: "wallet_provider_unavailable",
    message: "Wallet Standard review state is invalid; repair it before approving Vault sends",
    retryable: false,
  });
}

function saveFile(file: WalletStandardReviewFile, env: NodeJS.ProcessEnv): void {
  const filePath = reviewPath(env);
  const temporary = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, "wx", REVIEW_FILE_MODE);
    fs.writeFileSync(descriptor, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, filePath);
    try {
      fs.chmodSync(filePath, REVIEW_FILE_MODE);
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

function rpcUrlDigest(rpcUrl: string): string {
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
      message: "Wallet Standard review requires a valid HTTP(S) Solana RPC URL",
    });
  }
  return createHash("sha256").update(normalized, "utf8").digest("base64url");
}

async function resolveWalletStandardChain(
  rpcUrl: string,
): Promise<"solana:mainnet" | "solana:devnet"> {
  const genesisHash = await fetchSolanaRpc<string>(rpcUrl, "getGenesisHash", []);
  if (genesisHash === SOLANA_MAINNET_GENESIS_HASH) {
    return "solana:mainnet";
  }
  if (genesisHash === SOLANA_DEVNET_GENESIS_HASH) {
    return "solana:devnet";
  }
  throw new WalletProviderError({
    code: "wallet_provider_invalid_config",
    message: "Hardware Vault supports only verified Solana mainnet or devnet RPC endpoints",
  });
}

async function withReviewLock<T>(env: NodeJS.ProcessEnv, task: () => Promise<T>): Promise<T> {
  const run = async () =>
    await withFileLock(reviewPath(env), REVIEW_LOCK_OPTIONS, async () => await task());
  const current = reviewStateLock.then(run, run);
  reviewStateLock = current.then(
    () => undefined,
    () => undefined,
  );
  return await current;
}

function toPrepareResult(record: WalletStandardReviewRecord): WalletStandardReviewPrepareResult {
  return {
    requestId: record.requestId,
    preparedId: record.preparedId,
    signer: record.signer,
    unsignedTxBase64: record.unsignedTxBase64,
    messageBase64: record.messageBase64,
    intentDigest: record.intentDigest,
    expiresAt: record.expiresAt,
    chain: record.chain,
    simulation: {
      ok: true,
      ...(typeof record.simulationUnitsConsumed === "number" &&
      Number.isFinite(record.simulationUnitsConsumed)
        ? { unitsConsumed: record.simulationUnitsConsumed }
        : {}),
    },
  };
}

export async function prepareWalletStandardReview(params: {
  requestId: string;
  payload: WalletSendApprovalPayload;
  signerAddress: string;
  rpcUrl: string;
  env?: NodeJS.ProcessEnv;
}): Promise<WalletStandardReviewPrepareResult> {
  const env = params.env ?? process.env;
  const requestId = params.requestId.trim();
  if (!requestId) {
    throw new WalletProviderError({
      code: "wallet_provider_invalid_config",
      message: "Wallet Standard review requires an approval request ID",
    });
  }
  return await withReviewLock(env, async () => {
    const requestDigest = computeReviewedSolanaRequestDigest({
      request: params.payload,
      signer: params.signerAddress.trim(),
    });
    const expectedRpcUrlDigest = rpcUrlDigest(params.rpcUrl);
    const file = readFile(env);
    const existing = file.reviews.find((review) => review.requestId === requestId);
    if (existing) {
      const sameRequest =
        Boolean(existing.requestDigest) && secureEqual(existing.requestDigest, requestDigest);
      const sameRpc =
        Boolean(existing.rpcUrlDigest) && secureEqual(existing.rpcUrlDigest, expectedRpcUrlDigest);
      if (
        sameRequest &&
        sameRpc &&
        existing.status === "prepared" &&
        Date.parse(existing.expiresAt) > Date.now()
      ) {
        return toPrepareResult(existing);
      }
      throw new WalletProviderError({
        code:
          existing.status === "broadcasting" || existing.status === "unknown"
            ? "wallet_provider_ambiguous"
            : "wallet_provider_invalid_config",
        message:
          "This approval request ID already has an immutable Wallet Standard review; create a new approval request",
        retryable: false,
      });
    }
    const chain = await resolveWalletStandardChain(params.rpcUrl);
    const prepared = await buildReviewedSolanaTransaction({
      request: params.payload,
      signerAddress: params.signerAddress,
      rpcUrl: params.rpcUrl,
    });
    const now = Date.now();
    const record: WalletStandardReviewRecord = {
      requestId,
      preparedId: randomBytes(32).toString("base64url"),
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
      chain,
      rpcUrlDigest: expectedRpcUrlDigest,
      simulationUnitsConsumed: prepared.simulation.unitsConsumed,
    };
    file.reviews.push(record);
    saveFile(file, env);
    return toPrepareResult(record);
  });
}

async function executeLocked(params: {
  requestId: string;
  preparedId: string;
  intentDigest: string;
  signedTxBase64: string;
  rpcUrl: string;
  env: NodeJS.ProcessEnv;
}): Promise<{ ok: true; txHash: string; signer: string; idempotent: boolean }> {
  const file = readFile(params.env);
  const review = file.reviews.find((entry) => entry.requestId === params.requestId);
  if (!review || !secureEqual(review.preparedId, params.preparedId)) {
    throw new WalletProviderError({
      code: "wallet_provider_invalid_config",
      message: "Wallet Standard review is missing or does not match this approval",
    });
  }
  if (!secureEqual(review.intentDigest, params.intentDigest)) {
    throw new WalletProviderError({
      code: "wallet_provider_invalid_config",
      message: "Wallet Standard intent digest does not match the approved transaction",
    });
  }
  if (!review.rpcUrlDigest || !secureEqual(review.rpcUrlDigest, rpcUrlDigest(params.rpcUrl))) {
    throw new WalletProviderError({
      code: "wallet_provider_invalid_config",
      message: "Solana RPC configuration changed after review; approve again",
    });
  }
  if (review.status === "broadcast" && review.txHash) {
    return { ok: true, txHash: review.txHash, signer: review.signer, idempotent: true };
  }
  if (review.status === "broadcasting" || review.status === "unknown") {
    if (!review.txHash) {
      throw new WalletProviderError({
        code: "wallet_provider_ambiguous",
        message:
          "Hardware-wallet broadcast is already in progress or unknown; do not submit it again",
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
        message: `Hardware-wallet broadcast remains unknown; reconcile signature ${review.txHash} before any new send`,
        retryable: false,
      });
    }
    if (reconciled.state === "landed") {
      review.status = "broadcast";
      saveFile(file, params.env);
      return { ok: true, txHash: review.txHash, signer: review.signer, idempotent: true };
    }
    if (reconciled.state === "failed" || reconciled.state === "expired") {
      review.status = "failed";
      review.failureReason =
        reconciled.state === "failed"
          ? reconciled.reason
          : `reviewed transaction expired at block height ${review.lastValidBlockHeight} without landing`;
      saveFile(file, params.env);
      throw new WalletProviderError({
        code: "wallet_provider_unavailable",
        message: `${review.failureReason}; create and approve a new Wallet Standard review`,
        retryable: false,
      });
    }
    throw new WalletProviderError({
      code: "wallet_provider_ambiguous",
      message: `Hardware-wallet broadcast remains pending; reconcile signature ${review.txHash} before any new send`,
      retryable: false,
    });
  }
  if (review.status === "failed") {
    throw new WalletProviderError({
      code: "wallet_provider_unavailable",
      message: `${review.failureReason ?? "Wallet Standard transaction failed"}; create and approve a new Wallet Standard review`,
      retryable: false,
    });
  }
  if (Date.parse(review.expiresAt) <= Date.now()) {
    throw new WalletProviderError({
      code: "wallet_provider_invalid_config",
      message: "Hardware-wallet review expired; approve again to receive a fresh blockhash",
    });
  }
  const verified = validateReviewedSolanaSignedTransaction({
    unsignedTxBase64: review.unsignedTxBase64,
    signedTxBase64: params.signedTxBase64,
    signerAddress: review.signer,
  });
  review.status = "broadcasting";
  review.txHash = verified.txHash;
  review.signedTxBase64 = verified.signedBytes.toString("base64");
  saveFile(file, params.env);
  try {
    const txHash = await broadcastReviewedSolanaTransaction({
      rpcUrl: params.rpcUrl,
      signedTxBase64: review.signedTxBase64,
      expectedTxHash: verified.txHash,
    });
    review.status = "broadcast";
    review.txHash = txHash;
    saveFile(file, params.env);
    return { ok: true, txHash, signer: review.signer, idempotent: false };
  } catch (error) {
    review.status = "unknown";
    saveFile(file, params.env);
    throw error;
  }
}

export async function executeWalletStandardReview(params: {
  requestId: string;
  preparedId: string;
  intentDigest: string;
  signedTxBase64: string;
  rpcUrl: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ ok: true; txHash: string; signer: string; idempotent: boolean }> {
  const env = params.env ?? process.env;
  const requestId = params.requestId.trim();
  return await withReviewLock(env, async () => await executeLocked({ ...params, requestId, env }));
}

export function readWalletStandardReviewTxHash(params: {
  requestId: string;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  const file = readFile(params.env ?? process.env);
  return file.reviews.find((review) => review.requestId === params.requestId.trim())?.txHash;
}
