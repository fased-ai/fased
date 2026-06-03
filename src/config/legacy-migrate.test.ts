import { describe, expect, it } from "vitest";
import { migrateLegacyConfig } from "./legacy-migrate.js";

describe("legacy migrate wallet Solana-only runtime", () => {
  it("removes stale non-Solana wallet policy and normalizes chain lists", () => {
    const legacyPolicyKey = ["e", "vm"].join("");
    const res = migrateLegacyConfig({
      wallet: {
        keystore: {
          chainSupport: ["solana", legacyPolicyKey],
        },
        runtime: {
          chains: [legacyPolicyKey, "solana"],
          policy: {
            [legacyPolicyKey]: {
              maxPerTx: "1",
              maxDaily: "2",
            },
            solana: {
              maxPerTx: "1000000000",
              maxDaily: "2000000000",
            },
          },
        },
      },
    });

    expect(res.changes).toContain(
      'Normalized wallet.keystore.chainSupport → ["solana"] (removed legacy non-Solana entries).',
    );
    expect(res.changes).toContain(
      'Normalized wallet.runtime.chains → ["solana"] (removed legacy non-Solana entries).',
    );
    expect(res.changes).toContain("Removed wallet.runtime.policy legacy non-Solana policy block.");
    expect(res.config?.wallet?.keystore?.chainSupport).toEqual(["solana"]);
    expect(res.config?.wallet?.runtime?.chains).toEqual(["solana"]);
    expect(
      (res.config?.wallet?.runtime?.policy as Record<string, unknown> | undefined)?.[
        legacyPolicyKey
      ],
    ).toBeUndefined();
    expect(res.config?.wallet?.runtime?.policy?.solana?.maxPerTx).toBe("1000000000");
  });
});

describe("legacy migrate audio transcription", () => {
  it("moves routing.transcribeAudio into tools.media.audio.models", () => {
    const res = migrateLegacyConfig({
      routing: {
        transcribeAudio: {
          command: ["whisper", "--model", "base"],
          timeoutSeconds: 2,
        },
      },
    });

    expect(res.changes).toContain("Moved routing.transcribeAudio → tools.media.audio.models.");
    expect(res.config?.tools?.media?.audio).toEqual({
      enabled: true,
      models: [
        {
          command: "whisper",
          type: "cli",
          args: ["--model", "base"],
          timeoutSeconds: 2,
        },
      ],
    });
    expect((res.config as { routing?: unknown } | null)?.routing).toBeUndefined();
  });

  it("keeps existing tools media model and drops legacy routing value", () => {
    const res = migrateLegacyConfig({
      routing: {
        transcribeAudio: {
          command: ["whisper", "--model", "tiny"],
        },
      },
      tools: {
        media: {
          audio: {
            models: [{ command: "existing", type: "cli" }],
          },
        },
      },
    });

    expect(res.changes).toContain(
      "Removed routing.transcribeAudio (tools.media.audio.models already set).",
    );
    expect(res.config?.tools?.media?.audio?.models).toEqual([{ command: "existing", type: "cli" }]);
    expect((res.config as { routing?: unknown } | null)?.routing).toBeUndefined();
  });

  it("drops invalid audio.transcription payloads", () => {
    const res = migrateLegacyConfig({
      audio: {
        transcription: {
          command: [{}],
        },
      },
    });

    expect(res.changes).toContain("Removed audio.transcription (invalid or empty command).");
    expect((res.config as { audio?: unknown } | null)?.audio).toBeUndefined();
    expect(res.config?.tools?.media?.audio).toBeUndefined();
  });
});

describe("legacy migrate top-level media", () => {
  it("moves preserveFilenames to Microsoft Teams channel config", () => {
    const res = migrateLegacyConfig({
      media: {
        preserveFilenames: true,
      },
    });

    expect(res.changes).toContain(
      "Moved media.preserveFilenames → channels.msteams.preserveFilenames.",
    );
    expect(res.config?.channels?.msteams?.preserveFilenames).toBe(true);
    expect((res.config as { media?: unknown } | null)?.media).toBeUndefined();
  });

  it("drops preserveFilenames when Microsoft Teams already has the setting", () => {
    const res = migrateLegacyConfig({
      media: {
        preserveFilenames: false,
      },
      channels: {
        msteams: {
          preserveFilenames: true,
        },
      },
    });

    expect(res.changes).toContain(
      "Removed media.preserveFilenames (channels.msteams.preserveFilenames already set).",
    );
    expect(res.config?.channels?.msteams?.preserveFilenames).toBe(true);
    expect((res.config as { media?: unknown } | null)?.media).toBeUndefined();
  });
});

describe("legacy migrate mention routing", () => {
  it("moves routing.groupChat.requireMention into channel group defaults", () => {
    const res = migrateLegacyConfig({
      routing: {
        groupChat: {
          requireMention: true,
        },
      },
    });

    expect(res.changes).toContain(
      'Moved routing.groupChat.requireMention → channels.telegram.groups."*".requireMention.',
    );
    expect(res.changes).toContain(
      'Moved routing.groupChat.requireMention → channels.imessage.groups."*".requireMention.',
    );
    expect(res.config?.channels?.telegram?.groups?.["*"]?.requireMention).toBe(true);
    expect(res.config?.channels?.imessage?.groups?.["*"]?.requireMention).toBe(true);
    expect((res.config as { routing?: unknown } | null)?.routing).toBeUndefined();
  });

  it("moves channels.telegram.requireMention into groups.*.requireMention", () => {
    const res = migrateLegacyConfig({
      channels: {
        telegram: {
          requireMention: false,
        },
      },
    });

    expect(res.changes).toContain(
      'Moved telegram.requireMention → channels.telegram.groups."*".requireMention.',
    );
    expect(res.config?.channels?.telegram?.groups?.["*"]?.requireMention).toBe(false);
    expect(
      (res.config?.channels?.telegram as { requireMention?: unknown } | undefined)?.requireMention,
    ).toBeUndefined();
  });
});
