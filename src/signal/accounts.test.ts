import { describe, expect, it } from "vitest";
import { resolveSignalAccount } from "./accounts.js";

describe("resolveSignalAccount", () => {
  it("requires a Signal account or explicit HTTP URL before marking setup configured", () => {
    expect(
      resolveSignalAccount({
        cfg: { channels: { signal: { cliPath: "signal-cli" } } },
      }).configured,
    ).toBe(false);
    expect(
      resolveSignalAccount({
        cfg: { channels: { signal: { httpHost: "127.0.0.1", httpPort: 8080 } } },
      }).configured,
    ).toBe(false);
    expect(
      resolveSignalAccount({
        cfg: { channels: { signal: { account: "+15555550123" } } },
      }).configured,
    ).toBe(true);
    expect(
      resolveSignalAccount({
        cfg: { channels: { signal: { httpUrl: "http://127.0.0.1:8080" } } },
      }).configured,
    ).toBe(true);
  });
});
