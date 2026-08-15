import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderConfig, type ConfigProps } from "./config.ts";

describe("config view", () => {
  const baseProps = (): ConfigProps => ({
    raw: "{\n}\n",
    originalRaw: "{\n}\n",
    valid: true,
    issues: [],
    loading: false,
    saving: false,
    applying: false,
    connected: true,
    schema: {
      type: "object",
      properties: {},
    },
    schemaLoading: false,
    authStatus: null,
    modelCatalogStatus: null,
    authActionBusyProfileId: null,
    authAction: null,
    uiHints: {},
    formMode: "form" as const,
    formValue: {},
    originalValue: {},
    searchQuery: "",
    activeSection: null,
    activeSubsection: null,
    onRawChange: vi.fn(),
    onFormModeChange: vi.fn(),
    onFormPatch: vi.fn(),
    onSearchChange: vi.fn(),
    onSectionChange: vi.fn(),
    onReload: vi.fn(),
    onSave: vi.fn(),
    onApply: vi.fn(),
    onSubsectionChange: vi.fn(),
    onStoreProfileCredential: vi.fn(),
    onRunInteractiveProfileAuth: vi.fn(),
    onClearProfileCredential: vi.fn(),
  });

  it("allows save when form is unsafe", () => {
    const container = document.createElement("div");
    render(
      renderConfig({
        ...baseProps(),
        schema: {
          type: "object",
          properties: {
            mixed: {
              anyOf: [{ type: "string" }, { type: "object", properties: {} }],
            },
          },
        },
        schemaLoading: false,
        uiHints: {},
        formMode: "form",
        formValue: { mixed: "x" },
      }),
      container,
    );

    const saveButton = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "Save",
    );
    expect(saveButton).not.toBeUndefined();
    expect(saveButton?.disabled).toBe(false);
  });

  it("disables save when schema is missing", () => {
    const container = document.createElement("div");
    render(
      renderConfig({
        ...baseProps(),
        schema: null,
        formMode: "form",
        formValue: { gateway: { mode: "local" } },
        originalValue: {},
      }),
      container,
    );

    const saveButton = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "Save",
    );
    expect(saveButton).not.toBeUndefined();
    expect(saveButton?.disabled).toBe(true);
  });

  it("shows config load errors inline", () => {
    const container = document.createElement("div");
    render(
      renderConfig({
        ...baseProps(),
        error: "config.get failed",
      }),
      container,
    );

    expect(container.textContent).toContain("config.get failed");
  });

  it("disables save and apply when raw is unchanged", () => {
    const container = document.createElement("div");
    render(
      renderConfig({
        ...baseProps(),
        formMode: "raw",
        raw: "{\n}\n",
        originalRaw: "{\n}\n",
      }),
      container,
    );

    const saveButton = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "Save",
    );
    const applyButton = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "Apply",
    );
    expect(saveButton).not.toBeUndefined();
    expect(applyButton).not.toBeUndefined();
    expect(saveButton?.disabled).toBe(true);
    expect(applyButton?.disabled).toBe(true);
  });

  it("enables save and apply when raw changes", () => {
    const container = document.createElement("div");
    render(
      renderConfig({
        ...baseProps(),
        formMode: "raw",
        raw: '{\n  gateway: { mode: "local" }\n}\n',
        originalRaw: "{\n}\n",
      }),
      container,
    );

    const saveButton = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "Save",
    );
    const applyButton = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "Apply",
    );
    expect(saveButton).not.toBeUndefined();
    expect(applyButton).not.toBeUndefined();
    expect(saveButton?.disabled).toBe(false);
    expect(applyButton?.disabled).toBe(false);
  });

  it("switches mode via the sidebar toggle", () => {
    const container = document.createElement("div");
    const onFormModeChange = vi.fn();
    render(
      renderConfig({
        ...baseProps(),
        onFormModeChange,
      }),
      container,
    );

    const btn = container.querySelector<HTMLButtonElement>('button[aria-label="Raw"]');
    expect(btn).toBeTruthy();
    btn?.click();
    expect(onFormModeChange).toHaveBeenCalledWith("raw");
  });

  it("switches sections from the sidebar", () => {
    const container = document.createElement("div");
    const onSectionChange = vi.fn();
    render(
      renderConfig({
        ...baseProps(),
        onSectionChange,
        schema: {
          type: "object",
          properties: {
            gateway: { type: "object", properties: {} },
            agents: { type: "object", properties: {} },
          },
        },
      }),
      container,
    );

    const btn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Gateway",
    );
    expect(btn).toBeTruthy();
    btn?.click();
    expect(onSectionChange).toHaveBeenCalledWith("gateway");
  });

  it("wires search input to onSearchChange", () => {
    const container = document.createElement("div");
    const onSearchChange = vi.fn();
    render(
      renderConfig({
        ...baseProps(),
        onSearchChange,
      }),
      container,
    );

    const input = container.querySelector(".config-search__input");
    expect(input).not.toBeNull();
    if (!input) {
      return;
    }
    (input as HTMLInputElement).value = "gateway";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onSearchChange).toHaveBeenCalledWith("gateway");
  });

  it("keeps advanced config search compact without a visible tag picker", () => {
    const container = document.createElement("div");
    render(renderConfig(baseProps()), container);

    expect(container.querySelector(".config-search__input")).not.toBeNull();
    expect(container.querySelector(".config-search__tag-picker")).toBeNull();
  });

  it("positions Config as a lean Advanced Config editor with section navigation", () => {
    const container = document.createElement("div");
    render(
      renderConfig({
        ...baseProps(),
        schema: {
          type: "object",
          properties: {
            env: { type: "object", properties: {} },
            acp: { type: "object", properties: {} },
            approvals: { type: "object", properties: {} },
            auth: { type: "object", properties: {} },
            models: { type: "object", properties: {} },
            agents: { type: "object", properties: {} },
            skills: { type: "object", properties: {} },
            channels: { type: "object", properties: {} },
            bindings: { type: "array", items: { type: "object" } },
            broadcast: { type: "object", properties: {} },
            talk: { type: "object", properties: {} },
            commands: { type: "object", properties: {} },
            messages: { type: "object", properties: {} },
            meta: { type: "object", properties: {} },
            hooks: { type: "object", properties: {} },
            session: { type: "object", properties: {} },
            memory: { type: "object", properties: {} },
            mcp: { type: "object", properties: {} },
            media: { type: "object", properties: { preserveFilenames: { type: "boolean" } } },
            plugins: { type: "object", properties: {} },
            cron: { type: "object", properties: {} },
            wallet: { type: "object", properties: {} },
            federation: { type: "object", properties: {} },
            gateway: { type: "object", properties: {} },
            nodeHost: { type: "object", properties: {} },
            discovery: { type: "object", properties: {} },
            update: { type: "object", properties: {} },
            web: { type: "object", properties: {} },
          },
        },
      }),
      container,
    );

    const text = container.textContent ?? "";
    expect(text).toContain("Advanced Config");
    expect(container.querySelector(".config-advanced-banner")).toBeNull();
    expect(container.querySelector(".config-friendly-link")).toBeNull();

    const labels = Array.from(container.querySelectorAll(".config-nav__label")).map((node) =>
      node.textContent?.trim(),
    );
    expect(labels).toEqual(
      expect.arrayContaining(["ACP Runtime", "Gateway", "Node Host", "Bindings", "Broadcast"]),
    );
    expect(labels).not.toContain("All Settings");
    expect(labels).not.toContain("Agents");
    expect(labels).not.toContain("Approvals");
    expect(labels).not.toContain("Canvas Host");
    expect(labels).not.toContain("Network");
    expect(labels).not.toContain("Authentication");
    expect(labels).not.toContain("Environment");
    expect(labels).not.toContain("Hooks");
    expect(labels).not.toContain("Memory");
    expect(labels).not.toContain("MCP");
    expect(labels).not.toContain("Metadata");
    expect(labels).not.toContain("Messages");
    expect(labels).not.toContain("Models");
    expect(labels).not.toContain("Plugins");
    expect(labels).not.toContain("Skills");
    expect(labels).not.toContain("Session");
    expect(labels).not.toContain("Tasks");
    expect(labels).not.toContain("Updates");
    expect(labels).not.toContain("Channels");
    expect(labels).not.toContain("Commands");
    expect(labels).not.toContain("Wallet");
    expect(labels).not.toContain("Talk");
    expect(labels).not.toContain("Media");
    expect(labels).not.toContain("Web");
    expect(labels).not.toContain("Discovery");
    expect(labels).not.toContain("Setup Wizard");
    expect(labels).not.toContain("Diagnostics");
    expect(labels).not.toContain("Logging");
    expect(labels).not.toContain("Browser");
    expect(container.querySelector(".config-section-index")).not.toBeNull();
  });

  it("treats ACP config as advanced external harness plumbing", () => {
    const container = document.createElement("div");
    render(
      renderConfig({
        ...baseProps(),
        activeSection: "acp",
        schema: {
          type: "object",
          properties: {
            acp: {
              type: "object",
              properties: {
                enabled: { type: "boolean" },
                backend: { type: "string" },
                allowedAgents: { type: "array", items: { type: "string" } },
              },
            },
          },
        },
        formValue: {
          acp: {
            enabled: true,
            backend: "acpx",
            allowedAgents: ["codex"],
          },
        },
        originalValue: {
          acp: {
            enabled: true,
            backend: "acpx",
            allowedAgents: ["codex"],
          },
        },
      }),
      container,
    );

    const text = container.textContent ?? "";
    const shortcuts = Array.from(
      container.querySelectorAll<HTMLAnchorElement>(".config-section-shortcut"),
    ).map((link) => `${link.textContent?.trim()} ${link.getAttribute("href")}`);
    expect(shortcuts).toEqual(
      expect.arrayContaining([
        "Debug /debug",
        "Extensions /extensions",
        "Agents /agents",
        "Channels /channels",
      ]),
    );
    expect(text).toContain("ACP config is advanced external harness plumbing");
    expect(text).toContain("Use Debug for ACPX bridge/runtime inspection");
    expect(text).toContain("global ACP gate, dispatch, backend id");
  });

  it("keeps auto-stamped config metadata out of generated Advanced Config", () => {
    const container = document.createElement("div");
    render(
      renderConfig({
        ...baseProps(),
        activeSection: "meta",
        schema: {
          type: "object",
          properties: {
            meta: {
              type: "object",
              properties: {
                lastTouchedVersion: { type: "string" },
                lastTouchedAt: { type: "string" },
              },
            },
            gateway: { type: "object", properties: {} },
          },
        },
        formValue: {
          meta: {
            lastTouchedVersion: "0.1.1",
            lastTouchedAt: "2026-05-17T00:00:00.000Z",
          },
        },
        originalValue: {
          meta: {
            lastTouchedVersion: "0.1.1",
            lastTouchedAt: "2026-05-17T00:00:00.000Z",
          },
        },
      }),
      container,
    );

    const labels = Array.from(container.querySelectorAll(".config-nav__label")).map((node) =>
      node.textContent?.trim(),
    );
    expect(labels).toContain("Gateway");
    expect(labels).not.toContain("Metadata");
    expect(container.querySelector(".config-section-index")).not.toBeNull();
    expect(container.textContent ?? "").not.toContain("Last Touched");
    expect(container.textContent ?? "").not.toContain("0.1.1");
  });

  it("shows section-specific friendly shortcuts for advanced sections", () => {
    const container = document.createElement("div");
    render(
      renderConfig({
        ...baseProps(),
        activeSection: "gateway",
        schema: {
          type: "object",
          properties: {
            gateway: { type: "object", properties: {} },
          },
        },
      }),
      container,
    );

    const sectionShortcuts = Array.from(
      container.querySelectorAll<HTMLAnchorElement>(".config-section-shortcut"),
    ).map((link) => `${link.textContent?.trim()} ${link.getAttribute("href")}`);
    expect(sectionShortcuts).toEqual(expect.arrayContaining(["Debug /debug"]));
  });

  it("treats Bindings config as advanced channel route rules", () => {
    const container = document.createElement("div");
    render(
      renderConfig({
        ...baseProps(),
        activeSection: "bindings",
        schema: {
          type: "object",
          properties: {
            bindings: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  agentId: { type: "string" },
                  match: { type: "object", properties: { channel: { type: "string" } } },
                },
              },
            },
          },
        },
        formValue: {
          bindings: [
            {
              agentId: "research",
              match: { channel: "telegram", accountId: "ops" },
            },
          ],
        },
        originalValue: {
          bindings: [
            {
              agentId: "research",
              match: { channel: "telegram", accountId: "ops" },
            },
          ],
        },
      }),
      container,
    );

    const text = container.textContent ?? "";
    const shortcuts = Array.from(
      container.querySelectorAll<HTMLAnchorElement>(".config-section-shortcut"),
    ).map((link) => `${link.textContent?.trim()} ${link.getAttribute("href")}`);
    expect(shortcuts).toEqual(expect.arrayContaining(["Channels /channels", "Agents /agents"]));
    expect(text).toContain("Bindings are advanced channel-to-Agent route rules");
    expect(text).toContain("Use Channels for normal account routing");
    expect(text).toContain("most-specific match wins");
  });

  it("treats Broadcast config as experimental multi-Agent channel fanout", () => {
    const container = document.createElement("div");
    render(
      renderConfig({
        ...baseProps(),
        activeSection: "broadcast",
        schema: {
          type: "object",
          properties: {
            broadcast: {
              type: "object",
              properties: {
                strategy: { type: "string", enum: ["parallel", "sequential"] },
                "120363403215116621@g.us": {
                  type: "array",
                  items: { type: "string" },
                },
              },
            },
          },
        },
        formValue: {
          broadcast: {
            strategy: "parallel",
            "120363403215116621@g.us": ["research", "logger"],
          },
        },
        originalValue: {
          broadcast: {
            strategy: "parallel",
            "120363403215116621@g.us": ["research", "logger"],
          },
        },
      }),
      container,
    );

    const text = container.textContent ?? "";
    const shortcuts = Array.from(
      container.querySelectorAll<HTMLAnchorElement>(".config-section-shortcut"),
    ).map((link) => `${link.textContent?.trim()} ${link.getAttribute("href")}`);
    expect(shortcuts).toEqual(expect.arrayContaining(["Channels /channels", "Agents /agents"]));
    expect(text).toContain("Broadcast config is experimental multi-Agent channel fanout");
    expect(text).toContain("WhatsApp peers");
    expect(text).toContain("source peer ID to multiple Agent IDs");
  });

  it("keeps legacy Audio config out of generated Advanced Config", () => {
    const container = document.createElement("div");
    render(
      renderConfig({
        ...baseProps(),
        activeSection: "audio",
        schema: {
          type: "object",
          properties: {
            audio: {
              type: "object",
              properties: {
                transcription: {
                  type: "object",
                  properties: {
                    command: { type: "array", items: { type: "string" } },
                    timeoutSeconds: { type: "number" },
                  },
                },
              },
            },
          },
        },
        formValue: {
          audio: {
            transcription: { command: ["whisper-cli", "--input", "{input}"] },
          },
        },
        originalValue: {
          audio: {
            transcription: { command: ["whisper-cli", "--input", "{input}"] },
          },
        },
      }),
      container,
    );

    const text = container.textContent ?? "";
    const labels = Array.from(container.querySelectorAll(".config-nav__label")).map((node) =>
      node.textContent?.trim(),
    );
    expect(labels).not.toContain("Audio");
    expect(text).not.toContain("Audio config is legacy local transcription plumbing");
    expect(text).not.toContain("whisper-cli");
  });

  it("keeps Talk API/provider config out of generated Advanced Config", () => {
    const container = document.createElement("div");
    render(
      renderConfig({
        ...baseProps(),
        activeSection: "talk",
        schema: {
          type: "object",
          properties: {
            talk: {
              type: "object",
              properties: {
                provider: { type: "string" },
                voiceId: { type: "string" },
                modelId: { type: "string" },
                outputFormat: { type: "string" },
                interruptOnSpeech: { type: "boolean" },
              },
            },
          },
        },
        formValue: {
          talk: {
            provider: "elevenlabs",
            voiceId: "voice-123",
            modelId: "eleven_multilingual_v2",
            interruptOnSpeech: true,
          },
        },
        originalValue: {
          talk: {
            provider: "elevenlabs",
            voiceId: "voice-123",
            modelId: "eleven_multilingual_v2",
            interruptOnSpeech: true,
          },
        },
      }),
      container,
    );

    const text = container.textContent ?? "";
    const labels = Array.from(container.querySelectorAll(".config-nav__label")).map((node) =>
      node.textContent?.trim(),
    );
    expect(labels).not.toContain("Talk");
    expect(text).not.toContain("Talk config is live voice-conversation plumbing");
    expect(text).not.toContain("provider aliases");
    expect(text).not.toContain("eleven_multilingual_v2");
  });

  it("routes Gateway config users to Overview or Debug before raw edits", () => {
    const container = document.createElement("div");
    render(
      renderConfig({
        ...baseProps(),
        activeSection: "gateway",
        schema: {
          type: "object",
          properties: {
            gateway: {
              type: "object",
              properties: {
                mode: { type: "string" },
                port: { type: "number" },
                bind: { type: "string" },
                auth: { type: "object", properties: {} },
                controlUi: { type: "object", properties: {} },
              },
            },
          },
        },
        formValue: {
          gateway: {
            mode: "local",
            port: 18789,
            bind: "127.0.0.1",
            auth: { mode: "token" },
            controlUi: { allowedOrigins: [] },
          },
        },
        originalValue: {
          gateway: {
            mode: "local",
            port: 18789,
            bind: "127.0.0.1",
            auth: { mode: "token" },
            controlUi: { allowedOrigins: [] },
          },
        },
      }),
      container,
    );

    const text = container.textContent ?? "";
    const shortcuts = Array.from(
      container.querySelectorAll<HTMLAnchorElement>(".config-section-shortcut"),
    ).map((link) => `${link.textContent?.trim()} ${link.getAttribute("href")}`);
    expect(shortcuts).toEqual(expect.arrayContaining(["Overview /dash", "Debug /debug"]));
    expect(text).toContain("Gateway config is low-level runtime plumbing");
    expect(text).toContain("Use Overview for endpoint");
    expect(text).toContain("Use Debug for startup timings");
    expect(text).toContain("bind, port, auth, CORS");
  });

  it("routes Node Host config users to Nodes before raw edits", () => {
    const container = document.createElement("div");
    render(
      renderConfig({
        ...baseProps(),
        activeSection: "nodeHost",
        schema: {
          type: "object",
          properties: {
            nodeHost: {
              type: "object",
              properties: {
                browserProxy: {
                  type: "object",
                  properties: {
                    enabled: { type: "boolean" },
                    allowProfiles: { type: "array", items: { type: "string" } },
                  },
                },
              },
            },
          },
        },
        formValue: {
          nodeHost: {
            browserProxy: { enabled: true, allowProfiles: ["Default"] },
          },
        },
        originalValue: {
          nodeHost: {
            browserProxy: { enabled: true, allowProfiles: ["Default"] },
          },
        },
      }),
      container,
    );

    const text = container.textContent ?? "";
    const shortcuts = Array.from(
      container.querySelectorAll<HTMLAnchorElement>(".config-section-shortcut"),
    ).map((link) => `${link.textContent?.trim()} ${link.getAttribute("href")}`);
    expect(shortcuts).toEqual(
      expect.arrayContaining(["Nodes /nodes", "Services /services", "Debug /debug"]),
    );
    expect(text).toContain("Node Host config is advanced companion-process plumbing");
    expect(text).toContain("Nodes for pairing");
    expect(text).toContain("browser proxy");
  });

  it("keeps setup, browser, logging, and diagnostics out of generated Advanced Config", () => {
    const container = document.createElement("div");
    render(
      renderConfig({
        ...baseProps(),
        activeSection: "diagnostics",
        schema: {
          type: "object",
          properties: {
            wizard: {
              type: "object",
              properties: {
                lastRunAt: { type: "string" },
              },
            },
            diagnostics: {
              type: "object",
              properties: {
                enabled: { type: "boolean" },
              },
            },
            logging: {
              type: "object",
              properties: {
                level: { type: "string", enum: ["info", "debug", "trace"] },
              },
            },
            browser: {
              type: "object",
              properties: {
                enabled: { type: "boolean" },
              },
            },
            gateway: { type: "object", properties: {} },
          },
        },
        formValue: {},
        originalValue: {},
      }),
      container,
    );

    const labels = Array.from(container.querySelectorAll(".config-nav__label")).map((node) =>
      node.textContent?.trim(),
    );
    expect(labels).toContain("Gateway");
    expect(labels).not.toContain("Setup Wizard");
    expect(labels).not.toContain("Diagnostics");
    expect(labels).not.toContain("Logging");
    expect(labels).not.toContain("Browser");
    expect(container.textContent ?? "").not.toContain(
      "Diagnostics config is advanced observability",
    );
    expect(container.textContent ?? "").not.toContain("Logging config controls file");
    expect(container.textContent ?? "").not.toContain("Browser config is advanced runtime");
  });

  it("keeps UI chrome fallback config out of Advanced Config", () => {
    const container = document.createElement("div");
    render(
      renderConfig({
        ...baseProps(),
        activeSection: "ui",
        schema: {
          type: "object",
          properties: {
            ui: {
              type: "object",
              properties: {
                seamColor: { type: "string" },
                assistant: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    avatar: { type: "string" },
                  },
                },
              },
            },
            gateway: { type: "object", properties: {} },
          },
        },
        formValue: {
          ui: {
            seamColor: "#ff4500",
            assistant: { name: "Assistant", avatar: "A" },
          },
        },
        originalValue: {
          ui: {
            seamColor: "#ff4500",
            assistant: { name: "Assistant", avatar: "A" },
          },
        },
      }),
      container,
    );

    const labels = Array.from(container.querySelectorAll(".config-nav__label")).map((node) =>
      node.textContent?.trim(),
    );
    expect(labels).toContain("Gateway");
    expect(labels).not.toContain("UI");
    expect(container.querySelector(".config-section-index")).not.toBeNull();
    expect(container.textContent ?? "").not.toContain("Assistant Name");
    expect(container.textContent ?? "").not.toContain("Assistant Avatar");
    expect(container.textContent ?? "").not.toContain("Accent Color");
  });

  it("keeps provider auth and model registry controls out of Advanced Config", () => {
    const container = document.createElement("div");
    render(
      renderConfig({
        ...baseProps(),
        activeSection: "models",
        schema: {
          type: "object",
          properties: {
            auth: {
              type: "object",
              properties: {
                profiles: { type: "object", properties: {} },
                order: { type: "object", properties: {} },
                cooldowns: {
                  type: "object",
                  properties: {
                    billingBackoffHours: { type: "number" },
                  },
                },
              },
            },
            models: {
              type: "object",
              properties: {
                providers: {
                  type: "object",
                  properties: {
                    openai: {
                      type: "object",
                      properties: {
                        baseUrl: { type: "string" },
                        apiKey: { type: "string" },
                        models: { type: "array", items: { type: "object" } },
                      },
                    },
                  },
                },
              },
            },
            gateway: {
              type: "object",
              properties: {
                mode: { type: "string" },
              },
            },
          },
        },
      }),
      container,
    );

    const text = container.textContent ?? "";
    const labels = Array.from(container.querySelectorAll(".config-nav__label")).map((node) =>
      node.textContent?.trim(),
    );
    expect(labels).not.toContain("Authentication");
    expect(labels).not.toContain("Models");
    expect(container.querySelector(".config-section-index")).not.toBeNull();
    expect(text).toContain("Gateway");
    expect(text).not.toContain("Billing Backoff Hours");
    expect(text).not.toContain("Base Url");
    expect(text).not.toContain("Api Key");
    expect(text).not.toContain("Openai");
  });

  it("keeps wallet runtime controls out of Advanced Config", () => {
    const container = document.createElement("div");
    render(
      renderConfig({
        ...baseProps(),
        activeSection: "wallet",
        schema: {
          type: "object",
          properties: {
            wallet: {
              type: "object",
              properties: {
                provider: {
                  type: "object",
                  properties: {
                    id: { type: "string", enum: ["embedded-keystore", "local-socket-signer"] },
                  },
                },
                approvalAuth: {
                  type: "object",
                  properties: {
                    mode: { type: "string", enum: ["none", "webauthn"] },
                  },
                },
                keystore: {
                  type: "object",
                  properties: {
                    enabled: { type: "boolean" },
                    path: { type: "string" },
                  },
                },
              },
            },
            gateway: {
              type: "object",
              properties: {
                mode: { type: "string" },
              },
            },
          },
        },
      }),
      container,
    );

    const text = container.textContent ?? "";
    const labels = Array.from(container.querySelectorAll(".config-nav__label")).map((node) =>
      node.textContent?.trim(),
    );
    expect(labels).not.toContain("Wallet");
    expect(container.querySelector(".config-section-index")).not.toBeNull();
    expect(text).toContain("Gateway");
    expect(text).not.toContain("Wallet Provider");
    expect(text).not.toContain("Wallet Approval Auth Mode");
    expect(text).not.toContain("Embedded Keystore Enabled");
    expect(text).not.toContain("local-socket-signer");
    expect(text).not.toContain("embedded-keystore");
  });

  it("keeps channel account controls out of Advanced Config", () => {
    const container = document.createElement("div");
    render(
      renderConfig({
        ...baseProps(),
        activeSection: "channels",
        schema: {
          type: "object",
          properties: {
            channels: {
              type: "object",
              properties: {
                telegram: {
                  type: "object",
                  properties: {
                    enabled: { type: "boolean" },
                    botToken: { type: "string" },
                    defaultAgentId: { type: "string" },
                  },
                },
              },
            },
            gateway: {
              type: "object",
              properties: {
                mode: { type: "string" },
              },
            },
          },
        },
      }),
      container,
    );

    const text = container.textContent ?? "";
    const labels = Array.from(container.querySelectorAll(".config-nav__label")).map((node) =>
      node.textContent?.trim(),
    );
    expect(labels).not.toContain("Channels");
    expect(container.querySelector(".config-section-index")).not.toBeNull();
    expect(text).toContain("Gateway");
    expect(text).not.toContain("Telegram");
    expect(text).not.toContain("Bot Token");
    expect(text).not.toContain("Default Agent Id");
  });

  it("keeps Agent workspace and model controls out of Advanced Config", () => {
    const container = document.createElement("div");
    render(
      renderConfig({
        ...baseProps(),
        activeSection: "agents",
        schema: {
          type: "object",
          properties: {
            agents: {
              type: "object",
              properties: {
                list: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      model: { type: "string" },
                      activeModelProvider: { type: "string" },
                      taskModels: {
                        type: "object",
                        properties: {
                          cheapCheck: { type: "string" },
                          escalation: { type: "string" },
                        },
                      },
                      subagents: {
                        type: "object",
                        properties: {
                          allowAgents: { type: "array", items: { type: "string" } },
                        },
                      },
                    },
                  },
                },
              },
            },
            gateway: {
              type: "object",
              properties: {
                mode: { type: "string" },
              },
            },
          },
        },
      }),
      container,
    );

    const text = container.textContent ?? "";
    const labels = Array.from(container.querySelectorAll(".config-nav__label")).map((node) =>
      node.textContent?.trim(),
    );
    expect(labels).not.toContain("Agents");
    expect(container.querySelector(".config-section-index")).not.toBeNull();
    expect(text).toContain("Gateway");
    expect(text).not.toContain("Agent Task Cheap Check Model");
    expect(text).not.toContain("Legacy Active Model Provider");
    expect(text).not.toContain("Allow Agents");
  });

  it("keeps hook internals out of Advanced Config", () => {
    const container = document.createElement("div");
    render(
      renderConfig({
        ...baseProps(),
        activeSection: "hooks",
        schema: {
          type: "object",
          properties: {
            hooks: {
              type: "object",
              properties: {
                enabled: { type: "boolean" },
                token: { type: "string" },
                mappings: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      agentId: { type: "string" },
                      sessionKey: { type: "string" },
                      messageTemplate: { type: "string" },
                    },
                  },
                },
                internal: {
                  type: "object",
                  properties: {
                    entries: { type: "object", properties: {} },
                    handlers: { type: "array", items: { type: "object", properties: {} } },
                  },
                },
              },
            },
            gateway: {
              type: "object",
              properties: {
                mode: { type: "string" },
              },
            },
          },
        },
      }),
      container,
    );

    const text = container.textContent ?? "";
    const labels = Array.from(container.querySelectorAll(".config-nav__label")).map((node) =>
      node.textContent?.trim(),
    );
    expect(labels).not.toContain("Hooks");
    expect(container.querySelector(".config-section-index")).not.toBeNull();
    expect(text).toContain("Gateway");
    expect(text).not.toContain("Session Key");
    expect(text).not.toContain("Message Template");
    expect(text).not.toContain("Handlers");
  });

  it("keeps tool runtime controls out of Advanced Config", () => {
    const container = document.createElement("div");
    render(
      renderConfig({
        ...baseProps(),
        activeSection: "tools",
        schema: {
          type: "object",
          properties: {
            tools: {
              type: "object",
              properties: {
                profile: { type: "string" },
                web: {
                  type: "object",
                  properties: {
                    search: {
                      type: "object",
                      properties: {
                        enabled: { type: "boolean" },
                        provider: { type: "string" },
                        apiKey: { type: "string" },
                      },
                    },
                  },
                },
                exec: {
                  type: "object",
                  properties: {
                    timeoutSec: { type: "number" },
                  },
                },
              },
            },
            gateway: {
              type: "object",
              properties: {
                mode: { type: "string" },
              },
            },
          },
        },
      }),
      container,
    );

    const text = container.textContent ?? "";
    const labels = Array.from(container.querySelectorAll(".config-nav__label")).map((node) =>
      node.textContent?.trim(),
    );
    expect(labels).not.toContain("Tools");
    expect(container.querySelector(".config-section-index")).not.toBeNull();
    expect(text).toContain("Gateway");
    expect(text).not.toContain("Tools");
    expect(text).not.toContain("Api Key");
    expect(text).not.toContain("Timeout Sec");
  });

  it("hides update settings and the update action from the control UI", () => {
    const container = document.createElement("div");
    render(
      renderConfig({
        ...baseProps(),
        schema: {
          type: "object",
          properties: {
            update: {
              type: "object",
              properties: {
                channel: { type: "string" },
              },
            },
            gateway: {
              type: "object",
              properties: {
                mode: { type: "string" },
              },
            },
          },
        },
        formValue: { update: { channel: "stable" }, gateway: { mode: "local" } },
        originalValue: { update: { channel: "stable" }, gateway: { mode: "local" } },
      }),
      container,
    );

    const labels = Array.from(container.querySelectorAll(".config-nav__label")).map((node) =>
      node.textContent?.trim(),
    );
    expect(labels).not.toContain("Updates");
    const updateButton = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "Update",
    );
    expect(updateButton).toBeUndefined();
    expect(container.textContent).not.toContain("Auto-update settings and release channel");
  });
});
