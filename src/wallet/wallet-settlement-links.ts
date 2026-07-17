import fs from "node:fs";
import path from "node:path";
import type { WalletChain, WalletProviderId } from "../config/types.wallet.js";
import { serializeWalletState, writeWalletStateFileAtomically } from "./wallet-atomic-state.js";
import { ensureWalletStateDir } from "./wallet-runtime-config.js";

export type WalletSettlementLinkStatus = "pending" | "unknown" | "executed" | "failed" | "rejected";

export type WalletSettlementLink = {
  requestId: string;
  taskId: string;
  invoiceId?: string;
  senderHandle?: string;
  providerId?: WalletProviderId;
  walletId?: string;
  walletName?: string;
  chain?: WalletChain;
  amount?: string;
  to?: string;
  contract?: string;
  program?: string;
  mode: "manual" | "autonomous";
  status: WalletSettlementLinkStatus;
  txHash?: string;
  reason?: string;
  createdAt: string;
  updatedAt: string;
};

type WalletSettlementLinksFile = {
  version: 1;
  links: WalletSettlementLink[];
};

function linksFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(ensureWalletStateDir(env).rootDir, "wallet-settlement-links.json");
}

function isWalletSettlementLink(value: unknown): value is WalletSettlementLink {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const entry = value as Partial<WalletSettlementLink>;
  return (
    typeof entry.requestId === "string" &&
    Boolean(entry.requestId.trim()) &&
    typeof entry.taskId === "string" &&
    Boolean(entry.taskId.trim()) &&
    (entry.mode === "manual" || entry.mode === "autonomous") &&
    (entry.status === "pending" ||
      entry.status === "unknown" ||
      entry.status === "executed" ||
      entry.status === "failed" ||
      entry.status === "rejected") &&
    typeof entry.createdAt === "string" &&
    Boolean(entry.createdAt) &&
    typeof entry.updatedAt === "string" &&
    Boolean(entry.updatedAt)
  );
}

function loadFile(env: NodeJS.ProcessEnv = process.env): WalletSettlementLinksFile {
  const filePath = linksFilePath(env);
  if (!fs.existsSync(filePath)) {
    return { version: 1, links: [] };
  }
  try {
    const parsed = JSON.parse(
      fs.readFileSync(filePath, "utf8"),
    ) as Partial<WalletSettlementLinksFile>;
    if (
      parsed?.version === 1 &&
      Array.isArray(parsed.links) &&
      parsed.links.every(isWalletSettlementLink)
    ) {
      return {
        version: 1,
        links: parsed.links,
      };
    }
  } catch (error) {
    throw new Error("wallet settlement state is unreadable; refusing to reset request links", {
      cause: error,
    });
  }
  throw new Error("wallet settlement state has an unsupported shape; refusing to reset links");
}

function saveFile(file: WalletSettlementLinksFile, env: NodeJS.ProcessEnv = process.env) {
  const filePath = linksFilePath(env);
  writeWalletStateFileAtomically(filePath, serializeWalletState(file));
}

export function upsertWalletSettlementLink(params: {
  requestId: string;
  taskId: string;
  invoiceId?: string;
  senderHandle?: string;
  providerId?: WalletProviderId;
  walletId?: string;
  walletName?: string;
  chain?: WalletChain;
  amount?: string;
  to?: string;
  contract?: string;
  program?: string;
  mode?: "manual" | "autonomous";
  status?: WalletSettlementLinkStatus;
  txHash?: string;
  reason?: string;
  env?: NodeJS.ProcessEnv;
}): WalletSettlementLink {
  const env = params.env ?? process.env;
  const requestId = params.requestId.trim();
  const taskId = params.taskId.trim();
  if (!requestId || !taskId) {
    throw new Error("requestId and taskId are required");
  }
  const file = loadFile(env);
  const now = new Date().toISOString();
  const existing = file.links.find((item) => item.requestId === requestId);
  if (existing) {
    existing.taskId = taskId;
    existing.invoiceId = params.invoiceId?.trim() || undefined;
    existing.senderHandle = params.senderHandle?.trim() || undefined;
    existing.providerId = params.providerId ?? existing.providerId;
    existing.walletId = params.walletId?.trim() || existing.walletId;
    existing.walletName = params.walletName?.trim() || existing.walletName;
    existing.chain = params.chain ?? existing.chain;
    existing.amount = params.amount?.trim() || existing.amount;
    existing.to = params.to?.trim() || existing.to;
    existing.contract = params.contract?.trim() || existing.contract;
    existing.program = params.program?.trim() || existing.program;
    existing.mode = params.mode ?? existing.mode;
    existing.status = params.status ?? existing.status;
    existing.txHash = params.txHash?.trim() || existing.txHash;
    existing.reason = params.reason?.trim() || existing.reason;
    existing.updatedAt = now;
    saveFile(file, env);
    return existing;
  }
  const created: WalletSettlementLink = {
    requestId,
    taskId,
    invoiceId: params.invoiceId?.trim() || undefined,
    senderHandle: params.senderHandle?.trim() || undefined,
    providerId: params.providerId,
    walletId: params.walletId?.trim() || undefined,
    walletName: params.walletName?.trim() || undefined,
    chain: params.chain,
    amount: params.amount?.trim() || undefined,
    to: params.to?.trim() || undefined,
    contract: params.contract?.trim() || undefined,
    program: params.program?.trim() || undefined,
    mode: params.mode ?? "manual",
    status: params.status ?? "pending",
    txHash: params.txHash?.trim() || undefined,
    reason: params.reason?.trim() || undefined,
    createdAt: now,
    updatedAt: now,
  };
  file.links.push(created);
  saveFile(file, env);
  return created;
}

export function getWalletSettlementLinkByRequestId(params: {
  requestId: string;
  env?: NodeJS.ProcessEnv;
}): WalletSettlementLink | null {
  const requestId = params.requestId.trim();
  if (!requestId) {
    return null;
  }
  const file = loadFile(params.env ?? process.env);
  const match = file.links.find((item) => item.requestId === requestId);
  return match ?? null;
}

export function markWalletSettlementLinkOutcome(params: {
  requestId: string;
  status: WalletSettlementLinkStatus;
  txHash?: string;
  reason?: string;
  env?: NodeJS.ProcessEnv;
}): WalletSettlementLink | null {
  const env = params.env ?? process.env;
  const requestId = params.requestId.trim();
  if (!requestId) {
    return null;
  }
  const file = loadFile(env);
  const match = file.links.find((item) => item.requestId === requestId);
  if (!match) {
    return null;
  }
  match.status = params.status;
  match.txHash = params.txHash?.trim() || match.txHash;
  match.reason = params.reason?.trim() || match.reason;
  match.updatedAt = new Date().toISOString();
  saveFile(file, env);
  return match;
}

export function listWalletSettlementLinks(params?: {
  env?: NodeJS.ProcessEnv;
  limit?: number;
  taskId?: string;
}) {
  const env = params?.env ?? process.env;
  const limit = Math.max(1, Math.min(500, params?.limit ?? 100));
  const taskId = params?.taskId?.trim();
  const file = loadFile(env);
  return [...file.links]
    .toReversed()
    .filter((entry) => (taskId ? entry.taskId === taskId : true))
    .slice(0, limit);
}
