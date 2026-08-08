package store

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"fased-lifecycled/bundle"
	"fased-lifecycled/model"
)

const (
	generationInventoryName = "inventory.json"
	generationPayloadName   = "payload"
)

func (s *Store) StageGeneration(generationID string) error {
	if err := validateGenerationID(generationID); err != nil {
		return err
	}
	target := s.generationPath(generationID)
	if _, err := os.Lstat(target); err == nil {
		_, verifyErr := s.verifyGenerationPath(target, generationID)
		return verifyErr
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	inbox := s.inboxGenerationPath(generationID)
	if _, err := s.verifyGenerationPath(inbox, generationID); err != nil {
		return fmt.Errorf("inbox generation verification failed: %w", err)
	}
	generationsRoot := filepath.Join(s.root, "generations")
	if err := os.MkdirAll(generationsRoot, 0o700); err != nil {
		return err
	}
	if err := os.Rename(inbox, target); err != nil {
		return err
	}
	return syncDirectory(generationsRoot)
}

func (s *Store) ActivateGeneration(currentID, previousID string) error {
	if _, err := s.verifiedGeneration(currentID); err != nil {
		return fmt.Errorf("current generation: %w", err)
	}
	if previousID != "" {
		if currentID == previousID {
			return errors.New("current and previous generation must differ")
		}
		if _, err := s.verifiedGeneration(previousID); err != nil {
			return fmt.Errorf("previous generation: %w", err)
		}
		if err := s.writeGenerationPointer("previous", previousID); err != nil {
			return err
		}
	}
	return s.writeGenerationPointer("current", currentID)
}

func (s *Store) ResolveGeneration(pointer string) (model.Generation, error) {
	if pointer != "current" && pointer != "previous" {
		return model.Generation{}, errors.New("generation pointer must be current or previous")
	}
	pointerPath := filepath.Join(s.root, pointer)
	info, err := os.Lstat(pointerPath)
	if err != nil {
		return model.Generation{}, err
	}
	if info.Mode()&os.ModeSymlink == 0 {
		return model.Generation{}, errors.New("generation pointer must be a symbolic link")
	}
	target, err := os.Readlink(pointerPath)
	if err != nil {
		return model.Generation{}, err
	}
	prefix := "generations/"
	if !strings.HasPrefix(target, prefix) || strings.Contains(strings.TrimPrefix(target, prefix), "/") {
		return model.Generation{}, errors.New("generation pointer has an unsafe target")
	}
	generationID := "sha256:" + strings.TrimPrefix(target, prefix)
	return s.verifiedGeneration(generationID)
}

func (s *Store) verifiedGeneration(generationID string) (model.Generation, error) {
	if err := validateGenerationID(generationID); err != nil {
		return model.Generation{}, err
	}
	return s.verifyGenerationPath(s.generationPath(generationID), generationID)
}

func (s *Store) verifyGenerationPath(root, generationID string) (model.Generation, error) {
	inventoryJSON, err := readRegular(filepath.Join(root, generationInventoryName))
	if err != nil {
		return model.Generation{}, err
	}
	inventory, err := bundle.DecodeInventory(inventoryJSON)
	if err != nil {
		return model.Generation{}, err
	}
	generation, err := bundle.Identity(inventory)
	if err != nil {
		return model.Generation{}, err
	}
	if generation.ID != generationID {
		return model.Generation{}, errors.New("generation directory and inventory identity differ")
	}
	if err := bundle.Verify(filepath.Join(root, generationPayloadName), inventory, generation); err != nil {
		return model.Generation{}, err
	}
	return generation, nil
}

func (s *Store) writeGenerationPointer(pointer, generationID string) error {
	if pointer != "current" && pointer != "previous" {
		return errors.New("generation pointer must be current or previous")
	}
	if err := validateGenerationID(generationID); err != nil {
		return err
	}
	temp, err := os.CreateTemp(s.root, ".pointer-*")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	if err := temp.Close(); err != nil {
		return err
	}
	if err := os.Remove(tempPath); err != nil {
		return err
	}
	defer os.Remove(tempPath)
	target := filepath.ToSlash(filepath.Join("generations", strings.TrimPrefix(generationID, "sha256:")))
	if err := os.Symlink(target, tempPath); err != nil {
		return err
	}
	if err := os.Rename(tempPath, filepath.Join(s.root, pointer)); err != nil {
		return err
	}
	return syncDirectory(s.root)
}

func (s *Store) inboxGenerationPath(generationID string) string {
	return filepath.Join(s.root, "inbox", strings.TrimPrefix(generationID, "sha256:"))
}

func (s *Store) generationPath(generationID string) string {
	return filepath.Join(s.root, "generations", strings.TrimPrefix(generationID, "sha256:"))
}

func validateGenerationID(generationID string) error {
	hex := strings.TrimPrefix(generationID, "sha256:")
	if len(hex) != 64 || "sha256:"+hex != generationID {
		return errors.New("generation id must be a lowercase sha256 digest")
	}
	for _, char := range hex {
		if !strings.ContainsRune("0123456789abcdef", char) {
			return errors.New("generation id must be a lowercase sha256 digest")
		}
	}
	return nil
}

func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}
