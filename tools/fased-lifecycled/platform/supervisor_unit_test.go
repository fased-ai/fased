package platform

import (
	"strings"
	"testing"

	"fased-lifecycled/model"
)

func TestSupervisorUnitIsStableAndProfileBound(t *testing.T) {
	config, err := NewConfig(model.ProfileProtectedLocal, "instance", "/home/operator/.fased",
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
		"supervisor --config /var/lib/fased-local/instance/lifecycle/platform.json",
		"--socket /run/fased-local-controller/instance/request.sock",
		"RuntimeDirectory=fased-local-controller/instance fased-local-controller-worker/instance",
	} {
		if !strings.Contains(text, expected) {
			t.Fatalf("supervisor unit lacks %q", expected)
		}
	}
}
