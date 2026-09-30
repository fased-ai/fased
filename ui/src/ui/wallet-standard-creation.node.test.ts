import { afterEach, expect, it, vi } from "vitest";
import { createStandardWalletNamedWallet } from "./wallet-api.ts";

afterEach(() => vi.unstubAllGlobals());

it("creates a standard wallet without adding operations or changing existing wallets", async () => {
  const wallets = [{ name: "Wallet", id: "savings", metadata: { role: "vault" } }];
  const before = JSON.stringify(wallets);
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ ok: true, wallet: { id: "agent-2" } }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  await createStandardWalletNamedWallet({ rpcProfileId: "devnet-primary" }, wallets);
  const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("/api/wallet/wallets");
  expect(options.credentials).toBe("include");
  if (typeof options.body !== "string") {
    throw new Error("Expected a JSON creation request");
  }
  expect(JSON.parse(options.body)).toEqual({
    name: "Wallet 2",
    rpcProfileId: "devnet-primary",
    providerId: "local-socket-signer",
    role: "agent",
    chain: "solana",
  });
  expect(JSON.stringify(wallets)).toBe(before);
});

it("preserves a chosen purpose name and cannot accept a caller-selected legacy role", async () => {
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, wallet: {} }) }));
  vi.stubGlobal("fetch", fetchMock);
  const input = {
    name: " Trading ",
    rpcUrl: "https://rpc.example",
    role: "mining",
    policy: { allowAll: true },
  };
  await createStandardWalletNamedWallet(input, []);
  const [, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  if (typeof options.body !== "string") {
    throw new Error("Expected a JSON creation request");
  }
  expect(JSON.parse(options.body)).toEqual({
    name: "Trading",
    rpcUrl: "https://rpc.example",
    providerId: "local-socket-signer",
    role: "agent",
    chain: "solana",
  });
});
