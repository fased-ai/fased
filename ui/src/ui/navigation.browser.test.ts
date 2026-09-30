import { describe, expect, it, vi } from "vitest";
import "../styles.css";
import { mountApp as mountTestApp, registerAppMountHooks } from "./test-helpers/app-mount.ts";

registerAppMountHooks();

function mountApp(pathname: string) {
  const app = mountTestApp(pathname);
  app.applySettings({ ...app.settings, token: "owner-token-for-workflow-navigation" });
  return app;
}

describe("control UI workflow navigation", () => {
  it("opens Overview from the root route", async () => {
    const app = mountApp("/");
    await app.updateComplete;

    expect(app.tab).toBe("overview");
    expect(window.location.pathname).toBe("/dash");
  });

  it("opens the WEN Desk on its own route", async () => {
    const app = mountApp("/wen");
    await vi.waitFor(() =>
      expect(app.textContent).toContain("Connect a WEN-enabled Fased instance"),
    );

    expect(app.tab).toBe("wen");
    expect(window.location.pathname).toBe("/wen");
    expect(app.querySelector('section[aria-label="WEN desk"]')).not.toBeNull();
    expect(app.querySelector("wen-review-panel")).toBeNull();
  });

  it("renders the flat workflow sidebar and the compact topbar actions", async () => {
    const app = mountApp("/overview");
    await app.updateComplete;

    expect(app.querySelector(".nav-label__text")).toBeNull();
    const navLabels = Array.from(app.querySelectorAll<HTMLAnchorElement>(".nav-item")).map((el) =>
      el.getAttribute("data-label"),
    );
    expect(navLabels).toEqual([
      "Dashboard",
      "WEN",
      "Agents",
      "Chat",
      "Tasks",
      "Wallets",
      "Network",
      "Modules",
    ]);
    expect(navLabels).not.toContain("Mining");
    expect(navLabels).not.toContain("Providers");
    expect(navLabels).not.toContain("Channels");
    expect(navLabels).not.toContain("Services");
    expect(navLabels).not.toContain("Marketplace");
    expect(navLabels).not.toContain("Logs");
    expect(
      app.querySelector<HTMLAnchorElement>('.topbar-icon-link[href="https://docs.fased.ai"]'),
    ).not.toBeNull();
    expect(app.querySelector(".topbar-menu__button")).not.toBeNull();
    expect(app.textContent).not.toContain("Resources");
  });

  it("shows the legacy Mining route for an attached wallet and keeps it directly routable", async () => {
    const app = mountApp("/overview");
    await app.updateComplete;
    expect(app.querySelector('a.nav-item[href="/mining"]')).toBeNull();

    app.miningAttachedWalletId = "mining";
    await app.updateComplete;
    expect(app.querySelector('a.nav-item[href="/mining"]')).not.toBeNull();

    app.miningAttachedWalletId = null;
    app.setTab("mining");
    await app.updateComplete;
    expect(app.querySelector('a.nav-item[href="/mining"]')).not.toBeNull();
  });

  it("keeps legacy Mining visible when its wallet role is registered", async () => {
    const app = mountApp("/overview");
    app.walletNamedWallets = [
      {
        id: "old-owner-wallet",
        name: "Old mining wallet",
        providerId: "local-socket-signer",
        metadata: { purpose: "mining" },
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ];
    await app.updateComplete;
    expect(app.querySelector('a.nav-item[href="/mining"]')).not.toBeNull();
  });

  it("keeps Providers routable without showing it in the sidebar", async () => {
    const app = mountApp("/overview");
    await app.updateComplete;

    const link = app.querySelector<HTMLAnchorElement>('a.nav-item[href="/providers"]');
    expect(link).toBeNull();

    app.setTab("providers");
    await app.updateComplete;
    expect(app.tab).toBe("providers");
    expect(window.location.pathname).toBe("/providers");
  });

  it("keeps Agent-owned global pages routable without showing them in the sidebar", async () => {
    const app = mountApp("/overview");
    await app.updateComplete;

    expect(app.querySelector('a.nav-item[href="/cron"]')).not.toBeNull();
    for (const href of ["/channels", "/services"]) {
      expect(app.querySelector<HTMLAnchorElement>(`a.nav-item[href="${href}"]`)).toBeNull();
    }

    app.setTab("channels");
    await app.updateComplete;
    expect(app.tab).toBe("channels");
    expect(window.location.pathname).toBe("/channels");

    app.setTab("services");
    await app.updateComplete;
    expect(app.tab).toBe("services");
    expect(window.location.pathname).toBe("/services");

    app.setTab("cron");
    await app.updateComplete;
    expect(app.tab).toBe("cron");
    expect(window.location.pathname).toBe("/cron");
  });

  it("preserves the last session when opening chat from sidebar navigation", async () => {
    const sessionKey = "agent:main:subagent:task-123";
    const app = mountApp(`/sessions?session=${encodeURIComponent(sessionKey)}`);
    app.applySettings({
      ...app.settings,
      sessionKey,
      lastActiveSessionKey: sessionKey,
    });
    await app.updateComplete;

    const link = app.querySelector<HTMLAnchorElement>('a.nav-item[href="/chat"]');
    expect(link).not.toBeNull();
    link?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));

    await app.updateComplete;
    expect(app.tab).toBe("chat");
    expect(app.sessionKey).toBe(sessionKey);
    expect(window.location.pathname).toBe("/chat");
    expect(window.location.search).toBe(`?session=${encodeURIComponent(sessionKey)}`);
  });

  it("hides nav item text in collapsed mode while keeping icons available", async () => {
    const app = mountApp("/overview");
    await app.updateComplete;

    app.applySettings({ ...app.settings, navCollapsed: true });
    await app.updateComplete;

    expect(app.querySelector(".shell--nav-collapsed")).not.toBeNull();
    expect(app.querySelector(".nav-item__text")).toBeNull();
    expect(app.querySelector(".nav-item__icon")).not.toBeNull();
  });
});
