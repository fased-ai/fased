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

const CurrentInventorySchemaVersion uint32 = 1

type Artifact struct {
	Path       string `json:"path"`
	SHA256     string `json:"sha256"`
	Size       int64  `json:"size"`
	Executable bool   `json:"executable"`
}

type Inventory struct {
	SchemaVersion uint32     `json:"schemaVersion"`
	Version       string     `json:"version"`
	Commit        string     `json:"commit"`
	Tree          string     `json:"tree"`
	Artifacts     []Artifact `json:"artifacts"`
}

func Inspect(root, version, commit, tree string) (Inventory, model.Generation, error) {
	clean, err := secureRoot(root)
	if err != nil {
		return Inventory{}, model.Generation{}, err
	}
	inventory := Inventory{SchemaVersion: CurrentInventorySchemaVersion, Version: version, Commit: commit, Tree: tree}
	err = filepath.WalkDir(clean, func(filePath string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if filePath == clean {
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("generation contains symlink %q", filePath)
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
	actual, actualGeneration, err := Inspect(root, expected.Version, expected.Commit, expected.Tree)
	if err != nil {
		return err
	}
	if actualGeneration != generation || !sameInventory(actual, expected) {
		return errors.New("generation contents do not match the declared artifact inventory")
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
	if inventory.SchemaVersion != CurrentInventorySchemaVersion {
		return errors.New("unsupported artifact inventory schema")
	}
	if len(inventory.Artifacts) == 0 {
		return errors.New("artifact inventory must not be empty")
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
