package platform

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"fased-lifecycled/model"
)

type fakeUnits struct {
	calls       *[]string
	definitions map[string][]byte
}

type fakeLifecycleFiles struct{ calls *[]string }

func (files fakeLifecycleFiles) Prepare(string, map[string]LifecycleFile) error {
	*files.calls = append(*files.calls, "files.prepare")
	return nil
}
func (files fakeLifecycleFiles) Activate(string, []string) error {
	*files.calls = append(*files.calls, "files.activate")
	return nil
}
func (files fakeLifecycleFiles) Restore(string, []string) error {
	*files.calls = append(*files.calls, "files.restore")
	return nil
}
func (files fakeLifecycleFiles) Discard(string) error {
	*files.calls = append(*files.calls, "files.discard")
	return nil
}

func (units *fakeUnits) Prepare(_ string, definitions map[string][]byte) error {
	*units.calls = append(*units.calls, "units.prepare")
	units.definitions = definitions
	return nil
}
func (units *fakeUnits) Activate(string, []string) error {
	*units.calls = append(*units.calls, "units.activate")
	return nil
}
func (units *fakeUnits) Restore(string, []string) error {
	*units.calls = append(*units.calls, "units.restore")
	return nil
}
func (units *fakeUnits) Discard(string) error {
	*units.calls = append(*units.calls, "units.discard")
	return nil
}

type fakeSystemd struct {
	calls *[]string
	fail  string
}

func (systemd fakeSystemd) call(name string) error {
	*systemd.calls = append(*systemd.calls, name)
	if systemd.fail == name {
		return errors.New("injected systemd failure")
	}
	return nil
}
func (systemd fakeSystemd) DaemonReload(context.Context) error { return systemd.call("systemd.reload") }
func (systemd fakeSystemd) Stop(_ context.Context, unit string) error {
	return systemd.call("systemd.stop:" + unit)
}
func (systemd fakeSystemd) Start(_ context.Context, unit string) error {
	return systemd.call("systemd.start:" + unit)
}
func (systemd fakeSystemd) Enable(_ context.Context, unit string) error {
	return systemd.call("systemd.enable:" + unit)
}
func (systemd fakeSystemd) Disable(_ context.Context, unit string) error {
	return systemd.call("systemd.disable:" + unit)
}
func (systemd fakeSystemd) IsEnabled(_ context.Context, unit string) error {
	return systemd.call("systemd.enabled:" + unit)
}
func (systemd fakeSystemd) IsActive(_ context.Context, unit string) error {
	return systemd.call("systemd.active:" + unit)
}

type fakeGenerations struct {
	root       string
	dependency string
	calls      *[]string
}

type fakeHealth struct{ calls *[]string }

func (health fakeHealth) Verify(_ context.Context, port uint16, target model.Generation) error {
	*health.calls = append(*health.calls, fmt.Sprintf("gateway.ready:%d:%s:%s", port, target.Version, target.Commit))
	return nil
}

func (generations fakeGenerations) GenerationPayloadPath(string) (string, error) {
	return generations.root, nil
}
func (generations fakeGenerations) GenerationDependencyPath(string) (string, error) {
	return generations.dependency, nil
}
func (generations fakeGenerations) ActivateGeneration(current, previous string) error {
	*generations.calls = append(*generations.calls, "generation.activate:"+current+":"+previous)
	return nil
}

func targetAdapter(t *testing.T) (*TargetAdapter, model.Transaction, *[]string) {
	t.Helper()
	tx, identity := manifestTransaction(t, false)
	root := t.TempDir()
	for _, name := range []string{"fased-gateway-launch", "fased-signerd"} {
		path := filepath.Join(root, "bin", name)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("binary"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	helper := filepath.Join(root, "runtime", "scripts", "fased-signer-owner-hosting.sh")
	if err := os.MkdirAll(filepath.Dir(helper), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(helper, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	operator, gateway, signer := principals()
	config, err := NewConfig(model.ProfileProtectedLocal, "example", "/home/example/.fased", operator, gateway, signer)
	if err != nil {
		t.Fatal(err)
	}
	calls := []string{}
	return &TargetAdapter{Config: config, Identity: identity, Units: &fakeUnits{calls: &calls}, Files: fakeLifecycleFiles{calls: &calls}, Systemd: fakeSystemd{calls: &calls}, Generations: fakeGenerations{root: root, dependency: filepath.Join(root, "dependencies", "node_modules"), calls: &calls}, Health: fakeHealth{calls: &calls}, Predecessor: NoPredecessor{}, Network: NoNetworkPolicy{}}, tx, &calls
}

func TestTargetAdapterStagesStartsVerifiesAndCommitsCanonicalServices(t *testing.T) {
	adapter, tx, calls := targetAdapter(t)
	if err := adapter.Prepare(context.Background(), tx); err != nil {
		t.Fatal(err)
	}
	if err := adapter.Quiesce(context.Background(), tx); err != nil {
		t.Fatal(err)
	}
	if err := adapter.Activate(context.Background(), tx); err != nil {
		t.Fatal(err)
	}
	if err := adapter.Verify(context.Background(), tx); err != nil {
		t.Fatal(err)
	}
	if err := adapter.Commit(context.Background(), tx); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"units.prepare", "files.prepare", "systemd.stop:fased-gateway-example.service", "systemd.stop:fased-signerd-example.service",
		"files.activate", "units.activate", "systemd.reload", "systemd.enable:fased-signerd-example.service", "systemd.start:fased-signerd-example.service",
		"systemd.enable:fased-gateway-example.service", "systemd.start:fased-gateway-example.service",
		"systemd.active:fased-signerd-example.service", "systemd.active:fased-gateway-example.service",
		"gateway.ready:18789:0.1.76:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		"generation.activate:" + digestB + ":" + digestA, "units.discard", "files.discard",
	}
	if !reflect.DeepEqual(*calls, want) {
		t.Fatalf("unexpected target adapter order:\n got=%v\nwant=%v", *calls, want)
	}
	definitions := adapter.Units.(*fakeUnits).definitions
	combined := string(definitions[adapter.Identity.Services["signer"]]) + string(definitions[adapter.Identity.Services["gateway"]])
	if strings.Contains(combined, "/bin/sh") || !strings.Contains(combined, "NoNewPrivileges=true") || !strings.Contains(combined, "User=996") {
		t.Fatalf("canonical units lack privilege or direct-exec contracts:\n%s", combined)
	}
	if !strings.Contains(combined, "SupplementaryGroups=fscf-example") ||
		!strings.Contains(combined, "RuntimeDirectoryMode=0755") ||
		!strings.Contains(combined, "WorkingDirectory="+filepath.Join(adapter.Generations.(fakeGenerations).root, "runtime")) ||
		!strings.Contains(combined, "Environment=HOME=/home/example") ||
		!strings.Contains(combined, "Environment=FASED_VERSION=0.1.76") ||
		!strings.Contains(combined, "Environment=FASED_HOST_PROFILE=local") ||
		!strings.Contains(combined, "BindReadOnlyPaths="+filepath.Join(adapter.Generations.(fakeGenerations).root, "dependencies", "node_modules")+":"+filepath.Join(adapter.Generations.(fakeGenerations).root, "runtime", "node_modules")) {
		t.Fatalf("canonical Gateway unit lacks Local runtime context:\n%s", combined)
	}
}

func TestFreshTargetAndControllerDoNotStopAbsentCanonicalServices(t *testing.T) {
	adapter, tx, calls := targetAdapter(t)
	tx.PlanAction = "INSTALL"
	tx.Previous = nil
	tx.ManifestDigest = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
	if err := adapter.Quiesce(context.Background(), tx); err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 0 {
		t.Fatalf("fresh target stopped absent services: %v", *calls)
	}

	root := t.TempDir()
	entrypoint := filepath.Join(root, "bin", "fased-lifecycled")
	if err := os.MkdirAll(filepath.Dir(entrypoint), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(entrypoint, []byte("binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	controller := &ControllerAdapter{Config: adapter.Config, Identity: adapter.Identity,
		Units: adapter.Units, Systemd: adapter.Systemd,
		Generations: fakeControllerGenerations{root: root, calls: calls}}
	if err := controller.Stage(context.Background(), tx); err != nil {
		t.Fatal(err)
	}
	*calls = nil
	if err := controller.Switch(context.Background(), tx); err != nil {
		t.Fatal(err)
	}
	for _, call := range *calls {
		if strings.HasPrefix(call, "systemd.stop:") {
			t.Fatalf("fresh controller stopped an absent service: %v", *calls)
		}
	}
}

func TestFreshLocalDefersGatewayUntilOnboardingCreatesConfig(t *testing.T) {
	adapter, tx, calls := targetAdapter(t)
	tx.PlanAction = "INSTALL"
	tx.Previous = nil
	tx.ManifestDigest = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
	if err := adapter.Prepare(context.Background(), tx); err != nil {
		t.Fatal(err)
	}
	if err := adapter.Activate(context.Background(), tx); err != nil {
		t.Fatal(err)
	}
	if err := adapter.Verify(context.Background(), tx); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"units.prepare", "files.prepare", "files.activate", "units.activate", "systemd.reload",
		"systemd.enable:fased-signerd-example.service", "systemd.start:fased-signerd-example.service",
		"systemd.enable:fased-gateway-example.service", "systemd.active:fased-signerd-example.service",
	}
	if !reflect.DeepEqual(*calls, want) {
		t.Fatalf("fresh Local started or health-checked Gateway before onboarding:\n got=%v\nwant=%v", *calls, want)
	}
}

func TestTargetAdapterStagesCanonicalHostingServices(t *testing.T) {
	tx, _ := manifestTransaction(t, false)
	operator, gateway, signer := principals()
	config, err := NewConfig(model.ProfileHosting, "hosting", "/home/app/.fased", operator, gateway, signer)
	if err != nil {
		t.Fatal(err)
	}
	identity, err := config.Identity()
	if err != nil {
		t.Fatal(err)
	}
	platformDigest, err := identity.Digest(model.ProfileHosting)
	if err != nil {
		t.Fatal(err)
	}
	tx.Profile = model.ProfileHosting
	tx.PlatformDigest = platformDigest

	root := t.TempDir()
	for _, name := range []string{"fased-gateway-launch", "fased-signerd"} {
		path := filepath.Join(root, "bin", name)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("binary"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	helper := filepath.Join(root, "runtime", "scripts", "fased-signer-owner-hosting.sh")
	if err := os.MkdirAll(filepath.Dir(helper), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(helper, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	calls := []string{}
	units := &fakeUnits{calls: &calls}
	adapter := &TargetAdapter{
		Config: config, Identity: identity, Units: units, Files: fakeLifecycleFiles{calls: &calls},
		Systemd: fakeSystemd{calls: &calls}, Generations: fakeGenerations{root: root, dependency: filepath.Join(root, "dependencies", "node_modules"), calls: &calls},
		Health: fakeHealth{calls: &calls}, Predecessor: NoPredecessor{}, Network: NoNetworkPolicy{},
	}
	if err := adapter.Prepare(context.Background(), tx); err != nil {
		t.Fatal(err)
	}
	if err := adapter.Quiesce(context.Background(), tx); err != nil {
		t.Fatal(err)
	}
	if err := adapter.Activate(context.Background(), tx); err != nil {
		t.Fatal(err)
	}
	if err := adapter.Verify(context.Background(), tx); err != nil {
		t.Fatal(err)
	}
	if err := adapter.Commit(context.Background(), tx); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"units.prepare", "files.prepare", "systemd.stop:fased-gateway.service", "systemd.stop:fased-signerd.service",
		"files.activate", "units.activate", "systemd.reload", "systemd.enable:fased-signerd.service", "systemd.start:fased-signerd.service",
		"systemd.enable:fased-gateway.service", "systemd.start:fased-gateway.service",
		"systemd.active:fased-signerd.service", "systemd.active:fased-gateway.service",
		"gateway.ready:18789:0.1.76:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		"generation.activate:" + digestB + ":" + digestA, "units.discard", "files.discard",
	}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("unexpected Hosting adapter order:\n got=%v\nwant=%v", calls, want)
	}
	combined := string(units.definitions[identity.Services["signer"]]) + string(units.definitions[identity.Services["gateway"]])
	for _, required := range []string{
		"User=996", "NoNewPrivileges=true", "Environment=HOME=/home/app",
		"Environment=FASED_STATE_DIR=/home/app/.fased", "Environment=FASED_HOST_PROFILE=hosting",
		"-state-db /var/lib/fased-signerd/state.db", "-update-gate /var/lib/fased-signer-update-gate/active",
	} {
		if !strings.Contains(combined, required) {
			t.Fatalf("canonical Hosting units are missing %q:\n%s", required, combined)
		}
	}
	if strings.Contains(combined, "fased-local-") || strings.Contains(combined, "/var/lib/fased-local/") {
		t.Fatalf("Hosting units contain Local topology:\n%s", combined)
	}
}

func TestTargetAdapterRestoresPreviousButDoesNotStartAbsentFreshServices(t *testing.T) {
	adapter, tx, calls := targetAdapter(t)
	if err := adapter.Restore(context.Background(), tx); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(*calls, []string{"files.restore", "units.restore", "systemd.reload", "systemd.start:fased-signerd-example.service", "systemd.start:fased-gateway-example.service"}) {
		t.Fatalf("update restore order changed: %v", *calls)
	}
	*calls = nil
	tx.Previous = nil
	if err := adapter.Restore(context.Background(), tx); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(*calls, []string{"files.restore", "units.restore", "systemd.reload"}) {
		t.Fatalf("fresh rollback started absent services: %v", *calls)
	}
}

func TestDiskUnitStoreRestoresExactPreviousUnit(t *testing.T) {
	operator, gateway, signer := principals()
	config, err := NewConfig(model.ProfileProtectedLocal, "example", "/home/example/.fased", operator, gateway, signer)
	if err != nil {
		t.Fatal(err)
	}
	store, err := NewDiskUnitStore(config, "target")
	if err != nil {
		t.Fatal(err)
	}
	store.rootPrefix = t.TempDir()
	identity, _ := config.Identity()
	unit := identity.Services["gateway"]
	unitPath := store.unitPath(unit)
	if err := os.MkdirAll(filepath.Dir(unitPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(unitPath, []byte("old\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := store.Prepare("018f47d2-5a6b-7c8d-9e0f-123456789abc", map[string][]byte{unit: []byte("new\n")}); err != nil {
		t.Fatal(err)
	}
	if err := store.Activate("018f47d2-5a6b-7c8d-9e0f-123456789abc", []string{unit}); err != nil {
		t.Fatal(err)
	}
	if err := store.Restore("018f47d2-5a6b-7c8d-9e0f-123456789abc", []string{unit}); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(unitPath)
	if err != nil || string(data) != "old\n" {
		t.Fatalf("unit rollback mismatch: %q err=%v", data, err)
	}
}
