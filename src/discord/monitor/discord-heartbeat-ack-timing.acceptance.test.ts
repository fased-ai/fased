import { describe, it } from "vitest";

describe("Discord gateway heartbeat ACK timing", () => {
  it.skip("does not treat the first heartbeat interval boundary as an ACK timeout", () => {
    /*
     * FasedAgent v2026.5.5 adjusted an owned Discord gateway heartbeat timer.
     * Fased currently delegates Discord gateway heartbeat scheduling to Carbon,
     * so this marker keeps the adoption item visible without adding a local
     * runtime shim that does not own the underlying timer.
     */
  });
});
