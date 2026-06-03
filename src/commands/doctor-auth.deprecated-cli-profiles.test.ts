import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";
import { captureEnv } from "../test-utils/env.js";
import { maybeRemoveDeprecatedCliAuthProfiles } from "./doctor-auth.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

let envSnapshot: ReturnType<typeof captureEnv>;
let tempAgentDir: string | undefined;

function makePrompter(confirmValue: boolean): DoctorPrompter {
  return {
    confirm: vi.fn().mockResolvedValue(confirmValue),
    confirmRepair: vi.fn().mockResolvedValue(confirmValue),
    confirmAggressive: vi.fn().mockResolvedValue(confirmValue),
    confirmSkipInNonInteractive: vi.fn().mockResolvedValue(confirmValue),
    select: vi.fn().mockResolvedValue(""),
    shouldRepair: confirmValue,
    shouldForce: false,
  };
}

beforeEach(() => {
  envSnapshot = captureEnv(["FASED_AGENT_DIR", "PI_CODING_AGENT_DIR"]);
  tempAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "fased-auth-"));
  process.env.FASED_AGENT_DIR = tempAgentDir;
  process.env.PI_CODING_AGENT_DIR = tempAgentDir;
});

afterEach(() => {
  envSnapshot.restore();
  if (tempAgentDir) {
    fs.rmSync(tempAgentDir, { recursive: true, force: true });
    tempAgentDir = undefined;
  }
});

describe("maybeRemoveDeprecatedCliAuthProfiles", () => {
  it("keeps normal OpenAI sign-in profiles", async () => {
    if (!tempAgentDir) {
      throw new Error("Missing temp agent dir");
    }
    const authPath = path.join(tempAgentDir, "auth-profiles.json");
    fs.writeFileSync(
      authPath,
      `${JSON.stringify(
        {
          version: 1,
          profiles: {
            "openai-codex:default": {
              type: "oauth",
              provider: "openai-codex",
              access: "token-b",
              refresh: "token-r2",
              expires: Date.now() + 60_000,
            },
          },
          order: {
            "openai-codex": ["openai-codex:default"],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const cfg = {
      auth: {
        profiles: {
          "openai-codex:default": { provider: "openai-codex", mode: "oauth" },
        },
        order: {
          "openai-codex": ["openai-codex:default"],
        },
      },
      agents: {
        defaults: {
          model: { primary: "openai-codex/gpt-5.3-codex" },
        },
      },
    } as const;

    const next = await maybeRemoveDeprecatedCliAuthProfiles(
      cfg as unknown as FasedAgentConfig,
      makePrompter(true),
    );

    const raw = JSON.parse(fs.readFileSync(authPath, "utf8")) as {
      profiles?: Record<string, unknown>;
      order?: Record<string, string[]>;
    };
    expect(raw.profiles?.["openai-codex:default"]).toBeTruthy();
    expect(raw.order?.["openai-codex"]).toEqual(["openai-codex:default"]);
    expect(next.auth?.profiles?.["openai-codex:default"]).toEqual({
      provider: "openai-codex",
      mode: "oauth",
    });
    expect(next.auth?.order?.["openai-codex"]).toEqual(["openai-codex:default"]);
    expect(next.agents?.defaults?.model).toEqual({
      primary: "openai-codex/gpt-5.3-codex",
    });
  });

  it("removes deprecated CLI auth profiles from store + config", async () => {
    if (!tempAgentDir) {
      throw new Error("Missing temp agent dir");
    }
    const authPath = path.join(tempAgentDir, "auth-profiles.json");
    fs.writeFileSync(
      authPath,
      `${JSON.stringify(
        {
          version: 1,
          profiles: {
            "anthropic:claude-cli": {
              type: "oauth",
              provider: "anthropic",
              access: "token-a",
              refresh: "token-r",
              expires: Date.now() + 60_000,
            },
            "openai-codex:codex-cli": {
              type: "oauth",
              provider: "openai-codex",
              access: "token-b",
              refresh: "token-r2",
              expires: Date.now() + 60_000,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const cfg = {
      auth: {
        profiles: {
          "anthropic:claude-cli": { provider: "anthropic", mode: "oauth" },
          "openai-codex:codex-cli": { provider: "openai-codex", mode: "oauth" },
        },
        order: {
          anthropic: ["anthropic:claude-cli"],
          "openai-codex": ["openai-codex:codex-cli"],
        },
      },
    } as const;

    const next = await maybeRemoveDeprecatedCliAuthProfiles(
      cfg as unknown as FasedAgentConfig,
      makePrompter(true),
    );

    const raw = JSON.parse(fs.readFileSync(authPath, "utf8")) as {
      profiles?: Record<string, unknown>;
    };
    expect(raw.profiles?.["anthropic:claude-cli"]).toBeUndefined();
    expect(raw.profiles?.["openai-codex:codex-cli"]).toBeUndefined();

    expect(next.auth?.profiles?.["anthropic:claude-cli"]).toBeUndefined();
    expect(next.auth?.profiles?.["openai-codex:codex-cli"]).toBeUndefined();
    expect(next.auth?.order?.anthropic).toBeUndefined();
    expect(next.auth?.order?.["openai-codex"]).toBeUndefined();
  });
});
