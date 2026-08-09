package platform

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

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
	Installation planner.Installation
	Topology     planner.PublicTopology
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
	manifest, err := model.DecodeManifest(bytes.NewReader(data))
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
	manifestPath := filepath.Join(request.OwnerStateRoot, "install.json")
	data, err := readDiscoveryRecord(manifestPath)
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
	if err := validateManagedRuntime(record, request.OwnerStateRoot); err != nil {
		return DiscoveryResult{Installation: planner.Installation{Kind: planner.InstallationAmbiguous, Profile: request.Profile}}, nil
	}
	var topology planner.PublicTopology
	switch request.Profile {
	case model.ProfileProtectedLocal:
		if record.Profile != "local" || record.Service.Scope != "user" || record.Service.Name != "fased-gateway.service" || !safeExecutableWithin(record.Service.Launcher, request.OwnerStateRoot) {
			return DiscoveryResult{Installation: planner.Installation{Kind: planner.InstallationAmbiguous, Profile: request.Profile}}, nil
		}
		topology = planner.TopologyLocalUserSystemdV2
	case model.ProfileHosting:
		if record.Profile != "hosting" || record.Service.Scope != "system" || record.Service.Name != "fased-gateway.service" || !safeExecutableWithin(record.Service.Launcher, request.OwnerStateRoot) || !hasExactHostingStableUnits(request) {
			return DiscoveryResult{Installation: planner.Installation{Kind: planner.InstallationAmbiguous, Profile: request.Profile}}, nil
		}
		topology = planner.TopologyHostingControllerV2
	}
	installation, err := planner.PublicStableInstallation(request.Profile, topology)
	return DiscoveryResult{Installation: installation, Topology: topology}, err
}

func validateManagedRuntime(record managedInstallRecord, ownerStateRoot string) error {
	if record.Runtime.ActiveVersion == "" || record.Runtime.CurrentLink != filepath.Join(ownerStateRoot, "runtime", "current") ||
		record.Runtime.ReleasesDir != filepath.Join(ownerStateRoot, "runtime", "releases") {
		return errors.New("managed runtime paths are noncanonical")
	}
	resolved, err := filepath.EvalSymlinks(record.Runtime.CurrentLink)
	if err != nil || !pathWithin(record.Runtime.ReleasesDir, resolved) {
		return errors.New("managed runtime current pointer is unsafe")
	}
	info, err := os.Lstat(resolved)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("managed runtime target is unsafe")
	}
	return nil
}

func hasKnownControlResidue(request DiscoveryRequest) bool {
	paths := []string{filepath.Join(request.OwnerStateRoot, "runtime"), filepath.Join(request.OwnerStateRoot, "updater")}
	for _, unit := range []string{"fased-host-updater.service", "fased-host-controller.service", "fased-gateway.service", "fased-signerd.service"} {
		paths = append(paths, rooted(request.SystemRootPrefix, filepath.Join("/etc/systemd/system", unit)))
	}
	for _, path := range paths {
		if _, err := os.Lstat(path); err == nil {
			return true
		}
	}
	return false
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
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() <= 0 || info.Size() > maxDiscoveryRecordSize {
		return nil, errors.New("discovery record is unsafe")
	}
	return os.ReadFile(path)
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

func safeExecutableWithin(path, root string) bool {
	if !filepath.IsAbs(path) || !pathWithin(root, path) {
		return false
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil || !pathWithin(root, resolved) {
		return false
	}
	info, err := os.Stat(resolved)
	return err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0o111 != 0
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
