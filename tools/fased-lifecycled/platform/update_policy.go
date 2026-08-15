package platform

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"syscall"

	"fased-lifecycled/model"
)

const CurrentUpdatePolicySchemaVersion uint32 = 1
const maxUpdatePolicyBytes = 4096

type UpdatePolicy struct {
	SchemaVersion uint32        `json:"schemaVersion"`
	Profile       model.Profile `json:"profile"`
	InstanceID    string        `json:"instanceId"`
	Channel       string        `json:"channel"`
}

func (config Config) UpdatePolicyPath() string {
	return filepath.Join(config.LifecycleRoot, "update-policy.json")
}

func ReadUpdatePolicy(config Config) (UpdatePolicy, error) {
	if err := config.Validate(); err != nil {
		return UpdatePolicy{}, err
	}
	return readUpdatePolicyAt(config.UpdatePolicyPath(), 0, config.Profile, config.InstanceID)
}

func InstallUpdatePolicyTransactional(config Config, channel string) (*FileReplacement, bool, error) {
	if err := config.Validate(); err != nil {
		return nil, false, err
	}
	return installUpdatePolicyTransactionalAt(config.UpdatePolicyPath(), 0, config.Profile, config.InstanceID, channel)
}

func readUpdatePolicyAt(path string, expectedUID uint32, profile model.Profile, instanceID string) (UpdatePolicy, error) {
	if !validUpdatePolicyIdentity(path, profile, instanceID) {
		return UpdatePolicy{}, errors.New("update policy identity is invalid")
	}
	info, err := os.Lstat(path)
	if err != nil {
		return UpdatePolicy{}, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0o600 ||
		stat.Uid != expectedUID || stat.Nlink != 1 || info.Size() <= 0 || info.Size() > maxUpdatePolicyBytes {
		return UpdatePolicy{}, errors.New("update policy is not a secure root-owned record")
	}
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return UpdatePolicy{}, err
	}
	defer file.Close()
	after, err := file.Stat()
	if err != nil || !os.SameFile(info, after) {
		return UpdatePolicy{}, errors.New("update policy changed while opening")
	}
	decoder := json.NewDecoder(io.LimitReader(file, maxUpdatePolicyBytes+1))
	decoder.DisallowUnknownFields()
	var policy UpdatePolicy
	if err := decoder.Decode(&policy); err != nil {
		return UpdatePolicy{}, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return UpdatePolicy{}, errors.New("update policy contains trailing data")
		}
		return UpdatePolicy{}, err
	}
	if err := validateUpdatePolicy(policy, profile, instanceID); err != nil {
		return UpdatePolicy{}, err
	}
	return policy, nil
}

func installUpdatePolicyTransactionalAt(path string, ownerUID uint32, profile model.Profile, instanceID, channel string) (*FileReplacement, bool, error) {
	policy := UpdatePolicy{SchemaVersion: CurrentUpdatePolicySchemaVersion, Profile: profile, InstanceID: instanceID, Channel: channel}
	if err := validateUpdatePolicy(policy, profile, instanceID); err != nil || !validUpdatePolicyIdentity(path, profile, instanceID) {
		if err != nil {
			return nil, false, err
		}
		return nil, false, errors.New("update policy path is invalid")
	}
	data, err := json.Marshal(policy)
	if err != nil {
		return nil, false, err
	}
	existing, err := readUpdatePolicyAt(path, ownerUID, profile, instanceID)
	if err == nil {
		existingData, marshalErr := json.Marshal(existing)
		if marshalErr != nil {
			return nil, false, marshalErr
		}
		if bytes.Equal(existingData, data) {
			return &FileReplacement{finished: true}, false, nil
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, false, err
	}
	replacement, err := InstallFileTransactional(path, data, 0o600, ownerUID, ownerUID)
	return replacement, err == nil, err
}

func validateUpdatePolicy(policy UpdatePolicy, profile model.Profile, instanceID string) error {
	if policy.SchemaVersion > CurrentUpdatePolicySchemaVersion {
		return errors.New("update policy schema is newer than supported")
	}
	if policy.SchemaVersion != CurrentUpdatePolicySchemaVersion || policy.Profile != profile || policy.InstanceID != instanceID ||
		(policy.Channel != "stable" && policy.Channel != "beta") {
		return errors.New("update policy differs from the installed lifecycle identity")
	}
	return nil
}

func validUpdatePolicyIdentity(path string, profile model.Profile, instanceID string) bool {
	return filepath.IsAbs(path) && filepath.Clean(path) == path && path != "/" &&
		(profile == model.ProfileProtectedLocal || profile == model.ProfileHosting) && instancePattern.MatchString(instanceID)
}
