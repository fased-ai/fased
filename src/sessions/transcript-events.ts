export type SessionTranscriptUpdate = {
  sessionFile: string;
  sessionKey?: string;
  message?: unknown;
  messageId?: string;
};

export type SessionTranscriptListener = (update: SessionTranscriptUpdate) => void;

const SESSION_TRANSCRIPT_LISTENERS = new Set<SessionTranscriptListener>();

export function onSessionTranscriptUpdate(listener: SessionTranscriptListener): () => void {
  SESSION_TRANSCRIPT_LISTENERS.add(listener);
  return () => {
    SESSION_TRANSCRIPT_LISTENERS.delete(listener);
  };
}

export function emitSessionTranscriptUpdate(update: string | SessionTranscriptUpdate): void {
  const normalized =
    typeof update === "string"
      ? { sessionFile: update }
      : { ...update, sessionFile: update.sessionFile };
  const trimmed = normalized.sessionFile.trim();
  if (!trimmed) {
    return;
  }
  const event = { ...normalized, sessionFile: trimmed };
  for (const listener of SESSION_TRANSCRIPT_LISTENERS) {
    listener(event);
  }
}
