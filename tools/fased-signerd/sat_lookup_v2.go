package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/big"
	"net"
	"net/url"
	"strings"

	solana "github.com/gagliardetto/solana-go"
	addresslookuptable "github.com/gagliardetto/solana-go/programs/address-lookup-table"
	"github.com/gagliardetto/solana-go/rpc"
)

const (
	maxSATLookupTableExtendAddressesV2    = 20
	maxSATLookupTableCreateSlotAgeV2      = 128
	satLookupTableCloseCooldownSlotsV2    = 512
	satLookupTableRentReservationLamports = uint64(25_000_000)
)

var satAddressLookupTableProgramIDV2 = solana.MustPublicKeyFromBase58("AddressLookupTab1e1111111111111111111111111")

type signerSATLookupTableIntentV2 struct {
	Address    string   `json:"address"`
	RecentSlot string   `json:"recentSlot,omitempty"`
	Addresses  []string `json:"addresses,omitempty"`
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
	details := &signerSATLookupTableIntentV2{Address: addressText}
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
	}, nil
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
	port := parsed.Port()
	if port == "" {
		if scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
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
		if requestErr == nil && (account == nil || account.Value == nil) {
			requestErr = errors.New("address lookup table account not found")
		}
		if requestErr == nil && !account.Value.Owner.Equals(satAddressLookupTableProgramIDV2) {
			requestErr = errors.New("address lookup table has invalid owner")
		}
		if requestErr == nil && account.Value.Executable {
			requestErr = errors.New("address lookup table account must not be executable")
		}
		var accountData []byte
		var state *addresslookuptable.AddressLookupTableState
		if requestErr == nil {
			accountData = account.GetBinary()
			state, requestErr = addresslookuptable.DecodeAddressLookupTableState(accountData)
		}
		if requestErr == nil && state.TypeIndex != 1 {
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
	if successes < 2 || agreedState == nil {
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
