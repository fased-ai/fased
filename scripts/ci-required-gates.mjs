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
  const anyNode =
    enabled(input.runNodeFocused) ||
    enabled(input.runNodeBuild) ||
    enabled(input.runNodePackaging) ||
    enabled(input.runNodeFull);
  if (anyNode) {
    for (const name of ["format and lint", "strict types baseline"]) {
      requireSuccess(results, name);
    }
  }
  if (enabled(input.runNodeFocused)) {
    requireSuccess(results, "focused Node tests");
  }
  if (enabled(input.runNodeBuild)) {
    requireSuccess(results, "dist build");
  }
  if (enabled(input.runNodePackaging)) {
    requireSuccess(results, "release contracts");
    requireSuccess(results, "packed Local install");
  }
  if (enabled(input.runNodeFull)) {
    requireSuccess(results, "full Node tests");
  }
  if (enabled(input.runNativeSigner)) {
    requireSuccess(results, "native signer");
  }
  if (enabled(input.runSignerIntegration)) {
    requireSuccess(results, "signer integration");
  }
  if (enabled(input.runSignerDarwinIntegration)) {
    requireSuccess(results, "Darwin signer integration");
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
  if (enabled(input.runT2Contracts)) {
    requireSuccess(results, "T2 harness contracts");
  }
  if (enabled(input.runPlatformBootstrap)) {
    requireSuccess(results, "platform bootstrap");
  }
  if (enabled(input.runDocker)) {
    requireSuccess(results, "Docker amd64");
    requireSuccess(results, "Docker arm64");
  }
  if (enabled(input.runCodeqlJavascript)) {
    requireSuccess(results, "CodeQL JavaScript");
  }
  if (enabled(input.runCodeqlGo)) {
    requireSuccess(results, "CodeQL Go");
  }
  if (enabled(input.runCodeqlPython)) {
    requireSuccess(results, "CodeQL Python");
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
    runNodeFocused: env.RUN_NODE_FOCUSED,
    runNodeBuild: env.RUN_NODE_BUILD,
    runNodePackaging: env.RUN_NODE_PACKAGING,
    runNodeFull: env.RUN_NODE_FULL,
    runNativeSigner: env.RUN_NATIVE_SIGNER,
    runSignerIntegration: env.RUN_SIGNER_INTEGRATION,
    runSignerDarwinIntegration: env.RUN_SIGNER_DARWIN_INTEGRATION,
    runHosting: env.RUN_HOSTING,
    runLocalFresh: env.RUN_LOCAL_FRESH,
    runLocalUpdate: env.RUN_LOCAL_UPDATE,
    runCiContracts: env.RUN_CI_CONTRACTS,
    runT2Contracts: env.RUN_T2_CONTRACTS,
    runPlatformBootstrap: env.RUN_PLATFORM_BOOTSTRAP,
    runDocker: env.RUN_DOCKER,
    runCodeqlJavascript: env.RUN_CODEQL_JAVASCRIPT,
    runCodeqlGo: env.RUN_CODEQL_GO,
    runCodeqlPython: env.RUN_CODEQL_PYTHON,
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
      "focused Node tests": env.FOCUSED_TESTS,
      "full Node tests": env.TESTS,
      "dist build": env.BUILD,
      "release contracts": env.RELEASE,
      "packed Local install": env.PACKED_CORE,
      "native signer": env.SIGNER,
      "signer integration": env.SIGNER_INTEGRATION,
      "Darwin signer integration": env.SIGNER_DARWIN_INTEGRATION,
      "Hosting lifecycle": env.HOSTING,
      "Protected Local fixture artifact": env.PROTECTED_LOCAL_ARTIFACT,
      "Protected Local lifecycle": env.PROTECTED_LOCAL,
      "Protected Local Rocky lifecycle": env.PROTECTED_LOCAL_ROCKY,
      "Protected Local update lifecycle": env.PROTECTED_LOCAL_UPDATE,
      "CI contracts": env.CI_CONTRACTS,
      "T2 harness contracts": env.T2_CONTRACTS,
      "platform bootstrap": env.PLATFORM_BOOTSTRAP,
      "Docker amd64": env.DOCKER_AMD64,
      "Docker arm64": env.DOCKER_ARM64,
      "CodeQL JavaScript": env.CODEQL_JAVASCRIPT,
      "CodeQL Go": env.CODEQL_GO,
      "CodeQL Python": env.CODEQL_PYTHON,
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
