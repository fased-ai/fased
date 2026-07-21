import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

const UPDATE_SUCCESS_MARKER = "last-update-success.json";
const RECENT_UPDATE_WINDOW_MS = 10 * 60_000;

export function updateSuccessMarkerPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), UPDATE_SUCCESS_MARKER);
}

export async function recordUpdateSuccess(
  details: { mode?: string; version?: string | null } = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const markerPath = updateSuccessMarkerPath(env);
  await fsp.mkdir(path.dirname(markerPath), { recursive: true, mode: 0o700 });
  const temporary = `${markerPath}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(
    temporary,
    `${JSON.stringify({ schemaVersion: 1, completedAt: new Date().toISOString(), ...details })}\n`,
    { mode: 0o600 },
  );
  await fsp.rename(temporary, markerPath);
}

export function updateCompletedRecently(
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): boolean {
  try {
    const value = JSON.parse(fs.readFileSync(updateSuccessMarkerPath(env), "utf8")) as {
      schemaVersion?: unknown;
      completedAt?: unknown;
    };
    if (value.schemaVersion !== 1 || typeof value.completedAt !== "string") {
      return false;
    }
    const completedAt = Date.parse(value.completedAt);
    return (
      Number.isFinite(completedAt) &&
      now >= completedAt &&
      now - completedAt <= RECENT_UPDATE_WINDOW_MS
    );
  } catch {
    return false;
  }
}
