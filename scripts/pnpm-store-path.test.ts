import { describe, expect, it } from "vitest";
import { selectPnpmStorePath } from "./pnpm-store-path.js";

describe("pnpm store path selection", () => {
  it("uses the exact absolute command result", () => {
    expect(
      selectPnpmStorePath({
        reported: "/store/v10\n",
        workspaceModulesMetadata: JSON.stringify({ storeDir: "/metadata/store" }),
      }),
    ).toBe("/store/v10");
  });

  it("uses the frozen workspace store when non-interactive pnpm emits no path", () => {
    expect(
      selectPnpmStorePath({
        reported: "",
        workspaceModulesMetadata: JSON.stringify({ storeDir: "/frozen/store/v10" }),
      }),
    ).toBe("/frozen/store/v10");
  });

  it("rejects relative command and metadata paths", () => {
    expect(() =>
      selectPnpmStorePath({
        reported: "relative/store",
        workspaceModulesMetadata: JSON.stringify({ storeDir: "/frozen/store" }),
      }),
    ).toThrow("pnpm store path is not absolute");
    expect(() =>
      selectPnpmStorePath({
        reported: "",
        workspaceModulesMetadata: JSON.stringify({ storeDir: "relative/store" }),
      }),
    ).toThrow("workspace storeDir is not absolute");
  });
});
