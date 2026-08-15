package hostsecurity

import (
	"errors"
)

const CurrentOwnershipSchemaVersion uint32 = 1

// Ownership is the durable uninstall baseline. Unlike the active transaction
// state, it is written once and is never replaced by later updates.
type Ownership struct {
	SchemaVersion uint32 `json:"schemaVersion"`
	TransactionID string `json:"transactionId"`
	GatewayPort   uint16 `json:"gatewayPort"`
	OperatorUser  string `json:"operatorUser"`

	TailscaleInstallOwned    bool   `json:"tailscaleInstallOwned,omitempty"`
	TailscaleInstallSnapshot string `json:"tailscaleInstallSnapshot,omitempty"`
	AuthenticationOwned      bool   `json:"authenticationOwned,omitempty"`
	ServeOwned               bool   `json:"serveOwned,omitempty"`
	PreviousServe            string `json:"previousServe,omitempty"`
	SignerWebAuthnOwned      bool   `json:"signerWebAuthnOwned,omitempty"`
	SignerWebAuthnExisted    bool   `json:"signerWebAuthnExisted,omitempty"`
	PreviousSignerWebAuthn   string `json:"previousSignerWebAuthn,omitempty"`
	HardeningOwned           bool   `json:"hardeningOwned,omitempty"`
	HardeningSnapshot        string `json:"hardeningSnapshot,omitempty"`
}

func ownershipFromCommittedState(state State) (Ownership, error) {
	if err := state.Validate(); err != nil || state.Phase != PhaseCommitted || !state.HardeningCommitted {
		return Ownership{}, errors.Join(err, errors.New("Hosting ownership requires committed state"))
	}
	ownership := Ownership{
		SchemaVersion: CurrentOwnershipSchemaVersion, TransactionID: state.TransactionID,
		GatewayPort: state.GatewayPort, OperatorUser: state.OperatorUser,
		TailscaleInstallOwned: state.TailscaleInstallStarted, TailscaleInstallSnapshot: state.TailscaleInstallSnapshot,
		AuthenticationOwned: state.AuthenticationStarted,
		ServeOwned:          state.ServeMutationStarted, PreviousServe: state.PreviousServe,
		SignerWebAuthnOwned:    state.SignerWebAuthnMutationStarted,
		SignerWebAuthnExisted:  state.SignerWebAuthnPreviouslyExisted,
		PreviousSignerWebAuthn: state.PreviousSignerWebAuthn,
		HardeningOwned:         state.HardeningStarted, HardeningSnapshot: state.HardeningSnapshot,
	}
	return ownership, ownership.Validate()
}

func (ownership Ownership) Validate() error {
	if ownership.SchemaVersion != CurrentOwnershipSchemaVersion || !uuidV4Pattern.MatchString(ownership.TransactionID) ||
		ownership.GatewayPort == 0 || !accountPattern.MatchString(ownership.OperatorUser) || ownership.OperatorUser == "root" ||
		len(ownership.TailscaleInstallSnapshot) > maxOpaqueSnapshot || len(ownership.PreviousServe) > maxOpaqueSnapshot ||
		len(ownership.PreviousSignerWebAuthn) > 4096 || len(ownership.HardeningSnapshot) > maxOpaqueSnapshot {
		return errors.New("Hosting ownership identity is invalid")
	}
	if ownership.TailscaleInstallOwned != (ownership.TailscaleInstallSnapshot != "") ||
		!ownership.ServeOwned && ownership.PreviousServe != "" ||
		ownership.SignerWebAuthnExisted && (!ownership.SignerWebAuthnOwned || ownership.PreviousSignerWebAuthn == "") ||
		!ownership.SignerWebAuthnOwned && ownership.PreviousSignerWebAuthn != "" ||
		ownership.HardeningOwned != (ownership.HardeningSnapshot != "") {
		return errors.New("Hosting ownership rollback fields are inconsistent")
	}
	return nil
}
