import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTROL_UI_LOGIN_DEFAULT_GRANT_TTL_MS,
  ControlUiLoginService,
  createLoginGrant,
  resolveControlUiPublicHost,
  verifyLoginGrant,
} from "./control-ui-login.js";

describe("control-ui-login grants", () => {
  it("creates and verifies signed grants", () => {
    const now = Date.now();
    const grant = createLoginGrant({
      gatewayToken: "root-token",
      host: "fasedagent7f1b9b93ccfdb.agents.fased.app",
      nowMs: now,
      ttlMs: CONTROL_UI_LOGIN_DEFAULT_GRANT_TTL_MS,
    });
    const verified = verifyLoginGrant({
      grant,
      gatewayToken: "root-token",
      host: "fasedagent7f1b9b93ccfdb.agents.fased.app",
      nowMs: now + 1000,
    });
    expect(verified.ok).toBe(true);
  });

  it("rejects host mismatch", () => {
    const now = Date.now();
    const grant = createLoginGrant({
      gatewayToken: "root-token",
      host: "a.agents.fased.app",
      nowMs: now,
      ttlMs: 60_000,
    });
    const verified = verifyLoginGrant({
      grant,
      gatewayToken: "root-token",
      host: "b.agents.fased.app",
      nowMs: now + 500,
    });
    expect(verified).toEqual({ ok: false, code: "host_mismatch" });
  });
});

describe("control-ui public host resolution", () => {
  it("uses trusted forwarded host when present", () => {
    const req = {
      socket: { remoteAddress: "127.0.0.1" },
      headers: {
        host: "127.0.0.1:18789",
        "x-forwarded-host": "fased-vps.tailnet.ts.net",
      },
    } as unknown as import("node:http").IncomingMessage;

    expect(resolveControlUiPublicHost(req, ["127.0.0.1/32"])).toBe("fased-vps.tailnet.ts.net");
  });

  it("uses trusted Tailscale Serve origin when forwarded host is omitted", () => {
    const req = {
      socket: { remoteAddress: "127.0.0.1" },
      headers: {
        host: "127.0.0.1:18789",
        origin: "https://fased-vps.tailnet.ts.net",
        "x-forwarded-for": "100.64.1.20",
        "x-forwarded-proto": "https",
        "tailscale-user-login": "operator@example.com",
      },
    } as unknown as import("node:http").IncomingMessage;

    expect(resolveControlUiPublicHost(req, ["127.0.0.1/32"])).toBe("fased-vps.tailnet.ts.net");
  });

  it("falls back to request host when Tailscale Serve origin is not trusted", () => {
    const req = {
      socket: { remoteAddress: "127.0.0.1" },
      headers: {
        host: "127.0.0.1:18789",
        origin: "https://attacker.example",
        "x-forwarded-for": "100.64.1.20",
        "x-forwarded-proto": "https",
      },
    } as unknown as import("node:http").IncomingMessage;

    expect(resolveControlUiPublicHost(req, ["127.0.0.1/32"])).toBe("127.0.0.1:18789");
  });

  it("can use HTTPS origin as hosted fallback for trusted loopback Serve requests", () => {
    const req = {
      socket: { remoteAddress: "127.0.0.1" },
      headers: {
        host: "127.0.0.1:18789",
        origin: "https://fased-vps.tailnet.ts.net",
      },
    } as unknown as import("node:http").IncomingMessage;

    expect(
      resolveControlUiPublicHost(req, ["127.0.0.1/32"], {
        allowLoopbackHttpsOriginFallback: true,
      }),
    ).toBe("fased-vps.tailnet.ts.net");
  });

  it("does not use HTTPS origin fallback unless explicitly enabled", () => {
    const req = {
      socket: { remoteAddress: "127.0.0.1" },
      headers: {
        host: "127.0.0.1:18789",
        origin: "https://fased-vps.tailnet.ts.net",
      },
    } as unknown as import("node:http").IncomingMessage;

    expect(resolveControlUiPublicHost(req, ["127.0.0.1/32"])).toBe("127.0.0.1:18789");
  });
});

describe("ControlUiLoginService", () => {
  it("exchanges grants once and rejects replay", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "fased-control-ui-login-test-"));
    try {
      const statePath = path.join(dir, "control-ui-login.json");
      const svc = new ControlUiLoginService({
        gatewayToken: "root-token",
        statePath,
      });
      const now = 1_700_000_000_000;
      const grant = svc.createLoginGrant({
        host: "fasedagent7f1b9b93ccfdb.agents.fased.app",
        ttlMs: 60_000,
        nowMs: now,
      });
      const exchanged = svc.exchangeGrant({
        grant,
        host: "fasedagent7f1b9b93ccfdb.agents.fased.app",
        nowMs: now + 500,
      });
      expect(exchanged.ok).toBe(true);
      const replay = svc.exchangeGrant({
        grant,
        host: "fasedagent7f1b9b93ccfdb.agents.fased.app",
        nowMs: now + 1500,
      });
      expect(replay).toEqual({ ok: false, code: "invalid_or_used_grant" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("authorizes valid session tokens and enforces idle expiry", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "fased-control-ui-login-test-"));
    try {
      const statePath = path.join(dir, "control-ui-login.json");
      const svc = new ControlUiLoginService({
        gatewayToken: "root-token",
        statePath,
        idleTimeoutMs: 2000,
        maxLifetimeMs: 10_000,
      });
      const now = 1_700_000_000_000;
      const grant = svc.createLoginGrant({
        host: "fasedagent7f1b9b93ccfdb.agents.fased.app",
        ttlMs: 60_000,
        nowMs: now,
      });
      const exchanged = svc.exchangeGrant({
        grant,
        host: "fasedagent7f1b9b93ccfdb.agents.fased.app",
        nowMs: now + 100,
      });
      expect(exchanged.ok).toBe(true);
      if (!exchanged.ok) {
        return;
      }

      const ok = svc.authorizeSessionToken({
        token: exchanged.sessionToken,
        host: "fasedagent7f1b9b93ccfdb.agents.fased.app",
        nowMs: now + 1500,
      });
      expect(ok.ok).toBe(true);

      const expired = svc.authorizeSessionToken({
        token: exchanged.sessionToken,
        host: "fasedagent7f1b9b93ccfdb.agents.fased.app",
        nowMs: now + 4001,
      });
      expect(expired.ok).toBe(false);
      if (expired.ok) {
        return;
      }
      expect(["expired_session_token", "invalid_session_token"]).toContain(expired.code);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("revokes active session tokens", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "fased-control-ui-login-test-"));
    try {
      const statePath = path.join(dir, "control-ui-login.json");
      const svc = new ControlUiLoginService({
        gatewayToken: "root-token",
        statePath,
      });
      const now = 1_700_000_000_000;
      const grant = svc.createLoginGrant({
        host: "fasedagent7f1b9b93ccfdb.agents.fased.app",
        ttlMs: 60_000,
        nowMs: now,
      });
      const exchanged = svc.exchangeGrant({
        grant,
        host: "fasedagent7f1b9b93ccfdb.agents.fased.app",
        nowMs: now + 100,
      });
      expect(exchanged.ok).toBe(true);
      if (!exchanged.ok) {
        return;
      }

      const revoked = svc.revokeSessionToken({
        token: exchanged.sessionToken,
        host: "fasedagent7f1b9b93ccfdb.agents.fased.app",
        nowMs: now + 200,
      });
      expect(revoked).toEqual({ ok: true });

      const auth = svc.authorizeSessionToken({
        token: exchanged.sessionToken,
        host: "fasedagent7f1b9b93ccfdb.agents.fased.app",
        nowMs: now + 300,
      });
      expect(auth).toEqual({ ok: false, code: "invalid_session_token" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("issues host-bound session without a grant", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "fased-control-ui-login-test-"));
    try {
      const statePath = path.join(dir, "control-ui-login.json");
      const svc = new ControlUiLoginService({
        gatewayToken: "root-token",
        statePath,
      });
      const now = 1_700_000_000_000;
      const issued = svc.issueSession({
        host: "fasedagent7f1b9b93ccfdb.agents.fased.app",
        nowMs: now,
      });
      expect(issued.ok).toBe(true);
      if (!issued.ok) {
        return;
      }
      const auth = svc.authorizeSessionToken({
        token: issued.sessionToken,
        host: "fasedagent7f1b9b93ccfdb.agents.fased.app",
        nowMs: now + 500,
      });
      expect(auth.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
