export type GatewayStartupTraceEntry = {
  name: string;
  durationMs: number;
};

export type GatewayStartupTraceSnapshot = {
  entries: GatewayStartupTraceEntry[];
  totalMs: number;
  summary: string;
  recordedAtMs: number;
};

type StartupTraceLogger = {
  info: (message: string, meta?: Record<string, unknown>) => void;
};

type GatewayStartupTraceOptions = {
  now?: () => number;
};

function formatDuration(ms: number): string {
  return `${Math.max(0, Math.round(ms))}ms`;
}

let lastGatewayStartupTraceSnapshot: GatewayStartupTraceSnapshot | null = null;

export function getLastGatewayStartupTraceSnapshot(): GatewayStartupTraceSnapshot | null {
  if (!lastGatewayStartupTraceSnapshot) {
    return null;
  }
  return {
    ...lastGatewayStartupTraceSnapshot,
    entries: lastGatewayStartupTraceSnapshot.entries.map((entry) => ({ ...entry })),
  };
}

export function resetLastGatewayStartupTraceSnapshotForTest() {
  lastGatewayStartupTraceSnapshot = null;
}

export function createGatewayStartupTrace(opts: GatewayStartupTraceOptions = {}) {
  const now = opts.now ?? (() => Date.now());
  const startedAt = now();
  const entries: GatewayStartupTraceEntry[] = [];

  const record = (name: string, started: number) => {
    entries.push({
      name,
      durationMs: Math.max(0, Math.round(now() - started)),
    });
  };

  return {
    measureSync<T>(name: string, run: () => T): T {
      const started = now();
      try {
        return run();
      } finally {
        record(name, started);
      }
    },

    async measure<T>(name: string, run: () => Promise<T> | T): Promise<T> {
      const started = now();
      try {
        return await run();
      } finally {
        record(name, started);
      }
    },

    entries(): GatewayStartupTraceEntry[] {
      return entries.map((entry) => ({ ...entry }));
    },

    totalMs(): number {
      return Math.max(0, Math.round(now() - startedAt));
    },

    summary(): string {
      const parts = entries.map((entry) => `${entry.name}=${formatDuration(entry.durationMs)}`);
      parts.push(`total=${formatDuration(this.totalMs())}`);
      return parts.join(", ");
    },

    logSummary(logger: StartupTraceLogger) {
      if (entries.length === 0) {
        return;
      }
      const totalMs = this.totalMs();
      const summary = this.summary();
      const startupTimings = this.entries();
      lastGatewayStartupTraceSnapshot = {
        entries: startupTimings,
        totalMs,
        summary,
        recordedAtMs: Math.round(now()),
      };
      logger.info(`gateway startup timings: ${summary}`, {
        startupTimings,
        totalMs,
      });
    },
  };
}
