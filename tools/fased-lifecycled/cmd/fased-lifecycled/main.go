package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"syscall"
	"time"

	"fased-lifecycled/bootstrap"
	"fased-lifecycled/bundle"
	"fased-lifecycled/daemon"
	"fased-lifecycled/engine"
	"fased-lifecycled/migrator"
	"fased-lifecycled/model"
	"fased-lifecycled/participant"
	"fased-lifecycled/planner"
	"fased-lifecycled/platform"
	"fased-lifecycled/protocol"
	"fased-lifecycled/signer"
	"fased-lifecycled/statebind"
	"fased-lifecycled/store"
	"golang.org/x/sys/unix"
)

const maxConfigBytes = 64 << 10

var (
	lifecycleBuildVersion     = "dev"
	lifecycleBuildCommit      = "unknown"
	lifecycleBuildTree        = "unknown"
	lifecycleBuildInputDigest = "unknown"
	lifecycleBuildDevelopment = "true"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "fased-lifecycled: %s\n", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		return errors.New("mode must be supervisor or signer-call")
	}
	if len(args) == 1 && args[0] == "--version" {
		_, err := fmt.Fprintf(os.Stdout, "fased-lifecycled %s commit=%s tree=%s buildInputDigest=%s development=%s\n",
			lifecycleBuildVersion, lifecycleBuildCommit, lifecycleBuildTree, lifecycleBuildInputDigest, lifecycleBuildDevelopment)
		return err
	}
	if args[0] == "signer-call" {
		return signer.RunSocketHelper(args[1:], os.Stdin, os.Stdout)
	}
	if args[0] == "request" {
		return runRequest(args[1:], os.Stdout)
	}
	if args[0] == "inventory" {
		return runInventory(args[1:], os.Stdout)
	}
	if args[0] == "state-access-check" {
		return runStateAccessCheck(args[1:])
	}
	if os.Geteuid() != 0 {
		return errors.New("lifecycle supervisor and target modes require root")
	}
	if args[0] == "initialize" {
		return runInitialize(args[1:], os.Stdout)
	}
	flags := flag.NewFlagSet(args[0], flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	var configPath, socketPath string
	flags.StringVar(&configPath, "config", "", "")
	flags.StringVar(&socketPath, "socket", "", "")
	if err := flags.Parse(args[1:]); err != nil || flags.NArg() != 0 {
		return errors.New("invalid lifecycle daemon arguments")
	}
	config, err := loadConfig(configPath, 0)
	if err != nil {
		return err
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	switch args[0] {
	case "supervisor":
		if socketPath != config.SupervisorSocket() {
			return errors.New("supervisor socket does not match platform configuration")
		}
		return runSupervisor(ctx, config, socketPath)
	default:
		return errors.New("unsupported lifecycle daemon mode")
	}
}

func runStateAccessCheck(args []string) error {
	flags := flag.NewFlagSet("state-access-check", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	var path string
	var directory bool
	flags.StringVar(&path, "path", "", "")
	flags.BoolVar(&directory, "directory", false, "")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 || !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return errors.New("invalid state access check arguments")
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil || resolved != path || info.Mode()&os.ModeSymlink != 0 || info.IsDir() != directory || (!directory && !info.Mode().IsRegular()) {
		return errors.New("state access check target is unsafe")
	}
	mode := uint32(unix.R_OK | unix.W_OK)
	if directory {
		mode |= unix.X_OK
	}
	if err := unix.Access(path, mode); err != nil {
		return fmt.Errorf("kernel state access check failed: %w", err)
	}
	openFlags := unix.O_CLOEXEC | unix.O_NOFOLLOW | unix.O_RDWR
	if directory {
		openFlags = unix.O_CLOEXEC | unix.O_NOFOLLOW | unix.O_RDONLY | unix.O_DIRECTORY
	}
	descriptor, err := unix.Open(path, openFlags, 0)
	if err != nil {
		return fmt.Errorf("target identity cannot open state: %w", err)
	}
	if err := unix.Close(descriptor); err != nil {
		return fmt.Errorf("close state access probe: %w", err)
	}
	return nil
}

func runInventory(args []string, output io.Writer) error {
	flags := flag.NewFlagSet("inventory", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	var root, version, commit, tree, outputPath string
	var dependencyHash, dependencyAsset, dependencyArchiveSHA256, pluginLockDigest string
	flags.StringVar(&root, "root", "", "")
	flags.StringVar(&version, "version", "", "")
	flags.StringVar(&commit, "commit", "", "")
	flags.StringVar(&tree, "tree", "", "")
	flags.StringVar(&outputPath, "output", "", "")
	flags.StringVar(&dependencyHash, "dependency-hash", "", "")
	flags.StringVar(&dependencyAsset, "dependency-asset", "", "")
	flags.StringVar(&dependencyArchiveSHA256, "dependency-archive-sha256", "", "")
	flags.StringVar(&pluginLockDigest, "plugin-lock-digest", "", "")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 || root == "" || version == "" || commit == "" || tree == "" || outputPath == "" || pluginLockDigest == "" {
		return errors.New("root, version, commit, tree, output, and plugin lock digest are required")
	}
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return err
	}
	stateSchemas := model.CurrentStateSchemas()
	capabilities := model.CapabilityRanges{
		Supervisor: model.CapabilityRange{Min: 1, Max: 1}, Controller: model.CapabilityRange{Min: 1, Max: 1},
		Migrator: model.CapabilityRange{Min: 1, Max: 1}, Signer: model.CapabilityRange{Min: 2, Max: 2},
	}
	dependencyValues := 0
	for _, value := range []string{dependencyHash, dependencyAsset, dependencyArchiveSHA256} {
		if value != "" {
			dependencyValues++
		}
	}
	pluginLockJSON, err := os.ReadFile(filepath.Join(absRoot, "runtime", "plugin.lock.json"))
	if err != nil {
		return fmt.Errorf("read generation plugin lock: %w", err)
	}
	pluginLock, err := participant.DecodePluginLock(pluginLockJSON)
	if err != nil {
		return fmt.Errorf("decode generation plugin lock: %w", err)
	}
	actualPluginLockDigest, err := participant.PluginLockDigest(pluginLock)
	if err != nil {
		return fmt.Errorf("digest generation plugin lock: %w", err)
	}
	if actualPluginLockDigest != pluginLockDigest {
		return errors.New("generation plugin lock differs from the declared digest")
	}
	var inventory bundle.Inventory
	var generation model.Generation
	if dependencyValues == 0 {
		inventory, generation, err = bundle.Inspect(absRoot, version, commit, tree, stateSchemas, capabilities)
	} else if dependencyValues == 3 {
		inventory, generation, err = bundle.InspectWithDependency(absRoot, version, commit, tree, stateSchemas, capabilities, bundle.DependencyLayer{
			Hash: dependencyHash, Asset: dependencyAsset, ArchiveSHA256: dependencyArchiveSHA256,
		})
	} else {
		return errors.New("dependency hash, asset, and archive digest must be supplied together")
	}
	if err != nil {
		return err
	}
	data, err := bundle.CanonicalInventoryJSON(inventory)
	if err != nil {
		return err
	}
	absOutput, err := filepath.Abs(outputPath)
	if err != nil {
		return err
	}
	if filepath.Dir(absOutput) == absRoot || filepath.Dir(absOutput) == filepath.Join(absRoot, "payload") {
		return errors.New("inventory output must be outside the inventoried payload")
	}
	if err := os.WriteFile(absOutput, append(data, '\n'), 0o600); err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(generation)
}

func runInitialize(args []string, output io.Writer) (resultErr error) {
	flags := flag.NewFlagSet("initialize", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	var profileRaw, instanceID, ownerStateRoot, operatorUser, updateChannel, generationArchive, dependencyArchive, sourceTopology string
	var gatewayPort uint64
	var releaseSequence, securityEpoch uint64
	var manifestProtocolMin, manifestProtocolMax uint64
	var releaseIndexDigest, releaseAuthorityDigest, pluginLockDigest string
	var repairCurrent bool
	flags.StringVar(&profileRaw, "profile", "", "")
	flags.StringVar(&instanceID, "instance", "", "")
	flags.StringVar(&ownerStateRoot, "owner-state", "", "")
	flags.StringVar(&operatorUser, "operator-user", "", "")
	flags.StringVar(&updateChannel, "update-channel", "", "")
	flags.StringVar(&generationArchive, "generation-archive", "", "")
	flags.StringVar(&dependencyArchive, "dependency-archive", "", "")
	flags.StringVar(&sourceTopology, "source-topology", "", "")
	flags.Uint64Var(&gatewayPort, "gateway-port", 0, "")
	flags.Uint64Var(&releaseSequence, "release-sequence", 0, "")
	flags.Uint64Var(&securityEpoch, "security-epoch", 0, "")
	flags.Uint64Var(&manifestProtocolMin, "manifest-protocol-min", 0, "")
	flags.Uint64Var(&manifestProtocolMax, "manifest-protocol-max", 0, "")
	flags.StringVar(&releaseIndexDigest, "release-index-digest", "", "")
	flags.StringVar(&releaseAuthorityDigest, "release-authority-digest", "", "")
	flags.StringVar(&pluginLockDigest, "plugin-lock-digest", "", "")
	flags.BoolVar(&repairCurrent, "repair-current", false, "")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 || gatewayPort == 0 || gatewayPort > 65535 ||
		(updateChannel != "stable" && updateChannel != "beta") {
		return errors.New("invalid lifecycle initialization arguments")
	}
	if manifestProtocolMin > uint64(^uint32(0)) || manifestProtocolMax > uint64(^uint32(0)) {
		return errors.New("manifest protocol range exceeds uint32")
	}
	profile := model.Profile(profileRaw)
	if operatorUser == "" {
		return errors.New("lifecycle initialization requires an operator user")
	}
	initializationLock, err := acquireInitializationLockForOS(runtime.GOOS, profile)
	if err != nil {
		return err
	}
	defer func() { resultErr = errors.Join(resultErr, initializationLock.Release()) }()
	principalSystem, err := platform.NewPrincipalSystem()
	if err != nil {
		return err
	}
	discovered, err := discoverInitialization(runtime.GOOS, profile, instanceID, ownerStateRoot, operatorUser, principalSystem)
	if err != nil {
		return err
	}
	publicPredecessorVersion := ""
	switch discovered.Installation.Kind {
	case planner.InstallationAmbiguous:
		return errors.New("installation is ambiguous; explicit repair is required")
	case planner.InstallationUnknownNewer:
		return errors.New("installation schema is newer than this lifecycle engine")
	case planner.InstallationPublicStable:
		if sourceTopology != "" && sourceTopology != string(discovered.Topology) {
			return errors.New("caller source topology differs from read-only discovery")
		}
		sourceTopology = string(discovered.Topology)
		publicPredecessorVersion = discovered.PublicPredecessorVersion
	case planner.InstallationEmpty, planner.InstallationManaged:
		if sourceTopology != "" {
			return errors.New("caller supplied a source topology for a non-bridge installation")
		}
	default:
		return errors.New("installation discovery returned an unsupported class")
	}
	if repairCurrent && discovered.Installation.Kind != planner.InstallationManaged {
		return errors.New("managed repair requires an existing canonical installation")
	}
	applyArguments, err := initializationApplyArguments("", generationArchive, dependencyArchive, sourceTopology, publicPredecessorVersion, releaseSequence, securityEpoch, uint32(manifestProtocolMin), uint32(manifestProtocolMax), releaseIndexDigest, releaseAuthorityDigest, pluginLockDigest)
	if err != nil {
		return err
	}
	if repairCurrent {
		applyArguments = append(applyArguments, "--repair-current")
	}
	if discovered.Installation.Kind == planner.InstallationManaged && !repairCurrent {
		configPath, fast, fastErr := managedInitializationFastPath(discovered.Installation, profile, instanceID, ownerStateRoot, operatorUser, uint16(gatewayPort), updateChannel,
			releaseSequence, securityEpoch, uint32(manifestProtocolMin), uint32(manifestProtocolMax), releaseIndexDigest, releaseAuthorityDigest, pluginLockDigest, principalSystem)
		if fastErr != nil {
			return fastErr
		}
		if fast {
			applyArguments[1] = configPath
			return applyVerifiedArchive(applyArguments, output)
		}
	}
	homeACL, err := platform.NewHomeACL()
	if err != nil {
		return err
	}
	serviceManager, err := platform.NewSystemServiceManager()
	if err != nil {
		return err
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	stableDaemon, err := os.ReadFile(executable)
	if err != nil {
		return err
	}
	transactionID, err := randomRequestID()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	result, err := bootstrap.BeginPlatformBootstrap(ctx, bootstrap.PlatformBootstrapRequest{
		TransactionID: transactionID, Profile: profile, InstanceIDAssertion: instanceID,
		OperatorUser: operatorUser, OwnerStateRoot: ownerStateRoot, UpdateChannel: updateChannel, GatewayPort: uint16(gatewayPort),
		ExpectedRegistryOwner: 0, RegistryPath: platform.LocalInstanceRegistryPathForOS(runtime.GOOS),
		JournalPath:  filepath.Join(platform.BootstrapJournalRootForOS(runtime.GOOS), transactionID+".json"),
		StableDaemon: stableDaemon, Principals: principalSystem, ACL: homeACL, Systemd: serviceManager, OperatingSystem: runtime.GOOS,
		BridgePublicStable: discovered.Installation.Kind == planner.InstallationPublicStable,
	})
	if err != nil {
		return err
	}
	defer func() { resultErr = errors.Join(resultErr, result.ReleaseCreatedRootHandles()) }()
	configPath := filepath.Join(result.Config.LifecycleRoot, "platform.json")
	applyArguments[1] = configPath
	if err := applyVerifiedArchive(applyArguments, output); err != nil {
		rollbackErr := result.Transaction.Rollback()
		cleanupErr := cleanupFailedInitialization(result, rollbackErr)
		if cleanupErr == nil {
			rollbackErr = nil
		}
		return errors.Join(err, rollbackErr, cleanupErr)
	}
	result.Transaction.Commit()
	return nil
}

func managedInitializationFastPath(
	installation planner.Installation,
	profile model.Profile,
	instanceAssertion, ownerStateRoot, operatorUser string,
	gatewayPort uint16,
	updateChannel string,
	releaseSequence, securityEpoch uint64,
	manifestProtocolMin, manifestProtocolMax uint32,
	releaseIndexDigest, releaseAuthorityDigest, pluginLockDigest string,
	principals platform.PrincipalSystem,
) (string, bool, error) {
	if installation.Kind != planner.InstallationManaged || installation.Manifest == nil || installation.Manifest.ActiveGeneration == nil {
		return "", false, errors.New("managed fast path requires an installed active generation")
	}
	manifest := installation.Manifest
	if instanceAssertion != "" && instanceAssertion != manifest.Platform.InstanceID {
		return "", false, errors.New("caller instance assertion differs from the managed manifest")
	}
	configPath := platform.LocalPlatformConfigPathForOS(runtime.GOOS, manifest.Platform.InstanceID)
	if profile == model.ProfileHosting {
		configPath = "/var/lib/fased-lifecycled/platform.json"
	}
	config, err := loadConfig(configPath, 0)
	if err != nil {
		return "", false, err
	}
	operator, exists, err := principals.LookupUser(context.Background(), operatorUser)
	if err != nil || !exists {
		return "", false, errors.New("managed update operator is unavailable")
	}
	state, err := store.OpenExistingLayout(store.Layout{StateRoot: config.LifecycleRoot, InstallRoot: config.InstallRoot})
	if err != nil {
		return "", false, err
	}
	authority, bound, err := managedFastPathAuthority(state, *manifest)
	if err != nil {
		return "", false, err
	}
	if !bound {
		return configPath, false, nil
	}
	policy, err := platform.ReadUpdatePolicy(config)
	if errors.Is(err, os.ErrNotExist) {
		return configPath, false, nil
	}
	if err != nil {
		return "", false, err
	}
	fast, err := managedInitializationInputsMatch(*manifest, config, operator, ownerStateRoot, gatewayPort, updateChannel,
		authority, policy, releaseSequence, securityEpoch, manifestProtocolMin, manifestProtocolMax,
		releaseIndexDigest, releaseAuthorityDigest, pluginLockDigest)
	return configPath, fast, err
}

type candidateAuthorityReader interface {
	ReadCandidateAuthority(string) (store.CandidateAuthority, error)
}

func managedFastPathAuthority(reader candidateAuthorityReader, manifest model.Manifest) (store.CandidateAuthority, bool, error) {
	if manifest.ActiveGeneration == nil {
		return store.CandidateAuthority{}, false, errors.New("managed fast path requires an installed active generation")
	}
	authority, err := reader.ReadCandidateAuthority(manifest.ActiveGeneration.ID)
	if errors.Is(err, os.ErrNotExist) && manifest.SchemaVersion == 1 {
		return store.CandidateAuthority{}, false, nil
	}
	if err != nil {
		return store.CandidateAuthority{}, false, err
	}
	return authority, true, nil
}

func managedInitializationInputsMatch(
	manifest model.Manifest,
	config platform.Config,
	operator platform.AccountRecord,
	ownerStateRoot string,
	gatewayPort uint16,
	updateChannel string,
	authority store.CandidateAuthority,
	policy platform.UpdatePolicy,
	releaseSequence, securityEpoch uint64,
	manifestProtocolMin, manifestProtocolMax uint32,
	releaseIndexDigest, releaseAuthorityDigest, pluginLockDigest string,
) (bool, error) {
	if manifest.ActiveGeneration == nil || operator.UID != config.Operator.UID || operator.GID != config.Operator.GID ||
		operator.Home != filepath.Dir(ownerStateRoot) || config.Profile != manifest.Profile || config.InstanceID != manifest.Platform.InstanceID ||
		config.OwnerStateRoot != ownerStateRoot || config.GatewayPort != gatewayPort {
		return false, errors.New("managed platform configuration differs from the authorized update identity")
	}
	configIdentity, err := config.Identity()
	if err != nil {
		return false, err
	}
	configDigest, err := configIdentity.Digest(manifest.Profile)
	if err != nil {
		return false, err
	}
	manifestDigest, err := manifest.Platform.Digest(manifest.Profile)
	if err != nil || configDigest != manifestDigest {
		return false, errors.New("managed manifest platform differs from its root configuration")
	}
	return policy.Channel == updateChannel &&
		authority.GenerationID == manifest.ActiveGeneration.ID &&
		authority.ReleaseSequence == releaseSequence && authority.SecurityEpoch == securityEpoch &&
		authority.ManifestMin == manifestProtocolMin && authority.ManifestMax == manifestProtocolMax &&
		authority.ReleaseIndex == releaseIndexDigest && authority.ReleaseAuthority == releaseAuthorityDigest &&
		authority.PluginLockDigest == pluginLockDigest, nil
}

type initializationMutationLock struct{ file *os.File }

func acquireInitializationLock(profile model.Profile) (*initializationMutationLock, error) {
	return acquireInitializationLockForOS(runtime.GOOS, profile)
}

func acquireInitializationLockForOS(operatingSystem string, profile model.Profile) (*initializationMutationLock, error) {
	var path string
	switch profile {
	case model.ProfileProtectedLocal:
		path = platform.BootstrapMutationLockPathForOS(operatingSystem)
	case model.ProfileHosting:
		if operatingSystem != "linux" {
			return nil, errors.New("Hosting lifecycle is supported only on Linux")
		}
		path = "/run/lock/fased-bootstrap-hosting.lock"
	default:
		return nil, errors.New("lifecycle initialization profile is unsupported")
	}
	return acquireInitializationLockAt(path, 0)
}

func acquireInitializationLockAt(path string, expectedUID uint32) (*initializationMutationLock, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path || path == "/" {
		return nil, errors.New("initialization lock path is unsafe")
	}
	descriptor, err := syscall.Open(path, syscall.O_CREAT|syscall.O_RDWR|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(descriptor), path)
	closeOnError := func(err error) (*initializationMutationLock, error) {
		_ = file.Close()
		return nil, err
	}
	var stat syscall.Stat_t
	if err := syscall.Fstat(descriptor, &stat); err != nil {
		return closeOnError(err)
	}
	if stat.Mode&syscall.S_IFMT != syscall.S_IFREG || stat.Mode&0o777 != 0o600 || stat.Uid != expectedUID || stat.Nlink != 1 {
		return closeOnError(errors.New("initialization lock file is unsafe"))
	}
	if err := syscall.Flock(descriptor, syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return closeOnError(errors.New("another bootstrap transaction is active"))
		}
		return closeOnError(err)
	}
	return &initializationMutationLock{file: file}, nil
}

func (lock *initializationMutationLock) Release() error {
	if lock == nil || lock.file == nil {
		return nil
	}
	file := lock.file
	lock.file = nil
	return errors.Join(syscall.Flock(int(file.Fd()), syscall.LOCK_UN), file.Close())
}

func cleanupFailedInitialization(result bootstrap.PlatformBootstrapResult, rollbackErr error) error {
	if err := result.Config.Validate(); err != nil {
		return err
	}
	removals, onlyRemovalFailures := bootstrapPathRemovalFailures(rollbackErr)
	if !onlyRemovalFailures {
		return errors.New("failed initialization retained canonical roots because safety-critical bootstrap rollback failed")
	}
	roots := append([]platform.CreatedBootstrapRoot(nil), result.CreatedRoots...)
	sort.Slice(roots, func(left, right int) bool { return len(roots[left].Path()) > len(roots[right].Path()) })
	var failures []error
	for _, root := range roots {
		failures = append(failures, root.RemoveAllIfSame())
	}
	if err := errors.Join(failures...); err != nil {
		return err
	}
	for _, removal := range removals {
		if err := os.Remove(removal.Path); err != nil && !errors.Is(err, os.ErrNotExist) {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}

func bootstrapPathRemovalFailures(err error) ([]*platform.BootstrapPathRemovalError, bool) {
	if err == nil {
		return nil, true
	}
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		var removals []*platform.BootstrapPathRemovalError
		for _, nested := range joined.Unwrap() {
			selected, only := bootstrapPathRemovalFailures(nested)
			if !only {
				return nil, false
			}
			removals = append(removals, selected...)
		}
		return removals, true
	}
	var removal *platform.BootstrapPathRemovalError
	if errors.As(err, &removal) && (errors.Is(removal.Err, syscall.ENOTEMPTY) || errors.Is(removal.Err, os.ErrNotExist)) {
		return []*platform.BootstrapPathRemovalError{removal}, true
	}
	return nil, false
}

func discoverInitialization(operatingSystem string, profile model.Profile, instanceID, ownerStateRoot, operatorUser string, principals platform.PrincipalSystem) (platform.DiscoveryResult, error) {
	selectedInstance := instanceID
	if profile == model.ProfileProtectedLocal && selectedInstance == "" {
		operator, exists, err := principals.LookupUser(context.Background(), operatorUser)
		if err != nil || !exists {
			return platform.DiscoveryResult{}, errors.New("Local operator is unavailable during read-only discovery")
		}
		entry, found, err := platform.FindLocalInstance(platform.LocalInstanceRegistryPathForOS(operatingSystem), 0, operator.UID, operatorUser, string(profile), ownerStateRoot)
		if err != nil {
			return platform.DiscoveryResult{}, err
		}
		if found {
			selectedInstance = entry.InstanceID
		} else {
			selectedInstance = "unallocated"
		}
	}
	manifestPath := filepath.Join(platform.LocalLifecycleRootForOS(operatingSystem, selectedInstance), "installation-manifest.json")
	installRoot := platform.LocalInstallRootForOS(operatingSystem, selectedInstance)
	if profile == model.ProfileHosting {
		manifestPath = "/var/lib/fased-lifecycled/installation-manifest.json"
		installRoot = "/opt/fased"
	}
	return platform.DiscoverInstallation(platform.DiscoveryRequest{
		Profile: profile, OwnerStateRoot: ownerStateRoot,
		CanonicalManifestPath: manifestPath, CanonicalInstallRoot: installRoot,
	})
}

func initializationApplyArguments(configPath, generationArchive, dependencyArchive, sourceTopology, publicPredecessorVersion string, releaseSequence, securityEpoch uint64, manifestProtocolMin, manifestProtocolMax uint32, releaseIndexDigest, releaseAuthorityDigest, pluginLockDigest string) ([]string, error) {
	if generationArchive == "" {
		return nil, errors.New("invalid lifecycle initialization generation input")
	}
	if !filepath.IsAbs(generationArchive) || filepath.Clean(generationArchive) != generationArchive {
		return nil, errors.New("invalid lifecycle initialization generation input")
	}
	arguments := []string{"--config", configPath, "--generation-archive", generationArchive}
	if releaseSequence == 0 || securityEpoch == 0 || manifestProtocolMin == 0 || manifestProtocolMax < manifestProtocolMin || releaseIndexDigest == "" || releaseAuthorityDigest == "" || pluginLockDigest == "" {
		return nil, errors.New("lifecycle initialization requires signed release authority")
	}
	arguments = append(arguments,
		"--release-sequence", strconv.FormatUint(releaseSequence, 10),
		"--security-epoch", strconv.FormatUint(securityEpoch, 10),
		"--manifest-protocol-min", strconv.FormatUint(uint64(manifestProtocolMin), 10),
		"--manifest-protocol-max", strconv.FormatUint(uint64(manifestProtocolMax), 10),
		"--release-index-digest", releaseIndexDigest,
		"--release-authority-digest", releaseAuthorityDigest,
		"--plugin-lock-digest", pluginLockDigest)
	if dependencyArchive != "" {
		if !filepath.IsAbs(dependencyArchive) || filepath.Clean(dependencyArchive) != dependencyArchive {
			return nil, errors.New("invalid lifecycle initialization dependency input")
		}
		arguments = append(arguments, "--dependency-archive", dependencyArchive)
	}
	if err := validatePublicPredecessorEvidence(sourceTopology, publicPredecessorVersion); err != nil {
		return nil, err
	}
	if sourceTopology != "" {
		arguments = append(arguments, "--source-topology", sourceTopology)
	}
	if publicPredecessorVersion != "" {
		arguments = append(arguments, "--public-predecessor-version", publicPredecessorVersion)
	}
	return arguments, nil
}

type bootstrapUnitReplacement struct {
	Path     string
	Previous []byte
	Existed  bool
}

func replaceBootstrapUnit(path string, data []byte) (bootstrapUnitReplacement, error) {
	replacement := bootstrapUnitReplacement{Path: path}
	if info, err := os.Lstat(path); err == nil {
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0o644 || !ok || stat.Uid != uint32(os.Geteuid()) || stat.Nlink != 1 {
			return replacement, errors.New("existing lifecycle supervisor unit is unsafe")
		}
		previous, readErr := os.ReadFile(path)
		if readErr != nil {
			return replacement, readErr
		}
		replacement.Previous = previous
		replacement.Existed = true
	} else if !errors.Is(err, os.ErrNotExist) {
		return replacement, err
	}
	if err := writeBootstrapRecord(path, data, 0o644); err != nil {
		return replacement, err
	}
	return replacement, nil
}

func (replacement bootstrapUnitReplacement) Restore() error {
	if replacement.Existed {
		return writeBootstrapRecord(replacement.Path, replacement.Previous, 0o644)
	}
	if err := os.Remove(replacement.Path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func installExactRecord(path string, data []byte, mode os.FileMode) error {
	if existing, err := os.ReadFile(path); err == nil {
		info, statErr := os.Lstat(path)
		if statErr != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != mode.Perm() || string(existing) != string(data) {
			return errors.New("existing lifecycle bootstrap record differs; explicit repair is required")
		}
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return writeBootstrapRecord(path, data, mode)
}

func writeBootstrapRecord(path string, data []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".fased-bootstrap-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(mode); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporaryPath, path)
}

func installStableBinary(path string) error {
	if err := ensureStableBinaryDirectory(filepath.Dir(path)); err != nil {
		return err
	}
	if info, err := os.Lstat(path); err == nil {
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0o755 || !ok || stat.Uid != 0 || stat.Nlink != 1 {
			return errors.New("installed lifecycle supervisor binary is unsafe")
		}
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	data, err := os.ReadFile(executable)
	if err != nil {
		return err
	}
	return installExactRecord(path, data, 0o755)
}

func ensureStableBinaryDirectory(directory string) error {
	if !filepath.IsAbs(directory) || filepath.Clean(directory) != directory || directory == "/" {
		return errors.New("stable lifecycle binary directory is invalid")
	}
	for _, current := range []string{filepath.Dir(directory), directory} {
		if err := os.Mkdir(current, 0o755); err != nil && !errors.Is(err, os.ErrExist) {
			return err
		}
		info, err := os.Lstat(current)
		if err != nil {
			return err
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || !ok || stat.Uid != uint32(os.Geteuid()) || info.Mode().Perm()&0o022 != 0 {
			return errors.New("stable lifecycle binary directory is unsafe")
		}
		if err := os.Chmod(current, 0o755); err != nil {
			return err
		}
	}
	return nil
}

func applyVerifiedArchive(args []string, output io.Writer) error {
	flags := flag.NewFlagSet("verified-archive-apply", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	var configPath, generationArchive, dependencyArchive, sourceTopology, publicPredecessorVersion string
	var releaseIndexDigest, releaseAuthorityDigest, pluginLockDigest string
	var releaseSequence, securityEpoch uint64
	var manifestProtocolMin, manifestProtocolMax uint64
	var repairCurrent bool
	flags.StringVar(&configPath, "config", "", "")
	flags.StringVar(&generationArchive, "generation-archive", "", "")
	flags.StringVar(&dependencyArchive, "dependency-archive", "", "")
	flags.StringVar(&sourceTopology, "source-topology", "", "")
	flags.StringVar(&publicPredecessorVersion, "public-predecessor-version", "", "")
	flags.Uint64Var(&releaseSequence, "release-sequence", 0, "")
	flags.Uint64Var(&securityEpoch, "security-epoch", 0, "")
	flags.Uint64Var(&manifestProtocolMin, "manifest-protocol-min", 0, "")
	flags.Uint64Var(&manifestProtocolMax, "manifest-protocol-max", 0, "")
	flags.StringVar(&releaseIndexDigest, "release-index-digest", "", "")
	flags.StringVar(&releaseAuthorityDigest, "release-authority-digest", "", "")
	flags.StringVar(&pluginLockDigest, "plugin-lock-digest", "", "")
	flags.BoolVar(&repairCurrent, "repair-current", false, "")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 {
		return errors.New("invalid lifecycle apply arguments")
	}
	if manifestProtocolMin > uint64(^uint32(0)) || manifestProtocolMax > uint64(^uint32(0)) {
		return errors.New("manifest protocol range exceeds uint32")
	}
	if generationArchive == "" {
		return errors.New("invalid lifecycle apply arguments")
	}
	if !filepath.IsAbs(generationArchive) || filepath.Clean(generationArchive) != generationArchive {
		return errors.New("invalid lifecycle apply arguments")
	}
	if dependencyArchive != "" && (!filepath.IsAbs(dependencyArchive) || filepath.Clean(dependencyArchive) != dependencyArchive) {
		return errors.New("invalid lifecycle dependency archive")
	}
	if err := validatePublicPredecessorEvidence(sourceTopology, publicPredecessorVersion); err != nil {
		return err
	}
	config, err := loadConfig(configPath, 0)
	if err != nil {
		return err
	}
	state, err := store.OpenLayout(store.Layout{StateRoot: config.LifecycleRoot, InstallRoot: config.InstallRoot})
	if err != nil {
		return err
	}
	generation, err := state.ImportGenerationArchive(generationArchive)
	if err != nil {
		return err
	}
	if err := importGenerationDependency(state, generation, dependencyArchive); err != nil {
		return err
	}
	if err := state.BindCandidateAuthority(store.CandidateAuthority{
		SchemaVersion: 1, GenerationID: generation.ID, ReleaseSequence: releaseSequence, SecurityEpoch: securityEpoch,
		ManifestMin: uint32(manifestProtocolMin), ManifestMax: uint32(manifestProtocolMax),
		ReleaseIndex: releaseIndexDigest, ReleaseAuthority: releaseAuthorityDigest, PluginLockDigest: pluginLockDigest,
	}); err != nil {
		return err
	}
	// Promote verified bytes before the stable supervisor enters its read-only
	// installation namespace. The installed host repeats this operation
	// idempotently inside the durable product transaction.
	if err := state.StageGeneration(generation.ID); err != nil {
		return err
	}
	expectedManifest := "absent"
	if _, digest, readErr := state.ReadManifest(); readErr == nil {
		expectedManifest = digest
	} else if !errors.Is(readErr, os.ErrNotExist) {
		return readErr
	}
	serviceManager, err := platform.NewSystemServiceManager()
	if err != nil {
		return err
	}
	identity, err := config.Identity()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Minute)
	defer cancel()
	if err := serviceManager.IsActive(ctx, identity.Services["supervisor"]); err != nil {
		if err := serviceManager.Start(ctx, identity.Services["supervisor"]); err != nil {
			return err
		}
	}
	if err := waitForSocket(ctx, config.SupervisorSocket()); err != nil {
		return err
	}
	requestID, err := randomRequestID()
	if err != nil {
		return err
	}
	operation := protocol.OperationConverge
	if repairCurrent {
		operation = protocol.OperationRepairCurrent
	}
	response, err := daemon.Call(ctx, config.SupervisorSocket(), protocol.Request{
		SchemaVersion: protocol.CurrentSchemaVersion, RequestID: requestID,
		Operation: operation, TargetGenerationID: generation.ID,
		SourceTopology:           sourceTopology,
		PublicPredecessorVersion: publicPredecessorVersion,
		ExpectedManifestDigest:   expectedManifest,
	}, 5*time.Minute)
	if err != nil {
		return err
	}
	return writeConvergenceResponse(output, response)
}

func writeConvergenceResponse(output io.Writer, response protocol.Response) error {
	if err := json.NewEncoder(output).Encode(response); err != nil {
		return err
	}
	if response.Outcome != string(engine.OutcomeUpdated) && response.Outcome != string(engine.OutcomeAlreadyCurrent) && response.Outcome != "REPAIRED" {
		detail := response.Detail
		if detail == "" {
			detail = "lifecycle transaction did not commit"
		}
		return fmt.Errorf("%s: %s", response.Outcome, detail)
	}
	return nil
}

func waitForSocket(ctx context.Context, path string) error {
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		info, err := os.Lstat(path)
		if err == nil && info.Mode()&os.ModeSocket != 0 && info.Mode()&os.ModeSymlink == 0 {
			return nil
		}
		select {
		case <-ctx.Done():
			return errors.New("lifecycle supervisor socket did not become ready")
		case <-ticker.C:
		}
	}
}

func randomRequestID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", value[0:4], value[4:6], value[6:8], value[8:10], value[10:16]), nil
}

func importGenerationDependency(state *store.Store, generation model.Generation, archive string) error {
	layer, err := state.GenerationDependency(generation.ID)
	if err != nil {
		return err
	}
	if layer == nil {
		if archive != "" {
			return errors.New("legacy generation must not receive a dependency archive")
		}
		return nil
	}
	if archive == "" {
		return errors.New("generation requires its exact dependency archive")
	}
	return state.ImportDependencyArchive(archive, *layer)
}

func runRequest(args []string, output io.Writer) error {
	socketPath, request, err := parseLifecycleRequestArguments(args)
	if err != nil {
		return err
	}
	response, err := daemon.Call(context.Background(), socketPath, request, 6*time.Minute)
	if err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(response)
}

func parseLifecycleRequestArguments(args []string) (string, protocol.Request, error) {
	flags := flag.NewFlagSet("request", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	var socketPath, operation, requestID, targetID, sourceTopology, publicPredecessorVersion, manifestDigest, transactionID string
	flags.StringVar(&socketPath, "socket", "", "")
	flags.StringVar(&operation, "operation", "", "")
	flags.StringVar(&requestID, "request-id", "", "")
	flags.StringVar(&targetID, "target-generation", "", "")
	flags.StringVar(&sourceTopology, "source-topology", "", "")
	flags.StringVar(&publicPredecessorVersion, "public-predecessor-version", "", "")
	flags.StringVar(&manifestDigest, "expected-manifest", "", "")
	flags.StringVar(&transactionID, "transaction", "", "")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 || !filepath.IsAbs(socketPath) {
		return "", protocol.Request{}, errors.New("invalid lifecycle request arguments")
	}
	request := protocol.Request{SchemaVersion: protocol.CurrentSchemaVersion, RequestID: requestID,
		Operation: protocol.Operation(operation), TargetGenerationID: targetID,
		SourceTopology: sourceTopology, PublicPredecessorVersion: publicPredecessorVersion,
		ExpectedManifestDigest: manifestDigest, TransactionID: transactionID}
	if err := request.Validate(); err != nil {
		return "", protocol.Request{}, err
	}
	return socketPath, request, nil
}

func validatePublicPredecessorEvidence(sourceTopology, publicPredecessorVersion string) error {
	if (sourceTopology == "") != (publicPredecessorVersion == "") {
		return errors.New("public predecessor topology and version must be supplied together")
	}
	if publicPredecessorVersion != "" {
		if err := model.ValidateVersion(publicPredecessorVersion); err != nil {
			return fmt.Errorf("public predecessor version: %w", err)
		}
	}
	return nil
}

func runSupervisor(ctx context.Context, config platform.Config, socketPath string) error {
	state, err := store.OpenExistingLayout(store.Layout{StateRoot: config.LifecycleRoot, InstallRoot: config.InstallRoot})
	if err != nil {
		return err
	}
	identity, err := config.Identity()
	if err != nil {
		return err
	}
	serviceManager, err := platform.NewSystemServiceManager()
	if err != nil {
		return err
	}
	targetEngine, targetAdapter, err := installedTargetRuntime(config, identity, state, serviceManager)
	if err != nil {
		return err
	}
	supervisor := &engine.SupervisorEngine{Journal: state, Target: targetEngine}
	binder := &statebind.Binder{Specs: statebind.CanonicalSpecs(config.OwnerStateRoot, config.InstallRoot, config.SignerStateRoot())}
	evidence := platform.DiscoveryEvidenceVerifier{Request: platform.DiscoveryRequest{
		Profile: config.Profile, OwnerStateRoot: config.OwnerStateRoot,
		CanonicalManifestPath: filepath.Join(config.LifecycleRoot, "installation-manifest.json"), CanonicalInstallRoot: config.InstallRoot,
	}}
	service := &daemon.Service{Profile: config.Profile, Platform: identity, Store: state, Inventory: binder, Supervisor: supervisor, Onboarding: targetAdapter, PredecessorEvidence: evidence, CurrentConvergence: targetAdapter, CurrentRepair: targetAdapter}
	if err := service.RecoverPending(ctx); err != nil {
		return fmt.Errorf("startup lifecycle recovery: %w", err)
	}
	listener, err := listenBound(socketPath, 0o660, int(config.Operator.GID))
	if err != nil {
		return err
	}
	defer closeListener(listener, socketPath)
	go closeOnContext(ctx, listener)
	server := daemon.Server{Handler: service, AllowedUIDs: map[uint32]struct{}{0: {}, config.Operator.UID: {}},
		ReadTimeout: 15 * time.Second, WriteTimeout: 15 * time.Second, OperationTimeout: 5 * time.Minute}
	return server.Serve(ctx, listener)
}

func installedTargetRuntime(config platform.Config, identity model.PlatformIdentity, state *store.Store, serviceManager platform.Systemd) (*engine.TargetEngine, *platform.TargetAdapter, error) {
	executable, err := os.Executable()
	if err != nil {
		return nil, nil, err
	}
	units, err := platform.NewDiskUnitStore(config, "target")
	if err != nil {
		return nil, nil, err
	}
	files, err := platform.NewDiskLifecycleFileStore(config)
	if err != nil {
		return nil, nil, err
	}
	typedState, err := platform.NewDiskTypedStateStore(config, platform.CommandStateAccessVerifier{Binary: executable})
	if err != nil {
		return nil, nil, err
	}
	registry, err := migrator.RegistryFor(config)
	if err != nil {
		return nil, nil, err
	}
	signerParticipant := &signer.Participant{Config: config,
		Caller: signer.CommandCaller{ClientBinary: executable, Config: config}, Offline: signer.CommandOfflineRestorer{},
		Generations: state, ExpectedGateUID: 0}
	var predecessor platform.Predecessor = platform.NoPredecessor{}
	var networkPolicy platform.NetworkPolicy = platform.NoNetworkPolicy{}
	if config.IsDarwinLaunchd() {
		predecessor = platform.NoPredecessor{}
	} else if config.Profile == model.ProfileProtectedLocal {
		legacyPredecessor := &platform.LegacyControllerPredecessor{Config: config, Systemd: serviceManager, State: platform.CommandLegacyControllerState{Binary: "/usr/bin/systemctl"}}
		predecessor = platform.CombinedPredecessor{
			Public: &platform.LocalPredecessor{Config: config, Systemd: platform.CommandUserSystemd{
				Binary: "/usr/bin/systemctl", Principal: config.Operator, Home: config.OwnerHome(),
			}},
			Legacy: legacyPredecessor,
		}
	} else {
		legacyPredecessor := &platform.LegacyControllerPredecessor{Config: config, Systemd: serviceManager, State: platform.CommandLegacyControllerState{Binary: "/usr/bin/systemctl"}}
		predecessor = platform.CombinedPredecessor{
			Public: &platform.HostingPredecessor{Config: config, Systemd: serviceManager, State: platform.CommandServiceState{Binary: "/usr/bin/systemctl"}},
			Legacy: legacyPredecessor,
		}
		networkPolicy = platform.CommandHostingNetworkPolicy{TailscaleBinary: "/usr/bin/tailscale", SocketBinary: "/usr/bin/ss", SignerWebAuthnPath: "/etc/fased/signerd-webauthn.env"}
	}
	targetAdapter := &platform.TargetAdapter{Config: config, Identity: identity, Units: units, Files: files, TypedState: typedState, Systemd: serviceManager, Generations: state, Health: platform.LoopbackGatewayHealth{}, Predecessor: predecessor, Fence: platform.DiskLocalPredecessorFence{}, Network: networkPolicy, Manifest: state, Plugins: platform.DiskPluginBoundary{Config: config, Resolver: state}, TaskLedger: platform.NewTaskLedgerQuiescer(config)}
	targetEngine := &engine.TargetEngine{Journal: state, Generations: state,
		Migrator: &migrator.SchemaMigrator{Registry: registry}, Signer: signerParticipant,
		Adapter: targetAdapter, Installation: &platform.ManifestCommitter{Store: state, Identity: identity}}
	return targetEngine, targetAdapter, nil
}

func loadConfig(path string, expectedUID int) (platform.Config, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return platform.Config{}, errors.New("platform configuration path must be absolute and clean")
	}
	info, err := os.Lstat(path)
	if err != nil {
		return platform.Config{}, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0o600 || !ok || stat.Nlink != 1 || int(stat.Uid) != expectedUID || info.Size() > maxConfigBytes {
		return platform.Config{}, errors.New("platform configuration is not a secure root-owned record")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return platform.Config{}, err
	}
	return platform.DecodeConfig(data)
}

func listenBound(path string, mode os.FileMode, gid int) (*net.UnixListener, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return nil, errors.New("lifecycle socket path must be absolute and clean")
	}
	parent := filepath.Dir(path)
	if err := os.MkdirAll(parent, 0o710); err != nil {
		return nil, err
	}
	if err := prepareSocketParent(parent, gid); err != nil {
		return nil, err
	}
	if info, err := os.Lstat(path); err == nil {
		stat, ok := info.Sys().(*syscall.Stat_t)
		if info.Mode()&os.ModeSocket == 0 || info.Mode()&os.ModeSymlink != 0 || !ok || stat.Uid != 0 {
			return nil, errors.New("refusing to replace unsafe lifecycle socket")
		}
		if err := os.Remove(path); err != nil {
			return nil, err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(path, mode); err != nil {
		listener.Close()
		return nil, err
	}
	if err := os.Chown(path, 0, gid); err != nil {
		listener.Close()
		return nil, err
	}
	return listener, nil
}

// The public supervisor socket is group-authorized, so its immediate parent
// must carry the same fixed group or an authorized operator cannot traverse to
// the socket. The private controller passes gid 0 and remains root-only.
func prepareSocketParent(path string, gid int) error {
	if gid < 0 {
		return errors.New("lifecycle socket group is invalid")
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	expectedUID := uint32(os.Geteuid())
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || !ok || stat.Uid != expectedUID || info.Mode().Perm()&0o022 != 0 {
		return errors.New("lifecycle socket directory is unsafe")
	}
	if err := os.Chown(path, int(expectedUID), gid); err != nil {
		return err
	}
	if err := os.Chmod(path, 0o710); err != nil {
		return err
	}
	verified, err := os.Lstat(path)
	if err != nil {
		return err
	}
	verifiedStat, ok := verified.Sys().(*syscall.Stat_t)
	if !verified.IsDir() || verified.Mode()&os.ModeSymlink != 0 || !ok || verifiedStat.Uid != expectedUID || verifiedStat.Gid != uint32(gid) || verified.Mode().Perm() != 0o710 {
		return errors.New("lifecycle socket directory identity did not converge")
	}
	return nil
}

func closeOnContext(ctx context.Context, listener *net.UnixListener) {
	<-ctx.Done()
	_ = listener.Close()
}

func closeListener(listener *net.UnixListener, path string) {
	_ = listener.Close()
	_ = os.Remove(path)
}
