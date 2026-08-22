package hostsecurity

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type fixtureRunner struct {
	outputs   map[string][]byte
	errors    map[string]error
	sequences map[string][]fixtureOutput
	calls     []string
}

type fixtureOutput struct {
	data []byte
	err  error
}

func commandKey(command string, args []string) string {
	return strings.Join(append([]string{command}, args...), " ")
}

func (runner *fixtureRunner) Run(_ context.Context, command string, args []string, _ io.Reader, stdout, _ io.Writer, _ []string) error {
	key := commandKey(command, args)
	runner.calls = append(runner.calls, key)
	if data := runner.outputs[key]; len(data) > 0 && stdout != nil {
		_, _ = stdout.Write(data)
	}
	return runner.errors[key]
}

func (runner *fixtureRunner) Output(ctx context.Context, command string, args ...string) ([]byte, error) {
	key := commandKey(command, args)
	runner.calls = append(runner.calls, key)
	if sequence := runner.sequences[key]; len(sequence) > 0 {
		result := sequence[0]
		runner.sequences[key] = sequence[1:]
		return result.data, result.err
	}
	return runner.outputs[key], runner.errors[key]
}

func linuxHostFixture(t *testing.T) (LinuxHost, *fixtureRunner, string) {
	t.Helper()
	root := t.TempDir()
	for _, directory := range []string{"usr/bin", "etc", "etc/ssh/sshd_config.d", "proc", "var/lib/fased-host-security"} {
		if err := os.MkdirAll(filepath.Join(root, directory), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Chmod(filepath.Join(root, "var/lib/fased-host-security"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "usr/bin/tailscale"), []byte("fixture"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"getfacl", "setfacl"} {
		if err := os.WriteFile(filepath.Join(root, "usr/bin", name), []byte("fixture"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "etc/os-release"), []byte("ID=ubuntu\nVERSION_ID=24.04\nVERSION_CODENAME=noble\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "etc/fstab"), []byte("# fixture fstab\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "proc/meminfo"), []byte("MemTotal:       8388608 kB\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "proc/swaps"), []byte("Filename\tType\tSize\tUsed\tPriority\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "etc/ssh/sshd_config.d/01-fased-hardening.conf"), []byte(sshHardeningConfig), 0o644); err != nil {
		t.Fatal(err)
	}
	runner := &fixtureRunner{outputs: map[string][]byte{}, errors: map[string]error{}, sequences: map[string][]fixtureOutput{}}
	host := LinuxHost{Runner: runner, HTTPClient: NewLinuxHost().HTTPClient, RootPrefix: root}
	return host, runner, root
}

func TestLowMemoryHostingStagesManagedSwapAndRollsBackExactly(t *testing.T) {
	host, runner, root := linuxHostFixture(t)
	if err := os.WriteFile(filepath.Join(root, "proc/meminfo"), []byte("MemTotal:       1572864 kB\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"nftables", "fail2ban", "unattended-upgrades", "acl"} {
		runner.outputs["/usr/bin/dpkg-query --show --showformat=${db:Status-Status}\t${db:Status-Eflag} "+name] = []byte("installed\tok")
	}
	encoded, err := host.SnapshotHardening(context.Background(), "app", io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := decodeHardeningSnapshot(encoded)
	if err != nil || !snapshot.Swap.Required {
		t.Fatalf("low-memory snapshot did not require managed swap: snapshot=%+v err=%v", snapshot.Swap, err)
	}
	if err := host.StageLifecyclePrerequisites(context.Background(), encoded, io.Discard); err != nil {
		t.Fatal(err)
	}
	if err := host.StageLifecyclePrerequisites(context.Background(), encoded, io.Discard); err != nil {
		t.Fatalf("same-transaction swap retry did not converge: %v", err)
	}
	swapPath := filepath.Join(root, strings.TrimPrefix(managedSwapPath, "/"))
	info, err := os.Lstat(swapPath)
	if err != nil || info.Size() != managedSwapBytes || info.Mode().Perm() != 0o600 {
		t.Fatalf("managed swap file is invalid: info=%v err=%v", info, err)
	}
	fstab, err := os.ReadFile(filepath.Join(root, "etc/fstab"))
	if err != nil || strings.Count(string(fstab), managedSwapFstabEntry) != 1 {
		t.Fatalf("managed swap fstab entry is not exact: %q err=%v", fstab, err)
	}
	inspection, err := host.Inspect(context.Background(), 18789, "app")
	if err != nil || !inspection.LifecyclePrerequisitesReady {
		t.Fatalf("managed swap did not satisfy Hosting prerequisites: inspection=%+v err=%v", inspection, err)
	}
	if err := host.RestoreHardening(context.Background(), encoded); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(swapPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("rollback retained managed swap: %v", err)
	}
	fstab, err = os.ReadFile(filepath.Join(root, "etc/fstab"))
	if err != nil || string(fstab) != "# fixture fstab\n" {
		t.Fatalf("rollback did not restore exact fstab: %q err=%v", fstab, err)
	}
}

func TestLowMemoryHostingRejectsUnjournaledManagedSwapResidue(t *testing.T) {
	host, _, root := linuxHostFixture(t)
	if err := os.WriteFile(filepath.Join(root, "proc/meminfo"), []byte("MemTotal:       1048576 kB\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, strings.TrimPrefix(managedSwapPath, "/"))
	if err := os.Symlink("/tmp/foreign-swap", target); err != nil {
		t.Fatal(err)
	}
	if _, err := host.SnapshotHardening(context.Background(), "app", io.Discard); err == nil || !strings.Contains(err.Error(), "managed swap file is unsafe") {
		t.Fatalf("unsafe managed swap residue was accepted: %v", err)
	}
}

func TestLowMemoryHostingResumesJournalBoundSwapResidue(t *testing.T) {
	host, runner, root := linuxHostFixture(t)
	if err := os.WriteFile(filepath.Join(root, "proc/meminfo"), []byte("MemTotal:       1048576 kB\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"nftables", "fail2ban", "unattended-upgrades", "acl"} {
		runner.outputs["/usr/bin/dpkg-query --show --showformat=${db:Status-Status}\t${db:Status-Eflag} "+name] = []byte("installed\tok")
	}
	encoded, err := host.SnapshotHardening(context.Background(), "app", io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	swapPath := filepath.Join(root, strings.TrimPrefix(managedSwapPath, "/"))
	file, err := os.OpenFile(swapPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Truncate(managedSwapBytes); err != nil {
		_ = file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "etc/fstab"), []byte("# fixture fstab\n"+managedSwapFstabEntry+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := host.StageLifecyclePrerequisites(context.Background(), encoded, io.Discard); err != nil {
		t.Fatalf("journal-bound pre-swapon residue did not resume: %v", err)
	}
	inspection, err := host.Inspect(context.Background(), 18789, "app")
	if err != nil || !inspection.LifecyclePrerequisitesReady {
		t.Fatalf("resumed swap did not converge: inspection=%+v err=%v", inspection, err)
	}
	if err := host.RestoreHardening(context.Background(), encoded); err != nil {
		t.Fatal(err)
	}
}

func TestHardeningConvergenceWaitsForFail2banControlReadiness(t *testing.T) {
	host, runner, root := linuxHostFixture(t)
	for path, data := range map[string]string{
		"etc/fased/hosting-firewall.nft":                renderFirewallConfig(),
		"etc/systemd/system/" + firewallUnitName:        renderFirewallUnit("/usr/sbin/nft"),
		"etc/fail2ban/jail.d/fased-sshd.local":          fail2banConfig,
		"etc/apt/apt.conf.d/52fased-security-updates":   aptAutomaticConfig,
		"etc/ssh/sshd_config.d/01-fased-hardening.conf": sshHardeningConfig,
	} {
		full := filepath.Join(root, path)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(data), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	runner.outputs["/usr/sbin/nft list table inet fased_hosting"] = []byte(`table inet fased_hosting { chain input { policy drop; ct state established,related accept; iifname "lo" accept; iifname "tailscale0" tcp dport { 22, 443 } accept; } }`)
	for _, key := range []string{
		"/usr/bin/systemctl is-active --quiet " + firewallUnitName,
		"/usr/bin/systemctl is-enabled --quiet " + firewallUnitName,
		"/usr/bin/systemctl is-active --quiet fail2ban.service",
		"/usr/bin/systemctl is-enabled --quiet fail2ban.service",
		"/usr/bin/systemctl is-active --quiet apt-daily-upgrade.timer",
		"/usr/bin/systemctl is-enabled --quiet apt-daily-upgrade.timer",
	} {
		runner.outputs[key] = []byte("ready\n")
	}
	runner.outputs["/usr/sbin/sshd -T"] = []byte("passwordauthentication no\nkbdinteractiveauthentication no\npermitrootlogin no\npubkeyauthentication yes\n")
	runner.sequences["/usr/bin/fail2ban-client status sshd"] = []fixtureOutput{
		{err: errors.New("control socket not ready")},
		{data: []byte("Status for the jail: sshd\n")},
	}
	if err := host.waitForHardening(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(runner.sequences["/usr/bin/fail2ban-client status sshd"]) != 0 {
		t.Fatal("hardening readiness did not retry the transient fail2ban control failure")
	}
}

func TestLinuxHostInspectionBindsPrivateTailscaleAndHardening(t *testing.T) {
	host, runner, root := linuxHostFixture(t)
	for path, data := range map[string]string{
		"etc/fased/hosting-firewall.nft":              renderFirewallConfig(),
		"etc/systemd/system/" + firewallUnitName:      renderFirewallUnit("/usr/sbin/nft"),
		"etc/fail2ban/jail.d/fased-sshd.local":        fail2banConfig,
		"etc/apt/apt.conf.d/52fased-security-updates": aptAutomaticConfig,
		"etc/fased/signerd-webauthn.env":              "FASED_WALLET_WEBAUTHN_RP_ID=fased.tailnet.ts.net\nFASED_WALLET_WEBAUTHN_ORIGINS=https://fased.tailnet.ts.net\n",
	} {
		full := filepath.Join(root, path)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(data), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	runner.outputs["/usr/bin/tailscale status --json"] = []byte(`{"BackendState":"Running","Self":{"DNSName":"fased.tailnet.ts.net.","TailscaleIPs":["100.64.1.9"]}}`)
	runner.outputs["/usr/bin/tailscale version"] = []byte("1.88.1\n")
	runner.outputs["/usr/bin/tailscale serve status --json"] = []byte(`{"TCP":{"443":{"HTTPS":true}},"Web":{"fased.tailnet.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:18789"}}}}}`)
	for _, key := range []string{
		"/usr/bin/systemctl is-active --quiet fased-signerd.service",
		"/usr/bin/systemctl is-active --quiet " + firewallUnitName,
		"/usr/bin/systemctl is-enabled --quiet " + firewallUnitName,
		"/usr/bin/systemctl is-active --quiet fail2ban.service",
		"/usr/bin/systemctl is-enabled --quiet fail2ban.service",
		"/usr/bin/systemctl is-active --quiet apt-daily-upgrade.timer",
		"/usr/bin/systemctl is-enabled --quiet apt-daily-upgrade.timer",
	} {
		runner.outputs[key] = []byte("active\n")
	}
	runner.outputs["/usr/bin/fail2ban-client status sshd"] = []byte("Status for the jail: sshd\n")
	runner.outputs["/usr/sbin/sshd -T"] = []byte("passwordauthentication no\npermitrootlogin no\npubkeyauthentication yes\n")
	runner.outputs["/usr/sbin/nft list table inet fased_hosting"] = []byte(`table inet fased_hosting { chain input { policy drop; ct state established,related accept; iifname "lo" accept; iifname "tailscale0" tcp dport { 22, 443 } accept; } }`)
	runner.errors["/usr/sbin/runuser -u app -- /usr/bin/sudo -n true"] = errors.New("not authorized")
	inspection, err := host.Inspect(context.Background(), 18789, "app")
	if err != nil {
		t.Fatal(err)
	}
	if !inspection.Authenticated || !inspection.PrivateServeReady || !inspection.HardeningReady || !inspection.SignerReady || inspection.AppCanElevate || inspection.TailscaleDNS != "fased.tailnet.ts.net" {
		t.Fatalf("Hosting inspection lost a required boundary: %+v", inspection)
	}
	if err := os.Remove(filepath.Join(root, "usr/bin/getfacl")); err != nil {
		t.Fatal(err)
	}
	withoutACL, err := host.Inspect(context.Background(), 18789, "app")
	if err != nil || withoutACL.HardeningReady {
		t.Fatalf("Hosting hardening accepted missing getfacl: inspection=%+v err=%v", withoutACL, err)
	}
}

func TestLinuxHostRejectsFunnelAndNonLoopbackServe(t *testing.T) {
	if !containsPublicFunnel([]byte(`{"AllowFunnel":true}`)) {
		t.Fatal("public Funnel configuration was accepted")
	}
	if containsPublicFunnel([]byte(`{"AllowFunnel":false}`)) {
		t.Fatal("private Serve configuration was classified as Funnel")
	}
	if serveTargetsLoopback([]byte(`{"Proxy":"http://0.0.0.0:18789"}`), 18789) {
		t.Fatal("public backend target was accepted as loopback")
	}
}

func TestHostingFirewallDefaultsClosedAndAllowsOnlyPrivateAdministration(t *testing.T) {
	config := renderFirewallConfig()
	for _, required := range []string{
		"policy drop", "ct state established,related accept", `iifname "lo" accept`,
		`iifname "tailscale0" tcp dport { 22, 443 } accept`, "ip protocol icmp accept",
	} {
		if !strings.Contains(config, required) {
			t.Fatalf("Hosting firewall omitted %q:\n%s", required, config)
		}
	}
	for _, forbidden := range []string{"policy accept", "tcp dport 18789 accept", "iifname != \"tailscale0\" tcp dport 22 accept"} {
		if strings.Contains(config, forbidden) {
			t.Fatalf("Hosting firewall exposed a public path %q:\n%s", forbidden, config)
		}
	}
}

func TestInspectChecksLifecyclePrerequisitesBeforeTailscaleExists(t *testing.T) {
	host, _, root := linuxHostFixture(t)
	if err := os.Remove(filepath.Join(root, "usr/bin/tailscale")); err != nil {
		t.Fatal(err)
	}
	inspection, err := host.Inspect(context.Background(), 18789, "app")
	if err != nil {
		t.Fatal(err)
	}
	if inspection.TailscaleInstalled {
		t.Fatal("missing Tailscale was reported as installed")
	}
	if !inspection.LifecyclePrerequisitesReady {
		t.Fatal("ACL lifecycle prerequisites were skipped when Tailscale was absent")
	}
}

func TestHardeningSnapshotIsReadOnlyAndRollbackRemovesOnlyNewPackages(t *testing.T) {
	host, runner, _ := linuxHostFixture(t)
	for _, name := range []string{"nftables", "fail2ban", "unattended-upgrades", "acl"} {
		runner.outputs["/usr/bin/dpkg-query --show --showformat=${db:Status-Status}\t${db:Status-Eflag} "+name] = []byte("installed\tok")
	}
	encoded, err := host.SnapshotHardening(context.Background(), "app", io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	for _, call := range runner.calls {
		if strings.Contains(call, "apt-get update") || strings.Contains(call, "apt-get install") {
			t.Fatalf("snapshot mutated the package database: %s", call)
		}
	}
	snapshot, err := decodeHardeningSnapshot(encoded)
	if err != nil {
		t.Fatal(err)
	}
	missingSwap := snapshot
	missingSwap.Swap = hardeningSwapSnapshot{}
	missingSwapBytes, err := json.Marshal(missingSwap)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := decodeHardeningSnapshot(string(missingSwapBytes)); err == nil {
		t.Fatal("schema-4 hardening snapshot accepted a missing swap decision")
	}
	legacy := snapshot
	legacy.SchemaVersion = 2
	legacy.Packages = legacy.Packages[:len(legacy.Packages)-1]
	legacyBytes, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := decodeHardeningSnapshot(string(legacyBytes)); err != nil {
		t.Fatalf("schema-2 hardening rollback snapshot was rejected: %v", err)
	}
	missingACL := snapshot
	missingACL.Packages = missingACL.Packages[:len(missingACL.Packages)-1]
	missingACLBytes, err := json.Marshal(missingACL)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := decodeHardeningSnapshot(string(missingACLBytes)); err == nil {
		t.Fatal("schema-3 hardening snapshot accepted a missing ACL package")
	}
	for index := range snapshot.Packages {
		snapshot.Packages[index].Installed = false
	}
	encodedBytes, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	runner.calls = nil
	if err := host.RestoreHardening(context.Background(), string(encodedBytes)); err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(runner.calls, "\n")
	if !strings.Contains(joined, "/usr/bin/apt-get remove -y nftables fail2ban unattended-upgrades acl") {
		t.Fatalf("rollback did not remove exactly the transaction-added packages:\n%s", joined)
	}
}

func TestHardeningSnapshotTreatsRemovedConfigResidueAsAbsent(t *testing.T) {
	host, runner, _ := linuxHostFixture(t)
	for _, name := range []string{"nftables", "fail2ban", "unattended-upgrades"} {
		runner.outputs["/usr/bin/dpkg-query --show --showformat=${db:Status-Status}\t${db:Status-Eflag} "+name] = []byte("installed\tok")
	}
	runner.outputs["/usr/bin/dpkg-query --show --showformat=${db:Status-Status}\t${db:Status-Eflag} acl"] = []byte("config-files\tok")

	encoded, err := host.SnapshotHardening(context.Background(), "app", io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := decodeHardeningSnapshot(encoded)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range snapshot.Packages {
		if item.Name == "acl" {
			if item.Installed {
				t.Fatal("removed ACL package configuration residue was treated as installed")
			}
			return
		}
	}
	t.Fatal("ACL package missing from hardening snapshot")
}

func TestHardeningSnapshotRejectsPartialDpkgState(t *testing.T) {
	host, runner, _ := linuxHostFixture(t)
	runner.outputs["/usr/bin/dpkg-query --show --showformat=${db:Status-Status}\t${db:Status-Eflag} nftables"] = []byte("unpacked\tok")
	if _, err := host.SnapshotHardening(context.Background(), "app", io.Discard); err == nil ||
		!strings.Contains(err.Error(), `dpkg package "nftables" is incomplete: status="unpacked" error="ok"`) {
		t.Fatalf("partial dpkg state was not rejected: %v", err)
	}
}

func TestClassifyDpkgPackageStatus(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name      string
		output    string
		installed bool
		wantError string
	}{
		{name: "installed", output: "installed\tok", installed: true},
		{name: "not installed", output: "not-installed\tok"},
		{name: "config residue", output: "config-files\tok"},
		{name: "half installed", output: "half-installed\tok", wantError: "is incomplete"},
		{name: "unpacked", output: "unpacked\tok", wantError: "is incomplete"},
		{name: "half configured", output: "half-configured\tok", wantError: "is incomplete"},
		{name: "triggers awaiting", output: "triggers-awaiting\tok", wantError: "is incomplete"},
		{name: "triggers pending", output: "triggers-pending\tok", wantError: "is incomplete"},
		{name: "reinstall required", output: "installed\treinstreq", wantError: "is unsafe"},
		{name: "unknown", output: "future-state\tok", wantError: "has an unknown status"},
		{name: "malformed", output: "installed", wantError: "returned an invalid status"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			installed, err := classifyDpkgPackageStatus("acl", []byte(test.output))
			if installed != test.installed {
				t.Fatalf("installed=%v, want %v", installed, test.installed)
			}
			if test.wantError == "" && err != nil {
				t.Fatal(err)
			}
			if test.wantError != "" && (err == nil || !strings.Contains(err.Error(), test.wantError)) {
				t.Fatalf("error=%v, want substring %q", err, test.wantError)
			}
		})
	}
}

func TestLinuxHostConfiguresAndRestoresServeWithoutCallerDNS(t *testing.T) {
	host, runner, _ := linuxHostFixture(t)
	runner.errors["/usr/bin/tailscale serve get-config --all"] = errors.New("not configured")
	previous, err := host.SnapshotPrivateServe(context.Background())
	if err != nil || previous != "" {
		t.Fatalf("snapshot private Serve: previous=%q err=%v", previous, err)
	}
	if err := host.ConfigurePrivateServe(context.Background(), 18789); err != nil {
		t.Fatalf("configure private Serve: %v", err)
	}
	if err := host.RestorePrivateServe(context.Background(), previous); err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(runner.calls, "\n")
	if !strings.Contains(joined, "/usr/bin/tailscale serve --bg --yes http://127.0.0.1:18789") || !strings.Contains(joined, "/usr/bin/tailscale serve reset") {
		t.Fatalf("Serve transaction did not use bounded commands:\n%s", joined)
	}
}

func TestLinuxHostRestoresModernEmptyServeSnapshotWithReset(t *testing.T) {
	host, runner, _ := linuxHostFixture(t)
	runner.outputs["/usr/bin/tailscale serve get-config --all"] = []byte(`{"version":"0.0.1","Services":{}}`)
	previous, err := host.SnapshotPrivateServe(context.Background())
	if err != nil || previous == "" {
		t.Fatalf("snapshot modern empty Serve config: previous=%q err=%v", previous, err)
	}
	if err := host.RestorePrivateServe(context.Background(), previous); err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(runner.calls, "\n")
	if !strings.Contains(joined, "/usr/bin/tailscale serve reset") || strings.Contains(joined, "serve set-config") {
		t.Fatalf("empty modern Serve snapshot was not reset safely:\n%s", joined)
	}
}

func TestOSReleaseAndDNFAutomaticParsingAreBounded(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "os-release")
	if err := os.WriteFile(path, []byte("ID=rocky\nVERSION_ID=9.5\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	values, err := parseOSRelease(path)
	if err != nil || values["ID"] != "rocky" || values["VERSION_ID"] != "9.5" {
		t.Fatalf("parse os-release: values=%v err=%v", values, err)
	}
	updated, err := enableDNFAutomatic([]byte("[commands]\napply_updates = no\n"))
	if err != nil || !strings.Contains(string(updated), "apply_updates = yes") {
		t.Fatalf("enable dnf automatic: %q err=%v", updated, err)
	}
}

func TestLinuxHostRecognizesOnlyIntactLegacyHostingBoundary(t *testing.T) {
	host, runner, root := linuxHostFixture(t)
	receipt := "schemaVersion=2\nrelease=0.1.76\ngatewayPort=18789\ntailscaleDns=legacy.tailnet.ts.net\ntailnetSshConfirmed=true\ntailscaleServeReady=true\nfirewallReady=true\nsshHardened=true\nfail2banReady=true\nautomaticUpdatesReady=true\nsignerReady=true\nappSudoDisabled=true\npreparedBy=root\n"
	if err := os.MkdirAll(filepath.Join(root, "etc/fased"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "etc/fased/hosting-prerequisites"), []byte(receipt), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "etc/fased/signerd-webauthn.env"), []byte("FASED_WALLET_WEBAUTHN_RP_ID=legacy.tailnet.ts.net\nFASED_WALLET_WEBAUTHN_ORIGINS=https://legacy.tailnet.ts.net\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runner.outputs["/usr/bin/tailscale status --json"] = []byte(`{"BackendState":"Running","Self":{"DNSName":"legacy.tailnet.ts.net.","TailscaleIPs":["100.64.1.9"]}}`)
	runner.outputs["/usr/bin/tailscale version"] = []byte("1.88.1\n")
	runner.outputs["/usr/bin/tailscale serve status --json"] = []byte(`{"Proxy":"http://127.0.0.1:18789"}`)
	for _, key := range []string{
		"/usr/bin/systemctl is-active --quiet fased-signerd.service",
		"/usr/bin/systemctl is-active --quiet fail2ban.service",
		"/usr/bin/systemctl is-enabled --quiet fail2ban.service",
		"/usr/bin/systemctl is-active --quiet apt-daily-upgrade.timer",
		"/usr/bin/systemctl is-enabled --quiet apt-daily-upgrade.timer",
	} {
		runner.outputs[key] = []byte("ready\n")
	}
	runner.outputs["/usr/bin/fail2ban-client status sshd"] = []byte("Status for the jail: sshd\n")
	runner.outputs["/usr/sbin/sshd -T"] = []byte("passwordauthentication no\npermitrootlogin no\npubkeyauthentication yes\n")
	runner.outputs["/usr/sbin/ufw status verbose"] = []byte("Status: active\nDefault: deny (incoming), allow (outgoing)\n22/tcp DENY IN Anywhere\n22/tcp ALLOW IN Anywhere on tailscale0\n443/tcp ALLOW IN Anywhere on tailscale0\n")
	runner.errors["/usr/sbin/runuser -u app -- /usr/bin/sudo -n true"] = errors.New("not authorized")
	inspection, err := host.Inspect(context.Background(), 18789, "app")
	if err != nil || !inspection.LegacyHardeningReady || inspection.HardeningReady {
		t.Fatalf("intact legacy Hosting boundary was not distinguished: %+v err=%v", inspection, err)
	}
	runner.outputs["/usr/sbin/ufw status verbose"] = []byte("Status: active\nDefault: allow (incoming), allow (outgoing)\n")
	inspection, err = host.Inspect(context.Background(), 18789, "app")
	if err != nil || inspection.LegacyHardeningReady {
		t.Fatalf("open legacy firewall was accepted: %+v err=%v", inspection, err)
	}
}

func TestTailscaleRepositoryAndServiceRollbackUsesPreMutationSnapshot(t *testing.T) {
	host, runner, root := linuxHostFixture(t)
	if err := os.Remove(filepath.Join(root, "usr/bin/tailscale")); err != nil {
		t.Fatal(err)
	}
	listPath := filepath.Join(root, "etc/apt/sources.list.d/tailscale.list")
	if err := os.MkdirAll(filepath.Dir(listPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(listPath, []byte("predecessor repository\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{
		"/usr/bin/systemctl is-enabled --quiet tailscaled.service",
		"/usr/bin/systemctl is-active --quiet tailscaled.service",
	} {
		runner.errors[key] = errors.New("absent before transaction")
	}
	snapshot, err := host.SnapshotTailscaleInstall(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	keyPath := filepath.Join(root, "usr/share/keyrings/tailscale-archive-keyring.gpg")
	if err := os.MkdirAll(filepath.Dir(keyPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyPath, []byte("new key"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(listPath, []byte("new repository\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	delete(runner.errors, "/usr/bin/systemctl is-enabled --quiet tailscaled.service")
	delete(runner.errors, "/usr/bin/systemctl is-active --quiet tailscaled.service")
	if err := host.RestoreTailscaleInstall(context.Background(), snapshot); err != nil {
		t.Fatal(err)
	}
	list, err := os.ReadFile(listPath)
	if err != nil || string(list) != "predecessor repository\n" {
		t.Fatalf("repository list was not restored: %q err=%v", list, err)
	}
	if _, err := os.Lstat(keyPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("new repository key was retained: %v", err)
	}
	joined := strings.Join(runner.calls, "\n")
	if !strings.Contains(joined, "systemctl disable tailscaled.service") || !strings.Contains(joined, "systemctl stop tailscaled.service") ||
		!strings.Contains(joined, "apt-get remove -y tailscale") {
		t.Fatalf("new tailscaled service state was not rolled back:\n%s", joined)
	}
}

func TestSignerWebAuthnConfigurationIsNoopAndExactlyRollbackable(t *testing.T) {
	host, runner, root := linuxHostFixture(t)
	path := filepath.Join(root, "etc/fased/signerd-webauthn.env")
	previous, existed, err := host.SnapshotSignerWebAuthn(context.Background())
	if err != nil || existed || previous != "" {
		t.Fatalf("unexpected absent signer snapshot: previous=%q existed=%v err=%v", previous, existed, err)
	}
	if err := host.ConfigureSignerWebAuthn(context.Background(), "fased.tailnet.ts.net", false); err != nil {
		t.Fatal(err)
	}
	if !host.signerWebAuthnReady("fased.tailnet.ts.net") {
		t.Fatal("configured signer WebAuthn identity is not exact")
	}
	callsBeforeNoop := len(runner.calls)
	if err := host.ConfigureSignerWebAuthn(context.Background(), "fased.tailnet.ts.net", true); err != nil {
		t.Fatal(err)
	}
	if len(runner.calls) != callsBeforeNoop {
		t.Fatalf("exact signer WebAuthn configuration restarted the service: %v", runner.calls[callsBeforeNoop:])
	}
	if err := host.RestoreSignerWebAuthn(context.Background(), previous, existed); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("transaction-created signer identity survived rollback: %v", err)
	}
	if !strings.Contains(strings.Join(runner.calls, "\n"), "/usr/bin/systemctl stop fased-signerd.service") {
		t.Fatalf("rollback did not stop the signer that depended on a removed identity: %v", runner.calls)
	}
}

func TestSignerWebAuthnConvergesOnlySafeEmptyPredecessorPlaceholder(t *testing.T) {
	host, _, root := linuxHostFixture(t)
	path := filepath.Join(root, "etc/fased/signerd-webauthn.env")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, nil, 0o644); err != nil {
		t.Fatal(err)
	}

	previous, existed, err := host.SnapshotSignerWebAuthn(context.Background())
	if err != nil || existed || previous != "" {
		t.Fatalf("safe empty predecessor placeholder was not treated as absent: previous=%q existed=%v err=%v", previous, existed, err)
	}
	if err := host.ConfigureSignerWebAuthn(context.Background(), "fased.tailnet.ts.net", false); err != nil {
		t.Fatal(err)
	}
	if !host.signerWebAuthnReady("fased.tailnet.ts.net") {
		t.Fatal("safe empty predecessor placeholder did not converge to the exact signer identity")
	}
	if err := host.RestoreSignerWebAuthn(context.Background(), previous, existed); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("placeholder-derived signer identity survived rollback: %v", err)
	}

	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := host.SnapshotSignerWebAuthn(context.Background()); err == nil || !strings.Contains(err.Error(), "mode=0600") {
		t.Fatalf("unsafe empty predecessor placeholder was accepted: %v", err)
	}
	if err := host.ConfigureSignerWebAuthn(context.Background(), "fased.tailnet.ts.net", false); err == nil {
		t.Fatal("unsafe empty predecessor placeholder was overwritten")
	}
}

func TestSignerWebAuthnRepairRestartsAndRestoresActiveSigner(t *testing.T) {
	host, runner, root := linuxHostFixture(t)
	path := filepath.Join(root, "etc/fased/signerd-webauthn.env")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	original := "FASED_WALLET_WEBAUTHN_RP_ID=old.tailnet.ts.net\nFASED_WALLET_WEBAUTHN_ORIGINS=https://old.tailnet.ts.net\n"
	if err := os.WriteFile(path, []byte(original), 0o644); err != nil {
		t.Fatal(err)
	}
	previous, existed, err := host.SnapshotSignerWebAuthn(context.Background())
	if err != nil || !existed || previous != original {
		t.Fatalf("signer snapshot mismatch: previous=%q existed=%v err=%v", previous, existed, err)
	}
	if err := host.ConfigureSignerWebAuthn(context.Background(), "new.tailnet.ts.net", true); err != nil {
		t.Fatal(err)
	}
	if err := host.RestoreSignerWebAuthn(context.Background(), previous, existed); err != nil {
		t.Fatal(err)
	}
	restored, err := os.ReadFile(path)
	if err != nil || string(restored) != original {
		t.Fatalf("signer WebAuthn rollback mismatch: %q err=%v", restored, err)
	}
	restarts := 0
	for _, call := range runner.calls {
		if call == "/usr/bin/systemctl restart fased-signerd.service" {
			restarts++
		}
	}
	if restarts != 2 {
		t.Fatalf("repair and restore did not each restart the active signer: restarts=%d calls=%v", restarts, runner.calls)
	}
}
