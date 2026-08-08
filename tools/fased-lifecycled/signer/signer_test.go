package signer

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"fased-lifecycled/model"
	"fased-lifecycled/platform"
)

const digestA = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const digestB = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
const commitA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

type fakeCaller struct {
	calls     *[]string
	failAbort bool
}

func (caller fakeCaller) Call(_ context.Context, operation string, request UpgradeRequest) (UpgradeReceipt, error) {
	*caller.calls = append(*caller.calls, operation)
	if operation == "v2.lifecycle.upgrade.abort" && caller.failAbort {
		return UpgradeReceipt{}, errors.New("signer is offline")
	}
	phase := map[string]string{
		"v2.lifecycle.upgrade.prepare": "prepared", "v2.lifecycle.upgrade.verify": "verified",
		"v2.lifecycle.upgrade.commit": "committed", "v2.lifecycle.upgrade.abort": "aborted",
	}[operation]
	return UpgradeReceipt{TransactionID: request.TransactionID, TargetGenerationID: request.TargetGenerationID,
		StateInventoryDigest: request.StateInventoryDigest, PlanDigest: request.PlanDigest,
		FromSchema: request.FromSchema, ToSchema: request.ToSchema, Phase: phase}, nil
}

type fakeOffline struct{ calls *[]string }

func (offline fakeOffline) Abort(_ context.Context, binary, stateDB string, _ UpgradeRequest, _ platform.Principal) error {
	*offline.calls = append(*offline.calls, "offline:"+filepath.Base(binary)+":"+filepath.Base(stateDB))
	return nil
}

type fakeResolver struct{ root string }

func (resolver fakeResolver) GenerationPayloadPath(string) (string, error) { return resolver.root, nil }

func participantAndTransaction(t *testing.T, fresh, failAbort bool) (*Participant, model.Transaction, *[]string) {
	t.Helper()
	operator := platform.Principal{UID: 1000, GID: 1000}
	gateway := platform.Principal{UID: 997, GID: 997}
	signer := platform.Principal{UID: uint32(os.Geteuid()), GID: uint32(os.Getegid())}
	if signer == operator || signer == gateway || signer.UID == 0 || signer.GID == 0 {
		signer = platform.Principal{UID: 996, GID: 996}
	}
	config, err := platform.NewConfig(model.ProfileProtectedLocal, "example", "/home/example/.fased", operator, gateway, signer)
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	payload := t.TempDir()
	if err := os.MkdirAll(filepath.Join(payload, "bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(payload, "bin", "fased-signerd"), []byte("binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	calls := []string{}
	participant := &Participant{Config: config, Caller: fakeCaller{calls: &calls, failAbort: failAbort},
		Offline: fakeOffline{calls: &calls}, Generations: fakeResolver{root: payload}, ExpectedGateUID: os.Geteuid(), rootPrefix: root}
	from := uint32(1)
	if fresh {
		from = 0
	}
	tx := model.Transaction{SchemaVersion: 1, ID: "018f47d2-5a6b-7c8d-9e0f-123456789abc", Profile: model.ProfileProtectedLocal,
		Phase: model.PhaseStaged, Revision: 2,
		Target:             model.Generation{ID: digestB, Version: "0.1.76", Commit: commitA, Tree: commitA, ArtifactSetDigest: digestB},
		TargetStateSchemas: map[string]uint32{"signer": 2}, TargetCapabilities: model.CapabilityRanges{
			Supervisor: model.CapabilityRange{Min: 1, Max: 1}, Controller: model.CapabilityRange{Min: 1, Max: 1},
			Migrator: model.CapabilityRange{Min: 1, Max: 1}, Signer: model.CapabilityRange{Min: 1, Max: 1}},
		ManifestDigest: digestA, StateInventoryDigest: digestA, MigrationPlanDigest: digestA,
		SignerPlanDigest: digestB, PlatformDigest: digestA,
		Migrations: []model.Migration{{State: "signer", From: from, To: 2}},
	}
	return participant, tx, &calls
}

func TestSignerParticipantBindsLivePrepareVerifyAndCommit(t *testing.T) {
	participant, tx, calls := participantAndTransaction(t, false, false)
	receipt, err := participant.Prepare(context.Background(), tx)
	if err != nil {
		t.Fatal(err)
	}
	if err := participant.Verify(context.Background(), tx, receipt); err != nil {
		t.Fatal(err)
	}
	if err := participant.Commit(context.Background(), tx); err != nil {
		t.Fatal(err)
	}
	want := []string{"v2.lifecycle.upgrade.prepare", "v2.lifecycle.upgrade.verify", "v2.lifecycle.upgrade.commit"}
	if !reflect.DeepEqual(*calls, want) {
		t.Fatalf("unexpected signer order: got=%v want=%v", *calls, want)
	}
	if _, err := os.Lstat(participant.resolve(participant.Config.UpdateGatePath())); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("committed signer gate remains: %v", err)
	}
}

func TestSignerAbortFallsBackToOfflineExactGeneration(t *testing.T) {
	participant, tx, calls := participantAndTransaction(t, false, true)
	if _, err := participant.Prepare(context.Background(), tx); err != nil {
		t.Fatal(err)
	}
	if err := participant.Abort(context.Background(), tx); err != nil {
		t.Fatal(err)
	}
	want := []string{"v2.lifecycle.upgrade.prepare", "v2.lifecycle.upgrade.abort", "offline:fased-signerd:state.db"}
	if !reflect.DeepEqual(*calls, want) {
		t.Fatalf("unexpected offline rollback: got=%v want=%v", *calls, want)
	}
}

func TestFreshSignerUsesGateWithoutCallingMissingOldSigner(t *testing.T) {
	participant, tx, calls := participantAndTransaction(t, true, false)
	receipt, err := participant.Prepare(context.Background(), tx)
	if err != nil {
		t.Fatal(err)
	}
	if err := participant.Verify(context.Background(), tx, receipt); err != nil {
		t.Fatal(err)
	}
	if err := participant.Commit(context.Background(), tx); err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 0 {
		t.Fatalf("fresh signer called a predecessor: %v", *calls)
	}
}
