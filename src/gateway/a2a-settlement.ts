import type { FederationPublishedOffer } from "../federation/offers.js";
import { isValidSolanaAddress } from "../wallet/solana-address.js";
import { fetchSolanaRpc } from "../wallet/solana-assets.js";
import { resolveScopedRpcUrlForWallet } from "../wallet/wallet-provider-resolver.js";
import type { DurableA2aPaymentChallenge } from "./a2a-task-store.js";

const A2A_PAYMENT_MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, field: string): string {
  return typeof record[field] === "string" ? record[field].trim() : "";
}

function recordsEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function canonicalAsset(value: unknown): { kind: "native" | "spl-token"; address?: string } | null {
  if (!isRecord(value)) {
    return null;
  }
  const kind = stringField(value, "kind").toLowerCase();
  if (kind === "native") {
    return { kind };
  }
  const address = stringField(value, "address");
  if (kind === "spl-token" && isValidSolanaAddress(address)) {
    return { kind, address };
  }
  return null;
}

function canonicalWallet(value: unknown): { chain: "solana"; address: string } | null {
  if (!isRecord(value) || stringField(value, "chain").toLowerCase() !== "solana") {
    return null;
  }
  const address = stringField(value, "address");
  return isValidSolanaAddress(address) ? { chain: "solana", address } : null;
}

function positiveSafeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function offerAmountInBaseUnits(offer: FederationPublishedOffer): number | null {
  const amount = offer.pricing.amount;
  const decimals = offer.paymentDefaults?.assetDecimals;
  if (
    typeof amount !== "number" ||
    !Number.isFinite(amount) ||
    amount <= 0 ||
    typeof decimals !== "number" ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 18
  ) {
    return null;
  }
  const scaled = amount * 10 ** decimals;
  const rounded = Math.round(scaled);
  return Number.isSafeInteger(rounded) && Math.abs(scaled - rounded) < 1e-6 ? rounded : null;
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

type ParsedInstruction = {
  program?: unknown;
  programId?: unknown;
  parsed?: unknown;
};

type ParsedTransaction = {
  blockTime?: number | null;
  meta?: {
    err?: unknown;
    preBalances?: number[];
    postBalances?: number[];
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
    innerInstructions?: Array<{ instructions?: ParsedInstruction[] }>;
  };
  transaction?: {
    message?: {
      accountKeys?: Array<string | { pubkey?: string }>;
      instructions?: ParsedInstruction[];
    };
  };
};

type TokenBalance = {
  accountIndex?: number;
  mint?: string;
  owner?: string;
  uiTokenAmount?: { amount?: string };
};

function accountKeyStrings(transaction: ParsedTransaction): string[] {
  return (transaction.transaction?.message?.accountKeys ?? []).map((key) =>
    typeof key === "string" ? key : String(key.pubkey ?? ""),
  );
}

function parsedInstructions(transaction: ParsedTransaction): ParsedInstruction[] {
  return [
    ...(transaction.transaction?.message?.instructions ?? []),
    ...(transaction.meta?.innerInstructions ?? []).flatMap((entry) => entry.instructions ?? []),
  ];
}

function hasExactNativeTransfer(params: {
  transaction: ParsedTransaction;
  payer: string;
  payee: string;
  amount: number;
}): boolean {
  return parsedInstructions(params.transaction).some((instruction) => {
    const parsed = isRecord(instruction.parsed) ? instruction.parsed : null;
    if (instruction.program !== "system" || parsed?.type !== "transfer") {
      return false;
    }
    const info = isRecord(parsed.info) ? parsed.info : null;
    return (
      info?.source === params.payer &&
      info?.destination === params.payee &&
      positiveSafeInteger(info?.lamports) === params.amount
    );
  });
}

function balanceAmount(entry: TokenBalance | undefined): bigint {
  const value = entry?.uiTokenAmount?.amount;
  return typeof value === "string" && /^\d+$/u.test(value) ? BigInt(value) : 0n;
}

function tokenBalanceFor(params: {
  balances: TokenBalance[];
  accountIndex: number;
  mint: string;
  owner: string;
}): TokenBalance | undefined {
  return params.balances.find(
    (entry) =>
      entry.accountIndex === params.accountIndex &&
      entry.mint === params.mint &&
      entry.owner === params.owner,
  );
}

function hasExactTokenTransfer(params: {
  transaction: ParsedTransaction;
  payer: string;
  payee: string;
  mint: string;
  amount: number;
}): boolean {
  const keys = accountKeyStrings(params.transaction);
  const pre = params.transaction.meta?.preTokenBalances ?? [];
  const post = params.transaction.meta?.postTokenBalances ?? [];
  const expected = BigInt(params.amount);
  return parsedInstructions(params.transaction).some((instruction) => {
    if (instruction.program !== "spl-token") {
      return false;
    }
    const parsed = isRecord(instruction.parsed) ? instruction.parsed : null;
    const parsedType = parsed?.type;
    if (parsedType !== "transfer" && parsedType !== "transferChecked") {
      return false;
    }
    const info = isRecord(parsed?.info) ? parsed.info : null;
    if (!info || info.authority !== params.payer) {
      return false;
    }
    const instructionAmount =
      positiveSafeInteger(info.amount) ??
      (isRecord(info.tokenAmount) ? positiveSafeInteger(Number(info.tokenAmount.amount)) : null);
    if (instructionAmount !== params.amount) {
      return false;
    }
    const sourceIndex = keys.indexOf(stringField(info, "source"));
    const destinationIndex = keys.indexOf(stringField(info, "destination"));
    if (sourceIndex < 0 || destinationIndex < 0) {
      return false;
    }
    const sourcePre = tokenBalanceFor({
      balances: pre,
      accountIndex: sourceIndex,
      mint: params.mint,
      owner: params.payer,
    });
    const sourcePost = tokenBalanceFor({
      balances: post,
      accountIndex: sourceIndex,
      mint: params.mint,
      owner: params.payer,
    });
    const destinationPre = tokenBalanceFor({
      balances: pre,
      accountIndex: destinationIndex,
      mint: params.mint,
      owner: params.payee,
    });
    const destinationPost = tokenBalanceFor({
      balances: post,
      accountIndex: destinationIndex,
      mint: params.mint,
      owner: params.payee,
    });
    return (
      Boolean(sourcePre && sourcePost && destinationPost) &&
      balanceAmount(sourcePre) - balanceAmount(sourcePost) === expected &&
      balanceAmount(destinationPost) - balanceAmount(destinationPre) === expected
    );
  });
}

function hasExactPaymentMemo(transaction: ParsedTransaction, expected: string): boolean {
  return parsedInstructions(transaction).some((instruction) => {
    const isMemoProgram =
      instruction.program === "spl-memo" || instruction.programId === A2A_PAYMENT_MEMO_PROGRAM;
    if (!isMemoProgram) {
      return false;
    }
    if (typeof instruction.parsed === "string") {
      return instruction.parsed === expected;
    }
    const parsed = isRecord(instruction.parsed) ? instruction.parsed : null;
    return parsed?.memo === expected || parsed?.info === expected;
  });
}

export type A2aSettlementResult = {
  status: "skipped" | "queued" | "executed" | "failed";
  mode?: "manual" | "autonomous";
  requestId?: string;
  txHash?: string;
  invoiceId?: string;
  chain?: "solana";
  amount?: string;
  challengeId?: string;
  payerAddress?: string;
  paymentMemo?: string;
  reason?: string;
};

type A2aSettlementDeps = {
  fetchSolanaRpc: typeof fetchSolanaRpc;
  now: () => number;
  resolveRpcUrl: (env: NodeJS.ProcessEnv) => string | undefined;
};

const DEFAULT_DEPS: A2aSettlementDeps = {
  fetchSolanaRpc,
  now: Date.now,
  resolveRpcUrl: (env) => resolveScopedRpcUrlForWallet({ env, chains: ["solana"] }),
};

export async function orchestrateA2aTaskSettlement(params: {
  taskId: string;
  taskInput: unknown;
  invoice: unknown;
  receipt: unknown;
  offer: FederationPublishedOffer | null;
  challenge: DurableA2aPaymentChallenge | null;
  senderHandle: string;
  env?: NodeJS.ProcessEnv;
  deps?: Partial<A2aSettlementDeps>;
}): Promise<A2aSettlementResult> {
  const deps = { ...DEFAULT_DEPS, ...params.deps };
  const env = params.env ?? process.env;
  const task = isRecord(params.taskInput) ? params.taskInput : null;
  const invoice = isRecord(params.invoice) ? params.invoice : null;
  const receipt = isRecord(params.receipt) ? params.receipt : null;
  const offer = params.offer;
  const fail = (reason: string): A2aSettlementResult => ({ status: "failed", reason });
  const challenge = params.challenge;
  if (!task || !invoice || !receipt || !offer || !offer.paymentDefaults || !challenge) {
    return fail(
      "paid task requires a seller-issued challenge, known offer, and complete invoice and receipt evidence",
    );
  }
  if (stringField(task, "taskId") !== params.taskId) {
    return fail("task.taskId must match the durable task identity");
  }
  const offerIds = [task, invoice, receipt].map((entry) => stringField(entry, "offerId"));
  if (offerIds.some((value) => value !== offer.id)) {
    return fail("task, invoice, and receipt must bind the exact seller offerId");
  }
  const invoiceId = stringField(invoice, "invoiceId");
  const receiptId = stringField(receipt, "receiptId");
  if (
    !invoiceId ||
    !receiptId ||
    stringField(task, "invoice") !== invoiceId ||
    stringField(task, "receipt") !== receiptId ||
    stringField(receipt, "invoiceId") !== invoiceId ||
    stringField(invoice, "taskId") !== params.taskId ||
    stringField(receipt, "taskId") !== params.taskId
  ) {
    return fail("invoice and receipt identities are not bound to the task");
  }
  if (
    challenge.taskId !== params.taskId ||
    challenge.senderHandle !== params.senderHandle.trim().toLowerCase() ||
    challenge.offerId !== offer.id ||
    challenge.invoiceId !== invoiceId ||
    challenge.receiptId !== receiptId ||
    challenge.challengeId !== stringField(invoice, "challengeId") ||
    challenge.challengeId !== stringField(receipt, "challengeId") ||
    challenge.paymentMemo !== stringField(invoice, "paymentMemo") ||
    challenge.paymentMemo !== stringField(receipt, "paymentMemo")
  ) {
    return fail("payment evidence does not match the seller-issued challenge");
  }
  const expectedAmount = offerAmountInBaseUnits(offer);
  if (!expectedAmount) {
    return fail("seller offer must define a positive fixed price before paid execution");
  }
  const invoiceAmount = positiveSafeInteger(invoice.amount);
  const receiptAmount = positiveSafeInteger(receipt.amount);
  if (invoiceAmount !== expectedAmount || receiptAmount !== expectedAmount) {
    return fail("invoice and receipt amount must equal the seller offer price");
  }
  if (challenge.amount !== expectedAmount) {
    return fail("seller-issued challenge amount no longer matches the offer");
  }
  const expectedCurrency = offer.paymentDefaults.currency.trim().toUpperCase();
  if (
    stringField(invoice, "currency").toUpperCase() !== expectedCurrency ||
    stringField(receipt, "currency").toUpperCase() !== expectedCurrency ||
    stringField(invoice, "chain").toLowerCase() !== "solana" ||
    stringField(receipt, "chain").toLowerCase() !== "solana"
  ) {
    return fail("invoice and receipt payment rail does not match the seller offer");
  }
  if (challenge.currency !== expectedCurrency) {
    return fail("seller-issued challenge currency no longer matches the offer");
  }
  const expectedAsset = canonicalAsset(offer.paymentDefaults.asset);
  const invoiceAsset = canonicalAsset(invoice.asset);
  const receiptAsset = canonicalAsset(receipt.asset);
  if (
    !expectedAsset ||
    !recordsEqual(invoiceAsset, expectedAsset) ||
    !recordsEqual(receiptAsset, expectedAsset)
  ) {
    return fail("invoice and receipt asset does not match the seller offer");
  }
  if (!recordsEqual(challenge.asset, expectedAsset)) {
    return fail("seller-issued challenge asset no longer matches the offer");
  }
  const expectedPayee = canonicalWallet(offer.paymentDefaults.payee);
  const invoicePayee = canonicalWallet(invoice.payee);
  const receiptPayee = canonicalWallet(receipt.payee);
  const payer = canonicalWallet(receipt.payer);
  if (
    !expectedPayee ||
    !payer ||
    !recordsEqual(invoicePayee, expectedPayee) ||
    !recordsEqual(receiptPayee, expectedPayee) ||
    payer.address === expectedPayee.address
  ) {
    return fail("invoice or receipt payer/payee is invalid");
  }
  if (
    challenge.payerAddress !== payer.address ||
    challenge.payeeAddress !== expectedPayee.address
  ) {
    return fail("payment payer/payee does not match the seller-issued challenge");
  }
  const issuedAt = parseTimestamp(invoice.issuedAt);
  const expiresAt = parseTimestamp(invoice.expiresAt);
  const settledAt = parseTimestamp(receipt.settledAt);
  const now = deps.now();
  if (
    issuedAt === null ||
    expiresAt === null ||
    settledAt === null ||
    issuedAt !== Date.parse(challenge.issuedAt) ||
    expiresAt !== Date.parse(challenge.expiresAt) ||
    issuedAt >= expiresAt ||
    settledAt < issuedAt ||
    settledAt > expiresAt ||
    now > expiresAt
  ) {
    return fail("invoice or receipt timestamp is invalid or expired");
  }
  const txRef = stringField(receipt, "txRef");
  if (!/^[1-9A-HJ-NP-Za-km-z]{80,100}$/u.test(txRef)) {
    return fail("receipt.txRef must be a Solana transaction signature");
  }
  const rpcUrl = deps.resolveRpcUrl(env);
  if (!rpcUrl) {
    return fail("seller Solana RPC is not configured; payment cannot be verified");
  }
  const transaction = await deps.fetchSolanaRpc<ParsedTransaction>(rpcUrl, "getTransaction", [
    txRef,
    { commitment: "finalized", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
  ]);
  if (!transaction || !transaction.meta || transaction.meta.err != null) {
    return fail("payment transaction is unavailable, not finalized, or failed");
  }
  const blockTimeMs =
    typeof transaction.blockTime === "number" && Number.isSafeInteger(transaction.blockTime)
      ? transaction.blockTime * 1000
      : null;
  if (
    blockTimeMs === null ||
    blockTimeMs < issuedAt ||
    blockTimeMs > expiresAt ||
    blockTimeMs > now + 60_000
  ) {
    return fail("finalized payment block time is outside the seller-issued challenge window");
  }
  if (!hasExactPaymentMemo(transaction, challenge.paymentMemo)) {
    return fail("finalized payment does not contain the exact seller-issued challenge memo");
  }
  const paymentMatches =
    expectedAsset.kind === "native"
      ? hasExactNativeTransfer({
          transaction,
          payer: payer.address,
          payee: expectedPayee.address,
          amount: expectedAmount,
        })
      : hasExactTokenTransfer({
          transaction,
          payer: payer.address,
          payee: expectedPayee.address,
          mint: expectedAsset.address!,
          amount: expectedAmount,
        });
  if (!paymentMatches) {
    return fail("finalized transaction does not contain the exact expected seller payment");
  }
  return {
    status: "executed",
    txHash: txRef,
    invoiceId,
    chain: "solana",
    amount: String(expectedAmount),
    challengeId: challenge.challengeId,
    payerAddress: payer.address,
    paymentMemo: challenge.paymentMemo,
  };
}
