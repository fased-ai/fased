package hostsecurity

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type fixtureRunner struct {
	outputs map[string][]byte
	errors  map[string]error
	calls   []string
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
	return runner.outputs[key], runner.errors[key]
}

func linuxHostFixture(t *testing.T) (LinuxHost, *fixtureRunner, string) {
	t.Helper()
	root := t.TempDir()
	for _, directory := range []string{"usr/bin", "etc", "etc/ssh/sshd_config.d"} {
		if err := os.MkdirAll(filepath.Join(root, directory), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "usr/bin/tailscale"), []byte("fixture"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "etc/os-release"), []byte("ID=ubuntu\nVERSION_ID=24.04\nVERSION_CODENAME=noble\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "etc/ssh/sshd_config.d/01-fased-hardening.conf"), []byte(sshHardeningConfig), 0o644); err != nil {
		t.Fatal(err)
	}
	runner := &fixtureRunner{outputs: map[string][]byte{}, errors: map[string]error{}}
	host := LinuxHost{Runner: runner, HTTPClient: NewLinuxHost().HTTPClient, RootPrefix: root}
	return host, runner, root
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
	runner.outputs["/usr/bin/fail2ban-client status sshd"] = []byte("Jail list: sshd\n")
	runner.outputs["/usr/sbin/sshd -T"] = []byte("passwordauthentication no\npermitrootlogin no\npubkeyauthentication yes\n")
	runner.outputs["/usr/sbin/nft list table inet fased_hosting"] = []byte(`table inet fased_hosting { chain input { iifname "tailscale0" tcp dport 22 accept; tcp dport 22 drop; } }`)
	runner.errors["/usr/sbin/runuser -u app -- /usr/bin/sudo -n true"] = errors.New("not authorized")
	inspection, err := host.Inspect(context.Background(), 18789, "app")
	if err != nil {
		t.Fatal(err)
	}
	if !inspection.Authenticated || !inspection.PrivateServeReady || !inspection.HardeningReady || !inspection.SignerReady || inspection.AppCanElevate || inspection.TailscaleDNS != "fased.tailnet.ts.net" {
		t.Fatalf("Hosting inspection lost a required boundary: %+v", inspection)
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
	runner.outputs["/usr/bin/fail2ban-client status sshd"] = []byte("Jail list: sshd\n")
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
	if !strings.Contains(joined, "systemctl disable tailscaled.service") || !strings.Contains(joined, "systemctl stop tailscaled.service") {
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
