import { afterEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: {
    existsSync: fsMocks.existsSync,
  },
  existsSync: fsMocks.existsSync,
}));

import { resolveManagedScriptPath } from "./managed-up.js";

const originalArgv = [...process.argv];

afterEach(() => {
  process.argv = [...originalArgv];
  vi.resetAllMocks();
});

describe("resolveManagedScriptPath", () => {
  it("prefers the running package script over a stale working-directory script", () => {
    process.argv = [
      "node",
      "/home/app/.fased/install-cache/npm-global/lib/node_modules/@fased/fased/dist/entry.js",
    ];
    fsMocks.existsSync.mockImplementation(
      (target: string) =>
        target === "/home/app/fased/scripts/start-managed.sh" ||
        target ===
          "/home/app/.fased/install-cache/npm-global/lib/node_modules/@fased/fased/scripts/start-managed.sh",
    );

    expect(resolveManagedScriptPath()).toBe(
      "/home/app/.fased/install-cache/npm-global/lib/node_modules/@fased/fased/scripts/start-managed.sh",
    );
  });

  it("finds start-managed.sh next to a bundled dist entrypoint", () => {
    process.argv = ["node", "/srv/fased/dist/index.js"];
    fsMocks.existsSync.mockImplementation(
      (target: string) => target === "/srv/fased/scripts/start-managed.sh",
    );

    expect(resolveManagedScriptPath()).toBe("/srv/fased/scripts/start-managed.sh");
  });

  it("finds start-managed.sh when the bundle is nested under dist/src", () => {
    process.argv = ["node", "/srv/fased/dist/src/index.js"];
    fsMocks.existsSync.mockImplementation(
      (target: string) => target === "/srv/fased/scripts/start-managed.sh",
    );

    expect(resolveManagedScriptPath()).toBe("/srv/fased/scripts/start-managed.sh");
  });

  it("falls back to start-vps.sh for older installs", () => {
    process.argv = ["node", "/srv/fased/dist/src/index.js"];
    fsMocks.existsSync.mockImplementation(
      (target: string) => target === "/srv/fased/scripts/start-vps.sh",
    );

    expect(resolveManagedScriptPath()).toBe("/srv/fased/scripts/start-vps.sh");
  });
});
