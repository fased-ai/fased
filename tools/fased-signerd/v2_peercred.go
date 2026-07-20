package main

import (
	"errors"
	"fmt"
	"net"
)

type signerPeerCredentialV2 struct {
	UID    int
	GID    int
	PID    int
	Proven bool
}

func requireSignerPeerCredentialV2(conn net.Conn, expectedUID int) (signerPeerCredentialV2, error) {
	if expectedUID < 0 {
		return signerPeerCredentialV2{}, errors.New("signer socket expected UID is not configured")
	}
	credential, err := readSignerPeerCredentialV2(conn)
	if err != nil || !credential.Proven {
		return signerPeerCredentialV2{}, errors.New("signer socket peer identity could not be proven")
	}
	if credential.UID != expectedUID && credential.UID != 0 {
		return signerPeerCredentialV2{}, fmt.Errorf(
			"signer socket peer uid %d is not authorized; expected uid %d",
			credential.UID,
			expectedUID,
		)
	}
	return credential, nil
}
