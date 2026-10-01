import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { nodesAction, registerNodesCli } = vi.hoisted(() => {
  const action = vi.fn();
  const register = vi.fn((program: Command) => {
    const nodes = program.command("nodes");
    nodes.command("list").action(action);
  });
  return { nodesAction: action, registerNodesCli: register };
});

const { federationAction, registerFederationCli } = vi.hoisted(() => {
  const action = vi.fn();
  const register = vi.fn((program: Command) => {
    const federation = program.command("federation");
    federation.command("status").action(action);
  });
  return { federationAction: action, registerFederationCli: register };
});

vi.mock("../nodes-cli.js", () => ({ registerNodesCli }));
vi.mock("../federation-cli.js", () => ({ registerFederationCli }));

const { registerSubCliByName, registerSubCliCommands } = await import("./register.subclis.js");

describe("registerSubCliCommands", () => {
  const originalArgv = process.argv;
  const originalDisableLazySubcommands = process.env.FASED_DISABLE_LAZY_SUBCOMMANDS;

  const createRegisteredProgram = (argv: string[], name?: string) => {
    process.argv = argv;
    const program = new Command();
    if (name) {
      program.name(name);
    }
    registerSubCliCommands(program, process.argv);
    return program;
  };

  beforeEach(() => {
    if (originalDisableLazySubcommands === undefined) {
      delete process.env.FASED_DISABLE_LAZY_SUBCOMMANDS;
    } else {
      process.env.FASED_DISABLE_LAZY_SUBCOMMANDS = originalDisableLazySubcommands;
    }
    registerNodesCli.mockClear();
    nodesAction.mockClear();
    registerFederationCli.mockClear();
    federationAction.mockClear();
  });

  afterEach(() => {
    process.argv = originalArgv;
    if (originalDisableLazySubcommands === undefined) {
      delete process.env.FASED_DISABLE_LAZY_SUBCOMMANDS;
    } else {
      process.env.FASED_DISABLE_LAZY_SUBCOMMANDS = originalDisableLazySubcommands;
    }
  });

  it("registers only the primary placeholder and dispatches", async () => {
    const program = createRegisteredProgram(["node", "fased", "nodes", "list"]);

    expect(program.commands.map((cmd) => cmd.name())).toEqual(["nodes"]);

    await program.parseAsync(["nodes", "list"], { from: "user" });

    expect(registerNodesCli).toHaveBeenCalledTimes(1);
    expect(nodesAction).toHaveBeenCalledTimes(1);
  });

  it("registers placeholders for all subcommands when no primary", () => {
    const program = createRegisteredProgram(["node", "fased"]);

    const names = program.commands.map((cmd) => cmd.name());
    expect(names).toContain("start");
    expect(names).not.toContain("managed");
    expect(names).toContain("nodes");
    expect(names).toContain("gateway");
    expect(names).not.toContain("mining");
    expect(names).not.toContain("sat");
    expect(names).toContain("federation");
    expect(registerNodesCli).not.toHaveBeenCalled();
  });

  it("re-parses argv for lazy subcommands", async () => {
    const program = createRegisteredProgram(["node", "fased", "nodes", "list"], "fased");

    expect(program.commands.map((cmd) => cmd.name())).toEqual(["nodes"]);

    await program.parseAsync(["nodes", "list"], { from: "user" });

    expect(registerNodesCli).toHaveBeenCalledTimes(1);
    expect(nodesAction).toHaveBeenCalledTimes(1);
  });

  it("replaces placeholder when registering a subcommand by name", async () => {
    const program = createRegisteredProgram(["node", "fased", "nodes", "--help"], "fased");

    await registerSubCliByName(program, "nodes");

    const names = program.commands.map((cmd) => cmd.name());
    expect(names.filter((name) => name === "nodes")).toHaveLength(1);

    await program.parseAsync(["nodes", "list"], { from: "user" });
    expect(registerNodesCli).toHaveBeenCalledTimes(1);
    expect(nodesAction).toHaveBeenCalledTimes(1);
  });

  it("registers federation subcommands by name without duplicate placeholders", async () => {
    const program = createRegisteredProgram(["node", "fased", "federation", "--help"], "fased");

    await registerSubCliByName(program, "federation");

    const names = program.commands.map((cmd) => cmd.name());
    expect(names.filter((name) => name === "federation")).toHaveLength(1);

    await program.parseAsync(["federation", "status"], { from: "user" });
    expect(registerFederationCli).toHaveBeenCalledTimes(1);
    expect(federationAction).toHaveBeenCalledTimes(1);
  });
});
