//go:build darwin

package platform

func NewPrincipalSystem() (PrincipalSystem, error) { return NewDarwinPrincipalSystem() }

func NewSystemServiceManager() (ServiceManager, error) { return NewCommandLaunchd() }

func NewHostPreflight() HostPreflight { return CommandDarwinHostPreflight() }
