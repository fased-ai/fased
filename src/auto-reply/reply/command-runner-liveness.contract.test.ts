import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FasedAgentConfig } from "../../config/config.js";
import { clearPluginCommands, registerPluginCommand } from "../../plugins/commands.js";
import { listChatCommandsForConfig } from "../commands-registry.js";
import { handleCommands } from "./commands.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

function createConfig(overrides: Partial<FasedAgentConfig> = {}): FasedAgentConfig {
  return {
    commands: { text: true },
    channels: { whatsapp: { allowFrom: ["*"] } },
    whatsapp: { allowFrom: ["*"] },
    ...overrides,
  } as FasedAgentConfig;
}

function buildParams(
  body: string,
  cfg: FasedAgentConfig = createConfig(),
  ctxOverrides: Parameters<typeof buildCommandTestParams>[2] = {},
) {
  return buildCommandTestParams(body, cfg, {
    SenderId: "owner",
    From: "owner",
    To: "agent",
    ...ctxOverrides,
  });
}

describe("command runner liveness contract", () => {
  beforeEach(() => {
    clearPluginCommands();
  });

  afterEach(() => {
    clearPluginCommands();
  });

  it("keeps advertised safe text commands executable before agent continuation", async () => {
    const cfg = createConfig();
    const advertised = listChatCommandsForConfig(cfg)
      .filter((command) => ["help", "commands", "whoami"].includes(command.key))
      .map((command) => command.textAliases[0]);

    expect(advertised).toEqual(expect.arrayContaining(["/help", "/commands", "/whoami"]));

    for (const alias of advertised) {
      const result = await handleCommands(buildParams(alias, cfg));

      expect(result.shouldContinue, alias).toBe(false);
      expect(result.reply?.text, alias).toEqual(expect.any(String));
      expect(result.reply?.text, alias).not.toHaveLength(0);
    }
  });

  it("continues to the agent for unknown commands instead of dropping the message", async () => {
    const result = await handleCommands(buildParams("/not-a-real-command please continue"));

    expect(result).toEqual({ shouldContinue: true });
  });

  it("executes plugin commands with sanitized args and then stops before agent continuation", async () => {
    const handler = vi.fn(async (ctx) => ({
      text: `plugin ok ${ctx.args ?? ""}`,
    }));

    expect(
      registerPluginCommand("demo-plugin", {
        name: "demo_live",
        description: "Demo liveness command",
        acceptsArgs: true,
        handler,
      }),
    ).toEqual({ ok: true });

    const result = await handleCommands(buildParams("/demo_live hello\u0000world"));

    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toBe("plugin ok helloworld");
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        args: "helloworld",
        channel: "whatsapp",
        isAuthorizedSender: true,
      }),
    );
  });

  it("lets non-matching plugin command input fall through to the agent", async () => {
    expect(
      registerPluginCommand("demo-plugin", {
        name: "demo_noargs",
        description: "Demo no-args command",
        acceptsArgs: false,
        handler: vi.fn(async () => ({ text: "should not run" })),
      }),
    ).toEqual({ ok: true });

    const result = await handleCommands(buildParams("/demo_noargs extra"));

    expect(result).toEqual({ shouldContinue: true });
  });

  it("keeps native command sources live when text commands are disabled on native surfaces", async () => {
    const cfg = createConfig({ commands: { text: false } });

    const textSource = await handleCommands(
      buildParams("/help", cfg, {
        Provider: "discord",
        Surface: "discord",
        CommandSource: "text",
      }),
    );
    expect(textSource).toEqual({ shouldContinue: true });

    const nativeSource = await handleCommands(
      buildParams("/help", cfg, {
        Provider: "discord",
        Surface: "discord",
        CommandSource: "native",
      }),
    );
    expect(nativeSource.shouldContinue).toBe(false);
    expect(nativeSource.reply?.text).toEqual(expect.any(String));
  });
});
