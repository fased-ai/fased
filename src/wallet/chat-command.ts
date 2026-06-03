import { createWalletTool } from "../agents/tools/wallet-tool.js";
import type { FasedAgentConfig } from "../config/config.js";

type WalletChatAction = "address" | "assets" | "balance" | "balances" | "list" | "send";

export type WalletChatCommand = {
  action: WalletChatAction;
  args: Record<string, unknown>;
};

const WALLET_HANDLE_RE = /@wallet:[a-z0-9_-]+/i;
const BARE_WALLET_ROUTE_RE = /(?:^|\s)@wallet\b/i;
const SOLANA_ADDRESS_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/;
const SEND_RE =
  /\b(?:send|transfer)\s+([0-9]+(?:\.[0-9]+)?)\s*(sol)\s+from\s+(@wallet:[a-z0-9_-]+)\s+to\s+(@wallet:[a-z0-9_-]+|[1-9A-HJ-NP-Za-km-z]{32,44})\b/i;

function stripWalletSlashCommand(message: string): string | null {
  const trimmed = message.trim();
  if (!/^\/wallet(?:\s|$)/i.test(trimmed)) {
    return null;
  }
  return trimmed.replace(/^\/wallet\b/i, "").trim();
}

function firstWalletHandle(message: string): string | undefined {
  return WALLET_HANDLE_RE.exec(message)?.[0];
}

function firstExternalAddress(message: string): string | undefined {
  return SOLANA_ADDRESS_RE.exec(message)?.[0];
}

function looksWalletScoped(message: string): boolean {
  return (
    /^\/wallet(?:\s|$)/i.test(message.trim()) ||
    BARE_WALLET_ROUTE_RE.test(message) ||
    WALLET_HANDLE_RE.test(message) ||
    /\b(?:wallet|wallets)\b/i.test(message)
  );
}

function hasBalanceWord(message: string): boolean {
  return /\b(?:balance|balances|asset|assets|token|tokens)\b/i.test(message);
}

function parseSendCommand(message: string): WalletChatCommand | null {
  const match = SEND_RE.exec(message);
  if (!match) {
    return null;
  }
  const [, amount, symbol, from, to] = match;
  if (!amount || !symbol || !from || !to) {
    return null;
  }
  return {
    action: "send",
    args: {
      action: "send",
      chain: "solana",
      walletHandle: from,
      to,
      amount,
      amountFormat: "human",
    },
  };
}

export function parseWalletChatCommand(message: string): WalletChatCommand | null {
  const raw = message.trim();
  if (!raw) {
    return null;
  }
  const send = parseSendCommand(raw);
  if (send) {
    return send;
  }

  const slashBody = stripWalletSlashCommand(raw);
  const commandText = slashBody ?? raw;
  const handle = firstWalletHandle(commandText);
  const externalAddress = firstExternalAddress(commandText);

  if (!looksWalletScoped(raw) && !(hasBalanceWord(raw) && externalAddress)) {
    return null;
  }

  if (
    (slashBody !== null && /^list\b/i.test(slashBody)) ||
    /\b(?:list|show)\s+(?:local\s+)?wallets\b/i.test(raw)
  ) {
    return { action: "list", args: { action: "list" } };
  }

  if (
    (slashBody !== null && /^balances\b/i.test(slashBody)) ||
    (!handle &&
      /\b(?:all|every)\b/i.test(raw) &&
      /\b(?:local\s+)?wallets?\b/i.test(raw) &&
      /\bbalances?\b/i.test(raw))
  ) {
    return { action: "balances", args: { action: "balances" } };
  }

  if (/\b(?:address|receive|deposit)\b/i.test(raw) && handle) {
    return {
      action: "address",
      args: { action: "address", walletHandle: handle },
    };
  }

  if (hasBalanceWord(raw) && externalAddress && !handle) {
    return {
      action: "balance",
      args: { action: "balance", address: externalAddress },
    };
  }

  if (handle && /\b(?:asset|assets|token|tokens)\b/i.test(raw)) {
    return {
      action: "assets",
      args: { action: "assets", walletHandle: handle },
    };
  }

  if (handle && hasBalanceWord(raw)) {
    return {
      action: "balance",
      args: { action: "balance", walletHandle: handle },
    };
  }

  if ((slashBody !== null || BARE_WALLET_ROUTE_RE.test(raw)) && hasBalanceWord(raw)) {
    return { action: "balance", args: { action: "balance" } };
  }

  const slashTokens = slashBody?.split(/\s+/).filter(Boolean) ?? [];
  if (slashTokens.length > 0) {
    const action = slashTokens[0]?.toLowerCase();
    const target = slashTokens.slice(1).join(" ");
    const slashHandle = firstWalletHandle(target);
    const slashAddress = firstExternalAddress(target);
    if (action === "address" && slashHandle) {
      return { action: "address", args: { action: "address", walletHandle: slashHandle } };
    }
    if ((action === "balance" || action === "assets") && slashHandle) {
      return {
        action: action === "assets" ? "assets" : "balance",
        args: { action, walletHandle: slashHandle },
      };
    }
    if (action === "balance" && slashAddress) {
      return { action: "balance", args: { action: "balance", address: slashAddress } };
    }
  }

  return null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function shortAddress(value: string): string {
  return value.length > 18 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value;
}

function formatAsset(asset: Record<string, unknown>): string | undefined {
  const kind = asString(asset.kind);
  const symbol = asString(asset.symbol);
  const program = asString(asset.program);
  const amount = asString(asset.amountDisplay) ?? asString(asset.balance);
  if (!amount) {
    return undefined;
  }
  if (kind === "native") {
    return `${symbol ?? "Native"}: ${amount}${symbol ? ` ${symbol}` : ""}`;
  }
  return `Token ${program ? shortAddress(program) : (symbol ?? "SPL")}: ${amount}`;
}

function formatSolanaAssets(result: Record<string, unknown>): string[] {
  const assets = Array.isArray(result.assets) ? result.assets : [];
  return assets
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .map(formatAsset)
    .filter((entry): entry is string => Boolean(entry));
}

function formatWalletBalanceEntry(entry: Record<string, unknown>): string {
  const name = asString(entry.walletName) ?? asString(entry.walletId) ?? "Wallet";
  const lines = [`Wallet: ${name}`];
  const balances = asRecord(entry.balances);
  const solana = asRecord(balances?.solana);
  if (solana) {
    const assetLines = formatSolanaAssets(solana);
    if (assetLines.length > 0) {
      lines.push(...assetLines);
    } else {
      const balance = asString(solana.balance);
      const unit = asString(solana.unit);
      if (balance) {
        lines.push(`Solana: ${balance}${unit ? ` ${unit}` : ""}`);
      }
    }
  }
  return lines.join("\n");
}

export function formatWalletCommandReply(
  command: WalletChatCommand,
  details: Record<string, unknown>,
): string {
  if (details.approvalRequired === true) {
    const requestId = asString(details.requestId);
    return `Wallet send requires approval in Control UI.${requestId ? ` Request: ${requestId}` : ""}`;
  }

  if (command.action === "list") {
    const wallets = Array.isArray(details.wallets) ? details.wallets : [];
    if (wallets.length === 0) {
      return "No local wallets found.";
    }
    return [
      "Local wallets:",
      ...wallets.map((entry) => {
        const wallet = asRecord(entry) ?? {};
        const name = asString(wallet.walletName) ?? asString(wallet.walletId) ?? "Wallet";
        const handle = asString(wallet.walletHandle);
        const role = asString(wallet.role);
        return `- ${name}${handle ? ` (${handle})` : ""}${role ? ` · ${role}` : ""}`;
      }),
    ].join("\n");
  }

  if (command.action === "balances") {
    const wallets = Array.isArray(details.wallets) ? details.wallets : [];
    if (wallets.length === 0) {
      return "No local wallet balances found.";
    }
    return wallets
      .map((entry) => asRecord(entry))
      .filter((entry): entry is Record<string, unknown> => Boolean(entry))
      .map(formatWalletBalanceEntry)
      .join("\n\n");
  }

  if (command.action === "address") {
    const result = asRecord(details.result) ?? details;
    const name = asString(result.walletName) ?? asString(result.walletId) ?? "Wallet";
    const addresses = asRecord(result.addresses);
    if (addresses) {
      const lines = [`${name} addresses:`];
      const address = asString(addresses.solana);
      if (address) {
        lines.push(`solana: ${address}`);
      }
      return lines.join("\n");
    }
    const address = asString(result.address);
    return address ? `${name} address: ${address}` : "No wallet address returned.";
  }

  if (command.action === "send") {
    const sent = asRecord(details.sent);
    const tx = asRecord(details.tx);
    const txHash = asString(tx?.txHash) ?? asString(tx?.hash) ?? asString(tx?.signature);
    const amount = asString(sent?.amountDisplay) ?? asString(sent?.amount);
    const unit = asString(sent?.unit);
    return [
      `Wallet send executed${amount ? `: ${amount}${unit ? ` ${unit}` : ""}` : ""}.`,
      txHash ? `Tx: ${txHash}` : undefined,
    ]
      .filter((entry): entry is string => Boolean(entry))
      .join("\n");
  }

  const result = asRecord(details.result) ?? details;
  const assetLines = formatSolanaAssets(result);
  if (assetLines.length > 0) {
    const target = asRecord(result.target);
    const label =
      asString(result.walletName) ??
      asString(result.walletId) ??
      asString(target?.address) ??
      asString(result.address) ??
      "Wallet";
    return [`Balance for ${label}:`, ...assetLines].join("\n");
  }
  if (asRecord(result.balances)) {
    return formatWalletBalanceEntry(result);
  }
  const balance = asString(result.balance);
  const unit = asString(result.unit);
  return balance ? `Balance: ${balance}${unit ? ` ${unit}` : ""}` : "Wallet command completed.";
}

export async function executeWalletChatCommand(params: {
  cfg: FasedAgentConfig;
  command: WalletChatCommand;
  sessionKey?: string;
}): Promise<{ result: unknown; replyText: string }> {
  const tool = createWalletTool({
    config: params.cfg,
    agentSessionKey: params.sessionKey,
    requestSource: "agent-tool",
  });
  if (!tool?.execute) {
    return {
      result: null,
      replyText: "Wallet runtime is not enabled.",
    };
  }
  const result = await tool.execute("channel-wallet-command", params.command.args);
  const details = asRecord(result.details) ?? {};
  return {
    result,
    replyText: formatWalletCommandReply(params.command, details),
  };
}
