import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readManagedFederationTokenSummary,
  resolveManagedFederationPublicUrl,
} from "./federation.js";
import { readManagedReservationSummaries } from "./tunnel.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("managed federation helpers", () => {
  it("derives a public URL from agentSlug when explicit publicUrl is absent", () => {
    expect(resolveManagedFederationPublicUrl({ agentSlug: "demoagent123" })).toBe(
      "https://demoagent123.agents.fased.app",
    );
  });

  it("reads a derived public URL from the managed federation token file", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fased-fed-"));
    tempDirs.push(stateDir);
    const federationDir = path.join(stateDir, "federation");
    fs.mkdirSync(federationDir, { recursive: true });
    fs.writeFileSync(
      path.join(federationDir, "access-token.json"),
      JSON.stringify({
        handle: "@demo@ff1.fased.app",
        tokenId: "token-1",
        expiresAt: "2030-01-01T00:00:00.000Z",
        agentSlug: "demoagent123",
      }),
      "utf8",
    );

    const summary = readManagedFederationTokenSummary({
      HOME: stateDir,
      FASED_STATE_DIR: stateDir,
    } as NodeJS.ProcessEnv);

    expect(summary.exists).toBe(true);
    expect(summary.agentSlug).toBe("demoagent123");
    expect(summary.publicUrl).toBe("https://demoagent123.agents.fased.app");
  });
});

describe("managed tunnel helpers", () => {
  it("reports reservation presence without exposing token previews", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fased-reservation-"));
    tempDirs.push(stateDir);
    fs.writeFileSync(path.join(stateDir, "agent.zrok-reservation"), "zrok-secret-value", "utf8");

    const summaries = readManagedReservationSummaries({
      HOME: stateDir,
      FASED_STATE_DIR: stateDir,
    } as NodeJS.ProcessEnv);

    expect(summaries).toEqual([
      {
        path: path.join(stateDir, "agent.zrok-reservation"),
        slug: "agent",
        tokenPresent: true,
      },
    ]);
    expect(JSON.stringify(summaries)).not.toContain("zrok-secret-value");
  });
});
