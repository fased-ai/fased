package platform

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"fased-lifecycled/model"
)

type ServiceState interface {
	Active(context.Context, string) (bool, error)
}

type CommandServiceState struct{ Binary string }

func (state CommandServiceState) Active(ctx context.Context, unit string) (bool, error) {
	if state.Binary != "/usr/bin/systemctl" && state.Binary != "/bin/systemctl" {
		return false, errors.New("service-state binary must use a fixed system path")
	}
	output, err := exec.CommandContext(ctx, state.Binary, "show", "--property=ActiveState", "--value", unit).CombinedOutput()
	if err != nil {
		return false, err
	}
	switch strings.TrimSpace(string(output)) {
	case "active", "activating", "reloading":
		return true, nil
	case "inactive", "failed", "deactivating":
		return false, nil
	default:
		return false, errors.New("service state is unknown")
	}
}

type HostingPredecessor struct {
	Config     Config
	Systemd    Systemd
	State      ServiceState
	rootPrefix string
}

type hostingPredecessorRecord struct {
	TransactionID string          `json:"transactionId"`
	Topology      string          `json:"topology"`
	Active        map[string]bool `json:"active"`
}

func (bridge *HostingPredecessor) Prepare(ctx context.Context, tx model.Transaction) error {
	if tx.PlanAction != "BRIDGE_PUBLIC_STABLE" {
		return nil
	}
	if err := bridge.validate(tx); err != nil {
		return err
	}
	record := hostingPredecessorRecord{TransactionID: tx.ID, Topology: tx.SourceTopology, Active: map[string]bool{}}
	for _, unit := range bridge.units() {
		active, err := bridge.State.Active(ctx, unit)
		if err != nil {
			return err
		}
		record.Active[unit] = active
	}
	data, err := json.Marshal(record)
	if err != nil {
		return err
	}
	return writePredecessorRecord(bridge.recordPath(tx), data)
}

func (bridge *HostingPredecessor) Quiesce(ctx context.Context, tx model.Transaction) error {
	record, found, err := bridge.read(tx)
	if err != nil || !found {
		return err
	}
	for _, unit := range bridge.units() {
		if record.Active[unit] {
			if err := bridge.Systemd.Stop(ctx, unit); err != nil {
				return err
			}
		}
	}
	return nil
}

func (bridge *HostingPredecessor) Restore(ctx context.Context, tx model.Transaction) error {
	record, found, err := bridge.read(tx)
	if err != nil || !found {
		return err
	}
	for _, unit := range bridge.units() {
		if record.Active[unit] {
			if err := bridge.Systemd.Start(ctx, unit); err != nil {
				return err
			}
		}
	}
	return nil
}

func (bridge *HostingPredecessor) Commit(_ context.Context, tx model.Transaction) error {
	return bridge.discard(tx)
}
func (bridge *HostingPredecessor) Discard(_ context.Context, tx model.Transaction) error {
	return bridge.discard(tx)
}

func (bridge *HostingPredecessor) validate(tx model.Transaction) error {
	if bridge == nil || bridge.Systemd == nil || bridge.State == nil {
		return errors.New("Hosting predecessor authority is unavailable")
	}
	if err := bridge.Config.Validate(); err != nil {
		return err
	}
	if bridge.Config.Profile != model.ProfileHosting || tx.Profile != model.ProfileHosting {
		return errors.New("Hosting predecessor received another profile")
	}
	switch tx.SourceTopology {
	case "hosting-root-gateway-v0", "hosting-controller-v2-self-updating":
		return nil
	default:
		return errors.New("Hosting predecessor topology is unsupported")
	}
}

func (bridge *HostingPredecessor) units() []string {
	return []string{"fased-signerd.service", "fased-gateway.service"}
}

func (bridge *HostingPredecessor) recordPath(tx model.Transaction) string {
	path := filepath.Join(bridge.Config.LifecycleRoot, "transactions", tx.ID, "predecessor.json")
	if bridge.rootPrefix != "" {
		return filepath.Join(bridge.rootPrefix, path)
	}
	return path
}

func (bridge *HostingPredecessor) read(tx model.Transaction) (hostingPredecessorRecord, bool, error) {
	if tx.PlanAction != "BRIDGE_PUBLIC_STABLE" {
		return hostingPredecessorRecord{}, false, nil
	}
	if err := bridge.validate(tx); err != nil {
		return hostingPredecessorRecord{}, false, err
	}
	data, err := os.ReadFile(bridge.recordPath(tx))
	if errors.Is(err, os.ErrNotExist) {
		return hostingPredecessorRecord{}, false, nil
	}
	if err != nil {
		return hostingPredecessorRecord{}, false, err
	}
	var record hostingPredecessorRecord
	if json.Unmarshal(data, &record) != nil || record.TransactionID != tx.ID || record.Topology != tx.SourceTopology || len(record.Active) != len(bridge.units()) {
		return hostingPredecessorRecord{}, false, errors.New("Hosting predecessor record is invalid or rebound")
	}
	for _, unit := range bridge.units() {
		if _, ok := record.Active[unit]; !ok {
			return hostingPredecessorRecord{}, false, errors.New("Hosting predecessor record is incomplete")
		}
	}
	return record, true, nil
}

func (bridge *HostingPredecessor) discard(tx model.Transaction) error {
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
