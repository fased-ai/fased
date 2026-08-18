//go:build linux

package admintransport

import (
	"errors"
	"net"

	"golang.org/x/sys/unix"
)

// ReadPeerCredential reads Linux SO_PEERCRED from a Unix-domain connection.
func ReadPeerCredential(conn net.Conn) (PeerCredential, error) {
	unixConn, ok := conn.(*net.UnixConn)
	if !ok {
		return PeerCredential{}, errors.New("signer peer credentials require a Unix socket")
	}
	raw, err := unixConn.SyscallConn()
	if err != nil {
		return PeerCredential{}, err
	}
	var credential *unix.Ucred
	var credentialErr error
	if err := raw.Control(func(fd uintptr) {
		credential, credentialErr = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
	}); err != nil {
		return PeerCredential{}, err
	}
	if credentialErr != nil || credential == nil {
		return PeerCredential{}, credentialErr
	}
	return PeerCredential{UID: int(credential.Uid), GID: int(credential.Gid), PID: int(credential.Pid), Proven: true}, nil
}
