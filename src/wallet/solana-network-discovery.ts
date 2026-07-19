export type SupportedSolanaNetwork = "local" | "devnet" | "mainnet-beta";

const OFFICIAL_SOLANA_RPC_URLS = {
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
  devnet: "https://api.devnet.solana.com",
  testnet: "https://api.testnet.solana.com",
} as const;

type SolanaNetworkDiscoveryOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

function parseRpcUrl(raw: string): URL {
  try {
    return new URL(raw.trim());
  } catch {
    throw new Error("Solana RPC URL is invalid");
  }
}

function isLoopbackRpc(url: URL): boolean {
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    hostname === "localhost" ||
    hostname === "localnet" ||
    hostname === "127.0.0.1" ||
    hostname === "::1"
  );
}

function officialNetworkFor(url: URL): "mainnet-beta" | "devnet" | "testnet" | undefined {
  const normalized = `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
  return (
    Object.entries(OFFICIAL_SOLANA_RPC_URLS) as Array<
      ["mainnet-beta" | "devnet" | "testnet", string]
    >
  ).find(([, rpcUrl]) => normalized === rpcUrl)?.[0];
}

async function fetchGenesisHash(params: {
  rpcUrl: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
}): Promise<string> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const response = await params.fetchImpl(params.rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getGenesisHash", params: [] }),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error("RPC request failed");
        }
        const declaredLength = Number(response.headers.get("content-length") ?? "0");
        if (Number.isFinite(declaredLength) && declaredLength > 16 * 1024) {
          throw new Error("RPC response is too large");
        }
        const body = await response.text();
        if (body.length > 16 * 1024) {
          throw new Error("RPC response is too large");
        }
        const payload = JSON.parse(body) as { result?: unknown; error?: unknown };
        if (payload.error || typeof payload.result !== "string" || !payload.result.trim()) {
          throw new Error("RPC returned an invalid genesis hash");
        }
        return payload.result.trim();
      })(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error("RPC genesis verification timed out"));
        }, params.timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

/**
 * Infers the cluster without adding a network question to normal onboarding.
 * Opaque provider URLs are matched to live official cluster witnesses by genesis
 * hash; the public endpoints are never returned as execution fallbacks.
 */
export async function discoverSolanaNetworkFromRpc(
  rpcUrl: string,
  options: SolanaNetworkDiscoveryOptions = {},
): Promise<SupportedSolanaNetwork> {
  const parsed = parseRpcUrl(rpcUrl);
  if (isLoopbackRpc(parsed)) {
    return "local";
  }
  const official = officialNetworkFor(parsed);
  if (official === "mainnet-beta" || official === "devnet") {
    return official;
  }
  if (official === "testnet") {
    throw new Error("Solana testnet is not supported for SAT Mining");
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = Math.max(250, Math.min(options.timeoutMs ?? 8_000, 30_000));
  const targets = [
    rpcUrl.trim(),
    OFFICIAL_SOLANA_RPC_URLS["mainnet-beta"],
    OFFICIAL_SOLANA_RPC_URLS.devnet,
    OFFICIAL_SOLANA_RPC_URLS.testnet,
  ];
  const results = await Promise.allSettled(
    targets.map((target) => fetchGenesisHash({ rpcUrl: target, fetchImpl, timeoutMs })),
  );
  const primary = results[0];
  if (primary.status !== "fulfilled") {
    throw new Error("Unable to verify the Solana RPC cluster by genesis hash");
  }
  if (results[1]?.status === "fulfilled" && results[1].value === primary.value) {
    return "mainnet-beta";
  }
  if (results[2]?.status === "fulfilled" && results[2].value === primary.value) {
    return "devnet";
  }
  if (results[3]?.status === "fulfilled" && results[3].value === primary.value) {
    throw new Error("Solana testnet is not supported for SAT Mining");
  }
  throw new Error("The Solana RPC cluster is unsupported or could not be independently verified");
}
