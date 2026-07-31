#!/usr/bin/env node

function enabled(value) {
  return value === true || value === "true";
}

function requireSuccess(results, name) {
  const result = results[name];
  if (result !== "success") {
    throw new Error(`required ${name} result was ${result ?? "missing"}`);
  }
}

export function assertApplicableGates(input) {
  const results = input.results ?? {};
  requireSuccess(results, "change scope");
  requireSuccess(results, "secrets");

  if (enabled(input.versionOnly)) {
    requireSuccess(results, "version identity");
    return;
  }

  if (enabled(input.docsChanged)) {
    requireSuccess(results, "documentation");
  }
  if (enabled(input.runNode)) {
    for (const name of [
      "format and lint",
      "strict types baseline",
      "Node tests",
      "dist build",
      "release contracts",
      "packed Local install",
    ]) {
      requireSuccess(results, name);
    }
  }
  if (enabled(input.runSigner)) {
    requireSuccess(results, "native signer");
  }
  if (enabled(input.runHosting)) {
    requireSuccess(results, "Hosting lifecycle");
  }
  if (enabled(input.runLocalFresh) || enabled(input.runLocalUpdate)) {
    requireSuccess(results, "Protected Local fixture artifact");
  }
  if (enabled(input.runLocalFresh)) {
    requireSuccess(results, "Protected Local lifecycle");
  }
  if (enabled(input.runLocalUpdate)) {
    requireSuccess(results, "Protected Local update lifecycle");
  }
  if (enabled(input.runCiContracts)) {
    requireSuccess(results, "CI contracts");
  }
  if (enabled(input.runUiMining)) {
    requireSuccess(results, "Mining browser");
  }
  if (enabled(input.runSkills)) {
    requireSuccess(results, "skills");
  }
  if (enabled(input.runMacos)) {
    requireSuccess(results, "macOS");
  }
  if (enabled(input.fullMatrix)) {
    requireSuccess(results, "Protected Local Rocky lifecycle");
    requireSuccess(results, "full UI");
    requireSuccess(results, "Windows");
  }
}

export function gateInputFromEnv(env = process.env) {
  return {
    docsChanged: env.DOCS_CHANGED,
    versionOnly: env.VERSION_ONLY,
    runNode: env.RUN_NODE,
    runSigner: env.RUN_SIGNER,
    runHosting: env.RUN_HOSTING,
    runLocalFresh: env.RUN_LOCAL_FRESH,
    runLocalUpdate: env.RUN_LOCAL_UPDATE,
    runCiContracts: env.RUN_CI_CONTRACTS,
    runUiMining: env.RUN_UI_MINING,
    runSkills: env.RUN_SKILLS,
    runMacos: env.RUN_MACOS,
    fullMatrix: env.FULL_MATRIX,
    results: {
      "change scope": env.CHANGE_SCOPE,
      secrets: env.SECRETS,
      documentation: env.DOCS,
      "version identity": env.VERSION_IDENTITY,
      "format and lint": env.CHECK,
      "strict types baseline": env.STRICT_TYPES,
      "Node tests": env.TESTS,
      "dist build": env.BUILD,
      "release contracts": env.RELEASE,
      "packed Local install": env.PACKED_CORE,
      "native signer": env.SIGNER,
      "Hosting lifecycle": env.HOSTING,
      "Protected Local fixture artifact": env.PROTECTED_LOCAL_ARTIFACT,
      "Protected Local lifecycle": env.PROTECTED_LOCAL,
      "Protected Local Rocky lifecycle": env.PROTECTED_LOCAL_ROCKY,
      "Protected Local update lifecycle": env.PROTECTED_LOCAL_UPDATE,
      "CI contracts": env.CI_CONTRACTS,
      "Mining browser": env.UI_MINING,
      skills: env.SKILLS,
      macOS: env.MACOS,
      "full UI": env.UI,
      Windows: env.WINDOWS,
    },
  };
}

function main() {
  assertApplicableGates(gateInputFromEnv());
  console.log("ci-required-gates: every applicable gate succeeded");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
