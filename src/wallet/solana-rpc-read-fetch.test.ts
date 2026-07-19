import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { fetchPinnedSolanaRpcRead } from "./solana-rpc-read-fetch.js";

const servers: ReturnType<typeof createServer>[] = [];

async function listen(
  handler: Parameters<typeof createServer>[0],
): Promise<{ server: ReturnType<typeof createServer>; url: string }> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${address.port}` };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe("fetchPinnedSolanaRpcRead", () => {
  it("allows a direct loopback Local RPC without following redirects", async () => {
    let redirectedRequests = 0;
    const destination = await listen((_req, res) => {
      redirectedRequests += 1;
      res.setHeader("content-type", "application/json");
      res.end('{"jsonrpc":"2.0","result":{"value":1}}');
    });
    const redirector = await listen((_req, res) => {
      res.statusCode = 307;
      res.setHeader("location", destination.url);
      res.end();
    });

    await expect(
      fetchPinnedSolanaRpcRead({
        rpcUrl: redirector.url,
        body: '{"jsonrpc":"2.0","method":"getBalance"}',
        timeoutMs: 2_000,
      }),
    ).rejects.toThrow();
    expect(redirectedRequests).toBe(0);

    const direct = await fetchPinnedSolanaRpcRead({
      rpcUrl: destination.url,
      body: '{"jsonrpc":"2.0","method":"getBalance"}',
      timeoutMs: 2_000,
    });
    try {
      expect(direct.response.status).toBe(200);
      await expect(direct.response.json()).resolves.toMatchObject({ result: { value: 1 } });
    } finally {
      await direct.release();
    }
  });

  it("rejects credentials, fragments, and non-loopback HTTP before fetching", async () => {
    for (const rpcUrl of [
      "https://user:secret@rpc.example/",
      "https://rpc.example/#secret",
      "http://rpc.example/",
    ]) {
      await expect(
        fetchPinnedSolanaRpcRead({ rpcUrl, body: "{}", timeoutMs: 2_000 }),
      ).rejects.toThrow(/not safe/i);
    }
  });
});
