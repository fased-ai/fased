import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ log: vi.fn() }));
const report = vi.hoisted(() => ({
  entries: [
    {
      id: "agent-core",
      label: "Fased Agent",
      category: "core",
      delivery: "core",
      description: "Agent",
      docsPath: "/start/fased",
      surface: "Agent > Models",
      state: "included",
      action: "configure",
      detail: "Included",
    },
  ],
  summary: {
    total: 1,
    coreIncluded: 1,
    optionalInstalled: 0,
    optionalConfigured: 0,
    externalRequired: 0,
    errors: 0,
  },
}));

vi.mock("../runtime.js", () => ({ defaultRuntime: runtime }));
vi.mock("../capabilities/catalog.js", () => ({
  buildCapabilityReadinessReport: vi.fn(() => report),
  formatCapabilityReadinessSummary: vi.fn(() => "Core included: 1"),
}));

describe("components CLI", () => {
  beforeEach(() => {
    runtime.log.mockClear();
  });

  it("prints the shared capability report as JSON", async () => {
    const { registerComponentsCli } = await import("./components-cli.js");
    const program = new Command().name("fased");
    registerComponentsCli(program);
    await program.parseAsync(["components", "--json"], { from: "user" });
    expect(JSON.parse(runtime.log.mock.calls[0]?.[0] as string)).toEqual(report);
  });

  it("prints lifecycle states in the table", async () => {
    const { registerComponentsCli } = await import("./components-cli.js");
    const program = new Command().name("fased");
    registerComponentsCli(program);
    await program.parseAsync(["components"], { from: "user" });
    expect(runtime.log.mock.calls.flat().join("\n")).toContain("Fased Agent");
    expect(runtime.log.mock.calls.flat().join("\n")).toContain("included");
  });
});
