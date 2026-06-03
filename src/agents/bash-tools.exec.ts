import path from "node:path";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { type ExecHost, maxAsk, minSecurity } from "../infra/exec-approvals.js";
import { resolveExecSafeBinRuntimePolicy } from "../infra/exec-safe-bin-runtime-policy.js";
import { SafeOpenError, readFileWithinRoot } from "../infra/fs-safe.js";
import {
  getShellPathFromLoginShell,
  resolveShellEnvFallbackTimeoutMs,
} from "../infra/shell-env.js";
import { logInfo } from "../logger.js";
import { parseAgentSessionKey, resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { markBackgrounded } from "./bash-process-registry.js";
import { processGatewayAllowlist } from "./bash-tools.exec-host-gateway.js";
import { executeNodeHostCommand } from "./bash-tools.exec-host-node.js";
import {
  DEFAULT_MAX_OUTPUT,
  DEFAULT_PATH,
  DEFAULT_PENDING_MAX_OUTPUT,
  applyPathPrepend,
  applyShellPath,
  normalizeExecAsk,
  normalizeExecTarget,
  normalizeExecSecurity,
  normalizePathPrepend,
  resolveApprovalRunningNoticeMs,
  resolveExecTarget,
  runExecProcess,
  sanitizeHostBaseEnv,
  execSchema,
  validateHostEnv,
} from "./bash-tools.exec-runtime.js";
import type {
  ExecElevatedDefaults,
  ExecToolDefaults,
  ExecToolDetails,
} from "./bash-tools.exec-types.js";
import {
  buildSandboxEnv,
  clampWithDefault,
  coerceEnv,
  readEnvInt,
  resolveSandboxWorkdir,
  resolveWorkdir,
  truncateMiddle,
} from "./bash-tools.shared.js";

export type { BashSandboxConfig } from "./bash-tools.shared.js";
export type {
  ExecElevatedDefaults,
  ExecToolDefaults,
  ExecToolDetails,
} from "./bash-tools.exec-types.js";

function extractScriptTargetFromCommand(
  command: string,
): { kind: "python"; relOrAbsPath: string } | { kind: "node"; relOrAbsPath: string } | null {
  const raw = command.trim();
  if (!raw) {
    return null;
  }

  // Intentionally simple parsing: we only support common forms like
  //   python file.py
  //   python3 -u file.py
  //   node --experimental-something file.js
  // If the command is more complex (pipes, heredocs, quoted paths with spaces), skip preflight.
  const pythonMatch = raw.match(/^\s*(python3?|python)\s+(?:-[^\s]+\s+)*([^\s]+\.py)\b/i);
  if (pythonMatch?.[2]) {
    return { kind: "python", relOrAbsPath: pythonMatch[2] };
  }
  const nodeMatch = raw.match(/^\s*(node)\s+(?:--[^\s]+\s+)*([^\s]+\.js)\b/i);
  if (nodeMatch?.[2]) {
    return { kind: "node", relOrAbsPath: nodeMatch[2] };
  }

  return null;
}

const SKIPPABLE_SCRIPT_PREFLIGHT_FS_ERROR_CODES = new Set([
  "EACCES",
  "EISDIR",
  "ELOOP",
  "EINVAL",
  "ENAMETOOLONG",
  "ENOENT",
  "ENOTDIR",
  "EPERM",
]);

function getNodeErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return String((error as { code?: unknown }).code);
}

function shouldSkipScriptPreflightPathError(error: unknown): boolean {
  if (error instanceof SafeOpenError) {
    return true;
  }
  const errorCode = getNodeErrorCode(error);
  return !!(errorCode && SKIPPABLE_SCRIPT_PREFLIGHT_FS_ERROR_CODES.has(errorCode));
}

function rejectApprovalCommandInShell(command: string): void {
  if (/\/approve\s+\S+\s+(?:allow-once|allow-always|deny)\b/i.test(command)) {
    throw new Error("exec cannot run /approve commands");
  }
}

function resolvePreflightRelativePath(params: { rootDir: string; absPath: string }): string | null {
  const root = path.resolve(params.rootDir);
  const candidate = path.resolve(params.absPath);
  const relative = path.relative(root, candidate);
  if (/^\.\.(?:[\\/]|$)/u.test(relative) || path.isAbsolute(relative)) {
    return null;
  }
  return relative;
}

async function validateScriptFileForShellBleed(params: {
  command: string;
  workdir: string;
}): Promise<void> {
  const target = extractScriptTargetFromCommand(params.command);
  if (!target) {
    return;
  }

  const absPath = path.isAbsolute(target.relOrAbsPath)
    ? path.resolve(target.relOrAbsPath)
    : path.resolve(params.workdir, target.relOrAbsPath);
  const relativePath = resolvePreflightRelativePath({
    rootDir: params.workdir,
    absPath,
  });
  if (!relativePath) {
    return;
  }

  // Best-effort: validate only files that safely resolve within workdir and
  // are reasonably small. Keep the read pinned to the opened file identity
  // instead of trusting a mutable pathname across separate stat/read calls.
  let content: string;
  try {
    const safeRead = await readFileWithinRoot({
      rootDir: params.workdir,
      relativePath,
      nonBlockingRead: true,
      allowSymlinkTargetWithinRoot: true,
      maxBytes: 512 * 1024,
    });
    content = safeRead.buffer.toString("utf-8");
  } catch (error) {
    if (shouldSkipScriptPreflightPathError(error)) {
      return;
    }
    throw error;
  }

  // Common failure mode: shell env var syntax leaking into Python/JS.
  // We deliberately match all-caps/underscore vars to avoid false positives with `$` as a JS identifier.
  const envVarRegex = /\$[A-Z_][A-Z0-9_]{1,}/g;
  const first = envVarRegex.exec(content);
  if (first) {
    const idx = first.index;
    const before = content.slice(0, idx);
    const line = before.split("\n").length;
    const token = first[0];
    throw new Error(
      [
        `exec preflight: detected likely shell variable injection (${token}) in ${target.kind} script: ${path.basename(
          absPath,
        )}:${line}.`,
        target.kind === "python"
          ? `In Python, use os.environ.get(${JSON.stringify(token.slice(1))}) instead of raw ${token}.`
          : `In Node.js, use process.env[${JSON.stringify(token.slice(1))}] instead of raw ${token}.`,
        "(If this is inside a string literal on purpose, escape it or restructure the code.)",
      ].join("\n"),
    );
  }

  // Another recurring pattern from the issue: shell commands accidentally emitted as JS.
  if (target.kind === "node") {
    const firstNonEmpty = content
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    if (firstNonEmpty && /^NODE\b/.test(firstNonEmpty)) {
      throw new Error(
        `exec preflight: JS file starts with shell syntax (${firstNonEmpty}). ` +
          `This looks like a shell command, not JavaScript.`,
      );
    }
  }
}

export function createExecTool(
  defaults?: ExecToolDefaults,
  // oxlint-disable-next-line typescript/no-explicit-any
): AgentTool<any, ExecToolDetails> {
  const defaultBackgroundMs = clampWithDefault(
    defaults?.backgroundMs ?? readEnvInt("PI_BASH_YIELD_MS"),
    10_000,
    10,
    120_000,
  );
  const allowBackground = defaults?.allowBackground ?? true;
  const defaultTimeoutSec =
    typeof defaults?.timeoutSec === "number" && defaults.timeoutSec > 0
      ? defaults.timeoutSec
      : 1800;
  const defaultPathPrepend = normalizePathPrepend(defaults?.pathPrepend);
  const {
    safeBins,
    safeBinProfiles,
    trustedSafeBinDirs,
    unprofiledSafeBins,
    unprofiledInterpreterSafeBins,
  } = resolveExecSafeBinRuntimePolicy({
    local: {
      safeBins: defaults?.safeBins,
      safeBinTrustedDirs: defaults?.safeBinTrustedDirs,
      safeBinProfiles: defaults?.safeBinProfiles,
    },
    onWarning: (message) => {
      logInfo(message);
    },
  });
  if (unprofiledSafeBins.length > 0) {
    logInfo(
      `exec: ignoring unprofiled safeBins entries (${unprofiledSafeBins.toSorted().join(", ")}); use allowlist or define tools.exec.safeBinProfiles.<bin>`,
    );
  }
  if (unprofiledInterpreterSafeBins.length > 0) {
    logInfo(
      `exec: interpreter/runtime binaries in safeBins (${unprofiledInterpreterSafeBins.join(", ")}) are unsafe without explicit hardened profiles; prefer allowlist entries`,
    );
  }
  const notifyOnExit = defaults?.notifyOnExit !== false;
  const notifyOnExitEmptySuccess = defaults?.notifyOnExitEmptySuccess === true;
  const notifySessionKey = defaults?.sessionKey?.trim() || undefined;
  const approvalRunningNoticeMs = resolveApprovalRunningNoticeMs(defaults?.approvalRunningNoticeMs);
  // Derive agentId only when sessionKey is an agent session key.
  const parsedAgentSession = parseAgentSessionKey(defaults?.sessionKey);
  const agentId =
    defaults?.agentId ??
    (parsedAgentSession ? resolveAgentIdFromSessionKey(defaults?.sessionKey) : undefined);

  return {
    name: "exec",
    label: "exec",
    description: [
      "Execute shell commands with background continuation. Use yieldMs/background to continue later via process tool.",
      "For deferred commands, rely on automatic completion wake when it is enabled and the command emits output or fails; otherwise use process to confirm completion. Use process whenever you need logs, status, input, or intervention.",
      defaults?.hasCronTool
        ? "Do not use exec sleep or delay loops for reminders or deferred follow-ups; use cron instead."
        : undefined,
      "Use pty=true for TTY-required commands (terminal UIs, coding agents).",
    ]
      .filter(Boolean)
      .join(" "),
    parameters: execSchema,
    execute: async (_toolCallId, args, signal, onUpdate) => {
      const params = args as {
        command: string;
        workdir?: string;
        env?: Record<string, string>;
        yieldMs?: number;
        background?: boolean;
        timeout?: number;
        pty?: boolean;
        elevated?: boolean;
        host?: string;
        security?: string;
        ask?: string;
        node?: string;
      };

      if (!params.command) {
        throw new Error("Provide a command to start.");
      }
      rejectApprovalCommandInShell(params.command);

      const maxOutput = DEFAULT_MAX_OUTPUT;
      const pendingMaxOutput = DEFAULT_PENDING_MAX_OUTPUT;
      const warnings: string[] = [];
      let execCommandOverride: string | undefined;
      const backgroundRequested = params.background === true;
      const yieldRequested = typeof params.yieldMs === "number";
      if (!allowBackground && (backgroundRequested || yieldRequested)) {
        warnings.push("Warning: background execution is disabled; running synchronously.");
      }
      const yieldWindow = allowBackground
        ? backgroundRequested
          ? 0
          : clampWithDefault(
              params.yieldMs ?? defaultBackgroundMs,
              defaultBackgroundMs,
              10,
              120_000,
            )
        : null;
      const elevatedDefaults = defaults?.elevated;
      const elevatedAllowed = Boolean(elevatedDefaults?.enabled && elevatedDefaults.allowed);
      const elevatedDefaultMode =
        elevatedDefaults?.defaultLevel === "full"
          ? "full"
          : elevatedDefaults?.defaultLevel === "ask"
            ? "ask"
            : elevatedDefaults?.defaultLevel === "on"
              ? "ask"
              : "off";
      const effectiveDefaultMode = elevatedAllowed ? elevatedDefaultMode : "off";
      const elevatedMode =
        typeof params.elevated === "boolean"
          ? params.elevated
            ? elevatedDefaultMode === "full"
              ? "full"
              : "ask"
            : "off"
          : effectiveDefaultMode;
      const elevatedRequested = elevatedMode !== "off";
      if (elevatedRequested) {
        if (!elevatedDefaults?.enabled || !elevatedDefaults.allowed) {
          const runtime = defaults?.sandbox ? "sandboxed" : "direct";
          const gates: string[] = [];
          const contextParts: string[] = [];
          const provider = defaults?.messageProvider?.trim();
          const sessionKey = defaults?.sessionKey?.trim();
          if (provider) {
            contextParts.push(`provider=${provider}`);
          }
          if (sessionKey) {
            contextParts.push(`session=${sessionKey}`);
          }
          if (!elevatedDefaults?.enabled) {
            gates.push("enabled (tools.elevated.enabled / agents.list[].tools.elevated.enabled)");
          } else {
            gates.push(
              "allowFrom (tools.elevated.allowFrom.<provider> / agents.list[].tools.elevated.allowFrom.<provider>)",
            );
          }
          throw new Error(
            [
              `elevated is not available right now (runtime=${runtime}).`,
              `Failing gates: ${gates.join(", ")}`,
              contextParts.length > 0 ? `Context: ${contextParts.join(" ")}` : undefined,
              "Fix-it keys:",
              "- tools.elevated.enabled",
              "- tools.elevated.allowFrom.<provider>",
              "- agents.list[].tools.elevated.enabled",
              "- agents.list[].tools.elevated.allowFrom.<provider>",
            ]
              .filter(Boolean)
              .join("\n"),
          );
        }
      }
      if (elevatedRequested) {
        logInfo(`exec: elevated command ${truncateMiddle(params.command, 120)}`);
      }
      const configuredTarget = defaults?.host ?? "auto";
      const requestedTarget = normalizeExecTarget(params.host) ?? null;
      const target = resolveExecTarget({
        configuredTarget,
        requestedTarget,
        elevatedRequested,
        sandboxAvailable: Boolean(defaults?.sandbox),
      });
      const host: ExecHost = target.effectiveHost;
      const sandboxHostConfigured = configuredTarget === "sandbox";

      const configuredSecurity = defaults?.security ?? (host === "sandbox" ? "deny" : "allowlist");
      const requestedSecurity = normalizeExecSecurity(params.security);
      let security = minSecurity(configuredSecurity, requestedSecurity ?? configuredSecurity);
      if (elevatedRequested && elevatedMode === "full") {
        security = "full";
      }
      const configuredAsk = defaults?.ask ?? "on-miss";
      const requestedAsk = normalizeExecAsk(params.ask);
      let ask = maxAsk(configuredAsk, requestedAsk ?? configuredAsk);
      const bypassApprovals = elevatedRequested && elevatedMode === "full";
      if (bypassApprovals) {
        ask = "off";
      }

      const sandbox = host === "sandbox" ? defaults?.sandbox : undefined;
      if (
        host === "sandbox" &&
        !sandbox &&
        (sandboxHostConfigured || requestedTarget === "sandbox")
      ) {
        throw new Error(
          [
            "exec host=sandbox is configured, but sandbox runtime is unavailable for this session.",
            "host=sandbox requires a sandbox runtime.",
            'Enable sandbox mode (`agents.defaults.sandbox.mode="non-main"` or `"all"`) or set tools.exec.host to "gateway"/"node".',
          ].join("\n"),
        );
      }
      const rawWorkdir = params.workdir?.trim() || defaults?.cwd || process.cwd();
      let workdir = rawWorkdir;
      let containerWorkdir = sandbox?.containerWorkdir;
      if (sandbox) {
        const resolved = await resolveSandboxWorkdir({
          workdir: rawWorkdir,
          sandbox,
          warnings,
        });
        workdir = resolved.hostWorkdir;
        containerWorkdir = resolved.containerWorkdir;
      } else {
        workdir = resolveWorkdir(rawWorkdir, warnings);
      }

      const inheritedBaseEnv = coerceEnv(process.env);
      const baseEnv = host === "sandbox" ? inheritedBaseEnv : sanitizeHostBaseEnv(inheritedBaseEnv);

      // Logic: Sandbox gets raw env. Host (gateway/node) must pass validation.
      // We validate BEFORE merging to prevent any dangerous vars from entering the stream.
      if (host !== "sandbox" && params.env) {
        validateHostEnv(params.env);
      }

      const mergedEnv = params.env ? { ...baseEnv, ...params.env } : baseEnv;

      const env = sandbox
        ? buildSandboxEnv({
            defaultPath: DEFAULT_PATH,
            paramsEnv: params.env,
            sandboxEnv: sandbox.env,
            containerWorkdir: containerWorkdir ?? sandbox.containerWorkdir,
          })
        : mergedEnv;

      if (!sandbox) {
        env.FASED_SHELL = "exec";
      }

      if (!sandbox && host === "gateway" && !params.env?.PATH) {
        const shellPath = getShellPathFromLoginShell({
          env: process.env,
          timeoutMs: resolveShellEnvFallbackTimeoutMs(process.env),
        });
        applyShellPath(env, shellPath);
      }

      // `tools.exec.pathPrepend` is only meaningful when exec runs locally (gateway) or in the sandbox.
      // Node hosts intentionally ignore request-scoped PATH overrides, so don't pretend this applies.
      if (host === "node" && defaultPathPrepend.length > 0) {
        warnings.push(
          "Warning: tools.exec.pathPrepend is ignored for host=node. Configure PATH on the node host/service instead.",
        );
      } else {
        applyPathPrepend(env, defaultPathPrepend);
      }

      if (host === "node") {
        return executeNodeHostCommand({
          command: params.command,
          workdir,
          env,
          requestedEnv: params.env,
          requestedNode: params.node?.trim(),
          boundNode: defaults?.node?.trim(),
          sessionKey: defaults?.sessionKey,
          turnSourceChannel: defaults?.messageProvider,
          turnSourceTo: defaults?.currentChannelId,
          turnSourceAccountId: defaults?.accountId,
          turnSourceThreadId: defaults?.currentThreadTs,
          agentId,
          security,
          ask,
          timeoutSec: params.timeout,
          defaultTimeoutSec,
          approvalRunningNoticeMs,
          warnings,
          notifySessionKey,
          trustedSafeBinDirs,
        });
      }

      if (host === "gateway" && !bypassApprovals) {
        const gatewayResult = await processGatewayAllowlist({
          command: params.command,
          workdir,
          env,
          pty: params.pty === true && !sandbox,
          timeoutSec: params.timeout,
          defaultTimeoutSec,
          security,
          ask,
          safeBins,
          safeBinProfiles,
          agentId,
          sessionKey: defaults?.sessionKey,
          turnSourceChannel: defaults?.messageProvider,
          turnSourceTo: defaults?.currentChannelId,
          turnSourceAccountId: defaults?.accountId,
          turnSourceThreadId: defaults?.currentThreadTs,
          scopeKey: defaults?.scopeKey,
          warnings,
          notifySessionKey,
          approvalRunningNoticeMs,
          maxOutput,
          pendingMaxOutput,
          trustedSafeBinDirs,
        });
        if (gatewayResult.pendingResult) {
          return gatewayResult.pendingResult;
        }
        execCommandOverride = gatewayResult.execCommandOverride;
      }

      const explicitTimeoutSec = typeof params.timeout === "number" ? params.timeout : null;
      const backgroundTimeoutBypass =
        allowBackground && explicitTimeoutSec === null && (backgroundRequested || yieldRequested);
      const effectiveTimeout = backgroundTimeoutBypass
        ? null
        : (explicitTimeoutSec ?? defaultTimeoutSec);
      const getWarningText = () => (warnings.length ? `${warnings.join("\n")}\n\n` : "");
      const usePty = params.pty === true && !sandbox;

      // Preflight: catch a common model failure mode (shell syntax leaking into Python/JS sources)
      // before we execute and burn tokens in cron loops.
      await validateScriptFileForShellBleed({ command: params.command, workdir });

      const run = await runExecProcess({
        command: params.command,
        execCommand: execCommandOverride,
        workdir,
        env,
        sandbox,
        containerWorkdir,
        usePty,
        warnings,
        maxOutput,
        pendingMaxOutput,
        notifyOnExit,
        notifyOnExitEmptySuccess,
        scopeKey: defaults?.scopeKey,
        sessionKey: notifySessionKey,
        timeoutSec: effectiveTimeout,
        onUpdate,
      });

      let yielded = false;
      let yieldTimer: NodeJS.Timeout | null = null;

      // Tool-call abort should not kill backgrounded sessions; timeouts still must.
      const onAbortSignal = () => {
        if (yielded || run.session.backgrounded) {
          return;
        }
        run.kill();
      };

      if (signal?.aborted) {
        onAbortSignal();
      } else if (signal) {
        signal.addEventListener("abort", onAbortSignal, { once: true });
      }

      return new Promise<AgentToolResult<ExecToolDetails>>((resolve, reject) => {
        const resolveRunning = () =>
          resolve({
            content: [
              {
                type: "text",
                text: `${getWarningText()}Command still running (session ${run.session.id}, pid ${
                  run.session.pid ?? "n/a"
                }). Use process (list/poll/log/write/kill/clear/remove) for follow-up.`,
              },
            ],
            details: {
              status: "running",
              sessionId: run.session.id,
              pid: run.session.pid ?? undefined,
              startedAt: run.startedAt,
              cwd: run.session.cwd,
              tail: run.session.tail,
            },
          });

        const onYieldNow = () => {
          if (yieldTimer) {
            clearTimeout(yieldTimer);
          }
          if (yielded) {
            return;
          }
          yielded = true;
          markBackgrounded(run.session);
          resolveRunning();
        };

        if (allowBackground && yieldWindow !== null) {
          if (yieldWindow === 0) {
            onYieldNow();
          } else {
            yieldTimer = setTimeout(() => {
              if (yielded) {
                return;
              }
              yielded = true;
              markBackgrounded(run.session);
              resolveRunning();
            }, yieldWindow);
          }
        }

        run.promise
          .then((outcome) => {
            if (yieldTimer) {
              clearTimeout(yieldTimer);
            }
            if (yielded || run.session.backgrounded) {
              return;
            }
            if (outcome.status === "failed") {
              reject(new Error(outcome.reason ?? "Command failed."));
              return;
            }
            resolve({
              content: [
                {
                  type: "text",
                  text: `${getWarningText()}${outcome.aggregated || "(no output)"}`,
                },
              ],
              details: {
                status: "completed",
                exitCode: outcome.exitCode ?? 0,
                durationMs: outcome.durationMs,
                aggregated: outcome.aggregated,
                cwd: run.session.cwd,
              },
            });
          })
          .catch((err) => {
            if (yieldTimer) {
              clearTimeout(yieldTimer);
            }
            if (yielded || run.session.backgrounded) {
              return;
            }
            reject(err as Error);
          });
      });
    },
  };
}

export const execTool = createExecTool();
