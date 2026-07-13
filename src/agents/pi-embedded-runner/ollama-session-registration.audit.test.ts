import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("Ollama embedded session registration", () => {
  it.each(["run/attempt.ts", "compact.ts"])(
    "registers the native provider before createAgentSession in %s",
    (relativePath) => {
      const source = fs.readFileSync(new URL(relativePath, import.meta.url), "utf8");
      const registration = source.indexOf("registerProviderStreamForModel({");
      const sessionCreation = source.indexOf("await createAgentSession({", registration);

      expect(registration).toBeGreaterThan(-1);
      expect(sessionCreation).toBeGreaterThan(registration);
    },
  );
});
