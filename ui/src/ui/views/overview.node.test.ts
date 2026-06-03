import { describe, expect, it } from "vitest";
import { ConnectErrorDetailCodes } from "../../../../src/gateway/protocol/connect-error-details.js";
import { DEFAULT_DASHBOARD_LAYOUT } from "../dashboard-layout.ts";
import { shouldShowPairingHint } from "./overview-hints.ts";
import { renderOverview } from "./overview.ts";

type LitTemplateLike = {
  strings?: ArrayLike<string>;
  values?: unknown[];
};

function flattenTemplateText(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((entry) => flattenTemplateText(entry)).join(" ");
  }
  if (value && typeof value === "object") {
    const template = value as LitTemplateLike;
    if (template.strings && Array.isArray(template.values)) {
      return [
        ...Array.from(template.strings),
        ...template.values.map((entry) => flattenTemplateText(entry)),
      ].join(" ");
    }
  }
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

describe("shouldShowPairingHint", () => {
  it("returns true for 'pairing required' close reason", () => {
    expect(shouldShowPairingHint(false, "disconnected (1008): pairing required")).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(shouldShowPairingHint(false, "Pairing Required")).toBe(true);
  });

  it("returns false when connected", () => {
    expect(shouldShowPairingHint(true, "disconnected (1008): pairing required")).toBe(false);
  });

  it("returns false when lastError is null", () => {
    expect(shouldShowPairingHint(false, null)).toBe(false);
  });

  it("returns false for unrelated errors", () => {
    expect(shouldShowPairingHint(false, "disconnected (1006): no reason")).toBe(false);
  });

  it("returns false for auth errors", () => {
    expect(shouldShowPairingHint(false, "disconnected (4008): unauthorized")).toBe(false);
  });

  it("returns true for structured pairing code", () => {
    expect(
      shouldShowPairingHint(
        false,
        "disconnected (4008): connect failed",
        ConnectErrorDetailCodes.PAIRING_REQUIRED,
      ),
    ).toBe(true);
  });
});

describe("renderOverview task counts", () => {
  it("counts saved Task definitions instead of active queue runs", () => {
    const text = flattenTemplateText(
      renderOverview({
        onboarding: false,
        managedMode: false,
        basePath: "",
        connected: true,
        hello: null,
        settings: {} as never,
        password: "",
        canSignOut: false,
        loginGrantInput: "",
        loginGrantPending: false,
        loginGrantError: null,
        lastError: null,
        authNotice: null,
        authSessionExpiresAt: null,
        authSessionIdleTimeoutSeconds: null,
        overviewAdvancedUnlocked: false,
        overviewSecretsRevealUntilMs: 0,
        presenceCount: 0,
        sessionsCount: 0,
        cronEnabled: true,
        cronJobs: 7,
        cronActiveTasks: 0,
        cronNext: null,
        lastChannelsRefresh: null,
        agentsList: {
          defaultId: "main",
          mainKey: "main",
          scope: "workspace",
          agents: [{ id: "main", name: "Assistant" } as never],
        },
        walletNamedWallets: [],
        dashboardLayout: DEFAULT_DASHBOARD_LAYOUT,
        dashboardWidgetDrawerOpen: false,
        onSettingsChange: () => undefined,
        onPasswordChange: () => undefined,
        onAuthStorageModeChange: () => undefined,
        onLoginGrantInputChange: () => undefined,
        onLoginGrantExchange: () => undefined,
        onSignOut: () => undefined,
        onUnlockAdvanced: () => undefined,
        onLockAdvanced: () => undefined,
        onRevealSecrets: () => undefined,
        onConnect: () => undefined,
        onRefresh: () => undefined,
        onDashboardLayoutChange: () => undefined,
        onDashboardWidgetDrawerOpen: () => undefined,
      }),
    );

    expect(text).toContain("Saved Task definitions");
    expect(text).toContain("7");
    expect(text).not.toContain("Active scheduled task runs");
  });

  it("links dashboard task and session cards into the Agent workbench", () => {
    const text = flattenTemplateText(
      renderOverview({
        onboarding: false,
        managedMode: false,
        basePath: "",
        connected: true,
        hello: null,
        settings: {} as never,
        password: "",
        canSignOut: false,
        loginGrantInput: "",
        loginGrantPending: false,
        loginGrantError: null,
        lastError: null,
        authNotice: null,
        authSessionExpiresAt: null,
        authSessionIdleTimeoutSeconds: null,
        overviewAdvancedUnlocked: false,
        overviewSecretsRevealUntilMs: 0,
        presenceCount: 0,
        sessionsCount: 3,
        cronEnabled: true,
        cronJobs: 2,
        cronActiveTasks: 0,
        cronNext: null,
        lastChannelsRefresh: null,
        agentsList: {
          defaultId: "main",
          mainKey: "main",
          scope: "workspace",
          agents: [{ id: "main", name: "Assistant" } as never],
        },
        walletNamedWallets: [],
        dashboardLayout: DEFAULT_DASHBOARD_LAYOUT,
        dashboardWidgetDrawerOpen: false,
        onSettingsChange: () => undefined,
        onPasswordChange: () => undefined,
        onAuthStorageModeChange: () => undefined,
        onLoginGrantInputChange: () => undefined,
        onLoginGrantExchange: () => undefined,
        onSignOut: () => undefined,
        onUnlockAdvanced: () => undefined,
        onLockAdvanced: () => undefined,
        onRevealSecrets: () => undefined,
        onConnect: () => undefined,
        onRefresh: () => undefined,
        onDashboardLayoutChange: () => undefined,
        onDashboardWidgetDrawerOpen: () => undefined,
      }),
    );

    expect(text).toContain("/agents");
    expect(text).not.toContain("/cron");
    expect(text).not.toContain("/sessions");
  });
});
