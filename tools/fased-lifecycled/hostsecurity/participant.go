package hostsecurity

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
)

type Host interface {
	Inspect(context.Context, uint16, string) (Inspection, error)
	SnapshotTailscaleInstall(context.Context) (string, error)
	InstallTailscale(context.Context, io.Writer) error
	RestoreTailscaleInstall(context.Context, string) error
	EnableTailscale(context.Context) error
	Authenticate(context.Context, string, bool, io.Writer) error
	SnapshotPrivateServe(context.Context) (string, error)
	ConfigurePrivateServe(context.Context, uint16) error
	RestorePrivateServe(context.Context, string) error
	SnapshotSignerWebAuthn(context.Context) (string, bool, error)
	ConfigureSignerWebAuthn(context.Context, string, bool) error
	RestoreSignerWebAuthn(context.Context, string, bool) error
	LogoutTailscale(context.Context) error
	SnapshotHardening(context.Context, string, io.Writer) (string, error)
	StageHardening(context.Context, string, io.Writer) error
	CommitHardening(context.Context, string) error
	RestoreHardening(context.Context, string) error
}

type Participant struct {
	Store Store
	Host  Host
	Log   io.Writer
	User  io.Writer
}

func (participant Participant) Prepare(ctx context.Context, request Request) (State, error) {
	if err := request.Validate(); err != nil || participant.Host == nil {
		return State{}, errors.Join(err, errors.New("Hosting security participant is incomplete"))
	}
	participant.progress("Fased: checking private Hosting access...")
	if previous, err := participant.Store.ReadState(); err == nil {
		switch previous.Phase {
		case PhasePreparing, PhaseAborting:
			if err := participant.abort(ctx, previous, nil); err != nil {
				return State{}, fmt.Errorf("recover previous Hosting security transaction: %w", err)
			}
		case PhasePrepared, PhaseRuntimeReady, PhaseHardening:
			if !previous.matches(request) {
				return State{}, errors.New("an incomplete Hosting security transaction has different release or platform identity")
			}
			inspection, inspectErr := participant.Host.Inspect(ctx, previous.GatewayPort, previous.OperatorUser)
			if inspectErr != nil || !inspection.TailscaleRunning || !inspection.Authenticated || !inspection.PrivateServeReady {
				return State{}, errors.Join(inspectErr, errors.New("incomplete Hosting security transaction no longer matches the prepared host"))
			}
			if !inspection.SignerWebAuthnReady {
				if err := participant.Host.ConfigureSignerWebAuthn(ctx, previous.TailscaleDNS, previous.Phase != PhasePrepared); err != nil {
					return State{}, fmt.Errorf("recover signer WebAuthn identity: %w", err)
				}
			}
			return previous, nil
		case PhaseCommitted:
			if _, err := participant.Store.EnsureOwnership(previous); err != nil {
				return State{}, fmt.Errorf("preserve Hosting uninstall baseline: %w", err)
			}
		case PhaseAborted:
			// The prior transaction already has a durable terminal state.
		default:
			return State{}, errors.New("previous Hosting security transaction has an unsupported phase")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return State{}, fmt.Errorf("read previous Hosting security transaction: %w", err)
	}
	state := State{SchemaVersion: CurrentSchemaVersion, TransactionID: request.TransactionID, Release: request.Release,
		Channel: request.Channel, GatewayPort: request.GatewayPort, OperatorUser: request.OperatorUser, Phase: PhasePreparing}
	if err := participant.Store.WriteState(state); err != nil {
		return State{}, err
	}
	inspection, err := participant.Host.Inspect(ctx, request.GatewayPort, request.OperatorUser)
	if err != nil {
		return State{}, participant.abort(ctx, state, err)
	}
	if request.RequireExistingHardening && (!inspection.HardeningReady && !inspection.LegacyHardeningReady || inspection.AppCanElevate) {
		return State{}, participant.abort(ctx, state, errors.New("Hosting update refused because the installed host-security boundary is not intact"))
	}
	if !inspection.TailscaleInstalled {
		participant.progress("Fased: installing Tailscale...")
		snapshot, err := participant.Host.SnapshotTailscaleInstall(ctx)
		if err != nil {
			return State{}, participant.abort(ctx, state, err)
		}
		state.TailscaleInstallStarted = true
		state.TailscaleInstallSnapshot = snapshot
		if err := participant.Store.WriteState(state); err != nil {
			return State{}, err
		}
		if err := participant.Host.InstallTailscale(ctx, participant.log()); err != nil {
			return State{}, participant.abort(ctx, state, err)
		}
		state.TailscaleInstalledByTransaction = true
		if err := participant.Store.WriteState(state); err != nil {
			return State{}, participant.abort(ctx, state, err)
		}
	}
	if err := participant.Host.EnableTailscale(ctx); err != nil {
		return State{}, participant.abort(ctx, state, err)
	}
	inspection, err = participant.Host.Inspect(ctx, request.GatewayPort, request.OperatorUser)
	if err != nil {
		return State{}, participant.abort(ctx, state, err)
	}
	if !inspection.Authenticated {
		participant.progress("Fased: waiting for Tailscale authentication...")
		state.AuthenticationStarted = true
		if err := participant.Store.WriteState(state); err != nil {
			return State{}, err
		}
		if err := participant.Host.Authenticate(ctx, request.AuthKeyFile, request.Interactive, participant.user()); err != nil {
			return State{}, participant.abort(ctx, state, err)
		}
		state.AuthenticatedByTransaction = true
		if err := participant.Store.WriteState(state); err != nil {
			return State{}, participant.abort(ctx, state, err)
		}
	}
	inspection, err = participant.Host.Inspect(ctx, request.GatewayPort, request.OperatorUser)
	if err != nil || !inspection.TailscaleRunning || !inspection.Authenticated || !validDNS(inspection.TailscaleDNS) || !ipv4Pattern.MatchString(inspection.TailscaleIPv4) || !versionPattern.MatchString(inspection.TailscaleVersion) {
		return State{}, participant.abort(ctx, state, errors.Join(err, errors.New("Tailscale did not converge to an authenticated identity")))
	}
	state.TailscaleDNS, state.TailscaleIPv4, state.TailscaleVersion = inspection.TailscaleDNS, inspection.TailscaleIPv4, inspection.TailscaleVersion
	if inspection.LegacyHardeningReady {
		state.AccessConfirmed = true
		state.LegacyHardeningAdopted = true
	}
	previousSignerWebAuthn, previousSignerWebAuthnExisted, err := participant.Host.SnapshotSignerWebAuthn(ctx)
	if err != nil {
		return State{}, participant.abort(ctx, state, err)
	}
	state.SignerWebAuthnMutationStarted = true
	state.SignerWebAuthnPreviouslyExisted = previousSignerWebAuthnExisted
	state.PreviousSignerWebAuthn = previousSignerWebAuthn
	if err := participant.Store.WriteState(state); err != nil {
		return State{}, err
	}
	if err := participant.Host.ConfigureSignerWebAuthn(ctx, state.TailscaleDNS, request.RequireExistingHardening); err != nil {
		return State{}, participant.abort(ctx, state, err)
	}
	state.SignerWebAuthnChanged = true
	if err := participant.Store.WriteState(state); err != nil {
		return State{}, participant.abort(ctx, state, err)
	}
	if !inspection.PrivateServeReady {
		participant.progress("Fased: configuring private Tailscale Serve...")
		previous, err := participant.Host.SnapshotPrivateServe(ctx)
		if err != nil {
			return State{}, participant.abort(ctx, state, err)
		}
		state.ServeMutationStarted = true
		state.PreviousServe = previous
		if err := participant.Store.WriteState(state); err != nil {
			return State{}, err
		}
		if err := participant.Host.ConfigurePrivateServe(ctx, request.GatewayPort); err != nil {
			return State{}, participant.abort(ctx, state, err)
		}
		state.ServeChanged = true
		if err := participant.Store.WriteState(state); err != nil {
			return State{}, participant.abort(ctx, state, err)
		}
	}
	inspection, err = participant.Host.Inspect(ctx, request.GatewayPort, request.OperatorUser)
	if err != nil || !inspection.PrivateServeReady || !inspection.SignerWebAuthnReady {
		return State{}, participant.abort(ctx, state, errors.Join(err, errors.New("private Tailscale Serve route is not ready")))
	}
	state.Phase = PhasePrepared
	if err := participant.Store.WriteState(state); err != nil {
		return State{}, participant.abort(ctx, state, err)
	}
	return state, nil
}

func (participant Participant) MarkRuntimeReady(ctx context.Context, transactionID string) (State, error) {
	participant.progress("Fased: verifying isolated Gateway and signer...")
	state, err := participant.boundState(transactionID)
	if err != nil {
		return State{}, err
	}
	if state.Phase == PhaseCommitted || state.RuntimeReady {
		return state, nil
	}
	if state.Phase != PhasePrepared {
		return State{}, errors.New("Hosting security transaction is not prepared")
	}
	inspection, err := participant.Host.Inspect(ctx, state.GatewayPort, state.OperatorUser)
	if err != nil || !inspection.TailscaleRunning || !inspection.Authenticated || !inspection.PrivateServeReady || !inspection.SignerWebAuthnReady || !inspection.SignerReady || inspection.AppCanElevate {
		return State{}, errors.Join(err, errors.New("Hosting runtime is not safe before host-security handoff"))
	}
	state.RuntimeReady = true
	state.Phase = PhaseRuntimeReady
	if err := participant.Store.WriteState(state); err != nil {
		return State{}, err
	}
	if err := participant.Store.WriteReceipt(state, false); err != nil {
		return State{}, err
	}
	return state, nil
}

func (participant Participant) Commit(ctx context.Context, transactionID string, accessConfirmed bool) (State, error) {
	state, err := participant.boundState(transactionID)
	if err != nil {
		return State{}, err
	}
	if state.Phase == PhaseCommitted {
		return state, participant.Store.WriteReceipt(state, true)
	}
	if state.Phase != PhaseRuntimeReady && state.Phase != PhaseHardening {
		return State{}, errors.New("Hosting security transaction is not runtime-ready")
	}
	inspection, err := participant.Host.Inspect(ctx, state.GatewayPort, state.OperatorUser)
	if err != nil {
		return State{}, err
	}
	state.AccessConfirmed = state.AccessConfirmed || accessConfirmed || inspection.HardeningReady || inspection.LegacyHardeningReady
	if !state.AccessConfirmed {
		return State{}, errors.New("provider access remains open until independent tailnet access is confirmed")
	}
	if !inspection.HardeningReady && !state.HardeningStarted {
		participant.progress("Fased: staging firewall, SSH, fail2ban, and security updates...")
		snapshot, err := participant.Host.SnapshotHardening(ctx, state.OperatorUser, participant.log())
		if err != nil {
			return State{}, participant.abort(ctx, state, err)
		}
		state.HardeningStarted = true
		state.Phase = PhaseHardening
		state.HardeningSnapshot = snapshot
		if err := participant.Store.WriteState(state); err != nil {
			return State{}, err
		}
		if err := participant.Host.StageHardening(ctx, state.HardeningSnapshot, participant.log()); err != nil {
			return State{}, participant.abort(ctx, state, err)
		}
	}
	if !inspection.HardeningReady {
		if err := participant.Host.CommitHardening(ctx, state.HardeningSnapshot); err != nil {
			return State{}, participant.abort(ctx, state, err)
		}
	} else if !state.HardeningStarted {
		state.HardeningAdopted = true
	}
	inspection, err = participant.Host.Inspect(ctx, state.GatewayPort, state.OperatorUser)
	if err != nil || !inspection.HardeningReady || !inspection.SignerWebAuthnReady || !inspection.SignerReady || inspection.AppCanElevate {
		return State{}, participant.abort(ctx, state, errors.Join(err, errors.New("Hosting hardening did not converge")))
	}
	state.HardeningCommitted = true
	state.Phase = PhaseCommitted
	if _, err := participant.Store.EnsureOwnership(state); err != nil {
		return State{}, err
	}
	if err := participant.Store.WriteState(state); err != nil {
		return State{}, err
	}
	if err := participant.Store.WriteReceipt(state, true); err != nil {
		return State{}, err
	}
	return state, nil
}

func (participant Participant) progress(message string) {
	if participant.User != nil {
		_, _ = fmt.Fprintln(participant.User, message)
	}
}

func (participant Participant) Abort(ctx context.Context, transactionID string) error {
	state, err := participant.boundState(transactionID)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if state.Phase == PhaseCommitted {
		return errors.New("committed Hosting security transaction cannot be aborted")
	}
	return participant.abort(ctx, state, nil)
}

func (participant Participant) abort(ctx context.Context, state State, cause error) error {
	state.Phase = PhaseAborting
	var failures []error
	if err := participant.Store.WriteState(state); err != nil {
		failures = append(failures, err)
	}
	if state.HardeningStarted {
		failures = append(failures, participant.Host.RestoreHardening(ctx, state.HardeningSnapshot))
	}
	if state.ServeMutationStarted {
		failures = append(failures, participant.Host.RestorePrivateServe(ctx, state.PreviousServe))
	}
	if state.SignerWebAuthnMutationStarted {
		failures = append(failures, participant.Host.RestoreSignerWebAuthn(ctx, state.PreviousSignerWebAuthn, state.SignerWebAuthnPreviouslyExisted))
	}
	if state.AuthenticationStarted {
		failures = append(failures, participant.Host.LogoutTailscale(ctx))
	}
	if state.TailscaleInstallStarted {
		failures = append(failures, participant.Host.RestoreTailscaleInstall(ctx, state.TailscaleInstallSnapshot))
	}
	failures = append(failures, participant.Store.RemoveReceiptOwned(state.TransactionID))
	state.Phase = PhaseAborted
	state.RuntimeReady, state.AccessConfirmed, state.HardeningCommitted = false, false, false
	if err := participant.Store.WriteState(state); err != nil {
		failures = append(failures, err)
	}
	joined := errors.Join(append([]error{cause}, failures...)...)
	if joined == nil {
		return nil
	}
	return fmt.Errorf("Hosting security transaction aborted: %w", joined)
}

func (participant Participant) boundState(transactionID string) (State, error) {
	state, err := participant.Store.ReadState()
	if err != nil {
		return State{}, err
	}
	if state.TransactionID != transactionID {
		return State{}, errors.New("Hosting security transaction identity differs from durable state")
	}
	return state, nil
}

func (participant Participant) log() io.Writer {
	if participant.Log != nil {
		return participant.Log
	}
	return io.Discard
}

func (participant Participant) user() io.Writer {
	if participant.User != nil {
		return participant.User
	}
	return io.Discard
}

func (state State) matches(request Request) bool {
	return state.Release == request.Release && state.Channel == request.Channel && state.GatewayPort == request.GatewayPort && state.OperatorUser == request.OperatorUser
}
