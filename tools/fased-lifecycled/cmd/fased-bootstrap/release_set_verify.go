package main

import (
	"crypto/sha256"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"fased-lifecycled/trust"
)

const releaseSetMetadataLimit = 1 << 20

var releaseRootNamePattern = regexp.MustCompile(`^fased-lifecycle-root-v([1-9][0-9]*)\.json$`)

type releaseSetIndexVerifier func(trust.VerifiedRoot, []byte, []byte, time.Time) (trust.ReleaseIndex, string, error)
type releaseSetHeadVerifier func([]byte, []byte, time.Time) (trust.RootHead, string, error)

func runVerifyReleaseSet(args []string, output io.Writer) error {
	flags := flag.NewFlagSet("verify-release-set", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	var directory, version, commit string
	flags.StringVar(&directory, "directory", "", "")
	flags.StringVar(&version, "version", "", "")
	flags.StringVar(&commit, "commit", "", "")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 {
		return errors.New("invalid release-set verification arguments")
	}
	return verifyReleaseSet(directory, version, commit, time.Now().UTC(), output,
		func(root trust.VerifiedRoot, indexJSON, bundleJSON []byte, now time.Time) (trust.ReleaseIndex, string, error) {
			verified, err := trust.VerifyAttestedReleaseIndex(root, indexJSON, bundleJSON, now)
			if err != nil {
				return trust.ReleaseIndex{}, "", err
			}
			return verified.Index(), verified.Digest(), nil
		},
		func(headJSON, bundleJSON []byte, now time.Time) (trust.RootHead, string, error) {
			verified, err := trust.VerifyAttestedRootHeadForIndexSchema(headJSON, bundleJSON, now, 2)
			if err != nil {
				return trust.RootHead{}, "", err
			}
			return verified.Head(), verified.Digest(), nil
		},
	)
}

func verifyReleaseSet(directory, version, commit string, now time.Time, output io.Writer, verifyIndex releaseSetIndexVerifier, verifyHead releaseSetHeadVerifier) error {
	if !filepath.IsAbs(directory) || filepath.Clean(directory) != directory || !versionPatternForReleaseSet(version) || !plainGitCommit(commit) || verifyIndex == nil || verifyHead == nil {
		return errors.New("release-set verification identity is invalid")
	}
	info, err := os.Lstat(directory)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("release-set directory is unsafe")
	}
	root, err := verifyReleaseSetRoots(directory, now)
	if err != nil {
		return err
	}
	indexJSON, err := readReleaseSetMetadata(directory, releaseIndexAssetName)
	if err != nil {
		return err
	}
	indexBundle, err := readReleaseSetMetadata(directory, releaseIndexAttestationAssetName)
	if err != nil {
		return err
	}
	index, indexDigest, err := verifyIndex(root, indexJSON, indexBundle, now)
	if err != nil {
		return fmt.Errorf("verify release index with production trust policy: %w", err)
	}
	if index.Version != version || index.Commit != commit {
		return errors.New("verified release index differs from requested release")
	}
	headJSON, err := readReleaseSetMetadata(directory, releaseRootHeadAssetName)
	if err != nil {
		return err
	}
	headBundle, err := readReleaseSetMetadata(directory, releaseRootHeadAttestationAssetName)
	if err != nil {
		return err
	}
	head, headDigest, err := verifyHead(headJSON, headBundle, now)
	if err != nil {
		return fmt.Errorf("verify lifecycle root head with production trust policy: %w", err)
	}
	if head.RootVersion != root.Version() || head.RootSHA256 != root.Digest() ||
		head.ReleaseIndexSHA256 != indexDigest || head.ReleaseVersion != index.Version ||
		head.ReleaseSequence != index.ReleaseSequence || head.SecurityEpoch != index.SecurityEpoch ||
		head.IndexCommit != index.Commit || head.WitnessCommit != index.Commit ||
		head.WitnessRef != "refs/tags/v"+index.Version {
		return errors.New("verified lifecycle root head differs from the release index")
	}
	assets := map[string]trust.Asset{}
	for _, inventory := range []map[string]trust.Asset{index.Application, index.DependencyLayer, index.LifecycleHost, index.Signer} {
		for _, asset := range inventory {
			if previous, exists := assets[asset.Name]; exists && (previous.Size != asset.Size || previous.SHA256 != asset.SHA256) {
				return errors.New("release index reuses an asset name with a different identity")
			}
			assets[asset.Name] = asset
		}
	}
	for name, asset := range assets {
		if err := verifyReleaseSetAsset(directory, name, asset); err != nil {
			return err
		}
	}
	if _, err := fmt.Fprintf(output, "Release set verified: version=%s commit=%s index=%s root-head=%s\n", version, commit, indexDigest, headDigest); err != nil {
		return err
	}
	return nil
}

func verifyReleaseSetRoots(directory string, now time.Time) (trust.VerifiedRoot, error) {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return trust.VerifiedRoot{}, errors.New("read release-set directory")
	}
	versions := make([]int, 0)
	for _, entry := range entries {
		match := releaseRootNamePattern.FindStringSubmatch(entry.Name())
		if match == nil {
			continue
		}
		version, parseErr := strconv.Atoi(match[1])
		if parseErr != nil {
			return trust.VerifiedRoot{}, errors.New("release root version is invalid")
		}
		versions = append(versions, version)
	}
	sort.Ints(versions)
	if len(versions) == 0 || versions[0] != 1 {
		return trust.VerifiedRoot{}, errors.New("release set lacks root v1")
	}
	rootJSON, err := readReleaseSetMetadata(directory, "fased-lifecycle-root-v1.json")
	if err != nil {
		return trust.VerifiedRoot{}, err
	}
	root, err := trust.VerifyInitialRootChainLink(rootJSON, productionPinnedRootSHA256)
	if err != nil {
		return trust.VerifiedRoot{}, fmt.Errorf("verify release root v1: %w", err)
	}
	for index, version := range versions[1:] {
		expected := index + 2
		if version != expected {
			return trust.VerifiedRoot{}, errors.New("release root rotation sequence is incomplete")
		}
		rotation, readErr := readReleaseSetMetadata(directory, fmt.Sprintf("fased-lifecycle-root-v%d.json", version))
		if readErr != nil {
			return trust.VerifiedRoot{}, readErr
		}
		root, err = trust.VerifyRootRotationChainLink(root, rotation)
		if err != nil {
			return trust.VerifiedRoot{}, fmt.Errorf("verify release root rotation %d: %w", version, err)
		}
	}
	if err := root.RequireCurrent(now); err != nil {
		return trust.VerifiedRoot{}, err
	}
	return root, nil
}

func readReleaseSetMetadata(directory, name string) ([]byte, error) {
	if filepath.Base(name) != name {
		return nil, errors.New("release-set metadata name is unsafe")
	}
	path := filepath.Join(directory, name)
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() <= 0 || info.Size() > releaseSetMetadataLimit {
		return nil, fmt.Errorf("release-set metadata is unsafe: %s", name)
	}
	data, err := os.ReadFile(path)
	if err != nil || len(data) == 0 || len(data) > releaseSetMetadataLimit {
		return nil, fmt.Errorf("read release-set metadata: %s", name)
	}
	return data, nil
}

func verifyReleaseSetAsset(directory, name string, asset trust.Asset) error {
	if filepath.Base(name) != name || name == "" || asset.Name != name || asset.Size == 0 || !strings.HasPrefix(asset.SHA256, "sha256:") {
		return errors.New("release-set asset identity is unsafe")
	}
	path := filepath.Join(directory, name)
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || uint64(info.Size()) != asset.Size {
		return fmt.Errorf("release-set asset is unsafe or has the wrong size: %s", name)
	}
	file, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open release-set asset: %s", name)
	}
	digest := sha256.New()
	_, copyErr := io.Copy(digest, file)
	closeErr := file.Close()
	if copyErr != nil || closeErr != nil || fmt.Sprintf("sha256:%x", digest.Sum(nil)) != asset.SHA256 {
		return fmt.Errorf("release-set asset digest mismatch: %s", name)
	}
	return nil
}

func versionPatternForReleaseSet(value string) bool {
	if value == "" || strings.ContainsAny(value, "/\\") {
		return false
	}
	return regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$`).MatchString(value)
}

func plainGitCommit(value string) bool {
	if len(value) != 40 {
		return false
	}
	for _, character := range value {
		if (character < '0' || character > '9') && (character < 'a' || character > 'f') {
			return false
		}
	}
	return true
}
