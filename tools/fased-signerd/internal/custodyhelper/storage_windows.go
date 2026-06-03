//go:build windows

package custodyhelper

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"syscall"
	"unsafe"
)

var (
	crypt32                = syscall.NewLazyDLL("Crypt32.dll")
	kernel32               = syscall.NewLazyDLL("Kernel32.dll")
	procCryptProtectData   = crypt32.NewProc("CryptProtectData")
	procCryptUnprotectData = crypt32.NewProc("CryptUnprotectData")
	procLocalFree          = kernel32.NewProc("LocalFree")
)

type dataBlob struct {
	cbData uint32
	pbData *byte
}

type windowsStoredShareFile struct {
	Version       int    `json:"version"`
	GatewayOrigin string `json:"gatewayOrigin"`
	WalletID      string `json:"walletId"`
	CredentialID  string `json:"credentialId,omitempty"`
	DeviceLabel   string `json:"deviceLabel,omitempty"`
	CreatedAt     string `json:"createdAt"`
	UpdatedAt     string `json:"updatedAt"`
	CiphertextB64 string `json:"ciphertext"`
}

type windowsDPAPIStorage struct {
	baseDir string
}

func newPlatformStorage() (Storage, error) {
	baseDir, err := helperDataDir()
	if err != nil {
		return nil, err
	}
	return &windowsDPAPIStorage{baseDir: baseDir}, nil
}

func (s *windowsDPAPIStorage) Platform() Platform       { return PlatformWindows }
func (s *windowsDPAPIStorage) StorageMode() StorageMode { return StorageModeWindowsDPAPI }
func (s *windowsDPAPIStorage) Warning() string          { return "" }
func (s *windowsDPAPIStorage) StoredWalletCount() int   { return countMetadataFiles(s.baseDir) }

func (s *windowsDPAPIStorage) HasStoredShare(_ context.Context, gatewayOrigin string, walletID string) (bool, error) {
	_, err := s.readFile(gatewayOrigin, walletID)
	if errors.Is(err, ErrNotFound) {
		return false, nil
	}
	return err == nil, err
}

func (s *windowsDPAPIStorage) Save(_ context.Context, record StoredShareRecord) error {
	record = normalizeRecord(record)
	ciphertext, err := protectWindowsData([]byte(record.DeviceShare))
	if err != nil {
		return err
	}
	payload := windowsStoredShareFile{
		Version:       1,
		GatewayOrigin: record.GatewayOrigin,
		WalletID:      record.WalletID,
		CredentialID:  record.CredentialID,
		DeviceLabel:   record.DeviceLabel,
		CreatedAt:     record.CreatedAt,
		UpdatedAt:     record.UpdatedAt,
		CiphertextB64: base64.StdEncoding.EncodeToString(ciphertext),
	}
	return writeJSONFile(metadataFilePath(s.baseDir, record.GatewayOrigin, record.WalletID), payload)
}

func (s *windowsDPAPIStorage) Load(
	_ context.Context,
	gatewayOrigin string,
	walletID string,
	_ string,
) (*StoredShareRecord, error) {
	payload, err := s.readFile(gatewayOrigin, walletID)
	if err != nil {
		return nil, err
	}
	ciphertext, err := base64.StdEncoding.DecodeString(payload.CiphertextB64)
	if err != nil {
		return nil, err
	}
	plaintext, err := unprotectWindowsData(ciphertext)
	if err != nil {
		return nil, err
	}
	return &StoredShareRecord{
		Version:       payload.Version,
		GatewayOrigin: payload.GatewayOrigin,
		WalletID:      payload.WalletID,
		DeviceShare:   string(plaintext),
		CredentialID:  payload.CredentialID,
		DeviceLabel:   payload.DeviceLabel,
		CreatedAt:     payload.CreatedAt,
		UpdatedAt:     payload.UpdatedAt,
	}, nil
}

func (s *windowsDPAPIStorage) Delete(_ context.Context, gatewayOrigin string, walletID string) (bool, error) {
	path := metadataFilePath(s.baseDir, gatewayOrigin, walletID)
	err := os.Remove(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return err == nil, err
}

func (s *windowsDPAPIStorage) readFile(gatewayOrigin string, walletID string) (*windowsStoredShareFile, error) {
	body, err := os.ReadFile(metadataFilePath(s.baseDir, gatewayOrigin, walletID))
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	var payload windowsStoredShareFile
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, err
	}
	return &payload, nil
}

func newDataBlob(data []byte) dataBlob {
	if len(data) == 0 {
		return dataBlob{}
	}
	return dataBlob{
		cbData: uint32(len(data)),
		pbData: &data[0],
	}
}

func protectWindowsData(plaintext []byte) ([]byte, error) {
	input := newDataBlob(plaintext)
	var output dataBlob
	result, _, err := procCryptProtectData.Call(
		uintptr(unsafe.Pointer(&input)),
		0,
		0,
		0,
		0,
		0x1,
		uintptr(unsafe.Pointer(&output)),
	)
	if result == 0 {
		return nil, fmt.Errorf("CryptProtectData failed: %w", err)
	}
	defer freeDataBlob(output)
	return blobBytes(output), nil
}

func unprotectWindowsData(ciphertext []byte) ([]byte, error) {
	input := newDataBlob(ciphertext)
	var output dataBlob
	result, _, err := procCryptUnprotectData.Call(
		uintptr(unsafe.Pointer(&input)),
		0,
		0,
		0,
		0,
		0x1,
		uintptr(unsafe.Pointer(&output)),
	)
	if result == 0 {
		return nil, fmt.Errorf("CryptUnprotectData failed: %w", err)
	}
	defer freeDataBlob(output)
	return blobBytes(output), nil
}

func blobBytes(blob dataBlob) []byte {
	if blob.cbData == 0 || blob.pbData == nil {
		return nil
	}
	out := make([]byte, blob.cbData)
	copy(out, unsafe.Slice(blob.pbData, blob.cbData))
	return out
}

func freeDataBlob(blob dataBlob) {
	if blob.pbData == nil {
		return
	}
	procLocalFree.Call(uintptr(unsafe.Pointer(blob.pbData)))
}
