import { describe, expect, it } from "vitest";
import { collectWhatsAppStatusIssues } from "./whatsapp.js";

describe("collectWhatsAppStatusIssues", () => {
  it("reports unlinked enabled accounts", () => {
    const issues = collectWhatsAppStatusIssues([
      {
        accountId: "default",
        enabled: true,
        linked: false,
      },
    ]);

    expect(issues).toEqual([
      expect.objectContaining({
        channel: "whatsapp",
        accountId: "default",
        kind: "auth",
      }),
    ]);
  });

  it("reports linked but disconnected runtime state", () => {
    const issues = collectWhatsAppStatusIssues([
      {
        accountId: "work",
        enabled: true,
        linked: true,
        running: true,
        connected: false,
        reconnectAttempts: 2,
        lastError: "socket closed",
      },
    ]);

    expect(issues).toEqual([
      expect.objectContaining({
        channel: "whatsapp",
        accountId: "work",
        kind: "runtime",
        message: "Linked but disconnected (reconnectAttempts=2): socket closed",
      }),
    ]);
  });

  it("does not infer stale local TUI responsiveness from activity timestamps alone", () => {
    const issues = collectWhatsAppStatusIssues([
      {
        accountId: "default",
        enabled: true,
        linked: true,
        running: true,
        connected: true,
        lastInboundAt: Date.now() - 86_400_000,
        lastOutboundAt: Date.now() - 86_400_000,
      },
    ]);

    expect(issues).toEqual([]);
  });

  it("skips disabled accounts", () => {
    const issues = collectWhatsAppStatusIssues([
      {
        accountId: "disabled",
        enabled: false,
        linked: false,
      },
    ]);
    expect(issues).toEqual([]);
  });
});
