import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  activateSecretsRuntimeSnapshot,
  clearSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot,
} from "../secrets/runtime.js";
import {
  ensureAuthProfileStore,
  markAuthProfileUsed,
  upsertAuthProfile,
  setAuthProfileOrder,
  replaceRuntimeAuthProfileStoreSnapshots,
  clearRuntimeAuthProfileStoreSnapshots,
} from "./auth-profiles.js";

describe("auth profile runtime snapshot persistence", () => {
  it("does not write resolved plaintext keys during usage updates", async () => {
    const runtimeKey = randomUUID();
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-auth-runtime-save-"));
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const authPath = path.join(agentDir, "auth-profiles.json");
    try {
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(
        authPath,
        `${JSON.stringify(
          {
            version: 1,
            profiles: {
              "openai:default": {
                type: "api_key",
                provider: "openai",
                keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const snapshot = await prepareSecretsRuntimeSnapshot({
        config: {},
        env: { OPENAI_API_KEY: runtimeKey },
        agentDirs: [agentDir],
      });
      activateSecretsRuntimeSnapshot(snapshot);

      const runtimeStore = ensureAuthProfileStore(agentDir);
      expect(runtimeStore.profiles["openai:default"]).toMatchObject({
        type: "api_key",
        key: runtimeKey,
        keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
      });

      await markAuthProfileUsed({
        store: runtimeStore,
        profileId: "openai:default",
        agentDir,
      });

      const persisted = JSON.parse(await fs.readFile(authPath, "utf8")) as {
        profiles: Record<string, { key?: string; keyRef?: unknown }>;
      };
      expect(persisted.profiles["openai:default"]?.key).toBeUndefined();
      expect(persisted.profiles["openai:default"]?.keyRef).toEqual({
        source: "env",
        provider: "default",
        id: "OPENAI_API_KEY",
      });
    } finally {
      clearSecretsRuntimeSnapshot();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe("account edits with an active runtime snapshot", () => {
  it("preserves new sign-ins and prior accounts through account selection and restart", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-account-edit-"));
    const authPath = path.join(agentDir, "auth-profiles.json");
    try {
      replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store: { version: 1, profiles: {} } }]);
      for (const profileId of ["openai-codex:first", "openai-codex:second"]) {
        upsertAuthProfile({
          agentDir,
          profileId,
          credential: {
            type: "oauth",
            provider: "openai-codex",
            access: randomUUID(),
            refresh: randomUUID(),
            expires: Date.now() + 3600000,
          },
        });
        await setAuthProfileOrder({ agentDir, provider: "openai-codex", order: [profileId] });
      }
      const persisted = JSON.parse(await fs.readFile(authPath, "utf8"));
      expect(Object.keys(persisted.profiles)).toEqual([
        "openai-codex:first",
        "openai-codex:second",
      ]);
      expect(persisted.order["openai-codex"]).toEqual(["openai-codex:second"]);
      clearRuntimeAuthProfileStoreSnapshots();
      expect(Object.keys(ensureAuthProfileStore(agentDir).profiles)).toEqual(
        Object.keys(persisted.profiles),
      );
      expect((await fs.stat(authPath)).mode & 0o777).toBe(0o600);
    } finally {
      clearRuntimeAuthProfileStoreSnapshots();
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });
  it("refuses to overwrite an unreadable credential file with a cached snapshot", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-account-corrupt-"));
    const authPath = path.join(agentDir, "auth-profiles.json");
    try {
      replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store: { version: 1, profiles: {} } }]);
      await fs.writeFile(authPath, "{broken");
      expect(() =>
        upsertAuthProfile({
          agentDir,
          profileId: "openai-codex:new",
          credential: {
            type: "oauth",
            provider: "openai-codex",
            access: randomUUID(),
            refresh: randomUUID(),
            expires: Date.now() + 3600000,
          },
        }),
      ).toThrow();
      expect(
        await setAuthProfileOrder({
          agentDir,
          provider: "openai-codex",
          order: ["openai-codex:new"],
        }),
      ).toBeNull();
      expect(await fs.readFile(authPath, "utf8")).toBe("{broken");
    } finally {
      clearRuntimeAuthProfileStoreSnapshots();
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });
});
