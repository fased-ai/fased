// Package daemon implements the fixed lifecycle request boundary.
package daemon

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"os"
	"sync"
	"time"

	"fased-lifecycled/bundle"
	"fased-lifecycled/engine"
	"fased-lifecycled/model"
	"fased-lifecycled/planner"
	"fased-lifecycled/protocol"
	"fased-lifecycled/store"
)

const absentManifestDigest = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
const supervisorCapability uint32 = 1

type StateStore interface {
	AcquireUpdateLock(string) (store.MutationLock, error)
	StageGeneration(string) error
	ReadManifest() (model.Manifest, string, error)
	ReadJournal(store.Authority, string) (model.Transaction, error)
	ReadCandidateContract(string) (bundle.Inventory, model.Generation, error)
	ReadCandidateAuthority(string) (store.CandidateAuthority, error)
}

type PendingTransactionStore interface {
	PendingSupervisorTransaction() (model.Transaction, error)
}

type StateInventory interface {
	Bind(context.Context, planner.Installation, bundle.Inventory, planner.Plan) (stateDigest, signerPlanDigest string, err error)
}

type Supervisor interface {
	Run(context.Context, model.Transaction) (engine.Result, error)
	Recover(context.Context, model.Transaction) (engine.Result, error)
}

type OnboardingCompleter interface {
	CompleteOnboarding(context.Context) (engine.Result, error)
}

type PublicPredecessorEvidenceVerifier interface {
	VerifyPublicPredecessorEvidence(topology, version string) error
}

type CurrentConvergenceVerifier interface {
	VerifyCurrent(context.Context, model.Manifest, string) (string, error)
}

type CurrentRepairer interface {
	RepairCurrent(context.Context, string, model.Manifest, string) (string, error)
}

type IDGenerator func() (string, error)

type Service struct {
	Profile             model.Profile
	Platform            model.PlatformIdentity
	Store               StateStore
	Inventory           StateInventory
	Supervisor          Supervisor
	Onboarding          OnboardingCompleter
	PredecessorEvidence PublicPredecessorEvidenceVerifier
	CurrentConvergence  CurrentConvergenceVerifier
	CurrentRepair       CurrentRepairer
	NewID               IDGenerator
	Now                 func() time.Time
	mutationMu          sync.Mutex
}

func (service *Service) Handle(ctx context.Context, request protocol.Request) (protocol.Response, error) {
	if err := request.Validate(); err != nil {
		return protocol.Response{}, err
	}
	if err := service.validate(); err != nil {
		return protocol.Response{}, err
	}
	service.mutationMu.Lock()
	defer service.mutationMu.Unlock()
	if err := service.recoverPendingLocked(ctx); err != nil {
		return protocol.Response{}, err
	}
	switch request.Operation {
	case protocol.OperationInspect:
		return service.inspect(request)
	case protocol.OperationConverge:
		return service.converge(ctx, request)
	case protocol.OperationRollback:
		return service.converge(ctx, request)
	case protocol.OperationRepairCurrent:
		return service.repairCurrent(ctx, request)
	case protocol.OperationRecover:
		return service.recover(ctx, request)
	case protocol.OperationCompleteOnboarding:
		return service.completeOnboarding(ctx, request)
	default:
		return protocol.Response{}, errors.New("unsupported lifecycle operation")
	}
}

func (service *Service) repairCurrent(ctx context.Context, request protocol.Request) (protocol.Response, error) {
	if service.CurrentRepair == nil {
		return protocol.Response{}, errors.New("managed repair adapter is unavailable")
	}
	manifest, manifestDigest, err := service.Store.ReadManifest()
	if err != nil {
		return protocol.Response{}, err
	}
	if err := manifest.Validate(); err != nil || manifest.Profile != service.Profile || manifest.ActiveGeneration == nil {
		return protocol.Response{}, errors.Join(err, errors.New("managed repair requires a valid active installation"))
	}
	platformDigest, err := service.Platform.Digest(service.Profile)
	if err != nil {
		return protocol.Response{}, err
	}
	installedPlatformDigest, digestErr := manifest.Platform.Digest(manifest.Profile)
	if digestErr != nil || installedPlatformDigest != platformDigest || request.TargetGenerationID != manifest.ActiveGeneration.ID || request.ExpectedManifestDigest != manifestDigest {
		return protocol.Response{}, errors.New("managed repair identity differs from the installed generation")
	}
	lock, err := service.Store.AcquireUpdateLock(request.RequestID)
	if err != nil {
		return protocol.Response{}, err
	}
	digest, repairErr := service.CurrentRepair.RepairCurrent(ctx, request.RequestID, manifest, manifestDigest)
	releaseErr := lock.Release()
	if repairErr != nil || releaseErr != nil {
		return protocol.Response{}, errors.Join(repairErr, releaseErr)
	}
	if !validConvergenceDigest(digest) {
		return protocol.Response{}, errors.New("managed repair lacks terminal convergence proof")
	}
	result := response(request, "REPAIRED", "", manifest.ActiveGeneration.ID)
	result.ConvergenceReceiptDigest = digest
	return result, nil
}

// RecoverPending converges an unfinished durable transaction before the
// supervisor exposes its request socket. Handle repeats the same check while
// holding the in-process mutation lock so no command can observe or mutate an
// installation between startup recovery and request dispatch.
func (service *Service) RecoverPending(ctx context.Context) error {
	if err := service.validate(); err != nil {
		return err
	}
	service.mutationMu.Lock()
	defer service.mutationMu.Unlock()
	return service.recoverPendingLocked(ctx)
}

func (service *Service) recoverPendingLocked(ctx context.Context) error {
	pendingStore, ok := service.Store.(PendingTransactionStore)
	if !ok {
		return nil
	}
	tx, err := pendingStore.PendingSupervisorTransaction()
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	lock, err := service.Store.AcquireUpdateLock(tx.ID)
	if err != nil {
		return fmt.Errorf("unfinished lifecycle transaction %s lock failed: %w", tx.ID, err)
	}
	result, err := service.Supervisor.Recover(ctx, tx)
	releaseErr := lock.Release()
	if err != nil {
		return fmt.Errorf("unfinished lifecycle transaction %s recovery failed: %w", tx.ID, errors.Join(err, releaseErr))
	}
	if releaseErr != nil {
		return fmt.Errorf("unfinished lifecycle transaction %s lock release failed: %w", tx.ID, releaseErr)
	}
	if result.Phase != model.PhaseCommitted && result.Phase != model.PhaseRolledBack {
		return fmt.Errorf("unfinished lifecycle transaction %s did not converge", tx.ID)
	}
	return nil
}

func (service *Service) completeOnboarding(ctx context.Context, request protocol.Request) (protocol.Response, error) {
	if (service.Profile != model.ProfileProtectedLocal && service.Profile != model.ProfileHosting) || service.Onboarding == nil {
		return protocol.Response{}, errors.New("onboarding completion is unavailable for this lifecycle profile")
	}
	manifest, _, err := service.Store.ReadManifest()
	if err != nil {
		return protocol.Response{}, err
	}
	if err := manifest.Validate(); err != nil || manifest.Profile != service.Profile || manifest.ActiveGeneration == nil {
		return protocol.Response{}, errors.New("committed installation is not ready for onboarding completion")
	}
	platformDigest, err := service.Platform.Digest(service.Profile)
	if err != nil {
		return protocol.Response{}, err
	}
	manifestDigest, err := manifest.Platform.Digest(manifest.Profile)
	if err != nil || manifestDigest != platformDigest {
		return protocol.Response{}, errors.New("committed platform identity changed before onboarding completion")
	}
	result, err := service.Onboarding.CompleteOnboarding(ctx)
	if err != nil {
		return protocol.Response{}, err
	}
	if result.Phase != model.PhaseCommitted || (result.Outcome != engine.OutcomeUpdated && result.Outcome != engine.OutcomeAlreadyCurrent) {
		return protocol.Response{}, errors.New("target controller did not complete onboarding")
	}
	response := response(request, string(result.Outcome), "", manifest.ActiveGeneration.ID)
	response.ConvergenceReceiptDigest = result.ConvergenceReceiptDigest
	if !validConvergenceDigest(response.ConvergenceReceiptDigest) {
		return protocol.Response{}, errors.New("onboarding completion lacks terminal convergence proof")
	}
	return response, nil
}

func (service *Service) inspect(request protocol.Request) (protocol.Response, error) {
	manifest, _, err := service.Store.ReadManifest()
	if errors.Is(err, os.ErrNotExist) {
		return response(request, "EMPTY", "", ""), nil
	}
	if err != nil {
		return protocol.Response{}, err
	}
	active := ""
	if manifest.ActiveGeneration != nil {
		active = manifest.ActiveGeneration.ID
	}
	return response(request, "MANAGED", "", active), nil
}

func (service *Service) converge(ctx context.Context, request protocol.Request) (protocol.Response, error) {
	platformDigest, err := service.Platform.Digest(service.Profile)
	if err != nil {
		return protocol.Response{}, err
	}
	installed, manifestDigest, err := service.Store.ReadManifest()
	installation := planner.Installation{Kind: planner.InstallationEmpty}
	if errors.Is(err, os.ErrNotExist) {
		if request.ExpectedManifestDigest != "absent" {
			return protocol.Response{}, errors.New("installation manifest changed before convergence")
		}
		manifestDigest = absentManifestDigest
		if request.SourceTopology != "" {
			if service.PredecessorEvidence == nil {
				return protocol.Response{}, errors.New("public predecessor evidence verifier is unavailable")
			}
			if err := service.PredecessorEvidence.VerifyPublicPredecessorEvidence(request.SourceTopology, request.PublicPredecessorVersion); err != nil {
				return protocol.Response{}, err
			}
			installation, err = planner.PublicStableInstallation(service.Profile, planner.PublicTopology(request.SourceTopology))
			if err != nil {
				return protocol.Response{}, err
			}
		}
	} else if err != nil {
		return protocol.Response{}, err
	} else {
		if request.ExpectedManifestDigest != manifestDigest {
			return protocol.Response{}, errors.New("installation manifest changed before convergence")
		}
		if request.SourceTopology != "" {
			return protocol.Response{}, errors.New("managed convergence does not accept a public-stable generation")
		}
		installation = planner.Installation{Kind: planner.InstallationManaged, Manifest: &installed}
		installedPlatformDigest, digestErr := installed.Platform.Digest(installed.Profile)
		if installed.Platform.IsLegacyControllerWorker(service.Profile) {
			if installed.SchemaVersion != 1 {
				return protocol.Response{}, errors.New("legacy controller-worker topology is supported only by the declared schema-one upgrade")
			}
			expectedLegacy, legacyErr := model.LegacyControllerPlatformIdentity(service.Profile, service.Platform.InstanceID, service.Platform.ConfigurationDigest)
			expectedLegacyDigest, expectedDigestErr := expectedLegacy.Digest(service.Profile)
			if legacyErr != nil || expectedDigestErr != nil || digestErr != nil || installedPlatformDigest != expectedLegacyDigest {
				return protocol.Response{}, errors.New("installed legacy platform identity requires explicit repair")
			}
		} else if digestErr != nil || installedPlatformDigest != platformDigest {
			return protocol.Response{}, errors.New("installed platform identity requires explicit repair")
		}
	}
	inventory, generation, err := service.Store.ReadCandidateContract(request.TargetGenerationID)
	if err != nil {
		return protocol.Response{}, err
	}
	authority, err := service.Store.ReadCandidateAuthority(request.TargetGenerationID)
	if err != nil {
		return protocol.Response{}, err
	}
	if inventory.Capabilities.Supervisor.Min > supervisorCapability || inventory.Capabilities.Supervisor.Max < supervisorCapability {
		return protocol.Response{}, errors.New("target generation requires an unsupported stable supervisor capability")
	}
	target := planner.Target{
		Profile: service.Profile, Generation: generation,
		StateSchemas: inventory.StateSchemas, Capabilities: inventory.Capabilities,
		ReleaseSequence: authority.ReleaseSequence, SecurityEpoch: authority.SecurityEpoch,
		ManifestMin: authority.ManifestMin, ManifestMax: authority.ManifestMax,
	}
	var plan planner.Plan
	if request.Operation == protocol.OperationRollback {
		if installation.Kind != planner.InstallationManaged || installed.PreviousGeneration == nil || installed.PreviousGeneration.ID != request.TargetGenerationID {
			return protocol.Response{}, errors.New("rollback target must be the committed previous generation")
		}
		plan, err = planner.BuildForInstallationAuthorized(installation, target, request.RollbackAuthorization, service.Now().UTC())
	} else {
		plan, err = planner.BuildForInstallation(installation, target)
	}
	if err != nil {
		return protocol.Response{}, err
	}
	switch plan.Action {
	case planner.ActionAlreadyCurrent:
		if installation.Kind != planner.InstallationManaged || service.CurrentConvergence == nil {
			return protocol.Response{}, errors.New("already-current requires live convergence verification")
		}
		digest, verifyErr := service.CurrentConvergence.VerifyCurrent(ctx, installed, manifestDigest)
		if verifyErr != nil || !validConvergenceDigest(digest) {
			if service.CurrentRepair == nil {
				return protocol.Response{}, errors.Join(errors.New("already-current live convergence proof failed"), verifyErr)
			}
			repaired, repairErr := service.repairCurrent(ctx, request)
			if repairErr != nil {
				return protocol.Response{}, errors.Join(errors.New("already-current live convergence proof failed"), verifyErr, repairErr)
			}
			repaired.Outcome = string(plan.Action)
			return repaired, nil
		}
		result := response(request, string(plan.Action), "", generation.ID)
		result.ConvergenceReceiptDigest = digest
		return result, nil
	case planner.ActionRepairRequired, planner.ActionRejectUnknownNewer, planner.ActionRejectDowngrade:
		return response(request, string(plan.Action), "", generation.ID), nil
	}
	transactionID, err := service.NewID()
	if err != nil {
		return protocol.Response{}, err
	}
	lock, err := service.Store.AcquireUpdateLock(transactionID)
	if err != nil {
		return protocol.Response{}, err
	}
	defer lock.Release()
	if installation.Kind == planner.InstallationManaged {
		if _, lockedDigest, readErr := service.Store.ReadManifest(); readErr != nil || lockedDigest != manifestDigest {
			return protocol.Response{}, errors.New("installation manifest changed while acquiring the update lock")
		}
	} else if _, _, readErr := service.Store.ReadManifest(); !errors.Is(readErr, os.ErrNotExist) {
		return protocol.Response{}, errors.New("installation appeared while acquiring the update lock")
	}
	if err := service.Store.StageGeneration(request.TargetGenerationID); err != nil {
		return protocol.Response{}, err
	}
	stateDigest, signerPlanDigest, err := service.Inventory.Bind(ctx, installation, inventory, plan)
	if err != nil {
		return protocol.Response{}, err
	}
	if installation.Kind == planner.InstallationPublicStable {
		if err := service.PredecessorEvidence.VerifyPublicPredecessorEvidence(request.SourceTopology, request.PublicPredecessorVersion); err != nil {
			return protocol.Response{}, err
		}
	}
	var previous *model.Generation
	if installation.Kind == planner.InstallationManaged {
		previous = installation.Manifest.ActiveGeneration
	}
	tx := model.Transaction{
		SchemaVersion: model.CurrentTransactionSchemaVersion, ID: transactionID,
		Profile: service.Profile, PlanAction: string(plan.Action), SourceTopology: request.SourceTopology, PublicPredecessorVersion: request.PublicPredecessorVersion,
		Phase: model.PhaseIdle, Revision: 1,
		ReleaseSequence: authority.ReleaseSequence, SecurityEpoch: authority.SecurityEpoch,
		ReleaseIndexDigest: authority.ReleaseIndex, ReleaseAuthorityDigest: authority.ReleaseAuthority,
		TargetManifestProtocolMin: authority.ManifestMin, TargetManifestProtocolMax: authority.ManifestMax,
		RollbackAuthorizationDigest: plan.RollbackAuthorizationDigest,
		Target:                      generation, Previous: previous, ManifestDigest: manifestDigest,
		TargetStateSchemas: inventory.StateSchemas, TargetCapabilities: inventory.Capabilities,
		StateInventoryDigest: stateDigest, MigrationPlanDigest: plan.Digest,
		SignerPlanDigest: signerPlanDigest,
		PlatformDigest:   platformDigest,
	}
	if installation.Kind == planner.InstallationManaged {
		tx.PredecessorManifestSchema = installation.Manifest.SchemaVersion
		predecessorPlatform := installation.Manifest.Platform
		tx.PredecessorPlatform = &predecessorPlatform
	}
	for _, migration := range plan.Migrations {
		tx.Migrations = append(tx.Migrations, model.Migration{State: migration.State, From: migration.From, To: migration.To})
	}
	if err := tx.Validate(); err != nil {
		return protocol.Response{}, err
	}
	result, runErr := service.Supervisor.Run(ctx, tx)
	response := response(request, string(result.Outcome), transactionID, generation.ID)
	response.ConvergenceReceiptDigest = result.ConvergenceReceiptDigest
	response.Performance = protocolPerformance(result.Performance)
	if runErr == nil && result.Outcome == engine.OutcomeUpdated && (!validConvergenceDigest(result.ConvergenceReceiptDigest) || result.ActiveGenerationID != generation.ID) {
		return protocol.Response{}, errors.New("target controller committed without terminal convergence proof")
	}
	return response, runErr
}

func protocolPerformance(performance engine.PerformanceEvidence) *protocol.PerformanceEvidence {
	if performance == (engine.PerformanceEvidence{}) {
		return nil
	}
	return &protocol.PerformanceEvidence{
		QuiesceMillis:          performance.QuiesceMillis,
		SwitchMillis:           performance.SwitchMillis,
		ServiceReadinessMillis: performance.ServiceReadinessMillis,
		TotalMillis:            performance.TotalMillis,
	}
}

func (service *Service) recover(ctx context.Context, request protocol.Request) (protocol.Response, error) {
	lock, err := service.Store.AcquireUpdateLock(request.TransactionID)
	if err != nil {
		return protocol.Response{}, err
	}
	defer lock.Release()
	tx, err := service.Store.ReadJournal(store.AuthoritySupervisor, request.TransactionID)
	if err != nil {
		return protocol.Response{}, err
	}
	result, recoverErr := service.Supervisor.Recover(ctx, tx)
	response := response(request, string(result.Outcome), tx.ID, tx.Target.ID)
	response.ConvergenceReceiptDigest = result.ConvergenceReceiptDigest
	return response, recoverErr
}

func (service *Service) validate() error {
	if service == nil || service.Store == nil || service.Inventory == nil || service.Supervisor == nil {
		return errors.New("lifecycle daemon service is incomplete")
	}
	if service.NewID == nil {
		service.NewID = randomUUID
	}
	if service.Now == nil {
		service.Now = func() time.Time { return time.Now().UTC() }
	}
	if service.Profile != model.ProfileProtectedLocal && service.Profile != model.ProfileHosting {
		return errors.New("lifecycle daemon profile is invalid")
	}
	if err := service.Platform.Validate(service.Profile); err != nil {
		return err
	}
	return nil
}

func response(request protocol.Request, outcome, transactionID, activeID string) protocol.Response {
	return protocol.Response{
		SchemaVersion: protocol.CurrentSchemaVersion, RequestID: request.RequestID,
		Outcome: outcome, TransactionID: transactionID, ActiveGenerationID: activeID,
	}
}

func validConvergenceDigest(value string) bool {
	if len(value) != 71 || value[:7] != "sha256:" {
		return false
	}
	for _, character := range value[7:] {
		if (character < '0' || character > '9') && (character < 'a' || character > 'f') {
			return false
		}
	}
	return true
}

func randomUUID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		value[0:4], value[4:6], value[6:8], value[8:10], value[10:16]), nil
}
