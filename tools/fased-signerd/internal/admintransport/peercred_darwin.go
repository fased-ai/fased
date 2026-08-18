//go:build darwin

package admintransport

import (
	"errors"
	"net"

	"golang.org/x/sys/unix"
)

// ReadPeerCredential reads Darwin LOCAL_PEERCRED from a Unix-domain connection.
func ReadPeerCredential(conn net.Conn) (PeerCredential, error) {
	unixConn, ok := conn.(*net.UnixConn)
	if !ok {
		return PeerCredential{}, errors.New("signer peer credentials require a Unix socket")
	}
	raw, err := unixConn.SyscallConn()
	if err != nil {
		return PeerCredential{}, err
	}
	credential := PeerCredential{GID: -1, PID: -1}
	var credentialErr error
	if err := raw.Control(func(fd uintptr) {
		peer, err := unix.GetsockoptXucred(int(fd), unix.SOL_LOCAL, unix.LOCAL_PEERCRED)
		if err != nil {
			credentialErr = err
			return
		}
		if peer == nil {
			credentialErr = errors.New("Darwin signer peer credential is unavailable")
			return
		}
		credential.UID = int(peer.Uid)
		if peer.Ngroups > 0 {
			credential.GID = int(peer.Groups[0])
		}
		credential.PID, credentialErr = unix.GetsockoptInt(int(fd), unix.SOL_LOCAL, unix.LOCAL_PEERPID)
	}); err != nil {
		return PeerCredential{}, err
	}
	if credentialErr != nil {
		return PeerCredential{}, credentialErr
	}
	credential.Proven = true
	return credential, nil
}
