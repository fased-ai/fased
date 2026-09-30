import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

const actions = vi.hoisted(() => ({ loaded: false, status: vi.fn() }));
vi.mock("./memory-cli-actions.js", () => {
  actions.loaded = true;
  return { runMemoryStatus: actions.status };
});

import { registerMemoryCli } from "./memory-cli.js";

describe("memory CLI lazy actions", () => {
  it("registers the complete command tree synchronously without loading actions", async () => {
    const program = new Command();
    expect(registerMemoryCli(program)).toBeUndefined();
    const memory = program.commands.find((command) => command.name() === "memory")!;
    expect(memory.commands.map((command) => command.name())).toEqual([
      "status",
      "doctor",
      "repair",
      "index",
      "search",
    ]);
    expect(memory.helpInformation()).toContain("Search, inspect, and reindex memory files");
    expect(memory.commands.find((command) => command.name() === "repair")?.commands[0].name()).toBe(
      "execute",
    );
    expect(actions.loaded).toBe(false);

    await program.parseAsync(["memory", "status", "--json"], { from: "user" });
    expect(actions.loaded).toBe(true);
    expect(actions.status).toHaveBeenCalledWith(expect.objectContaining({ json: true }));
  });
});
