import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isPrimarySessionTranscriptFileName,
  isSessionCompactionCheckpointArtifactName,
  type SessionEntry,
} from "../config/sessions.js";
import {
  captureSessionCompactionSnapshot,
  getSessionCompactionCheckpoint,
  listSessionCompactionCheckpoints,
  MAX_SESSION_COMPACTION_CHECKPOINTS,
  persistSessionCompactionCheckpoint,
} from "./session-compaction-checkpoints.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fased-compaction-checkpoint-"));
  tmpDirs.push(dir);
  return dir;
}

function checkpointFile(dir: string, index: number): string {
  return path
    .join(dir, `session.checkpoint.${randomUUID()}-${index}.jsonl`)
    .replace(/-[0-9]+\.jsonl$/, ".jsonl");
}

function makeEntry(): SessionEntry {
  return {
    sessionId: "session-1",
    updatedAt: 100,
  };
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("session compaction checkpoints", () => {
  it("captures bounded pre-compaction snapshots with checkpoint artifact names", () => {
    const dir = makeTmpDir();
    const transcript = path.join(dir, "session-1.jsonl");
    fs.writeFileSync(transcript, '{"message":{"role":"user","content":"hello"}}\n', "utf-8");

    const snapshot = captureSessionCompactionSnapshot({
      sessionId: "session-1",
      sessionFile: transcript,
      maxBytes: 1024,
    });

    expect(snapshot?.sessionId).toBe("session-1");
    expect(snapshot?.sessionFile).toBeTruthy();
    expect(fs.readFileSync(snapshot!.sessionFile!, "utf-8")).toBe(
      fs.readFileSync(transcript, "utf-8"),
    );
    expect(isSessionCompactionCheckpointArtifactName(path.basename(snapshot!.sessionFile!))).toBe(
      true,
    );
    expect(isPrimarySessionTranscriptFileName(path.basename(snapshot!.sessionFile!))).toBe(false);
  });

  it("skips oversized and non-jsonl snapshots", () => {
    const dir = makeTmpDir();
    const transcript = path.join(dir, "session-1.jsonl");
    const txt = path.join(dir, "session-1.txt");
    fs.writeFileSync(transcript, "too large\n", "utf-8");
    fs.writeFileSync(txt, "text\n", "utf-8");

    expect(
      captureSessionCompactionSnapshot({
        sessionId: "session-1",
        sessionFile: transcript,
        maxBytes: 1,
      }),
    ).toBeNull();
    expect(
      captureSessionCompactionSnapshot({
        sessionId: "session-1",
        sessionFile: txt,
        maxBytes: 1024,
      }),
    ).toBeNull();
  });

  it("lists newest checkpoints first and gets by exact id", () => {
    const entry = makeEntry();
    persistSessionCompactionCheckpoint({
      entry,
      sessionKey: "global",
      checkpointId: "older",
      reason: "manual",
      createdAt: 100,
      preCompaction: { sessionId: "session-1" },
      postCompaction: { sessionId: "session-1" },
    });
    persistSessionCompactionCheckpoint({
      entry,
      sessionKey: "global",
      checkpointId: "newer",
      reason: "overflow-retry",
      createdAt: 200,
      preCompaction: { sessionId: "session-1" },
      postCompaction: { sessionId: "session-1" },
    });

    expect(
      listSessionCompactionCheckpoints(entry).map((checkpoint) => checkpoint.checkpointId),
    ).toEqual(["newer", "older"]);
    expect(getSessionCompactionCheckpoint(entry, "older")?.reason).toBe("manual");
    expect(getSessionCompactionCheckpoint(entry, "missing")).toBeNull();
  });

  it("trims old checkpoints and deletes only safe checkpoint snapshot files", () => {
    const dir = makeTmpDir();
    const entry = makeEntry();
    const files: string[] = [];
    for (let index = 0; index < MAX_SESSION_COMPACTION_CHECKPOINTS + 1; index += 1) {
      const file = checkpointFile(dir, index);
      files.push(file);
      fs.writeFileSync(file, `${index}\n`, "utf-8");
      persistSessionCompactionCheckpoint({
        entry,
        sessionKey: "global",
        checkpointId: `checkpoint-${index}`,
        reason: "manual",
        createdAt: index,
        preCompaction: {
          sessionId: "session-1",
          sessionFile: file,
        },
        postCompaction: { sessionId: "session-1" },
      });
    }

    expect(listSessionCompactionCheckpoints(entry)).toHaveLength(
      MAX_SESSION_COMPACTION_CHECKPOINTS,
    );
    expect(listSessionCompactionCheckpoints(entry)[0]?.checkpointId).toBe("checkpoint-25");
    expect(fs.existsSync(files[0])).toBe(false);
    expect(fs.existsSync(files[25])).toBe(true);
  });
});
