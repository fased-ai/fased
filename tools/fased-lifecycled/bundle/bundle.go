// Package bundle inventories and verifies immutable generation contents.
package bundle

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"fased-lifecycled/model"
)

const CurrentInventorySchemaVersion uint32 = 3

const LegacyInventorySchemaVersion uint32 = 2

const (
	ArtifactFile    = "file"
	ArtifactSymlink = "symlink"
)

type Artifact struct {
	Path       string `json:"path"`
	Kind       string `json:"kind"`
	SHA256     string `json:"sha256"`
	Size       int64  `json:"size"`
	Executable bool   `json:"executable"`
	LinkTarget string `json:"linkTarget,omitempty"`
}

type Inventory struct {
	SchemaVersion uint32                 `json:"schemaVersion"`
	Version       string                 `json:"version"`
	Commit        string                 `json:"commit"`
	Tree          string                 `json:"tree"`
	StateSchemas  map[string]uint32      `json:"stateSchemas"`
	Capabilities  model.CapabilityRanges `json:"capabilities"`
	Dependency    *DependencyLayer       `json:"dependency,omitempty"`
	Artifacts     []Artifact             `json:"artifacts"`
}

type DependencyLayer struct {
	Hash          string `json:"hash"`
	Asset         string `json:"asset"`
	ArchiveSHA256 string `json:"archiveSHA256"`
}

func Inspect(root, version, commit, tree string, stateSchemas map[string]uint32, capabilities model.CapabilityRanges) (Inventory, model.Generation, error) {
	return inspectInventory(root, version, commit, tree, stateSchemas, capabilities, nil)
}

func InspectWithDependency(root, version, commit, tree string, stateSchemas map[string]uint32, capabilities model.CapabilityRanges, dependency DependencyLayer) (Inventory, model.Generation, error) {
	return inspectInventory(root, version, commit, tree, stateSchemas, capabilities, &dependency)
}

func inspectInventory(root, version, commit, tree string, stateSchemas map[string]uint32, capabilities model.CapabilityRanges, dependency *DependencyLayer) (Inventory, model.Generation, error) {
	clean, err := secureRoot(root)
	if err != nil {
		return Inventory{}, model.Generation{}, err
	}
	schemaVersion := LegacyInventorySchemaVersion
	if dependency != nil {
		schemaVersion = CurrentInventorySchemaVersion
	}
	inventory := Inventory{
		SchemaVersion: schemaVersion,
		Version:       version,
		Commit:        commit,
		Tree:          tree,
		StateSchemas:  stateSchemas,
		Capabilities:  capabilities,
		Dependency:    dependency,
	}
	err = filepath.WalkDir(clean, func(filePath string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if filePath == clean {
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			relative, err := filepath.Rel(clean, filePath)
			if err != nil {
				return err
			}
			target, err := safeSymlink(clean, filePath)
			if err != nil {
				return err
			}
			inventory.Artifacts = append(inventory.Artifacts, Artifact{
				Path:       filepath.ToSlash(relative),
				Kind:       ArtifactSymlink,
				SHA256:     hashBytes([]byte(target)),
				Size:       int64(len(target)),
				LinkTarget: filepath.ToSlash(target),
			})
			return nil
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("generation artifact %q is not a regular file", filePath)
		}
		relative, err := filepath.Rel(clean, filePath)
		if err != nil {
			return err
		}
		digest, err := hashFile(filePath)
		if err != nil {
			return err
		}
		inventory.Artifacts = append(inventory.Artifacts, Artifact{
			Path:       filepath.ToSlash(relative),
			Kind:       ArtifactFile,
			SHA256:     digest,
			Size:       info.Size(),
			Executable: info.Mode().Perm()&0o111 != 0,
		})
		return nil
	})
	if err != nil {
		return Inventory{}, model.Generation{}, err
	}
	sort.Slice(inventory.Artifacts, func(left, right int) bool {
		return inventory.Artifacts[left].Path < inventory.Artifacts[right].Path
	})
	generation, err := identity(inventory)
	if err != nil {
		return Inventory{}, model.Generation{}, err
	}
	return inventory, generation, nil
}

func Verify(root string, expected Inventory, generation model.Generation) error {
	if err := validateInventory(expected); err != nil {
		return err
	}
	bound, err := identity(expected)
	if err != nil {
		return err
	}
	if bound != generation {
		return errors.New("generation identity does not match the declared artifact inventory")
	}
	actual, actualGeneration, err := inspectInventory(root, expected.Version, expected.Commit, expected.Tree, expected.StateSchemas, expected.Capabilities, expected.Dependency)
	if err != nil {
		return err
	}
	if actualGeneration != generation || !sameInventory(actual, expected) {
		return inventoryMismatch(expected, actual)
	}
	return nil
}

func Identity(inventory Inventory) (model.Generation, error) {
	return identity(inventory)
}

func CanonicalInventoryJSON(inventory Inventory) ([]byte, error) {
	if err := validateInventory(inventory); err != nil {
		return nil, err
	}
	return json.Marshal(inventory)
}

func DecodeInventory(data []byte) (Inventory, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var inventory Inventory
	if err := decoder.Decode(&inventory); err != nil {
		return Inventory{}, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return Inventory{}, errors.New("unexpected trailing inventory JSON")
		}
		return Inventory{}, err
	}
	if err := validateInventory(inventory); err != nil {
		return Inventory{}, err
	}
	return inventory, nil
}

func identity(inventory Inventory) (model.Generation, error) {
	if err := validateInventory(inventory); err != nil {
		return model.Generation{}, err
	}
	data, err := json.Marshal(inventory)
	if err != nil {
		return model.Generation{}, err
	}
	sum := sha256.Sum256(data)
	digest := fmt.Sprintf("sha256:%x", sum)
	generation := model.Generation{
		ID:                digest,
		Version:           inventory.Version,
		Commit:            inventory.Commit,
		Tree:              inventory.Tree,
		ArtifactSetDigest: digest,
	}
	if err := generation.Validate(); err != nil {
		return model.Generation{}, err
	}
	return generation, nil
}

func validateInventory(inventory Inventory) error {
	if inventory.SchemaVersion > CurrentInventorySchemaVersion {
		return errors.New("artifact inventory schema is newer than supported")
	}
	if inventory.SchemaVersion != LegacyInventorySchemaVersion && inventory.SchemaVersion != CurrentInventorySchemaVersion {
		return errors.New("unsupported artifact inventory schema")
	}
	if inventory.SchemaVersion == LegacyInventorySchemaVersion && inventory.Dependency != nil {
		return errors.New("legacy artifact inventory must not declare a dependency layer")
	}
	if inventory.SchemaVersion == CurrentInventorySchemaVersion {
		if inventory.Dependency == nil || !validDependency(*inventory.Dependency) {
			return errors.New("artifact inventory dependency layer is invalid")
		}
	}
	if len(inventory.Artifacts) == 0 {
		return errors.New("artifact inventory must not be empty")
	}
	if len(inventory.StateSchemas) == 0 {
		return errors.New("artifact inventory state schemas must not be empty")
	}
	for name, version := range inventory.StateSchemas {
		if name == "" || version == 0 {
			return errors.New("artifact inventory state schemas require nonempty names and nonzero versions")
		}
	}
	if err := inventory.Capabilities.Validate(); err != nil {
		return err
	}
	previous := ""
	for _, artifact := range inventory.Artifacts {
		if artifact.Path == "" || strings.HasPrefix(artifact.Path, "/") || path.Clean(artifact.Path) != artifact.Path || artifact.Path == ".." || strings.HasPrefix(artifact.Path, "../") {
			return fmt.Errorf("unsafe artifact path %q", artifact.Path)
		}
		if strings.Contains(artifact.Path, `\`) {
			return fmt.Errorf("artifact path must use forward slashes: %q", artifact.Path)
		}
		if artifact.Path <= previous {
			return errors.New("artifact inventory paths must be unique and sorted")
		}
		if !validDigest(artifact.SHA256) || artifact.Size < 0 {
			return fmt.Errorf("invalid artifact identity for %q", artifact.Path)
		}
		switch artifact.Kind {
		case ArtifactFile:
			if artifact.LinkTarget != "" {
				return fmt.Errorf("regular artifact %q declares a link target", artifact.Path)
			}
		case ArtifactSymlink:
			resolved := path.Clean(path.Join(path.Dir(artifact.Path), artifact.LinkTarget))
			if artifact.LinkTarget == "" || path.IsAbs(artifact.LinkTarget) || strings.Contains(artifact.LinkTarget, `\`) || resolved == ".." || strings.HasPrefix(resolved, "../") || artifact.Executable || artifact.Size != int64(len(artifact.LinkTarget)) || artifact.SHA256 != hashBytes([]byte(artifact.LinkTarget)) {
				return fmt.Errorf("unsafe symbolic-link artifact %q", artifact.Path)
			}
		default:
			return fmt.Errorf("unsupported artifact kind %q", artifact.Kind)
		}
		previous = artifact.Path
	}
	probe := model.Generation{
		ID:                "sha256:0000000000000000000000000000000000000000000000000000000000000000",
		Version:           inventory.Version,
		Commit:            inventory.Commit,
		Tree:              inventory.Tree,
		ArtifactSetDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
	}
	return probe.Validate()
}

func validDependency(layer DependencyLayer) bool {
	if len(layer.Hash) != 64 || !validDigest(layer.ArchiveSHA256) || layer.Asset == "" || len(layer.Asset) > 256 || path.Base(layer.Asset) != layer.Asset {
		return false
	}
	for _, char := range layer.Hash {
		if !strings.ContainsRune("0123456789abcdef", char) {
			return false
		}
	}
	for _, char := range layer.Asset {
		if !(char >= 'a' && char <= 'z') && !(char >= 'A' && char <= 'Z') && !(char >= '0' && char <= '9') && !strings.ContainsRune("._+-", char) {
			return false
		}
	}
	return true
}

func secureRoot(root string) (string, error) {
	if !filepath.IsAbs(root) {
		return "", errors.New("generation root must be absolute")
	}
	clean := filepath.Clean(root)
	resolved, err := filepath.EvalSymlinks(clean)
	if err != nil {
		return "", err
	}
	if resolved != clean {
		return "", errors.New("generation root must not contain symlinks")
	}
	return clean, nil
}

func hashFile(filePath string) (string, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return fmt.Sprintf("sha256:%x", hash.Sum(nil)), nil
}

func hashBytes(value []byte) string {
	sum := sha256.Sum256(value)
	return fmt.Sprintf("sha256:%x", sum)
}

func safeSymlink(root, filePath string) (string, error) {
	target, err := os.Readlink(filePath)
	if err != nil {
		return "", err
	}
	if filepath.IsAbs(target) || strings.Contains(target, `\`) {
		return "", fmt.Errorf("generation contains unsafe symlink %q", filePath)
	}
	lexical := filepath.Clean(filepath.Join(filepath.Dir(filePath), target))
	if !insideRoot(root, lexical) {
		return "", fmt.Errorf("generation symlink %q escapes the generation", filePath)
	}
	resolved, err := filepath.EvalSymlinks(filePath)
	if err != nil {
		return "", fmt.Errorf("generation contains dangling or cyclic symlink %q: %w", filePath, err)
	}
	if !insideRoot(root, resolved) {
		return "", fmt.Errorf("generation symlink %q resolves outside the generation", filePath)
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() && !info.IsDir() {
		return "", fmt.Errorf("generation symlink %q targets an unsupported entry", filePath)
	}
	return target, nil
}

func insideRoot(root, candidate string) bool {
	relative, err := filepath.Rel(root, candidate)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

func validDigest(value string) bool {
	if len(value) != len("sha256:")+64 || !strings.HasPrefix(value, "sha256:") {
		return false
	}
	for _, char := range value[len("sha256:"):] {
		if !strings.ContainsRune("0123456789abcdef", char) {
			return false
		}
	}
	return true
}

func sameInventory(left, right Inventory) bool {
	leftJSON, leftErr := json.Marshal(left)
	rightJSON, rightErr := json.Marshal(right)
	return leftErr == nil && rightErr == nil && string(leftJSON) == string(rightJSON)
}

func inventoryMismatch(expected, actual Inventory) error {
	if len(expected.Artifacts) != len(actual.Artifacts) {
		return fmt.Errorf("generation contents do not match the declared artifact inventory: artifact count is %d, expected %d", len(actual.Artifacts), len(expected.Artifacts))
	}
	for index := range expected.Artifacts {
		if expected.Artifacts[index] != actual.Artifacts[index] {
			return fmt.Errorf(
				"generation contents do not match the declared artifact inventory: artifact identity differs at %q (actual kind=%s sha256=%s size=%d executable=%t; expected kind=%s sha256=%s size=%d executable=%t)",
				expected.Artifacts[index].Path,
				actual.Artifacts[index].Kind,
				actual.Artifacts[index].SHA256,
				actual.Artifacts[index].Size,
				actual.Artifacts[index].Executable,
				expected.Artifacts[index].Kind,
				expected.Artifacts[index].SHA256,
				expected.Artifacts[index].Size,
				expected.Artifacts[index].Executable,
			)
		}
	}
	expected.Artifacts = nil
	actual.Artifacts = nil
	if !sameInventory(expected, actual) {
		return errors.New("generation contents do not match the declared artifact inventory: generation contract differs")
	}
	return errors.New("generation contents do not match the declared artifact inventory")
}
