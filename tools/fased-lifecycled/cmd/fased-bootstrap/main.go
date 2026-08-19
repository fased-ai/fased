package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"fased-lifecycled/acquire"
	"fased-lifecycled/host"
	"fased-lifecycled/hostsecurity"
	"fased-lifecycled/model"
	"fased-lifecycled/participant"
	"fased-lifecycled/platform"
	"fased-lifecycled/trust"
)

const productionPinnedRootSHA256 = "23d3e8235a39729d6ae37a5784eaa717a47e4ac725f5a416e78754ad9b4618ca" // pragma: allowlist secret

// These values are set with linker flags only for non-publishable branch
// acceptance artifacts. Production builds leave both empty and therefore
// retain the exact-tag GitHub Release route and production root pin.
var branchFixtureMetadataBase string
var branchFixturePinnedRootSHA256 string

const maxMetadataSize = 1 << 20

type bootstrapRequest struct {
	StateRoot, HostRoot, RootURL, RootRotationBaseURL, IndexURL, IndexAttestationURL, ReleaseBaseURL string
	Channel, Version, Architecture, PinnedRootSHA256                                                 string
	RootRotationURLs                                                                                 []string
	ExpectedRootVersion                                                                              uint64
	ExpectedRootSHA256                                                                               string
	OwnerUID                                                                                         uint32
	Client                                                                                           *http.Client
	Now                                                                                              time.Time
	VerifyIndex                                                                                      releaseIndexVerifier
	Inspect                                                                                          func(context.Context, host.StagedHost) error
}

type bootstrapResult struct {
	Version                string
	ReleaseSequence        uint64
	SecurityEpoch          uint64
	ManifestProtocolMin    uint32
	ManifestProtocolMax    uint32
	HostDigest             string
	HostPath               string
	ApplicationPath        string
	DependencyPath         string
	SignerPath             string
	ReleaseIndexDigest     string
	ReleaseAuthorityDigest string
	PluginLockDigest       string
	Performance            bootstrapPerformance
}

type bootstrapPerformance struct {
	MetadataMillis              uint64 `json:"metadataMillis"`
	SignatureVerificationMillis uint64 `json:"signatureVerificationMillis"`
	AssetAcquisitionMillis      uint64 `json:"assetAcquisitionMillis"`
	ExtractionMillis            uint64 `json:"extractionMillis"`
	FsyncMillis                 uint64 `json:"fsyncMillis"`
	ActivationMillis            uint64 `json:"activationMillis"`
	TotalMillis                 uint64 `json:"totalMillis"`
	TransferredBytes            uint64 `json:"transferredBytes"`
	MetadataTransferredBytes    uint64 `json:"metadataTransferredBytes"`
	ArtifactTransferredBytes    uint64 `json:"artifactTransferredBytes"`
	CacheHits                   uint32 `json:"cacheHits"`
	CacheMisses                 uint32 `json:"cacheMisses"`
}

type bootstrapVerifiedReleaseIndex struct {
	Index                  trust.ReleaseIndex
	Digest                 string
	ReleaseAuthorityDigest string
}

type releaseIndexVerifier func(trust.VerifiedRoot, []byte, []byte, time.Time) (bootstrapVerifiedReleaseIndex, error)

func verifyAttestedReleaseIndex(root trust.VerifiedRoot, indexJSON, bundleJSON []byte, now time.Time) (bootstrapVerifiedReleaseIndex, error) {
	verified, err := trust.VerifyAttestedReleaseIndex(root, indexJSON, bundleJSON, now)
	if err != nil {
		return bootstrapVerifiedReleaseIndex{}, err
	}
	return bootstrapVerifiedReleaseIndex{
		Index: verified.Index(), Digest: verified.Digest(),
		ReleaseAuthorityDigest: verified.ReleaseAuthorityDigest(),
	}, nil
}

func main() {
	if err := run(os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "fased-bootstrap:", err)
		os.Exit(1)
	}
}

func run(args []string, output io.Writer) error {
	if len(args) > 0 && (args[0] == "install" || args[0] == "update" || args[0] == "repair") {
		return runPublicLifecycle(args[0], args[1:], output)
	}
	if len(args) > 0 && args[0] == "uninstall" {
		return runPublicUninstall(args[1:], output)
	}
	if len(args) > 0 && args[0] == "rollback" {
		return runPublicRollback(args[1:], output)
	}
	if len(args) > 0 && args[0] == "status" {
		return runPublicLifecycleStatus(args[1:], output)
	}
	if len(args) > 0 && args[0] == "plugins" {
		return runManagedPlugins(args[1:], output)
	}
	flags := flag.NewFlagSet("fased-bootstrap", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	var request bootstrapRequest
	flags.StringVar(&request.StateRoot, "state-root", "", "")
	flags.StringVar(&request.HostRoot, "host-root", "", "")
	flags.StringVar(&request.RootURL, "root-url", "", "")
	flags.StringVar(&request.RootRotationBaseURL, "root-rotation-base-url", "", "")
	flags.Var((*stringListFlag)(&request.RootRotationURLs), "root-rotation-url", "")
	flags.StringVar(&request.IndexURL, "index-url", "", "")
	flags.StringVar(&request.IndexAttestationURL, "index-attestation-url", "", "")
	flags.StringVar(&request.ReleaseBaseURL, "release-base-url", "", "")
	flags.StringVar(&request.Channel, "channel", "", "")
	flags.StringVar(&request.Version, "version", "", "")
	flags.StringVar(&request.Architecture, "arch", architecture(), "")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 {
		return errors.New("invalid bootstrap arguments")
	}
	if os.Geteuid() != 0 {
		return errors.New("static lifecycle bootstrap requires root")
	}
	request.PinnedRootSHA256, request.OwnerUID, request.Now = productionPinnedRootSHA256, 0, time.Now().UTC()
	request.Inspect = inspectLifecycleHost
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	result, err := execute(ctx, request)
	if err != nil {
		return err
	}
	if err := pruneAcquisitionInbox(request.StateRoot); err != nil {
		return fmt.Errorf("lifecycle host committed but verified acquisition cleanup is pending: %w", err)
	}
	_, err = fmt.Fprintf(output, "Lifecycle host ready: %s sequence=%d epoch=%d digest=%s\n", result.Version, result.ReleaseSequence, result.SecurityEpoch, result.HostDigest)
	return err
}

type managedPluginCommand struct {
	profile, catalog, digest, operation string
	archives                            map[string]string
}

func runManagedPlugins(args []string, output io.Writer) error {
	if os.Geteuid() != 0 {
		return errors.New("invalid managed plugin arguments")
	}
	command, err := parseManagedPluginCommand(args)
	if err != nil {
		return err
	}
	operatorName := operatorFromEnvironment(model.Profile(command.profile))
	if operatorName == "" {
		return errors.New("managed plugin operator identity is unavailable")
	}
	operator, err := resolveOperator(operatorName, model.Profile(command.profile))
	if err != nil {
		return err
	}
	lockPath, err := managedPluginMutationLockPath(model.Profile(command.profile))
	if err != nil {
		return err
	}
	lock, err := acquireManagedPluginMutationLock(lockPath, 0)
	if err != nil {
		return err
	}
	defer lock.Release()
	data, err := readManagedPluginCatalog(command.catalog, operator.UID)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(data)
	if command.digest != fmt.Sprintf("sha256:%x", sum) {
		return errors.New("managed plugin catalog digest mismatch")
	}
	configPath, err := installedConfigPath(model.Profile(command.profile), operator)
	if err != nil {
		return err
	}
	configData, err := os.ReadFile(configPath)
	if err != nil {
		return errors.New("installed lifecycle platform configuration is unavailable")
	}
	config, err := platform.DecodeConfig(configData)
	if err != nil || config.Profile != model.Profile(command.profile) || config.Operator.UID != operator.UID || config.Operator.GID != operator.GID {
		return errors.New("installed lifecycle platform identity differs from plugin operator")
	}
	manifestData, err := os.ReadFile(filepath.Join(config.LifecycleRoot, "installation-manifest.json"))
	if err != nil {
		return errors.New("installed lifecycle manifest is unavailable")
	}
	status, err := decodeInstalledLifecycleStatus(config, model.Profile(command.profile), manifestData)
	if err != nil {
		return err
	}
	var manifest model.Manifest
	_ = json.Unmarshal(manifestData, &manifest)
	identity, err := config.Identity()
	expectedPlatformDigest, digestErr := identity.Digest(config.Profile)
	actualPlatformDigest, actualErr := manifest.Platform.Digest(config.Profile)
	if err != nil || digestErr != nil || actualErr != nil || expectedPlatformDigest != actualPlatformDigest {
		return errors.New("installed lifecycle platform identity is invalid")
	}
	service, err := platform.NewSystemServiceManager()
	if err != nil {
		return err
	}
	transactionID := "plugin-" + command.digest[7:63]
	catalog, err := participant.DecodeManagedPluginCatalog(data)
	if err != nil {
		return err
	}
	archiveDigest := map[string]string{}
	for _, entry := range catalog.Entries {
		archiveDigest[entry.ID] = entry.ArchiveDigest
	}
	sources := make([]platform.ManagedPluginArchiveSource, 0, len(command.archives))
	for id, source := range command.archives {
		sources = append(sources, platform.ManagedPluginArchiveSource{ID: id, Path: source, SHA256: archiveDigest[id]})
	}
	// Stage binds each source SHA to the catalog entry; copy the declared digest after catalog decoding in the platform transaction.
	production, err := platform.NewManagedPluginProduction(config, status.ActiveGenerationID, service)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	if err := production.Activation.ConvergeOtherUnfinished(ctx, transactionID); err != nil {
		return err
	}
	// Convergence may have committed another catalog. Rebind the installed
	// plugin lock only after that recovery so this stage cannot replace it with
	// the pre-convergence snapshot.
	production, err = platform.NewManagedPluginProduction(config, status.ActiveGenerationID, service)
	if err != nil {
		return err
	}
	if current, receipt, candidateLock, err := production.Activation.AlreadyCurrent(transactionID); err != nil {
		return err
	} else if current {
		_, err = fmt.Fprintf(output, "Managed plugins: status=ALREADY_CURRENT catalog=%s candidateLock=%s readiness=%s generation=%s\n", command.digest, candidateLock, receipt, status.ActiveGenerationID)
		return err
	}
	result, err := production.Transaction.Stage(platform.ManagedPluginStageRequest{TransactionID: transactionID, CatalogData: data, ExpectedCatalogDigest: command.digest, BaseLock: production.BaseLock, Archives: sources})
	if err != nil {
		return err
	}
	receipt, err := production.Activation.Apply(ctx, transactionID)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(output, "Managed plugins: status=INSTALLED catalog=%s candidateLock=%s readiness=%s generation=%s\n", command.digest, result.CandidateLockDigest, receipt, status.ActiveGenerationID)
	return err
}

// managedPluginMutationLockPath deliberately returns the same installation-wide
// lifecycle lease used by the bootstrap update and rollback routes. It is
// acquired before any installed-state inspection and retained through durable
// journal convergence, stage, activation, and finalization.
func managedPluginMutationLockPath(profile model.Profile) (string, error) {
	if profile == model.ProfileHosting {
		if runtime.GOOS != "linux" {
			return "", errors.New("Hosting lifecycle is supported only on Linux")
		}
		return "/run/lock/fased-bootstrap-hosting.lock", nil
	}
	if profile != model.ProfileProtectedLocal {
		return "", errors.New("managed plugin profile is invalid")
	}
	return platform.BootstrapMutationLockPathForOS(runtime.GOOS), nil
}

func acquireManagedPluginMutationLock(path string, expectedUID uint32) (*hostsecurity.MutationLock, error) {
	return hostsecurity.AcquireMutationLock(path, expectedUID)
}

func parseManagedPluginCommand(args []string) (managedPluginCommand, error) {
	if len(args) < 3 || args[0] != "--profile" || (args[2] != "install" && args[2] != "update") || namedPluginFlagCount(args, "profile") != 1 || namedPluginFlagCount(args, "catalog") != 1 || namedPluginFlagCount(args, "catalog-digest") != 1 {
		return managedPluginCommand{}, errors.New("invalid managed plugin arguments")
	}
	command := managedPluginCommand{operation: args[2], archives: map[string]string{}}
	for i := 0; i < len(args); i++ {
		if i == 2 {
			continue
		}
		switch args[i] {
		case "--profile", "--catalog", "--catalog-digest":
			if i+1 >= len(args) {
				return managedPluginCommand{}, errors.New("invalid managed plugin arguments")
			}
			value := args[i+1]
			i++
			if args[i-1] == "--profile" {
				command.profile = value
			}
			if args[i-1] == "--catalog" {
				command.catalog = value
			}
			if args[i-1] == "--catalog-digest" {
				command.digest = value
			}
		case "--archive":
			if i+1 >= len(args) {
				return managedPluginCommand{}, errors.New("invalid managed plugin archive")
			}
			value := args[i+1]
			i++
			id, source, ok := strings.Cut(value, "=")
			if !ok || id == "" || !filepath.IsAbs(source) || filepath.Clean(source) != source || command.archives[id] != "" {
				return managedPluginCommand{}, errors.New("invalid managed plugin archive")
			}
			command.archives[id] = source
		default:
			return managedPluginCommand{}, errors.New("invalid managed plugin arguments")
		}
	}
	if (command.profile != "protected-local" && command.profile != "hosting") || !pluginCommandDigest(command.digest) || !filepath.IsAbs(command.catalog) || filepath.Clean(command.catalog) != command.catalog || len(command.archives) == 0 || len(command.archives) > 4096 {
		return managedPluginCommand{}, errors.New("invalid managed plugin arguments")
	}
	return command, nil
}
func namedPluginFlagCount(args []string, name string) int {
	count := 0
	for _, arg := range args {
		if arg == "--"+name {
			count++
		}
	}
	return count
}
func pluginCommandDigest(value string) bool {
	if len(value) != 71 || !strings.HasPrefix(value, "sha256:") {
		return false
	}
	_, err := hex.DecodeString(value[7:])
	return err == nil && value == strings.ToLower(value)
}

func readManagedPluginCatalog(path string, ownerUID uint32) ([]byte, error) {
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, errors.New("managed plugin catalog is unsafe")
	}
	file := os.NewFile(uintptr(fd), path)
	defer file.Close()
	var before syscall.Stat_t
	if err := syscall.Fstat(fd, &before); err != nil || before.Mode&syscall.S_IFMT != syscall.S_IFREG || before.Nlink != 1 || before.Uid != ownerUID || before.Mode&0o022 != 0 || before.Size <= 0 || before.Size > 1<<20 {
		return nil, errors.New("managed plugin catalog is unsafe")
	}
	data, err := io.ReadAll(io.LimitReader(file, 1<<20+1))
	if err != nil || len(data) == 0 || len(data) > 1<<20 {
		return nil, errors.New("managed plugin catalog is unsafe")
	}
	var after syscall.Stat_t
	if err := syscall.Fstat(fd, &after); err != nil || after.Ino != before.Ino || after.Dev != before.Dev || after.Size != before.Size || after.Mtim != before.Mtim {
		return nil, errors.New("managed plugin catalog changed while reading")
	}
	info, err := os.Lstat(path)
	if err != nil {
		return nil, errors.New("managed plugin catalog changed while reading")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Ino != before.Ino || stat.Dev != before.Dev {
		return nil, errors.New("managed plugin catalog changed while reading")
	}
	return data, nil
}

func execute(ctx context.Context, request bootstrapRequest) (bootstrapResult, error) {
	executeStarted := time.Now()
	if request.StateRoot == "" || request.HostRoot == "" || request.RootURL == "" || request.IndexURL == "" || request.IndexAttestationURL == "" || request.ReleaseBaseURL == "" || request.Channel == "" || request.PinnedRootSHA256 == "" || request.OwnerUID != uint32(os.Geteuid()) || request.Inspect == nil {
		return bootstrapResult{}, errors.New("bootstrap request is incomplete or has the wrong root owner")
	}
	client := request.Client
	if client == nil {
		client = &http.Client{Timeout: 2 * time.Minute, CheckRedirect: secureMetadataRedirect}
	}
	performance := bootstrapPerformance{}
	root, err := resolveTrustedRootMeasured(ctx, client, request.StateRoot, request.OwnerUID, request.RootURL, request.RootRotationBaseURL, request.RootRotationURLs, request.PinnedRootSHA256, request.ExpectedRootVersion, request.ExpectedRootSHA256, request.Now, &performance)
	if err != nil {
		return bootstrapResult{}, err
	}
	indexJSON, err := fetchMetadataMeasured(ctx, client, request.IndexURL, &performance)
	if err != nil {
		return bootstrapResult{}, err
	}
	indexAttestationJSON, err := fetchMetadataMeasured(ctx, client, request.IndexAttestationURL, &performance)
	if err != nil {
		return bootstrapResult{}, err
	}
	verifyIndex := request.VerifyIndex
	if verifyIndex == nil {
		verifyIndex = verifyAttestedReleaseIndex
	}
	verificationStarted := time.Now()
	verifiedIndex, err := verifyIndex(root, indexJSON, indexAttestationJSON, request.Now)
	performance.SignatureVerificationMillis += durationMillis(verificationStarted)
	if err != nil {
		return bootstrapResult{}, err
	}
	if !plainSHA256(verifiedIndex.Digest) || !plainSHA256(verifiedIndex.ReleaseAuthorityDigest) {
		return bootstrapResult{}, errors.New("verified release authority returned malformed digests")
	}
	index := verifiedIndex.Index
	if index.Channel != request.Channel || (request.Version != "" && index.Version != request.Version) {
		return bootstrapResult{}, errors.New("signed release index differs from requested channel or version")
	}
	asset, ok := index.LifecycleHost[request.Architecture]
	if !ok {
		return bootstrapResult{}, errors.New("signed release index lacks the requested lifecycle-host architecture")
	}
	assetURL, err := assetURL(request.ReleaseBaseURL, asset.Name)
	if err != nil {
		return bootstrapResult{}, err
	}
	inbox, err := acquire.OpenInbox(request.StateRoot, request.OwnerUID)
	if err != nil {
		return bootstrapResult{}, err
	}
	defer inbox.Close()
	object, err := (acquire.Downloader{Client: client}).Fetch(ctx, assetURL, asset, inbox)
	if err != nil {
		return bootstrapResult{}, err
	}
	defer object.Close()
	performance.addAcquisition(object.Receipt())
	store, err := host.OpenStore(request.HostRoot, request.OwnerUID)
	if err != nil {
		return bootstrapResult{}, err
	}
	defer store.Close()
	extractionStarted := time.Now()
	staged, err := store.Stage(object, asset, host.Requirements{Manifest: 2, Journal: 1, Participant: 1, Platform: 1})
	if err != nil {
		return bootstrapResult{}, err
	}
	performance.ExtractionMillis += durationMillis(extractionStarted)
	application, applicationReceipt, err := fetchIndexedAsset(ctx, client, request, inbox, index.Application)
	if err != nil {
		return bootstrapResult{}, err
	}
	performance.addAcquisition(applicationReceipt)
	dependency, dependencyReceipt, err := fetchIndexedAsset(ctx, client, request, inbox, index.DependencyLayer)
	if err != nil {
		return bootstrapResult{}, err
	}
	performance.addAcquisition(dependencyReceipt)
	signer, signerReceipt, err := fetchIndexedAsset(ctx, client, request, inbox, index.Signer)
	if err != nil {
		return bootstrapResult{}, err
	}
	performance.addAcquisition(signerReceipt)
	activationStarted := time.Now()
	if err := store.Activate(staged, func(candidate host.StagedHost) error { return request.Inspect(ctx, candidate) }); err != nil {
		return bootstrapResult{}, err
	}
	performance.ActivationMillis = durationMillis(activationStarted)
	performance.TotalMillis = durationMillis(executeStarted)
	return bootstrapResult{
		Version: index.Version, ReleaseSequence: index.ReleaseSequence, SecurityEpoch: index.SecurityEpoch,
		ManifestProtocolMin: asset.Protocols.Manifest.Min, ManifestProtocolMax: asset.Protocols.Manifest.Max,
		HostDigest: staged.Digest, HostPath: staged.Path,
		ApplicationPath: application, DependencyPath: dependency, SignerPath: signer,
		ReleaseIndexDigest: "sha256:" + verifiedIndex.Digest, ReleaseAuthorityDigest: "sha256:" + verifiedIndex.ReleaseAuthorityDigest,
		PluginLockDigest: index.PluginLockDigest,
		Performance:      performance,
	}, nil
}

func (performance *bootstrapPerformance) addAcquisition(receipt acquire.Receipt) {
	performance.AssetAcquisitionMillis += receipt.DurationMillis
	performance.TransferredBytes += receipt.TransferredBytes
	performance.ArtifactTransferredBytes += receipt.TransferredBytes
	performance.FsyncMillis += receipt.FsyncMillis
	if receipt.CacheHit {
		performance.CacheHits++
	} else {
		performance.CacheMisses++
	}
}

func (performance *bootstrapPerformance) addMetadata(data []byte, started time.Time) {
	if performance == nil {
		return
	}
	performance.MetadataMillis += durationMillis(started)
	performance.MetadataTransferredBytes += uint64(len(data))
	performance.TransferredBytes += uint64(len(data))
}

func (performance *bootstrapPerformance) addSignatureVerification(started time.Time) {
	if performance != nil {
		performance.SignatureVerificationMillis += durationMillis(started)
	}
}

func durationMillis(started time.Time) uint64 {
	elapsed := time.Since(started).Milliseconds()
	if elapsed < 1 {
		return 1
	}
	return uint64(elapsed)
}

func plainSHA256(candidate string) bool {
	if len(candidate) != 64 {
		return false
	}
	_, err := hex.DecodeString(candidate)
	return err == nil
}

func fetchIndexedAsset(ctx context.Context, client *http.Client, request bootstrapRequest, inbox *acquire.Inbox, assets map[string]trust.Asset) (string, acquire.Receipt, error) {
	asset, ok := assets[request.Architecture]
	if !ok {
		return "", acquire.Receipt{}, errors.New("signed release index lacks the requested architecture")
	}
	url, err := assetURL(request.ReleaseBaseURL, asset.Name)
	if err != nil {
		return "", acquire.Receipt{}, err
	}
	object, err := (acquire.Downloader{Client: client}).Fetch(ctx, url, asset, inbox)
	if err != nil {
		return "", acquire.Receipt{}, err
	}
	receipt := object.Receipt()
	if err := object.Close(); err != nil {
		return "", acquire.Receipt{}, err
	}
	return path.Join(request.StateRoot, "inbox", receipt.RelativePath), receipt, nil
}

func fetchMetadata(ctx context.Context, client *http.Client, rawURL string) ([]byte, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" {
		return nil, errors.New("trust metadata URL must be absolute HTTPS")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return nil, err
	}
	response, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("trust metadata returned HTTP %d", response.StatusCode)
	}
	if response.ContentLength > maxMetadataSize {
		return nil, errors.New("trust metadata exceeds size limit")
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxMetadataSize+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxMetadataSize {
		return nil, errors.New("trust metadata exceeds size limit")
	}
	return data, nil
}

func fetchMetadataMeasured(ctx context.Context, client *http.Client, rawURL string, performance *bootstrapPerformance) ([]byte, error) {
	started := time.Now()
	data, err := fetchMetadata(ctx, client, rawURL)
	if err == nil {
		performance.addMetadata(data, started)
	}
	return data, err
}

func assetURL(base, name string) (string, error) {
	parsed, err := url.Parse(base)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || path.Base(name) != name {
		return "", errors.New("release base URL or asset name is unsafe")
	}
	if !strings.HasSuffix(parsed.Path, "/") {
		parsed.Path += "/"
	}
	parsed.Path += name
	return parsed.String(), nil
}

func inspectLifecycleHost(ctx context.Context, candidate host.StagedHost) error {
	checkCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	command := exec.CommandContext(checkCtx, candidate.Path, "--version")
	command.Env = []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LANG=C", "LC_ALL=C"}
	output, err := command.CombinedOutput()
	if err != nil {
		return fmt.Errorf("staged lifecycle-host inspection failed: %w", err)
	}
	if len(output) == 0 || len(output) > 4096 || !strings.HasPrefix(string(output), "fased-lifecycled ") {
		return errors.New("staged lifecycle-host returned an invalid identity")
	}
	return nil
}

func secureMetadataRedirect(request *http.Request, via []*http.Request) error {
	if len(via) >= 3 || request.URL.Scheme != "https" || request.URL.User != nil {
		return errors.New("trust metadata redirect is unsafe")
	}
	return nil
}
func architecture() string {
	switch runtime.GOARCH {
	case "amd64":
		return "x64"
	case "arm64":
		return "arm64"
	default:
		return runtime.GOARCH
	}
}

type stringListFlag []string

func (values *stringListFlag) String() string { return strings.Join(*values, ",") }
func (values *stringListFlag) Set(value string) error {
	if value == "" {
		return errors.New("empty root rotation URL")
	}
	*values = append(*values, value)
	return nil
}
