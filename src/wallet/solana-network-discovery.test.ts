import { describe, expect, it, vi } from "vitest";
import { discoverSolanaNetworkFromRpc } from "./solana-network-discovery.js";

function rpcFetch(genesisByUrl: Record<string, string>): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const genesis = genesisByUrl[url];
    return new Response(
      JSON.stringify(
        genesis
          ? { jsonrpc: "2.0", id: 1, result: genesis }
          : { jsonrpc: "2.0", id: 1, error: { code: -1, message: "unavailable" } },
      ),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}

describe("discoverSolanaNetworkFromRpc", () => {
  it("uses exact official and loopback endpoints without a network prompt or witness request", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(
      discoverSolanaNetworkFromRpc("https://api.mainnet-beta.solana.com/", { fetchImpl }),
    ).resolves.toBe("mainnet-beta");
    await expect(
      discoverSolanaNetworkFromRpc("https://api.devnet.solana.com", { fetchImpl }),
    ).resolves.toBe("devnet");
    await expect(
      discoverSolanaNetworkFromRpc("http://127.0.0.1:8899", { fetchImpl }),
    ).resolves.toBe("local");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("infers an opaque provider from live same-genesis official witnesses", async () => {
    const provider = "https://opaque.provider.example/solana?token=secret";
    const fetchImpl = rpcFetch({
      [provider]: "devnet-live-genesis",
      "https://api.mainnet-beta.solana.com": "mainnet-live-genesis",
      "https://api.devnet.solana.com": "devnet-live-genesis",
      "https://api.testnet.solana.com": "testnet-live-genesis",
    });
    await expect(discoverSolanaNetworkFromRpc(provider, { fetchImpl })).resolves.toBe("devnet");
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("rejects unsupported clusters without leaking the credential-bearing URL", async () => {
    const provider = "https://opaque.provider.example/solana?token=do-not-leak";
    const fetchImpl = rpcFetch({
      [provider]: "custom-genesis",
      "https://api.mainnet-beta.solana.com": "mainnet-live-genesis",
      "https://api.devnet.solana.com": "devnet-live-genesis",
      "https://api.testnet.solana.com": "testnet-live-genesis",
    });
    let message = "";
    try {
      await discoverSolanaNetworkFromRpc(provider, { fetchImpl });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("unsupported");
    expect(message).not.toContain("do-not-leak");
    expect(message).not.toContain(provider);
  });

  it("times out even when a provider implementation ignores AbortSignal", async () => {
    const fetchImpl = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    await expect(
      discoverSolanaNetworkFromRpc("https://opaque.provider.example/solana", {
        fetchImpl,
        timeoutMs: 250,
      }),
    ).rejects.toThrow("Unable to verify");
  });
});
