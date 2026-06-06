import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { configureFederationForOnboarding } from "./onboarding.federation.js";
import type { WizardPrompter } from "./prompts.js";

function makePrompter(params?: {
  confirm?: WizardPrompter["confirm"];
  text?: WizardPrompter["text"];
}): WizardPrompter {
  return {
    intro: vi.fn(async () => {}),
    outro: vi.fn(async () => {}),
    note: vi.fn(async () => {}),
    select: vi.fn(async (opts) => opts.options[0]!.value),
    multiselect: vi.fn(async () => []),
    text: params?.text ?? vi.fn(async (opts) => opts.initialValue ?? ""),
    confirm: params?.confirm ?? vi.fn(async () => true),
    progress: vi.fn(() => ({
      update: vi.fn(),
      stop: vi.fn(),
    })),
  };
}

async function makeTempStateDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "fased-federation-onboarding-"));
}

async function writeFederationToken(stateDir: string): Promise<void> {
  const tokenDir = path.join(stateDir, "federation");
  await fs.mkdir(tokenDir, { recursive: true });
  await fs.writeFile(
    path.join(tokenDir, "access-token.json"),
    JSON.stringify({
      tokenId: "test-token",
      nodeId: "test-node",
      handle: "@agent@ff1.fased.app",
      issuedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      scopes: ["federation.read", "federation.write"],
      signature: "test-signature",
      trustState: "verified",
      hostedState: "ready",
      publicUrl: "https://agent.agents.fased.app",
    }),
  );
}

describe("configureFederationForOnboarding", () => {
  it("silently enables auto-connect when no federation state exists", async () => {
    const stateDir = await makeTempStateDir();
    const confirm = vi.fn(async () => true);
    const text = vi.fn(async (opts) => opts.initialValue ?? "");
    const prompter = makePrompter({ confirm, text });

    try {
      const result = await configureFederationForOnboarding({
        flow: "quickstart",
        hostProfile: "local",
        baseConfig: {
          env: {
            vars: {
              FASED_STATE_DIR: stateDir,
            },
          },
        },
        prompter,
      });

      expect(confirm).not.toHaveBeenCalled();
      expect(prompter.note).not.toHaveBeenCalled();
      expect(text).not.toHaveBeenCalled();
      expect(result).toEqual({
        enabled: true,
        baseUrl: "https://ff1.fased.app",
        handle: undefined,
      });
    } finally {
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  it("keeps auto-connect settings silently", async () => {
    const stateDir = await makeTempStateDir();
    const confirm = vi.fn(async () => true);
    const text = vi.fn(async (opts) => opts.initialValue ?? "");
    const prompter = makePrompter({ confirm, text });

    try {
      const result = await configureFederationForOnboarding({
        flow: "quickstart",
        hostProfile: "local",
        baseConfig: {
          env: {
            vars: {
              FASED_STATE_DIR: stateDir,
              FASED_FEDERATION_AUTO_CONNECT: "1",
              FASED_FEDERATION_BASE_URL: "https://ff1.fased.app",
              FASED_FEDERATION_HANDLE: "@agent@ff1.fased.app",
            },
          },
        },
        prompter,
      });

      expect(confirm).not.toHaveBeenCalled();
      expect(prompter.note).not.toHaveBeenCalled();
      expect(text).not.toHaveBeenCalled();
      expect(result).toEqual({
        enabled: true,
        baseUrl: "https://ff1.fased.app",
        handle: "@agent@ff1.fased.app",
      });
    } finally {
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  it("uses a persisted federation token handle silently", async () => {
    const stateDir = await makeTempStateDir();
    const confirm = vi.fn(async () => true);
    const text = vi.fn(async (opts) => opts.initialValue ?? "");
    const prompter = makePrompter({ confirm, text });

    try {
      await writeFederationToken(stateDir);

      const result = await configureFederationForOnboarding({
        flow: "quickstart",
        hostProfile: "hosting",
        baseConfig: {
          env: {
            vars: {
              FASED_STATE_DIR: stateDir,
              FASED_FEDERATION_AUTO_CONNECT: "1",
              FASED_FEDERATION_BASE_URL: "https://ff1.fased.app",
            },
          },
        },
        prompter,
      });

      expect(confirm).not.toHaveBeenCalled();
      expect(prompter.note).not.toHaveBeenCalled();
      expect(text).not.toHaveBeenCalled();
      expect(result).toEqual({
        enabled: true,
        baseUrl: "https://ff1.fased.app",
        handle: "@agent@ff1.fased.app",
      });
    } finally {
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  it("respects an explicitly disabled existing auto-connect setting", async () => {
    const stateDir = await makeTempStateDir();
    const confirm = vi.fn(async () => true);
    const text = vi.fn(async (opts) => opts.initialValue ?? "");
    const prompter = makePrompter({ confirm, text });

    try {
      const result = await configureFederationForOnboarding({
        flow: "quickstart",
        hostProfile: "local",
        baseConfig: {
          env: {
            vars: {
              FASED_STATE_DIR: stateDir,
              FASED_FEDERATION_AUTO_CONNECT: "0",
            },
          },
        },
        prompter,
      });

      expect(confirm).not.toHaveBeenCalled();
      expect(prompter.note).not.toHaveBeenCalled();
      expect(text).not.toHaveBeenCalled();
      expect(result).toEqual({ enabled: false });
    } finally {
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });
});
