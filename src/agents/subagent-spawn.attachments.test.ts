import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeStrictBase64, materializeSubagentAttachments } from "./subagent-attachments.js";
import { createSubagentSpawnTestConfig } from "./subagent-spawn.test-helpers.js";

describe("decodeStrictBase64", () => {
  const maxBytes = 1024;

  it("valid base64 returns buffer with correct bytes", () => {
    const input = "hello world";
    const encoded = Buffer.from(input).toString("base64");
    const result = decodeStrictBase64(encoded, maxBytes);
    expect(result).not.toBeNull();
    expect(result?.toString("utf8")).toBe(input);
  });

  it("empty string returns null", () => {
    expect(decodeStrictBase64("", maxBytes)).toBeNull();
  });

  it("bad padding (length % 4 !== 0) returns null", () => {
    expect(decodeStrictBase64("abc", maxBytes)).toBeNull();
  });

  it("non-base64 chars returns null", () => {
    expect(decodeStrictBase64("!@#$", maxBytes)).toBeNull();
  });

  it("whitespace-only returns null (empty after strip)", () => {
    expect(decodeStrictBase64("   ", maxBytes)).toBeNull();
  });

  it("pre-decode oversize guard returns null", () => {
    expect(decodeStrictBase64("A".repeat(2737), maxBytes)).toBeNull();
  });

  it("decoded byteLength exceeds maxDecodedBytes returns null", () => {
    const bigBuf = Buffer.alloc(1025, 0x42);
    const encoded = bigBuf.toString("base64");
    expect(decodeStrictBase64(encoded, maxBytes)).toBeNull();
  });

  it("valid base64 at exact boundary returns Buffer", () => {
    const exactBuf = Buffer.alloc(1024, 0x41);
    const encoded = exactBuf.toString("base64");
    const result = decodeStrictBase64(encoded, maxBytes);
    expect(result).not.toBeNull();
    expect(result?.byteLength).toBe(1024);
  });
});

describe("materializeSubagentAttachments", () => {
  let workspaceDir = "";

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `fased-subagent-attachments-${process.pid}-${Date.now()}-`),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (workspaceDir) {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
      workspaceDir = "";
    }
  });

  const validContent = Buffer.from("hello").toString("base64");

  function buildConfig() {
    return createSubagentSpawnTestConfig(workspaceDir);
  }

  async function materializeWithName(name: string) {
    return materializeSubagentAttachments({
      config: buildConfig(),
      targetAgentId: "main",
      attachments: [{ name, content: validContent, encoding: "base64" }],
    });
  }

  it("materializes attachments under .fased/attachments", async () => {
    const result = await materializeSubagentAttachments({
      config: buildConfig(),
      targetAgentId: "main",
      attachments: [{ name: "file.txt", content: validContent, encoding: "base64" }],
      mountPathHint: "/workspace/.fased/attachments",
    });

    expect(result?.status).toBe("ok");
    if (!result || result.status !== "ok") {
      throw new Error("expected materializeSubagentAttachments to succeed");
    }

    expect(result.receipt.files).toEqual([
      {
        name: "file.txt",
        bytes: 5,
        sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      },
    ]);
    expect(result.receipt.relDir).toMatch(/^\.fased\/attachments\//);
    expect(fs.existsSync(path.join(result.absDir, "file.txt"))).toBe(true);
    expect(fs.existsSync(path.join(result.absDir, ".manifest.json"))).toBe(true);
  });

  it("name with / returns attachments_invalid_name", async () => {
    const result = await materializeWithName("foo/bar");
    expect(result?.status).toBe("error");
    expect(result && "error" in result ? result.error : "").toMatch(/attachments_invalid_name/);
  });

  it("name '..' returns attachments_invalid_name", async () => {
    const result = await materializeWithName("..");
    expect(result?.status).toBe("error");
    expect(result && "error" in result ? result.error : "").toMatch(/attachments_invalid_name/);
  });

  it("name '.manifest.json' returns attachments_invalid_name", async () => {
    const result = await materializeWithName(".manifest.json");
    expect(result?.status).toBe("error");
    expect(result && "error" in result ? result.error : "").toMatch(/attachments_invalid_name/);
  });

  it("name with newline returns attachments_invalid_name", async () => {
    const result = await materializeWithName("foo\nbar");
    expect(result?.status).toBe("error");
    expect(result && "error" in result ? result.error : "").toMatch(/attachments_invalid_name/);
  });

  it("duplicate name returns attachments_duplicate_name", async () => {
    const result = await materializeSubagentAttachments({
      config: buildConfig(),
      targetAgentId: "main",
      attachments: [
        { name: "file.txt", content: validContent, encoding: "base64" },
        { name: "file.txt", content: validContent, encoding: "base64" },
      ],
    });
    expect(result?.status).toBe("error");
    expect(result && "error" in result ? result.error : "").toMatch(/attachments_duplicate_name/);
  });

  it("empty name returns attachments_invalid_name", async () => {
    const result = await materializeWithName("");
    expect(result?.status).toBe("error");
    expect(result && "error" in result ? result.error : "").toMatch(/attachments_invalid_name/);
  });

  it("removes materialized attachments when manifest write fails", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "fixed-attachment-id" as ReturnType<typeof crypto.randomUUID>,
    );
    const collidingDir = path.join(workspaceDir, ".fased", "attachments", "fixed-attachment-id");
    fs.mkdirSync(collidingDir, { recursive: true });
    fs.writeFileSync(path.join(collidingDir, ".manifest.json"), "{}\n");

    const result = await materializeSubagentAttachments({
      config: buildConfig(),
      targetAgentId: "main",
      attachments: [{ name: "file.txt", content: validContent, encoding: "base64" }],
    });

    expect(result?.status).toBe("error");
    expect(result && "error" in result ? result.error : "").toContain(".manifest.json");
    const attachmentsRoot = path.join(workspaceDir, ".fased", "attachments");
    const retainedDirs = fs.existsSync(attachmentsRoot)
      ? fs.readdirSync(attachmentsRoot).filter((entry) => !entry.startsWith("."))
      : [];
    expect(retainedDirs).toHaveLength(0);
  });
});
