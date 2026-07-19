import type { Dispatcher } from "undici";
import {
  closeDispatcher,
  createPinnedDispatcher,
  resolvePinnedHostnameWithPolicy,
  type SsrFPolicy,
} from "../infra/net/ssrf.js";

function normalizeRpcHostname(hostname: string): string {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
  return normalized.startsWith("[") && normalized.endsWith("]")
    ? normalized.slice(1, -1)
    : normalized;
}

function isLoopbackRpcHostname(hostname: string): boolean {
  const normalized = normalizeRpcHostname(hostname);
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

function isLoopbackRpcAddress(address: string): boolean {
  const normalized = normalizeRpcHostname(address);
  return (
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized) ||
    /^::ffff:127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

async function resolveWithTimeout(hostname: string, policy: SsrFPolicy, timeoutMs: number) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      resolvePinnedHostnameWithPolicy(hostname, { policy }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("stored Solana RPC hostname resolution timed out")),
          Math.max(250, timeoutMs),
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function fetchPinnedSolanaRpcRead(params: {
  rpcUrl: string;
  body: string;
  timeoutMs: number;
}): Promise<{ response: Response; release: () => Promise<void> }> {
  const parsed = new URL(params.rpcUrl);
  const hostname = normalizeRpcHostname(parsed.hostname);
  const loopback = isLoopbackRpcHostname(hostname);
  if (
    !hostname ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback))
  ) {
    throw new Error("stored Solana RPC URL is not safe for Gateway reads");
  }
  const policy: SsrFPolicy = {
    hostnameAllowlist: [hostname],
    // Loopback is a deliberate Local-development exception. Resolve it under an
    // exact-name policy, then independently require every pinned answer to remain
    // loopback so a modified hosts file cannot redirect localhost to another LAN host.
    ...(loopback ? { allowPrivateNetwork: true } : {}),
  };
  const pinned = await resolveWithTimeout(hostname, policy, params.timeoutMs);
  if (loopback && !pinned.addresses.every(isLoopbackRpcAddress)) {
    throw new Error("stored Local Solana RPC hostname did not resolve only to loopback addresses");
  }
  const dispatcher = createPinnedDispatcher(pinned);
  try {
    const response = await fetch(parsed.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: params.body,
      redirect: "error",
      signal: AbortSignal.timeout(Math.max(250, params.timeoutMs)),
      dispatcher,
    } as RequestInit & { dispatcher: Dispatcher });
    return {
      response,
      release: async () => closeDispatcher(dispatcher),
    };
  } catch (error) {
    await closeDispatcher(dispatcher);
    throw error;
  }
}
