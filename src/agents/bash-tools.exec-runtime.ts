import path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type {
  ExecApprovalDecision,
  ExecAsk,
  ExecHost,
  ExecSecurity,
  ExecTarget,
} from "../infra/exec-approvals.js";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import {
  isDangerousHostEnvOverrideVarName,
  isDangerousHostInheritedEnvVarName,
} from "../infra/host-env-security.js";
import { mergePathPrepend } from "../infra/path-prepend.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import type { ProcessSession } from "./bash-process-registry.js";
import type { ExecToolDetails } from "./bash-tools.exec-types.js";
import type { BashSandboxConfig } from "./bash-tools.shared.js";
export { applyPathPrepend, normalizePathPrepend } from "../infra/path-prepend.js";
import { logWarn } from "../logger.js";
import type { ManagedRun, RunExit } from "../process/supervisor/index.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import {
  addSession,
  appendOutput,
  createSessionSlug,
  markExited,
  tail,
} from "./bash-process-registry.js";
import {
  buildDockerExecArgs,
  chunkString,
  clampWithDefault,
  readEnvInt,
} from "./bash-tools.shared.js";
import { buildCursorPositionResponse, stripDsrRequests } from "./pty-dsr.js";
import { getShellConfig, sanitizeBinaryOutput } from "./shell-utils.js";

// Sanitize inherited host env before merge so dangerous variables from process.env
// are not propagated into non-sandboxed executions.
export function sanitizeHostBaseEnv(env: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const upperKey = key.toUpperCase();
    if (upperKey === "PATH") {
      sanitized[key] = value;
      continue;
    }
    if (isDangerousHostInheritedEnvVarName(upperKey)) {
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}
// Centralized sanitization helper.
// Throws an error if dangerous variables or PATH modifications are detected on the host.
export function validateHostEnv(env: Record<string, string>): void {
  const blockedOverrideKeys: string[] = [];
  for (const key of Object.keys(env)) {
    const upperKey = key.toUpperCase();

    // 1. Block known dangerous variables (Fail Closed)
    if (isDangerousHostInheritedEnvVarName(upperKey)) {
      throw new Error(
        `Security Violation: Environment variable '${key}' is forbidden during host execution.`,
      );
    }

    // 2. Strictly block PATH modification on host
    // Allowing custom PATH on the gateway/node can lead to binary hijacking.
    if (upperKey === "PATH") {
      throw new Error(
        "Security Violation: Custom 'PATH' variable is forbidden during host execution.",
      );
    }
    if (isDangerousHostEnvOverrideVarName(upperKey)) {
      blockedOverrideKeys.push(upperKey);
    }
  }
  if (blockedOverrideKeys.length > 0) {
    throw new Error(
      `Security Violation: blocked override keys: ${blockedOverrideKeys.toSorted().join(", ")}.`,
    );
  }
}
export const DEFAULT_MAX_OUTPUT = clampWithDefault(
  readEnvInt("PI_BASH_MAX_OUTPUT_CHARS"),
  200_000,
  1_000,
  200_000,
);
export const DEFAULT_PENDING_MAX_OUTPUT = clampWithDefault(
  readEnvInt("FASED_BASH_PENDING_MAX_OUTPUT_CHARS"),
  30_000,
  1_000,
  200_000,
);
export const DEFAULT_PATH =
  process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
export const DEFAULT_NOTIFY_TAIL_CHARS = 400;
const DEFAULT_NOTIFY_SNIPPET_CHARS = 180;
export const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;
export const DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS = 130_000;
const DEFAULT_APPROVAL_RUNNING_NOTICE_MS = 10_000;
const APPROVAL_SLUG_LENGTH = 8;

export const execSchema = Type.Object({
  command: Type.String({ description: "Shell command to execute" }),
  workdir: Type.Optional(Type.String({ description: "Working directory (defaults to cwd)" })),
  env: Type.Optional(Type.Record(Type.String(), Type.String())),
  yieldMs: Type.Optional(
    Type.Number({
      description: "Milliseconds to wait before backgrounding (default 10000)",
    }),
  ),
  background: Type.Optional(Type.Boolean({ description: "Run in background immediately" })),
  timeout: Type.Optional(
    Type.Number({
      description: "Timeout in seconds (optional, kills process on expiry)",
    }),
  ),
  pty: Type.Optional(
    Type.Boolean({
      description:
        "Run in a pseudo-terminal (PTY) when available (TTY-required CLIs, coding agents)",
    }),
  ),
  elevated: Type.Optional(
    Type.Boolean({
      description: "Run on the host with elevated permissions (if allowed)",
    }),
  ),
  host: Type.Optional(
    Type.String({
      description: "Exec host (sandbox|gateway|node).",
    }),
  ),
  security: Type.Optional(
    Type.String({
      description: "Exec security mode (deny|allowlist|full).",
    }),
  ),
  ask: Type.Optional(
    Type.String({
      description: "Exec ask mode (off|on-miss|always).",
    }),
  ),
  node: Type.Optional(
    Type.String({
      description: "Node id/name for host=node.",
    }),
  ),
});

export type ExecProcessOutcome = {
  status: "completed" | "failed";
  exitCode: number | null;
  exitSignal: NodeJS.Signals | number | null;
  durationMs: number;
  aggregated: string;
  timedOut: boolean;
  failureKind?: ExecFailureKind;
  reason?: string;
};

export type ExecProcessHandle = {
  session: ProcessSession;
  startedAt: number;
  pid?: number;
  promise: Promise<ExecProcessOutcome>;
  kill: () => void;
};

export function normalizeExecHost(value?: string | null): ExecHost | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "sandbox" || normalized === "gateway" || normalized === "node") {
    return normalized;
  }
  return null;
}

export function normalizeExecTarget(value?: string | null): ExecTarget | null {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "auto" ||
    normalized === "sandbox" ||
    normalized === "gateway" ||
    normalized === "node"
  ) {
    return normalized;
  }
  return null;
}

export function normalizeExecSecurity(value?: string | null): ExecSecurity | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "deny" || normalized === "allowlist" || normalized === "full") {
    return normalized;
  }
  return null;
}

export function normalizeExecAsk(value?: string | null): ExecAsk | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "off" || normalized === "on-miss" || normalized === "always") {
    return normalized as ExecAsk;
  }
  return null;
}

export function renderExecHostLabel(host: ExecHost) {
  return host === "sandbox" ? "sandbox" : host === "gateway" ? "gateway" : "node";
}

function renderExecTargetLabel(target: ExecTarget) {
  return target === "auto" ? "auto" : renderExecHostLabel(target);
}

function effectiveHostForTarget(params: {
  target: ExecTarget;
  sandboxAvailable: boolean;
}): ExecHost {
  if (params.target === "auto") {
    return params.sandboxAvailable ? "sandbox" : "gateway";
  }
  return params.target;
}

export function resolveExecTarget(params: {
  configuredTarget: ExecTarget;
  requestedTarget?: ExecTarget | null;
  elevatedRequested: boolean;
  sandboxAvailable: boolean;
}): {
  configuredTarget: ExecTarget;
  requestedTarget: ExecTarget | null;
  selectedTarget: ExecTarget;
  effectiveHost: ExecHost;
} {
  const requestedTarget = params.requestedTarget ?? null;
  if (params.elevatedRequested) {
    if (params.configuredTarget === "node") {
      return {
        configuredTarget: params.configuredTarget,
        requestedTarget,
        selectedTarget: "node",
        effectiveHost: "node",
      };
    }
    return {
      configuredTarget: params.configuredTarget,
      requestedTarget,
      selectedTarget: "gateway",
      effectiveHost: "gateway",
    };
  }

  if (params.configuredTarget === "auto") {
    const selectedTarget = requestedTarget ?? "auto";
    if (requestedTarget === "gateway" && params.sandboxAvailable) {
      throw new Error(
        "exec host not allowed (requested gateway; configured host is auto; set tools.exec.host=gateway or auto to allow this override).",
      );
    }
    return {
      configuredTarget: "auto",
      requestedTarget,
      selectedTarget,
      effectiveHost: effectiveHostForTarget({
        target: selectedTarget,
        sandboxAvailable: params.sandboxAvailable,
      }),
    };
  }

  if (requestedTarget && requestedTarget !== params.configuredTarget) {
    const allowedHint =
      requestedTarget === "auto"
        ? "set tools.exec.host=auto to allow this override"
        : `set tools.exec.host=${renderExecTargetLabel(requestedTarget)} or auto to allow this override`;
    throw new Error(
      `exec host not allowed (requested ${renderExecTargetLabel(requestedTarget)}; configured host is ${renderExecHostLabel(params.configuredTarget)}; ${allowedHint}).`,
    );
  }

  return {
    configuredTarget: params.configuredTarget,
    requestedTarget,
    selectedTarget: params.configuredTarget,
    effectiveHost: params.configuredTarget,
  };
}

export function isRequestedExecTargetAllowed(params: {
  configuredTarget: ExecTarget;
  requestedTarget: ExecTarget;
}): boolean {
  if (params.configuredTarget === "auto") {
    return true;
  }
  return params.requestedTarget === params.configuredTarget;
}

export function detectCursorKeyMode(value: string): "normal" | "application" | null {
  const escape = String.fromCharCode(27);
  const applicationIndex = value.lastIndexOf(`${escape}[?1h`);
  const normalIndex = value.lastIndexOf(`${escape}[?1l`);
  if (applicationIndex < 0 && normalIndex < 0) {
    return null;
  }
  return applicationIndex > normalIndex ? "application" : "normal";
}

export type ExecFailureKind =
  | RunExit["reason"]
  | "shell-command-not-found"
  | "shell-command-not-executable";

export function formatExecFailureReason(params: {
  failureKind: ExecFailureKind;
  exitSignal: NodeJS.Signals | number | null;
  timeoutSec: number | null;
}): string {
  if (params.failureKind === "shell-command-not-found") {
    return "Command not found";
  }
  if (params.failureKind === "shell-command-not-executable") {
    return "Command not executable (permission denied)";
  }
  if (params.failureKind === "overall-timeout") {
    return typeof params.timeoutSec === "number" && params.timeoutSec > 0
      ? `Command timed out after ${params.timeoutSec} seconds`
      : "Command timed out";
  }
  if (params.failureKind === "no-output-timeout") {
    return "Command timed out waiting for output";
  }
  if (params.exitSignal != null) {
    return `Command aborted by signal ${params.exitSignal}`;
  }
  return "Command aborted before exit code was captured";
}

export function buildExecExitOutcome(params: {
  exit: RunExit;
  aggregated: string;
  durationMs: number;
  timeoutSec: number | null;
}): ExecProcessOutcome {
  const { exit } = params;
  const isNormalExit = exit.reason === "exit";
  const exitCode = exit.exitCode ?? 0;
  const failureKind: ExecFailureKind | null =
    isNormalExit && exitCode === 127
      ? "shell-command-not-found"
      : isNormalExit && exitCode === 126
        ? "shell-command-not-executable"
        : isNormalExit
          ? null
          : exit.reason;
  if (!failureKind) {
    const exitMsg = exitCode !== 0 ? `\n\n(Command exited with code ${exitCode})` : "";
    return {
      status: "completed",
      exitCode,
      exitSignal: exit.exitSignal,
      durationMs: params.durationMs,
      aggregated: params.aggregated + exitMsg,
      timedOut: false,
    };
  }

  const reason = formatExecFailureReason({
    failureKind,
    exitSignal: exit.exitSignal,
    timeoutSec: params.timeoutSec,
  });
  return {
    status: "failed",
    exitCode: exit.exitCode,
    exitSignal: exit.exitSignal,
    durationMs: params.durationMs,
    aggregated: params.aggregated,
    timedOut: exit.timedOut,
    failureKind,
    reason: params.aggregated ? `${params.aggregated}\n\n${reason}` : reason,
  };
}

export function buildApprovalPendingMessage(params: {
  warningText?: string;
  approvalSlug: string;
  approvalId: string;
  allowedDecisions: readonly ExecApprovalDecision[];
  command: string;
  cwd?: string;
  host: "gateway" | "node";
  nodeId?: string;
  interactive?: boolean;
}): string {
  const cwd = params.cwd?.trim() || process.cwd();
  const lines = [
    `${params.warningText ?? ""}Approval required.`,
    `Reply with: /approve ${params.approvalSlug} ${params.allowedDecisions.join("|")}`,
    `Use full ${params.approvalId} if the short id is ambiguous.`,
    `Host: ${params.host}`,
    params.nodeId ? `Node: ${params.nodeId}` : undefined,
    `CWD: ${cwd}`,
  ].filter((line): line is string => typeof line === "string");
  if (params.interactive) {
    lines.push("Mode: foreground (interactive approvals available).");
    lines.push(
      params.allowedDecisions.includes("allow-always")
        ? "Background mode requires pre-approved policy or Allow Always."
        : "Background mode requires an effective policy that allows pre-approval.",
    );
  }
  lines.push("Command:");
  lines.push("```sh");
  lines.push(params.command);
  lines.push("```");
  if (!params.allowedDecisions.includes("allow-always")) {
    lines.push("Allow Always is unavailable for this request.");
  }
  return lines.join("\n");
}

export function normalizeNotifyOutput(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function compactNotifyOutput(value: string, maxChars = DEFAULT_NOTIFY_SNIPPET_CHARS) {
  const normalized = normalizeNotifyOutput(value);
  if (!normalized) {
    return "";
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  const safe = Math.max(1, maxChars - 1);
  return `${normalized.slice(0, safe)}…`;
}

export function applyShellPath(env: Record<string, string>, shellPath?: string | null) {
  if (!shellPath) {
    return;
  }
  const entries = shellPath
    .split(path.delimiter)
    .map((part) => part.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    return;
  }
  const merged = mergePathPrepend(env.PATH, entries);
  if (merged) {
    env.PATH = merged;
  }
}

function maybeNotifyOnExit(session: ProcessSession, status: "completed" | "failed") {
  if (!session.backgrounded || !session.notifyOnExit || session.exitNotified) {
    return;
  }
  const sessionKey = session.sessionKey?.trim();
  if (!sessionKey) {
    return;
  }
  session.exitNotified = true;
  const exitLabel = session.exitSignal
    ? `signal ${session.exitSignal}`
    : `code ${session.exitCode ?? 0}`;
  const output = compactNotifyOutput(
    tail(session.tail || session.aggregated || "", DEFAULT_NOTIFY_TAIL_CHARS),
  );
  if (status === "completed" && !output && session.notifyOnExitEmptySuccess !== true) {
    return;
  }
  const summary = output
    ? `Exec ${status} (${session.id.slice(0, 8)}, ${exitLabel}) :: ${output}`
    : `Exec ${status} (${session.id.slice(0, 8)}, ${exitLabel})`;
  enqueueSystemEvent(summary, { sessionKey });
  requestHeartbeatNow(
    sessionKey.startsWith("agent:")
      ? { reason: "exec-event", sessionKey }
      : { reason: "exec-event" },
  );
}

export function createApprovalSlug(id: string) {
  return id.slice(0, APPROVAL_SLUG_LENGTH);
}

export function resolveApprovalRunningNoticeMs(value?: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_APPROVAL_RUNNING_NOTICE_MS;
  }
  if (value <= 0) {
    return 0;
  }
  return Math.floor(value);
}

export function emitExecSystemEvent(
  text: string,
  opts: { sessionKey?: string; contextKey?: string },
) {
  const sessionKey = opts.sessionKey?.trim();
  if (!sessionKey) {
    return;
  }
  enqueueSystemEvent(text, { sessionKey, contextKey: opts.contextKey });
  requestHeartbeatNow(
    sessionKey.startsWith("agent:")
      ? { reason: "exec-event", sessionKey }
      : { reason: "exec-event" },
  );
}

export async function runExecProcess(opts: {
  command: string;
  // Execute this instead of `command` (which is kept for display/session/logging).
  // Used to sanitize safeBins execution while preserving the original user input.
  execCommand?: string;
  workdir: string;
  env: Record<string, string>;
  sandbox?: BashSandboxConfig;
  containerWorkdir?: string | null;
  usePty: boolean;
  warnings: string[];
  maxOutput: number;
  pendingMaxOutput: number;
  notifyOnExit: boolean;
  notifyOnExitEmptySuccess?: boolean;
  scopeKey?: string;
  sessionKey?: string;
  timeoutSec: number | null;
  onUpdate?: (partialResult: AgentToolResult<ExecToolDetails>) => void;
}): Promise<ExecProcessHandle> {
  const startedAt = Date.now();
  const sessionId = createSessionSlug();
  const execCommand = opts.execCommand ?? opts.command;
  const supervisor = getProcessSupervisor();

  const session: ProcessSession = {
    id: sessionId,
    command: opts.command,
    scopeKey: opts.scopeKey,
    sessionKey: opts.sessionKey,
    notifyOnExit: opts.notifyOnExit,
    notifyOnExitEmptySuccess: opts.notifyOnExitEmptySuccess === true,
    exitNotified: false,
    child: undefined,
    stdin: undefined,
    pid: undefined,
    startedAt,
    cwd: opts.workdir,
    maxOutputChars: opts.maxOutput,
    pendingMaxOutputChars: opts.pendingMaxOutput,
    totalOutputChars: 0,
    pendingStdout: [],
    pendingStderr: [],
    pendingStdoutChars: 0,
    pendingStderrChars: 0,
    aggregated: "",
    tail: "",
    exited: false,
    exitCode: undefined as number | null | undefined,
    exitSignal: undefined as NodeJS.Signals | number | null | undefined,
    truncated: false,
    backgrounded: false,
    cursorKeyMode: "unknown",
  };
  addSession(session);

  const emitUpdate = () => {
    if (!opts.onUpdate) {
      return;
    }
    const tailText = session.tail || session.aggregated;
    const warningText = opts.warnings.length ? `${opts.warnings.join("\n")}\n\n` : "";
    opts.onUpdate({
      content: [{ type: "text", text: warningText + (tailText || "") }],
      details: {
        status: "running",
        sessionId,
        pid: session.pid ?? undefined,
        startedAt,
        cwd: session.cwd,
        tail: session.tail,
      },
    });
  };

  const handleStdout = (data: string) => {
    const str = sanitizeBinaryOutput(data.toString());
    for (const chunk of chunkString(str)) {
      appendOutput(session, "stdout", chunk);
      emitUpdate();
    }
  };

  const handleStderr = (data: string) => {
    const str = sanitizeBinaryOutput(data.toString());
    for (const chunk of chunkString(str)) {
      appendOutput(session, "stderr", chunk);
      emitUpdate();
    }
  };

  const timeoutMs =
    typeof opts.timeoutSec === "number" && opts.timeoutSec > 0
      ? Math.floor(opts.timeoutSec * 1000)
      : undefined;

  const spawnSpec:
    | {
        mode: "child";
        argv: string[];
        env: NodeJS.ProcessEnv;
        stdinMode: "pipe-open" | "pipe-closed";
      }
    | {
        mode: "pty";
        ptyCommand: string;
        childFallbackArgv: string[];
        env: NodeJS.ProcessEnv;
        stdinMode: "pipe-open";
      } = (() => {
    if (opts.sandbox) {
      return {
        mode: "child" as const,
        argv: [
          "docker",
          ...buildDockerExecArgs({
            containerName: opts.sandbox.containerName,
            command: execCommand,
            workdir: opts.containerWorkdir ?? opts.sandbox.containerWorkdir,
            env: opts.env,
            tty: opts.usePty,
          }),
        ],
        env: process.env,
        stdinMode: opts.usePty ? ("pipe-open" as const) : ("pipe-closed" as const),
      };
    }
    const { shell, args: shellArgs } = getShellConfig();
    const childArgv = [shell, ...shellArgs, execCommand];
    if (opts.usePty) {
      return {
        mode: "pty" as const,
        ptyCommand: execCommand,
        childFallbackArgv: childArgv,
        env: opts.env,
        stdinMode: "pipe-open" as const,
      };
    }
    return {
      mode: "child" as const,
      argv: childArgv,
      env: opts.env,
      stdinMode: "pipe-closed" as const,
    };
  })();

  let managedRun: ManagedRun | null = null;
  let usingPty = spawnSpec.mode === "pty";
  const cursorResponse = buildCursorPositionResponse();

  const onSupervisorStdout = (chunk: string) => {
    if (usingPty) {
      const cursorKeyMode = detectCursorKeyMode(chunk);
      if (cursorKeyMode) {
        session.cursorKeyMode = cursorKeyMode;
      }
      const { cleaned, requests } = stripDsrRequests(chunk);
      if (requests > 0 && managedRun?.stdin) {
        for (let i = 0; i < requests; i += 1) {
          managedRun.stdin.write(cursorResponse);
        }
      }
      handleStdout(cleaned);
      return;
    }
    handleStdout(chunk);
  };

  try {
    const spawnBase = {
      runId: sessionId,
      sessionId: opts.sessionKey?.trim() || sessionId,
      backendId: opts.sandbox ? "exec-sandbox" : "exec-host",
      scopeKey: opts.scopeKey,
      cwd: opts.workdir,
      env: spawnSpec.env,
      timeoutMs,
      captureOutput: false,
      onStdout: onSupervisorStdout,
      onStderr: handleStderr,
    };
    managedRun =
      spawnSpec.mode === "pty"
        ? await supervisor.spawn({
            ...spawnBase,
            mode: "pty",
            ptyCommand: spawnSpec.ptyCommand,
          })
        : await supervisor.spawn({
            ...spawnBase,
            mode: "child",
            argv: spawnSpec.argv,
            stdinMode: spawnSpec.stdinMode,
          });
  } catch (err) {
    if (spawnSpec.mode === "pty") {
      const warning = `Warning: PTY spawn failed (${String(err)}); retrying without PTY for \`${opts.command}\`.`;
      logWarn(
        `exec: PTY spawn failed (${String(err)}); retrying without PTY for "${opts.command}".`,
      );
      opts.warnings.push(warning);
      usingPty = false;
      try {
        managedRun = await supervisor.spawn({
          runId: sessionId,
          sessionId: opts.sessionKey?.trim() || sessionId,
          backendId: "exec-host",
          scopeKey: opts.scopeKey,
          mode: "child",
          argv: spawnSpec.childFallbackArgv,
          cwd: opts.workdir,
          env: spawnSpec.env,
          stdinMode: "pipe-open",
          timeoutMs,
          captureOutput: false,
          onStdout: handleStdout,
          onStderr: handleStderr,
        });
      } catch (retryErr) {
        markExited(session, null, null, "failed");
        maybeNotifyOnExit(session, "failed");
        throw retryErr;
      }
    } else {
      markExited(session, null, null, "failed");
      maybeNotifyOnExit(session, "failed");
      throw err;
    }
  }
  session.stdin = managedRun.stdin;
  session.pid = managedRun.pid;

  const promise = managedRun
    .wait()
    .then((exit): ExecProcessOutcome => {
      const durationMs = Date.now() - startedAt;
      const outcome = buildExecExitOutcome({
        exit,
        aggregated: session.aggregated.trim(),
        durationMs,
        timeoutSec: opts.timeoutSec,
      });

      markExited(session, exit.exitCode, exit.exitSignal, outcome.status);
      maybeNotifyOnExit(session, outcome.status);
      if (!session.child && session.stdin) {
        session.stdin.destroyed = true;
      }
      return outcome;
    })
    .catch((err): ExecProcessOutcome => {
      markExited(session, null, null, "failed");
      maybeNotifyOnExit(session, "failed");
      const aggregated = session.aggregated.trim();
      const message = aggregated ? `${aggregated}\n\n${String(err)}` : String(err);
      return {
        status: "failed",
        exitCode: null,
        exitSignal: null,
        durationMs: Date.now() - startedAt,
        aggregated,
        timedOut: false,
        reason: message,
      };
    });

  return {
    session,
    startedAt,
    pid: session.pid ?? undefined,
    promise,
    kill: () => {
      managedRun?.cancel("manual-cancel");
    },
  };
}
