import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";
import {
  autoMigrateLegacyStateDir,
  autoMigrateLegacyState,
  detectLegacyStateMigrations,
  resetAutoMigrateLegacyStateDirForTest,
  resetAutoMigrateLegacyStateForTest,
  runLegacyStateMigrations,
} from "./doctor-state-migrations.js";

let tempRoot: string | null = null;

async function makeTempRoot() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "fased-doctor-"));
  tempRoot = root;
  return root;
}

afterEach(async () => {
  resetAutoMigrateLegacyStateForTest();
  resetAutoMigrateLegacyStateDirForTest();
  if (!tempRoot) {
    return;
  }
  await fs.promises.rm(tempRoot, { recursive: true, force: true });
  tempRoot = null;
});

function writeJson5(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function writeLegacySessionsFixture(params: {
  root: string;
  sessions: Record<string, { sessionId: string; updatedAt: number }>;
  transcripts?: Record<string, string>;
}) {
  const legacySessionsDir = path.join(params.root, "sessions");
  fs.mkdirSync(legacySessionsDir, { recursive: true });
  writeJson5(path.join(legacySessionsDir, "sessions.json"), params.sessions);
  for (const [fileName, content] of Object.entries(params.transcripts ?? {})) {
    fs.writeFileSync(path.join(legacySessionsDir, fileName), content, "utf-8");
  }
  return legacySessionsDir;
}

async function detectAndRunMigrations(params: {
  root: string;
  cfg: FasedAgentConfig;
  now?: () => number;
}) {
  const detected = await detectLegacyStateMigrations({
    cfg: params.cfg,
    env: { FASED_STATE_DIR: params.root } as NodeJS.ProcessEnv,
  });
  await runLegacyStateMigrations({ detected, now: params.now });
}

function readSessionsStore(targetDir: string) {
  return JSON.parse(fs.readFileSync(path.join(targetDir, "sessions.json"), "utf-8")) as Record<
    string,
    { sessionId: string }
  >;
}

async function runAndReadSessionsStore(params: {
  root: string;
  cfg: FasedAgentConfig;
  targetDir: string;
  now?: () => number;
}) {
  await detectAndRunMigrations({
    root: params.root,
    cfg: params.cfg,
    now: params.now,
  });
  return readSessionsStore(params.targetDir);
}

async function runStateDirMigration(root: string, env = {} as NodeJS.ProcessEnv) {
  return autoMigrateLegacyStateDir({
    env,
    homedir: () => root,
  });
}

async function runAutoMigrateLegacyStateWithLog(params: {
  root: string;
  cfg: FasedAgentConfig;
  now?: () => number;
}) {
  const log = { info: vi.fn(), warn: vi.fn() };
  const result = await autoMigrateLegacyState({
    cfg: params.cfg,
    env: { FASED_STATE_DIR: params.root } as NodeJS.ProcessEnv,
    log,
    now: params.now,
  });
  return { result, log };
}

describe("doctor legacy state migrations", () => {
  it("migrates legacy sessions into agents/<id>/sessions", async () => {
    const root = await makeTempRoot();
    const cfg: FasedAgentConfig = {};
    const legacySessionsDir = writeLegacySessionsFixture({
      root,
      sessions: {
        "+1555": { sessionId: "a", updatedAt: 10 },
        "+1666": { sessionId: "b", updatedAt: 20 },
        "slack:channel:C123": { sessionId: "c", updatedAt: 30 },
        "group:abc": { sessionId: "d", updatedAt: 40 },
        "subagent:xyz": { sessionId: "e", updatedAt: 50 },
      },
      transcripts: {
        "a.jsonl": "a",
        "b.jsonl": "b",
      },
    });

    const detected = await detectLegacyStateMigrations({
      cfg,
      env: { FASED_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    const result = await runLegacyStateMigrations({
      detected,
      now: () => 123,
    });

    expect(result.warnings).toEqual([]);
    const targetDir = path.join(root, "agents", "main", "sessions");
    expect(fs.existsSync(path.join(targetDir, "a.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, "b.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(legacySessionsDir, "a.jsonl"))).toBe(false);

    const store = JSON.parse(
      fs.readFileSync(path.join(targetDir, "sessions.json"), "utf-8"),
    ) as Record<string, { sessionId: string }>;
    expect(store["agent:main:main"]?.sessionId).toBe("b");
    expect(store["agent:main:+1555"]?.sessionId).toBe("a");
    expect(store["agent:main:+1666"]?.sessionId).toBe("b");
    expect(store["+1555"]).toBeUndefined();
    expect(store["+1666"]).toBeUndefined();
    expect(store["agent:main:slack:channel:c123"]?.sessionId).toBe("c");
    expect(store["agent:main:unknown:group:abc"]?.sessionId).toBe("d");
    expect(store["agent:main:subagent:xyz"]?.sessionId).toBe("e");
  });

  it("migrates legacy agent dir with conflict fallback", async () => {
    const root = await makeTempRoot();
    const cfg: FasedAgentConfig = {};

    const legacyAgentDir = path.join(root, "agent");
    fs.mkdirSync(legacyAgentDir, { recursive: true });
    fs.writeFileSync(path.join(legacyAgentDir, "foo.txt"), "legacy", "utf-8");
    fs.writeFileSync(path.join(legacyAgentDir, "baz.txt"), "legacy2", "utf-8");

    const targetAgentDir = path.join(root, "agents", "main", "agent");
    fs.mkdirSync(targetAgentDir, { recursive: true });
    fs.writeFileSync(path.join(targetAgentDir, "foo.txt"), "new", "utf-8");

    const detected = await detectLegacyStateMigrations({
      cfg,
      env: { FASED_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    await runLegacyStateMigrations({ detected, now: () => 123 });

    expect(fs.readFileSync(path.join(targetAgentDir, "baz.txt"), "utf-8")).toBe("legacy2");
    const backupDir = path.join(root, "agents", "main", "agent.legacy-123");
    expect(fs.existsSync(path.join(backupDir, "foo.txt"))).toBe(true);
  });

  it("auto-migrates legacy agent dir on startup", async () => {
    const root = await makeTempRoot();
    const cfg: FasedAgentConfig = {};

    const legacyAgentDir = path.join(root, "agent");
    fs.mkdirSync(legacyAgentDir, { recursive: true });
    fs.writeFileSync(path.join(legacyAgentDir, "auth.json"), "{}", "utf-8");

    const { result, log } = await runAutoMigrateLegacyStateWithLog({ root, cfg });

    const targetAgentDir = path.join(root, "agents", "main", "agent");
    expect(fs.existsSync(path.join(targetAgentDir, "auth.json"))).toBe(true);
    expect(result.migrated).toBe(true);
    expect(log.info).toHaveBeenCalled();
  });

  it("auto-migrates legacy sessions on startup", async () => {
    const root = await makeTempRoot();
    const cfg: FasedAgentConfig = {};
    const legacySessionsDir = writeLegacySessionsFixture({
      root,
      sessions: {
        "+1555": { sessionId: "a", updatedAt: 10 },
      },
      transcripts: {
        "a.jsonl": "a",
      },
    });

    const { result, log } = await runAutoMigrateLegacyStateWithLog({
      root,
      cfg,
      now: () => 123,
    });

    expect(result.migrated).toBe(true);
    expect(log.info).toHaveBeenCalled();

    const targetDir = path.join(root, "agents", "main", "sessions");
    expect(fs.existsSync(path.join(targetDir, "a.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(legacySessionsDir, "a.jsonl"))).toBe(false);
    expect(fs.existsSync(path.join(targetDir, "sessions.json"))).toBe(true);
  });

  it("migrates legacy WhatsApp auth files without touching oauth.json", async () => {
    const root = await makeTempRoot();
    const cfg: FasedAgentConfig = {};

    const oauthDir = path.join(root, "credentials");
    fs.mkdirSync(oauthDir, { recursive: true });
    fs.writeFileSync(path.join(oauthDir, "oauth.json"), "{}", "utf-8");
    fs.writeFileSync(path.join(oauthDir, "creds.json"), "{}", "utf-8");
    fs.writeFileSync(path.join(oauthDir, "session-abc.json"), "{}", "utf-8");

    const detected = await detectLegacyStateMigrations({
      cfg,
      env: { FASED_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    await runLegacyStateMigrations({ detected, now: () => 123 });

    const target = path.join(oauthDir, "whatsapp", "default");
    expect(fs.existsSync(path.join(target, "creds.json"))).toBe(true);
    expect(fs.existsSync(path.join(target, "session-abc.json"))).toBe(true);
    expect(fs.existsSync(path.join(oauthDir, "oauth.json"))).toBe(true);
    expect(fs.existsSync(path.join(oauthDir, "creds.json"))).toBe(false);
  });

  it("migrates legacy Telegram pairing allowFrom store to account-scoped default file", async () => {
    const root = await makeTempRoot();
    const cfg: FasedAgentConfig = {};

    const oauthDir = path.join(root, "credentials");
    fs.mkdirSync(oauthDir, { recursive: true });
    fs.writeFileSync(
      path.join(oauthDir, "telegram-allowFrom.json"),
      JSON.stringify(
        {
          version: 1,
          allowFrom: ["123456"],
        },
        null,
        2,
      ) + "\n",
      "utf-8",
    );

    const detected = await detectLegacyStateMigrations({
      cfg,
      env: { FASED_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    expect(detected.pairingAllowFrom.hasLegacyTelegram).toBe(true);

    const result = await runLegacyStateMigrations({ detected, now: () => 123 });
    expect(result.warnings).toEqual([]);

    const target = path.join(oauthDir, "telegram-default-allowFrom.json");
    expect(fs.existsSync(target)).toBe(true);
    expect(JSON.parse(fs.readFileSync(target, "utf-8"))).toEqual({
      version: 1,
      allowFrom: ["123456"],
    });
  });

  it("no-ops when nothing detected", async () => {
    const root = await makeTempRoot();
    const cfg: FasedAgentConfig = {};
    const detected = await detectLegacyStateMigrations({
      cfg,
      env: { FASED_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    const result = await runLegacyStateMigrations({ detected });
    expect(result.changes).toEqual([]);
  });

  it("routes legacy state to the default agent entry", async () => {
    const root = await makeTempRoot();
    const cfg: FasedAgentConfig = {
      agents: { list: [{ id: "alpha", default: true }] },
    };
    writeLegacySessionsFixture({
      root,
      sessions: {
        "+1555": { sessionId: "a", updatedAt: 10 },
      },
    });

    const targetDir = path.join(root, "agents", "alpha", "sessions");
    const store = await runAndReadSessionsStore({
      root,
      cfg,
      targetDir,
      now: () => 123,
    });
    expect(store["agent:alpha:main"]?.sessionId).toBe("a");
  });

  it("honors session.mainKey when seeding the direct-chat bucket", async () => {
    const root = await makeTempRoot();
    const cfg: FasedAgentConfig = { session: { mainKey: "work" } };
    writeLegacySessionsFixture({
      root,
      sessions: {
        "+1555": { sessionId: "a", updatedAt: 10 },
        "+1666": { sessionId: "b", updatedAt: 20 },
      },
    });

    const targetDir = path.join(root, "agents", "main", "sessions");
    const store = await runAndReadSessionsStore({
      root,
      cfg,
      targetDir,
      now: () => 123,
    });
    expect(store["agent:main:work"]?.sessionId).toBe("b");
    expect(store["agent:main:main"]).toBeUndefined();
  });

  it("canonicalizes legacy main keys inside the target sessions store", async () => {
    const root = await makeTempRoot();
    const cfg: FasedAgentConfig = {};
    const targetDir = path.join(root, "agents", "main", "sessions");
    writeJson5(path.join(targetDir, "sessions.json"), {
      main: { sessionId: "legacy", updatedAt: 10 },
      "agent:main:main": { sessionId: "fresh", updatedAt: 20 },
    });

    const store = await runAndReadSessionsStore({
      root,
      cfg,
      targetDir,
      now: () => 123,
    });
    expect(store["main"]).toBeUndefined();
    expect(store["agent:main:main"]?.sessionId).toBe("fresh");
  });

  it("prefers the newest entry when collapsing main aliases", async () => {
    const root = await makeTempRoot();
    const cfg: FasedAgentConfig = { session: { mainKey: "work" } };
    const targetDir = path.join(root, "agents", "main", "sessions");
    writeJson5(path.join(targetDir, "sessions.json"), {
      "agent:main:main": { sessionId: "legacy", updatedAt: 50 },
      "agent:main:work": { sessionId: "canonical", updatedAt: 10 },
    });

    const store = await runAndReadSessionsStore({
      root,
      cfg,
      targetDir,
      now: () => 123,
    });
    expect(store["agent:main:work"]?.sessionId).toBe("legacy");
    expect(store["agent:main:main"]).toBeUndefined();
  });

  it("lowercases agent session keys during canonicalization", async () => {
    const root = await makeTempRoot();
    const cfg: FasedAgentConfig = {};
    const targetDir = path.join(root, "agents", "main", "sessions");
    writeJson5(path.join(targetDir, "sessions.json"), {
      "agent:main:slack:channel:C123": { sessionId: "legacy", updatedAt: 10 },
    });

    const store = await runAndReadSessionsStore({
      root,
      cfg,
      targetDir,
      now: () => 123,
    });
    expect(store["agent:main:slack:channel:c123"]?.sessionId).toBe("legacy");
    expect(store["agent:main:slack:channel:C123"]).toBeUndefined();
  });

  it("auto-migrates when only target sessions contain legacy keys", async () => {
    const root = await makeTempRoot();
    const cfg: FasedAgentConfig = {};
    const targetDir = path.join(root, "agents", "main", "sessions");
    writeJson5(path.join(targetDir, "sessions.json"), {
      main: { sessionId: "legacy", updatedAt: 10 },
    });

    const { result, log } = await runAutoMigrateLegacyStateWithLog({ root, cfg });

    const store = JSON.parse(
      fs.readFileSync(path.join(targetDir, "sessions.json"), "utf-8"),
    ) as Record<string, { sessionId: string }>;
    expect(result.migrated).toBe(true);
    expect(log.info).toHaveBeenCalled();
    expect(store["main"]).toBeUndefined();
    expect(store["agent:main:main"]?.sessionId).toBe("legacy");
  });

  it("does nothing when no legacy state dir exists", async () => {
    const root = await makeTempRoot();
    const result = await runStateDirMigration(root);

    expect(result.migrated).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.warnings).toHaveLength(0);
  });
});
