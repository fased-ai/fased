package main

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
)

const signerLifecycleUpgradeSchemaV1 = 1

const (
	signerLifecyclePhasePreparedV1  = "prepared"
	signerLifecyclePhaseVerifiedV1  = "verified"
	signerLifecyclePhaseCommittedV1 = "committed"
)

type signerLifecycleUpgradeRequestV1 struct {
	SchemaVersion        int    `json:"schemaVersion"`
	TransactionID        string `json:"transactionId"`
	TargetGenerationID   string `json:"targetGenerationId"`
	StateInventoryDigest string `json:"stateInventoryDigest"`
	PlanDigest           string `json:"planDigest"`
	FromSchema           uint64 `json:"fromSchema"`
	ToSchema             uint64 `json:"toSchema"`
}

type signerLifecycleUpgradeMarkerV1 struct {
	Request      signerLifecycleUpgradeRequestV1 `json:"request"`
	Phase        string                          `json:"phase"`
	BackupName   string                          `json:"backupName,omitempty"`
	BackupSHA256 string                          `json:"backupSha256,omitempty"`
}

type signerLifecycleUpgradeReceiptV1 struct {
	TransactionID        string `json:"transactionId"`
	TargetGenerationID   string `json:"targetGenerationId"`
	StateInventoryDigest string `json:"stateInventoryDigest"`
	PlanDigest           string `json:"planDigest"`
	FromSchema           uint64 `json:"fromSchema"`
	ToSchema             uint64 `json:"toSchema"`
	Phase                string `json:"phase"`
	BackupSHA256         string `json:"backupSha256,omitempty"`
}

var signerLifecycleUUIDPatternV1 = regexp.MustCompile("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
var signerLifecycleDigestPatternV1 = regexp.MustCompile("^sha256:[0-9a-f]{64}$")

func decodeSignerLifecycleUpgradeRequestV1(raw json.RawMessage) (signerLifecycleUpgradeRequestV1, error) {
	var request signerLifecycleUpgradeRequestV1
	if err := decodeStrictJSONV2(raw, &request); err != nil {
		return request, errors.New("invalid signer lifecycle upgrade request")
	}
	if err := request.validate(); err != nil {
		return request, err
	}
	return request, nil
}

func (request signerLifecycleUpgradeRequestV1) validate() error {
	if request.SchemaVersion != signerLifecycleUpgradeSchemaV1 {
		return errors.New("unsupported signer lifecycle upgrade schema")
	}
	if !signerLifecycleUUIDPatternV1.MatchString(request.TransactionID) {
		return errors.New("invalid signer lifecycle transaction id")
	}
	if !signerLifecycleDigestPatternV1.MatchString(request.TargetGenerationID) ||
		!signerLifecycleDigestPatternV1.MatchString(request.StateInventoryDigest) ||
		!signerLifecycleDigestPatternV1.MatchString(request.PlanDigest) {
		return errors.New("invalid signer lifecycle identity binding")
	}
	if request.FromSchema == 0 || request.ToSchema < request.FromSchema {
		return errors.New("invalid signer lifecycle schema transition")
	}
	return nil
}

func requireSignerLifecycleGateBindingV1(gatePath string, request signerLifecycleUpgradeRequestV1, trustedUID, trustedGID int) error {
	if err := request.validate(); err != nil {
		return err
	}
	if !filepath.IsAbs(gatePath) || filepath.Clean(gatePath) != gatePath {
		return errors.New("signer lifecycle gate path must be absolute and clean")
	}
	info, err := os.Lstat(gatePath)
	if err != nil {
		return fmt.Errorf("read signer lifecycle gate: %w", err)
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0o640 || !ok || stat.Nlink != 1 || int(stat.Uid) != trustedUID || int(stat.Gid) != trustedGID {
		return errors.New("signer lifecycle gate is not a secure transaction record")
	}
	raw, err := os.ReadFile(gatePath)
	if err != nil {
		return err
	}
	bound, err := decodeSignerLifecycleUpgradeRequestV1(raw)
	if err != nil || bound != request {
		return errors.New("signer lifecycle gate does not match the requested transaction")
	}
	return nil
}

func prepareSignerLifecycleUpgradeV1(store *signerStoreV2, statePath string, request signerLifecycleUpgradeRequestV1) (signerLifecycleUpgradeReceiptV1, error) {
	if err := request.validate(); err != nil {
		return signerLifecycleUpgradeReceiptV1{}, err
	}
	if store == nil || store.db == nil || store.schemaVersion != request.FromSchema {
		return signerLifecycleUpgradeReceiptV1{}, errors.New("signer schema does not match lifecycle prepare request")
	}
	markerPath := signerLifecycleMarkerPathV1(statePath)
	if marker, err := readSignerLifecycleMarkerV1(markerPath); err == nil {
		if marker.Request == request {
			return marker.receipt(), nil
		}
		if marker.Phase != signerLifecyclePhaseCommittedV1 {
			return signerLifecycleUpgradeReceiptV1{}, errors.New("another signer lifecycle transaction is active")
		}
		if err := os.Remove(markerPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			return signerLifecycleUpgradeReceiptV1{}, err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return signerLifecycleUpgradeReceiptV1{}, err
	}
	backupPath, err := backupSignerStateBeforeMigrationV2(store.db, statePath)
	if err != nil {
		return signerLifecycleUpgradeReceiptV1{}, err
	}
	backupDigest, err := signerLifecycleFileDigestV1(backupPath)
	if err != nil {
		_ = os.Remove(backupPath)
		return signerLifecycleUpgradeReceiptV1{}, err
	}
	marker := signerLifecycleUpgradeMarkerV1{
		Request: request, Phase: signerLifecyclePhasePreparedV1,
		BackupName: filepath.Base(backupPath), BackupSHA256: backupDigest,
	}
	if err := writeSignerLifecycleMarkerV1(markerPath, marker); err != nil {
		_ = os.Remove(backupPath)
		return signerLifecycleUpgradeReceiptV1{}, err
	}
	return marker.receipt(), nil
}

func verifySignerLifecycleUpgradeV1(store *signerStoreV2, statePath string, request signerLifecycleUpgradeRequestV1) (signerLifecycleUpgradeReceiptV1, error) {
	marker, err := requireSignerLifecycleMarkerV1(statePath, request)
	if err != nil {
		return signerLifecycleUpgradeReceiptV1{}, err
	}
	if marker.Phase == signerLifecyclePhaseCommittedV1 {
		return marker.receipt(), nil
	}
	if store == nil || store.db == nil || store.schemaVersion != request.ToSchema {
		return signerLifecycleUpgradeReceiptV1{}, errors.New("signer schema does not match lifecycle verify request")
	}
	if err := verifySignerLifecycleBackupV1(statePath, marker); err != nil {
		return signerLifecycleUpgradeReceiptV1{}, err
	}
	marker.Phase = signerLifecyclePhaseVerifiedV1
	if err := writeSignerLifecycleMarkerV1(signerLifecycleMarkerPathV1(statePath), marker); err != nil {
		return signerLifecycleUpgradeReceiptV1{}, err
	}
	return marker.receipt(), nil
}

func commitSignerLifecycleUpgradeV1(store *signerStoreV2, statePath string, request signerLifecycleUpgradeRequestV1) (signerLifecycleUpgradeReceiptV1, error) {
	marker, err := requireSignerLifecycleMarkerV1(statePath, request)
	if err != nil {
		return signerLifecycleUpgradeReceiptV1{}, err
	}
	if marker.Phase != signerLifecyclePhaseVerifiedV1 && marker.Phase != signerLifecyclePhaseCommittedV1 {
		return signerLifecycleUpgradeReceiptV1{}, errors.New("signer lifecycle upgrade is not verified")
	}
	if store == nil || store.db == nil || store.schemaVersion != request.ToSchema {
		return signerLifecycleUpgradeReceiptV1{}, errors.New("signer schema does not match lifecycle commit request")
	}
	if marker.Phase != signerLifecyclePhaseCommittedV1 {
		marker.Phase = signerLifecyclePhaseCommittedV1
		if err := writeSignerLifecycleMarkerV1(signerLifecycleMarkerPathV1(statePath), marker); err != nil {
			return signerLifecycleUpgradeReceiptV1{}, err
		}
	}
	if marker.BackupName != "" {
		if err := os.Remove(filepath.Join(filepath.Dir(statePath), marker.BackupName)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return signerLifecycleUpgradeReceiptV1{}, err
		}
		if err := syncSignerStateDirectoryV2(filepath.Dir(statePath)); err != nil {
			return signerLifecycleUpgradeReceiptV1{}, err
		}
	}
	return marker.receipt(), nil
}

func abortSignerLifecycleUpgradeV1(store *signerStoreV2, statePath string, request signerLifecycleUpgradeRequestV1) error {
	marker, err := requireSignerLifecycleMarkerV1(statePath, request)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if marker.Phase == signerLifecyclePhaseCommittedV1 {
		return errors.New("committed signer lifecycle upgrade cannot be aborted")
	}
	if store == nil || store.db == nil || store.schemaVersion != request.FromSchema {
		return errors.New("signer lifecycle abort requires the offline restore helper")
	}
	return removeSignerLifecycleTransactionV1(statePath, marker)
}

func abortSignerLifecycleUpgradeOfflineV1(statePath string, request signerLifecycleUpgradeRequestV1) error {
	if !filepath.IsAbs(statePath) || filepath.Clean(statePath) != statePath {
		return errors.New("signer state database path must be absolute and clean")
	}
	if err := validateSignerLifecycleFileV1(statePath); err != nil {
		return err
	}
	marker, err := requireSignerLifecycleMarkerV1(statePath, request)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if marker.Phase == signerLifecyclePhaseCommittedV1 {
		return errors.New("committed signer lifecycle upgrade cannot be aborted")
	}
	if err := verifySignerLifecycleBackupV1(statePath, marker); err != nil {
		return err
	}
	backupPath := filepath.Join(filepath.Dir(statePath), marker.BackupName)
	temp, err := os.CreateTemp(filepath.Dir(statePath), ".signer-restore-*")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	backup, err := os.Open(backupPath)
	if err != nil {
		_ = temp.Close()
		return err
	}
	if _, err := io.Copy(temp, backup); err != nil {
		_ = backup.Close()
		_ = temp.Close()
		return err
	}
	if err := backup.Close(); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Chmod(0o600); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tempPath, statePath); err != nil {
		return err
	}
	if err := syncSignerStateDirectoryV2(filepath.Dir(statePath)); err != nil {
		return err
	}
	return removeSignerLifecycleTransactionV1(statePath, marker)
}

func requireSignerLifecycleMarkerV1(statePath string, request signerLifecycleUpgradeRequestV1) (signerLifecycleUpgradeMarkerV1, error) {
	if err := request.validate(); err != nil {
		return signerLifecycleUpgradeMarkerV1{}, err
	}
	marker, err := readSignerLifecycleMarkerV1(signerLifecycleMarkerPathV1(statePath))
	if err != nil {
		return marker, err
	}
	if marker.Request != request {
		return marker, errors.New("signer lifecycle transaction binding mismatch")
	}
	return marker, nil
}

func readSignerLifecycleMarkerV1(markerPath string) (signerLifecycleUpgradeMarkerV1, error) {
	info, err := os.Lstat(markerPath)
	if err != nil {
		return signerLifecycleUpgradeMarkerV1{}, err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0o600 {
		return signerLifecycleUpgradeMarkerV1{}, errors.New("signer lifecycle marker is not a secure regular file")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Nlink != 1 || int(stat.Uid) != os.Geteuid() {
		return signerLifecycleUpgradeMarkerV1{}, errors.New("signer lifecycle marker has invalid ownership or link count")
	}
	raw, err := os.ReadFile(markerPath)
	if err != nil {
		return signerLifecycleUpgradeMarkerV1{}, err
	}
	var marker signerLifecycleUpgradeMarkerV1
	if err := decodeStrictJSONV2(raw, &marker); err != nil {
		return marker, errors.New("invalid signer lifecycle marker")
	}
	if err := marker.Request.validate(); err != nil {
		return marker, err
	}
	if marker.Phase != signerLifecyclePhasePreparedV1 && marker.Phase != signerLifecyclePhaseVerifiedV1 && marker.Phase != signerLifecyclePhaseCommittedV1 {
		return marker, errors.New("invalid signer lifecycle marker phase")
	}
	if marker.BackupName != filepath.Base(marker.BackupName) || strings.TrimSpace(marker.BackupName) == "" || !signerLifecycleDigestPatternV1.MatchString(marker.BackupSHA256) {
		return marker, errors.New("invalid signer lifecycle backup binding")
	}
	return marker, nil
}

func writeSignerLifecycleMarkerV1(markerPath string, marker signerLifecycleUpgradeMarkerV1) error {
	data, err := json.Marshal(marker)
	if err != nil {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(markerPath), ".signer-upgrade-*")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	if err := temp.Chmod(0o600); err != nil {
		_ = temp.Close()
		return err
	}
	if _, err := temp.Write(data); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tempPath, markerPath); err != nil {
		return err
	}
	return syncSignerStateDirectoryV2(filepath.Dir(markerPath))
}

func verifySignerLifecycleBackupV1(statePath string, marker signerLifecycleUpgradeMarkerV1) error {
	backupPath := filepath.Join(filepath.Dir(statePath), marker.BackupName)
	if err := validateSignerLifecycleFileV1(backupPath); err != nil {
		return err
	}
	digest, err := signerLifecycleFileDigestV1(backupPath)
	if err != nil {
		return err
	}
	if digest != marker.BackupSHA256 {
		return errors.New("signer lifecycle backup digest mismatch")
	}
	return nil
}

func validateSignerLifecycleFileV1(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o077 != 0 {
		return errors.New("signer lifecycle file must be an owner-only regular file")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Nlink != 1 || int(stat.Uid) != os.Geteuid() {
		return errors.New("signer lifecycle file has invalid ownership or link count")
	}
	return nil
}

func runSignerLifecycleAbortCLI(args []string, stdin io.Reader, stdout io.Writer) error {
	flags := flag.NewFlagSet("lifecycle-upgrade-abort", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	var statePath string
	flags.StringVar(&statePath, "state-db", "", "signer-owned state database")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 {
		return errors.New("usage: lifecycle-upgrade-abort --state-db <absolute-path>")
	}
	raw, err := io.ReadAll(io.LimitReader(stdin, 64*1024+1))
	if err != nil {
		return err
	}
	if len(raw) > 64*1024 {
		return errors.New("signer lifecycle request is too large")
	}
	request, err := decodeSignerLifecycleUpgradeRequestV1(raw)
	if err != nil {
		return err
	}
	if err := abortSignerLifecycleUpgradeOfflineV1(statePath, request); err != nil {
		return err
	}
	return json.NewEncoder(stdout).Encode(map[string]string{"transactionId": request.TransactionID, "phase": "aborted"})
}

func removeSignerLifecycleTransactionV1(statePath string, marker signerLifecycleUpgradeMarkerV1) error {
	if marker.BackupName != "" {
		if err := os.Remove(filepath.Join(filepath.Dir(statePath), marker.BackupName)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	if err := os.Remove(signerLifecycleMarkerPathV1(statePath)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return syncSignerStateDirectoryV2(filepath.Dir(statePath))
}

func signerLifecycleMarkerPathV1(statePath string) string {
	return filepath.Clean(statePath) + ".lifecycle-upgrade.json"
}

func signerLifecycleFileDigestV1(path string) (string, error) {
	file, err := os.Open(path)
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

func (marker signerLifecycleUpgradeMarkerV1) receipt() signerLifecycleUpgradeReceiptV1 {
	return signerLifecycleUpgradeReceiptV1{
		TransactionID: marker.Request.TransactionID, TargetGenerationID: marker.Request.TargetGenerationID,
		StateInventoryDigest: marker.Request.StateInventoryDigest, PlanDigest: marker.Request.PlanDigest,
		FromSchema: marker.Request.FromSchema, ToSchema: marker.Request.ToSchema,
		Phase: marker.Phase, BackupSHA256: marker.BackupSHA256,
	}
}
