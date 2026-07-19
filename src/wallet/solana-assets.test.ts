import { PublicKey } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchSolanaWalletAssetsViaRpc,
  invalidateSolanaAssetRpcCaches,
  parseMetaplexMetadataAccount,
  SOLANA_ASSET_CONSTANTS,
} from "./solana-assets.js";

function encodeBorshString(value: string): Buffer {
  const payload = Buffer.from(value, "utf8");
  const size = Buffer.alloc(4);
  size.writeUInt32LE(payload.length, 0);
  return Buffer.concat([size, payload]);
}

function buildMetaplexMetadataBase64(params: {
  name: string;
  symbol: string;
  uri: string;
}): string {
  return Buffer.concat([
    Buffer.from([4]),
    Buffer.alloc(32),
    Buffer.alloc(32),
    encodeBorshString(params.name),
    encodeBorshString(params.symbol),
    encodeBorshString(params.uri),
  ]).toString("base64");
}

function deriveMetadataAddress(mint: string): string {
  const metadataProgram = new PublicKey(SOLANA_ASSET_CONSTANTS.metaplexMetadataProgramId);
  const mintKey = new PublicKey(mint);
  const [metadataAddress] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), metadataProgram.toBuffer(), mintKey.toBuffer()],
    metadataProgram,
  );
  return metadataAddress.toBase58();
}

describe("parseMetaplexMetadataAccount", () => {
  it("parses name, symbol, and uri from the metadata account", () => {
    const parsed = parseMetaplexMetadataAccount(
      buildMetaplexMetadataBase64({
        name: "USD Coin\u0000\u0000",
        symbol: "USDC\u0000",
        uri: "https://example.com/token.json\u0000",
      }),
    );
    expect(parsed).toEqual({
      name: "USD Coin",
      symbol: "USDC",
      uri: "https://example.com/token.json",
    });
  });
});

describe("fetchSolanaWalletAssetsViaRpc", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    invalidateSolanaAssetRpcCaches();
  });

  it("resolves SPL metadata from token-2022 extensions, metadata URI, and Jupiter enrichment", async () => {
    const metaplexMint = new PublicKey(Buffer.alloc(32, 7)).toBase58();
    const token2022Mint = new PublicKey(Buffer.alloc(32, 8)).toBase58();
    const metaplexMetadataAddress = deriveMetadataAddress(metaplexMint);
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const rawBody = typeof init?.body === "string" ? init.body : "{}";
      const body = JSON.parse(rawBody) as {
        method?: string;
        params?: unknown[];
      };
      const method = body.method ?? "";
      const params = Array.isArray(body.params) ? body.params : [];
      if (String(_url).startsWith("https://lite-api.jup.ag/ultra/v1/search")) {
        return {
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => [
            {
              address: metaplexMint,
              name: "USD Coin Indexed",
              symbol: "USDC",
              icon: "https://img.example/usdc.png",
              usdPrice: 1,
              isVerified: true,
              tags: ["verified", "strict"],
            },
          ],
        } as Response;
      }
      if (String(_url) === "https://example.com/tt22.json") {
        return {
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({
            name: "Token Twenty Two Metadata",
            symbol: "TT22",
            image: "https://img.example/tt22.png",
          }),
        } as Response;
      }
      if (method === "getTokenAccountsByOwner") {
        const filter = params[1] as { programId?: string } | undefined;
        if (filter?.programId === SOLANA_ASSET_CONSTANTS.tokenProgramId) {
          return {
            ok: true,
            json: async () => ({
              result: {
                value: [
                  {
                    pubkey: new PublicKey(Buffer.alloc(32, 9)).toBase58(),
                    account: {
                      data: {
                        parsed: {
                          info: {
                            mint: metaplexMint,
                            tokenAmount: { amount: "1234500", decimals: 6 },
                          },
                        },
                      },
                    },
                  },
                ],
              },
            }),
          } as Response;
        }
        if (filter?.programId === SOLANA_ASSET_CONSTANTS.token2022ProgramId) {
          return {
            ok: true,
            json: async () => ({
              result: {
                value: [
                  {
                    pubkey: new PublicKey(Buffer.alloc(32, 10)).toBase58(),
                    account: {
                      data: {
                        parsed: {
                          info: {
                            mint: token2022Mint,
                            tokenAmount: { amount: "4200", decimals: 2 },
                          },
                        },
                      },
                    },
                  },
                ],
              },
            }),
          } as Response;
        }
      }
      if (method === "getMultipleAccounts") {
        const addresses = Array.isArray(params[0]) ? params[0].map(String) : [];
        const config = (params[1] ?? {}) as { encoding?: string };
        if (config.encoding === "jsonParsed") {
          return {
            ok: true,
            json: async () => ({
              result: {
                value: addresses.map((address) => {
                  if (address === metaplexMint) {
                    return {
                      owner: SOLANA_ASSET_CONSTANTS.tokenProgramId,
                      data: { parsed: { info: { decimals: 6, extensions: [] } } },
                    };
                  }
                  if (address === token2022Mint) {
                    return {
                      owner: SOLANA_ASSET_CONSTANTS.token2022ProgramId,
                      data: {
                        parsed: {
                          info: {
                            decimals: 2,
                            extensions: [
                              {
                                extension: "tokenMetadata",
                                state: {
                                  name: "Token Twenty Two",
                                  symbol: "TT22",
                                  uri: "https://example.com/tt22.json",
                                },
                              },
                            ],
                          },
                        },
                      },
                    };
                  }
                  return null;
                }),
              },
            }),
          } as Response;
        }
        if (config.encoding === "base64") {
          return {
            ok: true,
            json: async () => ({
              result: {
                value: addresses.map((address) => {
                  if (address === metaplexMetadataAddress) {
                    return {
                      data: [
                        buildMetaplexMetadataBase64({
                          name: "USD Coin",
                          symbol: "USDC",
                          uri: "https://example.com/usdc.json",
                        }),
                        "base64",
                      ],
                    };
                  }
                  return null;
                }),
              },
            }),
          } as Response;
        }
      }
      if (method === "getAccountInfo") {
        const address = typeof params[0] === "string" ? params[0] : "";
        const config = (params[1] ?? {}) as { encoding?: string };
        if (address === metaplexMint && config.encoding === "jsonParsed") {
          return {
            ok: true,
            json: async () => ({
              result: {
                value: {
                  owner: SOLANA_ASSET_CONSTANTS.tokenProgramId,
                  data: { parsed: { info: { decimals: 6, extensions: [] } } },
                },
              },
            }),
          } as Response;
        }
        if (address === token2022Mint && config.encoding === "jsonParsed") {
          return {
            ok: true,
            json: async () => ({
              result: {
                value: {
                  owner: SOLANA_ASSET_CONSTANTS.token2022ProgramId,
                  data: {
                    parsed: {
                      info: {
                        decimals: 2,
                        extensions: [
                          {
                            extension: "tokenMetadata",
                            state: {
                              name: "Token Twenty Two",
                              symbol: "TT22",
                              uri: "https://example.com/tt22.json",
                            },
                          },
                        ],
                      },
                    },
                  },
                },
              },
            }),
          } as Response;
        }
        if (address === metaplexMetadataAddress && config.encoding === "base64") {
          return {
            ok: true,
            json: async () => ({
              result: {
                value: {
                  data: [
                    buildMetaplexMetadataBase64({
                      name: "USD Coin",
                      symbol: "USDC",
                      uri: "https://example.com/usdc.json",
                    }),
                    "base64",
                  ],
                },
              },
            }),
          } as Response;
        }
      }
      return {
        ok: true,
        json: async () => ({ result: { value: [] } }),
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const assets = await fetchSolanaWalletAssetsViaRpc({
      rpcUrl: "http://localhost:8899",
      ownerAddress: new PublicKey(Buffer.alloc(32, 11)).toBase58(),
      nativeLamports: "1000000000",
    });

    expect(assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: `solana:spl-token:${metaplexMint}`,
          symbol: "USDC",
          name: "USD Coin Indexed",
          amountDisplay: "1.2345",
          logoUri: "https://img.example/usdc.png",
          verificationStatus: "verified",
          valueUsd: 1.2345,
        }),
        expect.objectContaining({
          id: `solana:spl-token:${token2022Mint}`,
          symbol: "TT22",
          name: "Token Twenty Two Metadata",
          amountDisplay: "42",
          logoUri: "https://img.example/tt22.png",
        }),
      ]),
    );
    const rpcMethods = fetchMock.mock.calls
      .map(([, init]) => {
        const rawBody = typeof init?.body === "string" ? init.body : "{}";
        return (JSON.parse(rawBody) as { method?: string }).method ?? "";
      })
      .filter(Boolean);
    expect(rpcMethods.filter((method) => method === "getAccountInfo")).toHaveLength(0);
    expect(rpcMethods.filter((method) => method === "getMultipleAccounts")).toHaveLength(2);
  });

  it("caches native balance and token account reads across fast repeated asset loads", async () => {
    invalidateSolanaAssetRpcCaches();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const rawBody = typeof init?.body === "string" ? init.body : "{}";
      const body = JSON.parse(rawBody) as {
        method?: string;
        params?: unknown[];
      };
      if (body.method === "getBalance") {
        return {
          ok: true,
          json: async () => ({ result: { value: 123_000_000 } }),
        } as Response;
      }
      if (body.method === "getTokenAccountsByOwner") {
        return {
          ok: true,
          json: async () => ({ result: { value: [] } }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({ result: { value: [] } }),
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const ownerAddress = new PublicKey(Buffer.alloc(32, 12)).toBase58();
    await fetchSolanaWalletAssetsViaRpc({
      rpcUrl: "http://localhost:8899",
      ownerAddress,
    });
    await fetchSolanaWalletAssetsViaRpc({
      rpcUrl: "http://localhost:8899",
      ownerAddress,
    });
    const rpcMethods = fetchMock.mock.calls
      .map(([, init]) => {
        const rawBody = typeof init?.body === "string" ? init.body : "{}";
        return (JSON.parse(rawBody) as { method?: string }).method ?? "";
      })
      .filter(Boolean);
    expect(rpcMethods.filter((method) => method === "getBalance")).toHaveLength(1);
    expect(rpcMethods.filter((method) => method === "getTokenAccountsByOwner")).toHaveLength(2);
  });
});
