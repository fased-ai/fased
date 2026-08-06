#!/usr/bin/env node

import { createHash } from "node:crypto";

export const GATE_AUTHORITY_VERSION = 3;

export const PHASES = Object.freeze(["T0", "T1", "T2", "T3", "merge-reuse", "stable"]);
export const ENTRY_POINTS = Object.freeze([
  "local-fresh",
  "local-update",
  "hosting-fresh",
  "hosting-update",
]);

const DOC_PATH_RE = /^(?:docs\/|.*\.(?:md|mdx)$|scripts\/docs-product-contract\.mjs$)/;
const VERSION_PATH_RE =
  /^(?:package\.json|CHANGELOG\.md|src\/brand\.ts|extensions\/[^/]+\/(?:package\.json|CHANGELOG\.md))$/;
const CI_INFRASTRUCTURE_PATH_RE =
  /^(?:\.pre-commit-config\.yaml$|\.secrets\.baseline$|config\/lifecycle-compatibility\.v1\.json$|\.github\/(?:actions\/[^/]+\/action\.ya?ml|workflows\/[^/]+\.ya?ml)|scripts\/(?:gate-authority|hosted-installer-artifact-layout|lifecycle-compatibility-inventory|lifecycle-release-gate|release-artifact-set|verify-release-gate-status|ci-(?:change-scope|dependency-integrity|private-route-status|required-gates|merged-main-reuse|run-changed-tests|version-identity|workflow-contract))(?:\.mjs|\.test\.ts)|scripts\/(?:check-composite-action-input-interpolation\.py|lifecycle-release-gate-receipt\.v1\.schema\.json)|ui\/vitest\.changed-node\.config\.ts)$/;
const LIFECYCLE_GATE_REQUIRED_PATHS = Object.freeze(["scripts/lifecycle-release-gate.mjs"]);
const LIFECYCLE_GATE_ENFORCEMENT_PATH_RE =
  /^(?:\.github\/workflows\/(?:ci|docker-release)\.yml|scripts\/(?:gate-authority|lifecycle-release-gate|ci-(?:change-scope|private-route-status|required-gates|merged-main-reuse|version-identity|workflow-contract))(?:\.mjs|\.test\.ts)|scripts\/lifecycle-release-gate-receipt\.v1\.schema\.json)$/;
const T2_FIXTURE_PATH_RE =
  /^scripts\/(?:protected-local-t2-(?:controller-worker|supervisor-worker|systemd-fixture)\.mjs|protected-local-t2-systemd\.test\.ts|test-protected-local-t2-systemd\.sh)$/;
const TEST_PATH_RE =
  /^(?:test\/|tests\/|fixtures\/|.*\.(?:test|spec)\.[^.]+$|scripts\/test-[^/]+|scripts\/docker\/[^/]+\/)/;
const NON_PRODUCTION_TEST_PATH_RE = /^(?:test\/|tests\/|fixtures\/|.*\.(?:test|spec)\.[^.]+$)/;
const ROUTABLE_TEST_PATH_RE = /^(?:src|scripts|test|extensions|ui)\/.*\.test\.ts$/u;
const NON_ROUTINE_TEST_PATH_RE = /\.(?:e2e|live)\.test\.ts$/u;
const NODE_PATH_RE =
  /^(?:src\/|test\/|extensions\/|packages\/|scripts\/|ui\/|\.github\/|fased\.mjs$|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|tsconfig[^/]*\.json$|vitest[^/]*\.ts$|tsdown\.config\.ts$|\.oxlintrc\.json$|\.oxfmtrc\.jsonc$)/;
const KNOWN_NODE_SOURCE_PATH_RE =
  /^(?:src|test|extensions|packages|scripts|ui)\/.*\.(?:cjs|cts|css|html|js|jsx|json|mjs|mts|py|scss|sh|ts|tsx|ya?ml)$/u;
const KNOWN_NODE_ROOT_PATH_RE =
  /^(?:fased\.mjs|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig[^/]*\.json|vitest[^/]*\.ts|tsdown\.config\.ts|\.oxlintrc\.json|\.oxfmtrc\.jsonc)$/u;
// This lane runs a fixed, allowlisted test set. Keep the production allowlist
// exact: adding another updater/signer path must fall back to the full Node
// matrix until its nearest regression is explicitly added to `node-focused`.
const LOCAL_UPDATE_FOCUSED_PRODUCTION_PATHS = new Set([
  "package.json",
  "scripts/fased-host-updater.mjs",
  "scripts/fased-lifecycle-supervisor.mjs",
  "scripts/fased-managed-updater-core.mjs",
  "scripts/lifecycle-control-normalizer.mjs",
  "scripts/protected-local-bootstrap.mjs",
  "scripts/protected-local-service-plan.mjs",
  "scripts/protected-local-supervisor-client-root-fixture.mjs",
  "scripts/release-check.ts",
  "src/wallet/wallet-runtime-config.ts",
]);
const NODE_PACKAGING_PATH_RE =
  /^(?:package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|packages\/|extensions\/[^/]+\/package\.json$|scripts\/(?:build-hosted-runtime-artifact|hosted-release-manifest|managed-runtime-layout|release-artifact-set)[^/]*)/;
const NATIVE_SIGNER_PATH_RE =
  /^(?:tools\/fased-signerd\/|config\/signer-protocol-v2\.json$|scripts\/(?:build-fased-signerd|fased-signerd-build-identity|generate-signer-protocol-v2|release-fased-signerd|signer-protocol-v2\.generated|test-fased-signerd-portable-builds)[^/]*|src\/wallet\/signer-protocol-v2\.generated[^/]*)/;
const SIGNER_INTEGRATION_PATH_RE =
  /^(?:install\.sh$|scripts\/(?:fased-managed-updater|install-fased-signerd|install-managed-runtime|managed-runtime-layout|protected-local-)[^/]*|src\/wallet\/(?:native-signer-|providers\/local-socket-signer-adapter)[^/]*|src\/wizard\/onboarding\.wallet[^/]*)/;
const DARWIN_SIGNER_INTEGRATION_PATH_RE =
  /^(?:install\.sh$|scripts\/(?:install-platform-preflight|install-release-pin)[^/]*|src\/wallet\/providers\/local-socket-signer-adapter[^/]*|src\/wizard\/onboarding\.wallet[^/]*)/;
const PLATFORM_BOOTSTRAP_PATH_RE =
  /^(?:install\.sh$|scripts\/(?:install-platform-preflight|test-install-runtime-profile)[^/]*|scripts\/docker\/protected-local-systemd\/Containerfile\.[^/]+$)/;
const DOCKER_PRODUCT_PATH_RE =
  /^(?:\.dockerignore$|Dockerfile$|docker-compose\.yml$|docker-setup\.sh$|\.github\/actions\/setup-trivy-cache\/|\.github\/workflows\/docker-release\.yml$|scripts\/(?:docker-signer-|fased-signerd-build-identity|scan-docker-image)[^/]*|src\/(?:commands\/wallet\.docker-signer-doctor|docker-)[^/]*|tools\/fased-signerd\/)/;
const CODEQL_JAVASCRIPT_PATH_RE = /\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/u;
const CODEQL_GO_PATH_RE =
  /^(?:tools\/fased-signerd\/.*\.(?:go)$|tools\/fased-signerd\/go\.(?:mod|sum))$/u;
const CODEQL_PYTHON_PATH_RE = /\.py$/u;
const SIGNER_PATH_RE =
  /^(?:install\.sh$|tools\/fased-signerd\/|config\/signer-protocol-v2\.json$|scripts\/(?:fased-managed-updater|install-fased-signerd|install-managed-runtime|managed-runtime-layout|protected-local-|release-fased-signerd|test-fased-signerd-portable-builds|generate-signer-protocol-v2|signer-protocol-v2\.generated)[^/]*|src\/wallet\/(?:native-signer-|providers\/local-socket-signer-adapter|signer-protocol-v2\.generated)[^/]*|src\/wizard\/onboarding\.wallet[^/]*)/;
const UI_PATH_RE = /^ui\//;
const GATEWAY_NODE_PATH_RE = /^src\/gateway\//;
const EXTENSION_NODE_PATH_RE = /^extensions\//;
const MACOS_APP_PATH_RE = /^(?:apps\/(?:macos|shared)\/|Swabble\/|appcast\.xml$)/;
const EXPERIMENTAL_MOBILE_PATH_RE = /^apps\/(?:android|ios)\//;
const MACOS_RUNTIME_PATH_RE =
  /^(?:install\.sh$|scripts\/(?:codesign-mac-app|fased-managed-updater|install-managed-runtime|install-platform-preflight|install-release-pin|managed-runtime-layout|package-mac-app|restart-mac)[^/]*|src\/(?:cli\/daemon-cli\/install|commands\/(?:daemon-install-helpers|doctor-platform-notes)|daemon\/(?:launchd|runtime-paths)|infra\/(?:managed-runtime|update-runner)|macos\/)[^/]*)/;
const NATIVE_ONLY_PATH_RE = /^(?:apps\/(?:android|ios|macos|shared)\/|Swabble\/|appcast\.xml$)/;
const SHARED_LIFECYCLE_PATH_RE =
  /^(?:install\.sh$|scripts\/(?:build-hosted-runtime-artifact|fased-lifecycle-supervisor|hosted-release-manifest|install-(?:managed-runtime|platform-preflight|release-pin|runtime-profile)|lifecycle-(?!control-normalizer)|managed-runtime-layout|signer-(?:enrollment-launchers|owner-policy-installers)|start-managed)[^/]*|src\/(?:cli\/daemon-cli\/(?:install|restart-health)|commands\/(?:daemon-install-helpers|doctor-(?:gateway-health|state-integrity))|config\/io|daemon\/systemd|infra\/(?:managed-runtime|update-runner))[^/]*|\.github\/workflows\/hosted-runtime-release\.yml$)/;
const SHARED_UPDATE_PATH_RE =
  /^(?:scripts\/(?:fased-(?:host|managed)-updater|managed-updater-bundle)[^/]*|src\/infra\/update-runner[^/]*)/;
const LOCAL_LIFECYCLE_PATH_RE =
  /^(?:scripts\/(?:docker\/protected-local-systemd\/|lifecycle-control-normalizer|protected-local-|test-protected-local-systemd-container)[^/]*|src\/(?:commands\/onboard-non-interactive\/local|infra\/local-source-paired-update)[^/]*)/;
const LOCAL_FRESH_PATH_RE = /^(?:scripts\/(?:install-local-|test-install-runtime-profile)[^/]*)/;
const SHARED_FRESH_PATH_RE =
  /^(?:src\/(?:cli\/program\/register\.onboard|wizard\/onboarding)[^/]*)/;
const HOSTING_FRESH_PATH_RE =
  /^(?:scripts\/(?:docker\/streamed-hosting-bootstrap\/|hosting-|install-hosted-runtime|test-(?:hosted-runtime-install|streamed-hosting-bootstrap-container))[^/]*|src\/(?:commands\/hosted-dashboard-probe|wizard\/host-security-capability)[^/]*)/;
const HOSTING_UPDATE_PATH_RE =
  /^(?:scripts\/(?:docker\/hosting-systemd\/|fased-host-|fased-signer-(?:enroll|network|owner|policy)-hosting|hosted-(?!release-manifest)|migrate-hosted-signer|test-hosting-systemd-container)[^/]*|src\/infra\/host[^/]*)/;
const MINING_PATH_RE =
  /^(?:extensions\/sat-mining\/|src\/mining\/|src\/.*mining[^/]*|test\/ui-mining-api\.test\.ts$|ui\/src\/ui\/.*mining[^/]*|ui\/src\/ui\/(?:app-gateway|app-polling)\.ts$)/;
const SKILLS_PATH_RE = /^(?:skills\/|scripts\/.*skill[^/]*\.(?:py|mjs|ts)$)/;
const PACKAGE_PATH_RE =
  /^(?:package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|packages\/|extensions\/)/;
const STATE_MIGRATION_PATH_RE = /(?:^|\/)(?:migrat|transaction|rollback|state)[^/]*[/.]/;
const DOCKER_PATH_RE = /^(?:Dockerfile|docker\/|scripts\/docker\/|\.github\/workflows\/docker)/;
const PRIVILEGED_PATH_RE =
  /^(?:install\.sh$|tools\/fased-signerd\/|scripts\/(?:fased-(?:host-updater|lifecycle-supervisor|managed-updater)|install-(?:fased-signerd|managed-runtime)|lifecycle-|managed-runtime-layout|protected-local-(?:bootstrap|controller|layout|service-plan|supervisor)|signer-(?:enrollment-launchers|owner-policy-installers)|start-managed)[^/]*|src\/(?:daemon\/systemd|infra\/(?:managed-runtime|update-runner)|wallet\/native-signer-)[^/]*)/;

export function normalizeChangedPaths(paths) {
  return [...new Set(paths.map((value) => value.trim().replaceAll("\\", "/")).filter(Boolean))];
}

function stableValue(value) {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

function digestPlan(plan) {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(stableValue(plan)))
    .digest("hex")}`;
}

function assertOption(value, allowed, name) {
  if (value !== undefined && value !== null && !allowed.includes(value)) {
    throw new Error(`gate authority: invalid ${name} ${JSON.stringify(value)}`);
  }
}

function isNonProductionPath(path) {
  return (
    DOC_PATH_RE.test(path) ||
    CI_INFRASTRUCTURE_PATH_RE.test(path) ||
    T2_FIXTURE_PATH_RE.test(path) ||
    TEST_PATH_RE.test(path)
  );
}

function isKnownProductionPath(path) {
  return (
    KNOWN_NODE_SOURCE_PATH_RE.test(path) ||
    KNOWN_NODE_ROOT_PATH_RE.test(path) ||
    NATIVE_SIGNER_PATH_RE.test(path) ||
    NATIVE_ONLY_PATH_RE.test(path) ||
    SHARED_LIFECYCLE_PATH_RE.test(path) ||
    SHARED_UPDATE_PATH_RE.test(path) ||
    LOCAL_LIFECYCLE_PATH_RE.test(path) ||
    LOCAL_FRESH_PATH_RE.test(path) ||
    SHARED_FRESH_PATH_RE.test(path) ||
    HOSTING_FRESH_PATH_RE.test(path) ||
    HOSTING_UPDATE_PATH_RE.test(path) ||
    DOCKER_PRODUCT_PATH_RE.test(path) ||
    SKILLS_PATH_RE.test(path)
  );
}

function emptyScope(overrides = {}) {
  return {
    docsOnly: false,
    docsChanged: false,
    versionOnly: false,
    ciInfrastructureOnly: false,
    lifecycleGateEnforcementOnly: false,
    t2FixtureOnly: false,
    testOnly: false,
    fixtureOnly: false,
    productionChanged: false,
    privilegeChanged: false,
    reusePrChecks: false,
    runNode: false,
    runNodeFocused: false,
    runNodeBuild: false,
    runNodePackaging: false,
    runNodeFull: false,
    runNodeUnit: false,
    runNodeGateway: false,
    runNodeExtensions: false,
    runUi: false,
    runMacosRuntime: false,
    runMacosApp: false,
    experimentalMobileChanged: false,
    runSigner: false,
    runNativeSigner: false,
    runSignerIntegration: false,
    runSignerDarwinIntegration: false,
    runPlatformBootstrap: false,
    runDocker: false,
    runCodeqlJavascript: false,
    runCodeqlGo: false,
    runCodeqlPython: false,
    runHosting: false,
    runHostingFresh: false,
    runHostingUpdate: false,
    runLocalFresh: false,
    runLocalUpdate: false,
    runCiContracts: false,
    runT2Contracts: false,
    runUiMining: false,
    runSkills: false,
    fullMatrix: false,
    ...overrides,
  };
}

function acceptanceGates(scope) {
  return Object.freeze({
    L0: scope.runLocalFresh,
    L1: scope.runLocalUpdate,
    H0: scope.runHostingFresh || scope.runHostingUpdate,
    H1: scope.runHostingFresh,
    H2: scope.runHostingUpdate,
  });
}

function surfaceMap(scope, paths, productionPaths, all = false) {
  const production =
    scope.ciInfrastructureOnly || scope.lifecycleGateEnforcementOnly
      ? productionPaths
      : productionPaths.length > 0
        ? productionPaths
        : paths;
  const knownProduction =
    scope.runNode ||
    scope.runSigner ||
    scope.runHosting ||
    scope.runLocalFresh ||
    scope.runLocalUpdate ||
    scope.runMacosRuntime ||
    scope.runMacosApp ||
    scope.runUiMining ||
    scope.runSkills ||
    production.some((path) => DOCKER_PATH_RE.test(path));
  return Object.freeze({
    documentation: all || scope.docsChanged,
    sourceBuild: all || scope.runNode,
    packagePlugin:
      all || scope.versionOnly || production.some((path) => PACKAGE_PATH_RE.test(path)),
    localFresh: all || scope.runLocalFresh,
    localUpdate: all || scope.runLocalUpdate,
    stateMigration: all || production.some((path) => STATE_MIGRATION_PATH_RE.test(`${path}/`)),
    signerWallet: all || scope.runSigner,
    hostingFresh: all || scope.runHostingFresh,
    hostingUpdate: all || scope.runHostingUpdate,
    dockerArchitecture: all || production.some((path) => DOCKER_PATH_RE.test(path)),
    nativeApple: all || scope.runMacosRuntime || scope.runMacosApp,
    skills: all || scope.runSkills,
    mining: all || scope.runUiMining,
    otherProduct: all || (scope.productionChanged && !knownProduction),
  });
}

export function createGatePlan(inputPaths, options = {}) {
  const phase = options.phase ?? "T3";
  const entryPoint = options.entryPoint ?? null;
  assertOption(phase, PHASES, "phase");
  assertOption(entryPoint, ENTRY_POINTS, "entry point");

  const paths = normalizeChangedPaths(inputPaths);
  const fullMatrix = options.fullMatrix === true;
  const reusePrChecks = options.reusePrChecks === true;
  const unknown = options.unknown === true || paths.length === 0;

  if (reusePrChecks && !fullMatrix) {
    const scope = emptyScope({ reusePrChecks: true });
    const body = {
      authorityVersion: GATE_AUTHORITY_VERSION,
      phase: "merge-reuse",
      entryPoint,
      entryPoints: [],
      affectedEntryPoints: [],
      changeKind: "merge-reuse",
      paths,
      productionPaths: [],
      scope,
      surfaces: surfaceMap(scope, [], []),
      acceptance: acceptanceGates(scope),
      affectedAcceptance: acceptanceGates(scope),
      manualReviewRequired: false,
    };
    return Object.freeze({ ...body, planDigest: digestPlan(body) });
  }

  if (fullMatrix || unknown) {
    const scope = emptyScope({
      productionChanged: true,
      privilegeChanged: true,
      runNode: true,
      runNodeFocused: false,
      runNodeBuild: true,
      runNodePackaging: true,
      runNodeFull: true,
      runNodeUnit: false,
      runNodeGateway: false,
      runNodeExtensions: false,
      runUi: true,
      runMacosRuntime: true,
      runMacosApp: true,
      runSigner: true,
      runNativeSigner: true,
      runSignerIntegration: true,
      runSignerDarwinIntegration: true,
      runPlatformBootstrap: true,
      runDocker: false,
      runCodeqlJavascript: true,
      runCodeqlGo: true,
      runCodeqlPython: true,
      runHosting: true,
      runHostingFresh: true,
      runHostingUpdate: true,
      runLocalFresh: true,
      runLocalUpdate: true,
      runCiContracts: true,
      runT2Contracts: true,
      runUiMining: true,
      runSkills: true,
      fullMatrix: true,
    });
    const body = {
      authorityVersion: GATE_AUTHORITY_VERSION,
      phase,
      entryPoint,
      entryPoints: [...ENTRY_POINTS],
      affectedEntryPoints: [...ENTRY_POINTS],
      changeKind: "full-matrix",
      paths,
      productionPaths: paths,
      scope,
      surfaces: surfaceMap(scope, paths, paths, true),
      acceptance: acceptanceGates(scope),
      affectedAcceptance: acceptanceGates(scope),
      // A failed diff is handled automatically by the complete supported
      // matrix. It never falls through to a human approval escape hatch.
      manualReviewRequired: false,
    };
    return Object.freeze({ ...body, planDigest: digestPlan(body) });
  }

  const docsChanged = paths.some((path) => DOC_PATH_RE.test(path));
  const docsOnly = paths.every((path) => DOC_PATH_RE.test(path));
  const versionOnly =
    paths.includes("package.json") &&
    paths.includes("src/brand.ts") &&
    paths.every((path) => VERSION_PATH_RE.test(path));
  const lifecycleGateEnforcementOnly =
    !versionOnly &&
    LIFECYCLE_GATE_REQUIRED_PATHS.every((path) => paths.includes(path)) &&
    paths.every((path) => LIFECYCLE_GATE_ENFORCEMENT_PATH_RE.test(path));
  const ciInfrastructureOnly =
    !versionOnly &&
    paths.some((path) => CI_INFRASTRUCTURE_PATH_RE.test(path)) &&
    paths.every((path) => CI_INFRASTRUCTURE_PATH_RE.test(path) || DOC_PATH_RE.test(path));
  const ciInfrastructureChanged =
    lifecycleGateEnforcementOnly || paths.some((path) => CI_INFRASTRUCTURE_PATH_RE.test(path));
  const t2FixtureOnly = paths.every((path) => T2_FIXTURE_PATH_RE.test(path));
  const testOnly = paths.every((path) => TEST_PATH_RE.test(path) || T2_FIXTURE_PATH_RE.test(path));
  const fixtureOnly = paths.every((path) =>
    /^(?:fixtures\/|scripts\/(?:docker\/|test-|protected-local-t2-))/.test(path),
  );
  const productionPaths = versionOnly
    ? []
    : paths.filter(
        (path) =>
          !isNonProductionPath(path) &&
          !(lifecycleGateEnforcementOnly && LIFECYCLE_GATE_ENFORCEMENT_PATH_RE.test(path)),
      );
  const productionChanged = productionPaths.length > 0;
  const gateToolingOnly =
    !versionOnly &&
    !docsOnly &&
    !productionChanged &&
    paths.every(
      (path) =>
        CI_INFRASTRUCTURE_PATH_RE.test(path) ||
        (lifecycleGateEnforcementOnly && LIFECYCLE_GATE_ENFORCEMENT_PATH_RE.test(path)) ||
        T2_FIXTURE_PATH_RE.test(path) ||
        DOC_PATH_RE.test(path) ||
        TEST_PATH_RE.test(path) ||
        NON_PRODUCTION_TEST_PATH_RE.test(path),
    );
  const effectivePaths = productionChanged ? productionPaths : paths;
  const routableTestOnly =
    testOnly &&
    !t2FixtureOnly &&
    paths.every((path) => ROUTABLE_TEST_PATH_RE.test(path) && !NON_ROUTINE_TEST_PATH_RE.test(path));
  const unclassifiedProductionPaths = productionPaths.filter(
    (path) => !isKnownProductionPath(path),
  );

  if (testOnly && !t2FixtureOnly && !fixtureOnly && !routableTestOnly) {
    const unroutableTestPaths = paths.filter(
      (path) => !ROUTABLE_TEST_PATH_RE.test(path) || NON_ROUTINE_TEST_PATH_RE.test(path),
    );
    throw new Error(
      `gate authority: classification blocked: no automatic test lane for ${JSON.stringify(unroutableTestPaths)}`,
    );
  }

  if (unclassifiedProductionPaths.length > 0) {
    throw new Error(
      `gate authority: classification blocked: unclassified production paths ${JSON.stringify(unclassifiedProductionPaths)}`,
    );
  }

  let hasUnclassifiedNonNativeNonDocs = false;
  for (const path of effectivePaths) {
    if (
      !DOC_PATH_RE.test(path) &&
      !NATIVE_ONLY_PATH_RE.test(path) &&
      !NATIVE_SIGNER_PATH_RE.test(path) &&
      !CODEQL_PYTHON_PATH_RE.test(path)
    ) {
      hasUnclassifiedNonNativeNonDocs = true;
    }
  }

  let runNode =
    !versionOnly &&
    !ciInfrastructureOnly &&
    !t2FixtureOnly &&
    !fixtureOnly &&
    (productionChanged || routableTestOnly) &&
    effectivePaths.some(
      (path) =>
        (NODE_PATH_RE.test(path) &&
          !NATIVE_SIGNER_PATH_RE.test(path) &&
          !CODEQL_PYTHON_PATH_RE.test(path)) ||
        (routableTestOnly && ROUTABLE_TEST_PATH_RE.test(path)),
    );
  if (productionChanged && !runNode && hasUnclassifiedNonNativeNonDocs) {
    runNode = true;
  }

  const sharedLifecycleChanged = effectivePaths.some((path) => SHARED_LIFECYCLE_PATH_RE.test(path));
  const sharedUpdateChanged = effectivePaths.some((path) => SHARED_UPDATE_PATH_RE.test(path));
  const localLifecycleChanged = effectivePaths.some((path) => LOCAL_LIFECYCLE_PATH_RE.test(path));
  const localFreshChanged = effectivePaths.some((path) => LOCAL_FRESH_PATH_RE.test(path));
  const sharedFreshChanged = effectivePaths.some((path) => SHARED_FRESH_PATH_RE.test(path));
  const hostingFreshChanged = effectivePaths.some((path) => HOSTING_FRESH_PATH_RE.test(path));
  const hostingUpdateChanged = effectivePaths.some((path) => HOSTING_UPDATE_PATH_RE.test(path));

  let runLocalFresh =
    sharedLifecycleChanged || sharedFreshChanged || localLifecycleChanged || localFreshChanged;
  let runLocalUpdate = sharedLifecycleChanged || sharedUpdateChanged || localLifecycleChanged;
  let runHostingFresh = sharedLifecycleChanged || sharedFreshChanged || hostingFreshChanged;
  let runHostingUpdate = sharedLifecycleChanged || sharedUpdateChanged || hostingUpdateChanged;
  const lifecycleFixtureChanged = paths.some(
    (path) =>
      !CI_INFRASTRUCTURE_PATH_RE.test(path) &&
      !T2_FIXTURE_PATH_RE.test(path) &&
      (LOCAL_LIFECYCLE_PATH_RE.test(path) ||
        HOSTING_FRESH_PATH_RE.test(path) ||
        HOSTING_UPDATE_PATH_RE.test(path)),
  );

  if (
    (gateToolingOnly && !lifecycleFixtureChanged) ||
    t2FixtureOnly ||
    (testOnly && !fixtureOnly && !productionChanged)
  ) {
    runLocalFresh = false;
    runLocalUpdate = false;
    runHostingFresh = false;
    runHostingUpdate = false;
  }

  const affectedEntryPointFlags = Object.freeze({
    "local-fresh": runLocalFresh,
    "local-update": runLocalUpdate,
    "hosting-fresh": runHostingFresh,
    "hosting-update": runHostingUpdate,
  });
  const affectedEntryPoints = ENTRY_POINTS.filter((name) => affectedEntryPointFlags[name]);

  if (entryPoint) {
    if (!affectedEntryPointFlags[entryPoint]) {
      throw new Error(
        `gate authority: entry point ${JSON.stringify(entryPoint)} is not affected by the changed paths`,
      );
    }
    runLocalFresh = entryPoint === "local-fresh";
    runLocalUpdate = entryPoint === "local-update";
    runHostingFresh = entryPoint === "hosting-fresh";
    runHostingUpdate = entryPoint === "hosting-update";
  }

  const privilegeChanged = productionPaths.some((path) => PRIVILEGED_PATH_RE.test(path));
  const t2FixtureChanged = paths.some((path) => T2_FIXTURE_PATH_RE.test(path));
  const runT2Contracts = t2FixtureOnly || t2FixtureChanged || privilegeChanged;
  const runCiContracts = ciInfrastructureChanged;
  const runHosting = runHostingFresh || runHostingUpdate;
  const pureUiProduction =
    productionPaths.length > 0 && productionPaths.every((path) => UI_PATH_RE.test(path));
  const pureGatewayProduction =
    productionPaths.length > 0 && productionPaths.every((path) => GATEWAY_NODE_PATH_RE.test(path));
  const pureExtensionProduction =
    productionPaths.length > 0 &&
    productionPaths.every((path) => EXTENSION_NODE_PATH_RE.test(path));
  const focusedLocalUpdate =
    runNode &&
    entryPoint === "local-update" &&
    productionPaths.length > 0 &&
    productionPaths.every((path) => LOCAL_UPDATE_FOCUSED_PRODUCTION_PATHS.has(path));
  const runNodeFocused = focusedLocalUpdate;
  const runUi =
    !ciInfrastructureOnly &&
    !t2FixtureOnly &&
    (!testOnly || routableTestOnly) &&
    effectivePaths.some((path) => UI_PATH_RE.test(path));
  const uiReplacesNodeFull =
    pureUiProduction || (routableTestOnly && paths.every((path) => UI_PATH_RE.test(path)));
  const runNodeGateway =
    runNode &&
    !runNodeFocused &&
    ((routableTestOnly && paths.some((path) => GATEWAY_NODE_PATH_RE.test(path))) ||
      pureGatewayProduction);
  const runNodeExtensions =
    runNode &&
    !runNodeFocused &&
    ((routableTestOnly && paths.some((path) => EXTENSION_NODE_PATH_RE.test(path))) ||
      pureExtensionProduction);
  const runNodeUnit =
    runNode &&
    !runNodeFocused &&
    routableTestOnly &&
    paths.some(
      (path) =>
        !UI_PATH_RE.test(path) &&
        !GATEWAY_NODE_PATH_RE.test(path) &&
        !EXTENSION_NODE_PATH_RE.test(path),
    );
  const runNodeBuild =
    runNode &&
    !pureUiProduction &&
    (productionChanged || runHosting || runLocalFresh || runLocalUpdate);
  const runNodePackaging =
    runNode && productionPaths.some((path) => NODE_PACKAGING_PATH_RE.test(path));
  const runNodeFull =
    runNode &&
    !runNodeFocused &&
    !uiReplacesNodeFull &&
    !runNodeUnit &&
    !runNodeGateway &&
    !runNodeExtensions;
  const runMacosRuntime =
    productionChanged && effectivePaths.some((path) => MACOS_RUNTIME_PATH_RE.test(path));
  const runMacosApp =
    productionChanged && effectivePaths.some((path) => MACOS_APP_PATH_RE.test(path));
  const experimentalMobileChanged = paths.some((path) => EXPERIMENTAL_MOBILE_PATH_RE.test(path));
  const experimentalMobileOnly =
    productionPaths.length > 0 &&
    productionPaths.every((path) => EXPERIMENTAL_MOBILE_PATH_RE.test(path));
  const runNativeSigner =
    productionChanged && effectivePaths.some((path) => NATIVE_SIGNER_PATH_RE.test(path));
  const runSignerIntegration =
    productionChanged &&
    effectivePaths.some(
      (path) => SIGNER_INTEGRATION_PATH_RE.test(path) || NATIVE_SIGNER_PATH_RE.test(path),
    );
  const runSignerDarwinIntegration =
    runSignerIntegration &&
    effectivePaths.some((path) => DARWIN_SIGNER_INTEGRATION_PATH_RE.test(path));
  const runPlatformBootstrap =
    runLocalFresh && effectivePaths.some((path) => PLATFORM_BOOTSTRAP_PATH_RE.test(path));
  const runDocker =
    !ciInfrastructureOnly && effectivePaths.some((path) => DOCKER_PRODUCT_PATH_RE.test(path));
  const codeqlPaths = productionChanged ? productionPaths : [];
  const runCodeqlJavascript = codeqlPaths.some((path) => CODEQL_JAVASCRIPT_PATH_RE.test(path));
  const runCodeqlGo = codeqlPaths.some((path) => CODEQL_GO_PATH_RE.test(path));
  const runCodeqlPython = codeqlPaths.some((path) => CODEQL_PYTHON_PATH_RE.test(path));
  const selectedEntryPoints = [
    runLocalFresh && "local-fresh",
    runLocalUpdate && "local-update",
    runHostingFresh && "hosting-fresh",
    runHostingUpdate && "hosting-update",
  ].filter(Boolean);

  const scope = emptyScope({
    docsOnly,
    docsChanged,
    versionOnly,
    ciInfrastructureOnly,
    lifecycleGateEnforcementOnly,
    t2FixtureOnly,
    testOnly,
    fixtureOnly,
    productionChanged,
    privilegeChanged,
    runNode,
    runNodeFocused,
    runNodeBuild,
    runNodePackaging,
    runNodeFull,
    runNodeUnit,
    runNodeGateway,
    runNodeExtensions,
    runUi,
    runMacosRuntime,
    runMacosApp,
    experimentalMobileChanged,
    runSigner: productionChanged && effectivePaths.some((path) => SIGNER_PATH_RE.test(path)),
    runNativeSigner,
    runSignerIntegration,
    runSignerDarwinIntegration,
    runPlatformBootstrap,
    runDocker,
    runCodeqlJavascript,
    runCodeqlGo,
    runCodeqlPython,
    runHosting,
    runHostingFresh,
    runHostingUpdate,
    runLocalFresh,
    runLocalUpdate,
    runCiContracts,
    runT2Contracts,
    runUiMining:
      productionChanged &&
      !effectivePaths.some((path) => UI_PATH_RE.test(path)) &&
      effectivePaths.some((path) => MINING_PATH_RE.test(path)),
    runSkills: productionChanged && effectivePaths.some((path) => SKILLS_PATH_RE.test(path)),
    fullMatrix,
  });
  const affectedScope = {
    ...scope,
    runHosting:
      affectedEntryPointFlags["hosting-fresh"] || affectedEntryPointFlags["hosting-update"],
    runHostingFresh: affectedEntryPointFlags["hosting-fresh"],
    runHostingUpdate: affectedEntryPointFlags["hosting-update"],
    runLocalFresh: affectedEntryPointFlags["local-fresh"],
    runLocalUpdate: affectedEntryPointFlags["local-update"],
  };

  const changeKind = versionOnly
    ? "version-only"
    : docsOnly
      ? "documentation-only"
      : lifecycleGateEnforcementOnly
        ? "lifecycle-gate-enforcement-only"
        : ciInfrastructureOnly
          ? "ci-infrastructure-only"
          : t2FixtureOnly
            ? "t2-fixture-only"
            : fixtureOnly
              ? "fixture-only"
              : testOnly
                ? "test-only"
                : gateToolingOnly
                  ? "gate-tooling-only"
                  : experimentalMobileOnly
                    ? "experimental-mobile"
                    : productionChanged
                      ? "production"
                      : "unknown";
  const body = {
    authorityVersion: GATE_AUTHORITY_VERSION,
    phase,
    entryPoint,
    entryPoints: selectedEntryPoints,
    affectedEntryPoints,
    changeKind,
    paths,
    productionPaths,
    scope,
    surfaces: surfaceMap(affectedScope, paths, productionPaths),
    acceptance: acceptanceGates(scope),
    affectedAcceptance: acceptanceGates(affectedScope),
    // Kept for consumers of the v3 plan schema. Successful classification is
    // fully automatic; ambiguous paths fail above instead of requesting a
    // human-only escape hatch.
    manualReviewRequired: false,
  };
  return Object.freeze({ ...body, planDigest: digestPlan(body) });
}

export function classifyChangedPaths(paths, options = {}) {
  const plan = createGatePlan(paths, options);
  return Object.freeze({
    ...plan.scope,
    authorityVersion: plan.authorityVersion,
    phase: plan.phase,
    entryPoint: plan.entryPoint,
    entryPoints: plan.entryPoints,
    affectedEntryPoints: plan.affectedEntryPoints,
    changeKind: plan.changeKind,
    surfaces: plan.surfaces,
    acceptance: plan.acceptance,
    affectedAcceptance: plan.affectedAcceptance,
    manualReviewRequired: plan.manualReviewRequired,
    planDigest: plan.planDigest,
  });
}
