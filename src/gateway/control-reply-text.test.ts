import { describe, expect, it } from "vitest";
import { stripTrailingSuppressedControlReplyToken } from "./control-reply-text.js";

describe("stripTrailingSuppressedControlReplyToken", () => {
  it("removes a standalone trailing control-token line", () => {
    expect(
      stripTrailingSuppressedControlReplyToken("Fased local model is working.\nNO_REPLY"),
    ).toBe("Fased local model is working.");
  });

  it("keeps inline token text", () => {
    expect(stripTrailingSuppressedControlReplyToken("Explain what NO_REPLY means.")).toBe(
      "Explain what NO_REPLY means.",
    );
  });

  it("turns a control-only response into an empty display value", () => {
    expect(stripTrailingSuppressedControlReplyToken("  NO_REPLY  ")).toBe("");
  });
});
