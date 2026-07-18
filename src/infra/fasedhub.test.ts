import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  downloadFasedHubSkillArchive,
  resolveFasedHubAuthToken,
  resolveFasedHubBaseUrl,
  resolveFasedHubConfigPaths,
  resolveFasedHubWorkdir,
  searchFasedHubSkills,
} from "./fasedhub.js";

const HUB_ENV_KEYS = [
  "FASEDHUB_REGISTRY",
  "FASED_CLAWHUB_REGISTRY",
  "CLAWHUB_REGISTRY",
  "FASEDHUB_URL",
  "FASED_CLAWHUB_URL",
  "CLAWHUB_URL",
  "FASEDHUB_TOKEN",
  "FASEDHUB_AUTH_TOKEN",
  "FASED_CLAWHUB_TOKEN",
  "CLAWHUB_TOKEN",
  "CLAWHUB_AUTH_TOKEN",
  "FASEDHUB_CONFIG_PATH",
  "FASED_CLAWHUB_CONFIG_PATH",
  "CLAWHUB_CONFIG_PATH",
  "CLAWDHUB_CONFIG_PATH",
  "FASEDHUB_WORKDIR",
  "FASED_CLAWHUB_WORKDIR",
  "CLAWHUB_WORKDIR",
  "XDG_CONFIG_HOME",
] as const;

describe("fasedhub registry client", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    for (const key of HUB_ENV_KEYS) {
      delete process.env[key];
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("prefers public ClawHub registry env vars over internal FasedHub aliases", () => {
    process.env.CLAWHUB_REGISTRY = "https://clawhub.example.com";
    process.env.FASED_CLAWHUB_REGISTRY = "https://compat.example.com";
    process.env.FASEDHUB_REGISTRY = "https://fasedhub.example.com";

    expect(resolveFasedHubBaseUrl()).toBe("https://clawhub.example.com");
  });

  it("falls back to internal FasedHub registry aliases", () => {
    process.env.FASEDHUB_REGISTRY = "https://internal.example.com/";

    expect(resolveFasedHubBaseUrl()).toBe("https://internal.example.com");
  });

  it("prefers public ClawHub config path and workdir env vars", () => {
    process.env.CLAWHUB_CONFIG_PATH = "/tmp/clawhub.json";
    process.env.FASEDHUB_CONFIG_PATH = "/tmp/fasedhub.json";
    process.env.CLAWHUB_WORKDIR = "/tmp/clawhub-workdir";
    process.env.FASEDHUB_WORKDIR = "/tmp/fasedhub-workdir";

    expect(resolveFasedHubConfigPaths()).toEqual(["/tmp/clawhub.json"]);
    expect(resolveFasedHubWorkdir("/tmp/cwd")).toBe("/tmp/clawhub-workdir");
  });

  it("falls back to internal FasedHub config path and workdir aliases", () => {
    process.env.FASEDHUB_CONFIG_PATH = "/tmp/fasedhub.json";
    process.env.FASEDHUB_WORKDIR = "/tmp/fasedhub-workdir";

    expect(resolveFasedHubConfigPaths()).toEqual(["/tmp/fasedhub.json"]);
    expect(resolveFasedHubWorkdir("/tmp/cwd")).toBe("/tmp/fasedhub-workdir");
  });

  it("resolves auth token from public ClawHub config before internal alias config", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fasedhub-config-test-"));
    const fasedHubConfig = path.join(root, "fasedhub", "config.json");
    const clawHubConfig = path.join(root, "clawhub", "config.json");
    process.env.XDG_CONFIG_HOME = root;
    await fs.mkdir(path.dirname(fasedHubConfig), { recursive: true });
    await fs.mkdir(path.dirname(clawHubConfig), { recursive: true });
    await fs.writeFile(fasedHubConfig, JSON.stringify({ auth: { token: "fased-token" } }), "utf8");
    await fs.writeFile(clawHubConfig, JSON.stringify({ token: "clawhub-token" }), "utf8");

    try {
      await expect(resolveFasedHubAuthToken()).resolves.toBe("clawhub-token");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("uses public ClawHub token env var before internal FasedHub token alias", async () => {
    process.env.CLAWHUB_TOKEN = "clawhub-token";
    process.env.FASEDHUB_TOKEN = "fased-token";
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      expect(url).toBe("https://clawhub.com/api/v1/search?q=calendar&limit=5");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer clawhub-token");
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await expect(searchFasedHubSkills({ query: "calendar", limit: 5, fetchImpl })).resolves.toEqual(
      [],
    );
  });

  it("verifies the registry-provided archive digest before writing an install artifact", async () => {
    const bytes = Buffer.from("signed-skill-archive");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const result = await downloadFasedHubSkillArchive({
      slug: "safe-skill",
      version: "1.0.0",
      expectedSha256: sha256,
      fetchImpl: async () => new Response(bytes, { status: 200 }),
    });
    try {
      expect(result.sha256).toBe(sha256);
      expect(result.integrityVerified).toBe(true);
      await expect(fs.readFile(result.archivePath)).resolves.toEqual(bytes);
    } finally {
      await result.cleanup();
    }
  });

  it("rejects mismatched and oversized skill archives before installation", async () => {
    await expect(
      downloadFasedHubSkillArchive({
        slug: "tampered-skill",
        expectedSha256: "0".repeat(64),
        fetchImpl: async () => new Response("tampered", { status: 200 }),
      }),
    ).rejects.toThrow("digest mismatch");

    await expect(
      downloadFasedHubSkillArchive({
        slug: "oversized-skill",
        fetchImpl: async () =>
          new Response("small", {
            status: 200,
            headers: { "content-length": String(25 * 1024 * 1024 + 1) },
          }),
      }),
    ).rejects.toThrow("download limit");
  });
});
