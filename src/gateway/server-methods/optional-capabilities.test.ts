import { describe, expect, it } from "vitest";
import { browserHandlers } from "./browser.js";
import { channelsHandlers } from "./channels.js";
import { OPTIONAL_GATEWAY_METHODS, optionalGatewayHandlers } from "./optional-capabilities.js";
import { ttsHandlers } from "./tts.js";
import { voicewakeHandlers } from "./voicewake.js";

describe("optional Gateway capability dispatch", () => {
  it("keeps schema-only method names exact with their dynamically loaded implementations", () => {
    expect(OPTIONAL_GATEWAY_METHODS.browser).toEqual(Object.keys(browserHandlers).toSorted());
    expect(OPTIONAL_GATEWAY_METHODS.channels).toEqual(Object.keys(channelsHandlers).toSorted());
    expect(OPTIONAL_GATEWAY_METHODS.tts).toEqual(Object.keys(ttsHandlers).toSorted());
    expect(OPTIONAL_GATEWAY_METHODS.voicewake).toEqual(Object.keys(voicewakeHandlers).toSorted());
    expect(Object.keys(optionalGatewayHandlers).toSorted()).toEqual(
      Object.values(OPTIONAL_GATEWAY_METHODS).flat().toSorted(),
    );
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
