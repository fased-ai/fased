package main

import (
	"context"
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

	"fased-lifecycled/controller"
	"fased-lifecycled/daemon"
	"fased-lifecycled/engine"
	"fased-lifecycled/migrator"
	"fased-lifecycled/platform"
	"fased-lifecycled/signer"
	"fased-lifecycled/statebind"
	"fased-lifecycled/store"
)

const maxConfigBytes = 64 << 10

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
	if args[0] == "signer-call" {
		return signer.RunSocketHelper(args[1:], os.Stdin, os.Stdout)
	}
	if os.Geteuid() != 0 {
		return errors.New("lifecycle supervisor and target modes require root")
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
		{Name: "managedInstall", Path: config.InstallRoot},
		{Name: "mining", Path: filepath.Join(config.OwnerStateRoot, "mining")},
		{Name: "signer", Path: config.SignerStateRoot()},
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
	targetAdapter := &platform.TargetAdapter{Config: config, Identity: identity, Units: units, Systemd: systemd, Generations: state}
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
