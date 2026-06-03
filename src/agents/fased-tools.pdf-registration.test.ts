import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";
import "./test-helpers/fast-core-tools.js";
import { createFasedCompatTools } from "./fased-tools.compat.js";

async function withTempAgentDir<T>(run: (agentDir: string) => Promise<T>): Promise<T> {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-tools-pdf-"));
  try {
    return await run(agentDir);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
}

describe("createFasedCompatTools PDF registration", () => {
  it("includes pdf tool when pdfModel is configured", async () => {
    await withTempAgentDir(async (agentDir) => {
      const cfg: FasedAgentConfig = {
        agents: {
          defaults: {
            pdfModel: { primary: "openai/gpt-5.4-mini" },
          },
        },
      };

      const tools = createFasedCompatTools({ config: cfg, agentDir });
      expect(tools.some((tool) => tool.name === "pdf")).toBe(true);
    });
  });
});
