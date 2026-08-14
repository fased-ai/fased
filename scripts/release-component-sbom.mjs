#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;

function fail(message) {
  throw new Error(`release component SBOM: ${message}`);
}

function spdxId(value) {
  return `SPDXRef-Package-${createHash("sha256").update(value).digest("hex").slice(0, 20)}`;
}

function encodePurlName(name) {
  return name.startsWith("@")
    ? `%40${name.slice(1).split("/").map(encodeURIComponent).join("/")}`
    : encodeURIComponent(name);
}

function npmPurl(name, version) {
  return `pkg:npm/${encodePurlName(name)}@${encodeURIComponent(version)}`;
}

function goPurl(name, version) {
  return `pkg:golang/${name.split("/").map(encodeURIComponent).join("/")}@${encodeURIComponent(version)}`;
}

function packageEntry({ name, version, purl, license = "NOASSERTION", resolved = "NOASSERTION" }) {
  if (!name || !version || !purl) {
    fail("component package identity is incomplete");
  }
  return {
    SPDXID: spdxId(purl),
    name,
    versionInfo: version,
    downloadLocation: resolved || "NOASSERTION",
    filesAnalyzed: false,
    licenseConcluded: "NOASSERTION",
    licenseDeclared: license || "NOASSERTION",
    externalRefs: [
      {
        referenceCategory: "PACKAGE-MANAGER",
        referenceType: "purl",
        referenceLocator: purl,
      },
    ],
  };
}

function componentDocument({ name, namespace, created, packages }) {
  const ordered = packages.toSorted((left, right) => {
    const leftPurl = left.externalRefs[0].referenceLocator;
    const rightPurl = right.externalRefs[0].referenceLocator;
    return leftPurl.localeCompare(rightPurl);
  });
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name,
    documentNamespace: namespace,
    creationInfo: {
      created,
      creators: ["Organization: Fased", "Tool: fased-release-component-sbom-v1"],
    },
    documentDescribes: ordered.map((entry) => entry.SPDXID),
    packages: ordered,
  };
}

function canonicalInstant(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    fail("created must be one canonical ISO-8601 UTC instant");
  }
  return value;
}

async function pnpmInstalledManifests(nodeModulesPath) {
  const virtualStore = path.join(nodeModulesPath, ".pnpm");
  const manifests = [];
  for (const virtualEntry of await fsp.readdir(virtualStore, { withFileTypes: true })) {
    if (!virtualEntry.isDirectory()) {
      continue;
    }
    const packagesRoot = path.join(virtualStore, virtualEntry.name, "node_modules");
    let packages;
    try {
      packages = await fsp.readdir(packagesRoot, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    for (const entry of packages) {
      if (!entry.isDirectory() || entry.name === ".bin") {
        continue;
      }
      const candidates = entry.name.startsWith("@")
        ? (await fsp.readdir(path.join(packagesRoot, entry.name), { withFileTypes: true }))
            .filter((candidate) => candidate.isDirectory())
            .map((candidate) => path.join(packagesRoot, entry.name, candidate.name))
        : [path.join(packagesRoot, entry.name)];
      for (const candidate of candidates) {
        try {
          manifests.push(
            JSON.parse(await fsp.readFile(path.join(candidate, "package.json"), "utf8")),
          );
        } catch (error) {
          if (error?.code !== "ENOENT") {
            throw error;
          }
        }
      }
    }
  }
  return manifests;
}

export async function buildNodeComponentSbom({ nodeModulesPath, version, architecture, created }) {
  if (!VERSION_PATTERN.test(version || "") || !new Set(["x64", "arm64"]).has(architecture)) {
    fail("Node release identity is invalid");
  }
  const packages = new Map();
  for (const candidate of await pnpmInstalledManifests(nodeModulesPath)) {
    if (typeof candidate?.name !== "string" || typeof candidate?.version !== "string") {
      continue;
    }
    const name = candidate.name;
    const dependencyVersion = String(candidate.version);
    const purl = npmPurl(name, dependencyVersion);
    packages.set(
      purl,
      packageEntry({
        name,
        version: dependencyVersion,
        purl,
        license: typeof candidate.license === "string" ? candidate.license : "NOASSERTION",
        resolved: "NOASSERTION",
      }),
    );
  }
  if (packages.size === 0) {
    fail("pnpm deployment contains no installed production components");
  }
  return componentDocument({
    name: `fased-hosted-components-linux-${architecture}-v${version}`,
    namespace: `https://fased.ai/spdx/components/node/${version}/linux-${architecture}`,
    created: canonicalInstant(created),
    packages: [...packages.values()],
  });
}

function parseJsonSequence(output) {
  const values = [];
  let offset = 0;
  while (offset < output.length) {
    while (/\s/u.test(output[offset] ?? "")) {
      offset += 1;
    }
    if (offset >= output.length) {
      break;
    }
    let depth = 0;
    let inString = false;
    let escaped = false;
    const start = offset;
    for (; offset < output.length; offset += 1) {
      const character = output[offset];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === '"') {
          inString = false;
        }
        continue;
      }
      if (character === '"') {
        inString = true;
      } else if (character === "{") {
        depth += 1;
      } else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          offset += 1;
          values.push(JSON.parse(output.slice(start, offset)));
          break;
        }
      }
    }
    if (depth !== 0 || inString) {
      fail("go list returned malformed JSON");
    }
  }
  return values;
}

export async function buildGoComponentSbom({ goBinary, moduleRoot, version, commit, created }) {
  if (!VERSION_PATTERN.test(version || "") || !/^[a-f0-9]{40}$/u.test(commit || "")) {
    fail("Go release identity is invalid");
  }
  const { stdout } = await execFileAsync(goBinary, ["list", "-m", "-json", "all"], {
    cwd: moduleRoot,
    env: { ...process.env, GOWORK: "off" },
    maxBuffer: 16 * 1024 * 1024,
  });
  return buildGoComponentSbomFromModules({
    modules: parseJsonSequence(stdout),
    version,
    commit,
    created,
  });
}

export function buildGoComponentSbomFromModules({ modules, version, commit, created }) {
  if (
    !VERSION_PATTERN.test(version || "") ||
    !/^[a-f0-9]{40}$/u.test(commit || "") ||
    !Array.isArray(modules)
  ) {
    fail("Go release identity is invalid");
  }
  const packages = new Map();
  for (const candidate of modules) {
    const selected = candidate.Replace || candidate;
    const name = String(selected.Path || candidate.Path || "");
    const dependencyVersion =
      String(selected.Version || candidate.Version || "").trim() ||
      (candidate.Main ? `${version}+${commit.slice(0, 12)}` : "");
    if (!name || !dependencyVersion) {
      fail(`Go module ${name || "unknown"} has no immutable version`);
    }
    const purl = goPurl(name, dependencyVersion);
    packages.set(
      purl,
      packageEntry({
        name,
        version: dependencyVersion,
        purl,
        resolved: "NOASSERTION",
      }),
    );
  }
  if (packages.size === 0) {
    fail("go list returned no signer components");
  }
  return componentDocument({
    name: `fased-signerd-components-v${version}`,
    namespace: `https://fased.ai/spdx/components/go/${version}/${commit}`,
    created: canonicalInstant(created),
    packages: [...packages.values()],
  });
}

function parseArgs(argv) {
  const command = argv[0];
  const values = new Map();
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || values.has(key)) {
      fail("arguments are malformed");
    }
    values.set(key, value);
  }
  return { command, values };
}

function required(values, name) {
  const value = values.get(name);
  if (!value) {
    fail(`missing ${name}`);
  }
  return value;
}

async function main(argv) {
  const { command, values } = parseArgs(argv);
  const output = path.resolve(required(values, "--output"));
  const version = required(values, "--version");
  const created = required(values, "--created");
  const document =
    command === "node"
      ? await buildNodeComponentSbom({
          nodeModulesPath: path.resolve(required(values, "--node-modules")),
          version,
          architecture: required(values, "--architecture"),
          created,
        })
      : command === "go"
        ? await buildGoComponentSbom({
            goBinary: path.resolve(required(values, "--go")),
            moduleRoot: path.resolve(required(values, "--module-root")),
            version,
            commit: required(values, "--commit"),
            created,
          })
        : fail("usage: release-component-sbom <node|go> [options]");
  await fsp.writeFile(output, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o644 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
