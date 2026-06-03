import { describe, expect, it } from "vitest";
import {
  classifyFailoverReason,
  isAuthErrorMessage,
  isBillingErrorMessage,
} from "./pi-embedded-helpers.js";

describe("Z.ai failover code handling", () => {
  it("treats code 1113 payloads as auth errors", () => {
    const payload = '{"error":{"code":1113,"message":"auth failed"}}';
    expect(isAuthErrorMessage(payload)).toBe(true);
    expect(classifyFailoverReason(payload)).toBe("auth");
  });

  it("treats code 1311 payloads as billing errors, including long payloads", () => {
    const payload =
      '{"error":{"code":1311,"message":"subscription does not include this model","details":"' +
      "x".repeat(700) +
      '"}}';
    expect(payload.length).toBeGreaterThan(512);
    expect(isBillingErrorMessage(payload)).toBe(true);
    expect(classifyFailoverReason(payload)).toBe("billing");
  });
});
