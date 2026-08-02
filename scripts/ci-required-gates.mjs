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
  if (enabled(input.manualReviewRequired)) {
    throw new Error(
      "required change scope is ambiguous; select one lifecycle entry point or the explicit full matrix",
    );
  }

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
      "packed package smoke",
    ]) {
      requireSuccess(results, name);
    }
  }
  if (enabled(input.runSigner)) {
    requireSuccess(results, "native signer");
  }
  if (enabled(input.runHosting)) {
    requireSuccess(results, "Hosting supporting fixtures");
  }
  if (enabled(input.runLocalFresh) || enabled(input.runLocalUpdate)) {
    requireSuccess(results, "Protected Local fixture artifact");
  }
  if (enabled(input.runLocalFresh)) {
    requireSuccess(results, "Local fresh supporting fixture");
  }
  if (enabled(input.runLocalUpdate)) {
    requireSuccess(results, "Local update supporting fixture");
  }
  if (enabled(input.runCiContracts)) {
    requireSuccess(results, "CI contracts");
  }
  if (enabled(input.runT2Contracts)) {
    requireSuccess(results, "T2 privilege source contracts (supporting)");
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
    requireSuccess(results, "Local Rocky supporting fixture");
    requireSuccess(results, "full UI");
    requireSuccess(results, "Windows");
  }
}

export function gateInputFromEnv(env = process.env) {
  return {
    docsChanged: env.DOCS_CHANGED,
    manualReviewRequired: env.MANUAL_REVIEW_REQUIRED,
    versionOnly: env.VERSION_ONLY,
    runNode: env.RUN_NODE,
    runSigner: env.RUN_SIGNER,
    runHosting: env.RUN_HOSTING,
    runLocalFresh: env.RUN_LOCAL_FRESH,
    runLocalUpdate: env.RUN_LOCAL_UPDATE,
    runCiContracts: env.RUN_CI_CONTRACTS,
    runT2Contracts: env.RUN_T2_CONTRACTS,
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
      "packed package smoke": env.PACKED_CORE,
      "native signer": env.SIGNER,
      "Hosting supporting fixtures": env.HOSTING,
      "Protected Local fixture artifact": env.PROTECTED_LOCAL_ARTIFACT,
      "Local fresh supporting fixture": env.PROTECTED_LOCAL,
      "Local Rocky supporting fixture": env.PROTECTED_LOCAL_ROCKY,
      "Local update supporting fixture": env.PROTECTED_LOCAL_UPDATE,
      "CI contracts": env.CI_CONTRACTS,
      "T2 privilege source contracts (supporting)": env.T2_CONTRACTS,
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
  console.log(
    "ci-required-gates: every selected supporting CI job succeeded; installed acceptance remains receipt-bound",
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
