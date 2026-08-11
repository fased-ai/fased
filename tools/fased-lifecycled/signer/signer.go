// Package signer binds the native signer lifecycle to the product transaction.
package signer

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"

	"fased-lifecycled/engine"
	"fased-lifecycled/model"
	"fased-lifecycled/platform"
)

type UpgradeRequest struct {
	SchemaVersion        uint32 `json:"schemaVersion"`
	TransactionID        string `json:"transactionId"`
	TargetGenerationID   string `json:"targetGenerationId"`
	StateInventoryDigest string `json:"stateInventoryDigest"`
	PlanDigest           string `json:"planDigest"`
	FromSchema           uint32 `json:"fromSchema"`
	ToSchema             uint32 `json:"toSchema"`
}

type UpgradeReceipt struct {
	TransactionID        string `json:"transactionId"`
	TargetGenerationID   string `json:"targetGenerationId"`
	StateInventoryDigest string `json:"stateInventoryDigest"`
	PlanDigest           string `json:"planDigest"`
	FromSchema           uint32 `json:"fromSchema"`
	ToSchema             uint32 `json:"toSchema"`
	Phase                string `json:"phase"`
}

type Caller interface {
	Call(context.Context, string, UpgradeRequest) (UpgradeReceipt, error)
}

type OfflineRestorer interface {
	Abort(context.Context, string, string, UpgradeRequest, platform.Principal) error
}

type GenerationResolver interface {
	GenerationPayloadPath(string) (string, error)
}

type Participant struct {
	Config          platform.Config
	Caller          Caller
	Offline         OfflineRestorer
	Generations     GenerationResolver
	ExpectedGateUID int
	rootPrefix      string
}

const absentManifestDigest = "sha256:0000000000000000000000000000000000000000000000000000000000000000"

func (participant *Participant) Prepare(ctx context.Context, tx model.Transaction) (engine.ParticipantReceipt, error) {
	request, offline, err := participant.request(tx)
	if err != nil {
		return engine.ParticipantReceipt{}, err
	}
	if err := participant.writeGate(request); err != nil {
		return engine.ParticipantReceipt{}, err
	}
	if !offline {
		receipt, err := participant.Caller.Call(ctx, "v2.lifecycle.upgrade.prepare", request)
		if err != nil {
			return engine.ParticipantReceipt{}, err
		}
		if err := validateUpgradeReceipt(receipt, request, "prepared"); err != nil {
			return engine.ParticipantReceipt{}, err
		}
	}
	return engineReceipt(tx), nil
}

func (participant *Participant) Verify(ctx context.Context, tx model.Transaction, receipt engine.ParticipantReceipt) error {
	if receipt != engineReceipt(tx) {
		return errors.New("signer participant receipt does not match transaction")
	}
	request, offline, err := participant.request(tx)
	if err != nil || offline {
		return err
	}
	result, err := participant.Caller.Call(ctx, "v2.lifecycle.upgrade.verify", request)
	if err != nil {
		return err
	}
	return validateUpgradeReceipt(result, request, "verified")
}

func (participant *Participant) Commit(ctx context.Context, tx model.Transaction) error {
	request, offline, err := participant.request(tx)
	if err != nil {
		return err
	}
	if !offline {
		result, err := participant.Caller.Call(ctx, "v2.lifecycle.upgrade.commit", request)
		if err != nil {
			return err
		}
		if err := validateUpgradeReceipt(result, request, "committed"); err != nil {
			return err
		}
	}
	return participant.removeGate(request)
}

func (participant *Participant) Abort(ctx context.Context, tx model.Transaction) error {
	request, offline, err := participant.request(tx)
	if err != nil {
		return err
	}
	if offline {
		return participant.removeGate(request)
	}
	if _, liveErr := participant.Caller.Call(ctx, "v2.lifecycle.upgrade.abort", request); liveErr == nil {
		return participant.removeGate(request)
	}
	payload, err := participant.Generations.GenerationPayloadPath(tx.Target.ID)
	if err != nil {
		return err
	}
	binary := filepath.Join(payload, "bin", "fased-signerd")
	stateDB := participant.resolve(filepath.Join(participant.Config.SignerStateRoot(), "state.db"))
	if err := participant.Offline.Abort(ctx, binary, stateDB, request, participant.Config.Signer); err != nil {
		return err
	}
	return participant.removeGate(request)
}

func (participant *Participant) request(tx model.Transaction) (UpgradeRequest, bool, error) {
	if participant == nil || participant.Caller == nil || participant.Offline == nil || participant.Generations == nil {
		return UpgradeRequest{}, false, errors.New("signer lifecycle participant is incomplete")
	}
	if err := participant.Config.Validate(); err != nil {
		return UpgradeRequest{}, false, err
	}
	to := tx.TargetStateSchemas["signer"]
	if to == 0 {
		return UpgradeRequest{}, false, errors.New("target generation has no signer schema")
	}
	from := to
	for _, migration := range tx.Migrations {
		if migration.State == "signer" {
			from = migration.From
			break
		}
	}
	request := UpgradeRequest{SchemaVersion: 1, TransactionID: tx.ID, TargetGenerationID: tx.Target.ID,
		StateInventoryDigest: tx.StateInventoryDigest, PlanDigest: tx.SignerPlanDigest, FromSchema: from, ToSchema: to}
	// A same-schema update has no signer-owned state transformation to prepare.
	// The root-authored gate freezes application mutations while the target
	// transaction replaces and health-checks the signer runtime. The typed live
	// signer lifecycle protocol is reserved for an actual schema transition.
	// This keeps compatibility based on persisted schema rather than release
	// names and permits older same-schema signers to be replaced atomically.
	return request, from == 0 || from == to || tx.ManifestDigest == absentManifestDigest, nil
}

func (participant *Participant) writeGate(request UpgradeRequest) error {
	data, err := json.Marshal(request)
	if err != nil {
		return err
	}
	path := participant.resolve(participant.Config.UpdateGatePath())
	if existing, err := readSecureGate(path, participant.ExpectedGateUID, int(participant.Config.Signer.GID)); err == nil {
		if bytes.Equal(existing, data) {
			return nil
		}
		return errors.New("another signer update transaction owns the gate")
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".signer-gate-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o640); err != nil {
		temporary.Close()
		return err
	}
	expectedGID := int(participant.Config.Signer.GID)
	if participant.ExpectedGateUID != os.Geteuid() || expectedGID != os.Getegid() {
		if err := temporary.Chown(participant.ExpectedGateUID, expectedGID); err != nil {
			temporary.Close()
			return err
		}
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

func (participant *Participant) removeGate(request UpgradeRequest) error {
	path := participant.resolve(participant.Config.UpdateGatePath())
	data, err := readSecureGate(path, participant.ExpectedGateUID, int(participant.Config.Signer.GID))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	want, _ := json.Marshal(request)
	if !bytes.Equal(data, want) {
		return errors.New("signer update gate binding changed")
	}
	return os.Remove(path)
}

func (participant *Participant) resolve(path string) string {
	if participant.rootPrefix == "" {
		return path
	}
	return filepath.Join(participant.rootPrefix, filepath.Clean(path))
}

func readSecureGate(path string, expectedUID, expectedGID int) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0o640 || !ok || stat.Nlink != 1 || int(stat.Uid) != expectedUID || int(stat.Gid) != expectedGID {
		return nil, errors.New("signer update gate is not a secure bound record")
	}
	return os.ReadFile(path)
}

func validateUpgradeReceipt(receipt UpgradeReceipt, request UpgradeRequest, phase string) error {
	if receipt.TransactionID != request.TransactionID || receipt.TargetGenerationID != request.TargetGenerationID ||
		receipt.StateInventoryDigest != request.StateInventoryDigest || receipt.PlanDigest != request.PlanDigest ||
		receipt.FromSchema != request.FromSchema || receipt.ToSchema != request.ToSchema || receipt.Phase != phase {
		return errors.New("signer lifecycle receipt does not match transaction")
	}
	return nil
}

func engineReceipt(tx model.Transaction) engine.ParticipantReceipt {
	return engine.ParticipantReceipt{TransactionID: tx.ID, TargetGenerationID: tx.Target.ID,
		StateInventoryDigest: tx.StateInventoryDigest, PlanDigest: tx.SignerPlanDigest}
}

type CommandOfflineRestorer struct {
	SystemdRun string
}

func (restorer CommandOfflineRestorer) Abort(ctx context.Context, binary, stateDB string, request UpgradeRequest, principal platform.Principal) error {
	if err := requireExecutable(binary); err != nil {
		return err
	}
	encoded, err := json.Marshal(request)
	if err != nil {
		return err
	}
	command, err := signerCommand(ctx, restorer.SystemdRun, binary, principal, filepath.Dir(stateDB),
		"lifecycle-upgrade-abort", "--state-db", stateDB)
	if err != nil {
		return err
	}
	command.Stdin = bytes.NewReader(encoded)
	output, err := command.CombinedOutput()
	if err != nil {
		return fmt.Errorf("offline signer rollback failed: %w: %s", err, output)
	}
	return nil
}

func requireExecutable(path string) error {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return errors.New("signer helper path must be absolute and clean")
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o111 == 0 {
		return errors.New("signer helper must be a regular executable")
	}
	return nil
}
