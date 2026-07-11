import { describe, expect, it } from "vitest";
import { findRoutedCommand } from "./routes.js";

describe("program routes", () => {
  function expectRoute(path: string[]) {
    const route = findRoutedCommand(path);
    expect(route).not.toBeNull();
    return route;
  }

  async function expectRunFalse(path: string[], argv: string[]) {
    const route = expectRoute(path);
    await expect(route?.run(argv)).resolves.toBe(false);
  }

  it("matches status route and preserves plugin loading", () => {
    const route = expectRoute(["status"]);
    expect(route?.loadPlugins).toBe(true);
  });

  it("returns false when status timeout flag value is missing", async () => {
    await expectRunFalse(["status"], ["node", "fased", "status", "--timeout"]);
  });

  it("returns false for sessions route when --store value is missing", async () => {
    await expectRunFalse(["sessions"], ["node", "fased", "sessions", "--store"]);
  });

  it("returns false for sessions route when --active value is missing", async () => {
    await expectRunFalse(["sessions"], ["node", "fased", "sessions", "--active"]);
  });

  it("returns false for sessions route when --agent value is missing", async () => {
    await expectRunFalse(["sessions"], ["node", "fased", "sessions", "--agent"]);
  });

  it("does not fast-route sessions subcommands", () => {
    expect(findRoutedCommand(["sessions", "cleanup"])).toBeNull();
  });

  it("does not match unknown routes", () => {
    expect(findRoutedCommand(["definitely-not-real"])).toBeNull();
  });

  it("fast-routes update and plugin status commands without plugin bootstrap", () => {
    for (const path of [
      ["update", "status"],
      ["plugins", "info"],
      ["plugins", "doctor"],
    ]) {
      const route = expectRoute(path);
      expect(route?.loadPlugins).not.toBe(true);
    }
  });

  it("returns false for config get route when path argument is missing", async () => {
    await expectRunFalse(["config", "get"], ["node", "fased", "config", "get", "--json"]);
  });

  it("returns false for config unset route when path argument is missing", async () => {
    await expectRunFalse(["config", "unset"], ["node", "fased", "config", "unset"]);
  });

  it("returns false for memory status route when --agent value is missing", async () => {
    await expectRunFalse(["memory", "status"], ["node", "fased", "memory", "status", "--agent"]);
  });

  it("returns false for memory doctor route when --agent value is missing", async () => {
    await expectRunFalse(["memory", "doctor"], ["node", "fased", "memory", "doctor", "--agent"]);
  });

  it("does not route memory doctor repair or preflight execution positionals", async () => {
    await expectRunFalse(["memory", "doctor"], ["node", "fased", "memory", "doctor", "execute"]);
    await expectRunFalse(["memory", "doctor"], ["node", "fased", "memory", "doctor", "repair"]);
    await expectRunFalse(["memory", "doctor"], ["node", "fased", "memory", "doctor", "preflight"]);
    await expectRunFalse(
      ["memory", "doctor"],
      ["node", "fased", "memory", "doctor", "--agent", "main", "execute"],
    );
    expect(findRoutedCommand(["memory", "repair"])).toBeNull();
    expect(findRoutedCommand(["memory", "preflight"])).toBeNull();
  });

  it("returns false for models list route when --provider value is missing", async () => {
    await expectRunFalse(["models", "list"], ["node", "fased", "models", "list", "--provider"]);
  });

  it("returns false for models status route when probe flags are missing values", async () => {
    await expectRunFalse(
      ["models", "status"],
      ["node", "fased", "models", "status", "--probe-provider"],
    );
    await expectRunFalse(
      ["models", "status"],
      ["node", "fased", "models", "status", "--probe-timeout"],
    );
    await expectRunFalse(
      ["models", "status"],
      ["node", "fased", "models", "status", "--probe-concurrency"],
    );
    await expectRunFalse(
      ["models", "status"],
      ["node", "fased", "models", "status", "--probe-max-tokens"],
    );
    await expectRunFalse(
      ["models", "status"],
      ["node", "fased", "models", "status", "--probe-provider", "openai", "--agent"],
    );
  });

  it("returns false for models status route when --probe-profile has no value", async () => {
    await expectRunFalse(
      ["models", "status"],
      ["node", "fased", "models", "status", "--probe-profile"],
    );
  });
});
