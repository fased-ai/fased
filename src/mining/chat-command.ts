import type { FasedAgentConfig } from "../config/config.js";
import { callGatewayScoped } from "../gateway/call.js";
import { ADMIN_SCOPE } from "../gateway/method-scopes.js";

type MiningChatAction = "readiness" | "status" | "wallets" | "history" | "start" | "stop";

export type MiningChatCommand = {
  action: MiningChatAction;
  method: string;
  params?: Record<string, unknown>;
  expectFinal?: boolean;
  timeoutMs?: number;
};

const WALLET_HANDLE_RE = /@wallet:([a-z0-9_-]+)/i;

function hasWord(text: string, word: string): boolean {
  return new RegExp(`\\b${word}\\b`, "i").test(text);
}

function readWalletId(message: string): string | undefined {
  const match = WALLET_HANDLE_RE.exec(message);
  return match?.[1]?.trim() || undefined;
}

function mentionsMining(message: string): boolean {
  return /(?:^|\s)@mining\b/i.test(message);
}

function looksScheduledOrConditional(message: string): boolean {
  return /\b(?:after|auto|automatically|before|cron|daily|every|hourly|if|once|schedule|scheduled|then|tomorrow|when|whenever)\b/i.test(
    message,
  );
}

export function parseMiningChatCommand(message: string): MiningChatCommand | null {
  const raw = message.trim();
  if (!raw || !mentionsMining(raw) || looksScheduledOrConditional(raw)) {
    return null;
  }
  const normalized = raw.toLowerCase().replace(/\s+/g, " ");
  const walletId = readWalletId(raw);

  if (hasWord(normalized, "start")) {
    return {
      action: "start",
      method: "sat.startMining",
      params: walletId ? { walletId } : {},
      expectFinal: true,
      timeoutMs: 90_000,
    };
  }
  if (hasWord(normalized, "stop")) {
    return {
      action: "stop",
      method: "sat.stopMining",
      params: {},
      expectFinal: true,
      timeoutMs: 90_000,
    };
  }
  if (hasWord(normalized, "readiness") || hasWord(normalized, "ready")) {
    return {
      action: "readiness",
      method: "sat.getMiningReadiness",
      params: walletId ? { walletId } : {},
    };
  }
  if (hasWord(normalized, "wallets")) {
    return {
      action: "wallets",
      method: "sat.listMiningWallets",
      params: {},
    };
  }
  if (hasWord(normalized, "history")) {
    return {
      action: "history",
      method: "sat.getMiningHistory",
      params: {},
    };
  }
  if (
    hasWord(normalized, "status") ||
    hasWord(normalized, "check") ||
    hasWord(normalized, "show")
  ) {
    return {
      action: "status",
      method: "sat.getMiningStatus",
      params: {},
    };
  }
  return null;
}

function forceLocalGatewayConfig(cfg: FasedAgentConfig): FasedAgentConfig {
  return {
    ...cfg,
    gateway: {
      ...cfg.gateway,
      mode: "local",
    },
  };
}

function resolveLocalGatewayAuth(cfg: FasedAgentConfig): { token?: string; password?: string } {
  const token =
    typeof cfg.gateway?.auth?.token === "string" && cfg.gateway.auth.token.trim()
      ? cfg.gateway.auth.token.trim()
      : undefined;
  const password =
    typeof cfg.gateway?.auth?.password === "string" && cfg.gateway.auth.password.trim()
      ? cfg.gateway.auth.password.trim()
      : undefined;
  return {
    ...(token ? { token } : {}),
    ...(password ? { password } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function extractPayload(result: unknown): Record<string, unknown> {
  const record = asRecord(result) ?? {};
  const payload = asRecord(record.payload);
  return payload ?? record;
}

function readStatus(payload: Record<string, unknown>): Record<string, unknown> {
  return asRecord(payload.status) ?? payload;
}

function readDetail(status: Record<string, unknown>): string | undefined {
  for (const key of ["nextActionDetail", "bootstrapReason", "blockedReason"]) {
    const value = status[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function boolLabel(value: unknown): string {
  return value === true ? "true" : value === false ? "false" : "unknown";
}

export async function executeMiningChatCommand(params: {
  cfg: FasedAgentConfig;
  command: MiningChatCommand;
}): Promise<{ result: unknown; replyText: string }> {
  const auth = resolveLocalGatewayAuth(params.cfg);
  const result = await callGatewayScoped({
    config: forceLocalGatewayConfig(params.cfg),
    method: params.command.method,
    params: params.command.params ?? {},
    scopes: [ADMIN_SCOPE],
    expectFinal: params.command.expectFinal,
    timeoutMs: params.command.timeoutMs ?? 30_000,
    ...auth,
  });
  return {
    result,
    replyText: formatMiningChatCommandReply(params.command, result),
  };
}

export function formatMiningChatCommandReply(command: MiningChatCommand, result: unknown): string {
  const payload = extractPayload(result);
  const status = readStatus(payload);
  const detail = readDetail(status);
  switch (command.action) {
    case "start": {
      const running = status.running === true;
      const started = payload.started === true && running && status.drainOnly !== true;
      return started
        ? "SAT mining is running."
        : `Start was requested, but SAT mining is not running. ${
            detail ?? "Check mining readiness for the blocking reason."
          }`;
    }
    case "stop": {
      const stopped = payload.stopped === true && status.running !== true;
      if (stopped) {
        return "SAT mining stopped.";
      }
      if (status.drainOnly === true) {
        return "New SAT mining cycles are stopped; drain/recovery remains active until locked capital is free.";
      }
      return `Stop was requested, but SAT mining still reports running=${boolLabel(status.running)}. ${detail ?? "Check mining status for details."}`;
    }
    case "status":
      return `SAT mining status: running=${boolLabel(status.running)}, drainOnly=${boolLabel(status.drainOnly)}, enabledWanted=${boolLabel(status.enabledWanted)}.${detail ? ` ${detail}` : ""}`;
    case "readiness":
      return `SAT mining readiness checked.${detail ? ` ${detail}` : ""}`;
    case "wallets":
      return "SAT mining wallets listed.";
    case "history":
      return "SAT mining history loaded.";
  }
}
