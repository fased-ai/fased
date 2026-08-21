package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"fased-lifecycled/acquire"
	"fased-lifecycled/platform"
	"fased-lifecycled/trust"
)

var managedComponentIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)

type acquiredManagedComponent struct {
	CatalogPath   string
	CatalogDigest string
	ArchivePath   string
	Cleanup       func() error
}

func acquireReleaseManagedComponent(ctx context.Context, config platform.Config, status installedLifecycleStatus, componentID string) (acquiredManagedComponent, error) {
	if !managedComponentIDPattern.MatchString(componentID) {
		return acquiredManagedComponent{}, errors.New("managed component identity is invalid")
	}
	channel := "stable"
	if policy, err := platform.ReadUpdatePolicy(config); err == nil {
		channel = policy.Channel
	} else if !errors.Is(err, os.ErrNotExist) {
		return acquiredManagedComponent{}, fmt.Errorf("installed lifecycle update policy is invalid: %w", err)
	} else if strings.Contains(status.Version, "-") {
		channel = "beta"
	}
	route, err := publicTrustRoute(status.Version)
	if err != nil {
		return acquiredManagedComponent{}, err
	}
	route.RootRotationBaseURL = productionChannelReleasePrefix + channel + "-v1"
	client := &http.Client{Timeout: 2 * time.Minute, CheckRedirect: secureMetadataRedirect}
	stateRoot := platform.BootstrapCacheRootForOS(runtime.GOOS)
	now := time.Now().UTC()
	root, err := resolveTrustedRootMeasured(ctx, client, stateRoot, 0, route.RootURL, route.RootRotationBaseURL, nil, route.PinnedRootSHA256, 0, "", now, nil)
	if err != nil {
		return acquiredManagedComponent{}, err
	}
	indexJSON, err := fetchMetadata(ctx, client, route.IndexURL)
	if err != nil {
		return acquiredManagedComponent{}, err
	}
	attestationJSON, err := fetchMetadata(ctx, client, route.IndexAttestationURL)
	if err != nil {
		return acquiredManagedComponent{}, err
	}
	verify := route.VerifyIndex
	if verify == nil {
		verify = verifyAttestedReleaseIndex
	}
	verified, err := verify(root, indexJSON, attestationJSON, now)
	if err != nil {
		return acquiredManagedComponent{}, err
	}
	if verified.Index.Version != status.Version || verified.Index.Channel != channel {
		return acquiredManagedComponent{}, errors.New("managed component release differs from the installed generation")
	}
	assets, ok := verified.Index.Components[componentID]
	if !ok {
		return acquiredManagedComponent{}, fmt.Errorf("managed component %s is absent from the signed release inventory", componentID)
	}
	inbox, err := acquire.OpenInbox(stateRoot, 0)
	if err != nil {
		return acquiredManagedComponent{}, err
	}
	defer inbox.Close()
	catalogSource, err := fetchManagedComponentAsset(ctx, client, route.ReleaseBaseURL, stateRoot, inbox, assets.Catalog)
	if err != nil {
		return acquiredManagedComponent{}, err
	}
	archiveSource, err := fetchManagedComponentAsset(ctx, client, route.ReleaseBaseURL, stateRoot, inbox, assets.Archive)
	if err != nil {
		return acquiredManagedComponent{}, err
	}
	directory, err := os.MkdirTemp(config.OwnerStateRoot, ".component-acquisition-")
	if err != nil {
		return acquiredManagedComponent{}, err
	}
	cleanup := func() error { return os.RemoveAll(directory) }
	if err := os.Chmod(directory, 0o700); err != nil {
		_ = cleanup()
		return acquiredManagedComponent{}, err
	}
	if err := os.Chown(directory, int(config.Operator.UID), int(config.Operator.GID)); err != nil {
		_ = cleanup()
		return acquiredManagedComponent{}, err
	}
	catalogPath := filepath.Join(directory, assets.Catalog.Name)
	archivePath := filepath.Join(directory, assets.Archive.Name)
	if err := copyManagedComponentAsset(catalogSource, catalogPath, assets.Catalog, config); err != nil {
		_ = cleanup()
		return acquiredManagedComponent{}, err
	}
	if err := copyManagedComponentAsset(archiveSource, archivePath, assets.Archive, config); err != nil {
		_ = cleanup()
		return acquiredManagedComponent{}, err
	}
	if _, err := inbox.Prune(); err != nil {
		_ = cleanup()
		return acquiredManagedComponent{}, err
	}
	return acquiredManagedComponent{CatalogPath: catalogPath, CatalogDigest: assets.Catalog.SHA256, ArchivePath: archivePath, Cleanup: cleanup}, nil
}

func fetchManagedComponentAsset(ctx context.Context, client *http.Client, releaseBaseURL, stateRoot string, inbox *acquire.Inbox, asset trust.Asset) (string, error) {
	rawURL, err := assetURL(releaseBaseURL, asset.Name)
	if err != nil {
		return "", err
	}
	object, err := (acquire.Downloader{Client: client}).Fetch(ctx, rawURL, asset, inbox)
	if err != nil {
		return "", err
	}
	receipt := object.Receipt()
	if err := object.Close(); err != nil {
		return "", err
	}
	return filepath.Join(stateRoot, "inbox", receipt.RelativePath), nil
}

func copyManagedComponentAsset(source, destination string, asset trust.Asset, config platform.Config) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	ok := false
	defer func() {
		_ = output.Close()
		if !ok {
			_ = os.Remove(destination)
		}
	}()
	written, err := io.CopyN(output, input, int64(asset.Size))
	if err != nil || written != int64(asset.Size) {
		return errors.New("managed component acquisition copy is incomplete")
	}
	var trailing [1]byte
	if count, readErr := input.Read(trailing[:]); count != 0 || (readErr != nil && !errors.Is(readErr, io.EOF)) {
		return errors.New("managed component acquisition asset changed while copying")
	}
	if err := output.Chown(int(config.Operator.UID), int(config.Operator.GID)); err != nil {
		return err
	}
	if err := output.Chmod(0o600); err != nil {
		return err
	}
	if err := output.Sync(); err != nil {
		return err
	}
	if err := output.Close(); err != nil {
		return err
	}
	directory, err := os.Open(filepath.Dir(destination))
	if err != nil {
		return err
	}
	defer directory.Close()
	if err := directory.Sync(); err != nil {
		return err
	}
	ok = true
	return nil
}
