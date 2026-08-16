//go:build darwin

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
		credentials, err := unix.GetsockoptXucred(int(fd), unix.SOL_LOCAL, unix.LOCAL_PEERCRED)
		if err != nil {
			controlErr = err
			return
		}
		peer.UID = credentials.Uid
		if credentials.Ngroups > 0 {
			peer.GID = credentials.Groups[0]
		}
	}); err != nil {
		return Peer{}, err
	}
	if controlErr != nil {
		return Peer{}, fmt.Errorf("read lifecycle peer credentials: %w", controlErr)
	}
	return peer, nil
}
