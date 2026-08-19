import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMiningReadConnection,
  inspectMiningRpcDiagnostics,
  type MiningReadConnectionLike,
} from "./rpc-read-service.js";

const timeoutEnv = "FASED_SAT_RPC_REQUEST_TIMEOUT_MS";
let originalTimeout: string | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalTimeout == null) {
    delete process.env[timeoutEnv];
  } else {
    process.env[timeoutEnv] = originalTimeout;
  }
  originalTimeout = undefined;
});

function fakeSolana(calls: Map<string, () => Promise<unknown>>): {
  Connection: new (endpoint: string) => MiningReadConnectionLike;
} {
  class Connection implements MiningReadConnectionLike {
    readonly secondaryRpcEndpoint = null;

    constructor(readonly rpcEndpoint: string) {}

    getAccountInfo = async (): Promise<unknown> => await calls.get(this.rpcEndpoint)!();
    getProgramAccounts = async (): Promise<unknown> => await calls.get(this.rpcEndpoint)!();
    getMinimumBalanceForRentExemption = async (): Promise<unknown> =>
      await calls.get(this.rpcEndpoint)!();
  }
  return { Connection };
}

describe("Mining RPC read service", () => {
  it("keeps low-level transport ownership outside the stable facade", async () => {
    const source = await readFile(new URL("./rpc-read.ts", import.meta.url), "utf8");

    expect(source).toContain('from "./rpc-read-service.js"');
    expect(source).not.toContain('from "node:http"');
    expect(source).not.toContain('from "node:https"');
    expect(source).not.toContain("transport.request(");
    expect(source).not.toContain("fetchWithSsrFGuard");
  });

  it("uses the primary connection and records the method request", async () => {
    const primaryUrl = "http://service-primary-success.invalid";
    const calls = new Map([[primaryUrl, async () => "primary-result"]]);
    const connection = createMiningReadConnection(fakeSolana(calls), {
      primaryUrl,
      secondaryUrl: null,
    });

    await expect(connection.getAccountInfo()).resolves.toBe("primary-result");
    expect(inspectMiningRpcDiagnostics({ primaryUrl, secondaryUrl: null }).rpcState.lastMode).toBe(
      "primary",
    );
  });

  it("falls back once when the primary connection fails", async () => {
    const primaryUrl = "http://service-primary-failure.invalid";
    const fallbackUrl = "http://service-fallback-success.invalid";
    const calls = new Map<string, () => Promise<unknown>>([
      [
        primaryUrl,
        async () => {
          throw new Error("primary unavailable");
        },
      ],
      [fallbackUrl, async () => "fallback-result"],
    ]);
    const connection = createMiningReadConnection(fakeSolana(calls), {
      primaryUrl,
      secondaryUrl: fallbackUrl,
    });

    await expect(connection.getAccountInfo()).resolves.toBe("fallback-result");
    expect(
      inspectMiningRpcDiagnostics({ primaryUrl, secondaryUrl: fallbackUrl }).rpcState,
    ).toMatchObject({
      lastMode: "fallback",
      fallbackCount: expect.any(Number),
    });
  });

  it("keeps a quota-backed primary circuit open while the fallback succeeds", async () => {
    const primaryUrl = "http://service-primary-quota.invalid";
    const fallbackUrl = "http://service-fallback-quota.invalid";
    const primary = vi.fn(async () => {
      throw new Error("429 Too Many Requests");
    });
    const fallback = vi.fn(async () => "fallback-result");
    const connection = createMiningReadConnection(
      fakeSolana(
        new Map([
          [primaryUrl, primary],
          [fallbackUrl, fallback],
        ]),
      ),
      { primaryUrl, secondaryUrl: fallbackUrl },
    );

    await expect(connection.getAccountInfo()).resolves.toBe("fallback-result");
    await expect(connection.getAccountInfo()).resolves.toBe("fallback-result");
    expect(primary).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledTimes(2);
  });

  it("bounds a hung connection request and redacts credential-bearing endpoint errors", async () => {
    originalTimeout = process.env[timeoutEnv];
    process.env[timeoutEnv] = "20";
    const primaryUrl = "http://service-timeout.invalid/rpc?api-key=primary-secret";
    const fallbackUrl = "http://service-fallback-timeout.invalid";
    const connection = createMiningReadConnection(
      fakeSolana(
        new Map([
          [primaryUrl, async () => await new Promise<never>(() => {})],
          [
            fallbackUrl,
            async () => {
              throw new Error("fallback http://fallback.invalid/rpc?token=fallback-secret");
            },
          ],
        ]),
      ),
      { primaryUrl, secondaryUrl: fallbackUrl },
    );

    const error = await connection.getAccountInfo().catch((caught) => String(caught));
    expect(error).toContain("api-key=***");
    expect(error).toContain("token=***");
    expect(error).not.toContain("primary-secret");
    expect(error).not.toContain("fallback-secret");
  });

  it("cancels an oversized guarded fetch stream before buffering the full response", async () => {
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1));
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(source));

    class FetchBackedConnection implements MiningReadConnectionLike {
      readonly secondaryRpcEndpoint = null;
      readonly fetchFn: typeof globalThis.fetch;

      constructor(
        readonly rpcEndpoint: string,
        config: { fetch: typeof globalThis.fetch },
      ) {
        this.fetchFn = config.fetch;
      }

      getAccountInfo = async (): Promise<unknown> => {
        const response = await this.fetchFn(this.rpcEndpoint);
        return await response.arrayBuffer();
      };
      getProgramAccounts = this.getAccountInfo;
      getMinimumBalanceForRentExemption = this.getAccountInfo;
    }

    const connection = createMiningReadConnection(
      { Connection: FetchBackedConnection },
      { primaryUrl: "http://127.0.0.1:19003/rpc", secondaryUrl: null },
    );

    await expect(connection.getAccountInfo()).rejects.toThrow("response exceeded size limit");
    expect(cancelled).toBe(true);
  });

  it("prunes stale method buckets so they cannot reappear after clock rollback", async () => {
    const initialNowMs = 1_800_000_000_000;
    let nowMs = initialNowMs;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const primaryUrl = "http://service-prune-primary.invalid";
    const connection = createMiningReadConnection(
      fakeSolana(new Map([[primaryUrl, async () => "program-result"]])),
      { primaryUrl, secondaryUrl: null },
    );

    await expect(connection.getProgramAccounts()).resolves.toBe("program-result");
    nowMs += 24 * 60 * 60_000 + 1;
    inspectMiningRpcDiagnostics({ primaryUrl, secondaryUrl: null });

    nowMs = initialNowMs + 30_000;
    const metrics = inspectMiningRpcDiagnostics({ primaryUrl, secondaryUrl: null }).rpcMetrics;
    const method = metrics.methods.find((entry) => entry.method === "getProgramAccounts");
    expect(method).toMatchObject({
      requestsSinceStart: 1,
      requestsLastHour: 0,
      requestsLast24Hours: 0,
    });
  });
});
