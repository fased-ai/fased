import { describe, expect, it } from "vitest";
import { formatLineAddressForLog, formatLineIdForLog } from "./logging.js";

describe("LINE log formatting", () => {
  it("redacts long LINE ids", () => {
    expect(formatLineIdForLog("U1234567890abcdef")).toBe("U12...def");
  });

  it("fully redacts short ids", () => {
    expect(formatLineIdForLog("U123")).toBe("<redacted>");
  });

  it("preserves LINE address kind while redacting the id", () => {
    expect(formatLineAddressForLog("line:group:C1234567890")).toBe("line:group:C12...890");
  });
});
