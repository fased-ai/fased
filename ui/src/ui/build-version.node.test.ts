import { describe, expect, it } from "vitest";
import { controlUiVersionMismatch } from "./build-version.ts";

describe("controlUiVersionMismatch", () => {
  it("accepts matching release versions", () => {
    expect(controlUiVersionMismatch("0.1.54", "0.1.54")).toBe(false);
  });

  it("rejects stale browser assets from an upgraded runtime", () => {
    expect(controlUiVersionMismatch("0.1.54", "0.1.53")).toBe(true);
  });

  it("does not block the Vite development build", () => {
    expect(controlUiVersionMismatch("0.1.54", "dev")).toBe(false);
  });
});
