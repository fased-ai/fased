package main

import (
	"errors"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
)

func main() {
	executable, err := os.Executable()
	if err != nil {
		panic(err)
	}
	payload := filepath.Dir(filepath.Dir(executable))
	if filepath.Base(executable) == "fased-gateway-launch" {
		if _, err := os.Lstat(filepath.Join(payload, "fail-first-start")); err == nil {
			os.Exit(42)
		} else if !errors.Is(err, os.ErrNotExist) {
			panic(err)
		}
		waitForSignal()
		return
	}

	listeners := make([]net.Listener, 0, 3)
	for index, argument := range os.Args[1:] {
		if argument != "-socket" && argument != "-operator-socket" && argument != "-control-socket" {
			continue
		}
		valueIndex := index + 2
		if valueIndex >= len(os.Args) {
			panic("missing socket argument")
		}
		path := os.Args[valueIndex]
		if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
			panic(err)
		}
		_ = os.Remove(path)
		listener, err := net.Listen("unix", path)
		if err != nil {
			panic(err)
		}
		if err := os.Chmod(path, 0o660); err != nil {
			panic(err)
		}
		listeners = append(listeners, listener)
	}
	if len(listeners) != 3 {
		panic("signer fixture did not receive the three canonical sockets")
	}
	waitForSignal()
	for _, listener := range listeners {
		_ = listener.Close()
	}
}

func waitForSignal() {
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)
	<-signals
}
