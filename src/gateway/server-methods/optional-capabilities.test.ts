import { afterEach, describe, expect, it, vi } from "vitest";
import { browserHandlers } from "../../../extensions/runtime-browser/gateway-handlers.js";
import { ttsHandlers } from "../../../extensions/runtime-speech/tts-handlers.js";
import { voicewakeHandlers } from "../../../extensions/runtime-speech/voicewake-handlers.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { channelsHandlers } from "./channels.js";
import { OPTIONAL_GATEWAY_METHODS, optionalGatewayHandlers } from "./optional-capabilities.js";

describe("optional Gateway capability dispatch", () => {
  afterEach(() => resetPluginRuntimeStateForTest());

  it("keeps schema-only method names exact with their dynamically loaded implementations", () => {
    expect(OPTIONAL_GATEWAY_METHODS.browser).toEqual(Object.keys(browserHandlers).toSorted());
    expect(OPTIONAL_GATEWAY_METHODS.channels).toEqual(Object.keys(channelsHandlers).toSorted());
    expect(OPTIONAL_GATEWAY_METHODS.tts).toEqual(Object.keys(ttsHandlers).toSorted());
    expect(OPTIONAL_GATEWAY_METHODS.voicewake).toEqual(Object.keys(voicewakeHandlers).toSorted());
    expect(Object.keys(optionalGatewayHandlers).toSorted()).toEqual(
      Object.values(OPTIONAL_GATEWAY_METHODS).flat().toSorted(),
    );
  });

  it("dispatches managed implementation only through the active component provider", async () => {
    const registry = createEmptyPluginRegistry();
    const handler = vi.fn(async ({ respond }) => respond(true, { source: "managed" }));
    registry.capabilityProviders["browser-runtime"] = { "browser.request": handler };
    setActivePluginRegistry(registry);
    const respond = vi.fn();
    await optionalGatewayHandlers["browser.request"]({ respond } as never);
    expect(handler).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(true, { source: "managed" });
  });

  it("binds speech methods to the exact managed plugin identity", async () => {
    const registry = createEmptyPluginRegistry();
    const handler = vi.fn(async ({ respond }) => respond(true, { provider: "edge" }));
    registry.capabilityProviders["speech-runtime"] = { "tts.status": handler };
    setActivePluginRegistry(registry);
    const respond = vi.fn();

    await optionalGatewayHandlers["tts.status"]({ respond } as never);

    expect(handler).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(true, { provider: "edge" });
  });

  it("keeps optional implementations out of the eager Gateway method graph", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src", "gateway", "server-methods.ts"),
      "utf8",
    );
    for (const moduleName of ["browser", "channels", "tts", "voicewake"]) {
      expect(source).not.toContain(`./server-methods/${moduleName}.js`);
    }
    expect(source).toContain("...optionalGatewayHandlers");
  });

  it("does not load Federation auto-connect from the default Gateway HTTP graph", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src", "gateway", "server-http.ts"),
      "utf8",
    );
    expect(source).not.toMatch(
      /import\s*\{[^}]*loadPersistedFederationBondProof[^}]*\}\s*from\s*["']\.\.\/federation\/auto-connect\.js["']/su,
    );
    expect(source).toContain('await import("../federation/auto-connect.js")');
  });
});
import fs from "node:fs/promises";
import path from "node:path";
