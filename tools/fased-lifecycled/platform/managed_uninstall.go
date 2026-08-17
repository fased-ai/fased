package platform

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"fased-lifecycled/model"
)

const CurrentManagedUninstallSchemaVersion uint32 = 1

type ManagedUninstallRecord struct {
	SchemaVersion        uint32         `json:"schemaVersion"`
	Profile              model.Profile  `json:"profile"`
	InstanceID           string         `json:"instanceId"`
	ConfigurationDigest  string         `json:"configurationDigest"`
	ActiveGenerationID   string         `json:"activeGenerationId"`
	ManifestDigest       string         `json:"manifestDigest"`
	Manifest             model.Manifest `json:"manifest"`
	HostSecurityRestored bool           `json:"hostSecurityRestored"`
	ServicesStopped      bool           `json:"servicesStopped"`
	ServicesDisabled     bool           `json:"servicesDisabled"`
	UnitsRemoved         bool           `json:"unitsRemoved"`
	AuthorityRemoved     bool           `json:"authorityRemoved"`
	ProjectionsRemoved   bool           `json:"projectionsRemoved"`
	ManagedRootsRemoved  bool           `json:"managedRootsRemoved"`
	LauncherRemoved      bool           `json:"launcherRemoved"`
	Completed            bool           `json:"completed"`
}

func (record ManagedUninstallRecord) Validate() error {
	if record.SchemaVersion != CurrentManagedUninstallSchemaVersion ||
		(record.Profile != model.ProfileProtectedLocal && record.Profile != model.ProfileHosting) ||
		!instancePattern.MatchString(record.InstanceID) || !validManagedDigest(record.ConfigurationDigest) ||
		!validManagedDigest(record.ActiveGenerationID) || !validManagedDigest(record.ManifestDigest) {
		return errors.New("managed uninstall identity is invalid")
	}
	digest, err := ManagedManifestDigest(record.Manifest)
	if err != nil || record.Manifest.ValidateInstalled() != nil || record.Manifest.Profile != record.Profile ||
		record.Manifest.ActiveGeneration == nil || record.Manifest.ActiveGeneration.ID != record.ActiveGenerationID || digest != record.ManifestDigest {
		return errors.New("managed uninstall manifest binding is invalid")
	}
	if record.Profile == model.ProfileHosting && !record.HostSecurityRestored {
		if record.ServicesStopped || record.ServicesDisabled || record.UnitsRemoved || record.AuthorityRemoved || record.ProjectionsRemoved || record.ManagedRootsRemoved || record.LauncherRemoved || record.Completed {
			return errors.New("Hosting uninstall crossed the host-security restoration boundary")
		}
	}
	if record.Completed && (!record.HostSecurityRestored || !record.ServicesStopped || !record.ServicesDisabled || !record.UnitsRemoved || !record.AuthorityRemoved || !record.ProjectionsRemoved || !record.ManagedRootsRemoved || !record.LauncherRemoved) {
		return errors.New("managed uninstall completion is inconsistent")
	}
	return nil
}

type ManagedUninstaller struct {
	Config              Config
	Manifest            model.Manifest
	ManifestDigest      string
	Systemd             Systemd
	OperatorUser        string
	PayloadPath         string
	DependencyPath      string
	PluginLockData      []byte
	RootPrefix          string
	ExpectedUID         uint32
	RestoreHostSecurity func(context.Context) error
	syncDir             func(string) error
}

func (uninstaller *ManagedUninstaller) Run(ctx context.Context) (ManagedUninstallRecord, error) {
	record, err := uninstaller.loadOrCreateRecord()
	if err != nil {
		return ManagedUninstallRecord{}, err
	}
	if record.Completed {
		return record, nil
	}
	identity, _ := uninstaller.Config.Identity()
	if !record.HostSecurityRestored {
		if uninstaller.Config.Profile == model.ProfileHosting {
			if uninstaller.RestoreHostSecurity == nil {
				return record, errors.New("Hosting uninstall lacks host-security restoration")
			}
			if err := uninstaller.RestoreHostSecurity(ctx); err != nil {
				return record, err
			}
		}
		record.HostSecurityRestored = true
		if err := uninstaller.writeRecord(record); err != nil {
			return record, err
		}
	}
	services := []string{identity.Services["gateway"], identity.Services["signer"], identity.Services["supervisor"]}
	if !record.ServicesStopped {
		for _, unit := range services {
			if err := uninstaller.Systemd.Stop(ctx, unit); err != nil {
				return record, err
			}
		}
		record.ServicesStopped = true
		if err := uninstaller.writeRecord(record); err != nil {
			return record, err
		}
	}
	if !record.ServicesDisabled {
		for _, unit := range services {
			if err := uninstaller.Systemd.Disable(ctx, unit); err != nil {
				return record, err
			}
		}
		record.ServicesDisabled = true
		if err := uninstaller.writeRecord(record); err != nil {
			return record, err
		}
	}
	if !record.UnitsRemoved {
		expected, err := uninstaller.expectedUnits(identity)
		if err != nil {
			return record, err
		}
		for unit, data := range expected {
			if err := uninstaller.removeExactFile(uninstaller.Config.ServiceDefinitionPath(unit), data, 0o644, uninstaller.ExpectedUID); err != nil {
				return record, err
			}
		}
		if err := uninstaller.Systemd.DaemonReload(ctx); err != nil {
			return record, err
		}
		record.UnitsRemoved = true
		if err := uninstaller.writeRecord(record); err != nil {
			return record, err
		}
	}
	if !record.AuthorityRemoved {
		authority, err := RenderUpdateAuthority(uninstaller.Config, uninstaller.OperatorUser)
		if err != nil {
			return record, err
		}
		if err := uninstaller.removeExactFile(uninstaller.Config.UpdateAuthorityPath(), authority, 0o440, uninstaller.ExpectedUID); err != nil {
			return record, err
		}
		record.AuthorityRemoved = true
		if err := uninstaller.writeRecord(record); err != nil {
			return record, err
		}
	}
	if !record.ProjectionsRemoved {
		if err := uninstaller.removeProjections(); err != nil {
			return record, err
		}
		record.ProjectionsRemoved = true
		if err := uninstaller.writeRecord(record); err != nil {
			return record, err
		}
	}
	if !record.ManagedRootsRemoved {
		if err := uninstaller.removeManagedRoots(); err != nil {
			return record, err
		}
		record.ManagedRootsRemoved = true
		if err := uninstaller.writeRecord(record); err != nil {
			return record, err
		}
	}
	if !record.LauncherRemoved {
		launcher, err := RenderCLILauncher(uninstaller.Config)
		if err != nil {
			return record, err
		}
		if err := uninstaller.removeExactFile(filepath.Join(uninstaller.Config.OwnerStateRoot, "bin", "fased"), launcher, 0o755, uninstaller.ExpectedUID); err != nil {
			return record, err
		}
		record.LauncherRemoved = true
		if err := uninstaller.writeRecord(record); err != nil {
			return record, err
		}
	}
	record.Completed = true
	if err := uninstaller.writeRecord(record); err != nil {
		return record, err
	}
	return record, nil
}

func (uninstaller *ManagedUninstaller) validate() (string, error) {
	if uninstaller == nil || uninstaller.Systemd == nil {
		return "", errors.New("managed uninstaller is incomplete")
	}
	if err := uninstaller.Config.Validate(); err != nil {
		return "", err
	}
	if !accountNamePattern.MatchString(uninstaller.OperatorUser) || uninstaller.OperatorUser == "root" {
		return "", errors.New("managed uninstall operator identity is invalid")
	}
	if uninstaller.RootPrefix != "" && (!filepath.IsAbs(uninstaller.RootPrefix) || filepath.Clean(uninstaller.RootPrefix) != uninstaller.RootPrefix || uninstaller.RootPrefix == "/") {
		return "", errors.New("managed uninstall root prefix is unsafe")
	}
	if err := uninstaller.Manifest.ValidateInstalled(); err != nil || uninstaller.Manifest.Profile != uninstaller.Config.Profile || uninstaller.Manifest.ActiveGeneration == nil {
		return "", errors.Join(err, errors.New("managed uninstall manifest is invalid"))
	}
	identity, err := uninstaller.Config.Identity()
	if err != nil {
		return "", err
	}
	want, _ := identity.Digest(uninstaller.Config.Profile)
	got, digestErr := uninstaller.Manifest.Platform.Digest(uninstaller.Manifest.Profile)
	if digestErr != nil || want != got || uninstaller.Manifest.Platform.InstanceID != uninstaller.Config.InstanceID {
		return "", errors.New("managed uninstall platform identity differs from the installed manifest")
	}
	if !validManagedDigest(uninstaller.ManifestDigest) {
		return "", errors.New("managed uninstall manifest digest is invalid")
	}
	return want, nil
}

func (uninstaller *ManagedUninstaller) loadOrCreateRecord() (ManagedUninstallRecord, error) {
	configurationDigest, err := uninstaller.validate()
	if err != nil {
		return ManagedUninstallRecord{}, err
	}
	path := uninstaller.recordPath()
	record, err := readManagedUninstallRecord(uninstaller.resolve(path), uninstaller.ExpectedUID)
	if err == nil {
		if record.Profile == uninstaller.Config.Profile && record.InstanceID == uninstaller.Config.InstanceID && record.ConfigurationDigest == configurationDigest &&
			record.ActiveGenerationID == uninstaller.Manifest.ActiveGeneration.ID && record.ManifestDigest == uninstaller.ManifestDigest {
			return record, nil
		}
		if !record.Completed {
			return ManagedUninstallRecord{}, errors.New("incomplete managed uninstall has a different installed identity")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return ManagedUninstallRecord{}, err
	}
	record = ManagedUninstallRecord{SchemaVersion: CurrentManagedUninstallSchemaVersion,
		Profile: uninstaller.Config.Profile, InstanceID: uninstaller.Config.InstanceID,
		ConfigurationDigest: configurationDigest, ActiveGenerationID: uninstaller.Manifest.ActiveGeneration.ID,
		ManifestDigest: uninstaller.ManifestDigest, Manifest: uninstaller.Manifest,
		HostSecurityRestored: uninstaller.Config.Profile != model.ProfileHosting}
	if err := uninstaller.writeRecord(record); err != nil {
		return ManagedUninstallRecord{}, err
	}
	return record, nil
}

func (uninstaller *ManagedUninstaller) expectedUnits(identity model.PlatformIdentity) (map[string][]byte, error) {
	if uninstaller.Manifest.ActiveGeneration == nil || uninstaller.PayloadPath == "" {
		return nil, errors.New("managed uninstall target unit identity is unavailable")
	}
	adapter := TargetAdapter{Config: uninstaller.Config, Identity: identity}
	units, err := adapter.renderTargetUnits(uninstaller.PayloadPath, *uninstaller.Manifest.ActiveGeneration, uninstaller.DependencyPath)
	if err != nil {
		return nil, err
	}
	supervisor, err := RenderSupervisorUnit(uninstaller.Config)
	if err != nil {
		return nil, err
	}
	units[identity.Services["supervisor"]] = supervisor
	return units, nil
}

func (uninstaller *ManagedUninstaller) removeProjections() error {
	if err := uninstaller.removeManagedCLIProjection(); err != nil {
		return err
	}
	cli, err := CanonicalCLIProjectionJSON(uninstaller.Config)
	if err != nil {
		return err
	}
	install, err := CanonicalInstallProjectionForManifestJSON(uninstaller.Config, uninstaller.Manifest)
	if err != nil {
		return err
	}
	wrapper, err := RenderSignerOwnerWrapper(uninstaller.Config)
	if err != nil {
		return err
	}
	checks := []struct {
		path string
		data []byte
		mode os.FileMode
		uid  uint32
	}{
		{CanonicalCLIProjectionPath(uninstaller.Config), cli, 0o640, uninstaller.Config.Operator.UID},
		{CanonicalInstallProjectionPath(uninstaller.Config), install, 0o640, uninstaller.Config.Operator.UID},
		{CanonicalSignerOwnerFiles(uninstaller.Config)[1], wrapper, 0o755, uninstaller.ExpectedUID},
	}
	for _, check := range checks {
		if err := uninstaller.removeExactFile(check.path, check.data, check.mode, check.uid); err != nil {
			return err
		}
	}
	return uninstaller.removePluginLockProjection()
}

func (uninstaller *ManagedUninstaller) removeManagedCLIProjection() error {
	data, err := RenderManagedCLIProjection(uninstaller.Config)
	if err != nil {
		return err
	}
	ancestryRoot := "/"
	if uninstaller.RootPrefix != "" {
		ancestryRoot = uninstaller.RootPrefix
	}
	path := uninstaller.resolve(ManagedCLIProjectionPath)
	if err := validateManagedCLIProjectionAncestry(path, ancestryRoot, uninstaller.ExpectedUID); err != nil {
		return err
	}
	return uninstaller.removeExactFile(ManagedCLIProjectionPath, data, 0o755, uninstaller.ExpectedUID)
}

func (uninstaller *ManagedUninstaller) removePluginLockProjection() error {
	if len(uninstaller.PluginLockData) == 0 {
		return nil
	}
	path := CanonicalPluginLockPath(uninstaller.Config)
	data, err := readExactRootFile(
		uninstaller.resolve(path),
		0o640,
		uninstaller.Config.Operator.UID,
		1<<20,
	)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !bytes.Equal(data, uninstaller.PluginLockData) {
		return nil
	}
	resolved := uninstaller.resolve(path)
	if err := os.Remove(resolved); err != nil {
		return err
	}
	return uninstaller.syncDirectory(filepath.Dir(resolved))
}

func (uninstaller *ManagedUninstaller) removeManagedRoots() error {
	if uninstaller.Config.Profile == model.ProfileProtectedLocal {
		if err := uninstaller.removeTree(uninstaller.Config.InstallRoot); err != nil {
			return err
		}
		if err := uninstaller.removeTree(filepath.Join(uninstaller.Config.ProductStateRoot, "controller")); err != nil {
			return err
		}
	} else {
		for _, child := range []string{"current", "previous", "generations", "dependencies", "inbox", "plugin-code", "helpers"} {
			if err := uninstaller.removePath(filepath.Join(uninstaller.Config.InstallRoot, child)); err != nil {
				return err
			}
		}
		for _, path := range []string{"/var/lib/fased-host-updater", "/var/lib/fased-signer-update-gate", "/var/lib/fased-host-security", "/etc/fased/hosting-prerequisites"} {
			if err := uninstaller.removePath(path); err != nil {
				return err
			}
		}
	}
	if err := uninstaller.removePath(uninstaller.Config.RuntimeRoot); err != nil {
		return err
	}
	return uninstaller.pruneLifecycleState()
}

func (uninstaller *ManagedUninstaller) pruneLifecycleState() error {
	root := uninstaller.resolve(uninstaller.Config.LifecycleRoot)
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.Join(err, errors.New("managed lifecycle root is unsafe during uninstall"))
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return err
	}
	keep := map[string]bool{"platform.json": true, "update-policy.json": true, "uninstalled.json": true}
	for _, entry := range entries {
		if keep[entry.Name()] {
			continue
		}
		if err := os.RemoveAll(filepath.Join(root, entry.Name())); err != nil {
			return err
		}
		if err := uninstaller.syncDirectory(root); err != nil {
			return err
		}
	}
	return nil
}

func (uninstaller *ManagedUninstaller) recordPath() string {
	return filepath.Join(uninstaller.Config.LifecycleRoot, "uninstalled.json")
}

func (uninstaller *ManagedUninstaller) writeRecord(record ManagedUninstallRecord) error {
	if err := record.Validate(); err != nil {
		return err
	}
	data, err := json.Marshal(record)
	if err != nil {
		return err
	}
	path := uninstaller.resolve(uninstaller.recordPath())
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	return writeAtomicRootOwnedFileWithDirectorySync(
		path,
		append(data, '\n'),
		0o600,
		uninstaller.ExpectedUID,
		uninstaller.syncDirectory,
	)
}

func readManagedUninstallRecord(path string, expectedUID uint32) (ManagedUninstallRecord, error) {
	data, err := readExactRootFile(path, 0o600, expectedUID, 1<<20)
	if err != nil {
		return ManagedUninstallRecord{}, err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var record ManagedUninstallRecord
	if err := decoder.Decode(&record); err != nil {
		return ManagedUninstallRecord{}, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return ManagedUninstallRecord{}, errors.New("managed uninstall record contains trailing data")
	}
	if err := record.Validate(); err != nil {
		return ManagedUninstallRecord{}, err
	}
	return record, nil
}

func ReadManagedUninstallRecord(config Config, expectedUID uint32) (ManagedUninstallRecord, error) {
	if err := config.Validate(); err != nil {
		return ManagedUninstallRecord{}, err
	}
	record, err := readManagedUninstallRecord(filepath.Join(config.LifecycleRoot, "uninstalled.json"), expectedUID)
	if err != nil {
		return ManagedUninstallRecord{}, err
	}
	identity, err := config.Identity()
	if err != nil {
		return ManagedUninstallRecord{}, err
	}
	digest, err := identity.Digest(config.Profile)
	if err != nil || record.Profile != config.Profile || record.InstanceID != config.InstanceID || record.ConfigurationDigest != digest {
		return ManagedUninstallRecord{}, errors.New("managed uninstall record differs from the installed platform")
	}
	return record, nil
}

func (uninstaller *ManagedUninstaller) removeExactFile(path string, expected []byte, mode os.FileMode, uid uint32) error {
	resolved := uninstaller.resolve(path)
	data, err := readExactRootFile(resolved, mode, uid, int64(len(expected)+1))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !bytes.Equal(data, expected) {
		return fmt.Errorf("managed uninstall refused modified file %s", path)
	}
	if err := os.Remove(resolved); err != nil {
		return err
	}
	return uninstaller.syncDirectory(filepath.Dir(resolved))
}

func readExactRootFile(path string, mode os.FileMode, uid uint32, limit int64) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != mode || stat.Uid != uid || stat.Nlink != 1 || info.Size() <= 0 || info.Size() > limit {
		return nil, errors.New("managed uninstall file is unsafe")
	}
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	after, err := file.Stat()
	if err != nil || !os.SameFile(info, after) {
		return nil, errors.Join(err, errors.New("managed uninstall file changed while opening"))
	}
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil || int64(len(data)) > limit {
		return nil, errors.Join(err, errors.New("managed uninstall file exceeded its bound"))
	}
	return data, nil
}

func writeAtomicRootOwnedFile(path string, data []byte, mode os.FileMode, uid uint32) error {
	return writeAtomicRootOwnedFileWithDirectorySync(path, data, mode, uid, syncManagedUninstallDirectory)
}

func writeAtomicRootOwnedFileWithDirectorySync(path string, data []byte, mode os.FileMode, uid uint32, syncDir func(string) error) error {
	temporary, err := os.CreateTemp(filepath.Dir(path), ".fased-uninstall-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(mode); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Chown(int(uid), int(uid)); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return err
	}
	return syncDir(filepath.Dir(path))
}

func (uninstaller *ManagedUninstaller) syncDirectory(path string) error {
	if uninstaller.syncDir != nil {
		return uninstaller.syncDir(path)
	}
	return syncManagedUninstallDirectory(path)
}

func syncManagedUninstallDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	if err := directory.Sync(); err != nil {
		_ = directory.Close()
		return err
	}
	return directory.Close()
}

func (uninstaller *ManagedUninstaller) removeTree(path string) error {
	resolved := uninstaller.resolve(path)
	info, err := os.Lstat(resolved)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.Join(err, fmt.Errorf("managed uninstall tree is unsafe: %s", path))
	}
	if err := os.RemoveAll(resolved); err != nil {
		return err
	}
	return uninstaller.syncDirectory(filepath.Dir(resolved))
}

func (uninstaller *ManagedUninstaller) removePath(path string) error {
	resolved := uninstaller.resolve(path)
	info, err := os.Lstat(resolved)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || info.Mode().IsRegular() {
		if err := os.Remove(resolved); err != nil {
			return err
		}
		return uninstaller.syncDirectory(filepath.Dir(resolved))
	}
	if !info.IsDir() {
		return fmt.Errorf("managed uninstall path is unsafe: %s", path)
	}
	if err := os.RemoveAll(resolved); err != nil {
		return err
	}
	return uninstaller.syncDirectory(filepath.Dir(resolved))
}

func (uninstaller *ManagedUninstaller) resolve(path string) string {
	if uninstaller.RootPrefix == "" {
		return path
	}
	return filepath.Join(uninstaller.RootPrefix, filepath.Clean(path))
}

func validManagedDigest(value string) bool {
	if len(value) != 71 || !strings.HasPrefix(value, "sha256:") {
		return false
	}
	_, err := hex.DecodeString(strings.TrimPrefix(value, "sha256:"))
	return err == nil
}

func ManagedManifestDigest(manifest model.Manifest) (string, error) {
	data, err := json.Marshal(manifest)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(data)
	return fmt.Sprintf("sha256:%x", digest), nil
}
