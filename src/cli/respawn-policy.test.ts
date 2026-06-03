import { describe, expect, it } from "vitest";
import { shouldSkipRespawnForArgv } from "./respawn-policy.js";

describe("shouldSkipRespawnForArgv", () => {
  it.each([
    { argv: ["node", "fased", "--help"] },
    { argv: ["node", "fased", "-V"] },
    { argv: ["node", "fased", "gateway"] },
    { argv: ["node", "fased", "gateway", "--port", "18789", "--bind", "loopback"] },
    { argv: ["node", "fased", "gateway", "run", "--port=18789", "--bind", "loopback"] },
    {
      argv: ["node", "fased", "--profile", "server", "gateway", "run", "--allow-unconfigured"],
    },
  ] as const)("skips respawn for argv %j", ({ argv }) => {
    expect(shouldSkipRespawnForArgv([...argv]), argv.join(" ")).toBe(true);
  });

  it.each([
    { argv: ["node", "fased", "status"] },
    { argv: ["node", "fased", "gateway", "status"] },
    { argv: ["node", "fased", "gateway", "call", "health"] },
  ] as const)("keeps respawn path for argv %j", ({ argv }) => {
    expect(shouldSkipRespawnForArgv([...argv]), argv.join(" ")).toBe(false);
  });
});
