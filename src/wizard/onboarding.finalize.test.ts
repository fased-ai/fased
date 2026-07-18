import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildGatewayServiceRestartAttempts,
  buildGatewayWsUrlFromHttpUrl,
  buildOnboardingDashboardUrl,
  ensureGatewaySecretMatchesToken,
  formatHostedRootServiceRequiredFailure,
  formatLocalDashboardReady,
  formatStrictRemoteAccessDetails,
  gatewayServiceMatchesCurrentInstall,
  validateLocalDashboardBootCheck,
  waitForGatewayHttpListener,
} from "./onboarding.finalize.js";

describe("buildOnboardingDashboardUrl", () => {
  it("builds an auth-ready dashboard URL with fragment-only token and wallet focus", () => {
    const url = buildOnboardingDashboardUrl({
      baseUrl: "http://localhost:18789/control/",
      basePath: "/control",
      token: "abc123",
      walletSecurityFocus: {
        walletId: "wallet-agent",
        role: "agent",
      },
    });

    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/control/");
    expect(parsed.searchParams.get("token")).toBeNull();
    expect(parsed.searchParams.get("wallet")).toBeNull();
    expect(parsed.searchParams.get("wallet_role")).toBeNull();
    expect(parsed.searchParams.get("wallet_security")).toBeNull();
    const hash = new URLSearchParams(parsed.hash.slice(1));
    expect(hash.get("token")).toBe("abc123");
    expect(hash.get("gatewayUrl")).toBeNull();
    expect(hash.get("wallet")).toBe("wallet-agent");
    expect(hash.get("wallet_role")).toBe("agent");
    expect(hash.get("wallet_security")).toBe("1");
  });
});

describe("formatStrictRemoteAccessDetails", () => {
  it("prints tokenized direct and tunnel dashboard URLs", () => {
    const text = formatStrictRemoteAccessDetails({
      tailscaleSshUser: "app",
      tailscaleNodeName: "fased-vps.tailnet.ts.net",
      tailscaleIpv4: "100.64.1.9",
      dashboardUrl: "https://fased-vps.tailnet.ts.net/#token=abc123",
      tunnelUrl: "http://localhost:18789/#token=abc123",
      port: 18789,
      gatewayToken: "abc123",
    });

    expect(text).toContain("WEB UI");
    expect(text).toContain("SSH");
    expect(text).toContain("FALLBACK TUNNEL");
    expect(text).toContain("LOCAL PORT BUSY");
    expect(text).toContain("TOKEN BACKUP");
    expect(text).toContain("Open this on your own computer");
    expect(text).toContain("https://fased-vps.tailnet.ts.net/#token=abc123");
    expect(text).toContain("ssh app@fased-vps.tailnet.ts.net");
    expect(text).toContain("ssh app@100.64.1.9");
    expect(text).toContain("hostname DNS fails");
    expect(text).toContain("VPN blocks MagicDNS");
    expect(text).toContain("100.x");
    expect(text).not.toContain("tailscale ssh");
    expect(text).toContain("ssh -N -L 18789:127.0.0.1:18789 app@fased-vps.tailnet.ts.net");
    expect(text).toContain("ssh -N -L 18789:127.0.0.1:18789 app@100.64.1.9");
    expect(text).toContain("http://localhost:18789/#token=abc123");
    expect(text).toContain("Address already in use");
    expect(text).toContain("Stop the local Fased gateway");
    expect(text).toContain("ssh -N -L 18790:127.0.0.1:18789 app@fased-vps.tailnet.ts.net");
    expect(text).toContain("http://localhost:18790/#token=abc123");
    expect(text).toContain("Only paste this if the browser asks for a token:");
  });
});

describe("buildGatewayWsUrlFromHttpUrl", () => {
  it("maps a Tailscale dashboard URL to the same-origin websocket URL", () => {
    expect(
      buildGatewayWsUrlFromHttpUrl({
        httpUrl: "https://fased-vps.tailnet.ts.net/control/?x=1#token=abc",
        basePath: "/control",
      }),
    ).toBe("wss://fased-vps.tailnet.ts.net/control");
  });

  it("uses root websocket path when the Control UI has no base path", () => {
    expect(
      buildGatewayWsUrlFromHttpUrl({
        httpUrl: "https://fased-vps.tailnet.ts.net/",
      }),
    ).toBe("wss://fased-vps.tailnet.ts.net");
  });
});

describe("formatLocalDashboardReady", () => {
  it("prints local setup as a short scannable checklist", () => {
    const text = formatLocalDashboardReady({
      dashboardUrl: "http://localhost:18789/#token=abc123",
      gatewayToken: "abc123",
      opened: true,
    });

    expect(text).toContain("WEB UI");
    expect(text).toContain("NEXT");
    expect(text).toContain("http://localhost:18789/#token=abc123");
    expect(text).toContain("Agent > Models");
    expect(text).toContain("TOKEN BACKUP");
    expect(text).not.toContain("Gateway WS");
  });
});

describe("buildGatewayServiceRestartAttempts", () => {
  it("uses user service first for local profile restarts", () => {
    const labels = buildGatewayServiceRestartAttempts("fased-gateway", "local").map(
      (attempt) => attempt.label,
    );

    expect(labels.slice(0, 2)).toEqual(["user restart", "user start"]);
    expect(labels).toContain("signal app-owned hosted Gateway");
  });

  it("uses root-managed service first for hosting profile restarts", () => {
    const labels = buildGatewayServiceRestartAttempts("fased-gateway", "hosting").map(
      (attempt) => attempt.label,
    );

    expect(labels).toEqual(["signal app-owned hosted Gateway"]);
    expect(labels).not.toContain("user restart");
  });
});

describe("waitForGatewayHttpListener", () => {
  it("accepts a loopback TCP listener even when HTTP root does not answer", async () => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("test server did not bind to a TCP port");
      }

      const result = await waitForGatewayHttpListener({
        wsUrl: `ws://127.0.0.1:${address.port}`,
        deadlineMs: 1_000,
        pollMs: 100,
      });

      expect(result.ok).toBe(true);
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});

describe("formatHostedRootServiceRequiredFailure", () => {
  it("explains that hosting does not fall back to an app-managed user service", () => {
    const text = formatHostedRootServiceRequiredFailure({
      runAsUser: "app",
      detail: "sudo denied",
    });

    expect(text).toContain("root-managed fased-gateway.service running as User=app");
    expect(text).toContain("will not fall back to an app-managed user service");
    expect(text).toContain("Root service repair failed: sudo denied");
    expect(text).toContain("exact tagged, attested Hosting release");
    expect(text).toContain("never run the app checkout with sudo");
    expect(text).toContain("sudo systemctl status fased-gateway");
  });
});

describe("validateLocalDashboardBootCheck", () => {
  const okIndex = {
    url: "http://localhost:18789/",
    ok: true,
    status: 200,
    contentType: "text/html; charset=utf-8",
  };
  const okEntry = {
    url: "http://localhost:18789/assets/index.js",
    ok: true,
    status: 200,
    contentType: "application/javascript; charset=utf-8",
  };
  const okApp = {
    url: "http://localhost:18789/assets/app.js",
    ok: true,
    status: 200,
    contentType: "application/javascript; charset=utf-8",
  };

  it("requires the app JS bundle before local onboarding can print Dashboard ready", () => {
    const result = validateLocalDashboardBootCheck({
      index: "ok",
      indexResponse: okIndex,
      entryJs: okEntry,
      appJs: null,
      serve: "direct",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail).toContain("app JS is not referenced");
    }
  });

  it("accepts index, entry JS, and app JS when all assets are valid", () => {
    expect(
      validateLocalDashboardBootCheck({
        index: "ok",
        indexResponse: okIndex,
        entryJs: okEntry,
        appJs: okApp,
        serve: "direct",
      }),
    ).toEqual({ ok: true });
  });
});

describe("gatewayServiceMatchesCurrentInstall", () => {
  it("rejects a managed gateway service from another checkout", () => {
    const result = gatewayServiceMatchesCurrentInstall({
      repoRoot: "/home/fc/fasedbot/fased",
      command: {
        programArguments: ["/bin/bash", "/opt/stale-fased/scripts/start-managed.sh"],
      },
    });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("/opt/stale-fased/scripts/start-managed.sh");
    expect(result.detail).toContain("/home/fc/fasedbot/fased/scripts/start-managed.sh");
  });

  it("accepts a managed gateway service from the current checkout", () => {
    const result = gatewayServiceMatchesCurrentInstall({
      repoRoot: "/home/fc/fasedbot/fased",
      command: {
        programArguments: ["/bin/bash", "/home/fc/fasedbot/fased/scripts/start-managed.sh"],
        workingDirectory: "/home/fc/fasedbot/fased",
      },
    });

    expect(result.ok).toBe(true);
  });

  it("rejects an absolute entrypoint outside the current checkout", () => {
    const result = gatewayServiceMatchesCurrentInstall({
      repoRoot: "/home/fc/fasedbot/fased",
      command: {
        programArguments: ["/usr/bin/node", "/opt/stale-fased/dist/entry.js", "gateway"],
      },
    });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("entrypoint");
  });
});

describe("ensureGatewaySecretMatchesToken", () => {
  it("keeps the gateway service token file aligned with the configured token", async () => {
    const previousHome = process.env.FASED_HOME;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-gateway-secret-"));
    process.env.FASED_HOME = dir;
    try {
      const changed = await ensureGatewaySecretMatchesToken("config-token");
      expect(changed).toBe(true);
      await expect(fs.readFile(path.join(dir, ".fased", "gateway-secret"), "utf8")).resolves.toBe(
        "config-token\n",
      );

      const unchanged = await ensureGatewaySecretMatchesToken("config-token");
      expect(unchanged).toBe(false);
    } finally {
      if (previousHome === undefined) {
        delete process.env.FASED_HOME;
      } else {
        process.env.FASED_HOME = previousHome;
      }
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
