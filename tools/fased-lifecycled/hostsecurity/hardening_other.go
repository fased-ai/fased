//go:build !linux

package hostsecurity

import (
	"context"
	"errors"
	"io"
)

var errLinuxHostingOnly = errors.New("Hosting host-security is supported only on Linux")

func (host LinuxHost) lifecyclePrerequisitesReady() (bool, error) {
	return false, errLinuxHostingOnly
}

func (host LinuxHost) SnapshotTailscaleInstall(context.Context) (string, error) {
	return "", errLinuxHostingOnly
}

func (host LinuxHost) RestoreTailscaleInstall(context.Context, string) error {
	return errLinuxHostingOnly
}

func (host LinuxHost) SnapshotSignerWebAuthn(context.Context) (string, bool, error) {
	return "", false, errLinuxHostingOnly
}

func (host LinuxHost) ConfigureSignerWebAuthn(context.Context, string, bool) error {
	return errLinuxHostingOnly
}

func (host LinuxHost) RestoreSignerWebAuthn(context.Context, string, bool) error {
	return errLinuxHostingOnly
}

func (host LinuxHost) SnapshotHardening(context.Context, string, io.Writer) (string, error) {
	return "", errLinuxHostingOnly
}

func (host LinuxHost) StageHardening(context.Context, string, io.Writer) error {
	return errLinuxHostingOnly
}

func (host LinuxHost) StageLifecyclePrerequisites(context.Context, string, io.Writer) error {
	return errLinuxHostingOnly
}

func (host LinuxHost) CommitHardening(context.Context, string) error {
	return errLinuxHostingOnly
}

func (host LinuxHost) RestoreHardening(context.Context, string) error {
	return errLinuxHostingOnly
}

func (host LinuxHost) hardeningReady(context.Context) bool {
	return false
}

func (host LinuxHost) inspectHardening(context.Context) ([]HardeningIssue, error) {
	return nil, errLinuxHostingOnly
}

func (host LinuxHost) signerWebAuthnReady(string) bool {
	return false
}

func (host LinuxHost) legacyHardeningReady(context.Context, Inspection, uint16) bool {
	return false
}
