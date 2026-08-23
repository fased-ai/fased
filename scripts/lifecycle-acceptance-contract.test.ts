import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  REQUIRED_PREDICATES,
  buildAcceptanceReceipt,
  digestAcceptanceContract,
  digestPublishedAcceptanceContract,
  validateAcceptanceContract,
  validatePublishedAcceptanceContract,
  verifyAcceptanceReceipt,
} from "./lifecycle-acceptance-contract.mjs";

const contractPath = new URL("../config/lifecycle-acceptance.v2.json", import.meta.url);
const digest = `sha256:${"b".repeat(64)}`;

function contract() {
  return JSON.parse(readFileSync(contractPath, "utf8"));
}

function evidence(profile: string, scenario: string, version = "0.1.76-rc.70") {
  return REQUIRED_PREDICATES[profile][scenario].map((id) => ({
    id,
    status: "PASS",
    evidenceDigest: digest,
    summary: id.endsWith("-already-current") ? `Already current: ${version}` : "verified",
  }));
}

function acquisition(version = "0.1.76-rc.70", evidenceClass = "PASS") {
  const releaseBaseUrl = `https://github.com/fased-ai/fased/releases/download/v${version}`;
  return {
    mode: evidenceClass === "PASS" ? "immutable-github-release" : "substituted-fixture",
    releaseBaseUrl,
    metadataBaseUrl: releaseBaseUrl,
    transportSubstituted: evidenceClass !== "PASS",
    trustInventoryDigest: digest,
  };
}

describe("lifecycle acceptance contract", () => {
  it("validates the exact historical v1 public contract without weakening current v2", () => {
    const legacy = {
      schemaVersion: 1,
      role: "fased-lifecycle-acceptance-contract",
      contractId: "public-local-lifecycle-v1",
      scenarios: {
        "fresh-install": [
          "artifact-identity",
          "public-installer-acquisition",
          "canonical-lifecycle",
          "four-services-active",
          "wallet-status",
          "wallet-signer-doctor",
          "mining-status",
          "network-status",
          "plugin-doctor",
          "restart-health",
          "state-preservation",
          "already-current",
        ],
        "managed-update": [
          "artifact-identity",
          "public-installer-acquisition",
          "rollback-retry",
          "canonical-lifecycle",
          "four-services-active",
          "wallet-status",
          "wallet-signer-doctor",
          "mining-status",
          "network-status",
          "plugin-doctor",
          "restart-health",
          "state-preservation",
          "already-current",
        ],
      },
    };
    expect(validatePublishedAcceptanceContract(legacy)).toBe(legacy);
    expect(digestPublishedAcceptanceContract(legacy)).toBe(
      "sha256:b9ac4c751e0ad3e7455b177cd80538aedcbd8365aeac9eb7c174b72fea4c8ad8",
    );
    expect(() => validateAcceptanceContract(legacy)).toThrow("contract fields are invalid");
    expect(() =>
      validatePublishedAcceptanceContract({
        ...legacy,
        scenarios: {
          ...legacy.scenarios,
          "managed-update": legacy.scenarios["managed-update"].slice(0, -1),
        },
      }),
    ).toThrow("published v1 contract digest is invalid");
  });

  it("validates the exact historical v2 public contract without accepting mutations", () => {
    const { evidencePolicy: _evidencePolicy, ...currentV2 } = contract();
    const legacyV2 = {
      ...currentV2,
      profiles: Object.fromEntries(
        Object.entries(currentV2.profiles).map(([profile, scenarios]) => [
          profile,
          Object.fromEntries(
            Object.entries(scenarios).map(([scenario, predicates]) => [
              scenario,
              predicates.filter(
                (predicate) =>
                  ![
                    "lifecycle-performance",
                    "installer-noop-performance",
                    "updater-noop-performance",
                  ].includes(predicate),
              ),
            ]),
          ),
        ]),
      ),
    };
    expect(validatePublishedAcceptanceContract(legacyV2)).toBe(legacyV2);
    expect(digestPublishedAcceptanceContract(legacyV2)).toBe(
      "sha256:a1a15e2b080c25921339ed2aa38d05a9745213728866b9f19b48cedc79854197",
    );
    expect(() =>
      validatePublishedAcceptanceContract({
        ...legacyV2,
        profiles: {
          ...legacyV2.profiles,
          hosting: {
            ...legacyV2.profiles.hosting,
            "fresh-install": legacyV2.profiles.hosting["fresh-install"].slice(1),
          },
        },
      }),
    ).toThrow("published v2 contract digest is invalid");
  });

  it("validates only the exact evidence-policy v2 contract published by rc.80", () => {
    const current = contract();
    const rc80 = {
      ...current,
      evidencePolicy: {
        ...current.evidencePolicy,
        branch: { ...current.evidencePolicy.branch, evidenceClass: "PASS" },
      },
      profiles: Object.fromEntries(
        Object.entries(current.profiles).map(([profile, scenarios]) => [
          profile,
          Object.fromEntries(
            Object.entries(scenarios).map(([scenario, predicates]) => [
              scenario,
              predicates.filter(
                (predicate) =>
                  ![
                    "lifecycle-performance",
                    "installer-noop-performance",
                    "updater-noop-performance",
                  ].includes(predicate),
              ),
            ]),
          ),
        ]),
      ),
    };
    expect(validatePublishedAcceptanceContract(rc80)).toBe(rc80);
    expect(digestPublishedAcceptanceContract(rc80)).toBe(
      "sha256:8cf857831936399150ce4fef5339dc4371ba64bffc54509a768c5f45cc022a14",
    );
    expect(() => validateAcceptanceContract(rc80)).toThrow("evidence policy is invalid");
    expect(() =>
      validatePublishedAcceptanceContract({
        ...rc80,
        profiles: {
          ...rc80.profiles,
          hosting: {
            ...rc80.profiles.hosting,
            "fresh-install": rc80.profiles.hosting["fresh-install"].slice(1),
          },
        },
      }),
    ).toThrow("evidence policy is invalid");
  });

  it("defines identical evidence classes for Local and Hosting", () => {
    const value = contract();
    expect(validateAcceptanceContract(value)).toBe(value);
    expect(digestAcceptanceContract(value)).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(value.profiles["protected-local"]).toEqual(value.profiles.hosting);
  });

  it.each([
    ["protected-local", "fresh-install"],
    ["protected-local", "managed-update"],
    ["hosting", "fresh-install"],
    ["hosting", "managed-update"],
  ])("binds %s/%s evidence to exact bytes and capsule policy", (profile, scenario) => {
    const value = contract();
    const capsule = scenario === "managed-update" ? digest : null;
    const installationClass = scenario === "managed-update" ? "public-stable" : null;
    const installationClassDigest = scenario === "managed-update" ? digest : null;
    const receipt = buildAcceptanceReceipt({
      contract: value,
      profile,
      scenario,
      version: "0.1.76-rc.70",
      commit: "a".repeat(40),
      candidateDescriptorDigest: digest,
      predecessorCapsuleDigest: capsule,
      predecessorInstallationClass: installationClass,
      predecessorInstallationClassDigest: installationClassDigest,
      acquisition: acquisition(),
      evidence: evidence(profile, scenario),
    });
    expect(
      verifyAcceptanceReceipt({
        contract: value,
        receipt,
        expected: {
          profile,
          scenario,
          predecessorCapsuleDigest: capsule,
          predecessorInstallationClass: installationClass,
          predecessorInstallationClassDigest: installationClassDigest,
        },
      }),
    ).toBe(receipt);
  });

  it("rejects name-only, reordered, and nonliteral idempotence evidence", () => {
    const value = contract();
    const records = evidence("hosting", "fresh-install");
    expect(() =>
      buildAcceptanceReceipt({
        contract: value,
        profile: "hosting",
        scenario: "fresh-install",
        version: "0.1.76-rc.70",
        commit: "a".repeat(40),
        candidateDescriptorDigest: digest,
        acquisition: acquisition(),
        evidence: records.map(({ id }) => id),
      }),
    ).toThrow();
    expect(() =>
      buildAcceptanceReceipt({
        contract: value,
        profile: "hosting",
        scenario: "fresh-install",
        version: "0.1.76-rc.70",
        commit: "a".repeat(40),
        candidateDescriptorDigest: digest,
        acquisition: acquisition(),
        evidence: records.with(records.length - 1, {
          ...records.at(-1),
          summary: "current",
        }),
      }),
    ).toThrow("literal idempotence result");
  });

  it("never upgrades substituted fixture transport into enforcing evidence", () => {
    const value = contract();
    expect(() =>
      buildAcceptanceReceipt({
        contract: value,
        profile: "hosting",
        scenario: "fresh-install",
        version: "0.1.76-rc.70",
        commit: "a".repeat(40),
        candidateDescriptorDigest: digest,
        acquisition: acquisition("0.1.76-rc.70", "SUPPORTING"),
        evidence: evidence("hosting", "fresh-install"),
      }),
    ).toThrow("acquisition evidence");
    const supportingEvidence = evidence("hosting", "fresh-install").map((record) => ({
      ...record,
      status: "SUPPORTING",
    }));
    expect(
      buildAcceptanceReceipt({
        contract: value,
        profile: "hosting",
        scenario: "fresh-install",
        version: "0.1.76-rc.70",
        commit: "a".repeat(40),
        candidateDescriptorDigest: digest,
        evidenceClass: "SUPPORTING",
        acquisition: acquisition("0.1.76-rc.70", "SUPPORTING"),
        evidence: supportingEvidence,
      }).evidenceClass,
    ).toBe("SUPPORTING");
  });

  it("rejects substituted acquisition from claiming branch product PASS", () => {
    const value = contract();
    const branchEvidence = evidence("hosting", "fresh-install").map((record) =>
      record.id === "public-installer-acquisition" ? { ...record, status: "SUPPORTING" } : record,
    );
    expect(() =>
      buildAcceptanceReceipt({
        contract: value,
        profile: "hosting",
        scenario: "fresh-install",
        version: "0.1.76-rc.70",
        commit: "a".repeat(40),
        candidateDescriptorDigest: digest,
        evidenceClass: "PASS",
        acquisitionEvidenceClass: "SUPPORTING",
        acquisition: acquisition("0.1.76-rc.70", "SUPPORTING"),
        evidence: branchEvidence,
      }),
    ).toThrow("acquisition evidence is invalid for its evidence class");
  });

  it("binds reused product bytes separately from exact fixture source", () => {
    const value = contract();
    const productCommit = "a".repeat(40);
    const productTree = "b".repeat(40);
    const fixtureCommit = "c".repeat(40);
    const fixtureTree = "d".repeat(40);
    const receipt = buildAcceptanceReceipt({
      contract: value,
      profile: "protected-local",
      scenario: "fresh-install",
      version: "0.1.76-rc.70",
      commit: productCommit,
      productCommit,
      productTree,
      artifactSetDigest: digest,
      fixtureCommit,
      fixtureTree,
      candidateDescriptorDigest: digest,
      acquisition: acquisition(),
      evidence: evidence("protected-local", "fresh-install"),
    });
    expect(receipt).toMatchObject({
      commit: productCommit,
      productCommit,
      productTree,
      artifactSetDigest: digest,
      fixtureCommit,
      fixtureTree,
    });
    expect(() =>
      buildAcceptanceReceipt({
        contract: value,
        profile: "protected-local",
        scenario: "fresh-install",
        version: "0.1.76-rc.70",
        commit: productCommit,
        productCommit: fixtureCommit,
        productTree,
        artifactSetDigest: digest,
        fixtureCommit,
        fixtureTree,
        candidateDescriptorDigest: digest,
        acquisition: acquisition(),
        evidence: evidence("protected-local", "fresh-install"),
      }),
    ).toThrow("fixture receipt identity binding is invalid");
    expect(() =>
      verifyAcceptanceReceipt({
        contract: value,
        receipt,
        expected: { fixtureTree: "e".repeat(40) },
      }),
    ).toThrow("fixtureTree mismatch");
  });

  it("wires the v2 contract into the single release builder", () => {
    const builder = readFileSync(
      new URL("./build-linux-x64-release-artifact.sh", import.meta.url),
      "utf8",
    );
    const workflow = readFileSync(
      new URL("../.github/workflows/hosted-runtime-release.yml", import.meta.url),
      "utf8",
    );
    expect(builder).toContain("fased-lifecycle-acceptance-v2.json");
    expect(builder).toContain("release-artifact-set.mjs");
    expect(workflow).toContain("scripts/build-linux-x64-release-artifact.sh");
    expect(workflow).not.toContain("test-lifecycle-hosting-acceptance.sh");
  });

  it("keeps the optional fixture-image preparer Hosting-only", () => {
    const hostingWrapper = readFileSync(
      new URL("./test-lifecycle-hosting-acceptance.sh", import.meta.url),
      "utf8",
    );
    const prepare = readFileSync(
      new URL("./prepare-lifecycle-systemd-fixture-images.sh", import.meta.url),
      "utf8",
    );
    expect(hostingWrapper).not.toContain("run_container build");
    expect(hostingWrapper).toContain("fased_fixture_image_ref");
    expect(hostingWrapper).toContain("Fixture image is unavailable; prepare it explicitly");
    expect(prepare).toContain("run_container build");
    expect(prepare).toContain("io.fased.fixture.input-digest");
    expect(prepare).toContain("hosting-systemd");
    expect(prepare).not.toContain("protected-local-systemd");
  });

  it("waits up to 30 seconds for the substituted Hosting release server", () => {
    const hosting = readFileSync(
      new URL("./docker/hosting-systemd/lifecycle-acceptance.sh", import.meta.url),
      "utf8",
    );
    const readiness = hosting.slice(
      hosting.indexOf("start_release_transport_server() {"),
      hosting.indexOf("acceptance_mark() {"),
    );
    expect(readiness).toContain("local deadline=$((SECONDS + 30))");
    expect(readiness).toContain("while ((SECONDS < deadline)); do");
    expect(readiness).toContain("--connect-timeout 1 --max-time 1");
    expect(readiness).toContain('"$release_url" >/dev/null 2>&1');
    expect(readiness).toContain("return 0");
    expect(readiness).toContain("cat /tmp/fased-hosting-release-server.log >&2");
    expect(readiness).toContain(
      "Hosting fixture release server did not become ready within 30 seconds",
    );
    expect(readiness).not.toContain("for _ in {1..40}");
  });

  it("captures exact Hosting sshd diagnostics and verifies runtime prerequisites", () => {
    const hosting = readFileSync(
      new URL("./docker/hosting-systemd/lifecycle-acceptance.sh", import.meta.url),
      "utf8",
    );
    const diagnostics = hosting.slice(
      hosting.indexOf("diagnostics() {"),
      hosting.indexOf("trap diagnostics EXIT"),
    );
    const prerequisites = hosting.slice(
      hosting.indexOf("verify_sshd_runtime_prerequisites() {"),
      hosting.indexOf("install_hosting_package_fixtures() {"),
    );
    const providerAccess = hosting.slice(
      hosting.indexOf("prepare_provider_access_fixture() {"),
      hosting.indexOf("prepare_legacy_host_security_fixture() {"),
    );

    expect(diagnostics).toContain("/var/log/fased/hosting-security.log");
    expect(diagnostics).toContain(
      "/tmp/fased-hosting-{install,noop,update-failure,update,update-installer-noop,update-noop,reboot-noop}.{out,err}",
    );
    expect(diagnostics).toContain("Hosting sshd diagnostic (exit=%s)");
    expect(diagnostics).toContain("/tmp/fased-hosting-sshd-diagnostic.err");
    expect(diagnostics).toContain("stat -c '%U:%G:%a %n' /run/sshd /etc/ssh/ssh_host_*_key");
    expect(prerequisites).toContain(
      'test "$(stat -c \'%U:%G:%a\' /usr/sbin/sshd)" = "root:root:755"',
    );
    expect(prerequisites).toContain('test "$(stat -c \'%U:%G:%a\' /run/sshd)" = "root:root:755"');
    expect(prerequisites).toContain('test "$(stat -c \'%U:%G:%a\' "$host_key")" = "root:root:600"');
    expect(prerequisites).toContain("/usr/sbin/sshd -t");
    expect(prerequisites).toContain("Hosting fixture sshd preflight failed (exit=%s)");
    expect(providerAccess).toContain("systemctl is-active --quiet ssh.service");
    expect(providerAccess).toContain("verify_sshd_runtime_prerequisites");
  });

  it("waits for the real fail2ban control socket before seeding legacy Hosting state", () => {
    const hosting = readFileSync(
      new URL("./docker/hosting-systemd/lifecycle-acceptance.sh", import.meta.url),
      "utf8",
    );
    const readiness = hosting.slice(
      hosting.indexOf("wait_for_fail2ban_fixture() {"),
      hosting.indexOf("prepare_legacy_host_security_fixture() {"),
    );
    const legacyPreparation = hosting.slice(
      hosting.indexOf("prepare_legacy_host_security_fixture() {"),
      hosting.indexOf("install_release_transport_fixture() {"),
    );

    expect(readiness).toContain("local deadline=$((SECONDS + 30))");
    expect(readiness).toContain("while ((SECONDS < deadline)); do");
    expect(readiness).toContain("fail2ban-client status sshd 2>/dev/null");
    expect(readiness).toContain("sleep 0.1");
    expect(readiness).toContain("return 0");
    expect(readiness).toContain(
      "Hosting fixture fail2ban sshd jail did not become ready within 30 seconds",
    );
    expect(legacyPreparation).toContain("wait_for_fail2ban_fixture");
    expect(legacyPreparation).not.toContain(
      "fail2ban-client status sshd | grep -Fqi 'status for the jail: sshd'",
    );
  });

  it("binds actual onboarding child termination into fresh Hosting acceptance", () => {
    const hosting = readFileSync(
      new URL("./docker/hosting-systemd/lifecycle-acceptance.sh", import.meta.url),
      "utf8",
    );
    const evidence = hosting.slice(
      hosting.indexOf("record_canonical_lifecycle_evidence() {"),
      hosting.indexOf("assert_healthy() {"),
    );
    const freshInstall = hosting.slice(
      hosting.indexOf("  install)"),
      hosting.indexOf("  managed-update)"),
    );

    expect(evidence).toContain('.role == "fased-hosting-onboarding-termination"');
    expect(evidence).toContain(".actualChild == true");
    expect(evidence).toContain(".signal == 9");
    expect(evidence).toContain('.durablePhase == "ONBOARDING_PENDING"');
    expect(evidence).toContain('--arg manifestDigest "sha256:$(sha256sum "$manifest"');
    expect(evidence).toContain('--arg terminationDigest "sha256:$(sha256sum "$termination"');
    expect(evidence).toContain("manifestDigest:$manifestDigest");
    expect(evidence).toContain("evidenceDigest:$terminationDigest");
    expect(freshInstall).toContain(
      'canonical_lifecycle_evidence="$(record_canonical_lifecycle_evidence)"',
    );
    expect(freshInstall).toContain(
      'acceptance_mark canonical-lifecycle "$canonical_lifecycle_evidence"',
    );
    expect(freshInstall).toContain(
      "canonical Hosting lifecycle and actual onboarding child termination verified",
    );
  });

  it("starts from a real absent Ubuntu ACL package state and installs it transactionally", () => {
    const hosting = readFileSync(
      new URL("./docker/hosting-systemd/lifecycle-acceptance.sh", import.meta.url),
      "utf8",
    );
    const adapterStart = hosting.indexOf("cat >/usr/bin/apt-get <<'EOF_APT_FIXTURE'");
    const adapter = hosting.slice(adapterStart, hosting.indexOf("\nEOF_APT_FIXTURE", adapterStart));
    const aclRemoval = adapter.slice(
      adapter.indexOf('if [[ "$#" -eq 3 && "$1" == "remove"'),
      adapter.indexOf('if [[ "$#" -eq 6 && "$1" == "-o"'),
    );

    expect(adapter).toContain('"$3" == "acl"');
    expect(hosting).toContain("DEBIAN_FRONTEND=noninteractive apt-get remove -y acl");
    expect(hosting).toContain("test -x /usr/bin/dpkg-query");
    expect(hosting).toContain("'--showformat=${db:Status-Status}\\t${db:Status-Eflag}' acl");
    expect(hosting).toContain("$'not-installed\\tok'");
    expect(hosting).toContain("$'config-files\\tok'");
    expect(hosting).not.toContain("cat >/usr/bin/dpkg-query <<'EOF_DPKG_QUERY_FIXTURE'");
    expect(hosting).not.toContain("fased-fixture-dpkg-query-real");
    expect(aclRemoval).toContain("exec env DEBIAN_FRONTEND=noninteractive");
    expect(aclRemoval).toContain('/usr/local/libexec/fased-fixture-apt-get-real "$@"');
    expect(aclRemoval).not.toContain("rm -f -- /usr/bin/getfacl /usr/bin/setfacl");
    expect(adapter).toContain('"$#" -eq 4');
    expect(adapter).toContain('"$4" == "acl"');
    expect(adapter).toContain('"$7" == "acl"');
    expect(adapter).toContain("/usr/local/libexec/fased-fixture-apt-get-real");
    expect(adapter).toContain("DEBIAN_FRONTEND=noninteractive");
    expect(hosting).toContain("/var/lib/fased-hosting-fixture/apt-sourceparts");
    expect(hosting).toContain("/var/lib/fased-hosting-fixture/apt-sources.list");
    expect(adapter).toContain(
      "Dir::Etc::sourceparts=/var/lib/fased-hosting-fixture/apt-sourceparts",
    );
  });

  it("kills the actual onboarding child and retains container evidence as supporting", () => {
    const hosting = readFileSync(
      new URL("./docker/hosting-systemd/lifecycle-acceptance.sh", import.meta.url),
      "utf8",
    );
    const driver = readFileSync(
      new URL("./test-lifecycle-hosting-acceptance.sh", import.meta.url),
      "utf8",
    );
    expect(hosting).toContain("interrupt_actual_onboarding_child");
    expect(hosting).toContain("script -qefc /tmp/fased-hosting-interactive-installer");
    expect(hosting).toContain("/tmp/fased-hosting-interrupted-onboarding.out");
    expect(hosting).toContain("/home/app/\\.fased/bin/fased onboard --install-daemon");
    expect(hosting).toContain('kill -KILL "$onboarding_pid"');
    expect(hosting).toContain('.phase == "ONBOARDING_PENDING"');
    expect(hosting).not.toContain("seed_runtime_ready_predecessor_host_security");
    expect(hosting).toContain("acceptance_evidence_class=SUPPORTING");
    expect(driver).toContain("--memory 2g");
    expect(driver).toContain("--memory-swap 2g");
    expect(driver).toContain("--pids-limit 1024");
    expect(driver).toContain('environmentClass:"hosting-container"');
    expect(driver).toContain("/sys/fs/cgroup/memory.events");
    expect(driver).toContain("/sys/fs/cgroup/memory.peak");
    expect(driver).toContain("systemctl show --value -p MemoryPeak");
  });

  it("clears fixture-induced systemd rate limits before explicit restart proof", () => {
    const hosting = readFileSync(
      new URL("./docker/hosting-systemd/lifecycle-acceptance.sh", import.meta.url),
      "utf8",
    );
    const helper = hosting.slice(
      hosting.indexOf("restart_managed_services_after_fixture_churn() {"),
      hosting.indexOf("diagnostics() {"),
    );

    expect(helper.indexOf("systemctl reset-failed")).toBeGreaterThanOrEqual(0);
    expect(helper.indexOf("systemctl restart")).toBeGreaterThan(
      helper.indexOf("systemctl reset-failed"),
    );
    expect(helper).toContain(
      "fased-host-updater.service fased-signerd.service fased-gateway.service",
    );
    expect(hosting.match(/restart_managed_services_after_fixture_churn/gu)?.length).toBe(3);
    expect(hosting).not.toContain(
      "systemctl restart fased-host-updater.service fased-signerd.service fased-gateway.service",
    );
  });

  it("binds the Hosting Mining fixture scope before the first target start", () => {
    const hosting = readFileSync(
      new URL("./docker/hosting-systemd/lifecycle-acceptance.sh", import.meta.url),
      "utf8",
    );
    const fresh = hosting.slice(
      hosting.indexOf("  install)"),
      hosting.indexOf("  managed-update)"),
    );
    const managed = hosting.slice(
      hosting.indexOf("  managed-update)"),
      hosting.indexOf("  verify-reboot)"),
    );
    const helper = hosting.slice(
      hosting.indexOf("install_fixture_sat_runtime_environment() {"),
      hosting.indexOf("run_operator_acceptance() {"),
    );

    expect(helper).toContain("95-fixture-sat-runtime.conf");
    expect(helper.indexOf("install_fixture_sat_runtime_environment")).toBeLessThan(
      helper.indexOf("systemctl restart fased-gateway.service"),
    );
    expect(fresh.indexOf("install_fixture_sat_runtime_environment")).toBeLessThan(
      fresh.indexOf("run_public_installer"),
    );
    expect(managed.indexOf("install_fixture_sat_runtime_environment")).toBeLessThan(
      managed.indexOf("run_public_installer"),
    );
  });

  it("preserves installer transfer evidence through the Hosting curl adapter", () => {
    const hosting = readFileSync(
      new URL("./docker/hosting-systemd/lifecycle-acceptance.sh", import.meta.url),
      "utf8",
    );
    const adapterStart = hosting.indexOf("cat >/usr/bin/curl <<EOF_FIXTURE_CURL");
    const adapter = hosting.slice(
      adapterStart,
      hosting.indexOf("\nEOF_FIXTURE_CURL", adapterStart),
    );
    expect(adapter).toContain('write_out=""');
    expect(adapter).toContain("--write-out|-w)");
    expect(adapter).toContain('write_out="\\${args[\\$((index + 1))]:-}"');
    expect(adapter).toContain("'%{size_download} %{time_total}\\n'");
    expect(adapter).toContain('stat -c %s "/artifacts/\\$asset"');
    expect(adapter).toContain("printf '%s 0.000000\\n'");
    expect(adapter).toContain("Unsupported fixture curl --write-out template");
  });

  it("requires the optional Hosting diagnostic to resolve the public command", () => {
    const hosting = readFileSync(
      new URL("./docker/hosting-systemd/lifecycle-acceptance.sh", import.meta.url),
      "utf8",
    );
    expect(hosting).toContain('cd /tmp && test "$(command -v fased)" = /usr/local/bin/fased');
    expect(hosting).toContain("/bin/bash --login -c");
    expect(hosting).toContain("PATH=/usr/local/bin:/usr/bin:/bin");
    expect(hosting).toContain('fased status && exec fased update "$@"');
    expect(hosting).toContain("test -f /usr/local/bin/fased");
    expect(hosting).toContain("test ! -L /usr/local/bin/fased");
    expect(hosting).toContain(
      `test "$(stat -c '%U:%G:%a' /usr/local/bin/fased)" = "root:root:755"`,
    );
    expect(hosting).toContain("run_public_updater() {\n  assert_public_command_projection");
    expect(hosting.match(/assert_public_command_projection/gu)?.length).toBe(2);
    expect(hosting).not.toContain("/home/app/.fased/bin/fased update");
  });

  it("records bounded lifecycle performance evidence in the optional Hosting diagnostic", () => {
    const hosting = readFileSync(
      new URL("./docker/hosting-systemd/lifecycle-acceptance.sh", import.meta.url),
      "utf8",
    );
    for (const fixture of [hosting]) {
      expect(fixture).toContain("compact_performance_summary() {");
      expect(fixture).toContain(
        "transferred=[0-9]+B metadata-bytes=[0-9]+B artifact-bytes=[0-9]+B",
      );
      expect(fixture).toContain("record_noop_performance() {");
      expect(fixture).toContain('test "${#lines[@]}" -eq 1');
      expect(fixture).toContain("-e 's/^Lifecycle performance: /perf /'");
      expect(fixture).toContain("-e 's/metadata=/meta=/'");
      expect(fixture).toContain("-e 's/transaction=/tx=/'");
      expect(fixture).toContain("-e 's/transferred=/bytes=/'");
      expect(fixture).toContain("-e 's/cache-hits=/hits=/'");
      expect(fixture).toContain("-e 's/cache-misses=/misses=/'");
      expect(fixture).toContain('performance_summary="$(compact_performance_summary /tmp/');
      expect(fixture).toContain('test "${#performance_summary}" -le 240');
      expect(fixture).toMatch(
        /acceptance_mark lifecycle-performance \/tmp\/[a-z-]+\.out "\$performance_summary"/u,
      );
      expect(fixture).not.toContain("install timing, bytes, and cache evidence recorded");
      expect(fixture).not.toContain("update timing, bytes, and cache evidence recorded");
      expect(fixture).toContain("record_noop_performance installer-noop-performance /tmp/");
      expect(fixture).toContain("record_noop_performance updater-noop-performance /tmp/");
    }
    expect(hosting.match(/acceptance_mark lifecycle-performance/gu)?.length).toBe(2);
    for (const scenario of ["fresh-install", "managed-update"]) {
      expect(contract().profiles.hosting[scenario]).toContain("installer-noop-performance");
      expect(contract().profiles.hosting[scenario]).toContain("updater-noop-performance");
    }
  });

  it("fails closed when root T2 source identity is dirty or drifts", () => {
    const wrapper = readFileSync(
      new URL("./test-lifecycle-local-t2-systemd.sh", import.meta.url),
      "utf8",
    );
    const sourceCommit = wrapper.indexOf('source_commit="$(git -C "$repo_root" rev-parse HEAD)"');
    const sourceTree = wrapper.indexOf(
      'source_tree="$(git -C "$repo_root" rev-parse \'HEAD^{tree}\')"',
    );
    const preflight = wrapper.indexOf('ensure_clean_source_worktree "preflight"');
    const workerRoot = wrapper.indexOf('worker_root="$(mktemp -d');
    const receiptCheck = wrapper.indexOf('test -s "$receipt"');
    const postReceipt = wrapper.indexOf("ensure_source_identity_unchanged", receiptCheck);
    const receiptAssertions = wrapper.indexOf("jq -e --arg commit");

    expect(wrapper).toContain('git -C "$repo_root" status --porcelain=v1 --untracked-files=normal');
    expect(wrapper).toContain('source_commit="$(git -C "$repo_root" rev-parse HEAD)"');
    expect(wrapper).toContain('source_tree="$(git -C "$repo_root" rev-parse \'HEAD^{tree}\')"');
    expect(wrapper).toContain('current_commit="$(git -C "$repo_root" rev-parse HEAD)"');
    expect(wrapper).toContain('current_tree="$(git -C "$repo_root" rev-parse \'HEAD^{tree}\')"');
    expect(wrapper).toContain('"$current_commit" != "$source_commit"');
    expect(wrapper).toContain('"$current_tree" != "$source_tree"');
    expect(wrapper).toContain('ensure_clean_source_worktree "post-receipt verification"');
    expect(sourceCommit).toBeGreaterThan(-1);
    expect(sourceTree).toBeGreaterThan(sourceCommit);
    expect(preflight).toBeGreaterThan(sourceTree);
    expect(workerRoot).toBeGreaterThan(preflight);
    expect(postReceipt).toBeGreaterThan(receiptCheck);
    expect(postReceipt).toBeLessThan(receiptAssertions);
  });

  it("keeps release validation bound to the npm-free managed lifecycle contract", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { scripts?: Record<string, string> };
    expect(packageJson.scripts?.["release:validate-dist:contracts"]).not.toContain(
      "test:managed-updater",
    );
    expect(packageJson.scripts?.["test:managed-updater"]).toBeUndefined();
  });
});
