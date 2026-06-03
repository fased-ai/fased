import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { acpAction, registerAcpCli } = vi.hoisted(() => {
  const action = vi.fn();
  const register = vi.fn((program: Command) => {
    program.command("acp").action(action);
  });
  return { acpAction: action, registerAcpCli: register };
});

const { nodesAction, registerNodesCli } = vi.hoisted(() => {
  const action = vi.fn();
  const register = vi.fn((program: Command) => {
    const nodes = program.command("nodes");
    nodes.command("list").action(action);
  });
  return { nodesAction: action, registerNodesCli: register };
});

const { miningAction, registerMiningCli } = vi.hoisted(() => {
  const action = vi.fn();
  const register = vi.fn((program: Command) => {
    const mining = program.command("mining");
    mining.command("status").action(action);
  });
  return { miningAction: action, registerMiningCli: register };
});

const { satAction, registerSatCli } = vi.hoisted(() => {
  const action = vi.fn();
  const register = vi.fn((program: Command) => {
    const sat = program.command("sat");
    sat.command("maintain").action(action);
  });
  return { satAction: action, registerSatCli: register };
});

const { federationAction, registerFederationCli } = vi.hoisted(() => {
  const action = vi.fn();
  const register = vi.fn((program: Command) => {
    const federation = program.command("federation");
    federation.command("status").action(action);
  });
  return { federationAction: action, registerFederationCli: register };
});

vi.mock("../acp-cli.js", () => ({ registerAcpCli }));
vi.mock("../nodes-cli.js", () => ({ registerNodesCli }));
vi.mock("../mining-cli.js", () => ({ registerMiningCli }));
vi.mock("../sat-cli.js", () => ({ registerSatCli }));
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
    registerAcpCli.mockClear();
    acpAction.mockClear();
    registerNodesCli.mockClear();
    nodesAction.mockClear();
    registerMiningCli.mockClear();
    miningAction.mockClear();
    registerSatCli.mockClear();
    satAction.mockClear();
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
    const program = createRegisteredProgram(["node", "fased", "acp"]);

    expect(program.commands.map((cmd) => cmd.name())).toEqual(["acp"]);

    await program.parseAsync(["acp"], { from: "user" });

    expect(registerAcpCli).toHaveBeenCalledTimes(1);
    expect(acpAction).toHaveBeenCalledTimes(1);
  });

  it("registers placeholders for all subcommands when no primary", () => {
    const program = createRegisteredProgram(["node", "fased"]);

    const names = program.commands.map((cmd) => cmd.name());
    expect(names).toContain("start");
    expect(names).toContain("managed");
    expect(names).toContain("acp");
    expect(names).toContain("gateway");
    expect(names).toContain("mining");
    expect(names).toContain("sat");
    expect(names).toContain("federation");
    expect(registerAcpCli).not.toHaveBeenCalled();
  });

  it("re-parses argv for lazy subcommands", async () => {
    const program = createRegisteredProgram(["node", "fased", "nodes", "list"], "fased");

    expect(program.commands.map((cmd) => cmd.name())).toEqual(["nodes"]);

    await program.parseAsync(["nodes", "list"], { from: "user" });

    expect(registerNodesCli).toHaveBeenCalledTimes(1);
    expect(nodesAction).toHaveBeenCalledTimes(1);
  });

  it("dispatches lazy mining subcommands", async () => {
    const program = createRegisteredProgram(["node", "fased", "mining", "status"], "fased");

    expect(program.commands.map((cmd) => cmd.name())).toEqual(["mining"]);

    await program.parseAsync(["mining", "status"], { from: "user" });

    expect(registerMiningCli).toHaveBeenCalledTimes(1);
    expect(miningAction).toHaveBeenCalledTimes(1);
  });

  it("dispatches lazy SAT operator subcommands", async () => {
    const program = createRegisteredProgram(["node", "fased", "sat", "maintain"], "fased");

    expect(program.commands.map((cmd) => cmd.name())).toEqual(["sat"]);

    await program.parseAsync(["sat", "maintain"], { from: "user" });

    expect(registerSatCli).toHaveBeenCalledTimes(1);
    expect(satAction).toHaveBeenCalledTimes(1);
  });

  it("replaces placeholder when registering a subcommand by name", async () => {
    const program = createRegisteredProgram(["node", "fased", "acp", "--help"], "fased");

    await registerSubCliByName(program, "acp");

    const names = program.commands.map((cmd) => cmd.name());
    expect(names.filter((name) => name === "acp")).toHaveLength(1);

    await program.parseAsync(["acp"], { from: "user" });
    expect(registerAcpCli).toHaveBeenCalledTimes(1);
    expect(acpAction).toHaveBeenCalledTimes(1);
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
