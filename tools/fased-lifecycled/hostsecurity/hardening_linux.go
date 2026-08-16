package hostsecurity

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"syscall"
	"time"
)

const (
	hardeningSnapshotSchema     uint32 = 1
	firewallUnitName                   = "fased-hosting-firewall.service"
	hardeningConvergenceTimeout        = 15 * time.Second
	hardeningConvergencePoll           = 100 * time.Millisecond
)

type hardeningFileSnapshot struct {
	Path   string `json:"path"`
	Exists bool   `json:"exists"`
	Mode   uint32 `json:"mode,omitempty"`
	Data   string `json:"data,omitempty"`
}

type hardeningServiceSnapshot struct {
	Name    string `json:"name"`
	Enabled bool   `json:"enabled"`
	Active  bool   `json:"active"`
}

type hardeningSnapshot struct {
	SchemaVersion uint32                     `json:"schemaVersion"`
	Family        string                     `json:"family"`
	SSHService    string                     `json:"sshService"`
	UpdateTimer   string                     `json:"updateTimer"`
	NftBinary     string                     `json:"nftBinary"`
	Files         []hardeningFileSnapshot    `json:"files"`
	Services      []hardeningServiceSnapshot `json:"services"`
}

func (host LinuxHost) SnapshotHardening(ctx context.Context, operator string, log io.Writer) (string, error) {
	if err := host.validate(); err != nil || !accountPattern.MatchString(operator) {
		return "", errors.Join(err, errors.New("Hosting hardening stage input is invalid"))
	}
	release, err := parseOSRelease(host.path("/etc/os-release"))
	if err != nil {
		return "", err
	}
	family, timer, err := host.installHardeningPackages(ctx, release, log)
	if err != nil {
		return "", err
	}
	nftBinary, err := fixedExecutable("/usr/sbin/nft", "/usr/bin/nft", "/sbin/nft")
	if host.RootPrefix != "" {
		nftBinary, err = "/usr/sbin/nft", nil
	}
	if err != nil {
		return "", err
	}
	sshService := "sshd.service"
	if host.commandSucceeds(ctx, "/usr/bin/systemctl", "status", "ssh.service") {
		sshService = "ssh.service"
	}
	paths := []string{
		"/etc/ssh/sshd_config.d/01-fased-hardening.conf",
		"/etc/fased/hosting-firewall.nft",
		"/etc/systemd/system/" + firewallUnitName,
		"/etc/fail2ban/jail.d/fased-sshd.local",
	}
	if family == "apt" {
		paths = append(paths, "/etc/apt/apt.conf.d/52fased-security-updates")
	} else {
		paths = append(paths, "/etc/dnf/automatic.conf")
	}
	snapshot := hardeningSnapshot{SchemaVersion: hardeningSnapshotSchema, Family: family, SSHService: sshService, UpdateTimer: timer, NftBinary: nftBinary}
	for _, path := range paths {
		file, err := snapshotHardeningFile(host.path(path), path)
		if err != nil {
			return "", err
		}
		snapshot.Files = append(snapshot.Files, file)
	}
	for _, service := range []string{firewallUnitName, "fail2ban.service", timer, sshService} {
		snapshot.Services = append(snapshot.Services, hardeningServiceSnapshot{Name: service,
			Enabled: host.commandSucceeds(ctx, "/usr/bin/systemctl", "is-enabled", "--quiet", service),
			Active:  host.commandSucceeds(ctx, "/usr/bin/systemctl", "is-active", "--quiet", service)})
	}
	data, err := json.Marshal(snapshot)
	if err != nil || len(data) > maxOpaqueSnapshot {
		return "", errors.Join(err, errors.New("Hosting hardening snapshot exceeded its bound"))
	}
	return string(data), nil
}

func (host LinuxHost) StageHardening(ctx context.Context, encoded string, log io.Writer) error {
	snapshot, err := decodeHardeningSnapshot(encoded)
	if err != nil {
		return err
	}
	if err := host.writeHardeningFiles(snapshot); err != nil {
		_ = host.restoreHardeningFiles(snapshot)
		return err
	}
	if err := host.run(ctx, "/usr/bin/systemctl", []string{"daemon-reload"}, nil, io.Discard, log, nil); err != nil {
		_ = host.restoreHardeningFiles(snapshot)
		return err
	}
	sshd, err := fixedExecutable("/usr/sbin/sshd", "/usr/bin/sshd", "/sbin/sshd")
	if host.RootPrefix != "" {
		sshd, err = "/usr/sbin/sshd", nil
	}
	if err != nil {
		_ = host.restoreHardeningFiles(snapshot)
		return err
	}
	if err := host.Runner.Run(ctx, sshd, []string{"-t"}, nil, io.Discard, log, nil); err != nil {
		_ = host.restoreHardeningFiles(snapshot)
		return fmt.Errorf("staged SSH hardening is invalid: %w", err)
	}
	return nil
}

func (host LinuxHost) CommitHardening(ctx context.Context, encoded string) error {
	snapshot, err := decodeHardeningSnapshot(encoded)
	if err != nil {
		return err
	}
	log := io.Discard
	if _, err := host.Runner.Output(ctx, snapshot.NftBinary, "delete", "table", "inet", "fased_hosting"); err != nil {
		// Absence is the expected first-install state. Applying the exact owned
		// table below remains authoritative.
	}
	for _, service := range []string{firewallUnitName, "fail2ban.service", snapshot.UpdateTimer} {
		if err := host.run(ctx, "/usr/bin/systemctl", []string{"enable", "--now", service}, nil, log, log, nil); err != nil {
			return errors.Join(err, host.RestoreHardening(ctx, encoded))
		}
	}
	if err := host.run(ctx, "/usr/bin/systemctl", []string{"restart", snapshot.SSHService}, nil, log, log, nil); err != nil {
		return errors.Join(err, host.RestoreHardening(ctx, encoded))
	}
	if err := host.waitForHardening(ctx); err != nil {
		return errors.Join(err, host.RestoreHardening(ctx, encoded))
	}
	return nil
}

func (host LinuxHost) waitForHardening(ctx context.Context) error {
	deadline := time.NewTimer(hardeningConvergenceTimeout)
	defer deadline.Stop()
	ticker := time.NewTicker(hardeningConvergencePoll)
	defer ticker.Stop()
	for {
		if host.hardeningReady(ctx) {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return errors.New("Hosting hardening services did not become ready before the bounded deadline")
		case <-ticker.C:
		}
	}
}

func (host LinuxHost) RestoreHardening(ctx context.Context, encoded string) error {
	if strings.TrimSpace(encoded) == "" {
		return nil
	}
	snapshot, err := decodeHardeningSnapshot(encoded)
	if err != nil {
		return err
	}
	var failures []error
	_, _ = host.Runner.Output(ctx, snapshot.NftBinary, "delete", "table", "inet", "fased_hosting")
	failures = append(failures, host.restoreHardeningFiles(snapshot))
	failures = append(failures, host.run(ctx, "/usr/bin/systemctl", []string{"daemon-reload"}, nil, io.Discard, io.Discard, nil))
	for _, service := range snapshot.Services {
		currentlyEnabled := host.commandSucceeds(ctx, "/usr/bin/systemctl", "is-enabled", "--quiet", service.Name)
		if service.Enabled && !currentlyEnabled {
			failures = append(failures, host.run(ctx, "/usr/bin/systemctl", []string{"enable", service.Name}, nil, io.Discard, io.Discard, nil))
		} else if !service.Enabled && currentlyEnabled {
			failures = append(failures, host.run(ctx, "/usr/bin/systemctl", []string{"disable", service.Name}, nil, io.Discard, io.Discard, nil))
		}
		currentlyActive := host.commandSucceeds(ctx, "/usr/bin/systemctl", "is-active", "--quiet", service.Name)
		if service.Active {
			action := "start"
			if currentlyActive && (service.Name == snapshot.SSHService || service.Name == firewallUnitName || service.Name == "fail2ban.service") {
				action = "restart"
			}
			if !currentlyActive || action == "restart" {
				failures = append(failures, host.run(ctx, "/usr/bin/systemctl", []string{action, service.Name}, nil, io.Discard, io.Discard, nil))
			}
		} else if currentlyActive {
			failures = append(failures, host.run(ctx, "/usr/bin/systemctl", []string{"stop", service.Name}, nil, io.Discard, io.Discard, nil))
		}
	}
	return errors.Join(failures...)
}

func (host LinuxHost) hardeningReady(ctx context.Context) bool {
	nftBinary, err := fixedExecutable("/usr/sbin/nft", "/usr/bin/nft", "/sbin/nft")
	if host.RootPrefix != "" {
		nftBinary, err = "/usr/sbin/nft", nil
	}
	if err != nil {
		return false
	}
	table, err := host.Runner.Output(ctx, nftBinary, "list", "table", "inet", "fased_hosting")
	if err != nil || !bytes.Contains(table, []byte(`iifname "tailscale0"`)) || !bytes.Contains(table, []byte("tcp dport 22 drop")) {
		return false
	}
	if !host.commandSucceeds(ctx, "/usr/bin/systemctl", "is-active", "--quiet", firewallUnitName) ||
		!host.commandSucceeds(ctx, "/usr/bin/systemctl", "is-enabled", "--quiet", firewallUnitName) || !host.fail2banReady(ctx) {
		return false
	}
	if !host.automaticUpdatesReady(ctx) || !host.sshEffectiveReady(ctx) {
		return false
	}
	exactFiles := map[string]string{
		"/etc/ssh/sshd_config.d/01-fased-hardening.conf": sshHardeningConfig,
		"/etc/fased/hosting-firewall.nft":                renderFirewallConfig(),
		"/etc/systemd/system/" + firewallUnitName:        renderFirewallUnit(nftBinary),
		"/etc/fail2ban/jail.d/fased-sshd.local":          fail2banConfig,
	}
	for path, expected := range exactFiles {
		data, err := readSecureRootFile(host.path(path), 0o644, uint32(os.Getuid()), 1<<20)
		if err != nil || !bytes.Equal(data, []byte(expected)) {
			return false
		}
	}
	release, err := parseOSRelease(host.path("/etc/os-release"))
	if err != nil {
		return false
	}
	if release["ID"] == "ubuntu" || release["ID"] == "debian" {
		data, err := readSecureRootFile(host.path("/etc/apt/apt.conf.d/52fased-security-updates"), 0o644, uint32(os.Getuid()), 1<<20)
		return err == nil && bytes.Equal(data, []byte(aptAutomaticConfig))
	}
	data, err := readSecureRootFile(host.path("/etc/dnf/automatic.conf"), 0o644, uint32(os.Getuid()), 1<<20)
	return err == nil && dnfAutomaticEnabled(data)
}

func (host LinuxHost) installHardeningPackages(ctx context.Context, release map[string]string, log io.Writer) (family, timer string, err error) {
	switch release["ID"] {
	case "ubuntu", "debian":
		apt, findErr := fixedExecutable("/usr/bin/apt-get", "/bin/apt-get")
		if host.RootPrefix != "" {
			apt, findErr = "/usr/bin/apt-get", nil
		}
		if findErr != nil {
			return "", "", findErr
		}
		env := []string{"DEBIAN_FRONTEND=noninteractive", "NEEDRESTART_MODE=a"}
		if err := host.Runner.Run(ctx, apt, []string{"update"}, nil, log, log, env); err != nil {
			return "", "", err
		}
		if err := host.Runner.Run(ctx, apt, []string{"install", "-y", "--no-install-recommends", "nftables", "fail2ban", "unattended-upgrades"}, nil, log, log, env); err != nil {
			return "", "", err
		}
		return "apt", "apt-daily-upgrade.timer", nil
	case "fedora", "centos", "rhel", "rocky", "almalinux", "ol", "cloudlinux":
		manager, findErr := fixedExecutable("/usr/bin/dnf5", "/usr/bin/dnf", "/usr/bin/yum")
		if host.RootPrefix != "" {
			manager, findErr = "/usr/bin/dnf", nil
		}
		if findErr != nil {
			return "", "", findErr
		}
		if release["ID"] != "fedora" {
			if err := host.Runner.Run(ctx, manager, []string{"install", "-y", "epel-release"}, nil, log, log, nil); err != nil {
				return "", "", err
			}
		}
		if err := host.Runner.Run(ctx, manager, []string{"install", "-y", "nftables", "fail2ban", "dnf-automatic"}, nil, log, log, nil); err != nil {
			return "", "", err
		}
		return "rpm", "dnf-automatic-install.timer", nil
	default:
		return "", "", errors.New("unsupported Hosting distribution for hardening")
	}
}

const sshHardeningConfig = `# Managed by the Fased Go lifecycle.
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
`

const fail2banConfig = `[sshd]
enabled = true
backend = systemd
banaction = nftables-multiport
`

const aptAutomaticConfig = `APT::Periodic::Enable "1";
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
`

func renderFirewallConfig() string {
	return `table inet fased_hosting {
  chain input {
    type filter hook input priority -10; policy accept;
    iifname "tailscale0" tcp dport { 22, 443 } accept
    tcp dport 22 drop
  }
}
`
}

func renderFirewallUnit(nftBinary string) string {
	return fmt.Sprintf(`[Unit]
Description=Fased Hosting firewall boundary
DefaultDependencies=no
After=local-fs.target
Before=network-pre.target shutdown.target ssh.service sshd.service
Wants=network-pre.target
Conflicts=shutdown.target

[Service]
Type=oneshot
ExecStartPre=-%s delete table inet fased_hosting
ExecStart=%s -f /etc/fased/hosting-firewall.nft
ExecStop=-%s delete table inet fased_hosting
RemainAfterExit=yes
NoNewPrivileges=true
CapabilityBoundingSet=CAP_NET_ADMIN
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
`, nftBinary, nftBinary, nftBinary)
}

func (host LinuxHost) writeHardeningFiles(snapshot hardeningSnapshot) error {
	files := map[string][]byte{
		"/etc/ssh/sshd_config.d/01-fased-hardening.conf": []byte(sshHardeningConfig),
		"/etc/fased/hosting-firewall.nft":                []byte(renderFirewallConfig()),
		"/etc/systemd/system/" + firewallUnitName:        []byte(renderFirewallUnit(snapshot.NftBinary)),
		"/etc/fail2ban/jail.d/fased-sshd.local":          []byte(fail2banConfig),
	}
	if snapshot.Family == "apt" {
		files["/etc/apt/apt.conf.d/52fased-security-updates"] = []byte(aptAutomaticConfig)
	} else {
		current, err := os.ReadFile(host.path("/etc/dnf/automatic.conf"))
		if err != nil {
			return err
		}
		updated, err := enableDNFAutomatic(current)
		if err != nil {
			return err
		}
		files["/etc/dnf/automatic.conf"] = updated
	}
	for path, data := range files {
		if err := writeAtomicRootFile(host.path(path), data, 0o644, uint32(os.Getuid())); err != nil {
			return err
		}
	}
	return nil
}

func enableDNFAutomatic(data []byte) ([]byte, error) {
	lines := strings.Split(string(data), "\n")
	found := false
	for index, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "apply_updates") && strings.Contains(trimmed, "=") {
			lines[index] = "apply_updates = yes"
			found = true
		}
	}
	if !found {
		return nil, errors.New("dnf automatic configuration lacks apply_updates")
	}
	return []byte(strings.Join(lines, "\n")), nil
}

func dnfAutomaticEnabled(data []byte) bool {
	for _, line := range strings.Split(string(data), "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "apply_updates") {
			key, value, ok := strings.Cut(trimmed, "=")
			return ok && strings.TrimSpace(key) == "apply_updates" && strings.EqualFold(strings.TrimSpace(value), "yes")
		}
	}
	return false
}

func snapshotHardeningFile(realPath, canonicalPath string) (hardeningFileSnapshot, error) {
	info, err := os.Lstat(realPath)
	if errors.Is(err, os.ErrNotExist) {
		return hardeningFileSnapshot{Path: canonicalPath}, nil
	}
	if err != nil {
		return hardeningFileSnapshot{}, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || stat.Nlink != 1 || info.Size() > 1<<20 {
		return hardeningFileSnapshot{}, fmt.Errorf("Hosting hardening file is unsafe: %s", canonicalPath)
	}
	data, err := os.ReadFile(realPath)
	if err != nil {
		return hardeningFileSnapshot{}, err
	}
	return hardeningFileSnapshot{Path: canonicalPath, Exists: true, Mode: uint32(info.Mode().Perm()), Data: base64.StdEncoding.EncodeToString(data)}, nil
}

func (host LinuxHost) restoreHardeningFiles(snapshot hardeningSnapshot) error {
	var failures []error
	for _, file := range snapshot.Files {
		path := host.path(file.Path)
		if !file.Exists {
			if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
				failures = append(failures, err)
			}
			continue
		}
		data, err := base64.StdEncoding.DecodeString(file.Data)
		if err != nil {
			failures = append(failures, err)
			continue
		}
		failures = append(failures, writeAtomicRootFile(path, data, os.FileMode(file.Mode), uint32(os.Getuid())))
	}
	return errors.Join(failures...)
}

func decodeHardeningSnapshot(encoded string) (hardeningSnapshot, error) {
	if len(encoded) == 0 || len(encoded) > maxOpaqueSnapshot {
		return hardeningSnapshot{}, errors.New("Hosting hardening snapshot is empty or oversized")
	}
	decoder := json.NewDecoder(strings.NewReader(encoded))
	decoder.DisallowUnknownFields()
	var snapshot hardeningSnapshot
	if err := decoder.Decode(&snapshot); err != nil || snapshot.SchemaVersion != hardeningSnapshotSchema ||
		(snapshot.Family != "apt" && snapshot.Family != "rpm") || snapshot.SSHService == "" || snapshot.UpdateTimer == "" || snapshot.NftBinary == "" || len(snapshot.Files) < 5 || len(snapshot.Services) != 4 {
		return hardeningSnapshot{}, errors.Join(err, errors.New("Hosting hardening snapshot is invalid"))
	}
	return snapshot, nil
}
