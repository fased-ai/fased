import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "./auth-profiles/types.js";

const mocks = vi.hoisted(() => ({
  syncExternalCliCredentials: vi.fn((store: AuthProfileStore) => {
    store.profiles["external:default"] = {
      type: "token",
      provider: "external",
      token: "external-token",
    };
    return true;
  }),
}));

vi.mock("./auth-profiles/external-cli-sync.js", () => ({
  syncExternalCliCredentials: mocks.syncExternalCliCredentials,
}));

const { upsertAuthProfile } = await import("./auth-profiles/profiles.js");

describe("auth profile local update persistence", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("does not persist externally synced CLI credentials during local upsert", () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "fased-auth-local-update-"));
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai:default",
        credential: {
          type: "api_key",
          provider: "openai",
          key: "sk-test",
        },
      });

      const authPath = path.join(agentDir, "auth-profiles.json");
      const persisted = JSON.parse(fs.readFileSync(authPath, "utf8")) as AuthProfileStore;

      expect(persisted.profiles["openai:default"]).toMatchObject({
        type: "api_key",
        provider: "openai",
      });
      expect(persisted.profiles["external:default"]).toBeUndefined();
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
