package platform

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"fased-lifecycled/engine"
	"fased-lifecycled/model"
)

type fakeControllerGenerations struct {
	root  string
	calls *[]string
}

func (generations fakeControllerGenerations) GenerationPayloadPath(string) (string, error) {
	return generations.root, nil
}
func (generations fakeControllerGenerations) ActivateControllerGeneration(current, previous string) error {
	*generations.calls = append(*generations.calls, "controller.activate:"+current+":"+previous)
	return nil
}

func TestControllerAdapterUsesIndependentVerifiedHandoff(t *testing.T) {
	tx, identity := manifestTransaction(t, false)
	operator, gateway, signer := principals()
	config, err := NewConfig(model.ProfileProtectedLocal, "example", "/home/example/.fased", operator, gateway, signer)
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	entrypoint := filepath.Join(root, "bin", "fased-lifecycled")
	if err := os.MkdirAll(filepath.Dir(entrypoint), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(entrypoint, []byte("binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	calls := []string{}
	units := &fakeUnits{calls: &calls}
	adapter := ControllerAdapter{Config: config, Identity: identity, Units: units,
		Systemd: fakeSystemd{calls: &calls}, Generations: fakeControllerGenerations{root: root, calls: &calls}}
	ctx := context.Background()
	if err := adapter.Stage(ctx, tx); err != nil {
		t.Fatal(err)
	}
	if err := adapter.Prepare(ctx, tx); err != nil {
		t.Fatal(err)
	}
	if err := adapter.Switch(ctx, tx); err != nil {
		t.Fatal(err)
	}
	if err := adapter.Verify(ctx, tx, engine.Result{Outcome: engine.OutcomePrepared, Phase: model.PhaseVerified}); err != nil {
		t.Fatal(err)
	}
	if err := adapter.Commit(ctx, tx); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"units.prepare", "systemd.stop:fased-local-controller-worker-example.service",
		"units.activate", "systemd.reload", "systemd.enable:fased-local-controller-worker-example.service",
		"systemd.start:fased-local-controller-worker-example.service", "systemd.active:fased-local-controller-worker-example.service",
		"controller.activate:" + digestB + ":" + digestA, "units.discard",
	}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("unexpected controller order:\n got=%v\nwant=%v", calls, want)
	}
	definition := string(units.definitions[identity.Services["controller"]])
	if !strings.Contains(definition, "--socket /run/fased-local-controller-worker/example/controller.sock") || strings.Contains(definition, "/controller/controller.sock") {
		t.Fatalf("controller unit socket is not canonical:\n%s", definition)
	}
	if strings.Contains(definition, "/bin/sh") || !strings.Contains(definition, "RestrictAddressFamilies=AF_UNIX") {
		t.Fatalf("controller unit is not narrow and direct:\n%s", definition)
	}
}

func TestControllerVerifyRejectsUnverifiedTarget(t *testing.T) {
	adapter, tx, _ := targetAdapter(t)
	controller := ControllerAdapter{Config: adapter.Config, Identity: adapter.Identity, Units: adapter.Units,
		Systemd: adapter.Systemd, Generations: fakeControllerGenerations{root: t.TempDir(), calls: &[]string{}}}
	if err := controller.Verify(context.Background(), tx, engine.Result{Outcome: engine.OutcomeRolledBack, Phase: model.PhaseRolledBack}); err == nil {
		t.Fatal("controller accepted a rolled-back target handoff")
	}
}
