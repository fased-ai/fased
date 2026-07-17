import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  loadAuthProfileStoreForSecretsRuntime,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "./auth-profiles.js";
import { AUTH_STORE_VERSION, log } from "./auth-profiles/constants.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";

type StrictAuthLayout = {
  agentDir: string;
  mainDir: string;
  oauthPath: string;
};

function withStrictAuthLayout(run: (layout: StrictAuthLayout) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-auth-strict-layout-"));
  const agentDir = path.join(root, "agents", "worker", "agent");
  const mainDir = path.join(root, "agents", "main", "agent");
  const oauthDir = path.join(root, "credentials");
  const oauthPath = path.join(oauthDir, "oauth.json");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(mainDir, { recursive: true });
  fs.mkdirSync(oauthDir, { recursive: true });

  const envKeys = [
    "FASED_AGENT_DIR",
    "PI_CODING_AGENT_DIR",
    "FASED_STATE_DIR",
    "FASED_OAUTH_DIR",
    "HOME",
    "CODEX_HOME",
  ] as const;
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  try {
    process.env.FASED_AGENT_DIR = mainDir;
    process.env.PI_CODING_AGENT_DIR = mainDir;
    process.env.FASED_STATE_DIR = root;
    process.env.FASED_OAUTH_DIR = oauthDir;
    process.env.HOME = root;
    process.env.CODEX_HOME = path.join(root, "codex");
    run({ agentDir, mainDir, oauthPath });
  } finally {
    for (const key of envKeys) {
      const value = previous[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeJson(pathname: string, value: unknown): void {
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  fs.writeFileSync(pathname, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function validApiKeyStore(key = "sk-valid"): AuthProfileStore {
  return {
    version: AUTH_STORE_VERSION,
    profiles: {
      "openai:default": {
        type: "api_key",
        provider: "openai",
        key,
      },
    },
  };
}

describe("ensureAuthProfileStore", () => {
  it("fails closed when the secrets runtime reads a corrupt auth profile store", () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "fased-auth-strict-"));
    const previousAgentDir = process.env.FASED_AGENT_DIR;
    const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
      process.env.FASED_AGENT_DIR = agentDir;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      fs.writeFileSync(path.join(agentDir, "auth-profiles.json"), "{not-json\n", "utf8");

      expect(() => loadAuthProfileStoreForSecretsRuntime(agentDir)).toThrow(
        "Auth profile store is unreadable or contains invalid JSON.",
      );

      fs.writeFileSync(
        path.join(agentDir, "auth-profiles.json"),
        `${JSON.stringify({
          version: AUTH_STORE_VERSION,
          profiles: {
            "openai:broken": { type: "api_key", key: "SENTINEL_SECRET" },
          },
        })}\n`,
        "utf8",
      );
      expect(() => loadAuthProfileStoreForSecretsRuntime(agentDir)).toThrow(
        "Auth profile store has an invalid structure or credential entry.",
      );
    } finally {
      if (previousAgentDir === undefined) {
        delete process.env.FASED_AGENT_DIR;
      } else {
        process.env.FASED_AGENT_DIR = previousAgentDir;
      }
      if (previousPiAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
      }
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("strictly validates credential material, refs, expiry, and credential metadata", () => {
    withStrictAuthLayout(({ agentDir }) => {
      const authPath = path.join(agentDir, "auth-profiles.json");
      const invalidProfiles = [
        { type: "api_key", provider: "openai" },
        { type: "api_key", provider: "openai", key: 42 },
        {
          type: "api_key",
          provider: "openai",
          keyRef: { source: "env", provider: "default", id: "" },
        },
        { type: "api_key", provider: "openai", key: "sk-valid", metadata: { accountId: 42 } },
        { type: "token", provider: "github" },
        { type: "token", provider: "github", token: "token", expires: "tomorrow" },
        {
          type: "token",
          provider: "github",
          tokenRef: { source: "env", provider: "default", id: "GITHUB_TOKEN", extra: true },
        },
        {
          type: "oauth",
          provider: "openai-codex",
          access: "access",
          refresh: "",
          expires: Date.now() + 60_000,
        },
        {
          type: "oauth",
          provider: "openai-codex",
          access: "access",
          refresh: "refresh",
          expires: null,
        },
      ];

      for (const profile of invalidProfiles) {
        writeJson(authPath, {
          version: AUTH_STORE_VERSION,
          profiles: { "provider:broken": profile },
        });
        expect(() => loadAuthProfileStoreForSecretsRuntime(agentDir)).toThrow(
          "Auth profile store has an invalid structure or credential entry.",
        );
      }

      writeJson(authPath, {
        version: AUTH_STORE_VERSION,
        profiles: {
          "openai:ref": {
            type: "api_key",
            provider: "openai",
            keyRef: { source: "env", id: "OPENAI_API_KEY" },
          },
          "github:ref": {
            type: "token",
            provider: "github",
            tokenRef: { source: "env", provider: "default", id: "GITHUB_TOKEN" },
            expires: Date.now() + 60_000,
          },
          "openai-codex:default": {
            type: "oauth",
            provider: "openai-codex",
            access: "access",
            refresh: "refresh",
            expires: Date.now() + 60_000,
            availableModelIds: ["gpt-5"],
          },
        },
      });
      const store = loadAuthProfileStoreForSecretsRuntime(agentDir);
      expect(store.profiles["openai:ref"]).toMatchObject({
        type: "api_key",
        provider: "openai",
        keyRef: { source: "env", id: "OPENAI_API_KEY" },
      });
      expect(store.profiles["github:ref"]).toMatchObject({
        type: "token",
        provider: "github",
      });
      expect(store.profiles["openai-codex:default"]).toMatchObject({
        type: "oauth",
        provider: "openai-codex",
      });
    });
  });

  it("rejects malformed strict store metadata and preserves valid last-good state", () => {
    withStrictAuthLayout(({ agentDir }) => {
      const authPath = path.join(agentDir, "auth-profiles.json");
      const invalidMetadata = [
        { version: "1" },
        { version: AUTH_STORE_VERSION + 1 },
        { order: [] },
        { order: { openai: ["openai:default", 42] } },
        { lastGood: { openai: 42 } },
        { usageStats: { "openai:default": [] } },
        { usageStats: { "openai:default": { cooldownUntil: "later" } } },
        { usageStats: { "openai:default": { disabledReason: "not-a-reason" } } },
        { usageStats: { "openai:default": { failureCounts: { auth: -1 } } } },
      ];

      for (const metadata of invalidMetadata) {
        writeJson(authPath, { ...validApiKeyStore(), ...metadata });
        expect(() => loadAuthProfileStoreForSecretsRuntime(agentDir)).toThrow(
          "Auth profile store has an invalid structure or credential entry.",
        );
      }

      const versionlessStore = validApiKeyStore();
      const { version: _version, ...legacyVersionlessStore } = versionlessStore;
      writeJson(authPath, legacyVersionlessStore);
      expect(loadAuthProfileStoreForSecretsRuntime(agentDir).version).toBe(AUTH_STORE_VERSION);

      const lastGood = { openai: "openai:default" };
      const usageStats = {
        "openai:default": {
          lastUsed: Date.now(),
          errorCount: 2,
          failureCounts: { auth: 2 },
          cooldownReason: "auth",
        },
      };
      writeJson(authPath, {
        ...validApiKeyStore(),
        order: { openai: ["openai:default"] },
        lastGood,
        usageStats,
      });
      const store = loadAuthProfileStoreForSecretsRuntime(agentDir);
      expect(store.order).toEqual({ openai: ["openai:default"] });
      expect(store.lastGood).toEqual(lastGood);
      expect(store.usageStats).toEqual(usageStats);
    });
  });

  it("rejects every malformed legacy or OAuth entry and keeps OAuth discriminator fields canonical", () => {
    withStrictAuthLayout(({ agentDir, oauthPath }) => {
      const legacyPath = path.join(agentDir, "auth.json");
      writeJson(legacyPath, {
        openai: { type: "api_key", provider: "openai", key: "sk-valid" },
        broken: { type: "token", provider: "broken" },
      });
      expect(() => loadAuthProfileStoreForSecretsRuntime(agentDir)).toThrow(
        "Legacy auth profile store has an invalid structure or credential entry.",
      );

      writeJson(legacyPath, {
        openai: {
          type: "api_key",
          provider: "openai",
          keyRef: { source: "env", id: "OPENAI_API_KEY" },
        },
        github: {
          type: "token",
          provider: "github",
          tokenRef: { source: "env", provider: "default", id: "GITHUB_TOKEN" },
        },
      });
      const legacyStore = loadAuthProfileStoreForSecretsRuntime(agentDir);
      expect(legacyStore.profiles["openai:default"]).toMatchObject({
        type: "api_key",
        keyRef: { source: "env", id: "OPENAI_API_KEY" },
      });
      expect(legacyStore.profiles["github:default"]).toMatchObject({
        type: "token",
        tokenRef: { source: "env", provider: "default", id: "GITHUB_TOKEN" },
      });

      fs.rmSync(legacyPath, { force: true });
      writeJson(oauthPath, {
        "openai-codex": {
          access: "access",
          refresh: "refresh",
          expires: Date.now() + 60_000,
        },
        broken: { access: "access", refresh: 42, expires: Date.now() + 60_000 },
      });
      expect(() => loadAuthProfileStoreForSecretsRuntime(agentDir)).toThrow(
        "OAuth credential store has an invalid credential entry.",
      );

      writeJson(oauthPath, {
        "openai-codex": {
          type: "api_key",
          provider: "attacker-controlled",
          access: "access",
          refresh: "refresh",
          expires: Date.now() + 60_000,
        },
      });
      const store = loadAuthProfileStoreForSecretsRuntime(agentDir);
      expect(store.profiles["openai-codex:default"]).toMatchObject({
        type: "oauth",
        provider: "openai-codex",
        access: "access",
      });
    });
  });

  it("rejects either side of a main and agent store merge when it is corrupt", () => {
    withStrictAuthLayout(({ agentDir, mainDir }) => {
      const agentPath = path.join(agentDir, "auth-profiles.json");
      const mainPath = path.join(mainDir, "auth-profiles.json");

      writeJson(agentPath, validApiKeyStore("agent-key"));
      fs.writeFileSync(mainPath, "{not-json\n", "utf8");
      expect(() => loadAuthProfileStoreForSecretsRuntime(agentDir)).toThrow(
        "Auth profile store is unreadable or contains invalid JSON.",
      );

      fs.writeFileSync(agentPath, "{not-json\n", "utf8");
      writeJson(mainPath, validApiKeyStore("main-key"));
      expect(() => loadAuthProfileStoreForSecretsRuntime(agentDir)).toThrow(
        "Auth profile store is unreadable or contains invalid JSON.",
      );
    });
  });

  it("leaves the active last-good runtime store untouched after strict load failure", () => {
    withStrictAuthLayout(({ agentDir, mainDir, oauthPath }) => {
      const lastGoodStore = validApiKeyStore("last-good-key");
      replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store: lastGoodStore }]);
      try {
        const agentAuthPath = path.join(agentDir, "auth-profiles.json");
        const mainAuthPath = path.join(mainDir, "auth-profiles.json");
        const legacyPath = path.join(agentDir, "auth.json");
        const expectLastGoodPreserved = () => {
          expect(ensureAuthProfileStore(agentDir).profiles["openai:default"]).toMatchObject({
            type: "api_key",
            provider: "openai",
            key: "last-good-key",
          });
        };

        fs.writeFileSync(agentAuthPath, "{not-json\n", "utf8");
        expect(() => loadAuthProfileStoreForSecretsRuntime(agentDir)).toThrow(
          "Auth profile store is unreadable or contains invalid JSON.",
        );
        expectLastGoodPreserved();

        writeJson(agentAuthPath, validApiKeyStore("candidate-key"));
        fs.writeFileSync(mainAuthPath, "{not-json\n", "utf8");
        expect(() => loadAuthProfileStoreForSecretsRuntime(agentDir)).toThrow(
          "Auth profile store is unreadable or contains invalid JSON.",
        );
        expectLastGoodPreserved();

        fs.rmSync(agentAuthPath, { force: true });
        fs.rmSync(mainAuthPath, { force: true });
        writeJson(legacyPath, { broken: { type: "token", provider: "broken" } });
        expect(() => loadAuthProfileStoreForSecretsRuntime(agentDir)).toThrow(
          "Legacy auth profile store has an invalid structure or credential entry.",
        );
        expectLastGoodPreserved();

        fs.rmSync(legacyPath, { force: true });
        writeJson(oauthPath, {
          broken: { access: "access", refresh: 42, expires: Date.now() + 60_000 },
        });
        expect(() => loadAuthProfileStoreForSecretsRuntime(agentDir)).toThrow(
          "OAuth credential store has an invalid credential entry.",
        );
        expectLastGoodPreserved();
      } finally {
        clearRuntimeAuthProfileStoreSnapshots();
      }
    });
  });

  it("migrates legacy auth.json and deletes it (PR #368)", () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "fased-auth-profiles-"));
    try {
      const legacyPath = path.join(agentDir, "auth.json");
      fs.writeFileSync(
        legacyPath,
        `${JSON.stringify(
          {
            anthropic: {
              type: "oauth",
              provider: "anthropic",
              access: "access-token",
              refresh: "refresh-token",
              expires: Date.now() + 60_000,
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const store = ensureAuthProfileStore(agentDir);
      expect(store.profiles["anthropic:default"]).toMatchObject({
        type: "oauth",
        provider: "anthropic",
      });

      const migratedPath = path.join(agentDir, "auth-profiles.json");
      expect(fs.existsSync(migratedPath)).toBe(true);
      expect(fs.existsSync(legacyPath)).toBe(false);

      // idempotent
      const store2 = ensureAuthProfileStore(agentDir);
      expect(store2.profiles["anthropic:default"]).toBeDefined();
      expect(fs.existsSync(legacyPath)).toBe(false);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("merges main auth profiles into agent store and keeps agent overrides", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-auth-merge-"));
    const previousAgentDir = process.env.FASED_AGENT_DIR;
    const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
      const mainDir = path.join(root, "main-agent");
      const agentDir = path.join(root, "agent-x");
      fs.mkdirSync(mainDir, { recursive: true });
      fs.mkdirSync(agentDir, { recursive: true });

      process.env.FASED_AGENT_DIR = mainDir;
      process.env.PI_CODING_AGENT_DIR = mainDir;

      const mainStore = {
        version: AUTH_STORE_VERSION,
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            key: "main-key",
          },
          "anthropic:default": {
            type: "api_key",
            provider: "anthropic",
            key: "main-anthropic-key",
          },
        },
      };
      fs.writeFileSync(
        path.join(mainDir, "auth-profiles.json"),
        `${JSON.stringify(mainStore, null, 2)}\n`,
        "utf8",
      );

      const agentStore = {
        version: AUTH_STORE_VERSION,
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            key: "agent-key",
          },
        },
      };
      fs.writeFileSync(
        path.join(agentDir, "auth-profiles.json"),
        `${JSON.stringify(agentStore, null, 2)}\n`,
        "utf8",
      );

      const store = ensureAuthProfileStore(agentDir);
      expect(store.profiles["anthropic:default"]).toMatchObject({
        type: "api_key",
        provider: "anthropic",
        key: "main-anthropic-key",
      });
      expect(store.profiles["openai:default"]).toMatchObject({
        type: "api_key",
        provider: "openai",
        key: "agent-key",
      });
    } finally {
      if (previousAgentDir === undefined) {
        delete process.env.FASED_AGENT_DIR;
      } else {
        process.env.FASED_AGENT_DIR = previousAgentDir;
      }
      if (previousPiAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("normalizes auth-profiles credential aliases with canonical-field precedence", () => {
    const cases = [
      {
        name: "mode/apiKey aliases map to type/key",
        profile: {
          provider: "anthropic",
          mode: "api_key",
          apiKey: "sk-ant-alias",
        },
        expected: {
          type: "api_key",
          key: "sk-ant-alias",
        },
      },
      {
        name: "canonical type overrides conflicting mode alias",
        profile: {
          provider: "anthropic",
          type: "api_key",
          mode: "token",
          key: "sk-ant-canonical",
        },
        expected: {
          type: "api_key",
          key: "sk-ant-canonical",
        },
      },
      {
        name: "canonical key overrides conflicting apiKey alias",
        profile: {
          provider: "anthropic",
          type: "api_key",
          key: "sk-ant-canonical",
          apiKey: "sk-ant-alias",
        },
        expected: {
          type: "api_key",
          key: "sk-ant-canonical",
        },
      },
      {
        name: "canonical profile shape remains unchanged",
        profile: {
          provider: "anthropic",
          type: "api_key",
          key: "sk-ant-direct",
        },
        expected: {
          type: "api_key",
          key: "sk-ant-direct",
        },
      },
    ] as const;

    for (const testCase of cases) {
      const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "fased-auth-alias-"));
      try {
        const storeData = {
          version: AUTH_STORE_VERSION,
          profiles: {
            "anthropic:work": testCase.profile,
          },
        };
        fs.writeFileSync(
          path.join(agentDir, "auth-profiles.json"),
          `${JSON.stringify(storeData, null, 2)}\n`,
          "utf8",
        );

        const store = ensureAuthProfileStore(agentDir);
        expect(store.profiles["anthropic:work"], testCase.name).toMatchObject(testCase.expected);
      } finally {
        fs.rmSync(agentDir, { recursive: true, force: true });
      }
    }
  });

  it("normalizes mode/apiKey aliases while migrating legacy auth.json", () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "fased-auth-legacy-alias-"));
    try {
      fs.writeFileSync(
        path.join(agentDir, "auth.json"),
        `${JSON.stringify(
          {
            anthropic: {
              provider: "anthropic",
              mode: "api_key",
              apiKey: "sk-ant-legacy",
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const store = ensureAuthProfileStore(agentDir);
      expect(store.profiles["anthropic:default"]).toMatchObject({
        type: "api_key",
        provider: "anthropic",
        key: "sk-ant-legacy",
      });
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("logs one warning with aggregated reasons for rejected auth-profiles entries", () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "fased-auth-invalid-"));
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      const invalidStore = {
        version: AUTH_STORE_VERSION,
        profiles: {
          "anthropic:missing-type": {
            provider: "anthropic",
          },
          "openai:missing-provider": {
            type: "api_key",
            key: "sk-openai",
          },
          "qwen:not-object": "broken",
        },
      };
      fs.writeFileSync(
        path.join(agentDir, "auth-profiles.json"),
        `${JSON.stringify(invalidStore, null, 2)}\n`,
        "utf8",
      );

      const store = ensureAuthProfileStore(agentDir);
      expect(store.profiles).toEqual({});
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        "ignored invalid auth profile entries during store load",
        {
          source: "auth-profiles.json",
          dropped: 3,
          reasons: {
            invalid_type: 1,
            missing_provider: 1,
            non_object: 1,
          },
          keys: ["anthropic:missing-type", "openai:missing-provider", "qwen:not-object"],
        },
      );
    } finally {
      warnSpy.mockRestore();
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
