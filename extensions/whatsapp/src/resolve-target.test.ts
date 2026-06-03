import { describe, expect, it, vi } from "vitest";
import { installCommonResolveTargetErrorCases } from "../../shared/resolve-target-test-helpers.js";

vi.mock("fased/plugin-sdk", () => ({
  getChatChannelMeta: () => ({ id: "whatsapp", label: "WhatsApp" }),
  normalizeWhatsAppTarget: (value: string) => {
    if (value === "invalid-target") return null;
    // Simulate E.164 normalization: strip leading + and whatsapp: prefix
    const stripped = value.replace(/^whatsapp:/i, "").replace(/^\+/, "");
    return stripped.includes("@g.us") ? stripped : `${stripped}@s.whatsapp.net`;
  },
  isWhatsAppGroupJid: (value: string) => value.endsWith("@g.us"),
  resolveWhatsAppOutboundTarget: ({
    to,
    allowFrom,
    mode,
  }: {
    to?: string;
    allowFrom: string[];
    mode: "explicit" | "implicit";
  }) => {
    const raw = typeof to === "string" ? to.trim() : "";
    if (!raw) {
      return { ok: false, error: new Error("missing target") };
    }
    const normalizeWhatsAppTarget = (value: string) => {
      if (value === "invalid-target") return null;
      const stripped = value.replace(/^whatsapp:/i, "").replace(/^\+/, "");
      return stripped.includes("@g.us") ? stripped : `${stripped}@s.whatsapp.net`;
    };
    const normalized = normalizeWhatsAppTarget(raw);
    if (!normalized) {
      return { ok: false, error: new Error("invalid target") };
    }

    if (mode === "implicit" && !normalized.endsWith("@g.us")) {
      const allowAll = allowFrom.includes("*");
      const allowExact = allowFrom.some((entry) => {
        if (!entry) {
          return false;
        }
        const normalizedEntry = normalizeWhatsAppTarget(entry.trim());
        return normalizedEntry?.toLowerCase() === normalized.toLowerCase();
      });
      if (!allowAll && !allowExact) {
        return { ok: false, error: new Error("target not allowlisted") };
      }
    }

    return { ok: true, to: normalized };
  },
  missingTargetError: (provider: string, hint: string) =>
    new Error(`Delivering to ${provider} requires target ${hint}`),
  WhatsAppConfigSchema: {},
  whatsappOnboardingAdapter: {},
  resolveWhatsAppHeartbeatRecipients: vi.fn(),
  buildChannelConfigSchema: vi.fn(),
  collectWhatsAppStatusIssues: vi.fn(),
  createActionGate: vi.fn(),
  DEFAULT_ACCOUNT_ID: "default",
  escapeRegExp: vi.fn(),
  formatPairingApproveHint: vi.fn(),
  listWhatsAppAccountIds: vi.fn(),
  listWhatsAppDirectoryGroupsFromConfig: vi.fn(),
  listWhatsAppDirectoryPeersFromConfig: vi.fn(),
  looksLikeWhatsAppTargetId: vi.fn(),
  migrateBaseNameToDefaultAccount: vi.fn(),
  normalizeAccountId: vi.fn(),
  normalizeE164: vi.fn(),
  normalizeWhatsAppMessagingTarget: vi.fn(),
  readStringParam: vi.fn(),
  resolveDefaultWhatsAppAccountId: vi.fn(),
  resolveWhatsAppAccount: vi.fn(),
  resolveWhatsAppGroupIntroHint: vi.fn(),
  resolveWhatsAppGroupRequireMention: vi.fn(),
  resolveWhatsAppGroupToolPolicy: vi.fn(),
  resolveWhatsAppMentionStripPatterns: vi.fn(() => []),
  applyAccountNameToChannelSection: vi.fn(),
}));

vi.mock("./runtime.js", () => ({
  getWhatsAppRuntime: vi.fn(() => ({
    channel: {
      text: { chunkText: vi.fn() },
      whatsapp: {
        sendMessageWhatsApp: vi.fn(),
        createLoginTool: vi.fn(),
      },
    },
  })),
}));

import { whatsappPlugin } from "./channel.js";

const resolveTarget = whatsappPlugin.outbound!.resolveTarget!;

describe("whatsapp resolveTarget", () => {
  it("should resolve valid target in explicit mode", () => {
    const result = resolveTarget({
      to: "5511999999999",
      mode: "explicit",
      allowFrom: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw result.error;
    }
    expect(result.to).toBe("5511999999999@s.whatsapp.net");
  });

  it("should resolve target in implicit mode with wildcard", () => {
    const result = resolveTarget({
      to: "5511999999999",
      mode: "implicit",
      allowFrom: ["*"],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw result.error;
    }
    expect(result.to).toBe("5511999999999@s.whatsapp.net");
  });

  it("should resolve target in implicit mode when in allowlist", () => {
    const result = resolveTarget({
      to: "5511999999999",
      mode: "implicit",
      allowFrom: ["5511999999999"],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw result.error;
    }
    expect(result.to).toBe("5511999999999@s.whatsapp.net");
  });

  it("should allow group JID regardless of allowlist", () => {
    const result = resolveTarget({
      to: "120363123456789@g.us",
      mode: "implicit",
      allowFrom: ["5511999999999"],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw result.error;
    }
    expect(result.to).toBe("120363123456789@g.us");
  });

  it("should error when target not in allowlist (implicit mode)", () => {
    const result = resolveTarget({
      to: "5511888888888",
      mode: "implicit",
      allowFrom: ["5511999999999", "5511777777777"],
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected resolution to fail");
    }
    expect(result.error).toBeDefined();
  });

  installCommonResolveTargetErrorCases({
    resolveTarget,
    implicitAllowFrom: ["5511999999999"],
  });
});

describe("whatsapp extension outbound", () => {
  it("passes visible reply target through sendText", async () => {
    const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "wa-text-1", toJid: "jid" });
    const sendText = whatsappPlugin.outbound!.sendText!;

    const result = await sendText({
      cfg: {},
      to: "+1555",
      text: "hello",
      accountId: "work",
      replyToId: "msg-123",
      deps: { sendWhatsApp },
    });

    expect(sendWhatsApp).toHaveBeenCalledWith(
      "+1555",
      "hello",
      expect.objectContaining({
        accountId: "work",
        replyToId: "msg-123",
        verbose: false,
      }),
    );
    expect(result).toEqual({ channel: "whatsapp", messageId: "wa-text-1", toJid: "jid" });
  });

  it("passes visible reply target through sendMedia", async () => {
    const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "wa-media-1", toJid: "jid" });
    const sendMedia = whatsappPlugin.outbound!.sendMedia!;

    const result = await sendMedia({
      cfg: {},
      to: "+1555",
      text: "caption",
      mediaUrl: "https://example.com/a.jpg",
      accountId: "work",
      replyToId: "msg-456",
      deps: { sendWhatsApp },
    });

    expect(sendWhatsApp).toHaveBeenCalledWith(
      "+1555",
      "caption",
      expect.objectContaining({
        accountId: "work",
        mediaUrl: "https://example.com/a.jpg",
        replyToId: "msg-456",
        verbose: false,
      }),
    );
    expect(result).toEqual({ channel: "whatsapp", messageId: "wa-media-1", toJid: "jid" });
  });
});
