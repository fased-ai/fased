import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { analyzeConfigSchema, renderConfigForm } from "./views/config-form.ts";

const rootSchema = {
  type: "object",
  properties: {
    gateway: {
      type: "object",
      properties: {
        auth: {
          type: "object",
          properties: {
            token: { type: "string" },
          },
        },
      },
    },
    allowFrom: {
      type: "array",
      items: { type: "string" },
    },
    mode: {
      type: "string",
      enum: ["off", "token"],
    },
    enabled: {
      type: "boolean",
    },
    bind: {
      anyOf: [{ const: "auto" }, { const: "lan" }, { const: "tailnet" }, { const: "loopback" }],
    },
  },
};

describe("config form renderer", () => {
  it("renders inputs and patches values", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    const analysis = analyzeConfigSchema(rootSchema);
    render(
      renderConfigForm({
        schema: analysis.schema,
        uiHints: {
          "gateway.auth.token": { label: "Gateway Token", sensitive: true },
        },
        unsupportedPaths: analysis.unsupportedPaths,
        value: {},
        revealSensitive: true,
        onPatch,
      }),
      container,
    );

    const tokenInput: HTMLInputElement | null = container.querySelector(
      '#config-section-gateway input.cfg-input[type="text"]',
    );
    expect(tokenInput).not.toBeNull();
    if (!tokenInput) {
      return;
    }
    tokenInput.value = "abc123";
    tokenInput.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["gateway", "auth", "token"], "abc123");

    const tokenButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".cfg-segmented__btn"),
    ).find((btn) => btn.textContent?.trim() === "token");
    expect(tokenButton).not.toBeUndefined();
    tokenButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["mode"], "token");

    const checkbox: HTMLInputElement | null = container.querySelector("input[type='checkbox']");
    expect(checkbox).not.toBeNull();
    if (!checkbox) {
      return;
    }
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["enabled"], true);
  });

  it("adds and removes array entries", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    const analysis = analyzeConfigSchema(rootSchema);
    render(
      renderConfigForm({
        schema: analysis.schema,
        uiHints: {},
        unsupportedPaths: analysis.unsupportedPaths,
        value: { allowFrom: ["+1"] },
        onPatch,
      }),
      container,
    );

    const addButton = container.querySelector(".cfg-array__add");
    expect(addButton).not.toBeUndefined();
    addButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["allowFrom"], ["+1", ""]);

    const removeButton = container.querySelector(".cfg-array__item-remove");
    expect(removeButton).not.toBeUndefined();
    removeButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["allowFrom"], []);
  });

  it("renders union literals as select options", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    const analysis = analyzeConfigSchema(rootSchema);
    render(
      renderConfigForm({
        schema: analysis.schema,
        uiHints: {},
        unsupportedPaths: analysis.unsupportedPaths,
        value: { bind: "auto" },
        onPatch,
      }),
      container,
    );

    const tailnetButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".cfg-segmented__btn"),
    ).find((btn) => btn.textContent?.trim() === "tailnet");
    expect(tailnetButton).not.toBeUndefined();
    tailnetButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["bind"], "tailnet");
  });

  it("keeps normal wallet config focused on self-hosted Solana options and hides runtime plumbing", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    const schema = {
      type: "object",
      properties: {
        wallet: {
          type: "object",
          properties: {
            provider: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                  enum: ["embedded-keystore", "local-socket-signer", "alchemy", "turnkey", "privy"],
                },
              },
            },
            runtime: {
              type: "object",
              properties: {
                chains: {
                  type: "array",
                  items: { type: "string", enum: ["solana"] },
                },
                policy: {
                  type: "object",
                  properties: {
                    directSigning: { type: "boolean" },
                    solana: {
                      type: "object",
                      properties: {
                        maxDaily: { type: "string" },
                      },
                    },
                  },
                },
                service: {
                  type: "object",
                  properties: {
                    host: { type: "string" },
                  },
                },
                auth: {
                  type: "object",
                  properties: {
                    bootstrapUrl: { type: "string" },
                  },
                },
                source: {
                  type: "object",
                  properties: {
                    ref: { type: "string" },
                  },
                },
                install: {
                  type: "object",
                  properties: {
                    version: { type: "string" },
                  },
                },
                toolAccess: {
                  type: "object",
                  properties: {
                    mode: { type: "string", enum: ["owner-only", "allowlist", "all"] },
                  },
                },
              },
            },
          },
        },
      },
    };
    const analysis = analyzeConfigSchema(schema);
    render(
      renderConfigForm({
        schema: analysis.schema,
        uiHints: {
          "wallet.provider.id": { label: "Wallet Provider" },
          "wallet.runtime.chains": { label: "Wallet Chains" },
          "wallet.runtime.policy.directSigning": { label: "Wallet Direct Signing" },
          "wallet.runtime.policy.solana.maxDaily": { label: "Wallet Solana Max Daily" },
          "wallet.runtime.service.host": { label: "Wallet Service Host" },
          "wallet.runtime.auth.bootstrapUrl": { label: "Wallet Runtime Auth Bootstrap URL" },
          "wallet.runtime.source.ref": { label: "Wallet Source Ref" },
          "wallet.runtime.install.version": { label: "Wallet Runtime Install Version" },
          "wallet.runtime.toolAccess.mode": { label: "Wallet Tool Access Mode" },
        },
        unsupportedPaths: analysis.unsupportedPaths,
        value: {
          wallet: {
            provider: { id: "local-socket-signer" },
            runtime: {
              chains: ["solana"],
              policy: { directSigning: false, solana: { maxDaily: "1" } },
              service: { host: "127.0.0.1" },
              auth: { bootstrapUrl: "http://127.0.0.1:7777/bootstrap" },
              source: { ref: "compat" },
              install: { version: "local" },
              toolAccess: { mode: "owner-only" },
            },
          },
        },
        onPatch,
      }),
      container,
    );

    const text = container.textContent ?? "";
    expect(text).not.toContain("embedded-keystore");
    expect(text).toContain("local-socket-signer");
    expect(text).toContain("Wallet Chains");
    expect(text).toContain("Normal Config only exposes self-hosted wallet providers");
    expect(text).not.toContain("alchemy");
    expect(text).not.toContain("turnkey");
    expect(text).not.toContain("privy");
    expect(text).not.toContain("Wallet Direct Signing");
    expect(text).not.toContain("Wallet Solana Max Daily");
    expect(text).not.toContain("Wallet Service Host");
    expect(text).not.toContain("Wallet Runtime Auth Bootstrap URL");
    expect(text).not.toContain("Wallet Source Ref");
    expect(text).not.toContain("Wallet Runtime Install Version");
    expect(text).not.toContain("Wallet Tool Access Mode");

    const chainButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".cfg-segmented__btn"),
    )
      .map((button) => button.textContent?.trim())
      .filter(Boolean);
    expect(chainButtons).toContain("solana");
    expect(chainButtons.filter((button) => button === "solana")).toHaveLength(1);
  });

  it("renders map fields from additionalProperties", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    const schema = {
      type: "object",
      properties: {
        slack: {
          type: "object",
          additionalProperties: {
            type: "string",
          },
        },
      },
    };
    const analysis = analyzeConfigSchema(schema);
    render(
      renderConfigForm({
        schema: analysis.schema,
        uiHints: {},
        unsupportedPaths: analysis.unsupportedPaths,
        value: { slack: { channelA: "ok" } },
        onPatch,
      }),
      container,
    );

    const removeButton = container.querySelector(".cfg-map__item-remove");
    expect(removeButton).not.toBeUndefined();
    removeButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["slack"], {});
  });

  it("supports wildcard uiHints for map entries", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    const schema = {
      type: "object",
      properties: {
        plugins: {
          type: "object",
          properties: {
            entries: {
              type: "object",
              additionalProperties: {
                type: "object",
                properties: {
                  enabled: { type: "boolean" },
                },
              },
            },
          },
        },
      },
    };
    const analysis = analyzeConfigSchema(schema);
    render(
      renderConfigForm({
        schema: analysis.schema,
        uiHints: {
          "plugins.entries.*.enabled": { label: "Plugin Enabled" },
        },
        unsupportedPaths: analysis.unsupportedPaths,
        value: { plugins: { entries: { "voice-call": { enabled: true } } } },
        onPatch,
      }),
      container,
    );

    expect(container.textContent).toContain("Plugin Enabled");
  });

  it("renders tags from uiHints metadata", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    const analysis = analyzeConfigSchema(rootSchema);
    render(
      renderConfigForm({
        schema: analysis.schema,
        uiHints: {
          "gateway.auth.token": { tags: ["security", "secret"] },
        },
        unsupportedPaths: analysis.unsupportedPaths,
        value: {},
        onPatch,
      }),
      container,
    );

    const tags = Array.from(container.querySelectorAll(".cfg-tag")).map((node) =>
      node.textContent?.trim(),
    );
    expect(tags).toContain("security");
    expect(tags).toContain("secret");
  });

  it("filters by tag query", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    const analysis = analyzeConfigSchema(rootSchema);
    render(
      renderConfigForm({
        schema: analysis.schema,
        uiHints: {
          "gateway.auth.token": { tags: ["security"] },
        },
        unsupportedPaths: analysis.unsupportedPaths,
        value: {},
        searchQuery: "tag:security",
        onPatch,
      }),
      container,
    );

    expect(container.textContent).toContain("Gateway");
    expect(container.textContent).toContain("Token");
    expect(container.textContent).not.toContain("Allow From");
    expect(container.textContent).not.toContain("Mode");
  });

  it("does not treat plain text as tag filter", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    const analysis = analyzeConfigSchema(rootSchema);
    render(
      renderConfigForm({
        schema: analysis.schema,
        uiHints: {
          "gateway.auth.token": { tags: ["security"] },
        },
        unsupportedPaths: analysis.unsupportedPaths,
        value: {},
        searchQuery: "security",
        onPatch,
      }),
      container,
    );

    expect(container.textContent).toContain('No settings match "security"');
  });

  it("requires both text and tag when combined", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    const analysis = analyzeConfigSchema(rootSchema);
    render(
      renderConfigForm({
        schema: analysis.schema,
        uiHints: {
          "gateway.auth.token": { tags: ["security"] },
        },
        unsupportedPaths: analysis.unsupportedPaths,
        value: {},
        searchQuery: "token tag:security",
        onPatch,
      }),
      container,
    );

    expect(container.textContent).toContain("Token");
    expect(container.textContent).not.toContain('No settings match "token tag:security"');

    const noMatchContainer = document.createElement("div");
    render(
      renderConfigForm({
        schema: analysis.schema,
        uiHints: {
          "gateway.auth.token": { tags: ["security"] },
        },
        unsupportedPaths: analysis.unsupportedPaths,
        value: {},
        searchQuery: "mode tag:security",
        onPatch,
      }),
      noMatchContainer,
    );
    expect(noMatchContainer.textContent).toContain('No settings match "mode tag:security"');
  });

  it("supports SecretInput unions in additionalProperties maps", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    const schema = {
      type: "object",
      properties: {
        models: {
          type: "object",
          properties: {
            providers: {
              type: "object",
              additionalProperties: {
                type: "object",
                properties: {
                  apiKey: {
                    anyOf: [
                      { type: "string" },
                      {
                        oneOf: [
                          {
                            type: "object",
                            properties: {
                              source: { type: "string", const: "env" },
                              provider: { type: "string" },
                              id: { type: "string" },
                            },
                            required: ["source", "provider", "id"],
                            additionalProperties: false,
                          },
                          {
                            type: "object",
                            properties: {
                              source: { type: "string", const: "file" },
                              provider: { type: "string" },
                              id: { type: "string" },
                            },
                            required: ["source", "provider", "id"],
                            additionalProperties: false,
                          },
                        ],
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      },
    };
    const analysis = analyzeConfigSchema(schema);
    expect(analysis.unsupportedPaths).not.toContain("models.providers");
    expect(analysis.unsupportedPaths).not.toContain("models.providers.*.apiKey");

    render(
      renderConfigForm({
        schema: analysis.schema,
        uiHints: {
          "models.providers.*.apiKey": { sensitive: true },
        },
        unsupportedPaths: analysis.unsupportedPaths,
        value: { models: { providers: { openai: { apiKey: "old" } } } }, // pragma: allowlist secret
        revealSensitive: true,
        onPatch,
      }),
      container,
    );

    const apiKeyInput: HTMLInputElement | null = container.querySelector(
      "#config-section-models .cfg-map__item-value input.cfg-input[type='text']",
    );
    expect(apiKeyInput).not.toBeNull();
    if (!apiKeyInput) {
      return;
    }
    apiKeyInput.value = "new-key";
    apiKeyInput.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["models", "providers", "openai", "apiKey"], "new-key");
  });

  it("keeps channel account maps editable when account children have complex unions", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    const schema = {
      type: "object",
      properties: {
        channels: {
          type: "object",
          properties: {
            telegram: {
              type: "object",
              properties: {
                accounts: {
                  type: "object",
                  additionalProperties: {
                    type: "object",
                    properties: {
                      enabled: { type: "boolean" },
                      capabilities: {
                        anyOf: [
                          { type: "array", items: { type: "string" } },
                          {
                            type: "object",
                            properties: {
                              inlineButtons: {
                                type: "string",
                                enum: ["off", "dm", "group", "all", "allowlist"],
                              },
                            },
                            additionalProperties: false,
                          },
                        ],
                      },
                      commands: {
                        type: "object",
                        properties: {
                          native: {
                            anyOf: [{ type: "boolean" }, { const: "auto" }],
                          },
                        },
                      },
                      customCommands: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            command: {},
                            description: {},
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    const analysis = analyzeConfigSchema(schema);
    expect(analysis.unsupportedPaths).not.toContain("channels.telegram.accounts");
    expect(analysis.unsupportedPaths).not.toContain("channels.telegram.accounts.*");

    render(
      renderConfigForm({
        schema: analysis.schema,
        uiHints: {},
        unsupportedPaths: analysis.unsupportedPaths,
        value: {
          channels: {
            telegram: {
              accounts: {
                default: {
                  enabled: true,
                  capabilities: { inlineButtons: "dm" },
                  commands: { native: "auto" },
                  customCommands: [{ command: "/sum", description: "Summarize" }],
                },
              },
            },
          },
        },
        onPatch,
      }),
      container,
    );

    expect(container.textContent).toContain("Accounts");
    expect(container.textContent).not.toContain("Unsupported schema node");

    const enabledCheckbox: HTMLInputElement | null =
      container.querySelector("input[type='checkbox']");
    expect(enabledCheckbox).not.toBeNull();
    enabledCheckbox?.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(
      ["channels", "telegram", "accounts", "default", "enabled"],
      enabledCheckbox?.checked,
    );
  });

  it("accepts renderable unions", () => {
    const schema = {
      type: "object",
      properties: {
        mixed: {
          anyOf: [{ type: "string" }, { type: "object", properties: {} }],
        },
      },
    };
    const analysis = analyzeConfigSchema(schema);
    expect(analysis.unsupportedPaths).not.toContain("mixed");
  });

  it("supports nullable types", () => {
    const schema = {
      type: "object",
      properties: {
        note: { type: ["string", "null"] },
      },
    };
    const analysis = analyzeConfigSchema(schema);
    expect(analysis.unsupportedPaths).not.toContain("note");
  });

  it("ignores untyped additionalProperties schemas", () => {
    const schema = {
      type: "object",
      properties: {
        channels: {
          type: "object",
          properties: {
            whatsapp: {
              type: "object",
              properties: {
                enabled: { type: "boolean" },
              },
            },
          },
          additionalProperties: {},
        },
      },
    };
    const analysis = analyzeConfigSchema(schema);
    expect(analysis.unsupportedPaths).not.toContain("channels");
  });

  it("treats additionalProperties true as editable map fields", () => {
    const schema = {
      type: "object",
      properties: {
        accounts: {
          type: "object",
          additionalProperties: true,
        },
      },
    };
    const analysis = analyzeConfigSchema(schema);
    expect(analysis.unsupportedPaths).not.toContain("accounts");

    const onPatch = vi.fn();
    const container = document.createElement("div");
    render(
      renderConfigForm({
        schema: analysis.schema,
        uiHints: {},
        unsupportedPaths: analysis.unsupportedPaths,
        value: { accounts: { default: { enabled: true } } },
        onPatch,
      }),
      container,
    );

    const removeButton = container.querySelector(".cfg-map__item-remove");
    expect(removeButton).not.toBeNull();
    removeButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["accounts"], {});
  });
});
