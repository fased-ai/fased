import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const APPCAST_URL = new URL("../appcast.xml", import.meta.url);

function expectedSparkleVersion(shortVersion: string): string {
  const [year, month, day] = shortVersion.split(".");
  if (!year || !month || !day) {
    throw new Error(`unexpected short version: ${shortVersion}`);
  }
  return `${year}${month.padStart(2, "0")}${day.padStart(2, "0")}0`;
}

describe("appcast.xml", () => {
  it("uses date-derived Sparkle versions for release entries", () => {
    const appcast = readFileSync(APPCAST_URL, "utf8");
    const items = Array.from(appcast.matchAll(/<item>[\s\S]*?<\/item>/g)).map((match) => match[0]);

    for (const item of items) {
      const shortVersion = item.match(
        /<sparkle:shortVersionString>([^<]+)<\/sparkle:shortVersionString>/,
      )?.[1];
      const sparkleVersion = item.match(/<sparkle:version>([^<]+)<\/sparkle:version>/)?.[1];
      expect(shortVersion).toBeDefined();
      expect(sparkleVersion).toBe(expectedSparkleVersion(shortVersion ?? ""));
    }
  });
});
