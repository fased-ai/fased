package hostsecurity

import (
	"bytes"
	"context"
	"os"
	"regexp"
	"strconv"
	"strings"
)

var stableReleasePattern = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+$`)

func (host LinuxHost) legacyHardeningReady(ctx context.Context, inspection Inspection, port uint16) bool {
	if !inspection.SignerWebAuthnReady || !host.legacyReceiptReady(inspection, port) || !host.sshEffectiveReady(ctx) || !host.fail2banReady(ctx) || !host.automaticUpdatesReady(ctx) {
		return false
	}
	return host.legacyUFWReady(ctx) || host.legacyFirewalldReady(ctx)
}

func (host LinuxHost) legacyReceiptReady(inspection Inspection, port uint16) bool {
	data, err := readSecureRootFile(host.path("/etc/fased/hosting-prerequisites"), 0o644, uint32(os.Getuid()), 4096)
	if err != nil {
		return false
	}
	allowed := map[string]bool{
		"schemaVersion": true, "release": true, "gatewayPort": true, "tailscaleDns": true,
		"tailnetSshConfirmed": true, "tailscaleServeReady": true, "firewallReady": true,
		"sshHardened": true, "fail2banReady": true, "automaticUpdatesReady": true,
		"signerReady": true, "appSudoDisabled": true, "preparedBy": true,
	}
	values := map[string]string{}
	seen := map[string]bool{}
	for _, line := range strings.Split(strings.TrimSuffix(string(data), "\n"), "\n") {
		key, value, ok := strings.Cut(line, "=")
		if !ok || !allowed[key] || seen[key] || strings.ContainsAny(value, "\x00\r\n") {
			return false
		}
		seen[key] = true
		values[key] = value
	}
	if len(values) != len(allowed) || values["schemaVersion"] != "2" || !stableReleasePattern.MatchString(values["release"]) ||
		values["gatewayPort"] != strconv.Itoa(int(port)) || values["tailscaleDns"] != inspection.TailscaleDNS ||
		values["tailnetSshConfirmed"] != "true" || values["tailscaleServeReady"] != "true" || values["firewallReady"] != "true" ||
		values["sshHardened"] != "true" || values["fail2banReady"] != "true" || values["automaticUpdatesReady"] != "true" ||
		values["signerReady"] != "true" || values["appSudoDisabled"] != "true" || values["preparedBy"] != "root" {
		return false
	}
	return true
}

func (host LinuxHost) legacyUFWReady(ctx context.Context) bool {
	command := "/usr/sbin/ufw"
	if host.RootPrefix == "" {
		if _, err := fixedExecutable(command, "/usr/bin/ufw"); err != nil {
			return false
		}
	}
	output, err := host.Runner.Output(ctx, command, "status", "verbose")
	normalized := strings.ToLower(string(output))
	return err == nil && strings.Contains(normalized, "status: active") && strings.Contains(normalized, "default: deny (incoming)") &&
		strings.Contains(normalized, "tailscale0") && strings.Contains(normalized, "22") && strings.Contains(normalized, "443") && strings.Contains(normalized, "deny")
}

func (host LinuxHost) legacyFirewalldReady(ctx context.Context) bool {
	command := "/usr/bin/firewall-cmd"
	if host.RootPrefix == "" {
		if _, err := fixedExecutable(command, "/usr/sbin/firewall-cmd"); err != nil {
			return false
		}
	}
	state, err := host.Runner.Output(ctx, command, "--state")
	if err != nil || strings.TrimSpace(string(state)) != "running" {
		return false
	}
	if _, err := host.Runner.Output(ctx, command, "--permanent", "--zone=trusted", "--query-interface=tailscale0"); err != nil {
		return false
	}
	if _, err := host.Runner.Output(ctx, command, "--permanent", "--zone=public", "--query-service=ssh"); err == nil {
		return false
	}
	if _, err := host.Runner.Output(ctx, command, "--permanent", "--zone=public", "--query-port=22/tcp"); err == nil {
		return false
	}
	return true
}

func (host LinuxHost) sshEffectiveReady(ctx context.Context) bool {
	command := "/usr/sbin/sshd"
	if host.RootPrefix == "" {
		var err error
		command, err = fixedExecutable(command, "/usr/bin/sshd", "/sbin/sshd")
		if err != nil {
			return false
		}
	}
	output, err := host.Runner.Output(ctx, command, "-T")
	if err != nil {
		return false
	}
	want := [][]byte{[]byte("passwordauthentication no"), []byte("permitrootlogin no"), []byte("pubkeyauthentication yes")}
	lower := bytes.ToLower(output)
	for _, value := range want {
		if !bytes.Contains(lower, value) {
			return false
		}
	}
	return true
}

func (host LinuxHost) fail2banReady(ctx context.Context) bool {
	if !host.commandSucceeds(ctx, "/usr/bin/systemctl", "is-active", "--quiet", "fail2ban.service") ||
		!host.commandSucceeds(ctx, "/usr/bin/systemctl", "is-enabled", "--quiet", "fail2ban.service") {
		return false
	}
	command := "/usr/bin/fail2ban-client"
	if host.RootPrefix == "" {
		var err error
		command, err = fixedExecutable(command, "/usr/bin/fail2ban-client", "/usr/local/bin/fail2ban-client")
		if err != nil {
			return false
		}
	}
	output, err := host.Runner.Output(ctx, command, "status", "sshd")
	return err == nil && bytes.Contains(bytes.ToLower(output), []byte("jail list"))
}

func (host LinuxHost) automaticUpdatesReady(ctx context.Context) bool {
	release, err := parseOSRelease(host.path("/etc/os-release"))
	if err != nil {
		return false
	}
	if release["ID"] == "ubuntu" || release["ID"] == "debian" {
		return host.commandSucceeds(ctx, "/usr/bin/systemctl", "is-active", "--quiet", "apt-daily-upgrade.timer") &&
			host.commandSucceeds(ctx, "/usr/bin/systemctl", "is-enabled", "--quiet", "apt-daily-upgrade.timer")
	}
	for _, timer := range []string{"dnf5-automatic.timer", "dnf-automatic-install.timer", "dnf-automatic.timer", "yum-cron.service"} {
		if host.commandSucceeds(ctx, "/usr/bin/systemctl", "is-active", "--quiet", timer) && host.commandSucceeds(ctx, "/usr/bin/systemctl", "is-enabled", "--quiet", timer) {
			return true
		}
	}
	return false
}
