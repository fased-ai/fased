#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const DOC_PATH_RE = /^(?:docs\/|.*\.(?:md|mdx)$|scripts\/docs-product-contract\.mjs$)/;
const VERSION_PATH_RE =
  /^(?:package\.json|CHANGELOG\.md|src\/brand\.ts|extensions\/[^/]+\/(?:package\.json|CHANGELOG\.md))$/;
const CI_INFRASTRUCTURE_PATH_RE =
  /^(?:\.github\/workflows\/ci\.yml|scripts\/ci-(?:change-scope|required-gates|merged-main-reuse)(?:\.mjs|\.test\.ts)|scripts\/test-protected-local-systemd-container\.sh|scripts\/docker\/protected-local-systemd\/)/;
const NODE_PATH_RE =
  /^(?:src\/|test\/|extensions\/|packages\/|scripts\/|ui\/|\.github\/|fased\.mjs$|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|tsconfig[^/]*\.json$|vitest[^/]*\.ts$|tsdown\.config\.ts$|\.oxlintrc\.json$|\.oxfmtrc\.jsonc$)/;
const SIGNER_PATH_RE =
  /^(?:install\.sh$|tools\/fased-signerd\/|config\/signer-protocol-v2\.json$|scripts\/(?:fased-managed-updater|install-fased-signerd|install-managed-runtime|managed-runtime-layout|protected-local-|release-fased-signerd|test-fased-signerd-portable-builds|generate-signer-protocol-v2|signer-protocol-v2\.generated)[^/]*|src\/wallet\/(?:native-signer-|providers\/local-socket-signer-adapter|signer-protocol-v2\.generated)[^/]*|src\/wizard\/onboarding\.wallet[^/]*)/;
const MACOS_PATH_RE = /^(?:apps\/(?:macos|ios|shared)\/|Swabble\/)/;
const GENERATED_NATIVE_PROTOCOL_RE =
  /^(?:apps\/macos\/Sources\/FasedAgentProtocol\/|apps\/shared\/FasedAgentKit\/Sources\/FasedAgentProtocol\/)/;
const NATIVE_ONLY_PATH_RE = /^(?:apps\/(?:android|ios|macos|shared)\/|Swabble\/|appcast\.xml$)/;
const HOSTING_PATH_RE =
  /^(?:install\.sh$|scripts\/(?:docker\/(?:streamed-hosting-bootstrap|hosting-systemd|protected-local-systemd)\/|build-hosted-runtime-artifact|fased-host-|fased-managed-updater|fased-signer-(?:enroll|policy)-hosting|hosted-|hosting-|install-(?:hosted-runtime|managed-runtime|platform-preflight|release-pin|runtime-profile)|managed-runtime-layout|migrate-hosted-signer|protected-local-|signer-(?:enrollment-launchers|owner-policy-installers)|test-(?:hosted-runtime-install|hosting-systemd-container|install-runtime-profile|protected-local-systemd-container|streamed-hosting-bootstrap-container)|start-managed)[^/]*|src\/(?:cli\/daemon-cli\/(?:install|restart-health)|cli\/program\/register\.onboard|commands\/(?:daemon-install-helpers|doctor-(?:gateway-health|state-integrity)|hosted-dashboard-probe|onboard-non-interactive\/local)|config\/io|daemon\/systemd|infra\/(?:host|managed-runtime|update-runner|local-source-paired-update)|security\/(?:audit|fix)|wizard\/(?:host-security-capability|onboarding))[^/]*|\.github\/workflows\/hosted-runtime-release\.yml$)/;
const MINING_PATH_RE =
  /^(?:extensions\/sat-mining\/|src\/mining\/|src\/.*mining[^/]*|test\/ui-mining-api\.test\.ts$|ui\/src\/ui\/.*mining[^/]*|ui\/src\/ui\/(?:app-gateway|app-polling)\.ts$)/;
const SKILLS_PATH_RE = /^(?:skills\/|scripts\/.*skill[^/]*\.(?:py|mjs|ts)$)/;

function normalizePaths(paths) {
  return [...new Set(paths.map((path) => path.trim().replaceAll("\\", "/")).filter(Boolean))];
}

function trueString(value) {
  return value ? "true" : "false";
}

export function classifyChangedPaths(inputPaths, options = {}) {
  const paths = normalizePaths(inputPaths);
  const fullMatrix = options.fullMatrix === true;
  const reusePrChecks = options.reusePrChecks === true;
  const unknown = options.unknown === true || paths.length === 0;

  if (reusePrChecks && !fullMatrix) {
    return {
      docsOnly: false,
      docsChanged: false,
      versionOnly: false,
      ciInfrastructureOnly: false,
      reusePrChecks: true,
      runNode: false,
      runMacos: false,
      runSigner: false,
      runHosting: false,
      runUiMining: false,
      runSkills: false,
      fullMatrix: false,
    };
  }

  if (fullMatrix || unknown) {
    return {
      docsOnly: false,
      docsChanged: false,
      versionOnly: false,
      ciInfrastructureOnly: false,
      reusePrChecks: false,
      runNode: true,
      runMacos: true,
      runSigner: true,
      runHosting: true,
      runUiMining: true,
      runSkills: true,
      fullMatrix: true,
    };
  }

  const docsChanged = paths.some((path) => DOC_PATH_RE.test(path));
  const docsOnly = paths.every((path) => DOC_PATH_RE.test(path));
  const versionOnly =
    paths.includes("package.json") &&
    paths.includes("src/brand.ts") &&
    paths.every((path) => VERSION_PATH_RE.test(path));
  const ciInfrastructureOnly =
    !versionOnly && paths.every((path) => CI_INFRASTRUCTURE_PATH_RE.test(path));

  let runMacos = false;
  let hasNonNativeNonDocs = false;
  for (const path of paths) {
    if (MACOS_PATH_RE.test(path) && !GENERATED_NATIVE_PROTOCOL_RE.test(path)) {
      runMacos = true;
    }
    if (!DOC_PATH_RE.test(path) && !NATIVE_ONLY_PATH_RE.test(path)) {
      hasNonNativeNonDocs = true;
    }
  }

  let runNode =
    !versionOnly &&
    !docsOnly &&
    !ciInfrastructureOnly &&
    paths.some((path) => NODE_PATH_RE.test(path));
  if (!versionOnly && !runNode && !docsOnly && !ciInfrastructureOnly && hasNonNativeNonDocs) {
    runNode = true;
  }

  return {
    docsOnly,
    docsChanged,
    versionOnly,
    ciInfrastructureOnly,
    reusePrChecks: false,
    runNode,
    runMacos,
    runSigner: !versionOnly && paths.some((path) => SIGNER_PATH_RE.test(path)),
    runHosting:
      !versionOnly && (ciInfrastructureOnly || paths.some((path) => HOSTING_PATH_RE.test(path))),
    runUiMining: !versionOnly && paths.some((path) => MINING_PATH_RE.test(path)),
    runSkills: !versionOnly && paths.some((path) => SKILLS_PATH_RE.test(path)),
    fullMatrix,
  };
}

function outputEntries(scope) {
  return {
    docs_only: trueString(scope.docsOnly),
    docs_changed: trueString(scope.docsChanged),
    version_only: trueString(scope.versionOnly),
    ci_infrastructure_only: trueString(scope.ciInfrastructureOnly),
    reuse_pr_checks: trueString(scope.reusePrChecks),
    run_node: trueString(scope.runNode),
    run_macos: trueString(scope.runMacos),
    run_signer: trueString(scope.runSigner),
    run_hosting: trueString(scope.runHosting),
    run_ui_mining: trueString(scope.runUiMining),
    run_skills: trueString(scope.runSkills),
    full_matrix: trueString(scope.fullMatrix),
  };
}

function resolveDiffBase(env = process.env) {
  if (env.GITHUB_EVENT_NAME === "push") {
    const before = env.GITHUB_EVENT_BEFORE?.trim();
    if (before && !/^0+$/.test(before)) {
      return before;
    }
    return "HEAD^";
  }

  if (env.GITHUB_EVENT_NAME === "pull_request") {
    const baseRef = env.GITHUB_BASE_REF?.trim();
    if (baseRef) {
      try {
        return execFileSync("git", ["merge-base", `origin/${baseRef}`, "HEAD"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
      } catch {
        // Fall through to the event's immutable base SHA.
      }
    }
    const baseSha = env.GITHUB_BASE_SHA?.trim();
    if (baseSha) {
      return baseSha;
    }
  }

  return "HEAD^";
}

export function changedPathsFromGit(env = process.env) {
  const base = resolveDiffBase(env);
  const output = execFileSync("git", ["diff", "--name-only", base, "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return normalizePaths(output.split(/\r?\n/));
}

function main() {
  const fullMatrix = process.env.FULL_MATRIX === "true";
  const reusePrChecks = process.env.REUSE_PR_CHECKS === "true";
  let paths = [];
  let unknown = false;

  if (!fullMatrix && !reusePrChecks) {
    try {
      paths = changedPathsFromGit();
      unknown = paths.length === 0;
    } catch (error) {
      unknown = true;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`ci-change-scope: diff detection failed; enabling broad checks: ${message}`);
    }
  }

  const scope = classifyChangedPaths(paths, { fullMatrix, reusePrChecks, unknown });
  const entries = outputEntries(scope);
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    throw new Error("ci-change-scope: GITHUB_OUTPUT is required");
  }
  for (const [name, value] of Object.entries(entries)) {
    appendFileSync(outputPath, `${name}=${value}\n`);
  }

  console.log(
    JSON.stringify(
      {
        paths,
        ...entries,
      },
      null,
      2,
    ),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
