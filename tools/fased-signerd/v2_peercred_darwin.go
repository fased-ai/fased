//go:build darwin

package main

import (
	"errors"
	"net"

	"golang.org/x/sys/unix"
)

func readSignerPeerCredentialV2(conn net.Conn) (signerPeerCredentialV2, error) {
	unixConn, ok := conn.(*net.UnixConn)
	if !ok {
		return signerPeerCredentialV2{}, errors.New("signer peer credentials require a Unix socket")
	}
	raw, err := unixConn.SyscallConn()
	if err != nil {
		return signerPeerCredentialV2{}, err
	}
	credential := signerPeerCredentialV2{GID: -1, PID: -1}
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
		return signerPeerCredentialV2{}, err
	}
	if credentialErr != nil {
		return signerPeerCredentialV2{}, credentialErr
	}
	credential.Proven = true
	return credential, nil
}
