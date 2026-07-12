import fs from "node:fs";
import path from "node:path";
import { CURRENT_SESSION_VERSION, SessionManager } from "@mariozechner/pi-coding-agent";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { resolveDefaultSessionStorePath, resolveSessionTranscriptPathInDir } from "./paths.js";
import { resolveAndPersistSessionFile } from "./session-file.js";
import { loadSessionStore } from "./store.js";
import type { SessionEntry } from "./types.js";

type AppendMessageArg = Parameters<SessionManager["appendMessage"]>[0];

function stripQuery(value: string): string {
  const noHash = value.split("#")[0] ?? value;
  return noHash.split("?")[0] ?? noHash;
}

function extractFileNameFromMediaUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const cleaned = stripQuery(trimmed);
  try {
    const parsed = new URL(cleaned);
    const base = path.basename(parsed.pathname);
    if (!base) {
      return null;
    }
    try {
      return decodeURIComponent(base);
    } catch {
      return base;
    }
  } catch {
    const base = path.basename(cleaned);
    if (!base || base === "/" || base === ".") {
      return null;
    }
    return base;
  }
}

export function resolveMirroredTranscriptText(params: {
  text?: string;
  mediaUrls?: string[];
}): string | null {
  const mediaUrls = params.mediaUrls?.filter((url) => url && url.trim()) ?? [];
  if (mediaUrls.length > 0) {
    const names = mediaUrls
      .map((url) => extractFileNameFromMediaUrl(url))
      .filter((name): name is string => Boolean(name && name.trim()));
    if (names.length > 0) {
      return names.join(", ");
    }
    return "media";
  }

  const text = params.text ?? "";
  const trimmed = text.trim();
  return trimmed ? trimmed : null;
}

export async function resolveSessionTranscriptFile(params: {
  sessionId: string;
  sessionKey: string;
  agentId?: string;
  storePath?: string;
  sessionsDir?: string;
  fallbackSessionFile?: string;
  activeSessionKey?: string;
  threadId?: string | number;
}): Promise<{ sessionFile: string; sessionEntry: SessionEntry }> {
  const storePath = params.storePath ?? resolveDefaultSessionStorePath(params.agentId);
  const store = loadSessionStore(storePath, { skipCache: true });
  const fallbackSessionFile =
    params.fallbackSessionFile ??
    (params.threadId != null
      ? resolveSessionTranscriptPathInDir(
          params.sessionId,
          params.sessionsDir ?? path.dirname(storePath),
          params.threadId,
        )
      : undefined);
  return await resolveAndPersistSessionFile({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sessionStore: store,
    storePath,
    agentId: params.agentId,
    sessionsDir: params.sessionsDir,
    fallbackSessionFile,
    activeSessionKey: params.activeSessionKey,
  });
}

export function ensureSessionTranscriptHeader(params: { sessionFile: string; sessionId: string }): {
  created: boolean;
  error?: string;
} {
  if (fs.existsSync(params.sessionFile)) {
    return { created: false };
  }
  try {
    fs.mkdirSync(path.dirname(params.sessionFile), { recursive: true });
    const header = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: params.sessionId,
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    };
    fs.writeFileSync(params.sessionFile, `${JSON.stringify(header)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
    return { created: true };
  } catch (error) {
    return { created: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function appendAssistantMessageToSessionTranscript(params: {
  agentId?: string;
  sessionKey: string;
  text?: string;
  mediaUrls?: string[];
  /** Optional override for store path (mostly for tests). */
  storePath?: string;
}): Promise<{ ok: true; sessionFile: string } | { ok: false; reason: string }> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return { ok: false, reason: "missing sessionKey" };
  }

  const mirrorText = resolveMirroredTranscriptText({
    text: params.text,
    mediaUrls: params.mediaUrls,
  });
  if (!mirrorText) {
    return { ok: false, reason: "empty text" };
  }

  const storePath = params.storePath ?? resolveDefaultSessionStorePath(params.agentId);
  const store = loadSessionStore(storePath, { skipCache: true });
  const entry = store[sessionKey] as SessionEntry | undefined;
  if (!entry?.sessionId) {
    return { ok: false, reason: `unknown sessionKey: ${sessionKey}` };
  }

  let sessionFile: string;
  try {
    const resolvedSessionFile = await resolveAndPersistSessionFile({
      sessionId: entry.sessionId,
      sessionKey,
      sessionStore: store,
      storePath,
      sessionEntry: entry,
      agentId: params.agentId,
      sessionsDir: path.dirname(storePath),
    });
    sessionFile = resolvedSessionFile.sessionFile;
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  const ensured = ensureSessionTranscriptHeader({ sessionFile, sessionId: entry.sessionId });
  if (ensured.error) {
    return { ok: false, reason: ensured.error };
  }

  const sessionManager = SessionManager.open(sessionFile);
  const message: AppendMessageArg & Record<string, unknown> = {
    role: "assistant",
    content: [{ type: "text", text: mirrorText }],
    api: "openai-responses",
    provider: "fased",
    model: "delivery-mirror",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  const messageId = sessionManager.appendMessage(message);

  emitSessionTranscriptUpdate({
    sessionFile,
    sessionKey,
    message,
    ...(typeof messageId === "string" ? { messageId } : {}),
  });
  return { ok: true, sessionFile };
}
