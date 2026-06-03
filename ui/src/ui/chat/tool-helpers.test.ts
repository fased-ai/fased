import { describe, it, expect } from "vitest";
import {
  formatToolOutputForChat,
  formatToolOutputForSidebar,
  getTruncatedPreview,
} from "./tool-helpers.ts";

describe("tool-helpers", () => {
  describe("formatToolOutputForSidebar", () => {
    it("formats valid JSON object as code block", () => {
      const input = '{"name":"test","value":123}';
      const result = formatToolOutputForSidebar(input);

      expect(result).toBe(`\`\`\`json
{
  "name": "test",
  "value": 123
}
\`\`\``);
    });

    it("formats valid JSON array as code block", () => {
      const input = "[1, 2, 3]";
      const result = formatToolOutputForSidebar(input);

      expect(result).toBe(`\`\`\`json
[
  1,
  2,
  3
]
\`\`\``);
    });

    it("handles nested JSON objects", () => {
      const input = '{"outer":{"inner":"value"}}';
      const result = formatToolOutputForSidebar(input);

      expect(result).toContain("```json");
      expect(result).toContain('"outer"');
      expect(result).toContain('"inner"');
    });

    it("returns plain text for non-JSON content", () => {
      const input = "This is plain text output";
      const result = formatToolOutputForSidebar(input);

      expect(result).toBe("This is plain text output");
    });

    it("returns as-is for invalid JSON starting with {", () => {
      const input = "{not valid json";
      const result = formatToolOutputForSidebar(input);

      expect(result).toBe("{not valid json");
    });

    it("returns as-is for invalid JSON starting with [", () => {
      const input = "[not valid json";
      const result = formatToolOutputForSidebar(input);

      expect(result).toBe("[not valid json");
    });

    it("trims whitespace before detecting JSON", () => {
      const input = '   {"trimmed": true}   ';
      const result = formatToolOutputForSidebar(input);

      expect(result).toContain("```json");
      expect(result).toContain('"trimmed"');
    });

    it("handles empty string", () => {
      const result = formatToolOutputForSidebar("");
      expect(result).toBe("");
    });

    it("handles whitespace-only string", () => {
      const result = formatToolOutputForSidebar("   ");
      expect(result).toBe("   ");
    });

    it("formats wallet SOL balance output without raw JSON", () => {
      const input = JSON.stringify({
        ok: true,
        result: {
          ok: true,
          chain: "solana",
          address: "DSUtCCvUSkzKdyfo3uvCE6iNPR6FBgdvAhvR4BRgmE4b",
          balance: "1149940000",
          unit: "lamports",
        },
      });

      const result = formatToolOutputForChat({ name: "wallet", text: input });

      expect(result).toContain("Balance: 1.14994 SOL");
      expect(result).toContain("Address: DSUt...mE4b");
      expect(result).not.toContain("lamports");
      expect(result).not.toContain('"ok"');
    });

    it("formats wallet SPL raw balance with decimals", () => {
      const input = JSON.stringify({
        ok: true,
        result: {
          ok: true,
          chain: "solana",
          address: "DSUtCCvUSkzKdyfo3uvCE6iNPR6FBgdvAhvR4BRgmE4b",
          balance: "42000000",
          unit: "raw",
          decimals: 6,
          program: "So11111111111111111111111111111111111111112",
        },
      });

      const result = formatToolOutputForChat({ name: "wallet", text: input });

      expect(result).toContain("Balance: 42 token");
      expect(result).toContain("Mint: So11...1112");
    });

    it("formats wallet asset lists without raw JSON", () => {
      const input = JSON.stringify({
        ok: true,
        result: {
          ok: true,
          chain: "solana",
          address: "DSUtCCvUSkzKdyfo3uvCE6iNPR6FBgdvAhvR4BRgmE4b",
          assets: [
            {
              kind: "native",
              symbol: "SOL",
              amountDisplay: "1.14994",
            },
            {
              kind: "spl-token",
              symbol: "USDC",
              amountDisplay: "42",
              program: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            },
          ],
        },
      });

      const result = formatToolOutputForChat({ name: "wallet", text: input });

      expect(result).toContain("Balances for DSUt...mE4b:");
      expect(result).toContain("SOL: 1.14994");
      expect(result).toContain("USDC: 42 (EPjF...Dt1v)");
      expect(result).not.toContain('"assets"');
    });
  });

  describe("getTruncatedPreview", () => {
    it("returns short text unchanged", () => {
      const input = "Short text";
      const result = getTruncatedPreview(input);

      expect(result).toBe("Short text");
    });

    it("truncates text longer than max chars", () => {
      const input = "a".repeat(150);
      const result = getTruncatedPreview(input);

      expect(result.length).toBe(101); // 100 chars + ellipsis
      expect(result.endsWith("…")).toBe(true);
    });

    it("truncates to max lines", () => {
      const input = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5";
      const result = getTruncatedPreview(input);

      // Should only show first 2 lines (PREVIEW_MAX_LINES = 2)
      expect(result).toBe("Line 1\nLine 2…");
    });

    it("adds ellipsis when lines are truncated", () => {
      const input = "Line 1\nLine 2\nLine 3";
      const result = getTruncatedPreview(input);

      expect(result.endsWith("…")).toBe(true);
    });

    it("does not add ellipsis when all lines fit", () => {
      const input = "Line 1\nLine 2";
      const result = getTruncatedPreview(input);

      expect(result).toBe("Line 1\nLine 2");
      expect(result.endsWith("…")).toBe(false);
    });

    it("handles single line within limits", () => {
      const input = "Single line";
      const result = getTruncatedPreview(input);

      expect(result).toBe("Single line");
    });

    it("handles empty string", () => {
      const result = getTruncatedPreview("");
      expect(result).toBe("");
    });

    it("truncates by chars even within line limit", () => {
      // Two lines but very long content
      const longLine = "x".repeat(80);
      const input = `${longLine}\n${longLine}`;
      const result = getTruncatedPreview(input);

      expect(result.length).toBe(101); // 100 + ellipsis
      expect(result.endsWith("…")).toBe(true);
    });
  });
});
