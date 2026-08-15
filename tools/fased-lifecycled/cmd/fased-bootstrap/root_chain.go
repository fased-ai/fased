package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"syscall"
	"time"

	"fased-lifecycled/trust"
)

const (
	trustedRootCacheDirectory = "trusted-roots"
	maxRootRotationsPerRun    = 128
)

// resolveTrustedRoot starts from the immutable root-v1 pin, advances through a
// root-owned cached floor, and then discovers sequential cross-signed roots at
// deterministic channel asset names. A rotation is durable before it can
// authorize a release index, so a later network response cannot roll a client
// back to an older release authority.
func resolveTrustedRoot(
	ctx context.Context,
	client *http.Client,
	stateRoot string,
	ownerUID uint32,
	rootURL string,
	rotationBaseURL string,
	explicitRotationURLs []string,
	pinnedRootSHA256 string,
	now time.Time,
) (trust.VerifiedRoot, error) {
	if rotationBaseURL != "" && len(explicitRotationURLs) != 0 {
		return trust.VerifiedRoot{}, errors.New("root rotation base and explicit rotation URLs are mutually exclusive")
	}
	rootJSON, err := fetchMetadata(ctx, client, rootURL)
	if err != nil {
		return trust.VerifiedRoot{}, err
	}
	root, err := trust.VerifyInitialRootChainLink(rootJSON, pinnedRootSHA256)
	if err != nil {
		return trust.VerifiedRoot{}, err
	}
	if len(explicitRotationURLs) != 0 {
		for _, rotationURL := range explicitRotationURLs {
			rotationJSON, fetchErr := fetchMetadata(ctx, client, rotationURL)
			if fetchErr != nil {
				return trust.VerifiedRoot{}, fetchErr
			}
			root, err = trust.VerifyRootRotationChainLink(root, rotationJSON)
			if err != nil {
				return trust.VerifiedRoot{}, err
			}
		}
		if err := root.RequireCurrent(now); err != nil {
			return trust.VerifiedRoot{}, err
		}
		return root, nil
	}
	if rotationBaseURL == "" {
		if err := root.RequireCurrent(now); err != nil {
			return trust.VerifiedRoot{}, err
		}
		return root, nil
	}

	cacheDirectory, err := prepareTrustedRootCache(stateRoot, ownerUID)
	if err != nil {
		return trust.VerifiedRoot{}, err
	}
	for count := 0; count < maxRootRotationsPerRun; count++ {
		cachedPath := filepath.Join(cacheDirectory, rootRotationAssetName(root.Version()+1))
		cached, readErr := readTrustedRootCacheFile(cachedPath, ownerUID)
		if errors.Is(readErr, os.ErrNotExist) {
			break
		}
		if readErr != nil {
			return trust.VerifiedRoot{}, readErr
		}
		root, err = trust.VerifyRootRotationChainLink(root, cached)
		if err != nil {
			return trust.VerifiedRoot{}, fmt.Errorf("verify cached lifecycle root rotation: %w", err)
		}
	}

	for count := 0; count < maxRootRotationsPerRun; count++ {
		name := rootRotationAssetName(root.Version() + 1)
		rotationURL, urlErr := assetURL(rotationBaseURL, name)
		if urlErr != nil {
			return trust.VerifiedRoot{}, urlErr
		}
		rotationJSON, found, fetchErr := fetchOptionalMetadata(ctx, client, rotationURL)
		if fetchErr != nil {
			return trust.VerifiedRoot{}, fetchErr
		}
		if !found {
			if err := root.RequireCurrent(now); err != nil {
				return trust.VerifiedRoot{}, err
			}
			return root, nil
		}
		rotated, verifyErr := trust.VerifyRootRotationChainLink(root, rotationJSON)
		if verifyErr != nil {
			return trust.VerifiedRoot{}, fmt.Errorf("verify lifecycle root rotation %d: %w", root.Version()+1, verifyErr)
		}
		if persistErr := persistTrustedRoot(cacheDirectory, rotated.Version(), rotationJSON, ownerUID); persistErr != nil {
			return trust.VerifiedRoot{}, persistErr
		}
		root = rotated
	}
	return trust.VerifiedRoot{}, errors.New("lifecycle root rotation chain exceeds the bounded per-run limit")
}

func rootRotationAssetName(version uint64) string {
	return fmt.Sprintf("fased-lifecycle-root-v%d.json", version)
}

func prepareTrustedRootCache(stateRoot string, ownerUID uint32) (string, error) {
	if !filepath.IsAbs(stateRoot) || filepath.Clean(stateRoot) != stateRoot {
		return "", errors.New("bootstrap state root is not an absolute clean path")
	}
	if err := os.MkdirAll(stateRoot, 0o700); err != nil {
		return "", errors.New("create bootstrap state root")
	}
	if err := requireTrustedRootDirectory(stateRoot, ownerUID); err != nil {
		return "", err
	}
	cache := filepath.Join(stateRoot, trustedRootCacheDirectory)
	if err := os.Mkdir(cache, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
		return "", errors.New("create trusted root cache")
	}
	if err := requireTrustedRootDirectory(cache, ownerUID); err != nil {
		return "", err
	}
	return cache, nil
}

func requireTrustedRootDirectory(path string, ownerUID uint32) error {
	info, err := os.Lstat(path)
	if err != nil {
		return errors.New("inspect trusted root cache directory")
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return errors.New("trusted root cache must be a non-symlink directory")
	}
	if info.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("trusted root cache directory permissions are unsafe: %04o", info.Mode().Perm())
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil || resolved != path {
		return errors.New("trusted root cache path contains a symlink")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != ownerUID {
		return errors.New("trusted root cache directory has the wrong owner")
	}
	return nil
}

func readTrustedRootCacheFile(path string, ownerUID uint32) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 || stat.Uid != ownerUID || info.Size() <= 0 || info.Size() > maxMetadataSize {
		return nil, errors.New("cached lifecycle root is unsafe")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(info, opened) {
		return nil, errors.New("cached lifecycle root changed while opening")
	}
	data, err := io.ReadAll(io.LimitReader(file, maxMetadataSize+1))
	if err != nil || len(data) == 0 || len(data) > maxMetadataSize {
		return nil, errors.New("cached lifecycle root is unreadable or oversized")
	}
	return data, nil
}

func persistTrustedRoot(directory string, version uint64, data []byte, ownerUID uint32) error {
	path := filepath.Join(directory, rootRotationAssetName(version))
	if existing, err := readTrustedRootCacheFile(path, ownerUID); err == nil {
		if bytes.Equal(existing, data) {
			return nil
		}
		return errors.New("cached lifecycle root version is already bound to different bytes")
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	temporary, err := os.CreateTemp(directory, ".root-rotation-*")
	if err != nil {
		return errors.New("create trusted root cache file")
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	writeErr := temporary.Chmod(0o600)
	if writeErr == nil {
		_, writeErr = temporary.Write(data)
	}
	if writeErr == nil {
		writeErr = temporary.Sync()
	}
	closeErr := temporary.Close()
	if writeErr == nil {
		writeErr = closeErr
	}
	if writeErr != nil {
		return errors.New("write trusted root cache file")
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return errors.New("commit trusted root cache file")
	}
	directoryHandle, err := os.Open(directory)
	if err != nil {
		return errors.New("open trusted root cache directory")
	}
	defer directoryHandle.Close()
	if err := directoryHandle.Sync(); err != nil {
		return errors.New("sync trusted root cache directory")
	}
	_, err = readTrustedRootCacheFile(path, ownerUID)
	return err
}

func fetchOptionalMetadata(ctx context.Context, client *http.Client, rawURL string) ([]byte, bool, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" {
		return nil, false, errors.New("trust metadata URL must be absolute HTTPS")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return nil, false, err
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, false, err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return nil, false, nil
	}
	if response.StatusCode != http.StatusOK {
		return nil, false, fmt.Errorf("trust metadata returned HTTP %d", response.StatusCode)
	}
	if response.ContentLength > maxMetadataSize {
		return nil, false, errors.New("trust metadata exceeds size limit")
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxMetadataSize+1))
	if err != nil {
		return nil, false, err
	}
	if len(data) == 0 || len(data) > maxMetadataSize {
		return nil, false, errors.New("trust metadata is empty or exceeds size limit")
	}
	return data, true, nil
}
