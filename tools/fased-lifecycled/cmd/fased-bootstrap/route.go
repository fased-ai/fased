package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"fased-lifecycled/model"
	"fased-lifecycled/platform"
	"fased-lifecycled/protocol"
	"fased-lifecycled/trust"
)

const (
	productionReleaseBase            = "https://github.com/fased-ai/fased/releases/download"
	releaseRootAssetName             = "fased-lifecycle-root-v1.json"
	releaseIndexAssetName            = "fased-release-index-v1.json"
	releaseIndexAttestationAssetName = "fased-release-index-v1.json.attestation.json"
)

type publicReleaseRoute struct {
	RootURL, IndexURL, IndexAttestationURL, ReleaseBaseURL, PinnedRootSHA256 string
	VerifyIndex                                                              releaseIndexVerifier
}

type publicLifecycleRequest struct {
	Operation    string
	Profile      model.Profile
	Channel      string
	Version      string
	OperatorUser string
	GatewayPort  uint16
	Verbose      bool
	JSON         bool
	Onboard      bool
	OnboardArgs  []string
}

func runPublicLifecycle(operation string, args []string, output io.Writer) error {
	request, err := parsePublicLifecycleRequest(operation, args)
	if err != nil {
		return err
	}
	if os.Geteuid() != 0 {
		return errors.New("public lifecycle operation requires root authorization")
	}
	operator, err := resolveOperator(request.OperatorUser, request.Profile)
	if err != nil {
		return err
	}
	ownerConfigExisted, err := pathExists(filepath.Join(operator.Home, ".fased", "fased.json"))
	if err != nil {
		return fmt.Errorf("inspect owner configuration: %w", err)
	}
	if request.Operation == "update" {
		configPath, configErr := installedConfigPath(request.Profile, operator)
		if configErr != nil {
			return configErr
		}
		configData, readErr := os.ReadFile(configPath)
		if readErr != nil {
			return errors.New("installed lifecycle platform configuration is unavailable")
		}
		config, decodeErr := platform.DecodeConfig(configData)
		if decodeErr != nil {
			return fmt.Errorf("installed lifecycle platform configuration is invalid: %w", decodeErr)
		}
		if bindErr := bindInstalledUpdatePlatform(&request, operator, config); bindErr != nil {
			return bindErr
		}
	}
	releaseRoute, err := publicTrustRoute(request.Version)
	if err != nil {
		return err
	}
	bootstrap := bootstrapRequest{
		StateRoot: "/var/lib/fased-bootstrap", HostRoot: "/opt/fased/lifecycle",
		RootURL: releaseRoute.RootURL, IndexURL: releaseRoute.IndexURL,
		IndexAttestationURL: releaseRoute.IndexAttestationURL, ReleaseBaseURL: releaseRoute.ReleaseBaseURL,
		Channel: request.Channel, Version: request.Version, Architecture: architecture(),
		PinnedRootSHA256: releaseRoute.PinnedRootSHA256, OwnerUID: 0, Now: time.Now().UTC(), Inspect: inspectLifecycleHost,
		VerifyIndex: releaseRoute.VerifyIndex,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Minute)
	defer cancel()
	result, err := execute(ctx, bootstrap)
	if err != nil {
		return err
	}
	convergence, err := invokeLifecycleHost(ctx, request, operator, result, output)
	if err != nil {
		return err
	}
	outcome := convergence.Outcome
	if shouldRunOnboarding(request, outcome, ownerConfigExisted) {
		convergence, err = runOnboarding(ctx, request, operator, result)
		if err != nil {
			return err
		}
		outcome = convergence.Outcome
	}
	if request.JSON {
		_, err = fmt.Fprintf(output, "{\"status\":%q,\"version\":%q,\"releaseSequence\":%d,\"securityEpoch\":%d,\"activeGenerationId\":%q,\"convergenceReceiptDigest\":%q}\n", outcome, result.Version, result.ReleaseSequence, result.SecurityEpoch, convergence.ActiveGenerationID, convergence.ConvergenceReceiptDigest)
	} else if outcome == "ALREADY_CURRENT" {
		_, err = fmt.Fprintf(output, "Already current: %s\n", result.Version)
	} else {
		_, err = fmt.Fprintf(output, "Updated successfully: %s\n", result.Version)
	}
	return err
}

func pathExists(path string) (bool, error) {
	_, err := os.Lstat(path)
	if err == nil {
		return true, nil
	}
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return false, err
}

func shouldRunOnboarding(request publicLifecycleRequest, outcome string, ownerConfigExisted bool) bool {
	return request.Operation == "install" && request.Onboard && !ownerConfigExisted && outcome != "ALREADY_CURRENT"
}

func publicTrustRoute(version string) (publicReleaseRoute, error) {
	if err := model.ValidateVersion(version); err != nil {
		return publicReleaseRoute{}, errors.New("public lifecycle operation requires an exact immutable version")
	}
	expectedBase := productionReleaseBase + "/v" + version
	base, pin := expectedBase, productionPinnedRootSHA256
	if branchFixtureMetadataBase == "" && branchFixturePinnedRootSHA256 == "" {
		return immutableReleaseRoute(base, pin), nil
	}
	if branchFixtureMetadataBase == "" || branchFixturePinnedRootSHA256 == "" {
		return publicReleaseRoute{}, errors.New("branch fixture trust route is incomplete")
	}
	if branchFixtureMetadataBase != expectedBase || len(branchFixturePinnedRootSHA256) != 64 {
		return publicReleaseRoute{}, errors.New("branch fixture trust route is malformed")
	}
	route := immutableReleaseRoute(branchFixtureMetadataBase, branchFixturePinnedRootSHA256)
	// Branch proof binaries are explicitly non-publishable. Their third fetched
	// trust object is a root-signed delegation rather than a GitHub attestation,
	// allowing exact unpublished bytes to be exercised without weakening the
	// ordinary production verifier.
	route.VerifyIndex = verifyDelegatedBranchReleaseIndex
	return route, nil
}

func verifyDelegatedBranchReleaseIndex(root trust.VerifiedRoot, indexJSON, delegationJSON []byte, now time.Time) (bootstrapVerifiedReleaseIndex, error) {
	delegation, err := trust.VerifyDelegation(root, delegationJSON, now)
	if err != nil {
		return bootstrapVerifiedReleaseIndex{}, err
	}
	verified, err := trust.VerifyReleaseIndex(delegation, indexJSON, now)
	if err != nil {
		return bootstrapVerifiedReleaseIndex{}, err
	}
	return bootstrapVerifiedReleaseIndex{
		Index: verified.Index(), Digest: verified.Digest(),
		ReleaseAuthorityDigest: verified.ReleaseAuthorityDigest(),
	}, nil
}

func immutableReleaseRoute(base, pin string) publicReleaseRoute {
	return publicReleaseRoute{
		RootURL:             base + "/" + releaseRootAssetName,
		IndexURL:            base + "/" + releaseIndexAssetName,
		IndexAttestationURL: base + "/" + releaseIndexAttestationAssetName,
		ReleaseBaseURL:      base, PinnedRootSHA256: pin,
	}
}

func parsePublicLifecycleRequest(operation string, args []string) (publicLifecycleRequest, error) {
	if operation != "install" && operation != "update" {
		return publicLifecycleRequest{}, errors.New("unsupported public lifecycle operation")
	}
	flags := flag.NewFlagSet(operation, flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	profile := ""
	gatewayPort := uint64(0)
	request := publicLifecycleRequest{Operation: operation, Channel: "stable", Onboard: operation == "install"}
	flags.StringVar(&profile, "profile", "", "")
	flags.StringVar(&request.Channel, "channel", "stable", "")
	flags.StringVar(&request.Channel, "update-channel", "stable", "")
	flags.StringVar(&request.Version, "version", "", "")
	flags.StringVar(&request.Version, "tag", "", "")
	flags.StringVar(&request.OperatorUser, "operator-user", "", "")
	flags.Uint64Var(&gatewayPort, "gateway-port", 0, "")
	flags.BoolVar(&request.Verbose, "verbose", false, "")
	flags.BoolVar(&request.JSON, "json", false, "")
	noOnboard := flags.Bool("no-onboard", false, "")
	if err := flags.Parse(args); err != nil {
		return publicLifecycleRequest{}, errors.New("invalid public lifecycle arguments")
	}
	gatewayPortSet := false
	flags.Visit(func(candidate *flag.Flag) {
		if candidate.Name == "gateway-port" {
			gatewayPortSet = true
		}
	})
	remaining := flags.Args()
	if len(remaining) > 0 && remaining[0] == "--" {
		remaining = remaining[1:]
	}
	if operation == "update" && len(remaining) != 0 {
		return publicLifecycleRequest{}, errors.New("update does not accept onboarding arguments")
	}
	request.OnboardArgs = append([]string(nil), remaining...)
	request.Onboard = request.Onboard && !*noOnboard
	request.Version = strings.TrimPrefix(request.Version, "v")
	if profile == "" {
		profile = inferProfile(request.OperatorUser)
	}
	request.Profile = model.Profile(profile)
	if request.Profile != model.ProfileProtectedLocal && request.Profile != model.ProfileHosting {
		return publicLifecycleRequest{}, errors.New("profile must be protected-local or hosting")
	}
	if request.Channel != "stable" && request.Channel != "beta" {
		return publicLifecycleRequest{}, errors.New("channel must be stable or beta")
	}
	if request.Version != "" {
		if err := model.ValidateVersion(request.Version); err != nil {
			return publicLifecycleRequest{}, fmt.Errorf("version: %w", err)
		}
		if strings.Contains(request.Version, "-") && request.Channel != "beta" {
			return publicLifecycleRequest{}, errors.New("prerelease versions require beta")
		}
	}
	if operation == "install" && request.Version == "" {
		return publicLifecycleRequest{}, errors.New("install requires an immutable version")
	}
	if operation == "update" && gatewayPortSet {
		return publicLifecycleRequest{}, errors.New("update preserves the installed Gateway port")
	}
	if operation == "install" && !gatewayPortSet {
		gatewayPort = 18789
	}
	if operation == "install" && (gatewayPort == 0 || gatewayPort > 65535) {
		return publicLifecycleRequest{}, errors.New("Gateway port is invalid")
	}
	request.GatewayPort = uint16(gatewayPort)
	if request.OperatorUser == "" {
		request.OperatorUser = operatorFromEnvironment(request.Profile)
	}
	if request.OperatorUser == "" || request.OperatorUser == "root" {
		return publicLifecycleRequest{}, errors.New("an unprivileged operator user is required")
	}
	return request, nil
}

func bindInstalledUpdatePlatform(request *publicLifecycleRequest, operator publicOperator, config platform.Config) error {
	expectedOwnerState := filepath.Join(operator.Home, ".fased")
	if request.Operation != "update" || config.Profile != request.Profile ||
		config.OwnerStateRoot != expectedOwnerState || config.Operator.UID != operator.UID ||
		config.Operator.GID != operator.GID {
		return errors.New("installed lifecycle platform identity differs from the update operator")
	}
	request.GatewayPort = config.GatewayPort
	return nil
}

func operatorFromEnvironment(profile model.Profile) string {
	if candidate := os.Getenv("SUDO_USER"); candidate != "" && candidate != "root" {
		return candidate
	}
	if profile == model.ProfileHosting {
		return "app"
	}
	return ""
}

func inferProfile(operator string) string {
	if operator == "app" || (operator == "" && os.Getenv("SUDO_USER") == "app") {
		return string(model.ProfileHosting)
	}
	return string(model.ProfileProtectedLocal)
}

type publicOperator struct {
	Name string
	Home string
	UID  uint32
	GID  uint32
}

func resolveOperator(name string, profile model.Profile) (publicOperator, error) {
	record, err := user.Lookup(name)
	if err != nil {
		if profile == model.ProfileHosting && name == "app" {
			return publicOperator{Name: name, Home: "/home/app"}, nil
		}
		return publicOperator{}, errors.New("public lifecycle operator does not exist")
	}
	uid, uidErr := strconv.ParseUint(record.Uid, 10, 32)
	gid, gidErr := strconv.ParseUint(record.Gid, 10, 32)
	if uidErr != nil || gidErr != nil || uid == 0 || !filepath.IsAbs(record.HomeDir) {
		return publicOperator{}, errors.New("public lifecycle operator identity is unsafe")
	}
	return publicOperator{Name: name, Home: record.HomeDir, UID: uint32(uid), GID: uint32(gid)}, nil
}

func invokeLifecycleHost(ctx context.Context, request publicLifecycleRequest, operator publicOperator, result bootstrapResult, output io.Writer) (protocol.Response, error) {
	args := []string{"initialize", "--profile", string(request.Profile), "--operator-user", operator.Name,
		"--owner-state", filepath.Join(operator.Home, ".fased"), "--gateway-port", strconv.Itoa(int(request.GatewayPort)),
		"--generation-archive", result.ApplicationPath, "--dependency-archive", result.DependencyPath,
		"--release-sequence", strconv.FormatUint(result.ReleaseSequence, 10), "--security-epoch", strconv.FormatUint(result.SecurityEpoch, 10),
		"--manifest-protocol-min", strconv.FormatUint(uint64(result.ManifestProtocolMin), 10), "--manifest-protocol-max", strconv.FormatUint(uint64(result.ManifestProtocolMax), 10),
		"--release-index-digest", result.ReleaseIndexDigest, "--release-authority-digest", result.ReleaseAuthorityDigest}
	command := exec.CommandContext(ctx, result.HostPath, args...)
	data, err := command.Output()
	if err != nil {
		if exit, ok := err.(*exec.ExitError); ok {
			return protocol.Response{}, fmt.Errorf("lifecycle transaction failed: %s", tail(exit.Stderr, 4096))
		}
		return protocol.Response{}, err
	}
	if len(data) > 64*1024 {
		return protocol.Response{}, errors.New("lifecycle transaction response exceeded its bound")
	}
	if request.Verbose {
		_, _ = output.Write(data)
	}
	return decodeTerminalLifecycleResponse(data)
}

func runOnboarding(ctx context.Context, request publicLifecycleRequest, operator publicOperator, result bootstrapResult) (protocol.Response, error) {
	configPath, err := installedConfigPath(request.Profile, operator)
	if err != nil {
		return protocol.Response{}, err
	}
	configData, err := os.ReadFile(configPath)
	if err != nil {
		return protocol.Response{}, err
	}
	config, err := platform.DecodeConfig(configData)
	if err != nil {
		return protocol.Response{}, err
	}
	launcher := filepath.Join(operator.Home, ".fased", "bin", "fased")
	args := onboardingCommandArgs(request, operator, config, launcher)
	args = append(args, request.OnboardArgs...)
	command := exec.CommandContext(ctx, "/usr/sbin/runuser", args...)
	command.Env = []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LANG=C.UTF-8", "LC_ALL=C.UTF-8"}
	command.Stdout, command.Stderr = os.Stdout, os.Stderr
	nonInteractive := false
	for _, argument := range request.OnboardArgs {
		if argument == "--non-interactive" {
			nonInteractive = true
		}
	}
	if !nonInteractive {
		tty, err := os.OpenFile("/dev/tty", os.O_RDWR, 0)
		if err != nil {
			return protocol.Response{}, errors.New("onboarding requires a terminal or --non-interactive arguments")
		}
		defer tty.Close()
		command.Stdin = tty
	}
	if err := command.Run(); err != nil {
		return protocol.Response{}, fmt.Errorf("onboarding failed: %w", err)
	}
	requestID, err := publicRequestID()
	if err != nil {
		return protocol.Response{}, err
	}
	complete := exec.CommandContext(ctx, result.HostPath, "request", "--socket", config.SupervisorSocket(), "--operation", "COMPLETE_ONBOARDING", "--request-id", requestID)
	data, err := complete.CombinedOutput()
	if request.Verbose && len(data) > 0 {
		_, _ = os.Stdout.Write([]byte(tail(data, 64*1024) + "\n"))
	}
	if err != nil {
		return protocol.Response{}, fmt.Errorf("onboarding commit failed: %s", tail(data, 4096))
	}
	return decodeTerminalLifecycleResponse(data)
}

func decodeTerminalLifecycleResponse(data []byte) (protocol.Response, error) {
	if len(data) == 0 || len(data) > 64*1024 {
		return protocol.Response{}, errors.New("lifecycle transaction response is empty or oversized")
	}
	var response protocol.Response
	if err := json.Unmarshal(data, &response); err != nil || response.SchemaVersion != protocol.CurrentSchemaVersion {
		return protocol.Response{}, errors.New("lifecycle transaction returned an invalid response")
	}
	if response.Outcome != "UPDATED" && response.Outcome != "ALREADY_CURRENT" {
		return protocol.Response{}, fmt.Errorf("lifecycle transaction did not converge: %s", response.Outcome)
	}
	if !digestID(response.ActiveGenerationID) || !digestID(response.ConvergenceReceiptDigest) {
		return protocol.Response{}, errors.New("lifecycle transaction response lacks generation-bound convergence proof")
	}
	return response, nil
}

func digestID(value string) bool {
	if len(value) != 71 || !strings.HasPrefix(value, "sha256:") {
		return false
	}
	_, err := hex.DecodeString(strings.TrimPrefix(value, "sha256:"))
	return err == nil
}

func onboardingCommandArgs(request publicLifecycleRequest, operator publicOperator, config platform.Config, launcher string) []string {
	ownerState := filepath.Join(operator.Home, ".fased")
	values := []string{
		"HOME=" + operator.Home,
		"LANG=C.UTF-8",
		"LC_ALL=C.UTF-8",
		"PATH=/usr/local/bin:/usr/bin:/bin",
		"FASED_STATE_DIR=" + ownerState,
		"FASED_CONFIG_PATH=" + filepath.Join(ownerState, "fased.json"),
		"FASED_INSTALLER_ONBOARD=1",
		"FASED_INSTALL_LIFECYCLE_COMMITTED=1",
		"FASED_WALLET_LOCAL_SIGNER_LIFECYCLE=external",
		"FASED_WALLET_LOCAL_SIGNER_SOCKET=" + config.ApplicationSocket(),
		"FASED_HOST_UPDATER_SOCKET=" + config.SupervisorSocket(),
	}
	if request.Profile == model.ProfileHosting {
		values = append(values, "FASED_HOST_PROFILE=hosting", "FASED_HOST_ROOT_PREPARED=1", "FASED_UPDATE_CHANNEL="+request.Channel)
	} else {
		values = append(values, "FASED_HOST_PROFILE=local", "FASED_PROTECTED_LOCAL=1", "FASED_PROTECTED_LOCAL_INSTANCE="+config.InstanceID)
	}
	args := []string{"-u", operator.Name, "--", "/usr/bin/env"}
	args = append(args, values...)
	return append(args, launcher, "onboard", "--install-daemon")
}

func installedConfigPath(profile model.Profile, operator publicOperator) (string, error) {
	if profile == model.ProfileHosting {
		return "/var/lib/fased-lifecycled/platform.json", nil
	}
	entry, found, err := platform.FindLocalInstance(platform.LocalInstanceRegistryPath, 0, operator.UID, operator.Name, string(profile), filepath.Join(operator.Home, ".fased"))
	if err != nil {
		return "", err
	}
	if !found {
		return "", errors.New("committed Local lifecycle instance is missing")
	}
	return filepath.Join("/var/lib/fased-local", entry.InstanceID, "lifecycle", "platform.json"), nil
}

func publicRequestID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", value[0:4], value[4:6], value[6:8], value[8:10], value[10:16]), nil
}

func tail(data []byte, limit int) string {
	if len(data) > limit {
		data = data[len(data)-limit:]
	}
	return strings.TrimSpace(string(data))
}
