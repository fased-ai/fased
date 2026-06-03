import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";
import { loadAndMaybeMigrateDoctorConfig } from "./doctor-config-flow.js";
import { runDoctorConfigWithInput } from "./doctor-config-flow.test-utils.js";
import {
  detectLegacyStateMigrations,
  resetAutoMigrateLegacyStateDirForTest,
  resetAutoMigrateLegacyStateForTest,
  runLegacyStateMigrations,
} from "./doctor-state-migrations.js";

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-doctor-config-session-"));
  tempRoots.push(root);
  return root;
}

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

afterEach(() => {
  resetAutoMigrateLegacyStateForTest();
  resetAutoMigrateLegacyStateDirForTest();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("Lane 6 doctor config/session migration audit", () => {
  it("preserves Fased-owned wallet, federation, and mining config during doctor repair", async () => {
    const walletConfig = {
      provider: { id: "local-socket-signer" },
      execution: { mode: "manual" },
      approvalAuth: { mode: "none" },
      runtime: {
        enabled: true,
        mode: "external",
        runtime: "external-custom",
        external: { kind: "custom" },
        auth: { mode: "static-token-compat" },
        chains: ["solana"],
        service: { host: "127.0.0.1", port: 18798 },
        policy: {
          capsEnabled: true,
          directSigning: false,
          solana: {
            allowPrograms: ["11111111111111111111111111111111"],
            maxPerTx: "100000000",
            maxDaily: "1000000000",
          },
        },
        toolAccess: {
          mode: "allowlist",
          allowAgents: ["main"],
          allowSkills: ["sat-mining"],
        },
      },
    };
    const federationConfig = {
      bond: {
        walletId: "solana-operator",
      },
    };
    const satMiningEntry = {
      enabled: true,
      config: {
        network: "devnet",
        walletId: "solana-1",
        riskMode: "balanced",
      },
    };

    const result = await runDoctorConfigWithInput({
      repair: true,
      config: {
        bridge: { bind: "auto" },
        wallet: walletConfig,
        federation: federationConfig,
        plugins: {
          entries: {
            "sat-mining": satMiningEntry,
          },
        },
      },
      run: loadAndMaybeMigrateDoctorConfig,
    });

    const cfg = result.cfg as Record<string, unknown> & {
      wallet?: unknown;
      federation?: unknown;
      plugins?: { entries?: Record<string, unknown> };
    };
    expect(cfg.bridge).toBeUndefined();
    expect(cfg.wallet).toEqual(walletConfig);
    expect(cfg.federation).toEqual(federationConfig);
    expect(cfg.plugins?.entries?.["sat-mining"]).toEqual(satMiningEntry);
  });

  it("canonicalizes legacy session stores without adding compaction or wallet-routing side effects", async () => {
    const root = makeTempRoot();
    const sessionsDir = path.join(root, "sessions");
    const cfg: FasedAgentConfig = {
      session: {
        mainKey: "ops",
      },
    };

    writeJson(path.join(sessionsDir, "sessions.json"), {
      main: {
        sessionId: "direct-main",
        updatedAt: 10,
      },
      "telegram:chat:123": {
        sessionId: "telegram-session",
        updatedAt: 20,
      },
      "whatsapp:120@g.us": {
        sessionId: "whatsapp-session",
        updatedAt: 30,
        room: "ops-room",
      },
      "subagent:miner": {
        sessionId: "subagent-session",
        updatedAt: 40,
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

    const targetStorePath = path.join(root, "agents", "main", "sessions", "sessions.json");
    const store = readJson<Record<string, Record<string, unknown>>>(targetStorePath);
    expect(Object.keys(store).toSorted()).toEqual([
      "agent:main:ops",
      "agent:main:subagent:miner",
      "agent:main:telegram:chat:123",
      "agent:main:whatsapp:group:120@g.us",
    ]);
    expect(store["agent:main:ops"]?.sessionId).toBe("direct-main");
    expect(store["agent:main:whatsapp:group:120@g.us"]?.groupChannel).toBe("ops-room");
    expect(store["agent:main:whatsapp:group:120@g.us"]?.room).toBeUndefined();

    for (const entry of Object.values(store)) {
      expect(entry.compactionCheckpoints).toBeUndefined();
      expect(entry.compactionCheckpointIds).toBeUndefined();
      expect(entry.channelDeliveryTouched).toBeUndefined();
      expect(entry.walletActionRoutingTouched).toBeUndefined();
    }
  });
});
