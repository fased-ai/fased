import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  isSessionCompactionCheckpointArtifactName,
  type SessionCompactionCheckpoint,
  type SessionCompactionCheckpointReason,
  type SessionCompactionTranscriptReference,
  type SessionEntry,
} from "../config/sessions.js";

export const MAX_SESSION_COMPACTION_CHECKPOINTS = 25;
export const MAX_SESSION_COMPACTION_CHECKPOINT_SNAPSHOT_BYTES = 64 * 1024 * 1024;

function optionalNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeTranscriptReference(value: unknown): SessionCompactionTranscriptReference | null {
  if (!isRecord(value) || typeof value.sessionId !== "string" || !value.sessionId.trim()) {
    return null;
  }
  const reference: SessionCompactionTranscriptReference = {
    sessionId: value.sessionId,
  };
  if (typeof value.sessionFile === "string" && value.sessionFile.trim()) {
    reference.sessionFile = value.sessionFile;
  }
  if (typeof value.leafId === "string" && value.leafId.trim()) {
    reference.leafId = value.leafId;
  }
  if (typeof value.entryId === "string" && value.entryId.trim()) {
    reference.entryId = value.entryId;
  }
  return reference;
}

function normalizeCheckpoint(value: unknown): SessionCompactionCheckpoint | null {
  if (!isRecord(value)) {
    return null;
  }
  const preCompaction = normalizeTranscriptReference(value.preCompaction);
  const postCompaction = normalizeTranscriptReference(value.postCompaction);
  if (!preCompaction || !postCompaction) {
    return null;
  }
  if (
    typeof value.checkpointId !== "string" ||
    !value.checkpointId.trim() ||
    typeof value.sessionKey !== "string" ||
    !value.sessionKey.trim() ||
    typeof value.sessionId !== "string" ||
    !value.sessionId.trim() ||
    typeof value.createdAt !== "number" ||
    !Number.isFinite(value.createdAt) ||
    (value.reason !== "manual" &&
      value.reason !== "auto-threshold" &&
      value.reason !== "overflow-retry" &&
      value.reason !== "timeout-retry")
  ) {
    return null;
  }
  const checkpoint: SessionCompactionCheckpoint = {
    checkpointId: value.checkpointId,
    sessionKey: value.sessionKey,
    sessionId: value.sessionId,
    createdAt: value.createdAt,
    reason: value.reason,
    preCompaction,
    postCompaction,
  };
  const tokensBefore = optionalNumber(value.tokensBefore as number | undefined);
  if (tokensBefore !== undefined) {
    checkpoint.tokensBefore = tokensBefore;
  }
  const tokensAfter = optionalNumber(value.tokensAfter as number | undefined);
  if (tokensAfter !== undefined) {
    checkpoint.tokensAfter = tokensAfter;
  }
  if (typeof value.summary === "string" && value.summary.trim()) {
    checkpoint.summary = value.summary;
  }
  if (typeof value.firstKeptEntryId === "string" && value.firstKeptEntryId.trim()) {
    checkpoint.firstKeptEntryId = value.firstKeptEntryId;
  }
  return checkpoint;
}

export function listSessionCompactionCheckpoints(
  entry: Pick<SessionEntry, "compactionCheckpoints"> | undefined,
): SessionCompactionCheckpoint[] {
  return (entry?.compactionCheckpoints ?? [])
    .map((checkpoint) => normalizeCheckpoint(checkpoint))
    .filter((checkpoint): checkpoint is SessionCompactionCheckpoint => Boolean(checkpoint))
    .toSorted((a, b) => b.createdAt - a.createdAt);
}

export function getSessionCompactionCheckpoint(
  entry: Pick<SessionEntry, "compactionCheckpoints"> | undefined,
  checkpointId: string,
): SessionCompactionCheckpoint | null {
  const id = checkpointId.trim();
  if (!id) {
    return null;
  }
  return (
    listSessionCompactionCheckpoints(entry).find((checkpoint) => checkpoint.checkpointId === id) ??
    null
  );
}

function deleteCheckpointSnapshotIfSafe(filePath: string | undefined, expectedDir: string): void {
  if (!filePath) {
    return;
  }
  const resolved = path.resolve(filePath);
  if (path.dirname(resolved) !== expectedDir) {
    return;
  }
  if (!isSessionCompactionCheckpointArtifactName(path.basename(resolved))) {
    return;
  }
  try {
    fs.unlinkSync(resolved);
  } catch {
    // Best-effort retention cleanup.
  }
}

export function cleanupSessionCompactionSnapshot(
  reference: SessionCompactionTranscriptReference,
): void {
  if (!reference.sessionFile) {
    return;
  }
  deleteCheckpointSnapshotIfSafe(
    reference.sessionFile,
    path.dirname(path.resolve(reference.sessionFile)),
  );
}

export function captureSessionCompactionSnapshot(params: {
  sessionId: string;
  sessionFile: string | undefined;
  maxBytes?: number;
}): SessionCompactionTranscriptReference | null {
  const sessionFile = params.sessionFile?.trim();
  if (!sessionFile) {
    return null;
  }
  const resolved = path.resolve(sessionFile);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return null;
  }
  const maxBytes = params.maxBytes ?? MAX_SESSION_COMPACTION_CHECKPOINT_SNAPSHOT_BYTES;
  if (!stat.isFile() || stat.size > maxBytes) {
    return null;
  }
  if (path.extname(resolved) !== ".jsonl") {
    return null;
  }
  if (isSessionCompactionCheckpointArtifactName(path.basename(resolved))) {
    return null;
  }
  const dir = path.dirname(resolved);
  const base = path.basename(resolved, ".jsonl");
  const snapshotFile = path.join(dir, `${base}.checkpoint.${randomUUID()}.jsonl`);
  try {
    fs.copyFileSync(resolved, snapshotFile);
  } catch {
    return null;
  }
  return {
    sessionId: params.sessionId,
    sessionFile: snapshotFile,
  };
}

export function persistSessionCompactionCheckpoint(params: {
  entry: SessionEntry;
  sessionKey: string;
  reason: SessionCompactionCheckpointReason;
  preCompaction: SessionCompactionTranscriptReference;
  postCompaction: SessionCompactionTranscriptReference;
  checkpointId?: string;
  createdAt?: number;
  tokensBefore?: number;
  tokensAfter?: number;
  summary?: string;
  firstKeptEntryId?: string;
}): SessionCompactionCheckpoint {
  const checkpoint: SessionCompactionCheckpoint = {
    checkpointId: params.checkpointId ?? randomUUID(),
    sessionKey: params.sessionKey,
    sessionId: params.entry.sessionId,
    createdAt: params.createdAt ?? Date.now(),
    reason: params.reason,
    preCompaction: params.preCompaction,
    postCompaction: params.postCompaction,
  };
  const tokensBefore = optionalNumber(params.tokensBefore);
  if (tokensBefore !== undefined) {
    checkpoint.tokensBefore = tokensBefore;
  }
  const tokensAfter = optionalNumber(params.tokensAfter);
  if (tokensAfter !== undefined) {
    checkpoint.tokensAfter = tokensAfter;
  }
  if (params.summary?.trim()) {
    checkpoint.summary = params.summary;
  }
  if (params.firstKeptEntryId?.trim()) {
    checkpoint.firstKeptEntryId = params.firstKeptEntryId;
  }

  const checkpoints = [checkpoint, ...listSessionCompactionCheckpoints(params.entry)].toSorted(
    (a, b) => b.createdAt - a.createdAt,
  );
  const retained = checkpoints.slice(0, MAX_SESSION_COMPACTION_CHECKPOINTS);
  const removed = checkpoints.slice(MAX_SESSION_COMPACTION_CHECKPOINTS);
  const snapshotDir = params.preCompaction.sessionFile
    ? path.dirname(path.resolve(params.preCompaction.sessionFile))
    : undefined;
  if (snapshotDir) {
    for (const oldCheckpoint of removed) {
      deleteCheckpointSnapshotIfSafe(oldCheckpoint.preCompaction.sessionFile, snapshotDir);
    }
  }
  params.entry.compactionCheckpoints = retained;
  return checkpoint;
}
