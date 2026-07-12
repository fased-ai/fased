import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAuthHealthSummary,
  DEFAULT_OAUTH_WARN_MS,
  formatRemainingShort,
} from "./auth-health.js";

describe("buildAuthHealthSummary", () => {
  const now = 1_700_000_000_000;
  const profileStatuses = (summary: ReturnType<typeof buildAuthHealthSummary>) =>
    Object.fromEntries(summary.profiles.map((profile) => [profile.profileId, profile.status]));
  const profileReasonCodes = (summary: ReturnType<typeof buildAuthHealthSummary>) =>
    Object.fromEntries(summary.profiles.map((profile) => [profile.profileId, profile.reasonCode]));

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("classifies OAuth and API key profiles", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const store = {
      version: 1,
      profiles: {
        "anthropic:ok": {
          type: "oauth" as const,
          provider: "anthropic",
          access: "access",
          refresh: "refresh",
          expires: now + DEFAULT_OAUTH_WARN_MS + 60_000,
        },
        "anthropic:expiring": {
          type: "oauth" as const,
          provider: "anthropic",
          access: "access",
          refresh: "refresh",
          expires: now + 10_000,
        },
        "anthropic:expired": {
          type: "oauth" as const,
          provider: "anthropic",
          access: "access",
          refresh: "refresh",
          expires: now - 10_000,
        },
        "anthropic:api": {
          type: "api_key" as const,
          provider: "anthropic",
          key: "sk-ant-api",
        },
      },
    };

    const summary = buildAuthHealthSummary({
      store,
      warnAfterMs: DEFAULT_OAUTH_WARN_MS,
    });

    const statuses = profileStatuses(summary);

    expect(statuses["anthropic:ok"]).toBe("ok");
    expect(statuses["anthropic:expiring"]).toBe("refresh-required");
    expect(statuses["anthropic:expired"]).toBe("refresh-required");
    expect(statuses["anthropic:api"]).toBe("static");

    const provider = summary.providers.find((entry) => entry.provider === "anthropic");
    expect(provider?.status).toBe("ok");
  });

  it("does not call an untested OAuth refresh ready", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const summary = buildAuthHealthSummary({
      store: {
        version: 1,
        profiles: {
          "openai-codex:default": {
            type: "oauth" as const,
            provider: "openai-codex",
            access: "expired-access",
            refresh: "stored-refresh",
            expires: now - 1,
          },
        },
      },
    });

    expect(summary.profiles[0]?.status).toBe("refresh-required");
    expect(summary.providers[0]?.status).toBe("refresh-required");
  });

  it("reports expired for OAuth without a refresh token", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const store = {
      version: 1,
      profiles: {
        "google:no-refresh": {
          type: "oauth" as const,
          provider: "google-gemini-cli",
          access: "access",
          refresh: "",
          expires: now - 10_000,
        },
      },
    };

    const summary = buildAuthHealthSummary({
      store,
      warnAfterMs: DEFAULT_OAUTH_WARN_MS,
    });

    const statuses = profileStatuses(summary);

    expect(statuses["google:no-refresh"]).toBe("expired");
  });

  it("marks token profiles with invalid expires as missing with reason code", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const store = {
      version: 1,
      profiles: {
        "github-copilot:invalid-expires": {
          type: "token" as const,
          provider: "github-copilot",
          token: "gh-token",
          expires: 0,
        },
      },
    };

    const summary = buildAuthHealthSummary({
      store,
      warnAfterMs: DEFAULT_OAUTH_WARN_MS,
    });
    const statuses = profileStatuses(summary);
    const reasonCodes = profileReasonCodes(summary);

    expect(statuses["github-copilot:invalid-expires"]).toBe("missing");
    expect(reasonCodes["github-copilot:invalid-expires"]).toBe("invalid_expires");
  });

  it("normalizes provider aliases when filtering and grouping profile health", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const store = {
      version: 1,
      profiles: {
        "zai:dot": {
          type: "api_key" as const,
          provider: "z.ai",
          key: "sk-dot",
        },
        "zai:dash": {
          type: "api_key" as const,
          provider: "z-ai",
          key: "sk-dash",
        },
      },
    };

    const summary = buildAuthHealthSummary({
      store,
      providers: ["zai"],
    });

    expect(summary.profiles.map((profile) => [profile.profileId, profile.provider])).toEqual([
      ["zai:dash", "zai"],
      ["zai:dot", "zai"],
    ]);
    expect(summary.providers).toEqual([
      {
        provider: "zai",
        status: "static",
        profiles: summary.profiles,
      },
    ]);
  });
});

describe("formatRemainingShort", () => {
  it("supports an explicit under-minute label override", () => {
    expect(formatRemainingShort(20_000)).toBe("1m");
    expect(formatRemainingShort(20_000, { underMinuteLabel: "soon" })).toBe("soon");
  });
});
