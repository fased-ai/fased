package platform

import "context"

type HostPreflight interface {
	Verify(context.Context) error
}
