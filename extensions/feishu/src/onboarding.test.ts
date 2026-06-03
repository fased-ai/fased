import { describe, expect, it } from "vitest";
import { feishuOnboardingAdapter } from "./onboarding.js";

describe("feishu onboarding", () => {
  it("exposes UI setup fields that match the CLI credential flow", () => {
    expect(feishuOnboardingAdapter.uiSetup).toMatchObject({
      title: "Feishu",
      detail: "App credentials.",
      notes: expect.arrayContaining([
        expect.stringContaining("Feishu Open Platform"),
        expect.stringContaining("App ID and App Secret"),
      ]),
      fields: expect.arrayContaining([
        expect.objectContaining({ label: "App ID", path: ["channels", "feishu", "appId"] }),
        expect.objectContaining({
          label: "App Secret",
          path: ["channels", "feishu", "appSecret"],
          kind: "password",
        }),
        expect.objectContaining({
          label: "Domain",
          path: ["channels", "feishu", "domain"],
          kind: "select",
        }),
        expect.objectContaining({
          label: "Connection mode",
          path: ["channels", "feishu", "connectionMode"],
          kind: "select",
        }),
        expect.objectContaining({
          label: "Group allowlist",
          path: ["channels", "feishu", "groupAllowFrom"],
          kind: "list",
        }),
      ]),
    });
    expect(feishuOnboardingAdapter.uiSetup?.access).toBeUndefined();
  });
});
