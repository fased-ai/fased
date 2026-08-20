import { formatCliCommand } from "../cli/command-format.js";
import { loadConfig } from "../config/config.js";
import { isLoopbackHost } from "../gateway/net.js";
import { getBridgeAuthForPort } from "./bridge-auth-registry.js";
import { resolveBrowserConfig } from "./config.js";
import { resolveBrowserControlAuth } from "./control-auth.js";

// Application-level error from the browser control service (service is reachable
// but returned an error response). Must NOT be wrapped with "Can't reach ..." messaging.
class BrowserServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserServiceError";
  }
}

type LoopbackBrowserAuthDeps = {
  loadConfig: typeof loadConfig;
  resolveBrowserControlAuth: typeof resolveBrowserControlAuth;
  getBridgeAuthForPort: typeof getBridgeAuthForPort;
};

function isAbsoluteHttp(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

function isLoopbackHttpUrl(url: string): boolean {
  try {
    return isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

function withLoopbackBrowserAuthImpl(
  url: string,
  init: (RequestInit & { timeoutMs?: number }) | undefined,
  deps: LoopbackBrowserAuthDeps,
): RequestInit & { timeoutMs?: number } {
  const headers = new Headers(init?.headers ?? {});
  if (headers.has("authorization") || headers.has("x-fased-password")) {
    return { ...init, headers };
  }
  if (!isLoopbackHttpUrl(url)) {
    return { ...init, headers };
  }

  try {
    const cfg = deps.loadConfig();
    const auth = deps.resolveBrowserControlAuth(cfg);
    if (auth.token) {
      headers.set("Authorization", `Bearer ${auth.token}`);
      return { ...init, headers };
    }
    if (auth.password) {
      headers.set("x-fased-password", auth.password);
      return { ...init, headers };
    }
  } catch {
    // ignore config/auth lookup failures and continue without auth headers
  }

  // Sandbox bridge servers can run with per-process ephemeral auth on dynamic ports.
  // Fall back to the in-memory registry if config auth is not available.
  try {
    const parsed = new URL(url);
    const port =
      parsed.port && Number.parseInt(parsed.port, 10) > 0
        ? Number.parseInt(parsed.port, 10)
        : parsed.protocol === "https:"
          ? 443
          : 80;
    const bridgeAuth = deps.getBridgeAuthForPort(port);
    if (bridgeAuth?.token) {
      headers.set("Authorization", `Bearer ${bridgeAuth.token}`);
    } else if (bridgeAuth?.password) {
      headers.set("x-fased-password", bridgeAuth.password);
    }
  } catch {
    // ignore
  }

  return { ...init, headers };
}

function withLoopbackBrowserAuth(
  url: string,
  init: (RequestInit & { timeoutMs?: number }) | undefined,
): RequestInit & { timeoutMs?: number } {
  return withLoopbackBrowserAuthImpl(url, init, {
    loadConfig,
    resolveBrowserControlAuth,
    getBridgeAuthForPort,
  });
}

function enhanceBrowserFetchError(url: string, err: unknown, timeoutMs: number): Error {
  const isLocal = !isAbsoluteHttp(url);
  // Human-facing hint for logs/diagnostics.
  const operatorHint = isLocal
    ? `Restart the FasedAgent gateway (FasedAgent.app menubar, or \`${formatCliCommand("fased gateway")}\`).`
    : "If this is a sandboxed session, ensure the sandbox browser is running.";
  // Model-facing suffix: explicitly tell the LLM NOT to retry.
  // Without this, models see "try again" and enter an infinite tool-call loop.
  const modelHint =
    "Do NOT retry the browser tool — it will keep failing. " +
    "Use an alternative approach or inform the user that the browser is currently unavailable.";
  const msg = String(err);
  const msgLower = msg.toLowerCase();
  const looksLikeTimeout =
    msgLower.includes("timed out") ||
    msgLower.includes("timeout") ||
    msgLower.includes("aborted") ||
    msgLower.includes("abort") ||
    msgLower.includes("aborterror");
  if (looksLikeTimeout) {
    return new Error(
      `Can't reach the FasedAgent browser control service (timed out after ${timeoutMs}ms). ${operatorHint} ${modelHint}`,
    );
  }
  return new Error(
    `Can't reach the FasedAgent browser control service. ${operatorHint} ${modelHint} (${msg})`,
  );
}

async function fetchHttpJson<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number },
): Promise<T> {
  const timeoutMs = init.timeoutMs ?? 5000;
  const ctrl = new AbortController();
  const upstreamSignal = init.signal;
  let upstreamAbortListener: (() => void) | undefined;
  if (upstreamSignal) {
    if (upstreamSignal.aborted) {
      ctrl.abort(upstreamSignal.reason);
    } else {
      upstreamAbortListener = () => ctrl.abort(upstreamSignal.reason);
      upstreamSignal.addEventListener("abort", upstreamAbortListener, { once: true });
    }
  }

  const t = setTimeout(() => ctrl.abort(new Error("timed out")), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new BrowserServiceError(text || `HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
    if (upstreamSignal && upstreamAbortListener) {
      upstreamSignal.removeEventListener("abort", upstreamAbortListener);
    }
  }
}

export async function fetchBrowserJson<T>(
  url: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<T> {
  const timeoutMs = init?.timeoutMs ?? 5000;
  try {
    const target = isAbsoluteHttp(url)
      ? url
      : new URL(url, `http://127.0.0.1:${resolveBrowserConfig(loadConfig()).controlPort}`).href;
    const httpInit = withLoopbackBrowserAuth(target, init);
    return await fetchHttpJson<T>(target, { ...httpInit, timeoutMs });
  } catch (err) {
    if (err instanceof BrowserServiceError) {
      throw err;
    }
    throw enhanceBrowserFetchError(url, err, timeoutMs);
  }
}

export const __test = {
  withLoopbackBrowserAuth: withLoopbackBrowserAuthImpl,
};
