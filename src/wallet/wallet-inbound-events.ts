import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FasedAgentConfig } from "../config/config.js";
import type { WalletChain, WalletProviderId } from "../config/types.wallet.js";
import { appendWalletAuditEntry, readWalletAuditEntries } from "./wallet-audit-log.js";
import {
  buildWalletProviderCapabilityMatrix,
  providerSupportsChainOperation,
} from "./wallet-provider-capabilities.js";
import {
  type WalletNamedWallet,
  readWalletProviderRegistry,
  resolveWalletSelection,
} from "./wallet-provider-registry.js";
import {
  createWalletProviderAdapter,
  resolveWalletProviderId,
} from "./wallet-provider-resolver.js";
import { walletDiagnosticErrorString } from "./wallet-redaction.js";
import { ensureWalletStateDir, type ResolvedWalletRuntimeConfig } from "./wallet-runtime-config.js";

const INBOUND_LEDGER_FILENAME = "wallet-inbound-events.v1.json";

export type WalletInboundDirection = "inbound" | "outbound" | "unknown";
export type WalletInboundKind = "deposit" | "withdrawal" | "transfer";
export type WalletInboundStatus = "detected" | "confirmed" | "reconciled" | "ignored";
export type WalletInboundSource = "poll" | "webhook";

export type WalletInboundEvent = {
  id: string;
  providerId: WalletProviderId;
  walletId?: string;
  walletName?: string;
  chain: WalletChain;
  direction: WalletInboundDirection;
  kind: WalletInboundKind;
  status: WalletInboundStatus;
  amount?: string;
  unit?: string;
  txHash?: string;
  address?: string;
  source: WalletInboundSource;
  observedAt: string;
  occurredAt?: string;
  reconciledAt?: string;
  reconciledTo?: {
    auditId?: string;
    requestId?: string;
    action?: string;
  };
  metadata?: Record<string, unknown>;
};

type WalletInboundSnapshot = {
  key: string;
  providerId: WalletProviderId;
  walletId?: string;
  chain: WalletChain;
  address?: string;
  balance: string;
  unit?: string;
  updatedAt: string;
};

type WalletInboundLedger = {
  version: 1;
  snapshots: WalletInboundSnapshot[];
  events: WalletInboundEvent[];
  updatedAt: string;
  lastReconciledAt?: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function inboundLedgerPath(env: NodeJS.ProcessEnv = process.env): string {
  const state = ensureWalletStateDir(env);
  return path.join(state.rootDir, INBOUND_LEDGER_FILENAME);
}

function newEventId(): string {
  return `in_${randomBytes(10).toString("hex")}`;
}

function normalizeProviderId(value: unknown): WalletProviderId | null {
  switch (typeof value === "string" ? value.trim() : "") {
    case "embedded-keystore":
    case "local-socket-signer":
    case "alchemy":
    case "turnkey":
    case "privy":
      return value as WalletProviderId;
    default:
      return null;
  }
}

function normalizeChain(value: unknown): WalletChain | null {
  return value === "solana" ? value : null;
}

function normalizeDirection(value: unknown): WalletInboundDirection {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (raw === "inbound" || raw === "deposit" || raw === "in") {
    return "inbound";
  }
  if (raw === "outbound" || raw === "withdrawal" || raw === "out") {
    return "outbound";
  }
  return "unknown";
}

function normalizeKind(value: unknown, direction: WalletInboundDirection): WalletInboundKind {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (raw === "deposit") {
    return "deposit";
  }
  if (raw === "withdrawal") {
    return "withdrawal";
  }
  if (raw === "transfer") {
    return "transfer";
  }
  if (direction === "inbound") {
    return "deposit";
  }
  if (direction === "outbound") {
    return "withdrawal";
  }
  return "transfer";
}

function normalizeStatus(value: unknown): WalletInboundStatus {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (raw === "confirmed") {
    return "confirmed";
  }
  if (raw === "reconciled") {
    return "reconciled";
  }
  if (raw === "ignored") {
    return "ignored";
  }
  return "detected";
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const out = value.trim();
  return out || undefined;
}

function parseAmount(raw: string | undefined): bigint | null {
  if (!raw) {
    return null;
  }
  const value = raw.trim();
  if (!value) {
    return null;
  }
  try {
    const parsed = BigInt(value);
    return parsed >= 0n ? parsed : null;
  } catch {
    return null;
  }
}

function makeSnapshotKey(params: {
  providerId: WalletProviderId;
  walletId?: string;
  chain: WalletChain;
  address?: string;
}) {
  return [
    params.providerId,
    params.walletId ?? "default",
    params.chain,
    params.address ?? "unknown",
  ].join(":");
}

function defaultLedger(): WalletInboundLedger {
  return {
    version: 1,
    snapshots: [],
    events: [],
    updatedAt: nowIso(),
  };
}

function normalizeLedger(raw: unknown): WalletInboundLedger {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return defaultLedger();
  }
  const value = raw as Partial<WalletInboundLedger>;
  const snapshots = Array.isArray(value.snapshots)
    ? value.snapshots
        .filter((entry): entry is WalletInboundSnapshot => {
          if (!entry || typeof entry !== "object") {
            return false;
          }
          const providerId = normalizeProviderId((entry as { providerId?: unknown }).providerId);
          return (
            typeof (entry as { key?: unknown }).key === "string" &&
            Boolean(providerId) &&
            normalizeChain((entry as { chain?: unknown }).chain) !== null &&
            typeof (entry as { balance?: unknown }).balance === "string" &&
            typeof (entry as { updatedAt?: unknown }).updatedAt === "string"
          );
        })
        .map((entry) => ({
          key: String(entry.key),
          providerId: entry.providerId,
          walletId: entry.walletId,
          chain: entry.chain,
          address: entry.address,
          balance: entry.balance,
          unit: entry.unit,
          updatedAt: entry.updatedAt,
        }))
    : [];
  const events = Array.isArray(value.events)
    ? value.events
        .filter((entry): entry is WalletInboundEvent => {
          if (!entry || typeof entry !== "object") {
            return false;
          }
          const providerId = normalizeProviderId((entry as { providerId?: unknown }).providerId);
          return (
            typeof (entry as { id?: unknown }).id === "string" &&
            Boolean(providerId) &&
            normalizeChain((entry as { chain?: unknown }).chain) !== null &&
            typeof (entry as { observedAt?: unknown }).observedAt === "string"
          );
        })
        .map((entry) => ({
          id: String(entry.id),
          providerId: entry.providerId,
          walletId: entry.walletId,
          walletName: entry.walletName,
          chain: entry.chain,
          direction: normalizeDirection(entry.direction),
          kind: normalizeKind(entry.kind, normalizeDirection(entry.direction)),
          status: normalizeStatus(entry.status),
          amount: entry.amount,
          unit: entry.unit,
          txHash: entry.txHash,
          address: entry.address,
          source: (entry.source === "webhook" ? "webhook" : "poll") as WalletInboundSource,
          observedAt: entry.observedAt,
          occurredAt: entry.occurredAt,
          reconciledAt: entry.reconciledAt,
          reconciledTo:
            entry.reconciledTo && typeof entry.reconciledTo === "object"
              ? {
                  auditId: asTrimmedString((entry.reconciledTo as { auditId?: unknown }).auditId),
                  requestId: asTrimmedString(
                    (entry.reconciledTo as { requestId?: unknown }).requestId,
                  ),
                  action: asTrimmedString((entry.reconciledTo as { action?: unknown }).action),
                }
              : undefined,
          metadata:
            entry.metadata && typeof entry.metadata === "object" ? entry.metadata : undefined,
        }))
    : [];
  return {
    version: 1,
    snapshots,
    events,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : nowIso(),
    lastReconciledAt:
      typeof value.lastReconciledAt === "string" ? value.lastReconciledAt : undefined,
  };
}

function readLedger(env: NodeJS.ProcessEnv = process.env): WalletInboundLedger {
  const filePath = inboundLedgerPath(env);
  if (!fs.existsSync(filePath)) {
    return defaultLedger();
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    return normalizeLedger(parsed);
  } catch {
    return defaultLedger();
  }
}

function writeLedger(ledger: WalletInboundLedger, env: NodeJS.ProcessEnv = process.env) {
  const filePath = inboundLedgerPath(env);
  const payload: WalletInboundLedger = {
    ...ledger,
    version: 1,
    updatedAt: nowIso(),
  };
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best effort
  }
}

function findWalletById(env: NodeJS.ProcessEnv, walletId?: string): WalletNamedWallet | undefined {
  if (!walletId) {
    return undefined;
  }
  const registry = readWalletProviderRegistry(env);
  return registry.wallets.find((entry) => entry.id === walletId);
}

function upsertEvent(ledger: WalletInboundLedger, event: WalletInboundEvent): WalletInboundEvent {
  const txHash = event.txHash?.trim().toLowerCase();
  if (txHash) {
    const existing = ledger.events.find(
      (entry) =>
        entry.providerId === event.providerId &&
        entry.chain === event.chain &&
        entry.txHash?.trim().toLowerCase() === txHash &&
        (entry.walletId ?? "") === (event.walletId ?? ""),
    );
    if (existing) {
      existing.status = event.status;
      existing.direction = event.direction;
      existing.kind = event.kind;
      existing.amount = event.amount ?? existing.amount;
      existing.unit = event.unit ?? existing.unit;
      existing.address = event.address ?? existing.address;
      existing.walletName = event.walletName ?? existing.walletName;
      existing.metadata = {
        ...existing.metadata,
        ...event.metadata,
      };
      existing.observedAt = event.observedAt;
      existing.occurredAt = event.occurredAt ?? existing.occurredAt;
      return existing;
    }
  }
  ledger.events.unshift(event);
  if (ledger.events.length > 2_000) {
    ledger.events = ledger.events.slice(0, 2_000);
  }
  return event;
}

function upsertSnapshot(ledger: WalletInboundLedger, snapshot: WalletInboundSnapshot) {
  const idx = ledger.snapshots.findIndex((entry) => entry.key === snapshot.key);
  if (idx >= 0) {
    ledger.snapshots[idx] = snapshot;
    return;
  }
  ledger.snapshots.push(snapshot);
}

export function listWalletInboundEvents(params?: {
  env?: NodeJS.ProcessEnv;
  providerId?: WalletProviderId;
  walletId?: string;
  chain?: WalletChain;
  status?: WalletInboundStatus | "all";
  limit?: number;
}): WalletInboundEvent[] {
  const env = params?.env ?? process.env;
  const ledger = readLedger(env);
  const status = params?.status && params.status !== "all" ? params.status : undefined;
  const limit = Math.max(1, Math.min(500, params?.limit ?? 100));
  return ledger.events
    .filter((entry) => {
      if (params?.providerId && entry.providerId !== params.providerId) {
        return false;
      }
      if (params?.walletId && entry.walletId !== params.walletId) {
        return false;
      }
      if (params?.chain && entry.chain !== params.chain) {
        return false;
      }
      if (status && entry.status !== status) {
        return false;
      }
      return true;
    })
    .slice(0, limit);
}

export function reconcileWalletInboundEvents(params?: {
  env?: NodeJS.ProcessEnv;
  limitAuditEntries?: number;
}) {
  const env = params?.env ?? process.env;
  const ledger = readLedger(env);
  const auditEntries = readWalletAuditEntries({
    env,
    limit: Math.max(200, Math.min(2_000, params?.limitAuditEntries ?? 1_000)),
  });
  const byTxHash = new Map<string, { auditId?: string; requestId?: string; action?: string }>();
  for (const entry of auditEntries) {
    if (entry.action !== "send_executed" && entry.action !== "send_failed") {
      continue;
    }
    const details = entry.details ?? {};
    const txHash = typeof details.txHash === "string" ? details.txHash.trim().toLowerCase() : "";
    if (!txHash) {
      continue;
    }
    if (!byTxHash.has(txHash)) {
      byTxHash.set(txHash, {
        auditId: entry.id,
        requestId: typeof details.requestId === "string" ? details.requestId : undefined,
        action: entry.action,
      });
    }
  }
  let reconciled = 0;
  let touched = false;
  for (const event of ledger.events) {
    if (event.status === "reconciled") {
      continue;
    }
    const txHash = event.txHash?.trim().toLowerCase();
    if (!txHash) {
      continue;
    }
    const match = byTxHash.get(txHash);
    if (!match) {
      continue;
    }
    event.status = "reconciled";
    event.reconciledAt = nowIso();
    event.reconciledTo = {
      auditId: match.auditId,
      requestId: match.requestId,
      action: match.action,
    };
    touched = true;
    reconciled += 1;
    appendWalletAuditEntry({
      action: "inbound_reconciled",
      actor: "wallet-inbound",
      details: {
        eventId: event.id,
        txHash: event.txHash,
        providerId: event.providerId,
        walletId: event.walletId,
        chain: event.chain,
        auditId: match.auditId,
        requestId: match.requestId,
      },
      env,
    });
  }
  if (touched) {
    ledger.lastReconciledAt = nowIso();
    writeLedger(ledger, env);
  }
  return {
    ok: true as const,
    reconciled,
    examined: ledger.events.length,
    lastReconciledAt: ledger.lastReconciledAt,
  };
}

export async function pollWalletInboundEvents(params: {
  cfg: FasedAgentConfig;
  wallet: ResolvedWalletRuntimeConfig;
  env?: NodeJS.ProcessEnv;
  providerId?: WalletProviderId;
  walletId?: string;
  walletName?: string;
  chain?: WalletChain | "all";
  actor?: string;
}) {
  const env = params.env ?? process.env;
  const walletSelection = resolveWalletSelection({
    providerId: params.providerId,
    walletId: params.walletId,
    walletName: params.walletName,
    env,
  });
  const providerId = walletSelection.providerId ?? resolveWalletProviderId(params.cfg, env);
  const walletRef = findWalletById(env, walletSelection.walletId);
  const provider = createWalletProviderAdapter({
    cfg: params.cfg,
    wallet: params.wallet,
    env,
    providerIdOverride: providerId,
    walletId: walletSelection.walletId,
  });
  const matrix = buildWalletProviderCapabilityMatrix(provider);
  const chainFilter = params.chain ?? "all";
  const targetChains =
    chainFilter === "all"
      ? params.wallet.chains
      : params.wallet.chains.filter((c) => c === chainFilter);
  const checkedAt = nowIso();
  const ledger = readLedger(env);
  const detected: WalletInboundEvent[] = [];
  const balances: Record<string, unknown> = {};

  let addresses: { solana?: string } = {};
  try {
    if (providerSupportsChainOperation({ matrix, chain: "solana", operation: "receiveAddress" })) {
      addresses = await provider.getAddresses({ walletId: walletSelection.walletId });
    }
  } catch {
    addresses = {};
  }

  for (const chain of targetChains) {
    if (!providerSupportsChainOperation({ matrix, chain, operation: "getBalance" })) {
      balances[chain] = {
        ok: false,
        chain,
        error: `${provider.id} does not support balance on chain=${chain}`,
      };
      continue;
    }
    try {
      const result = await provider.getBalance(chain, { walletId: walletSelection.walletId });
      balances[chain] = result;
      const address = asTrimmedString(result.address) ?? addresses[chain];
      const snapshotKey = makeSnapshotKey({
        providerId,
        walletId: walletSelection.walletId,
        chain,
        address,
      });
      const nextBalance = parseAmount(result.balance);
      const previous = ledger.snapshots.find((entry) => entry.key === snapshotKey);
      const prevBalance = previous ? parseAmount(previous.balance) : null;
      if (nextBalance !== null && prevBalance !== null && nextBalance !== prevBalance) {
        const delta = nextBalance - prevBalance;
        const direction: WalletInboundDirection = delta > 0n ? "inbound" : "outbound";
        const amount = delta > 0n ? delta : delta * -1n;
        const event = upsertEvent(ledger, {
          id: newEventId(),
          providerId,
          walletId: walletSelection.walletId,
          walletName: walletRef?.name ?? walletSelection.walletName,
          chain,
          direction,
          kind: direction === "inbound" ? "deposit" : "withdrawal",
          status: "detected",
          amount: amount.toString(10),
          unit: result.unit,
          address,
          source: "poll",
          observedAt: checkedAt,
          occurredAt: checkedAt,
          metadata: {
            previousBalance: prevBalance.toString(10),
            nextBalance: nextBalance.toString(10),
            snapshotKey,
          },
        });
        detected.push(event);
        appendWalletAuditEntry({
          action: direction === "inbound" ? "deposit_detected" : "withdrawal_detected",
          actor: params.actor?.trim() || "wallet-poller",
          details: {
            providerId,
            walletId: walletSelection.walletId,
            walletName: walletSelection.walletName,
            chain,
            amount: event.amount,
            address,
            source: "poll",
          },
          env,
        });
      }
      if (nextBalance !== null) {
        upsertSnapshot(ledger, {
          key: snapshotKey,
          providerId,
          walletId: walletSelection.walletId,
          chain,
          address,
          balance: nextBalance.toString(10),
          unit: result.unit,
          updatedAt: checkedAt,
        });
      }
    } catch (err) {
      balances[chain] = {
        ok: false,
        chain,
        error: walletDiagnosticErrorString(err),
      };
    }
  }

  writeLedger(ledger, env);
  const reconciliation = reconcileWalletInboundEvents({ env });
  return {
    ok: true as const,
    checkedAt,
    providerId,
    walletId: walletSelection.walletId,
    walletName: walletRef?.name ?? walletSelection.walletName,
    balances,
    detected,
    reconciliation,
  };
}

export function recordWalletInboundWebhookEvent(params: {
  cfg: FasedAgentConfig;
  wallet: ResolvedWalletRuntimeConfig;
  payload: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
  actor?: string;
}) {
  const env = params.env ?? process.env;
  const payload = params.payload;
  const providerId =
    normalizeProviderId(payload.providerId) ?? resolveWalletProviderId(params.cfg, env);
  const chain = normalizeChain(payload.chain);
  if (!chain) {
    throw new Error("invalid chain (must be solana)");
  }
  const walletId = asTrimmedString(payload.walletId);
  const walletName = asTrimmedString(payload.walletName);
  const direction = normalizeDirection(payload.direction);
  const kind = normalizeKind(payload.kind, direction);
  const status = normalizeStatus(payload.status);
  const event: WalletInboundEvent = {
    id: newEventId(),
    providerId,
    walletId,
    walletName,
    chain,
    direction,
    kind,
    status,
    amount:
      asTrimmedString(payload.amount) ??
      (typeof payload.value === "number" && Number.isFinite(payload.value)
        ? String(payload.value)
        : undefined),
    unit: asTrimmedString(payload.unit),
    txHash:
      asTrimmedString(payload.txHash) ??
      asTrimmedString(payload.hash) ??
      asTrimmedString(payload.transactionHash),
    address: asTrimmedString(payload.address),
    source: "webhook",
    observedAt: nowIso(),
    occurredAt: asTrimmedString(payload.occurredAt) ?? asTrimmedString(payload.timestamp),
    metadata:
      payload.metadata && typeof payload.metadata === "object"
        ? (payload.metadata as Record<string, unknown>)
        : undefined,
  };
  const ledger = readLedger(env);
  const saved = upsertEvent(ledger, event);
  writeLedger(ledger, env);
  appendWalletAuditEntry({
    action: "webhook_received",
    actor: params.actor?.trim() || "wallet-webhook",
    details: {
      providerId: saved.providerId,
      walletId: saved.walletId,
      walletName: saved.walletName,
      chain: saved.chain,
      txHash: saved.txHash,
      direction: saved.direction,
      status: saved.status,
    },
    env,
  });
  const reconciliation = reconcileWalletInboundEvents({ env });
  return {
    ok: true as const,
    event: saved,
    reconciliation,
  };
}
