package store

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"fased-lifecycled/bundle"
	"fased-lifecycled/model"
)

// ImportGeneration copies one already complete external generation into the
// root-owned inbox and verifies the copied bytes before exposing them to the
// supervisor. The caller supplies no version selector: identity comes only
// from the inventory and payload.
func (s *Store) ImportGeneration(source string) (model.Generation, error) {
	if !filepath.IsAbs(source) || filepath.Clean(source) != source {
		return model.Generation{}, errors.New("generation import source must be absolute and clean")
	}
	inventoryJSON, err := readGenerationInventory(filepath.Join(source, generationInventoryName))
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
	if err := bundle.Verify(filepath.Join(source, generationPayloadName), inventory, generation); err != nil {
		return model.Generation{}, fmt.Errorf("generation import verification failed: %w", err)
	}
	inboxRoot := filepath.Join(s.root, "inbox")
	if err := os.MkdirAll(inboxRoot, 0o700); err != nil {
		return model.Generation{}, err
	}
	destination := s.inboxGenerationPath(generation.ID)
	if _, err := os.Lstat(destination); err == nil {
		if _, verifyErr := s.verifyGenerationPath(destination, generation.ID); verifyErr != nil {
			return model.Generation{}, errors.New("existing inbox generation conflicts with verified source")
		}
		return generation, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return model.Generation{}, err
	}
	temporary, err := os.MkdirTemp(inboxRoot, ".import-*")
	if err != nil {
		return model.Generation{}, err
	}
	defer os.RemoveAll(temporary)
	if err := copyRegularTree(source, temporary); err != nil {
		return model.Generation{}, err
	}
	if _, err := s.verifyGenerationPath(temporary, generation.ID); err != nil {
		return model.Generation{}, fmt.Errorf("copied generation verification failed: %w", err)
	}
	if err := os.Rename(temporary, destination); err != nil {
		return model.Generation{}, err
	}
	if err := syncDirectory(inboxRoot); err != nil {
		return model.Generation{}, err
	}
	return generation, nil
}

func copyRegularTree(source, destination string) error {
	return filepath.WalkDir(source, func(current string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(source, current)
		if err != nil {
			return err
		}
		if relative == "." {
			return os.Chmod(destination, 0o711)
		}
		target := filepath.Join(destination, relative)
		inPayload := relative == generationPayloadName || strings.HasPrefix(relative, generationPayloadName+string(filepath.Separator))
		if entry.Type()&os.ModeSymlink != 0 {
			link, err := os.Readlink(current)
			if err != nil {
				return err
			}
			if filepath.IsAbs(link) || strings.Contains(link, `\`) {
				return fmt.Errorf("generation import contains unsafe symlink %q", relative)
			}
			lexical := filepath.Clean(filepath.Join(filepath.Dir(current), link))
			relativeTarget, err := filepath.Rel(source, lexical)
			if err != nil || relativeTarget == ".." || strings.HasPrefix(relativeTarget, ".."+string(filepath.Separator)) {
				return fmt.Errorf("generation import symlink %q escapes the source", relative)
			}
			return os.Symlink(link, target)
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if entry.IsDir() {
			mode := os.FileMode(0o700)
			if inPayload {
				mode = 0o755
			}
			if err := os.Mkdir(target, mode); err != nil {
				return err
			}
			return os.Chmod(target, mode)
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("generation import contains unsupported entry %q", relative)
		}
		input, err := os.Open(current)
		if err != nil {
			return err
		}
		mode := os.FileMode(0o600)
		if inPayload {
			mode = 0o644
		}
		if info.Mode().Perm()&0o111 != 0 {
			if inPayload {
				mode = 0o755
			} else {
				mode = 0o700
			}
		}
		output, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
		if err != nil {
			input.Close()
			return err
		}
		if err := output.Chmod(mode); err != nil {
			input.Close()
			output.Close()
			return err
		}
		_, copyErr := io.Copy(output, io.LimitReader(input, info.Size()+1))
		closeInputErr := input.Close()
		syncErr := output.Sync()
		closeOutputErr := output.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeInputErr != nil {
			return closeInputErr
		}
		if syncErr != nil {
			return syncErr
		}
		return closeOutputErr
	})
}

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
	if err := os.MkdirAll(generationsRoot, 0o711); err != nil {
		return err
	}
	if err := os.Chmod(generationsRoot, 0o711); err != nil {
		return err
	}
	if err := os.Rename(inbox, target); err != nil {
		return err
	}
	return syncDirectory(generationsRoot)
}

func (s *Store) ActivateGeneration(currentID, previousID string) error {
	return s.activatePointers("current", "previous", currentID, previousID)
}

func (s *Store) ActivateControllerGeneration(currentID, previousID string) error {
	return s.activatePointers("controller-current", "controller-previous", currentID, previousID)
}

func (s *Store) activatePointers(currentPointer, previousPointer, currentID, previousID string) error {
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
		if err := s.writeGenerationPointer(previousPointer, previousID); err != nil {
			return err
		}
	}
	return s.writeGenerationPointer(currentPointer, currentID)
}

func (s *Store) ResolveGeneration(pointer string) (model.Generation, error) {
	if !validPointer(pointer) {
		return model.Generation{}, errors.New("generation pointer is invalid")
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

func (s *Store) ReadGenerationContract(generationID string) (bundle.Inventory, model.Generation, error) {
	if err := validateGenerationID(generationID); err != nil {
		return bundle.Inventory{}, model.Generation{}, err
	}
	root := s.generationPath(generationID)
	inventoryJSON, err := readGenerationInventory(filepath.Join(root, generationInventoryName))
	if err != nil {
		return bundle.Inventory{}, model.Generation{}, err
	}
	inventory, err := bundle.DecodeInventory(inventoryJSON)
	if err != nil {
		return bundle.Inventory{}, model.Generation{}, err
	}
	generation, err := s.verifyGenerationPath(root, generationID)
	if err != nil {
		return bundle.Inventory{}, model.Generation{}, err
	}
	return inventory, generation, nil
}

func (s *Store) GenerationPayloadPath(generationID string) (string, error) {
	if _, err := s.verifiedGeneration(generationID); err != nil {
		return "", err
	}
	return filepath.Join(s.generationPath(generationID), generationPayloadName), nil
}

func (s *Store) verifiedGeneration(generationID string) (model.Generation, error) {
	if err := validateGenerationID(generationID); err != nil {
		return model.Generation{}, err
	}
	return s.verifyGenerationPath(s.generationPath(generationID), generationID)
}

func (s *Store) verifyGenerationPath(root, generationID string) (model.Generation, error) {
	inventoryJSON, err := readGenerationInventory(filepath.Join(root, generationInventoryName))
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
	if !validPointer(pointer) {
		return errors.New("generation pointer is invalid")
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

func validPointer(pointer string) bool {
	switch pointer {
	case "current", "previous", "controller-current", "controller-previous":
		return true
	default:
		return false
	}
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
