// Package hostsecurity owns the root-only Hosting network and operating-system
// security transaction. It deliberately remains separate from application
// onboarding and from replaceable application-generation code.
package hostsecurity

import (
	"errors"
	"regexp"
	"strings"

	"fased-lifecycled/model"
)

const CurrentSchemaVersion uint32 = 1

type Phase string

const (
	PhasePreparing    Phase = "PREPARING"
	PhasePrepared     Phase = "PREPARED"
	PhaseRuntimeReady Phase = "RUNTIME_READY"
	PhaseHardening    Phase = "HARDENING"
	PhaseCommitted    Phase = "COMMITTED"
	PhaseAborting     Phase = "ABORTING"
	PhaseAborted      Phase = "ABORTED"
	maxOpaqueSnapshot       = 128 << 10
)

type Request struct {
	TransactionID            string
	Release                  string
	Channel                  string
	GatewayPort              uint16
	OperatorUser             string
	AuthKeyFile              string
	Interactive              bool
	RequireExistingHardening bool
}

type Inspection struct {
	TailscaleInstalled          bool
	TailscaleRunning            bool
	Authenticated               bool
	TailscaleDNS                string
	TailscaleIPv4               string
	TailscaleVersion            string
	PrivateServeReady           bool
	SignerWebAuthnReady         bool
	LifecyclePrerequisitesReady bool
	HardeningReady              bool
	LegacyHardeningReady        bool
	SignerReady                 bool
	AppCanElevate               bool
}

type State struct {
	SchemaVersion                   uint32 `json:"schemaVersion"`
	TransactionID                   string `json:"transactionId"`
	Release                         string `json:"release"`
	Channel                         string `json:"updateChannel"`
	GatewayPort                     uint16 `json:"gatewayPort"`
	OperatorUser                    string `json:"operatorUser"`
	Phase                           Phase  `json:"phase"`
	TailscaleInstallStarted         bool   `json:"tailscaleInstallStarted,omitempty"`
	TailscaleInstallSnapshot        string `json:"tailscaleInstallSnapshot,omitempty"`
	TailscaleInstalledByTransaction bool   `json:"tailscaleInstalledByTransaction,omitempty"`
	AuthenticationStarted           bool   `json:"authenticationStarted,omitempty"`
	AuthenticatedByTransaction      bool   `json:"authenticatedByTransaction,omitempty"`
	ServeMutationStarted            bool   `json:"serveMutationStarted,omitempty"`
	ServeChanged                    bool   `json:"serveChanged,omitempty"`
	PreviousServe                   string `json:"previousServe,omitempty"`
	SignerWebAuthnMutationStarted   bool   `json:"signerWebAuthnMutationStarted,omitempty"`
	SignerWebAuthnChanged           bool   `json:"signerWebAuthnChanged,omitempty"`
	SignerWebAuthnPreviouslyExisted bool   `json:"signerWebAuthnPreviouslyExisted,omitempty"`
	PreviousSignerWebAuthn          string `json:"previousSignerWebAuthn,omitempty"`
	TailscaleDNS                    string `json:"tailscaleDns,omitempty"`
	TailscaleIPv4                   string `json:"tailscaleIpv4,omitempty"`
	TailscaleVersion                string `json:"tailscaleVersion,omitempty"`
	RuntimeReady                    bool   `json:"runtimeReady,omitempty"`
	AccessConfirmed                 bool   `json:"accessConfirmed,omitempty"`
	HardeningStarted                bool   `json:"hardeningStarted,omitempty"`
	LifecyclePrerequisitesStaged    bool   `json:"lifecyclePrerequisitesStaged,omitempty"`
	HardeningStaged                 bool   `json:"hardeningStaged,omitempty"`
	HardeningAdopted                bool   `json:"hardeningAdopted,omitempty"`
	HardeningSnapshot               string `json:"hardeningSnapshot,omitempty"`
	HardeningCommitted              bool   `json:"hardeningCommitted,omitempty"`
	LegacyHardeningAdopted          bool   `json:"legacyHardeningAdopted,omitempty"`
}

var (
	uuidV4Pattern  = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	accountPattern = regexp.MustCompile(`^[a-z_][a-z0-9_-]{0,31}$`)
	dnsPattern     = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$`)
	ipv4Pattern    = regexp.MustCompile(`^100\.(?:6[4-9]|[789][0-9]|1[01][0-9]|12[0-7])\.(?:[0-9]{1,3})\.(?:[0-9]{1,3})$`)
)

func (request Request) Validate() error {
	if !uuidV4Pattern.MatchString(request.TransactionID) || model.ValidateVersion(request.Release) != nil ||
		(request.Channel != "stable" && request.Channel != "beta") ||
		(strings.Contains(request.Release, "-") && request.Channel != "beta") || request.GatewayPort == 0 ||
		!accountPattern.MatchString(request.OperatorUser) || request.OperatorUser == "root" {
		return errors.New("Hosting security request identity is invalid")
	}
	if request.AuthKeyFile != "" && (!strings.HasPrefix(request.AuthKeyFile, "/") || strings.ContainsAny(request.AuthKeyFile, "\n\r\x00")) {
		return errors.New("Hosting security auth-key path is invalid")
	}
	return nil
}

func (state State) Validate() error {
	request := Request{TransactionID: state.TransactionID, Release: state.Release, Channel: state.Channel, GatewayPort: state.GatewayPort, OperatorUser: state.OperatorUser}
	if state.SchemaVersion != CurrentSchemaVersion || request.Validate() != nil || !validPhase(state.Phase) || len(state.PreviousServe) > maxOpaqueSnapshot || len(state.PreviousSignerWebAuthn) > 4096 || len(state.HardeningSnapshot) > maxOpaqueSnapshot || len(state.TailscaleInstallSnapshot) > maxOpaqueSnapshot {
		return errors.New("Hosting security state is invalid")
	}
	if state.TailscaleDNS != "" && !validDNS(state.TailscaleDNS) {
		return errors.New("Hosting security state contains an invalid Tailscale DNS identity")
	}
	if state.TailscaleIPv4 != "" && !ipv4Pattern.MatchString(state.TailscaleIPv4) {
		return errors.New("Hosting security state contains an invalid Tailscale IPv4 identity")
	}
	if state.TailscaleVersion != "" && !versionPattern.MatchString(state.TailscaleVersion) {
		return errors.New("Hosting security state contains an invalid Tailscale version")
	}
	if state.ServeChanged && !state.ServeMutationStarted || state.AuthenticatedByTransaction && !state.AuthenticationStarted ||
		state.SignerWebAuthnChanged && !state.SignerWebAuthnMutationStarted || state.SignerWebAuthnPreviouslyExisted && state.PreviousSignerWebAuthn == "" ||
		state.TailscaleInstalledByTransaction && !state.TailscaleInstallStarted || state.TailscaleInstallStarted && state.TailscaleInstallSnapshot == "" || state.RuntimeReady && state.Phase == PhasePreparing ||
		state.LifecyclePrerequisitesStaged && (!state.HardeningStarted || state.HardeningSnapshot == "") ||
		state.HardeningStaged && (!state.HardeningStarted || state.HardeningSnapshot == "") ||
		state.HardeningStarted != (state.HardeningSnapshot != "") ||
		state.HardeningCommitted && ((!state.HardeningStarted && !state.HardeningAdopted) || !state.RuntimeReady || !state.AccessConfirmed) ||
		state.Phase == PhaseCommitted && !state.HardeningCommitted || state.LegacyHardeningAdopted && !state.AccessConfirmed ||
		state.Phase != PhasePreparing && state.Phase != PhaseAborting && state.Phase != PhaseAborted && !state.SignerWebAuthnChanged {
		return errors.New("Hosting security state transition flags are inconsistent")
	}
	return nil
}

func validPhase(phase Phase) bool {
	switch phase {
	case PhasePreparing, PhasePrepared, PhaseRuntimeReady, PhaseHardening, PhaseCommitted, PhaseAborting, PhaseAborted:
		return true
	default:
		return false
	}
}

func validDNS(value string) bool {
	return len(value) <= 253 && dnsPattern.MatchString(value) && !strings.Contains(value, "..")
}

var versionPattern = regexp.MustCompile(`^[0-9]+\.[0-9]+(?:\.[0-9]+)?(?:-[0-9A-Za-z.-]+)?$`)
