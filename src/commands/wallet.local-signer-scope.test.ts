import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmbeddedKeystoreAdapter } from "../wallet/providers/embedded-keystore-adapter.js";
import { createLegacyLocalSignerEmbeddedAdapter } from "./wallet.js";

vi.mock("../wallet/providers/turnkey-adapter.js", () => ({
  TurnkeyAdapter: class {
    readonly id = "turnkey";
  },
}));

describe("legacy embedded adapter boundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws from direct adapter construction before reading or writing the filesystem", () => {
    const readFileSync = vi.spyOn(fs, "readFileSync");
    const writeFileSync = vi.spyOn(fs, "writeFileSync");
    const existsSync = vi.spyOn(fs, "existsSync");

    const options = new Proxy(
      {},
      {
        get() {
          throw new Error("adapter inspected legacy options");
        },
      },
    );

    expect(() => new EmbeddedKeystoreAdapter(options)).toThrow(
      /embedded-keystore adapter is unavailable/i,
    );
    expect(() => createLegacyLocalSignerEmbeddedAdapter()).toThrow(
      /legacy embedded adapter construction requested/i,
    );

    expect(readFileSync).not.toHaveBeenCalled();
    expect(writeFileSync).not.toHaveBeenCalled();
    expect(existsSync).not.toHaveBeenCalled();
  });
});
