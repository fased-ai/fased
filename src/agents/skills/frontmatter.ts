import type { Skill } from "@mariozechner/pi-coding-agent";
import { parseFrontmatterBlock } from "../../markdown/frontmatter.js";
import {
  getFrontmatterString,
  normalizeStringList,
  parseFasedAgentManifestInstallBase,
  parseFrontmatterBool,
  resolveFasedAgentManifestBlock,
  resolveFasedAgentManifestInstall,
  resolveFasedAgentManifestOs,
  resolveFasedAgentManifestRequires,
} from "../../shared/frontmatter.js";
import type {
  FasedAgentSkillMetadata,
  ParsedSkillFrontmatter,
  SkillConfigFieldSpec,
  SkillEntry,
  SkillInstallSpec,
  SkillInvocationPolicy,
} from "./types.js";

export function parseFrontmatter(content: string): ParsedSkillFrontmatter {
  return parseFrontmatterBlock(content);
}

function parseInstallSpec(input: unknown): SkillInstallSpec | undefined {
  const parsed = parseFasedAgentManifestInstallBase(input, [
    "brew",
    "node",
    "go",
    "uv",
    "download",
  ]);
  if (!parsed) {
    return undefined;
  }
  const { raw } = parsed;
  const spec: SkillInstallSpec = {
    kind: parsed.kind as SkillInstallSpec["kind"],
  };

  if (parsed.id) {
    spec.id = parsed.id;
  }
  if (parsed.label) {
    spec.label = parsed.label;
  }
  if (parsed.bins) {
    spec.bins = parsed.bins;
  }
  const osList = normalizeStringList(raw.os);
  if (osList.length > 0) {
    spec.os = osList;
  }
  const formula = typeof raw.formula === "string" ? raw.formula.trim() : "";
  if (formula) {
    spec.formula = formula;
  }
  const cask = typeof raw.cask === "string" ? raw.cask.trim() : "";
  if (!spec.formula && cask) {
    spec.formula = cask;
  }
  if (typeof raw.package === "string") {
    spec.package = raw.package;
  }
  if (typeof raw.module === "string") {
    spec.module = raw.module;
  }
  if (typeof raw.url === "string") {
    spec.url = raw.url;
  }
  if (typeof raw.archive === "string") {
    spec.archive = raw.archive;
  }
  if (typeof raw.integrity === "string") {
    spec.integrity = raw.integrity;
  }
  if (typeof raw.sha256 === "string") {
    spec.sha256 = raw.sha256;
  }
  if (typeof raw.shasum === "string") {
    spec.shasum = raw.shasum;
  }
  if (typeof raw.extract === "boolean") {
    spec.extract = raw.extract;
  }
  if (typeof raw.stripComponents === "number") {
    spec.stripComponents = raw.stripComponents;
  }
  if (typeof raw.targetDir === "string") {
    spec.targetDir = raw.targetDir;
  }

  return spec;
}

function parseConfigFieldSpec(input: unknown): SkillConfigFieldSpec | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const raw = input as Record<string, unknown>;
  const key = typeof raw.key === "string" ? raw.key.trim() : "";
  const path = typeof raw.path === "string" ? raw.path.trim() : "";
  if (!key && !path) {
    return undefined;
  }
  const typeRaw = typeof raw.type === "string" ? raw.type.trim() : "";
  const allowedTypes = ["string", "secret", "number", "boolean", "textarea"] as const;
  const type = allowedTypes.includes(typeRaw as (typeof allowedTypes)[number])
    ? (typeRaw as SkillConfigFieldSpec["type"])
    : undefined;
  return {
    ...(key ? { key } : {}),
    ...(path ? { path } : {}),
    ...(typeof raw.label === "string" && raw.label.trim() ? { label: raw.label.trim() } : {}),
    ...(type ? { type } : {}),
    ...(typeof raw.placeholder === "string" ? { placeholder: raw.placeholder } : {}),
    ...(typeof raw.required === "boolean" ? { required: raw.required } : {}),
  };
}

function resolveConfigFieldSpecs(metadataObj: Record<string, unknown>): SkillConfigFieldSpec[] {
  const raw = Array.isArray(metadataObj.configFields)
    ? metadataObj.configFields
    : Array.isArray(metadataObj.config)
      ? metadataObj.config
      : [];
  return raw
    .map((entry) => parseConfigFieldSpec(entry))
    .filter((entry): entry is SkillConfigFieldSpec => Boolean(entry));
}

export function resolveFasedAgentMetadata(
  frontmatter: ParsedSkillFrontmatter,
): FasedAgentSkillMetadata | undefined {
  const metadataObj = resolveFasedAgentManifestBlock({ frontmatter });
  if (!metadataObj) {
    return undefined;
  }
  const requires = resolveFasedAgentManifestRequires(metadataObj);
  const install = resolveFasedAgentManifestInstall(metadataObj, parseInstallSpec);
  const configFields = resolveConfigFieldSpecs(metadataObj);
  const osRaw = resolveFasedAgentManifestOs(metadataObj);
  return {
    always: typeof metadataObj.always === "boolean" ? metadataObj.always : undefined,
    emoji: typeof metadataObj.emoji === "string" ? metadataObj.emoji : undefined,
    homepage: typeof metadataObj.homepage === "string" ? metadataObj.homepage : undefined,
    skillKey: typeof metadataObj.skillKey === "string" ? metadataObj.skillKey : undefined,
    primaryEnv: typeof metadataObj.primaryEnv === "string" ? metadataObj.primaryEnv : undefined,
    os: osRaw.length > 0 ? osRaw : undefined,
    requires: requires,
    configFields: configFields.length > 0 ? configFields : undefined,
    install: install.length > 0 ? install : undefined,
  };
}

export function resolveSkillInvocationPolicy(
  frontmatter: ParsedSkillFrontmatter,
): SkillInvocationPolicy {
  return {
    userInvocable: parseFrontmatterBool(getFrontmatterString(frontmatter, "user-invocable"), true),
    disableModelInvocation: parseFrontmatterBool(
      getFrontmatterString(frontmatter, "disable-model-invocation"),
      false,
    ),
  };
}

export function resolveSkillKey(skill: Skill, entry?: SkillEntry): string {
  return entry?.metadata?.skillKey ?? skill.name;
}
