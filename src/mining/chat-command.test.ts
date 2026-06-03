import type { Mock } from "vitest";
import { describe, expect, it, vi } from "vitest";

vi.mock("../gateway/call.js", () => ({
  callGatewayScoped: vi.fn(async () => ({
    payload: { stopped: true, status: { running: false } },
  })),
}));

import { callGatewayScoped } from "../gateway/call.js";
import {
  executeMiningChatCommand,
  formatMiningChatCommandReply,
  parseMiningChatCommand,
  type MiningChatCommand,
} from "./chat-command.js";

describe("chat mining command parser", () => {
  it("routes obvious start commands to SAT start with the wallet handle", () => {
    expect(parseMiningChatCommand("Start @mining with @wallet:mining")).toEqual({
      action: "start",
      method: "sat.startMining",
      params: { walletId: "mining" },
      expectFinal: true,
      timeoutMs: 90_000,
    });
  });

  it("routes obvious stop commands to SAT stop", () => {
    expect(parseMiningChatCommand("Stop @mining.")).toEqual({
      action: "stop",
      method: "sat.stopMining",
      params: {},
      expectFinal: true,
      timeoutMs: 90_000,
    });
  });

  it("does not treat unrelated mining prose as a command", () => {
    expect(parseMiningChatCommand("write docs about @mining automation")).toBeNull();
  });

  it("does not route mining attach or detach chat commands", () => {
    expect(parseMiningChatCommand("@mining attach @wallet:vault")).toBeNull();
    expect(parseMiningChatCommand("@mining detach")).toBeNull();
  });

  it("leaves scheduled or conditional mining prompts to the agent path", () => {
    expect(
      parseMiningChatCommand(
        "Every hour, check @mining status. Stop @mining if the pool has more than 100 SOL.",
      ),
    ).toBeNull();
  });

  it("routes current cycle status requests instead of treating cycle as scheduling", () => {
    expect(parseMiningChatCommand("show @mining current cycle")).toEqual({
      action: "status",
      method: "sat.getMiningStatus",
      params: {},
    });
  });

  it("uses local gateway auth from config instead of a stale environment token", async () => {
    (callGatewayScoped as Mock).mockClear();
    await executeMiningChatCommand({
      cfg: {
        gateway: {
          mode: "remote",
          auth: { token: "local-auth-token" },
          remote: { token: "remote-token" },
        },
      } as never,
      command: {
        action: "stop",
        method: "sat.stopMining",
        params: {},
      },
    });
    expect(callGatewayScoped).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "local-auth-token",
        config: expect.objectContaining({
          gateway: expect.objectContaining({ mode: "local" }),
        }),
      }),
    );
  });

  it("formats start replies as running only after runtime confirms running", () => {
    const command: MiningChatCommand = {
      action: "start",
      method: "sat.startMining",
    };
    expect(
      formatMiningChatCommandReply(command, {
        payload: {
          started: true,
          status: { running: true, drainOnly: false },
        },
      }),
    ).toBe("SAT mining is running.");
  });

  it("formats start replies without claiming success when runtime is blocked", () => {
    const command: MiningChatCommand = {
      action: "start",
      method: "sat.startMining",
    };
    expect(
      formatMiningChatCommandReply(command, {
        payload: {
          started: false,
          status: { running: false, blockedReason: "wallet not configured" },
        },
      }),
    ).toContain("Start was requested, but SAT mining is not running. wallet not configured");
  });
});
