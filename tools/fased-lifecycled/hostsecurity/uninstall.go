package hostsecurity

import (
	"context"
	"errors"
	"os"
)

const CurrentUninstallSchemaVersion uint32 = 1

// UninstallRecord is a monotonic recovery journal. A step is recorded only
// after its exact first-install snapshot has been restored. Replaying an
// unrecorded step is required to be idempotent.
type UninstallRecord struct {
	SchemaVersion            uint32 `json:"schemaVersion"`
	OwnershipTransaction     string `json:"ownershipTransaction"`
	GatewayPort              uint16 `json:"gatewayPort"`
	OperatorUser             string `json:"operatorUser"`
	HardeningRestored        bool   `json:"hardeningRestored"`
	ServeRestored            bool   `json:"serveRestored"`
	SignerWebAuthnRestored   bool   `json:"signerWebAuthnRestored"`
	AuthenticationRestored   bool   `json:"authenticationRestored"`
	TailscaleInstallRestored bool   `json:"tailscaleInstallRestored"`
	Completed                bool   `json:"completed"`
}

func (record UninstallRecord) Validate() error {
	if record.SchemaVersion != CurrentUninstallSchemaVersion || !uuidV4Pattern.MatchString(record.OwnershipTransaction) ||
		record.GatewayPort == 0 || !accountPattern.MatchString(record.OperatorUser) || record.OperatorUser == "root" {
		return errors.New("Hosting uninstall identity is invalid")
	}
	if record.Completed && (!record.HardeningRestored || !record.ServeRestored || !record.SignerWebAuthnRestored || !record.AuthenticationRestored || !record.TailscaleInstallRestored) {
		return errors.New("Hosting uninstall completion is inconsistent")
	}
	return nil
}

func newUninstallRecord(ownership Ownership) UninstallRecord {
	return UninstallRecord{
		SchemaVersion: CurrentUninstallSchemaVersion, OwnershipTransaction: ownership.TransactionID,
		GatewayPort: ownership.GatewayPort, OperatorUser: ownership.OperatorUser,
		HardeningRestored: !ownership.HardeningOwned, ServeRestored: !ownership.ServeOwned,
		SignerWebAuthnRestored:   !ownership.SignerWebAuthnOwned,
		AuthenticationRestored:   !ownership.AuthenticationOwned,
		TailscaleInstallRestored: !ownership.TailscaleInstallOwned,
	}
}

// Uninstall restores only controls claimed by the immutable first-install
// ownership baseline. Pre-existing Tailscale, Serve, SSH/firewall, update, and
// signer configuration is adopted and therefore left untouched.
func (participant Participant) Uninstall(ctx context.Context) (UninstallRecord, error) {
	if participant.Host == nil {
		return UninstallRecord{}, errors.New("Hosting security participant is incomplete")
	}
	ownership, err := participant.Store.ReadOwnership()
	if err != nil {
		return UninstallRecord{}, err
	}
	record, err := participant.Store.ReadUninstall()
	if errors.Is(err, os.ErrNotExist) {
		record = newUninstallRecord(ownership)
		if err := participant.Store.WriteUninstall(record); err != nil {
			return UninstallRecord{}, err
		}
	} else if err != nil {
		return UninstallRecord{}, err
	}
	if record.OwnershipTransaction != ownership.TransactionID || record.GatewayPort != ownership.GatewayPort || record.OperatorUser != ownership.OperatorUser {
		return UninstallRecord{}, errors.New("Hosting uninstall journal differs from the ownership baseline")
	}
	if record.Completed {
		return record, nil
	}
	type step struct {
		done *bool
		run  func() error
	}
	steps := []step{
		{&record.HardeningRestored, func() error { return participant.Host.RestoreHardening(ctx, ownership.HardeningSnapshot) }},
		{&record.ServeRestored, func() error { return participant.Host.RestorePrivateServe(ctx, ownership.PreviousServe) }},
		{&record.SignerWebAuthnRestored, func() error {
			return participant.Host.RestoreSignerWebAuthn(ctx, ownership.PreviousSignerWebAuthn, ownership.SignerWebAuthnExisted)
		}},
		{&record.AuthenticationRestored, func() error { return participant.Host.LogoutTailscale(ctx) }},
		{&record.TailscaleInstallRestored, func() error { return participant.Host.RestoreTailscaleInstall(ctx, ownership.TailscaleInstallSnapshot) }},
	}
	for _, current := range steps {
		if *current.done {
			continue
		}
		if err := current.run(); err != nil {
			return record, err
		}
		*current.done = true
		if err := participant.Store.WriteUninstall(record); err != nil {
			return record, err
		}
	}
	record.Completed = true
	if err := participant.Store.WriteUninstall(record); err != nil {
		return record, err
	}
	return record, nil
}
