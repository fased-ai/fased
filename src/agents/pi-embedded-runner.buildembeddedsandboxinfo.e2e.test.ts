import { describe, expect, it } from "vitest";
import { buildEmbeddedSandboxInfo } from "./pi-embedded-runner.js";
import type { SandboxContext } from "./sandbox.js";

describe("buildEmbeddedSandboxInfo", () => {
  it("returns undefined when sandbox is missing", () => {
    expect(buildEmbeddedSandboxInfo()).toBeUndefined();
  });

  it("maps sandbox context into prompt info", () => {
    const sandbox = {
      enabled: true,
      sessionKey: "session:test",
      workspaceDir: "/tmp/fased-sandbox",
      agentWorkspaceDir: "/tmp/fased-workspace",
      workspaceAccess: "none",
      containerName: "fased-sbx-test",
      containerWorkdir: "/workspace",
      docker: {
        image: "fased-sandbox:bookworm-slim",
        containerPrefix: "fased-sbx-",
        workdir: "/workspace",
        readOnlyRoot: true,
        tmpfs: ["/tmp"],
        network: "none",
        user: "1000:1000",
        capDrop: ["ALL"],
        env: { LANG: "C.UTF-8" },
      },
      tools: {
        allow: ["exec"],
        deny: ["browser"],
      },
      browserAllowHostControl: true,
      browser: {
        bridgeUrl: "http://localhost:9222",
        noVncUrl: "http://localhost:6080",
        containerName: "fased-sbx-browser-test",
      },
    } satisfies SandboxContext;

    expect(buildEmbeddedSandboxInfo(sandbox)).toEqual({
      enabled: true,
      workspaceDir: "/tmp/fased-sandbox",
      containerWorkspaceDir: "/workspace",
      workspaceAccess: "none",
      agentWorkspaceMount: undefined,
      browserBridgeUrl: "http://localhost:9222",
      browserNoVncUrl: "http://localhost:6080",
      hostBrowserAllowed: true,
    });
  });

  it("includes elevated info when allowed", () => {
    const sandbox = {
      enabled: true,
      sessionKey: "session:test",
      workspaceDir: "/tmp/fased-sandbox",
      agentWorkspaceDir: "/tmp/fased-workspace",
      workspaceAccess: "none",
      containerName: "fased-sbx-test",
      containerWorkdir: "/workspace",
      docker: {
        image: "fased-sandbox:bookworm-slim",
        containerPrefix: "fased-sbx-",
        workdir: "/workspace",
        readOnlyRoot: true,
        tmpfs: ["/tmp"],
        network: "none",
        user: "1000:1000",
        capDrop: ["ALL"],
        env: { LANG: "C.UTF-8" },
      },
      tools: {
        allow: ["exec"],
        deny: ["browser"],
      },
      browserAllowHostControl: false,
    } satisfies SandboxContext;

    expect(
      buildEmbeddedSandboxInfo(sandbox, {
        enabled: true,
        allowed: true,
        defaultLevel: "on",
      }),
    ).toEqual({
      enabled: true,
      workspaceDir: "/tmp/fased-sandbox",
      containerWorkspaceDir: "/workspace",
      workspaceAccess: "none",
      agentWorkspaceMount: undefined,
      hostBrowserAllowed: false,
      elevated: { allowed: true, defaultLevel: "on" },
    });
  });
});
