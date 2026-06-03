//go:build linux

package custodyhelper

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
)

const linuxSecretToolService = "fased-wallet-custody"

type linuxCommandRunner func(ctx context.Context, stdin string, name string, args ...string) (string, error)

type linuxSecretServiceStorage struct {
	baseDir        string
	secretToolPath string
	run            linuxCommandRunner
}

func newPlatformStorage() (Storage, error) {
	secretToolPath, err := exec.LookPath("secret-tool")
	if err != nil {
		return nil, fmt.Errorf("native Linux helper requires secret-tool (libsecret) on this device")
	}
	baseDir, err := helperDataDir()
	if err != nil {
		return nil, err
	}
	return &linuxSecretServiceStorage{
		baseDir:        baseDir,
		secretToolPath: secretToolPath,
		run:            runLinuxCommand,
	}, nil
}

func (s *linuxSecretServiceStorage) Platform() Platform       { return PlatformLinux }
func (s *linuxSecretServiceStorage) StorageMode() StorageMode { return StorageModeSecretService }
func (s *linuxSecretServiceStorage) Warning() string          { return "" }
func (s *linuxSecretServiceStorage) StoredWalletCount() int   { return countMetadataFiles(s.baseDir) }

func (s *linuxSecretServiceStorage) HasStoredShare(
	ctx context.Context,
	gatewayOrigin string,
	walletID string,
) (bool, error) {
	_, err := s.lookup(ctx, gatewayOrigin, walletID)
	if errors.Is(err, ErrNotFound) {
		return false, nil
	}
	return err == nil, err
}

func (s *linuxSecretServiceStorage) Save(ctx context.Context, record StoredShareRecord) error {
	record = normalizeRecord(record)
	label := record.DeviceLabel
	if label == "" {
		label = fmt.Sprintf("fased wallet %s", record.WalletID)
	}
	_, err := s.run(
		ctx,
		record.DeviceShare,
		s.secretToolPath,
		"store",
		"--label",
		label,
		"service",
		linuxSecretToolService,
		"gatewayOrigin",
		record.GatewayOrigin,
		"walletId",
		record.WalletID,
	)
	if err != nil {
		return err
	}
	return writeMetadata(s.baseDir, record)
}

func (s *linuxSecretServiceStorage) Load(
	ctx context.Context,
	gatewayOrigin string,
	walletID string,
	_ string,
) (*StoredShareRecord, error) {
	deviceShare, err := s.lookup(ctx, gatewayOrigin, walletID)
	if err != nil {
		return nil, err
	}
	meta, err := readMetadata(s.baseDir, gatewayOrigin, walletID)
	if errors.Is(err, ErrNotFound) {
		now := nowRFC3339()
		return &StoredShareRecord{
			Version:       1,
			GatewayOrigin: trimOrEmpty(gatewayOrigin),
			WalletID:      trimOrEmpty(walletID),
			DeviceShare:   deviceShare,
			CreatedAt:     now,
			UpdatedAt:     now,
		}, nil
	}
	if err != nil {
		return nil, err
	}
	return &StoredShareRecord{
		Version:       1,
		GatewayOrigin: meta.GatewayOrigin,
		WalletID:      meta.WalletID,
		DeviceShare:   deviceShare,
		CredentialID:  meta.CredentialID,
		DeviceLabel:   meta.DeviceLabel,
		CreatedAt:     meta.CreatedAt,
		UpdatedAt:     meta.UpdatedAt,
	}, nil
}

func (s *linuxSecretServiceStorage) Delete(
	ctx context.Context,
	gatewayOrigin string,
	walletID string,
) (bool, error) {
	_, err := s.run(
		ctx,
		"",
		s.secretToolPath,
		"clear",
		"service",
		linuxSecretToolService,
		"gatewayOrigin",
		trimOrEmpty(gatewayOrigin),
		"walletId",
		trimOrEmpty(walletID),
	)
	if err != nil && !errors.Is(err, ErrNotFound) {
		return false, err
	}
	if metaErr := removeMetadata(s.baseDir, gatewayOrigin, walletID); metaErr != nil {
		return false, metaErr
	}
	return err == nil, nil
}

func (s *linuxSecretServiceStorage) lookup(
	ctx context.Context,
	gatewayOrigin string,
	walletID string,
) (string, error) {
	stdout, err := s.run(
		ctx,
		"",
		s.secretToolPath,
		"lookup",
		"service",
		linuxSecretToolService,
		"gatewayOrigin",
		trimOrEmpty(gatewayOrigin),
		"walletId",
		trimOrEmpty(walletID),
	)
	if err != nil {
		return "", err
	}
	value := strings.TrimRight(stdout, "\r\n")
	if value == "" {
		return "", ErrNotFound
	}
	return value, nil
}

func runLinuxCommand(
	ctx context.Context,
	stdin string,
	name string,
	args ...string,
) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin)
	}
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) && exitErr.ExitCode() == 1 {
			return "", ErrNotFound
		}
		message := strings.TrimSpace(stderr.String())
		if message == "" {
			message = err.Error()
		}
		return "", fmt.Errorf("secret-tool %s failed: %s", strings.Join(args, " "), message)
	}
	return stdout.String(), nil
}
