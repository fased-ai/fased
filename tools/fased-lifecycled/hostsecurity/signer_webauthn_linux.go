package hostsecurity

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
)

const signerWebAuthnPath = "/etc/fased/signerd-webauthn.env"

func renderSignerWebAuthn(dns string) ([]byte, error) {
	if !validDNS(dns) {
		return nil, errors.New("Tailscale DNS identity is invalid for signer WebAuthn")
	}
	return []byte("FASED_WALLET_WEBAUTHN_RP_ID=" + dns + "\nFASED_WALLET_WEBAUTHN_ORIGINS=https://" + dns + "\n"), nil
}

func (host LinuxHost) SnapshotSignerWebAuthn(context.Context) (string, bool, error) {
	data, err := readSecureRootFile(host.path(signerWebAuthnPath), 0o644, uint32(os.Getuid()), 4096)
	if errors.Is(err, os.ErrNotExist) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return string(data), true, nil
}

func (host LinuxHost) ConfigureSignerWebAuthn(ctx context.Context, dns string, reload bool) error {
	data, err := renderSignerWebAuthn(dns)
	if err != nil {
		return err
	}
	if current, readErr := readSecureRootFile(host.path(signerWebAuthnPath), 0o644, uint32(os.Getuid()), 4096); readErr == nil && bytes.Equal(current, data) {
		return nil
	}
	if err := writeAtomicRootFile(host.path(signerWebAuthnPath), data, 0o644, uint32(os.Getuid())); err != nil {
		return err
	}
	if reload && host.commandSucceeds(ctx, "/usr/bin/systemctl", "is-active", "--quiet", "fased-signerd.service") {
		if err := host.run(ctx, "/usr/bin/systemctl", []string{"restart", "fased-signerd.service"}, nil, io.Discard, io.Discard, nil); err != nil {
			return err
		}
		if !host.commandSucceeds(ctx, "/usr/bin/systemctl", "is-active", "--quiet", "fased-signerd.service") {
			return errors.New("signer did not restart with the repaired WebAuthn identity")
		}
	}
	return nil
}

func (host LinuxHost) RestoreSignerWebAuthn(ctx context.Context, previous string, existed bool) error {
	path := host.path(signerWebAuthnPath)
	if existed {
		if len(previous) == 0 || len(previous) > 4096 {
			return errors.New("previous signer WebAuthn configuration is invalid")
		}
		if err := writeAtomicRootFile(path, []byte(previous), 0o644, uint32(os.Getuid())); err != nil {
			return err
		}
	} else if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if !host.commandSucceeds(ctx, "/usr/bin/systemctl", "is-active", "--quiet", "fased-signerd.service") {
		return nil
	}
	action := "restart"
	if !existed {
		action = "stop"
	}
	return host.run(ctx, "/usr/bin/systemctl", []string{action, "fased-signerd.service"}, nil, io.Discard, io.Discard, nil)
}

func (host LinuxHost) signerWebAuthnReady(dns string) bool {
	expected, err := renderSignerWebAuthn(dns)
	if err != nil {
		return false
	}
	data, err := readSecureRootFile(host.path(signerWebAuthnPath), 0o644, uint32(os.Getuid()), 4096)
	return err == nil && bytes.Equal(data, expected)
}
