package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
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
	"unicode"

	"golang.org/x/term"

	"fased-lifecycled/acquire"
	"fased-lifecycled/daemon"
	"fased-lifecycled/hostsecurity"
	"fased-lifecycled/model"
	"fased-lifecycled/platform"
	"fased-lifecycled/protocol"
	"fased-lifecycled/publicupdate"
	"fased-lifecycled/store"
	"fased-lifecycled/trust"
)

const (
	productionReleaseBase               = "https://github.com/fased-ai/fased/releases/download"
	productionChannelReleasePrefix      = productionReleaseBase + "/fased-channel-"
	releaseRootAssetName                = "fased-lifecycle-root-v1.json"
	releaseIndexAssetName               = "fased-release-index-v2.json"
	releaseIndexAttestationAssetName    = "fased-release-index-v2.json.attestation.json"
	releaseRootHeadAssetName            = "fased-lifecycle-root-head-v2.json"
	releaseRootHeadAttestationAssetName = "fased-lifecycle-root-head-v2.json.attestation.json"
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
	invokePublicHostSecurity           = invokeLifecycleHostSecurity
	readPublicHostingReceipt           = publicupdate.ReadHostingReceipt
	writePublicHostingReceipt          = publicupdate.WriteHostingReceipt
	invokeTargetOwnedHostingUpdate     = invokeTargetOwnedHostingHost
	prunePublicAcquisitionInbox        = pruneAcquisitionInbox
	resolvePublicStatusOperator        = resolveOperator
)

type boundedLifecycleOutput struct {
	buffer    bytes.Buffer
	remaining int
	exceeded  bool
}

func (output *boundedLifecycleOutput) Write(data []byte) (int, error) {
	if len(data) > output.remaining {
		output.exceeded = true
		return 0, errors.New("target lifecycle output exceeded its bound")
	}
	written, err := output.buffer.Write(data)
	output.remaining -= written
	return written, err
}

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
		_, _ = fmt.Fprintln(output, formatLifecyclePhaseFrame(phase))
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

func formatLifecyclePhaseFrame(phase string) string {
	return fmt.Sprintf("\n  ╭─ LIFECYCLE ───────────────────────────────────────────────────────────────────╮\n  │ %-78s │\n  ╰───────────────────────────────────────────────────────────────────────────────╯", phase)
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
	verified, err := trust.VerifyAttestedRootHeadForIndexSchema(headJSON, bundleJSON, now, 2)
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
	if !publicLifecycleRootAuthorized() {
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
	operator, err := resolvePublicStatusOperator(operatorUser, selectedProfile)
	if err != nil {
		return err
	}
	if selectedProfile == model.ProfileHosting {
		receipt, receiptErr := readPublicHostingReceipt()
		if receiptErr == nil {
			if receipt.OperatorUser != operator.Name {
				return errors.New("installed Hosting authority differs from the status operator")
			}
			if jsonOutput {
				_, err = fmt.Fprintf(output, "{\"status\":\"installed\",\"profile\":%q,\"channel\":%q,\"version\":%q,\"releaseSequence\":%d,\"securityEpoch\":%d,\"activeGenerationId\":%q}\n", receipt.Profile, receipt.Channel, receipt.Version, receipt.ReleaseSequence, receipt.SecurityEpoch, receipt.ActiveGenerationID)
				return err
			}
			_, err = fmt.Fprintf(output, "Installed: %s profile=%s channel=%s sequence=%d epoch=%d\n", receipt.Version, receipt.Profile, receipt.Channel, receipt.ReleaseSequence, receipt.SecurityEpoch)
			return err
		}
		if !errors.Is(receiptErr, os.ErrNotExist) {
			return receiptErr
		}
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
	if err := convergeManagedPluginsBeforeCoreGeneration(ctx, config, installedLifecycleStatus{Profile: selectedProfile, ActiveGenerationID: manifest.ActiveGeneration.ID}); err != nil {
		return err
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
	channelBase := productionChannelReleasePrefix + policy.Channel + "-v2"
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
	response, err := callManagedRollback(ctx, config.SupervisorSocket(), protocol.Request{
		SchemaVersion: protocol.CurrentSchemaVersion, RequestID: requestID, Operation: protocol.OperationRollback,
		TargetGenerationID: previous.ID, ExpectedManifestDigest: manifestDigest, RollbackAuthorization: &authorization,
	}, time.Duration(timeoutSeconds)*time.Second, lock)
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

// callManagedRollback keeps the public rollback's already-acquired shared
// lifecycle lease continuous into the persistent supervisor. It duplicates the
// open file description rather than reopening the lock path, so the supervisor
// can execute rollback without self-deadlocking against its caller.
func callManagedRollback(ctx context.Context, socketPath string, request protocol.Request, timeout time.Duration, lock *hostsecurity.MutationLock) (protocol.Response, error) {
	if lock == nil {
		return protocol.Response{}, errors.New("lifecycle mutation lease is unavailable")
	}
	leaseFile, err := lock.DupForChild()
	if err != nil {
		return protocol.Response{}, err
	}
	defer leaseFile.Close()
	return daemon.CallWithLease(ctx, socketPath, request, timeout, leaseFile)
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
	if request.Profile == model.ProfileHosting && (request.Operation == "update" || request.Operation == "repair") {
		receipt, receiptErr := readPublicHostingReceipt()
		if receiptErr == nil {
			return runTargetOwnedHostingLifecycle(ctx, request, operator, receipt, lock, output)
		}
		if !errors.Is(receiptErr, os.ErrNotExist) {
			return receiptErr
		}
	}
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
			productionChannelReleasePrefix+request.Channel+"-v2", productionPinnedRootSHA256,
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
	releaseRoute.RootRotationBaseURL = productionChannelReleasePrefix + request.Channel + "-v2"
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
		Channel: request.Channel, Version: request.Version, OperatingSystem: runtime.GOOS, Architecture: architecture(),
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
	var hostingState hostsecurity.CommandState
	preparedOperatorUser := ""
	hostingTransactionID := ""
	hostingSecurityReused := false
	if request.Profile == model.ProfileHosting {
		hostingTransactionID, err = publicRequestID()
		if err != nil {
			return err
		}
		userOutput := output
		if request.JSON {
			userOutput = io.Discard
		}
		onboardingRequired := request.Operation == "install" && request.Onboard && !ownerConfigExisted
		prepared, prepareErr := invokePublicHostSecurity(ctx, result.HostPath, hostsecurity.CommandRequest{
			SchemaVersion: hostsecurity.CommandSchemaVersion, Operation: hostsecurity.CommandPrepare,
			TransactionID: hostingTransactionID, Release: result.Version, Channel: request.Channel,
			GatewayPort: request.GatewayPort, OperatorUser: operator.Name,
			PlatformIdentity: runtime.GOOS + "/" + architecture(), TrustRootSHA256: releaseRoute.PinnedRootSHA256,
			AuthKeyFile: request.TailscaleAuthKeyFile, Interactive: publicRequestAllowsBrowserAuthentication(request), RequireExistingHardening: request.Operation != "install",
			OnboardingRequired: onboardingRequired,
		}, userOutput)
		if prepareErr != nil {
			return prepareErr
		}
		hostingTransactionID = prepared.TransactionID
		hostingState = prepared
		preparedOperatorUser = prepared.OperatorUser
		hostingSecurityReused = !prepared.NeedsFinalization
	}
	resumePendingOnboarding := hostingState.OnboardingPending
	applyStarted := time.Now()
	applyProgress := beginLifecyclePhase(output, request.JSON, "applying the lifecycle generation")
	var convergence protocol.Response
	var verboseOutput []byte
	lifecycleApplied := false
	if resumePendingOnboarding {
		var alreadyCurrent bool
		convergence, alreadyCurrent, err = recoverPendingHostingOnboarding(operator, hostingState, result)
		if err == nil && !alreadyCurrent {
			convergence, verboseOutput, operator, lifecycleApplied, err = invokeLifecycleHostWithProvisionedOperator(ctx, request, operator, result, lock, preparedOperatorUser, invokeLifecycleHost, resolveOperator)
		} else if err == nil {
			lifecycleApplied = true
			operator, err = refreshPublicOperatorAfterLifecycleApply(operator, request.Profile, preparedOperatorUser, resolveOperator)
		}
	} else {
		convergence, verboseOutput, operator, lifecycleApplied, err = invokeLifecycleHostWithProvisionedOperator(ctx, request, operator, result, lock, preparedOperatorUser, invokeLifecycleHost, resolveOperator)
	}
	applyProgress.Stop()
	performance.ApplyMillis = durationMillis(applyStarted)
	performance.Transaction = convergence.Performance
	emitLifecycleHostVerbose(lifecycleHostVerboseOutputWriter(request, output, os.Stderr), verboseOutput)
	if err != nil {
		if request.Profile == model.ProfileHosting && !hostingSecurityReused && !resumePendingOnboarding && !lifecycleApplied {
			_, abortErr := invokePublicHostSecurity(ctx, result.HostPath, hostsecurity.CommandRequest{
				SchemaVersion: hostsecurity.CommandSchemaVersion, Operation: hostsecurity.CommandAbort, TransactionID: hostingTransactionID,
			}, io.Discard)
			err = errors.Join(err, abortErr)
		}
		return err
	}
	if request.Profile == model.ProfileHosting && !hostingSecurityReused {
		bound, bindErr := invokePublicHostSecurity(ctx, result.HostPath, hostsecurity.CommandRequest{
			SchemaVersion: hostsecurity.CommandSchemaVersion, Operation: hostsecurity.CommandBindRuntimeReady,
			TransactionID: hostingTransactionID, GenerationID: convergence.ActiveGenerationID,
			ConvergenceReceiptDigest: convergence.ConvergenceReceiptDigest, OnboardingRequired: hostingState.OnboardingRequired,
		}, io.Discard)
		if bindErr != nil {
			return fmt.Errorf("Hosting runtime installed but host-security handoff remains pending: %w", bindErr)
		}
		hostingState = bound
	}
	outcome := convergence.Outcome
	if shouldRunOnboarding(request, outcome, ownerConfigExisted) || hostingState.OnboardingPending {
		onboardingStarted := time.Now()
		onboardingCtx, detached := onboardingPhaseContext(ctx, request)
		convergence, err = runOnboarding(onboardingCtx, request, operator, result, lock, output, os.Stderr)
		performance.OnboardingMillis = durationMillis(onboardingStarted)
		if err != nil {
			return err
		}
		if request.Profile == model.ProfileHosting && !hostingSecurityReused {
			completed, completeErr := invokePublicHostSecurity(ctx, result.HostPath, hostsecurity.CommandRequest{
				SchemaVersion: hostsecurity.CommandSchemaVersion, Operation: hostsecurity.CommandCompleteOnboarding,
				TransactionID: hostingTransactionID,
			}, io.Discard)
			if completeErr != nil {
				return fmt.Errorf("onboarding completed but Hosting coordinator remains pending: %w", completeErr)
			}
			hostingState = completed
		}
		if detached {
			var finalizeCancel context.CancelFunc
			ctx, finalizeCancel = context.WithTimeout(context.Background(), request.Timeout)
			defer finalizeCancel()
		}
		outcome = convergence.Outcome
	}
	if request.Profile == model.ProfileHosting && !hostingSecurityReused {
		accessConfirmed := request.TailnetAccessConfirmed
		if !accessConfirmed {
			if committed, commitErr := invokePublicHostSecurity(ctx, result.HostPath, hostsecurity.CommandRequest{
				SchemaVersion: hostsecurity.CommandSchemaVersion, Operation: hostsecurity.CommandCommit,
				TransactionID: hostingTransactionID,
			}, io.Discard); commitErr == nil {
				accessConfirmed = true
				hostingState = committed
			} else if !strings.Contains(commitErr.Error(), "independent tailnet access") {
				return fmt.Errorf("Fased is installed and provider SSH remains open; Hosting hardening is pending: %w", commitErr)
			}
		}
		if !accessConfirmed {
			accessConfirmed, err = confirmTailnetAccess(hostingState, operator, output)
			if err != nil {
				return err
			}
		}
		if _, err := invokePublicHostSecurity(ctx, result.HostPath, hostsecurity.CommandRequest{
			SchemaVersion: hostsecurity.CommandSchemaVersion, Operation: hostsecurity.CommandCommit,
			TransactionID: hostingTransactionID, AccessConfirmed: accessConfirmed,
		}, io.Discard); err != nil {
			return fmt.Errorf("Fased is installed and provider SSH remains open; Hosting hardening is pending: %w", err)
		}
	}
	if request.Profile == model.ProfileHosting {
		if err := writePublicHostingReceipt(publicupdate.Receipt{
			SchemaVersion: publicupdate.SchemaVersion, Profile: request.Profile, Channel: request.Channel,
			Version: result.Version, OperatorUser: operator.Name, GatewayPort: request.GatewayPort,
			PlatformIdentity: runtime.GOOS + "/" + architecture(), ReleaseSequence: result.ReleaseSequence,
			SecurityEpoch: result.SecurityEpoch, ActiveGenerationID: convergence.ActiveGenerationID,
			ConvergenceReceiptDigest: convergence.ConvergenceReceiptDigest,
		}); err != nil {
			return fmt.Errorf("Hosting committed but Stage-0 authority receipt is pending: %w", err)
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
	} else {
		message := "Updated successfully: " + result.Version
		if outcome == "ALREADY_CURRENT" {
			message = "Already current: " + result.Version
		} else if request.Operation == "repair" {
			message = "Repaired successfully: " + result.Version
		}
		err = writeLifecycleOutcome(output, message)
	}
	if err == nil && request.Verbose && !request.JSON {
		_, err = fmt.Fprintln(output, formatLifecyclePerformance(performance))
	}
	return err
}

// runTargetOwnedHostingLifecycle is the permanent Hosting update handoff.
// Stage-0 interprets only its fixed authority receipt, verifies/acquires the
// selected release, and invokes that release's host once. Every evolving
// installation, plugin, security, and generation schema remains target-owned.
func runTargetOwnedHostingLifecycle(ctx context.Context, request publicLifecycleRequest, operator publicOperator, previous publicupdate.Receipt, lock *hostsecurity.MutationLock, output io.Writer) error {
	if runtime.GOOS != "linux" || architecture() != "x64" || previous.Profile != model.ProfileHosting ||
		previous.OperatorUser != operator.Name || previous.PlatformIdentity != runtime.GOOS+"/"+architecture() {
		return errors.New("installed Hosting authority differs from this host or operator")
	}
	request.GatewayPort = previous.GatewayPort
	if request.Operation == "repair" {
		request.Version, request.Channel = previous.Version, previous.Channel
	} else if !request.ChannelExplicit && request.Version == "" {
		request.Channel = previous.Channel
	}
	if err := verifyPublicLifecycleHost(ctx); err != nil {
		return err
	}
	now := time.Now().UTC()
	var selection *signedChannelSelection
	if request.Version == "" {
		progress := beginLifecyclePhase(output, request.JSON, "resolving the trusted release")
		resolved, err := discoverSignedChannelRelease(ctx, request.Channel, &http.Client{Timeout: 15 * time.Second, CheckRedirect: secureMetadataRedirect},
			productionChannelReleasePrefix+request.Channel+"-v2", productionPinnedRootSHA256,
			platform.BootstrapCacheRootForOS(runtime.GOOS), 0, previous.ReleaseSequence, previous.SecurityEpoch, now, nil, nil)
		progress.Stop()
		if err != nil {
			return err
		}
		request.Version = resolved.Version
		selection = &resolved
	}
	releaseRoute, err := publicTrustRoute(request.Version)
	if err != nil {
		return err
	}
	releaseRoute.RootRotationBaseURL = productionChannelReleasePrefix + request.Channel + "-v2"
	if releaseRoute.VerifyIndex != nil {
		releaseRoute.RootRotationBaseURL = releaseRoute.ReleaseBaseURL
	}
	expectedRootVersion, expectedRootSHA256 := uint64(0), ""
	if selection != nil {
		expectedRootVersion, expectedRootSHA256 = selection.RootVersion, selection.RootSHA256
	}
	progress := beginLifecyclePhase(output, request.JSON, "acquiring the verified lifecycle release")
	result, err := executePublicLifecycleBootstrap(ctx, bootstrapRequest{
		StateRoot: platform.BootstrapCacheRootForOS(runtime.GOOS), HostRoot: platform.LifecycleHostRootForOS(runtime.GOOS),
		RootURL: releaseRoute.RootURL, RootRotationBaseURL: releaseRoute.RootRotationBaseURL, IndexURL: releaseRoute.IndexURL,
		IndexAttestationURL: releaseRoute.IndexAttestationURL, ReleaseBaseURL: releaseRoute.ReleaseBaseURL,
		Channel: request.Channel, Version: request.Version, OperatingSystem: runtime.GOOS, Architecture: architecture(),
		PinnedRootSHA256: releaseRoute.PinnedRootSHA256, OwnerUID: 0, Now: now, Inspect: inspectLifecycleHost,
		VerifyIndex: releaseRoute.VerifyIndex, ExpectedRootVersion: expectedRootVersion, ExpectedRootSHA256: expectedRootSHA256,
	})
	progress.Stop()
	if err != nil {
		return err
	}
	if selection != nil {
		if err := validateSignedChannelResult(*selection, result); err != nil {
			return err
		}
	}
	if result.ReleaseSequence < previous.ReleaseSequence || result.SecurityEpoch < previous.SecurityEpoch {
		return errors.New("acquired Hosting release would roll back installed authority")
	}
	publicRequest := publicupdate.Request{
		SchemaVersion: publicupdate.SchemaVersion, Operation: request.Operation, Profile: model.ProfileHosting,
		Channel: request.Channel, Version: result.Version, OperatorUser: operator.Name, GatewayPort: previous.GatewayPort,
		PlatformIdentity: runtime.GOOS + "/" + architecture(), TimeoutSeconds: uint32(request.Timeout / time.Second),
		TrustRootSHA256: releaseRoute.PinnedRootSHA256, HostDigest: result.HostDigest,
		ApplicationPath: result.ApplicationPath, DependencyPath: result.DependencyPath,
		ReleaseSequence: result.ReleaseSequence, SecurityEpoch: result.SecurityEpoch,
		ManifestProtocolMin: result.ManifestProtocolMin, ManifestProtocolMax: result.ManifestProtocolMax,
		ReleaseIndexDigest: result.ReleaseIndexDigest, ReleaseAuthorityDigest: result.ReleaseAuthorityDigest,
		PluginLockDigest: result.PluginLockDigest, ExpectedPreviousSequence: previous.ReleaseSequence,
		ExpectedPreviousEpoch: previous.SecurityEpoch,
	}
	if err := publicRequest.Validate(); err != nil {
		return err
	}
	response, err := invokeTargetOwnedHostingUpdate(ctx, result.HostPath, publicRequest, lock)
	if err != nil {
		return err
	}
	committed, err := readPublicHostingReceipt()
	if err != nil {
		return fmt.Errorf("target lifecycle host did not commit its Stage-0 authority receipt: %w", err)
	}
	if err := publicupdate.ExactReceipt(committed, publicRequest); err != nil {
		return err
	}
	if committed.ActiveGenerationID != response.ActiveGenerationID || committed.ConvergenceReceiptDigest != response.ConvergenceReceiptDigest {
		return errors.New("target lifecycle response differs from its committed authority receipt")
	}
	if err := prunePublicAcquisitionInbox(platform.BootstrapCacheRootForOS(runtime.GOOS)); err != nil {
		return fmt.Errorf("lifecycle committed but verified acquisition cleanup is pending: %w", err)
	}
	if request.JSON {
		return json.NewEncoder(output).Encode(struct {
			Status                   string `json:"status"`
			Version                  string `json:"version"`
			ReleaseSequence          uint64 `json:"releaseSequence"`
			SecurityEpoch            uint64 `json:"securityEpoch"`
			ActiveGenerationID       string `json:"activeGenerationId"`
			ConvergenceReceiptDigest string `json:"convergenceReceiptDigest"`
		}{response.Outcome, result.Version, result.ReleaseSequence, result.SecurityEpoch, response.ActiveGenerationID, response.ConvergenceReceiptDigest})
	}
	message := "Updated successfully: " + result.Version
	if response.Outcome == "ALREADY_CURRENT" {
		message = "Already current: " + result.Version
	} else if request.Operation == "repair" {
		message = "Repaired successfully: " + result.Version
	}
	return writeLifecycleOutcome(output, message)
}

func invokeTargetOwnedHostingHost(ctx context.Context, hostPath string, request publicupdate.Request, lock *hostsecurity.MutationLock) (protocol.Response, error) {
	if lock == nil {
		return protocol.Response{}, errors.New("lifecycle mutation lease is unavailable")
	}
	requestData, err := json.Marshal(request)
	if err != nil {
		return protocol.Response{}, err
	}
	leaseFile, err := lock.DupForChild()
	if err != nil {
		return protocol.Response{}, err
	}
	defer leaseFile.Close()
	stdout := &boundedLifecycleOutput{remaining: 64 << 10}
	stderr := &boundedLifecycleOutput{remaining: 64 << 10}
	command := exec.CommandContext(ctx, hostPath, "hosting-update-v1")
	command.ExtraFiles = []*os.File{leaseFile}
	command.Stdin = bytes.NewReader(requestData)
	command.Stdout, command.Stderr = stdout, stderr
	command.Env = []string{"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "LANG=C.UTF-8", "LC_ALL=C.UTF-8"}
	if err := command.Run(); err != nil {
		if stdout.exceeded || stderr.exceeded {
			return protocol.Response{}, errors.New("target lifecycle host output exceeded its bound")
		}
		return protocol.Response{}, fmt.Errorf("target lifecycle host update failed: %s", tail(stderr.buffer.Bytes(), 4096))
	}
	if stdout.exceeded || stderr.exceeded {
		return protocol.Response{}, errors.New("target lifecycle host output exceeded its bound")
	}
	response, err := decodeTerminalLifecycleResponse(stdout.buffer.Bytes())
	if err != nil {
		return protocol.Response{}, err
	}
	if response.Outcome != "UPDATED" && response.Outcome != "ALREADY_CURRENT" {
		return protocol.Response{}, errors.New("target lifecycle host returned an unsupported outcome")
	}
	return response, nil
}

func writeLifecycleOutcome(output io.Writer, message string) error {
	if outputIsTerminal(output) {
		_, err := fmt.Fprintln(output, formatLifecycleOutcomeFrame(message))
		return err
	}
	_, err := fmt.Fprintln(output, message)
	return err
}

func formatLifecycleOutcomeFrame(message string) string {
	return fmt.Sprintf("\n  ╭─ FASED UPDATE ────────────────────────────────────────────────────────────────╮\n  │ %-78s │\n  ╰───────────────────────────────────────────────────────────────────────────────╯", message)
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
	activation, err := platform.PrepareManagedPluginCoreTransition(config, status.ActiveGenerationID, service)
	if err != nil {
		return fmt.Errorf("inspect managed plugin transaction before core generation transition: %w", err)
	}
	if activation != nil {
		if err := activation.ConvergeBeforeCoreGeneration(ctx); err != nil {
			return fmt.Errorf("converge managed plugin transaction before core generation transition: %w", err)
		}
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

// recoverPendingHostingOnboarding resumes the only deliberate state in which
// the generation is durably committed but live application convergence is not
// yet expected. The actual onboarding child may have been terminated before it
// created the owner configuration. Re-entering the ordinary lifecycle
// AlreadyCurrent path in that state incorrectly tries to repair services from
// that not-yet-created configuration. Bind the resume only to the exact
// installed manifest and coordinator receipt; onboarding completion performs
// the live convergence proof before the Hosting transaction can commit.
func recoverPendingHostingOnboarding(operator publicOperator, state hostsecurity.CommandState, result bootstrapResult) (protocol.Response, bool, error) {
	configPath, err := installedConfigPath(model.ProfileHosting, operator)
	if err != nil {
		return protocol.Response{}, false, err
	}
	configData, err := os.ReadFile(configPath)
	if err != nil {
		return protocol.Response{}, false, errors.New("pending Hosting onboarding platform configuration is unavailable")
	}
	config, err := platform.DecodeConfig(configData)
	if err != nil {
		return protocol.Response{}, false, fmt.Errorf("pending Hosting onboarding platform configuration is invalid: %w", err)
	}
	manifestData, err := os.ReadFile(filepath.Join(config.LifecycleRoot, "installation-manifest.json"))
	if err != nil {
		return protocol.Response{}, false, errors.New("pending Hosting onboarding lifecycle manifest is unavailable")
	}
	status, err := decodeInstalledLifecycleStatus(config, model.ProfileHosting, manifestData)
	if err != nil {
		return protocol.Response{}, false, err
	}
	return validatePendingHostingOnboardingBinding(state, status, result)
}

func validatePendingHostingOnboardingBinding(state hostsecurity.CommandState, status installedLifecycleStatus, result bootstrapResult) (protocol.Response, bool, error) {
	if !state.OnboardingPending || !state.RuntimeReady ||
		!state.OnboardingRequired || state.OnboardingComplete || state.Release != result.Version ||
		status.Profile != model.ProfileHosting ||
		status.ActiveGenerationID != state.LifecycleGenerationID ||
		!digestID(state.LifecycleGenerationID) || !digestID(state.ConvergenceReceiptDigest) {
		return protocol.Response{}, false, errors.New("pending Hosting onboarding differs from the exact acquired generation")
	}
	if status.Version != result.Version {
		if status.ReleaseSequence >= result.ReleaseSequence || status.SecurityEpoch > result.SecurityEpoch {
			return protocol.Response{}, false, errors.New("pending Hosting onboarding cannot adopt the acquired release authority")
		}
		return protocol.Response{}, false, nil
	}
	if status.ReleaseSequence != result.ReleaseSequence || status.SecurityEpoch != result.SecurityEpoch {
		return protocol.Response{}, false, errors.New("pending Hosting onboarding authority differs from the acquired release")
	}
	return protocol.Response{
		SchemaVersion:            protocol.CurrentSchemaVersion,
		Outcome:                  "ALREADY_CURRENT",
		ActiveGenerationID:       state.LifecycleGenerationID,
		ConvergenceReceiptDigest: state.ConvergenceReceiptDigest,
	}, true, nil
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

func confirmTailnetAccess(state hostsecurity.CommandState, operator publicOperator, output io.Writer) (bool, error) {
	if state.SchemaVersion != hostsecurity.CommandSchemaVersion || state.TransactionID == "" || state.TailscaleDNS == "" || state.OperatorUser == "" {
		return false, errors.New("Hosting tailnet confirmation state is invalid")
	}
	gatewayToken, err := readHostingGatewayToken(operator)
	if err != nil {
		return false, err
	}
	_, _ = fmt.Fprintln(output, formatTailnetAccessFrame(state, gatewayToken))
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

func readHostingGatewayToken(operator publicOperator) (string, error) {
	if operator.UID == 0 || !filepath.IsAbs(operator.Home) || filepath.Clean(operator.Home) != operator.Home {
		return "", errors.New("Hosting access owner identity is unsafe")
	}
	stateDir := filepath.Join(operator.Home, ".fased")
	for index, directory := range []string{operator.Home, stateDir} {
		info, err := os.Lstat(directory)
		stat, ok := bootstrapFileInfoStat(info)
		unsafeMode := info != nil && info.Mode().Perm()&0o002 != 0
		if index == 0 {
			unsafeMode = unsafeMode || info != nil && info.Mode().Perm()&0o020 != 0
		} else if info != nil && info.Mode().Perm()&0o020 != 0 {
			unsafeMode = unsafeMode || info.Mode()&os.ModeSetgid == 0
		}
		if err != nil || !ok || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || stat.Uid != operator.UID || unsafeMode {
			return "", errors.Join(err, errors.New("Hosting access state directory is unsafe"))
		}
	}
	secretPath := filepath.Join(stateDir, "gateway-secret")
	info, err := os.Lstat(secretPath)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	pathStat, ok := bootstrapFileInfoStat(info)
	if err != nil || !ok || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0o600 || pathStat.Uid != operator.UID || pathStat.Nlink != 1 || info.Size() < 1 || info.Size() > 4096 {
		return "", errors.Join(err, errors.New("Hosting Gateway token file is unsafe"))
	}
	descriptor, err := syscall.Open(secretPath, syscall.O_RDONLY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return "", err
	}
	file := os.NewFile(uintptr(descriptor), secretPath)
	defer file.Close()
	var opened syscall.Stat_t
	if err := syscall.Fstat(descriptor, &opened); err != nil || opened.Mode&syscall.S_IFMT != syscall.S_IFREG || opened.Uid != operator.UID || opened.Nlink != 1 || opened.Dev != pathStat.Dev || opened.Ino != pathStat.Ino {
		return "", errors.Join(err, errors.New("opened Hosting Gateway token file is unsafe"))
	}
	data, err := io.ReadAll(io.LimitReader(file, 4097))
	if err != nil || len(data) > 4096 {
		return "", errors.Join(err, errors.New("Hosting Gateway token exceeds its bound"))
	}
	token := strings.TrimSpace(string(data))
	if token == "" || strings.IndexFunc(token, unicode.IsSpace) >= 0 || strings.IndexFunc(token, unicode.IsControl) >= 0 {
		return "", errors.New("Hosting Gateway token is malformed")
	}
	return token, nil
}

func bootstrapFileInfoStat(info os.FileInfo) (*syscall.Stat_t, bool) {
	if info == nil {
		return nil, false
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	return stat, ok
}

func formatTailnetAccessFrame(state hostsecurity.CommandState, gatewayToken string) string {
	dashboardURL := "https://" + state.TailscaleDNS
	if gatewayToken != "" {
		dashboardURL += "/#token=" + url.QueryEscape(gatewayToken)
	}
	rows := []string{
		"WEB UI",
		dashboardURL,
		"",
		"AUTH",
	}
	if gatewayToken != "" {
		rows = append(rows,
			"Gateway token is included in the Web UI URL.",
			"Token backup: "+gatewayToken,
		)
	} else {
		rows = append(rows, "Password selected during setup; the browser will prompt for it.")
	}
	rows = append(rows,
		"",
		"TAILSCALE SSH",
		"tailscale ssh "+state.OperatorUser+"@"+state.TailscaleDNS,
		"",
		"Test SSH from your Tailscale computer before public SSH is disabled.",
		"Keep this provider console open while testing.",
	)
	rowWidth := 78
	for _, row := range rows {
		if len(row) > rowWidth && len(row) <= 120 {
			rowWidth = len(row)
		}
	}
	header := "─ PRIVATE HOSTING ACCESS "
	var frame strings.Builder
	_, _ = fmt.Fprintf(&frame, "\n  ╭%s%s╮\n", header, strings.Repeat("─", rowWidth+2-len(header)))
	for _, row := range rows {
		remaining := row
		for len(remaining) > rowWidth {
			_, _ = fmt.Fprintf(&frame, "  │ %-*s │\n", rowWidth, remaining[:rowWidth])
			remaining = remaining[rowWidth:]
		}
		_, _ = fmt.Fprintf(&frame, "  │ %-*s │\n", rowWidth, remaining)
	}
	_, _ = fmt.Fprintf(&frame, "  ╰%s╯", strings.Repeat("─", rowWidth+2))
	return frame.String()
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
	pinBytes, pinErr := hex.DecodeString(branchFixturePinnedRootSHA256)
	if !validUnpublishedMetadataBase(branchFixtureMetadataBase, expectedBase) || pinErr != nil || len(pinBytes) != sha256.Size || strings.ToLower(branchFixturePinnedRootSHA256) != branchFixturePinnedRootSHA256 {
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

func validUnpublishedMetadataBase(base, productionBase string) bool {
	if base == productionBase {
		return true
	}
	parsed, err := url.Parse(base)
	if err != nil || parsed.Scheme != "https" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return false
	}
	host, port, err := net.SplitHostPort(parsed.Host)
	if err != nil || host != "127.0.0.1" || port == "" {
		return false
	}
	if parsed.EscapedPath() != parsed.Path || filepath.Clean(parsed.Path) != parsed.Path || strings.HasSuffix(parsed.Path, "/") {
		return false
	}
	return filepath.Base(parsed.Path) == filepath.Base(productionBase)
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
	if namedFlagCount(request.OnboardArgs, "host-profile") != 0 {
		return publicLifecycleRequest{}, errors.New("onboarding host profile is selected by the lifecycle profile")
	}
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

type publicOperatorResolver func(string, model.Profile) (publicOperator, error)

type lifecycleHostInvoker func(context.Context, publicLifecycleRequest, publicOperator, bootstrapResult, *hostsecurity.MutationLock) (protocol.Response, []byte, error)

func invokeLifecycleHostWithProvisionedOperator(ctx context.Context, request publicLifecycleRequest, operator publicOperator, result bootstrapResult, lifecycleLease *hostsecurity.MutationLock, preparedOperatorUser string, invoke lifecycleHostInvoker, resolve publicOperatorResolver) (protocol.Response, []byte, publicOperator, bool, error) {
	response, output, err := invoke(ctx, request, operator, result, lifecycleLease)
	if err != nil {
		return response, output, operator, false, err
	}
	refreshed, err := refreshPublicOperatorAfterLifecycleApply(operator, request.Profile, preparedOperatorUser, resolve)
	return response, output, refreshed, true, err
}

func refreshPublicOperatorAfterLifecycleApply(operator publicOperator, profile model.Profile, preparedOperatorUser string, resolve publicOperatorResolver) (publicOperator, error) {
	if operator.UID != 0 {
		return operator, nil
	}
	if profile != model.ProfileHosting || operator.Name != "app" || operator.Home != "/home/app" || preparedOperatorUser != operator.Name {
		return publicOperator{}, errors.New("provisioned public lifecycle operator identity is unsafe")
	}
	refreshed, err := resolve(operator.Name, profile)
	if err != nil {
		return publicOperator{}, fmt.Errorf("resolve provisioned Hosting operator: %w", err)
	}
	if refreshed.UID == 0 || refreshed.GID == 0 || refreshed.Name != operator.Name || refreshed.Home != operator.Home {
		return publicOperator{}, errors.New("provisioned Hosting operator identity changed unexpectedly")
	}
	return refreshed, nil
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

func invokeLifecycleHostSecurity(ctx context.Context, hostPath string, request hostsecurity.CommandRequest, userOutput io.Writer) (hostsecurity.CommandState, error) {
	if !filepath.IsAbs(hostPath) || filepath.Clean(hostPath) != hostPath {
		return hostsecurity.CommandState{}, errors.New("lifecycle host path is unsafe")
	}
	data, err := json.Marshal(request)
	if err != nil {
		return hostsecurity.CommandState{}, err
	}
	var stdout strings.Builder
	var diagnostics strings.Builder
	if userOutput == nil {
		userOutput = io.Discard
	}
	command := exec.CommandContext(ctx, hostPath, "hosting-security")
	command.Stdin = strings.NewReader(string(data))
	command.Stdout = &stdout
	command.Stderr = io.MultiWriter(userOutput, &diagnostics)
	if err := command.Run(); err != nil {
		return hostsecurity.CommandState{}, fmt.Errorf("lifecycle host Hosting security command failed: %s", tail([]byte(diagnostics.String()), 4096))
	}
	if stdout.Len() > 64<<10 {
		return hostsecurity.CommandState{}, errors.New("lifecycle host Hosting security response exceeded its bound")
	}
	var state hostsecurity.CommandState
	if err := json.Unmarshal([]byte(stdout.String()), &state); err != nil {
		return hostsecurity.CommandState{}, fmt.Errorf("decode lifecycle host Hosting security response: %w", err)
	}
	if state.SchemaVersion != hostsecurity.CommandSchemaVersion || state.TransactionID != request.TransactionID || state.OperatorUser == "" {
		return hostsecurity.CommandState{}, errors.New("lifecycle host Hosting security response identity is invalid")
	}
	return state, nil
}

func invokeLifecycleHost(ctx context.Context, request publicLifecycleRequest, operator publicOperator, result bootstrapResult, lifecycleLease *hostsecurity.MutationLock) (protocol.Response, []byte, error) {
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
	if lifecycleLease == nil {
		return protocol.Response{}, nil, errors.New("lifecycle mutation lease is unavailable")
	}
	leaseFile, err := lifecycleLease.DupForChild()
	if err != nil {
		return protocol.Response{}, nil, err
	}
	defer leaseFile.Close()
	args = append(args, "--lifecycle-lease-fd", "3")
	command := exec.CommandContext(ctx, result.HostPath, args...)
	command.ExtraFiles = []*os.File{leaseFile}
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

func runOnboarding(ctx context.Context, request publicLifecycleRequest, operator publicOperator, result bootstrapResult, lifecycleLease *hostsecurity.MutationLock, output, diagnostics io.Writer) (protocol.Response, error) {
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
	command := onboardingCommand(ctx, request, operator, config, launcher)
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
		if contextErr := ctx.Err(); contextErr != nil {
			return protocol.Response{}, fmt.Errorf("onboarding deadline ended before completion: %w", contextErr)
		}
		return protocol.Response{}, fmt.Errorf("onboarding failed: %w", err)
	}
	requestID, err := publicRequestID()
	if err != nil {
		return protocol.Response{}, err
	}
	response, err := completeOnboardingWithLease(ctx, config.SupervisorSocket(), requestID, lifecycleLease)
	data, encodeErr := json.Marshal(response)
	if encodeErr == nil {
		data = append(data, '\n')
	}
	if request.Verbose && len(data) > 0 {
		_, _ = onboardingVerboseOutputWriter(request, output, diagnostics).Write([]byte(tail(data, 64*1024) + "\n"))
	}
	if err != nil {
		return protocol.Response{}, fmt.Errorf("onboarding commit failed: %s", tail([]byte(err.Error()), 4096))
	}
	return response, nil
}

func onboardingCommand(ctx context.Context, request publicLifecycleRequest, operator publicOperator, config platform.Config, launcher string) *exec.Cmd {
	args := onboardingCommandArgs(request, operator, config, launcher)
	command := exec.CommandContext(ctx, "/usr/sbin/runuser", args...)
	// The privileged installer is commonly invoked from /root. After runuser
	// drops privilege, that directory is not searchable by the operator and any
	// child process created with process.cwd() fails with EACCES. Bind onboarding
	// to the validated operator home before the privilege drop.
	command.Dir = operator.Home
	command.Env = []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LANG=C.UTF-8", "LC_ALL=C.UTF-8"}
	return command
}

func completeOnboardingWithLease(ctx context.Context, socketPath, requestID string, lifecycleLease *hostsecurity.MutationLock) (protocol.Response, error) {
	if lifecycleLease == nil {
		return protocol.Response{}, errors.New("lifecycle mutation lease is unavailable")
	}
	leaseFile, err := lifecycleLease.DupForChild()
	if err != nil {
		return protocol.Response{}, err
	}
	defer leaseFile.Close()
	return daemon.CallWithLease(ctx, socketPath, protocol.Request{SchemaVersion: protocol.CurrentSchemaVersion, RequestID: requestID, Operation: protocol.OperationCompleteOnboarding}, 5*time.Minute, leaseFile)
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
	hostProfile := "local"
	if request.Profile == model.ProfileHosting {
		hostProfile = "hosting"
	}
	args = append(args, launcher, "onboard", "--install-daemon")
	args = append(args, request.OnboardArgs...)
	if request.Profile == model.ProfileHosting {
		// The root bootstrap has already created and verified the durable Hosting
		// prerequisites marker. The app-owned onboarding process must receive the
		// explicit half of that two-factor capability after the intentional
		// privilege drop; environment or CLI input alone is insufficient.
		args = append(args, "--host-security-capable")
	}
	return append(args, "--host-profile", hostProfile)
}

func onboardingPhaseContext(ctx context.Context, request publicLifecycleRequest) (context.Context, bool) {
	for _, argument := range request.OnboardArgs {
		if argument == "--non-interactive" || argument == "--non-interactive=true" {
			return ctx, false
		}
	}
	// The lifecycle acquisition/apply deadline is a machine-phase bound. A human
	// may take longer while choosing Wallet and provider settings, so interactive
	// onboarding must not inherit that deadline. The bootstrap process and its
	// controlling terminal still own cancellation of the foreground child.
	return context.WithoutCancel(ctx), true
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
