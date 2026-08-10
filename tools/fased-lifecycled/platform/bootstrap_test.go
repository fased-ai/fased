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

func (system *memoryPrincipals) Memberships(_ context.Context, user string) (map[string]bool, error) {
	result := map[string]bool{}
	for group := range system.members[user] {
		result[group] = true
	}
	return result, nil
}

func (system *memoryPrincipals) DeleteUser(_ context.Context, user string) error {
	delete(system.users, user)
	delete(system.members, user)
	return nil
}

func (system *memoryPrincipals) DeleteGroup(_ context.Context, group string) error {
	delete(system.groups, group)
	for _, memberships := range system.members {
		delete(memberships, group)
	}
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

func TestTransactionalPrincipalProvisioningRollsBackExactPreexistingGraph(t *testing.T) {
	system := newMemoryPrincipals()
	system.users["owner"] = AccountRecord{Name: "owner", UID: 1000, GID: 1000, Home: "/home/owner", Shell: "/bin/bash"}
	system.groups["owner"] = GroupRecord{Name: "owner", GID: 1000}
	system.groups["existing"] = GroupRecord{Name: "existing", GID: 1001}
	system.members["owner"] = map[string]bool{"owner": true, "existing": true}
	beforeUsers := cloneAccounts(system.users)
	beforeGroups := cloneGroups(system.groups)
	beforeMembers := cloneMemberships(system.members)
	_, changes, err := ProvisionBootstrapPrincipalsTransactional(context.Background(), system, BootstrapRequest{
		Profile: model.ProfileProtectedLocal, InstanceID: "0123456789abcdef",
		OperatorUser: "owner", OwnerStateRoot: "/home/owner/.fased",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := changes.Rollback(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(system.users, beforeUsers) || !reflect.DeepEqual(system.groups, beforeGroups) || !reflect.DeepEqual(system.members, beforeMembers) {
		t.Fatalf("principal rollback differed: users=%+v groups=%+v memberships=%+v", system.users, system.groups, system.members)
	}
}

type failingMembershipPrincipals struct {
	*memoryPrincipals
	fail bool
}

func (system *failingMembershipPrincipals) AddMemberships(ctx context.Context, user string, groups []string) error {
	if system.fail {
		return errors.New("injected membership failure")
	}
	return system.memoryPrincipals.AddMemberships(ctx, user, groups)
}

func TestTransactionalPrincipalProvisioningRollsBackPartialFailure(t *testing.T) {
	memory := newMemoryPrincipals()
	memory.users["owner"] = AccountRecord{Name: "owner", UID: 1000, GID: 1000, Home: "/home/owner", Shell: "/bin/bash"}
	system := &failingMembershipPrincipals{memoryPrincipals: memory, fail: true}
	if _, _, err := ProvisionBootstrapPrincipalsTransactional(context.Background(), system, BootstrapRequest{
		Profile: model.ProfileProtectedLocal, InstanceID: "0123456789abcdef",
		OperatorUser: "owner", OwnerStateRoot: "/home/owner/.fased",
	}); err == nil {
		t.Fatal("injected principal failure succeeded")
	}
	if len(memory.users) != 1 || len(memory.groups) != 0 || len(memory.members) != 0 {
		t.Fatalf("partial principal failure was not rolled back: %+v %+v %+v", memory.users, memory.groups, memory.members)
	}
}

func cloneAccounts(source map[string]AccountRecord) map[string]AccountRecord {
	result := map[string]AccountRecord{}
	for key, value := range source {
		result[key] = value
	}
	return result
}

func cloneGroups(source map[string]GroupRecord) map[string]GroupRecord {
	result := map[string]GroupRecord{}
	for key, value := range source {
		result[key] = value
	}
	return result
}

func cloneMemberships(source map[string]map[string]bool) map[string]map[string]bool {
	result := map[string]map[string]bool{}
	for user, memberships := range source {
		result[user] = map[string]bool{}
		for group, value := range memberships {
			result[user][group] = value
		}
	}
	return result
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
		{Path: "/opt/fased/lifecycle", UID: 0, GID: 0, Mode: 0o755},
		{Path: "/opt/fased/lifecycle/supervisor-v1", UID: 0, GID: 0, Mode: 0o755},
		{Path: "/var/lib/fased-local/local", UID: 0, GID: 0, Mode: 0o755},
		{Path: "/var/lib/fased-local/local/controller", UID: 0, GID: 899, Mode: 0o710},
		{Path: "/var/lib/fased-local/local/lifecycle", UID: 0, GID: 0, Mode: 0o700},
		{Path: "/var/lib/fased-local/local/signer", UID: 899, GID: 899, Mode: 0o700},
		{Path: "/home/owner/.fased", UID: 1000, GID: 897, Mode: os.ModeSetgid | 0o770},
		{Path: "/home/owner/.fased/bin", UID: 1000, GID: 897, Mode: 0o750},
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
	if paths["/opt/fased"].Mode != 0o755 || paths["/opt/fased/lifecycle"].Mode != 0o755 ||
		paths["/opt/fased/lifecycle/supervisor-v1"].Mode != 0o755 || paths["/var/lib/fased-lifecycled"].Mode != 0o700 ||
		paths["/var/lib/fased-signerd"].UID != principals.Signer.UID || paths["/var/lib/fased-host-updater"].Mode != 0o700 ||
		paths["/home/app/.fased"].GID != principals.Groups.Config.GID {
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

func TestBootstrapPathTransactionRestoresExistingAndRemovesCreated(t *testing.T) {
	root := t.TempDir()
	existing := filepath.Join(root, "existing")
	created := filepath.Join(root, "new", "state")
	if err := os.Mkdir(existing, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(existing, 0o750); err != nil {
		t.Fatal(err)
	}
	changes, err := ApplyBootstrapPathPlanTransactional([]BootstrapPath{
		{Path: existing, UID: uint32(os.Getuid()), GID: uint32(os.Getgid()), Mode: 0o700},
		{Path: created, UID: uint32(os.Getuid()), GID: uint32(os.Getgid()), Mode: 0o700},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := changes.Rollback(); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(existing)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o750 {
		t.Fatalf("existing bootstrap path mode was not restored: %04o", info.Mode().Perm())
	}
	if _, err := os.Stat(filepath.Join(root, "new")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("created bootstrap ancestry was retained: %v", err)
	}
}
