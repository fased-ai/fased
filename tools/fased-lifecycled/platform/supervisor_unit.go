package platform

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"
)

const StableLifecycleHostPath = "/opt/fased/lifecycle/supervisor-v1/fased-lifecycled"

func RenderSupervisorUnit(config Config) ([]byte, error) {
	if err := config.Validate(); err != nil {
		return nil, err
	}
	identity, err := config.Identity()
	if err != nil {
		return nil, err
	}
	runtimeDirectory := strings.TrimPrefix(config.SupervisorRuntimeRoot(), "/run/")
	unit := fmt.Sprintf(`[Unit]
Description=Fased stable lifecycle supervisor (%s)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
Group=root
RuntimeDirectory=%s
RuntimeDirectoryMode=0710
UMask=0077
ExecStart=%s supervisor --config %s/platform.json --socket %s
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=%s %s %s %s %s %s %s
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
CapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE CAP_FOWNER CAP_FSETID CAP_SETUID CAP_SETGID
# PrivateDevices removes effective SETUID in a mount namespace on supported
# systemd/container combinations. The supervisor needs only these two
# capabilities to run target-identity access probes; the UID transition clears
# them before the unprivileged probe binary starts.
AmbientCapabilities=CAP_SETUID CAP_SETGID

[Install]
WantedBy=multi-user.target
`, config.InstanceID, runtimeDirectory, StableLifecycleHostPath, config.LifecycleRoot, config.SupervisorSocket(),
		config.InstallRoot, config.LifecycleRoot, config.ProductStateRoot, config.OwnerStateRoot,
		config.UnitRoot, filepath.Dir(config.UpdateGatePath()), filepath.Dir(CanonicalProductVersionPath(config)))
	if identity.Services["supervisor"] == "" {
		return nil, errors.New("platform identity has no supervisor service")
	}
	return []byte(unit), nil
}
