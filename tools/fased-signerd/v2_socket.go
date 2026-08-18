package main

import (
	"net"

	"fased-signerd/internal/admintransport"
)

func listenUnixSocketV2(socketPath string, mode uint32, groupName string) (net.Listener, error) {
	return admintransport.ListenUnixSocket(socketPath, mode, groupName)
}
