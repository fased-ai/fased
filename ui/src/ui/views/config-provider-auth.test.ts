import { describe, expect, it } from "vitest";
import {
  buildProviderAuthActionGuidance,
  buildProviderAuthActionCommand,
  buildProviderAuthActionSummary,
  buildOrderedProviderProfiles,
  buildProviderAuthState,
  buildPreferredProviderOrder,
  buildProviderAuthSummary,
  canReopenProviderAuthActionUrl,
  canRetryProviderAuthAction,
  calloutClassForProviderAuthActionTone,
  formatProviderAuthRuntimeStatus,
  labelForInteractiveProviderAuthAction,
  labelForProviderAuthActionStep,
  moveProviderAuthProfile,
  removeProviderAuthProfile,
  resolveProviderAuthLiveProfileStatus,
  resolveEditableProviderAuthModes,
  upsertProviderAuthProfile,
  validateProviderAuthProfileDraft,
} from "./config.ts";

describe("config provider auth summary", () => {
  it("summarizes configured provider auth and model coverage", () => {
    const summary = buildProviderAuthSummary({
      gateway: { auth: { mode: "token" } },
      auth: {
        profiles: {
          "openai:api": { provider: "openai", mode: "api_key" },
          "acme:oauth": { provider: "acme-cloud", mode: "oauth", email: "ops@example.com" },
        },
        order: {
          openai: ["openai:api"],
          "acme-cloud": ["acme:oauth"],
        },
      },
      models: {
        providers: {
          openai: { auth: "api-key", models: [{ id: "gpt-5.5" }] },
          "acme-cloud": { auth: "oauth", models: [{ id: "acme-pro" }, { id: "acme-lite" }] },
        },
      },
    });

    expect(summary.gatewayAuthMode).toBe("token");
    expect(summary.totalProfiles).toBe(2);
    expect(summary.totalProviders).toBe(2);
    expect(summary.profileModeCounts.api_key).toBe(1);
    expect(summary.profileModeCounts.oauth).toBe(1);
    expect(summary.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "openai",
          modelCount: 1,
          authMode: "api-key",
          orderedProfileIds: ["openai:api"],
        }),
        expect.objectContaining({
          id: "acme-cloud",
          modelCount: 2,
          authMode: "oauth",
          orderedProfileIds: ["acme:oauth"],
        }),
      ]),
    );
  });

  it("returns an empty summary when provider auth is not configured yet", () => {
    const summary = buildProviderAuthSummary({});

    expect(summary.gatewayAuthMode).toBeNull();
    expect(summary.totalProfiles).toBe(0);
    expect(summary.totalProviders).toBe(0);
    expect(summary.providers).toEqual([]);
    expect(summary.profileModeCounts).toEqual({
      api_key: 0,
      oauth: 0,
      token: 0,
      unknown: 0,
    });
  });

  it("derives editable auth modes from provider config and auth profiles", () => {
    const modes = resolveEditableProviderAuthModes({
      authMode: "oauth",
      hasApiKey: true,
      profiles: [
        { id: "openai:api", mode: "api_key" },
        { id: "openai:oauth", mode: "oauth" },
        { id: "openai:token", mode: "token" },
      ],
    });

    expect(modes).toEqual(["api-key", "oauth", "token"]);
  });

  it("promotes the selected profile to the front of auth.order while preserving other profiles", () => {
    const order = buildPreferredProviderOrder(
      {
        orderedProfileIds: ["openai:oauth"],
        profiles: [
          { id: "openai:api", mode: "api_key" },
          { id: "openai:oauth", mode: "oauth" },
          { id: "openai:token", mode: "token" },
        ],
      },
      "openai:token",
    );

    expect(order).toEqual(["openai:token", "openai:oauth", "openai:api"]);
  });

  it("renders provider profiles in auth.order and appends missing profiles afterward", () => {
    const ordered = buildOrderedProviderProfiles({
      orderedProfileIds: ["openai:oauth"],
      profiles: [
        { id: "openai:api", mode: "api_key" },
        { id: "openai:oauth", mode: "oauth" },
        { id: "openai:token", mode: "token" },
      ],
    });

    expect(ordered.map((profile) => profile.id)).toEqual([
      "openai:oauth",
      "openai:api",
      "openai:token",
    ]);
  });

  it("reconstructs editable auth state from the rendered summary", () => {
    const summary = buildProviderAuthSummary({
      auth: {
        profiles: {
          "openai:api": { provider: "openai", mode: "api_key" },
          "openai:oauth": { provider: "openai", mode: "oauth", email: "ops@example.com" },
        },
        order: {
          openai: ["openai:oauth"],
        },
      },
    });

    expect(buildProviderAuthState(summary)).toEqual({
      profiles: {
        "openai:api": { provider: "openai", mode: "api_key" },
        "openai:oauth": {
          provider: "openai",
          mode: "oauth",
          email: "ops@example.com",
        },
      },
      order: {
        openai: ["openai:oauth", "openai:api"],
      },
    });
  });

  it("adds a new profile and appends it to provider order", () => {
    const next = upsertProviderAuthProfile(
      {
        profiles: {
          "openai:api": { provider: "openai", mode: "api_key" },
        },
        order: {
          openai: ["openai:api"],
        },
      },
      {
        id: "openai:oauth",
        provider: "openai",
        mode: "oauth",
        email: "ops@example.com",
      },
    );

    expect(next).toEqual({
      profiles: {
        "openai:api": { provider: "openai", mode: "api_key" },
        "openai:oauth": {
          provider: "openai",
          mode: "oauth",
          email: "ops@example.com",
        },
      },
      order: {
        openai: ["openai:api", "openai:oauth"],
      },
    });
  });

  it("moves a profile between providers and repairs auth order", () => {
    const next = upsertProviderAuthProfile(
      {
        profiles: {
          "openai:api": { provider: "openai", mode: "api_key" },
          "openai:oauth": { provider: "openai", mode: "oauth" },
          "acme:oauth": { provider: "acme-cloud", mode: "oauth" },
        },
        order: {
          openai: ["openai:api", "openai:oauth"],
          "acme-cloud": ["acme:oauth"],
        },
      },
      {
        id: "openai:oauth",
        provider: "acme-cloud",
        mode: "token",
      },
    );

    expect(next).toEqual({
      profiles: {
        "openai:api": { provider: "openai", mode: "api_key" },
        "openai:oauth": { provider: "acme-cloud", mode: "token" },
        "acme:oauth": { provider: "acme-cloud", mode: "oauth" },
      },
      order: {
        openai: ["openai:api"],
        "acme-cloud": ["acme:oauth", "openai:oauth"],
      },
    });
  });

  it("removes a profile and cleans up empty provider order buckets", () => {
    const next = removeProviderAuthProfile(
      {
        profiles: {
          "openai:api": { provider: "openai", mode: "api_key" },
          "acme:oauth": { provider: "acme-cloud", mode: "oauth" },
        },
        order: {
          openai: ["openai:api"],
          "acme-cloud": ["acme:oauth"],
        },
      },
      "openai:api",
    );

    expect(next).toEqual({
      profiles: {
        "acme:oauth": { provider: "acme-cloud", mode: "oauth" },
      },
      order: {
        "acme-cloud": ["acme:oauth"],
      },
    });
  });

  it("moves a provider profile up within auth.order", () => {
    const next = moveProviderAuthProfile(
      {
        profiles: {
          "openai:api": { provider: "openai", mode: "api_key" },
          "openai:oauth": { provider: "openai", mode: "oauth" },
          "openai:token": { provider: "openai", mode: "token" },
        },
        order: {
          openai: ["openai:api", "openai:oauth", "openai:token"],
        },
      },
      "openai",
      "openai:token",
      "up",
    );

    expect(next.order).toEqual({
      openai: ["openai:api", "openai:token", "openai:oauth"],
    });
  });

  it("keeps auth.order unchanged when moving beyond the reorder bounds", () => {
    const state = {
      profiles: {
        "openai:api": { provider: "openai", mode: "api_key" as const },
        "openai:oauth": { provider: "openai", mode: "oauth" as const },
      },
      order: {
        openai: ["openai:api", "openai:oauth"],
      },
    };

    expect(moveProviderAuthProfile(state, "openai", "openai:api", "up")).toEqual(state);
    expect(moveProviderAuthProfile(state, "openai", "openai:oauth", "down")).toEqual(state);
  });

  it("rejects duplicate profile ids when adding a new profile", () => {
    const errors = validateProviderAuthProfileDraft(
      {
        profiles: {
          "openai:api": { provider: "openai", mode: "api_key" },
        },
        order: {
          openai: ["openai:api"],
        },
      },
      {
        id: "openai:api",
        provider: "openai",
        mode: "api_key",
      },
    );

    expect(errors).toEqual({
      id: "Profile id already exists.",
    });
  });

  it("rejects provider ids that do not match the profile id prefix", () => {
    const errors = validateProviderAuthProfileDraft(
      {
        profiles: {},
        order: {},
      },
      {
        id: "openai:manual",
        provider: "anthropic",
        mode: "oauth",
      },
    );

    expect(errors).toEqual({
      provider: 'Provider should match the profile id prefix "openai".',
    });
  });

  it("allows editing an existing profile without treating its current id as a duplicate", () => {
    const errors = validateProviderAuthProfileDraft(
      {
        profiles: {
          "openai:oauth": { provider: "openai", mode: "oauth", email: "ops@example.com" },
        },
        order: {
          openai: ["openai:oauth"],
        },
      },
      {
        id: "openai:oauth",
        provider: "openai",
        mode: "oauth",
        email: "ops@example.com",
      },
      "openai:oauth",
    );

    expect(errors).toEqual({});
  });

  it("rejects invalid email addresses in auth profile drafts", () => {
    const errors = validateProviderAuthProfileDraft(
      {
        profiles: {},
        order: {},
      },
      {
        id: "openai:oauth",
        provider: "openai",
        mode: "oauth",
        email: "not-an-email",
      },
    );

    expect(errors).toEqual({
      email: "Enter a valid email address.",
    });
  });

  it("builds provider auth action commands for interactive remediation", () => {
    expect(
      buildProviderAuthActionCommand({
        provider: "openai",
        profileId: "openai:oauth",
        mode: "oauth",
      }),
    ).toBe("pnpm fased models auth login --provider openai");
    expect(
      buildProviderAuthActionCommand({
        provider: "anthropic",
        profileId: "anthropic:manual",
        mode: "token",
      }),
    ).toBe("pnpm fased models auth paste-token --provider anthropic --profile-id anthropic:manual");
  });

  it("formats runtime auth status labels for the config card", () => {
    expect(
      formatProviderAuthRuntimeStatus({
        status: "expiring",
        remainingMs: 90 * 60_000,
      }),
    ).toBe("expiring · 2h");
    expect(
      formatProviderAuthRuntimeStatus({
        status: "ok",
        unusableKind: "disabled",
        unusableReason: "billing",
      }),
    ).toBe("disabled: billing");
  });

  it("resolves live provider auth status by provider/profile id", () => {
    expect(
      resolveProviderAuthLiveProfileStatus(
        {
          storePath: "~/.fased/auth-profiles.json",
          warnAfterMs: 86_400_000,
          providers: [
            {
              provider: "openai",
              status: "ok",
              effective: {
                kind: "profiles",
                detail: "~/.fased/auth-profiles.json",
              },
              profiles: [
                {
                  profileId: "openai:oauth",
                  provider: "openai",
                  type: "oauth",
                  status: "ok",
                  label: "openai:oauth ops@example.com",
                  source: "store",
                },
              ],
            },
          ],
        },
        "openai",
        "openai:oauth",
      ),
    ).toMatchObject({
      profileId: "openai:oauth",
      provider: "openai",
      status: "ok",
    });
  });

  it("maps provider auth action tone to the expected callout class", () => {
    expect(calloutClassForProviderAuthActionTone("info")).toBe("callout info");
    expect(calloutClassForProviderAuthActionTone("warn")).toBe("callout warn");
    expect(calloutClassForProviderAuthActionTone("danger")).toBe("callout danger");
  });

  it("shows specific busy labels for interactive provider auth steps", () => {
    expect(
      labelForInteractiveProviderAuthAction(true, {
        profileId: "openrouter:oauth",
        tone: "info",
        title: "Open browser",
        message: "Continue in the provider page.",
        detail: "A browser tab should open.",
        stepType: "note",
        active: true,
        hasUrl: true,
      }),
    ).toBe("Open browser…");

    expect(
      labelForInteractiveProviderAuthAction(true, {
        profileId: "openrouter:oauth",
        tone: "info",
        title: "Choose account",
        message: "Pick an account.",
        stepType: "select",
        active: true,
      }),
    ).toBe("Awaiting choice…");

    expect(labelForInteractiveProviderAuthAction(false, null)).toBe("Run sign-in");
  });

  it("derives step labels for provider auth callouts", () => {
    expect(
      labelForProviderAuthActionStep({
        profileId: "openrouter:oauth",
        actionKind: "interactive",
        tone: "info",
        title: "Open browser",
        message: "Visit the provider page.",
        stepType: "note",
        active: true,
        hasUrl: true,
        url: "https://example.com/device",
      }),
    ).toBe("browser step");
    expect(
      labelForProviderAuthActionStep({
        profileId: "openrouter:oauth",
        actionKind: "interactive",
        tone: "info",
        title: "Choose account",
        message: "Pick an account.",
        stepType: "select",
        active: true,
      }),
    ).toBe("single choice");
  });

  it("only offers retry and reopen affordances when interactive auth state supports them", () => {
    expect(
      canRetryProviderAuthAction({
        profileId: "openrouter:oauth",
        provider: "openrouter",
        actionKind: "interactive",
        tone: "warn",
        title: "Cancelled sign-in",
        message: "Try again.",
        active: false,
        retryable: true,
      }),
    ).toBe(true);

    expect(
      canReopenProviderAuthActionUrl({
        profileId: "openrouter:oauth",
        provider: "openrouter",
        actionKind: "interactive",
        tone: "warn",
        title: "Cancelled sign-in",
        message: "Try again.",
        active: false,
        url: "https://example.com/device",
      }),
    ).toBe(true);

    expect(
      canRetryProviderAuthAction({
        profileId: "openrouter:oauth",
        actionKind: "store",
        tone: "danger",
        title: "Failed to save",
        message: "No change.",
        active: false,
        retryable: true,
      }),
    ).toBe(false);
  });

  it("builds completion summaries for interactive and direct auth actions", () => {
    expect(
      buildProviderAuthActionSummary({
        profileId: "openrouter:oauth",
        provider: "openrouter",
        actionKind: "interactive",
        tone: "success",
        title: "Completed sign-in",
        message: "Done.",
        active: false,
      }),
    ).toBe("openrouter · openrouter:oauth sign-in completed.");

    expect(
      buildProviderAuthActionSummary({
        profileId: "openai:api",
        provider: "openai",
        actionKind: "store",
        tone: "danger",
        title: "Failed to save",
        message: "No change.",
        active: false,
      }),
    ).toBe("openai · openai:api credential update failed.");
  });

  it("builds next-step guidance for active and completed interactive auth actions", () => {
    expect(
      buildProviderAuthActionGuidance({
        profileId: "openrouter:oauth",
        provider: "openrouter",
        actionKind: "interactive",
        tone: "info",
        title: "Open browser",
        message: "Continue in browser.",
        stepType: "note",
        active: true,
        hasUrl: true,
        url: "https://example.com/device",
      }),
    ).toEqual([
      "Finish the provider page in your browser, then return here for the next prompt.",
      "Keep this Config card open so the next step stays visible.",
    ]);

    expect(
      buildProviderAuthActionGuidance({
        profileId: "openrouter:oauth",
        provider: "openrouter",
        actionKind: "interactive",
        tone: "warn",
        title: "Cancelled sign-in",
        message: "Try again.",
        active: false,
        retryable: true,
        url: "https://example.com/device",
      }),
    ).toEqual([
      "Use Retry sign-in to continue from this profile.",
      "Use Open sign-in page again if the provider browser page was already opened.",
    ]);
  });
});
