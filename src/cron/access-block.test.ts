import { describe, expect, it } from "vitest";
import {
  detectCronTaskAccessBlockFromRun,
  detectCronTaskAccessBlockFromText,
} from "./access-block.js";

describe("cron task access block detection", () => {
  it("detects missing Brave Search API key from agent output", () => {
    const block = detectCronTaskAccessBlockFromRun({
      summary:
        "I couldn't check the market risk because the Brave Search API key is missing. Run fased configure --section web.",
      detectedAtMs: 123,
    });

    expect(block).toMatchObject({
      code: "missing_brave_api_key",
      service: "web_search",
      reason: "Missing Brave Search API key for web_search.",
      setupCommand: "fased configure --section web",
      source: "run-output",
      detectedAtMs: 123,
    });
  });

  it("detects invalidated provider auth tokens", () => {
    const block = detectCronTaskAccessBlockFromText({
      text: "Your authentication token has been invalidated. Please try signing in again.",
      source: "run-output",
      detectedAtMs: 456,
    });

    expect(block).toMatchObject({
      code: "provider_auth_invalidated",
      service: "model_provider",
      setupPath: "/providers",
    });
  });

  it("routes common service credentials to exact Services rows", () => {
    expect(
      detectCronTaskAccessBlockFromText({
        text: "GitHub token missing for gh-issues.",
        source: "run-output",
        detectedAtMs: 1,
      }),
    ).toMatchObject({
      code: "missing_github_credential",
      setupPath: "/services#service-github",
    });

    expect(
      detectCronTaskAccessBlockFromText({
        text: "Gmail Pub/Sub credential is required.",
        source: "run-output",
        detectedAtMs: 2,
      }),
    ).toMatchObject({
      code: "missing_google_workspace_credential",
      setupPath: "/services#service-google-workspace",
    });

    expect(
      detectCronTaskAccessBlockFromText({
        text: "Firecrawl API key required.",
        source: "run-output",
        detectedAtMs: 3,
      }),
    ).toMatchObject({
      code: "missing_firecrawl_credential",
      setupPath: "/services#service-firecrawl",
    });
  });

  it("routes media/browser and plugin services to exact setup rows", () => {
    expect(
      detectCronTaskAccessBlockFromText({
        text: "Browser control service is not configured for this task.",
        source: "run-output",
        detectedAtMs: 4,
      }),
    ).toMatchObject({
      code: "media_browser_unavailable",
      service: "media_browser",
      setupPath: "/services#service-media-browser",
    });

    expect(
      detectCronTaskAccessBlockFromText({
        text: "Plugin service vector-db is not loaded.",
        source: "run-output",
        detectedAtMs: 5,
      }),
    ).toMatchObject({
      code: "plugin_service_unavailable",
      service: "plugin_services",
      setupPath: "/services#service-plugin-services",
    });
  });

  it("routes channel delivery credentials to Channels", () => {
    expect(
      detectCronTaskAccessBlockFromText({
        text: "Telegram bot token missing for delivery target.",
        source: "run-output",
        detectedAtMs: 6,
      }),
    ).toMatchObject({
      code: "channel_delivery_unavailable",
      service: "channel_delivery",
      setupPath: "/channels",
    });
  });
});
