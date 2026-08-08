// Package store persists lifecycle manifests and authority-scoped journals.
package store

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"fased-lifecycled/model"
)

const (
	manifestName  = "installation-manifest.json"
	maxRecordSize = 1 << 20
)

type Authority string

const (
	AuthoritySupervisor       Authority = "supervisor"
	AuthorityTargetController Authority = "target-controller"
)

type Store struct {
	root string
}

func Open(root string) (*Store, error) {
	if !filepath.IsAbs(root) {
		return nil, errors.New("lifecycle store root must be absolute")
	}
	clean := filepath.Clean(root)
	if err := os.MkdirAll(clean, 0o700); err != nil {
		return nil, err
	}
	resolved, err := filepath.EvalSymlinks(clean)
	if err != nil {
		return nil, err
	}
	if resolved != clean {
		return nil, errors.New("lifecycle store root must not contain symlinks")
	}
	return &Store{root: clean}, nil
}

func (s *Store) CommitManifest(manifest model.Manifest, expectedDigest string) (string, error) {
	data, err := model.CanonicalManifestJSON(manifest)
	if err != nil {
		return "", err
	}
	nextDigest := digest(data)
	path := filepath.Join(s.root, manifestName)
	_, currentDigest, err := s.ReadManifest()
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	if errors.Is(err, os.ErrNotExist) {
		if expectedDigest != "" {
			return "", errors.New("manifest compare-and-swap expected an existing record")
		}
	} else {
		if currentDigest != expectedDigest {
			return "", fmt.Errorf("manifest compare-and-swap mismatch: have %s, expected %s", currentDigest, expectedDigest)
		}
		if currentDigest == nextDigest {
			return nextDigest, nil
		}
	}
	if err := writeAtomic(path, data, 0o600); err != nil {
		return "", err
	}
	return nextDigest, nil
}

func (s *Store) ReadManifest() (model.Manifest, string, error) {
	data, err := readRegular(filepath.Join(s.root, manifestName))
	if err != nil {
		return model.Manifest{}, "", err
	}
	manifest, err := model.DecodeManifest(bytes.NewReader(data))
	if err != nil {
		return model.Manifest{}, "", err
	}
	return manifest, digest(data), nil
}

func (s *Store) CommitJournal(authority Authority, transaction model.Transaction) error {
	if err := validateAuthority(authority); err != nil {
		return err
	}
	if err := transaction.Validate(); err != nil {
		return err
	}
	dir := filepath.Join(s.root, "transactions", transaction.ID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	path := filepath.Join(dir, string(authority)+".json")
	data, err := model.CanonicalTransactionJSON(transaction)
	if err != nil {
		return err
	}
	existing, err := s.ReadJournal(authority, transaction.ID)
	if errors.Is(err, os.ErrNotExist) {
		if transaction.Phase != model.PhaseIdle || transaction.Revision != 1 {
			return errors.New("new authority journal must begin at IDLE revision 1")
		}
		return writeAtomic(path, data, 0o600)
	}
	if err != nil {
		return err
	}
	existingData, err := model.CanonicalTransactionJSON(existing)
	if err != nil {
		return err
	}
	if string(existingData) == string(data) {
		return nil
	}
	advanced, err := model.Advance(existing, transaction.Phase)
	if err != nil {
		return err
	}
	advancedData, err := model.CanonicalTransactionJSON(advanced)
	if err != nil {
		return err
	}
	if !bytes.Equal(advancedData, data) {
		return errors.New("journal update changed immutable transaction bindings or revision")
	}
	return writeAtomic(path, data, 0o600)
}

func (s *Store) ReadJournal(authority Authority, transactionID string) (model.Transaction, error) {
	if err := validateAuthority(authority); err != nil {
		return model.Transaction{}, err
	}
	probe := model.Transaction{
		SchemaVersion:        model.CurrentTransactionSchemaVersion,
		ID:                   transactionID,
		Profile:              model.ProfileProtectedLocal,
		Phase:                model.PhaseIdle,
		Revision:             1,
		Target:               placeholderGeneration(),
		ManifestDigest:       "sha256:0000000000000000000000000000000000000000000000000000000000000000",
		StateInventoryDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
		MigrationPlanDigest:  "sha256:0000000000000000000000000000000000000000000000000000000000000000",
		SignerPlanDigest:     "sha256:0000000000000000000000000000000000000000000000000000000000000000",
		PlatformDigest:       "sha256:0000000000000000000000000000000000000000000000000000000000000000",
	}
	if err := probe.Validate(); err != nil {
		return model.Transaction{}, fmt.Errorf("invalid transaction id: %w", err)
	}
	path := filepath.Join(s.root, "transactions", transactionID, string(authority)+".json")
	data, err := readRegular(path)
	if err != nil {
		return model.Transaction{}, err
	}
	transaction, err := model.DecodeTransaction(bytes.NewReader(data))
	if err != nil {
		return model.Transaction{}, err
	}
	if transaction.ID != transactionID {
		return model.Transaction{}, errors.New("journal path and transaction identity differ")
	}
	return transaction, nil
}

func validateAuthority(authority Authority) error {
	switch authority {
	case AuthoritySupervisor, AuthorityTargetController:
		return nil
	default:
		return fmt.Errorf("unsupported lifecycle authority %q", authority)
	}
}

func placeholderGeneration() model.Generation {
	return model.Generation{
		ID:                "sha256:0000000000000000000000000000000000000000000000000000000000000000",
		Version:           "0.0.0",
		Commit:            "0000000000000000000000000000000000000000",
		Tree:              "0000000000000000000000000000000000000000",
		ArtifactSetDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
	}
}

func digest(data []byte) string {
	sum := sha256.Sum256(data)
	return fmt.Sprintf("sha256:%x", sum)
}

func readRegular(path string) ([]byte, error) {
	before, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !before.Mode().IsRegular() {
		return nil, errors.New("durable lifecycle record must be a regular file")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	after, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !os.SameFile(before, after) {
		return nil, errors.New("durable lifecycle record changed while opening")
	}
	data, err := io.ReadAll(io.LimitReader(file, maxRecordSize+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxRecordSize {
		return nil, errors.New("durable lifecycle record exceeds size limit")
	}
	return data, nil
}

func writeAtomic(path string, data []byte, mode os.FileMode) (err error) {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	temp, err := os.CreateTemp(dir, ".pending-*")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	defer func() {
		_ = temp.Close()
		_ = os.Remove(tempPath)
	}()
	if err := temp.Chmod(mode); err != nil {
		return err
	}
	if _, err := temp.Write(data); err != nil {
		return err
	}
	if err := temp.Sync(); err != nil {
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tempPath, path); err != nil {
		return err
	}
	directory, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}
