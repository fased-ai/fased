import { describe, expect, it } from "vitest";
import "../styles.css";
import { mountApp as mountTestApp, registerAppMountHooks } from "./test-helpers/app-mount.ts";

registerAppMountHooks();

function mountApp(pathname: string) {
  const app = mountTestApp(pathname);
  app.applySettings({
    ...app.settings,
    token: "owner-token-for-browser-test",
  });
  return app;
}

describe("dashboard header breadcrumb", () => {
  it("renders the dashboard breadcrumb as an overview link", async () => {
    const app = mountApp("/channels");
    await app.updateComplete;

    const breadcrumb = app.querySelector<HTMLAnchorElement>(
      "dashboard-header .dashboard-header__breadcrumb-link",
    );
    expect(breadcrumb).toBeInstanceOf(HTMLAnchorElement);
    expect(breadcrumb?.getAttribute("href")).toBe("/dash");

    breadcrumb?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await app.updateComplete;

    expect(app.tab).toBe("overview");
    expect(window.location.pathname).toBe("/dash");
  });

  it("keeps dashboard breadcrumb routing inside the configured base path", async () => {
    const app = mountApp("/ui/channels");
    await app.updateComplete;

    const breadcrumb = app.querySelector<HTMLAnchorElement>(
      "dashboard-header .dashboard-header__breadcrumb-link",
    );
    expect(breadcrumb).toBeInstanceOf(HTMLAnchorElement);
    expect(breadcrumb?.getAttribute("href")).toBe("/ui/dash");
  });

  it("keeps chat controls in the topbar without rendering a second chat header", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    expect(app.querySelector("dashboard-header")).toBeNull();
    expect(app.querySelector(".content-header")).toBeNull();
    expect(app.querySelector(".topbar-chat-controls .chat-controls")).not.toBeNull();
    expect(app.querySelector(".chat-topbar-panels")).not.toBeNull();
    expect(app.querySelector(".topbar-chat-controls .chat-cron-filter-icon")).not.toBeNull();
    expect(app.querySelector('[title="Refresh chat data"]')).toBeNull();
    expect(app.querySelector('[title="New chat"]')).not.toBeNull();
    expect(app.querySelector('[title="Reset current chat"]')).not.toBeNull();
    expect(
      app.querySelector('.chat-topbar-panel--tasks [aria-label="Tasks for this chat"]'),
    ).not.toBeNull();
    expect(app.querySelector(".chat > .chat-usage-summary")).toBeNull();
  });

  it("closes topbar dropdown panels when clicking outside them", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    const stats = app.querySelector<HTMLDetailsElement>(".chat-topbar-panel--stats");
    expect(stats).not.toBeNull();
    stats!.open = true;
    app.querySelector(".chat")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await app.updateComplete;
    expect(stats!.open).toBe(false);

    const menu = app.querySelector<HTMLDetailsElement>(".topbar-menu");
    expect(menu).not.toBeNull();
    menu!.open = true;
    app.querySelector(".chat")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await app.updateComplete;
    expect(menu!.open).toBe(false);
  });

  it("switches sessions from the chat topbar session picker", async () => {
    const app = mountApp("/chat");
    app.sessionKey = "agent:main:main";
    app.sessionsResult = {
      ts: 0,
      path: "",
      count: 2,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [
        { key: "agent:main:main", kind: "direct", updatedAt: 100, label: "Local chat" },
        {
          key: "agent:main:webchat:direct:abc123",
          kind: "direct",
          updatedAt: 200,
          label: "Follow-up chat",
        },
      ],
    };
    await app.updateComplete;

    const target = Array.from(
      app.querySelectorAll<HTMLButtonElement>(".chat-session-list__item"),
    ).find((button) => button.title === "agent:main:webchat:direct:abc123");
    expect(target).not.toBeNull();
    target?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await app.updateComplete;

    expect(app.sessionKey).toBe("agent:main:webchat:direct:abc123");
  });
});
