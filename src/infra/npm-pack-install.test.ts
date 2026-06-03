import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NpmIntegrityDriftPayload } from "./npm-integrity.js";

const installSourceUtilsMock = vi.hoisted(() => {
  return {
    withTempDir: vi.fn(async (_prefix: string, fn: (tmpDir: string) => Promise<unknown>) => {
      return await fn("/tmp/fased-npm-pack-install-test");
    }),
    packNpmSpecToArchive: vi.fn(),
  };
});

vi.mock("./install-source-utils.js", () => installSourceUtilsMock);

let packNpmSpecToArchive: typeof import("./install-source-utils.js").packNpmSpecToArchive;
let withTempDir: typeof import("./install-source-utils.js").withTempDir;
let finalizeNpmSpecArchiveInstall: typeof import("./npm-pack-install.js").finalizeNpmSpecArchiveInstall;
let installFromNpmSpecArchive: typeof import("./npm-pack-install.js").installFromNpmSpecArchive;
let installFromNpmSpecArchiveWithInstaller: typeof import("./npm-pack-install.js").installFromNpmSpecArchiveWithInstaller;

beforeAll(async () => {
  vi.resetModules();
  ({ packNpmSpecToArchive, withTempDir } = await import("./install-source-utils.js"));
  ({
    finalizeNpmSpecArchiveInstall,
    installFromNpmSpecArchive,
    installFromNpmSpecArchiveWithInstaller,
  } = await import("./npm-pack-install.js"));
});

describe("installFromNpmSpecArchive", () => {
  const baseSpec = "@fased/test@1.0.0";
  const baseArchivePath = "/tmp/fased-test.tgz";

  const mockPackedSuccess = (overrides?: {
    resolvedSpec?: string;
    integrity?: string;
    shasum?: string;
    name?: string;
    version?: string;
  }) => {
    vi.mocked(packNpmSpecToArchive).mockResolvedValue({
      ok: true,
      archivePath: baseArchivePath,
      metadata: {
        name: overrides?.name ?? "@fased/test",
        version: overrides?.version ?? "1.0.0",
        resolvedSpec: overrides?.resolvedSpec ?? baseSpec,
        ...(overrides?.integrity ? { integrity: overrides.integrity } : {}),
        ...(overrides?.shasum ? { shasum: overrides.shasum } : {}),
        ...(!overrides?.integrity && !overrides?.shasum ? { integrity: "sha512-same" } : {}),
      },
    });
  };

  const runInstall = async (overrides: {
    expectedIntegrity?: string;
    onIntegrityDrift?: (payload: NpmIntegrityDriftPayload) => boolean | Promise<boolean>;
    warn?: (message: string) => void;
    installFromArchive: (params: {
      archivePath: string;
    }) => Promise<{ ok: boolean; [k: string]: unknown }>;
  }) =>
    await installFromNpmSpecArchive({
      tempDirPrefix: "fased-test-",
      spec: baseSpec,
      timeoutMs: 1000,
      expectedIntegrity: overrides.expectedIntegrity,
      onIntegrityDrift: overrides.onIntegrityDrift,
      warn: overrides.warn,
      installFromArchive: overrides.installFromArchive,
    });

  const expectWrappedOkResult = (
    result: Awaited<ReturnType<typeof runInstall>>,
    installResult: Record<string, unknown>,
  ) => {
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected ok result");
    }
    expect(result.installResult).toEqual(installResult);
    return result;
  };

  beforeEach(() => {
    vi.mocked(packNpmSpecToArchive).mockClear();
    vi.mocked(withTempDir).mockClear();
  });

  it("returns pack errors without invoking installer", async () => {
    vi.mocked(packNpmSpecToArchive).mockResolvedValue({ ok: false, error: "pack failed" });
    const installFromArchive = vi.fn(async () => ({ ok: true as const }));

    const result = await installFromNpmSpecArchive({
      tempDirPrefix: "fased-test-",
      spec: "@fased/test@1.0.0",
      timeoutMs: 1000,
      installFromArchive,
    });

    expect(result).toEqual({ ok: false, error: "pack failed" });
    expect(installFromArchive).not.toHaveBeenCalled();
    expect(withTempDir).toHaveBeenCalledWith("fased-test-", expect.any(Function));
  });

  it("returns resolution metadata and installer result on success", async () => {
    mockPackedSuccess({ name: "@fased/test", version: "1.0.0" });
    const installFromArchive = vi.fn(async () => ({ ok: true as const, target: "done" }));

    const result = await runInstall({
      expectedIntegrity: "sha512-same",
      installFromArchive,
    });

    const okResult = expectWrappedOkResult(result, { ok: true, target: "done" });
    expect(okResult.integrityDrift).toBeUndefined();
    expect(okResult.npmResolution.resolvedSpec).toBe("@fased/test@1.0.0");
    expect(okResult.npmResolution.name).toBe("@fased/test");
    expect(okResult.npmResolution.version).toBe("1.0.0");
    expect(okResult.npmResolution.resolvedAt).toBeTruthy();
    expect(installFromArchive).toHaveBeenCalledWith({ archivePath: "/tmp/fased-test.tgz" });
  });

  it("accepts shasum metadata when npm does not report integrity", async () => {
    mockPackedSuccess({ shasum: "abc123" });
    const installFromArchive = vi.fn(async () => ({ ok: true as const, target: "done" }));

    const result = await runInstall({
      installFromArchive,
    });

    const okResult = expectWrappedOkResult(result, { ok: true, target: "done" });
    expect(okResult.npmResolution.shasum).toBe("abc123");
    expect(installFromArchive).toHaveBeenCalledWith({ archivePath: "/tmp/fased-test.tgz" });
  });

  it("rejects npm pack results without pinned package metadata", async () => {
    vi.mocked(packNpmSpecToArchive).mockResolvedValue({
      ok: true,
      archivePath: baseArchivePath,
      metadata: {
        resolvedSpec: baseSpec,
      },
    });
    const installFromArchive = vi.fn(async () => ({ ok: true as const }));

    const result = await runInstall({
      installFromArchive,
    });

    expect(result).toEqual({
      ok: false,
      error:
        "npm pack did not report name, version, integrity or shasum for @fased/test@1.0.0; refusing unpinned npm plugin install",
    });
    expect(installFromArchive).not.toHaveBeenCalled();
  });

  it("proceeds when integrity drift callback accepts drift", async () => {
    mockPackedSuccess({ integrity: "sha512-new" });
    const onIntegrityDrift = vi.fn(async () => true);
    const installFromArchive = vi.fn(async () => ({ ok: true as const, id: "plugin-accept" }));

    const result = await runInstall({
      expectedIntegrity: "sha512-old",
      onIntegrityDrift,
      installFromArchive,
    });

    const okResult = expectWrappedOkResult(result, { ok: true, id: "plugin-accept" });
    expect(okResult.integrityDrift).toEqual({
      expectedIntegrity: "sha512-old",
      actualIntegrity: "sha512-new",
    });
    expect(onIntegrityDrift).toHaveBeenCalledTimes(1);
  });

  it("aborts when integrity drift callback rejects drift", async () => {
    mockPackedSuccess({ integrity: "sha512-new" });
    const installFromArchive = vi.fn(async () => ({ ok: true as const }));

    const result = await runInstall({
      expectedIntegrity: "sha512-old",
      onIntegrityDrift: async () => false,
      installFromArchive,
    });

    expect(result).toEqual({
      ok: false,
      error: "aborted: npm package integrity drift detected for @fased/test@1.0.0",
    });
    expect(installFromArchive).not.toHaveBeenCalled();
  });

  it("warns and proceeds on drift when no callback is configured", async () => {
    mockPackedSuccess({ integrity: "sha512-new" });
    const warn = vi.fn();
    const installFromArchive = vi.fn(async () => ({ ok: true as const, id: "plugin-1" }));

    const result = await runInstall({
      expectedIntegrity: "sha512-old",
      warn,
      installFromArchive,
    });

    const okResult = expectWrappedOkResult(result, { ok: true, id: "plugin-1" });
    expect(okResult.integrityDrift).toEqual({
      expectedIntegrity: "sha512-old",
      actualIntegrity: "sha512-new",
    });
    expect(warn).toHaveBeenCalledWith(
      "Integrity drift detected for @fased/test@1.0.0: expected sha512-old, got sha512-new",
    );
  });

  it("returns installer failures to callers for domain-specific handling", async () => {
    mockPackedSuccess({ integrity: "sha512-same" });
    const installFromArchive = vi.fn(async () => ({ ok: false as const, error: "install failed" }));

    const result = await runInstall({
      expectedIntegrity: "sha512-same",
      installFromArchive,
    });

    const okResult = expectWrappedOkResult(result, { ok: false, error: "install failed" });
    expect(okResult.integrityDrift).toBeUndefined();
  });
});

describe("installFromNpmSpecArchiveWithInstaller", () => {
  beforeEach(() => {
    vi.mocked(packNpmSpecToArchive).mockClear();
  });

  it("passes archive path and installer params to installFromArchive", async () => {
    vi.mocked(packNpmSpecToArchive).mockResolvedValue({
      ok: true,
      archivePath: "/tmp/fased-plugin.tgz",
      metadata: {
        name: "@fased/voice-call",
        version: "1.0.0",
        resolvedSpec: "@fased/voice-call@1.0.0",
        integrity: "sha512-same",
      },
    });
    const installFromArchive = vi.fn(
      async (_params: { archivePath: string; pluginId: string }) =>
        ({ ok: true as const, pluginId: "voice-call" }) as const,
    );

    const result = await installFromNpmSpecArchiveWithInstaller({
      tempDirPrefix: "fased-test-",
      spec: "@fased/voice-call@1.0.0",
      timeoutMs: 1000,
      installFromArchive,
      archiveInstallParams: { pluginId: "voice-call" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(installFromArchive).toHaveBeenCalledWith({
      archivePath: "/tmp/fased-plugin.tgz",
      pluginId: "voice-call",
    });
    expect(result.installResult).toEqual({ ok: true, pluginId: "voice-call" });
  });
});

describe("finalizeNpmSpecArchiveInstall", () => {
  it("returns top-level flow errors unchanged", () => {
    const result = finalizeNpmSpecArchiveInstall<{ ok: true } | { ok: false; error: string }>({
      ok: false,
      error: "pack failed",
    });

    expect(result).toEqual({ ok: false, error: "pack failed" });
  });

  it("returns install errors unchanged", () => {
    const result = finalizeNpmSpecArchiveInstall<{ ok: true } | { ok: false; error: string }>({
      ok: true,
      installResult: { ok: false, error: "install failed" },
      npmResolution: {
        resolvedSpec: "@fased/test@1.0.0",
        integrity: "sha512-same",
        resolvedAt: "2026-01-01T00:00:00.000Z",
      },
    });

    expect(result).toEqual({ ok: false, error: "install failed" });
  });

  it("attaches npm metadata to successful install results", () => {
    const result = finalizeNpmSpecArchiveInstall<
      { ok: true; pluginId: string } | { ok: false; error: string }
    >({
      ok: true,
      installResult: { ok: true, pluginId: "voice-call" },
      npmResolution: {
        resolvedSpec: "@fased/voice-call@1.0.0",
        integrity: "sha512-same",
        resolvedAt: "2026-01-01T00:00:00.000Z",
      },
      integrityDrift: {
        expectedIntegrity: "sha512-old",
        actualIntegrity: "sha512-same",
      },
    });

    expect(result).toEqual({
      ok: true,
      pluginId: "voice-call",
      npmResolution: {
        resolvedSpec: "@fased/voice-call@1.0.0",
        integrity: "sha512-same",
        resolvedAt: "2026-01-01T00:00:00.000Z",
      },
      integrityDrift: {
        expectedIntegrity: "sha512-old",
        actualIntegrity: "sha512-same",
      },
    });
  });
});
