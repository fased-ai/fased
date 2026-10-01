import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { resolveApiKeyForProfile } from "./oauth.js";
import { ensureAuthProfileStore, saveAuthProfileStore } from "./store.js";
import type { AuthProfileStore } from "./types.js";
it("refreshes a plan registration through the public grant and recovers its rotating tokens from disk", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fased-refresh-test-"));
  const agentDir = path.join(directory, "agent");
  vi.stubEnv("FASED_STATE_DIR", directory);
  vi.stubEnv("FASED_AGENT_DIR", agentDir);
  const profileId = "openai-codex:plan-test";
  const store: AuthProfileStore = {
    version: 1,
    profiles: {
      [profileId]: {
        type: "oauth",
        provider: "openai-codex",
        chatgptPlan: true,
        clientId: "oaiapp_test",
        subject: "owner",
        hostId: "test-host",
        idToken: "test-id",
        scopes: ["chatgpt.tokens.use.direct"],
        access: "expired-test-token",
        refresh: "old-test-refresh",
        expires: Date.now() - 1000,
      },
    },
  };
  const request = vi.fn<typeof fetch>(async () =>
    Response.json({
      token_type: "Bearer",
      access_token: "rotated-test-token",
      refresh_token: "rotated-test-refresh",
      expires_in: 3600,
      scope: "chatgpt.tokens.use.direct",
    }),
  );
  vi.stubGlobal("fetch", request);
  try {
    saveAuthProfileStore(store, agentDir);
    const result = await resolveApiKeyForProfile({
      cfg: { auth: { profiles: { [profileId]: { provider: "openai-codex", mode: "oauth" } } } },
      store,
      profileId,
      agentDir,
    });
    expect(result?.apiKey).toBe("rotated-test-token");
    expect(request.mock.calls[0][0]).toBe("https://auth.openai.com/api/accounts/oauth/token");
    const restarted = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
    expect(restarted.profiles[profileId]).toMatchObject({
      access: "rotated-test-token",
      refresh: "rotated-test-refresh",
      clientId: "oaiapp_test",
      subject: "owner",
      chatgptPlan: true,
    });
    expect((await fs.stat(path.join(agentDir, "auth-profiles.json"))).mode & 0o777).toBe(0o600);
    expect((await fs.readdir(agentDir)).some((name) => name.endsWith(".tmp"))).toBe(false);
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await fs.rm(directory, { recursive: true });
  }
});
