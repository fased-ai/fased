//go:build linux

package platform

func NewHomeACL() (HomeACL, error) {
	return NewLinuxACL()
}
