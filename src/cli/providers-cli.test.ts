import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runRegisteredCli } from "../test-utils/command-runner.js";
import { registerProvidersCli } from "./providers-cli.js";

const configMocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  writeConfigFile: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: configMocks.loadConfig,
  writeConfigFile: configMocks.writeConfigFile,
}));

describe("providers cli", () => {
  let output: string[];

  beforeEach(() => {
    output = [];
    configMocks.loadConfig.mockReset().mockReturnValue({ models: { providers: {} } });
    configMocks.writeConfigFile.mockReset().mockResolvedValue(undefined);
    vi.spyOn(console, "log").mockImplementation((line = "") => {
      output.push(String(line));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports provider refresh changes from a snapshot file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fased-providers-refresh-"));
    const snapshot = path.join(dir, "snapshot.json");
    await writeFile(
      snapshot,
      JSON.stringify({
        providers: {
          openai: {
            routes: {
              openai: ["gpt-5.5", "gpt-5.6"],
            },
          },
        },
      }),
    );

    await runRegisteredCli({
      register: registerProvidersCli,
      argv: ["providers", "refresh", "--from-file", snapshot],
    });

    const text = output.join("\n");
    expect(text).toContain("Provider refresh review");
    expect(text).toContain("openai/openai");
    expect(text).toContain("gpt-5.6");
    expect(text).toContain("source gaps preserved");
    expect(text).toContain("preserve curated");
    expect(text).not.toContain("remove from normal UI");
  });

  it("writes a review patch without applying registry changes", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fased-providers-refresh-"));
    const snapshot = path.join(dir, "snapshot.json");
    const patch = path.join(dir, "review.patch");
    await writeFile(
      snapshot,
      JSON.stringify({
        providers: {
          openai: {
            routes: {
              openai: ["gpt-5.6"],
            },
          },
        },
      }),
    );

    await runRegisteredCli({
      register: registerProvidersCli,
      argv: ["providers", "refresh", "--from-file", snapshot, "--write-review", patch],
    });

    const text = await readFile(patch, "utf8");
    expect(text).toContain("*** Begin Patch");
    expect(text).toContain('"gpt-5.6"');
  });

  it("prints actionable setup hints for missing provider refresh sources", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fased-providers-refresh-"));
    const snapshot = path.join(dir, "snapshot.json");
    await writeFile(
      snapshot,
      JSON.stringify({
        providers: {
          anthropic: {
            missing: {
              anthropic: {
                reason: "credential-missing",
                detail: "Set ANTHROPIC_API_KEY or configure an Anthropic API-key auth profile.",
              },
            },
          },
          minimax: {
            missing: {
              "minimax-portal": {
                reason: "credential-missing",
                detail: "Configure MiniMax portal OAuth or set MINIMAX_PORTAL_OAUTH_TOKEN.",
              },
            },
          },
          vllm: {
            missing: {
              vllm: {
                reason: "base-url-missing",
                detail: "Set VLLM_BASE_URL.",
              },
            },
          },
          copilot: {
            missing: {
              "github-copilot": {
                reason: "catalog-unsupported",
                detail: "Direct GitHub Copilot model catalog probing is not implemented.",
              },
            },
          },
        },
      }),
    );

    await runRegisteredCli({
      register: registerProvidersCli,
      argv: ["providers", "refresh", "--from-file", snapshot],
    });

    const text = output.join("\n");
    expect(text).toContain("Open Providers > Anthropic > API key.");
    expect(text).not.toContain(
      "fased models auth login --provider anthropic --method anthropic-oauth",
    );
    expect(text).toContain("Open Providers > MiniMax > Sign in.");
    expect(text).toContain(
      "CLI: fased models auth login --provider minimax-portal --method minimax-portal.",
    );
    expect(text).toContain("Open Providers > vLLM-compatible > vLLM-compatible URL + model.");
    expect(text).toContain("Configure the base URL for vllm");
    expect(text).toContain("No live catalog probe exists for this route yet");
  });

  it("adds and removes configured provider models without editing raw config by hand", async () => {
    configMocks.loadConfig.mockReturnValue({
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [],
          },
        },
      },
    });

    await runRegisteredCli({
      register: registerProvidersCli,
      argv: [
        "providers",
        "models",
        "add",
        "--provider",
        "openai",
        "--model",
        "gpt-new",
        "--name",
        "GPT New",
        "--context-window",
        "200000",
        "--max-tokens",
        "8192",
        "--reasoning",
        "--vision",
        "--tools",
        "--json",
      ],
    });

    const added = configMocks.writeConfigFile.mock.calls.at(-1)?.[0] as {
      models?: { providers?: Record<string, { models?: Array<Record<string, unknown>> }> };
    };
    expect(added.models?.providers?.openai?.models?.[0]).toMatchObject({
      id: "gpt-new",
      name: "GPT New",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 200000,
      maxTokens: 8192,
      capabilities: {
        tools: true,
        json: true,
      },
    });
    expect(output.join("\n")).toContain("Model saved: openai/gpt-new");

    configMocks.loadConfig.mockReturnValue(added);
    await runRegisteredCli({
      register: registerProvidersCli,
      argv: ["providers", "models", "remove", "--provider", "openai", "--model", "gpt-new"],
    });

    const removed = configMocks.writeConfigFile.mock.calls.at(-1)?.[0] as {
      models?: { providers?: Record<string, { models?: Array<Record<string, unknown>> }> };
    };
    expect(removed.models?.providers?.openai?.models).toEqual([]);
    expect(output.join("\n")).toContain("Model removed: openai/gpt-new");
  });
});
