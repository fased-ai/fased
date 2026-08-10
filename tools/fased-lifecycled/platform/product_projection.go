package platform

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"path/filepath"

	"fased-lifecycled/model"
)

type controllerIdentityProjection struct {
	SchemaVersion uint32 `json:"schemaVersion"`
	Version       string `json:"version"`
	ServerSHA256  string `json:"serverSha256"`
	ClientSHA256  string `json:"clientSha256"`
}

func CanonicalProductVersionPath(config Config) string {
	if config.Profile == model.ProfileProtectedLocal {
		return filepath.Join(config.ProductStateRoot, "controller", "signer-version")
	}
	return "/var/lib/fased-host-updater/signer-version"
}

func CanonicalControllerIdentityPath(config Config) string {
	if config.Profile == model.ProfileProtectedLocal {
		return filepath.Join(config.ProductStateRoot, "controller", "controller-version.json")
	}
	return "/var/lib/fased-host-updater/controller-version.json"
}

func CanonicalControllerIdentityJSON(payload, stableDaemonPath string, target model.Generation) ([]byte, error) {
	if err := target.Validate(); err != nil {
		return nil, err
	}
	serverBinary, err := readRegularFile(filepath.Join(payload, "bin", "fased-lifecycled"))
	if err != nil {
		return nil, err
	}
	clientBinary, err := readRegularFile(stableDaemonPath)
	if err != nil {
		return nil, err
	}
	serverDigest := fmt.Sprintf("%x", sha256.Sum256(serverBinary))
	clientDigest := fmt.Sprintf("%x", sha256.Sum256(clientBinary))
	data, err := json.MarshalIndent(controllerIdentityProjection{
		SchemaVersion: 1, Version: target.Version, ServerSHA256: serverDigest, ClientSHA256: clientDigest,
	}, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(data, '\n'), nil
}
