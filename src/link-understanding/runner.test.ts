import { describe, expect, it } from "vitest";
import { formatLinkCommandForLog, formatLinkUrlForLog } from "./runner.js";

describe("link understanding log formatting", () => {
  it("redacts URL query and hash values", () => {
    expect(formatLinkUrlForLog("https://example.com/path?token=secret#frag")).toBe(
      "https://example.com/path?<redacted>#<redacted>",
    );
  });

  it("redacts URL values in command previews", () => {
    const rawUrl = "https://example.com/path?api_key=secret";
    const formatted = formatLinkCommandForLog(["fetch-link", "--url", rawUrl], rawUrl);

    expect(formatted).toBe("fetch-link --url https://example.com/path?<redacted>");
    expect(formatted).not.toContain("secret");
  });
});
