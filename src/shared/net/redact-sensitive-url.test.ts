import { describe, expect, it } from "vitest";
import { redactSensitiveUrl, redactSensitiveUrlLikeString } from "./redact-sensitive-url.js";

describe("redactSensitiveUrl", () => {
  it("redacts credentials and sensitive query parameters", () => {
    expect(redactSensitiveUrl("https://user:pass@example.com/file.jpg?token=secret&ok=1")).toBe(
      "https://***:***@example.com/file.jpg?token=***&ok=1",
    );
  });

  it("redacts Telegram bot tokens embedded in file download paths", () => {
    expect(
      redactSensitiveUrl("https://api.telegram.org/file/bot123456:ABC_secret/photos/file.jpg"),
    ).toBe("https://api.telegram.org/file/bot***/photos/file.jpg");
  });
});

describe("redactSensitiveUrlLikeString", () => {
  it("redacts Telegram file URLs inside error strings", () => {
    expect(
      redactSensitiveUrlLikeString(
        "failed https://api.telegram.org/file/bot123456:ABC_secret/photos/file.jpg",
      ),
    ).toBe("failed https://api.telegram.org/file/bot***/photos/file.jpg");
  });
});
