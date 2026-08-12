package store

import (
	"archive/tar"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
	"syscall"

	"fased-lifecycled/bundle"
	"fased-lifecycled/model"
)

const (
	maxGenerationArchiveEntries = 50_000
	maxGenerationArchiveBytes   = 600 * 1024 * 1024
)

// ImportGenerationArchive expands one verified transport archive directly
// into the root-owned inbox. This avoids copying and hashing the complete
// runtime through an unprivileged extraction tree before the same bytes are
// verified again. The inventory remains the authority for every extracted
// byte and the generation is not exposed until verification succeeds.
func (s *Store) ImportGenerationArchive(archive string) (model.Generation, error) {
	if !filepath.IsAbs(archive) || filepath.Clean(archive) != archive {
		return model.Generation{}, errors.New("generation archive path must be absolute and clean")
	}
	archiveInfo, err := os.Lstat(archive)
	if err != nil {
		return model.Generation{}, err
	}
	if !archiveInfo.Mode().IsRegular() || archiveInfo.Mode()&os.ModeSymlink != 0 {
		return model.Generation{}, errors.New("generation archive must be a regular file")
	}
	inventoryJSON, err := readGenerationArchiveInventory(archive)
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
	if s.declaredActiveGeneration(generation) {
		return generation, nil
	}
	installed := s.generationPath(generation.ID)
	if _, err := os.Lstat(installed); err == nil {
		if _, verifyErr := s.verifyGenerationPath(installed, generation.ID); verifyErr != nil {
			return model.Generation{}, errors.New("installed generation conflicts with verified archive identity")
		}
		return generation, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return model.Generation{}, err
	}
	inboxRoot := filepath.Join(s.installRoot, "inbox")
	if err := os.MkdirAll(inboxRoot, 0o700); err != nil {
		return model.Generation{}, err
	}
	if err := os.Chmod(inboxRoot, 0o700); err != nil {
		return model.Generation{}, err
	}
	temporary, err := os.MkdirTemp(inboxRoot, ".archive-*")
	if err != nil {
		return model.Generation{}, err
	}
	defer os.RemoveAll(temporary)
	if err := os.Chmod(temporary, 0o700); err != nil {
		return model.Generation{}, err
	}
	if err := extractGenerationArchive(archive, temporary); err != nil {
		return model.Generation{}, err
	}
	if _, err := s.verifyGenerationPath(temporary, generation.ID); err != nil {
		return model.Generation{}, fmt.Errorf("extracted generation verification failed: %w", err)
	}
	destination := s.inboxGenerationPath(generation.ID)
	if _, err := os.Lstat(destination); err == nil {
		if _, verifyErr := s.verifyGenerationPath(destination, generation.ID); verifyErr != nil {
			return model.Generation{}, errors.New("existing inbox generation conflicts with verified archive")
		}
		return generation, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return model.Generation{}, err
	}
	if err := os.Rename(temporary, destination); err != nil {
		return model.Generation{}, err
	}
	if err := syncDirectory(inboxRoot); err != nil {
		return model.Generation{}, err
	}
	return generation, nil
}

func (s *Store) declaredActiveGeneration(generation model.Generation) bool {
	manifest, _, err := s.ReadManifest()
	if err != nil || manifest.ActiveGeneration == nil || *manifest.ActiveGeneration != generation {
		return false
	}
	pointer := filepath.Join(s.installRoot, "current")
	pointerInfo, err := os.Lstat(pointer)
	if err != nil || pointerInfo.Mode()&os.ModeSymlink == 0 {
		return false
	}
	target, err := os.Readlink(pointer)
	if err != nil || target != filepath.ToSlash(filepath.Join("generations", strings.TrimPrefix(generation.ID, "sha256:"))) {
		return false
	}
	rootInfo, err := os.Lstat(s.installRoot)
	if err != nil {
		return false
	}
	rootStat, rootOK := rootInfo.Sys().(*syscall.Stat_t)
	installedInfo, err := os.Lstat(s.generationPath(generation.ID))
	if err != nil {
		return false
	}
	installedStat, installedOK := installedInfo.Sys().(*syscall.Stat_t)
	return rootOK && installedOK && installedInfo.IsDir() &&
		installedInfo.Mode()&os.ModeSymlink == 0 && installedInfo.Mode().Perm()&0o022 == 0 &&
		installedStat.Uid == rootStat.Uid
}

func readGenerationArchiveInventory(archive string) ([]byte, error) {
	input, err := os.Open(archive)
	if err != nil {
		return nil, err
	}
	defer input.Close()
	compressed, err := gzip.NewReader(input)
	if err != nil {
		return nil, err
	}
	defer compressed.Close()
	reader := tar.NewReader(compressed)
	entries := 0
	var total int64
	for {
		header, nextErr := reader.Next()
		if errors.Is(nextErr, io.EOF) {
			break
		}
		if nextErr != nil {
			return nil, nextErr
		}
		entries++
		total += header.Size
		if entries > maxGenerationArchiveEntries || total > maxGenerationArchiveBytes || header.Size < 0 {
			return nil, errors.New("generation archive exceeds its inspection budget")
		}
		if header.Name != "generation/inventory.json" {
			continue
		}
		if header.Typeflag != tar.TypeReg || header.Size > maxGenerationInventorySize {
			return nil, errors.New("generation archive inventory is invalid")
		}
		inventory := make([]byte, header.Size)
		if _, err := io.ReadFull(reader, inventory); err != nil {
			return nil, err
		}
		return inventory, nil
	}
	return nil, errors.New("generation archive inventory is missing")
}

func extractGenerationArchive(archive, destination string) error {
	if err := os.Chmod(destination, 0o711); err != nil {
		return err
	}
	extractionRoot, err := os.OpenRoot(destination)
	if err != nil {
		return err
	}
	defer extractionRoot.Close()

	input, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer input.Close()
	compressed, err := gzip.NewReader(input)
	if err != nil {
		return err
	}
	defer compressed.Close()
	reader := tar.NewReader(compressed)
	entries := 0
	var total int64
	seen := make(map[string]struct{})
	for {
		header, nextErr := reader.Next()
		if errors.Is(nextErr, io.EOF) {
			break
		}
		if nextErr != nil {
			return nextErr
		}
		entries++
		total += header.Size
		if entries > maxGenerationArchiveEntries || total > maxGenerationArchiveBytes || header.Size < 0 {
			return errors.New("generation archive exceeds its extraction budget")
		}
		name := strings.TrimSuffix(header.Name, "/")
		clean := path.Clean(name)
		if clean != name || strings.Contains(name, `\`) || (clean != "generation" && !strings.HasPrefix(clean, "generation/")) {
			return fmt.Errorf("generation archive contains unsafe entry %q", header.Name)
		}
		if clean == "generation" {
			if header.Typeflag != tar.TypeDir {
				return errors.New("generation archive root must be a directory")
			}
			continue
		}
		relative := strings.TrimPrefix(clean, "generation/")
		if _, duplicate := seen[relative]; duplicate {
			return fmt.Errorf("generation archive contains duplicate entry %q", relative)
		}
		seen[relative] = struct{}{}
		target := filepath.FromSlash(relative)
		if err := ensureArchiveParent(extractionRoot, filepath.Dir(target)); err != nil {
			return err
		}
		inPayload := relative == generationPayloadName || strings.HasPrefix(relative, generationPayloadName+"/")
		switch header.Typeflag {
		case tar.TypeDir:
			mode := os.FileMode(0o700)
			if inPayload {
				mode = 0o755
			}
			if err := extractionRoot.Mkdir(target, mode); err != nil {
				return err
			}
			if err := extractionRoot.Chmod(target, mode); err != nil {
				return err
			}
		case tar.TypeReg, tar.TypeRegA:
			mode := os.FileMode(0o600)
			if relative == generationInventoryName {
				mode = 0o644
			}
			if inPayload {
				mode = 0o644
			}
			if header.Mode&0o111 != 0 {
				if inPayload {
					mode = 0o755
				} else {
					mode = 0o700
				}
			}
			output, openErr := extractionRoot.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
			if openErr != nil {
				return openErr
			}
			_, copyErr := io.CopyN(output, reader, header.Size)
			chmodErr := output.Chmod(mode)
			syncErr := output.Sync()
			closeErr := output.Close()
			if copyErr != nil {
				return copyErr
			}
			if chmodErr != nil {
				return chmodErr
			}
			if syncErr != nil {
				return syncErr
			}
			if closeErr != nil {
				return closeErr
			}
		case tar.TypeSymlink:
			link := header.Linkname
			if link == "" || path.IsAbs(link) || strings.Contains(link, `\`) {
				return fmt.Errorf("generation archive contains unsafe symlink %q", relative)
			}
			resolved := path.Clean(path.Join(path.Dir(relative), link))
			if resolved == "." || resolved == ".." || strings.HasPrefix(resolved, "../") {
				return fmt.Errorf("generation archive symlink %q escapes the generation", relative)
			}
			if err := extractionRoot.Symlink(filepath.FromSlash(link), target); err != nil {
				return err
			}
		default:
			return fmt.Errorf("generation archive contains unsupported entry %q", relative)
		}
	}
	return nil
}

func ensureArchiveParent(root *os.Root, parent string) error {
	if parent == "." {
		return nil
	}
	current := ""
	for _, component := range strings.Split(parent, string(filepath.Separator)) {
		current = filepath.Join(current, component)
		info, statErr := root.Lstat(current)
		if statErr != nil {
			return statErr
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return errors.New("generation archive parent is not a real directory")
		}
	}
	return nil
}

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
	inboxRoot := filepath.Join(s.installRoot, "inbox")
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
		if relative == generationInventoryName {
			mode = 0o644
		}
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
	dependency, err := s.GenerationDependency(generationID)
	if err != nil {
		return err
	}
	if dependency != nil {
		if _, err := s.resolveDependencyPath(*dependency); err != nil {
			return fmt.Errorf("generation dependency verification failed: %w", err)
		}
	}
	target := s.generationPath(generationID)
	if _, err := os.Lstat(target); err == nil {
		if manifest, _, manifestErr := s.ReadManifest(); manifestErr == nil &&
			manifest.ActiveGeneration != nil && manifest.ActiveGeneration.ID == generationID &&
			s.declaredActiveGeneration(*manifest.ActiveGeneration) {
			return s.ensureGenerationDependencyBinding(target, dependency)
		}
		if _, verifyErr := s.verifyGenerationPath(target, generationID); verifyErr != nil {
			return verifyErr
		}
		info, statErr := os.Lstat(target)
		if statErr != nil {
			return statErr
		}
		if info.Mode().Perm() == 0o711 {
			return s.ensureGenerationDependencyBinding(target, dependency)
		}
		if err := os.Chmod(target, 0o711); err != nil {
			return err
		}
		return s.ensureGenerationDependencyBinding(target, dependency)
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	inbox := s.inboxGenerationPath(generationID)
	if _, err := s.verifyGenerationPath(inbox, generationID); err != nil {
		return fmt.Errorf("inbox generation verification failed: %w", err)
	}
	if err := s.ensureGenerationDependencyBinding(inbox, dependency); err != nil {
		return err
	}
	generationsRoot := filepath.Join(s.installRoot, "generations")
	if err := os.MkdirAll(generationsRoot, 0o711); err != nil {
		return err
	}
	if err := os.Chmod(generationsRoot, 0o711); err != nil {
		return err
	}
	if err := os.Rename(inbox, target); err != nil {
		return err
	}
	if err := os.Chmod(target, 0o711); err != nil {
		_ = os.Rename(target, inbox)
		return err
	}
	return syncDirectory(generationsRoot)
}

// ensureGenerationDependencyBinding gives unprivileged CLI processes the same
// digest-bound dependency view that systemd services receive through
// BindReadOnlyPaths. The link is derived from the verified inventory and lives
// beside, rather than inside, the immutable payload covered by that inventory.
// A generation therefore selects exactly one dependency layer without copying
// node_modules into every application generation.
func (s *Store) ensureGenerationDependencyBinding(root string, dependency *bundle.DependencyLayer) error {
	path := filepath.Join(root, "node_modules")
	if dependency == nil {
		if _, err := os.Lstat(path); err == nil {
			return errors.New("legacy generation unexpectedly has a shared dependency binding")
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return nil
	}
	dependencyRoot, err := s.resolveDependencyPath(*dependency)
	if err != nil {
		return fmt.Errorf("generation dependency verification failed: %w", err)
	}
	expected := filepath.ToSlash(filepath.Join("..", "..", "dependencies", filepath.Base(dependencyRoot), "node_modules"))
	if info, err := os.Lstat(path); err == nil {
		if info.Mode()&os.ModeSymlink == 0 {
			return errors.New("generation dependency binding is not a symbolic link")
		}
		actual, err := os.Readlink(path)
		if err != nil {
			return err
		}
		if actual != expected {
			return errors.New("generation dependency binding does not match the verified inventory")
		}
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	temporary, err := os.CreateTemp(root, ".node-modules-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Remove(temporaryPath); err != nil {
		return err
	}
	defer os.Remove(temporaryPath)
	if err := os.Symlink(expected, temporaryPath); err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return err
	}
	return syncDirectory(root)
}

func (s *Store) ActivateGeneration(currentID, previousID string) error {
	return s.activatePointers("current", "previous", currentID, previousID)
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
	pointerPath := filepath.Join(s.installRoot, pointer)
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
	return s.readGenerationContractAt(s.generationPath(generationID), generationID)
}

// ReadCandidateContract verifies candidate identity without moving it from the
// acquisition inbox into the durable generation store. Compatibility planning
// must complete before the first mutation of an installation transaction.
func (s *Store) ReadCandidateContract(generationID string) (bundle.Inventory, model.Generation, error) {
	if err := validateGenerationID(generationID); err != nil {
		return bundle.Inventory{}, model.Generation{}, err
	}
	root := s.generationPath(generationID)
	if _, err := os.Lstat(root); errors.Is(err, os.ErrNotExist) {
		root = s.inboxGenerationPath(generationID)
	} else if err != nil {
		return bundle.Inventory{}, model.Generation{}, err
	}
	return s.readGenerationContractAt(root, generationID)
}

func (s *Store) readGenerationContractAt(root, generationID string) (bundle.Inventory, model.Generation, error) {
	if err := validateGenerationID(generationID); err != nil {
		return bundle.Inventory{}, model.Generation{}, err
	}
	inventoryJSON, err := readGenerationInventory(filepath.Join(root, generationInventoryName))
	if err != nil {
		return bundle.Inventory{}, model.Generation{}, err
	}
	inventory, err := bundle.DecodeInventory(inventoryJSON)
	if err != nil {
		return bundle.Inventory{}, model.Generation{}, err
	}
	generation, err := bundle.Identity(inventory)
	if err != nil || generation.ID != generationID {
		return bundle.Inventory{}, model.Generation{}, errors.New("generation directory and inventory identity differ")
	}
	if !s.declaredActiveGeneration(generation) {
		generation, err = s.verifyGenerationPath(root, generationID)
	}
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
	if pointer != "current" && pointer != "previous" {
		return errors.New("generation pointer is invalid")
	}
	if err := validateGenerationID(generationID); err != nil {
		return err
	}
	temp, err := os.CreateTemp(s.installRoot, ".pointer-*")
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
	if err := os.Rename(tempPath, filepath.Join(s.installRoot, pointer)); err != nil {
		return err
	}
	return syncDirectory(s.installRoot)
}

func validPointer(pointer string) bool {
	switch pointer {
	case "current", "previous":
		return true
	default:
		return false
	}
}

func (s *Store) inboxGenerationPath(generationID string) string {
	return filepath.Join(s.installRoot, "inbox", strings.TrimPrefix(generationID, "sha256:"))
}

func (s *Store) generationPath(generationID string) string {
	return filepath.Join(s.installRoot, "generations", strings.TrimPrefix(generationID, "sha256:"))
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
