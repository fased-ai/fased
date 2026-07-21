import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("managed gateway entry selection", () => {
  it("pins a built source checkout before consulting the managed package cache", () => {
    const script = fs.readFileSync(path.resolve(import.meta.dirname, "start-managed.sh"), "utf8");
    const sourceGuard = script.indexOf('[[ -d "$FASED_ROOT/.git" ]]');
    const managedCache = script.indexOf(
      '"$HOME/.fased/install-cache/npm-global/lib/node_modules/@fased/fased"',
    );

    expect(sourceGuard).toBeGreaterThanOrEqual(0);
    expect(managedCache).toBeGreaterThan(sourceGuard);
    expect(script).toContain('export FASED_RUNTIME_SOURCE="source-checkout"');
    expect(script).toContain('export FASED_RUNTIME_SOURCE="managed-package"');
    expect(script).toContain('export FASED_RUNTIME_SOURCE="packaged-runtime"');
  });

  it("prefers the lazy CLI entry before the compatibility index", () => {
    const script = fs.readFileSync(path.resolve(import.meta.dirname, "start-managed.sh"), "utf8");
    const start = script.indexOf("resolve_gateway_cli_entry() {");
    const end = script.indexOf("\n}\n", start);
    const resolver = script.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(resolver.indexOf("dist/entry.js")).toBeLessThan(resolver.indexOf("dist/index.js"));
    expect(resolver.indexOf("dist/entry.mjs")).toBeLessThan(resolver.indexOf("dist/index.mjs"));
  });

  it("starts the native Local signer directly and contains no Node broker lifecycle", () => {
    const script = fs.readFileSync(path.resolve(import.meta.dirname, "start-managed.sh"), "utf8");
    expect(script).toContain("start_signerd_process() {");
    expect(script).toContain('-socket "$SIGNERD_SOCKET"');
    expect(script).not.toContain("resolve_wallet_broker_cli_entry");
    expect(script).not.toContain("start_signer_broker");
    expect(script).not.toContain("wallet signer broker");
    expect(script).not.toContain("sudo -n -u");
  });

  it("migrates registered legacy wallets before the updated Gateway starts", () => {
    const script = fs.readFileSync(path.resolve(import.meta.dirname, "start-managed.sh"), "utf8");
    const migration = script.indexOf("migrate_registered_local_wallets_before_gateway_start");
    const gateway = script.indexOf("\nstart_gateway_if_needed", migration);
    expect(migration).toBeGreaterThanOrEqual(0);
    expect(gateway).toBeGreaterThan(migration);
    expect(script).toContain("local-signer migrate-active");
    expect(script).toContain('local-signer install --version "$RUNTIME_VERSION"');
  });

  it("stamps the gateway version from the runtime selected by the launcher", () => {
    const script = fs.readFileSync(path.resolve(import.meta.dirname, "start-managed.sh"), "utf8");
    const runtimeVersion = script.indexOf('RUNTIME_VERSION="$("$NODE_BIN"');
    const versionExport = script.indexOf('export FASED_VERSION="$RUNTIME_VERSION"');
    const gatewayEntry = script.indexOf("resolve_gateway_cli_entry() {");

    expect(runtimeVersion).toBeGreaterThanOrEqual(0);
    expect(versionExport).toBeGreaterThan(runtimeVersion);
    expect(gatewayEntry).toBeGreaterThan(versionExport);
    expect(script).toContain('path.join(root, "package.json")');
  });

  it("checks wallet status at startup without entering interactive wallet setup", () => {
    const script = fs.readFileSync(path.resolve(import.meta.dirname, "start-managed.sh"), "utf8");
    const commandStart = script.indexOf("WALLET_SETUP_CMD=(");
    const commandEnd = script.indexOf("\n  )", commandStart);
    const command = script.slice(commandStart, commandEnd);

    expect(commandStart).toBeGreaterThanOrEqual(0);
    expect(commandEnd).toBeGreaterThan(commandStart);
    expect(command).toContain("wallet\n    status\n    --json");
    expect(command).not.toContain("wallet\n    setup");
  });
});
