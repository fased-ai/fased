import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { upsertAuthProfile } from "./auth-profiles.js";
import { resolveImplicitProviders } from "./models-config.providers.js";

describe("current catalog implicit providers", () => {
  it("injects Fased-supported providers from env auth", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "fased-test-"));

    await withEnvAsync(
      {
        ARCEEAI_API_KEY: "arcee-key",
        DEEPSEEK_API_KEY: "deepseek-key",
        FIREWORKS_API_KEY: "fireworks-key",
        STEPFUN_API_KEY: "stepfun-key",
        TENCENT_TOKENHUB_API_KEY: "tencent-key",
      },
      async () => {
        const providers = await resolveImplicitProviders({ agentDir });

        expect(providers?.arcee?.apiKey).toBe("ARCEEAI_API_KEY");
        expect(providers?.deepseek?.apiKey).toBe("DEEPSEEK_API_KEY");
        expect(providers?.fireworks?.apiKey).toBe("FIREWORKS_API_KEY");
        expect(providers?.stepfun?.apiKey).toBe("STEPFUN_API_KEY");
        expect(providers?.["stepfun-plan"]?.apiKey).toBe("STEPFUN_API_KEY");
        expect(providers?.["tencent-tokenhub"]?.apiKey).toBe("TENCENT_TOKENHUB_API_KEY");
      },
    );
  });

  it("injects Fased-supported providers from stored auth profiles", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "fased-test-"));
    upsertAuthProfile({
      profileId: "deepseek:default",
      credential: { type: "api_key", provider: "deepseek", key: "deepseek-profile-key" },
      agentDir,
    });
    upsertAuthProfile({
      profileId: "tencent-tokenhub:default",
      credential: {
        type: "api_key",
        provider: "tencent-tokenhub",
        keyRef: { source: "env", provider: "default", id: "TENCENT_TOKENHUB_API_KEY" },
      },
      agentDir,
    });

    await withEnvAsync(
      {
        DEEPSEEK_API_KEY: undefined,
        TENCENT_TOKENHUB_API_KEY: undefined,
        TENCENT_API_KEY: undefined,
      },
      async () => {
        const providers = await resolveImplicitProviders({ agentDir });

        expect(providers?.deepseek?.apiKey).toBe("deepseek-profile-key");
        expect(providers?.["tencent-tokenhub"]?.apiKey).toBe("TENCENT_TOKENHUB_API_KEY");
      },
    );
  });
});
