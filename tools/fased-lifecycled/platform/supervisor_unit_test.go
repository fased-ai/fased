package platform

import (
	"strings"
	"testing"

	"fased-lifecycled/model"
)

func TestSupervisorUnitIsStableAndProfileBound(t *testing.T) {
	for _, fixture := range []struct {
		name              string
		profile           model.Profile
		instance          string
		ownerState        string
		supervisorRuntime string
		targetRuntime     string
		configPath        string
	}{
		{
			name: "local", profile: model.ProfileProtectedLocal, instance: "instance",
			ownerState: "/home/operator/.fased", supervisorRuntime: "fased-local-controller/instance",
			targetRuntime: "fased-local-controller-worker/instance", configPath: "/var/lib/fased-local/instance/lifecycle/platform.json",
		},
		{
			name: "hosting", profile: model.ProfileHosting, instance: "hosting",
			ownerState: "/home/app/.fased", supervisorRuntime: "fased-host-updater",
			targetRuntime: "fased-host-controller", configPath: "/var/lib/fased-lifecycled/platform.json",
		},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			config, err := NewConfig(fixture.profile, fixture.instance, fixture.ownerState,
				Principal{UID: 1000, GID: 1000}, Principal{UID: 1001, GID: 1001}, Principal{UID: 1002, GID: 1002})
			if err != nil {
				t.Fatal(err)
			}
			data, err := RenderSupervisorUnit(config, "/opt/fased/lifecycle/supervisor-v1/fased-lifecycled")
			if err != nil {
				t.Fatal(err)
			}
			text := string(data)
			for _, expected := range []string{
				"User=root", "NoNewPrivileges=true", "ProtectSystem=strict", "RestrictAddressFamilies=AF_UNIX",
				"supervisor --config " + fixture.configPath,
				"RuntimeDirectory=" + fixture.supervisorRuntime + "\n",
			} {
				if !strings.Contains(text, expected) {
					t.Fatalf("supervisor unit lacks %q", expected)
				}
			}
			if strings.Contains(text, fixture.targetRuntime) {
				t.Fatalf("supervisor must not own or write the target runtime directory:\n%s", text)
			}
		})
	}
}
