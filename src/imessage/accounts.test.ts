import { describe, expect, it } from "vitest";
import { resolveIMessageAccount } from "./accounts.js";

describe("resolveIMessageAccount", () => {
  it("requires bridge path config before marking setup configured", () => {
    expect(
      resolveIMessageAccount({
        cfg: { channels: { imessage: { dmPolicy: "pairing", groupPolicy: "allowlist" } } },
      }).configured,
    ).toBe(false);
    expect(
      resolveIMessageAccount({
        cfg: { channels: { imessage: { allowFrom: ["alice@example.com"] } } },
      }).configured,
    ).toBe(false);
    expect(
      resolveIMessageAccount({
        cfg: { channels: { imessage: { cliPath: "imsg" } } },
      }).configured,
    ).toBe(true);
    expect(
      resolveIMessageAccount({
        cfg: { channels: { imessage: { dbPath: "/Users/fc/Library/Messages/chat.db" } } },
      }).configured,
    ).toBe(true);
  });
});
