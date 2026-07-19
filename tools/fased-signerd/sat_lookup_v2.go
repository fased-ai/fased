package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/big"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"

	solana "github.com/gagliardetto/solana-go"
	addresslookuptable "github.com/gagliardetto/solana-go/programs/address-lookup-table"
	"github.com/gagliardetto/solana-go/rpc"
	bolt "go.etcd.io/bbolt"
)

const (
	maxSATLookupTableExtendAddressesV2    = 20
	maxSATLookupTableCreateSlotAgeV2      = 128
	satLookupTableCloseCooldownSlotsV2    = 512
	satLookupTableRentReservationLamports = uint64(25_000_000)
)

var (
	errSATLookupMutationInProgressV2     = errors.New("SAT lookup-table mutation is already in progress")
	errSATLookupMutationReconciliationV2 = errors.New("SAT lookup-table mutation is awaiting durable reconciliation")
)

var satAddressLookupTableProgramIDV2 = solana.MustPublicKeyFromBase58("AddressLookupTab1e1111111111111111111111111")

// These endpoints are verification candidates, never execution fallbacks. The
// signer selects one only after its live genesis hash agrees with the wallet's
// primary execution RPC.
var satOfficialVerificationRPCURLsV2 = []string{
	"https://api.mainnet-beta.solana.com",
	"https://api.devnet.solana.com",
	"https://api.testnet.solana.com",
}

type signerSATLookupTableIntentV2 struct {
	Address    string                  `json:"address"`
	CycleID    string                  `json:"cycleId"`
	PageIndex  string                  `json:"pageIndex"`
	RecentSlot string                  `json:"recentSlot,omitempty"`
	Addresses  []string                `json:"addresses,omitempty"`
	Parent     *signerSATInstructionV2 `json:"parent,omitempty"`
}

type signerSATLookupBindingRequestV2 struct {
	CycleID   string `json:"cycleId"`
	PageIndex string `json:"pageIndex"`
}

type signerSATLookupBindingResultV2 struct {
	CycleID           string `json:"cycleId"`
	PageIndex         string `json:"pageIndex"`
	Address           string `json:"address,omitempty"`
	Bound             bool   `json:"bound"`
	MutationRequestID string `json:"mutationRequestId,omitempty"`
	MutationState     string `json:"mutationState,omitempty"`
}

type signerSATLookupMutationLeaseV2 struct {
	RequestID string `json:"requestId"`
	CycleID   string `json:"cycleId"`
	PageIndex string `json:"pageIndex"`
	Address   string `json:"address"`
}

func normalizeSATLookupTableIntentV2(input signerIntentV2, wallet solana.PublicKey) (normalizedIntentV2, error) {
	if input.Destination != "" || input.Lamports != "" || input.TokenProgram != "" || input.Mint != "" || input.Amount != "" || input.Memo != "" || input.ProgramID != "" || input.DataBase64 != "" || len(input.Keys) != 0 || input.Context != nil || len(input.Instructions) != 0 || len(input.AddressLookupTables) != 0 || input.Jupiter != nil || input.Federation != nil || input.Cluster != "" {
		return normalizedIntentV2{}, errors.New("typed SAT lookup-table intent rejects unrelated signer fields")
	}
	if input.LookupTable == nil {
		return normalizedIntentV2{}, errors.New("typed SAT lookup-table details are required")
	}
	action := strings.TrimSpace(input.Action)
	switch action {
	case "create", "extend", "deactivate", "close":
	default:
		return normalizedIntentV2{}, fmt.Errorf("unsupported typed SAT lookup-table action %q", action)
	}
	addressText, err := normalizePublicKeyV2(input.LookupTable.Address, "SAT lookup-table address")
	if err != nil {
		return normalizedIntentV2{}, err
	}
	lookupTable := solana.MustPublicKeyFromBase58(addressText)
	cycleID, err := normalizeSATUintStringV2(input.LookupTable.CycleID, "lookupTable.cycleId")
	if err != nil {
		return normalizedIntentV2{}, err
	}
	pageIndex, err := normalizeSATUintStringV2(input.LookupTable.PageIndex, "lookupTable.pageIndex")
	if err != nil {
		return normalizedIntentV2{}, err
	}
	details := &signerSATLookupTableIntentV2{
		Address: addressText, CycleID: cycleID, PageIndex: pageIndex,
	}
	var parentIntent *normalizedIntentV2
	if action == "create" || action == "extend" {
		if input.LookupTable.Parent == nil {
			return normalizedIntentV2{}, errors.New("SAT lookup-table create and extend require the fully typed parent distribution")
		}
		parentInput := signerIntentV2{
			Type:       intentSolanaSATAction,
			Action:     input.LookupTable.Parent.Action,
			ProgramID:  input.LookupTable.Parent.ProgramID,
			DataBase64: input.LookupTable.Parent.DataBase64,
			Keys:       input.LookupTable.Parent.Keys,
			Context:    input.LookupTable.Parent.Context,
		}
		parent, parentErr := normalizeSATIntentV2(parentInput, wallet)
		if parentErr != nil {
			return normalizedIntentV2{}, fmt.Errorf("invalid SAT lookup-table parent distribution: %w", parentErr)
		}
		if parent.Intent.Action != "distributeCyclePage" || len(parent.Instructions) != 1 {
			return normalizedIntentV2{}, errors.New("SAT lookup-table parent must be one typed distributeCyclePage operation")
		}
		parentCycleID, parentPageIndex, bindingErr := satDistributionCyclePageV2(parent)
		if bindingErr != nil {
			return normalizedIntentV2{}, bindingErr
		}
		if cycleID != parentCycleID || pageIndex != parentPageIndex {
			return normalizedIntentV2{}, errors.New("SAT lookup-table binding does not match its typed parent distribution")
		}
		parentIntent = &parent
		wire := parent.Intent
		details.Parent = &signerSATInstructionV2{
			Action: wire.Action, ProgramID: wire.ProgramID, DataBase64: wire.DataBase64,
			Keys: wire.Keys, Context: wire.Context,
		}
	} else if input.LookupTable.Parent != nil {
		return normalizedIntentV2{}, errors.New("SAT lookup-table cleanup rejects a parent distribution")
	}
	var instruction solana.Instruction
	switch action {
	case "create":
		if len(input.LookupTable.Addresses) != 0 {
			return normalizedIntentV2{}, errors.New("SAT lookup-table create rejects addresses; extend them with separate durable operations")
		}
		recentSlot, err := normalizeSATUintStringV2(input.LookupTable.RecentSlot, "lookupTable.recentSlot")
		if err != nil {
			return normalizedIntentV2{}, err
		}
		details.RecentSlot = recentSlot
		slot, _ := new(big.Int).SetString(recentSlot, 10)
		if slot == nil || slot.BitLen() > 64 {
			return normalizedIntentV2{}, errors.New("SAT lookup-table recentSlot exceeds uint64")
		}
		derived, createInstruction, err := buildCreateSATLookupTableInstructionV2(wallet, slot.Uint64())
		if err != nil {
			return normalizedIntentV2{}, err
		}
		if !derived.Equals(lookupTable) {
			return normalizedIntentV2{}, errors.New("SAT lookup-table address does not match signer authority and recentSlot")
		}
		instruction = createInstruction
	case "extend":
		if strings.TrimSpace(input.LookupTable.RecentSlot) != "" {
			return normalizedIntentV2{}, errors.New("SAT lookup-table extend rejects recentSlot")
		}
		details.Addresses, err = normalizeSATLookupAddressesV2(input.LookupTable.Addresses)
		if err != nil {
			return normalizedIntentV2{}, err
		}
		parentAccounts := make(map[string]bool, len(details.Parent.Keys))
		for _, account := range details.Parent.Keys {
			if !account.IsSigner {
				parentAccounts[account.Pubkey] = true
			}
		}
		for _, address := range details.Addresses {
			if !parentAccounts[address] {
				return normalizedIntentV2{}, fmt.Errorf("SAT lookup-table address %s is not required by its parent distribution", address)
			}
		}
		addresses := make(solana.PublicKeySlice, 0, len(details.Addresses))
		for _, raw := range details.Addresses {
			addresses = append(addresses, solana.MustPublicKeyFromBase58(raw))
		}
		instruction, err = buildExtendSATLookupTableInstructionV2(lookupTable, wallet, addresses)
		if err != nil {
			return normalizedIntentV2{}, err
		}
	case "deactivate", "close":
		if strings.TrimSpace(input.LookupTable.RecentSlot) != "" || len(input.LookupTable.Addresses) != 0 {
			return normalizedIntentV2{}, fmt.Errorf("SAT lookup-table %s rejects recentSlot and addresses", action)
		}
		instruction, err = buildCleanupSATLookupTableInstructionV2(action, lookupTable, wallet)
		if err != nil {
			return normalizedIntentV2{}, err
		}
	}
	canonical := signerIntentV2{Type: intentSolanaSATLookupTable, Action: action, LookupTable: details}
	encoded, err := json.Marshal(canonical)
	if err != nil {
		return normalizedIntentV2{}, err
	}
	digest := sha256.Sum256(encoded)
	requiredPrograms := []string{satAddressLookupTableProgramIDV2.String()}
	if action == "create" || action == "extend" {
		requiredPrograms = append(requiredPrograms, solana.SystemProgramID.String())
	}
	requiredPrograms, _ = normalizeSortedStringsV2(requiredPrograms, func(raw string) (string, error) {
		return normalizePublicKeyV2(raw, "SAT lookup-table required program")
	})
	reservation := uint64(signerNativeFeeReservationV2)
	if action == "create" || action == "extend" {
		reservation = satLookupTableRentReservationLamports
	}
	return normalizedIntentV2{
		Intent: canonical, Digest: "sha256:" + hex.EncodeToString(digest[:]),
		Asset: "sat:action", Amount: big.NewInt(1),
		RequiredPrograms: requiredPrograms, Destination: satAddressLookupTableProgramIDV2.String(),
		Instructions:         []solana.Instruction{instruction},
		NativeFeeReservation: new(big.Int).SetUint64(reservation),
		PolicyOperation:      "satLookup." + action + "@" + satAddressLookupTableProgramIDV2.String(),
		RequiredRole:         "mining",
		ParentIntent:         parentIntent,
	}, nil
}

func satDistributionCyclePageV2(intent normalizedIntentV2) (string, string, error) {
	if intent.Intent.Type != intentSolanaSATAction || intent.Intent.Action != "distributeCyclePage" || len(intent.Instructions) != 1 {
		return "", "", errors.New("SAT lookup-table binding requires one typed distributeCyclePage operation")
	}
	data, err := intent.Instructions[0].Data()
	if err != nil || len(data) != 25 {
		return "", "", errors.New("SAT lookup-table parent distribution payload is invalid")
	}
	return strconv.FormatUint(binary.LittleEndian.Uint64(data[1:9]), 10),
		strconv.FormatUint(binary.LittleEndian.Uint64(data[9:17]), 10), nil
}

func normalizeSATLookupBindingRequestV2(input signerSATLookupBindingRequestV2) (signerSATLookupBindingRequestV2, error) {
	cycleID, err := normalizeSATUintStringV2(input.CycleID, "cycleId")
	if err != nil {
		return signerSATLookupBindingRequestV2{}, err
	}
	pageIndex, err := normalizeSATUintStringV2(input.PageIndex, "pageIndex")
	if err != nil {
		return signerSATLookupBindingRequestV2{}, err
	}
	return signerSATLookupBindingRequestV2{CycleID: cycleID, PageIndex: pageIndex}, nil
}

func satLookupBindingKeyV2(walletID, cycleID, pageIndex string) []byte {
	return []byte("sat-lookup-binding\x00" + normalizeWalletID(walletID) + "\x00" + cycleID + "\x00" + pageIndex)
}

func satLookupAddressBindingKeyV2(walletID, address string) []byte {
	return []byte("sat-lookup-address\x00" + normalizeWalletID(walletID) + "\x00" + address)
}

func satLookupBindingIdentityValueV2(cycleID, pageIndex string) []byte {
	return []byte(cycleID + "\x00" + pageIndex)
}

func satLookupMutationKeyV2(walletID, address string) []byte {
	return []byte("sat-lookup-mutation\x00" + normalizeWalletID(walletID) + "\x00" + address)
}

func satLookupMutationIdentityV2(walletID string, intent normalizedIntentV2) ([]byte, bool, error) {
	if intent.Intent.Type != intentSolanaSATLookupTable {
		return nil, false, nil
	}
	details := intent.Intent.LookupTable
	if details == nil {
		return nil, false, errors.New("typed SAT lookup-table details are missing")
	}
	return satLookupMutationKeyV2(walletID, details.Address), true, nil
}

// validateSATLookupMutationLeasePreflightInTxV2 rejects an address that is
// already durably owned by another cycle/page before a contender can replace
// the address-level mutation lease. The final bind remains part of the atomic
// signed-broadcast transition; this is only a non-mutating collision check.
func validateSATLookupMutationLeasePreflightInTxV2(tx *bolt.Tx, walletID string, intent normalizedIntentV2) error {
	address, cycleID, pageIndex, allowCreate, required, err := satLookupBindingIdentityV2(intent)
	if err != nil || !required {
		return err
	}
	meta := tx.Bucket(bucketSignerMetaV2)
	identity := satLookupBindingIdentityValueV2(cycleID, pageIndex)
	bound := meta.Get(satLookupBindingKeyV2(walletID, cycleID, pageIndex))
	if bound == nil {
		if !allowCreate {
			return errors.New("SAT lookup table is not bound to this wallet, cycle, and page")
		}
	} else if subtle.ConstantTimeCompare(bound, []byte(address)) != 1 {
		return errors.New("SAT lookup table does not match the durable wallet, cycle, and page binding")
	}
	if reverse := meta.Get(satLookupAddressBindingKeyV2(walletID, address)); reverse != nil && subtle.ConstantTimeCompare(reverse, identity) != 1 {
		return errors.New("SAT lookup-table address is already bound to another cycle and page")
	}
	return nil
}

// acquireSATLookupMutationLeaseV2 serializes every signer-owned mutation of one
// wallet/cycle/page lookup table. The durable owner record survives restarts.
// A stale reserved owner is failed and fenced in the same Bolt transaction
// before another request may proceed; broadcast/unknown owners remain blocked
// until reconciliation proves a terminal result.
func (s *signerStoreV2) acquireSATLookupMutationLeaseV2(walletID, requestID string, intent normalizedIntentV2) error {
	key, required, err := satLookupMutationIdentityV2(walletID, intent)
	if err != nil || !required {
		return err
	}
	walletID = normalizeWalletID(walletID)
	requestID, err = validateRequestIDV2(requestID)
	if err != nil {
		return err
	}
	details := intent.Intent.LookupTable
	if details == nil {
		return errors.New("typed SAT lookup-table details are missing")
	}
	requestedLease := signerSATLookupMutationLeaseV2{
		RequestID: requestID,
		CycleID:   details.CycleID,
		PageIndex: details.PageIndex,
		Address:   details.Address,
	}
	return s.db.Update(func(tx *bolt.Tx) error {
		if tx.Bucket(bucketSignerWalletsV2).Get([]byte(walletID)) == nil {
			return errors.New("signer wallet not found")
		}
		if err := validateSATLookupMutationLeasePreflightInTxV2(tx, walletID, intent); err != nil {
			return err
		}
		meta := tx.Bucket(bucketSignerMetaV2)
		operations := tx.Bucket(bucketSignerOperationsV2)
		if rawLease := meta.Get(key); rawLease != nil {
			var lease signerSATLookupMutationLeaseV2
			if err := json.Unmarshal(rawLease, &lease); err != nil || lease.Address != details.Address {
				return errors.New("stored SAT lookup-table mutation lease is invalid")
			}
			if lease.RequestID == requestID {
				return nil
			}
			if rawOperation := operations.Get([]byte(lease.RequestID)); rawOperation != nil {
				var owner signerOperationV2
				if err := json.Unmarshal(rawOperation, &owner); err != nil {
					return errors.New("stored SAT lookup-table mutation owner is invalid")
				}
				switch owner.State {
				case operationBroadcast, operationUnknown:
					return errSATLookupMutationReconciliationV2
				case operationReserved:
					now := s.now().UTC()
					leaseUntil, parseErr := time.Parse(time.RFC3339Nano, owner.ExecutionLeaseUntil)
					if parseErr != nil || leaseUntil.After(now) {
						return errSATLookupMutationInProgressV2
					}
					if owner.ReservationActive {
						if err := releaseUsageReservationV2(tx, owner); err != nil {
							return err
						}
						owner.ReservationActive = false
					}
					owner.State = operationFailed
					owner.Error = "stale SAT lookup-table mutation was fenced before broadcast"
					owner.ExecutionLeaseUntil = ""
					owner.UpdatedAt = timestampV2(now)
					encodedOwner, err := json.Marshal(owner)
					if err != nil {
						return err
					}
					if err := operations.Put([]byte(owner.RequestID), encodedOwner); err != nil {
						return err
					}
				}
			}
		}
		encoded, err := json.Marshal(requestedLease)
		if err != nil {
			return err
		}
		return meta.Put(key, encoded)
	})
}

// activeSATLookupMutationInTxV2 returns only an owner that can still affect
// the chain. Terminal owners and expired pre-broadcast reservations are
// reaped atomically so an unbound cycle/page cannot accumulate orphan leases
// and a restart cannot wedge the lifecycle forever.
func (s *signerStoreV2) activeSATLookupMutationInTxV2(
	tx *bolt.Tx,
	walletID string,
	rawLease []byte,
) (*signerSATLookupMutationLeaseV2, *signerOperationV2, bool, error) {
	var lease signerSATLookupMutationLeaseV2
	if json.Unmarshal(rawLease, &lease) != nil || lease.Address == "" || lease.RequestID == "" {
		return nil, nil, false, errors.New("stored SAT lookup-table mutation lease is invalid")
	}
	rawOperation := tx.Bucket(bucketSignerOperationsV2).Get([]byte(lease.RequestID))
	if rawOperation == nil {
		return nil, nil, false, errors.New("stored SAT lookup-table mutation owner is missing")
	}
	var operation signerOperationV2
	if json.Unmarshal(rawOperation, &operation) != nil || operation.WalletID != walletID || operation.IntentType != intentSolanaSATLookupTable {
		return nil, nil, false, errors.New("stored SAT lookup-table mutation owner is invalid")
	}
	terminal := operation.State == operationConfirmed || operation.State == operationFailed
	if operation.State == operationReserved {
		now := s.now().UTC()
		leaseUntil, parseErr := time.Parse(time.RFC3339Nano, operation.ExecutionLeaseUntil)
		if parseErr == nil && !leaseUntil.After(now) {
			if operation.ReservationActive {
				if err := releaseUsageReservationV2(tx, operation); err != nil {
					return nil, nil, false, err
				}
				operation.ReservationActive = false
			}
			operation.State = operationFailed
			operation.Error = "stale SAT lookup-table mutation was fenced before broadcast"
			operation.ExecutionLeaseUntil = ""
			operation.UpdatedAt = timestampV2(now)
			encoded, err := json.Marshal(operation)
			if err != nil {
				return nil, nil, false, err
			}
			if err := tx.Bucket(bucketSignerOperationsV2).Put([]byte(operation.RequestID), encoded); err != nil {
				return nil, nil, false, err
			}
			terminal = true
		}
	}
	if terminal {
		return nil, nil, true, nil
	}
	return &lease, &operation, false, nil
}

func (s *signerStoreV2) getSATLookupBindingV2(walletID string, request signerSATLookupBindingRequestV2) (signerSATLookupBindingResultV2, error) {
	request, err := normalizeSATLookupBindingRequestV2(request)
	if err != nil {
		return signerSATLookupBindingResultV2{}, err
	}
	walletID = normalizeWalletID(walletID)
	result := signerSATLookupBindingResultV2{CycleID: request.CycleID, PageIndex: request.PageIndex}
	err = s.db.Update(func(tx *bolt.Tx) error {
		if tx.Bucket(bucketSignerWalletsV2).Get([]byte(walletID)) == nil {
			return errors.New("signer wallet not found")
		}
		meta := tx.Bucket(bucketSignerMetaV2)
		if raw := meta.Get(satLookupBindingKeyV2(walletID, request.CycleID, request.PageIndex)); raw != nil {
			address, err := normalizePublicKeyV2(string(raw), "SAT lookup-table binding address")
			if err != nil {
				return errors.New("stored SAT lookup-table binding is invalid")
			}
			result.Address = address
			result.Bound = true
		}
		var mutation *signerSATLookupMutationLeaseV2
		var mutationOperation *signerOperationV2
		if result.Bound {
			key := satLookupMutationKeyV2(walletID, result.Address)
			if raw := meta.Get(key); raw != nil {
				lease, operation, terminal, err := s.activeSATLookupMutationInTxV2(tx, walletID, raw)
				if err != nil {
					return err
				}
				if terminal {
					if err := meta.Delete(key); err != nil {
						return err
					}
				}
				if lease != nil && (lease.CycleID != request.CycleID || lease.PageIndex != request.PageIndex || lease.Address != result.Address) {
					return errors.New("stored SAT lookup-table mutation lease is invalid")
				}
				mutation, mutationOperation = lease, operation
			}
		} else {
			prefix := []byte("sat-lookup-mutation\x00" + walletID + "\x00")
			var terminalKeys [][]byte
			if err := meta.ForEach(func(key, raw []byte) error {
				if !bytes.HasPrefix(key, prefix) {
					return nil
				}
				lease, operation, terminal, err := s.activeSATLookupMutationInTxV2(tx, walletID, raw)
				if err != nil {
					return err
				}
				if terminal {
					terminalKeys = append(terminalKeys, append([]byte(nil), key...))
					return nil
				}
				if lease != nil && lease.CycleID == request.CycleID && lease.PageIndex == request.PageIndex {
					if mutation != nil {
						return errors.New("wallet, cycle, and page own multiple SAT lookup-table mutations")
					}
					mutation, mutationOperation = lease, operation
				}
				return nil
			}); err != nil {
				return err
			}
			for _, key := range terminalKeys {
				if err := meta.Delete(key); err != nil {
					return err
				}
			}
		}
		if mutation != nil {
			result.MutationRequestID = mutation.RequestID
			result.MutationState = mutationOperation.State
		}
		return nil
	})
	return result, err
}

func satLookupBindingIdentityV2(intent normalizedIntentV2) (string, string, string, bool, bool, error) {
	address := ""
	cycleID := ""
	pageIndex := ""
	allowCreate := false
	var err error
	if intent.Intent.Type == intentSolanaSATLookupTable {
		details := intent.Intent.LookupTable
		if details == nil {
			return "", "", "", false, false, errors.New("typed SAT lookup-table details are missing")
		}
		address, cycleID, pageIndex = details.Address, details.CycleID, details.PageIndex
		allowCreate = intent.Intent.Action == "create"
	} else if intent.Intent.Type == intentSolanaSATAction && intent.Intent.Action == "distributeCyclePage" && len(intent.AddressLookupTables) == 1 {
		cycleID, pageIndex, err = satDistributionCyclePageV2(intent)
		if err != nil {
			return "", "", "", false, false, err
		}
		address = intent.AddressLookupTables[0].String()
	} else {
		return "", "", "", false, false, nil
	}
	return address, cycleID, pageIndex, allowCreate, true, nil
}

func validateOrBindSATLookupTableInTxV2(tx *bolt.Tx, walletID string, intent normalizedIntentV2) error {
	address, cycleID, pageIndex, allowCreate, required, err := satLookupBindingIdentityV2(intent)
	if err != nil || !required {
		return err
	}
	if tx.Bucket(bucketSignerWalletsV2).Get([]byte(walletID)) == nil {
		return errors.New("signer wallet not found")
	}
	bucket := tx.Bucket(bucketSignerMetaV2)
	key := satLookupBindingKeyV2(walletID, cycleID, pageIndex)
	reverseKey := satLookupAddressBindingKeyV2(walletID, address)
	identity := satLookupBindingIdentityValueV2(cycleID, pageIndex)
	bound := bucket.Get(key)
	if bound == nil {
		if !allowCreate {
			return errors.New("SAT lookup table is not bound to this wallet, cycle, and page")
		}
		if reverse := bucket.Get(reverseKey); reverse != nil && subtle.ConstantTimeCompare(reverse, identity) != 1 {
			return errors.New("SAT lookup-table address is already bound to another cycle and page")
		}
		if err := bucket.Put(reverseKey, identity); err != nil {
			return err
		}
		return bucket.Put(key, []byte(address))
	}
	if subtle.ConstantTimeCompare(bound, []byte(address)) != 1 {
		return errors.New("SAT lookup table does not match the durable wallet, cycle, and page binding")
	}
	if reverse := bucket.Get(reverseKey); reverse == nil {
		if err := bucket.Put(reverseKey, identity); err != nil {
			return err
		}
	} else if subtle.ConstantTimeCompare(reverse, identity) != 1 {
		return errors.New("SAT lookup-table address reverse binding conflicts with its cycle and page")
	}
	return nil
}

func (s *signerStoreV2) validateOrBindSATLookupTableV2(walletID string, intent normalizedIntentV2) error {
	walletID = normalizeWalletID(walletID)
	return s.db.Update(func(tx *bolt.Tx) error {
		return validateOrBindSATLookupTableInTxV2(tx, walletID, intent)
	})
}

// validateBindAndMarkBroadcastClaimV2 makes the lifecycle owner fence, the
// immutable wallet/cycle/page binding, and the exact signed-broadcast record
// one atomic state transition. A stale worker therefore cannot persist a
// binding after another request has fenced it.
func (s *signerStoreV2) validateBindAndMarkBroadcastClaimV2(
	walletID string,
	intent normalizedIntentV2,
	requestID string,
	attempt uint64,
	signature string,
	transactionDigest string,
	signedTxBase64 string,
) (signerOperationV2, error) {
	_, _, _, _, bindingRequired, err := satLookupBindingIdentityV2(intent)
	if err != nil {
		return signerOperationV2{}, err
	}
	if !bindingRequired {
		return s.markBroadcastClaim(requestID, attempt, signature, transactionDigest, signedTxBase64)
	}
	walletID = normalizeWalletID(walletID)
	var updated signerOperationV2
	err = s.db.Update(func(tx *bolt.Tx) error {
		operations := tx.Bucket(bucketSignerOperationsV2)
		rawOperation := operations.Get([]byte(requestID))
		if rawOperation == nil {
			return errors.New("signer operation not found")
		}
		if err := json.Unmarshal(rawOperation, &updated); err != nil {
			return err
		}
		if mutationKey, required, err := satLookupMutationIdentityV2(walletID, intent); err != nil {
			return err
		} else if required {
			rawLease := tx.Bucket(bucketSignerMetaV2).Get(mutationKey)
			var lease signerSATLookupMutationLeaseV2
			details := intent.Intent.LookupTable
			if rawLease == nil || details == nil || json.Unmarshal(rawLease, &lease) != nil || lease.RequestID != requestID || lease.CycleID != details.CycleID || lease.PageIndex != details.PageIndex || lease.Address != details.Address {
				return errors.New("SAT lookup-table mutation ownership was lost before broadcast")
			}
		}
		if err := validateOrBindSATLookupTableInTxV2(tx, walletID, intent); err != nil {
			return err
		}
		now := timestampV2(s.now())
		if err := applyBroadcastClaimV2(&updated, attempt, signature, transactionDigest, signedTxBase64, now); err != nil {
			return err
		}
		encoded, err := json.Marshal(updated)
		if err != nil {
			return err
		}
		return operations.Put([]byte(requestID), encoded)
	})
	return updated, err
}

// failExpiredSATLookupMutationV2 releases an address-level mutation owner only
// after independent reconciliation proves the exact signed transaction
// expired without applying its semantic effect. A never-created table also
// releases its forward and reverse bindings. Spend accounting and the
// historical signature remain conservative.
func (s *signerStoreV2) failExpiredSATLookupMutationV2(walletID, requestID, address string, clearBinding bool) (signerOperationV2, error) {
	walletID = normalizeWalletID(walletID)
	address, err := normalizePublicKeyV2(address, "SAT lookup-table address")
	if err != nil {
		return signerOperationV2{}, err
	}
	var updated signerOperationV2
	err = s.db.Update(func(tx *bolt.Tx) error {
		operations := tx.Bucket(bucketSignerOperationsV2)
		rawOperation := operations.Get([]byte(requestID))
		if rawOperation == nil {
			return errors.New("signer operation not found")
		}
		if err := json.Unmarshal(rawOperation, &updated); err != nil {
			return err
		}
		if updated.WalletID != walletID || updated.IntentType != intentSolanaSATLookupTable || (updated.State != operationBroadcast && updated.State != operationUnknown) {
			return errors.New("signer operation is not an unresolved SAT lookup-table mutation")
		}
		meta := tx.Bucket(bucketSignerMetaV2)
		mutationKey := satLookupMutationKeyV2(walletID, address)
		var lease signerSATLookupMutationLeaseV2
		if rawLease := meta.Get(mutationKey); rawLease == nil || json.Unmarshal(rawLease, &lease) != nil || lease.RequestID != requestID || lease.Address != address {
			return errors.New("SAT lookup-table mutation ownership is missing")
		}
		identity := satLookupBindingIdentityValueV2(lease.CycleID, lease.PageIndex)
		reverseKey := satLookupAddressBindingKeyV2(walletID, address)
		if subtle.ConstantTimeCompare(meta.Get(reverseKey), identity) != 1 {
			return errors.New("SAT lookup-table reverse binding changed during reconciliation")
		}
		bindingKey := satLookupBindingKeyV2(walletID, lease.CycleID, lease.PageIndex)
		bound := meta.Get(bindingKey)
		if subtle.ConstantTimeCompare(bound, []byte(address)) != 1 {
			return errors.New("SAT lookup-table binding changed during reconciliation")
		}
		if clearBinding {
			if err := meta.Delete(bindingKey); err != nil {
				return err
			}
			if err := meta.Delete(reverseKey); err != nil {
				return err
			}
		}
		if err := meta.Delete(mutationKey); err != nil {
			return err
		}
		updated.State = operationFailed
		updated.SignedTxBase64 = ""
		updated.Error = "signed SAT lookup-table mutation expired before reaching the verified cluster"
		updated.ExecutionLeaseUntil = ""
		updated.UpdatedAt = timestampV2(s.now())
		encoded, err := json.Marshal(updated)
		if err != nil {
			return err
		}
		return operations.Put([]byte(requestID), encoded)
	})
	return updated, err
}

func normalizeSATLookupAddressesV2(values []string) ([]string, error) {
	if len(values) == 0 || len(values) > maxSATLookupTableExtendAddressesV2 {
		return nil, fmt.Errorf("SAT lookup-table extend requires one to %d addresses", maxSATLookupTableExtendAddressesV2)
	}
	out := make([]string, 0, len(values))
	seen := make(map[string]bool, len(values))
	for _, raw := range values {
		value, err := normalizePublicKeyV2(raw, "SAT lookup-table entry")
		if err != nil {
			return nil, err
		}
		if seen[value] {
			return nil, errors.New("SAT lookup-table extend rejects duplicate addresses")
		}
		seen[value] = true
		out = append(out, value)
	}
	return out, nil
}

func buildCreateSATLookupTableInstructionV2(authority solana.PublicKey, recentSlot uint64) (solana.PublicKey, solana.Instruction, error) {
	var slotSeed [8]byte
	binary.LittleEndian.PutUint64(slotSeed[:], recentSlot)
	lookupTable, bump, err := solana.FindProgramAddress([][]byte{authority[:], slotSeed[:]}, satAddressLookupTableProgramIDV2)
	if err != nil {
		return solana.PublicKey{}, nil, err
	}
	data := make([]byte, 13)
	binary.LittleEndian.PutUint32(data[0:4], 0)
	binary.LittleEndian.PutUint64(data[4:12], recentSlot)
	data[12] = bump
	accounts := solana.AccountMetaSlice{
		{PublicKey: lookupTable, IsWritable: true},
		{PublicKey: authority, IsSigner: true},
		{PublicKey: authority, IsSigner: true, IsWritable: true},
		{PublicKey: solana.SystemProgramID},
	}
	return lookupTable, solana.NewInstruction(satAddressLookupTableProgramIDV2, accounts, data), nil
}

func buildExtendSATLookupTableInstructionV2(lookupTable, authority solana.PublicKey, addresses solana.PublicKeySlice) (solana.Instruction, error) {
	if len(addresses) == 0 || len(addresses) > maxSATLookupTableExtendAddressesV2 {
		return nil, errors.New("invalid SAT lookup-table extension size")
	}
	data := make([]byte, 12+len(addresses)*32)
	binary.LittleEndian.PutUint32(data[0:4], 2)
	binary.LittleEndian.PutUint64(data[4:12], uint64(len(addresses)))
	for index, address := range addresses {
		copy(data[12+index*32:], address[:])
	}
	accounts := solana.AccountMetaSlice{
		{PublicKey: lookupTable, IsWritable: true},
		{PublicKey: authority, IsSigner: true},
		{PublicKey: authority, IsSigner: true, IsWritable: true},
		{PublicKey: solana.SystemProgramID},
	}
	return solana.NewInstruction(satAddressLookupTableProgramIDV2, accounts, data), nil
}

func buildCleanupSATLookupTableInstructionV2(action string, lookupTable, authority solana.PublicKey) (solana.Instruction, error) {
	accounts := solana.AccountMetaSlice{{PublicKey: lookupTable, IsWritable: true}, {PublicKey: authority, IsSigner: true}}
	var discriminator uint32
	switch action {
	case "deactivate":
		discriminator = 3
	case "close":
		discriminator = 4
		accounts = append(accounts, &solana.AccountMeta{PublicKey: authority, IsWritable: true})
	default:
		return nil, errors.New("unsupported SAT lookup-table cleanup action")
	}
	data := make([]byte, 4)
	binary.LittleEndian.PutUint32(data, discriminator)
	return solana.NewInstruction(satAddressLookupTableProgramIDV2, accounts, data), nil
}

func signerCurrentSlotV2(rpcURLs []string) (uint64, error) {
	active, err := independentSATLookupRPCURLsV2(rpcURLs)
	if err != nil {
		return 0, err
	}
	var currentSlot uint64
	successes := 0
	for _, rpcURL := range active {
		client := newSignerOwnedSolanaRPCClientV2(rpcURL)
		ctx, cancel := context.WithTimeout(context.Background(), solanaWriteRPCRequestTimeout())
		slot, requestErr := client.GetSlot(ctx, rpc.CommitmentConfirmed)
		cancel()
		if requestErr == nil {
			markSolanaWriteRPCSuccess(rpcURL)
			if successes == 0 || slot < currentSlot {
				currentSlot = slot
			}
			successes++
			continue
		}
		markSolanaWriteRPCFailure(rpcURL, requestErr)
	}
	if successes < 2 {
		return 0, errors.New("signer-owned Solana current-slot verification requires two independent RPC origins")
	}
	return currentSlot, nil
}

func independentSATLookupRPCOriginV2(raw string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Hostname() == "" {
		return "", errors.New("signer-owned Solana RPC URL is invalid")
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "http" && scheme != "https" {
		return "", errors.New("signer-owned Solana RPC URL must use http or https")
	}
	host := strings.TrimSuffix(strings.ToLower(parsed.Hostname()), ".")
	if ip := net.ParseIP(host); ip != nil {
		host = ip.String()
	}
	port := parsed.Port()
	if port == "" {
		if scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	} else {
		value, err := strconv.ParseUint(port, 10, 16)
		if err != nil || value == 0 {
			return "", errors.New("signer-owned Solana RPC URL has an invalid port")
		}
		port = strconv.FormatUint(value, 10)
	}
	return scheme + "://" + net.JoinHostPort(host, port), nil
}

func independentSATLookupRPCURLsV2(rpcURLs []string) ([]string, error) {
	active, err := activeSolanaWriteRPCURLs(rpcURLs)
	if err != nil {
		return nil, err
	}
	independent := make([]string, 0, len(active))
	origins := make(map[string]bool, len(active))
	for _, rpcURL := range active {
		origin, err := independentSATLookupRPCOriginV2(rpcURL)
		if err != nil {
			return nil, err
		}
		if origins[origin] {
			continue
		}
		origins[origin] = true
		independent = append(independent, rpcURL)
	}
	if len(independent) < 2 {
		return nil, errors.New("signer-owned Solana lookup-table verification requires two independent RPC origins")
	}
	return independent, nil
}

func signerRPCGenesisHashV2(rpcURL string) (string, error) {
	client := newSignerOwnedSolanaRPCClientV2(rpcURL)
	ctx, cancel := context.WithTimeout(context.Background(), solanaWriteRPCRequestTimeout())
	genesis, err := client.GetGenesisHash(ctx)
	cancel()
	if err != nil {
		return "", errors.New("signer-owned Solana RPC genesis verification failed")
	}
	return genesis.String(), nil
}

func resolveSATLookupVerificationRPCURLsV2(config signerNetworkSecretV2) ([]string, error) {
	primaryGenesis, err := signerRPCGenesisHashV2(config.PrimaryRPCURL)
	if err != nil {
		return nil, err
	}
	if config.GenesisHash != "" && subtle.ConstantTimeCompare([]byte(primaryGenesis), []byte(config.GenesisHash)) != 1 {
		return nil, errors.New("primary Solana RPC no longer agrees with the configured genesis hash")
	}
	candidates := make([]string, 0, 2+len(satOfficialVerificationRPCURLsV2))
	if config.VerificationRPCURL != "" {
		candidates = append(candidates, config.VerificationRPCURL)
	}
	if config.ExecutionFallbackRPCURL != "" {
		candidates = append(candidates, config.ExecutionFallbackRPCURL)
	}
	candidates = append(candidates, satOfficialVerificationRPCURLsV2...)
	primaryOrigin, _ := independentSATLookupRPCOriginV2(config.PrimaryRPCURL)
	seenOrigins := map[string]bool{primaryOrigin: true}
	for index, candidate := range candidates {
		origin, originErr := independentSATLookupRPCOriginV2(candidate)
		if originErr != nil || seenOrigins[origin] {
			continue
		}
		seenOrigins[origin] = true
		candidateGenesis, genesisErr := signerRPCGenesisHashV2(candidate)
		if genesisErr != nil {
			if index == 0 && config.VerificationRPCURL != "" {
				return nil, errors.New("explicit verificationRpcUrl could not verify the primary RPC cluster")
			}
			continue
		}
		if candidateGenesis == primaryGenesis {
			return []string{config.PrimaryRPCURL, candidate}, nil
		}
		if candidate == config.VerificationRPCURL || candidate == config.ExecutionFallbackRPCURL {
			return nil, errors.New("configured Solana RPC origins disagree on genesis hash")
		}
	}
	return nil, errors.New("SAT lookup tables require a distinct RPC origin with the same genesis hash; configure an advanced execution fallback or verification witness")
}

func loadSATLookupTableStateV2(rpcURLs []string, address solana.PublicKey) (*addresslookuptable.AddressLookupTableState, error) {
	active, err := independentSATLookupRPCURLsV2(rpcURLs)
	if err != nil {
		return nil, err
	}
	var agreedData []byte
	var agreedState *addresslookuptable.AddressLookupTableState
	successes := 0
	for _, rpcURL := range active {
		client := newSignerOwnedSolanaRPCClientV2(rpcURL)
		ctx, cancel := context.WithTimeout(context.Background(), solanaWriteRPCRequestTimeout())
		account, requestErr := client.GetAccountInfoWithOpts(ctx, address, &rpc.GetAccountInfoOpts{Encoding: solana.EncodingBase64, Commitment: rpc.CommitmentConfirmed})
		cancel()
		absent := requestErr == nil && (account == nil || account.Value == nil)
		if errors.Is(requestErr, rpc.ErrNotFound) {
			requestErr = nil
			absent = true
		}
		if requestErr == nil && !absent && !account.Value.Owner.Equals(satAddressLookupTableProgramIDV2) {
			requestErr = errors.New("address lookup table has invalid owner")
		}
		if requestErr == nil && !absent && account.Value.Executable {
			requestErr = errors.New("address lookup table account must not be executable")
		}
		var accountData []byte
		var state *addresslookuptable.AddressLookupTableState
		if requestErr == nil && !absent {
			accountData = account.GetBinary()
			state, requestErr = addresslookuptable.DecodeAddressLookupTableState(accountData)
		}
		if requestErr == nil && !absent && state.TypeIndex != 1 {
			requestErr = errors.New("address lookup table has invalid state type")
		}
		if requestErr == nil {
			markSolanaWriteRPCSuccess(rpcURL)
			if successes == 0 {
				agreedData = append([]byte(nil), accountData...)
				agreedState = state
			} else if !bytes.Equal(agreedData, accountData) {
				disagreement := errors.New("signer-owned Solana RPC origins disagree on address lookup-table account data")
				markSolanaWriteRPCFailure(rpcURL, disagreement)
				return nil, disagreement
			}
			successes++
			continue
		}
		markSolanaWriteRPCFailure(rpcURL, requestErr)
	}
	if successes < 2 {
		return nil, errors.New("signer-owned Solana lookup-table verification requires two independent agreeing RPC origins")
	}
	return agreedState, nil
}

func validateSATLookupTableOperationStateV2(rpcURLs []string, wallet solana.PublicKey, intent normalizedIntentV2) error {
	details := intent.Intent.LookupTable
	if details == nil {
		return errors.New("typed SAT lookup-table details are missing")
	}
	address := solana.MustPublicKeyFromBase58(details.Address)
	if intent.Intent.Action == "create" {
		recentSlot, err := strconvParseUintV2(details.RecentSlot)
		if err != nil {
			return err
		}
		currentSlot, err := signerCurrentSlotV2(rpcURLs)
		if err != nil {
			return err
		}
		if recentSlot > currentSlot || currentSlot-recentSlot > maxSATLookupTableCreateSlotAgeV2 {
			return errors.New("SAT lookup-table recentSlot is outside the signer freshness window")
		}
		return nil
	}
	state, err := loadSATLookupTableStateV2(rpcURLs, address)
	if err != nil {
		return err
	}
	if state == nil {
		return errors.New("address lookup table account not found")
	}
	if state.Authority == nil || !state.Authority.Equals(wallet) {
		return errors.New("SAT lookup-table authority does not match signer-owned wallet")
	}
	switch intent.Intent.Action {
	case "extend":
		if !state.IsActive() {
			return errors.New("SAT lookup table is not active")
		}
		existing := make(map[string]bool, len(state.Addresses))
		for _, entry := range state.Addresses {
			existing[entry.String()] = true
		}
		for _, entry := range details.Addresses {
			if existing[entry] {
				return errors.New("SAT lookup-table extend rejects an address already present on chain")
			}
		}
		if len(state.Addresses)+len(details.Addresses) > addresslookuptable.LOOKUP_TABLE_MAX_ADDRESSES {
			return errors.New("SAT lookup-table capacity exceeded")
		}
	case "deactivate":
		if !state.IsActive() {
			return errors.New("SAT lookup table is already deactivated")
		}
	case "close":
		if state.IsActive() {
			return errors.New("SAT lookup table must be deactivated before close")
		}
		currentSlot, err := signerCurrentSlotV2(rpcURLs)
		if err != nil {
			return err
		}
		if state.DeactivationSlot > math.MaxUint64-satLookupTableCloseCooldownSlotsV2 || currentSlot <= state.DeactivationSlot+satLookupTableCloseCooldownSlotsV2 {
			return errors.New("SAT lookup-table close cooldown has not elapsed")
		}
	}
	return nil
}

func loadSATDistributionAddressTablesV2(rpcURLs []string, wallet solana.PublicKey, intent normalizedIntentV2) (map[solana.PublicKey]solana.PublicKeySlice, error) {
	if len(intent.AddressLookupTables) == 0 {
		return nil, nil
	}
	if len(intent.AddressLookupTables) != 1 || intent.Intent.Type != intentSolanaSATAction || intent.Intent.Action != "distributeCyclePage" {
		return nil, errors.New("address lookup tables are restricted to one typed SAT distribution table")
	}
	address := intent.AddressLookupTables[0]
	state, err := loadSATLookupTableStateV2(rpcURLs, address)
	if err != nil {
		return nil, err
	}
	if state == nil {
		return nil, errors.New("SAT distribution lookup table account not found")
	}
	if !state.IsActive() || state.Authority == nil || !state.Authority.Equals(wallet) {
		return nil, errors.New("SAT distribution lookup table is inactive or has the wrong authority")
	}
	currentSlot, err := signerCurrentSlotV2(rpcURLs)
	if err != nil {
		return nil, err
	}
	if currentSlot <= state.LastExtendedSlot {
		return nil, errors.New("SAT distribution lookup table is not active for the current slot")
	}
	available := make(map[string]bool, len(state.Addresses))
	for _, entry := range state.Addresses {
		available[entry.String()] = true
	}
	for _, instruction := range intent.Instructions {
		for _, account := range instruction.Accounts() {
			if account.IsSigner {
				continue
			}
			if !available[account.PublicKey.String()] {
				return nil, fmt.Errorf("SAT distribution lookup table omits required account %s", account.PublicKey)
			}
		}
	}
	return map[solana.PublicKey]solana.PublicKeySlice{address: state.Addresses}, nil
}

func strconvParseUintV2(raw string) (uint64, error) {
	value, ok := new(big.Int).SetString(strings.TrimSpace(raw), 10)
	if !ok || value.Sign() < 0 || value.BitLen() > 64 {
		return 0, errors.New("SAT lookup-table recentSlot must be a uint64 string")
	}
	return value.Uint64(), nil
}
