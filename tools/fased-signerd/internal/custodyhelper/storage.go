package custodyhelper

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

type Platform string

const (
	PlatformLinux   Platform = "linux"
	PlatformMacOS   Platform = "macos"
	PlatformWindows Platform = "windows"
	PlatformMock    Platform = "mock"
)

type StorageMode string

const (
	StorageModeOSKeychain    StorageMode = "os-keychain"
	StorageModeSecretService StorageMode = "secret-service"
	StorageModeWindowsDPAPI  StorageMode = "windows-dpapi"
	StorageModeMockMemory    StorageMode = "mock-memory"
	StorageModeUnavailable   StorageMode = "unavailable"
)

var (
	ErrNotFound    = errors.New("device share not found")
	ErrUnavailable = errors.New("secure storage unavailable")
)

type StoredShareRecord struct {
	Version       int
	GatewayOrigin string
	WalletID      string
	DeviceShare   string
	CredentialID  string
	DeviceLabel   string
	CreatedAt     string
	UpdatedAt     string
}

type Storage interface {
	Platform() Platform
	StorageMode() StorageMode
	Warning() string
	StoredWalletCount() int
	HasStoredShare(ctx context.Context, gatewayOrigin string, walletID string) (bool, error)
	Save(ctx context.Context, record StoredShareRecord) error
	Load(ctx context.Context, gatewayOrigin string, walletID string, prompt string) (*StoredShareRecord, error)
	Delete(ctx context.Context, gatewayOrigin string, walletID string) (bool, error)
}

type unavailableStorage struct {
	platform Platform
	warning  string
}

func (s *unavailableStorage) Platform() Platform       { return s.platform }
func (s *unavailableStorage) StorageMode() StorageMode { return StorageModeUnavailable }
func (s *unavailableStorage) Warning() string          { return s.warning }
func (s *unavailableStorage) StoredWalletCount() int   { return 0 }
func (s *unavailableStorage) HasStoredShare(context.Context, string, string) (bool, error) {
	return false, ErrUnavailable
}
func (s *unavailableStorage) Save(context.Context, StoredShareRecord) error { return ErrUnavailable }
func (s *unavailableStorage) Load(context.Context, string, string, string) (*StoredShareRecord, error) {
	return nil, ErrUnavailable
}
func (s *unavailableStorage) Delete(context.Context, string, string) (bool, error) {
	return false, ErrUnavailable
}

func NewPlatformStorage() Storage {
	store, err := newPlatformStorage()
	if err == nil {
		return store
	}
	return &unavailableStorage{
		platform: currentPlatform(),
		warning:  err.Error(),
	}
}

func currentPlatform() Platform {
	switch runtime.GOOS {
	case "linux":
		return PlatformLinux
	case "darwin":
		return PlatformMacOS
	case "windows":
		return PlatformWindows
	default:
		return Platform(runtime.GOOS)
	}
}

func AvailableRoutesForStorage(storage Storage) []string {
	routes := []string{HealthPath}
	if storage == nil || storage.StorageMode() == StorageModeUnavailable {
		return routes
	}
	return append(routes, StorageRoutes...)
}

func nowRFC3339() string {
	return time.Now().UTC().Format(time.RFC3339)
}

func trimOrEmpty(value string) string {
	return strings.TrimSpace(value)
}

func normalizeRecord(record StoredShareRecord) StoredShareRecord {
	record.Version = 1
	record.GatewayOrigin = trimOrEmpty(record.GatewayOrigin)
	record.WalletID = trimOrEmpty(record.WalletID)
	record.DeviceShare = trimOrEmpty(record.DeviceShare)
	record.CredentialID = trimOrEmpty(record.CredentialID)
	record.DeviceLabel = trimOrEmpty(record.DeviceLabel)
	if record.CreatedAt == "" {
		record.CreatedAt = nowRFC3339()
	}
	record.UpdatedAt = nowRFC3339()
	return record
}

func helperDataDir() (string, error) {
	baseDir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(baseDir, "fased", "wallet-custody-helper")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	return dir, nil
}

func walletRecordKey(gatewayOrigin string, walletID string) string {
	sum := sha256.Sum256([]byte(trimOrEmpty(gatewayOrigin) + "\n" + trimOrEmpty(walletID)))
	return hex.EncodeToString(sum[:16])
}

func metadataFilePath(baseDir string, gatewayOrigin string, walletID string) string {
	return filepath.Join(baseDir, walletRecordKey(gatewayOrigin, walletID)+".json")
}

type storedShareMetadata struct {
	Version       int    `json:"version"`
	GatewayOrigin string `json:"gatewayOrigin"`
	WalletID      string `json:"walletId"`
	CredentialID  string `json:"credentialId,omitempty"`
	DeviceLabel   string `json:"deviceLabel,omitempty"`
	CreatedAt     string `json:"createdAt"`
	UpdatedAt     string `json:"updatedAt"`
}

func writeJSONFile(path string, value any) error {
	body, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	body = append(body, '\n')
	return os.WriteFile(path, body, 0o600)
}

func readMetadata(baseDir string, gatewayOrigin string, walletID string) (*storedShareMetadata, error) {
	path := metadataFilePath(baseDir, gatewayOrigin, walletID)
	body, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	var meta storedShareMetadata
	if err := json.Unmarshal(body, &meta); err != nil {
		return nil, err
	}
	return &meta, nil
}

func writeMetadata(baseDir string, record StoredShareRecord) error {
	meta := storedShareMetadata{
		Version:       1,
		GatewayOrigin: record.GatewayOrigin,
		WalletID:      record.WalletID,
		CredentialID:  record.CredentialID,
		DeviceLabel:   record.DeviceLabel,
		CreatedAt:     record.CreatedAt,
		UpdatedAt:     record.UpdatedAt,
	}
	return writeJSONFile(metadataFilePath(baseDir, record.GatewayOrigin, record.WalletID), meta)
}

func removeMetadata(baseDir string, gatewayOrigin string, walletID string) error {
	err := os.Remove(metadataFilePath(baseDir, gatewayOrigin, walletID))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func countMetadataFiles(baseDir string) int {
	entries, err := os.ReadDir(baseDir)
	if err != nil {
		return 0
	}
	count := 0
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		if strings.HasSuffix(entry.Name(), ".json") {
			count += 1
		}
	}
	return count
}
