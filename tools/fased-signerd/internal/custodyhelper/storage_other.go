//go:build !linux && !windows

package custodyhelper

import "fmt"

func newPlatformStorage() (Storage, error) {
	return nil, fmt.Errorf("native custody helper is not implemented on %s in this binary", currentPlatform())
}
