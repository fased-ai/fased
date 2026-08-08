// Package daemon implements the fixed lifecycle request boundary.
package daemon

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"os"
	"sync"

	"fased-lifecycled/bundle"
	"fased-lifecycled/engine"
	"fased-lifecycled/model"
	"fased-lifecycled/planner"
	"fased-lifecycled/protocol"
	"fased-lifecycled/store"
)

const absentManifestDigest = "sha256:0000000000000000000000000000000000000000000000000000000000000000"

type StateStore interface {
	StageGeneration(string) error
	ReadManifest() (model.Manifest, string, error)
	ReadJournal(store.Authority, string) (model.Transaction, error)
	ReadGenerationContract(string) (bundle.Inventory, model.Generation, error)
}

type StateInventory interface {
	Bind(context.Context, *model.Manifest, bundle.Inventory, planner.Plan) (stateDigest, signerPlanDigest string, err error)
}

type Supervisor interface {
	Run(context.Context, model.Transaction) (engine.Result, error)
	Recover(context.Context, model.Transaction) (engine.Result, error)
}

type IDGenerator func() (string, error)

type Service struct {
	Profile    model.Profile
	Platform   model.PlatformIdentity
	Store      StateStore
	Inventory  StateInventory
	Supervisor Supervisor
	NewID      IDGenerator
	mutationMu sync.Mutex
}

func (service *Service) Handle(ctx context.Context, request protocol.Request) (protocol.Response, error) {
	if err := request.Validate(); err != nil {
		return protocol.Response{}, err
	}
	if err := service.validate(); err != nil {
		return protocol.Response{}, err
	}
	switch request.Operation {
	case protocol.OperationInspect:
		return service.inspect(request)
	case protocol.OperationConverge:
		service.mutationMu.Lock()
		defer service.mutationMu.Unlock()
		return service.converge(ctx, request)
	case protocol.OperationRecover:
		service.mutationMu.Lock()
		defer service.mutationMu.Unlock()
		return service.recover(ctx, request)
	default:
		return protocol.Response{}, errors.New("unsupported lifecycle operation")
	}
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
	var current *model.Manifest
	if errors.Is(err, os.ErrNotExist) {
		if request.ExpectedManifestDigest != "absent" {
			return protocol.Response{}, errors.New("installation manifest changed before convergence")
		}
		manifestDigest = absentManifestDigest
	} else if err != nil {
		return protocol.Response{}, err
	} else {
		if request.ExpectedManifestDigest != manifestDigest {
			return protocol.Response{}, errors.New("installation manifest changed before convergence")
		}
		current = &installed
		installedPlatformDigest, digestErr := installed.Platform.Digest(installed.Profile)
		if digestErr != nil || installedPlatformDigest != platformDigest {
			return protocol.Response{}, errors.New("installed platform identity requires explicit repair")
		}
	}
	if err := service.Store.StageGeneration(request.TargetGenerationID); err != nil {
		return protocol.Response{}, err
	}
	inventory, generation, err := service.Store.ReadGenerationContract(request.TargetGenerationID)
	if err != nil {
		return protocol.Response{}, err
	}
	plan, err := planner.Build(current, planner.Target{
		Profile: service.Profile, Generation: generation,
		StateSchemas: inventory.StateSchemas, Capabilities: inventory.Capabilities,
	})
	if err != nil {
		return protocol.Response{}, err
	}
	if plan.Action == planner.ActionAlreadyCurrent {
		return response(request, string(engine.OutcomeAlreadyCurrent), "", generation.ID), nil
	}
	stateDigest, signerPlanDigest, err := service.Inventory.Bind(ctx, current, inventory, plan)
	if err != nil {
		return protocol.Response{}, err
	}
	transactionID, err := service.NewID()
	if err != nil {
		return protocol.Response{}, err
	}
	var previous *model.Generation
	if current != nil {
		previous = current.ActiveGeneration
	}
	tx := model.Transaction{
		SchemaVersion: model.CurrentTransactionSchemaVersion, ID: transactionID,
		Profile: service.Profile, Phase: model.PhaseIdle, Revision: 1,
		Target: generation, Previous: previous, ManifestDigest: manifestDigest,
		TargetStateSchemas: inventory.StateSchemas, TargetCapabilities: inventory.Capabilities,
		StateInventoryDigest: stateDigest, MigrationPlanDigest: plan.Digest,
		SignerPlanDigest: signerPlanDigest,
		PlatformDigest:   platformDigest,
	}
	for _, migration := range plan.Migrations {
		tx.Migrations = append(tx.Migrations, model.Migration{State: migration.State, From: migration.From, To: migration.To})
	}
	if err := tx.Validate(); err != nil {
		return protocol.Response{}, err
	}
	result, runErr := service.Supervisor.Run(ctx, tx)
	return response(request, string(result.Outcome), transactionID, generation.ID), runErr
}

func (service *Service) recover(ctx context.Context, request protocol.Request) (protocol.Response, error) {
	tx, err := service.Store.ReadJournal(store.AuthoritySupervisor, request.TransactionID)
	if err != nil {
		return protocol.Response{}, err
	}
	result, recoverErr := service.Supervisor.Recover(ctx, tx)
	return response(request, string(result.Outcome), tx.ID, tx.Target.ID), recoverErr
}

func (service *Service) validate() error {
	if service == nil || service.Store == nil || service.Inventory == nil || service.Supervisor == nil {
		return errors.New("lifecycle daemon service is incomplete")
	}
	if service.NewID == nil {
		service.NewID = randomUUID
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
