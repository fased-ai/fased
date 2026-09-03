import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { callLocalSocketSigner } from "../wallet/providers/local-socket-signer-adapter.js";
import { fetchPinnedSolanaRpcRead } from "../wallet/solana-rpc-read-fetch.js";
import type {
  WalletProviderJupiterReviewV2,
  WalletProviderMoneyFoundationIntentV2,
  WalletProviderSignerTransactionEnvelopeV2,
} from "../wallet/wallet-provider-adapter.js";
import { createSignerReviewApprovalRequest } from "../wallet/wallet-send-approvals.js";

export type MoneyFoundationOperation = {
  requestId: string;
  state: "reserved" | "broadcast" | "confirmed" | "failed" | "unknown";
  signature?: string;
  error?: string;
};

export type MoneyFoundationReadback = {
  finalizedSlot: number;
  signature: string;
  accounts: Array<{ address: string; exists: boolean; owner?: string; dataSha256?: string }>;
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function prepareMoneyFoundationTransactionEnvelope(params: {
  transaction: Transaction;
  intent: WalletProviderMoneyFoundationIntentV2;
  walletPublicKey: string;
  positionMintSigner?: Keypair;
}): WalletProviderSignerTransactionEnvelopeV2 {
  const wallet = new PublicKey(params.walletPublicKey).toBase58();
  if (
    params.intent.moneyFoundation.liquidityTreasury !== wallet ||
    params.intent.moneyFoundation.sourceOwner !== wallet
  ) {
    throw new Error("money-foundation transaction is not owned by the selected liquidity treasury");
  }
  if (
    !params.transaction.feePayer?.equals(new PublicKey(wallet)) ||
    !params.transaction.recentBlockhash
  ) {
    throw new Error(
      "money-foundation compiler transaction requires the exact Vault fee payer and recent blockhash",
    );
  }
  if (params.intent.moneyFoundation.action === "ADD_POL") {
    if (
      !params.positionMintSigner ||
      params.positionMintSigner.publicKey.toBase58() !== params.intent.moneyFoundation.positionMint
    ) {
      throw new Error("ADD_POL requires the exact one-use position-mint signer");
    }
    params.transaction.partialSign(params.positionMintSigner);
  } else if (params.positionMintSigner) {
    throw new Error("EMERGENCY_UNWIND rejects an additional position-mint signer");
  }
  const message = params.transaction.compileMessage();
  const programs = [
    ...new Set(
      params.transaction.instructions.map((instruction) => instruction.programId.toBase58()),
    ),
  ].toSorted();
  const writableAccounts = message.accountKeys
    .filter((_, index) => message.isAccountWritable(index))
    .map((key) => key.toBase58())
    .toSorted();
  const serialized = params.transaction.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  });
  return {
    serializedTxBase64: serialized.toString("base64"),
    programs,
    writableAccounts,
    submission: "rpc",
  };
}

export function deriveMoneyFoundationRequestId(params: {
  walletId: string;
  workflowId: string;
  intent: WalletProviderMoneyFoundationIntentV2;
  transaction: WalletProviderSignerTransactionEnvelopeV2;
}): string {
  const workflowId = params.workflowId.trim();
  if (
    !workflowId ||
    workflowId.length > 160 ||
    Array.from(workflowId).some((value) => (value.codePointAt(0) ?? 0) < 32)
  ) {
    throw new Error("money-foundation workflowId must contain 1-160 printable characters");
  }
  return `money-foundation-${sha256(canonical(params)).slice(0, 48)}`;
}

async function requireMoneyFoundationSigner(socketPath: string): Promise<void> {
  const result = await callLocalSocketSigner<{
    ready?: boolean;
    capabilities?: { intentTypes?: string[]; features?: string[] };
  }>(socketPath, { op: "v2.capabilities" });
  const features = new Set(result.capabilities?.features ?? []);
  if (
    result.ready !== true ||
    !result.capabilities?.intentTypes?.includes("solana.moneyFoundationAction") ||
    !features.has("reviewedMoneyFoundationActions") ||
    !features.has("preSignedEphemeralPositionMint") ||
    !features.has("signerOwnedStateRecheck") ||
    !features.has("durableReviewAuthorization") ||
    !features.has("ambiguousBroadcastReconciliation")
  ) {
    throw new Error("native signer does not support the reviewed money-foundation contract");
  }
}

async function reconcileOperation(params: {
  socketPath: string;
  walletId: string;
  requestId: string;
}): Promise<MoneyFoundationOperation> {
  let operation = await callLocalSocketSigner<MoneyFoundationOperation>(params.socketPath, {
    op: "v2.operation.get",
    walletId: params.walletId,
    request: { requestId: params.requestId },
  });
  if (operation.state === "broadcast" || operation.state === "unknown") {
    operation = await callLocalSocketSigner<MoneyFoundationOperation>(params.socketPath, {
      op: "v2.operation.reconcile",
      walletId: params.walletId,
      request: { requestId: params.requestId },
    });
  }
  return operation;
}

async function finalizedReadback(params: {
  rpcUrl: string;
  signature: string;
  intent: WalletProviderMoneyFoundationIntentV2;
}): Promise<MoneyFoundationReadback> {
  const money = params.intent.moneyFoundation;
  const addresses = [money.pool, money.positionTokenAccount, money.satVault, money.solVault];
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "getMultipleAccounts",
    params: [addresses, { commitment: "finalized", encoding: "base64" }],
  });
  const { response, release } = await fetchPinnedSolanaRpcRead({
    rpcUrl: params.rpcUrl,
    body,
    timeoutMs: 10_000,
  });
  try {
    const payload = (await response.json()) as {
      error?: { message?: string };
      result?: {
        context?: { slot?: number };
        value?: Array<{ owner?: string; data?: [string, string] } | null>;
      };
    };
    const slot = payload.result?.context?.slot;
    const values = payload.result?.value;
    if (
      !response.ok ||
      payload.error ||
      !Number.isSafeInteger(slot) ||
      !Array.isArray(values) ||
      values.length !== addresses.length
    ) {
      throw new Error(payload.error?.message ?? "money-foundation finalized readback is malformed");
    }
    return {
      finalizedSlot: slot as number,
      signature: params.signature,
      accounts: addresses.map((address, index) => {
        const account = values[index];
        if (!account) {
          return { address, exists: false };
        }
        if (!account.owner || !Array.isArray(account.data) || account.data[1] !== "base64") {
          throw new Error(`money-foundation account ${address} has noncanonical RPC data`);
        }
        return {
          address,
          exists: true,
          owner: account.owner,
          dataSha256: `sha256:${sha256(Buffer.from(account.data[0], "base64"))}`,
        };
      }),
    };
  } finally {
    await release();
  }
}

export async function executeReviewedMoneyFoundationAction(params: {
  socketPath: string;
  rpcUrl: string;
  walletId: string;
  walletPublicKey: string;
  workflowId: string;
  intent: WalletProviderMoneyFoundationIntentV2;
  transaction: Transaction;
  positionMintSigner?: Keypair;
  env?: NodeJS.ProcessEnv;
}): Promise<{ operation: MoneyFoundationOperation; readback: MoneyFoundationReadback }> {
  await requireMoneyFoundationSigner(params.socketPath);
  const transaction = prepareMoneyFoundationTransactionEnvelope(params);
  const requestId = deriveMoneyFoundationRequestId({
    walletId: params.walletId,
    workflowId: params.workflowId,
    intent: params.intent,
    transaction,
  });
  const policy = await callLocalSocketSigner<{ hash: string }>(params.socketPath, {
    op: "v2.policy.get",
    walletId: params.walletId,
  });
  let review: WalletProviderJupiterReviewV2;
  try {
    review = await callLocalSocketSigner(params.socketPath, {
      op: "v2.review.get",
      walletId: params.walletId,
      request: { requestId },
    });
  } catch (error) {
    if (!String(error).includes("signer review not found")) {
      throw error;
    }
    review = await callLocalSocketSigner(params.socketPath, {
      op: "v2.review.prepare",
      walletId: params.walletId,
      request: {
        requestId,
        policyHash: policy.hash,
        mode: "reviewed",
        intent: params.intent,
        transaction,
      },
    });
  }
  if (
    review.requestId !== requestId ||
    review.policyHash !== policy.hash ||
    review.intentType !== params.intent.type ||
    !isDeepStrictEqual(review.semanticIntent, params.intent) ||
    !isDeepStrictEqual(review.transaction, transaction)
  ) {
    throw new Error("money-foundation signer review does not match the exact compiler action");
  }
  if (review.state === "prepared") {
    const approval = createSignerReviewApprovalRequest({
      review,
      role: "vault",
      walletId: params.walletId,
      requestedBy: "money-foundation",
      assetSymbol: params.intent.moneyFoundation.action === "ADD_POL" ? "SOL+SAT" : "POL",
      assetName: "SAT/SOL money-foundation action",
      memo: `Reviewed money-foundation action: ${params.intent.moneyFoundation.action}`,
      env: params.env,
    });
    throw new Error(`money-foundation review ${approval.id} is pending in Wallet Approvals`);
  }
  const operation = await reconcileOperation({
    socketPath: params.socketPath,
    walletId: params.walletId,
    requestId,
  });
  if (operation.state === "failed") {
    throw new Error(operation.error ?? `money-foundation operation ${requestId} failed`);
  }
  if (operation.state !== "confirmed" || !operation.signature) {
    throw new Error(
      `money-foundation operation ${requestId} is ${operation.state}; no duplicate broadcast is allowed`,
    );
  }
  return {
    operation,
    readback: await finalizedReadback({
      rpcUrl: params.rpcUrl,
      signature: operation.signature,
      intent: params.intent,
    }),
  };
}
