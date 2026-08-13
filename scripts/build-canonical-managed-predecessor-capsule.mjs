#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as tar from "tar";
import { buildInstalledStateCapsule } from "./lifecycle-installed-state-capsule.mjs";

const COMMIT = /^[a-f0-9]{40}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;

function fail(message) {
  throw new Error(`canonical managed predecessor capsule: ${message}`);
}

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }
  return `sha256:${hash.digest("hex")}`;
}

async function directory(root, relative, mode, owner) {
  const target = path.join(root, relative);
  await fsp.mkdir(target, { recursive: true, mode });
  await fsp.chmod(target, mode);
  return { path: relative, type: "directory", owner };
}

async function write(root, relative, bytes, mode, owner) {
  const target = path.join(root, relative);
  await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
  await fsp.writeFile(target, bytes, { flag: "wx", mode });
  await fsp.chmod(target, mode);
  return { path: relative, type: "file", owner };
}

async function copy(root, relative, source, mode, owner) {
  const target = path.join(root, relative);
  await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
  await fsp.copyFile(source, target, constants.COPYFILE_EXCL);
  await fsp.chmod(target, mode);
  return { path: relative, type: "file", owner };
}

function canonicalConfig(instance, gatewayPort = 19456) {
  return {
    schemaVersion: 1,
    profile: "protected-local",
    instanceId: instance,
    ownerStateRoot: "/home/testop/.fased",
    operator: { uid: 2000, gid: 2000 },
    // The acceptance harness reserves 2001 for its independent home-ACL
    // probe. Keep product principals in a separate, deterministic range so
    // the predecessor capsule can be restored without rebinding identities.
    gateway: { uid: 2101, gid: 2101 },
    signer: { uid: 2102, gid: 2102 },
    gatewayPort,
    installRoot: `/opt/fased/local/${instance}`,
    lifecycleRoot: `/var/lib/fased-local/${instance}/lifecycle`,
    productStateRoot: `/var/lib/fased-local/${instance}`,
    unitRoot: "/etc/systemd/system",
    runtimeRoot: `/run/fased-local/${instance}`,
  };
}

function configDigest(config) {
  return `sha256:${createHash("sha256").update(JSON.stringify(config)).digest("hex")}`;
}

function legacyPlatform(config) {
  const instance = config.instanceId;
  return {
    adapter: "linux-systemd-local-v1",
    instanceId: instance,
    configurationDigest: configDigest(config),
    services: {
      controller: `fased-local-controller-worker-${instance}.service`,
      gateway: `fased-gateway-${instance}.service`,
      signer: `fased-signerd-${instance}.service`,
      supervisor: `fased-local-controller-${instance}.service`,
    },
  };
}

function supervisorUnit(config) {
  const instance = config.instanceId;
  return `[Unit]\nDescription=Fased stable lifecycle supervisor (${instance})\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nUser=root\nGroup=root\nRuntimeDirectory=fased-local-controller/${instance} fased-local-controller-worker/${instance}\nRuntimeDirectoryMode=0710\nUMask=0077\nExecStart=/opt/fased/lifecycle/supervisor-v1/fased-lifecycled supervisor --config ${config.lifecycleRoot}/platform.json --socket /run/fased-local-controller/${instance}/request.sock\nRestart=on-failure\nRestartSec=3\nNoNewPrivileges=true\nPrivateTmp=true\nPrivateDevices=true\nProtectSystem=strict\nProtectHome=read-only\nReadWritePaths=${config.lifecycleRoot} /etc/systemd/system /run/fased-local-controller-worker/${instance}\nRestrictAddressFamilies=AF_UNIX\nCapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE CAP_FOWNER CAP_SETUID CAP_SETGID\nAmbientCapabilities=\n\n[Install]\nWantedBy=multi-user.target\n`;
}

function controllerUnit(config, generationRoot) {
  const instance = config.instanceId;
  return `[Unit]\nDescription=Fased target lifecycle controller (${instance})\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nUser=root\nGroup=root\nRuntimeDirectory=fased-local-controller-worker/${instance}\nRuntimeDirectoryMode=0710\nUMask=0077\nExecStart=${generationRoot}/payload/bin/fased-lifecycled target --config ${config.lifecycleRoot}/platform.json --socket /run/fased-local-controller-worker/${instance}/controller.sock\nRestart=on-failure\nRestartSec=3\nNoNewPrivileges=true\nPrivateTmp=true\nPrivateDevices=true\nProtectSystem=strict\nProtectHome=read-only\nReadWritePaths=${config.installRoot} ${config.lifecycleRoot} ${config.productStateRoot} ${config.ownerStateRoot} /etc/systemd/system ${config.productStateRoot}/controller\nRestrictAddressFamilies=AF_UNIX AF_INET AF_INET6\nCapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE CAP_FOWNER CAP_FSETID CAP_SETUID CAP_SETGID\nAmbientCapabilities=\n\n[Install]\nWantedBy=multi-user.target\n`;
}

function signerUnit(config, generationRoot) {
  const instance = config.instanceId;
  return `[Unit]\nDescription=Fased native signer (${instance})\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nUser=${config.signer.uid}\nGroup=${config.signer.gid}\nRuntimeDirectory=fased-local/${instance} fased-local/${instance}/application fased-local/${instance}/operator fased-local/${instance}/control\nRuntimeDirectoryMode=0755\nUMask=0077\nExecStart=${generationRoot}/payload/bin/fased-signerd -socket /run/fased-local/${instance}/application/app.sock -operator-socket /run/fased-local/${instance}/operator/operator.sock -control-socket /run/fased-local/${instance}/control/control.sock -socket-mode 0660 -socket-group fsgw-${instance} -operator-socket-group fsop-${instance} -application-uid ${config.gateway.uid} -operator-uid ${config.operator.uid} -control-uid ${config.signer.uid} -state-db ${config.productStateRoot}/signer/state.db -master-key ${config.productStateRoot}/signer/master.key -update-gate ${config.productStateRoot}/controller/signer-update-gate -audit-log ${config.productStateRoot}/signer/audit.jsonl\nRestart=always\nRestartSec=3\nNoNewPrivileges=true\nPrivateTmp=true\nPrivateDevices=true\nProtectSystem=strict\nProtectHome=true\nReadWritePaths=${config.productStateRoot}/signer /run/fased-local/${instance}\nRestrictAddressFamilies=AF_UNIX AF_INET AF_INET6\nCapabilityBoundingSet=\nAmbientCapabilities=\n\n[Install]\nWantedBy=multi-user.target\n`;
}

function gatewayUnit(config, generationRoot, dependencyRoot, version) {
  const instance = config.instanceId;
  return `[Unit]\nDescription=Fased Gateway (${instance})\nAfter=fased-signerd-${instance}.service network-online.target\nWants=fased-signerd-${instance}.service network-online.target\n\n[Service]\nType=simple\nUser=${config.gateway.uid}\nGroup=${config.gateway.gid}\nSupplementaryGroups=fscf-${instance}\nUMask=0007\nWorkingDirectory=${generationRoot}/payload/runtime\nEnvironment=HOME=/home/testop\nEnvironment=FASED_STATE_DIR=${config.ownerStateRoot}\nEnvironment=FASED_CONFIG_PATH=${config.ownerStateRoot}/fased.json\nEnvironment=FASED_CONFIG_DIR=${config.ownerStateRoot}\nEnvironment=FASED_PLUGIN_STATUS_CACHE_PATH=${config.ownerStateRoot}/cache/plugin-status.json\nEnvironment=FASED_MANAGED_RUNTIME_ROOT=${generationRoot}/payload/runtime\nEnvironment=FASED_GATEWAY_MODE=managed\nEnvironment=FASED_MANAGED_INTERNAL=1\nEnvironment=FASED_GATEWAY_SERVICE=1\nEnvironment=FASED_RUNTIME_SOURCE=managed-package\nEnvironment=FASED_VERSION=${version}\nEnvironment=FASED_HOST_PROFILE=local\nEnvironment=FASED_PROTECTED_LOCAL=1\nEnvironment=FASED_PROTECTED_LOCAL_INSTANCE=${instance}\nEnvironment=FASED_GATEWAY_PORT=${config.gatewayPort}\nEnvironment=FASED_WALLET_LOCAL_SIGNER_SOCKET=/run/fased-local/${instance}/application/app.sock\nExecStart=${generationRoot}/payload/bin/fased-gateway-launch\nRestart=always\nRestartSec=1\nNoNewPrivileges=true\nPrivateTmp=true\nPrivateDevices=true\nProtectSystem=strict\nProtectHome=read-only\nBindReadOnlyPaths=${dependencyRoot}/node_modules:${generationRoot}/payload/runtime/node_modules\nReadWritePaths=${config.ownerStateRoot}\nRestrictAddressFamilies=AF_UNIX AF_INET AF_INET6\nCapabilityBoundingSet=\nAmbientCapabilities=\n\n[Install]\nWantedBy=multi-user.target\n`;
}

function managedInstall(config, generation, previous) {
  return {
    schemaVersion: 2,
    profile: "protected-local",
    source: "go-lifecycle",
    stateDir: config.ownerStateRoot,
    configPath: `${config.ownerStateRoot}/fased.json`,
    runtime: {
      activeVersion: generation.version,
      previousVersion: previous?.version || null,
      currentLink: `${config.installRoot}/current`,
      previousLink: `${config.installRoot}/previous`,
      releasesDir: `${config.installRoot}/generations`,
    },
    service: {
      name: `fased-gateway-${config.instanceId}.service`,
      scope: "system",
      launcher: `${config.installRoot}/current/payload/bin/fased-gateway-launch`,
    },
  };
}

function localInstanceRegistry(config) {
  return {
    schemaVersion: 1,
    instances: [
      {
        instanceId: config.instanceId,
        operatorUid: config.operator.uid,
        operatorUser: "testop",
        profile: config.profile,
        stateDir: config.ownerStateRoot,
        createdAt: "1970-01-01T00:00:00Z",
      },
    ],
  };
}

function lifecycleProjection(config) {
  const instance = config.instanceId;
  return {
    schemaVersion: 1,
    profile: "protected-local",
    instanceId: instance,
    environment: {
      FASED_HOST_PROFILE: "local",
      FASED_HOST_UPDATER_SOCKET: `/run/fased-local-controller/${instance}/request.sock`,
      FASED_LIFECYCLE_CONFIG: `${config.lifecycleRoot}/platform.json`,
      FASED_LIFECYCLE_INSTALL_ROOT: config.installRoot,
      FASED_LIFECYCLE_INSTANCE: instance,
      FASED_LIFECYCLE_PROFILE: "protected-local",
      FASED_MANAGED_RUNTIME_ROOT: `${config.installRoot}/current/payload/runtime`,
      FASED_PROTECTED_LOCAL: "1",
      FASED_PROTECTED_LOCAL_INSTANCE: instance,
      FASED_RUNTIME_SOURCE: "go-lifecycle",
      FASED_WALLET_LOCAL_SIGNER_BIN: `${config.installRoot}/current/payload/bin/fased-signerd`,
      FASED_WALLET_LOCAL_SIGNER_LIFECYCLE: "external",
      FASED_WALLET_LOCAL_SIGNER_SOCKET: `/run/fased-local/${instance}/application/app.sock`,
    },
  };
}

// This is the stable owner launcher emitted by the immutable rc.72 Go
// lifecycle implementation. The predecessor capsule models that exact public
// installation class; it must not depend on a checkout or on the target
// generation's newer bundled-Node launcher contract.
function predecessorCliLauncher(config) {
  const instance = config.instanceId;
  return `#!/usr/bin/env bash
set -euo pipefail
install_root="${config.installRoot}"
export FASED_RUNTIME_SOURCE="go-lifecycle"
export FASED_MANAGED_RUNTIME_ROOT="${config.installRoot}/current/payload/runtime"
export FASED_LIFECYCLE_PROFILE="protected-local"
export FASED_LIFECYCLE_INSTANCE="${instance}"
export FASED_LIFECYCLE_CONFIG="${config.lifecycleRoot}/platform.json"
export FASED_LIFECYCLE_INSTALL_ROOT="${config.installRoot}"
export FASED_HOST_PROFILE="local"
export FASED_HOST_UPDATER_SOCKET="/run/fased-local-controller/${instance}/request.sock"
export FASED_WALLET_LOCAL_SIGNER_BIN="${config.installRoot}/current/payload/bin/fased-signerd"
export FASED_WALLET_LOCAL_SIGNER_SOCKET="/run/fased-local/${instance}/application/app.sock"
export FASED_PROTECTED_LOCAL="1"
export FASED_PROTECTED_LOCAL_INSTANCE="${instance}"
export FASED_WALLET_LOCAL_SIGNER_LIFECYCLE="external"
current="$install_root/current"
inventory="$current/inventory.json"
runtime="$current/payload/runtime/fased.mjs"
[[ -f "$inventory" && ! -L "$inventory" && -f "$runtime" && ! -L "$runtime" ]] || {
  echo "Fased runtime is not committed; run the verified installer or fased update." >&2
  exit 1
}
node_bin=""
for candidate in "\${FASED_NODE_BIN:-}" /usr/local/bin/node /usr/bin/node /usr/bin/node-24 /usr/bin/node-22; do
  [[ -n "$candidate" && -x "$candidate" ]] || continue
  if "$candidate" -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<22||(a===22&&b<14))process.exit(1);require("node:sqlite")' >/dev/null 2>&1; then
    node_bin="$candidate"
    break
  fi
done
[[ -n "$node_bin" ]] || { echo "Compatible Node runtime not found for Fased." >&2; exit 1; }
dependency_identity="$("$node_bin" -e '
  const fs=require("node:fs");
  const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  const hash=value?.dependency?.hash;
  const archive=value?.dependency?.archiveSHA256;
  if(typeof hash!=="string"||!/^[a-f0-9]{64}$/.test(hash)||typeof archive!=="string"||!/^sha256:[a-f0-9]{64}$/.test(archive))process.exit(1);
  process.stdout.write(hash+" "+archive.slice(7));
' "$inventory")" || { echo "Fased dependency identity is invalid." >&2; exit 1; }
read -r dependency_hash dependency_archive_hash <<<"$dependency_identity"
binding="$current/node_modules"
binding_target="$(readlink "$binding" 2>/dev/null || true)"
case "$binding_target" in
  "../../dependencies/$dependency_hash-$dependency_archive_hash/node_modules")
    dependency="$install_root/dependencies/$dependency_hash-$dependency_archive_hash/node_modules"
    ;;
  "../../dependencies/$dependency_hash/node_modules")
    dependency="$install_root/dependencies/$dependency_hash/node_modules"
    ;;
  *)
    echo "Fased generation dependency binding is invalid." >&2
    exit 1
    ;;
esac
[[ -d "$dependency" && ! -L "$dependency" ]] || { echo "Fased dependency layer is unavailable." >&2; exit 1; }
[[ -L "$binding" && "$(readlink -f "$binding")" == "$dependency" ]] || {
  echo "Fased generation dependency binding is invalid." >&2
  exit 1
}
export NODE_PATH="$dependency"
exec "$node_bin" "$runtime" "$@"
`;
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--") || argv[index + 1] === undefined) {
      fail("arguments must be --name value pairs");
    }
    values[argv[index].slice(2)] = argv[index + 1];
  }
  return values;
}

export async function buildCanonicalManagedPredecessorCapsule(options) {
  const {
    releaseManifestPath,
    releaseManifestAttestationPath,
    releaseTree,
    candidateDescriptorPath,
    generationArchivePath,
    dependencyArchivePath,
    previousGenerationPath,
    compatibilityIndexPath,
    acceptanceContractPath,
    outputDirectory,
    builderCommit,
    builderTree,
    branchProof = false,
  } = options;
  if (!COMMIT.test(releaseTree || "")) {
    fail("release tree is invalid");
  }
  const releaseManifest = JSON.parse(await fsp.readFile(releaseManifestPath, "utf8"));
  const candidate = JSON.parse(await fsp.readFile(candidateDescriptorPath, "utf8"));
  const predecessorEvidence = JSON.parse(await fsp.readFile(previousGenerationPath, "utf8"));
  const previous = predecessorEvidence.previousGeneration || predecessorEvidence;
  const { version, tag, commit } = releaseManifest?.release || {};
  if (
    tag !== `v${version}` ||
    !COMMIT.test(commit || "") ||
    candidate.version !== version ||
    candidate.commit !== commit ||
    candidate.tree !== releaseTree
  ) {
    fail("release and candidate identities disagree");
  }
  if (
    predecessorEvidence.previousGeneration &&
    (predecessorEvidence.schemaVersion !== 1 ||
      predecessorEvidence.role !== "fased-owner-local-predecessor-evidence" ||
      predecessorEvidence.activeVersion !== version)
  ) {
    fail("owner predecessor evidence is not bound to the active release");
  }
  if (branchProof && (!COMMIT.test(builderCommit || "") || !COMMIT.test(builderTree || ""))) {
    fail("branch proof identity is invalid");
  }
  for (const file of [generationArchivePath, dependencyArchivePath]) {
    const name = path.basename(file);
    const record = candidate.artifacts?.find((artifact) => artifact.name === name);
    const info = await fsp.lstat(file);
    if (
      !record ||
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size !== record.size ||
      (await sha256(file)) !== record.sha256
    ) {
      fail(`candidate artifact identity is invalid: ${name}`);
    }
  }
  const metadataRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-managed-metadata-"));
  const source = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-managed-predecessor-"));
  try {
    tar.x({
      cwd: metadataRoot,
      file: generationArchivePath,
      strict: true,
      sync: true,
    });
    const generationRecord = JSON.parse(
      await fsp.readFile(path.join(metadataRoot, "generation/generation.json"), "utf8"),
    );
    const inventory = JSON.parse(
      await fsp.readFile(path.join(metadataRoot, "generation/inventory.json"), "utf8"),
    );
    const generation = generationRecord.generation;
    if (
      generation.version !== version ||
      generation.commit !== commit ||
      generation.tree !== releaseTree ||
      generation.id !== generation.artifactSetDigest ||
      !DIGEST.test(generation.id || "") ||
      inventory.version !== version ||
      inventory.commit !== commit ||
      inventory.tree !== releaseTree ||
      inventory.dependency.asset !== path.basename(dependencyArchivePath) ||
      inventory.dependency.archiveSHA256 !== (await sha256(dependencyArchivePath))
    ) {
      fail("generation inventory is not bound to the release");
    }
    if (
      !DIGEST.test(previous.id || "") ||
      previous.id !== previous.artifactSetDigest ||
      !COMMIT.test(previous.commit || "") ||
      !COMMIT.test(previous.tree || "") ||
      previous.id === generation.id
    ) {
      fail("previous generation evidence is invalid");
    }
    const instance = "1122334455667788";
    const config = canonicalConfig(instance);
    const platform = legacyPlatform(config);
    const generationRoot = `${config.installRoot}/generations/${generation.id.slice(7)}`;
    const dependencyRoot = `${config.installRoot}/dependencies/${inventory.dependency.hash}-${inventory.dependency.archiveSHA256.slice(7)}`;
    const manifest = {
      schemaVersion: 1,
      profile: "protected-local",
      platform,
      activeGeneration: generation,
      previousGeneration: previous,
      stateSchemas: inventory.stateSchemas,
      capabilities: inventory.capabilities,
    };
    const entries = [];
    const roots = [
      ["opt/fased", 0o755, "root"],
      ["opt/fased/lifecycle", 0o755, "root"],
      ["opt/fased/lifecycle/supervisor-v1", 0o755, "root"],
      [`opt/fased/local/${instance}`, 0o755, "root"],
      [`opt/fased/local/${instance}/generations`, 0o755, "root"],
      [`opt/fased/local/${instance}/dependencies`, 0o755, "root"],
      [`opt/fased/local/${instance}/generations/${previous.id.slice(7)}`, 0o755, "root"],
      [`var/lib/fased-local/${instance}`, 0o755, "root"],
      [`var/lib/fased-local/${instance}/controller`, 0o700, "root"],
      [`var/lib/fased-local/${instance}/lifecycle`, 0o700, "root"],
      [`var/lib/fased-local/${instance}/signer`, 0o700, "root"],
      ["var/lib/fased-predecessor-input", 0o700, "root"],
      ["var/lib/fased-local-registry", 0o700, "root"],
      ["home/testop/.fased", 0o700, "operator"],
      ["home/testop/.fased/bin", 0o700, "operator"],
      ["home/testop/.fased/cache", 0o700, "operator"],
      ["home/testop/.fased/wallet", 0o700, "operator"],
    ];
    for (const [relative, mode, owner] of roots) {
      entries.push(await directory(source, relative, mode, owner));
    }
    entries.push(
      await copy(
        source,
        "var/lib/fased-predecessor-input/generation.tar.gz",
        generationArchivePath,
        0o600,
        "root",
      ),
      await copy(
        source,
        "var/lib/fased-predecessor-input/dependency.tar.gz",
        dependencyArchivePath,
        0o600,
        "root",
      ),
      await copy(
        source,
        "opt/fased/lifecycle/supervisor-v1/fased-lifecycled",
        path.join(metadataRoot, "generation/payload/bin/fased-lifecycled"),
        0o755,
        "root",
      ),
      await write(
        source,
        `var/lib/fased-local/${instance}/lifecycle/platform.json`,
        `${JSON.stringify(config, null, 2)}\n`,
        0o600,
        "root",
      ),
      await write(
        source,
        `var/lib/fased-local/${instance}/lifecycle/installation-manifest.json`,
        `${JSON.stringify(manifest, null, 2)}\n`,
        0o600,
        "root",
      ),
      await write(
        source,
        "var/lib/fased-local-registry/instances.json",
        `${JSON.stringify(localInstanceRegistry(config))}\n`,
        0o600,
        "root",
      ),
      await write(
        source,
        "home/testop/.fased/install.json",
        `${JSON.stringify(managedInstall(config, generation, previous), null, 2)}\n`,
        0o600,
        "operator",
      ),
      await write(
        source,
        "home/testop/.fased/lifecycle.json",
        `${JSON.stringify(lifecycleProjection(config), null, 2)}\n`,
        0o600,
        "operator",
      ),
      await write(
        source,
        "home/testop/.fased/bin/fased",
        predecessorCliLauncher(config),
        0o755,
        "operator",
      ),
      await write(
        source,
        "home/testop/.fased/fased.json",
        `${JSON.stringify({ gateway: { mode: "local", bind: "loopback", port: config.gatewayPort, auth: { mode: "token", token: "synthetic-predecessor-token" }, remote: { token: "synthetic-predecessor-token" } }, env: { vars: { FASED_PROTECTED_LOCAL_INSTANCE: instance } } }, null, 2)}\n`,
        0o600,
        "operator",
      ),
    );
    const units = new Map([
      [platform.services.controller, controllerUnit(config, generationRoot)],
      [platform.services.gateway, gatewayUnit(config, generationRoot, dependencyRoot, version)],
      [platform.services.signer, signerUnit(config, generationRoot)],
      [platform.services.supervisor, supervisorUnit(config)],
    ]);
    for (const [name, contents] of units) {
      entries.push(await write(source, `etc/systemd/system/${name}`, contents, 0o644, "root"));
    }
    for (const [name, target] of [
      ["current", `generations/${generation.id.slice(7)}`],
      ["previous", `generations/${previous.id.slice(7)}`],
    ]) {
      const relative = `opt/fased/local/${instance}/${name}`;
      await fsp.symlink(target, path.join(source, relative));
      entries.push({ path: relative, type: "symlink", owner: "root" });
    }
    const result = await buildInstalledStateCapsule({
      sourceRoot: source,
      outputDirectory,
      spec: {
        schemaVersion: 1,
        role: "fased-installed-state-capsule-spec",
        profile: "protected-local",
        compatibilityGroupId: "canonical-managed-schema1-local-v1",
        compatibilityDigest: await sha256(compatibilityIndexPath),
        release: { version, commit, tree: releaseTree },
        sourceReceipt: {
          schemaVersion: 1,
          repository: "fased-ai/fased",
          tag,
          authority: "github-artifact-attestation",
          manifest: {
            name: path.basename(releaseManifestPath),
            sha256: await sha256(releaseManifestPath),
          },
          manifestAttestation: {
            name: path.basename(releaseManifestAttestationPath),
            sha256: await sha256(releaseManifestAttestationPath),
          },
        },
        releaseIndex: null,
        topology: {
          schemaVersion: 1,
          kind: "managed-generation",
          capabilities: ["canonical-manifest-v1", "external-signer", "local-systemd"],
        },
        installationClass: {
          kind: "canonical-managed",
          manifestSchema: 1,
          platform,
          activeGeneration: generation,
          previousGeneration: previous,
          stateSchemas: inventory.stateSchemas,
          capabilities: inventory.capabilities,
        },
        ownership: { rootUid: 0, rootGid: 0, operatorUid: 2000, operatorGid: 2000 },
        pointers: { current: generation.id, previous: previous.id },
        expectedReceiptDigest: await sha256(acceptanceContractPath),
        sanitization: { syntheticState: true, containsSecrets: false },
        services: Object.keys(platform.services)
          .toSorted()
          .map((role) => platform.services[role]),
        archiveName: `fased-predecessor-protected-local-${version}.tar.gz`,
        entries,
      },
    });
    if (branchProof) {
      const proof = {
        schemaVersion: 1,
        role: "fased-predecessor-capsule-branch-proof",
        publishable: false,
        profile: "protected-local",
        builder: { commit: builderCommit, tree: builderTree },
        release: { version, commit, tree: releaseTree },
        descriptor: {
          name: path.basename(result.descriptorPath),
          sha256: await sha256(result.descriptorPath),
        },
        archive: {
          name: path.basename(result.archivePath),
          sha256: await sha256(result.archivePath),
        },
      };
      await fsp.writeFile(
        path.join(outputDirectory, "fased-predecessor-branch-proof.json"),
        `${JSON.stringify(proof, null, 2)}\n`,
        { flag: "wx", mode: 0o600 },
      );
    }
    return result;
  } finally {
    await fsp.rm(metadataRoot, { recursive: true, force: true });
    await fsp.rm(source, { recursive: true, force: true });
  }
}

async function main() {
  const values = parseArguments(process.argv.slice(2));
  const result = await buildCanonicalManagedPredecessorCapsule({
    releaseManifestPath: values["release-manifest"],
    releaseManifestAttestationPath: values["release-manifest-attestation"],
    releaseTree: values["release-tree"],
    candidateDescriptorPath: values["candidate-descriptor"],
    generationArchivePath: values["generation-archive"],
    dependencyArchivePath: values["dependency-archive"],
    previousGenerationPath: values["previous-generation"],
    compatibilityIndexPath: values["compatibility-index"],
    acceptanceContractPath: values["acceptance-contract"],
    outputDirectory: values.output,
    builderCommit: values["builder-commit"],
    builderTree: values["builder-tree"],
    branchProof: values["branch-proof"] === "1",
  });
  process.stdout.write(
    `${JSON.stringify({ descriptor: result.descriptorPath, archive: result.archivePath })}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
