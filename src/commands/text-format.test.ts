import { describe, expect, it } from "vitest";
import { shortenText } from "./text-format.js";

describe("shortenText", () => {
  it("returns original text when it fits", () => {
    expect(shortenText("fased", 16)).toBe("fased");
  });

  it("truncates and appends ellipsis when over limit", () => {
    expect(shortenText("fased-status-output", 10)).toBe("fased-sta…");
  });

  it("counts multi-byte characters correctly", () => {
    expect(shortenText("hello🙂world", 7)).toBe("hello🙂…");
  });
});
