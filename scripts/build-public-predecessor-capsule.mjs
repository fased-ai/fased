#!/usr/bin/env node

import {
  createCipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  scryptSync,
} from "node:crypto";
import { createReadStream } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildInstalledStateCapsule } from "./lifecycle-installed-state-capsule.mjs";

const COMMIT = /^[a-f0-9]{40}$/u;

function fail(message) {
  throw new Error(`public predecessor capsule: ${message}`);
}

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }
  return `sha256:${hash.digest("hex")}`;
}

async function write(root, relative, contents, mode) {
  const file = path.join(root, relative);
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o755 });
  await fsp.writeFile(file, contents, { mode, flag: "wx" });
  await fsp.chmod(file, mode);
  return {
    path: relative,
    type: "file",
    owner: relative.startsWith("home/") ? "operator" : "root",
  };
}

async function directory(root, relative, mode, owner = "operator") {
  const target = path.join(root, relative);
  await fsp.mkdir(target, { recursive: true, mode });
  await fsp.chmod(target, mode);
  return { path: relative, type: "directory", owner };
}

function managedInstall({ profile, owner, version, commit, manifestDigest }) {
  const state = `/home/${owner}/.fased`;
  return {
    schemaVersion: 2,
    profile: profile === "hosting" ? "hosting" : "local",
    source: "managed-artifact",
    stateDir: state,
    configPath: `${state}/fased.json`,
    runtime: {
      activeVersion: version,
      previousVersion: null,
      currentLink: `${state}/runtime/current`,
      previousLink: `${state}/runtime/previous`,
      releasesDir: `${state}/runtime/releases`,
      dependencyHash: null,
      releaseManifestDigest: manifestDigest,
      appCommit: commit,
      appArtifact: null,
      appArtifactDigest: null,
    },
    package: {},
    service: {
      name: "fased-gateway.service",
      scope: profile === "hosting" ? "system" : "user",
      launcher: `${state}/bin/fased-service`,
    },
    updater: {},
    update: {},
    release: { version, commit },
    updatedAt: "1970-01-01T00:00:00.000Z",
  };
}

function syntheticDeviceIdentity() {
  const seed = createHash("sha256").update("fased-public-predecessor-fixture-v1\n").digest();
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey(privateKey);
  const publicKeyDer = publicKey.export({ format: "der", type: "spki" });
  return {
    version: 1,
    deviceId: createHash("sha256").update(publicKeyDer.subarray(-32)).digest("hex"),
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    createdAtMs: 0,
  };
}

function encodeBase58(bytes) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
  let encoded = "";
  while (value > 0n) {
    encoded = alphabet[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) {
      break;
    }
    encoded = `1${encoded}`;
  }
  return encoded || "1";
}

function syntheticLegacyWallet() {
  const passphrase = "fased-synthetic-predecessor-passphrase";
  const seed = createHash("sha256").update("fased-public-predecessor-wallet-v1\n").digest();
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey(privateKey)
    .export({ format: "der", type: "spki" })
    .subarray(-32);
  const secretKey = Buffer.concat([seed, publicKey]);
  const salt = createHash("sha256")
    .update("fased-predecessor-wallet-salt-v1\n")
    .digest()
    .subarray(0, 16);
  const iv = createHash("sha256")
    .update("fased-predecessor-wallet-iv-v1\n")
    .digest()
    .subarray(0, 12);
  const key = scryptSync(passphrase, salt, 32);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(secretKey), cipher.final()]);
  return {
    passphrase,
    publicKey: encodeBase58(publicKey),
    envelope: {
      kind: "fased-solana-keypair",
      version: 1,
      kdf: "scrypt",
      cipher: "aes-256-gcm",
      salt: salt.toString("base64url"),
      iv: iv.toString("base64url"),
      authTag: cipher.getAuthTag().toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      publicKey: encodeBase58(publicKey),
    },
  };
}

function syntheticWalletRegistry(legacyWallet = null) {
  const updatedAt = "1970-01-01T00:00:00.000Z";
  return {
    version: 1,
    providers: {
      "embedded-keystore": {
        enabled: legacyWallet !== null,
        updatedAt,
        label: "Legacy embedded keystore (migration required)",
      },
      "local-socket-signer": {
        enabled: legacyWallet === null,
        updatedAt,
        label: "Local signer",
      },
      alchemy: { enabled: false, updatedAt },
      turnkey: { enabled: false, updatedAt, label: "Turnkey (policy-managed)" },
      "wallet-standard": {
        enabled: true,
        updatedAt,
        label: "Wallet Standard (verify hardware on device)",
      },
      privy: { enabled: false, updatedAt, label: "Privy (integration unavailable)" },
    },
    wallets:
      legacyWallet === null
        ? []
        : [
            {
              id: "agent-2",
              name: "Agent 2",
              providerId: "embedded-keystore",
              addresses: { solana: legacyWallet.publicKey },
              metadata: { role: "agent", purpose: "agent" },
              createdAt: updatedAt,
              updatedAt,
            },
          ],
    assignments: {},
    ...(legacyWallet === null ? {} : { defaultWalletId: "agent-2" }),
    updatedAt,
  };
}

function gatewaySource(version) {
  return `import http from "node:http";\nconst version=${JSON.stringify(version)};\nconst port=Number(process.env.FASED_GATEWAY_PORT||18789);\nhttp.createServer((request,response)=>{if(request.url==="/healthz"){response.setHeader("content-type","application/json");response.end(JSON.stringify({ok:true,version,runtimeSource:"managed-package"}));return;}response.statusCode=404;response.end();}).listen(port,"127.0.0.1");\n`;
}

function localUnit() {
  return `[Unit]\nDescription=Fased public-stable Gateway fixture\nAfter=network.target\n\n[Service]\nType=simple\nEnvironment=FASED_GATEWAY_PORT=19456\nExecStart=/home/testop/.fased/bin/fased-service\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\n`;
}

function hostingUnits() {
  return new Map([
    [
      "fased-host-updater.service",
      `[Unit]\nDescription=Fased stable updater fixture\n[Service]\nType=simple\nExecStart=/usr/bin/sleep infinity\n[Install]\nWantedBy=multi-user.target\n`,
    ],
    [
      "fased-host-controller.service",
      `[Unit]\nDescription=Fased stable controller fixture\n[Service]\nType=simple\nExecStart=/usr/bin/sleep infinity\n[Install]\nWantedBy=multi-user.target\n`,
    ],
    [
      "fased-signerd.service",
      `[Unit]\nDescription=Fased stable signer fixture\n[Service]\nType=simple\nExecStart=/usr/bin/sleep infinity\n[Install]\nWantedBy=multi-user.target\n`,
    ],
    [
      "fased-gateway.service",
      `[Unit]\nDescription=Fased public-stable Gateway fixture\nAfter=network.target\n[Service]\nType=simple\nUser=app\nEnvironment=FASED_GATEWAY_PORT=18789\nExecStart=/home/app/.fased/bin/fased-service\nRestart=on-failure\n[Install]\nWantedBy=multi-user.target\n`,
    ],
  ]);
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

export async function buildPublicPredecessorCapsule({
  profile,
  releaseManifestPath,
  releaseManifestAttestationPath,
  releaseTree,
  compatibilityIndexPath,
  acceptanceContractPath,
  outputDirectory,
  builderCommit,
  builderTree,
  branchProof = false,
}) {
  if (!["protected-local", "hosting"].includes(profile) || !COMMIT.test(releaseTree || "")) {
    fail("profile or release tree is invalid");
  }
  const releaseManifest = JSON.parse(await fsp.readFile(releaseManifestPath, "utf8"));
  const { version, tag, commit } = releaseManifest?.release || {};
  if (
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(version || "") ||
    !COMMIT.test(commit || "") ||
    tag !== `v${version}`
  ) {
    fail("release manifest identity is invalid");
  }
  if (branchProof && (!COMMIT.test(builderCommit || "") || !COMMIT.test(builderTree || ""))) {
    fail("branch proof identity is invalid");
  }
  const owner = profile === "hosting" ? "app" : "testop";
  const operatorUid = 2000;
  const operatorGid = 2000;
  const legacyWallet = profile === "hosting" ? syntheticLegacyWallet() : null;
  const stateRelative = `home/${owner}/.fased`;
  const releaseRelative = `${stateRelative}/runtime/releases/${version}`;
  const source = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-public-predecessor-"));
  try {
    const manifestDigest = await sha256(releaseManifestPath);
    const entries = [];
    for (const relative of [
      stateRelative,
      `${stateRelative}/bin`,
      `${stateRelative}/identity`,
      `${stateRelative}/runtime`,
      `${stateRelative}/runtime/releases`,
      releaseRelative,
      `${stateRelative}/wallet`,
    ]) {
      entries.push(await directory(source, relative, 0o700));
    }
    if (profile === "protected-local") {
      entries.push(await directory(source, `home/${owner}/.config`, 0o700));
      entries.push(await directory(source, `home/${owner}/.config/systemd`, 0o700));
      entries.push(await directory(source, `home/${owner}/.config/systemd/user`, 0o700));
    }
    entries.push(
      await write(
        source,
        `${stateRelative}/install.json`,
        `${JSON.stringify(managedInstall({ profile, owner, version, commit, manifestDigest }), null, 2)}\n`,
        0o600,
      ),
    );
    entries.push(
      await write(
        source,
        `${stateRelative}/fased.json`,
        `${JSON.stringify({ gateway: { mode: profile === "hosting" ? "remote" : "local", bind: "loopback", port: profile === "hosting" ? 18789 : 19456, auth: { mode: "token", token: "synthetic-predecessor-token" }, remote: { token: "synthetic-predecessor-token" } }, ...(legacyWallet === null ? {} : { wallet: { provider: { id: "embedded-keystore" } }, env: { vars: { FASED_WALLET_PASSPHRASE: legacyWallet.passphrase, FASED_WALLET_SOLANA_RPC_URL__AGENT_2: "https://api.mainnet-beta.solana.com" } } }) }, null, 2)}\n`,
        0o600,
      ),
    );
    entries.push(
      await write(
        source,
        `${stateRelative}/identity/device.json`,
        `${JSON.stringify(syntheticDeviceIdentity(), null, 2)}\n`,
        0o600,
      ),
    );
    entries.push(
      await write(
        source,
        `${stateRelative}/wallet/provider-registry.v1.json`,
        `${JSON.stringify(syntheticWalletRegistry(legacyWallet), null, 2)}\n`,
        0o600,
      ),
    );
    if (legacyWallet !== null) {
      entries.push(
        await write(
          source,
          `${stateRelative}/wallet/keystore-solana-agent-2.v1.enc`,
          `${JSON.stringify(legacyWallet.envelope, null, 2)}\n`,
          0o600,
        ),
      );
    }
    entries.push(
      await write(
        source,
        `${releaseRelative}/package.json`,
        `${JSON.stringify({ name: "@fased/fased", version })}\n`,
        0o600,
      ),
    );
    entries.push(
      await write(source, `${releaseRelative}/gateway.mjs`, gatewaySource(version), 0o700),
    );
    entries.push(
      await write(
        source,
        `${stateRelative}/bin/fased-service`,
        `#!/usr/bin/env bash\nexec /usr/local/bin/node /home/${owner}/.fased/runtime/current/gateway.mjs\n`,
        0o700,
      ),
    );
    await fsp.symlink(`releases/${version}`, path.join(source, `${stateRelative}/runtime/current`));
    entries.push({ path: `${stateRelative}/runtime/current`, type: "symlink", owner: "operator" });
    if (profile === "protected-local") {
      entries.push(
        await write(
          source,
          `home/${owner}/.config/systemd/user/fased-gateway.service`,
          localUnit(),
          0o600,
        ),
      );
    } else {
      for (const [name, contents] of hostingUnits()) {
        entries.push(await write(source, `etc/systemd/system/${name}`, contents, 0o600));
      }
    }
    const compatibilityDigest = await sha256(compatibilityIndexPath);
    const acceptanceDigest = await sha256(acceptanceContractPath);
    const pointerDigest = `sha256:${createHash("sha256").update(`${version}\n${commit}\n${releaseTree}\n`).digest("hex")}`;
    const result = await buildInstalledStateCapsule({
      sourceRoot: source,
      outputDirectory,
      spec: {
        schemaVersion: 1,
        role: "fased-installed-state-capsule-spec",
        profile,
        compatibilityGroupId:
          profile === "hosting" ? "public-stable-hosting-v1" : "public-stable-local-v1",
        compatibilityDigest,
        release: { version, commit, tree: releaseTree },
        sourceReceipt: {
          schemaVersion: 1,
          repository: "fased-ai/fased",
          tag,
          authority: "github-artifact-attestation",
          manifest: {
            name: path.basename(releaseManifestPath),
            sha256: manifestDigest,
          },
          manifestAttestation: {
            name: path.basename(releaseManifestAttestationPath),
            sha256: await sha256(releaseManifestAttestationPath),
          },
        },
        releaseIndex: null,
        topology: {
          schemaVersion: 1,
          kind: "public-stable",
          capabilities:
            profile === "hosting"
              ? ["hosting-systemd", "external-signer"]
              : ["local-systemd", "external-signer"],
        },
        installationClass: {
          kind: "public-stable",
          manifestSchema: null,
          platform: null,
          activeGeneration: null,
          previousGeneration: null,
          stateSchemas: {
            federation: 1,
            managedInstall: 2,
            mining: 1,
            signer: 1,
            walletRegistry: 1,
          },
          capabilities: null,
        },
        ownership: { rootUid: 0, rootGid: 0, operatorUid, operatorGid },
        pointers: { current: pointerDigest, previous: null },
        expectedReceiptDigest: acceptanceDigest,
        sanitization: { syntheticState: true, containsSecrets: false },
        services: profile === "hosting" ? [...hostingUnits().keys()] : ["fased-gateway.service"],
        archiveName: `fased-predecessor-${profile}-${version}.tar.gz`,
        entries,
      },
    });
    if (branchProof) {
      const proof = {
        schemaVersion: 1,
        role: "fased-predecessor-capsule-branch-proof",
        publishable: false,
        profile,
        builder: { commit: builderCommit, tree: builderTree },
        release: { version, commit, tree: releaseTree, manifestDigest },
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
        { mode: 0o600, flag: "wx" },
      );
    }
    return result;
  } finally {
    await fsp.rm(source, { recursive: true, force: true });
  }
}

async function main() {
  const values = parseArguments(process.argv.slice(2));
  const result = await buildPublicPredecessorCapsule({
    profile: values.profile,
    releaseManifestPath: values["release-manifest"],
    releaseManifestAttestationPath: values["release-manifest-attestation"],
    releaseTree: values["release-tree"],
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
