import fs from "node:fs";
import { describe, expect, it } from "vitest";

const launcher = fs.readFileSync(
  new URL("./fased-signer-owner-hosting.sh", import.meta.url),
  "utf8",
);
const targetAdapter = fs.readFileSync(
  new URL("../tools/fased-lifecycled/platform/target_adapter.go", import.meta.url),
  "utf8",
);
const wrapper = fs.readFileSync(
  new URL("../tools/fased-lifecycled/platform/signer_owner.go", import.meta.url),
  "utf8",
);

describe("Hosting signer-owner maintenance launcher", () => {
  it("ships as an executable generation entrypoint", () => {
    const mode = fs.statSync(new URL("./fased-signer-owner-hosting.sh", import.meta.url)).mode;
    expect(mode & 0o111).not.toBe(0);
  });

  it("keeps custody-changing commands behind one bounded signer-owner ceremony", () => {
    expect(launcher).toContain('if [[ "${EUID}" != "0" ]]');
    expect(launcher).toContain(
      'CONTROL_SOCKET="${FASED_SIGNER_CONTROL_SOCKET:-/run/fased-signerd/control.sock}"',
    );
    expect(launcher).toContain('"$RUNUSER_BIN" -u "$SIGNER_USER"');
    expect(launcher).toContain("--control-socket");
    expect(launcher).toContain("recovery-export|recovery-import|export-raw");
    expect(launcher).toContain("rotate-successor|rotation-status|rotation-commit");
    expect(launcher).toContain("get|put");
    expect(launcher).toContain("put (requires --confirm-digest sha256:<exact-policy-file-digest>)");
    expect(launcher).toContain('actual_policy_digest="sha256:$actual_policy_digest"');
    expect(launcher).toContain('staged_policy="$work_dir/policy.json"');
    expect(launcher).toContain('"$SIGNER_BIN" admin "$ADMIN_DOMAIN" "$command_name"');
    expect(launcher).toContain('[[ ! -e "$UPDATE_GATE" && ! -e "$UPDATE_JOURNAL" ]]');
    expect(launcher).toContain(
      "--control-socket|--control-socket=*|--operator-socket|--operator-socket=*",
    );
    expect(launcher).not.toMatch(/\beval\b/u);
    expect(launcher).not.toMatch(/sudoers/u);
  });

  it("keeps Hosting enrollment private, rollback-safe, and serialized with lifecycle mutation", () => {
    expect(launcher).toContain(
      'HOSTING_MUTATION_LOCK="${FASED_HOSTING_MUTATION_LOCK:-/run/lock/fased-bootstrap-hosting.lock}"',
    );
    expect(launcher).toContain('"$TAILSCALE_BIN" serve get-config --all');
    expect(launcher).toContain(
      'hosting_work_dir="$(mktemp -d /run/fased-signer-enrollment.XXXXXX)"',
    );
    expect(launcher).toContain('serve_snapshot="$hosting_work_dir/tailscale-serve.json"');
    expect(launcher).not.toContain('serve_snapshot="$work_dir/tailscale-serve.json"');
    expect(launcher).toContain("select(.AllowFunnel == true)");
    expect(launcher).toContain('"$TAILSCALE_BIN" serve set-config "$serve_snapshot" --all');
    expect(launcher).toContain('"$TAILSCALE_BIN" serve reset');
    expect(launcher).toContain("run_hosting_enrollment");
  });

  it("is activated only by the verified Go lifecycle transaction", () => {
    expect(targetAdapter).toContain("runtime/scripts/fased-signer-owner-hosting.sh");
    expect(targetAdapter).toContain("CanonicalSignerOwnerFiles(adapter.Config)");
    expect(wrapper).toContain("export FASED_SIGNER_OWNER_LOCAL=%q");
    expect(wrapper).toContain('exec %q "$@"');
  });
});
