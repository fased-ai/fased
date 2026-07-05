import { afterEach, describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../terminal/ansi.js";
import { createClackPrompter, tokenizedOptionFilter } from "./clack-prompter.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("tokenizedOptionFilter", () => {
  it("matches tokens regardless of order", () => {
    const option = {
      value: "openai/gpt-5.2",
      label: "openai/gpt-5.2",
      hint: "ctx 400k",
    };

    expect(tokenizedOptionFilter("gpt-5.2 openai/", option)).toBe(true);
    expect(tokenizedOptionFilter("openai/ gpt-5.2", option)).toBe(true);
  });

  it("requires all tokens to match", () => {
    const option = {
      value: "openai/gpt-5.2",
      label: "openai/gpt-5.2",
    };

    expect(tokenizedOptionFilter("gpt-5.2 anthropic/", option)).toBe(false);
  });

  it("matches against label, hint, and value", () => {
    const option = {
      value: "openai/gpt-5.2",
      label: "GPT 5.2",
      hint: "provider openai",
    };

    expect(tokenizedOptionFilter("provider openai", option)).toBe(true);
    expect(tokenizedOptionFilter("openai gpt-5.2", option)).toBe(true);
  });
});

describe("createClackPrompter", () => {
  it("prints the final setup outro without the old clack rail", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createClackPrompter().outro("Setup complete. Next: Agent > Models, then Chat.");

    const output = stripAnsi(write.mock.calls.map(([chunk]) => String(chunk)).join(""));
    expect(output).toContain("SETUP COMPLETE. NEXT: AGENT > MODELS, THEN CHAT.");
    expect(output).toMatch(/^  SETUP COMPLETE\./);
    expect(output).not.toMatch(/[◇│╰]/);
  });
});
