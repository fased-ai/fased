import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const commandsMock = vi.hoisted(() => ({
  loadCount: 0,
  channelsAddCommand: vi.fn(async () => {}),
  channelsCapabilitiesCommand: vi.fn(async () => {}),
  channelsListCommand: vi.fn(async () => {}),
  channelsLogsCommand: vi.fn(async () => {}),
  channelsRemoveCommand: vi.fn(async () => {}),
  channelsResolveCommand: vi.fn(async () => {}),
  channelsStatusCommand: vi.fn(async () => {}),
}));

const runtimeMock = vi.hoisted(() => ({
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
}));

vi.mock("../commands/channels.js", () => {
  commandsMock.loadCount += 1;
  return {
    channelsAddCommand: commandsMock.channelsAddCommand,
    channelsCapabilitiesCommand: commandsMock.channelsCapabilitiesCommand,
    channelsListCommand: commandsMock.channelsListCommand,
    channelsLogsCommand: commandsMock.channelsLogsCommand,
    channelsRemoveCommand: commandsMock.channelsRemoveCommand,
    channelsResolveCommand: commandsMock.channelsResolveCommand,
    channelsStatusCommand: commandsMock.channelsStatusCommand,
  };
});

vi.mock("../runtime.js", () => ({
  defaultRuntime: runtimeMock,
}));

vi.mock("./cli-utils.js", () => ({
  runCommandWithRuntime: async (_runtime: unknown, action: () => Promise<void>) => {
    await action();
  },
}));

async function loadRegisterChannelsCli() {
  vi.resetModules();
  commandsMock.loadCount = 0;
  commandsMock.channelsAddCommand.mockClear();
  commandsMock.channelsListCommand.mockClear();
  const mod = await import("./channels-cli.js");
  return mod.registerChannelsCli;
}

function captureStdout(action: () => Promise<void> | void): Promise<string> {
  let output = "";
  const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
    chunk: string | Uint8Array,
  ) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write);
  return Promise.resolve()
    .then(action)
    .then(() => output)
    .finally(() => {
      writeSpy.mockRestore();
    });
}

function findCommand(program: Command, name: string): Command {
  const command = program.commands.find((candidate) => candidate.name() === name);
  if (!command) {
    throw new Error(`Missing command ${name}`);
  }
  return command;
}

describe("registerChannelsCli", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  it("prints Fased channels help without loading channel action modules", async () => {
    const registerChannelsCli = await loadRegisterChannelsCli();
    const program = new Command().name("fased");
    registerChannelsCli(program);

    const output = await captureStdout(async () => {
      await program.parseAsync(["channels"], { from: "user" });
    });

    expect(commandsMock.loadCount).toBe(0);
    expect(output).toContain("Usage: fased channels");
    expect(output).toContain("fased channels add --channel telegram --token <token>");
    expect(output).toContain("docs.fased.ai/cli/channels");
    expect(process.exitCode).toBe(0);
  });

  it("keeps the Fased channel add option surface registered without loading actions", async () => {
    const registerChannelsCli = await loadRegisterChannelsCli();
    const program = new Command().name("fased");
    registerChannelsCli(program);

    const channels = findCommand(program, "channels");
    const add = findCommand(channels, "add");
    const optionFlags = add.options.map((option) => option.flags);

    expect(commandsMock.loadCount).toBe(0);
    expect(optionFlags).toContain("--token <token>");
    expect(optionFlags).toContain("--bot-token <token>");
    expect(optionFlags).toContain("--homeserver <url>");
    expect(optionFlags).toContain("--ship <ship>");
    expect(optionFlags).toContain("--auto-discover-channels");
    expect(optionFlags).toContain("--no-auto-discover-channels");
  });

  it("loads channel action modules only when a channel command runs", async () => {
    const registerChannelsCli = await loadRegisterChannelsCli();
    const program = new Command().name("fased");
    registerChannelsCli(program);

    await program.parseAsync(["channels", "list", "--no-usage"], { from: "user" });

    expect(commandsMock.loadCount).toBe(1);
    expect(commandsMock.channelsListCommand).toHaveBeenCalledWith(
      expect.objectContaining({ usage: false }),
      runtimeMock,
    );
  });
});
