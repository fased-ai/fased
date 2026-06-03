import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Command } from "commander";
import { sleep } from "fased/plugin-sdk";
import type { VoiceCallConfig } from "./config.js";
import type { VoiceCallRuntime } from "./runtime.js";
import { resolveUserPath } from "./utils.js";
import {
  cleanupTailscaleExposureRoute,
  getTailscaleSelfInfo,
  setupTailscaleExposureRoute,
} from "./webhook.js";

type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

function resolveMode(input: string): "off" | "serve" | "funnel" {
  const raw = input.trim().toLowerCase();
  if (raw === "serve" || raw === "off") {
    return raw;
  }
  return "funnel";
}

function resolveDefaultStorePath(config: VoiceCallConfig): string {
  const preferred = path.join(os.homedir(), ".fased", "voice-calls");
  const resolvedPreferred = resolveUserPath(preferred);
  const existing =
    [resolvedPreferred].find((dir) => {
      try {
        return fs.existsSync(path.join(dir, "calls.jsonl")) || fs.existsSync(dir);
      } catch {
        return false;
      }
    }) ?? resolvedPreferred;
  const base = config.store?.trim() ? resolveUserPath(config.store) : existing;
  return path.join(base, "calls.jsonl");
}

export function registerVoiceCallCli(params: {
  program: Command;
  config: VoiceCallConfig;
  ensureRuntime: () => Promise<VoiceCallRuntime>;
  logger: Logger;
}) {
  const { program, config, ensureRuntime, logger } = params;
  const root = program
    .command("voicecall")
    .description("Voice call utilities")
    .addHelpText("after", () => `\nDocs: https://docs.fased.ai/cli/voicecall\n`);

  root
    .command("call")
    .description("Initiate an outbound voice call")
    .requiredOption("-m, --message <text>", "Message to speak when call connects")
    .option(
      "-t, --to <phone>",
      "Phone number to call (E.164 format, uses config toNumber if not set)",
    )
    .option(
      "--mode <mode>",
      "Call mode: notify (hangup after message) or conversation (stay open)",
      "conversation",
    )
    .action(async (options: { message: string; to?: string; mode?: string }) => {
      const rt = await ensureRuntime();
      const to = options.to ?? rt.config.toNumber;
      if (!to) {
        throw new Error("Missing --to and no toNumber configured");
      }
      const result = await rt.manager.initiateCall(to, undefined, {
        message: options.message,
        mode:
          options.mode === "notify" || options.mode === "conversation" ? options.mode : undefined,
      });
      if (!result.success) {
        throw new Error(result.error || "initiate failed");
      }
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ callId: result.callId }, null, 2));
    });

  root
    .command("start")
    .description("Alias for voicecall call")
    .requiredOption("--to <phone>", "Phone number to call")
    .option("--message <text>", "Message to speak when call connects")
    .option(
      "--mode <mode>",
      "Call mode: notify (hangup after message) or conversation (stay open)",
      "conversation",
    )
    .action(async (options: { to: string; message?: string; mode?: string }) => {
      const rt = await ensureRuntime();
      const result = await rt.manager.initiateCall(options.to, undefined, {
        message: options.message,
        mode:
          options.mode === "notify" || options.mode === "conversation" ? options.mode : undefined,
      });
      if (!result.success) {
        throw new Error(result.error || "initiate failed");
      }
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ callId: result.callId }, null, 2));
    });

  root
    .command("continue")
    .description("Speak a message and wait for a response")
    .requiredOption("--call-id <id>", "Call ID")
    .requiredOption("--message <text>", "Message to speak")
    .action(async (options: { callId: string; message: string }) => {
      const rt = await ensureRuntime();
      const result = await rt.manager.continueCall(options.callId, options.message);
      if (!result.success) {
        throw new Error(result.error || "continue failed");
      }
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(result, null, 2));
    });

  root
    .command("speak")
    .description("Speak a message without waiting for response")
    .requiredOption("--call-id <id>", "Call ID")
    .requiredOption("--message <text>", "Message to speak")
    .action(async (options: { callId: string; message: string }) => {
      const rt = await ensureRuntime();
      const result = await rt.manager.speak(options.callId, options.message);
      if (!result.success) {
        throw new Error(result.error || "speak failed");
      }
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(result, null, 2));
    });

  root
    .command("end")
    .description("Hang up an active call")
    .requiredOption("--call-id <id>", "Call ID")
    .action(async (options: { callId: string }) => {
      const rt = await ensureRuntime();
      const result = await rt.manager.endCall(options.callId);
      if (!result.success) {
        throw new Error(result.error || "end failed");
      }
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(result, null, 2));
    });

  root
    .command("status")
    .description("Show call status")
    .requiredOption("--call-id <id>", "Call ID")
    .action(async (options: { callId: string }) => {
      const rt = await ensureRuntime();
      const call = rt.manager.getCall(options.callId);
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(call ?? { found: false }, null, 2));
    });

  root
    .command("tail")
    .description("Tail voice-call JSONL logs (prints new lines; useful during provider tests)")
    .option("--file <path>", "Path to calls.jsonl", resolveDefaultStorePath(config))
    .option("--since <n>", "Print last N lines first", "25")
    .option("--poll <ms>", "Poll interval in ms", "250")
    .action(async (options: { file: string; since?: string; poll?: string }) => {
      const file = options.file;
      const since = Math.max(0, Number(options.since ?? 0));
      const pollMs = Math.max(50, Number(options.poll ?? 250));

      if (!fs.existsSync(file)) {
        logger.error(`No log file at ${file}`);
        process.exit(1);
      }

      const initial = fs.readFileSync(file, "utf8");
      const lines = initial.split("\n").filter(Boolean);
      for (const line of lines.slice(Math.max(0, lines.length - since))) {
        // eslint-disable-next-line no-console
        console.log(line);
      }

      let offset = Buffer.byteLength(initial, "utf8");

      for (;;) {
        try {
          const stat = fs.statSync(file);
          if (stat.size < offset) {
            offset = 0;
          }
          if (stat.size > offset) {
            const fd = fs.openSync(file, "r");
            try {
              const buf = Buffer.alloc(stat.size - offset);
              fs.readSync(fd, buf, 0, buf.length, offset);
              offset = stat.size;
              const text = buf.toString("utf8");
              for (const line of text.split("\n").filter(Boolean)) {
                // eslint-disable-next-line no-console
                console.log(line);
              }
            } finally {
              fs.closeSync(fd);
            }
          }
        } catch {
          // ignore and retry
        }
        await sleep(pollMs);
      }
    });

  root
    .command("latency")
    .description("Summarize voice-call turn latency from JSONL logs")
    .option("--file <path>", "Path to calls.jsonl", resolveDefaultStorePath(config))
    .option("--last <n>", "Read the last N JSONL records", "100")
    .action((options: { file: string; last?: string }) => {
      const file = options.file;
      const last = Math.max(1, Number(options.last ?? 100));
      const records = readVoiceCallLogRecords(file, last);
      const turnLatencies = records
        .map((record) => numberMetadata(record, "lastTurnLatencyMs"))
        .filter((value): value is number => value !== undefined);
      const listenWaits = records
        .map((record) => numberMetadata(record, "lastTurnListenWaitMs"))
        .filter((value): value is number => value !== undefined);

      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify(
          {
            file,
            recordsScanned: records.length,
            turnLatencyMs: summarizeNumbers(turnLatencies),
            listenWaitMs: summarizeNumbers(listenWaits),
          },
          null,
          2,
        ),
      );
    });

  root
    .command("expose")
    .description("Enable/disable Tailscale serve/funnel for the webhook")
    .option("--mode <mode>", "off | serve (tailnet) | funnel (public)", "funnel")
    .option("--path <path>", "Tailscale path to expose (recommend matching serve.path)")
    .option("--port <port>", "Local webhook port")
    .option("--serve-path <path>", "Local webhook path")
    .action(
      async (options: { mode?: string; port?: string; path?: string; servePath?: string }) => {
        const mode = resolveMode(options.mode ?? "funnel");
        const servePort = Number(options.port ?? config.serve.port ?? 3334);
        const servePath = String(options.servePath ?? config.serve.path ?? "/voice/webhook");
        const tsPath = String(options.path ?? config.tailscale?.path ?? servePath);

        const localUrl = `http://127.0.0.1:${servePort}`;

        if (mode === "off") {
          await cleanupTailscaleExposureRoute({ mode: "serve", path: tsPath });
          await cleanupTailscaleExposureRoute({ mode: "funnel", path: tsPath });
          // eslint-disable-next-line no-console
          console.log(JSON.stringify({ ok: true, mode: "off", path: tsPath }, null, 2));
          return;
        }

        const publicUrl = await setupTailscaleExposureRoute({
          mode,
          path: tsPath,
          localUrl,
        });

        const tsInfo = publicUrl ? null : await getTailscaleSelfInfo();
        const enableUrl = tsInfo?.nodeId
          ? `https://login.tailscale.com/f/${mode}?node=${tsInfo.nodeId}`
          : null;

        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify(
            {
              ok: Boolean(publicUrl),
              mode,
              path: tsPath,
              localUrl,
              publicUrl,
              hint: publicUrl
                ? undefined
                : {
                    note: "Tailscale serve/funnel may be disabled on this tailnet (or require admin enable).",
                    enableUrl,
                  },
            },
            null,
            2,
          ),
        );
      },
    );
}

function readVoiceCallLogRecords(file: string, last: number): Record<string, unknown>[] {
  if (!fs.existsSync(file)) {
    return [];
  }
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  return lines
    .slice(Math.max(0, lines.length - last))
    .map((line) => {
      try {
        const parsed = JSON.parse(line) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null;
      } catch {
        return null;
      }
    })
    .filter((record): record is Record<string, unknown> => Boolean(record));
}

function numberMetadata(record: Record<string, unknown>, key: string): number | undefined {
  const metadata = record.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function summarizeNumbers(values: number[]) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  return {
    count: sorted.length,
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
    avgMs: Math.round(sum / sorted.length),
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
  };
}

function percentile(sorted: number[], p: number): number {
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1));
  return sorted[index];
}
