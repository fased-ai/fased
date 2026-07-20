//go:build linux

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
	var credential *unix.Ucred
	var credentialErr error
	if err := raw.Control(func(fd uintptr) {
		credential, credentialErr = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
	}); err != nil {
		return signerPeerCredentialV2{}, err
	}
	if credentialErr != nil || credential == nil {
		return signerPeerCredentialV2{}, credentialErr
	}
	return signerPeerCredentialV2{
		UID: int(credential.Uid), GID: int(credential.Gid), PID: int(credential.Pid), Proven: true,
	}, nil
}
