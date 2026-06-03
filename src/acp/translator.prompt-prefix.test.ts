import os from "node:os";
import path from "node:path";
import type { PromptRequest } from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import { createInMemorySessionStore } from "./session.js";
import { AcpGatewayAgent } from "./translator.js";
import { createAcpConnection, createAcpGateway } from "./translator.test-helpers.js";

describe("acp prompt cwd prefix", () => {
  async function runPromptWithCwd(cwd: string) {
    const pinnedHome = os.homedir();
    const previousFasedAgentHome = process.env.FASED_HOME;
    const previousHome = process.env.HOME;
    delete process.env.FASED_HOME;
    process.env.HOME = pinnedHome;

    const sessionStore = createInMemorySessionStore();
    sessionStore.createSession({
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      cwd,
    });

    const requestSpy = vi.fn(async (method: string) => {
      if (method === "chat.send") {
        throw new Error("stop-after-send");
      }
      return {};
    });
    const agent = new AcpGatewayAgent(
      createAcpConnection(),
      createAcpGateway(requestSpy as unknown as GatewayClient["request"]),
      {
        sessionStore,
        prefixCwd: true,
      },
    );

    try {
      await expect(
        agent.prompt({
          sessionId: "session-1",
          prompt: [{ type: "text", text: "hello" }],
          _meta: {},
        } as unknown as PromptRequest),
      ).rejects.toThrow("stop-after-send");
      return requestSpy;
    } finally {
      if (previousFasedAgentHome === undefined) {
        delete process.env.FASED_HOME;
      } else {
        process.env.FASED_HOME = previousFasedAgentHome;
      }
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    }
  }

  it("redacts home directory in prompt prefix", async () => {
    const requestSpy = await runPromptWithCwd(path.join(os.homedir(), "fased-test"));
    expect(requestSpy).toHaveBeenCalledWith(
      "chat.send",
      expect.objectContaining({
        message: expect.stringMatching(/\[Working directory: ~[\\/]fased-test\]/),
      }),
      { expectFinal: true },
    );
  });

  it("keeps backslash separators when cwd uses them", async () => {
    const requestSpy = await runPromptWithCwd(`${os.homedir()}\\fased-test`);
    expect(requestSpy).toHaveBeenCalledWith(
      "chat.send",
      expect.objectContaining({
        message: expect.stringContaining("[Working directory: ~\\fased-test]"),
      }),
      { expectFinal: true },
    );
  });
});
