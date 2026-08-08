package migrator

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"fased-lifecycled/engine"
	"fased-lifecycled/model"
)

const digestA = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const digestB = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
const commitA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const commitB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

func transaction() model.Transaction {
	previous := model.Generation{ID: digestA, Version: "0.1.75", Commit: commitA, Tree: commitA, ArtifactSetDigest: digestA}
	return model.Transaction{
		SchemaVersion: model.CurrentTransactionSchemaVersion, ID: "018f47d2-5a6b-7c8d-9e0f-123456789abc",
		Profile: model.ProfileProtectedLocal, Phase: model.PhasePrepared, Revision: 3,
		Target: model.Generation{ID: digestB, Version: "0.1.76", Commit: commitB, Tree: commitB, ArtifactSetDigest: digestB}, Previous: &previous,
		ManifestDigest: digestA, StateInventoryDigest: digestB, MigrationPlanDigest: digestA, SignerPlanDigest: digestB, PlatformDigest: digestA,
		Migrations: []model.Migration{{State: "managedInstall", From: 1, To: 2}, {State: "signer", From: 1, To: 2}},
	}
}

type fakeAdapter struct {
	name   string
	calls  *[]string
	failAt string
}

func (adapter fakeAdapter) call(operation string) error {
	*adapter.calls = append(*adapter.calls, adapter.name+"."+operation)
	if adapter.failAt == operation {
		return errors.New("injected failure")
	}
	return nil
}

func (adapter fakeAdapter) Prepare(context.Context, model.Transaction, model.Migration) error {
	return adapter.call("prepare")
}
func (adapter fakeAdapter) Activate(context.Context, model.Transaction, model.Migration) error {
	return adapter.call("activate")
}
func (adapter fakeAdapter) Verify(context.Context, model.Transaction, model.Migration) error {
	return adapter.call("verify")
}
func (adapter fakeAdapter) Commit(context.Context, model.Transaction, model.Migration) error {
	return adapter.call("commit")
}
func (adapter fakeAdapter) Abort(context.Context, model.Transaction, model.Migration) error {
	return adapter.call("abort")
}

func TestExplicitMigratorRunsOrderedPlanAndReverseAbort(t *testing.T) {
	var calls []string
	migrator := SchemaMigrator{Registry: map[Key]Adapter{
		{State: "managedInstall", From: 1, To: 2}: fakeAdapter{name: "application", calls: &calls},
		{State: "signer", From: 1, To: 2}:         fakeAdapter{name: "signer-owner", calls: &calls},
	}}
	tx := transaction()
	receipt, err := migrator.Prepare(context.Background(), tx)
	if err != nil {
		t.Fatal(err)
	}
	if err := migrator.Activate(context.Background(), tx); err != nil {
		t.Fatal(err)
	}
	if err := migrator.Verify(context.Background(), tx, receipt); err != nil {
		t.Fatal(err)
	}
	if err := migrator.Commit(context.Background(), tx); err != nil {
		t.Fatal(err)
	}
	if err := migrator.Abort(context.Background(), tx); err != nil {
		t.Fatal(err)
	}
	wantTail := []string{"signer-owner.abort", "application.abort"}
	if !reflect.DeepEqual(calls[len(calls)-2:], wantTail) {
		t.Fatalf("abort was not reverse ordered: %v", calls)
	}
}

func TestMigratorFailsClosedWithoutExactAdapter(t *testing.T) {
	tx := transaction()
	migrator := SchemaMigrator{Registry: map[Key]Adapter{}}
	if _, err := migrator.Prepare(context.Background(), tx); err == nil {
		t.Fatal("missing migration adapter was accepted")
	}
}

func TestMigratorRejectsReceiptRebinding(t *testing.T) {
	var calls []string
	migrator := SchemaMigrator{Registry: map[Key]Adapter{
		{State: "managedInstall", From: 1, To: 2}: fakeAdapter{name: "application", calls: &calls},
		{State: "signer", From: 1, To: 2}:         fakeAdapter{name: "signer-owner", calls: &calls},
	}}
	rebound := engine.ParticipantReceipt{TransactionID: transaction().ID, PlanDigest: digestB}
	if err := migrator.Verify(context.Background(), transaction(), rebound); err == nil {
		t.Fatal("rebound migration receipt was accepted")
	}
}
