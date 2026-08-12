#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const TARGET_DEFAULTS = [
  { path: ["agents", "defaults", "compaction", "mode"], value: "safeguard" },
  { path: ["commands", "native"], value: "auto" },
  { path: ["commands", "nativeSkills"], value: "auto" },
  { path: ["commands", "ownerDisplay"], value: "raw" },
  { path: ["commands", "restart"], value: true },
];
const SYSTEM_PLUGIN_ALLOW_ADDITIONS = new Set(["memory-core"]);

function fail(message) {
  throw new Error(`lifecycle configuration preservation: ${message}`);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pointer(path) {
  if (path.length === 0) {
    return "/";
  }
  return `/${path.map((part) => part.replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
}

function lookup(root, path) {
  let current = root;
  for (const part of path) {
    if (!isObject(current) || !Object.prototype.hasOwnProperty.call(current, part)) {
      return { found: false, value: undefined };
    }
    current = current[part];
  }
  return { found: true, value: current };
}

function removePath(root, path) {
  const parents = [];
  let current = root;
  for (const part of path.slice(0, -1)) {
    if (!isObject(current) || !Object.prototype.hasOwnProperty.call(current, part)) {
      return;
    }
    parents.push([current, part]);
    current = current[part];
  }
  if (!isObject(current)) {
    return;
  }
  delete current[path.at(-1)];
  for (const [parent, part] of parents.toReversed()) {
    const child = parent[part];
    if (!isObject(child) || Object.keys(child).length !== 0) {
      break;
    }
    delete parent[part];
  }
}

function firstDifference(before, after, path = []) {
  if (isDeepStrictEqual(before, after)) {
    return null;
  }
  if (!isObject(before) || !isObject(after)) {
    return pointer(path);
  }
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].toSorted();
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(before, key)) {
      return pointer([...path, key]);
    }
    if (!Object.prototype.hasOwnProperty.call(after, key)) {
      return pointer([...path, key]);
    }
    const nested = firstDifference(before[key], after[key], [...path, key]);
    if (nested) {
      return nested;
    }
  }
  return pointer(path);
}

function validatePluginAllow(before, after) {
  const path = ["plugins", "allow"];
  const previous = lookup(before, path);
  const target = lookup(after, path);
  if (!previous.found && !target.found) {
    return;
  }
  if (
    !Array.isArray(previous.value) ||
    !previous.value.every((value) => typeof value === "string")
  ) {
    fail("predecessor /plugins/allow must be an array of plugin IDs");
  }
  if (!Array.isArray(target.value) || !target.value.every((value) => typeof value === "string")) {
    fail("target /plugins/allow must be an array of plugin IDs");
  }
  const previousPluginIds = /** @type {string[]} */ (previous.value);
  const targetPluginIds = /** @type {string[]} */ (target.value);
  if (
    new Set(previousPluginIds).size !== previousPluginIds.length ||
    new Set(targetPluginIds).size !== targetPluginIds.length
  ) {
    fail("/plugins/allow must not contain duplicate plugin IDs");
  }
  const previousSet = new Set(previousPluginIds);
  const targetSet = new Set(targetPluginIds);
  for (const pluginId of previousSet) {
    if (!targetSet.has(pluginId)) {
      fail(`target removed predecessor plugin allow entry ${pluginId}`);
    }
  }
  for (const pluginId of targetSet) {
    if (!previousSet.has(pluginId) && !SYSTEM_PLUGIN_ALLOW_ADDITIONS.has(pluginId)) {
      fail(`target added undeclared plugin allow entry ${pluginId}`);
    }
  }
  removePath(before, path);
  removePath(after, path);
}

function permitSystemMetadata(before, after, targetVersion) {
  const targetTouchedAt = lookup(after, ["meta", "lastTouchedAt"]);
  if (
    targetTouchedAt.found &&
    (typeof targetTouchedAt.value !== "string" || Number.isNaN(Date.parse(targetTouchedAt.value)))
  ) {
    fail("target /meta/lastTouchedAt is not a timestamp");
  }
  const targetTouchedVersion = lookup(after, ["meta", "lastTouchedVersion"]);
  if (targetTouchedVersion.found && targetTouchedVersion.value !== targetVersion) {
    fail(`target /meta/lastTouchedVersion is not ${targetVersion}`);
  }
  for (const path of [
    ["meta", "lastTouchedAt"],
    ["meta", "lastTouchedVersion"],
  ]) {
    removePath(before, path);
    removePath(after, path);
  }
}

function permitHostingMode(before, after, profile) {
  if (profile !== "hosting") {
    return;
  }
  const predecessorMode = lookup(before, ["gateway", "mode"]);
  const targetMode = lookup(after, ["gateway", "mode"]);
  if (!predecessorMode.found || predecessorMode.value !== "remote") {
    fail("Hosting predecessor /gateway/mode must be remote");
  }
  if (!targetMode.found || targetMode.value !== "local") {
    fail("Hosting target /gateway/mode must be local");
  }
  removePath(before, ["gateway", "mode"]);
  removePath(after, ["gateway", "mode"]);
}

function permitTargetDefaults(before, after) {
  for (const entry of TARGET_DEFAULTS) {
    if (lookup(before, entry.path).found) {
      continue;
    }
    const target = lookup(after, entry.path);
    if (!target.found) {
      continue;
    }
    if (!isDeepStrictEqual(target.value, entry.value)) {
      fail(`target default ${pointer(entry.path)} has an undeclared value`);
    }
    removePath(after, entry.path);
  }
}

export function assertConfigurationPreserved({ predecessor, target, targetVersion, profile }) {
  if (!isObject(predecessor) || !isObject(target)) {
    fail("configuration roots must be JSON objects");
  }
  if (typeof targetVersion !== "string" || targetVersion.length === 0) {
    fail("target version is required");
  }
  if (profile !== "hosting" && profile !== "protected-local") {
    fail("profile is invalid");
  }

  const normalizedPredecessor = clone(predecessor);
  const normalizedTarget = clone(target);
  permitHostingMode(normalizedPredecessor, normalizedTarget, profile);
  permitSystemMetadata(normalizedPredecessor, normalizedTarget, targetVersion);
  permitTargetDefaults(normalizedPredecessor, normalizedTarget);
  validatePluginAllow(normalizedPredecessor, normalizedTarget);

  const difference = firstDifference(normalizedPredecessor, normalizedTarget);
  if (difference) {
    fail(`undeclared configuration change at ${difference}`);
  }
  return {
    ok: true,
    profile,
    targetVersion,
    permittedTargetDefaults: TARGET_DEFAULTS.map((entry) => pointer(entry.path)),
    permittedSystemMetadata: ["/gateway/mode", "/meta/lastTouchedAt", "/meta/lastTouchedVersion"],
    permittedPluginAllowAdditions: [...SYSTEM_PLUGIN_ALLOW_ADDITIONS].toSorted(),
  };
}

function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index]?.startsWith("--") || args[index + 1] === undefined) {
      fail("arguments must be --name value pairs");
    }
    options[args[index].slice(2)] = args[index + 1];
  }
  return options;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${label} is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = assertConfigurationPreserved({
    predecessor: readJson(options.before, "predecessor configuration"),
    target: readJson(options.after, "target configuration"),
    targetVersion: options["target-version"],
    profile: options.profile,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
