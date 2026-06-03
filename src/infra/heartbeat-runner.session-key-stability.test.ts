import { afterEach, describe, expect, it, vi } from "vitest";
import * as replyModule from "../auto-reply/reply.js";
import type { FasedAgentConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { seedSessionStore, withTempHeartbeatSandbox } from "./heartbeat-runner.test-utils.js";

// Avoid pulling optional runtime deps during isolated runs.
vi.mock("jiti", () => ({ createJiti: () => () => ({}) }));

afterEach(() => {
  vi.restoreAllMocks();
});

function makeHeartbeatConfig(tmpDir: string, storePath: string): FasedAgentConfig {
  return {
    agents: {
      defaults: {
        workspace: tmpDir,
        heartbeat: {
          every: "5m",
          target: "none",
        },
      },
    },
    session: { store: storePath },
  };
}

async function captureHeartbeatSessionKey(params: { cfg: FasedAgentConfig; sessionKey?: string }) {
  const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
  replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

  await runHeartbeatOnce({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    deps: {
      getQueueSize: () => 0,
      nowMs: () => 0,
    },
  });

  expect(replySpy).toHaveBeenCalledTimes(1);
  return replySpy.mock.calls[0]?.[0]?.SessionKey;
}

describe("runHeartbeatOnce session key stability", () => {
  it("does not append another heartbeat suffix when a forced key already ends with :heartbeat", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      const cfg = makeHeartbeatConfig(tmpDir, storePath);
      const baseSessionKey = resolveMainSessionKey(cfg);
      const heartbeatSessionKey = `${baseSessionKey}:heartbeat`;
      await seedSessionStore(storePath, heartbeatSessionKey, {
        lastChannel: "webchat",
        lastProvider: "webchat",
        lastTo: "local",
      });

      await expect(
        captureHeartbeatSessionKey({ cfg, sessionKey: heartbeatSessionKey }),
      ).resolves.toBe(heartbeatSessionKey);
    });
  });

  it("uses a configured heartbeat session exactly once without synthetic suffixes", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      const cfg: FasedAgentConfig = {
        ...makeHeartbeatConfig(tmpDir, storePath),
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: {
              every: "5m",
              target: "none",
              session: "alerts:heartbeat",
            },
          },
        },
      };
      const configuredSessionKey = "agent:main:alerts:heartbeat";
      await seedSessionStore(storePath, configuredSessionKey, {
        lastChannel: "webchat",
        lastProvider: "webchat",
        lastTo: "local",
      });

      await expect(captureHeartbeatSessionKey({ cfg })).resolves.toBe(configuredSessionKey);
    });
  });
});
