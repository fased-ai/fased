package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path"
	"runtime"
	"strings"
	"time"

	"fased-lifecycled/acquire"
	"fased-lifecycled/host"
	"fased-lifecycled/trust"
)

const productionPinnedRootSHA256 = "23d3e8235a39729d6ae37a5784eaa717a47e4ac725f5a416e78754ad9b4618ca"

// These values are set with linker flags only for non-publishable branch
// acceptance artifacts. Production builds leave both empty and therefore
// retain the immutable production metadata route and root pin.
var branchFixtureMetadataBase string
var branchFixturePinnedRootSHA256 string

const maxMetadataSize = 1 << 20

type bootstrapRequest struct {
	StateRoot, HostRoot, RootURL, DelegationURL, IndexURL, ReleaseBaseURL string
	Channel, Version, Architecture, PinnedRootSHA256                      string
	RootRotationURLs                                                      []string
	OwnerUID                                                              uint32
	Client                                                                *http.Client
	Now                                                                   time.Time
	Inspect                                                               func(context.Context, host.StagedHost) error
}

type bootstrapResult struct {
	Version            string
	ReleaseSequence    uint64
	SecurityEpoch      uint64
	HostDigest         string
	HostPath           string
	ApplicationPath    string
	DependencyPath     string
	SignerPath         string
	ReleaseIndexDigest string
	DelegationDigest   string
}

func main() {
	if err := run(os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "fased-bootstrap:", err)
		os.Exit(1)
	}
}

func run(args []string, output io.Writer) error {
	if len(args) > 0 && (args[0] == "install" || args[0] == "update") {
		return runPublicLifecycle(args[0], args[1:], output)
	}
	flags := flag.NewFlagSet("fased-bootstrap", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	var request bootstrapRequest
	flags.StringVar(&request.StateRoot, "state-root", "", "")
	flags.StringVar(&request.HostRoot, "host-root", "", "")
	flags.StringVar(&request.RootURL, "root-url", "", "")
	flags.Var((*stringListFlag)(&request.RootRotationURLs), "root-rotation-url", "")
	flags.StringVar(&request.DelegationURL, "delegation-url", "", "")
	flags.StringVar(&request.IndexURL, "index-url", "", "")
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
	_, err = fmt.Fprintf(output, "Lifecycle host ready: %s sequence=%d epoch=%d digest=%s\n", result.Version, result.ReleaseSequence, result.SecurityEpoch, result.HostDigest)
	return err
}

func execute(ctx context.Context, request bootstrapRequest) (bootstrapResult, error) {
	if request.StateRoot == "" || request.HostRoot == "" || request.RootURL == "" || request.DelegationURL == "" || request.IndexURL == "" || request.ReleaseBaseURL == "" || request.Channel == "" || request.PinnedRootSHA256 == "" || request.OwnerUID != uint32(os.Geteuid()) || request.Inspect == nil {
		return bootstrapResult{}, errors.New("bootstrap request is incomplete or has the wrong root owner")
	}
	client := request.Client
	if client == nil {
		client = &http.Client{Timeout: 2 * time.Minute, CheckRedirect: secureMetadataRedirect}
	}
	rootJSON, err := fetchMetadata(ctx, client, request.RootURL)
	if err != nil {
		return bootstrapResult{}, err
	}
	root, err := trust.VerifyInitialRoot(rootJSON, request.PinnedRootSHA256, request.Now)
	if err != nil {
		return bootstrapResult{}, err
	}
	for _, rotationURL := range request.RootRotationURLs {
		rotationJSON, err := fetchMetadata(ctx, client, rotationURL)
		if err != nil {
			return bootstrapResult{}, err
		}
		root, err = trust.VerifyRootRotation(root, rotationJSON, request.Now)
		if err != nil {
			return bootstrapResult{}, err
		}
	}
	delegationJSON, err := fetchMetadata(ctx, client, request.DelegationURL)
	if err != nil {
		return bootstrapResult{}, err
	}
	delegation, err := trust.VerifyDelegation(root, delegationJSON, request.Now)
	if err != nil {
		return bootstrapResult{}, err
	}
	indexJSON, err := fetchMetadata(ctx, client, request.IndexURL)
	if err != nil {
		return bootstrapResult{}, err
	}
	verifiedIndex, err := trust.VerifyReleaseIndex(delegation, indexJSON, request.Now)
	if err != nil {
		return bootstrapResult{}, err
	}
	index := verifiedIndex.Index()
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
	store, err := host.OpenStore(request.HostRoot, request.OwnerUID)
	if err != nil {
		return bootstrapResult{}, err
	}
	defer store.Close()
	staged, err := store.Stage(object, asset, host.Requirements{Manifest: 2, Journal: 1, Participant: 1, Platform: 1})
	if err != nil {
		return bootstrapResult{}, err
	}
	if err := store.Activate(staged, func(candidate host.StagedHost) error { return request.Inspect(ctx, candidate) }); err != nil {
		return bootstrapResult{}, err
	}
	application, err := fetchIndexedAsset(ctx, client, request, inbox, index.Application)
	if err != nil {
		return bootstrapResult{}, err
	}
	dependency, err := fetchIndexedAsset(ctx, client, request, inbox, index.DependencyLayer)
	if err != nil {
		return bootstrapResult{}, err
	}
	signer, err := fetchIndexedAsset(ctx, client, request, inbox, index.Signer)
	if err != nil {
		return bootstrapResult{}, err
	}
	return bootstrapResult{
		Version: index.Version, ReleaseSequence: index.ReleaseSequence, SecurityEpoch: index.SecurityEpoch,
		HostDigest: staged.Digest, HostPath: staged.Path,
		ApplicationPath: application, DependencyPath: dependency, SignerPath: signer,
		ReleaseIndexDigest: "sha256:" + verifiedIndex.Digest(), DelegationDigest: "sha256:" + verifiedIndex.DelegationDigest(),
	}, nil
}

func fetchIndexedAsset(ctx context.Context, client *http.Client, request bootstrapRequest, inbox *acquire.Inbox, assets map[string]trust.Asset) (string, error) {
	asset, ok := assets[request.Architecture]
	if !ok {
		return "", errors.New("signed release index lacks the requested architecture")
	}
	url, err := assetURL(request.ReleaseBaseURL, asset.Name)
	if err != nil {
		return "", err
	}
	object, err := (acquire.Downloader{Client: client}).Fetch(ctx, url, asset, inbox)
	if err != nil {
		return "", err
	}
	receipt := object.Receipt()
	if err := object.Close(); err != nil {
		return "", err
	}
	return path.Join(request.StateRoot, "inbox", receipt.RelativePath), nil
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
