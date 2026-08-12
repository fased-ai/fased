#!/usr/bin/env node

import { spawn } from "node:child_process";
import { constants, realpathSync } from "node:fs";
import fsp from "node:fs/promises";
import { fileURLToPath } from "node:url";

const FIXED_BOOTSTRAP = "/opt/fased/lifecycle/bootstrap-v1/fased-bootstrap";
const NPM_REGISTRY = "https://registry.npmjs.org";
const GITHUB_RELEASES = "https://api.github.com/repos/fased-ai/fased/releases?per_page=100";
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;

async function requireFixedBootstrap(path = FIXED_BOOTSTRAP, expectedUid = 0) {
  const before = await fsp.lstat(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.uid !== expectedUid ||
    (before.mode & 0o777) !== 0o555
  ) {
    throw new Error("The fixed lifecycle update client is unsafe; rerun the public installer.");
  }
  const handle = await fsp.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.uid !== expectedUid ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw new Error("The fixed lifecycle update client changed while opening.");
    }
  } finally {
    await handle.close();
  }
  return path;
}

export async function run(
  argv = process.argv.slice(2),
  { bootstrapPath = FIXED_BOOTSTRAP, fetchImpl = globalThis.fetch } = {},
) {
  const bootstrap = await requireFixedBootstrap(bootstrapPath);
  const lifecycleArgs = argv[0] === "update" ? argv.slice(1) : argv;
  const profile = requireInstalledProfile(process.env.FASED_LIFECYCLE_PROFILE);
  const resolvedArgs = await resolveLifecycleArgs(lifecycleArgs, { fetchImpl });
  const invocation = fixedInvocation(bootstrap, resolvedArgs, process.getuid?.() ?? -1, profile);
  await new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      stdio: "inherit",
      env: {
        HOME: process.env.HOME,
        LANG: process.env.LANG || "C.UTF-8",
        LC_ALL: process.env.LC_ALL || "C.UTF-8",
        PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      },
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Fixed lifecycle update client stopped by ${signal}.`));
      } else if (code !== 0) {
        reject(new Error(`Fixed lifecycle update client failed with exit code ${code}.`));
      } else {
        resolve();
      }
    });
  });
}

async function resolveLifecycleArgs(argv, { fetchImpl = globalThis.fetch } = {}) {
  const exact = optionValue(argv, ["--version", "--tag"]);
  if (exact && exact !== "stable" && exact !== "beta" && exact !== "latest") {
    return [...argv];
  }
  const channel = optionValue(argv, ["--channel", "--update-channel"]) || "stable";
  if (channel !== "stable" && channel !== "beta") {
    throw new Error("The update channel must be stable or beta.");
  }
  const version = await resolveChannelVersion(channel, fetchImpl);
  if (!VERSION_PATTERN.test(version) || (channel === "stable" && version.includes("-"))) {
    throw new Error("The update channel did not resolve to an exact immutable release.");
  }
  return [...argv, "--version", version];
}

async function resolveChannelVersion(channel, fetchImpl) {
  if (typeof fetchImpl !== "function") {
    throw new Error("The update channel resolver is unavailable.");
  }
  const tag = channel === "beta" ? "beta" : "latest";
  try {
    const response = await fetchWithTimeout(fetchImpl, `${NPM_REGISTRY}/@fased%2ffased/${tag}`);
    if (response.ok) {
      const payload = await response.json();
      const candidate =
        typeof payload?.version === "string"
          ? payload.version
          : typeof payload?.["dist-tags"]?.[tag] === "string"
            ? payload["dist-tags"][tag]
            : "";
      if (VERSION_PATTERN.test(candidate)) {
        return candidate;
      }
    }
  } catch {
    // npm is an optional, untrusted channel hint; GitHub is the fallback.
  }

  try {
    const response = await fetchWithTimeout(fetchImpl, GITHUB_RELEASES, {
      accept: "application/vnd.github+json",
      "user-agent": "fased-managed-updater",
    });
    if (response.ok) {
      const releases = await response.json();
      if (Array.isArray(releases)) {
        const selected = releases.find(
          (release) =>
            release?.draft === false &&
            (channel === "beta" ? release?.prerelease === true : release?.prerelease === false) &&
            typeof release?.tag_name === "string",
        );
        const candidate = selected?.tag_name?.replace(/^v/, "") || "";
        if (VERSION_PATTERN.test(candidate)) {
          return candidate;
        }
      }
    }
  } catch {
    // Report one bounded channel-resolution error below.
  }
  throw new Error(`Unable to resolve the ${channel} channel to an exact immutable release.`);
}

async function fetchWithTimeout(fetchImpl, url, headers = { accept: "application/json" }) {
  return fetchImpl(url, { headers, signal: AbortSignal.timeout(5000) });
}

function optionValue(argv, names) {
  let value = "";
  for (let index = 0; index < argv.length; index += 1) {
    for (const name of names) {
      if (argv[index] === name) {
        value = argv[index + 1] || "";
      } else if (argv[index].startsWith(`${name}=`)) {
        value = argv[index].slice(name.length + 1);
      }
    }
  }
  return value.replace(/^v/, "");
}

function requireInstalledProfile(profile) {
  if (profile !== "protected-local" && profile !== "hosting") {
    throw new Error(
      "The installed lifecycle profile is missing or invalid; rerun the public installer.",
    );
  }
  return profile;
}

function fixedInvocation(bootstrap, argv, uid, profile) {
  const args = [bootstrap, "update", "--profile", profile, ...argv];
  return uid === 0
    ? { command: bootstrap, args: args.slice(1) }
    : { command: "/usr/bin/sudo", args };
}

function isMainModule(entrypoint, moduleUrl, realpath = realpathSync) {
  if (!entrypoint) {
    return false;
  }
  try {
    return realpath(entrypoint) === realpath(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isMainModule(process.argv[1], import.meta.url)) {
  run().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export const __testing = {
  FIXED_BOOTSTRAP,
  fixedInvocation,
  isMainModule,
  requireFixedBootstrap,
  requireInstalledProfile,
  resolveLifecycleArgs,
};
