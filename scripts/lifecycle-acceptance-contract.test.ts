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
    expect(() => validateAcceptanceContract(rc80)).toThrow(
      "protected-local/fresh-install predicates are incomplete or reordered",
    );
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
    ).toThrow("protected-local/fresh-install predicates are incomplete or reordered");
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

  it("separates branch product PASS from substituted acquisition SUPPORTING", () => {
    const value = contract();
    const branchEvidence = evidence("hosting", "fresh-install").map((record) =>
      record.id === "public-installer-acquisition" ? { ...record, status: "SUPPORTING" } : record,
    );
    const receipt = buildAcceptanceReceipt({
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
    });
    expect(receipt.evidenceClass).toBe("PASS");
    expect(receipt.acquisitionEvidenceClass).toBe("SUPPORTING");
    expect(() =>
      verifyAcceptanceReceipt({
        contract: value,
        receipt,
        expected: { evidenceClass: "PASS", acquisitionEvidenceClass: "PASS" },
      }),
    ).toThrow("acquisitionEvidenceClass mismatch");
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

  it("wires the v2 contract and capsule verifier into candidate proof", () => {
    const wrapper = readFileSync(
      new URL("./test-lifecycle-local-acceptance.sh", import.meta.url),
      "utf8",
    );
    const driver = readFileSync(new URL("./run-lifecycle-local0.sh", import.meta.url), "utf8");
    const workflow = readFileSync(
      new URL("../.github/workflows/pre-tag-p1.yml", import.meta.url),
      "utf8",
    );
    expect(wrapper).toContain("fased-lifecycle-acceptance-v2.json");
    expect(wrapper).toContain("capsule_descriptor_attestation");
    expect(wrapper).toContain("capsule_archive_attestation");
    expect(wrapper).toContain("gh attestation verify");
    expect(workflow).toContain("test-lifecycle-local-acceptance.sh");
    expect(driver).toContain('local workflow="$ROOT_DIR/.github/workflows/pre-tag-p1.yml"');
    expect(driver).toContain("prepare-branch-predecessor-capsule.sh");
    expect(driver).toContain('current_phase="pre-tag-predecessor-capsule-contract"');
  });

  it("keeps fixture-image preparation outside normal aggregate LOCAL0", () => {
    const localWrapper = readFileSync(
      new URL("./test-lifecycle-local-acceptance.sh", import.meta.url),
      "utf8",
    );
    const hostingWrapper = readFileSync(
      new URL("./test-lifecycle-hosting-acceptance.sh", import.meta.url),
      "utf8",
    );
    const driver = readFileSync(new URL("./run-lifecycle-local0.sh", import.meta.url), "utf8");
    const prepare = readFileSync(
      new URL("./prepare-lifecycle-systemd-fixture-images.sh", import.meta.url),
      "utf8",
    );
    for (const wrapper of [localWrapper, hostingWrapper]) {
      expect(wrapper).not.toContain("run_container build");
      expect(wrapper).not.toContain('$RUNTIME" build');
      expect(wrapper).toContain("fased_fixture_image_ref");
      expect(wrapper).toContain("Fixture image is unavailable; prepare it explicitly");
    }
    expect(driver.match(/FASED_SYSTEMD_FIXTURE_PREPARE_IMAGES=0/gu)?.length).toBe(2);
    expect(driver).toContain("$CACHE_ROOT/images/local");
    expect(driver).toContain("$CACHE_ROOT/images/hosting");
    expect(driver).not.toContain("$CACHE_ROOT/images/$tree/local");
    expect(driver).not.toContain("$CACHE_ROOT/images/$tree/hosting");
    expect(prepare).toContain("run_container build");
    expect(prepare).toContain("io.fased.fixture.input-digest");
    expect(prepare).toContain("protected-local-systemd");
    expect(prepare).toContain("hosting-systemd");
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

  it("starts without ACL tools and models their transactional installation", () => {
    const hosting = readFileSync(
      new URL("./docker/hosting-systemd/lifecycle-acceptance.sh", import.meta.url),
      "utf8",
    );
    const adapterStart = hosting.indexOf("cat >/usr/bin/apt-get <<'EOF_APT_FIXTURE'");
    const adapter = hosting.slice(adapterStart, hosting.indexOf("\nEOF_APT_FIXTURE", adapterStart));

    expect(hosting).toContain("remove_acl_fixture_prerequisite() {");
    expect(adapter).toContain('"$3" == "acl"');
    expect(adapter).toContain("fased-fixture-apt-get-real remove -y acl");
    expect(adapter).toContain('"$7" == "acl"');
    expect(adapter).toContain("fased-fixture-apt-get-real install -y --no-install-recommends acl");
    expect(adapter).toContain("command -v getfacl >/dev/null");
    expect(adapter).toContain("command -v setfacl >/dev/null");
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

  it("requires managed update to execute the predecessor-installed updater", () => {
    const fixture = readFileSync(
      new URL("./docker/protected-local-systemd/lifecycle-acceptance.sh", import.meta.url),
      "utf8",
    );
    const managedUpdate = fixture.slice(fixture.indexOf('if [[ "$phase" == "managed-update" ]]'));
    expect(managedUpdate).toContain("run_installed_updater()");
    expect(managedUpdate).toContain('cd /tmp && test "$(command -v fased)" = /usr/local/bin/fased');
    expect(managedUpdate).toContain("/bin/bash --login -c");
    expect(managedUpdate).toContain('fased status && exec fased update "$@"');
    expect(managedUpdate.match(/run_installed_updater/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("requires Local and Hosting fixtures to resolve the public command outside the owner state", () => {
    const local = readFileSync(
      new URL("./docker/protected-local-systemd/lifecycle-acceptance.sh", import.meta.url),
      "utf8",
    );
    const hosting = readFileSync(
      new URL("./docker/hosting-systemd/lifecycle-acceptance.sh", import.meta.url),
      "utf8",
    );
    for (const fixture of [local, hosting]) {
      expect(fixture).toContain('cd /tmp && test "$(command -v fased)" = /usr/local/bin/fased');
      expect(fixture).toContain("/bin/bash --login -c");
      expect(fixture).toContain("PATH=/usr/local/bin:/usr/bin:/bin");
      expect(fixture).toContain('fased status && exec fased update "$@"');
      expect(fixture).toContain("test -f /usr/local/bin/fased");
      expect(fixture).toContain("test ! -L /usr/local/bin/fased");
      expect(fixture).toContain(
        `test "$(stat -c '%U:%G:%a' /usr/local/bin/fased)" = "root:root:755"`,
      );
    }
    expect(local).toContain("run_installed_updater() {\n    assert_public_command_projection");
    expect(local.match(/assert_public_command_projection/gu)?.length).toBe(3);
    expect(hosting).toContain("run_public_updater() {\n  assert_public_command_projection");
    expect(hosting.match(/assert_public_command_projection/gu)?.length).toBe(2);
    expect(local).not.toContain('"$state/bin/fased" update');
    expect(hosting).not.toContain("/home/app/.fased/bin/fased update");
  });

  it("binds the Local SAT fixture identity before the first Gateway start", () => {
    const local = readFileSync(
      new URL("./docker/protected-local-systemd/lifecycle-acceptance.sh", import.meta.url),
      "utf8",
    );
    const environmentInstall = local.indexOf("install_fixture_sat_runtime_environment\n");
    const publicInstall = local.indexOf('runuser -u testop -- env "${fresh_env[@]}"');
    const helperStart = local.indexOf("install_fixture_sat_runtime_environment() {");
    const helper = local.slice(helperStart, local.indexOf("\n}\n", helperStart));

    expect(environmentInstall).toBeGreaterThan(helperStart);
    expect(publicInstall).toBeGreaterThan(environmentInstall);
    expect(helper).toContain("[Manager]");
    expect(helper).toContain("DefaultEnvironment=FASED_SAT_PROGRAM_ID="); // pragma: allowlist secret
    expect(helper).toContain("DefaultEnvironment=FASED_SAT_MINT_ADDRESS="); // pragma: allowlist secret
    expect(helper).not.toContain("systemctl restart");
    expect(local).not.toContain("95-fixture-sat-runtime.conf");
  });

  it("records exact bounded lifecycle performance evidence in Local and Hosting receipts", () => {
    const local = readFileSync(
      new URL("./docker/protected-local-systemd/lifecycle-acceptance.sh", import.meta.url),
      "utf8",
    );
    const hosting = readFileSync(
      new URL("./docker/hosting-systemd/lifecycle-acceptance.sh", import.meta.url),
      "utf8",
    );
    for (const fixture of [local, hosting]) {
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
    expect(local.match(/acceptance_mark lifecycle-performance/gu)?.length).toBe(3);
    expect(hosting.match(/acceptance_mark lifecycle-performance/gu)?.length).toBe(2);
    expect(local).toContain("chmod 0775 /opt/fased/lifecycle");
    expect(local).toContain("installer reused a bootstrap through writable ancestry");
    expect(local).toContain("existing bootstrap projection is unsafe");
    expect(local).toContain("chmod 0755 /opt/fased/lifecycle");
    for (const profile of ["protected-local", "hosting"]) {
      for (const scenario of ["fresh-install", "managed-update"]) {
        expect(contract().profiles[profile][scenario]).toContain("installer-noop-performance");
        expect(contract().profiles[profile][scenario]).toContain("updater-noop-performance");
      }
    }
  });

  it("records per-process Local runtime RSS rather than whole-container memory", () => {
    const local = readFileSync(
      new URL("./docker/protected-local-systemd/lifecycle-acceptance.sh", import.meta.url),
      "utf8",
    );
    const runner = readFileSync(
      new URL("./test-lifecycle-local-acceptance.sh", import.meta.url),
      "utf8",
    );
    expect(local).toContain("record_runtime_process_evidence() {");
    expect(local).toContain('systemctl show --property MainPID --value "fased-local-controller-');
    expect(local).toContain('systemctl show --property MainPID --value "fased-signerd-');
    expect(local).toContain('systemctl show --property MainPID --value "fased-gateway-');
    expect(local).toContain('record_runtime_process_evidence "$instance"');
    expect(runner).toContain('runtime_receipt="$receipt.runtime-processes.json"');
    expect(runner).toContain("all(.pid > 1 and .rssBytes > 0)");
  });

  it("proves a distinct managed-plugin install, digest-changing update, and no-op in protected Local", () => {
    const local = readFileSync(
      new URL("./docker/protected-local-systemd/lifecycle-acceptance.sh", import.meta.url),
      "utf8",
    );
    expect(local).toContain("run_managed_plugin_transaction_acceptance() {");
    expect(local).toContain("/usr/local/bin/fased plugins install");
    expect(local).toContain('--catalog "$v1_catalog" --catalog-digest "$v1_catalog_digest"');
    expect(local).toContain("local plugin_id=fixture-transaction-plugin");
    expect(local).toContain('jq -cjn --arg id "$plugin_id"');
    expect(local).toContain('local v1_root="$input_root/v1" v2_root="$input_root/v2"');
    expect(local).toContain("managed_plugin_tree_digest()");
    expect(local).toContain('plugins install --catalog "$v1_catalog"');
    expect(local).toContain('plugins update --catalog "$v2_catalog"');
    expect(local).toContain('test "$v1_digest" != "$v2_digest"');
    expect(local).toContain('test "$v1_candidate_lock" != "$v2_candidate_lock"');
    expect(local).toContain(
      "local v2_ready_marker=/var/lib/fased-protected-local-fixture/managed-plugin-v2-ready",
    );
    expect(local).toContain('const fixtureManagedPluginVersion = "v2";');
    expect(local).not.toContain('if (!existsSync("%s"))');
    expect(local).toContain(
      'local v2_fault_dropin_dir="/etc/systemd/system/fased-gateway-$instance.service.d"',
    );
    expect(local).toContain("ExecStartPre=$v2_fault_script");
    expect(local).toContain(".digest == \\$digest)");
    expect(local).toContain("systemctl daemon-reload");
    expect(local).toContain('rm -f "$v2_fault_dropin"');
    expect(local).toContain("fixture v2 activation failure was accepted");
    expect(local).toContain('systemctl is-active --quiet "fased-gateway-$instance.service"');
    expect(local).toContain('install -m 0444 /dev/null "$v2_ready_marker"');
    expect(local).toContain("rollbackRetry:true");
    expect(local).toContain("failedOutputDigest:$failedOutputDigest");
    const failedUpdate =
      'plugins update --catalog "$v2_catalog" --catalog-digest "$v2_catalog_digest" --archive "$plugin_id=$v2_archive" >/tmp/fased-managed-plugin-update-v2-failed.out';
    const successfulUpdate =
      'plugins update --catalog "$v2_catalog" --catalog-digest "$v2_catalog_digest" --archive "$plugin_id=$v2_archive" >/tmp/fased-managed-plugin-update-v2.out';
    expect(local).toContain(failedUpdate);
    expect(local).toContain(successfulUpdate);
    expect(local.indexOf('install -m 0444 /dev/null "$v2_ready_marker"')).toBeLessThan(
      local.indexOf('update_started_ms="$(date +%s%3N)"'),
    );
    expect(local).toContain("Managed plugins: status=INSTALLED");
    expect(local).toContain("Managed plugins: status=ALREADY_CURRENT");
    expect(local).toContain('role:"fased-managed-plugin-transaction-acceptance"');
    expect(local).toContain('test "$install_duration_ms" -le 60000');
    expect(local).toContain('test "$update_duration_ms" -le 60000');
    expect(local).toContain('test "$noop_duration_ms" -le 5000');
    expect(local).toContain("run_managed_plugin_transaction_acceptance");
    expect(local).toContain(
      'run_managed_plugin_transaction_acceptance "$stable_bridge_plugin_object"',
    );
    expect(local).not.toContain("fased plugins install npm:");
    const wrapper = readFileSync(
      new URL("./test-lifecycle-local-acceptance.sh", import.meta.url),
      "utf8",
    );
    expect(wrapper).toContain('plugin_receipt="$receipt.plugins"');
    expect(wrapper).toContain('FIXTURE_SOURCE_TREE="$(git -C "$ROOT_DIR" rev-parse');
    expect(wrapper).toContain('-e "FASED_FIXTURE_PRODUCT_COMMIT=$COMMIT"');
    expect(wrapper).toContain('-e "FASED_FIXTURE_SOURCE_COMMIT=$FIXTURE_SOURCE_COMMIT"');
    expect(wrapper).toContain('--artifact-set-digest "$ARTIFACT_SET_DIGEST"');
    expect(wrapper).toContain(".fixtureCommit == $fixture_commit");
    expect(wrapper).toContain(".fixtureTree == $fixture_tree");
    expect(wrapper).toContain(".performance.installBudgetMs == 60000");
    expect(wrapper).toContain(".performance.noopBudgetMs == 5000");
    expect(wrapper).toContain("managed plugin transaction receipt verified");
    expect(wrapper).toContain(
      'if [[ "$MANAGED_PREDECESSOR_CLASS" == "public-stable" ]]; then\n' +
        '      plugin_receipt="$receipt.plugins"',
    );
    expect(wrapper).toContain(
      "printf 'managed plugin transaction receipt verified: %s\\n' \"$plugin_receipt\"\n" +
        "    fi\n" +
        '    if ! run_container exec "$name" /bin/bash',
    );
  });

  it("restores the protected Local system command ancestry after Node extraction", () => {
    for (const containerfile of [
      "./docker/protected-local-systemd/Containerfile.ubuntu",
      "./docker/protected-local-systemd/Containerfile.rocky",
    ]) {
      const source = readFileSync(new URL(containerfile, import.meta.url), "utf8");
      const extraction = source.indexOf("tar -xJ --strip-components=1 -C /usr/local");
      const ownership = source.indexOf("chown root:root /usr/local/bin /usr/local/bin/node");
      const mode = source.indexOf("chmod 0755 /usr/local/bin");
      expect(extraction).toBeGreaterThanOrEqual(0);
      expect(ownership).toBeGreaterThan(extraction);
      expect(mode).toBeGreaterThan(ownership);
    }
  });

  it("proves repair and uninstall after reboot without escaping fixture trust", () => {
    const fixture = readFileSync(
      new URL("./docker/protected-local-systemd/lifecycle-acceptance.sh", import.meta.url),
      "utf8",
    );
    const wrapper = readFileSync(
      new URL("./test-lifecycle-local-acceptance.sh", import.meta.url),
      "utf8",
    );
    const operations = fixture.slice(
      fixture.indexOf('if [[ "$phase" == "verify-operations" ]]'),
      fixture.indexOf(
        '[[ "$phase" == "fresh-install"',
        fixture.indexOf('if [[ "$phase" == "verify-operations" ]]'),
      ),
    );
    const verifyReboot = fixture.slice(
      fixture.indexOf('if [[ "$phase" == "verify-reboot" ]]'),
      fixture.indexOf('if [[ "$phase" == "verify-operations" ]]'),
    );
    expect(operations).toContain('grep -Fqx "127.0.0.1 github.com" /etc/hosts');
    expect(operations).toContain('exec fased repair "$@"');
    expect(operations).toContain('exec fased uninstall "$@"');
    expect(operations).toContain('cd /tmp && test "$(command -v fased)" = /usr/local/bin/fased');
    expect(operations).toContain("test ! -e /usr/local/bin/fased");
    expect(operations).toContain('predecessor_class="$(jq -er .predecessorClass "$snapshot")"');
    expect(verifyReboot).not.toContain(".predecessorClass");
    expect(fixture.match(/predecessorClass: \$predecessorClass/g)?.length).toBe(2);
    expect(operations).toContain('case "$predecessor_class" in');
    expect(operations).toContain("public-stable)");
    expect(operations).toContain('"$state/extensions/stable-bridge/fased.plugin.json"');
    expect(operations).toContain('"$state/plugin-data/stable-bridge/state.json"');
    expect(operations).toContain('"$state/sat-mining/stable-bridge-history.json"');
    expect(operations).toContain('"$state/workspace/stable-bridge.txt"');
    expect(operations).toContain("canonical-managed)");
    expect(operations).toContain('"$state/sat-mining/wallets/agent/mining.sqlite"');
    expect(operations).toContain('"$state/plugin-data/fixture/state.json"');
    expect(operations).toContain("predecessorClass:$predecessorClass");
    expect(operations).toContain('sha256sum --check "$owner_preservation"');
    expect(operations).toContain('sha256sum --check "$signer_preservation"');
    expect(wrapper).toContain(
      "/usr/local/bin/fased-protected-local-systemd-fixture verify-operations",
    );
    expect(wrapper).toContain('--arg predecessor_class "$MANAGED_PREDECESSOR_CLASS"');
    expect(wrapper).toContain(".predecessorClass == $predecessor_class");
    expect(wrapper).toContain('operations_receipt="$receipt.operations"');
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
