package admintransport

import (
	"errors"
	"fmt"
	"net"
)

// PeerCredential is a kernel-proven Unix peer identity.
type PeerCredential struct {
	UID    int
	GID    int
	PID    int
	Proven bool
}

// RequirePeerCredential accepts only the expected UID or root.
func RequirePeerCredential(conn net.Conn, expectedUID int) (PeerCredential, error) {
	if expectedUID < 0 {
		return PeerCredential{}, errors.New("signer socket expected UID is not configured")
	}
	credential, err := ReadPeerCredential(conn)
	if err != nil || !credential.Proven {
		return PeerCredential{}, errors.New("signer socket peer identity could not be proven")
	}
	if credential.UID != expectedUID && credential.UID != 0 {
		return PeerCredential{}, fmt.Errorf(
			"signer socket peer uid %d is not authorized; expected uid %d",
			credential.UID,
			expectedUID,
		)
	}
	return credential, nil
}
