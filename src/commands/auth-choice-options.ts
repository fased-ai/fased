import type { AuthProfileStore } from "../agents/auth-profiles.js";
import {
  resolveManifestProviderAuthChoices,
  type ProviderAuthChoiceMetadata,
} from "../plugins/provider-auth-choices.js";
import {
  PROVIDER_BRAND_ORDER,
  listProviderBrandManifests,
  type ProviderBrandManifest,
} from "../providers/registry.js";
import { AUTH_CHOICE_LEGACY_ALIASES_FOR_CLI } from "./auth-choice-legacy.js";
import { ONBOARD_PROVIDER_AUTH_FLAGS } from "./onboard-provider-auth-flags.js";
import type { AuthChoice, AuthChoiceGroupId } from "./onboard-types.js";

export type { AuthChoiceGroupId };

export type AuthChoiceOption = {
  value: AuthChoice;
  label: string;
  hint?: string;
};
export type AuthChoiceGroup = {
  value: AuthChoiceGroupId;
  label: string;
  hint?: string;
  options: AuthChoiceOption[];
};

type AuthChoiceGroupDef = {
  value: AuthChoiceGroupId;
  label: string;
  hint?: string;
  choices: AuthChoice[];
};

function providerManifestToAuthChoiceGroupDef(manifest: ProviderBrandManifest): AuthChoiceGroupDef {
  return {
    value: manifest.id as AuthChoiceGroupId,
    label: manifest.label,
    hint: manifest.hint,
    choices: manifest.methods.map((method) => method.id as AuthChoice),
  };
}

const MANIFEST_AUTH_CHOICE_GROUP_DEFS = listProviderBrandManifests().map(
  providerManifestToAuthChoiceGroupDef,
);

const STATIC_AUTH_CHOICE_GROUP_DEFS: AuthChoiceGroupDef[] = [];

const AUTH_CHOICE_GROUP_DEF_BY_ID = new Map<AuthChoiceGroupId, AuthChoiceGroupDef>(
  [...MANIFEST_AUTH_CHOICE_GROUP_DEFS, ...STATIC_AUTH_CHOICE_GROUP_DEFS].map((group) => [
    group.value,
    group,
  ]),
);

const AUTH_CHOICE_GROUP_DEFS: AuthChoiceGroupDef[] = [
  ...PROVIDER_BRAND_ORDER.flatMap((providerId) => {
    const group = AUTH_CHOICE_GROUP_DEF_BY_ID.get(providerId as AuthChoiceGroupId);
    if (!group) {
      return [];
    }
    AUTH_CHOICE_GROUP_DEF_BY_ID.delete(providerId as AuthChoiceGroupId);
    return [group];
  }),
  ...AUTH_CHOICE_GROUP_DEF_BY_ID.values(),
];

const PROVIDER_AUTH_CHOICE_OPTION_HINTS: Partial<Record<AuthChoice, string>> = {};

const PROVIDER_AUTH_CHOICE_OPTION_LABELS: Partial<Record<AuthChoice, string>> = {
  "moonshot-api-key": "Kimi API key (.ai)",
  "moonshot-api-key-cn": "Kimi API key (.cn)",
  "kimi-code-api-key": "Kimi Code API key (subscription)",
};

function isVisibleManifestAuthChoice(choice: ProviderAuthChoiceMetadata): boolean {
  return choice.assistantVisibility !== "manual-only";
}

function titleCaseProviderLabel(providerId: string): string {
  return providerId
    .split(/[-_]/g)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function mergeUniqueAuthChoiceOptions(
  ...lists: ReadonlyArray<AuthChoiceOption>[]
): AuthChoiceOption[] {
  const merged: AuthChoiceOption[] = [];
  const seen = new Set<string>();

  for (const list of lists) {
    for (const option of list) {
      const key = String(option.value);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(option);
    }
  }

  return merged;
}

function buildProviderAuthChoiceOptions(): AuthChoiceOption[] {
  return ONBOARD_PROVIDER_AUTH_FLAGS.map((flag) => ({
    value: flag.authChoice,
    label: PROVIDER_AUTH_CHOICE_OPTION_LABELS[flag.authChoice] ?? flag.description,
    ...(PROVIDER_AUTH_CHOICE_OPTION_HINTS[flag.authChoice]
      ? { hint: PROVIDER_AUTH_CHOICE_OPTION_HINTS[flag.authChoice] }
      : {}),
  }));
}

function buildManifestAuthChoiceOptions(): AuthChoiceOption[] {
  return mergeUniqueAuthChoiceOptions(
    resolveManifestProviderAuthChoices({
      includeUntrustedWorkspacePlugins: false,
    })
      .filter(isVisibleManifestAuthChoice)
      .map((choice) => ({
        value: choice.choiceId as AuthChoice,
        label: choice.choiceLabel,
        ...(choice.choiceHint ? { hint: choice.choiceHint } : {}),
      })),
  );
}

function buildRegistryProviderAuthChoiceOptions(): AuthChoiceOption[] {
  return listProviderBrandManifests()
    .flatMap((manifest) => manifest.methods)
    .map((method) => ({
      value: method.id as AuthChoice,
      label: method.label,
      hint: method.hint,
    }));
}

function buildManifestAuthChoiceGroupDefs(): AuthChoiceGroupDef[] {
  const groups = new Map<
    string,
    {
      value: AuthChoiceGroupId;
      label: string;
      hint?: string;
      choices: AuthChoice[];
    }
  >();

  for (const choice of resolveManifestProviderAuthChoices({
    includeUntrustedWorkspacePlugins: false,
  }).filter(isVisibleManifestAuthChoice)) {
    const groupId = (choice.groupId ?? choice.providerId) as AuthChoiceGroupId;
    const existing = groups.get(String(groupId));
    if (existing) {
      if (!existing.choices.includes(choice.choiceId as AuthChoice)) {
        existing.choices.push(choice.choiceId as AuthChoice);
      }
      if (!existing.hint && choice.groupHint) {
        existing.hint = choice.groupHint;
      }
      continue;
    }

    groups.set(String(groupId), {
      value: groupId,
      label: choice.groupLabel ?? titleCaseProviderLabel(choice.providerId),
      ...(choice.groupHint ? { hint: choice.groupHint } : {}),
      choices: [choice.choiceId as AuthChoice],
    });
  }

  return [...groups.values()];
}

function resolveAuthChoiceGroupDefs(): AuthChoiceGroupDef[] {
  const merged = AUTH_CHOICE_GROUP_DEFS.map((group) => ({
    ...group,
    choices: [...group.choices],
  }));
  const groupByValue = new Map(merged.map((group) => [String(group.value), group]));

  for (const manifestGroup of buildManifestAuthChoiceGroupDefs()) {
    const existing = groupByValue.get(String(manifestGroup.value));
    if (!existing) {
      const appended = { ...manifestGroup, choices: [...manifestGroup.choices] };
      merged.push(appended);
      groupByValue.set(String(manifestGroup.value), appended);
      continue;
    }

    for (const choice of manifestGroup.choices) {
      if (!existing.choices.includes(choice)) {
        existing.choices.push(choice);
      }
    }
    if (!existing.hint && manifestGroup.hint) {
      existing.hint = manifestGroup.hint;
    }
  }

  return merged;
}

function resolveBaseAuthChoiceOptions(): AuthChoiceOption[] {
  return mergeUniqueAuthChoiceOptions(
    buildRegistryProviderAuthChoiceOptions(),
    STATIC_BASE_AUTH_CHOICE_OPTIONS,
    buildManifestAuthChoiceOptions(),
  );
}

const STATIC_BASE_AUTH_CHOICE_OPTIONS: ReadonlyArray<AuthChoiceOption> = [
  ...buildProviderAuthChoiceOptions(),
  {
    value: "moonshot-api-key-cn",
    label: "Kimi API key (.cn)",
  },
  { value: "zai-api-key", label: "Z.AI API key" },
  {
    value: "xiaomi-api-key",
    label: "Xiaomi API key",
  },
];

export function formatAuthChoiceChoicesForCli(params?: {
  includeSkip?: boolean;
  includeLegacyAliases?: boolean;
}): string {
  const includeSkip = params?.includeSkip ?? true;
  const includeLegacyAliases = params?.includeLegacyAliases ?? false;
  const values = resolveBaseAuthChoiceOptions().map((opt) => opt.value);

  if (includeSkip) {
    values.push("skip");
  }
  if (includeLegacyAliases) {
    values.push(...AUTH_CHOICE_LEGACY_ALIASES_FOR_CLI);
  }

  return values.join("|");
}

export function buildAuthChoiceOptions(params: {
  store: AuthProfileStore;
  includeSkip: boolean;
}): AuthChoiceOption[] {
  void params.store;
  const options: AuthChoiceOption[] = resolveBaseAuthChoiceOptions();

  if (params.includeSkip) {
    options.push({ value: "skip", label: "Skip for now" });
  }

  return options;
}

export function buildAuthChoiceGroups(params: { store: AuthProfileStore; includeSkip: boolean }): {
  groups: AuthChoiceGroup[];
  skipOption?: AuthChoiceOption;
} {
  const options = buildAuthChoiceOptions({
    ...params,
    includeSkip: false,
  });
  const optionByValue = new Map<AuthChoice, AuthChoiceOption>(
    options.map((opt) => [opt.value, opt]),
  );

  const groups = resolveAuthChoiceGroupDefs().map((group) => ({
    ...group,
    options: group.choices
      .map((choice) => optionByValue.get(choice))
      .filter((opt): opt is AuthChoiceOption => Boolean(opt)),
  }));

  const skipOption = params.includeSkip
    ? ({ value: "skip", label: "Skip for now" } satisfies AuthChoiceOption)
    : undefined;

  return { groups, skipOption };
}
