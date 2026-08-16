package hostsecurity

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type LinuxHost struct {
	Runner     Runner
	HTTPClient *http.Client
	RootPrefix string
}

type tailscaleStatus struct {
	BackendState string `json:"BackendState"`
	Self         struct {
		DNSName      string   `json:"DNSName"`
		TailscaleIPs []string `json:"TailscaleIPs"`
	} `json:"Self"`
}

func NewLinuxHost() LinuxHost {
	return LinuxHost{Runner: CommandRunner{}, HTTPClient: &http.Client{
		Timeout: 20 * time.Second,
		CheckRedirect: func(request *http.Request, via []*http.Request) error {
			if len(via) > 2 || request.URL.Scheme != "https" || len(via) == 0 || request.URL.Hostname() != via[0].URL.Hostname() {
				return errors.New("Hosting prerequisite download redirect is unsafe")
			}
			return nil
		},
	}}
}

func (host LinuxHost) validate() error {
	if host.Runner == nil || host.HTTPClient == nil {
		return errors.New("Linux Hosting security adapter is incomplete")
	}
	if host.RootPrefix != "" && (!filepath.IsAbs(host.RootPrefix) || filepath.Clean(host.RootPrefix) != host.RootPrefix || host.RootPrefix == "/") {
		return errors.New("Linux Hosting security test root is unsafe")
	}
	return nil
}

func (host LinuxHost) path(path string) string {
	if host.RootPrefix == "" {
		return path
	}
	return filepath.Join(host.RootPrefix, strings.TrimPrefix(path, "/"))
}

func (host LinuxHost) tailscaleBinary() (string, error) {
	if host.RootPrefix != "" {
		for _, path := range []string{"/usr/bin/tailscale", "/bin/tailscale"} {
			candidate := host.path(path)
			if info, err := os.Lstat(candidate); err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0o111 != 0 {
				return path, nil
			}
		}
		return "", errors.New("Tailscale is unavailable")
	}
	return fixedExecutable("/usr/bin/tailscale", "/bin/tailscale")
}

func (host LinuxHost) Inspect(ctx context.Context, port uint16, operator string) (Inspection, error) {
	if err := host.validate(); err != nil || port == 0 || !accountPattern.MatchString(operator) {
		return Inspection{}, errors.Join(err, errors.New("Linux Hosting inspection input is invalid"))
	}
	inspection := Inspection{}
	tailscale, err := host.tailscaleBinary()
	if err != nil {
		return inspection, nil
	}
	inspection.TailscaleInstalled = true
	statusJSON, statusErr := host.Runner.Output(ctx, tailscale, "status", "--json")
	if statusErr == nil {
		var status tailscaleStatus
		if json.Unmarshal(statusJSON, &status) == nil && status.BackendState == "Running" {
			inspection.TailscaleRunning = true
			inspection.TailscaleDNS = strings.TrimSuffix(strings.ToLower(strings.TrimSpace(status.Self.DNSName)), ".")
			for _, value := range status.Self.TailscaleIPs {
				if ipv4Pattern.MatchString(value) {
					inspection.TailscaleIPv4 = value
					break
				}
			}
			inspection.Authenticated = validDNS(inspection.TailscaleDNS) && inspection.TailscaleIPv4 != ""
		}
	}
	if version, versionErr := host.Runner.Output(ctx, tailscale, "version"); versionErr == nil {
		first, _, _ := strings.Cut(strings.TrimSpace(string(version)), "\n")
		first = strings.TrimSpace(first)
		if versionPattern.MatchString(first) {
			inspection.TailscaleVersion = first
		}
	}
	serve, serveErr := host.Runner.Output(ctx, tailscale, "serve", "status", "--json")
	if serveErr == nil && !containsPublicFunnel(serve) && serveTargetsLoopback(serve, port) {
		inspection.PrivateServeReady = true
	}
	inspection.SignerReady = host.commandSucceeds(ctx, "/usr/bin/systemctl", "is-active", "--quiet", "fased-signerd.service")
	inspection.AppCanElevate = host.commandSucceeds(ctx, "/usr/sbin/runuser", "-u", operator, "--", "/usr/bin/sudo", "-n", "true")
	inspection.HardeningReady = host.hardeningReady(ctx)
	inspection.SignerWebAuthnReady = host.signerWebAuthnReady(inspection.TailscaleDNS)
	if !inspection.HardeningReady {
		inspection.LegacyHardeningReady = host.legacyHardeningReady(ctx, inspection, port)
	}
	return inspection, nil
}

func containsPublicFunnel(data []byte) bool {
	var value any
	if json.Unmarshal(data, &value) != nil {
		return true
	}
	var visit func(any) bool
	visit = func(item any) bool {
		switch typed := item.(type) {
		case map[string]any:
			for key, child := range typed {
				if strings.EqualFold(key, "AllowFunnel") && child == true {
					return true
				}
				if visit(child) {
					return true
				}
			}
		case []any:
			for _, child := range typed {
				if visit(child) {
					return true
				}
			}
		}
		return false
	}
	return visit(value)
}

func serveTargetsLoopback(data []byte, port uint16) bool {
	needle := "http://127.0.0.1:" + strconv.Itoa(int(port))
	return bytes.Contains(data, []byte(needle))
}

func serveSnapshotHasNoRoutes(data string) bool {
	var root map[string]any
	if json.Unmarshal([]byte(data), &root) != nil {
		return false
	}
	delete(root, "version")
	delete(root, "Version")
	return emptyJSONContainer(root)
}

func emptyJSONContainer(value any) bool {
	switch typed := value.(type) {
	case nil:
		return true
	case map[string]any:
		for _, child := range typed {
			if !emptyJSONContainer(child) {
				return false
			}
		}
		return true
	case []any:
		for _, child := range typed {
			if !emptyJSONContainer(child) {
				return false
			}
		}
		return true
	default:
		return false
	}
}

func (host LinuxHost) commandSucceeds(ctx context.Context, command string, args ...string) bool {
	if host.RootPrefix != "" {
		// Fixture runners bind fixed logical command paths themselves.
		_, err := host.Runner.Output(ctx, command, args...)
		return err == nil
	}
	if _, err := os.Lstat(command); err != nil {
		return false
	}
	_, err := host.Runner.Output(ctx, command, args...)
	return err == nil
}

func (host LinuxHost) InstallTailscale(ctx context.Context, log io.Writer) error {
	if err := host.validate(); err != nil {
		return err
	}
	if _, err := host.tailscaleBinary(); err == nil {
		return nil
	}
	osRelease, err := parseOSRelease(host.path("/etc/os-release"))
	if err != nil {
		return err
	}
	switch osRelease["ID"] {
	case "ubuntu", "debian":
		return host.installTailscaleAPT(ctx, osRelease, log)
	case "fedora", "centos", "rhel", "rocky", "almalinux", "ol", "cloudlinux":
		return host.installTailscaleRPM(ctx, osRelease, log)
	default:
		return fmt.Errorf("unsupported Hosting distribution %q", osRelease["ID"])
	}
}

func (host LinuxHost) installTailscaleAPT(ctx context.Context, release map[string]string, log io.Writer) error {
	distro := release["ID"]
	codename := release["VERSION_CODENAME"]
	if codename == "" {
		codename = release["UBUNTU_CODENAME"]
	}
	if !regexp.MustCompile(`^[a-z0-9][a-z0-9.-]*$`).MatchString(codename) {
		return errors.New("Ubuntu or Debian codename is invalid")
	}
	base := "https://pkgs.tailscale.com/stable/" + distro + "/" + codename
	key, err := host.fetch(ctx, base+".noarmor.gpg", 1<<20)
	if err != nil || len(key) == 0 {
		return errors.Join(err, errors.New("Tailscale apt signing key is unavailable"))
	}
	list, err := host.fetch(ctx, base+".tailscale-keyring.list", 4096)
	if err != nil {
		return err
	}
	keyring := "/usr/share/keyrings/tailscale-archive-keyring.gpg"
	want := fmt.Sprintf("deb [signed-by=%s] https://pkgs.tailscale.com/stable/%s %s main", keyring, distro, codename)
	if normalizedRepositoryLine(string(list)) != want {
		return errors.New("Tailscale apt repository definition differs from the bounded official route")
	}
	if err := writeAtomicRootFile(host.path(keyring), key, 0o644, uint32(os.Getuid())); err != nil {
		return err
	}
	listPath := "/etc/apt/sources.list.d/tailscale.list"
	if err := writeAtomicRootFile(host.path(listPath), []byte(want+"\n"), 0o644, uint32(os.Getuid())); err != nil {
		return err
	}
	apt, err := fixedExecutable("/usr/bin/apt-get", "/bin/apt-get")
	if host.RootPrefix != "" {
		apt = "/usr/bin/apt-get"
		err = nil
	}
	if err != nil {
		return err
	}
	environment := []string{"DEBIAN_FRONTEND=noninteractive", "NEEDRESTART_MODE=a"}
	if err := host.Runner.Run(ctx, apt, []string{"-o", "Dir::Etc::sourcelist=" + listPath, "-o", "Dir::Etc::sourceparts=-", "-o", "Acquire::AllowInsecureRepositories=false", "-o", "Acquire::AllowDowngradeToInsecureRepositories=false", "-o", "APT::Get::AllowUnauthenticated=false", "update"}, nil, log, log, environment); err != nil {
		return err
	}
	return host.Runner.Run(ctx, apt, []string{"-o", "APT::Get::AllowUnauthenticated=false", "install", "-y", "--no-install-recommends", "tailscale"}, nil, log, log, environment)
}

func (host LinuxHost) installTailscaleRPM(ctx context.Context, release map[string]string, log io.Writer) error {
	distro := release["ID"]
	major := strings.Split(release["VERSION_ID"], ".")[0]
	repositoryPath := ""
	switch distro {
	case "fedora":
		repositoryPath = "fedora"
	case "centos":
		repositoryPath = "centos/" + major
	default:
		repositoryPath = "rhel/" + major
	}
	if distro != "fedora" && !regexp.MustCompile(`^[0-9]+$`).MatchString(major) {
		return errors.New("RPM-family major version is invalid")
	}
	want := fmt.Sprintf("[tailscale-stable]\nname=Tailscale stable\nbaseurl=https://pkgs.tailscale.com/stable/%s/$basearch\nenabled=1\ntype=rpm\nrepo_gpgcheck=1\ngpgcheck=1\ngpgkey=https://pkgs.tailscale.com/stable/%s/repo.gpg\n", repositoryPath, repositoryPath)
	data, err := host.fetch(ctx, "https://pkgs.tailscale.com/stable/"+repositoryPath+"/tailscale.repo", 16<<10)
	if err != nil || string(data) != want {
		return errors.Join(err, errors.New("Tailscale RPM repository definition differs from the bounded official route"))
	}
	if err := writeAtomicRootFile(host.path("/etc/yum.repos.d/tailscale.repo"), data, 0o644, uint32(os.Getuid())); err != nil {
		return err
	}
	manager, err := fixedExecutable("/usr/bin/dnf5", "/usr/bin/dnf", "/usr/bin/yum")
	if host.RootPrefix != "" {
		manager = "/usr/bin/dnf"
		err = nil
	}
	if err != nil {
		return err
	}
	return host.Runner.Run(ctx, manager, []string{"install", "-y", "--setopt=tailscale-stable.gpgcheck=1", "--setopt=tailscale-stable.repo_gpgcheck=1", "tailscale"}, nil, log, log, nil)
}

func (host LinuxHost) EnableTailscale(ctx context.Context) error {
	return host.run(ctx, "/usr/bin/systemctl", []string{"enable", "--now", "tailscaled.service"}, nil, io.Discard, io.Discard, nil)
}

func (host LinuxHost) Authenticate(ctx context.Context, authKeyFile string, interactive bool, output io.Writer) error {
	tailscale, err := host.tailscaleBinary()
	if err != nil {
		return err
	}
	args := []string{"up", "--ssh"}
	if authKeyFile != "" {
		if err := validateAuthKeyFile(host.path(authKeyFile), uint32(os.Getuid())); err != nil {
			return err
		}
		args = append(args, "--auth-key=file:"+authKeyFile)
	} else if !interactive {
		return errors.New("non-interactive Hosting authentication requires a root-owned auth-key file")
	}
	return host.Runner.Run(ctx, tailscale, args, nil, output, output, nil)
}

func (host LinuxHost) SnapshotPrivateServe(ctx context.Context) (string, error) {
	tailscale, err := host.tailscaleBinary()
	if err != nil {
		return "", err
	}
	previous, previousErr := host.Runner.Output(ctx, tailscale, "serve", "get-config", "--all")
	if previousErr != nil {
		previous = nil
	}
	if len(bytes.TrimSpace(previous)) > 0 && containsPublicFunnel(previous) {
		return "", errors.New("existing Tailscale Serve configuration enables Funnel")
	}
	if len(previous) > maxOpaqueSnapshot {
		return "", errors.New("existing Tailscale Serve configuration exceeds its rollback bound")
	}
	return string(previous), nil
}

func (host LinuxHost) ConfigurePrivateServe(ctx context.Context, port uint16) error {
	tailscale, err := host.tailscaleBinary()
	if err != nil {
		return err
	}
	target := "http://127.0.0.1:" + strconv.Itoa(int(port))
	if err := host.Runner.Run(ctx, tailscale, []string{"serve", "--bg", "--yes", target}, nil, io.Discard, io.Discard, nil); err != nil {
		return err
	}
	return nil
}

func (host LinuxHost) RestorePrivateServe(ctx context.Context, previous string) error {
	tailscale, err := host.tailscaleBinary()
	if err != nil {
		return err
	}
	if strings.TrimSpace(previous) == "" || serveSnapshotHasNoRoutes(previous) {
		return host.Runner.Run(ctx, tailscale, []string{"serve", "reset"}, nil, io.Discard, io.Discard, nil)
	}
	temporary, err := os.CreateTemp("", "fased-tailscale-serve-*.json")
	if err != nil {
		return err
	}
	path := temporary.Name()
	defer os.Remove(path)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.WriteString(previous); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return host.Runner.Run(ctx, tailscale, []string{"serve", "set-config", path, "--all"}, nil, io.Discard, io.Discard, nil)
}

func (host LinuxHost) LogoutTailscale(ctx context.Context) error {
	tailscale, err := host.tailscaleBinary()
	if err != nil {
		return nil
	}
	return host.Runner.Run(ctx, tailscale, []string{"logout"}, nil, io.Discard, io.Discard, nil)
}

func (host LinuxHost) fetch(ctx context.Context, rawURL string, limit int64) ([]byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil || request.URL.Scheme != "https" || request.URL.Hostname() != "pkgs.tailscale.com" {
		return nil, errors.New("Hosting prerequisite URL is outside the bounded vendor route")
	}
	response, err := host.HTTPClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || response.ContentLength > limit {
		return nil, errors.New("Hosting prerequisite download returned an invalid response")
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil || len(data) == 0 || int64(len(data)) > limit {
		return nil, errors.Join(err, errors.New("Hosting prerequisite download is empty or oversized"))
	}
	return data, nil
}

func parseOSRelease(path string) (map[string]string, error) {
	data, err := os.ReadFile(path)
	if err != nil || len(data) == 0 || len(data) > 64<<10 {
		return nil, errors.Join(err, errors.New("Hosting operating-system identity is unavailable"))
	}
	values := map[string]string{}
	for _, line := range strings.Split(string(data), "\n") {
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, found := strings.Cut(line, "=")
		if !found || !regexp.MustCompile(`^[A-Z][A-Z0-9_]*$`).MatchString(key) {
			return nil, errors.New("Hosting operating-system identity is malformed")
		}
		value = strings.Trim(value, `"'`)
		if strings.ContainsAny(value, "\x00\r\n") || len(value) > 256 {
			return nil, errors.New("Hosting operating-system identity contains an invalid value")
		}
		values[key] = strings.ToLower(value)
	}
	if values["ID"] == "" {
		return nil, errors.New("Hosting operating-system identity lacks ID")
	}
	return values, nil
}

func normalizedRepositoryLine(value string) string {
	lines := []string{}
	for _, line := range strings.Split(value, "\n") {
		line = strings.TrimSpace(strings.SplitN(line, "#", 2)[0])
		if line != "" {
			lines = append(lines, strings.Join(strings.Fields(line), " "))
		}
	}
	return strings.Join(lines, "\n")
}

var authKeyPattern = regexp.MustCompile(`^tskey-auth-[A-Za-z0-9_-]+\n?$`)

func validateAuthKeyFile(path string, uid uint32) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || stat.Uid != uid || stat.Nlink != 1 || info.Mode().Perm()&0o077 != 0 || info.Mode().Perm()&0o400 == 0 || info.Size() <= 0 || info.Size() > 4096 {
		return errors.New("Tailscale auth-key file is unsafe")
	}
	data, err := os.ReadFile(path)
	if err != nil || !authKeyPattern.Match(data) {
		return errors.New("Tailscale auth-key file has invalid contents")
	}
	return nil
}

func (host LinuxHost) run(ctx context.Context, command string, args []string, stdin io.Reader, stdout, stderr io.Writer, environment []string) error {
	if host.RootPrefix == "" {
		if _, err := fixedExecutable(command); err != nil {
			return err
		}
	}
	return host.Runner.Run(ctx, command, args, stdin, stdout, stderr, environment)
}
