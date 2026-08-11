package platform

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"
)

func RenderSupervisorUnit(config Config, binary string) ([]byte, error) {
	if err := config.Validate(); err != nil {
		return nil, err
	}
	if !filepath.IsAbs(binary) || filepath.Clean(binary) != binary {
		return nil, errors.New("supervisor binary path must be absolute and clean")
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
ReadWritePaths=%s %s
RestrictAddressFamilies=AF_UNIX
CapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE CAP_FOWNER CAP_SETUID CAP_SETGID
AmbientCapabilities=

[Install]
WantedBy=multi-user.target
`, config.InstanceID, runtimeDirectory, binary, config.LifecycleRoot, config.SupervisorSocket(),
		config.LifecycleRoot, config.UnitRoot)
	if identity.Services["supervisor"] == "" {
		return nil, errors.New("platform identity has no supervisor service")
	}
	return []byte(unit), nil
}
