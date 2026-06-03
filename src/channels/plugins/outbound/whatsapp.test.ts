import { describe, expect, it, vi } from "vitest";
import { whatsappOutbound } from "./whatsapp.js";

describe("whatsappOutbound", () => {
  it("passes reply target through sendText", async () => {
    const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "wa-text-1", toJid: "jid" });
    const sendText = whatsappOutbound.sendText;
    expect(sendText).toBeDefined();

    const result = await sendText!({
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

  it("passes group JID and reply target through sendText", async () => {
    const sendWhatsApp = vi.fn().mockResolvedValue({
      messageId: "wa-group-text-1",
      toJid: "120363123456789@g.us",
    });
    const sendText = whatsappOutbound.sendText;
    expect(sendText).toBeDefined();

    const result = await sendText!({
      cfg: {},
      to: "120363123456789@g.us",
      text: "hello group",
      accountId: "work",
      replyToId: "group-msg-123",
      deps: { sendWhatsApp },
    });

    expect(sendWhatsApp).toHaveBeenCalledWith(
      "120363123456789@g.us",
      "hello group",
      expect.objectContaining({
        accountId: "work",
        replyToId: "group-msg-123",
        verbose: false,
      }),
    );
    expect(result).toEqual({
      channel: "whatsapp",
      messageId: "wa-group-text-1",
      toJid: "120363123456789@g.us",
    });
  });

  it("passes reply target through sendMedia", async () => {
    const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "wa-media-1", toJid: "jid" });
    const sendMedia = whatsappOutbound.sendMedia;
    expect(sendMedia).toBeDefined();

    const result = await sendMedia!({
      cfg: {},
      to: "+1555",
      text: "caption",
      mediaUrl: "https://example.com/a.jpg",
      mediaLocalRoots: ["/tmp/media"],
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
        mediaLocalRoots: ["/tmp/media"],
        replyToId: "msg-456",
        verbose: false,
      }),
    );
    expect(result).toEqual({ channel: "whatsapp", messageId: "wa-media-1", toJid: "jid" });
  });
});
