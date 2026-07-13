import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const renderComponentReport = vi.hoisted(() => vi.fn());
const installComponentCommand = vi.hoisted(() => vi.fn());
const buildCapabilityReadinessReport = vi.hoisted(() => vi.fn());
const runtime = vi.hoisted(() => ({ log: vi.fn() }));

vi.mock("./components-cli.js", () => ({ renderComponentReport, installComponentCommand }));
vi.mock("../capabilities/catalog.js", () => ({ buildCapabilityReadinessReport }));
vi.mock("../runtime.js", () => ({ defaultRuntime: runtime }));
vi.mock("../terminal/links.js", () => ({
  formatDocsLink: (_path: string, label: string) => label,
}));
vi.mock("../terminal/theme.js", () => ({ theme: { heading: (value: string) => value } }));

describe("services CLI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prints the canonical component report", async () => {
    const { registerServicesCli } = await import("./services-cli.js");
    const program = new Command().name("fased");
    registerServicesCli(program);
    await program.parseAsync(["services", "status", "--json"], { from: "user" });
    expect(renderComponentReport).toHaveBeenCalledWith(expect.objectContaining({ json: true }));
  });

  it("installs a missing npm component when connect is requested", async () => {
    buildCapabilityReadinessReport.mockReturnValue({
      entries: [
        {
          id: "media-runtime",
          label: "Media Runtime",
          delivery: "npm-addon",
          state: "not-installed",
        },
      ],
    });
    const { registerServicesCli } = await import("./services-cli.js");
    const program = new Command().name("fased");
    registerServicesCli(program);
    await program.parseAsync(["services", "connect", "media-runtime"], { from: "user" });
    expect(installComponentCommand).toHaveBeenCalledWith("media-runtime");
  });

  it("prints the owning surface for an external runtime", async () => {
    buildCapabilityReadinessReport.mockReturnValue({
      entries: [
        {
          id: "ollama",
          label: "Ollama",
          delivery: "external-runtime",
          state: "external-required",
          detail: "Run Ollama first.",
          surface: "Agent > Models",
          docsPath: "/providers/ollama",
        },
      ],
    });
    const { registerServicesCli } = await import("./services-cli.js");
    const program = new Command().name("fased");
    registerServicesCli(program);
    await program.parseAsync(["services", "connect", "ollama"], { from: "user" });
    expect(runtime.log.mock.calls.flat().join("\n")).toContain("Connect from: Agent > Models");
  });
});
