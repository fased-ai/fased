// Package statebind inventories the fixed, adapter-owned product state roots.
package statebind

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"

	"fased-lifecycled/bundle"
	"fased-lifecycled/planner"
)

const defaultMaxFiles = 100000
const defaultMaxBytes int64 = 32 << 30

type Spec struct {
	Name                  string
	Path                  string
	MaxFiles              int
	MaxBytes              int64
	RootOnly              bool
	Optional              bool
	IgnoreSQLiteTransient bool
}

type Binder struct {
	Specs []Spec
}

type fileRecord struct {
	Path   string `json:"path"`
	Mode   uint32 `json:"mode"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256,omitempty"`
}

type stateRecord struct {
	Name    string       `json:"name"`
	Schema  uint32       `json:"schema"`
	Absent  bool         `json:"absent"`
	Entries []fileRecord `json:"entries"`
}

func CanonicalSpecs(ownerStateRoot, installRoot, signerStateRoot string) []Spec {
	owner := func(name, relative string) Spec {
		return Spec{Name: name, Path: filepath.Join(ownerStateRoot, relative), Optional: true}
	}
	return []Spec{
		owner("agents", "agents"), owner("channels", "channels"), owner("configuration", "fased.json"),
		owner("credentials", "credentials"), owner("cron", "cron"), owner("deliveryQueue", "delivery-queue"),
		owner("devices", "devices"), owner("federation", "federation"), owner("identity", "identity"),
		{Name: "managedInstall", Path: installRoot, RootOnly: true}, owner("memory", "memory"),
		{Name: "mining", Path: filepath.Join(ownerStateRoot, "sat-mining"), IgnoreSQLiteTransient: true},
		owner("pluginState", "extensions"), owner("schedules", "schedules"), owner("secrets", "secrets"),
		owner("sessions", "sessions"), {Name: "signer", Path: signerStateRoot, RootOnly: true},
		owner("tasks", "tasks"), owner("walletRegistry", "wallet"),
	}
}

func (binder *Binder) Bind(ctx context.Context, installed planner.Installation, inventory bundle.Inventory, plan planner.Plan) (string, string, error) {
	generation, err := bundle.Identity(inventory)
	if err != nil {
		return "", "", err
	}
	want, err := planner.BuildForInstallation(installed, planner.Target{
		Profile: plan.Profile, Generation: generation,
		StateSchemas: inventory.StateSchemas, Capabilities: inventory.Capabilities,
	})
	if err != nil {
		return "", "", err
	}
	wantJSON, _ := json.Marshal(want)
	gotJSON, _ := json.Marshal(plan)
	if string(wantJSON) != string(gotJSON) {
		return "", "", errors.New("state inventory plan is not the canonical compatibility plan")
	}
	specs, err := binder.validate(inventory.StateSchemas)
	if err != nil {
		return "", "", err
	}
	records := make([]stateRecord, 0, len(specs))
	allowAbsent := map[string]bool{}
	for _, migration := range plan.Migrations {
		if migration.From == 0 {
			allowAbsent[migration.State] = true
		}
	}
	for _, spec := range specs {
		if err := ctx.Err(); err != nil {
			return "", "", err
		}
		record, err := inspectState(ctx, spec, inventory.StateSchemas[spec.Name], spec.Optional || installed.Kind == planner.InstallationEmpty || allowAbsent[spec.Name])
		if err != nil {
			return "", "", fmt.Errorf("inventory state %s: %w", spec.Name, err)
		}
		records = append(records, record)
	}
	stateDigest, err := digestJSON(records)
	if err != nil {
		return "", "", err
	}
	signerBinding := struct {
		GenerationID string             `json:"generationId"`
		Inventory    string             `json:"stateInventoryDigest"`
		Migration    *planner.Migration `json:"migration,omitempty"`
	}{GenerationID: generation.ID, Inventory: stateDigest}
	for index := range plan.Migrations {
		if plan.Migrations[index].State == "signer" {
			signerBinding.Migration = &plan.Migrations[index]
			break
		}
	}
	signerDigest, err := digestJSON(signerBinding)
	return stateDigest, signerDigest, err
}

func (binder *Binder) validate(schemas map[string]uint32) ([]Spec, error) {
	if binder == nil || len(binder.Specs) != len(schemas) {
		return nil, errors.New("state binder must declare the exact target state set")
	}
	specs := append([]Spec(nil), binder.Specs...)
	sort.Slice(specs, func(left, right int) bool { return specs[left].Name < specs[right].Name })
	previous := ""
	for index := range specs {
		spec := &specs[index]
		if spec.Name == "" || spec.Name == previous || schemas[spec.Name] == 0 {
			return nil, errors.New("state binder contains an unknown or duplicate state")
		}
		if !filepath.IsAbs(spec.Path) || filepath.Clean(spec.Path) != spec.Path {
			return nil, fmt.Errorf("state %s path must be absolute and clean", spec.Name)
		}
		if spec.MaxFiles == 0 {
			spec.MaxFiles = defaultMaxFiles
		}
		if spec.MaxBytes == 0 {
			spec.MaxBytes = defaultMaxBytes
		}
		if spec.MaxFiles < 1 || spec.MaxBytes < 1 {
			return nil, fmt.Errorf("state %s inventory bounds are invalid", spec.Name)
		}
		previous = spec.Name
	}
	return specs, nil
}

func inspectState(ctx context.Context, spec Spec, schema uint32, allowAbsent bool) (stateRecord, error) {
	record := stateRecord{Name: spec.Name, Schema: schema}
	rootInfo, err := os.Lstat(spec.Path)
	if errors.Is(err, os.ErrNotExist) && allowAbsent {
		record.Absent = true
		return record, nil
	}
	if err != nil {
		return stateRecord{}, err
	}
	if rootInfo.Mode()&os.ModeSymlink != 0 {
		return stateRecord{}, errors.New("state root must not be a symlink")
	}
	resolved, err := filepath.EvalSymlinks(spec.Path)
	if err != nil || resolved != spec.Path {
		return stateRecord{}, errors.New("state root path must not traverse symlinks")
	}
	if spec.RootOnly {
		record.Entries = append(record.Entries, fileRecord{Path: ".", Mode: uint32(rootInfo.Mode().Perm()), Size: rootInfo.Size()})
		return record, nil
	}
	var total int64
	err = filepath.WalkDir(spec.Path, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if spec.IgnoreSQLiteTransient && entry.Type().IsRegular() && isSQLiteTransient(entry.Name()) {
			return nil
		}
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 || (!info.Mode().IsRegular() && !info.IsDir()) {
			return errors.New("state contains a symlink or special file")
		}
		relative, err := filepath.Rel(spec.Path, path)
		if err != nil {
			return err
		}
		recordEntry := fileRecord{Path: filepath.ToSlash(relative), Mode: uint32(info.Mode().Perm()), Size: info.Size()}
		if info.Mode().IsRegular() {
			total += info.Size()
			if total > spec.MaxBytes {
				return errors.New("state inventory byte limit exceeded")
			}
			digest, err := hashStableFile(path, info)
			if err != nil {
				return err
			}
			recordEntry.SHA256 = digest
		}
		record.Entries = append(record.Entries, recordEntry)
		if len(record.Entries) > spec.MaxFiles {
			return errors.New("state inventory file limit exceeded")
		}
		return nil
	})
	return record, err
}

func isSQLiteTransient(name string) bool {
	for _, suffix := range []string{"-wal", "-shm", "-journal", ".sqlite-wal", ".sqlite-shm", ".sqlite-journal"} {
		if strings.HasSuffix(name, suffix) {
			return true
		}
	}
	return false
}

func hashStableFile(path string, before os.FileInfo) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	after, err := file.Stat()
	if err != nil || !os.SameFile(before, after) || linkCount(after) != 1 {
		return "", errors.New("state file changed identity or has multiple links")
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	final, err := file.Stat()
	if err != nil || final.Size() != after.Size() || final.ModTime() != after.ModTime() {
		return "", errors.New("state file changed while inventorying")
	}
	return fmt.Sprintf("sha256:%x", hash.Sum(nil)), nil
}

func linkCount(info os.FileInfo) uint64 {
	if stat, ok := info.Sys().(*syscall.Stat_t); ok {
		return uint64(stat.Nlink)
	}
	return 0
}

func digestJSON(value any) (string, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(data)
	return fmt.Sprintf("sha256:%x", digest), nil
}
