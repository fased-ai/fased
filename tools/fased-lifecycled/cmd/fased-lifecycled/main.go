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

	"fased-lifecycled/bundle"
	"fased-lifecycled/controller"
	"fased-lifecycled/daemon"
	"fased-lifecycled/engine"
	"fased-lifecycled/migrator"
	"fased-lifecycled/model"
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
	flags.StringVar(&root, "root", "", "")
	flags.StringVar(&version, "version", "", "")
	flags.StringVar(&commit, "commit", "", "")
	flags.StringVar(&tree, "tree", "", "")
	flags.StringVar(&outputPath, "output", "", "")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 || root == "" || version == "" || commit == "" || tree == "" || outputPath == "" {
		return errors.New("root, version, commit, tree, and output are required")
	}
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return err
	}
	inventory, generation, err := bundle.Inspect(absRoot, version, commit, tree, map[string]uint32{
		"federation": 2, "managedInstall": 2, "mining": 1, "signer": 2, "walletRegistry": 1,
	}, model.CapabilityRanges{
		Supervisor: model.CapabilityRange{Min: 1, Max: 1}, Controller: model.CapabilityRange{Min: 1, Max: 1},
		Migrator: model.CapabilityRange{Min: 1, Max: 1}, Signer: model.CapabilityRange{Min: 2, Max: 2},
	})
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
	var profileRaw, instanceID, ownerStateRoot, generationRoot string
	var operatorUID, operatorGID, gatewayUID, gatewayGID, signerUID, signerGID, gatewayPort uint64
	flags.StringVar(&profileRaw, "profile", "", "")
	flags.StringVar(&instanceID, "instance", "", "")
	flags.StringVar(&ownerStateRoot, "owner-state", "", "")
	flags.StringVar(&generationRoot, "generation", "", "")
	flags.Uint64Var(&operatorUID, "operator-uid", 0, "")
	flags.Uint64Var(&operatorGID, "operator-gid", 0, "")
	flags.Uint64Var(&gatewayUID, "gateway-uid", 0, "")
	flags.Uint64Var(&gatewayGID, "gateway-gid", 0, "")
	flags.Uint64Var(&signerUID, "signer-uid", 0, "")
	flags.Uint64Var(&signerGID, "signer-gid", 0, "")
	flags.Uint64Var(&gatewayPort, "gateway-port", 0, "")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 || gatewayPort == 0 || gatewayPort > 65535 || operatorUID > uint64(^uint32(0)) || operatorGID > uint64(^uint32(0)) || gatewayUID > uint64(^uint32(0)) || gatewayGID > uint64(^uint32(0)) || signerUID > uint64(^uint32(0)) || signerGID > uint64(^uint32(0)) {
		return errors.New("invalid lifecycle initialization arguments")
	}
	config, err := platform.NewConfigWithGatewayPort(model.Profile(profileRaw), instanceID, ownerStateRoot, uint16(gatewayPort),
		platform.Principal{UID: uint32(operatorUID), GID: uint32(operatorGID)},
		platform.Principal{UID: uint32(gatewayUID), GID: uint32(gatewayGID)},
		platform.Principal{UID: uint32(signerUID), GID: uint32(signerGID)})
	if err != nil {
		return err
	}
	if _, err := store.Open(config.LifecycleRoot); err != nil {
		return err
	}
	configData, err := platform.CanonicalConfigJSON(config)
	if err != nil {
		return err
	}
	configPath := filepath.Join(config.LifecycleRoot, "platform.json")
	if err := installExactRecord(configPath, configData, 0o600); err != nil {
		return err
	}
	stableBinary := "/opt/fased/lifecycle/supervisor-v1/fased-lifecycled"
	if err := installStableBinary(stableBinary); err != nil {
		return err
	}
	unitData, err := platform.RenderSupervisorUnit(config, stableBinary)
	if err != nil {
		return err
	}
	identity, err := config.Identity()
	if err != nil {
		return err
	}
	if err := installExactRecord(filepath.Join(config.UnitRoot, identity.Services["supervisor"]), unitData, 0o644); err != nil {
		return err
	}
	systemd, err := systemdClient()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	if err := systemd.DaemonReload(ctx); err != nil {
		return err
	}
	if err := systemd.Enable(ctx, identity.Services["supervisor"]); err != nil {
		return err
	}
	return runApply([]string{"--config", configPath, "--generation", generationRoot}, output)
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

func runApply(args []string, output io.Writer) error {
	flags := flag.NewFlagSet("apply", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	var configPath, generationRoot string
	flags.StringVar(&configPath, "config", "", "")
	flags.StringVar(&generationRoot, "generation", "", "")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 || !filepath.IsAbs(generationRoot) || filepath.Clean(generationRoot) != generationRoot {
		return errors.New("invalid lifecycle apply arguments")
	}
	config, err := loadConfig(configPath, 0)
	if err != nil {
		return err
	}
	state, err := store.Open(config.LifecycleRoot)
	if err != nil {
		return err
	}
	generation, err := state.ImportGeneration(generationRoot)
	if err != nil {
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
	var configPath, generationRoot string
	flags.StringVar(&configPath, "config", "", "")
	flags.StringVar(&generationRoot, "generation", "", "")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 || !filepath.IsAbs(generationRoot) || filepath.Clean(generationRoot) != generationRoot {
		return errors.New("invalid lifecycle stage arguments")
	}
	config, err := loadConfig(configPath, 0)
	if err != nil {
		return err
	}
	state, err := store.Open(config.LifecycleRoot)
	if err != nil {
		return err
	}
	generation, err := state.ImportGeneration(generationRoot)
	if err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(generation)
}

func runRequest(args []string, output io.Writer) error {
	flags := flag.NewFlagSet("request", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	var socketPath, operation, requestID, targetID, manifestDigest, transactionID string
	flags.StringVar(&socketPath, "socket", "", "")
	flags.StringVar(&operation, "operation", "", "")
	flags.StringVar(&requestID, "request-id", "", "")
	flags.StringVar(&targetID, "target-generation", "", "")
	flags.StringVar(&manifestDigest, "expected-manifest", "", "")
	flags.StringVar(&transactionID, "transaction", "", "")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 || !filepath.IsAbs(socketPath) {
		return errors.New("invalid lifecycle request arguments")
	}
	request := protocol.Request{SchemaVersion: protocol.CurrentSchemaVersion, RequestID: requestID,
		Operation: protocol.Operation(operation), TargetGenerationID: targetID,
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
	state, err := store.Open(config.LifecycleRoot)
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
	binder := &statebind.Binder{Specs: []statebind.Spec{
		{Name: "federation", Path: filepath.Join(config.OwnerStateRoot, "federation")},
		{Name: "managedInstall", Path: config.InstallRoot, RootOnly: true},
		{Name: "mining", Path: filepath.Join(config.OwnerStateRoot, "mining")},
		// Signer content is snapshotted and rollback-bound by the signer participant.
		// Inventory only the signer-owned root here so a live bbolt transaction cannot
		// race the generic filesystem hasher.
		{Name: "signer", Path: config.SignerStateRoot(), RootOnly: true},
		{Name: "walletRegistry", Path: filepath.Join(config.OwnerStateRoot, "wallet")},
	}}
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
	state, err := store.Open(config.LifecycleRoot)
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
	targetAdapter := &platform.TargetAdapter{Config: config, Identity: identity, Units: units, Systemd: systemd, Generations: state, Health: platform.LoopbackGatewayHealth{}}
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
