package platform

import (
	"strings"
	"testing"

	"fased-lifecycled/model"
)

func TestManagedUpdateAuthorityIsScopedToOperatorProfileAndStaticBootstrap(t *testing.T) {
	for name, fixture := range map[string]struct {
		profile  model.Profile
		instance string
		owner    string
		user     string
		operator Principal
		gateway  Principal
		signer   Principal
		path     string
		line     string
	}{
		"protected Local": {
			profile: model.ProfileProtectedLocal, instance: "0123456789abcdef", owner: "/home/owner/.fased", user: "owner",
			operator: Principal{UID: 1000, GID: 1000}, gateway: Principal{UID: 1001, GID: 1001}, signer: Principal{UID: 1002, GID: 1002},
			path: "/etc/sudoers.d/fased-local-0123456789abcdef-update",
			line: "owner ALL=(root) NOPASSWD: /opt/fased/lifecycle/bootstrap-v1/fased-bootstrap update --profile protected-local *\n",
		},
		"Hosting": {
			profile: model.ProfileHosting, instance: "hosting", owner: "/home/app/.fased", user: "app",
			operator: Principal{UID: 1000, GID: 1000}, gateway: Principal{UID: 1001, GID: 1001}, signer: Principal{UID: 1002, GID: 1002},
			path: "/etc/sudoers.d/fased-hosting-update",
			line: "app ALL=(root) NOPASSWD: /opt/fased/lifecycle/bootstrap-v1/fased-bootstrap update --profile hosting *\n",
		},
	} {
		t.Run(name, func(t *testing.T) {
			config, err := NewConfig(fixture.profile, fixture.instance, fixture.owner, fixture.operator, fixture.gateway, fixture.signer)
			if err != nil {
				t.Fatal(err)
			}
			if got := config.UpdateAuthorityPath(); got != fixture.path {
				t.Fatalf("unexpected update authority path: %q", got)
			}
			policy, err := RenderUpdateAuthority(config, fixture.user)
			if err != nil {
				t.Fatal(err)
			}
			if string(policy) != fixture.line {
				t.Fatalf("unexpected update authority:\n%s", policy)
			}
			for _, forbidden := range []string{" ALL\n", "ALL=(ALL)", "install ", "fased-lifecycled", "/bin/sh", "/usr/bin/env"} {
				if strings.Contains(string(policy), forbidden) {
					t.Fatalf("update authority contains forbidden grant %q", forbidden)
				}
			}
		})
	}
}

func TestManagedUpdateAuthorityRejectsUnsafeOperatorName(t *testing.T) {
	config, err := NewConfig(model.ProfileHosting, "hosting", "/home/app/.fased",
		Principal{UID: 1000, GID: 1000}, Principal{UID: 1001, GID: 1001}, Principal{UID: 1002, GID: 1002})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := RenderUpdateAuthority(config, "app ALL=(ALL) NOPASSWD: ALL"); err == nil {
		t.Fatal("unsafe operator name entered the update authorization")
	}
}
