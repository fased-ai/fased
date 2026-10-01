import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createChatGptPlanAttempt,
  exchangeChatGptPlanCode,
  getChatGptHostId,
  validateChatGptCallback,
  type ChatGptPlanCredential,
} from "../providers/chatgpt-plan-auth.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { WizardCancelledError } from "../wizard/prompts.js";

export async function loginOpenAICodexOAuth(params: {
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  isRemote: boolean;
  openUrl: (url: string) => Promise<void>;
  localBrowserMessage?: string;
  existing?: ChatGptPlanCredential;
  stateDir?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<ChatGptPlanCredential> {
  if (params.isRemote) {
    throw new Error(
      "ChatGPT plan registration must complete in a local browser. Hosting account transfer is not implemented yet; do not paste authorization codes.",
    );
  }
  const signal = params.prompter.signal;
  if (signal?.aborted) {
    throw new WizardCancelledError();
  }
  const hostId = await getChatGptHostId(params.stateDir);
  const server = createServer();
  let finish: (url: URL) => void = () => {};
  let fail: (error: Error) => void = () => {};
  const callback = new Promise<URL>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  // Cancellation may happen while opening the browser; attach a rejection handler immediately.
  void callback.catch(() => {});
  const abort = () => {
    fail(new WizardCancelledError());
    server.closeAllConnections();
    server.close();
  };
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(
    () => fail(new Error("ChatGPT sign-in expired; start a fresh sign-in")),
    params.timeoutMs ?? 15 * 60_000,
  );
  timeout.unref();
  const spin = params.prompter.progress("Opening ChatGPT sign-in…");
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address() as AddressInfo;
    const redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
    const attempt = createChatGptPlanAttempt({ redirectUri, hostId, existing: params.existing });
    let consumed = false;
    server.on("request", (request, response) => {
      response.setHeader("content-type", "text/plain; charset=utf-8");
      response.setHeader("cache-control", "no-store");
      response.setHeader("referrer-policy", "no-referrer");
      const url = new URL(request.url ?? "/", redirectUri);
      if (
        request.method !== "GET" ||
        request.headers.host !== `127.0.0.1:${address.port}` ||
        url.pathname !== "/auth/callback"
      ) {
        response.writeHead(404).end("Not found");
        return;
      }
      if (consumed || signal?.aborted) {
        response.writeHead(410).end("Sign-in attempt is closed");
        return;
      }
      try {
        validateChatGptCallback(attempt, url);
      } catch (error) {
        response.writeHead(400).end("Sign-in could not complete. Return to Fased.");
        // Invalid unsolicited state never consumes the owner's pending attempt.
        if (url.searchParams.get("state") === attempt.state) {
          consumed = true;
          fail(error instanceof Error ? error : new Error("ChatGPT callback rejected"));
        }
        return;
      }
      consumed = true;
      response.end("Completing sign-in. You can return to Fased.");
      finish(url);
    });
    if (signal?.aborted) {
      throw new WizardCancelledError();
    }
    spin.update(params.localBrowserMessage ?? "Complete sign-in in your browser…");
    await params.openUrl(attempt.url);
    const url = await callback;
    if (signal?.aborted) {
      throw new WizardCancelledError();
    }
    const credential = await exchangeChatGptPlanCode(attempt, url, params.fetchImpl, signal);
    if (signal?.aborted) {
      throw new WizardCancelledError();
    }
    spin.stop("ChatGPT sign-in complete");
    return credential;
  } catch (error) {
    spin.stop(signal?.aborted ? "Sign-in cancelled" : "ChatGPT sign-in failed");
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
