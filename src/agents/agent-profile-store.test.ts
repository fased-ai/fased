import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentConfig } from "../config/types.agents.js";
import { createDenyAllCapitalPolicy } from "./agent-profile-contracts.js";
import {
  appendAgentProfileGeneration,
  ensureAgentProfileState,
  ensureAgentProfileStates,
  readActiveAgentProfile,
  readAgentProfileState,
} from "./agent-profile-store.js";
import { buildTemplateProfilePayloads } from "./persona-templates.js";

const roots: string[] = [];

function testEnv(): NodeJS.ProcessEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-agent-profiles-"));
  roots.push(root);
  return { FASED_STATE_DIR: root };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("Agent profile generations", () => {
  it("migrates one legacy Agent into four independent generation-one profiles", async () => {
    const env = testEnv();
    const config: AgentConfig = {
      id: "wally",
      name: "Wally",
      identity: { name: "Wally Prime" },
      taskModels: { strong: "openai/gpt-5", summarizer: "openai/gpt-5-mini" },
    };

    const state = await ensureAgentProfileState({
      agentId: "wally",
      config,
      env,
      now: new Date("2026-09-02T12:00:00.000Z"),
    });

    expect(state.agentId).toBe("wally");
    expect(readActiveAgentProfile(state, "persona").displayName).toBe("Wally Prime");
    expect(readActiveAgentProfile(state, "strategy").taskModelRoutes).toEqual({
      strong: "openai/gpt-5",
      summarizer: "openai/gpt-5-mini",
    });
    expect(readActiveAgentProfile(state, "capitalPolicy")).toEqual(createDenyAllCapitalPolicy());
    expect(Object.values(state.active).every((entry) => entry.generation === 1)).toBe(true);
    expect(new Set(Object.values(state.active).map((entry) => entry.digest)).size).toBe(4);

    const persisted = path.join(env.FASED_STATE_DIR ?? "", "agent-profiles", "profiles.v1.json");
    expect(fs.statSync(persisted).mode & 0o777).toBe(0o600);
  });

  it("is idempotent and never rewrites migration history from later config changes", async () => {
    const env = testEnv();
    const first = await ensureAgentProfileState({
      agentId: "wally",
      config: { id: "wally", name: "First" },
      env,
      now: new Date("2026-09-02T12:00:00.000Z"),
    });
    const second = await ensureAgentProfileState({
      agentId: "wally",
      config: { id: "wally", name: "Changed" },
      env,
      now: new Date("2026-09-03T12:00:00.000Z"),
    });

    expect(second).toEqual(first);
    expect(readActiveAgentProfile(second, "persona").displayName).toBe("First");
  });

  it("migrates multiple Agents atomically without sharing profile histories", async () => {
    const env = testEnv();
    const states = await ensureAgentProfileStates({
      agents: [
        { agentId: "alpha", config: { id: "alpha", name: "Alpha" }, source: "legacy-migration" },
        { agentId: "beta", config: { id: "beta", name: "Beta" }, source: "legacy-migration" },
      ],
      env,
      now: new Date("2026-09-02T12:00:00.000Z"),
    });

    const alpha = states.alpha;
    const beta = states.beta;
    if (!alpha || !beta) {
      throw new Error("missing migrated Agent profile state");
    }
    expect(readActiveAgentProfile(alpha, "persona").displayName).toBe("Alpha");
    expect(readActiveAgentProfile(beta, "persona").displayName).toBe("Beta");
    expect(alpha.active.persona.digest).not.toBe(beta.active.persona.digest);
  });

  it("appends only the selected profile and rejects stale writers", async () => {
    const env = testEnv();
    const initial = await ensureAgentProfileState({
      agentId: "wally",
      env,
      now: new Date("2026-09-02T12:00:00.000Z"),
    });
    const persona = readActiveAgentProfile(initial, "persona");
    const updated = await appendAgentProfileGeneration({
      agentId: "wally",
      kind: "persona",
      expectedGeneration: initial.active.persona.generation,
      expectedDigest: initial.active.persona.digest,
      payload: { ...persona, tone: "concise" },
      source: "owner",
      env,
      now: new Date("2026-09-02T13:00:00.000Z"),
    });

    expect(updated.history.persona).toHaveLength(2);
    expect(updated.history.persona[1]?.previousDigest).toBe(initial.active.persona.digest);
    expect(updated.history.research).toHaveLength(1);
    expect(updated.active.capitalPolicy).toEqual(initial.active.capitalPolicy);

    await expect(
      appendAgentProfileGeneration({
        agentId: "wally",
        kind: "persona",
        expectedGeneration: initial.active.persona.generation,
        expectedDigest: initial.active.persona.digest,
        payload: { ...persona, tone: "stale" },
        source: "owner",
        env,
      }),
    ).rejects.toThrow("generation changed");
  });

  it("fails closed when immutable profile history is modified", async () => {
    const env = testEnv();
    await ensureAgentProfileState({ agentId: "wally", env });
    const persisted = path.join(env.FASED_STATE_DIR ?? "", "agent-profiles", "profiles.v1.json");
    const parsed = JSON.parse(fs.readFileSync(persisted, "utf8")) as {
      agents: { wally: { history: { persona: Array<{ payload: { tone: string } }> } } };
    };
    parsed.agents.wally.history.persona[0].payload.tone = "tampered";
    fs.writeFileSync(persisted, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });

    expect(() => readAgentProfileState({ agentId: "wally", env })).toThrow(
      "Agent profile store is unreadable",
    );
    await expect(ensureAgentProfileState({ agentId: "wally", env })).rejects.toThrow(
      "refusing profile mutation",
    );
  });

  it("rejects authority hidden inside a deny-all policy", async () => {
    const env = testEnv();
    const initial = await ensureAgentProfileState({ agentId: "wally", env });
    await expect(
      appendAgentProfileGeneration({
        agentId: "wally",
        kind: "capitalPolicy",
        expectedGeneration: initial.active.capitalPolicy.generation,
        expectedDigest: initial.active.capitalPolicy.digest,
        payload: { ...createDenyAllCapitalPolicy(), allowedWalletIds: ["strategy"] },
        source: "owner",
        env,
      }),
    ).rejects.toThrow("deny-all CapitalPolicy cannot contain economic authority");
  });

  it("rejects noncanonical expiry timestamps and unknown persisted state fields", async () => {
    const env = testEnv();
    const initial = await ensureAgentProfileState({ agentId: "wally", env });
    await expect(
      appendAgentProfileGeneration({
        agentId: "wally",
        kind: "capitalPolicy",
        expectedGeneration: initial.active.capitalPolicy.generation,
        expectedDigest: initial.active.capitalPolicy.digest,
        payload: {
          ...createDenyAllCapitalPolicy(),
          expiresAt: "September 3, 2026",
        },
        source: "owner",
        env,
      }),
    ).rejects.toThrow("canonical ISO timestamp");

    const persisted = path.join(env.FASED_STATE_DIR ?? "", "agent-profiles", "profiles.v1.json");
    const parsed = JSON.parse(fs.readFileSync(persisted, "utf8")) as {
      agents: { wally: Record<string, unknown> };
    };
    parsed.agents.wally.unexpected = true;
    fs.writeFileSync(persisted, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
    expect(() => readAgentProfileState({ agentId: "wally", env })).toThrow(
      "Agent profile store is unreadable",
    );
  });

  it("accepts reviewed creation payloads but rejects creation-time financial authority", async () => {
    const env = testEnv();
    const initialPayloads = buildTemplateProfilePayloads({
      templateId: "mining-operator",
      displayName: "Wally",
    });
    const state = await ensureAgentProfileState({
      agentId: "wally",
      source: "creation",
      initialPayloads,
      env,
    });
    expect(readActiveAgentProfile(state, "strategy").capabilityPacks).toContain("miner");
    expect(readActiveAgentProfile(state, "capitalPolicy").mode).toBe("deny-all");

    await expect(
      ensureAgentProfileState({
        agentId: "trader",
        source: "creation",
        initialPayloads: {
          ...initialPayloads,
          capitalPolicy: {
            ...createDenyAllCapitalPolicy(),
            mode: "allowlisted",
            allowedWalletIds: ["strategy"],
          },
        },
        env,
      }),
    ).rejects.toThrow("must begin with deny-all financial authority");
  });
});
