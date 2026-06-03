import { createCronTool } from "../agents/tools/cron-tool.js";
import { createWalletActionTool } from "../agents/tools/wallet-action-tool.js";
import type { FasedAgentConfig } from "../config/config.js";

type TradeChatAction =
  | "event_plan"
  | "limit_cancel"
  | "limit_history"
  | "limit_order"
  | "quote"
  | "schedule_plan"
  | "swap";

export type TradeChatCommand = {
  action: TradeChatAction;
  args: Record<string, unknown>;
  condition?: string;
  scheduleLabel?: string;
};

const WALLET_HANDLE_RE = /@wallet:[a-z0-9_-]+/i;
const TOKEN_PATTERN = "[A-Za-z0-9._-]{2,44}";
const AMOUNT_PAIR_RE = new RegExp(
  `\\b([0-9]+(?:\\.[0-9]+)?)\\s+(${TOKEN_PATTERN})\\s+(?:worth\\s+of|to|for|into)\\s+(${TOKEN_PATTERN})\\s+from\\s+(@wallet:[a-z0-9_-]+)\\b`,
  "i",
);
const CANCEL_LIMIT_RE =
  /\b(?:cancel|remove)\s+(?:limit(?:\s+order)?\s+)?([A-Za-z0-9._:-]+)\s+from\s+(@wallet:[a-z0-9_-]+)\b/i;

type ParsedSchedule = {
  schedule: Record<string, unknown>;
  label: string;
};

function stripTradeSlashCommand(message: string): string | null {
  const trimmed = message.trim();
  if (!/^\/(?:trade|wallet)(?:\s|$)/i.test(trimmed)) {
    return null;
  }
  return trimmed.replace(/^\/(?:trade|wallet)\b/i, "").trim();
}

function stripTradeHandleCommand(message: string): string | null {
  const trimmed = message.trim();
  if (!/^@trade(?:\s|$)/i.test(trimmed)) {
    return null;
  }
  return trimmed.replace(/^@trade\b/i, "").trim();
}

function hasTradeVerb(message: string): boolean {
  return /\b(?:buy|cancel|dca|limit|quote|sell|swap|trade|trigger)\b/i.test(message);
}

function looksTradeScoped(message: string): boolean {
  const raw = message.trim();
  return (
    /^\/(?:trade|wallet)(?:\s|$)/i.test(raw) ||
    /^@trade(?:\s|$)/i.test(raw) ||
    (WALLET_HANDLE_RE.test(raw) && hasTradeVerb(raw))
  );
}

function readSlippageBps(message: string): number | undefined {
  const match = /\bslippage\s+([0-9]+(?:\.[0-9]+)?)\s*(bps|%)?\b/i.exec(message);
  const raw = match?.[1];
  if (!raw) {
    return undefined;
  }
  const unit = match?.[2]?.toLowerCase();
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(unit === "%" ? value * 100 : value);
}

function readExpirySeconds(message: string): number | undefined {
  const match =
    /\b(?:expire|expires|expiry)\s+(?:in\s+)?([0-9]+)\s*(minute|hour|day|week)s?\b/i.exec(message);
  const amount = Number(match?.[1]);
  const unit = match?.[2]?.toLowerCase();
  if (!Number.isFinite(amount) || amount <= 0 || !unit) {
    return undefined;
  }
  const multipliers: Record<string, number> = {
    minute: 60,
    hour: 60 * 60,
    day: 24 * 60 * 60,
    week: 7 * 24 * 60 * 60,
  };
  return Math.floor(amount * multipliers[unit]);
}

function readSchedule(message: string): ParsedSchedule | null {
  const cron = /\bcron\s+"([^"]+)"/i.exec(message)?.[1]?.trim();
  if (cron) {
    return { schedule: { kind: "cron", expr: cron }, label: `cron ${cron}` };
  }
  const at = /\bat\s+(\d{4}-\d{2}-\d{2}T[^\s]+)/i.exec(message)?.[1]?.trim();
  if (at) {
    return { schedule: { kind: "at", at }, label: `at ${at}` };
  }
  const every = /\bevery\s+([0-9]+)?\s*(minute|hour|day|week)s?\b/i.exec(message);
  if (every?.[2]) {
    const count = Math.max(1, Number(every[1] ?? "1"));
    const unit = every[2].toLowerCase();
    const unitMs: Record<string, number> = {
      minute: 60_000,
      hour: 60 * 60_000,
      day: 24 * 60 * 60_000,
      week: 7 * 24 * 60 * 60_000,
    };
    return {
      schedule: { kind: "every", everyMs: count * unitMs[unit] },
      label: `every ${count} ${unit}${count === 1 ? "" : "s"}`,
    };
  }
  if (/\bhourly\b/i.test(message)) {
    return { schedule: { kind: "every", everyMs: 60 * 60_000 }, label: "hourly" };
  }
  if (/\bdaily\b/i.test(message)) {
    return { schedule: { kind: "every", everyMs: 24 * 60 * 60_000 }, label: "daily" };
  }
  if (/\bweekly\b/i.test(message)) {
    return { schedule: { kind: "every", everyMs: 7 * 24 * 60 * 60_000 }, label: "weekly" };
  }
  return null;
}

function readCondition(message: string): string | undefined {
  const quoted = /\b(?:trigger|when|if)\s+"([^"]+)"/i.exec(message)?.[1]?.trim();
  if (quoted) {
    return quoted;
  }
  const prefix = /\b(?:trigger|when|if)\s+(.+?)\s+\b(?:buy|sell|swap)\b/i
    .exec(message)?.[1]
    ?.trim();
  return prefix || undefined;
}

function readPairArgs(message: string): Record<string, unknown> | null {
  const match = AMOUNT_PAIR_RE.exec(message);
  if (!match) {
    return null;
  }
  const [, amount, inputToken, outputToken, walletHandle] = match;
  if (!amount || !inputToken || !outputToken || !walletHandle) {
    return null;
  }
  return {
    walletHandle,
    inputToken,
    outputToken,
    amount,
    amountFormat: "human",
    ...(readSlippageBps(message) !== undefined ? { slippageBps: readSlippageBps(message) } : {}),
  };
}

function readLimitTrigger(message: string): Record<string, unknown> | null {
  const match = /\bwhen\s+(?:(\S+)\s+)?(above|below|over|under)\s+\$?([0-9]+(?:\.[0-9]+)?)\b/i.exec(
    message,
  );
  if (!match?.[2] || !match[3]) {
    return null;
  }
  const condition = match[2].toLowerCase();
  const triggerCondition = condition === "above" || condition === "over" ? "above" : "below";
  return {
    triggerCondition,
    triggerPriceUsd: Number(match[3]),
    ...(match[1] ? { triggerToken: match[1] } : {}),
    ...(readExpirySeconds(message) ? { expirySeconds: readExpirySeconds(message) } : {}),
  };
}

function commandMode(message: string): "manual" | "autonomous" {
  if (/\b(?:manual|plan only|prepare|review|do not (?:send|execute|place))\b/i.test(message)) {
    return "manual";
  }
  return "autonomous";
}

function limitMode(message: string): "manual" | "autonomous" {
  if (commandMode(message) === "manual") {
    return "manual";
  }
  return /\b(?:autonomous|create|execute|live|place)\b/i.test(message) ? "autonomous" : "manual";
}

export function parseTradeChatCommand(message: string): TradeChatCommand | null {
  const raw = message.trim();
  if (!raw || !looksTradeScoped(raw)) {
    return null;
  }
  const slashBody = stripTradeSlashCommand(raw);
  const handleBody = stripTradeHandleCommand(raw);
  const commandText = slashBody ?? handleBody ?? raw;

  const cancel = CANCEL_LIMIT_RE.exec(commandText);
  if (cancel?.[1] && cancel[2] && /\blimit\b/i.test(commandText)) {
    return {
      action: "limit_cancel",
      args: { action: "limit_cancel", orderId: cancel[1], walletHandle: cancel[2] },
    };
  }

  const historyHandle = WALLET_HANDLE_RE.exec(commandText)?.[0];
  if (
    historyHandle &&
    /\b(?:limit\s+history|limit\s+orders|limits|orders)\b/i.test(commandText) &&
    !AMOUNT_PAIR_RE.test(commandText)
  ) {
    return {
      action: "limit_history",
      args: {
        action: "limit_history",
        walletHandle: historyHandle,
        state: /\b(?:past|filled|expired|cancelled|canceled)\b/i.test(commandText)
          ? "past"
          : "active",
      },
    };
  }

  const pair = readPairArgs(commandText);
  if (!pair) {
    return null;
  }

  const isLimit = /\blimit(?:-|\s)?(?:order)?\b/i.test(commandText);
  if (isLimit) {
    const trigger = readLimitTrigger(commandText);
    if (!trigger) {
      return null;
    }
    return {
      action: "limit_order",
      args: {
        action: "limit_order",
        ...pair,
        ...trigger,
        mode: limitMode(commandText),
      },
    };
  }

  const schedule = readSchedule(commandText);
  const condition = readCondition(commandText);
  const isEvent = Boolean(condition) || /\btrigger\b/i.test(commandText);
  if (isEvent) {
    return {
      action: "event_plan",
      condition,
      scheduleLabel: schedule?.label,
      args: {
        action: "plan",
        ...pair,
        mode: "autonomous",
        schedule: schedule?.schedule,
      },
    };
  }

  const isDcaOrSchedule =
    /\b(?:dca|daily|hourly|recurring|schedule|scheduled|weekly)\b/i.test(commandText) ||
    /\bevery\s+[0-9]*\s*(?:minute|hour|day|week)s?\b/i.test(commandText);
  if (isDcaOrSchedule) {
    return {
      action: "schedule_plan",
      scheduleLabel: schedule?.label,
      args: {
        action: "schedule_plan",
        ...pair,
        mode: "autonomous",
        schedule: schedule?.schedule,
        name: `Recurring wallet action ${asString(pair.walletHandle) ?? "Agent wallet"}`,
      },
    };
  }

  if (/\bquote\b/i.test(commandText)) {
    return { action: "quote", args: { action: "quote", ...pair } };
  }
  if (/\b(?:buy|sell|swap)\b/i.test(commandText)) {
    return {
      action: "swap",
      args: { action: "swap", ...pair, mode: commandMode(commandText) },
    };
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

function formatBaseUnits(value: unknown, decimals: unknown): string | undefined {
  const raw = asString(value);
  const places = typeof decimals === "number" && Number.isFinite(decimals) ? decimals : 0;
  if (!raw || !/^[0-9]+$/.test(raw)) {
    return raw;
  }
  const amount = BigInt(raw);
  const scale = 10n ** BigInt(Math.max(0, places));
  if (scale === 1n) {
    return amount.toString();
  }
  const whole = amount / scale;
  const fraction = (amount % scale).toString().padStart(places, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function cronId(details: Record<string, unknown> | undefined): string | undefined {
  return (
    asString(details?.id) ??
    asString(asRecord(details?.job)?.id) ??
    asString(asRecord(details?.result)?.id)
  );
}

function buildEventCronJob(params: {
  command: TradeChatCommand;
  details: Record<string, unknown>;
}): Record<string, unknown> {
  const plan = asRecord(params.details.plan);
  if (!plan) {
    throw new Error("wallet action plan missing");
  }
  const schedule = asRecord(params.command.args.schedule);
  if (!schedule) {
    throw new Error("schedule required for conditional wallet action");
  }
  const condition = params.command.condition?.trim();
  if (!condition) {
    throw new Error(
      'conditional wallet action requires a quoted condition, for example: trigger "condition is true"',
    );
  }
  const walletHandle = asString(plan.walletHandle) ?? asString(params.command.args.walletHandle);
  const message = [
    "Run this Fased conditional wallet action exactly as structured.",
    `Condition: ${condition}`,
    "Evaluate the condition first. If it is false or uncertain, do not run the wallet action and report skipped.",
    "If it is true, call wallet_action with the exact plan below. Do not substitute wallets, tokens, amounts, slippage, or mode.",
    "",
    "walletActionPlan:",
    JSON.stringify({ ...plan, action: "swap", mode: "autonomous" }, null, 2),
  ].join("\n");
  return {
    name: `Conditional wallet action ${walletHandle ?? ""}`.trim(),
    schedule,
    sessionTarget: "isolated",
    payload: { kind: "agentTurn", message },
    delivery: { mode: "announce", bestEffort: true },
    enabled: false,
  };
}

function formatTradeReply(params: {
  command: TradeChatCommand;
  details: Record<string, unknown>;
  cronDetails?: Record<string, unknown>;
}): string {
  const { command, details, cronDetails } = params;
  if (details.approvalRequired === true) {
    const requestId = asString(details.requestId);
    return `Wallet action requires approval in Control UI.${requestId ? ` Request: ${requestId}` : ""}`;
  }
  if (command.action === "quote") {
    const quote = asRecord(details.quote) ?? {};
    const input = formatBaseUnits(quote.inAmount, quote.inputDecimals);
    const output = formatBaseUnits(quote.outAmount, quote.outputDecimals);
    const slippage =
      typeof quote.slippageBps === "number" || typeof quote.slippageBps === "string"
        ? String(quote.slippageBps)
        : undefined;
    return [
      `Quote: ${input ?? "?"} ${asString(quote.inputSymbol) ?? "input"} -> ${output ?? "?"} ${asString(quote.outputSymbol) ?? "output"}.`,
      slippage ? `Slippage: ${slippage} bps.` : undefined,
      asString(quote.routeLabel) ? `Route: ${asString(quote.routeLabel)}.` : undefined,
    ]
      .filter((entry): entry is string => Boolean(entry))
      .join("\n");
  }
  if (command.action === "swap") {
    const tx = asRecord(details.tx);
    const txHash = asString(tx?.txHash) ?? asString(tx?.hash) ?? asString(tx?.signature);
    return `Wallet action executed.${txHash ? `\nTx: ${txHash}` : ""}`;
  }
  if (command.action === "schedule_plan" || command.action === "event_plan") {
    const id = cronId(cronDetails);
    const kind = command.action === "event_plan" ? "conditional action" : "recurring action";
    return [
      `Created disabled ${kind} scheduled task${id ? `: ${id}` : ""}.`,
      command.scheduleLabel ? `Schedule: ${command.scheduleLabel}.` : undefined,
      "It will not run until you review and enable it in Tasks.",
    ]
      .filter((entry): entry is string => Boolean(entry))
      .join("\n");
  }
  if (command.action === "limit_order") {
    if (details.live === true) {
      const order = asRecord(details.order);
      const txHash = asString(order?.txSignature) ?? asString(asRecord(order?.tx)?.txHash);
      return `Limit order created.${asString(order?.id) ? `\nOrder: ${asString(order?.id)}` : ""}${txHash ? `\nTx: ${txHash}` : ""}`;
    }
    return "Limit order plan ready. Add `place` or `live` to create the Jupiter Trigger order.";
  }
  if (command.action === "limit_history") {
    const history = Array.isArray(details.history) ? details.history : [];
    return `Limit orders: ${history.length} ${command.args.state === "past" ? "past" : "active"} order(s).`;
  }
  if (command.action === "limit_cancel") {
    const tx = asRecord(details.tx);
    const txHash = asString(tx?.txHash) ?? asString(tx?.hash) ?? asString(tx?.signature);
    return `Limit order canceled.${txHash ? `\nTx: ${txHash}` : ""}`;
  }
  return "Wallet action command completed.";
}

export async function executeTradeChatCommand(params: {
  cfg: FasedAgentConfig;
  command: TradeChatCommand;
  sessionKey?: string;
}): Promise<{ result: unknown; replyText: string }> {
  if (
    (params.command.action === "schedule_plan" || params.command.action === "event_plan") &&
    !asRecord(params.command.args.schedule)
  ) {
    throw new Error("schedule required for recurring or conditional wallet action commands");
  }
  const walletTool = createWalletActionTool({
    config: params.cfg,
    agentSessionKey: params.sessionKey,
    requestSource: "agent-tool",
  });
  if (!walletTool?.execute) {
    throw new Error("wallet action tool is not available");
  }
  const walletResult = await walletTool.execute("trade-chat-command", params.command.args);
  const details = asRecord(walletResult.details) ?? {};
  let cronDetails: Record<string, unknown> | undefined;
  if (params.command.action === "schedule_plan" || params.command.action === "event_plan") {
    const job =
      params.command.action === "event_plan"
        ? buildEventCronJob({ command: params.command, details })
        : asRecord(details.cronJob);
    if (!job) {
      throw new Error("scheduled task plan missing");
    }
    const cronTool = createCronTool({ agentSessionKey: params.sessionKey });
    const cronResult = await cronTool.execute("trade-chat-cron-add", {
      action: "add",
      job,
    });
    cronDetails = asRecord(cronResult.details);
  }
  return {
    result: { wallet: walletResult.details, cron: cronDetails },
    replyText: formatTradeReply({ command: params.command, details, cronDetails }),
  };
}
