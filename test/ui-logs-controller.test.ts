import { describe, expect, it, vi } from "vitest";
import { loadLogs } from "../ui/src/ui/controllers/logs.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("loadLogs", () => {
  it("ignores overlapping quiet fetches so reconnect refresh does not duplicate log lines", async () => {
    const pending = deferred<{
      cursor: number;
      lines: string[];
      truncated: boolean;
    }>();
    const request = vi.fn(() => pending.promise);
    const state = {
      client: { request },
      connected: true,
      logsLoading: false,
      logsError: null,
      logsCursor: null,
      logsFile: null,
      logsEntries: [],
      logsTruncated: false,
      logsLastFetchAt: null,
      logsLimit: 500,
      logsMaxBytes: 250_000,
    };

    const first = loadLogs(state, { reset: true });
    const second = loadLogs(state, { quiet: true });
    pending.resolve({
      cursor: 10,
      lines: ['{"message":"line-1"}'],
      truncated: false,
    });

    await Promise.all([first, second]);

    expect(request).toHaveBeenCalledTimes(1);
    expect(state.logsEntries).toHaveLength(1);
    expect(state.logsCursor).toBe(10);
  });
});
