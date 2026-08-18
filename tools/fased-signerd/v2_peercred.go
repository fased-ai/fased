package main

import (
	"net"

	"fased-signerd/internal/admintransport"
)

type signerPeerCredentialV2 = admintransport.PeerCredential

func requireSignerPeerCredentialV2(conn net.Conn, expectedUID int) (signerPeerCredentialV2, error) {
	return admintransport.RequirePeerCredential(conn, expectedUID)
}

func readSignerPeerCredentialV2(conn net.Conn) (signerPeerCredentialV2, error) {
	return admintransport.ReadPeerCredential(conn)
}
