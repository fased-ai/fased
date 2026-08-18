//go:build !linux && !darwin

package admintransport

import (
	"errors"
	"net"
)

// ReadPeerCredential fails closed where Unix credentials are unavailable.
func ReadPeerCredential(_ net.Conn) (PeerCredential, error) {
	return PeerCredential{}, errors.New("Unix peer credentials are unsupported on this platform")
}
