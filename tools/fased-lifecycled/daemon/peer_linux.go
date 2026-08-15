//go:build linux

package daemon

import (
	"fmt"
	"net"

	"golang.org/x/sys/unix"
)

func UnixPeer(connection *net.UnixConn) (Peer, error) {
	raw, err := connection.SyscallConn()
	if err != nil {
		return Peer{}, err
	}
	var peer Peer
	var controlErr error
	if err := raw.Control(func(fd uintptr) {
		credentials, err := unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
		if err != nil {
			controlErr = err
			return
		}
		peer = Peer{UID: credentials.Uid, GID: credentials.Gid}
	}); err != nil {
		return Peer{}, err
	}
	if controlErr != nil {
		return Peer{}, fmt.Errorf("read lifecycle peer credentials: %w", controlErr)
	}
	return peer, nil
}
