package platform

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"syscall"
	"time"
)

const (
	LocalInstanceRegistryPath       = "/var/lib/fased-local-registry/instances.json"
	DarwinLocalInstanceRegistryPath = "/Library/FasedLifecycle/instances.json"
	localRegistrySchema             = uint32(1)
	maxLocalRegistrySize            = 1 << 20
)

func LocalInstanceRegistryPathForOS(operatingSystem string) string {
	if operatingSystem == "darwin" {
		return DarwinLocalInstanceRegistryPath
	}
	return LocalInstanceRegistryPath
}

type LocalInstanceEntry struct {
	InstanceID   string `json:"instanceId"`
	OperatorUID  uint32 `json:"operatorUid"`
	OperatorUser string `json:"operatorUser"`
	Profile      string `json:"profile"`
	StateDir     string `json:"stateDir"`
	CreatedAt    string `json:"createdAt"`
}

type localInstanceRegistry struct {
	SchemaVersion uint32               `json:"schemaVersion"`
	Instances     []LocalInstanceEntry `json:"instances"`
}

type LocalInstanceRequest struct {
	TransactionID string
	OperatorUID   uint32
	OperatorUser  string
	Profile       string
	StateDir      string
}

type LocalInstanceAllocation struct {
	Entry          LocalInstanceEntry
	TransactionID  string
	RegistryDigest string
	Created        bool
	Committed      bool
}

type InstanceIDSource interface {
	Read([]byte) (int, error)
}

// FindLocalInstance performs the read-only half of Local instance selection.
// It never allocates an identity and therefore is safe before compatibility
// planning decides whether mutation is allowed.
func FindLocalInstance(registryPath string, expectedOwnerUID uint32, operatorUID uint32, operatorUser, profile, stateDir string) (LocalInstanceEntry, bool, error) {
	registry, _, err := readLocalInstanceRegistry(registryPath, expectedOwnerUID)
	if err != nil {
		return LocalInstanceEntry{}, false, err
	}
	for _, entry := range registry.Instances {
		if entry.OperatorUID == operatorUID && entry.Profile == profile && entry.StateDir == stateDir {
			if entry.OperatorUser != operatorUser {
				return LocalInstanceEntry{}, false, errors.New("registered Local operator identity changed for its UID")
			}
			return entry, true, nil
		}
	}
	return LocalInstanceEntry{}, false, nil
}

func PlanLocalInstance(registryPath string, expectedOwnerUID uint32, request LocalInstanceRequest, source InstanceIDSource, now time.Time) (LocalInstanceAllocation, error) {
	if err := validateLocalInstanceRequest(request); err != nil {
		return LocalInstanceAllocation{}, err
	}
	registry, registryDigest, err := readLocalInstanceRegistry(registryPath, expectedOwnerUID)
	if err != nil {
		return LocalInstanceAllocation{}, err
	}
	for _, entry := range registry.Instances {
		if entry.OperatorUID == request.OperatorUID && entry.Profile == request.Profile && entry.StateDir == request.StateDir {
			if entry.OperatorUser != request.OperatorUser {
				return LocalInstanceAllocation{}, errors.New("registered Local operator identity changed for its UID")
			}
			return LocalInstanceAllocation{Entry: entry, TransactionID: request.TransactionID, RegistryDigest: registryDigest, Committed: true}, nil
		}
	}
	if source == nil {
		source = rand.Reader
	}
	ids := map[string]bool{}
	for _, entry := range registry.Instances {
		ids[entry.InstanceID] = true
	}
	instanceID := ""
	for attempts := 0; attempts < 64; attempts++ {
		value := make([]byte, 8)
		if _, err := io.ReadFull(source, value); err != nil {
			return LocalInstanceAllocation{}, err
		}
		candidate := hex.EncodeToString(value)
		if !ids[candidate] {
			instanceID = candidate
			break
		}
	}
	if instanceID == "" {
		return LocalInstanceAllocation{}, errors.New("could not allocate a unique Local instance identity")
	}
	entry := LocalInstanceEntry{InstanceID: instanceID, OperatorUID: request.OperatorUID,
		OperatorUser: request.OperatorUser, Profile: request.Profile, StateDir: request.StateDir,
		CreatedAt: now.UTC().Format(time.RFC3339Nano)}
	return LocalInstanceAllocation{Entry: entry, TransactionID: request.TransactionID, RegistryDigest: registryDigest, Created: true}, nil
}

func CommitLocalInstance(registryPath string, expectedOwnerUID uint32, allocation *LocalInstanceAllocation) error {
	if allocation == nil || !allocation.Created || allocation.Committed || allocation.TransactionID == "" {
		return errors.New("Local instance allocation is not commit-ready")
	}
	registry, currentDigest, err := readLocalInstanceRegistry(registryPath, expectedOwnerUID)
	if err != nil {
		return err
	}
	for _, entry := range registry.Instances {
		if sameLocalBoundary(entry, allocation.Entry) {
			if entry != allocation.Entry {
				return errors.New("Local instance boundary was committed by another transaction")
			}
			allocation.Committed = true
			return nil
		}
		if entry.InstanceID == allocation.Entry.InstanceID {
			return errors.New("Local instance ID was committed by another transaction")
		}
	}
	if currentDigest != allocation.RegistryDigest {
		return errors.New("Local instance registry compare-and-swap mismatch")
	}
	registry.Instances = append(registry.Instances, allocation.Entry)
	sort.Slice(registry.Instances, func(left, right int) bool {
		return registry.Instances[left].InstanceID < registry.Instances[right].InstanceID
	})
	if err := writeLocalInstanceRegistry(registryPath, expectedOwnerUID, registry); err != nil {
		return err
	}
	allocation.Committed = true
	return nil
}

func RollbackLocalInstance(registryPath string, expectedOwnerUID uint32, allocation *LocalInstanceAllocation) error {
	if allocation == nil || !allocation.Created || !allocation.Committed {
		return nil
	}
	registry, _, err := readLocalInstanceRegistry(registryPath, expectedOwnerUID)
	if err != nil {
		return err
	}
	next := make([]LocalInstanceEntry, 0, len(registry.Instances))
	removed := false
	for _, entry := range registry.Instances {
		if entry.InstanceID == allocation.Entry.InstanceID {
			if entry != allocation.Entry {
				return errors.New("Local instance rollback identity mismatch")
			}
			removed = true
			continue
		}
		next = append(next, entry)
	}
	if removed {
		registry.Instances = next
		if err := writeLocalInstanceRegistry(registryPath, expectedOwnerUID, registry); err != nil {
			return err
		}
	}
	allocation.Committed = false
	return nil
}

func validateLocalInstanceRequest(request LocalInstanceRequest) error {
	if !lockTransactionPattern.MatchString(request.TransactionID) {
		return errors.New("Local instance transaction identity is invalid")
	}
	if request.OperatorUID == 0 || !accountNamePattern.MatchString(request.OperatorUser) || request.OperatorUser == "root" {
		return errors.New("Local instance operator identity is invalid")
	}
	if request.Profile == "" || len(request.Profile) > 128 || strings.IndexFunc(request.Profile, func(value rune) bool { return value <= 0x1f || value == 0x7f }) >= 0 {
		return errors.New("Local instance profile identity is invalid")
	}
	if !filepath.IsAbs(request.StateDir) || filepath.Clean(request.StateDir) != request.StateDir {
		return errors.New("Local instance state directory is invalid")
	}
	info, err := os.Lstat(request.StateDir)
	if errors.Is(err, os.ErrNotExist) {
		parent := filepath.Dir(request.StateDir)
		parentInfo, parentErr := os.Lstat(parent)
		parentStat, parentOK := infoSyscall(parentInfo)
		if parentErr != nil || !parentOK || !parentInfo.IsDir() || parentInfo.Mode()&os.ModeSymlink != 0 || parentStat.Uid != request.OperatorUID {
			return errors.New("Local instance state directory parent is unavailable or unsafe")
		}
		return nil
	}
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("Local instance state directory must be a non-symlink directory")
	}
	return nil
}

var lockTransactionPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func sameLocalBoundary(left, right LocalInstanceEntry) bool {
	return left.OperatorUID == right.OperatorUID && left.Profile == right.Profile && left.StateDir == right.StateDir
}

func readLocalInstanceRegistry(path string, expectedOwnerUID uint32) (localInstanceRegistry, string, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path || path == "/" {
		return localInstanceRegistry{}, "", errors.New("Local instance registry path is invalid")
	}
	if err := validateLocalRegistryParent(filepath.Dir(path), expectedOwnerUID, false); err != nil {
		return localInstanceRegistry{}, "", err
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		registry := localInstanceRegistry{SchemaVersion: localRegistrySchema, Instances: []LocalInstanceEntry{}}
		return registry, localRegistryDigest(registry), nil
	}
	if err != nil {
		return localInstanceRegistry{}, "", err
	}
	info, err := os.Lstat(path)
	stat, ok := infoSyscall(info)
	if err != nil || !ok || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0o600 || stat.Uid != expectedOwnerUID || stat.Nlink != 1 || len(data) == 0 || len(data) > maxLocalRegistrySize {
		return localInstanceRegistry{}, "", errors.New("Local instance registry is unsafe")
	}
	var registry localInstanceRegistry
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&registry); err != nil {
		return localInstanceRegistry{}, "", err
	}
	if err := validateLocalInstanceRegistry(registry); err != nil {
		return localInstanceRegistry{}, "", err
	}
	return registry, localRegistryDigest(registry), nil
}

func writeLocalInstanceRegistry(path string, expectedOwnerUID uint32, registry localInstanceRegistry) error {
	if err := validateLocalInstanceRegistry(registry); err != nil {
		return err
	}
	parent := filepath.Dir(path)
	if err := validateLocalRegistryParent(parent, expectedOwnerUID, true); err != nil {
		return err
	}
	data, err := json.Marshal(registry)
	if err != nil {
		return err
	}
	temporary, err := os.CreateTemp(parent, ".instances-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(append(data, '\n')); err != nil {
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
	directory, err := os.Open(parent)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}

func validateLocalInstanceRegistry(registry localInstanceRegistry) error {
	if registry.SchemaVersion > localRegistrySchema {
		return errors.New("Local instance registry schema is newer than supported")
	}
	if registry.SchemaVersion != localRegistrySchema || registry.Instances == nil {
		return errors.New("Local instance registry schema is unsupported")
	}
	ids, boundaries := map[string]bool{}, map[string]bool{}
	for _, entry := range registry.Instances {
		if !regexp.MustCompile(`^[0-9a-f]{16}$`).MatchString(entry.InstanceID) || entry.OperatorUID == 0 || !accountNamePattern.MatchString(entry.OperatorUser) ||
			entry.Profile == "" || !filepath.IsAbs(entry.StateDir) || filepath.Clean(entry.StateDir) != entry.StateDir {
			return errors.New("Local instance registry contains an invalid entry")
		}
		if _, err := time.Parse(time.RFC3339Nano, entry.CreatedAt); err != nil {
			return errors.New("Local instance registry contains an invalid creation time")
		}
		boundary := fmt.Sprintf("%d\x00%s\x00%s", entry.OperatorUID, entry.Profile, entry.StateDir)
		if ids[entry.InstanceID] || boundaries[boundary] {
			return errors.New("Local instance registry contains a duplicate identity")
		}
		ids[entry.InstanceID], boundaries[boundary] = true, true
	}
	return nil
}

func localRegistryDigest(registry localInstanceRegistry) string {
	data, _ := json.Marshal(registry)
	sum := sha256.Sum256(data)
	return fmt.Sprintf("sha256:%x", sum)
}

func validateLocalRegistryParent(parent string, expectedOwnerUID uint32, create bool) error {
	if info, err := os.Lstat(parent); errors.Is(err, os.ErrNotExist) {
		if !create {
			return nil
		}
		if err := os.MkdirAll(parent, 0o700); err != nil {
			return err
		}
		if err := os.Chmod(parent, 0o700); err != nil {
			return err
		}
	} else if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("Local instance registry directory is unsafe")
	}
	info, err := os.Lstat(parent)
	stat, ok := infoSyscall(info)
	if err != nil || !ok || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0o700 || stat.Uid != expectedOwnerUID {
		return errors.New("Local instance registry directory is unsafe")
	}
	return nil
}

func infoSyscall(info os.FileInfo) (*syscall.Stat_t, bool) {
	if info == nil {
		return nil, false
	}
	value, ok := info.Sys().(*syscall.Stat_t)
	return value, ok
}
