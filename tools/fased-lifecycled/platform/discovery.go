package platform

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"fased-lifecycled/model"
	"fased-lifecycled/planner"
)

const maxDiscoveryRecordSize = 1 << 20

type DiscoveryRequest struct {
	Profile               model.Profile
	OwnerStateRoot        string
	CanonicalManifestPath string
	CanonicalInstallRoot  string
	SystemRootPrefix      string
}

type DiscoveryResult struct {
	Installation             planner.Installation
	Topology                 planner.PublicTopology
	PublicPredecessorVersion string
}

type managedInstallRecord struct {
	SchemaVersion uint32          `json:"schemaVersion"`
	Profile       string          `json:"profile"`
	Source        string          `json:"source"`
	StateDir      string          `json:"stateDir"`
	ConfigPath    string          `json:"configPath"`
	Runtime       managedRuntime  `json:"runtime"`
	Package       json.RawMessage `json:"package"`
	Service       managedService  `json:"service"`
	Updater       json.RawMessage `json:"updater"`
	Update        json.RawMessage `json:"update"`
	Release       json.RawMessage `json:"release"`
	UpdatedAt     string          `json:"updatedAt"`
}

type managedRuntime struct {
	ActiveVersion         string  `json:"activeVersion"`
	PreviousVersion       *string `json:"previousVersion"`
	CurrentLink           string  `json:"currentLink"`
	PreviousLink          string  `json:"previousLink"`
	ReleasesDir           string  `json:"releasesDir"`
	DependencyHash        *string `json:"dependencyHash"`
	ReleaseManifestDigest *string `json:"releaseManifestDigest"`
	AppCommit             *string `json:"appCommit"`
	AppArtifact           *string `json:"appArtifact"`
	AppArtifactDigest     *string `json:"appArtifactDigest"`
}

type managedService struct {
	Name     string `json:"name"`
	Scope    string `json:"scope"`
	Launcher string `json:"launcher"`
}

func DiscoverInstallation(request DiscoveryRequest) (DiscoveryResult, error) {
	if err := validateDiscoveryRequest(request); err != nil {
		return DiscoveryResult{}, err
	}
	if result, found, err := discoverCanonical(request); err != nil || found {
		return result, err
	}
	return discoverPublicStable(request)
}

func validateDiscoveryRequest(request DiscoveryRequest) error {
	if request.Profile != model.ProfileProtectedLocal && request.Profile != model.ProfileHosting {
		return errors.New("discovery profile is unsupported")
	}
	for _, path := range []string{request.OwnerStateRoot, request.CanonicalManifestPath, request.CanonicalInstallRoot} {
		if !filepath.IsAbs(path) || filepath.Clean(path) != path || path == "/" {
			return errors.New("discovery paths must be absolute, clean, and scoped")
		}
	}
	if request.SystemRootPrefix != "" && (!filepath.IsAbs(request.SystemRootPrefix) || filepath.Clean(request.SystemRootPrefix) != request.SystemRootPrefix) {
		return errors.New("discovery system root prefix is invalid")
	}
	return nil
}

func discoverCanonical(request DiscoveryRequest) (DiscoveryResult, bool, error) {
	data, err := readDiscoveryRecord(request.CanonicalManifestPath)
	if errors.Is(err, os.ErrNotExist) {
		return DiscoveryResult{}, false, nil
	}
	if err != nil {
		return DiscoveryResult{Installation: planner.Installation{Kind: planner.InstallationAmbiguous, Profile: request.Profile}}, true, nil
	}
	var header struct {
		SchemaVersion uint32 `json:"schemaVersion"`
	}
	if err := json.Unmarshal(data, &header); err != nil {
		return DiscoveryResult{Installation: planner.Installation{Kind: planner.InstallationAmbiguous, Profile: request.Profile}}, true, nil
	}
	if header.SchemaVersion > model.CurrentManifestSchemaVersion {
		return DiscoveryResult{Installation: planner.Installation{Kind: planner.InstallationUnknownNewer, Profile: request.Profile}}, true, nil
	}
	manifest, err := model.DecodeInstalledManifest(bytes.NewReader(data))
	if err != nil || manifest.Profile != request.Profile {
		return DiscoveryResult{Installation: planner.Installation{Kind: planner.InstallationAmbiguous, Profile: request.Profile}}, true, nil
	}
	if manifest.ActiveGeneration == nil {
		return DiscoveryResult{Installation: planner.Installation{Kind: planner.InstallationAmbiguous, Profile: request.Profile}}, true, nil
	}
	want := filepath.ToSlash(filepath.Join("generations", strings.TrimPrefix(manifest.ActiveGeneration.ID, "sha256:")))
	current, err := readScopedPointer(filepath.Join(request.CanonicalInstallRoot, "current"), request.CanonicalInstallRoot)
	if err != nil || current != want {
		return DiscoveryResult{Installation: planner.Installation{Kind: planner.InstallationAmbiguous, Profile: request.Profile}}, true, nil
	}
	return DiscoveryResult{Installation: planner.Installation{Kind: planner.InstallationManaged, Profile: request.Profile, Manifest: &manifest}}, true, nil
}

func discoverPublicStable(request DiscoveryRequest) (DiscoveryResult, error) {
	ownerParent, err := os.OpenRoot(filepath.Dir(request.OwnerStateRoot))
	if errors.Is(err, os.ErrNotExist) {
		return DiscoveryResult{Installation: planner.Installation{Kind: planner.InstallationEmpty, Profile: request.Profile}}, nil
	}
	if err != nil {
		return DiscoveryResult{Installation: planner.Installation{Kind: planner.InstallationAmbiguous, Profile: request.Profile}}, nil
	}
	defer ownerParent.Close()
	ownerRoot, _, err := openBoundDiscoveryDirectory(ownerParent, filepath.Base(request.OwnerStateRoot))
	if errors.Is(err, os.ErrNotExist) {
		if hasKnownControlResidue(request) {
			return DiscoveryResult{Installation: planner.Installation{Kind: planner.InstallationAmbiguous, Profile: request.Profile}}, nil
		}
		return DiscoveryResult{Installation: planner.Installation{Kind: planner.InstallationEmpty, Profile: request.Profile}}, nil
	}
	if err != nil {
		return DiscoveryResult{Installation: planner.Installation{Kind: planner.InstallationAmbiguous, Profile: request.Profile}}, nil
	}
	defer ownerRoot.Close()
	data, err := readDiscoveryRecordAt(ownerRoot, "install.json")
	if errors.Is(err, os.ErrNotExist) {
		if hasKnownControlResidue(request) {
			return DiscoveryResult{Installation: planner.Installation{Kind: planner.InstallationAmbiguous, Profile: request.Profile}}, nil
		}
		return DiscoveryResult{Installation: planner.Installation{Kind: planner.InstallationEmpty, Profile: request.Profile}}, nil
	}
	if err != nil {
		return DiscoveryResult{Installation: planner.Installation{Kind: planner.InstallationAmbiguous, Profile: request.Profile}}, nil
	}
	var header struct {
		SchemaVersion uint32 `json:"schemaVersion"`
	}
	if err := json.Unmarshal(data, &header); err != nil {
		return DiscoveryResult{Installation: planner.Installation{Kind: planner.InstallationAmbiguous, Profile: request.Profile}}, nil
	}
	if header.SchemaVersion > 2 {
		return DiscoveryResult{Installation: planner.Installation{Kind: planner.InstallationUnknownNewer, Profile: request.Profile}}, nil
	}
	var record managedInstallRecord
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&record); err != nil || (record.SchemaVersion != 1 && record.SchemaVersion != 2) ||
		record.StateDir != request.OwnerStateRoot || record.ConfigPath != filepath.Join(request.OwnerStateRoot, "fased.json") {
		return DiscoveryResult{Installation: planner.Installation{Kind: planner.InstallationAmbiguous, Profile: request.Profile}}, nil
	}
	if err := validateManagedRuntime(record, ownerRoot, request.OwnerStateRoot); err != nil {
		return DiscoveryResult{Installation: planner.Installation{Kind: planner.InstallationAmbiguous, Profile: request.Profile}}, nil
	}
	var topology planner.PublicTopology
	switch request.Profile {
	case model.ProfileProtectedLocal:
		if record.Profile != "local" || record.Service.Scope != "user" || record.Service.Name != "fased-gateway.service" || !safeExecutableWithinRoot(record.Service.Launcher, request.OwnerStateRoot, ownerRoot) {
			return DiscoveryResult{Installation: planner.Installation{Kind: planner.InstallationAmbiguous, Profile: request.Profile}}, nil
		}
		topology = planner.TopologyLocalUserSystemdV2
	case model.ProfileHosting:
		if record.Profile != "hosting" || record.Service.Scope != "system" || record.Service.Name != "fased-gateway.service" || !safeExecutableWithinRoot(record.Service.Launcher, request.OwnerStateRoot, ownerRoot) || !hasExactHostingStableUnits(request) {
			return DiscoveryResult{Installation: planner.Installation{Kind: planner.InstallationAmbiguous, Profile: request.Profile}}, nil
		}
		topology = planner.TopologyHostingControllerV2
	}
	installation, err := planner.PublicStableInstallation(request.Profile, topology)
	return DiscoveryResult{Installation: installation, Topology: topology, PublicPredecessorVersion: record.Runtime.ActiveVersion}, err
}

func validateManagedRuntime(record managedInstallRecord, ownerRoot *os.Root, ownerStateRoot string) error {
	if record.Runtime.ActiveVersion == "" || record.Runtime.CurrentLink != filepath.Join(ownerStateRoot, "runtime", "current") ||
		record.Runtime.ReleasesDir != filepath.Join(ownerStateRoot, "runtime", "releases") {
		return errors.New("managed runtime paths are noncanonical")
	}
	runtimeRoot, _, err := openBoundDiscoveryDirectory(ownerRoot, "runtime")
	if err != nil {
		return errors.New("managed runtime root is unavailable")
	}
	defer runtimeRoot.Close()
	currentTarget, err := runtimeRoot.Readlink("current")
	if err != nil {
		return errors.New("managed runtime current pointer is unsafe")
	}
	releaseName, err := selectedReleaseName(filepath.Join(ownerStateRoot, "runtime"), record.Runtime.ReleasesDir, currentTarget)
	if err != nil {
		return err
	}
	releasesRoot, _, err := openBoundDiscoveryDirectory(runtimeRoot, "releases")
	if err != nil {
		return errors.New("managed runtime releases root is unavailable")
	}
	defer releasesRoot.Close()
	selectedBefore, err := releasesRoot.Lstat(releaseName)
	if err != nil || !selectedBefore.IsDir() || selectedBefore.Mode()&os.ModeSymlink != 0 {
		return errors.New("managed runtime target is unsafe")
	}
	selectedRoot, err := releasesRoot.OpenRoot(releaseName)
	if err != nil {
		return errors.New("managed runtime target is unsafe")
	}
	defer selectedRoot.Close()
	selectedAfter, err := selectedRoot.Stat(".")
	if err != nil || !selectedAfter.IsDir() || !os.SameFile(selectedBefore, selectedAfter) {
		return errors.New("managed runtime target changed while opening")
	}
	packageData, err := readDiscoveryRecordAt(selectedRoot, "package.json")
	if err != nil {
		return errors.New("managed runtime package identity is unavailable")
	}
	currentAfter, err := runtimeRoot.Readlink("current")
	if err != nil || currentAfter != currentTarget {
		return errors.New("managed runtime current pointer changed during discovery")
	}
	selectedAgain, selectedAgainInfo, err := openBoundDiscoveryDirectory(releasesRoot, releaseName)
	if err != nil {
		return errors.New("managed runtime target changed during discovery")
	}
	selectedAgain.Close()
	if !os.SameFile(selectedAfter, selectedAgainInfo) {
		return errors.New("managed runtime target changed during discovery")
	}
	var packageIdentity struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(packageData, &packageIdentity); err != nil || packageIdentity.Version != record.Runtime.ActiveVersion || model.ValidateVersion(packageIdentity.Version) != nil {
		return errors.New("managed runtime version is not bound to the selected package")
	}
	return nil
}

func openBoundDiscoveryDirectory(parent *os.Root, name string) (*os.Root, os.FileInfo, error) {
	before, err := parent.Lstat(name)
	if err != nil {
		return nil, nil, err
	}
	if !before.IsDir() || before.Mode()&os.ModeSymlink != 0 {
		return nil, nil, errors.New("discovery directory is unsafe")
	}
	root, err := parent.OpenRoot(name)
	if err != nil {
		return nil, nil, err
	}
	after, err := root.Stat(".")
	if err != nil || !after.IsDir() || !os.SameFile(before, after) {
		root.Close()
		return nil, nil, errors.New("discovery directory changed while opening")
	}
	return root, after, nil
}

func safeExecutableWithinRoot(path, rootPath string, root *os.Root) bool {
	relative, err := filepath.Rel(rootPath, path)
	if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return false
	}
	file, err := root.Open(relative)
	if err != nil {
		return false
	}
	defer file.Close()
	info, err := file.Stat()
	return err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0o111 != 0
}

func selectedReleaseName(runtimeRoot, releasesRoot, target string) (string, error) {
	resolved := target
	if !filepath.IsAbs(resolved) {
		resolved = filepath.Join(runtimeRoot, resolved)
	}
	resolved = filepath.Clean(resolved)
	relative, err := filepath.Rel(releasesRoot, resolved)
	if err != nil || relative == "." || relative == ".." || strings.Contains(relative, string(filepath.Separator)) || filepath.IsAbs(relative) {
		return "", errors.New("managed runtime current pointer is unsafe")
	}
	return relative, nil
}

func hasKnownControlResidue(request DiscoveryRequest) bool {
	paths := []string{filepath.Join(request.OwnerStateRoot, "runtime"), filepath.Join(request.OwnerStateRoot, "updater")}
	for _, unit := range []string{"fased-host-controller.service", "fased-gateway.service", "fased-signerd.service"} {
		paths = append(paths, rooted(request.SystemRootPrefix, filepath.Join("/etc/systemd/system", unit)))
	}
	for _, path := range paths {
		if _, err := os.Lstat(path); err == nil {
			return true
		}
	}
	supervisorPath := rooted(request.SystemRootPrefix, "/etc/systemd/system/fased-host-updater.service")
	if _, err := os.Lstat(supervisorPath); errors.Is(err, os.ErrNotExist) {
		return false
	}
	return !hasExactHostingBootstrapSupervisor(request, supervisorPath)
}

// hasExactHostingBootstrapSupervisor recognizes the sole idempotent projection
// that a failed fresh Hosting bootstrap may leave before the installation
// manifest exists. It deliberately does not forgive any owner runtime, updater,
// target-service residue, or a supervisor unit that differs by even one byte.
func hasExactHostingBootstrapSupervisor(request DiscoveryRequest, path string) bool {
	if request.Profile != model.ProfileHosting {
		return false
	}
	ownerStateRoot, ok := unrootDiscoveryPath(request.SystemRootPrefix, request.OwnerStateRoot)
	if !ok {
		return false
	}
	config, err := NewConfig(model.ProfileHosting, "hosting", ownerStateRoot,
		Principal{UID: 1, GID: 1}, Principal{UID: 2, GID: 2}, Principal{UID: 3, GID: 3})
	if err != nil {
		return false
	}
	expected, err := RenderSupervisorUnit(config)
	if err != nil {
		return false
	}
	expectedUID, expectedGID := expectedDiscoverySystemOwner(request)
	actual, err := readExactBootstrapProjection(path, 0o644, expectedUID, expectedGID, int64(len(expected)))
	return err == nil && bytes.Equal(actual, expected)
}

func unrootDiscoveryPath(prefix, path string) (string, bool) {
	if prefix == "" {
		return path, true
	}
	relative, err := filepath.Rel(prefix, path)
	if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return "", false
	}
	return filepath.Join(string(filepath.Separator), relative), true
}

func expectedDiscoverySystemOwner(request DiscoveryRequest) (uint32, uint32) {
	if request.SystemRootPrefix == "" {
		return 0, 0
	}
	info, err := os.Lstat(request.SystemRootPrefix)
	if err != nil {
		return ^uint32(0), ^uint32(0)
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return ^uint32(0), ^uint32(0)
	}
	return stat.Uid, stat.Gid
}

func readExactBootstrapProjection(path string, mode os.FileMode, uid, gid uint32, size int64) ([]byte, error) {
	before, err := os.Lstat(path)
	stat, ok := beforeSyscallStat(before)
	if err != nil || !ok || !before.Mode().IsRegular() || before.Mode()&os.ModeSymlink != 0 || before.Mode().Perm() != mode || stat.Nlink != 1 || stat.Uid != uid || stat.Gid != gid || before.Size() != size {
		return nil, errors.New("bootstrap supervisor projection is unsafe")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, errors.New("bootstrap supervisor projection is unsafe")
	}
	defer file.Close()
	after, err := file.Stat()
	if err != nil || !os.SameFile(before, after) {
		return nil, errors.New("bootstrap supervisor projection changed while reading")
	}
	data, err := io.ReadAll(io.LimitReader(file, size+1))
	if err != nil || int64(len(data)) != size {
		return nil, errors.New("bootstrap supervisor projection is unsafe")
	}
	finalDescriptor, descriptorErr := file.Stat()
	finalPath, pathErr := os.Lstat(path)
	if descriptorErr != nil || pathErr != nil || !os.SameFile(before, finalDescriptor) || !os.SameFile(before, finalPath) {
		return nil, errors.New("bootstrap supervisor projection changed while reading")
	}
	return data, nil
}

func beforeSyscallStat(info os.FileInfo) (*syscall.Stat_t, bool) {
	if info == nil {
		return nil, false
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	return stat, ok
}

func hasExactHostingStableUnits(request DiscoveryRequest) bool {
	for _, unit := range []string{"fased-host-updater.service", "fased-host-controller.service", "fased-gateway.service", "fased-signerd.service"} {
		path := rooted(request.SystemRootPrefix, filepath.Join("/etc/systemd/system", unit))
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return false
		}
	}
	return true
}

func readDiscoveryRecord(path string) ([]byte, error) {
	root, err := os.OpenRoot(filepath.Dir(path))
	if err != nil {
		return nil, err
	}
	defer root.Close()
	return readDiscoveryRecordAt(root, filepath.Base(path))
}

func readDiscoveryRecordAt(root *os.Root, name string) ([]byte, error) {
	before, err := root.Lstat(name)
	if err != nil {
		return nil, err
	}
	if !before.Mode().IsRegular() || before.Mode()&os.ModeSymlink != 0 || before.Size() <= 0 || before.Size() > maxDiscoveryRecordSize {
		return nil, errors.New("discovery record is unsafe")
	}
	file, err := root.Open(name)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	after, err := file.Stat()
	if err != nil || !after.Mode().IsRegular() || !os.SameFile(before, after) {
		return nil, errors.New("discovery record changed while opening")
	}
	data, err := io.ReadAll(io.LimitReader(file, maxDiscoveryRecordSize+1))
	if err != nil || len(data) == 0 || len(data) > maxDiscoveryRecordSize {
		return nil, errors.New("discovery record is unsafe")
	}
	return data, nil
}

type DiscoveryEvidenceVerifier struct {
	Request DiscoveryRequest
}

func (verifier DiscoveryEvidenceVerifier) VerifyPublicPredecessorEvidence(topology, version string) error {
	result, err := DiscoverInstallation(verifier.Request)
	if err != nil {
		return err
	}
	if result.Installation.Kind != planner.InstallationPublicStable || string(result.Topology) != topology || result.PublicPredecessorVersion != version {
		return errors.New("public predecessor evidence changed before convergence")
	}
	return nil
}

func readScopedPointer(path, root string) (string, error) {
	info, err := os.Lstat(path)
	if err != nil || info.Mode()&os.ModeSymlink == 0 {
		return "", errors.New("generation pointer is not a symlink")
	}
	target, err := os.Readlink(path)
	if err != nil || filepath.IsAbs(target) || filepath.Clean(target) != target {
		return "", errors.New("generation pointer target is unsafe")
	}
	resolved := filepath.Join(filepath.Dir(path), target)
	if !pathWithin(root, resolved) {
		return "", errors.New("generation pointer escapes install root")
	}
	return filepath.ToSlash(target), nil
}

func pathWithin(root, path string) bool {
	relative, err := filepath.Rel(root, path)
	return err == nil && relative != "." && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

func rooted(prefix, path string) string {
	if prefix == "" {
		return path
	}
	return filepath.Join(prefix, strings.TrimPrefix(path, "/"))
}

func (result DiscoveryResult) String() string {
	return fmt.Sprintf("%s:%s", result.Installation.Kind, result.Topology)
}
