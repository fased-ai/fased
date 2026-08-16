//go:build systemd_t2

package platform

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"fased-lifecycled/acquire"
	"fased-lifecycled/bundle"
	"fased-lifecycled/engine"
	"fased-lifecycled/model"
	"fased-lifecycled/store"
	"fased-lifecycled/trust"
)

type t2Receipt struct {
	SchemaVersion         uint32                 `json:"schemaVersion"`
	Status                string                 `json:"status"`
	InstanceID            string                 `json:"instanceId"`
	SourceCommit          string                 `json:"sourceCommit"`
	SourceTree            string                 `json:"sourceTree"`
	FailureInjected       bool                   `json:"failureInjected"`
	ExactRollback         bool                   `json:"exactRollback"`
	RetryCommitted        bool                   `json:"retryCommitted"`
	CriticalBefore        string                 `json:"criticalBefore"`
	CriticalAfterRollback string                 `json:"criticalAfterRollback"`
	CriticalAfterCommit   string                 `json:"criticalAfterCommit"`
	Initial               t2ServiceObservation   `json:"initial"`
	Restored              t2ServiceObservation   `json:"restored"`
	Committed             t2ServiceObservation   `json:"committed"`
	Retention             t2RetentionObservation `json:"retention"`
	ConvergenceReceipt    string                 `json:"convergenceReceipt"`
}

type t2RetentionObservation struct {
	ActiveGenerationID   string   `json:"activeGenerationId"`
	PreviousGenerationID string   `json:"previousGenerationId"`
	CurrentPointer       string   `json:"currentPointer"`
	PreviousPointer      string   `json:"previousPointer"`
	RemovedGenerations   []string `json:"removedGenerations"`
	RemovedDependencies  []string `json:"removedDependencies"`
	RemovedInboxObjects  int      `json:"removedInboxObjects"`
}

type t2ServiceObservation struct {
	GenerationID string          `json:"generationId"`
	Signer       t2ProcessRecord `json:"signer"`
	Gateway      t2ProcessRecord `json:"gateway"`
	Socket       t2SocketRecord  `json:"socket"`
}

type t2ProcessRecord struct {
	Unit                          string `json:"unit"`
	MainPID                       uint32 `json:"mainPid"`
	InvocationID                  string `json:"invocationId"`
	ActiveEnterTimestampMonotonic uint64 `json:"activeEnterTimestampMonotonic"`
	ExecStartDigest               string `json:"execStartDigest"`
	Executable                    string `json:"executable"`
	Cgroup                        string `json:"cgroup"`
}

type t2SocketRecord struct {
	Path string `json:"path"`
	UID  uint32 `json:"uid"`
	GID  uint32 `json:"gid"`
	Mode uint32 `json:"mode"`
}

type t2GenerationStore struct {
	payloads map[string]string
}

func (generations t2GenerationStore) StageGeneration(generationID string) error {
	payload, ok := generations.payloads[generationID]
	if !ok {
		return errors.New("T2 target generation is unavailable")
	}
	info, err := os.Lstat(payload)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("T2 target payload is unsafe")
	}
	return nil
}

type t2Participant struct {
	plan func(model.Transaction) string
}

func (participant t2Participant) Prepare(_ context.Context, tx model.Transaction) (engine.ParticipantReceipt, error) {
	return engine.ParticipantReceipt{TransactionID: tx.ID, TargetGenerationID: tx.Target.ID,
		StateInventoryDigest: tx.StateInventoryDigest, PlanDigest: participant.plan(tx)}, nil
}
func (t2Participant) Verify(context.Context, model.Transaction, engine.ParticipantReceipt) error {
	return nil
}
func (t2Participant) Commit(context.Context, model.Transaction) error   { return nil }
func (t2Participant) Abort(context.Context, model.Transaction) error    { return nil }
func (t2Participant) Activate(context.Context, model.Transaction) error { return nil }

type t2Adapter struct {
	config         Config
	identity       model.PlatformIdentity
	units          *DiskUnitStore
	systemd        CommandSystemd
	state          *store.Store
	payloads       map[string]string
	criticalPath   string
	criticalDigest string
	initial        t2ServiceObservation
	restored       t2ServiceObservation
	committed      t2ServiceObservation
	lastTarget     model.Generation
}

func (adapter *t2Adapter) Prepare(_ context.Context, tx model.Transaction) error {
	payload, ok := adapter.payloads[tx.Target.ID]
	if !ok {
		return errors.New("T2 adapter target payload is unavailable")
	}
	renderer := &TargetAdapter{Config: adapter.config, Identity: adapter.identity}
	definitions, err := renderer.renderTargetUnits(payload, tx.Target, "")
	if err != nil {
		return err
	}
	if err := adapter.units.Prepare(tx.ID, definitions); err != nil {
		return err
	}
	adapter.lastTarget = tx.Target
	return nil
}

func (adapter *t2Adapter) Quiesce(ctx context.Context, tx model.Transaction) error {
	observation, err := adapter.observe(ctx, *tx.Previous)
	if err != nil {
		return err
	}
	if adapter.initial.GenerationID == "" {
		adapter.initial = observation
	}
	return adapter.StopTarget(ctx, tx)
}

func (adapter *t2Adapter) PrepareState(_ context.Context, tx model.Transaction) (engine.ParticipantReceipt, string, error) {
	digest, err := t2FileDigest(adapter.criticalPath)
	if err != nil || digest != adapter.criticalDigest {
		return engine.ParticipantReceipt{}, "", errors.New("T2 critical state changed before activation")
	}
	members := engine.StateMemberDigests{ApplicationState: digest, Configuration: digest,
		Wallet: digest, Mining: digest, Federation: digest, PluginData: digest, Signer: digest}
	return engine.ParticipantReceipt{TransactionID: tx.ID, TargetGenerationID: tx.Target.ID,
		StateInventoryDigest: tx.StateInventoryDigest, PlanDigest: tx.StateInventoryDigest,
		MemberDigests: members}, digest, nil
}

func (adapter *t2Adapter) StopTarget(ctx context.Context, _ model.Transaction) error {
	return errors.Join(
		adapter.systemd.Stop(ctx, adapter.identity.Services["gateway"]),
		adapter.systemd.Stop(ctx, adapter.identity.Services["signer"]),
	)
}

func (adapter *t2Adapter) Activate(ctx context.Context, tx model.Transaction) error {
	if err := adapter.units.Activate(tx.ID, adapter.targetUnits()); err != nil {
		return err
	}
	if err := adapter.systemd.DaemonReload(ctx); err != nil {
		return err
	}
	for _, unit := range adapter.startOrder() {
		if err := adapter.systemd.Enable(ctx, unit); err != nil {
			return err
		}
		if err := adapter.systemd.Start(ctx, unit); err != nil {
			return err
		}
	}
	return nil
}

func (adapter *t2Adapter) Verify(ctx context.Context, tx model.Transaction) (engine.ParticipantReceipt, error) {
	observation, err := adapter.observe(ctx, tx.Target)
	if err != nil {
		return engine.ParticipantReceipt{}, err
	}
	adapter.committed = observation
	return engine.ParticipantReceipt{TransactionID: tx.ID, TargetGenerationID: tx.Target.ID,
		StateInventoryDigest: tx.StateInventoryDigest, PlanDigest: tx.Target.ID,
		EvidenceDigest: t2Digest(observation)}, nil
}

func (adapter *t2Adapter) Commit(_ context.Context, tx model.Transaction) error {
	return adapter.state.ActivateGeneration(tx.Target.ID, tx.Previous.ID, tx.PredecessorManifestSchema)
}

func (adapter *t2Adapter) Converge(ctx context.Context, tx model.Transaction) (engine.ConvergenceReceipt, error) {
	manifest, _, err := adapter.state.ReadManifest()
	if err != nil || manifest.ActiveGeneration == nil || manifest.ActiveGeneration.ID != tx.Target.ID {
		return engine.ConvergenceReceipt{}, errors.New("T2 committed manifest does not bind the target")
	}
	current, err := adapter.state.ResolveGeneration("current")
	if err != nil || current.ID != tx.Target.ID {
		return engine.ConvergenceReceipt{}, errors.New("T2 current pointer does not bind the target")
	}
	observation, err := adapter.observe(ctx, tx.Target)
	if err != nil {
		return engine.ConvergenceReceipt{}, err
	}
	adapter.committed = observation
	return engine.ConvergenceReceipt{TransactionID: tx.ID, TargetGenerationID: tx.Target.ID,
		StateInventoryDigest: tx.StateInventoryDigest, PlatformDigest: tx.PlatformDigest,
		EvidenceDigest: t2Digest(observation)}, nil
}

func (adapter *t2Adapter) Finalize(_ context.Context, tx model.Transaction) error {
	return adapter.units.Discard(tx.ID)
}

func (adapter *t2Adapter) Restore(ctx context.Context, tx model.Transaction) error {
	if tx.Previous == nil {
		return errors.New("T2 rollback has no previous generation")
	}
	if err := adapter.units.Restore(tx.ID, adapter.targetUnits()); err != nil {
		return err
	}
	if err := adapter.systemd.DaemonReload(ctx); err != nil {
		return err
	}
	if err := adapter.state.ActivateGeneration(tx.Previous.ID, "", tx.PredecessorManifestSchema); err != nil {
		return err
	}
	for _, unit := range adapter.startOrder() {
		if err := adapter.systemd.ResetFailed(ctx, unit); err != nil {
			return err
		}
		if err := adapter.systemd.Start(ctx, unit); err != nil {
			return err
		}
	}
	observation, err := adapter.observe(ctx, *tx.Previous)
	if err != nil {
		return err
	}
	adapter.restored = observation
	digest, err := t2FileDigest(adapter.criticalPath)
	if err != nil || digest != adapter.criticalDigest {
		return errors.New("T2 rollback changed critical state")
	}
	return nil
}

func (adapter *t2Adapter) Discard(_ context.Context, tx model.Transaction) error {
	return adapter.units.Discard(tx.ID)
}

func (adapter *t2Adapter) targetUnits() []string {
	return []string{adapter.identity.Services["gateway"], adapter.identity.Services["signer"]}
}

func (adapter *t2Adapter) startOrder() []string {
	return []string{adapter.identity.Services["signer"], adapter.identity.Services["gateway"]}
}

func (adapter *t2Adapter) observe(ctx context.Context, generation model.Generation) (t2ServiceObservation, error) {
	deadline := time.Now().Add(8 * time.Second)
	var last error
	for time.Now().Before(deadline) {
		observation, err := adapter.observeOnce(ctx, generation)
		if err == nil {
			return observation, nil
		}
		last = err
		time.Sleep(100 * time.Millisecond)
	}
	return t2ServiceObservation{}, fmt.Errorf("T2 service observation did not converge: %w", last)
}

func (adapter *t2Adapter) observeOnce(ctx context.Context, generation model.Generation) (t2ServiceObservation, error) {
	payload := adapter.payloads[generation.ID]
	signer, err := t2InspectProcess(ctx, adapter.systemd, adapter.identity.Services["signer"], filepath.Join(payload, "bin/fased-signerd"))
	if err != nil {
		return t2ServiceObservation{}, err
	}
	gateway, err := t2InspectProcess(ctx, adapter.systemd, adapter.identity.Services["gateway"], filepath.Join(payload, "bin/fased-gateway-launch"))
	if err != nil {
		return t2ServiceObservation{}, err
	}
	socket, err := t2InspectSocket(adapter.config.ApplicationSocket(), adapter.config.Signer.UID, adapter.config.Gateway.GID)
	if err != nil {
		return t2ServiceObservation{}, err
	}
	return t2ServiceObservation{GenerationID: generation.ID, Signer: signer, Gateway: gateway, Socket: socket}, nil
}

func t2InspectProcess(ctx context.Context, systemd CommandSystemd, unit, executable string) (t2ProcessRecord, error) {
	identity, err := systemd.Inspect(ctx, unit)
	if err != nil {
		return t2ProcessRecord{}, err
	}
	actual, err := os.Readlink(fmt.Sprintf("/proc/%d/exe", identity.MainPID))
	if err != nil || actual != executable || !strings.Contains(identity.ExecStart, executable) {
		return t2ProcessRecord{}, errors.New("T2 process executable is not generation-bound")
	}
	cgroupBytes, err := os.ReadFile(fmt.Sprintf("/proc/%d/cgroup", identity.MainPID))
	if err != nil || !strings.Contains(string(cgroupBytes), unit) {
		return t2ProcessRecord{}, errors.New("T2 process cgroup is not unit-bound")
	}
	return t2ProcessRecord{Unit: unit, MainPID: identity.MainPID, InvocationID: identity.InvocationID,
		ActiveEnterTimestampMonotonic: identity.ActiveEnterTimestampMonotonic,
		ExecStartDigest:               identity.ExecStartDigest, Executable: actual,
		Cgroup: strings.TrimSpace(string(cgroupBytes))}, nil
}

func t2InspectSocket(path string, uid, gid uint32) (t2SocketRecord, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return t2SocketRecord{}, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || info.Mode()&os.ModeSocket == 0 || info.Mode()&os.ModeSymlink != 0 || stat.Uid != uid || stat.Gid != gid || info.Mode().Perm() != 0o660 {
		return t2SocketRecord{}, errors.New("T2 signer socket identity is invalid")
	}
	return t2SocketRecord{Path: path, UID: stat.Uid, GID: stat.Gid, Mode: uint32(info.Mode().Perm())}, nil
}

func TestLifecycleT2SystemdControllerTransition(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Fatal("T2 requires one root execution")
	}
	instanceID := os.Getenv("FASED_T2_INSTANCE")
	worker := os.Getenv("FASED_T2_WORKER")
	receiptPath := os.Getenv("FASED_T2_RECEIPT_OUTPUT")
	if !instancePattern.MatchString(instanceID) || worker == "" || receiptPath == "" {
		t.Fatal("T2 fixture environment is incomplete")
	}
	operator, err := t2SourceOwner(os.Getenv("FASED_T2_SOURCE_ROOT"))
	if err != nil {
		t.Fatal(err)
	}
	fixtureGIDs, err := t2UnusedGroupIDs(instanceID, 3)
	if err != nil {
		t.Fatal(err)
	}
	gateway, signer, err := t2FixturePrincipals(operator, fixtureGIDs[0])
	if err != nil {
		t.Fatal(err)
	}
	config, err := NewConfig(model.ProfileProtectedLocal, instanceID,
		filepath.Join("/var/lib", ".fased-t2-"+instanceID, "owner", ".fased"), operator, gateway, signer)
	if err != nil {
		t.Fatal(err)
	}
	identity, err := config.Identity()
	if err != nil {
		t.Fatal(err)
	}
	systemd := CommandSystemd{Binary: "/usr/bin/systemctl"}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	createdGroups := []string{}
	t.Cleanup(func() { t2Cleanup(config, identity, systemd, createdGroups) })

	for name, gid := range map[string]uint32{
		config.GatewayGroupName():  gateway.GID,
		config.OperatorGroupName(): fixtureGIDs[1],
		config.ConfigGroupName():   fixtureGIDs[2],
	} {
		if err := t2CreateAliasGroup(name, gid); err != nil {
			t.Fatal(err)
		}
		createdGroups = append(createdGroups, name)
	}
	if err := t2PrepareRoots(config, fixtureGIDs[2]); err != nil {
		t.Fatal(err)
	}
	state, err := store.OpenLayout(store.Layout{StateRoot: config.LifecycleRoot, InstallRoot: config.InstallRoot})
	if err != nil {
		t.Fatal(err)
	}
	units, err := NewDiskUnitStore(config, "target")
	if err != nil {
		t.Fatal(err)
	}

	capabilities := model.CapabilityRanges{
		Supervisor: model.CapabilityRange{Min: 1, Max: 1}, Controller: model.CapabilityRange{Min: 1, Max: 1},
		Migrator: model.CapabilityRange{Min: 1, Max: 1}, Signer: model.CapabilityRange{Min: 2, Max: 2},
	}
	stateSchemas := map[string]uint32{"signer": 2}
	retainedDependency, err := t2ImportDependency(state, config.LifecycleRoot, "retained")
	if err != nil {
		t.Fatal(err)
	}
	staleDependency, err := t2ImportDependency(state, config.LifecycleRoot, "stale")
	if err != nil {
		t.Fatal(err)
	}
	generationA, payloadA, err := t2PrepareGeneration(config, worker, "a", "1.2.2", retainedDependency, stateSchemas, capabilities)
	if err != nil {
		t.Fatal(err)
	}
	generationB, payloadB, err := t2PrepareGeneration(config, worker, "b", "1.2.3", retainedDependency, stateSchemas, capabilities)
	if err != nil {
		t.Fatal(err)
	}
	payloads := map[string]string{generationA.ID: payloadA, generationB.ID: payloadB}
	if err := os.WriteFile(filepath.Join(payloadB, "fail-first-start"), []byte("fail\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	criticalPath := filepath.Join(config.OwnerStateRoot, "critical-state.json")
	criticalDigest, err := t2FileDigest(criticalPath)
	if err != nil {
		t.Fatal(err)
	}
	manifestDigest, err := state.CommitManifest(model.Manifest{SchemaVersion: model.CurrentManifestSchemaVersion,
		Profile: config.Profile, Platform: identity, ActiveGeneration: &generationA,
		StateSchemas: stateSchemas, Capabilities: capabilities, ReleaseSequence: 1, SecurityEpoch: 1}, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := state.ActivateGeneration(generationA.ID, "", 0); err != nil {
		t.Fatal(err)
	}
	renderer := &TargetAdapter{Config: config, Identity: identity}
	initialTransaction := t2UUID()
	definitions, err := renderer.renderTargetUnits(payloads[generationA.ID], generationA, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := units.Prepare(initialTransaction, definitions); err != nil {
		t.Fatal(err)
	}
	if err := units.Activate(initialTransaction, []string{identity.Services["gateway"], identity.Services["signer"]}); err != nil {
		t.Fatal(err)
	}
	if err := systemd.DaemonReload(ctx); err != nil {
		t.Fatal(err)
	}
	for _, unit := range []string{identity.Services["signer"], identity.Services["gateway"]} {
		if err := systemd.Enable(ctx, unit); err != nil {
			t.Fatal(err)
		}
		if err := systemd.Start(ctx, unit); err != nil {
			t.Fatal(err)
		}
	}

	adapter := &t2Adapter{config: config, identity: identity, units: units, systemd: systemd,
		state: state, payloads: payloads, criticalPath: criticalPath, criticalDigest: criticalDigest}
	initial, err := adapter.observe(ctx, generationA)
	if err != nil {
		t.Fatal(err)
	}
	adapter.initial = initial
	failedTx := t2Transaction(t2UUID(), identity, generationA, generationB, manifestDigest, criticalDigest, capabilities, stateSchemas)
	result, runErr := t2Supervisor(state, adapter, payloads).Run(ctx, failedTx)
	if runErr == nil || result.Outcome != engine.OutcomeRolledBack || adapter.restored.GenerationID != generationA.ID {
		t.Fatalf("injected first start failure did not roll back exactly: result=%+v err=%v", result, runErr)
	}
	afterRollback, err := t2FileDigest(criticalPath)
	if err != nil || afterRollback != criticalDigest {
		t.Fatal("critical state changed across rollback")
	}
	if adapter.restored.Signer.Executable != filepath.Join(payloads[generationA.ID], "bin/fased-signerd") ||
		adapter.restored.Gateway.Executable != filepath.Join(payloads[generationA.ID], "bin/fased-gateway-launch") ||
		adapter.restored.Signer.InvocationID == initial.Signer.InvocationID || adapter.restored.Gateway.InvocationID == initial.Gateway.InvocationID {
		t.Fatal("rollback did not restart the exact A generation with new process identities")
	}

	if err := os.Remove(filepath.Join(payloads[generationB.ID], "fail-first-start")); err != nil {
		t.Fatal(err)
	}
	retryTx := t2Transaction(t2UUID(), identity, generationA, generationB, manifestDigest, criticalDigest, capabilities, stateSchemas)
	result, err = t2Supervisor(state, adapter, payloads).Run(ctx, retryTx)
	if err != nil || result.Outcome != engine.OutcomeUpdated || result.ActiveGenerationID != generationB.ID {
		t.Fatalf("T2 retry did not commit B: result=%+v err=%v", result, err)
	}
	afterCommit, err := t2FileDigest(criticalPath)
	if err != nil || afterCommit != criticalDigest {
		t.Fatal("critical state changed across committed retry")
	}
	if adapter.committed.Signer.Executable != filepath.Join(payloads[generationB.ID], "bin/fased-signerd") ||
		adapter.committed.Gateway.Executable != filepath.Join(payloads[generationB.ID], "bin/fased-gateway-launch") {
		t.Fatal("committed services are not bound to generation B")
	}
	retention, err := t2PruneCommittedState(state, config, generationA, generationB, staleDependency)
	if err != nil {
		t.Fatal(err)
	}
	receipt := t2Receipt{SchemaVersion: 1, Status: "PASS", InstanceID: instanceID,
		SourceCommit: os.Getenv("FASED_T2_SOURCE_COMMIT"), SourceTree: os.Getenv("FASED_T2_SOURCE_TREE"),
		FailureInjected: true, ExactRollback: true, RetryCommitted: true,
		CriticalBefore: criticalDigest, CriticalAfterRollback: afterRollback, CriticalAfterCommit: afterCommit,
		Initial: initial, Restored: adapter.restored, Committed: adapter.committed, Retention: retention,
		ConvergenceReceipt: result.ConvergenceReceiptDigest}
	data, err := json.MarshalIndent(receipt, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	receiptFile, err := os.OpenFile(receiptPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := receiptFile.Write(append(data, '\n')); err != nil {
		_ = receiptFile.Close()
		t.Fatal(err)
	}
	if err := receiptFile.Close(); err != nil {
		t.Fatal(err)
	}
	t.Logf("T2_RECEIPT=%s", receiptPath)
}

func t2Supervisor(state *store.Store, adapter *t2Adapter, payloads map[string]string) *engine.SupervisorEngine {
	participant := t2Participant{plan: func(tx model.Transaction) string { return tx.SignerPlanDigest }}
	migrator := t2Participant{plan: func(tx model.Transaction) string { return tx.MigrationPlanDigest }}
	target := &engine.TargetEngine{Journal: state, Generations: t2GenerationStore{payloads: payloads},
		Signer: participant, Migrator: migrator, Adapter: adapter,
		Installation: &ManifestCommitter{Store: state, Identity: adapter.identity}}
	return &engine.SupervisorEngine{Journal: state, Target: target}
}

func t2Transaction(id string, identity model.PlatformIdentity, previous, target model.Generation, manifestDigest, stateDigest string, capabilities model.CapabilityRanges, schemas map[string]uint32) model.Transaction {
	platformDigest, _ := identity.Digest(model.ProfileProtectedLocal)
	return model.Transaction{SchemaVersion: model.CurrentTransactionSchemaVersion, ID: id,
		Profile: model.ProfileProtectedLocal, PlanAction: "UPDATE", ReleaseSequence: 2, SecurityEpoch: 1,
		ReleaseIndexDigest: t2Digest("release-index"), ReleaseAuthorityDigest: t2Digest("release-authority"),
		TargetManifestProtocolMin: model.CurrentManifestSchemaVersion, TargetManifestProtocolMax: model.CurrentManifestSchemaVersion,
		PredecessorManifestSchema: model.CurrentManifestSchemaVersion, PredecessorPlatform: &identity,
		Phase: model.PhaseIdle, Revision: 1, Target: target, TargetStateSchemas: schemas, TargetCapabilities: capabilities,
		Previous: &previous, ManifestDigest: manifestDigest, StateInventoryDigest: stateDigest,
		MigrationPlanDigest: t2Digest("migration-plan"), SignerPlanDigest: t2Digest("signer-plan"), PlatformDigest: platformDigest}
}

func t2Generation(value, version string) model.Generation {
	return model.Generation{ID: "sha256:" + strings.Repeat(value, 64), Version: version,
		Commit: strings.Repeat(value, 40), Tree: strings.Repeat(value, 40), ArtifactSetDigest: "sha256:" + strings.Repeat(value, 64)}
}

func t2PrepareRoots(config Config, configGID uint32) error {
	for _, path := range []string{config.InstallRoot, config.LifecycleRoot, config.ProductStateRoot,
		config.SignerStateRoot(), filepath.Dir(config.UpdateGatePath()), config.OwnerStateRoot} {
		if err := os.MkdirAll(path, 0o755); err != nil {
			return err
		}
	}
	if err := os.Chown(config.OwnerStateRoot, int(config.Operator.UID), int(configGID)); err != nil {
		return err
	}
	if err := os.Chmod(config.OwnerStateRoot, 0o2770); err != nil {
		return err
	}
	if err := os.Chown(config.SignerStateRoot(), int(config.Signer.UID), int(config.Signer.GID)); err != nil {
		return err
	}
	if err := os.Chmod(config.SignerStateRoot(), 0o700); err != nil {
		return err
	}
	critical := []byte("{\"wallet\":\"preserved\",\"signer\":\"v2\"}\n")
	criticalPath := filepath.Join(config.OwnerStateRoot, "critical-state.json")
	if err := os.WriteFile(criticalPath, critical, 0o660); err != nil {
		return err
	}
	return os.Chown(criticalPath, int(config.Operator.UID), int(configGID))
}

func t2PrepareGeneration(config Config, worker, label, version string, dependency bundle.DependencyLayer, schemas map[string]uint32, capabilities model.CapabilityRanges) (model.Generation, string, error) {
	staging := filepath.Join(config.InstallRoot, ".t2-generation-"+label)
	if err := os.MkdirAll(filepath.Join(staging, "bin"), 0o755); err != nil {
		return model.Generation{}, "", err
	}
	if err := os.MkdirAll(filepath.Join(staging, "runtime"), 0o755); err != nil {
		return model.Generation{}, "", err
	}
	for _, binary := range []string{"fased-signerd", "fased-gateway-launch"} {
		data, err := os.ReadFile(worker)
		if err != nil {
			return model.Generation{}, "", err
		}
		if err := os.WriteFile(filepath.Join(staging, "bin", binary), data, 0o755); err != nil {
			return model.Generation{}, "", err
		}
	}
	if err := os.WriteFile(filepath.Join(staging, "runtime.txt"), []byte("T2 generation "+label+"\n"), 0o644); err != nil {
		return model.Generation{}, "", err
	}
	inventory, generation, err := bundle.InspectWithDependency(staging, version, strings.Repeat(label, 40), strings.Repeat(label, 40), schemas, capabilities, dependency)
	if err != nil {
		return model.Generation{}, "", err
	}
	root := filepath.Join(config.InstallRoot, "generations", strings.TrimPrefix(generation.ID, "sha256:"))
	if err := os.MkdirAll(root, 0o711); err != nil {
		return model.Generation{}, "", err
	}
	payload := filepath.Join(root, "payload")
	if err := os.Rename(staging, payload); err != nil {
		return model.Generation{}, "", err
	}
	data, err := bundle.CanonicalInventoryJSON(inventory)
	if err != nil {
		return model.Generation{}, "", err
	}
	if err := os.WriteFile(filepath.Join(root, "inventory.json"), data, 0o600); err != nil {
		return model.Generation{}, "", err
	}
	if err := os.Chmod(root, 0o711); err != nil {
		return model.Generation{}, "", err
	}
	return generation, payload, nil
}

func t2ImportDependency(state *store.Store, lifecycleRoot, label string) (bundle.DependencyLayer, error) {
	var raw bytes.Buffer
	compressed := gzip.NewWriter(&raw)
	archive := tar.NewWriter(compressed)
	if err := archive.WriteHeader(&tar.Header{Name: "node_modules", Typeflag: tar.TypeDir, Mode: 0o755}); err != nil {
		return bundle.DependencyLayer{}, err
	}
	contents := []byte("T2 dependency " + label + "\n")
	if err := archive.WriteHeader(&tar.Header{Name: "node_modules/t2-" + label + ".txt", Typeflag: tar.TypeReg, Mode: 0o644, Size: int64(len(contents))}); err != nil {
		return bundle.DependencyLayer{}, err
	}
	if _, err := archive.Write(contents); err != nil {
		return bundle.DependencyLayer{}, err
	}
	if err := archive.Close(); err != nil {
		return bundle.DependencyLayer{}, err
	}
	if err := compressed.Close(); err != nil {
		return bundle.DependencyLayer{}, err
	}
	digest := sha256.Sum256(raw.Bytes())
	layer := bundle.DependencyLayer{Hash: strings.TrimPrefix(t2Digest("dependency-"+label), "sha256:"), Asset: "fased-deps-linux-x64.tar.gz", ArchiveSHA256: "sha256:" + hex.EncodeToString(digest[:])}
	path := filepath.Join(lifecycleRoot, "t2-dependency-"+label+".tar.gz")
	if err := os.WriteFile(path, raw.Bytes(), 0o600); err != nil {
		return bundle.DependencyLayer{}, err
	}
	if err := state.ImportDependencyArchive(path, layer); err != nil {
		return bundle.DependencyLayer{}, err
	}
	return layer, nil
}

func t2PruneCommittedState(state *store.Store, config Config, previous, active model.Generation, staleDependency bundle.DependencyLayer) (t2RetentionObservation, error) {
	manifest, _, err := state.ReadManifest()
	if err != nil || manifest.ActiveGeneration == nil || manifest.PreviousGeneration == nil || manifest.ActiveGeneration.ID != active.ID || manifest.PreviousGeneration.ID != previous.ID {
		return t2RetentionObservation{}, errors.New("T2 committed manifest does not retain the active and previous rollback window")
	}
	current, err := state.ResolveGeneration("current")
	if err != nil || current.ID != active.ID {
		return t2RetentionObservation{}, errors.New("T2 current pointer does not retain the committed active generation")
	}
	previousPointer, err := state.ResolveGeneration("previous")
	if err != nil || previousPointer.ID != previous.ID {
		return t2RetentionObservation{}, errors.New("T2 previous pointer does not retain the committed rollback generation")
	}
	stale := t2Generation("c", "1.2.1")
	stalePath := filepath.Join(config.InstallRoot, "generations", strings.TrimPrefix(stale.ID, "sha256:"))
	if err := os.MkdirAll(stalePath, 0o711); err != nil {
		return t2RetentionObservation{}, err
	}
	removedGenerations, err := state.PruneGenerations()
	if err != nil || len(removedGenerations) != 1 || removedGenerations[0] != stale.ID {
		return t2RetentionObservation{}, fmt.Errorf("T2 generation pruning outcome=%v err=%v", removedGenerations, err)
	}
	if _, err := os.Lstat(stalePath); !errors.Is(err, os.ErrNotExist) {
		return t2RetentionObservation{}, errors.New("T2 stale generation survived production pruning")
	}
	removedDependencies, err := state.PruneDependencies()
	wantDependency := staleDependency.Hash + "-" + strings.TrimPrefix(staleDependency.ArchiveSHA256, "sha256:")
	if err != nil || len(removedDependencies) != 1 || removedDependencies[0] != wantDependency {
		return t2RetentionObservation{}, fmt.Errorf("T2 dependency pruning outcome=%v err=%v", removedDependencies, err)
	}
	inbox, err := acquire.OpenInbox(config.LifecycleRoot, 0)
	if err != nil {
		return t2RetentionObservation{}, err
	}
	defer inbox.Close()
	contents := []byte("T2 committed acquisition object\n")
	digest := sha256.Sum256(contents)
	object, err := inbox.Put(context.Background(), trust.Asset{Name: "t2-committed.asset", Size: uint64(len(contents)), SHA256: "sha256:" + hex.EncodeToString(digest[:])}, bytes.NewReader(contents))
	if err != nil {
		return t2RetentionObservation{}, err
	}
	if err := object.Close(); err != nil {
		return t2RetentionObservation{}, err
	}
	removedInboxObjects, err := inbox.Prune()
	if err != nil || removedInboxObjects != 1 {
		return t2RetentionObservation{}, fmt.Errorf("T2 inbox pruning outcome=%d err=%v", removedInboxObjects, err)
	}
	return t2RetentionObservation{ActiveGenerationID: active.ID, PreviousGenerationID: previous.ID, CurrentPointer: current.ID, PreviousPointer: previousPointer.ID, RemovedGenerations: removedGenerations, RemovedDependencies: removedDependencies, RemovedInboxObjects: removedInboxObjects}, nil
}

func t2FixturePrincipals(operator Principal, serviceGID uint32) (Principal, Principal, error) {
	nobody, err := user.Lookup("nobody")
	if err != nil {
		return Principal{}, Principal{}, err
	}
	daemon, err := user.Lookup("daemon")
	if err != nil {
		return Principal{}, Principal{}, err
	}
	nobodyUID, _ := strconv.ParseUint(nobody.Uid, 10, 32)
	daemonUID, _ := strconv.ParseUint(daemon.Uid, 10, 32)
	if nobodyUID == 0 || daemonUID == 0 || serviceGID == 0 || uint32(daemonUID) == operator.UID {
		return Principal{}, Principal{}, errors.New("T2 fixture principals are unavailable")
	}
	return Principal{UID: uint32(nobodyUID), GID: serviceGID}, Principal{UID: uint32(daemonUID), GID: serviceGID}, nil
}

func t2UnusedGroupIDs(instanceID string, count int) ([]uint32, error) {
	seed := sha256.Sum256([]byte(instanceID))
	start := 40000 + int(seed[0])<<4 + int(seed[1]&0x0f)
	result := make([]uint32, 0, count)
	for offset := 0; offset < 20000 && len(result) < count; offset++ {
		gid := uint32(40000 + (start-40000+offset)%20000)
		if _, err := user.LookupGroupId(strconv.FormatUint(uint64(gid), 10)); err == nil {
			continue
		}
		result = append(result, gid)
	}
	if len(result) != count {
		return nil, errors.New("T2 could not allocate unused fixture group identities")
	}
	return result, nil
}

func t2SourceOwner(path string) (Principal, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return Principal{}, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || stat.Uid == 0 || stat.Gid == 0 {
		return Principal{}, errors.New("T2 source root must belong to its non-root operator")
	}
	return Principal{UID: stat.Uid, GID: stat.Gid}, nil
}

func t2CreateAliasGroup(name string, gid uint32) error {
	if _, err := user.LookupGroup(name); err == nil {
		return fmt.Errorf("T2 alias group already exists: %s", name)
	}
	command := exec.Command("/usr/sbin/groupadd", "--non-unique", "--gid", strconv.FormatUint(uint64(gid), 10), name)
	output, err := command.CombinedOutput()
	if err != nil {
		return fmt.Errorf("create T2 alias group %s: %w: %s", name, err, output)
	}
	return nil
}

func t2Cleanup(config Config, identity model.PlatformIdentity, systemd CommandSystemd, groups []string) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	for _, unit := range []string{identity.Services["gateway"], identity.Services["signer"]} {
		_ = systemd.Stop(ctx, unit)
		_ = systemd.Disable(ctx, unit)
		_ = os.Remove(filepath.Join(config.UnitRoot, unit))
	}
	_ = systemd.DaemonReload(ctx)
	_ = os.RemoveAll(config.InstallRoot)
	_ = os.RemoveAll(filepath.Join("/var/lib", ".fased-t2-"+config.InstanceID))
	_ = os.RemoveAll(config.ProductStateRoot)
	for _, name := range groups {
		_ = exec.Command("/usr/sbin/groupdel", "--force", name).Run()
	}
}

func t2FileDigest(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(data)
	return "sha256:" + hex.EncodeToString(digest[:]), nil
}

func t2Digest(value any) string {
	data, _ := json.Marshal(value)
	digest := sha256.Sum256(data)
	return "sha256:" + hex.EncodeToString(digest[:])
}

func t2UUID() string {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		panic(err)
	}
	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", value[0:4], value[4:6], value[6:8], value[8:10], value[10:16])
}

var _ engine.MigratorParticipant = t2Participant{}
var _ engine.PlatformAdapter = (*t2Adapter)(nil)
