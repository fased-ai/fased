import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";

const mocks = vi.hoisted(() => ({ exchange: vi.fn() }));
vi.mock("../providers/chatgpt-plan-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../providers/chatgpt-plan-auth.js")>()),
  exchangeChatGptPlanCode: mocks.exchange,
}));
import { loginOpenAICodexOAuth } from "./openai-codex-oauth.js";

let stateDir: string;
beforeEach(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-login-test-"));
  vi.clearAllMocks();
});
afterEach(async () => {
  await fs.rm(stateDir, { recursive: true });
});
function options(openUrl: (url: string) => Promise<void>, signal?: AbortSignal) {
  return {
    stateDir,
    isRemote: false,
    openUrl,
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as unknown as RuntimeEnv,
    prompter: {
      signal,
      progress: () => ({ update: vi.fn(), stop: vi.fn() }),
    } as unknown as WizardPrompter,
  };
}
function resultUrl(url: string, state?: string) {
  const auth = new URL(url);
  const callback = new URL(auth.searchParams.get("redirect_uri")!);
  callback.searchParams.set("state", state ?? auth.searchParams.get("state")!);
  callback.searchParams.set("code", "local-test-code");
  callback.searchParams.set("client_id", "oaiapp_test");
  return callback;
}

describe("ChatGPT local callback lifetime", () => {
  it("starts a private available-port listener before opening the browser and exchanges once", async () => {
    mocks.exchange.mockResolvedValue({ chatgptPlan: true, access: "test-token" });
    let callback: URL | undefined;
    const params = options(async (url) => {
      callback = resultUrl(url);
      const first = await fetch(callback);
      expect(first.status).toBe(200);
      expect(await first.text()).not.toContain("local-test-code");
      expect((await fetch(callback)).status).toBe(410);
    });
    expect(await loginOpenAICodexOAuth(params)).toMatchObject({ chatgptPlan: true });
    expect(mocks.exchange).toHaveBeenCalledTimes(1);
    expect(params.runtime.log).not.toHaveBeenCalled();
    await expect(fetch(callback!)).rejects.toThrow();
  });
  it("rejects a stale callback without consuming the current attempt", async () => {
    mocks.exchange.mockResolvedValue({ chatgptPlan: true });
    await loginOpenAICodexOAuth(
      options(async (url) => {
        expect((await fetch(resultUrl(url, "stale"))).status).toBe(400);
        expect((await fetch(resultUrl(url))).status).toBe(200);
      }),
    );
    expect(mocks.exchange).toHaveBeenCalledTimes(1);
  });
  it("cancels a waiting browser flow and closes its listener", async () => {
    const controller = new AbortController();
    let callback: URL | undefined;
    const params = options(async (url) => {
      callback = resultUrl(url);
      controller.abort();
    }, controller.signal);
    await expect(loginOpenAICodexOAuth(params)).rejects.toThrow("wizard cancelled");
    expect(mocks.exchange).not.toHaveBeenCalled();
    await expect(fetch(callback!)).rejects.toThrow();
  });
  it("cleans up a failed browser opening without exchanging", async () => {
    await expect(
      loginOpenAICodexOAuth(
        options(async () => {
          throw new Error("browser unavailable");
        }),
      ),
    ).rejects.toThrow("browser unavailable");
    expect(mocks.exchange).not.toHaveBeenCalled();
  });
  it("expires an unanswered attempt without exchanging", async () => {
    await expect(
      loginOpenAICodexOAuth({ ...options(async () => {}), timeoutMs: 10 }),
    ).rejects.toThrow("expired");
    expect(mocks.exchange).not.toHaveBeenCalled();
  });
  it("does not start server-local authentication for a remote owner's browser", async () => {
    const params = { ...options(vi.fn()), isRemote: true };
    await expect(loginOpenAICodexOAuth(params)).rejects.toThrow("local browser");
    expect(params.openUrl).not.toHaveBeenCalled();
  });
});
