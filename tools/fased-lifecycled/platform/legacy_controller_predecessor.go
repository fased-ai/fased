package platform

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"

	"fased-lifecycled/model"
)

// CombinedPredecessor keeps the public-stable bridge and the one-time
// canonical controller-worker retirement as distinct, non-overlapping
// authorities behind the target transaction's single predecessor boundary.
type CombinedPredecessor struct {
	Public Predecessor
	Legacy *LegacyControllerPredecessor
}

func (combined CombinedPredecessor) Prepare(ctx context.Context, tx model.Transaction) error {
	if err := combined.Public.Prepare(ctx, tx); err != nil {
		return err
	}
	return combined.Legacy.Prepare(ctx, tx)
}
func (combined CombinedPredecessor) Quiesce(ctx context.Context, tx model.Transaction) error {
	if err := combined.Public.Quiesce(ctx, tx); err != nil {
		return err
	}
	return combined.Legacy.Quiesce(ctx, tx)
}
func (combined CombinedPredecessor) Restore(ctx context.Context, tx model.Transaction) error {
	return errors.Join(combined.Legacy.Restore(ctx, tx), combined.Public.Restore(ctx, tx))
}
func (combined CombinedPredecessor) Commit(ctx context.Context, tx model.Transaction) error {
	if err := combined.Legacy.Commit(ctx, tx); err != nil {
		return err
	}
	return combined.Public.Commit(ctx, tx)
}
func (combined CombinedPredecessor) Discard(ctx context.Context, tx model.Transaction) error {
	return errors.Join(combined.Legacy.Discard(ctx, tx), combined.Public.Discard(ctx, tx))
}

type LegacyControllerState interface {
	Active(context.Context, string) (bool, error)
	Enabled(context.Context, string) (bool, error)
}

type CommandLegacyControllerState struct{ Binary string }

func (state CommandLegacyControllerState) Active(ctx context.Context, unit string) (bool, error) {
	return (CommandServiceState{Binary: state.Binary}).Active(ctx, unit)
}

func (state CommandLegacyControllerState) Enabled(ctx context.Context, unit string) (bool, error) {
	if state.Binary != "/usr/bin/systemctl" && state.Binary != "/bin/systemctl" {
		return false, errors.New("legacy controller state binary must use a fixed system path")
	}
	output, err := exec.CommandContext(ctx, state.Binary, "is-enabled", unit).CombinedOutput()
	switch strings.TrimSpace(string(output)) {
	case "enabled", "enabled-runtime", "linked", "linked-runtime", "alias":
		return true, nil
	case "disabled", "static", "indirect", "generated", "transient", "masked", "masked-runtime":
		return false, nil
	default:
		if err != nil {
			return false, fmt.Errorf("systemctl is-enabled failed: %w: %s", err, output)
		}
		return false, errors.New("legacy controller enabled state is unknown")
	}
}

type LegacyControllerPredecessor struct {
	Config     Config
	Systemd    Systemd
	State      LegacyControllerState
	rootPrefix string
}

type legacyControllerRecord struct {
	SchemaVersion             uint32 `json:"schemaVersion"`
	TransactionID             string `json:"transactionId"`
	PredecessorManifestSchema uint32 `json:"predecessorManifestSchema"`
	PlatformDigest            string `json:"platformDigest"`
	Unit                      string `json:"unit"`
	UnitSHA256                string `json:"unitSha256"`
	UnitData                  []byte `json:"unitData"`
	WasEnabled                bool   `json:"wasEnabled"`
	WasActive                 bool   `json:"wasActive"`
}

func (legacy *LegacyControllerPredecessor) Prepare(ctx context.Context, tx model.Transaction) error {
	unit, applicable, err := legacy.selectedUnit(tx)
	if err != nil || !applicable {
		return err
	}
	data, err := legacy.readUnit(unit)
	if err != nil {
		return err
	}
	active, err := legacy.State.Active(ctx, unit)
	if err != nil {
		return err
	}
	enabled, err := legacy.State.Enabled(ctx, unit)
	if err != nil {
		return err
	}
	digest, err := tx.PredecessorPlatform.Digest(tx.Profile)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(data)
	record := legacyControllerRecord{
		SchemaVersion: 1, TransactionID: tx.ID, PredecessorManifestSchema: tx.PredecessorManifestSchema,
		PlatformDigest: digest, Unit: unit, UnitSHA256: fmt.Sprintf("sha256:%x", sum), UnitData: data,
		WasEnabled: enabled, WasActive: active,
	}
	encoded, err := json.Marshal(record)
	if err != nil {
		return err
	}
	return writePredecessorRecord(legacy.recordPath(tx), encoded)
}

func (legacy *LegacyControllerPredecessor) Quiesce(ctx context.Context, tx model.Transaction) error {
	record, applicable, err := legacy.read(tx)
	if err != nil || !applicable {
		return err
	}
	return legacy.Systemd.Stop(ctx, record.Unit)
}

func (legacy *LegacyControllerPredecessor) Restore(ctx context.Context, tx model.Transaction) error {
	record, applicable, err := legacy.read(tx)
	if err != nil || !applicable {
		return err
	}
	if err := os.Remove(legacy.retiredPath(tx)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := writeAtomicFile(legacy.unitPath(record.Unit), record.UnitData, 0o644); err != nil {
		return err
	}
	if err := syncDirectory(filepath.Dir(legacy.unitPath(record.Unit))); err != nil {
		return err
	}
	if err := legacy.Systemd.DaemonReload(ctx); err != nil {
		return err
	}
	if record.WasEnabled {
		if err := legacy.Systemd.Enable(ctx, record.Unit); err != nil {
			return err
		}
	} else if err := legacy.Systemd.Disable(ctx, record.Unit); err != nil {
		return err
	}
	if record.WasActive {
		return legacy.Systemd.Start(ctx, record.Unit)
	}
	return legacy.Systemd.Stop(ctx, record.Unit)
}

func (legacy *LegacyControllerPredecessor) Commit(ctx context.Context, tx model.Transaction) error {
	record, applicable, err := legacy.read(tx)
	if err != nil || !applicable {
		return err
	}
	if marker, markerErr := os.ReadFile(legacy.retiredPath(tx)); markerErr == nil {
		if string(marker) != record.UnitSHA256+"\n" {
			return errors.New("legacy controller retirement marker is invalid")
		}
		if _, statErr := os.Lstat(legacy.unitPath(record.Unit)); !errors.Is(statErr, os.ErrNotExist) {
			return errors.New("retired legacy controller unit reappeared")
		}
		return nil
	} else if !errors.Is(markerErr, os.ErrNotExist) {
		return markerErr
	}
	current, err := legacy.readUnit(record.Unit)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err == nil && !bytes.Equal(current, record.UnitData) {
		return errors.New("legacy controller unit changed before retirement")
	}
	if err := legacy.Systemd.Disable(ctx, record.Unit); err != nil {
		return err
	}
	if err := os.Remove(legacy.unitPath(record.Unit)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := syncDirectory(filepath.Dir(legacy.unitPath(record.Unit))); err != nil {
		return err
	}
	if err := legacy.Systemd.DaemonReload(ctx); err != nil {
		return err
	}
	return writeAtomicFile(legacy.retiredPath(tx), []byte(record.UnitSHA256+"\n"), 0o600)
}

func (legacy *LegacyControllerPredecessor) Discard(_ context.Context, tx model.Transaction) error {
	return legacy.discard(tx)
}

func (legacy *LegacyControllerPredecessor) selectedUnit(tx model.Transaction) (string, bool, error) {
	if tx.PredecessorPlatform == nil || !tx.PredecessorPlatform.IsLegacyControllerWorker(tx.Profile) {
		return "", false, nil
	}
	if legacy == nil || legacy.Systemd == nil || legacy.State == nil {
		return "", false, errors.New("legacy controller predecessor authority is unavailable")
	}
	if err := legacy.Config.Validate(); err != nil {
		return "", false, err
	}
	if tx.PlanAction != "UPDATE" || tx.PredecessorManifestSchema != 1 || tx.Profile != legacy.Config.Profile {
		return "", false, errors.New("legacy controller predecessor is not bound to a schema-one managed update")
	}
	target, err := legacy.Config.Identity()
	if err != nil {
		return "", false, err
	}
	expected, err := model.LegacyControllerPlatformIdentity(tx.Profile, target.InstanceID, target.ConfigurationDigest)
	if err != nil {
		return "", false, err
	}
	want, _ := expected.Digest(tx.Profile)
	got, _ := tx.PredecessorPlatform.Digest(tx.Profile)
	if want != got {
		return "", false, errors.New("legacy controller predecessor platform is not the canonical predecessor of this target")
	}
	return expected.Services["controller"], true, nil
}

func (legacy *LegacyControllerPredecessor) read(tx model.Transaction) (legacyControllerRecord, bool, error) {
	_, applicable, err := legacy.selectedUnit(tx)
	if err != nil || !applicable {
		return legacyControllerRecord{}, applicable, err
	}
	data, err := os.ReadFile(legacy.recordPath(tx))
	if err != nil {
		return legacyControllerRecord{}, true, err
	}
	var record legacyControllerRecord
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&record); err != nil {
		return legacyControllerRecord{}, true, err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return legacyControllerRecord{}, true, errors.New("legacy controller record has trailing data")
	}
	digest, _ := tx.PredecessorPlatform.Digest(tx.Profile)
	sum := sha256.Sum256(record.UnitData)
	unit := tx.PredecessorPlatform.Services["controller"]
	if record.SchemaVersion != 1 || record.TransactionID != tx.ID || record.PredecessorManifestSchema != tx.PredecessorManifestSchema ||
		record.PlatformDigest != digest || record.Unit != unit || record.UnitSHA256 != fmt.Sprintf("sha256:%x", sum) || len(record.UnitData) == 0 || len(record.UnitData) > 1<<20 {
		return legacyControllerRecord{}, true, errors.New("legacy controller record is invalid or rebound")
	}
	return record, true, nil
}

func (legacy *LegacyControllerPredecessor) readUnit(unit string) ([]byte, error) {
	path := legacy.unitPath(unit)
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	expectedUID := uint32(0)
	if legacy.rootPrefix != "" {
		expectedUID = uint32(os.Geteuid())
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0o644 || !ok || stat.Uid != expectedUID || stat.Nlink != 1 || info.Size() == 0 || info.Size() > 1<<20 {
		return nil, errors.New("legacy controller unit is unsafe")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	after, err := os.Lstat(path)
	if err != nil || !os.SameFile(info, after) {
		return nil, errors.New("legacy controller unit changed while reading")
	}
	return data, nil
}

func (legacy *LegacyControllerPredecessor) discard(tx model.Transaction) error {
	_, applicable, err := legacy.selectedUnit(tx)
	if err != nil || !applicable {
		return err
	}
	if err := os.Remove(legacy.recordPath(tx)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.Remove(legacy.retiredPath(tx)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func (legacy *LegacyControllerPredecessor) recordPath(tx model.Transaction) string {
	path := filepath.Join(legacy.Config.LifecycleRoot, "transactions", tx.ID, "legacy-controller-predecessor.json")
	if legacy.rootPrefix != "" {
		return filepath.Join(legacy.rootPrefix, path)
	}
	return path
}

func (legacy *LegacyControllerPredecessor) unitPath(unit string) string {
	path := legacy.Config.ServiceDefinitionPath(unit)
	if legacy.rootPrefix != "" {
		return filepath.Join(legacy.rootPrefix, path)
	}
	return path
}

func (legacy *LegacyControllerPredecessor) retiredPath(tx model.Transaction) string {
	path := filepath.Join(legacy.Config.LifecycleRoot, "transactions", tx.ID, "legacy-controller-retired")
	if legacy.rootPrefix != "" {
		return filepath.Join(legacy.rootPrefix, path)
	}
	return path
}

func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}
