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
	"syscall"
	"time"

	"fased-lifecycled/bootstrap"
	"fased-lifecycled/bundle"
	"fased-lifecycled/candidate"
	"fased-lifecycled/controller"
	"fased-lifecycled/daemon"
	"fased-lifecycled/engine"
	"fased-lifecycled/migrator"
	"fased-lifecycled/model"
	"fased-lifecycled/planner"
	"fased-lifecycled/platform"
	"fased-lifecycled/protocol"
	"fased-lifecycled/signer"
	"fased-lifecycled/statebind"
	"fased-lifecycled/store"
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
		return errors.New("mode must be supervisor, target, or signer-call")
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
	if os.Geteuid() != 0 {
		return errors.New("lifecycle supervisor and target modes require root")
	}
	if args[0] == "initialize" {
		return runInitialize(args[1:], os.Stdout)
	}
	if args[0] == "stage" {
		return runStage(args[1:], os.Stdout)
	}
	if args[0] == "apply" {
		return runApply(args[1:], os.Stdout)
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
	case "target":
		if socketPath != config.ControllerSocket() {
			return errors.New("target socket does not match platform configuration")
		}
		return runTarget(ctx, config, socketPath)
	default:
		return errors.New("unsupported lifecycle daemon mode")
	}
}

func runInventory(args []string, output io.Writer) error {
	flags := flag.NewFlagSet("inventory", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	var root, version, commit, tree, outputPath string
	var dependencyHash, dependencyAsset, dependencyArchiveSHA256 string
	flags.StringVar(&root, "root", "", "")
	flags.StringVar(&version, "version", "", "")
	flags.StringVar(&commit, "commit", "", "")
	flags.StringVar(&tree, "tree", "", "")
	flags.StringVar(&outputPath, "output", "", "")
	flags.StringVar(&dependencyHash, "dependency-hash", "", "")
	flags.StringVar(&dependencyAsset, "dependency-asset", "", "")
	flags.StringVar(&dependencyArchiveSHA256, "dependency-archive-sha256", "", "")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 || root == "" || version == "" || commit == "" || tree == "" || outputPath == "" {
		return errors.New("root, version, commit, tree, and output are required")
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

func runInitialize(args []string, output io.Writer) error {
	flags := flag.NewFlagSet("initialize", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	var profileRaw, instanceID, ownerStateRoot, operatorUser, generationRoot, generationArchive, dependencyArchive, sourceTopology string
	var gatewayPort uint64
	flags.StringVar(&profileRaw, "profile", "", "")
	flags.StringVar(&instanceID, "instance", "", "")
	flags.StringVar(&ownerStateRoot, "owner-state", "", "")
	flags.StringVar(&operatorUser, "operator-user", "", "")
	flags.StringVar(&generationRoot, "generation", "", "")
	flags.StringVar(&generationArchive, "generation-archive", "", "")
	flags.StringVar(&dependencyArchive, "dependency-archive", "", "")
	flags.StringVar(&sourceTopology, "source-topology", "", "")
	flags.Uint64Var(&gatewayPort, "gateway-port", 0, "")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 || gatewayPort == 0 || gatewayPort > 65535 {
		return errors.New("invalid lifecycle initialization arguments")
	}
	profile := model.Profile(profileRaw)
	if operatorUser == "" {
		return errors.New("lifecycle initialization requires an operator user")
	}
	principalSystem, err := platform.NewLinuxPrincipalSystem()
	if err != nil {
		return err
	}
	discovered, err := discoverInitialization(profile, instanceID, ownerStateRoot, operatorUser, principalSystem)
	if err != nil {
		return err
	}
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
	case planner.InstallationEmpty, planner.InstallationManaged:
		if sourceTopology != "" {
			return errors.New("caller supplied a source topology for a non-bridge installation")
		}
	default:
		return errors.New("installation discovery returned an unsupported class")
	}
	applyArguments, err := initializationApplyArguments("", generationRoot, generationArchive, dependencyArchive, sourceTopology)
	if err != nil {
		return err
	}
	var homeACL platform.HomeACL
	if profile == model.ProfileProtectedLocal {
		homeACL, err = platform.NewLinuxACL()
		if err != nil {
			return err
		}
	}
	systemd, err := systemdClient()
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
		OperatorUser: operatorUser, OwnerStateRoot: ownerStateRoot, GatewayPort: uint16(gatewayPort),
		ExpectedRegistryOwner: 0, RegistryPath: platform.LocalInstanceRegistryPath,
		JournalPath:      filepath.Join("/var/lib/fased-lifecycle-bootstrap", transactionID+".json"),
		StableDaemonPath: "/opt/fased/lifecycle/supervisor-v1/fased-lifecycled",
		StableDaemon:     stableDaemon, Principals: principalSystem, ACL: homeACL, Systemd: systemd,
	})
	if err != nil {
		return err
	}
	configPath := filepath.Join(result.Config.LifecycleRoot, "platform.json")
	applyArguments[1] = configPath
	if err := runApply(applyArguments, output); err != nil {
		return errors.Join(err, result.Transaction.Rollback())
	}
	result.Transaction.Commit()
	return nil
}

func discoverInitialization(profile model.Profile, instanceID, ownerStateRoot, operatorUser string, principals platform.PrincipalSystem) (platform.DiscoveryResult, error) {
	selectedInstance := instanceID
	if profile == model.ProfileProtectedLocal && selectedInstance == "" {
		operator, exists, err := principals.LookupUser(context.Background(), operatorUser)
		if err != nil || !exists {
			return platform.DiscoveryResult{}, errors.New("Local operator is unavailable during read-only discovery")
		}
		entry, found, err := platform.FindLocalInstance(platform.LocalInstanceRegistryPath, 0, operator.UID, operatorUser, string(profile), ownerStateRoot)
		if err != nil {
			return platform.DiscoveryResult{}, err
		}
		if found {
			selectedInstance = entry.InstanceID
		} else {
			selectedInstance = "unallocated"
		}
	}
	manifestPath := filepath.Join("/var/lib/fased-local", selectedInstance, "lifecycle", "installation-manifest.json")
	installRoot := filepath.Join("/opt/fased/local", selectedInstance)
	if profile == model.ProfileHosting {
		manifestPath = "/var/lib/fased-lifecycled/installation-manifest.json"
		installRoot = "/opt/fased"
	}
	return platform.DiscoverInstallation(platform.DiscoveryRequest{
		Profile: profile, OwnerStateRoot: ownerStateRoot,
		CanonicalManifestPath: manifestPath, CanonicalInstallRoot: installRoot,
	})
}

func initializationApplyArguments(configPath, generationRoot, generationArchive, dependencyArchive, sourceTopology string) ([]string, error) {
	if (generationRoot == "") == (generationArchive == "") {
		return nil, errors.New("invalid lifecycle initialization generation input")
	}
	flagName, selected := "--generation", generationRoot
	if generationArchive != "" {
		flagName, selected = "--generation-archive", generationArchive
	}
	if !filepath.IsAbs(selected) || filepath.Clean(selected) != selected {
		return nil, errors.New("invalid lifecycle initialization generation input")
	}
	arguments := []string{"--config", configPath, flagName, selected}
	if dependencyArchive != "" {
		if !filepath.IsAbs(dependencyArchive) || filepath.Clean(dependencyArchive) != dependencyArchive {
			return nil, errors.New("invalid lifecycle initialization dependency input")
		}
		arguments = append(arguments, "--dependency-archive", dependencyArchive)
	}
	if sourceTopology != "" {
		arguments = append(arguments, "--source-topology", sourceTopology)
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

func runApply(args []string, output io.Writer) error {
	flags := flag.NewFlagSet("apply", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	var configPath, generationRoot, generationArchive, dependencyArchive, generationID, sourceTopology string
	flags.StringVar(&configPath, "config", "", "")
	flags.StringVar(&generationRoot, "generation", "", "")
	flags.StringVar(&generationArchive, "generation-archive", "", "")
	flags.StringVar(&dependencyArchive, "dependency-archive", "", "")
	flags.StringVar(&generationID, "generation-id", "", "")
	flags.StringVar(&sourceTopology, "source-topology", "", "")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 {
		return errors.New("invalid lifecycle apply arguments")
	}
	selected := 0
	for _, value := range []string{generationRoot, generationArchive, generationID} {
		if value != "" {
			selected++
		}
	}
	if selected != 1 {
		return errors.New("invalid lifecycle apply arguments")
	}
	selectedInput := generationRoot
	if generationArchive != "" {
		selectedInput = generationArchive
	}
	if selectedInput != "" && (!filepath.IsAbs(selectedInput) || filepath.Clean(selectedInput) != selectedInput) {
		return errors.New("invalid lifecycle apply arguments")
	}
	if dependencyArchive != "" && (!filepath.IsAbs(dependencyArchive) || filepath.Clean(dependencyArchive) != dependencyArchive) {
		return errors.New("invalid lifecycle dependency archive")
	}
	config, err := loadConfig(configPath, 0)
	if err != nil {
		return err
	}
	state, err := store.OpenLayout(store.Layout{StateRoot: config.LifecycleRoot, InstallRoot: config.InstallRoot})
	if err != nil {
		return err
	}
	var generation model.Generation
	if generationID != "" {
		generation = model.Generation{ID: generationID}
	} else if generationArchive != "" {
		generation, err = state.ImportGenerationArchive(generationArchive)
	} else {
		generation, err = state.ImportGeneration(generationRoot)
	}
	if err != nil {
		return err
	}
	if generationID == "" {
		if err := importGenerationDependency(state, generation, dependencyArchive); err != nil {
			return err
		}
	}
	// Promote verified bytes before the stable supervisor enters its read-only
	// installation namespace. The target controller repeats this operation
	// idempotently as part of its own mutation transaction.
	if err := state.StageGeneration(generation.ID); err != nil {
		return err
	}
	expectedManifest := "absent"
	if _, digest, readErr := state.ReadManifest(); readErr == nil {
		expectedManifest = digest
	} else if !errors.Is(readErr, os.ErrNotExist) {
		return readErr
	}
	systemd, err := systemdClient()
	if err != nil {
		return err
	}
	identity, err := config.Identity()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Minute)
	defer cancel()
	if err := systemd.Start(ctx, identity.Services["supervisor"]); err != nil {
		return err
	}
	if err := waitForSocket(ctx, config.SupervisorSocket()); err != nil {
		return err
	}
	requestID, err := randomRequestID()
	if err != nil {
		return err
	}
	response, err := daemon.Call(ctx, config.SupervisorSocket(), protocol.Request{
		SchemaVersion: protocol.CurrentSchemaVersion, RequestID: requestID,
		Operation: protocol.OperationConverge, TargetGenerationID: generation.ID,
		SourceTopology:         sourceTopology,
		ExpectedManifestDigest: expectedManifest,
	}, 5*time.Minute)
	if err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(response)
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

func runStage(args []string, output io.Writer) error {
	flags := flag.NewFlagSet("stage", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	var configPath, generationRoot, generationArchive, dependencyArchive, descriptorPath, attestationPath, releaseVersion string
	flags.StringVar(&configPath, "config", "", "")
	flags.StringVar(&generationRoot, "generation", "", "")
	flags.StringVar(&generationArchive, "generation-archive", "", "")
	flags.StringVar(&dependencyArchive, "dependency-archive", "", "")
	flags.StringVar(&descriptorPath, "candidate-descriptor", "", "")
	flags.StringVar(&attestationPath, "candidate-attestation", "", "")
	flags.StringVar(&releaseVersion, "release-version", "", "")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 || (generationRoot == "") == (generationArchive == "") {
		return errors.New("invalid lifecycle stage arguments")
	}
	selectedInput := generationRoot
	if generationArchive != "" {
		selectedInput = generationArchive
	}
	if !filepath.IsAbs(selectedInput) || filepath.Clean(selectedInput) != selectedInput {
		return errors.New("invalid lifecycle stage arguments")
	}
	if dependencyArchive != "" && (!filepath.IsAbs(dependencyArchive) || filepath.Clean(dependencyArchive) != dependencyArchive) {
		return errors.New("invalid lifecycle dependency archive")
	}
	if generationArchive != "" {
		for _, path := range []string{descriptorPath, attestationPath} {
			if !filepath.IsAbs(path) || filepath.Clean(path) != path {
				return errors.New("candidate evidence path is invalid")
			}
		}
		files := map[string]string{filepath.Base(generationArchive): generationArchive}
		if dependencyArchive != "" {
			files[filepath.Base(dependencyArchive)] = dependencyArchive
		}
		if _, err := candidate.Verify(context.Background(), candidate.GitHubVerifier{Binary: githubCLI()}, descriptorPath, attestationPath, releaseVersion, files); err != nil {
			return err
		}
	}
	config, err := loadConfig(configPath, 0)
	if err != nil {
		return err
	}
	state, err := store.OpenLayout(store.Layout{StateRoot: config.LifecycleRoot, InstallRoot: config.InstallRoot})
	if err != nil {
		return err
	}
	var generation model.Generation
	if generationArchive != "" {
		generation, err = state.ImportGenerationArchive(generationArchive)
	} else {
		generation, err = state.ImportGeneration(generationRoot)
	}
	if err != nil {
		return err
	}
	if err := importGenerationDependency(state, generation, dependencyArchive); err != nil {
		return err
	}
	if err := state.StageGeneration(generation.ID); err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(generation)
}

func githubCLI() string {
	for _, path := range []string{"/usr/bin/gh", "/usr/local/bin/gh"} {
		if info, err := os.Lstat(path); err == nil && info.Mode().IsRegular() && info.Mode()&os.ModeSymlink == 0 && info.Mode().Perm()&0o111 != 0 {
			return path
		}
	}
	return ""
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
	flags := flag.NewFlagSet("request", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	var socketPath, operation, requestID, targetID, sourceTopology, manifestDigest, transactionID string
	flags.StringVar(&socketPath, "socket", "", "")
	flags.StringVar(&operation, "operation", "", "")
	flags.StringVar(&requestID, "request-id", "", "")
	flags.StringVar(&targetID, "target-generation", "", "")
	flags.StringVar(&sourceTopology, "source-topology", "", "")
	flags.StringVar(&manifestDigest, "expected-manifest", "", "")
	flags.StringVar(&transactionID, "transaction", "", "")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 || !filepath.IsAbs(socketPath) {
		return errors.New("invalid lifecycle request arguments")
	}
	request := protocol.Request{SchemaVersion: protocol.CurrentSchemaVersion, RequestID: requestID,
		Operation: protocol.Operation(operation), TargetGenerationID: targetID,
		SourceTopology:         sourceTopology,
		ExpectedManifestDigest: manifestDigest, TransactionID: transactionID}
	if err := request.Validate(); err != nil {
		return err
	}
	response, err := daemon.Call(context.Background(), socketPath, request, 6*time.Minute)
	if err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(response)
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
	units, err := platform.NewDiskUnitStore(config, "controller")
	if err != nil {
		return err
	}
	systemd, err := systemdClient()
	if err != nil {
		return err
	}
	controllerAdapter := &platform.ControllerAdapter{Config: config, Identity: identity, Units: units, Systemd: systemd, Generations: state}
	targetClient := controller.Client{SocketPath: config.ControllerSocket(), Timeout: 4 * time.Minute}
	supervisor := &engine.SupervisorEngine{Journal: state, Controller: controllerAdapter, Target: targetClient}
	binder := &statebind.Binder{Specs: statebind.CanonicalSpecs(config.OwnerStateRoot, config.InstallRoot, config.SignerStateRoot())}
	service := &daemon.Service{Profile: config.Profile, Platform: identity, Store: state, Inventory: binder, Supervisor: supervisor}
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

func runTarget(ctx context.Context, config platform.Config, socketPath string) error {
	state, err := store.OpenLayout(store.Layout{StateRoot: config.LifecycleRoot, InstallRoot: config.InstallRoot})
	if err != nil {
		return err
	}
	identity, err := config.Identity()
	if err != nil {
		return err
	}
	units, err := platform.NewDiskUnitStore(config, "target")
	if err != nil {
		return err
	}
	files, err := platform.NewDiskLifecycleFileStore(config)
	if err != nil {
		return err
	}
	systemd, err := systemdClient()
	if err != nil {
		return err
	}
	registry, err := migrator.RegistryFor(config)
	if err != nil {
		return err
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	signerParticipant := &signer.Participant{Config: config,
		Caller: signer.CommandCaller{ClientBinary: executable, Config: config}, Offline: signer.CommandOfflineRestorer{},
		Generations: state, ExpectedGateUID: 0}
	var predecessor platform.Predecessor = platform.NoPredecessor{}
	var networkPolicy platform.NetworkPolicy = platform.NoNetworkPolicy{}
	if config.Profile == model.ProfileProtectedLocal {
		predecessor = &platform.LocalPredecessor{Config: config, Systemd: platform.CommandUserSystemd{
			Binary: "/usr/bin/systemctl", Principal: config.Operator, Home: config.OwnerHome(),
		}}
	} else {
		predecessor = &platform.HostingPredecessor{Config: config, Systemd: systemd, State: platform.CommandServiceState{Binary: "/usr/bin/systemctl"}}
		networkPolicy = platform.CommandHostingNetworkPolicy{TailscaleBinary: "/usr/bin/tailscale", SocketBinary: "/usr/bin/ss"}
	}
	targetAdapter := &platform.TargetAdapter{Config: config, Identity: identity, Units: units, Files: files, Systemd: systemd, Generations: state, Health: platform.LoopbackGatewayHealth{}, Predecessor: predecessor, Network: networkPolicy}
	targetEngine := &engine.TargetEngine{Journal: state, Generations: state,
		Migrator: &migrator.SchemaMigrator{Registry: registry}, Signer: signerParticipant,
		Adapter: targetAdapter, Installation: &platform.ManifestCommitter{Store: state, Identity: identity}}
	listener, err := listenBound(socketPath, 0o600, 0)
	if err != nil {
		return err
	}
	defer closeListener(listener, socketPath)
	go closeOnContext(ctx, listener)
	server := controller.Server{Service: &controller.Service{Engine: targetEngine}, OperationTimeout: 4 * time.Minute}
	return server.Serve(ctx, listener)
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

func systemdClient() (platform.CommandSystemd, error) {
	for _, path := range []string{"/usr/bin/systemctl", "/bin/systemctl"} {
		if info, err := os.Lstat(path); err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0o111 != 0 {
			return platform.CommandSystemd{Binary: path}, nil
		}
	}
	return platform.CommandSystemd{}, errors.New("systemctl is unavailable")
}

func listenBound(path string, mode os.FileMode, gid int) (*net.UnixListener, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return nil, errors.New("lifecycle socket path must be absolute and clean")
	}
	parent := filepath.Dir(path)
	if err := os.MkdirAll(parent, 0o710); err != nil {
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

func closeOnContext(ctx context.Context, listener *net.UnixListener) {
	<-ctx.Done()
	_ = listener.Close()
}

func closeListener(listener *net.UnixListener, path string) {
	_ = listener.Close()
	_ = os.Remove(path)
}
