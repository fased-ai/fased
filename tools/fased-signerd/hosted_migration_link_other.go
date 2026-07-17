//go:build !linux

package main

import (
	"errors"
	"os"
)

func linkHostedMigrationDescriptorV1(_ *os.File, _ string) error {
	return errors.New("hosted signer migration requires Linux descriptor linking")
}
