import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Command } from "commander";
import { resolveStateDir } from "../config/paths.js";
import { withFileLock, type FileLockOptions } from "../plugin-sdk/file-lock.js";
import { defaultRuntime } from "../runtime.js";
import { theme } from "../terminal/theme.js";
import {
  serializeWalletState,
  writeWalletStateFileAtomically,
} from "../wallet/wallet-atomic-state.js";
import { runCommandWithRuntime } from "./cli-utils.js";
import { formatCliCommand } from "./command-format.js";
import type { GatewayRpcOpts } from "./gateway-rpc.js";
import { addGatewayClientOptions, callGatewayFromCli } from "./gateway-rpc.js";
import { formatHelpExamples } from "./help-format.js";

type SatGatewayOpts = GatewayRpcOpts & {
  json?: boolean;
  targetReserveSol?: string;
  targetReserveLamports?: string;
  minSol?: string;
  minSolLamports?: string;
  minSatRaw?: string;
  loop?: boolean;
  intervalSeconds?: string;
  jitterSeconds?: string;
  maxIterations?: string;
  cleanupMaxCycles?: string;
  cleanupBudgetMs?: string;
  cleanupMaxTransactions?: string;
  cleanupBatchMode?: string;
  cleanupMaxBatchInstructions?: string;
  cleanupScanMode?: string;
  statusMode?: string;
  includeStatus?: string;
  logFile?: string;
  lockFile?: string;
  staleLockSeconds?: string;
  manifestUrl?: string;
  idempotencyKey?: string;
};

const LAMPORTS_PER_SOL = 1_000_000_000n;
const DEFAULT_MAINTAIN_INTERVAL_SECONDS = 300;
const DEFAULT_MAINTAIN_JITTER_SECONDS = 30;
const DEFAULT_STALE_LOCK_SECONDS = 900;
const SAT_MAINTENANCE_IDEMPOTENCY_VERSION = 1;
const SAT_MAINTENANCE_IDEMPOTENCY_LIMIT = 64;
const SAT_MAINTENANCE_IDEMPOTENCY_LOCK_OPTIONS: FileLockOptions = {
  retries: {
    retries: 120,
    factor: 1.15,
    minTimeout: 10,
    maxTimeout: 100,
    randomize: true,
  },
  stale: 120_000,
};

type SatMaintenancePendingIdempotency = {
  idempotencyKey: string;
  paramsDigest: string;
  createdAt: string;
};

type SatMaintenanceIdempotencyFile = {
  version: typeof SAT_MAINTENANCE_IDEMPOTENCY_VERSION;
  pending: Record<string, SatMaintenancePendingIdempotency>;
};

function runSatCommand(action: () => Promise<void>, label?: string) {
  return runCommandWithRuntime(defaultRuntime, action, (err) => {
    const message = err instanceof Error ? err.message : String(err);
    defaultRuntime.error(label ? `${label}: ${message}` : message);
    defaultRuntime.exit(1);
  });
}

function parseLamportsPair(
  solRaw: string | undefined,
  lamportsRaw: string | undefined,
  labels: { sol: string; lamports: string },
): string | undefined {
  const sol = typeof solRaw === "string" ? solRaw.trim() : "";
  const lamports = typeof lamportsRaw === "string" ? lamportsRaw.trim() : "";
  if (sol && lamports) {
    throw new Error(`Use either ${labels.sol} or ${labels.lamports}, not both`);
  }
  if (lamports) {
    if (!/^\d+$/.test(lamports)) {
      throw new Error(`${labels.lamports} must be a non-negative integer string`);
    }
    return lamports;
  }
  if (!sol) {
    return undefined;
  }
  if (!/^\d+(\.\d{0,9})?$/.test(sol)) {
    throw new Error(`${labels.sol} must be a non-negative number with up to 9 decimals`);
  }
  const [wholePart, fractionPart = ""] = sol.split(".");
  return (
    BigInt(wholePart || "0") * LAMPORTS_PER_SOL +
    BigInt((fractionPart + "000000000").slice(0, 9) || "0")
  ).toString();
}

function parseNonNegativeInteger(raw: string | undefined, label: string): string | undefined {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) {
    return undefined;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error(`${label} must be a non-negative integer string`);
  }
  return value;
}

function parseMaintenanceStatusMode(raw: string | undefined): string | undefined {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!value) {
    return undefined;
  }
  if (!["compact", "ui", "debug", "none"].includes(value)) {
    throw new Error("--status-mode must be compact, ui, debug, or none");
  }
  return value;
}

function parseMaintenanceCleanupScanMode(raw: string | undefined): string | undefined {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!value) {
    return undefined;
  }
  if (!["recent", "scan", "auto"].includes(value)) {
    throw new Error("--cleanup-scan-mode must be recent, scan, or auto");
  }
  return value;
}

function parseMaintenanceCleanupBatchMode(raw: string | undefined): string | undefined {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!value) {
    return undefined;
  }
  if (!["off", "auto"].includes(value)) {
    throw new Error("--cleanup-batch-mode must be off or auto");
  }
  return value;
}

function parseNonNegativeIntegerNumber(
  raw: string | undefined,
  label: string,
  fallback: number,
): number {
  const parsed = parseNonNegativeInteger(raw, label);
  if (parsed === undefined) {
    return fallback;
  }
  const value = Number(parsed);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} must be a safe non-negative integer`);
  }
  return value;
}

function parseOptionalPositiveInteger(raw: string | undefined, label: string): number | undefined {
  const parsed = parseNonNegativeInteger(raw, label);
  if (parsed === undefined) {
    return undefined;
  }
  const value = Number(parsed);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function normalizeMaintenanceIdempotencyKey(raw: string): string {
  const value = raw.trim();
  if (!value || value.length > 160 || /[^\x20-\x7e]/u.test(value)) {
    throw new Error("--idempotency-key must contain 1-160 printable characters");
  }
  return value;
}

function maintenanceParamsDigest(params: Record<string, string>): string {
  const canonical = Object.fromEntries(
    Object.entries(params).toSorted(([left], [right]) => left.localeCompare(right)),
  );
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function maintenanceIdempotencyPath(): string {
  return join(resolveStateDir(process.env), "sat-mining", "maintenance-cli-idempotency.json");
}

async function readMaintenanceIdempotencyFile(
  filePath: string,
): Promise<SatMaintenanceIdempotencyFile> {
  try {
    const parsed = JSON.parse(
      await readFile(filePath, "utf8"),
    ) as Partial<SatMaintenanceIdempotencyFile>;
    if (
      parsed.version !== SAT_MAINTENANCE_IDEMPOTENCY_VERSION ||
      !parsed.pending ||
      typeof parsed.pending !== "object" ||
      Array.isArray(parsed.pending)
    ) {
      throw new Error(`invalid SAT maintenance idempotency state at ${filePath}`);
    }
    const pending: Record<string, SatMaintenancePendingIdempotency> = {};
    for (const [digest, value] of Object.entries(parsed.pending)) {
      if (
        !/^[0-9a-f]{64}$/u.test(digest) ||
        !value ||
        typeof value.idempotencyKey !== "string" ||
        value.paramsDigest !== digest ||
        typeof value.createdAt !== "string"
      ) {
        throw new Error(`invalid SAT maintenance idempotency record ${digest}`);
      }
      pending[digest] = {
        idempotencyKey: normalizeMaintenanceIdempotencyKey(value.idempotencyKey),
        paramsDigest: digest,
        createdAt: value.createdAt,
      };
    }
    return { version: SAT_MAINTENANCE_IDEMPOTENCY_VERSION, pending };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: SAT_MAINTENANCE_IDEMPOTENCY_VERSION, pending: {} };
    }
    throw error;
  }
}

function trimMaintenanceIdempotencyEntries(
  pending: Record<string, SatMaintenancePendingIdempotency>,
): Record<string, SatMaintenancePendingIdempotency> {
  return Object.fromEntries(
    Object.entries(pending)
      .toSorted(([, left], [, right]) => left.createdAt.localeCompare(right.createdAt))
      .slice(-SAT_MAINTENANCE_IDEMPOTENCY_LIMIT),
  );
}

async function claimMaintenanceIdempotency(
  params: Record<string, string>,
  explicitKey?: string,
): Promise<{ idempotencyKey: string; paramsDigest: string; managed: boolean }> {
  const paramsDigest = maintenanceParamsDigest(params);
  if (explicitKey?.trim()) {
    return {
      idempotencyKey: normalizeMaintenanceIdempotencyKey(explicitKey),
      paramsDigest,
      managed: false,
    };
  }
  const filePath = maintenanceIdempotencyPath();
  return await withFileLock(filePath, SAT_MAINTENANCE_IDEMPOTENCY_LOCK_OPTIONS, async () => {
    const state = await readMaintenanceIdempotencyFile(filePath);
    const existing = state.pending[paramsDigest];
    if (existing) {
      return { ...existing, managed: true };
    }
    const pending: SatMaintenancePendingIdempotency = {
      idempotencyKey: `sat-maintain-${randomUUID()}`,
      paramsDigest,
      createdAt: new Date().toISOString(),
    };
    state.pending[paramsDigest] = pending;
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
    writeWalletStateFileAtomically(
      filePath,
      serializeWalletState({
        version: SAT_MAINTENANCE_IDEMPOTENCY_VERSION,
        pending: trimMaintenanceIdempotencyEntries(state.pending),
      }),
    );
    return { ...pending, managed: true };
  });
}

async function completeMaintenanceIdempotency(claim: {
  idempotencyKey: string;
  paramsDigest: string;
  managed: boolean;
}): Promise<void> {
  if (!claim.managed) {
    return;
  }
  const filePath = maintenanceIdempotencyPath();
  await withFileLock(filePath, SAT_MAINTENANCE_IDEMPOTENCY_LOCK_OPTIONS, async () => {
    const state = await readMaintenanceIdempotencyFile(filePath);
    if (state.pending[claim.paramsDigest]?.idempotencyKey !== claim.idempotencyKey) {
      return;
    }
    delete state.pending[claim.paramsDigest];
    writeWalletStateFileAtomically(filePath, serializeWalletState(state));
  });
}

function renderSatResult(result: unknown, opts: { json?: boolean }, successText?: string): void {
  if (opts.json || successText === undefined) {
    defaultRuntime.log(JSON.stringify(result, null, 2));
    return;
  }
  defaultRuntime.log(successText);
}

function renderSatMainnetSyncResult(result: unknown, opts: SatGatewayOpts): void {
  if (opts.json) {
    renderSatResult(result, opts);
    return;
  }
  const payload =
    result && typeof result === "object" && !Array.isArray(result)
      ? (result as { payload?: unknown }).payload
      : undefined;
  const sync =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as { state?: unknown; message?: unknown; verification?: unknown })
      : null;
  const state = typeof sync?.state === "string" ? sync.state : "unknown";
  const message = typeof sync?.message === "string" ? sync.message : "No sync detail returned.";
  defaultRuntime.log(`SAT mainnet sync: ${state}`);
  defaultRuntime.log(message);
  if (state !== "synced" && state !== "not_live") {
    defaultRuntime.exit(1);
  }
}

function buildMaintenanceParams(opts: SatGatewayOpts): Record<string, string> {
  const targetBalanceLamports = parseLamportsPair(
    opts.targetReserveSol,
    opts.targetReserveLamports,
    { sol: "--target-reserve-sol", lamports: "--target-reserve-lamports" },
  );
  const minSolLamports = parseLamportsPair(opts.minSol, opts.minSolLamports, {
    sol: "--min-sol",
    lamports: "--min-sol-lamports",
  });
  const minSatRaw = parseNonNegativeInteger(opts.minSatRaw, "--min-sat-raw");
  const cleanupMaxCycles = parseNonNegativeInteger(opts.cleanupMaxCycles, "--cleanup-max-cycles");
  const cleanupBudgetMs = parseNonNegativeInteger(opts.cleanupBudgetMs, "--cleanup-budget-ms");
  const cleanupMaxTransactions = parseNonNegativeInteger(
    opts.cleanupMaxTransactions,
    "--cleanup-max-transactions",
  );
  const cleanupMaxBatchInstructions = parseNonNegativeInteger(
    opts.cleanupMaxBatchInstructions,
    "--cleanup-max-batch-instructions",
  );
  const cleanupBatchMode = parseMaintenanceCleanupBatchMode(opts.cleanupBatchMode);
  const cleanupScanMode = parseMaintenanceCleanupScanMode(opts.cleanupScanMode);
  const statusMode = parseMaintenanceStatusMode(opts.statusMode);
  return {
    ...(targetBalanceLamports ? { targetBalanceLamports } : {}),
    ...(minSolLamports ? { minSolLamports } : {}),
    ...(minSatRaw ? { minSatRaw } : {}),
    ...(cleanupMaxCycles ? { cleanupMaxCycles } : {}),
    ...(cleanupBudgetMs ? { cleanupBudgetMs } : {}),
    ...(cleanupMaxTransactions ? { cleanupMaxTransactions } : {}),
    ...(cleanupMaxBatchInstructions ? { cleanupMaxBatchInstructions } : {}),
    ...(cleanupBatchMode ? { cleanupBatchMode } : {}),
    ...(cleanupScanMode ? { cleanupScanMode } : {}),
    ...(statusMode ? { statusMode } : {}),
  };
}

async function appendMaintenanceLog(logFile: string | undefined, record: unknown): Promise<void> {
  if (!logFile) {
    return;
  }
  await mkdir(dirname(logFile), { recursive: true });
  await appendFile(logFile, `${JSON.stringify(record)}\n`, "utf8");
}

async function acquireMaintenanceLock(lockFile: string, staleAfterMs: number) {
  try {
    return await open(lockFile, "wx");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
      throw error;
    }
    let detail = "";
    try {
      detail = (await readFile(lockFile, "utf8")).trim();
    } catch {
      detail = "";
    }
    const pid = parseMaintenanceLockPid(detail);
    if (pid !== undefined && !isProcessAlive(pid)) {
      await rm(lockFile, { force: true });
      return acquireMaintenanceLock(lockFile, staleAfterMs);
    }
    let lockAgeMs = 0;
    try {
      const lockStat = await stat(lockFile);
      lockAgeMs = Date.now() - lockStat.mtimeMs;
    } catch {
      lockAgeMs = staleAfterMs + 1;
    }
    if (staleAfterMs > 0 && lockAgeMs > staleAfterMs) {
      await rm(lockFile, { force: true });
      return acquireMaintenanceLock(lockFile, staleAfterMs);
    }
    throw new Error(
      `SAT maintenance loop already running; lock file ${lockFile}${detail ? ` (${detail})` : ""}`,
      { cause: error },
    );
  }
}

function parseMaintenanceLockPid(detail: string): number | undefined {
  if (!detail) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(detail) as { pid?: unknown };
    if (typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0) {
      return parsed.pid;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function withMaintenanceLock<T>(opts: SatGatewayOpts, action: () => Promise<T>): Promise<T> {
  const lockFile = opts.lockFile || join(tmpdir(), "fased-sat-maintain.lock");
  await mkdir(dirname(lockFile), { recursive: true });
  const staleAfterMs =
    parseNonNegativeIntegerNumber(
      opts.staleLockSeconds,
      "--stale-lock-seconds",
      DEFAULT_STALE_LOCK_SECONDS,
    ) * 1000;
  const handle = await acquireMaintenanceLock(lockFile, staleAfterMs);
  let released = false;
  const release = async () => {
    if (released) {
      return;
    }
    released = true;
    await handle.close().catch(() => undefined);
    await rm(lockFile, { force: true }).catch(() => undefined);
  };
  const handleSignal = (signal: NodeJS.Signals) => {
    release()
      .catch(() => undefined)
      .finally(() => {
        process.exit(signal === "SIGINT" ? 130 : 143);
      });
  };
  try {
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
      "utf8",
    );
    process.once("SIGINT", handleSignal);
    process.once("SIGTERM", handleSignal);
    return await action();
  } finally {
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
    await release();
  }
}

async function callMaintenancePass(opts: SatGatewayOpts): Promise<unknown> {
  const params = buildMaintenanceParams(opts);
  const claim = await claimMaintenanceIdempotency(params, opts.idempotencyKey);
  const result = await callGatewayFromCli("sat.runProtocolMaintenanceOnce", opts, {
    ...params,
    idempotencyKey: claim.idempotencyKey,
  });
  await completeMaintenanceIdempotency(claim);
  return result;
}

function summarizeMaintenanceResult(result: unknown): unknown {
  if (!result || typeof result !== "object") {
    return result;
  }
  const envelope = result as {
    ok?: unknown;
    payload?: {
      submitted?: unknown;
      status?: {
        currentCycleId?: unknown;
        running?: unknown;
        nextAction?: unknown;
        lanes?: unknown;
        cleanup?: unknown;
        updatedAt?: unknown;
      };
    };
  };
  if (!envelope.payload || typeof envelope.payload !== "object") {
    return result;
  }
  return {
    ok: envelope.ok,
    submitted: envelope.payload.submitted,
    status: envelope.payload.status
      ? {
          currentCycleId: envelope.payload.status.currentCycleId,
          running: envelope.payload.status.running,
          nextAction: envelope.payload.status.nextAction,
          lanes: envelope.payload.status.lanes,
          cleanup: envelope.payload.status.cleanup,
          updatedAt: envelope.payload.status.updatedAt,
        }
      : undefined,
  };
}

function maintenanceDelayMs(intervalSeconds: number, jitterSeconds: number): number {
  const baseMs = intervalSeconds * 1000;
  if (jitterSeconds <= 0) {
    return baseMs;
  }
  return baseMs + Math.floor(Math.random() * (jitterSeconds * 1000 + 1));
}

async function runMaintenanceLoop(opts: SatGatewayOpts): Promise<void> {
  if (opts.idempotencyKey?.trim()) {
    throw new Error(
      "--idempotency-key is for one maintenance pass; loop mode manages a durable key per pass",
    );
  }
  const intervalSeconds = parseNonNegativeIntegerNumber(
    opts.intervalSeconds,
    "--interval-seconds",
    DEFAULT_MAINTAIN_INTERVAL_SECONDS,
  );
  const jitterSeconds = parseNonNegativeIntegerNumber(
    opts.jitterSeconds,
    "--jitter-seconds",
    DEFAULT_MAINTAIN_JITTER_SECONDS,
  );
  const maxIterations = parseOptionalPositiveInteger(opts.maxIterations, "--max-iterations");
  const continuous = maxIterations === undefined;
  await withMaintenanceLock(opts, async () => {
    for (let pass = 1; maxIterations === undefined || pass <= maxIterations; pass += 1) {
      const startedAt = new Date().toISOString();
      try {
        const result = await callMaintenancePass(opts);
        const summary = summarizeMaintenanceResult(result);
        await appendMaintenanceLog(opts.logFile, {
          ts: new Date().toISOString(),
          event: "sat-maintain",
          pass,
          status: "success",
          result: summary,
        });
        if (opts.json) {
          defaultRuntime.log(JSON.stringify({ pass, result: summary }, null, 2));
        } else {
          defaultRuntime.log(`SAT protocol maintenance pass ${pass} ok`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await appendMaintenanceLog(opts.logFile, {
          ts: new Date().toISOString(),
          event: "sat-maintain",
          pass,
          status: "failure",
          error: message,
          startedAt,
        });
        defaultRuntime.error(`SAT protocol maintenance pass ${pass} failed: ${message}`);
        if (!continuous) {
          throw error;
        }
      }
      if (maxIterations !== undefined && pass >= maxIterations) {
        break;
      }
      await sleep(maintenanceDelayMs(intervalSeconds, jitterSeconds));
    }
  });
}

export function registerSatCli(program: Command) {
  const sat = program
    .command("sat")
    .description("SAT protocol operator tools")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          [
            formatCliCommand("fased sat maintain --target-reserve-sol 1 --json"),
            "Run one permissionless SAT protocol maintenance pass.",
          ],
          [
            formatCliCommand("fased sat maintain --min-sol 0.01 --min-sat-raw 100000000000"),
            "Skip tiny pending protocol lanes.",
          ],
          [
            formatCliCommand(
              "fased sat maintain --loop --interval-seconds 300 --jitter-seconds 30 --log-file ~/.fased/sat-maintainer.jsonl",
            ),
            "Run a local periodic maintainer loop with jitter and JSONL audit records.",
          ],
          [
            formatCliCommand("fased sat sync-mainnet"),
            "Fetch and verify the official SAT mainnet manifest.",
          ],
        ])}\n`,
    );

  addGatewayClientOptions(
    sat
      .command("sync-mainnet")
      .description("Fetch and verify the official SAT mainnet manifest, then apply verified IDs")
      .option("--manifest-url <url>", "Override the official manifest URL")
      .option("--json", "Output JSON", false),
  ).action(async (opts: SatGatewayOpts) => {
    await runSatCommand(async () => {
      const result = await callGatewayFromCli(
        "sat.syncMainnet",
        opts,
        opts.manifestUrl ? { manifestUrl: opts.manifestUrl.trim() } : undefined,
        { expectFinal: true },
      );
      renderSatMainnetSyncResult(result, opts);
    }, "SAT mainnet sync failed");
  });

  addGatewayClientOptions(
    sat
      .command("maintain")
      .description(
        "Run one safe SAT protocol maintenance pass: reserve refill, fixed-recipient protocol claims, and bounded cleanup",
      )
      .option("--target-reserve-sol <amount>", "Reserve target in SOL")
      .option("--target-reserve-lamports <amount>", "Reserve target in lamports")
      .option("--min-sol <amount>", "Minimum pending SOL lane to submit")
      .option("--min-sol-lamports <amount>", "Minimum pending SOL lane in lamports")
      .option("--min-sat-raw <amount>", "Minimum pending SAT raw units to submit")
      .option("--loop", "Run continuously with interval, jitter, and a local lock", false)
      .option(
        "--interval-seconds <seconds>",
        "Loop interval before jitter",
        `${DEFAULT_MAINTAIN_INTERVAL_SECONDS}`,
      )
      .option(
        "--jitter-seconds <seconds>",
        "Random extra loop delay",
        `${DEFAULT_MAINTAIN_JITTER_SECONDS}`,
      )
      .option(
        "--max-iterations <count>",
        "Stop after N loop passes; useful for tests and smoke runs",
      )
      .option(
        "--cleanup-max-cycles <count>",
        "Maximum settled cycles to cleanup per maintenance pass",
      )
      .option(
        "--cleanup-budget-ms <ms>",
        "Cleanup time budget per maintenance pass; remaining cleanup is deferred",
      )
      .option(
        "--cleanup-max-transactions <count>",
        "Maximum cleanup transactions to submit per maintenance pass",
      )
      .option("--cleanup-batch-mode <mode>", "Cleanup batching mode: off or auto")
      .option(
        "--cleanup-max-batch-instructions <count>",
        "Maximum cleanup close instructions per batch transaction",
      )
      .option("--cleanup-scan-mode <mode>", "Cleanup discovery mode: recent, scan, or auto")
      .option("--status-mode <mode>", "Response status mode: compact, ui, debug, or none")
      .option(
        "--idempotency-key <key>",
        "Retry key for one pass; reuse the same key after an ambiguous result",
      )
      .option("--log-file <path>", "Append JSONL audit records")
      .option("--lock-file <path>", "Local lock file for the loop")
      .option(
        "--stale-lock-seconds <seconds>",
        "Remove a stale loop lock after this age",
        `${DEFAULT_STALE_LOCK_SECONDS}`,
      )
      .option("--json", "Output JSON", false),
  ).action(async (opts: SatGatewayOpts) => {
    await runSatCommand(async () => {
      if (opts.loop) {
        await runMaintenanceLoop(opts);
        return;
      }
      const result = await callMaintenancePass(opts);
      renderSatResult(result, opts, "SAT protocol maintenance pass submitted");
    }, "SAT protocol maintenance failed");
  });
}
