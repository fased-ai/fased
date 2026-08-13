package store

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"

	"fased-lifecycled/model"
)

// CandidateAuthority is the root-bound result of verifying one attested
// release index. It is deliberately absent from the operator protocol: only
// the root bootstrap that imported the exact generation may create this record.
type CandidateAuthority struct {
	SchemaVersion    uint32 `json:"schemaVersion"`
	GenerationID     string `json:"generationId"`
	ReleaseSequence  uint64 `json:"releaseSequence"`
	SecurityEpoch    uint64 `json:"securityEpoch"`
	ManifestMin      uint32 `json:"manifestMin"`
	ManifestMax      uint32 `json:"manifestMax"`
	ReleaseIndex     string `json:"releaseIndexDigest"`
	ReleaseAuthority string `json:"releaseAuthorityDigest"`
}

func (authority CandidateAuthority) validate() error {
	if authority.SchemaVersion != 1 || authority.ReleaseSequence == 0 || authority.SecurityEpoch == 0 ||
		authority.ManifestMin == 0 || authority.ManifestMax < authority.ManifestMin ||
		model.CurrentManifestSchemaVersion < authority.ManifestMin || model.CurrentManifestSchemaVersion > authority.ManifestMax ||
		!validSHA256Digest(authority.GenerationID) || !validSHA256Digest(authority.ReleaseIndex) || !validSHA256Digest(authority.ReleaseAuthority) {
		return errors.New("candidate release authority is malformed")
	}
	return nil
}

func (s *Store) BindCandidateAuthority(authority CandidateAuthority) error {
	if err := authority.validate(); err != nil {
		return err
	}
	if _, generation, err := s.ReadCandidateContract(authority.GenerationID); err != nil || generation.ID != authority.GenerationID {
		if err != nil {
			return err
		}
		return errors.New("candidate release authority differs from imported generation")
	}
	data, err := json.Marshal(authority)
	if err != nil {
		return err
	}
	path := s.candidateAuthorityPath(authority.GenerationID)
	if existing, err := readRegular(path); err == nil {
		if !bytes.Equal(existing, data) {
			return errors.New("candidate release authority is already bound differently")
		}
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := writeAuthorityOnce(path, data); errors.Is(err, os.ErrExist) {
		existing, readErr := readRegular(path)
		if readErr != nil {
			return readErr
		}
		if !bytes.Equal(existing, data) {
			return errors.New("candidate release authority raced with a different binding")
		}
		return nil
	} else {
		return err
	}
}

func (s *Store) ReadCandidateAuthority(generationID string) (CandidateAuthority, error) {
	if !validSHA256Digest(generationID) {
		return CandidateAuthority{}, errors.New("candidate release authority generation is malformed")
	}
	data, err := readRegular(s.candidateAuthorityPath(generationID))
	if err != nil {
		return CandidateAuthority{}, err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var authority CandidateAuthority
	if err := decoder.Decode(&authority); err != nil {
		return CandidateAuthority{}, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return CandidateAuthority{}, errors.New("candidate release authority contains trailing data")
		}
		return CandidateAuthority{}, err
	}
	if err := authority.validate(); err != nil {
		return CandidateAuthority{}, err
	}
	if authority.GenerationID != generationID {
		return CandidateAuthority{}, errors.New("candidate release authority identity differs")
	}
	return authority, nil
}

func (s *Store) candidateAuthorityPath(generationID string) string {
	return filepath.Join(s.stateRoot, "candidate-authority", generationID[len("sha256:"):]+".json")
}

func writeAuthorityOnce(path string, data []byte) error {
	directoryPath := filepath.Dir(path)
	if err := os.MkdirAll(directoryPath, 0o700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(directoryPath, ".authority-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer func() {
		_ = temporary.Close()
		_ = os.Remove(temporaryPath)
	}()
	if err := temporary.Chmod(0o600); err != nil {
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		return err
	}
	if err := temporary.Sync(); err != nil {
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Link(temporaryPath, path); err != nil {
		return err
	}
	if err := os.Remove(temporaryPath); err != nil {
		return err
	}
	directory, err := os.Open(directoryPath)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}
