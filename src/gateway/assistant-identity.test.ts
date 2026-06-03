import { describe, expect, it } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";
import { DEFAULT_ASSISTANT_IDENTITY, resolveAssistantIdentity } from "./assistant-identity.js";

describe("resolveAssistantIdentity avatar normalization", () => {
  it("drops sentence-like avatar placeholders", () => {
    const cfg: FasedAgentConfig = {
      ui: {
        assistant: {
          avatar: "workspace-relative path, http(s) URL, or data URI",
        },
      },
    };

    expect(resolveAssistantIdentity({ cfg, workspaceDir: "" }).avatar).toBe(
      DEFAULT_ASSISTANT_IDENTITY.avatar,
    );
  });

  it("keeps short text avatars", () => {
    const cfg: FasedAgentConfig = {
      ui: {
        assistant: {
          avatar: "PS",
        },
      },
    };

    expect(resolveAssistantIdentity({ cfg, workspaceDir: "" }).avatar).toBe("PS");
  });

  it("keeps path avatars", () => {
    const cfg: FasedAgentConfig = {
      ui: {
        assistant: {
          avatar: "avatars/fased.png",
        },
      },
    };

    expect(resolveAssistantIdentity({ cfg, workspaceDir: "" }).avatar).toBe("avatars/fased.png");
  });

  it("prefers Agent identity over legacy global UI fallback", () => {
    const cfg: FasedAgentConfig = {
      ui: {
        assistant: {
          name: "Global",
          avatar: "G",
        },
      },
      agents: {
        list: [
          {
            id: "main",
            identity: {
              name: "Agent",
              avatar: "A",
            },
          },
        ],
      },
    };

    expect(resolveAssistantIdentity({ cfg, agentId: "main", workspaceDir: "" })).toMatchObject({
      name: "Agent",
      avatar: "A",
    });
  });
});
