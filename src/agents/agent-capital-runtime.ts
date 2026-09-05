import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { PublicKey } from "@solana/web3.js";
import { callLocalSocketSigner } from "../wallet/providers/local-socket-signer-adapter.js";
import { fetchPinnedSolanaRpcRead } from "../wallet/solana-rpc-read-fetch.js";
import type { WalletProviderJupiterReviewV2 } from "../wallet/wallet-provider-adapter.js";
import {
  createSignerReviewApprovalRequest,
  type WalletSendApprovalRequest,
} from "../wallet/wallet-send-approvals.js";
import {
  FASED_AGENT_CAPITAL_CONTRACT,
  FASED_AGENT_CAPITAL_PROGRAM_ID,
  type FasedAgentCapitalAction,
} from "./fased-agent-capital-contract.generated.js";

export type AgentCapitalInstruction = {
  action: FasedAgentCapitalAction;
  programId: string;
  dataBase64: string;
  keys: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
};

export type AgentCapitalOperation = {
  requestId: string;
  state: "reserved" | "broadcast" | "confirmed" | "failed" | "unknown";
  signature?: string;
  error?: string;
};

export type AgentCapitalReadback = {
  finalizedSlot: number;
  signature: string;
  accounts: Array<{
    address: string;
    exists: boolean;
    owner?: string;
    dataSha256?: string;
    accountKind?: string;
  }>;
};

export type ReviewedAgentCapitalActionResult =
  | {
      state: "pending";
      requestId: string;
      approval: WalletSendApprovalRequest;
    }
  | {
      state: "confirmed";
      operation: AgentCapitalOperation;
      readback: AgentCapitalReadback;
    };

const instructionByAction = new Map(
  FASED_AGENT_CAPITAL_CONTRACT.instructions.map((instruction) => [instruction.action, instruction]),
);
const accountKindByDiscriminator = new Map(
  FASED_AGENT_CAPITAL_CONTRACT.accounts.map((account) => [
    Buffer.from(account.discriminator).toString("hex"),
    account.name,
  ]),
);

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

export function validateAgentCapitalInstruction(
  instruction: AgentCapitalInstruction,
  signer: string,
): AgentCapitalInstruction {
  if (instruction.programId !== FASED_AGENT_CAPITAL_PROGRAM_ID) {
    throw new Error("Agent Capital instruction does not use the pinned canonical program");
  }
  if (instruction.action === "commit_vault_cycle" || instruction.action === "reveal_vault_cycle") {
    throw new Error(
      "Vault mining requires the signer-owned Vault commitment path; generic instruction data is disabled",
    );
  }
  const contract = instructionByAction.get(instruction.action);
  if (!contract) {
    throw new Error(`unsupported Agent Capital action ${instruction.action}`);
  }
  const data = Buffer.from(instruction.dataBase64, "base64");
  if (
    data.toString("base64") !== instruction.dataBase64 ||
    data.length !== contract.dataSize ||
    !data.subarray(0, 8).equals(Buffer.from(contract.discriminator))
  ) {
    throw new Error("Agent Capital instruction data does not match its generated action");
  }
  if (instruction.keys.length !== contract.accounts.length) {
    throw new Error("Agent Capital instruction account count does not match its generated action");
  }
  const signerKey = new PublicKey(signer).toBase58();
  let signerFound = false;
  const keys = instruction.keys.map((key, index) => {
    const expected = contract.accounts[index];
    const pubkey = new PublicKey(key.pubkey).toBase58();
    if (key.isSigner !== expected.signer || key.isWritable !== expected.writable) {
      throw new Error(`Agent Capital account ${expected.name} flags do not match the contract`);
    }
    if ("address" in expected && expected.address !== pubkey) {
      throw new Error(`Agent Capital account ${expected.name} has the wrong fixed address`);
    }
    if (key.isSigner) {
      if (pubkey !== signerKey) {
        throw new Error(
          "Agent Capital v1 execution supports one selected signer wallet; multi-authority binding remains an explicit owner ceremony",
        );
      }
      signerFound = true;
    }
    return { pubkey, isSigner: key.isSigner, isWritable: key.isWritable };
  });
  if (!signerFound) {
    throw new Error("Agent Capital instruction does not bind the selected wallet");
  }
  return { ...instruction, keys };
}

export function deriveAgentCapitalRequestId(params: {
  walletId: string;
  workflowId: string;
  instruction: AgentCapitalInstruction;
}): string {
  const workflowId = params.workflowId.trim();
  const containsControlCharacter = Array.from(workflowId).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
  if (!workflowId || workflowId.length > 160 || containsControlCharacter) {
    throw new Error("Agent Capital workflowId must contain 1-160 printable characters");
  }
  return `agent-capital-${sha256(canonical(params)).slice(0, 48)}`;
}

async function signerCapabilities(socketPath: string): Promise<void> {
  const result = await callLocalSocketSigner<{
    ready?: boolean;
    capabilities?: { intentTypes?: string[]; features?: string[] };
  }>(socketPath, { op: "v2.capabilities" });
  const features = new Set(result.capabilities?.features ?? []);
  if (
    result.ready !== true ||
    !result.capabilities?.intentTypes?.includes("solana.agentCapitalAction") ||
    !features.has("reviewedAgentCapitalActions") ||
    !features.has("signerOwnedStateRecheck") ||
    !features.has("durableReviewAuthorization") ||
    !features.has("ambiguousBroadcastReconciliation")
  ) {
    throw new Error("native signer does not support the reviewed Agent Capital contract");
  }
}

async function reconcileOperation(params: {
  socketPath: string;
  walletId: string;
  requestId: string;
}): Promise<AgentCapitalOperation> {
  let operation = await callLocalSocketSigner<AgentCapitalOperation>(params.socketPath, {
    op: "v2.operation.get",
    walletId: params.walletId,
    request: { requestId: params.requestId },
  });
  if (operation.state === "broadcast" || operation.state === "unknown") {
    operation = await callLocalSocketSigner<AgentCapitalOperation>(params.socketPath, {
      op: "v2.operation.reconcile",
      walletId: params.walletId,
      request: { requestId: params.requestId },
    });
  }
  return operation;
}

async function readback(params: {
  rpcUrl: string;
  signature: string;
  instruction: AgentCapitalInstruction;
}): Promise<AgentCapitalReadback> {
  const addresses = [
    ...new Set(params.instruction.keys.filter((key) => key.isWritable).map((key) => key.pubkey)),
  ];
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
    if (!response.ok) {
      throw new Error(`Agent Capital finalized readback failed (${response.status})`);
    }
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
      payload.error ||
      !Number.isSafeInteger(slot) ||
      !Array.isArray(values) ||
      values.length !== addresses.length
    ) {
      throw new Error(payload.error?.message ?? "Agent Capital finalized readback is malformed");
    }
    return {
      finalizedSlot: slot as number,
      signature: params.signature,
      accounts: addresses.map((address, index) => {
        const account = values[index];
        if (!account) {
          return { address, exists: false };
        }
        if (!Array.isArray(account.data) || account.data[1] !== "base64" || !account.owner) {
          throw new Error(`Agent Capital account ${address} has noncanonical RPC data`);
        }
        const data = Buffer.from(account.data[0], "base64");
        const accountKind =
          account.owner === FASED_AGENT_CAPITAL_PROGRAM_ID
            ? accountKindByDiscriminator.get(data.subarray(0, 8).toString("hex"))
            : undefined;
        return {
          address,
          exists: true,
          owner: account.owner,
          dataSha256: `sha256:${sha256(data)}`,
          ...(accountKind ? { accountKind } : {}),
        };
      }),
    };
  } finally {
    await release();
  }
}

export async function prepareOrReconcileReviewedAgentCapitalAction(params: {
  socketPath: string;
  rpcUrl: string;
  cluster: "local" | "devnet" | "mainnet-beta";
  walletId: string;
  walletPublicKey: string;
  workflowId: string;
  instruction: AgentCapitalInstruction;
  env?: NodeJS.ProcessEnv;
}): Promise<ReviewedAgentCapitalActionResult> {
  const instruction = validateAgentCapitalInstruction(params.instruction, params.walletPublicKey);
  await signerCapabilities(params.socketPath);
  const intent = {
    type: "solana.agentCapitalAction" as const,
    cluster: params.cluster,
    ...instruction,
  };
  const requestId = deriveAgentCapitalRequestId({
    walletId: params.walletId,
    workflowId: params.workflowId,
    instruction,
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
      request: { requestId, policyHash: policy.hash, mode: "reviewed", intent },
    });
  }
  if (
    review.requestId !== requestId ||
    review.policyHash !== policy.hash ||
    review.intentType !== intent.type ||
    !isDeepStrictEqual(review.semanticIntent, intent)
  ) {
    throw new Error("Agent Capital signer review does not match the exact requested action");
  }
  if (review.state === "prepared") {
    const role =
      instructionByAction.get(instruction.action) &&
      [
        "deposit_capital_offer",
        "deposit_capital_offer_generation",
        "claim_vault_sat",
        "finalize_vault_exit",
        "refund_cancelled_position",
        "request_vault_exit",
      ].includes(instruction.action)
        ? "vault"
        : "profile";
    const approval = createSignerReviewApprovalRequest({
      review,
      role,
      walletId: params.walletId,
      requestedBy: "agent-capital",
      assetSymbol: ["deposit_capital_offer", "deposit_capital_offer_generation"].includes(
        instruction.action,
      )
        ? "SOL"
        : "CAPITAL",
      assetName: "Agent Capital action",
      memo: `Reviewed Agent Capital action: ${instruction.action}`,
      env: params.env,
    });
    return { state: "pending", requestId, approval };
  }
  const operation = await reconcileOperation({
    socketPath: params.socketPath,
    walletId: params.walletId,
    requestId,
  });
  if (operation.state === "failed") {
    throw new Error(operation.error ?? `Agent Capital operation ${requestId} failed`);
  }
  if (operation.state !== "confirmed" || !operation.signature) {
    throw new Error(
      `Agent Capital operation ${requestId} is ${operation.state}; no duplicate broadcast is allowed`,
    );
  }
  return {
    state: "confirmed",
    operation,
    readback: await readback({
      rpcUrl: params.rpcUrl,
      signature: operation.signature,
      instruction,
    }),
  };
}

export async function executeReviewedAgentCapitalAction(params: {
  socketPath: string;
  rpcUrl: string;
  cluster: "local" | "devnet" | "mainnet-beta";
  walletId: string;
  walletPublicKey: string;
  workflowId: string;
  instruction: AgentCapitalInstruction;
  env?: NodeJS.ProcessEnv;
}): Promise<{ operation: AgentCapitalOperation; readback: AgentCapitalReadback }> {
  const result = await prepareOrReconcileReviewedAgentCapitalAction(params);
  if (result.state === "pending") {
    throw new Error(`Agent Capital review ${result.approval.id} is pending in Wallet Approvals`);
  }
  return { operation: result.operation, readback: result.readback };
}
