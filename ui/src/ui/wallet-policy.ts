export function toRawPolicyAmount(human: string, _chain: "solana" = "solana"): string {
  try {
    const trimmed = human.trim().split(" ")[0] || "0";
    const [wholePart, fracPart] = trimmed.split(".");
    const basePower = 9n;
    const base = 10n ** basePower;
    const wholeBig = BigInt(wholePart || "0") * base;
    if (!fracPart) {
      return wholeBig.toString();
    }
    const fracPadded = fracPart.padEnd(Number(basePower), "0").slice(0, Number(basePower));
    const fracBig = BigInt(fracPadded);
    return (wholeBig + fracBig).toString();
  } catch {
    return "0";
  }
}

export function toRawTokenPolicyAmount(human: string, decimals: number): string {
  try {
    const trimmed = human.trim().split(" ")[0] || "0";
    if (decimals < 0) {
      return trimmed;
    }
    const [wholePart, fracPart] = trimmed.split(".");
    const boundedDecimals = Math.max(0, Math.min(18, Math.floor(decimals)));
    const base = 10n ** BigInt(boundedDecimals);
    const wholeBig = BigInt(wholePart || "0") * base;
    if (!fracPart) {
      return wholeBig.toString();
    }
    const fracPadded = fracPart.padEnd(boundedDecimals, "0").slice(0, boundedDecimals);
    return (wholeBig + BigInt(fracPadded || "0")).toString();
  } catch {
    return "0";
  }
}

export function formatRawTokenPolicyAmount(raw: string | undefined, decimals: number): string {
  const value = String(raw ?? "").trim();
  if (!value) {
    return "";
  }
  if (decimals < 0) {
    return value;
  }
  try {
    const amount = BigInt(value);
    const boundedDecimals = Math.max(0, Math.min(18, Math.floor(decimals)));
    const base = 10n ** BigInt(boundedDecimals);
    const whole = amount / base;
    if (boundedDecimals === 0) {
      return whole.toString();
    }
    const fraction = (amount % base).toString().padStart(boundedDecimals, "0").replace(/0+$/, "");
    return fraction ? `${whole}.${fraction}` : whole.toString();
  } catch {
    return value;
  }
}

export type WalletRecurringIntervalUnit = "minutes" | "hours" | "days" | "months";

export type WalletRecurringIntervalDraft = {
  every: string;
  unit: WalletRecurringIntervalUnit;
  time: string;
  custom: boolean;
};

function clampPositiveInteger(value: string | number | undefined, fallback = 1): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.min(parsed, 999);
}

function parseTime(value: string | undefined): { hour: number; minute: number; time: string } {
  const match = String(value ?? "").match(/^(\d{1,2}):(\d{2})$/);
  const hour = match ? Math.min(23, Math.max(0, Number.parseInt(match[1] ?? "9", 10))) : 9;
  const minute = match ? Math.min(59, Math.max(0, Number.parseInt(match[2] ?? "0", 10))) : 0;
  return {
    hour,
    minute,
    time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
  };
}

export function buildRecurringTransferCron(input: {
  every: string | number;
  unit: WalletRecurringIntervalUnit;
  time?: string;
}): string {
  const every = clampPositiveInteger(input.every);
  const { hour, minute } = parseTime(input.time);
  switch (input.unit) {
    case "minutes":
      return `*/${every} * * * *`;
    case "hours":
      return `0 */${every} * * *`;
    case "months":
      return `${minute} ${hour} 1 */${every} *`;
    case "days":
    default:
      return `${minute} ${hour} */${every} * *`;
  }
}

export function parseRecurringTransferCron(expr: string | undefined): WalletRecurringIntervalDraft {
  const value = String(expr ?? "").trim();
  if (!value) {
    return { every: "1", unit: "days", time: "09:00", custom: false };
  }
  if (value === "* * * * *") {
    return { every: "1", unit: "minutes", time: "09:00", custom: false };
  }
  let match = value.match(/^\*\/(\d+) \* \* \* \*$/);
  if (match) {
    return {
      every: String(clampPositiveInteger(match[1])),
      unit: "minutes",
      time: "09:00",
      custom: false,
    };
  }
  match = value.match(/^0 \*\/(\d+) \* \* \*$/);
  if (match) {
    return {
      every: String(clampPositiveInteger(match[1])),
      unit: "hours",
      time: "09:00",
      custom: false,
    };
  }
  match = value.match(/^(\d{1,2}) (\d{1,2}) \* \* \*$/);
  if (match) {
    const parsed = parseTime(`${match[2]}:${match[1]?.padStart(2, "0")}`);
    return { every: "1", unit: "days", time: parsed.time, custom: false };
  }
  match = value.match(/^(\d{1,2}) (\d{1,2}) \*\/(\d+) \* \*$/);
  if (match) {
    const parsed = parseTime(`${match[2]}:${match[1]?.padStart(2, "0")}`);
    return {
      every: String(clampPositiveInteger(match[3])),
      unit: "days",
      time: parsed.time,
      custom: false,
    };
  }
  match = value.match(/^(\d{1,2}) (\d{1,2}) 1 \* \*$/);
  if (match) {
    const parsed = parseTime(`${match[2]}:${match[1]?.padStart(2, "0")}`);
    return { every: "1", unit: "months", time: parsed.time, custom: false };
  }
  match = value.match(/^(\d{1,2}) (\d{1,2}) 1 \*\/(\d+) \*$/);
  if (match) {
    const parsed = parseTime(`${match[2]}:${match[1]?.padStart(2, "0")}`);
    return {
      every: String(clampPositiveInteger(match[3])),
      unit: "months",
      time: parsed.time,
      custom: false,
    };
  }
  return { every: "1", unit: "days", time: "09:00", custom: true };
}

export function formatWalletPolicyAllowlist(values: string[] | undefined): string {
  return (values ?? [])
    .map((value) => value.trim())
    .filter(Boolean)
    .join("\n");
}

export function parseWalletPolicyAllowlist(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[\n,]+/)
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

export function buildWalletPolicyPatch(input: {
  capsEnabled: boolean;
  directSigning: boolean;
  skillsEnabled: boolean;
  solanaMaxPerTx: string;
  solanaMaxDaily: string;
  solanaAllowPrograms?: string;
  solanaTokenCaps?: Record<string, { maxPerTx?: string; maxDaily?: string; decimals: number }>;
  recurringTransfer?: {
    enabled?: boolean;
    to?: string;
    program?: string;
    amountMode?: "fixed" | "percentage";
    amount?: string;
    percentage?: number;
    minAmount?: string;
    keepAmount?: string;
    cron?: string;
    tz?: string;
    name?: string;
  } | null;
}) {
  const schedule = input.recurringTransfer?.cron?.trim()
    ? {
        kind: "cron",
        expr: input.recurringTransfer.cron.trim(),
        ...(input.recurringTransfer.tz?.trim() ? { tz: input.recurringTransfer.tz.trim() } : {}),
      }
    : undefined;
  return {
    capsEnabled: input.capsEnabled,
    directSigning: input.directSigning,
    skillsEnabled: input.skillsEnabled,
    solanaMaxPerTx: toRawPolicyAmount(input.solanaMaxPerTx, "solana"),
    solanaMaxDaily: toRawPolicyAmount(input.solanaMaxDaily, "solana"),
    solanaAllowPrograms: parseWalletPolicyAllowlist(input.solanaAllowPrograms ?? ""),
    solanaTokenCaps: Object.fromEntries(
      Object.entries(input.solanaTokenCaps ?? {}).map(([mint, cap]) => [
        mint,
        {
          maxPerTx: toRawTokenPolicyAmount(cap.maxPerTx ?? "", cap.decimals),
          maxDaily: toRawTokenPolicyAmount(cap.maxDaily ?? "", cap.decimals),
        },
      ]),
    ),
    recurringTransfer:
      input.recurringTransfer === null
        ? null
        : input.recurringTransfer
          ? {
              enabled: input.recurringTransfer.enabled === true,
              chain: "solana" as const,
              to: input.recurringTransfer.to?.trim(),
              program: input.recurringTransfer.program?.trim() || undefined,
              amountMode: input.recurringTransfer.amountMode ?? "fixed",
              amount: input.recurringTransfer.amount?.trim() || undefined,
              percentage: input.recurringTransfer.percentage,
              minAmount: input.recurringTransfer.minAmount?.trim() || undefined,
              keepAmount: input.recurringTransfer.keepAmount?.trim() || undefined,
              schedule,
              name: input.recurringTransfer.name?.trim() || undefined,
            }
          : undefined,
  };
}
