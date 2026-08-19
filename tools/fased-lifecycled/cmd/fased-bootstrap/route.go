package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/term"

	"fased-lifecycled/acquire"
	"fased-lifecycled/daemon"
	"fased-lifecycled/hostsecurity"
	"fased-lifecycled/model"
	"fased-lifecycled/platform"
	"fased-lifecycled/protocol"
	"fased-lifecycled/store"
	"fased-lifecycled/trust"
)

const (
	productionReleaseBase               = "https://github.com/fased-ai/fased/releases/download"
	productionChannelReleasePrefix      = productionReleaseBase + "/fased-channel-"
	releaseRootAssetName                = "fased-lifecycle-root-v1.json"
	releaseIndexAssetName               = "fased-release-index-v1.json"
	releaseIndexAttestationAssetName    = "fased-release-index-v1.json.attestation.json"
	releaseRootHeadAssetName            = "fased-lifecycle-root-head-v1.json"
	releaseRootHeadAttestationAssetName = "fased-lifecycle-root-head-v1.json.attestation.json"
)

type publicReleaseRoute struct {
	RootURL, RootRotationBaseURL, IndexURL, IndexAttestationURL, ReleaseBaseURL, PinnedRootSHA256 string
	VerifyIndex                                                                                   releaseIndexVerifier
}

type publicLifecycleRequest struct {
	Operation              string
	Profile                model.Profile
	Channel                string
	ChannelExplicit        bool
	Version                string
	OperatorUser           string
	GatewayPort            uint16
	Verbose                bool
	JSON                   bool
	Onboard                bool
	OnboardArgs            []string
	TailscaleAuthKeyFile   string
	TailnetAccessConfirmed bool
	Timeout                time.Duration
}

type installedLifecycleStatus struct {
	Profile            model.Profile
	Channel            string
	Version            string
	ReleaseSequence    uint64
	SecurityEpoch      uint64
	ActiveGenerationID string
}

type signedChannelSelection struct {
	Version                string
	ReleaseSequence        uint64
	SecurityEpoch          uint64
	IndexDigest            string
	ReleaseAuthorityDigest string
	RootVersion            uint64
	RootSHA256             string
}

type publicLifecyclePerformance struct {
	ReleaseResolutionMillis uint64                        `json:"releaseResolutionMillis"`
	ApplyMillis             uint64                        `json:"applyMillis"`
	OnboardingMillis        uint64                        `json:"onboardingMillis"`
	TotalMillis             uint64                        `json:"totalMillis"`
	Acquisition             bootstrapPerformance          `json:"acquisition"`
	Transaction             *protocol.PerformanceEvidence `json:"transaction,omitempty"`
	TransactionStatus       string                        `json:"transactionStatus"`
}

// These narrow seams keep the public-route lease ordering testable without
// weakening the production trust or service path. Production always uses the
// shared plugin/core lease, host preflight, and verified bootstrap executor.
var (
	publicLifecycleMutationLockPath    = managedPluginMutationLockPath
	acquirePublicLifecycleMutationLock = acquireManagedPluginMutationLock
	verifyPublicLifecycleHost          = func(ctx context.Context) error { return platform.NewHostPreflight().Verify(ctx) }
	executePublicLifecycleBootstrap    = execute
	publicLifecycleRootAuthorized      = func() bool { return os.Geteuid() == 0 }
)

type lifecyclePhaseProgress struct {
	output   io.Writer
	terminal bool
	done     chan struct{}
	wait     sync.WaitGroup
	stop     sync.Once
}

func beginLifecyclePhase(output io.Writer, jsonOutput bool, phase string) *lifecyclePhaseProgress {
	if jsonOutput {
		return nil
	}
	terminal := outputIsTerminal(output)
	progress := newLifecyclePhaseProgress(output, phase, terminal, 500*time.Millisecond)
	return progress
}

func newLifecyclePhaseProgress(output io.Writer, phase string, terminal bool, heartbeat time.Duration) *lifecyclePhaseProgress {
	progress := &lifecyclePhaseProgress{output: output, terminal: terminal}
	if !terminal {
		_, _ = fmt.Fprintf(output, "Phase: %s\n", phase)
		return progress
	}
	progress.done = make(chan struct{})
	frames := []string{"|", "/", "-", "\\"}
	write := func(frame string) {
		_, _ = fmt.Fprintf(output, "\r\033[2KPhase: %s %s", phase, frame)
	}
	write(frames[0])
	progress.wait.Add(1)
	go func() {
		defer progress.wait.Done()
		ticker := time.NewTicker(heartbeat)
		defer ticker.Stop()
		frame := 1
		for {
			select {
			case <-progress.done:
				return
			case <-ticker.C:
				write(frames[frame%len(frames)])
				frame++
			}
		}
	}()
	return progress
}

func (progress *lifecyclePhaseProgress) Stop() {
	if progress == nil {
		return
	}
	progress.stop.Do(func() {
		if progress.done != nil {
			close(progress.done)
			progress.wait.Wait()
		}
		if progress.terminal {
			_, _ = fmt.Fprint(progress.output, "\r\033[2K")
		}
	})
}

func outputIsTerminal(output io.Writer) bool {
	type fileDescriptor interface{ Fd() uintptr }
	writer, ok := output.(fileDescriptor)
	return ok && term.IsTerminal(int(writer.Fd()))
}

type rootHeadVerifier func([]byte, []byte, time.Time) (trust.RootHead, error)

func verifyAttestedRootHead(headJSON, bundleJSON []byte, now time.Time) (trust.RootHead, error) {
	verified, err := trust.VerifyAttestedRootHead(headJSON, bundleJSON, now)
	if err != nil {
		return trust.RootHead{}, err
	}
	return verified.Head(), nil
}

func decodeInstalledLifecycleStatus(config platform.Config, profile model.Profile, manifestData []byte) (installedLifecycleStatus, error) {
	var manifest model.Manifest
	if err := json.Unmarshal(manifestData, &manifest); err != nil || manifest.ValidateInstalled() != nil {
		return installedLifecycleStatus{}, errors.New("installed lifecycle manifest is invalid")
	}
	configurationDigest, err := config.Digest()
	if err != nil {
		return installedLifecycleStatus{}, errors.New("installed lifecycle platform configuration is invalid")
	}
	if manifest.Profile != profile || manifest.Platform.InstanceID != config.InstanceID || manifest.Platform.ConfigurationDigest != configurationDigest || manifest.ActiveGeneration == nil {
		return installedLifecycleStatus{}, errors.New("installed lifecycle manifest differs from the selected platform")
	}
	return installedLifecycleStatus{
		Profile: profile, Version: manifest.ActiveGeneration.Version,
		ReleaseSequence: manifest.ReleaseSequence, SecurityEpoch: manifest.SecurityEpoch,
		ActiveGenerationID: manifest.ActiveGeneration.ID,
	}, nil
}

func runPublicLifecycleStatus(args []string, output io.Writer) error {
	flags := flag.NewFlagSet("status", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	profile := ""
	operatorUser := ""
	jsonOutput := false
	timeoutSeconds := 3
	flags.StringVar(&profile, "profile", "", "")
	flags.StringVar(&operatorUser, "operator-user", "", "")
	flags.BoolVar(&jsonOutput, "json", false, "")
	flags.IntVar(&timeoutSeconds, "timeout", 3, "")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 || timeoutSeconds < 1 || timeoutSeconds > 30 {
		return errors.New("invalid public lifecycle status arguments")
	}
	if os.Geteuid() != 0 {
		return errors.New("public lifecycle status requires root authorization")
	}
	if profile == "" {
		profile = string(inferProfile(operatorUser))
	}
	selectedProfile := model.Profile(profile)
	if selectedProfile != model.ProfileProtectedLocal && selectedProfile != model.ProfileHosting {
		return errors.New("profile must be protected-local or hosting")
	}
	if operatorUser == "" {
		operatorUser = operatorFromEnvironment(selectedProfile)
	}
	operator, err := resolveOperator(operatorUser, selectedProfile)
	if err != nil {
		return err
	}
	configPath, err := installedConfigPath(selectedProfile, operator)
	if err != nil {
		return err
	}
	configData, err := os.ReadFile(configPath)
	if err != nil {
		return errors.New("installed lifecycle platform configuration is unavailable")
	}
	config, err := platform.DecodeConfig(configData)
	if err != nil {
		return fmt.Errorf("installed lifecycle platform configuration is invalid: %w", err)
	}
	request := publicLifecycleRequest{Operation: "update", Profile: selectedProfile, OperatorUser: operatorUser}
	if err := bindInstalledUpdatePlatform(&request, operator, config); err != nil {
		return err
	}
	manifestData, err := os.ReadFile(filepath.Join(config.LifecycleRoot, "installation-manifest.json"))
	if err != nil {
		return errors.New("installed lifecycle manifest is unavailable")
	}
	status, err := decodeInstalledLifecycleStatus(config, selectedProfile, manifestData)
	if err != nil {
		return err
	}
	request.Channel = "stable"
	installedChannel := ""
	policy, policyErr := platform.ReadUpdatePolicy(config)
	if policyErr == nil {
		installedChannel = policy.Channel
	} else if !errors.Is(policyErr, os.ErrNotExist) {
		return fmt.Errorf("installed lifecycle update policy is invalid: %w", policyErr)
	}
	if err := bindInstalledUpdateChannel(&request, installedChannel, status); err != nil {
		return err
	}
	status.Channel = request.Channel
	if jsonOutput {
		_, err = fmt.Fprintf(output, "{\"status\":\"installed\",\"profile\":%q,\"channel\":%q,\"version\":%q,\"releaseSequence\":%d,\"securityEpoch\":%d,\"activeGenerationId\":%q}\n", status.Profile, status.Channel, status.Version, status.ReleaseSequence, status.SecurityEpoch, status.ActiveGenerationID)
		return err
	}
	_, err = fmt.Fprintf(output, "Installed: %s profile=%s channel=%s sequence=%d epoch=%d\n", status.Version, status.Profile, status.Channel, status.ReleaseSequence, status.SecurityEpoch)
	return err
}

func runPublicUninstall(args []string, output io.Writer) error {
	if namedFlagCount(args, "profile") > 1 {
		return errors.New("managed uninstall profile must be selected exactly once")
	}
	flags := flag.NewFlagSet("uninstall", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	profile := ""
	operatorUser := ""
	yes := false
	nonInteractive := false
	jsonOutput := false
	flags.StringVar(&profile, "profile", "", "")
	flags.StringVar(&operatorUser, "operator-user", "", "")
	flags.BoolVar(&yes, "yes", false, "")
	flags.BoolVar(&nonInteractive, "non-interactive", false, "")
	flags.BoolVar(&jsonOutput, "json", false, "")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 {
		return errors.New("invalid managed uninstall arguments")
	}
	if os.Geteuid() != 0 {
		return errors.New("managed uninstall requires root authorization")
	}
	if profile == "" {
		profile = inferProfile(operatorUser)
	}
	selectedProfile := model.Profile(profile)
	if selectedProfile != model.ProfileProtectedLocal && selectedProfile != model.ProfileHosting {
		return errors.New("profile must be protected-local or hosting")
	}
	if operatorUser == "" {
		operatorUser = operatorFromEnvironment(selectedProfile)
	}
	if sudoOperator := os.Getenv("SUDO_USER"); sudoOperator != "" && sudoOperator != "root" {
		if operatorUser != "" && operatorUser != sudoOperator {
			return errors.New("uninstall operator differs from the authorized sudo peer")
		}
		operatorUser = sudoOperator
	}
	operator, err := resolveOperator(operatorUser, selectedProfile)
	if err != nil {
		return err
	}
	if nonInteractive && !yes {
		return errors.New("non-interactive managed uninstall requires --yes")
	}
	if !yes {
		confirmed, err := confirmManagedUninstall(operator.Home)
		if err != nil {
			return err
		}
		if !confirmed {
			return errors.New("managed uninstall cancelled")
		}
	}
	lockPath := platform.BootstrapMutationLockPathForOS(runtime.GOOS)
	if selectedProfile == model.ProfileHosting {
		if runtime.GOOS != "linux" {
			return errors.New("Hosting lifecycle is supported only on Linux")
		}
		lockPath = "/run/lock/fased-bootstrap-hosting.lock"
	}
	lock, err := hostsecurity.AcquireMutationLock(lockPath, 0)
	if err != nil {
		return err
	}
	defer lock.Release()
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Minute)
	defer cancel()
	if err := platform.NewHostPreflight().Verify(ctx); err != nil {
		return err
	}
	configPath, err := installedConfigPath(selectedProfile, operator)
	if err != nil {
		return err
	}
	configData, err := os.ReadFile(configPath)
	if err != nil {
		return errors.New("installed lifecycle platform configuration is unavailable")
	}
	config, err := platform.DecodeConfig(configData)
	if err != nil {
		return fmt.Errorf("installed lifecycle platform configuration is invalid: %w", err)
	}
	if config.Profile != selectedProfile || config.OwnerStateRoot != filepath.Join(operator.Home, ".fased") ||
		config.Operator.UID != operator.UID || config.Operator.GID != operator.GID {
		return errors.New("installed lifecycle platform identity differs from the uninstall operator")
	}

	resume, resumeErr := platform.ReadManagedUninstallRecord(config, 0)
	state, openErr := store.OpenExistingLayout(store.Layout{StateRoot: config.LifecycleRoot, InstallRoot: config.InstallRoot})
	var manifest model.Manifest
	manifestDigest := ""
	payload := ""
	dependency := ""
	var pluginLock []byte
	if openErr == nil {
		manifest, manifestDigest, err = state.ReadManifest()
		if err == nil && manifest.ActiveGeneration != nil {
			payload, err = state.GenerationPayloadPath(manifest.ActiveGeneration.ID)
			if err == nil {
				dependency, err = state.GenerationDependencyPath(manifest.ActiveGeneration.ID)
			}
			if err == nil {
				pluginLock, err = os.ReadFile(filepath.Join(payload, "runtime", "plugin.lock.json"))
			}
		}
	}
	if err != nil || openErr != nil {
		if resumeErr != nil {
			return errors.Join(openErr, err, errors.New("installed lifecycle bytes and uninstall recovery record are unavailable"))
		}
		manifest, manifestDigest = resume.Manifest, resume.ManifestDigest
		if !resume.UnitsRemoved || !resume.ProjectionsRemoved {
			return errors.New("managed uninstall recovery still requires installed generation bytes")
		}
		payload, dependency, pluginLock = "", "", nil
	}
	if manifest.ActiveGeneration == nil {
		return errors.New("managed uninstall lacks an active generation identity")
	}
	serviceManager, err := platform.NewSystemServiceManager()
	if err != nil {
		return err
	}
	uninstaller := platform.ManagedUninstaller{
		Config: config, Manifest: manifest, ManifestDigest: manifestDigest,
		Systemd: serviceManager, OperatorUser: operator.Name,
		PayloadPath: payload, DependencyPath: dependency, PluginLockData: pluginLock, ExpectedUID: 0,
	}
	if selectedProfile == model.ProfileHosting {
		uninstaller.RestoreHostSecurity = func(ctx context.Context) error {
			securityLock, lockErr := hostsecurity.AcquireMutationLock("/run/lock/fased-host-security.lock", 0)
			if lockErr != nil {
				return lockErr
			}
			defer securityLock.Release()
			participant := hostsecurity.Participant{
				Store: hostsecurity.Store{StatePath: "/var/lib/fased-host-security/active.json", ReceiptPath: "/etc/fased/hosting-prerequisites", ExpectedUID: 0},
				Host:  hostsecurity.NewLinuxHost(),
			}
			_, uninstallErr := participant.Uninstall(ctx)
			return uninstallErr
		}
	}
	record, err := uninstaller.Run(ctx)
	if err != nil {
		return err
	}
	if !record.Completed {
		return errors.New("managed uninstall did not reach a terminal state")
	}
	if jsonOutput {
		_, err = fmt.Fprintf(output, "{\"status\":\"UNINSTALLED\",\"profile\":%q,\"instanceId\":%q,\"ownerStatePreserved\":true,\"signerStatePreserved\":true}\n", config.Profile, config.InstanceID)
	} else {
		_, err = fmt.Fprintf(output, "Uninstalled Fased %s services and executable generations. Preserved owner configuration, workspaces, and signer custody under %s.\n", config.Profile, config.OwnerStateRoot)
	}
	return err
}

func runPublicRollback(args []string, output io.Writer) error {
	if namedFlagCount(args, "profile") > 1 {
		return errors.New("managed rollback profile must be selected exactly once")
	}
	flags := flag.NewFlagSet("rollback", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	profile, operatorUser, authorizationFile := "", "", ""
	jsonOutput := false
	timeoutSeconds := uint64(300)
	flags.StringVar(&profile, "profile", "", "")
	flags.StringVar(&operatorUser, "operator-user", "", "")
	flags.StringVar(&authorizationFile, "authorization-file", "", "")
	flags.BoolVar(&jsonOutput, "json", false, "")
	flags.Uint64Var(&timeoutSeconds, "timeout", 300, "")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 || timeoutSeconds == 0 || timeoutSeconds > 600 ||
		!filepath.IsAbs(authorizationFile) || filepath.Clean(authorizationFile) != authorizationFile {
		return errors.New("invalid managed rollback arguments")
	}
	if os.Geteuid() != 0 {
		return errors.New("managed rollback requires root authorization")
	}
	if profile == "" {
		profile = inferProfile(operatorUser)
	}
	selectedProfile := model.Profile(profile)
	if selectedProfile != model.ProfileProtectedLocal && selectedProfile != model.ProfileHosting {
		return errors.New("profile must be protected-local or hosting")
	}
	if operatorUser == "" {
		operatorUser = operatorFromEnvironment(selectedProfile)
	}
	if sudoOperator := os.Getenv("SUDO_USER"); sudoOperator != "" && sudoOperator != "root" {
		if operatorUser != "" && operatorUser != sudoOperator {
			return errors.New("rollback operator differs from the authorized sudo peer")
		}
		operatorUser = sudoOperator
	}
	operator, err := resolveOperator(operatorUser, selectedProfile)
	if err != nil {
		return err
	}
	lockPath := platform.BootstrapMutationLockPathForOS(runtime.GOOS)
	if selectedProfile == model.ProfileHosting {
		if runtime.GOOS != "linux" {
			return errors.New("Hosting lifecycle is supported only on Linux")
		}
		lockPath = "/run/lock/fased-bootstrap-hosting.lock"
	}
	lock, err := hostsecurity.AcquireMutationLock(lockPath, 0)
	if err != nil {
		return err
	}
	defer lock.Release()
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutSeconds)*time.Second)
	defer cancel()
	if err := platform.NewHostPreflight().Verify(ctx); err != nil {
		return err
	}
	configPath, err := installedConfigPath(selectedProfile, operator)
	if err != nil {
		return err
	}
	configData, err := readSecureRollbackInput(configPath, maxMetadataSize, 0)
	if err != nil {
		return errors.New("installed lifecycle platform configuration is unavailable or unsafe")
	}
	config, err := platform.DecodeConfig(configData)
	if err != nil {
		return fmt.Errorf("installed lifecycle platform configuration is invalid: %w", err)
	}
	if config.Profile != selectedProfile || config.OwnerStateRoot != filepath.Join(operator.Home, ".fased") ||
		config.Operator.UID != operator.UID || config.Operator.GID != operator.GID {
		return errors.New("installed lifecycle platform identity differs from the rollback operator")
	}
	state, err := store.OpenExistingLayout(store.Layout{StateRoot: config.LifecycleRoot, InstallRoot: config.InstallRoot})
	if err != nil {
		return err
	}
	manifest, manifestDigest, err := state.ReadManifest()
	if err != nil || manifest.ValidateInstalled() != nil || manifest.ActiveGeneration == nil || manifest.PreviousGeneration == nil {
		return errors.Join(err, errors.New("managed rollback requires committed active and previous generations"))
	}
	configured, err := config.Identity()
	if err != nil {
		return err
	}
	configuredDigest, err := configured.Digest(selectedProfile)
	manifestPlatformDigest, manifestPlatformErr := manifest.Platform.Digest(selectedProfile)
	if err != nil || manifestPlatformErr != nil || configuredDigest != manifestPlatformDigest {
		return errors.New("installed rollback platform identity is inconsistent")
	}
	_, previous, err := state.ReadGenerationContract(manifest.PreviousGeneration.ID)
	if err != nil || previous != *manifest.PreviousGeneration {
		return errors.Join(err, errors.New("committed previous generation is unavailable or inconsistent"))
	}
	previousAuthority, err := state.ReadCandidateAuthority(previous.ID)
	if err != nil {
		return errors.New("previous generation release authority is unavailable")
	}
	policy, err := platform.ReadUpdatePolicy(config)
	if err != nil {
		return fmt.Errorf("installed lifecycle update policy is invalid: %w", err)
	}
	now := time.Now().UTC()
	channelBase := productionChannelReleasePrefix + policy.Channel + "-v1"
	client := &http.Client{Timeout: 15 * time.Second, CheckRedirect: secureMetadataRedirect}
	selection, err := discoverSignedChannelRelease(ctx, policy.Channel, client, channelBase, productionPinnedRootSHA256,
		platform.BootstrapCacheRootForOS(runtime.GOOS), 0, manifest.ReleaseSequence, manifest.SecurityEpoch, now, nil, nil)
	if err != nil {
		return err
	}
	rootURL, err := assetURL(channelBase, releaseRootAssetName)
	if err != nil {
		return err
	}
	root, err := resolveTrustedRoot(ctx, client, platform.BootstrapCacheRootForOS(runtime.GOOS), 0, rootURL, channelBase, nil,
		productionPinnedRootSHA256, selection.RootVersion, selection.RootSHA256, now)
	if err != nil {
		return err
	}
	grantJSON, err := readSecureRollbackInput(authorizationFile, maxMetadataSize, 0)
	if err != nil {
		return err
	}
	authorization, err := trust.VerifyRollbackGrant(root, grantJSON, now)
	if err != nil {
		return fmt.Errorf("verify rollback authorization: %w", err)
	}
	if err := root.AuthorizeGeneration(previous); err != nil {
		return err
	}
	if authorization.CurrentGenerationID != manifest.ActiveGeneration.ID || authorization.TargetGenerationID != previous.ID ||
		authorization.CurrentReleaseSequence != manifest.ReleaseSequence || authorization.TargetReleaseSequence != previousAuthority.ReleaseSequence ||
		authorization.SecurityEpoch != manifest.SecurityEpoch || previousAuthority.SecurityEpoch != manifest.SecurityEpoch {
		return errors.New("rollback authorization differs from the committed release identities")
	}
	requestID, err := publicRequestID()
	if err != nil {
		return err
	}
	response, err := daemon.Call(ctx, config.SupervisorSocket(), protocol.Request{
		SchemaVersion: protocol.CurrentSchemaVersion, RequestID: requestID, Operation: protocol.OperationRollback,
		TargetGenerationID: previous.ID, ExpectedManifestDigest: manifestDigest, RollbackAuthorization: &authorization,
	}, time.Duration(timeoutSeconds)*time.Second)
	if err != nil {
		return err
	}
	if response.Outcome != "UPDATED" || response.ActiveGenerationID != previous.ID || !digestID(response.ConvergenceReceiptDigest) {
		return errors.New("managed rollback did not produce terminal generation-bound convergence proof")
	}
	if jsonOutput {
		_, err = fmt.Fprintf(output, "{\"status\":\"ROLLED_BACK\",\"version\":%q,\"releaseSequence\":%d,\"securityEpoch\":%d,\"activeGenerationId\":%q,\"convergenceReceiptDigest\":%q}\n", previous.Version, previousAuthority.ReleaseSequence, previousAuthority.SecurityEpoch, response.ActiveGenerationID, response.ConvergenceReceiptDigest)
	} else {
		_, err = fmt.Fprintf(output, "Rolled back successfully: %s\n", previous.Version)
	}
	return err
}

func readSecureRollbackInput(path string, limit int64, expectedUID uint32) ([]byte, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path || limit <= 0 {
		return nil, errors.New("root-owned rollback input path is unsafe")
	}
	before, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	stat, ok := before.Sys().(*syscall.Stat_t)
	if !ok || !before.Mode().IsRegular() || before.Mode()&os.ModeSymlink != 0 || before.Mode().Perm() != 0o600 || stat.Uid != expectedUID || stat.Nlink != 1 || before.Size() <= 0 || before.Size() > limit {
		return nil, errors.New("root-owned rollback input is unsafe")
	}
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	after, err := file.Stat()
	if err != nil || !os.SameFile(before, after) {
		return nil, errors.Join(err, errors.New("root-owned rollback input changed while opening"))
	}
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil || len(data) == 0 || int64(len(data)) > limit {
		return nil, errors.Join(err, errors.New("root-owned rollback input is empty or oversized"))
	}
	return data, nil
}

func confirmManagedUninstall(ownerHome string) (bool, error) {
	tty, err := os.OpenFile("/dev/tty", os.O_RDWR, 0)
	if err != nil {
		return false, errors.New("managed uninstall requires a terminal or --yes")
	}
	defer tty.Close()
	if _, err := fmt.Fprintf(tty, "Remove Fased services and executable generations? Configuration, workspaces, and signer custody under %s will be preserved. [y/N] ", filepath.Join(ownerHome, ".fased")); err != nil {
		return false, err
	}
	answer, err := bufio.NewReader(io.LimitReader(tty, 32)).ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return false, err
	}
	answer = strings.ToLower(strings.TrimSpace(answer))
	return answer == "y" || answer == "yes", nil
}

func runPublicLifecycle(operation string, args []string, output io.Writer) error {
	lifecycleStarted := time.Now()
	request, err := parsePublicLifecycleRequest(operation, args)
	if err != nil {
		return err
	}
	if !publicLifecycleRootAuthorized() {
		return errors.New("public lifecycle operation requires root authorization")
	}
	operator, err := resolveOperator(request.OperatorUser, request.Profile)
	if err != nil {
		return err
	}
	// Core and third-party plugin mutations share one lease. Acquire it before
	// inspecting installed state or acquiring a lifecycle release, then retain
	// it through recovery, generation convergence, and terminal output.
	lockPath, err := publicLifecycleMutationLockPath(request.Profile)
	if err != nil {
		return err
	}
	lock, err := acquirePublicLifecycleMutationLock(lockPath, 0)
	if err != nil {
		return err
	}
	defer lock.Release()
	ctx, cancel := context.WithTimeout(context.Background(), request.Timeout)
	defer cancel()
	ownerConfigExisted, err := pathExists(filepath.Join(operator.Home, ".fased", "fased.json"))
	if err != nil {
		return fmt.Errorf("inspect owner configuration: %w", err)
	}
	installedStatus := installedLifecycleStatus{}
	var installedConfig *platform.Config
	if request.Operation == "update" || request.Operation == "repair" {
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
		manifestData, readErr := os.ReadFile(filepath.Join(config.LifecycleRoot, "installation-manifest.json"))
		if readErr != nil {
			return errors.New("installed lifecycle manifest is unavailable")
		}
		installedStatus, err = decodeInstalledLifecycleStatus(config, request.Profile, manifestData)
		if err != nil {
			return err
		}
		installedChannel := ""
		policy, policyErr := platform.ReadUpdatePolicy(config)
		if policyErr == nil {
			installedChannel = policy.Channel
		} else if !errors.Is(policyErr, os.ErrNotExist) {
			return fmt.Errorf("installed lifecycle update policy is invalid: %w", policyErr)
		}
		if err := bindInstalledUpdateChannel(&request, installedChannel, installedStatus); err != nil {
			return err
		}
		installedConfig = &config
		if request.Operation == "repair" {
			request.Version = installedStatus.Version
		}
	}
	if request.Profile == model.ProfileHosting && runtime.GOOS != "linux" {
		return errors.New("Hosting lifecycle is supported only on Linux")
	}
	if err := verifyPublicLifecycleHost(ctx); err != nil {
		return err
	}
	if installedConfig != nil {
		if err := convergeManagedPluginsBeforeCoreGeneration(ctx, *installedConfig, installedStatus); err != nil {
			return err
		}
	}
	now := time.Now().UTC()
	var channelSelection *signedChannelSelection
	performance := publicLifecyclePerformance{}
	if request.Version == "" {
		resolutionStarted := time.Now()
		resolutionProgress := beginLifecyclePhase(output, request.JSON, "resolving the trusted release")
		discoveryClient := &http.Client{Timeout: 15 * time.Second, CheckRedirect: secureMetadataRedirect}
		selection, selectionErr := discoverSignedChannelRelease(
			ctx, request.Channel, discoveryClient,
			productionChannelReleasePrefix+request.Channel+"-v1", productionPinnedRootSHA256,
			platform.BootstrapCacheRootForOS(runtime.GOOS), 0, installedStatus.ReleaseSequence, installedStatus.SecurityEpoch, now, nil, nil,
		)
		resolutionProgress.Stop()
		if selectionErr != nil {
			return selectionErr
		}
		request.Version = selection.Version
		channelSelection = &selection
		performance.ReleaseResolutionMillis = durationMillis(resolutionStarted)
	}
	releaseRoute, err := publicTrustRoute(request.Version)
	if err != nil {
		return err
	}
	releaseRoute.RootRotationBaseURL = productionChannelReleasePrefix + request.Channel + "-v1"
	if releaseRoute.VerifyIndex != nil {
		// Unpublished branch fixtures are isolated from the production channel and
		// must serve any test rotation chain beside their exact fixture metadata.
		releaseRoute.RootRotationBaseURL = releaseRoute.ReleaseBaseURL
	}
	expectedRootVersion := uint64(0)
	expectedRootSHA256 := ""
	if channelSelection != nil {
		expectedRootVersion = channelSelection.RootVersion
		expectedRootSHA256 = channelSelection.RootSHA256
	}
	bootstrap := bootstrapRequest{
		StateRoot: platform.BootstrapCacheRootForOS(runtime.GOOS), HostRoot: platform.LifecycleHostRootForOS(runtime.GOOS),
		RootURL: releaseRoute.RootURL, RootRotationBaseURL: releaseRoute.RootRotationBaseURL, IndexURL: releaseRoute.IndexURL,
		IndexAttestationURL: releaseRoute.IndexAttestationURL, ReleaseBaseURL: releaseRoute.ReleaseBaseURL,
		Channel: request.Channel, Version: request.Version, Architecture: architecture(),
		PinnedRootSHA256: releaseRoute.PinnedRootSHA256, OwnerUID: 0, Now: now, Inspect: inspectLifecycleHost,
		VerifyIndex: releaseRoute.VerifyIndex, ExpectedRootVersion: expectedRootVersion,
		ExpectedRootSHA256: expectedRootSHA256,
	}
	acquisitionProgress := beginLifecyclePhase(output, request.JSON, "acquiring the verified lifecycle release")
	result, err := executePublicLifecycleBootstrap(ctx, bootstrap)
	acquisitionProgress.Stop()
	if err != nil {
		return err
	}
	if channelSelection != nil {
		if err := validateSignedChannelResult(*channelSelection, result); err != nil {
			return err
		}
	}
	performance.Acquisition = result.Performance
	var hostingParticipant *hostsecurity.Participant
	hostingTransactionID := ""
	hostingSecurityReused := false
	if request.Profile == model.ProfileHosting {
		securityLock, lockErr := hostsecurity.AcquireMutationLock("/run/lock/fased-host-security.lock", 0)
		if lockErr != nil {
			return lockErr
		}
		defer securityLock.Release()
		hostingTransactionID, err = publicRequestID()
		if err != nil {
			return err
		}
		log, logErr := openHostingSecurityLog()
		if logErr != nil {
			return logErr
		}
		defer log.Close()
		userOutput := output
		if request.JSON {
			userOutput = io.Discard
		}
		participant := hostsecurity.Participant{
			Store: hostsecurity.Store{StatePath: "/var/lib/fased-host-security/active.json", ReceiptPath: "/etc/fased/hosting-prerequisites", ExpectedUID: 0},
			Host:  hostsecurity.NewLinuxHost(), Log: log, User: userOutput,
		}
		hostingParticipant = &participant
		prepared, prepareErr := participant.Prepare(ctx, hostsecurity.Request{
			TransactionID: hostingTransactionID, Release: result.Version, Channel: request.Channel,
			GatewayPort: request.GatewayPort, OperatorUser: operator.Name,
			AuthKeyFile: request.TailscaleAuthKeyFile, Interactive: publicRequestAllowsBrowserAuthentication(request), RequireExistingHardening: request.Operation != "install",
		})
		if prepareErr != nil {
			return prepareErr
		}
		hostingTransactionID = prepared.TransactionID
		hostingSecurityReused = !hostingSecurityTransactionNeedsFinalization(prepared)
	}
	applyStarted := time.Now()
	applyProgress := beginLifecyclePhase(output, request.JSON, "applying the lifecycle generation")
	convergence, verboseOutput, err := invokeLifecycleHost(ctx, request, operator, result)
	applyProgress.Stop()
	performance.ApplyMillis = durationMillis(applyStarted)
	performance.Transaction = convergence.Performance
	emitLifecycleHostVerbose(lifecycleHostVerboseOutputWriter(request, output, os.Stderr), verboseOutput)
	if err != nil {
		if hostingParticipant != nil && !hostingSecurityReused {
			err = errors.Join(err, hostingParticipant.Abort(ctx, hostingTransactionID))
		}
		return err
	}
	if hostingParticipant != nil && !hostingSecurityReused {
		if _, err := hostingParticipant.MarkRuntimeReady(ctx, hostingTransactionID); err != nil {
			return fmt.Errorf("Hosting runtime installed but host-security handoff remains pending: %w", err)
		}
	}
	outcome := convergence.Outcome
	if shouldRunOnboarding(request, outcome, ownerConfigExisted) {
		onboardingStarted := time.Now()
		convergence, err = runOnboarding(ctx, request, operator, result, output, os.Stderr)
		performance.OnboardingMillis = durationMillis(onboardingStarted)
		if err != nil {
			return err
		}
		outcome = convergence.Outcome
	}
	if hostingParticipant != nil && !hostingSecurityReused {
		accessConfirmed := request.TailnetAccessConfirmed
		if !accessConfirmed {
			if _, commitErr := hostingParticipant.Commit(ctx, hostingTransactionID, false); commitErr == nil {
				accessConfirmed = true
			} else if !strings.Contains(commitErr.Error(), "independent tailnet access") {
				return fmt.Errorf("Fased is installed and provider SSH remains open; Hosting hardening is pending: %w", commitErr)
			}
		}
		if !accessConfirmed {
			state, stateErr := hostingParticipant.Store.ReadState()
			if stateErr != nil {
				return stateErr
			}
			accessConfirmed, err = confirmTailnetAccess(state, output)
			if err != nil {
				return err
			}
		}
		if _, err := hostingParticipant.Commit(ctx, hostingTransactionID, accessConfirmed); err != nil {
			return fmt.Errorf("Fased is installed and provider SSH remains open; Hosting hardening is pending: %w", err)
		}
	}
	if err := pruneAcquisitionInbox(platform.BootstrapCacheRootForOS(runtime.GOOS)); err != nil {
		return fmt.Errorf("lifecycle committed but verified acquisition cleanup is pending: %w", err)
	}
	performance.TransactionStatus = transactionPerformanceStatus(outcome, performance.Transaction)
	performance.TotalMillis = durationMillis(lifecycleStarted)
	if request.JSON {
		response := struct {
			Status                   string                     `json:"status"`
			Version                  string                     `json:"version"`
			ReleaseSequence          uint64                     `json:"releaseSequence"`
			SecurityEpoch            uint64                     `json:"securityEpoch"`
			ActiveGenerationID       string                     `json:"activeGenerationId"`
			ConvergenceReceiptDigest string                     `json:"convergenceReceiptDigest"`
			Performance              publicLifecyclePerformance `json:"performance"`
		}{outcome, result.Version, result.ReleaseSequence, result.SecurityEpoch, convergence.ActiveGenerationID, convergence.ConvergenceReceiptDigest, performance}
		err = json.NewEncoder(output).Encode(response)
	} else if outcome == "ALREADY_CURRENT" {
		_, err = fmt.Fprintf(output, "Already current: %s\n", result.Version)
	} else if request.Operation == "repair" {
		_, err = fmt.Fprintf(output, "Repaired successfully: %s\n", result.Version)
	} else {
		_, err = fmt.Fprintf(output, "Updated successfully: %s\n", result.Version)
	}
	if err == nil && request.Verbose && !request.JSON {
		_, err = fmt.Fprintln(output, formatLifecyclePerformance(performance))
	}
	return err
}

// convergeManagedPluginsBeforeCoreGeneration is deliberately called with the
// committed active generation, not the candidate generation. An unfinished
// plugin journal is bound to the running Gateway/readiness identity and must
// become terminal (or fail closed) before the core lifecycle may replace it.
// The caller already owns the shared lifecycle mutation lease.
func convergeManagedPluginsBeforeCoreGeneration(ctx context.Context, config platform.Config, status installedLifecycleStatus) error {
	service, err := platform.NewSystemServiceManager()
	if err != nil {
		return err
	}
	production, err := platform.NewManagedPluginProduction(config, status.ActiveGenerationID, service)
	if err != nil {
		return fmt.Errorf("inspect managed plugin transaction before core generation transition: %w", err)
	}
	if err := production.Activation.ConvergeBeforeCoreGeneration(ctx); err != nil {
		return fmt.Errorf("converge managed plugin transaction before core generation transition: %w", err)
	}
	return nil
}

func formatLifecyclePerformance(performance publicLifecyclePerformance) string {
	return fmt.Sprintf(
		"Lifecycle performance: resolution=%dms metadata=%dms verify=%dms assets=%dms extraction=%dms fsync=%dms activation=%dms transaction=%s quiesce=%s switch=%s readiness=%s apply=%dms onboarding=%dms total=%dms transferred=%dB metadata-bytes=%dB artifact-bytes=%dB cache-hits=%d cache-misses=%d",
		performance.ReleaseResolutionMillis,
		performance.Acquisition.MetadataMillis,
		performance.Acquisition.SignatureVerificationMillis,
		performance.Acquisition.AssetAcquisitionMillis,
		performance.Acquisition.ExtractionMillis,
		performance.Acquisition.FsyncMillis,
		performance.Acquisition.ActivationMillis,
		performance.TransactionStatus,
		transactionMillis(performance.Transaction, func(value *protocol.PerformanceEvidence) uint64 { return value.QuiesceMillis }),
		transactionMillis(performance.Transaction, func(value *protocol.PerformanceEvidence) uint64 { return value.SwitchMillis }),
		transactionMillis(performance.Transaction, func(value *protocol.PerformanceEvidence) uint64 { return value.ServiceReadinessMillis }),
		performance.ApplyMillis,
		performance.OnboardingMillis,
		performance.TotalMillis,
		performance.Acquisition.TransferredBytes,
		performance.Acquisition.MetadataTransferredBytes,
		performance.Acquisition.ArtifactTransferredBytes,
		performance.Acquisition.CacheHits,
		performance.Acquisition.CacheMisses,
	)
}

func transactionPerformanceStatus(outcome string, evidence *protocol.PerformanceEvidence) string {
	if evidence != nil {
		return "measured"
	}
	if outcome == "ALREADY_CURRENT" {
		return "not-applicable"
	}
	return "unavailable"
}

func transactionMillis(evidence *protocol.PerformanceEvidence, selectValue func(*protocol.PerformanceEvidence) uint64) string {
	if evidence == nil {
		return "na"
	}
	return fmt.Sprintf("%dms", selectValue(evidence))
}

func hostingSecurityTransactionNeedsFinalization(state hostsecurity.State) bool {
	return state.Phase != hostsecurity.PhaseCommitted
}

func pruneAcquisitionInbox(stateRoot string) error {
	inbox, err := acquire.OpenInbox(stateRoot, 0)
	if err != nil {
		return err
	}
	defer inbox.Close()
	_, err = inbox.Prune()
	return err
}

func validateSignedChannelResult(selection signedChannelSelection, result bootstrapResult) error {
	if result.Version != selection.Version || result.ReleaseSequence != selection.ReleaseSequence ||
		result.SecurityEpoch != selection.SecurityEpoch || result.ReleaseIndexDigest != "sha256:"+selection.IndexDigest ||
		result.ReleaseAuthorityDigest != "sha256:"+selection.ReleaseAuthorityDigest {
		return errors.New("exact release differs from the signed channel selection")
	}
	return nil
}

func discoverSignedChannelRelease(ctx context.Context, channel string, client *http.Client, baseURL, pinnedRootSHA256, stateRoot string, ownerUID uint32, minimumReleaseSequence, minimumSecurityEpoch uint64, now time.Time, verifyIndex releaseIndexVerifier, verifyRootHead rootHeadVerifier) (signedChannelSelection, error) {
	if channel != "stable" && channel != "beta" {
		return signedChannelSelection{}, errors.New("release discovery channel must be stable or beta")
	}
	if client == nil {
		return signedChannelSelection{}, errors.New("release discovery client is unavailable")
	}
	rootURL, err := assetURL(baseURL, releaseRootAssetName)
	if err != nil {
		return signedChannelSelection{}, err
	}
	indexURL, err := assetURL(baseURL, releaseIndexAssetName)
	if err != nil {
		return signedChannelSelection{}, err
	}
	attestationURL, err := assetURL(baseURL, releaseIndexAttestationAssetName)
	if err != nil {
		return signedChannelSelection{}, err
	}
	rootHeadURL, err := assetURL(baseURL, releaseRootHeadAssetName)
	if err != nil {
		return signedChannelSelection{}, err
	}
	rootHeadAttestationURL, err := assetURL(baseURL, releaseRootHeadAttestationAssetName)
	if err != nil {
		return signedChannelSelection{}, err
	}
	rootHeadJSON, err := fetchMetadata(ctx, client, rootHeadURL)
	if err != nil {
		return signedChannelSelection{}, fmt.Errorf("fetch signed %s root-head: %w", channel, err)
	}
	rootHeadAttestationJSON, err := fetchMetadata(ctx, client, rootHeadAttestationURL)
	if err != nil {
		return signedChannelSelection{}, fmt.Errorf("fetch signed %s root-head attestation: %w", channel, err)
	}
	if verifyRootHead == nil {
		verifyRootHead = verifyAttestedRootHead
	}
	head, err := verifyRootHead(rootHeadJSON, rootHeadAttestationJSON, now)
	if err != nil {
		return signedChannelSelection{}, fmt.Errorf("verify signed %s root-head: %w", channel, err)
	}
	if head.Channel != channel {
		return signedChannelSelection{}, errors.New("signed root-head differs from the requested channel")
	}
	root, err := resolveTrustedRoot(ctx, client, stateRoot, ownerUID, rootURL, baseURL, nil, pinnedRootSHA256, head.RootVersion, head.RootSHA256, now)
	if err != nil {
		return signedChannelSelection{}, fmt.Errorf("verify signed %s channel root: %w", channel, err)
	}
	indexJSON, err := fetchMetadata(ctx, client, indexURL)
	if err != nil {
		return signedChannelSelection{}, fmt.Errorf("fetch signed %s channel index: %w", channel, err)
	}
	indexDigest := sha256.Sum256(indexJSON)
	if hex.EncodeToString(indexDigest[:]) != head.ReleaseIndexSHA256 {
		return signedChannelSelection{}, errors.New("signed channel index differs from the witnessed root-head")
	}
	attestationJSON, err := fetchMetadata(ctx, client, attestationURL)
	if err != nil {
		return signedChannelSelection{}, fmt.Errorf("fetch signed %s channel attestation: %w", channel, err)
	}
	if verifyIndex == nil {
		verifyIndex = verifyAttestedReleaseIndex
	}
	verified, err := verifyIndex(root, indexJSON, attestationJSON, now)
	if err != nil {
		return signedChannelSelection{}, fmt.Errorf("verify signed %s channel index: %w", channel, err)
	}
	index := verified.Index
	if index.Version != head.ReleaseVersion || index.ReleaseSequence != head.ReleaseSequence ||
		index.SecurityEpoch != head.SecurityEpoch || index.Commit != head.IndexCommit {
		return signedChannelSelection{}, errors.New("signed channel index identity differs from the witnessed root-head")
	}
	if index.Channel != channel ||
		(channel == "stable" && strings.Contains(index.Version, "-")) ||
		(channel == "beta" && !strings.Contains(index.Version, "-")) {
		return signedChannelSelection{}, errors.New("signed channel index differs from the requested channel")
	}
	if index.ReleaseSequence < minimumReleaseSequence || index.SecurityEpoch < minimumSecurityEpoch {
		return signedChannelSelection{}, errors.New("signed channel index is older than the installed release authority")
	}
	if !plainSHA256(verified.Digest) || !plainSHA256(verified.ReleaseAuthorityDigest) {
		return signedChannelSelection{}, errors.New("signed channel index returned malformed authority digests")
	}
	return signedChannelSelection{
		Version: index.Version, ReleaseSequence: index.ReleaseSequence, SecurityEpoch: index.SecurityEpoch,
		IndexDigest: verified.Digest, ReleaseAuthorityDigest: verified.ReleaseAuthorityDigest,
		RootVersion: head.RootVersion, RootSHA256: head.RootSHA256,
	}, nil
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

func publicRequestAllowsBrowserAuthentication(request publicLifecycleRequest) bool {
	// Application onboarding and root-owned Tailscale authentication are
	// independent. A scripted onboarding payload must not suppress the browser
	// login URL. JSON is the explicit headless lifecycle boundary and therefore
	// requires --ts-authkey-file when the host is not authenticated already.
	return !request.JSON
}

const maxHostingSecurityLogBytes = 8 << 20

type boundedHostingLog struct {
	file      *os.File
	remaining int64
}

func (log *boundedHostingLog) Write(data []byte) (int, error) {
	if log == nil || log.file == nil || log.remaining <= 0 {
		return 0, errors.New("Hosting security log exceeded its bound")
	}
	if int64(len(data)) > log.remaining {
		written, err := log.file.Write(data[:log.remaining])
		log.remaining -= int64(written)
		return written, errors.Join(err, errors.New("Hosting security log exceeded its bound"))
	}
	written, err := log.file.Write(data)
	log.remaining -= int64(written)
	return written, err
}

func (log *boundedHostingLog) Close() error {
	if log == nil || log.file == nil {
		return nil
	}
	file := log.file
	log.file = nil
	return errors.Join(file.Sync(), file.Close())
}

func openHostingSecurityLog() (io.WriteCloser, error) {
	const directory = "/var/log/fased"
	const path = directory + "/hosting-security.log"
	return openBoundedHostingSecurityLog(directory, path, 0, maxHostingSecurityLogBytes)
}

func openBoundedHostingSecurityLog(directory, path string, expectedUID uint32, limit int64) (io.WriteCloser, error) {
	if !filepath.IsAbs(directory) || filepath.Clean(directory) != directory || filepath.Dir(path) != directory || limit <= 0 {
		return nil, errors.New("Hosting security log path is unsafe")
	}
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return nil, err
	}
	directoryInfo, err := os.Lstat(directory)
	if err != nil {
		return nil, err
	}
	directoryStat, statOK := directoryInfo.Sys().(*syscall.Stat_t)
	if !statOK || !directoryInfo.IsDir() || directoryInfo.Mode()&os.ModeSymlink != 0 || directoryInfo.Mode().Perm() != 0o700 || directoryStat.Uid != expectedUID {
		return nil, errors.New("Hosting security log directory is unsafe")
	}
	if info, err := os.Lstat(path); err == nil {
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0o600 || stat.Uid != expectedUID || stat.Nlink != 1 {
			return nil, errors.New("Hosting security log is unsafe")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	descriptor, err := syscall.Open(path, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(descriptor), path)
	var opened syscall.Stat_t
	if err := syscall.Fstat(descriptor, &opened); err != nil || opened.Mode&syscall.S_IFMT != syscall.S_IFREG || opened.Uid != expectedUID || opened.Nlink != 1 {
		file.Close()
		return nil, errors.Join(err, errors.New("opened Hosting security log is unsafe"))
	}
	if err := file.Chmod(0o600); err != nil {
		file.Close()
		return nil, err
	}
	if err := file.Truncate(0); err != nil {
		file.Close()
		return nil, err
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		file.Close()
		return nil, err
	}
	return &boundedHostingLog{file: file, remaining: limit}, nil
}

func confirmTailnetAccess(state hostsecurity.State, output io.Writer) (bool, error) {
	if err := state.Validate(); err != nil || state.TailscaleDNS == "" || state.OperatorUser == "" {
		return false, errors.Join(err, errors.New("Hosting tailnet confirmation state is invalid"))
	}
	_, _ = fmt.Fprintf(output, "\nFased Hosting is private at https://%s\n", state.TailscaleDNS)
	_, _ = fmt.Fprintf(output, "Before public SSH is disabled, connect from your Tailscale computer:\n  tailscale ssh %s@%s\n", state.OperatorUser, state.TailscaleDNS)
	_, _ = fmt.Fprintln(output, "Keep this provider console open while testing. You will not be asked to retype the DNS name.")
	tty, err := os.OpenFile("/dev/tty", os.O_RDWR, 0)
	if err != nil {
		return false, errors.New("non-interactive Hosting setup preserved provider SSH; rerun with --tailnet-access-confirmed only after the external Tailscale SSH test succeeds")
	}
	defer tty.Close()
	if _, err := fmt.Fprint(tty, "Did the independent Tailscale SSH test succeed? [y/N] "); err != nil {
		return false, err
	}
	answer, err := bufio.NewReader(io.LimitReader(tty, 32)).ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return false, err
	}
	answer = strings.ToLower(strings.TrimSpace(answer))
	if answer != "y" && answer != "yes" {
		return false, errors.New("provider SSH remains open because independent tailnet access was not confirmed")
	}
	return true, nil
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
	if operation != "install" && operation != "update" && operation != "repair" {
		return publicLifecycleRequest{}, errors.New("unsupported public lifecycle operation")
	}
	if operation != "install" && namedFlagCount(args, "profile") > 1 {
		return publicLifecycleRequest{}, errors.New("managed operation profile must be selected exactly once")
	}
	if namedFlagCount(args, "channel")+namedFlagCount(args, "update-channel") > 1 {
		return publicLifecycleRequest{}, errors.New("update channel must be selected at most once")
	}
	flags := flag.NewFlagSet(operation, flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	profile := ""
	gatewayPort := uint64(0)
	request := publicLifecycleRequest{Operation: operation, Channel: "stable", Onboard: operation == "install", Timeout: 8 * time.Minute}
	timeoutSeconds := uint64(0)
	flags.StringVar(&profile, "profile", "", "")
	flags.StringVar(&request.Channel, "channel", "stable", "")
	flags.StringVar(&request.Channel, "update-channel", "stable", "")
	flags.StringVar(&request.Version, "version", "", "")
	flags.StringVar(&request.Version, "tag", "", "")
	flags.StringVar(&request.OperatorUser, "operator-user", "", "")
	flags.StringVar(&request.TailscaleAuthKeyFile, "ts-authkey-file", "", "")
	flags.BoolVar(&request.TailnetAccessConfirmed, "tailnet-access-confirmed", false, "")
	flags.Uint64Var(&gatewayPort, "gateway-port", 0, "")
	flags.BoolVar(&request.Verbose, "verbose", false, "")
	flags.BoolVar(&request.JSON, "json", false, "")
	flags.Bool("yes", false, "")
	flags.Uint64Var(&timeoutSeconds, "timeout", 0, "")
	noOnboard := flags.Bool("no-onboard", false, "")
	if err := flags.Parse(args); err != nil {
		return publicLifecycleRequest{}, errors.New("invalid public lifecycle arguments")
	}
	if operation != "install" && (request.TailscaleAuthKeyFile != "" || request.TailnetAccessConfirmed) {
		return publicLifecycleRequest{}, errors.New("Tailscale bootstrap options are install-only")
	}
	gatewayPortSet := false
	flags.Visit(func(candidate *flag.Flag) {
		if candidate.Name == "gateway-port" {
			gatewayPortSet = true
		}
		if candidate.Name == "channel" || candidate.Name == "update-channel" {
			request.ChannelExplicit = true
		}
	})
	remaining := flags.Args()
	if len(remaining) > 0 && remaining[0] == "--" {
		remaining = remaining[1:]
	}
	if operation != "install" && len(remaining) != 0 {
		return publicLifecycleRequest{}, errors.New("managed operation does not accept onboarding arguments")
	}
	request.OnboardArgs = append([]string(nil), remaining...)
	request.Onboard = request.Onboard && !*noOnboard
	request.Version = strings.TrimPrefix(request.Version, "v")
	if request.Version == "stable" || request.Version == "latest" {
		request.Channel, request.Version = "stable", ""
		request.ChannelExplicit = true
	} else if request.Version == "beta" {
		request.Channel, request.Version = "beta", ""
		request.ChannelExplicit = true
	}
	if profile == "" {
		profile = inferProfile(request.OperatorUser)
	}
	request.Profile = model.Profile(profile)
	if request.Profile != model.ProfileProtectedLocal && request.Profile != model.ProfileHosting {
		return publicLifecycleRequest{}, errors.New("profile must be protected-local or hosting")
	}
	if request.Profile != model.ProfileHosting && (request.TailscaleAuthKeyFile != "" || request.TailnetAccessConfirmed) {
		return publicLifecycleRequest{}, errors.New("Tailscale options require the Hosting profile")
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
	if operation == "repair" && request.Version != "" {
		return publicLifecycleRequest{}, errors.New("repair is bound to the exact installed version")
	}
	if operation != "install" && gatewayPortSet {
		return publicLifecycleRequest{}, errors.New("managed update and repair preserve the installed Gateway port")
	}
	if timeoutSeconds > 0 {
		if timeoutSeconds > uint64((30 * time.Minute).Seconds()) {
			return publicLifecycleRequest{}, errors.New("timeout must be between 1 and 1800 seconds")
		}
		request.Timeout = time.Duration(timeoutSeconds) * time.Second
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
	if operation != "install" {
		sudoOperator := os.Getenv("SUDO_USER")
		if sudoOperator != "" && sudoOperator != "root" {
			if request.OperatorUser != "" && request.OperatorUser != sudoOperator {
				return publicLifecycleRequest{}, errors.New("update operator differs from the authorized sudo peer")
			}
			request.OperatorUser = sudoOperator
		}
	}
	if request.OperatorUser == "" || request.OperatorUser == "root" {
		return publicLifecycleRequest{}, errors.New("an unprivileged operator user is required")
	}
	return request, nil
}

func namedFlagCount(args []string, name string) int {
	count := 0
	prefix := "--" + name
	for _, value := range args {
		if value == prefix || strings.HasPrefix(value, prefix+"=") {
			count++
		}
	}
	return count
}

func bindInstalledUpdatePlatform(request *publicLifecycleRequest, operator publicOperator, config platform.Config) error {
	expectedOwnerState := filepath.Join(operator.Home, ".fased")
	if (request.Operation != "update" && request.Operation != "repair") || config.Profile != request.Profile ||
		config.OwnerStateRoot != expectedOwnerState || config.Operator.UID != operator.UID ||
		config.Operator.GID != operator.GID {
		return errors.New("installed lifecycle platform identity differs from the update operator")
	}
	request.GatewayPort = config.GatewayPort
	return nil
}

func bindInstalledUpdateChannel(request *publicLifecycleRequest, installedChannel string, status installedLifecycleStatus) error {
	if request.Operation != "update" && request.Operation != "repair" {
		return errors.New("installed update channel can bind only an installed lifecycle request")
	}
	if request.ChannelExplicit || request.Version != "" {
		return nil
	}
	if installedChannel != "" {
		if installedChannel != "stable" && installedChannel != "beta" {
			return errors.New("installed lifecycle update channel is unsupported")
		}
		request.Channel = installedChannel
		return nil
	}
	// Schema-one managed installations predate the root-owned policy record.
	// Infer the signed channel once from their already-verified installed
	// generation, then persist it during the next full lifecycle transaction.
	// Compatibility behavior remains topology/schema selected.
	request.Channel = "stable"
	if strings.Contains(status.Version, "-") {
		request.Channel = "beta"
	}
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

func invokeLifecycleHost(ctx context.Context, request publicLifecycleRequest, operator publicOperator, result bootstrapResult) (protocol.Response, []byte, error) {
	args := []string{"initialize", "--profile", string(request.Profile), "--operator-user", operator.Name,
		"--owner-state", filepath.Join(operator.Home, ".fased"), "--gateway-port", strconv.Itoa(int(request.GatewayPort)),
		"--update-channel", request.Channel,
		"--generation-archive", result.ApplicationPath, "--dependency-archive", result.DependencyPath,
		"--release-sequence", strconv.FormatUint(result.ReleaseSequence, 10), "--security-epoch", strconv.FormatUint(result.SecurityEpoch, 10),
		"--manifest-protocol-min", strconv.FormatUint(uint64(result.ManifestProtocolMin), 10), "--manifest-protocol-max", strconv.FormatUint(uint64(result.ManifestProtocolMax), 10),
		"--release-index-digest", result.ReleaseIndexDigest, "--release-authority-digest", result.ReleaseAuthorityDigest,
		"--plugin-lock-digest", result.PluginLockDigest}
	if request.Operation == "repair" {
		args = append(args, "--repair-current")
	}
	command := exec.CommandContext(ctx, result.HostPath, args...)
	data, err := command.Output()
	if err != nil {
		if exit, ok := err.(*exec.ExitError); ok {
			return protocol.Response{}, nil, fmt.Errorf("lifecycle transaction failed: %s", tail(exit.Stderr, 4096))
		}
		return protocol.Response{}, nil, err
	}
	if len(data) > 64*1024 {
		return protocol.Response{}, nil, errors.New("lifecycle transaction response exceeded its bound")
	}
	response, decodeErr := decodeTerminalLifecycleResponse(data)
	return response, lifecycleHostVerboseOutput(request, data), decodeErr
}

func lifecycleHostVerboseOutput(request publicLifecycleRequest, data []byte) []byte {
	if !request.Verbose {
		return nil
	}
	return data
}

func lifecycleHostVerboseOutputWriter(request publicLifecycleRequest, output, diagnostics io.Writer) io.Writer {
	if request.JSON {
		return diagnostics
	}
	return output
}

func emitLifecycleHostVerbose(output io.Writer, data []byte) {
	if len(data) > 0 {
		_, _ = output.Write(data)
	}
}

func runOnboarding(ctx context.Context, request publicLifecycleRequest, operator publicOperator, result bootstrapResult, output, diagnostics io.Writer) (protocol.Response, error) {
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
	command.Stdout, command.Stderr = onboardingProcessOutputWriters(request, output, diagnostics)
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
		_, _ = onboardingVerboseOutputWriter(request, output, diagnostics).Write([]byte(tail(data, 64*1024) + "\n"))
	}
	if err != nil {
		return protocol.Response{}, fmt.Errorf("onboarding commit failed: %s", tail(data, 4096))
	}
	return decodeTerminalLifecycleResponse(data)
}

func onboardingProcessOutputWriters(request publicLifecycleRequest, output, diagnostics io.Writer) (io.Writer, io.Writer) {
	if request.JSON {
		return diagnostics, diagnostics
	}
	return os.Stdout, os.Stderr
}

func onboardingVerboseOutputWriter(request publicLifecycleRequest, output, diagnostics io.Writer) io.Writer {
	if request.JSON {
		return diagnostics
	}
	return os.Stdout
}

func decodeTerminalLifecycleResponse(data []byte) (protocol.Response, error) {
	if len(data) == 0 || len(data) > 64*1024 {
		return protocol.Response{}, errors.New("lifecycle transaction response is empty or oversized")
	}
	var response protocol.Response
	if err := json.Unmarshal(data, &response); err != nil || response.SchemaVersion != protocol.CurrentSchemaVersion {
		return protocol.Response{}, errors.New("lifecycle transaction returned an invalid response")
	}
	if response.Outcome != "UPDATED" && response.Outcome != "ALREADY_CURRENT" && response.Outcome != "REPAIRED" {
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
		"FASED_LIFECYCLE_INSTALL_ROOT=" + config.InstallRoot,
		"FASED_WALLET_LOCAL_SIGNER_BIN=" + filepath.Join(config.InstallRoot, "current", "payload", "bin", "fased-signerd"),
		"FASED_WALLET_LOCAL_SIGNER_SOCKET=" + config.ApplicationSocket(),
		"FASED_HOST_UPDATER_SOCKET=" + config.SupervisorSocket(),
	}
	if request.Profile == model.ProfileHosting {
		values = append(values, "FASED_HOST_PROFILE=hosting", "FASED_HOST_ROOT_PREPARED=1", "FASED_UPDATE_CHANNEL="+request.Channel, "FASED_HOSTING_RELEASE="+request.Version)
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
	entry, found, err := platform.FindLocalInstance(platform.LocalInstanceRegistryPathForOS(runtime.GOOS), 0, operator.UID, operator.Name, string(profile), filepath.Join(operator.Home, ".fased"))
	if err != nil {
		return "", err
	}
	if !found {
		return "", errors.New("committed Local lifecycle instance is missing")
	}
	return platform.LocalPlatformConfigPathForOS(runtime.GOOS, entry.InstanceID), nil
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
