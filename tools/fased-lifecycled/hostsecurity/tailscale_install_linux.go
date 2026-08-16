package hostsecurity

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strings"
)

const tailscaleInstallSnapshotSchema uint32 = 1

type tailscaleInstallSnapshot struct {
	SchemaVersion  uint32                   `json:"schemaVersion"`
	PackageExisted bool                     `json:"packageExisted"`
	Files          []hardeningFileSnapshot  `json:"files"`
	Service        hardeningServiceSnapshot `json:"service"`
}

func (host LinuxHost) SnapshotTailscaleInstall(ctx context.Context) (string, error) {
	release, err := parseOSRelease(host.path("/etc/os-release"))
	if err != nil {
		return "", err
	}
	paths := []string{}
	switch release["ID"] {
	case "ubuntu", "debian":
		paths = []string{"/usr/share/keyrings/tailscale-archive-keyring.gpg", "/etc/apt/sources.list.d/tailscale.list"}
	case "fedora", "centos", "rhel", "rocky", "almalinux", "ol", "cloudlinux":
		paths = []string{"/etc/yum.repos.d/tailscale.repo"}
	default:
		return "", errors.New("unsupported Hosting distribution for Tailscale transaction")
	}
	_, binaryErr := host.tailscaleBinary()
	snapshot := tailscaleInstallSnapshot{SchemaVersion: tailscaleInstallSnapshotSchema, PackageExisted: binaryErr == nil,
		Service: hardeningServiceSnapshot{Name: "tailscaled.service",
			Enabled: host.commandSucceeds(ctx, "/usr/bin/systemctl", "is-enabled", "--quiet", "tailscaled.service"),
			Active:  host.commandSucceeds(ctx, "/usr/bin/systemctl", "is-active", "--quiet", "tailscaled.service")}}
	for _, path := range paths {
		file, err := snapshotHardeningFile(host.path(path), path)
		if err != nil {
			return "", err
		}
		snapshot.Files = append(snapshot.Files, file)
	}
	data, err := json.Marshal(snapshot)
	if err != nil || len(data) > maxOpaqueSnapshot {
		return "", errors.Join(err, errors.New("Tailscale installation snapshot exceeded its bound"))
	}
	return string(data), nil
}

func (host LinuxHost) RestoreTailscaleInstall(ctx context.Context, encoded string) error {
	snapshot, err := decodeTailscaleInstallSnapshot(encoded)
	if err != nil {
		return err
	}
	var failures []error
	currentActive := host.commandSucceeds(ctx, "/usr/bin/systemctl", "is-active", "--quiet", snapshot.Service.Name)
	if !snapshot.Service.Active && currentActive {
		failures = append(failures, host.run(ctx, "/usr/bin/systemctl", []string{"stop", snapshot.Service.Name}, nil, io.Discard, io.Discard, nil))
	}
	currentEnabled := host.commandSucceeds(ctx, "/usr/bin/systemctl", "is-enabled", "--quiet", snapshot.Service.Name)
	if !snapshot.Service.Enabled && currentEnabled {
		failures = append(failures, host.run(ctx, "/usr/bin/systemctl", []string{"disable", snapshot.Service.Name}, nil, io.Discard, io.Discard, nil))
	}
	if !snapshot.PackageExisted {
		failures = append(failures, host.removeTailscalePackage(ctx))
	}
	for _, file := range snapshot.Files {
		path := host.path(file.Path)
		if !file.Exists {
			if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
				failures = append(failures, err)
			}
			continue
		}
		failures = append(failures, restoreOneHardeningFile(host, file))
	}
	currentEnabled = host.commandSucceeds(ctx, "/usr/bin/systemctl", "is-enabled", "--quiet", snapshot.Service.Name)
	if snapshot.Service.Enabled && !currentEnabled {
		failures = append(failures, host.run(ctx, "/usr/bin/systemctl", []string{"enable", snapshot.Service.Name}, nil, io.Discard, io.Discard, nil))
	}
	currentActive = host.commandSucceeds(ctx, "/usr/bin/systemctl", "is-active", "--quiet", snapshot.Service.Name)
	if snapshot.Service.Active && !currentActive {
		failures = append(failures, host.run(ctx, "/usr/bin/systemctl", []string{"start", snapshot.Service.Name}, nil, io.Discard, io.Discard, nil))
	}
	return errors.Join(failures...)
}

func (host LinuxHost) removeTailscalePackage(ctx context.Context) error {
	release, err := parseOSRelease(host.path("/etc/os-release"))
	if err != nil {
		return err
	}
	var command string
	var args []string
	var environment []string
	switch release["ID"] {
	case "ubuntu", "debian":
		command, err = fixedExecutable("/usr/bin/apt-get", "/bin/apt-get")
		args = []string{"remove", "-y", "tailscale"}
		environment = []string{"DEBIAN_FRONTEND=noninteractive", "NEEDRESTART_MODE=a"}
	case "fedora", "centos", "rhel", "rocky", "almalinux", "ol", "cloudlinux":
		command, err = fixedExecutable("/usr/bin/dnf5", "/usr/bin/dnf", "/usr/bin/yum")
		args = []string{"remove", "-y", "tailscale"}
	default:
		return errors.New("unsupported Hosting distribution for Tailscale package rollback")
	}
	if host.RootPrefix != "" {
		if release["ID"] == "ubuntu" || release["ID"] == "debian" {
			command = "/usr/bin/apt-get"
		} else {
			command = "/usr/bin/dnf"
		}
		err = nil
	}
	if err != nil {
		return err
	}
	if err := host.Runner.Run(ctx, command, args, nil, io.Discard, io.Discard, environment); err != nil {
		return err
	}
	if host.RootPrefix == "" {
		if _, err := host.tailscaleBinary(); err == nil {
			return errors.New("Tailscale package rollback left the CLI installed")
		}
	}
	return nil
}

func restoreOneHardeningFile(host LinuxHost, file hardeningFileSnapshot) error {
	data, err := base64.StdEncoding.DecodeString(file.Data)
	if err != nil {
		return err
	}
	return writeAtomicRootFile(host.path(file.Path), data, os.FileMode(file.Mode), uint32(os.Getuid()))
}

func decodeTailscaleInstallSnapshot(encoded string) (tailscaleInstallSnapshot, error) {
	if len(encoded) == 0 || len(encoded) > maxOpaqueSnapshot {
		return tailscaleInstallSnapshot{}, errors.New("Tailscale installation snapshot is empty or oversized")
	}
	decoder := json.NewDecoder(strings.NewReader(encoded))
	decoder.DisallowUnknownFields()
	var snapshot tailscaleInstallSnapshot
	if err := decoder.Decode(&snapshot); err != nil || snapshot.SchemaVersion != tailscaleInstallSnapshotSchema ||
		snapshot.Service.Name != "tailscaled.service" || len(snapshot.Files) < 1 || len(snapshot.Files) > 2 {
		return tailscaleInstallSnapshot{}, errors.Join(err, errors.New("Tailscale installation snapshot is invalid"))
	}
	allowed := map[string]bool{
		"/usr/share/keyrings/tailscale-archive-keyring.gpg": true,
		"/etc/apt/sources.list.d/tailscale.list":            true,
		"/etc/yum.repos.d/tailscale.repo":                   true,
	}
	seen := map[string]bool{}
	for _, file := range snapshot.Files {
		if !allowed[file.Path] || seen[file.Path] || file.Mode&0o022 != 0 || len(file.Data) > maxOpaqueSnapshot {
			return tailscaleInstallSnapshot{}, errors.New("Tailscale installation snapshot contains an unsafe file")
		}
		seen[file.Path] = true
		if file.Exists {
			if file.Mode == 0 || file.Data == "" {
				return tailscaleInstallSnapshot{}, errors.New("Tailscale installation snapshot lacks existing file data")
			}
			if _, err := base64.StdEncoding.DecodeString(file.Data); err != nil {
				return tailscaleInstallSnapshot{}, errors.New("Tailscale installation snapshot data is invalid")
			}
		}
	}
	apt := seen["/usr/share/keyrings/tailscale-archive-keyring.gpg"] && seen["/etc/apt/sources.list.d/tailscale.list"] && len(seen) == 2
	rpm := seen["/etc/yum.repos.d/tailscale.repo"] && len(seen) == 1
	if !apt && !rpm {
		return tailscaleInstallSnapshot{}, errors.New("Tailscale installation snapshot has an invalid platform file set")
	}
	return snapshot, nil
}
