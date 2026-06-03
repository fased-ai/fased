import { runCliAgent } from "../../agents/cli-runner.js";
import { getCliSessionId } from "../../agents/cli-session.js";
import { isCliProvider } from "../../agents/model-selection.js";
import { runEmbeddedPiAgent } from "../../agents/pi-embedded.js";
import type { buildWorkspaceSkillSnapshot } from "../../agents/skills.js";
import type { ThinkLevel, VerboseLevel } from "../../auto-reply/thinking.js";
import type { loadConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { resolveMessageChannel } from "../../utils/message-channel.js";
import type { resolveAgentRunContext } from "./run-context.js";
import type { AgentCommandOpts } from "./types.js";

export function resolveFallbackRetryPrompt(params: {
  body: string;
  isFallbackRetry: boolean;
}): string {
  if (!params.isFallbackRetry) {
    return params.body;
  }
  return "Continue where you left off. The previous model attempt failed or timed out.";
}

export function runAgentAttempt(params: {
  providerOverride: string;
  modelOverride: string;
  cfg: ReturnType<typeof loadConfig>;
  sessionEntry: SessionEntry | undefined;
  sessionId: string;
  sessionKey: string | undefined;
  sessionAgentId: string;
  sessionFile: string;
  workspaceDir: string;
  body: string;
  isFallbackRetry: boolean;
  resolvedThinkLevel: ThinkLevel;
  timeoutMs: number;
  runId: string;
  opts: AgentCommandOpts;
  runContext: ReturnType<typeof resolveAgentRunContext>;
  spawnedBy: string | undefined;
  messageChannel: ReturnType<typeof resolveMessageChannel>;
  skillsSnapshot: ReturnType<typeof buildWorkspaceSkillSnapshot> | undefined;
  resolvedVerboseLevel: VerboseLevel | undefined;
  agentDir: string;
  onAgentEvent: (evt: { stream: string; data?: Record<string, unknown> }) => void;
  primaryProvider: string;
}) {
  const effectivePrompt = resolveFallbackRetryPrompt({
    body: params.body,
    isFallbackRetry: params.isFallbackRetry,
  });
  if (isCliProvider(params.providerOverride, params.cfg)) {
    const cliSessionId = getCliSessionId(params.sessionEntry, params.providerOverride);
    return runCliAgent({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      agentId: params.sessionAgentId,
      sessionFile: params.sessionFile,
      workspaceDir: params.workspaceDir,
      config: params.cfg,
      prompt: effectivePrompt,
      provider: params.providerOverride,
      model: params.modelOverride,
      thinkLevel: params.resolvedThinkLevel,
      timeoutMs: params.timeoutMs,
      runId: params.runId,
      extraSystemPrompt: params.opts.extraSystemPrompt,
      cliSessionId,
      images: params.isFallbackRetry ? undefined : params.opts.images,
      streamParams: params.opts.streamParams,
    });
  }

  const authProfileId =
    params.providerOverride === params.primaryProvider
      ? params.sessionEntry?.authProfileOverride
      : undefined;
  return runEmbeddedPiAgent({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.sessionAgentId,
    messageChannel: params.messageChannel,
    agentAccountId: params.runContext.accountId,
    messageTo: params.opts.replyTo ?? params.opts.to,
    messageThreadId: params.opts.threadId,
    groupId: params.runContext.groupId,
    groupChannel: params.runContext.groupChannel,
    groupSpace: params.runContext.groupSpace,
    spawnedBy: params.spawnedBy,
    currentChannelId: params.runContext.currentChannelId,
    currentThreadTs: params.runContext.currentThreadTs,
    replyToMode: params.runContext.replyToMode,
    hasRepliedRef: params.runContext.hasRepliedRef,
    senderIsOwner: true,
    sessionFile: params.sessionFile,
    workspaceDir: params.workspaceDir,
    config: params.cfg,
    skillsSnapshot: params.skillsSnapshot,
    prompt: effectivePrompt,
    images: params.isFallbackRetry ? undefined : params.opts.images,
    clientTools: params.opts.clientTools,
    provider: params.providerOverride,
    model: params.modelOverride,
    authProfileId,
    authProfileIdSource: authProfileId ? params.sessionEntry?.authProfileOverrideSource : undefined,
    thinkLevel: params.resolvedThinkLevel,
    verboseLevel: params.resolvedVerboseLevel,
    timeoutMs: params.timeoutMs,
    runId: params.runId,
    lane: params.opts.lane,
    abortSignal: params.opts.abortSignal,
    extraSystemPrompt: params.opts.extraSystemPrompt,
    inputProvenance: params.opts.inputProvenance,
    streamParams: params.opts.streamParams,
    agentDir: params.agentDir,
    onAgentEvent: params.onAgentEvent,
  });
}
