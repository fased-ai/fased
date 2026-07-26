import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";
import { resolveStorePath, resolveSessionTranscriptsDirForAgent } from "../config/sessions.js";
import { note } from "../terminal/note.js";
import { noteStateIntegrity } from "./doctor-state-integrity.js";

vi.mock("../terminal/note.js", () => ({
  note: vi.fn(),
}));

type EnvSnapshot = {
  HOME?: string;
  FASED_HOME?: string;
  FASED_STATE_DIR?: string;
  FASED_OAUTH_DIR?: string;
  FASED_HOST_PROFILE?: string;
};

function captureEnv(): EnvSnapshot {
  return {
    HOME: process.env.HOME,
    FASED_HOME: process.env.FASED_HOME,
    FASED_STATE_DIR: process.env.FASED_STATE_DIR,
    FASED_OAUTH_DIR: process.env.FASED_OAUTH_DIR,
    FASED_HOST_PROFILE: process.env.FASED_HOST_PROFILE,
  };
}

function restoreEnv(snapshot: EnvSnapshot) {
  for (const key of Object.keys(snapshot) as Array<keyof EnvSnapshot>) {
    const value = snapshot[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function setupSessionState(cfg: FasedAgentConfig, env: NodeJS.ProcessEnv, homeDir: string) {
  const agentId = "main";
  const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId, env, () => homeDir);
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
}

function stateIntegrityText(): string {
  return vi
    .mocked(note)
    .mock.calls.filter((call) => call[1] === "State integrity")
    .map((call) => String(call[0]))
    .join("\n");
}

const OAUTH_PROMPT_MATCHER = expect.objectContaining({
  message: expect.stringContaining("Create OAuth dir at"),
});

async function runStateIntegrity(cfg: FasedAgentConfig) {
  setupSessionState(cfg, process.env, process.env.HOME ?? "");
  const confirmSkipInNonInteractive = vi.fn(async () => false);
  await noteStateIntegrity(cfg, { confirmSkipInNonInteractive });
  return confirmSkipInNonInteractive;
}

describe("doctor state integrity oauth dir checks", () => {
  let envSnapshot: EnvSnapshot;
  let tempHome = "";

  beforeEach(() => {
    envSnapshot = captureEnv();
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "fased-doctor-state-integrity-"));
    process.env.HOME = tempHome;
    process.env.FASED_HOME = tempHome;
    process.env.FASED_STATE_DIR = path.join(tempHome, ".fased");
    delete process.env.FASED_OAUTH_DIR;
    delete process.env.FASED_HOST_PROFILE;
    fs.mkdirSync(process.env.FASED_STATE_DIR, { recursive: true, mode: 0o700 });
    vi.mocked(note).mockClear();
  });

  afterEach(() => {
    restoreEnv(envSnapshot);
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("does not prompt for oauth dir when no whatsapp/pairing config is active", async () => {
    const cfg: FasedAgentConfig = {};
    const confirmSkipInNonInteractive = await runStateIntegrity(cfg);
    expect(confirmSkipInNonInteractive).not.toHaveBeenCalledWith(OAUTH_PROMPT_MATCHER);
    const text = stateIntegrityText();
    expect(text).toContain("OAuth dir not present");
    expect(text).not.toContain("CRITICAL: OAuth dir missing");
  });

  it("prompts for oauth dir when whatsapp is configured", async () => {
    const cfg: FasedAgentConfig = {
      channels: {
        whatsapp: {},
      },
    };
    const confirmSkipInNonInteractive = await runStateIntegrity(cfg);
    expect(confirmSkipInNonInteractive).toHaveBeenCalledWith(OAUTH_PROMPT_MATCHER);
    expect(stateIntegrityText()).toContain("CRITICAL: OAuth dir missing");
  });

  it("prompts for oauth dir when a channel dmPolicy is pairing", async () => {
    const cfg: FasedAgentConfig = {
      channels: {
        telegram: {
          dmPolicy: "pairing",
        },
      },
    };
    const confirmSkipInNonInteractive = await runStateIntegrity(cfg);
    expect(confirmSkipInNonInteractive).toHaveBeenCalledWith(OAUTH_PROMPT_MATCHER);
  });

  it("prompts for oauth dir when FASED_OAUTH_DIR is explicitly configured", async () => {
    process.env.FASED_OAUTH_DIR = path.join(tempHome, ".oauth");
    const cfg: FasedAgentConfig = {};
    const confirmSkipInNonInteractive = await runStateIntegrity(cfg);
    expect(confirmSkipInNonInteractive).toHaveBeenCalledWith(OAUTH_PROMPT_MATCHER);
    expect(stateIntegrityText()).toContain("CRITICAL: OAuth dir missing");
  });

  it("accepts shared Hosting permissions from the persisted Hosting runtime", async () => {
    const configPath = path.join(process.env.FASED_STATE_DIR ?? "", "fased.json");
    fs.chmodSync(process.env.FASED_STATE_DIR ?? "", 0o2770);
    fs.writeFileSync(configPath, "{}\n", { mode: 0o660 });
    fs.chmodSync(configPath, 0o660);
    const cfg: FasedAgentConfig = {
      env: {
        vars: {
          FASED_WALLET_LOCAL_SIGNER_SOCKET: "/run/fased-signerd/app.sock",
        },
      },
    };

    setupSessionState(cfg, process.env, tempHome);
    await noteStateIntegrity(
      cfg,
      { confirmSkipInNonInteractive: vi.fn(async () => false) },
      configPath,
    );

    const text = stateIntegrityText();
    expect(text).not.toContain("State directory permissions are incorrect");
    expect(text).not.toContain("Config file permissions are incorrect");
  });

  it("detects orphan transcripts and offers archival remediation", async () => {
    const cfg: FasedAgentConfig = {};
    setupSessionState(cfg, process.env, process.env.HOME ?? "");
    const sessionsDir = resolveSessionTranscriptsDirForAgent("main", process.env, () => tempHome);
    fs.writeFileSync(path.join(sessionsDir, "orphan-session.jsonl"), '{"type":"session"}\n');
    const confirmSkipInNonInteractive = vi.fn(async (params: { message: string }) =>
      params.message.includes("orphan transcript file"),
    );
    await noteStateIntegrity(cfg, { confirmSkipInNonInteractive });
    expect(stateIntegrityText()).toContain("orphan transcript file");
    expect(confirmSkipInNonInteractive).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("orphan transcript file"),
      }),
    );
    const files = fs.readdirSync(sessionsDir);
    expect(files.some((name) => name.startsWith("orphan-session.jsonl.deleted."))).toBe(true);
  });

  it("prints fased-only verification hints when recent sessions are missing transcripts", async () => {
    const cfg: FasedAgentConfig = {};
    setupSessionState(cfg, process.env, process.env.HOME ?? "");
    const storePath = resolveStorePath(cfg.session?.store, { agentId: "main" });
    fs.writeFileSync(
      storePath,
      JSON.stringify(
        {
          "agent:main:main": {
            sessionId: "missing-transcript",
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
    );

    await noteStateIntegrity(cfg, { confirmSkipInNonInteractive: vi.fn(async () => false) });

    const text = stateIntegrityText();
    expect(text).toContain("recent sessions are missing transcripts");
    expect(text).toMatch(/fased sessions --store ".*sessions\.json"/);
    expect(text).toContain("fased doctor --fix");
    expect(text).toContain("cannot be reconstructed");
    expect(text).not.toContain("--active");
    expect(text).not.toContain(" ls ");
  });

  it("repairs missing transcript headers without deleting session metadata", async () => {
    const cfg: FasedAgentConfig = {};
    setupSessionState(cfg, process.env, process.env.HOME ?? "");
    const storePath = resolveStorePath(cfg.session?.store, { agentId: "main" });
    const sessionsDir = resolveSessionTranscriptsDirForAgent("main", process.env, () => tempHome);
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        "agent:main:main": { sessionId: "repair-me", updatedAt: Date.now() },
      }),
    );
    const confirmSkipInNonInteractive = vi.fn(async () => false);

    await noteStateIntegrity(cfg, { shouldRepair: true, confirmSkipInNonInteractive });

    const transcriptPath = path.join(sessionsDir, "repair-me.jsonl");
    expect(fs.existsSync(transcriptPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(transcriptPath, "utf8").trim())).toMatchObject({
      type: "session",
      id: "repair-me",
    });
    expect(JSON.parse(fs.readFileSync(storePath, "utf8"))).toHaveProperty(
      "agent:main:main.sessionId",
      "repair-me",
    );
    expect(confirmSkipInNonInteractive).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Recreate missing") }),
    );
  });

  it("ignores slash-routing sessions for recent missing transcript warnings", async () => {
    const cfg: FasedAgentConfig = {};
    setupSessionState(cfg, process.env, process.env.HOME ?? "");
    const storePath = resolveStorePath(cfg.session?.store, { agentId: "main" });
    fs.writeFileSync(
      storePath,
      JSON.stringify(
        {
          "agent:main:telegram:slash:6790081233": {
            sessionId: "missing-slash-transcript",
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
    );

    await noteStateIntegrity(cfg, { confirmSkipInNonInteractive: vi.fn(async () => false) });

    const text = stateIntegrityText();
    expect(text).not.toContain("recent sessions are missing transcripts");
  });
});
