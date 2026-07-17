import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { fetchSolanaMintInfoViaRpc, fetchSolanaRpc } from "./solana-assets.js";
import {
  buildCreateAssociatedTokenAccountIdempotentInstruction,
  buildTransferCheckedInstruction,
  deriveAssociatedTokenAddress,
  toTransactionInstruction,
} from "./solana-spl-transfer.js";
import {
  WalletProviderError,
  type WalletProviderPrepareTxRequest,
} from "./wallet-provider-adapter.js";

const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const MAX_TRANSACTION_BYTES = 1_232;
const MAX_MEMO_BYTES = 256;
const MAX_U64 = (1n << 64n) - 1n;
const INTENT_DOMAIN = "FasedAgent reviewed Solana transaction v1\0";
const REQUEST_DOMAIN = "FasedAgent reviewed Solana request v1\0";

type LatestBlockhashResult = {
  value?: {
    blockhash?: string;
    lastValidBlockHeight?: number;
  };
};

type SimulationResult = {
  value?: {
    err?: unknown;
    logs?: string[];
    unitsConsumed?: number;
  };
};

type SignatureStatusResult = {
  value?: Array<{
    err?: unknown;
    confirmationStatus?: "processed" | "confirmed" | "finalized";
    confirmations?: number | null;
    slot?: number;
  } | null>;
};

export type ReviewedSolanaReconciliation =
  | { state: "landed"; confirmationStatus: "processed" | "confirmed" | "finalized" }
  | { state: "failed"; reason: string }
  | { state: "expired"; blockHeight: number }
  | { state: "pending"; blockHeight: number };

export type ReviewedSolanaTransaction = {
  unsignedTxBase64: string;
  messageBase64: string;
  intentDigest: string;
  signer: string;
  recentBlockhash: string;
  lastValidBlockHeight: number;
  simulation: {
    ok: true;
    unitsConsumed?: number;
  };
};

function invalid(message: string): WalletProviderError {
  return new WalletProviderError({
    code: "wallet_provider_invalid_config",
    message,
  });
}

function unavailable(message: string): WalletProviderError {
  return new WalletProviderError({
    code: "wallet_provider_unavailable",
    message,
    retryable: false,
  });
}

function parsePositiveAmount(raw: string | undefined): bigint {
  const value = String(raw ?? "").trim();
  if (!/^\d+$/.test(value)) {
    throw invalid("reviewed Solana transfer amount must be a positive base-unit integer");
  }
  const amount = BigInt(value);
  if (amount <= 0n || amount > MAX_U64) {
    throw invalid("reviewed Solana transfer amount is outside the supported u64 range");
  }
  return amount;
}

function parsePublicKey(value: string | undefined, label: string): PublicKey {
  try {
    return new PublicKey(String(value ?? "").trim());
  } catch {
    throw invalid(`${label} is not a valid Solana address`);
  }
}

function normalizeRpcUrl(rpcUrl: string): string {
  const value = rpcUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw invalid("Solana RPC URL is invalid");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw invalid("Solana RPC URL must use HTTPS or HTTP");
  }
  return parsed.toString();
}

async function fetchStrictSolanaRpc<T>(
  rpcUrl: string,
  method: string,
  params: unknown[],
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(normalizeRpcUrl(rpcUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  } catch {
    throw unavailable(`Solana RPC ${method} reconciliation request failed`);
  }
  if (!response.ok) {
    throw unavailable(`Solana RPC ${method} reconciliation request failed`);
  }
  let payload: { result?: T; error?: unknown };
  try {
    payload = (await response.json()) as { result?: T; error?: unknown };
  } catch {
    throw unavailable(`Solana RPC ${method} reconciliation returned invalid JSON`);
  }
  if (payload.error != null || !("result" in payload)) {
    throw unavailable(`Solana RPC ${method} reconciliation returned an error`);
  }
  return payload.result as T;
}

function canonicalIntent(params: {
  request: WalletProviderPrepareTxRequest;
  signer: string;
  messageBase64: string;
}): string {
  return JSON.stringify({
    version: 1,
    chain: "solana",
    signer: params.signer,
    to: String(params.request.to ?? "").trim(),
    amount: String(params.request.amount ?? "").trim(),
    mint: String(params.request.program ?? params.request.tokenMint ?? "").trim() || null,
    memo: String(params.request.memo ?? "").trim() || null,
    messageBase64: params.messageBase64,
  });
}

function canonicalRequest(params: {
  request: WalletProviderPrepareTxRequest;
  signer: string;
}): string {
  return JSON.stringify({
    version: 1,
    chain: params.request.chain,
    signer: params.signer,
    to: String(params.request.to ?? "").trim(),
    amount: String(params.request.amount ?? "").trim(),
    mint: String(params.request.program ?? params.request.tokenMint ?? "").trim() || null,
    memo: String(params.request.memo ?? "").trim() || null,
  });
}

export function computeReviewedSolanaRequestDigest(params: {
  request: WalletProviderPrepareTxRequest;
  signer: string;
}): string {
  return createHash("sha256")
    .update(REQUEST_DOMAIN, "utf8")
    .update(canonicalRequest(params), "utf8")
    .digest("base64url");
}

export function computeReviewedSolanaIntentDigest(params: {
  request: WalletProviderPrepareTxRequest;
  signer: string;
  messageBase64: string;
}): string {
  return createHash("sha256")
    .update(INTENT_DOMAIN, "utf8")
    .update(canonicalIntent(params), "utf8")
    .digest("base64url");
}

async function buildTransferInstructions(params: {
  request: WalletProviderPrepareTxRequest;
  rpcUrl: string;
  signer: PublicKey;
  destination: PublicKey;
  amount: bigint;
}): Promise<TransactionInstruction[]> {
  const mint = String(params.request.program ?? params.request.tokenMint ?? "").trim();
  if (!mint) {
    if (params.amount > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw invalid("native SOL transfer exceeds JavaScript safe integer range");
    }
    return [
      SystemProgram.transfer({
        fromPubkey: params.signer,
        toPubkey: params.destination,
        lamports: Number(params.amount),
      }),
    ];
  }
  parsePublicKey(mint, "SPL mint");
  const mintInfo = await fetchSolanaMintInfoViaRpc({ rpcUrl: params.rpcUrl, mint });
  if (!mintInfo) {
    throw unavailable("Solana RPC could not resolve the SPL mint owner and decimals");
  }
  const sourceTokenAccount = await deriveAssociatedTokenAddress({
    owner: params.signer.toBase58(),
    mint,
    tokenProgramId: mintInfo.tokenProgramId,
  });
  const destinationTokenAccount = await deriveAssociatedTokenAddress({
    owner: params.destination.toBase58(),
    mint,
    tokenProgramId: mintInfo.tokenProgramId,
  });
  return [
    await toTransactionInstruction(
      await buildCreateAssociatedTokenAccountIdempotentInstruction({
        payer: params.signer.toBase58(),
        owner: params.destination.toBase58(),
        mint,
        tokenProgramId: mintInfo.tokenProgramId,
      }),
    ),
    await toTransactionInstruction(
      buildTransferCheckedInstruction({
        sourceTokenAccount,
        mint,
        destinationTokenAccount,
        authority: params.signer.toBase58(),
        amountRaw: params.amount.toString(),
        decimals: mintInfo.decimals,
        tokenProgramId: mintInfo.tokenProgramId,
      }),
    ),
  ];
}

function appendMemo(transaction: Transaction, memo: string | undefined, signer: PublicKey): void {
  const normalized = String(memo ?? "").trim();
  if (!normalized) {
    return;
  }
  const bytes = Buffer.from(normalized, "utf8");
  if (bytes.length > MAX_MEMO_BYTES) {
    throw invalid(`Solana memo must not exceed ${MAX_MEMO_BYTES} UTF-8 bytes`);
  }
  transaction.add(
    new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [{ pubkey: signer, isSigner: true, isWritable: false }],
      data: bytes,
    }),
  );
}

export async function buildReviewedSolanaTransaction(params: {
  request: WalletProviderPrepareTxRequest;
  signerAddress: string;
  rpcUrl: string;
}): Promise<ReviewedSolanaTransaction> {
  if (params.request.chain !== "solana") {
    throw new WalletProviderError({
      code: "wallet_provider_unsupported_chain",
      message: "reviewed transaction builder supports Solana only",
    });
  }
  if (params.request.serializedTxBase64?.trim()) {
    throw invalid("reviewed SOL/SPL sends do not accept caller-supplied serialized transactions");
  }
  const rpcUrl = normalizeRpcUrl(params.rpcUrl);
  const signer = parsePublicKey(params.signerAddress, "signer");
  const destination = parsePublicKey(params.request.to, "destination");
  const amount = parsePositiveAmount(params.request.amount);
  const latest = await fetchSolanaRpc<LatestBlockhashResult>(rpcUrl, "getLatestBlockhash", [
    { commitment: "confirmed" },
  ]);
  const recentBlockhash = String(latest?.value?.blockhash ?? "").trim();
  const lastValidBlockHeight = Number(latest?.value?.lastValidBlockHeight);
  if (!recentBlockhash || !Number.isSafeInteger(lastValidBlockHeight)) {
    throw unavailable("Solana RPC did not return a valid recent blockhash");
  }
  const transaction = new Transaction({
    feePayer: signer,
    recentBlockhash,
  });
  transaction.add(
    ...(await buildTransferInstructions({
      request: params.request,
      rpcUrl,
      signer,
      destination,
      amount,
    })),
  );
  appendMemo(transaction, params.request.memo, signer);
  const unsignedBytes = transaction.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  });
  if (unsignedBytes.length > MAX_TRANSACTION_BYTES) {
    throw invalid("reviewed Solana transaction exceeds the network packet limit");
  }
  const unsignedTxBase64 = unsignedBytes.toString("base64");
  const messageBase64 = transaction.serializeMessage().toString("base64");
  const simulation = await fetchSolanaRpc<SimulationResult>(rpcUrl, "simulateTransaction", [
    unsignedTxBase64,
    {
      encoding: "base64",
      commitment: "confirmed",
      sigVerify: false,
      replaceRecentBlockhash: false,
    },
  ]);
  if (!simulation?.value || simulation.value.err != null) {
    throw unavailable("reviewed Solana transaction simulation failed");
  }
  return {
    unsignedTxBase64,
    messageBase64,
    intentDigest: computeReviewedSolanaIntentDigest({
      request: params.request,
      signer: signer.toBase58(),
      messageBase64,
    }),
    signer: signer.toBase58(),
    recentBlockhash,
    lastValidBlockHeight,
    simulation: {
      ok: true,
      ...(Number.isFinite(simulation.value.unitsConsumed)
        ? { unitsConsumed: simulation.value.unitsConsumed }
        : {}),
    },
  };
}

function encodeBase58(bytes: Uint8Array): string {
  if (bytes.length === 0) {
    return "";
  }
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) {
      const value = digits[index] * 256 + carry;
      digits[index] = value % 58;
      carry = Math.floor(value / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let output = "";
  for (const byte of bytes) {
    if (byte !== 0) {
      break;
    }
    output += "1";
  }
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    output += alphabet[digits[index]];
  }
  return output;
}

export function validateReviewedSolanaSignedTransaction(params: {
  unsignedTxBase64: string;
  signedTxBase64: string;
  signerAddress: string;
}): { signedBytes: Buffer; txHash: string } {
  let unsignedTransaction: Transaction;
  let signedTransaction: Transaction;
  let signedBytes: Buffer;
  try {
    const unsignedBytes = Buffer.from(params.unsignedTxBase64, "base64");
    signedBytes = Buffer.from(params.signedTxBase64, "base64");
    if (unsignedBytes.length === 0 || signedBytes.length === 0) {
      throw new Error("empty transaction");
    }
    if (signedBytes.length > MAX_TRANSACTION_BYTES) {
      throw new Error("transaction exceeds packet limit");
    }
    unsignedTransaction = Transaction.from(unsignedBytes);
    signedTransaction = Transaction.from(signedBytes);
  } catch {
    throw invalid("wallet returned an invalid signed Solana transaction");
  }
  const expectedMessage = unsignedTransaction.serializeMessage();
  const actualMessage = signedTransaction.serializeMessage();
  if (
    expectedMessage.length !== actualMessage.length ||
    !timingSafeEqual(expectedMessage, actualMessage)
  ) {
    throw invalid("wallet changed the reviewed Solana transaction intent");
  }
  const expectedSigner = parsePublicKey(params.signerAddress, "signer");
  if (!signedTransaction.feePayer?.equals(expectedSigner)) {
    throw invalid("wallet signed with a different Solana fee payer");
  }
  const signerEntry = signedTransaction.signatures.find((entry) =>
    entry.publicKey.equals(expectedSigner),
  );
  if (!signerEntry?.signature || !signedTransaction.verifySignatures(true)) {
    throw invalid("wallet did not return a valid signature for the reviewed account");
  }
  return {
    signedBytes,
    txHash: encodeBase58(signerEntry.signature),
  };
}

export async function broadcastReviewedSolanaTransaction(params: {
  rpcUrl: string;
  signedTxBase64: string;
  expectedTxHash: string;
}): Promise<string> {
  const rpcUrl = normalizeRpcUrl(params.rpcUrl);
  const txHash = await fetchSolanaRpc<string>(rpcUrl, "sendTransaction", [
    params.signedTxBase64,
    {
      encoding: "base64",
      skipPreflight: false,
      preflightCommitment: "confirmed",
      maxRetries: 0,
    },
  ]);
  if (!txHash) {
    throw new WalletProviderError({
      code: "wallet_provider_ambiguous",
      message: `Solana broadcast result is unknown; reconcile signature ${params.expectedTxHash} before any new send`,
      retryable: false,
    });
  }
  if (txHash !== params.expectedTxHash) {
    throw unavailable(
      "Solana RPC returned a transaction signature that did not match the signed payload",
    );
  }
  return txHash;
}

export async function reconcileReviewedSolanaTransaction(params: {
  rpcUrl: string;
  expectedTxHash: string;
  lastValidBlockHeight: number;
}): Promise<ReviewedSolanaReconciliation> {
  const expectedTxHash = params.expectedTxHash.trim();
  if (!expectedTxHash) {
    throw invalid("Solana reconciliation requires the exact transaction signature");
  }
  if (!Number.isSafeInteger(params.lastValidBlockHeight) || params.lastValidBlockHeight < 0) {
    throw invalid("Solana reconciliation requires a valid last block height");
  }
  const statuses = await fetchStrictSolanaRpc<SignatureStatusResult>(
    params.rpcUrl,
    "getSignatureStatuses",
    [[expectedTxHash], { searchTransactionHistory: true }],
  );
  const status = Array.isArray(statuses?.value) ? statuses.value[0] : undefined;
  if (status) {
    if (status.err != null) {
      return {
        state: "failed",
        reason: "Solana reported a terminal transaction error for the reviewed signature",
      };
    }
    const confirmationStatus =
      status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized"
        ? status.confirmationStatus
        : "processed";
    return { state: "landed", confirmationStatus };
  }
  const blockHeight = await fetchStrictSolanaRpc<number>(params.rpcUrl, "getBlockHeight", [
    { commitment: "confirmed" },
  ]);
  if (!Number.isSafeInteger(blockHeight) || blockHeight < 0) {
    throw unavailable("Solana RPC returned an invalid block height during reconciliation");
  }
  return blockHeight > params.lastValidBlockHeight
    ? { state: "expired", blockHeight }
    : { state: "pending", blockHeight };
}

export function newReviewedSolanaPreparedId(): string {
  return randomBytes(24).toString("base64url");
}
