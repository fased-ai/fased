//go:build !linux && !darwin

package main

import (
	"errors"
	"net"
)

func readSignerPeerCredentialV2(_ net.Conn) (signerPeerCredentialV2, error) {
	return signerPeerCredentialV2{}, errors.New("Unix peer credentials are unsupported on this platform")
}
