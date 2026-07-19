import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { ensureWalletStateDir } from "./wallet-runtime-config.js";

export type WalletAuditAction =
  | "rotate_keys"
  | "reset_wallet"
  | "wallet_named_created"
  | "wallet_rpc_updated"
  | "wallet_archived"
  | "wallet_policy_updated"
  | "mining_policy_updated"
  | "passkey_enrolled"
  | "passkey_removed"
  | "passkey_verified"
  | "send_requested"
  | "send_approved"
  | "send_rejected"
  | "send_executed"
  | "send_failed"
  | "deposit_detected"
  | "withdrawal_detected"
  | "webhook_received"
  | "inbound_reconciled";

export type WalletAuditEntry = {
  id: string;
  at: string;
  action: WalletAuditAction;
  actor: string;
  details?: Record<string, unknown>;
};

type WalletAuditFileLine = WalletAuditEntry;

function makeId(): string {
  return randomBytes(12).toString("hex");
}

export function appendWalletAuditEntry(params: {
  action: WalletAuditAction;
  actor?: string;
  details?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
}) {
  const paths = ensureWalletStateDir(params.env ?? process.env);
  const entry: WalletAuditFileLine = {
    id: makeId(),
    at: new Date().toISOString(),
    action: params.action,
    actor: params.actor?.trim() || "system",
    details: params.details ?? {},
  };
  fs.appendFileSync(paths.auditLogPath, `${JSON.stringify(entry)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    fs.chmodSync(paths.auditLogPath, 0o600);
  } catch {
    // best effort
  }
  return entry;
}

export function readWalletAuditEntries(params?: {
  env?: NodeJS.ProcessEnv;
  limit?: number;
}): WalletAuditEntry[] {
  const paths = ensureWalletStateDir(params?.env ?? process.env);
  if (!fs.existsSync(paths.auditLogPath)) {
    return [];
  }
  const limit = Math.max(1, Math.min(500, params?.limit ?? 100));
  const raw = fs.readFileSync(paths.auditLogPath, "utf8");
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const out: WalletAuditEntry[] = [];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]) as WalletAuditFileLine;
      if (
        parsed &&
        typeof parsed.id === "string" &&
        typeof parsed.at === "string" &&
        typeof parsed.action === "string" &&
        typeof parsed.actor === "string"
      ) {
        out.push({
          id: parsed.id,
          at: parsed.at,
          action: parsed.action,
          actor: parsed.actor,
          details: typeof parsed.details === "object" && parsed.details ? parsed.details : {},
        });
      }
    } catch {
      // ignore malformed line
    }
    if (out.length >= limit) {
      break;
    }
  }
  return out;
}
