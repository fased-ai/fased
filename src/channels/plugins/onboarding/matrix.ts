import type { FasedAgentConfig } from "../../../config/config.js";
import type { DmPolicy, GroupPolicy } from "../../../config/types.js";
import { formatDocsLink } from "../../../terminal/links.js";
import type { WizardPrompter } from "../../../wizard/prompts.js";
import type { ChannelOnboardingAdapter, ChannelOnboardingDmPolicy } from "../onboarding-types.js";
import { promptChannelAccessConfig } from "./channel-access.js";
import { addWildcardAllowFrom, mergeAllowFromEntries } from "./helpers.js";

const channel = "matrix" as const;

type MatrixConfig = {
  enabled?: boolean;
  homeserver?: string;
  userId?: string;
  accessToken?: string;
  password?: string;
  deviceName?: string;
  encryption?: boolean;
  groupPolicy?: GroupPolicy;
  groups?: Record<string, unknown>;
  rooms?: Record<string, unknown>;
  dm?: {
    policy?: DmPolicy;
    allowFrom?: Array<string | number>;
  };
};

function resolveMatrixConfig(cfg: FasedAgentConfig): MatrixConfig {
  return ((cfg.channels as Record<string, unknown> | undefined)?.matrix ?? {}) as MatrixConfig;
}

function patchMatrixConfig(
  cfg: FasedAgentConfig,
  patch: Record<string, unknown>,
): FasedAgentConfig {
  const channels = (cfg.channels ?? {}) as Record<string, unknown>;
  const current = (channels.matrix ?? {}) as Record<string, unknown>;
  return {
    ...cfg,
    channels: {
      ...channels,
      matrix: {
        ...current,
        enabled: true,
        ...patch,
      },
    },
  };
}

function hasMatrixCredentials(cfg: FasedAgentConfig): boolean {
  const matrix = resolveMatrixConfig(cfg);
  const homeserver = matrix.homeserver?.trim() || process.env.MATRIX_HOMESERVER?.trim();
  const accessToken = matrix.accessToken?.trim() || process.env.MATRIX_ACCESS_TOKEN?.trim();
  const userId = matrix.userId?.trim() || process.env.MATRIX_USER_ID?.trim();
  const password = matrix.password?.trim() || process.env.MATRIX_PASSWORD?.trim();
  return Boolean(homeserver && (accessToken || (userId && password)));
}

function splitEntries(raw: string): string[] {
  return raw
    .split(/[\n,;]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function setMatrixDmPolicy(cfg: FasedAgentConfig, policy: DmPolicy): FasedAgentConfig {
  const current = resolveMatrixConfig(cfg);
  const allowFrom = policy === "open" ? addWildcardAllowFrom(current.dm?.allowFrom) : undefined;
  return patchMatrixConfig(cfg, {
    dm: {
      ...current.dm,
      policy,
      ...(allowFrom ? { allowFrom } : {}),
    },
  });
}

async function noteMatrixAuthHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "Matrix requires a homeserver URL.",
      "Use an access token (recommended) or a password.",
      "With access token, user ID can be fetched automatically.",
      "Env vars supported: MATRIX_HOMESERVER, MATRIX_USER_ID, MATRIX_ACCESS_TOKEN, MATRIX_PASSWORD.",
      `Docs: ${formatDocsLink("/channels/matrix", "channels/matrix")}`,
    ].join("\n"),
    "Matrix setup",
  );
}

function setMatrixGroupPolicy(cfg: FasedAgentConfig, groupPolicy: GroupPolicy): FasedAgentConfig {
  return patchMatrixConfig(cfg, { groupPolicy });
}

function setMatrixGroupRooms(cfg: FasedAgentConfig, roomKeys: string[]): FasedAgentConfig {
  const groups = Object.fromEntries(roomKeys.map((key) => [key, { allow: true }]));
  return patchMatrixConfig(cfg, { groups });
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "Matrix",
  channel,
  policyKey: "channels.matrix.dm.policy",
  allowFromKey: "channels.matrix.dm.allowFrom",
  getCurrent: (cfg) => resolveMatrixConfig(cfg).dm?.policy ?? "pairing",
  setPolicy: setMatrixDmPolicy,
  promptAllowFrom: async ({ cfg, prompter }) => {
    const current = resolveMatrixConfig(cfg);
    const raw = await prompter.text({
      message: "Matrix allowFrom (full @user:server; display name only if unique)",
      placeholder: "@user:server",
      initialValue: current.dm?.allowFrom?.map((entry) => String(entry)).join(", "),
      validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
    });
    return patchMatrixConfig(cfg, {
      dm: {
        ...current.dm,
        policy: "allowlist",
        allowFrom: mergeAllowFromEntries(current.dm?.allowFrom, splitEntries(String(raw))),
      },
    });
  },
};

export const matrixOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  uiSetup: {
    title: "Matrix",
    detail: "Homeserver and Matrix bot credentials.",
    notes: [
      "Matrix requires a homeserver URL.",
      "Use an access token or a password.",
      "With access token, user ID can be fetched automatically.",
      "Env vars supported: MATRIX_HOMESERVER, MATRIX_USER_ID, MATRIX_ACCESS_TOKEN, MATRIX_PASSWORD.",
    ],
    fields: [
      {
        label: "Homeserver URL",
        path: ["channels", "matrix", "homeserver"],
        placeholder: "https://matrix.example.org",
      },
      {
        label: "Access token",
        path: ["channels", "matrix", "accessToken"],
        placeholder: "Matrix access token",
        kind: "password",
      },
      {
        label: "User ID",
        path: ["channels", "matrix", "userId"],
        placeholder: "@bot:example.org",
      },
      {
        label: "Password",
        path: ["channels", "matrix", "password"],
        placeholder: "Required only for password login",
        kind: "password",
      },
      {
        label: "Device name",
        path: ["channels", "matrix", "deviceName"],
        placeholder: "FasedAgent Gateway",
      },
    ],
    access: {
      kind: "matrix-rooms",
      label: "Matrix rooms",
      note: "Allowlist Matrix rooms, open all rooms, or block room messages.",
      placeholder: "!roomId:server, #alias:server, Project Room",
    },
  },
  getStatus: async ({ cfg }) => {
    const configured = hasMatrixCredentials(cfg);
    return {
      channel,
      configured,
      statusLines: [
        `Matrix: ${configured ? "configured" : "needs homeserver + access token or password"}`,
      ],
      selectionHint: configured ? "configured" : "needs auth",
      quickstartScore: configured ? 2 : 1,
    };
  },
  configure: async ({ cfg, prompter }) => {
    let next = cfg;
    const existing = resolveMatrixConfig(next);
    if (!hasMatrixCredentials(next)) {
      await noteMatrixAuthHelp(prompter);
    }

    const homeserver = String(
      await prompter.text({
        message: "Matrix homeserver URL",
        initialValue: existing.homeserver,
        validate: (value) => {
          const raw = String(value ?? "").trim();
          if (!raw) {
            return "Required";
          }
          if (!/^https?:\/\//i.test(raw)) {
            return "Use a full URL (https://...)";
          }
          return undefined;
        },
      }),
    ).trim();

    let accessToken = existing.accessToken ?? "";
    let password = existing.password ?? "";
    let userId = existing.userId ?? "";
    if (accessToken || password) {
      const keep = await prompter.confirm({
        message: "Matrix credentials already configured. Keep them?",
        initialValue: true,
      });
      if (!keep) {
        accessToken = "";
        password = "";
        userId = "";
      }
    }

    if (!accessToken && !password) {
      const authMode = await prompter.select({
        message: "Matrix auth method",
        options: [
          { value: "token", label: "Access token (user ID fetched automatically)" },
          { value: "password", label: "Password (requires user ID)" },
        ],
      });

      if (authMode === "token") {
        accessToken = String(
          await prompter.text({
            message: "Matrix access token",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
        userId = "";
      } else {
        userId = String(
          await prompter.text({
            message: "Matrix user ID",
            initialValue: existing.userId,
            validate: (value) => {
              const raw = String(value ?? "").trim();
              if (!raw) {
                return "Required";
              }
              if (!raw.startsWith("@")) {
                return "Matrix user IDs should start with @";
              }
              if (!raw.includes(":")) {
                return "Matrix user IDs should include a server (:server)";
              }
              return undefined;
            },
          }),
        ).trim();
        password = String(
          await prompter.text({
            message: "Matrix password",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
      }
    }

    const deviceName = String(
      await prompter.text({
        message: "Matrix device name (optional)",
        initialValue: existing.deviceName ?? "FasedAgent Gateway",
      }),
    ).trim();

    const enableEncryption = await prompter.confirm({
      message: "Enable end-to-end encryption (E2EE)?",
      initialValue: existing.encryption ?? false,
    });

    next = patchMatrixConfig(next, {
      homeserver,
      accessToken: accessToken || undefined,
      password: password || undefined,
      userId: userId || undefined,
      deviceName: deviceName || undefined,
      encryption: enableEncryption || undefined,
    });

    const existingGroups = resolveMatrixConfig(next).groups ?? resolveMatrixConfig(next).rooms;
    const accessConfig = await promptChannelAccessConfig({
      prompter,
      label: "Matrix rooms",
      currentPolicy: resolveMatrixConfig(next).groupPolicy ?? "allowlist",
      currentEntries: Object.keys(existingGroups ?? {}),
      placeholder: "!roomId:server, #alias:server, Project Room",
      updatePrompt: Boolean(existingGroups),
    });
    if (accessConfig) {
      next = setMatrixGroupPolicy(next, accessConfig.policy);
      if (accessConfig.policy === "allowlist") {
        next = setMatrixGroupRooms(next, accessConfig.entries);
      }
    }

    return {
      cfg: next,
      accountId: "default",
    };
  },
  dmPolicy,
  disable: (cfg) => {
    const channels = (cfg.channels ?? {}) as Record<string, unknown>;
    const current = (channels.matrix ?? {}) as Record<string, unknown>;
    return {
      ...cfg,
      channels: {
        ...channels,
        matrix: {
          ...current,
          enabled: false,
        },
      },
    };
  },
};
