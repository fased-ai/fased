package hostsecurity

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
)

var errHardeningReconciliationRequired = errors.New("Hosting hardening reconciliation is required")

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
	StageLifecyclePrerequisites(context.Context, string, io.Writer) error
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
	var resumed *State
	if previous, err := participant.Store.ReadState(); err == nil {
		switch previous.Phase {
		case PhasePreflight, PhasePreparing, PhaseAborting:
			if !previous.matchesIncompleteBoundary(request) {
				return State{}, errors.New("an incomplete Hosting security transaction has a different update channel or platform identity")
			}
			if err := participant.abort(ctx, previous, nil); err != nil {
				return State{}, fmt.Errorf("recover previous Hosting security transaction: %w", err)
			}
		case PhasePrerequisitesReady:
			if !previous.matchesIncompleteBoundary(request) {
				return State{}, errors.New("an incomplete Hosting security transaction has a different update channel or platform identity")
			}
			inspection, inspectErr := participant.Host.Inspect(ctx, previous.GatewayPort, previous.OperatorUser)
			if inspectErr != nil || !inspection.LifecyclePrerequisitesReady {
				return State{}, errors.Join(inspectErr, errors.New("incomplete Hosting prerequisites no longer match the prepared host"))
			}
			if previous.Release != request.Release {
				previous.TransactionID = request.TransactionID
				previous.Release = request.Release
				if err := participant.Store.WriteState(previous); err != nil {
					return State{}, fmt.Errorf("rebind incomplete Hosting prerequisites: %w", err)
				}
			}
			resumed = &previous
		case PhaseHardening, PhaseHardeningReady:
			if !previous.matchesIncompleteBoundary(request) {
				return State{}, errors.New("an incomplete Hosting security transaction has a different update channel or platform identity")
			}
			inspection, inspectErr := participant.Host.Inspect(ctx, previous.GatewayPort, previous.OperatorUser)
			if inspectErr != nil || !previous.matchesPreparedHost(inspection) || !inspection.SignerReady || inspection.AppCanElevate {
				return State{}, errors.Join(inspectErr, errors.New("incomplete Hosting hardening boundary is not intact"))
			}
			finalized, finalizeErr := participant.Commit(ctx, previous.TransactionID, previous.AccessConfirmed)
			if finalizeErr != nil {
				return State{}, fmt.Errorf("finish previous Hosting hardening: %w", finalizeErr)
			}
			if finalized.matches(request) {
				return finalized, nil
			}
		case PhasePrepared, PhasePrivateNetworkReady, PhaseGenerationReady, PhaseRuntimeReady, PhaseOnboardingPending, PhaseOnboardingComplete:
			if !previous.matchesIncompleteBoundary(request) {
				return State{}, errors.New("an incomplete Hosting security transaction has a different update channel or platform identity")
			}
			inspection, inspectErr := participant.Host.Inspect(ctx, previous.GatewayPort, previous.OperatorUser)
			if inspectErr != nil || !previous.matchesPreparedHost(inspection) {
				return State{}, errors.Join(inspectErr, errors.New("incomplete Hosting security transaction no longer matches the prepared host"))
			}
			if !inspection.SignerWebAuthnReady {
				if err := participant.Host.ConfigureSignerWebAuthn(ctx, previous.TailscaleDNS, previous.Phase != PhasePrepared); err != nil {
					return State{}, fmt.Errorf("recover signer WebAuthn identity: %w", err)
				}
				inspection, inspectErr = participant.Host.Inspect(ctx, previous.GatewayPort, previous.OperatorUser)
				if inspectErr != nil || !previous.matchesPreparedHost(inspection) || !inspection.SignerWebAuthnReady {
					return State{}, errors.Join(inspectErr, errors.New("recovered signer WebAuthn identity did not converge"))
				}
			}
			if previous.RuntimeReady && (!inspection.SignerReady || inspection.AppCanElevate) {
				return State{}, errors.New("incomplete Hosting runtime boundary is not intact")
			}
			if previous.Phase == PhaseGenerationReady && (!inspection.SignerReady || inspection.AppCanElevate) {
				return State{}, errors.New("incomplete Hosting generation boundary is not intact")
			}
			if previous.SchemaVersion == 1 {
				previous.SchemaVersion = CurrentSchemaVersion
				previous.PlatformIdentity = request.PlatformIdentity
				previous.TrustRootSHA256 = request.TrustRootSHA256
				previous.OnboardingRequired = request.OnboardingRequired
				previous.LegacyRuntimeBindingPending = previous.RuntimeReady
			}
			if previous.Release != request.Release {
				previous.TransactionID = request.TransactionID
				previous.Release = request.Release
				if err := participant.Store.WriteState(previous); err != nil {
					return State{}, fmt.Errorf("rebind incomplete Hosting security transaction: %w", err)
				}
			}
			// Runtime-ready recovery must repair or replace the pending receipt
			// after the durable state write. This closes the crash window between
			// state rebinding and receipt publication without trusting stale bytes.
			if previous.RuntimeReady {
				if err := participant.Store.WriteReceipt(previous, false); err != nil {
					return State{}, fmt.Errorf("publish rebound Hosting security receipt: %w", err)
				}
			}
			return previous, nil
		case PhaseCommitted:
			if previous.matches(request) {
				if err := participant.validateCommittedBoundary(ctx, previous); err == nil {
					return previous, nil
				} else if !errors.Is(err, errHardeningReconciliationRequired) {
					return State{}, err
				}
			} else {
				// Acquisition has already authenticated request.TrustRootSHA256 before
				// the host-security participant runs. A committed host boundary must
				// therefore survive an authorized lifecycle trust-root rotation while
				// still rejecting changes to the host, channel, or platform identity.
				// Incomplete transactions remain pinned to their original trust root.
				if !previous.matchesCommittedHostBoundary(request) {
					return State{}, errors.New("committed Hosting security transaction has a different update channel or platform identity")
				}
			}
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
	state := State{}
	if resumed != nil {
		state = *resumed
	} else {
		state = State{SchemaVersion: CurrentSchemaVersion, TransactionID: request.TransactionID, Release: request.Release,
			Channel: request.Channel, GatewayPort: request.GatewayPort, OperatorUser: request.OperatorUser,
			PlatformIdentity: request.PlatformIdentity, TrustRootSHA256: request.TrustRootSHA256,
			OnboardingRequired: request.OnboardingRequired, Phase: PhasePreflight}
		if err := participant.Store.WriteState(state); err != nil {
			return State{}, err
		}
	}
	inspection, err := participant.Host.Inspect(ctx, request.GatewayPort, request.OperatorUser)
	if err != nil {
		return State{}, participant.abort(ctx, state, err)
	}
	if !inspection.LifecyclePrerequisitesReady {
		participant.progress("Fased: installing lifecycle ACL prerequisites...")
		snapshot, snapshotErr := participant.Host.SnapshotHardening(ctx, request.OperatorUser, participant.log())
		if snapshotErr != nil {
			return State{}, participant.abort(ctx, state, snapshotErr)
		}
		state.HardeningStarted = true
		state.HardeningSnapshot = snapshot
		if err := participant.Store.WriteState(state); err != nil {
			return State{}, err
		}
		if err := participant.Host.StageLifecyclePrerequisites(ctx, snapshot, participant.log()); err != nil {
			return State{}, participant.abort(ctx, state, err)
		}
		state.LifecyclePrerequisitesStaged = true
		if err := participant.Store.WriteState(state); err != nil {
			return State{}, participant.abort(ctx, state, err)
		}
		inspection, err = participant.Host.Inspect(ctx, request.GatewayPort, request.OperatorUser)
		if err != nil || !inspection.LifecyclePrerequisitesReady {
			return State{}, participant.abort(ctx, state, errors.Join(err, errors.New("Hosting lifecycle prerequisites did not converge")))
		}
	}
	if state.Phase == PhasePreflight || state.Phase == PhasePreparing {
		state.Phase = PhasePrerequisitesReady
		if err := participant.Store.WriteState(state); err != nil {
			return State{}, participant.abort(ctx, state, err)
		}
	}
	if request.RequireExistingHardening && inspection.AppCanElevate {
		return State{}, participant.abort(ctx, state, errors.New("Hosting update refused: operator_can_elevate"))
	}
	if request.RequireExistingHardening && !inspection.HardeningReady && !inspection.LegacyHardeningReady {
		if len(inspection.HardeningIssues) == 0 {
			return State{}, participant.abort(ctx, state, errors.New("Hosting update refused: hardening_issue_unclassified"))
		}
		state, inspection, err = participant.reconcileExistingHardening(ctx, state, inspection)
		if err != nil {
			return State{}, err
		}
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
	state.Phase = PhasePrivateNetworkReady
	if err := participant.Store.WriteState(state); err != nil {
		return State{}, participant.abort(ctx, state, err)
	}
	return state, nil
}

func (participant Participant) BindRuntimeReady(ctx context.Context, transactionID, generationID, convergenceReceiptDigest string, onboardingRequired bool) (State, error) {
	if !sha256IDPattern.MatchString(generationID) || !sha256IDPattern.MatchString(convergenceReceiptDigest) {
		return State{}, errors.New("Hosting runtime binding is invalid")
	}
	state, err := participant.boundState(transactionID)
	if err != nil {
		return State{}, err
	}
	if state.Phase == PhaseCommitted {
		if state.LifecycleGenerationID != generationID || state.ConvergenceReceiptDigest != convergenceReceiptDigest {
			return State{}, errors.New("committed Hosting runtime binding differs from the active generation")
		}
		return state, nil
	}
	if state.Phase != PhasePrepared && state.Phase != PhasePrivateNetworkReady && state.Phase != PhaseGenerationReady &&
		state.Phase != PhaseRuntimeReady && state.Phase != PhaseOnboardingPending && state.Phase != PhaseOnboardingComplete {
		return State{}, errors.New("Hosting security transaction is not prepared")
	}
	inspection, err := participant.Host.Inspect(ctx, state.GatewayPort, state.OperatorUser)
	if err != nil || !inspection.TailscaleRunning || !inspection.Authenticated || !inspection.PrivateServeReady || !inspection.SignerWebAuthnReady || !inspection.SignerReady || inspection.AppCanElevate {
		return State{}, errors.Join(err, errors.New("Hosting runtime is not safe before host-security handoff"))
	}
	if state.Phase == PhasePrepared || state.Phase == PhasePrivateNetworkReady || state.Phase == PhaseGenerationReady {
		state.LifecycleGenerationID = generationID
		state.ConvergenceReceiptDigest = ""
		state.RuntimeReady = false
		state.Phase = PhaseGenerationReady
		if err := participant.Store.WriteState(state); err != nil {
			return State{}, err
		}
	}
	state.RuntimeReady = true
	state.LifecycleGenerationID = generationID
	state.ConvergenceReceiptDigest = convergenceReceiptDigest
	state.LegacyRuntimeBindingPending = false
	state.OnboardingRequired = state.OnboardingRequired || onboardingRequired
	if state.OnboardingRequired && !state.OnboardingComplete {
		state.Phase = PhaseOnboardingPending
	} else {
		state.OnboardingComplete = true
		state.Phase = PhaseRuntimeReady
	}
	if err := participant.Store.WriteState(state); err != nil {
		return State{}, err
	}
	if err := participant.Store.WriteReceipt(state, false); err != nil {
		return State{}, err
	}
	return state, nil
}

func (participant Participant) MarkOnboardingComplete(transactionID string) (State, error) {
	state, err := participant.boundState(transactionID)
	if err != nil {
		return State{}, err
	}
	if state.Phase == PhaseCommitted || state.Phase == PhaseHardening || state.Phase == PhaseOnboardingComplete {
		return state, nil
	}
	if !state.RuntimeReady || state.Phase != PhaseOnboardingPending {
		return State{}, errors.New("Hosting coordinator is not awaiting onboarding")
	}
	state.OnboardingComplete = true
	state.Phase = PhaseOnboardingComplete
	if err := participant.Store.WriteState(state); err != nil {
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
	if state.Phase == PhaseRuntimeReady && !state.OnboardingComplete {
		return State{}, errors.New("Hosting coordinator onboarding is incomplete")
	}
	if state.Phase != PhaseRuntimeReady && state.Phase != PhaseOnboardingComplete && state.Phase != PhaseHardening && state.Phase != PhaseHardeningReady {
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
	if !inspection.HardeningReady {
		participant.progress("Fased: staging firewall, SSH, fail2ban, and security updates...")
		if !state.HardeningStarted {
			snapshot, err := participant.Host.SnapshotHardening(ctx, state.OperatorUser, participant.log())
			if err != nil {
				return State{}, participant.abort(ctx, state, err)
			}
			state.HardeningStarted = true
			state.HardeningSnapshot = snapshot
		}
		state.Phase = PhaseHardening
		if err := participant.Store.WriteState(state); err != nil {
			return State{}, err
		}
		if !state.HardeningStaged {
			if err := participant.Host.StageHardening(ctx, state.HardeningSnapshot, participant.log()); err != nil {
				return State{}, participant.abort(ctx, state, err)
			}
			state.HardeningStaged = true
			if err := participant.Store.WriteState(state); err != nil {
				return State{}, participant.abort(ctx, state, err)
			}
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
	state.Phase = PhaseHardeningReady
	if err := participant.Store.WriteState(state); err != nil {
		return State{}, err
	}
	ownershipState := state
	ownershipState.Phase = PhaseCommitted
	if _, err := participant.Store.EnsureOwnership(ownershipState); err != nil {
		return State{}, err
	}
	state.Phase = PhaseCommitted
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
		_, _ = fmt.Fprintln(participant.User, formatHostingProgressFrame(message))
	}
}

func (participant Participant) reconcileExistingHardening(ctx context.Context, state State, inspection Inspection) (State, Inspection, error) {
	participant.progress("Fased: reconciling Hosting security boundary (" + hardeningIssueSummary(inspection.HardeningIssues) + ")...")
	if !state.HardeningStarted {
		snapshot, err := participant.Host.SnapshotHardening(ctx, state.OperatorUser, participant.log())
		if err != nil {
			return State{}, Inspection{}, participant.abort(ctx, state, err)
		}
		state.HardeningStarted = true
		state.HardeningSnapshot = snapshot
		if err := participant.Store.WriteState(state); err != nil {
			return State{}, Inspection{}, err
		}
	}
	if !state.HardeningStaged {
		if err := participant.Host.StageHardening(ctx, state.HardeningSnapshot, participant.log()); err != nil {
			return State{}, Inspection{}, participant.abort(ctx, state, err)
		}
		state.HardeningStaged = true
		if err := participant.Store.WriteState(state); err != nil {
			return State{}, Inspection{}, participant.abort(ctx, state, err)
		}
	}
	if err := participant.Host.CommitHardening(ctx, state.HardeningSnapshot); err != nil {
		return State{}, Inspection{}, participant.abort(ctx, state, err)
	}
	converged, err := participant.Host.Inspect(ctx, state.GatewayPort, state.OperatorUser)
	if err != nil || !converged.HardeningReady || converged.AppCanElevate {
		cause := errors.Join(err, fmt.Errorf("Hosting hardening reconciliation did not converge: %s", hardeningIssueSummary(converged.HardeningIssues)))
		return State{}, Inspection{}, participant.abort(ctx, state, cause)
	}
	state.HardeningReconciled = true
	state.SchemaVersion = CurrentSchemaVersion
	if err := participant.Store.WriteState(state); err != nil {
		return State{}, Inspection{}, err
	}
	return state, converged, nil
}

func hardeningIssueSummary(issues []HardeningIssue) string {
	if len(issues) == 0 {
		return "none"
	}
	values := make([]string, len(issues))
	for index, issue := range issues {
		values[index] = string(issue)
	}
	return strings.Join(values, ",")
}

func formatHostingProgressFrame(message string) string {
	message = strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(message, "Fased:"), "..."))
	return fmt.Sprintf("\n  ╭─ HOSTING SETUP ───────────────────────────────────────────────────────────────╮\n  │ %-78s │\n  ╰───────────────────────────────────────────────────────────────────────────────╯", message)
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
	if state.HardeningStarted && !state.HardeningReconciled {
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
	// The public receipt is first published by BindRuntimeReady. Earlier phases
	// cannot own it, so recovery must preserve any predecessor receipt instead
	// of trying to parse or remove it.
	if state.RuntimeReady {
		failures = append(failures, participant.Store.RemoveReceiptOwned(state.TransactionID))
	}
	state.Phase = PhaseAborted
	state.RuntimeReady, state.OnboardingComplete, state.AccessConfirmed, state.HardeningCommitted = false, false, false, false
	state.LifecycleGenerationID, state.ConvergenceReceiptDigest = "", ""
	state.LegacyRuntimeBindingPending = false
	state.LifecyclePrerequisitesStaged, state.HardeningStaged = false, false
	state.HardeningAdopted, state.LegacyHardeningAdopted = false, false
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
	return state.Release == request.Release && state.Channel == request.Channel && state.GatewayPort == request.GatewayPort && state.OperatorUser == request.OperatorUser &&
		(state.PlatformIdentity == "" || state.PlatformIdentity == request.PlatformIdentity) &&
		(state.TrustRootSHA256 == "" || state.TrustRootSHA256 == request.TrustRootSHA256)
}

func (state State) matchesIncompleteBoundary(request Request) bool {
	return state.Channel == request.Channel && state.GatewayPort == request.GatewayPort && state.OperatorUser == request.OperatorUser &&
		(state.PlatformIdentity == "" || state.PlatformIdentity == request.PlatformIdentity) &&
		(state.TrustRootSHA256 == "" || state.TrustRootSHA256 == request.TrustRootSHA256)
}

func (state State) matchesCommittedHostBoundary(request Request) bool {
	return state.Channel == request.Channel && state.GatewayPort == request.GatewayPort && state.OperatorUser == request.OperatorUser &&
		(state.PlatformIdentity == "" || state.PlatformIdentity == request.PlatformIdentity)
}

func (state State) matchesPreparedHost(inspection Inspection) bool {
	return inspection.LifecyclePrerequisitesReady && inspection.TailscaleInstalled && inspection.TailscaleRunning && inspection.Authenticated &&
		validDNS(inspection.TailscaleDNS) && ipv4Pattern.MatchString(inspection.TailscaleIPv4) && versionPattern.MatchString(inspection.TailscaleVersion) &&
		inspection.TailscaleDNS == state.TailscaleDNS && inspection.TailscaleIPv4 == state.TailscaleIPv4 && inspection.TailscaleVersion == state.TailscaleVersion &&
		inspection.PrivateServeReady
}

func (participant Participant) validateCommittedBoundary(ctx context.Context, state State) error {
	ownership, err := participant.Store.ReadOwnership()
	if err != nil {
		return fmt.Errorf("read committed Hosting security ownership: %w", err)
	}
	if ownership.GatewayPort != state.GatewayPort || ownership.OperatorUser != state.OperatorUser {
		return errors.New("committed Hosting security ownership differs from the active platform")
	}
	inspection, err := participant.Host.Inspect(ctx, state.GatewayPort, state.OperatorUser)
	if err != nil || !inspection.TailscaleInstalled || !inspection.TailscaleRunning || !inspection.Authenticated ||
		!validDNS(inspection.TailscaleDNS) || !ipv4Pattern.MatchString(inspection.TailscaleIPv4) || !versionPattern.MatchString(inspection.TailscaleVersion) ||
		inspection.TailscaleDNS != state.TailscaleDNS || inspection.TailscaleIPv4 != state.TailscaleIPv4 || inspection.TailscaleVersion != state.TailscaleVersion ||
		!inspection.PrivateServeReady || !inspection.SignerWebAuthnReady || !inspection.SignerReady {
		return errors.Join(err, errors.New("committed Hosting security boundary is not intact"))
	}
	if inspection.AppCanElevate {
		return errors.New("committed Hosting security boundary is unsafe: operator_can_elevate")
	}
	if !inspection.HardeningReady {
		if len(inspection.HardeningIssues) == 0 {
			return errors.New("committed Hosting security boundary is not intact: hardening_issue_unclassified")
		}
		return fmt.Errorf("%w: %s", errHardeningReconciliationRequired, hardeningIssueSummary(inspection.HardeningIssues))
	}
	return nil
}
