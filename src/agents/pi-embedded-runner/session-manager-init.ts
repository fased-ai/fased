type SessionHeaderEntry = { type: "session"; id?: string; cwd?: string };

/**
 * Keep Fased's requested identity for new transcripts while leaving existing
 * transcripts under SessionManager's append lifecycle. In particular, an
 * existing header-only file is already marked flushed by SessionManager and
 * must not be truncated or reset to unflushed: its next assistant write uses
 * exclusive creation and would fail with EEXIST.
 */
export async function prepareSessionManagerForRun(params: {
  sessionManager: unknown;
  sessionFile: string;
  hadSessionFile: boolean;
  sessionId: string;
  cwd: string;
}): Promise<void> {
  const sm = params.sessionManager as {
    sessionId: string;
    fileEntries: Array<{ type: string; id?: string; cwd?: string }>;
  };

  const header = sm.fileEntries.find((e): e is SessionHeaderEntry => e.type === "session");
  if (!params.hadSessionFile && header) {
    header.id = params.sessionId;
    header.cwd = params.cwd;
    sm.sessionId = params.sessionId;
  }
}
