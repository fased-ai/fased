package platform

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	"fased-lifecycled/model"
)

// UserSystemd is the narrow authority needed to fence and restore the one
// supported public-stable Local user service during a bridge.
type UserSystemd interface {
	IsActive(context.Context, string) (bool, error)
	Stop(context.Context, string) error
	Start(context.Context, string) error
}

type LocalPredecessor struct {
	Config     Config
	Systemd    UserSystemd
	rootPrefix string
}

// NoPredecessor is valid only for fresh or already-managed transactions. A
// public-stable bridge must select a profile adapter instead.
type NoPredecessor struct{}

func (NoPredecessor) Prepare(_ context.Context, tx model.Transaction) error {
	if tx.PlanAction == "BRIDGE_PUBLIC_STABLE" {
		return errors.New("public-stable bridge has no predecessor adapter")
	}
	return nil
}
func (NoPredecessor) Quiesce(context.Context, model.Transaction) error { return nil }
func (NoPredecessor) Restore(context.Context, model.Transaction) error { return nil }
func (NoPredecessor) Commit(context.Context, model.Transaction) error  { return nil }
func (NoPredecessor) Discard(context.Context, model.Transaction) error { return nil }

type predecessorRecord struct {
	TransactionID string `json:"transactionId"`
	Topology      string `json:"topology"`
	Service       string `json:"service"`
	WasActive     bool   `json:"wasActive"`
}

func (bridge *LocalPredecessor) Prepare(ctx context.Context, tx model.Transaction) error {
	if tx.PlanAction != "BRIDGE_PUBLIC_STABLE" {
		return nil
	}
	if err := bridge.validate(tx); err != nil {
		return err
	}
	active, err := bridge.Systemd.IsActive(ctx, "fased-gateway.service")
	if err != nil {
		return err
	}
	record := predecessorRecord{TransactionID: tx.ID, Topology: tx.SourceTopology, Service: "fased-gateway.service", WasActive: active}
	data, err := json.Marshal(record)
	if err != nil {
		return err
	}
	return writePredecessorRecord(bridge.recordPath(tx), data)
}

func (bridge *LocalPredecessor) Quiesce(ctx context.Context, tx model.Transaction) error {
	record, found, err := bridge.read(tx)
	if err != nil || !found || !record.WasActive {
		return err
	}
	return bridge.Systemd.Stop(ctx, record.Service)
}

func (bridge *LocalPredecessor) Restore(ctx context.Context, tx model.Transaction) error {
	record, found, err := bridge.read(tx)
	if err != nil || !found || !record.WasActive {
		return err
	}
	return bridge.Systemd.Start(ctx, record.Service)
}

func (bridge *LocalPredecessor) Commit(_ context.Context, tx model.Transaction) error {
	return bridge.discard(tx)
}

func (bridge *LocalPredecessor) Discard(_ context.Context, tx model.Transaction) error {
	return bridge.discard(tx)
}

func (bridge *LocalPredecessor) validate(tx model.Transaction) error {
	if bridge == nil || bridge.Systemd == nil {
		return errors.New("Local public-stable predecessor authority is unavailable")
	}
	if err := bridge.Config.Validate(); err != nil {
		return err
	}
	if bridge.Config.Profile != model.ProfileProtectedLocal || tx.Profile != model.ProfileProtectedLocal {
		return errors.New("Local predecessor received another profile")
	}
	switch tx.SourceTopology {
	case "legacy-local-same-user-v0", "local-user-systemd-v1", "local-user-systemd-v2-self-updating", "local-user-systemd-v2":
		return nil
	default:
		return errors.New("Local predecessor topology is unsupported")
	}
}

func (bridge *LocalPredecessor) read(tx model.Transaction) (predecessorRecord, bool, error) {
	if tx.PlanAction != "BRIDGE_PUBLIC_STABLE" {
		return predecessorRecord{}, false, nil
	}
	if err := bridge.validate(tx); err != nil {
		return predecessorRecord{}, false, err
	}
	data, err := os.ReadFile(bridge.recordPath(tx))
	if errors.Is(err, os.ErrNotExist) {
		return predecessorRecord{}, false, nil
	}
	if err != nil {
		return predecessorRecord{}, false, err
	}
	var record predecessorRecord
	if json.Unmarshal(data, &record) != nil || record.TransactionID != tx.ID || record.Topology != tx.SourceTopology || record.Service != "fased-gateway.service" {
		return predecessorRecord{}, false, errors.New("Local predecessor record is invalid or rebound")
	}
	return record, true, nil
}

func (bridge *LocalPredecessor) discard(tx model.Transaction) error {
	if tx.PlanAction != "BRIDGE_PUBLIC_STABLE" {
		return nil
	}
	if _, found, err := bridge.read(tx); err != nil || !found {
		return err
	}
	if err := os.Remove(bridge.recordPath(tx)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func (bridge *LocalPredecessor) recordPath(tx model.Transaction) string {
	path := filepath.Join(bridge.Config.LifecycleRoot, "transactions", tx.ID, "predecessor.json")
	if bridge.rootPrefix != "" {
		return filepath.Join(bridge.rootPrefix, path)
	}
	return path
}

func writePredecessorRecord(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	if existing, err := os.ReadFile(path); err == nil {
		if string(existing) == string(data) {
			return nil
		}
		return errors.New("another predecessor transaction is already recorded")
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".predecessor-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporaryPath, path)
}
