import type { FasedAgentConfig } from "../../config/config.js";

export const EMBEDDED_COMPACTION_TIMEOUT_MS = 300_000;

export async function compactWithSafetyTimeout<T>(
  compact: () => Promise<T>,
  timeoutMs: number = EMBEDDED_COMPACTION_TIMEOUT_MS,
  opts?: { abortSignal?: AbortSignal; onCancel?: () => void },
): Promise<T> {
  const resolvedTimeout = Math.max(1, Math.floor(timeoutMs));
  let cancelled = false;
  let timer: NodeJS.Timeout | undefined;
  let abortListener: (() => void) | undefined;
  const cancelOnce = () => {
    if (cancelled) {
      return;
    }
    cancelled = true;
    try {
      opts?.onCancel?.();
    } catch {
      // Preserve the timeout/abort error as the visible failure.
    }
  };
  const timeoutError = new Error("Compaction timed out");
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      cancelOnce();
      reject(timeoutError);
    }, resolvedTimeout);
    timer.unref?.();
  });
  const abortPromise =
    opts?.abortSignal &&
    new Promise<never>((_, reject) => {
      if (opts.abortSignal!.aborted) {
        cancelOnce();
        reject(opts.abortSignal!.reason);
        return;
      }
      abortListener = () => {
        cancelOnce();
        reject(opts.abortSignal!.reason);
      };
      opts.abortSignal!.addEventListener("abort", abortListener, { once: true });
    });
  try {
    return await Promise.race(
      abortPromise ? [compact(), timeoutPromise, abortPromise] : [compact(), timeoutPromise],
    );
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (opts?.abortSignal && abortListener) {
      opts.abortSignal.removeEventListener("abort", abortListener);
    }
  }
}

export function resolveCompactionTimeoutMs(cfg?: FasedAgentConfig): number {
  const raw = cfg?.agents?.defaults?.compaction?.timeoutSeconds;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return EMBEDDED_COMPACTION_TIMEOUT_MS;
  }
  return Math.floor(raw) * 1000;
}
