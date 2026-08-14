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

  it("prints the owning surface for a bundled component", async () => {
    buildCapabilityReadinessReport.mockReturnValue({
      entries: [
        {
          id: "media-runtime",
          label: "Media Runtime",
          delivery: "core",
          state: "included",
          detail: "Included in the signed generation.",
          surface: "Services > Components",
          docsPath: "/nodes/media-understanding",
        },
      ],
    });
    const { registerServicesCli } = await import("./services-cli.js");
    const program = new Command().name("fased");
    registerServicesCli(program);
    await program.parseAsync(["services", "connect", "media-runtime"], { from: "user" });
    expect(installComponentCommand).not.toHaveBeenCalled();
    expect(runtime.log.mock.calls.flat().join("\n")).toContain(
      "Connect from: Services > Components",
    );
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
