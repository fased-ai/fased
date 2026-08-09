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
	"strings"

	"fased-lifecycled/model"
)

const (
	manifestName               = "installation-manifest.json"
	maxDurableRecordSize       = 1 << 20
	maxGenerationInventorySize = 16 << 20
)

type Authority string

const (
	AuthoritySupervisor       Authority = "supervisor"
	AuthorityTargetController Authority = "target-controller"
)

type Store struct {
	stateRoot   string
	installRoot string
}

// Layout separates mutable lifecycle authority from immutable executable
// generations. StateRoot belongs under /var/lib; InstallRoot belongs under
// /opt. Keeping these roots distinct prevents executable payloads from being
// mistaken for durable transaction state.
type Layout struct {
	StateRoot   string
	InstallRoot string
}

// Open is retained for isolated tests and migration tooling that intentionally
// use a single temporary root. Production callers must use OpenLayout.
func Open(root string) (*Store, error) {
	shared, err := prepareRoot(root, 0o711, "lifecycle store root")
	if err != nil {
		return nil, err
	}
	return &Store{stateRoot: shared, installRoot: shared}, nil
}

func OpenLayout(layout Layout) (*Store, error) {
	stateRoot, err := prepareRoot(layout.StateRoot, 0o700, "lifecycle state root")
	if err != nil {
		return nil, err
	}
	installRoot, err := prepareRoot(layout.InstallRoot, 0o755, "lifecycle install root")
	if err != nil {
		return nil, err
	}
	if stateRoot == installRoot {
		return nil, errors.New("production lifecycle state and install roots must be distinct")
	}
	if pathContains(stateRoot, installRoot) || pathContains(installRoot, stateRoot) {
		return nil, errors.New("lifecycle state and install roots must not overlap")
	}
	return &Store{stateRoot: stateRoot, installRoot: installRoot}, nil
}

func prepareRoot(root string, mode os.FileMode, label string) (string, error) {
	if !filepath.IsAbs(root) || filepath.Clean(root) != root || root == "/" {
		return "", fmt.Errorf("%s must be absolute, clean, and scoped", label)
	}
	clean := filepath.Clean(root)
	if err := os.MkdirAll(clean, 0o711); err != nil {
		return "", err
	}
	if err := os.Chmod(clean, mode); err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(clean)
	if err != nil {
		return "", err
	}
	if resolved != clean {
		return "", fmt.Errorf("%s must not contain symlinks", label)
	}
	return clean, nil
}

func pathContains(parent, child string) bool {
	relative, err := filepath.Rel(parent, child)
	return err == nil && relative != "." && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

func (s *Store) CommitManifest(manifest model.Manifest, expectedDigest string) (string, error) {
	data, err := model.CanonicalManifestJSON(manifest)
	if err != nil {
		return "", err
	}
	nextDigest := digest(data)
	path := filepath.Join(s.stateRoot, manifestName)
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
	data, err := readRegular(filepath.Join(s.stateRoot, manifestName))
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
	dir := filepath.Join(s.stateRoot, "transactions", transaction.ID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if err := s.commitTransactionEnvelope(dir, transaction); err != nil {
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
		SchemaVersion:      model.CurrentTransactionSchemaVersion,
		ID:                 transactionID,
		Profile:            model.ProfileProtectedLocal,
		Phase:              model.PhaseIdle,
		Revision:           1,
		Target:             placeholderGeneration(),
		TargetStateSchemas: map[string]uint32{"placeholder": 1},
		TargetCapabilities: model.CapabilityRanges{
			Supervisor: model.CapabilityRange{Min: 1, Max: 1}, Controller: model.CapabilityRange{Min: 1, Max: 1},
			Migrator: model.CapabilityRange{Min: 1, Max: 1}, Signer: model.CapabilityRange{Min: 1, Max: 1},
		},
		ManifestDigest:       "sha256:0000000000000000000000000000000000000000000000000000000000000000",
		StateInventoryDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
		MigrationPlanDigest:  "sha256:0000000000000000000000000000000000000000000000000000000000000000",
		SignerPlanDigest:     "sha256:0000000000000000000000000000000000000000000000000000000000000000",
		PlatformDigest:       "sha256:0000000000000000000000000000000000000000000000000000000000000000",
	}
	if err := probe.Validate(); err != nil {
		return model.Transaction{}, fmt.Errorf("invalid transaction id: %w", err)
	}
	path := filepath.Join(s.stateRoot, "transactions", transactionID, string(authority)+".json")
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
	if err := s.verifyTransactionEnvelope(filepath.Dir(path), transaction); err != nil {
		return model.Transaction{}, err
	}
	return transaction, nil
}

func (s *Store) commitTransactionEnvelope(dir string, transaction model.Transaction) error {
	envelope, err := transaction.Envelope()
	if err != nil {
		return err
	}
	data, err := model.CanonicalTransactionEnvelopeJSON(envelope)
	if err != nil {
		return err
	}
	path := filepath.Join(dir, "envelope.json")
	existing, err := readRegular(path)
	if errors.Is(err, os.ErrNotExist) {
		return writeAtomic(path, data, 0o600)
	}
	if err != nil {
		return err
	}
	if !bytes.Equal(existing, data) {
		return errors.New("transaction envelope differs from immutable transaction binding")
	}
	return nil
}

func (s *Store) verifyTransactionEnvelope(dir string, transaction model.Transaction) error {
	data, err := readRegular(filepath.Join(dir, "envelope.json"))
	if err != nil {
		return err
	}
	want, err := transaction.Envelope()
	if err != nil {
		return err
	}
	got, err := model.DecodeTransactionEnvelope(bytes.NewReader(data))
	if err != nil {
		return err
	}
	wantJSON, err := model.CanonicalTransactionEnvelopeJSON(want)
	if err != nil {
		return err
	}
	gotJSON, err := model.CanonicalTransactionEnvelopeJSON(got)
	if err != nil {
		return err
	}
	if !bytes.Equal(wantJSON, gotJSON) {
		return errors.New("authority journal does not match shared transaction envelope")
	}
	return nil
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
	return readRegularBounded(path, maxDurableRecordSize, "durable lifecycle record")
}

func readGenerationInventory(path string) ([]byte, error) {
	return readRegularBounded(path, maxGenerationInventorySize, "generation inventory")
}

func readRegularBounded(path string, limit int64, label string) ([]byte, error) {
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
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("%s exceeds size limit", label)
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
