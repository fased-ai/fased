import type { Command } from "commander";
import { defaultRuntime } from "../runtime.js";
import { theme } from "../terminal/theme.js";
import { runCommandWithRuntime } from "./cli-utils.js";
import { formatCliCommand } from "./command-format.js";
import type { GatewayRpcOpts } from "./gateway-rpc.js";
import { addGatewayClientOptions, callGatewayFromCli } from "./gateway-rpc.js";
import { formatHelpExamples } from "./help-format.js";

type MiningGatewayOpts = GatewayRpcOpts & {
  json?: boolean;
  wallet?: string;
  window?: string;
  activityWindow?: string;
  maxPoints?: string;
  sol?: string;
  lamports?: string;
};

const LAMPORTS_PER_SOL = 1_000_000_000n;

function runMiningCommand(action: () => Promise<void>, label?: string) {
  return runCommandWithRuntime(defaultRuntime, action, (err) => {
    const message = err instanceof Error ? err.message : String(err);
    defaultRuntime.error(label ? `${label}: ${message}` : message);
    defaultRuntime.exit(1);
  });
}

function renderResult(result: unknown, opts: { json?: boolean }, successText?: string): void {
  if (opts.json || successText === undefined) {
    defaultRuntime.log(JSON.stringify(result, null, 2));
    return;
  }
  defaultRuntime.log(successText);
}

async function runMiningGatewayCommand(
  method: string,
  opts: MiningGatewayOpts,
  params?: unknown,
  successText?: string,
  extra?: { expectFinal?: boolean; render?: boolean },
): Promise<unknown> {
  const result = await callGatewayFromCli(method, opts, params, {
    expectFinal: extra?.expectFinal ?? false,
  });
  if (extra?.render !== false) {
    renderResult(result, opts, successText);
  }
  return result;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function extractGatewayPayload(result: unknown): unknown {
  let current = result;
  for (let index = 0; index < 3; index += 1) {
    const record = asRecord(current);
    if (!record || !("payload" in record)) {
      return current;
    }
    current = record.payload;
  }
  return current;
}

function readBoolean(
  record: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const value = record?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function readMiningGatewayStatus(result: unknown): {
  payload: Record<string, unknown>;
  status: Record<string, unknown> | undefined;
} {
  const payload = asRecord(extractGatewayPayload(result)) ?? {};
  return {
    payload,
    status: asRecord(payload.status),
  };
}

function readMiningStatusDetail(status: Record<string, unknown> | undefined): string {
  for (const key of ["nextActionDetail", "bootstrapReason", "blockedReason"]) {
    const value = status?.[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "No status detail returned.";
}

function renderMiningStartResult(result: unknown, opts: MiningGatewayOpts): void {
  if (opts.json) {
    renderResult(result, opts);
    return;
  }
  const { payload, status } = readMiningGatewayStatus(result);
  const running = readBoolean(status, "running") === true;
  const drainOnly = readBoolean(status, "drainOnly") === true;
  const enabledWanted = readBoolean(status, "enabledWanted");
  const started = payload.started === true && running && !drainOnly && enabledWanted !== false;
  if (!started) {
    throw new Error(
      `Start was requested, but SAT mining is not running. ${readMiningStatusDetail(status)}`,
    );
  }
  defaultRuntime.log("SAT mining started");
}

function renderMiningStopResult(result: unknown, opts: MiningGatewayOpts): void {
  if (opts.json) {
    renderResult(result, opts);
    return;
  }
  const { payload, status } = readMiningGatewayStatus(result);
  const running = readBoolean(status, "running") === true;
  const drainOnly = readBoolean(status, "drainOnly") === true;
  const stopped = payload.stopped === true && !running;
  if (stopped) {
    defaultRuntime.log("SAT mining stopped");
    return;
  }
  if (payload.stopped === true && drainOnly) {
    defaultRuntime.log(
      "New SAT mining cycles stopped; drain/recovery remains active until locked capital is free.",
    );
    return;
  }
  throw new Error(
    `Stop was requested, but SAT mining is still running. ${readMiningStatusDetail(status)}`,
  );
}

function parsePositiveInt(raw: string | undefined, label: string): number | undefined {
  if (!raw) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function normalizeWalletId(raw: string | undefined): string | undefined {
  const walletId = typeof raw === "string" ? raw.trim() : "";
  return walletId ? walletId : undefined;
}

function parseLamportsInput(opts: { sol?: string; lamports?: string }): string {
  const lamportsRaw = typeof opts.lamports === "string" ? opts.lamports.trim() : "";
  const solRaw = typeof opts.sol === "string" ? opts.sol.trim() : "";
  if (lamportsRaw && solRaw) {
    throw new Error("Use either --sol or --lamports, not both");
  }
  if (lamportsRaw) {
    if (!/^\d+$/.test(lamportsRaw)) {
      throw new Error("--lamports must be a non-negative integer string");
    }
    return lamportsRaw;
  }
  if (!solRaw) {
    throw new Error("One of --sol or --lamports is required");
  }
  if (!/^\d+(\.\d{0,9})?$/.test(solRaw)) {
    throw new Error("--sol must be a non-negative number with up to 9 decimal places");
  }
  const [wholePart, fractionPart = ""] = solRaw.split(".");
  const lamports =
    BigInt(wholePart || "0") * LAMPORTS_PER_SOL +
    BigInt((fractionPart + "000000000").slice(0, 9) || "0");
  return lamports.toString();
}

export function registerMiningCli(program: Command) {
  const mining = program
    .command("mining")
    .description("Operate SAT mining without going through the Control UI")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          [formatCliCommand("fased mining status"), "Show live mining status and issuance state."],
          [
            formatCliCommand("fased mining start --wallet solana-1"),
            "Start SAT mining for an explicit wallet id.",
          ],
          [
            formatCliCommand("fased mining deposit-capital --sol 1"),
            "Move 1 SOL into miner capital.",
          ],
          [
            formatCliCommand("fased mining set-commit --sol 0.75"),
            "Set the active SAT commit amount.",
          ],
        ])}\n`,
    );

  addGatewayClientOptions(
    mining
      .command("status")
      .description("Show live SAT mining status")
      .option("--json", "Output JSON", false),
  ).action(async (opts: MiningGatewayOpts) => {
    await runMiningCommand(async () => {
      await runMiningGatewayCommand("sat.getMiningStatus", opts);
    }, "Mining status failed");
  });

  addGatewayClientOptions(
    mining
      .command("readiness")
      .description("Show SAT mining readiness for the selected or provided wallet")
      .option("--wallet <walletId>", "Wallet id to inspect")
      .option("--json", "Output JSON", false),
  ).action(async (opts: MiningGatewayOpts) => {
    await runMiningCommand(async () => {
      await runMiningGatewayCommand("sat.getMiningReadiness", opts, {
        walletId: normalizeWalletId(opts.wallet),
      });
    }, "Mining readiness failed");
  });

  addGatewayClientOptions(
    mining
      .command("wallets")
      .description("List mining-eligible wallets")
      .option("--json", "Output JSON", false),
  ).action(async (opts: MiningGatewayOpts) => {
    await runMiningCommand(async () => {
      await runMiningGatewayCommand("sat.listMiningWallets", opts);
    }, "Mining wallet list failed");
  });

  addGatewayClientOptions(
    mining
      .command("start")
      .description("Start SAT mining for the active or provided wallet")
      .option("--wallet <walletId>", "Wallet id to attach before starting")
      .option("--json", "Output JSON", false),
  ).action(async (opts: MiningGatewayOpts) => {
    await runMiningCommand(async () => {
      const startOpts = {
        ...opts,
        timeout: opts.timeout === "30000" || opts.timeout == null ? "90000" : opts.timeout,
      };
      const result = await runMiningGatewayCommand(
        "sat.startMining",
        startOpts,
        {
          walletId: normalizeWalletId(opts.wallet),
        },
        undefined,
        { expectFinal: true, render: false },
      );
      renderMiningStartResult(result, opts);
    }, "Start mining failed");
  });

  addGatewayClientOptions(
    mining.command("stop").description("Stop SAT mining").option("--json", "Output JSON", false),
  ).action(async (opts: MiningGatewayOpts) => {
    await runMiningCommand(async () => {
      const result = await runMiningGatewayCommand("sat.stopMining", opts, undefined, undefined, {
        expectFinal: true,
        render: false,
      });
      renderMiningStopResult(result, opts);
    }, "Stop mining failed");
  });

  addGatewayClientOptions(
    mining
      .command("history")
      .description("Show SAT mining history and activity windows")
      .option("--window <window>", "History window (for example 24h or 7d)")
      .option("--activity-window <window>", "Activity window override")
      .option("--max-points <n>", "Max points to return")
      .option("--json", "Output JSON", false),
  ).action(async (opts: MiningGatewayOpts) => {
    await runMiningCommand(async () => {
      await runMiningGatewayCommand("sat.getMiningHistory", opts, {
        window: typeof opts.window === "string" ? opts.window.trim() || undefined : undefined,
        activityWindow:
          typeof opts.activityWindow === "string"
            ? opts.activityWindow.trim() || undefined
            : undefined,
        maxPoints: parsePositiveInt(opts.maxPoints, "--max-points"),
      });
    }, "Mining history failed");
  });

  addGatewayClientOptions(
    mining
      .command("claim-backlog")
      .description("Claim the oldest ready SAT reward backlog batch")
      .option("--json", "Output JSON", false),
  ).action(async (opts: MiningGatewayOpts) => {
    await runMiningCommand(async () => {
      await runMiningGatewayCommand("sat.claimBacklog", opts, undefined, "Claim backlog submitted");
    }, "Claim backlog failed");
  });

  const keeper = mining.command("keeper").description("Run permissionless SAT keeper work");
  addGatewayClientOptions(
    keeper
      .command("run")
      .description("Run one SAT keeper/cranker settlement tick")
      .option("--once", "Run one tick and exit", true)
      .option("--json", "Output JSON", false),
  ).action(async (opts: MiningGatewayOpts) => {
    await runMiningCommand(async () => {
      await runMiningGatewayCommand("sat.runKeeperOnce", opts, undefined, "Keeper tick submitted");
    }, "Keeper tick failed");
  });

  const cleanup = mining.command("cleanup").description("Recover rent from resolved SAT accounts");
  addGatewayClientOptions(
    cleanup
      .command("resolved")
      .description("Close resolved cycle accounts for a specific cycle")
      .requiredOption("--cycle <id>", "Cycle id to clean")
      .option("--json", "Output JSON", false),
  ).action(async (opts: MiningGatewayOpts & { cycle?: string }) => {
    await runMiningCommand(async () => {
      const cycleId = parsePositiveInt(opts.cycle, "--cycle");
      await runMiningGatewayCommand(
        "sat.closeResolvedCycleAccounts",
        opts,
        { cycleId },
        "Resolved cycle cleanup submitted",
      );
    }, "Resolved cycle cleanup failed");
  });

  addGatewayClientOptions(
    mining
      .command("deposit-capital")
      .description("Deposit SOL into SAT miner capital")
      .option("--sol <amount>", "SOL amount to deposit")
      .option("--lamports <amount>", "Lamports amount to deposit")
      .option("--json", "Output JSON", false),
  ).action(async (opts: MiningGatewayOpts) => {
    await runMiningCommand(async () => {
      await runMiningGatewayCommand(
        "sat.depositMinerCapital",
        opts,
        { lamports: parseLamportsInput(opts) },
        "Miner capital deposited",
      );
    }, "Deposit miner capital failed");
  });

  addGatewayClientOptions(
    mining
      .command("withdraw-capital")
      .description("Withdraw SOL from SAT miner capital")
      .option("--sol <amount>", "SOL amount to withdraw")
      .option("--lamports <amount>", "Lamports amount to withdraw")
      .option("--json", "Output JSON", false),
  ).action(async (opts: MiningGatewayOpts) => {
    await runMiningCommand(async () => {
      await runMiningGatewayCommand(
        "sat.withdrawMinerCapital",
        opts,
        { lamports: parseLamportsInput(opts) },
        "Miner capital withdrawn",
      );
    }, "Withdraw miner capital failed");
  });

  addGatewayClientOptions(
    mining
      .command("set-commit")
      .description("Set the active SAT mining commit amount")
      .option("--sol <amount>", "SOL amount to commit")
      .option("--lamports <amount>", "Lamports amount to commit")
      .option("--no-persist-config", "Do not persist the commit in runtime config")
      .option("--json", "Output JSON", false),
  ).action(async (opts: MiningGatewayOpts & { persistConfig?: boolean }) => {
    await runMiningCommand(async () => {
      await runMiningGatewayCommand(
        "sat.setActiveCommit",
        opts,
        {
          lamports: parseLamportsInput(opts),
          persistConfig: opts.persistConfig !== false,
        },
        "Mining commit updated",
      );
    }, "Set mining commit failed");
  });
}
