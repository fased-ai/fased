//go:build linux

package platform

func NewPrincipalSystem() (PrincipalSystem, error) { return NewLinuxPrincipalSystem() }

func NewSystemServiceManager() (ServiceManager, error) {
	for _, path := range []string{"/usr/bin/systemctl", "/bin/systemctl"} {
		if manager := (CommandSystemd{Binary: path}); manager.runTestablePath() == nil {
			return manager, nil
		}
	}
	return nil, errSystemdUnavailable
}

func NewHostPreflight() HostPreflight { return CommandLinuxHostPreflight() }
