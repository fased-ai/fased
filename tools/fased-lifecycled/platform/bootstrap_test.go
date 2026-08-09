package platform

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"fased-lifecycled/model"
)

type memoryPrincipals struct {
	users   map[string]AccountRecord
	groups  map[string]GroupRecord
	members map[string]map[string]bool
}

func newMemoryPrincipals() *memoryPrincipals {
	return &memoryPrincipals{
		users:   map[string]AccountRecord{},
		groups:  map[string]GroupRecord{},
		members: map[string]map[string]bool{},
	}
}

func (system *memoryPrincipals) LookupUser(_ context.Context, name string) (AccountRecord, bool, error) {
	record, ok := system.users[name]
	return record, ok, nil
}

func (system *memoryPrincipals) LookupGroup(_ context.Context, name string) (GroupRecord, bool, error) {
	record, ok := system.groups[name]
	return record, ok, nil
}

func (system *memoryPrincipals) AddGroup(_ context.Context, name string) error {
	if _, exists := system.groups[name]; exists {
		return errors.New("duplicate group")
	}
	system.groups[name] = GroupRecord{Name: name, GID: uint32(60000 + len(system.groups))}
	return nil
}

func (system *memoryPrincipals) AddUser(_ context.Context, request AddUserRequest) error {
	if _, exists := system.users[request.Name]; exists {
		return errors.New("duplicate user")
	}
	group := system.groups[request.PrimaryGroup]
	uid := uint32(61000 + len(system.users))
	if request.PrimaryGroup == "" {
		group = GroupRecord{Name: request.Name, GID: uid}
		system.groups[request.Name] = group
	}
	system.users[request.Name] = AccountRecord{
		Name: request.Name, UID: uid, GID: group.GID,
		Home: request.Home, Shell: request.Shell,
	}
	return nil
}

func (system *memoryPrincipals) AddMemberships(_ context.Context, user string, groups []string) error {
	if system.members[user] == nil {
		system.members[user] = map[string]bool{}
	}
	for _, group := range groups {
		system.members[user][group] = true
	}
	return nil
}

func (system *memoryPrincipals) RemoveMembership(_ context.Context, user, group string) error {
	delete(system.members[user], group)
	return nil
}

func (system *memoryPrincipals) LockUser(context.Context, string) error { return nil }

func TestProvisionBootstrapPrincipalsOwnsLocalAccountGraph(t *testing.T) {
	system := newMemoryPrincipals()
	system.users["owner"] = AccountRecord{Name: "owner", UID: 1000, GID: 1000, Home: "/home/owner", Shell: "/bin/bash"}

	got, err := ProvisionBootstrapPrincipals(context.Background(), system, BootstrapRequest{
		Profile: model.ProfileProtectedLocal, InstanceID: "0123456789abcdef",
		OperatorUser: "owner", OwnerStateRoot: "/home/owner/.fased",
	})
	if err != nil {
		t.Fatal(err)
	}
	wantNames := PrincipalNames{
		OperatorUser: "owner", GatewayUser: "fsgw-0123456789abcdef", SignerUser: "fssg-0123456789abcdef",
		GatewayGroup: "fsgw-0123456789abcdef", SignerGroup: "fssg-0123456789abcdef",
		OperatorGroup: "fsop-0123456789abcdef", ConfigGroup: "fscf-0123456789abcdef",
	}
	if got.Names != wantNames {
		t.Fatalf("names = %+v, want %+v", got.Names, wantNames)
	}
	if got.Operator.UID != 1000 || got.Gateway.UID == got.Signer.UID || got.Gateway.GID != got.Groups.Gateway.GID {
		t.Fatalf("principal isolation failed: %+v", got)
	}
	if !system.members["owner"][wantNames.OperatorGroup] || !system.members["owner"][wantNames.ConfigGroup] ||
		!system.members[wantNames.GatewayUser][wantNames.ConfigGroup] ||
		!system.members[wantNames.SignerUser][wantNames.GatewayGroup] ||
		!system.members[wantNames.SignerUser][wantNames.OperatorGroup] {
		t.Fatalf("required memberships missing: %+v", system.members)
	}
	if system.members["owner"][wantNames.GatewayGroup] || system.members[wantNames.GatewayUser][wantNames.OperatorGroup] {
		t.Fatalf("forbidden memberships retained: %+v", system.members)
	}
}

func TestProvisionBootstrapPrincipalsCreatesCanonicalHostingAccounts(t *testing.T) {
	system := newMemoryPrincipals()
	got, err := ProvisionBootstrapPrincipals(context.Background(), system, BootstrapRequest{
		Profile: model.ProfileHosting, InstanceID: "hosting", OperatorUser: "app", OwnerStateRoot: "/home/app/.fased",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.Names.GatewayUser != "fased-gateway" || got.Names.SignerUser != "fased-signer" || system.users["app"].Home != "/home/app" {
		t.Fatalf("unexpected Hosting principals: %+v", got)
	}
}

func TestProvisionBootstrapPrincipalsRejectsNoncanonicalOwnerAndExistingServiceIdentity(t *testing.T) {
	for _, test := range []struct {
		name    string
		prepare func(*memoryPrincipals)
		request BootstrapRequest
	}{
		{
			name: "Local owner state outside owner home",
			prepare: func(system *memoryPrincipals) {
				system.users["owner"] = AccountRecord{Name: "owner", UID: 1000, GID: 1000, Home: "/home/owner", Shell: "/bin/bash"}
			},
			request: BootstrapRequest{Profile: model.ProfileProtectedLocal, InstanceID: "local", OperatorUser: "owner", OwnerStateRoot: "/srv/fased"},
		},
		{
			name: "service account substitution",
			prepare: func(system *memoryPrincipals) {
				system.users["owner"] = AccountRecord{Name: "owner", UID: 1000, GID: 1000, Home: "/home/owner", Shell: "/bin/bash"}
				system.users["fsgw-local"] = AccountRecord{Name: "fsgw-local", UID: 900, GID: 901, Home: "/tmp/wrong", Shell: "/bin/bash"}
			},
			request: BootstrapRequest{Profile: model.ProfileProtectedLocal, InstanceID: "local", OperatorUser: "owner", OwnerStateRoot: "/home/owner/.fased"},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			system := newMemoryPrincipals()
			test.prepare(system)
			if _, err := ProvisionBootstrapPrincipals(context.Background(), system, test.request); err == nil {
				t.Fatal("unsafe bootstrap identity was accepted")
			}
		})
	}
}

func TestBootstrapPathPlanIsCanonicalAndBounded(t *testing.T) {
	principals := BootstrapPrincipals{
		Operator: Principal{UID: 1000, GID: 1000}, Gateway: Principal{UID: 900, GID: 900}, Signer: Principal{UID: 899, GID: 899},
		Groups: BootstrapGroups{Gateway: GroupRecord{GID: 900}, Signer: GroupRecord{GID: 899}, Operator: GroupRecord{GID: 898}, Config: GroupRecord{GID: 897}},
	}
	config, err := NewConfig(model.ProfileProtectedLocal, "local", "/home/owner/.fased", principals.Operator, principals.Gateway, principals.Signer)
	if err != nil {
		t.Fatal(err)
	}
	got, err := BootstrapPathPlan(config, principals)
	if err != nil {
		t.Fatal(err)
	}
	want := []BootstrapPath{
		{Path: "/opt/fased/local/local", UID: 0, GID: 0, Mode: 0o755},
		{Path: "/var/lib/fased-local/local", UID: 0, GID: 0, Mode: 0o755},
		{Path: "/var/lib/fased-local/local/lifecycle", UID: 0, GID: 0, Mode: 0o700},
		{Path: "/var/lib/fased-local/local/signer", UID: 899, GID: 899, Mode: 0o700},
		{Path: "/home/owner/.fased", UID: 1000, GID: 897, Mode: os.ModeSetgid | 0o770},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("path plan = %#v, want %#v", got, want)
	}
}

func TestHostingBootstrapPathPlanUsesSharedCanonicalRoots(t *testing.T) {
	principals := BootstrapPrincipals{
		Operator: Principal{UID: 1000, GID: 1000}, Gateway: Principal{UID: 900, GID: 900}, Signer: Principal{UID: 899, GID: 899},
		Groups: BootstrapGroups{Gateway: GroupRecord{GID: 900}, Signer: GroupRecord{GID: 899}, Operator: GroupRecord{GID: 898}, Config: GroupRecord{GID: 897}},
	}
	config, err := NewConfig(model.ProfileHosting, "hosting", "/home/app/.fased", principals.Operator, principals.Gateway, principals.Signer)
	if err != nil {
		t.Fatal(err)
	}
	got, err := BootstrapPathPlan(config, principals)
	if err != nil {
		t.Fatal(err)
	}
	paths := map[string]BootstrapPath{}
	for _, spec := range got {
		paths[spec.Path] = spec
	}
	if paths["/opt/fased"].Mode != 0o755 || paths["/var/lib/fased-lifecycled"].Mode != 0o700 ||
		paths["/var/lib/fased-signerd"].UID != principals.Signer.UID || paths["/home/app/.fased"].GID != principals.Groups.Config.GID {
		t.Fatalf("unexpected Hosting path plan: %+v", got)
	}
}

func TestApplyBootstrapPathPlanRejectsSymlinkedAncestry(t *testing.T) {
	root := t.TempDir()
	target := t.TempDir()
	if err := os.Symlink(target, filepath.Join(root, "linked")); err != nil {
		t.Fatal(err)
	}
	if err := ApplyBootstrapPathPlan([]BootstrapPath{{
		Path: filepath.Join(root, "linked", "state"), UID: uint32(os.Getuid()), GID: uint32(os.Getgid()), Mode: 0o700,
	}}); err == nil {
		t.Fatal("symlinked bootstrap ancestry was accepted")
	}
}
