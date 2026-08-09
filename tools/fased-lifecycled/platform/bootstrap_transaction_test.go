package platform

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"fased-lifecycled/model"
)

func TestBootstrapPathPlanPreservesServiceTraversalUnderRestrictiveUmask(t *testing.T) {
	root := t.TempDir()
	installRoot := filepath.Join(root, "opt", "fased", "local", "instance")
	previousUmask := syscall.Umask(0o077)
	defer syscall.Umask(previousUmask)

	changes, err := ApplyBootstrapPathPlanTransactional([]BootstrapPath{{
		Path: installRoot, UID: uint32(os.Getuid()), GID: uint32(os.Getgid()), Mode: 0o755,
	}})
	if err != nil {
		t.Fatal(err)
	}
	changes.Commit()

	for _, path := range []string{
		filepath.Join(root, "opt"),
		filepath.Join(root, "opt", "fased"),
		filepath.Join(root, "opt", "fased", "local"),
		installRoot,
	} {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o755 {
			t.Fatalf("bootstrap traversal mode for %s = %04o; want 0755", path, info.Mode().Perm())
		}
	}
}

type memoryBootstrapJournal struct{ events []BootstrapEvent }

func (journal *memoryBootstrapJournal) Record(phase BootstrapPhase, state string) error {
	journal.events = append(journal.events, BootstrapEvent{Sequence: uint32(len(journal.events) + 1), Phase: phase, State: state})
	return nil
}

func TestBootstrapPhaseFailureRestoresRegistryACLPathsUnitsAndPrincipals(t *testing.T) {
	phases := []BootstrapPhase{BootstrapPhaseRegistry, BootstrapPhasePrincipals, BootstrapPhasePaths, BootstrapPhaseACL, BootstrapPhaseDaemon, BootstrapPhaseConfig, BootstrapPhaseUnits}
	for failAt := range phases {
		t.Run(string(phases[failAt]), func(t *testing.T) {
			root := t.TempDir()
			registryPath := filepath.Join(root, "registry", "instances.json")
			ownerState := filepath.Join(root, "owner", ".fased")
			if err := os.MkdirAll(ownerState, 0o700); err != nil {
				t.Fatal(err)
			}
			principals := newMemoryPrincipals()
			principals.users["owner"] = AccountRecord{Name: "owner", UID: 1000, GID: 1000, Home: "/home/owner", Shell: "/bin/bash"}
			aclRunner := &memoryACLRunner{entries: baseACL()}
			acl := &LinuxACL{getfacl: "getfacl", setfacl: "setfacl", runner: aclRunner}
			managedPath := filepath.Join(root, "managed", "state")
			files := map[BootstrapPhase]string{
				BootstrapPhaseDaemon: filepath.Join(root, "daemon"), BootstrapPhaseConfig: filepath.Join(root, "config"), BootstrapPhaseUnits: filepath.Join(root, "unit"),
			}
			for _, path := range files {
				if err := os.WriteFile(path, []byte("before"), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			request := LocalInstanceRequest{TransactionID: "018f47d2-5a6b-7c8d-9e0f-123456789abc", OperatorUID: uint32(os.Getuid()), OperatorUser: "owner", Profile: "protected-local", StateDir: ownerState}
			allocation, err := PlanLocalInstance(registryPath, uint32(os.Getuid()), request, bytes.NewReader([]byte("12345678")), time.Unix(100, 0))
			if err != nil {
				t.Fatal(err)
			}
			journal := &memoryBootstrapJournal{}
			steps := make([]BootstrapStep, 0, len(phases))
			for index, phase := range phases {
				index, phase := index, phase
				steps = append(steps, BootstrapStep{Phase: phase, Apply: func() (BootstrapUndo, error) {
					if index == failAt {
						return nil, errors.New("injected integrated bootstrap failure")
					}
					switch phase {
					case BootstrapPhaseRegistry:
						if err := CommitLocalInstance(registryPath, uint32(os.Getuid()), &allocation); err != nil {
							return nil, err
						}
						return func() error { return RollbackLocalInstance(registryPath, uint32(os.Getuid()), &allocation) }, nil
					case BootstrapPhasePrincipals:
						_, changes, err := ProvisionBootstrapPrincipalsTransactional(context.Background(), principals, BootstrapRequest{Profile: model.ProfileProtectedLocal, InstanceID: allocation.Entry.InstanceID, OperatorUser: "owner", OwnerStateRoot: "/home/owner/.fased"})
						if err != nil {
							return nil, err
						}
						return func() error { return changes.Rollback(context.Background()) }, nil
					case BootstrapPhasePaths:
						changes, err := ApplyBootstrapPathPlanTransactional([]BootstrapPath{{Path: managedPath, UID: uint32(os.Getuid()), GID: uint32(os.Getgid()), Mode: 0o700}})
						if err != nil {
							return nil, err
						}
						return changes.Rollback, nil
					case BootstrapPhaseACL:
						snapshot, err := acl.Capture(context.Background(), "/home/owner")
						if err != nil {
							return nil, err
						}
						if err := acl.GrantTraversal(context.Background(), "/home/owner", 60001, snapshot); err != nil {
							return nil, err
						}
						return func() error { return acl.Restore(context.Background(), "/home/owner", snapshot) }, nil
					default:
						replacement, err := InstallFileTransactional(files[phase], []byte("after"), 0o600, uint32(os.Getuid()), uint32(os.Getgid()))
						if err != nil {
							return nil, err
						}
						return replacement.Rollback, nil
					}
				}})
			}
			if err := ExecuteBootstrapTransaction(journal, steps); err == nil {
				t.Fatal("integrated bootstrap failure succeeded")
			}
			registry, _, err := readLocalInstanceRegistry(registryPath, uint32(os.Getuid()))
			if err != nil || len(registry.Instances) != 0 {
				t.Fatalf("registry rollback mismatch: %+v %v", registry, err)
			}
			if len(principals.users) != 1 || len(principals.groups) != 0 {
				t.Fatalf("principal rollback mismatch: %+v %+v", principals.users, principals.groups)
			}
			if !sameACL(aclRunner.entries, baseACL()) {
				t.Fatalf("ACL rollback mismatch: %+v", aclRunner.entries)
			}
			if _, err := os.Stat(filepath.Join(root, "managed")); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("path rollback mismatch: %v", err)
			}
			for _, path := range files {
				data, err := os.ReadFile(path)
				if err != nil || string(data) != "before" {
					t.Fatalf("file rollback mismatch for %s: %q %v", path, data, err)
				}
			}
		})
	}
}

func TestBootstrapTransactionRollsBackEveryCompletedPhase(t *testing.T) {
	phases := []BootstrapPhase{BootstrapPhaseRegistry, BootstrapPhasePrincipals, BootstrapPhasePaths, BootstrapPhaseACL, BootstrapPhaseDaemon, BootstrapPhaseConfig, BootstrapPhaseUnits}
	for failAt := range phases {
		t.Run(string(phases[failAt]), func(t *testing.T) {
			state := make([]bool, len(phases))
			journal := &memoryBootstrapJournal{}
			steps := make([]BootstrapStep, 0, len(phases))
			for index, phase := range phases {
				index, phase := index, phase
				steps = append(steps, BootstrapStep{Phase: phase, Apply: func() (BootstrapUndo, error) {
					if index == failAt {
						return nil, errors.New("injected bootstrap failure")
					}
					state[index] = true
					return func() error { state[index] = false; return nil }, nil
				}})
			}
			if err := ExecuteBootstrapTransaction(journal, steps); err == nil {
				t.Fatal("injected bootstrap failure succeeded")
			}
			for index, mutated := range state {
				if mutated {
					t.Fatalf("phase %s remained mutated after failure at %s", phases[index], phases[failAt])
				}
			}
		})
	}
}

func TestBootstrapTransactionRecordsBeforeEveryMutation(t *testing.T) {
	journal := &memoryBootstrapJournal{}
	mutated := false
	err := ExecuteBootstrapTransaction(journal, []BootstrapStep{{Phase: BootstrapPhaseRegistry, Apply: func() (BootstrapUndo, error) {
		if len(journal.events) != 1 || journal.events[0].State != "APPLYING" {
			t.Fatal("bootstrap mutation ran before its durable applying event")
		}
		mutated = true
		return func() error { mutated = false; return nil }, nil
	}}})
	if err != nil || !mutated || len(journal.events) != 2 || journal.events[1].State != "APPLIED" {
		t.Fatalf("unexpected bootstrap transaction result: mutated=%v events=%+v err=%v", mutated, journal.events, err)
	}
}

func TestUnknownNewerBootstrapJournalFailsBeforeMutation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "journal.json")
	payload, err := json.Marshal(BootstrapJournalRecord{SchemaVersion: 2, TransactionID: "018f47d2-5a6b-7c8d-9e0f-123456789abc", Events: []BootstrapEvent{}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, payload, 0o600); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := OpenBootstrapJournal(path, "018f47d2-5a6b-7c8d-9e0f-123456789abc"); err == nil {
		t.Fatal("unknown-newer bootstrap journal was accepted")
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatal("unknown-newer bootstrap journal was mutated")
	}
}
