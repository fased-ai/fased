import { beforeEach, describe, expect, it } from "vitest";
import { markControlUiBootStage } from "./boot-state.ts";

describe("markControlUiBootStage", () => {
  beforeEach(() => {
    delete window.__FASED_CONTROL_UI_BOOT;
  });

  it("does not downgrade a ready boot stage when an earlier async marker resolves later", () => {
    markControlUiBootStage("entry-loaded");
    markControlUiBootStage("first-updated");
    markControlUiBootStage("app-imported");

    expect(window.__FASED_CONTROL_UI_BOOT?.stage).toBe("first-updated");
  });

  it("allows boot failures to replace earlier stages", () => {
    markControlUiBootStage("first-updated");
    markControlUiBootStage("boot-failed", "late runtime failure");

    expect(window.__FASED_CONTROL_UI_BOOT).toMatchObject({
      stage: "boot-failed",
      detail: "late runtime failure",
    });
  });
});
