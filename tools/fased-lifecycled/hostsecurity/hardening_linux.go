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
	"os/exec"
	"strings"
	"syscall"
	"time"
)

const (
	hardeningSnapshotSchema     uint32 = 3
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

type hardeningPackageSnapshot struct {
	Name      string `json:"name"`
	Installed bool   `json:"installed"`
}

type hardeningSnapshot struct {
	SchemaVersion uint32                     `json:"schemaVersion"`
	Family        string                     `json:"family"`
	SSHService    string                     `json:"sshService"`
	UpdateTimer   string                     `json:"updateTimer"`
	NftBinary     string                     `json:"nftBinary"`
	Packages      []hardeningPackageSnapshot `json:"packages"`
	Files         []hardeningFileSnapshot    `json:"files"`
	Services      []hardeningServiceSnapshot `json:"services"`
}

func (host LinuxHost) SnapshotHardening(ctx context.Context, operator string, _ io.Writer) (string, error) {
	if err := host.validate(); err != nil || !accountPattern.MatchString(operator) {
		return "", errors.Join(err, errors.New("Hosting hardening stage input is invalid"))
	}
	release, err := parseOSRelease(host.path("/etc/os-release"))
	if err != nil {
		return "", err
	}
	family, timer, packageNames, err := hardeningPackagePlan(release)
	if err != nil {
		return "", err
	}
	nftBinary := "/usr/sbin/nft"
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
	for _, name := range packageNames {
		installed, err := host.hardeningPackageInstalled(ctx, family, name)
		if err != nil {
			return "", err
		}
		snapshot.Packages = append(snapshot.Packages, hardeningPackageSnapshot{Name: name, Installed: installed})
	}
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
	if err := host.installHardeningPackages(ctx, snapshot, log); err != nil {
		return err
	}
	nftBinary, err := fixedExecutable(snapshot.NftBinary)
	if host.RootPrefix != "" {
		nftBinary, err = snapshot.NftBinary, nil
	}
	if err != nil || nftBinary != snapshot.NftBinary {
		return errors.Join(err, errors.New("installed nft executable differs from the snapshotted Hosting path"))
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
	failures = append(failures, host.restoreHardeningPackages(ctx, snapshot))
	return errors.Join(failures...)
}

func (host LinuxHost) hardeningReady(ctx context.Context) bool {
	if !host.aclToolsReady() {
		return false
	}
	nftBinary, err := fixedExecutable("/usr/sbin/nft", "/usr/bin/nft", "/sbin/nft")
	if host.RootPrefix != "" {
		nftBinary, err = "/usr/sbin/nft", nil
	}
	if err != nil {
		return false
	}
	table, err := host.Runner.Output(ctx, nftBinary, "list", "table", "inet", "fased_hosting")
	if err != nil || !bytes.Contains(table, []byte("policy drop")) ||
		!bytes.Contains(table, []byte("ct state established,related accept")) ||
		!bytes.Contains(table, []byte(`iifname "lo" accept`)) ||
		!bytes.Contains(table, []byte(`iifname "tailscale0" tcp dport { 22, 443 } accept`)) {
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

func (host LinuxHost) aclToolsReady() bool {
	for _, candidates := range [][]string{{"/usr/bin/getfacl", "/bin/getfacl"}, {"/usr/bin/setfacl", "/bin/setfacl"}} {
		if host.RootPrefix == "" {
			if _, err := fixedExecutable(candidates...); err != nil {
				return false
			}
			continue
		}
		found := false
		for _, candidate := range candidates {
			info, err := os.Lstat(host.path(candidate))
			if err == nil && info.Mode().IsRegular() && info.Mode()&os.ModeSymlink == 0 && info.Mode().Perm()&0o111 != 0 {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

func hardeningPackagePlan(release map[string]string) (family, timer string, packages []string, err error) {
	switch release["ID"] {
	case "ubuntu", "debian":
		return "apt", "apt-daily-upgrade.timer", []string{"nftables", "fail2ban", "unattended-upgrades", "acl"}, nil
	case "fedora":
		return "rpm", "dnf-automatic-install.timer", []string{"nftables", "fail2ban", "dnf-automatic", "acl"}, nil
	case "centos", "rhel", "rocky", "almalinux", "ol", "cloudlinux":
		return "rpm", "dnf-automatic-install.timer", []string{"epel-release", "nftables", "fail2ban", "dnf-automatic", "acl"}, nil
	default:
		return "", "", nil, errors.New("unsupported Hosting distribution for hardening")
	}
}

func (host LinuxHost) hardeningPackageInstalled(ctx context.Context, family, name string) (bool, error) {
	var command string
	var args []string
	var err error
	switch family {
	case "apt":
		command, err = fixedExecutable("/usr/bin/dpkg-query", "/bin/dpkg-query")
		args = []string{"--show", "--showformat=${db:Status-Abbrev}", name}
	case "rpm":
		command, err = fixedExecutable("/usr/bin/rpm", "/bin/rpm")
		args = []string{"-q", "--quiet", name}
	default:
		return false, errors.New("unsupported Hosting hardening package family")
	}
	if host.RootPrefix != "" {
		if family == "apt" {
			command = "/usr/bin/dpkg-query"
		} else {
			command = "/usr/bin/rpm"
		}
		err = nil
	}
	if err != nil {
		return false, err
	}
	output, outputErr := host.Runner.Output(ctx, command, args...)
	if outputErr != nil {
		if host.RootPrefix == "" {
			var exitError *exec.ExitError
			if !errors.As(outputErr, &exitError) {
				return false, outputErr
			}
		}
		return false, nil
	}
	if family == "apt" && strings.TrimSpace(string(output)) != "ii" {
		return false, errors.New("dpkg returned an ambiguous installed-package status")
	}
	return true, nil
}

func (host LinuxHost) installHardeningPackages(ctx context.Context, snapshot hardeningSnapshot, log io.Writer) error {
	packageNames := make([]string, 0, len(snapshot.Packages))
	for _, item := range snapshot.Packages {
		packageNames = append(packageNames, item.Name)
	}
	switch snapshot.Family {
	case "apt":
		apt, findErr := fixedExecutable("/usr/bin/apt-get", "/bin/apt-get")
		if host.RootPrefix != "" {
			apt, findErr = "/usr/bin/apt-get", nil
		}
		if findErr != nil {
			return findErr
		}
		env := []string{"DEBIAN_FRONTEND=noninteractive", "NEEDRESTART_MODE=a"}
		if err := host.Runner.Run(ctx, apt, []string{"update"}, nil, log, log, env); err != nil {
			return err
		}
		if err := host.Runner.Run(ctx, apt, append([]string{"install", "-y", "--no-install-recommends"}, packageNames...), nil, log, log, env); err != nil {
			return err
		}
		return nil
	case "rpm":
		manager, findErr := fixedExecutable("/usr/bin/dnf5", "/usr/bin/dnf", "/usr/bin/yum")
		if host.RootPrefix != "" {
			manager, findErr = "/usr/bin/dnf", nil
		}
		if findErr != nil {
			return findErr
		}
		if err := host.Runner.Run(ctx, manager, append([]string{"install", "-y"}, packageNames...), nil, log, log, nil); err != nil {
			return err
		}
		return nil
	default:
		return errors.New("unsupported Hosting distribution for hardening")
	}
}

func (host LinuxHost) restoreHardeningPackages(ctx context.Context, snapshot hardeningSnapshot) error {
	remove := make([]string, 0, len(snapshot.Packages))
	for _, item := range snapshot.Packages {
		if !item.Installed {
			remove = append(remove, item.Name)
		}
	}
	if len(remove) == 0 {
		return nil
	}
	var command string
	var args []string
	var environment []string
	var err error
	if snapshot.Family == "apt" {
		command, err = fixedExecutable("/usr/bin/apt-get", "/bin/apt-get")
		args = append([]string{"remove", "-y"}, remove...)
		environment = []string{"DEBIAN_FRONTEND=noninteractive", "NEEDRESTART_MODE=a"}
	} else {
		command, err = fixedExecutable("/usr/bin/dnf5", "/usr/bin/dnf", "/usr/bin/yum")
		args = append([]string{"remove", "-y"}, remove...)
	}
	if host.RootPrefix != "" {
		if snapshot.Family == "apt" {
			command = "/usr/bin/apt-get"
		} else {
			command = "/usr/bin/dnf"
		}
		err = nil
	}
	if err != nil {
		return err
	}
	return host.Runner.Run(ctx, command, args, nil, io.Discard, io.Discard, environment)
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
    type filter hook input priority -10; policy drop;
    ct state established,related accept
    iifname "lo" accept
    iifname "tailscale0" tcp dport { 22, 443 } accept
    ip protocol icmp accept
    ip6 nexthdr ipv6-icmp accept
    udp sport 67 udp dport 68 accept
    udp sport 547 udp dport 546 accept
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
	if err := decoder.Decode(&snapshot); err != nil || (snapshot.SchemaVersion != 2 && snapshot.SchemaVersion != hardeningSnapshotSchema) ||
		(snapshot.Family != "apt" && snapshot.Family != "rpm") || snapshot.SSHService == "" || snapshot.UpdateTimer == "" || snapshot.NftBinary != "/usr/sbin/nft" || len(snapshot.Files) < 5 || len(snapshot.Services) != 4 {
		return hardeningSnapshot{}, errors.Join(err, errors.New("Hosting hardening snapshot is invalid"))
	}
	wantPackages := map[string]bool{"nftables": true, "fail2ban": true}
	if snapshot.SchemaVersion >= 3 {
		wantPackages["acl"] = true
	}
	if snapshot.Family == "apt" {
		wantPackages["unattended-upgrades"] = true
		wantCount := 3
		if snapshot.SchemaVersion >= 3 {
			wantCount++
		}
		if snapshot.UpdateTimer != "apt-daily-upgrade.timer" || len(snapshot.Packages) != wantCount {
			return hardeningSnapshot{}, errors.New("Hosting apt hardening snapshot is invalid")
		}
	} else {
		wantPackages["dnf-automatic"] = true
		wantPackages["epel-release"] = true
		minimum, maximum := 3, 4
		if snapshot.SchemaVersion >= 3 {
			minimum, maximum = 4, 5
		}
		if snapshot.UpdateTimer != "dnf-automatic-install.timer" || (len(snapshot.Packages) != minimum && len(snapshot.Packages) != maximum) {
			return hardeningSnapshot{}, errors.New("Hosting rpm hardening snapshot is invalid")
		}
	}
	seenPackages := map[string]bool{}
	for _, item := range snapshot.Packages {
		if !wantPackages[item.Name] || seenPackages[item.Name] {
			return hardeningSnapshot{}, errors.New("Hosting hardening snapshot contains an unsafe package set")
		}
		seenPackages[item.Name] = true
	}
	if !seenPackages["nftables"] || !seenPackages["fail2ban"] ||
		(snapshot.SchemaVersion >= 3 && !seenPackages["acl"]) ||
		(snapshot.Family == "apt" && (!seenPackages["unattended-upgrades"] || len(seenPackages) != len(wantPackages))) ||
		(snapshot.Family == "rpm" && (!seenPackages["dnf-automatic"] || len(seenPackages) < len(wantPackages)-1)) {
		return hardeningSnapshot{}, errors.New("Hosting hardening snapshot lacks required packages")
	}
	return snapshot, nil
}
