import "./reply.directive.directive-behavior.e2e-mocks.js";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";
import {
  assertModelSelection,
  installDirectiveBehaviorE2EHooks,
  runEmbeddedPiAgent,
  withTempHome,
} from "./reply.directive.directive-behavior.e2e-harness.js";
import { getReplyFromConfig } from "./reply.js";

const TEST_MODEL_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function makeMoonshotConfig(home: string, storePath: string): FasedAgentConfig {
  return {
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-opus-4-5" },
        workspace: path.join(home, "fased"),
        models: {
          "anthropic/claude-opus-4-5": {},
          "moonshot/kimi-k2-0905-preview": {},
        },
      },
    },
    models: {
      mode: "merge",
      providers: {
        moonshot: {
          baseUrl: "https://api.moonshot.ai/v1",
          apiKey: "sk-test",
          api: "openai-completions",
          models: [{ id: "kimi-k2-0905-preview", name: "Kimi K2", cost: TEST_MODEL_COST }],
        },
      },
    },
    session: { store: storePath },
  };
}

describe("directive behavior", () => {
  installDirectiveBehaviorE2EHooks();

  it("supports fuzzy model matches on /model directive", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");

      const res = await getReplyFromConfig(
        { Body: "/model kimi", From: "+1222", To: "+1222", CommandAuthorized: true },
        {},
        makeMoonshotConfig(home, storePath),
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Model set to moonshot/kimi-k2-0905-preview.");
      assertModelSelection(storePath, {
        provider: "moonshot",
        model: "kimi-k2-0905-preview",
      });
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
  it("resolves provider-less exact model ids via fuzzy matching when unambiguous", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");

      const res = await getReplyFromConfig(
        {
          Body: "/model kimi-k2-0905-preview",
          From: "+1222",
          To: "+1222",
          CommandAuthorized: true,
        },
        {},
        makeMoonshotConfig(home, storePath),
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Model set to moonshot/kimi-k2-0905-preview.");
      assertModelSelection(storePath, {
        provider: "moonshot",
        model: "kimi-k2-0905-preview",
      });
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
  it("supports fuzzy matches within a provider on /model provider/model", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");

      const res = await getReplyFromConfig(
        { Body: "/model moonshot/kimi", From: "+1222", To: "+1222", CommandAuthorized: true },
        {},
        makeMoonshotConfig(home, storePath),
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Model set to moonshot/kimi-k2-0905-preview.");
      assertModelSelection(storePath, {
        provider: "moonshot",
        model: "kimi-k2-0905-preview",
      });
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
  it("picks the best fuzzy match when multiple models match", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");

      await getReplyFromConfig(
        { Body: "/model minimax", From: "+1222", To: "+1222", CommandAuthorized: true },
        {},
        {
          agents: {
            defaults: {
              model: { primary: "minimax/MiniMax-M2.1" },
              workspace: path.join(home, "fased"),
              models: {
                "minimax/MiniMax-M2.1": {},
                "minimax/MiniMax-M2.1-lightning": {},
                "lmstudio/minimax-m2.1-gs32": {},
              },
            },
          },
          models: {
            mode: "merge",
            providers: {
              minimax: {
                baseUrl: "https://api.minimax.io/anthropic",
                apiKey: "sk-test",
                api: "anthropic-messages",
                models: [{ id: "MiniMax-M2.1", name: "MiniMax M2.1", cost: TEST_MODEL_COST }],
              },
              lmstudio: {
                baseUrl: "http://127.0.0.1:1234/v1",
                apiKey: "lmstudio",
                api: "openai-responses",
                models: [
                  { id: "minimax-m2.1-gs32", name: "MiniMax M2.1 GS32", cost: TEST_MODEL_COST },
                ],
              },
            },
          },
          session: { store: storePath },
        },
      );

      assertModelSelection(storePath);
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
  it("picks the best fuzzy match within a provider", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");

      await getReplyFromConfig(
        { Body: "/model minimax/m2.1", From: "+1222", To: "+1222", CommandAuthorized: true },
        {},
        {
          agents: {
            defaults: {
              model: { primary: "minimax/MiniMax-M2.1" },
              workspace: path.join(home, "fased"),
              models: {
                "minimax/MiniMax-M2.1": {},
                "minimax/MiniMax-M2.1-lightning": {},
              },
            },
          },
          models: {
            mode: "merge",
            providers: {
              minimax: {
                baseUrl: "https://api.minimax.io/anthropic",
                apiKey: "sk-test",
                api: "anthropic-messages",
                models: [
                  { id: "MiniMax-M2.1", name: "MiniMax M2.1", cost: TEST_MODEL_COST },
                  {
                    id: "MiniMax-M2.1-lightning",
                    name: "MiniMax M2.1 Lightning",
                    cost: TEST_MODEL_COST,
                  },
                ],
              },
            },
          },
          session: { store: storePath },
        },
      );

      assertModelSelection(storePath);
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
});
