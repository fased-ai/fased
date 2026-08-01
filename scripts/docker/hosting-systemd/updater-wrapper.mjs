#!/usr/bin/env node

import fsp from "node:fs/promises";
import path from "node:path";
const { __testing, startServer } =
  await import("file:///opt/fased/host-controller/current/fased-host-updater.mjs");

const assetsDir = "/artifacts";

async function copyFixtureAsset(url, destination) {
  const asset = path.basename(new URL(url).pathname);
  const source = path.join(assetsDir, asset);
  await fsp.copyFile(source, destination);
  await fsp.chmod(destination, 0o600);
}

const configuration = __testing.parseServerConfiguration();
const context = __testing.createTransactionContext({
  paths: configuration.paths,
  signerServiceName: configuration.signerServiceName,
  gatewayServiceName: configuration.gatewayServiceName,
  signerApplicationSocketPath: configuration.signerApplicationSocketPath,
  supervised: configuration.supervised,
  controllerConfiguration: configuration,
  downloadReleaseAsset: copyFixtureAsset,
  verifyReleaseAsset: async () => undefined,
});

await startServer({ configuration, context });
