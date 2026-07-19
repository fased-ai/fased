package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	solana "github.com/gagliardetto/solana-go"
	addresslookuptable "github.com/gagliardetto/solana-go/programs/address-lookup-table"
	bolt "go.etcd.io/bbolt"
)

func encodeSATLookupTableStateV2(t *testing.T, authority solana.PublicKey, addresses ...solana.PublicKey) []byte {
	t.Helper()
	data := make([]byte, addresslookuptable.LOOKUP_TABLE_META_SIZE+len(addresses)*32)
	binary.LittleEndian.PutUint32(data[0:4], 1)
	binary.LittleEndian.PutUint64(data[4:12], math.MaxUint64)
	binary.LittleEndian.PutUint64(data[12:20], 100)
	data[20] = 0
	data[21] = 1
	copy(data[22:54], authority[:])
	for index, address := range addresses {
		copy(data[addresslookuptable.LOOKUP_TABLE_META_SIZE+index*32:], address[:])
	}
	return data
}

func startSATLookupRPCServerV2(t *testing.T, accountData []byte, slot uint64) *httptest.Server {
	return startSATLookupRPCServerWithGenesisV2(t, accountData, slot, solana.NewWallet().PublicKey().String())
}

func startSATLookupRPCServerWithGenesisV2(t *testing.T, accountData []byte, slot uint64, genesis string) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		defer request.Body.Close()
		var input struct {
			ID     any    `json:"id"`
			Method string `json:"method"`
		}
		if err := json.NewDecoder(request.Body).Decode(&input); err != nil {
			http.Error(writer, "invalid request", http.StatusBadRequest)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		if input.Method == "getGenesisHash" {
			_ = json.NewEncoder(writer).Encode(map[string]any{
				"jsonrpc": "2.0",
				"id":      input.ID,
				"result":  genesis,
			})
			return
		}
		if input.Method == "getSlot" {
			_ = json.NewEncoder(writer).Encode(map[string]any{
				"jsonrpc": "2.0",
				"id":      input.ID,
				"result":  slot,
			})
			return
		}
		if input.Method != "getAccountInfo" {
			_ = json.NewEncoder(writer).Encode(map[string]any{
				"jsonrpc": "2.0",
				"id":      input.ID,
				"error":   map[string]any{"code": -32601, "message": "unexpected method"},
			})
			return
		}
		_ = json.NewEncoder(writer).Encode(map[string]any{
			"jsonrpc": "2.0",
			"id":      input.ID,
			"result": map[string]any{
				"context": map[string]any{"slot": slot},
				"value": map[string]any{
					"data":       []any{base64.StdEncoding.EncodeToString(accountData), "base64"},
					"executable": false,
					"lamports":   1,
					"owner":      satAddressLookupTableProgramIDV2.String(),
					"rentEpoch":  0,
				},
			},
		})
	}))
	t.Cleanup(server.Close)
	return server
}

func TestSignerV2SATLookupVerificationInfersSameGenesisWitness(t *testing.T) {
	genesis := solana.NewWallet().PublicKey().String()
	primary := startSATLookupRPCServerWithGenesisV2(t, nil, 100, genesis)
	witness := startSATLookupRPCServerWithGenesisV2(t, nil, 100, genesis)
	original := satOfficialVerificationRPCURLsV2
	satOfficialVerificationRPCURLsV2 = []string{witness.URL}
	t.Cleanup(func() { satOfficialVerificationRPCURLsV2 = original })

	urls, err := resolveSATLookupVerificationRPCURLsV2(signerNetworkSecretV2{
		SchemaVersion: 2, PrimaryRPCURL: primary.URL,
	})
	if err != nil || len(urls) != 2 || urls[0] != primary.URL || urls[1] != witness.URL {
		t.Fatalf("automatic same-genesis witness was not selected: urls=%v err=%v", urls, err)
	}
}

func TestSignerV2SATLookupVerificationRejectsSameOriginAndGenesisMismatch(t *testing.T) {
	primary := startSATLookupRPCServerWithGenesisV2(t, nil, 100, solana.NewWallet().PublicKey().String())
	mismatch := startSATLookupRPCServerWithGenesisV2(t, nil, 100, solana.NewWallet().PublicKey().String())
	original := satOfficialVerificationRPCURLsV2
	t.Cleanup(func() { satOfficialVerificationRPCURLsV2 = original })

	satOfficialVerificationRPCURLsV2 = []string{primary.URL}
	if _, err := resolveSATLookupVerificationRPCURLsV2(signerNetworkSecretV2{
		SchemaVersion: 2, PrimaryRPCURL: primary.URL,
	}); err == nil || !strings.Contains(err.Error(), "distinct RPC origin") {
		t.Fatalf("primary was allowed to witness itself: %v", err)
	}
	satOfficialVerificationRPCURLsV2 = nil
	if _, err := resolveSATLookupVerificationRPCURLsV2(signerNetworkSecretV2{
		SchemaVersion: 2, PrimaryRPCURL: primary.URL, ExecutionFallbackRPCURL: mismatch.URL,
	}); err == nil || !strings.Contains(err.Error(), "disagree on genesis") {
		t.Fatalf("mismatched advanced execution fallback was accepted: %v", err)
	}
}

func TestSignerV2SATLookupOriginCanonicalizesEquivalentPortsAndIPs(t *testing.T) {
	defaultPort, err := independentSATLookupRPCOriginV2("https://api.mainnet-beta.solana.com")
	if err != nil {
		t.Fatal(err)
	}
	paddedPort, err := independentSATLookupRPCOriginV2("https://api.mainnet-beta.solana.com:0443")
	if err != nil || paddedPort != defaultPort {
		t.Fatalf("equivalent HTTPS origins did not canonicalize equally: default=%q padded=%q err=%v", defaultPort, paddedPort, err)
	}
	shortIP, err := independentSATLookupRPCOriginV2("http://[::1]:8899")
	if err != nil {
		t.Fatal(err)
	}
	longIP, err := independentSATLookupRPCOriginV2("http://[0:0:0:0:0:0:0:1]:08899")
	if err != nil || longIP != shortIP {
		t.Fatalf("equivalent loopback origins did not canonicalize equally: short=%q long=%q err=%v", shortIP, longIP, err)
	}
}

func TestSignerV2SATCurrentSlotUsesConservativeIndependentAgreement(t *testing.T) {
	data := encodeSATLookupTableStateV2(t, solana.NewWallet().PublicKey())
	primary := startSATLookupRPCServerV2(t, data, 110)
	secondary := startSATLookupRPCServerV2(t, data, 105)

	slot, err := signerCurrentSlotV2([]string{primary.URL, secondary.URL})
	if err != nil {
		t.Fatalf("two independent current-slot reads were rejected: %v", err)
	}
	if slot != 105 {
		t.Fatalf("current-slot verification did not choose the conservative agreed bound: got %d", slot)
	}
	if _, err := signerCurrentSlotV2([]string{primary.URL}); err == nil || !strings.Contains(err.Error(), "two independent") {
		t.Fatalf("one current-slot RPC origin did not fail closed: %v", err)
	}
}

func TestSignerV2SATLookupTableStateRequiresIndependentAgreement(t *testing.T) {
	authority := solana.NewWallet().PublicKey()
	first := solana.NewWallet().PublicKey()
	second := solana.NewWallet().PublicKey()
	canonicalData := encodeSATLookupTableStateV2(t, authority, first, second)
	agreeingPrimary := startSATLookupRPCServerV2(t, canonicalData, 101)
	agreeingSecondary := startSATLookupRPCServerV2(t, canonicalData, 102)

	state, err := loadSATLookupTableStateV2(
		[]string{agreeingPrimary.URL, agreeingSecondary.URL},
		solana.NewWallet().PublicKey(),
	)
	if err != nil {
		t.Fatalf("two independent agreeing RPC origins were rejected: %v", err)
	}
	if len(state.Addresses) != 2 || !state.Addresses[0].Equals(first) || !state.Addresses[1].Equals(second) {
		t.Fatalf("agreed lookup-table ordering was not preserved: %#v", state.Addresses)
	}

	if _, err := loadSATLookupTableStateV2(
		[]string{agreeingPrimary.URL},
		solana.NewWallet().PublicKey(),
	); err == nil || !strings.Contains(err.Error(), "two independent") {
		t.Fatalf("one RPC origin did not fail closed: %v", err)
	}
	if _, err := loadSATLookupTableStateV2(
		[]string{agreeingPrimary.URL, agreeingPrimary.URL + "/duplicate-path"},
		solana.NewWallet().PublicKey(),
	); err == nil || !strings.Contains(err.Error(), "two independent") {
		t.Fatalf("duplicate RPC origins did not fail closed: %v", err)
	}
}

func TestSignerV2SATLookupTableRepeatedAbsenceKeepsVerificationRPCsHealthy(t *testing.T) {
	newAbsentRPC := func() *httptest.Server {
		server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			defer request.Body.Close()
			var input struct {
				ID any `json:"id"`
			}
			if err := json.NewDecoder(request.Body).Decode(&input); err != nil {
				t.Fatal(err)
			}
			writer.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(writer).Encode(map[string]any{
				"jsonrpc": "2.0", "id": input.ID,
				"result": map[string]any{"context": map[string]any{"slot": 101}, "value": nil},
			})
		}))
		t.Cleanup(server.Close)
		return server
	}
	primary, secondary := newAbsentRPC(), newAbsentRPC()
	urls := []string{primary.URL, secondary.URL}
	for attempt := 0; attempt < 3; attempt++ {
		state, err := loadSATLookupTableStateV2(urls, solana.NewWallet().PublicKey())
		if err != nil || state != nil {
			t.Fatalf("verified absence attempt %d was not a healthy result: state=%#v err=%v", attempt, state, err)
		}
		active, err := activeSolanaWriteRPCURLs(urls)
		if err != nil || len(active) != 2 {
			t.Fatalf("verified absence poisoned RPC circuits: active=%v err=%v", active, err)
		}
	}
}

func TestSignerV2SATLookupTableStateRejectsCompromisedPrimaryOrdering(t *testing.T) {
	authority := solana.NewWallet().PublicKey()
	first := solana.NewWallet().PublicKey()
	second := solana.NewWallet().PublicKey()
	forgedPrimary := startSATLookupRPCServerV2(
		t,
		encodeSATLookupTableStateV2(t, authority, second, first),
		101,
	)
	canonicalSecondary := startSATLookupRPCServerV2(
		t,
		encodeSATLookupTableStateV2(t, authority, first, second),
		101,
	)

	if _, err := loadSATLookupTableStateV2(
		[]string{forgedPrimary.URL, canonicalSecondary.URL},
		solana.NewWallet().PublicKey(),
	); err == nil || !strings.Contains(err.Error(), "disagree") {
		t.Fatalf("compromised primary lookup-table ordering did not fail closed: %v", err)
	}
}

func TestSignerV2SATLookupMutationEffectReconciliationCoversEveryLifecycleAction(t *testing.T) {
	authority := solana.NewWallet().PublicKey()
	table := solana.NewWallet().PublicKey()
	added := solana.NewWallet().PublicKey()
	activeWithoutAddress := encodeSATLookupTableStateV2(t, authority)
	activeWithAddress := encodeSATLookupTableStateV2(t, authority, added)
	inactive := append([]byte(nil), activeWithoutAddress...)
	binary.LittleEndian.PutUint64(inactive[4:12], 90)

	tests := []struct {
		name     string
		mutation signedSATLookupMutationV2
		data     []byte
		applied  bool
		absent   bool
	}{
		{name: "extend absent", mutation: signedSATLookupMutationV2{Action: "extend", Address: table, Addresses: []solana.PublicKey{added}}, data: activeWithoutAddress, absent: true},
		{name: "extend applied", mutation: signedSATLookupMutationV2{Action: "extend", Address: table, Addresses: []solana.PublicKey{added}}, data: activeWithAddress, applied: true},
		{name: "deactivate absent", mutation: signedSATLookupMutationV2{Action: "deactivate", Address: table}, data: activeWithoutAddress, absent: true},
		{name: "deactivate applied", mutation: signedSATLookupMutationV2{Action: "deactivate", Address: table}, data: inactive, applied: true},
		{name: "close absent", mutation: signedSATLookupMutationV2{Action: "close", Address: table}, data: inactive, absent: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			primary := startSATLookupRPCServerV2(t, test.data, 100)
			secondary := startSATLookupRPCServerV2(t, test.data, 100)
			applied, absent, err := reconcileSATLookupMutationEffectV2([]string{primary.URL, secondary.URL}, authority, test.mutation)
			if err != nil || applied != test.applied || absent != test.absent {
				t.Fatalf("unexpected mutation effect: applied=%t absent=%t err=%v", applied, absent, err)
			}
		})
	}

	var absentServers []*httptest.Server
	for range 2 {
		server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			defer request.Body.Close()
			var input struct {
				ID     any    `json:"id"`
				Method string `json:"method"`
			}
			if err := json.NewDecoder(request.Body).Decode(&input); err != nil {
				t.Fatal(err)
			}
			if input.Method != "getAccountInfo" {
				t.Fatalf("unexpected absent-state RPC method %q", input.Method)
			}
			writer.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(writer).Encode(map[string]any{
				"jsonrpc": "2.0", "id": input.ID,
				"result": map[string]any{"context": map[string]any{"slot": 100}, "value": nil},
			})
		}))
		absentServers = append(absentServers, server)
		t.Cleanup(server.Close)
	}
	applied, absent, err := reconcileSATLookupMutationEffectV2(
		[]string{absentServers[0].URL, absentServers[1].URL},
		authority,
		signedSATLookupMutationV2{Action: "close", Address: table},
	)
	if err != nil || !applied || absent {
		t.Fatalf("closed table absence was not confirmed: applied=%t absent=%t err=%v", applied, absent, err)
	}
}

func assertSATLookupInstructionMatchesWeb3(t *testing.T, instruction solana.Instruction, expectedData string, expectedAccounts []string) {
	t.Helper()
	data, err := instruction.Data()
	if err != nil {
		t.Fatalf("encode SAT lookup-table instruction: %v", err)
	}
	if actual := hex.EncodeToString(data); actual != expectedData {
		t.Fatalf("SAT lookup-table instruction data diverges from @solana/web3.js: got %s want %s", actual, expectedData)
	}
	accounts := instruction.Accounts()
	actualAccounts := make([]string, 0, len(accounts))
	for _, account := range accounts {
		actualAccounts = append(actualAccounts, fmt.Sprintf("%s:%t:%t", account.PublicKey, account.IsSigner, account.IsWritable))
	}
	if strings.Join(actualAccounts, "|") != strings.Join(expectedAccounts, "|") {
		t.Fatalf("SAT lookup-table account metas diverge from @solana/web3.js: got %#v want %#v", actualAccounts, expectedAccounts)
	}
}

func TestSignerV2SATLookupInstructionsMatchWeb3Golden(t *testing.T) {
	authority := solana.MustPublicKeyFromBase58("8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW")
	address, create, err := buildCreateSATLookupTableInstructionV2(authority, 100)
	if err != nil {
		t.Fatalf("build SAT lookup-table create: %v", err)
	}
	if address.String() != "4c8wadNoNVAJMpJtQnUAYbJgdE1YyfTpwBCNak1hBuPB" {
		t.Fatalf("Go lookup-table PDA derivation diverges from @solana/web3.js: %s", address)
	}
	lookupMeta := address.String() + ":false:true"
	authorityReadonlyMeta := authority.String() + ":true:false"
	authorityWritableMeta := authority.String() + ":true:true"
	systemMeta := solana.SystemProgramID.String() + ":false:false"
	assertSATLookupInstructionMatchesWeb3(t, create, "000000006400000000000000fe", []string{
		lookupMeta, authorityReadonlyMeta, authorityWritableMeta, systemMeta,
	})
	extend, err := buildExtendSATLookupTableInstructionV2(address, authority, solana.PublicKeySlice{solana.SystemProgramID})
	if err != nil {
		t.Fatalf("build SAT lookup-table extend: %v", err)
	}
	assertSATLookupInstructionMatchesWeb3(t, extend, "0200000001000000000000000000000000000000000000000000000000000000000000000000000000000000", []string{
		lookupMeta, authorityReadonlyMeta, authorityWritableMeta, systemMeta,
	})
	deactivate, err := buildCleanupSATLookupTableInstructionV2("deactivate", address, authority)
	if err != nil {
		t.Fatalf("build SAT lookup-table deactivate: %v", err)
	}
	assertSATLookupInstructionMatchesWeb3(t, deactivate, "03000000", []string{
		lookupMeta, authorityReadonlyMeta,
	})
	closeInstruction, err := buildCleanupSATLookupTableInstructionV2("close", address, authority)
	if err != nil {
		t.Fatalf("build SAT lookup-table close: %v", err)
	}
	assertSATLookupInstructionMatchesWeb3(t, closeInstruction, "04000000", []string{
		lookupMeta, authorityReadonlyMeta, authority.String() + ":false:true",
	})
}

func satTestLookupCreateIntent(t *testing.T, wallet solana.PublicKey, slot uint64) signerIntentV2 {
	t.Helper()
	address, _, err := buildCreateSATLookupTableInstructionV2(wallet, slot)
	if err != nil {
		t.Fatalf("derive test SAT lookup table: %v", err)
	}
	return signerIntentV2{
		Type:   intentSolanaSATLookupTable,
		Action: "create",
		LookupTable: &signerSATLookupTableIntentV2{
			Address:    address.String(),
			CycleID:    "7",
			PageIndex:  "2",
			RecentSlot: strconv.FormatUint(slot, 10),
			Parent:     satTestLookupParent(t, wallet, address),
		},
	}
}

func TestSignerV2SATLookupTableCreateIsTypedProgramBoundAndRentCapped(t *testing.T) {
	web3Authority := solana.MustPublicKeyFromBase58("8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW")
	web3Address, _, err := buildCreateSATLookupTableInstructionV2(web3Authority, 100)
	if err != nil || web3Address.String() != "4c8wadNoNVAJMpJtQnUAYbJgdE1YyfTpwBCNak1hBuPB" {
		t.Fatalf("Go lookup-table PDA derivation diverges from @solana/web3.js: address=%s err=%v", web3Address, err)
	}
	wallet := solana.NewWallet().PublicKey()
	normalized, err := normalizeSignerIntentForWalletV2(satTestLookupCreateIntent(t, wallet, 99), &wallet)
	if err != nil {
		t.Fatalf("normalize SAT lookup-table create: %v", err)
	}
	if normalized.RequiredRole != "mining" || normalized.PolicyOperation != "satLookup.create@"+satAddressLookupTableProgramIDV2.String() {
		t.Fatalf("lookup-table create is not Mining-role and program bound: %#v", normalized)
	}
	if normalized.Asset != "sat:action" || normalized.Amount.Uint64() != 1 {
		t.Fatalf("unexpected lookup-table semantic accounting: asset=%s amount=%s", normalized.Asset, normalized.Amount)
	}
	if normalized.NativeFeeReservation == nil || normalized.NativeFeeReservation.Uint64() != satLookupTableRentReservationLamports {
		t.Fatalf("lookup-table rent reservation is not signer owned: %v", normalized.NativeFeeReservation)
	}
	if !containsStringV2(normalized.RequiredPrograms, satAddressLookupTableProgramIDV2.String()) || !containsStringV2(normalized.RequiredPrograms, solana.SystemProgramID.String()) {
		t.Fatalf("lookup-table create required programs are incomplete: %#v", normalized.RequiredPrograms)
	}
	if len(normalized.Instructions) != 1 || !normalized.Instructions[0].ProgramID().Equals(satAddressLookupTableProgramIDV2) {
		t.Fatalf("unexpected lookup-table create instruction: %#v", normalized.Instructions)
	}
	policy, err := normalizeSignerPolicyV2(signerPolicyV2{
		WalletID: "mining", Role: "mining",
		Operations: []string{normalized.PolicyOperation}, Programs: normalized.RequiredPrograms,
		Assets: []signerPolicyAssetV2{
			{Asset: "sat:action", Destinations: []string{satAddressLookupTableProgramIDV2.String()}, MaxPerTx: "1", MaxDaily: "10"},
			{Asset: "solana:native", Destinations: []string{satAddressLookupTableProgramIDV2.String()}, MaxPerTx: "25000000", MaxDaily: "100000000"},
		},
	})
	if err != nil {
		t.Fatalf("normalize lookup-table policy: %v", err)
	}
	if _, err := policyReservationsForIntentV2(policy, normalized); err != nil {
		t.Fatalf("exact lookup-table policy should reserve action plus rent atomically: %v", err)
	}
	policy.Assets[1].MaxPerTx = "24999999"
	if _, err := policyReservationsForIntentV2(policy, normalized); err == nil || !strings.Contains(err.Error(), "fee/rent") {
		t.Fatalf("lookup-table create accepted a native cap below the signer rent ceiling: %v", err)
	}
	wrongAddress := satTestLookupCreateIntent(t, wallet, 99)
	wrongAddress.LookupTable.Address = solana.NewWallet().PublicKey().String()
	if _, err := normalizeSignerIntentForWalletV2(wrongAddress, &wallet); err == nil || !strings.Contains(err.Error(), "does not match") {
		t.Fatalf("lookup-table create accepted a caller-selected address: %v", err)
	}
	wrongWallet := solana.NewWallet().PublicKey()
	if _, err := normalizeSignerIntentForWalletV2(satTestLookupCreateIntent(t, wallet, 99), &wrongWallet); err == nil || !strings.Contains(err.Error(), "does not match") {
		t.Fatalf("lookup-table create accepted a different signer authority: %v", err)
	}
}

func TestSignerV2SATLookupTableExtendRejectsDuplicatesOversizeAndUnrelatedFields(t *testing.T) {
	wallet, table := solana.NewWallet().PublicKey(), solana.NewWallet().PublicKey()
	parent := satTestLookupParent(t, wallet, table)
	addresses := []string{parent.Keys[1].Pubkey, parent.Keys[2].Pubkey}
	valid := signerIntentV2{
		Type: intentSolanaSATLookupTable, Action: "extend",
		LookupTable: &signerSATLookupTableIntentV2{Address: table.String(), CycleID: "7", PageIndex: "2", Addresses: addresses, Parent: parent},
	}
	normalized, err := normalizeSignerIntentForWalletV2(valid, &wallet)
	if err != nil {
		t.Fatalf("normalize SAT lookup-table extend: %v", err)
	}
	if normalized.PolicyOperation != "satLookup.extend@"+satAddressLookupTableProgramIDV2.String() || normalized.NativeFeeReservation.Uint64() != satLookupTableRentReservationLamports {
		t.Fatalf("unexpected lookup-table extend policy or cap: %#v", normalized)
	}
	if normalized.ParentIntent == nil || normalized.ParentIntent.Intent.Action != "distributeCyclePage" {
		t.Fatalf("lookup-table extension was not bound to its validated parent: %#v", normalized.ParentIntent)
	}
	wrongBinding := valid
	wrongBinding.LookupTable = &signerSATLookupTableIntentV2{
		Address: table.String(), CycleID: "8", PageIndex: "2", Addresses: addresses, Parent: parent,
	}
	if _, err := normalizeSignerIntentForWalletV2(wrongBinding, &wallet); err == nil || !strings.Contains(err.Error(), "does not match") {
		t.Fatalf("lookup-table extension accepted a cycle/page binding outside its parent: %v", err)
	}
	if err := requireAutonomousRoleV2(signerPolicyV2{Role: "mining"}, normalized); err != nil {
		t.Fatalf("Mining role rejected typed lookup-table lifecycle: %v", err)
	}
	if err := requireAutonomousRoleV2(signerPolicyV2{Role: "agent"}, normalized); err == nil || !strings.Contains(err.Error(), "Mining wallet") {
		t.Fatalf("Agent role accepted typed lookup-table lifecycle: %v", err)
	}
	duplicate := valid
	duplicate.LookupTable = &signerSATLookupTableIntentV2{Address: table.String(), CycleID: "7", PageIndex: "2", Addresses: []string{addresses[0], addresses[0]}, Parent: parent}
	if _, err := normalizeSignerIntentForWalletV2(duplicate, &wallet); err == nil || !strings.Contains(err.Error(), "duplicate") {
		t.Fatalf("lookup-table extend accepted duplicate addresses: %v", err)
	}
	oversize := make([]string, maxSATLookupTableExtendAddressesV2+1)
	for index := range oversize {
		oversize[index] = solana.NewWallet().PublicKey().String()
	}
	tooMany := valid
	tooMany.LookupTable = &signerSATLookupTableIntentV2{Address: table.String(), CycleID: "7", PageIndex: "2", Addresses: oversize, Parent: parent}
	if _, err := normalizeSignerIntentForWalletV2(tooMany, &wallet); err == nil || !strings.Contains(err.Error(), "one to 20") {
		t.Fatalf("lookup-table extend accepted too many addresses: %v", err)
	}
	outsideParent := valid
	outsideParent.LookupTable = &signerSATLookupTableIntentV2{
		Address: table.String(), CycleID: "7", PageIndex: "2", Addresses: []string{solana.NewWallet().PublicKey().String()}, Parent: parent,
	}
	if _, err := normalizeSignerIntentForWalletV2(outsideParent, &wallet); err == nil || !strings.Contains(err.Error(), "not required by its parent") {
		t.Fatalf("lookup-table extend accepted an address outside the parent distribution: %v", err)
	}
	unrelated := valid
	unrelated.Destination = solana.NewWallet().PublicKey().String()
	if _, err := normalizeSignerIntentForWalletV2(unrelated, &wallet); err == nil || !strings.Contains(err.Error(), "unrelated") {
		t.Fatalf("lookup-table intent accepted an unrelated transfer field: %v", err)
	}
}

func TestSignerV2SATLookupBindingIsAtomicAndGuardsDistributionAndCleanup(t *testing.T) {
	store, keys := openTestSignerV2(t)
	wallet := solana.NewWallet().PublicKey()
	createTestSignerWalletV2(t, store, keys, "mining", solana.NewWallet().PublicKey().String(), 100, 1000)

	firstInput := satTestLookupCreateIntent(t, wallet, 99)
	first, err := normalizeSignerIntentForWalletV2(firstInput, &wallet)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.validateOrBindSATLookupTableV2("mining", first); err != nil {
		t.Fatalf("bind first lookup-table identity: %v", err)
	}
	binding, err := store.getSATLookupBindingV2("mining", signerSATLookupBindingRequestV2{CycleID: "7", PageIndex: "2"})
	if err != nil || !binding.Bound || binding.Address != first.Intent.LookupTable.Address {
		t.Fatalf("read durable lookup-table binding: binding=%#v err=%v", binding, err)
	}

	secondInput := satTestLookupCreateIntent(t, wallet, 100)
	second, err := normalizeSignerIntentForWalletV2(secondInput, &wallet)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.validateOrBindSATLookupTableV2("mining", second); err == nil || !strings.Contains(err.Error(), "durable wallet, cycle, and page") {
		t.Fatalf("second table identity replaced the first binding: %v", err)
	}
	secondPage := first
	secondPage.Intent.LookupTable = &signerSATLookupTableIntentV2{
		Address: first.Intent.LookupTable.Address, CycleID: "7", PageIndex: "3", RecentSlot: first.Intent.LookupTable.RecentSlot,
	}
	if err := store.validateOrBindSATLookupTableV2("mining", secondPage); err == nil || !strings.Contains(err.Error(), "already bound to another cycle and page") {
		t.Fatalf("one lookup-table address was bound to two page identities: %v", err)
	}
	collisionOwner := signerOperationV2{
		RequestID: "reverse-collision-owner", WalletID: "mining", IntentType: intentSolanaSATLookupTable,
		State: operationReserved, ExecutionAttempt: 1, ExecutionLeaseUntil: timestampV2(store.now().Add(time.Minute)),
	}
	if err := store.db.Update(func(tx *bolt.Tx) error {
		encoded, err := json.Marshal(collisionOwner)
		if err != nil {
			return err
		}
		return tx.Bucket(bucketSignerOperationsV2).Put([]byte(collisionOwner.RequestID), encoded)
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.acquireSATLookupMutationLeaseV2("mining", collisionOwner.RequestID, secondPage); err == nil || !strings.Contains(err.Error(), "already bound") {
		t.Fatalf("reverse collision persisted an address-level mutation lease: %v", err)
	}
	secondPageBinding, err := store.getSATLookupBindingV2("mining", signerSATLookupBindingRequestV2{CycleID: "7", PageIndex: "3"})
	if err != nil || secondPageBinding.Bound {
		t.Fatalf("reverse-binding collision left a poisoned forward binding: binding=%#v err=%v", secondPageBinding, err)
	}
	originalAfterCollision, err := store.getSATLookupBindingV2("mining", signerSATLookupBindingRequestV2{CycleID: "7", PageIndex: "2"})
	if err != nil || !originalAfterCollision.Bound || originalAfterCollision.Address != first.Intent.LookupTable.Address || originalAfterCollision.MutationRequestID != "" {
		t.Fatalf("reverse collision poisoned the original binding: binding=%#v err=%v", originalAfterCollision, err)
	}

	program := solana.NewWallet().PublicKey()
	distribution, err := normalizeSignerIntentForWalletV2(
		satTestDistributionIntent(t, wallet, program, solana.MustPublicKeyFromBase58(binding.Address)),
		&wallet,
	)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.validateOrBindSATLookupTableV2("mining", distribution); err != nil {
		t.Fatalf("bound distribution table was rejected: %v", err)
	}
	wrongDistribution, err := normalizeSignerIntentForWalletV2(
		satTestDistributionIntent(t, wallet, program, solana.NewWallet().PublicKey()),
		&wallet,
	)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.validateOrBindSATLookupTableV2("mining", wrongDistribution); err == nil || !strings.Contains(err.Error(), "durable wallet, cycle, and page") {
		t.Fatalf("distribution used a table outside its cycle/page binding: %v", err)
	}

	cleanupInput := signerIntentV2{
		Type: intentSolanaSATLookupTable, Action: "deactivate",
		LookupTable: &signerSATLookupTableIntentV2{
			Address: binding.Address, CycleID: "7", PageIndex: "2",
		},
	}
	cleanup, err := normalizeSignerIntentForWalletV2(cleanupInput, &wallet)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.validateOrBindSATLookupTableV2("mining", cleanup); err != nil {
		t.Fatalf("bound cleanup table was rejected: %v", err)
	}
	cleanup.Intent.LookupTable.Address = second.Intent.LookupTable.Address
	if err := store.validateOrBindSATLookupTableV2("mining", cleanup); err == nil || !strings.Contains(err.Error(), "durable wallet, cycle, and page") {
		t.Fatalf("cleanup targeted a table outside its cycle/page binding: %v", err)
	}
}

func TestSignerV2SATLookupBindingReadReapsExpiredAndTerminalPreBroadcastOwners(t *testing.T) {
	store, keys := openTestSignerV2(t)
	wallet := solana.NewWallet().PublicKey()
	createTestSignerWalletV2(t, store, keys, "mining-reap", solana.NewWallet().PublicKey().String(), 100, 1000)
	createIntent, err := normalizeSignerIntentForWalletV2(satTestLookupCreateIntent(t, wallet, 99), &wallet)
	if err != nil {
		t.Fatal(err)
	}
	now := store.now().UTC()
	putOwnerAndLease := func(operation signerOperationV2, lease signerSATLookupMutationLeaseV2) {
		t.Helper()
		if err := store.db.Update(func(tx *bolt.Tx) error {
			encodedOperation, err := json.Marshal(operation)
			if err != nil {
				return err
			}
			if err := tx.Bucket(bucketSignerOperationsV2).Put([]byte(operation.RequestID), encodedOperation); err != nil {
				return err
			}
			encodedLease, err := json.Marshal(lease)
			if err != nil {
				return err
			}
			return tx.Bucket(bucketSignerMetaV2).Put(satLookupMutationKeyV2(operation.WalletID, lease.Address), encodedLease)
		}); err != nil {
			t.Fatal(err)
		}
	}

	expiredCreate := signerOperationV2{
		RequestID: "expired-create-before-bind", WalletID: "mining_reap", IntentType: intentSolanaSATLookupTable,
		State: operationReserved, ExecutionAttempt: 1, ExecutionLeaseUntil: timestampV2(now.Add(-time.Second)),
	}
	putOwnerAndLease(expiredCreate, signerSATLookupMutationLeaseV2{
		RequestID: expiredCreate.RequestID, CycleID: "7", PageIndex: "2", Address: createIntent.Intent.LookupTable.Address,
	})
	binding, err := store.getSATLookupBindingV2(expiredCreate.WalletID, signerSATLookupBindingRequestV2{CycleID: "7", PageIndex: "2"})
	if err != nil || binding.Bound || binding.MutationRequestID != "" {
		t.Fatalf("expired create reservation was not reaped: binding=%#v err=%v", binding, err)
	}
	fenced, err := store.getOperation(expiredCreate.RequestID)
	if err != nil || fenced.State != operationFailed || fenced.ExecutionLeaseUntil != "" {
		t.Fatalf("expired create owner was not durably fenced: operation=%#v err=%v", fenced, err)
	}

	if err := store.validateOrBindSATLookupTableV2(expiredCreate.WalletID, createIntent); err != nil {
		t.Fatal(err)
	}
	expiredExtend := signerOperationV2{
		RequestID: "expired-extend-before-broadcast", WalletID: expiredCreate.WalletID, IntentType: intentSolanaSATLookupTable,
		State: operationReserved, ExecutionAttempt: 1, ExecutionLeaseUntil: timestampV2(now.Add(-time.Second)),
	}
	putOwnerAndLease(expiredExtend, signerSATLookupMutationLeaseV2{
		RequestID: expiredExtend.RequestID, CycleID: "7", PageIndex: "2", Address: createIntent.Intent.LookupTable.Address,
	})
	binding, err = store.getSATLookupBindingV2(expiredExtend.WalletID, signerSATLookupBindingRequestV2{CycleID: "7", PageIndex: "2"})
	if err != nil || !binding.Bound || binding.Address != createIntent.Intent.LookupTable.Address || binding.MutationRequestID != "" {
		t.Fatalf("expired bound mutation was not reaped without losing its binding: binding=%#v err=%v", binding, err)
	}

	for index := 0; index < 2; index++ {
		address, _, err := buildCreateSATLookupTableInstructionV2(wallet, uint64(100+index))
		if err != nil {
			t.Fatal(err)
		}
		owner := signerOperationV2{
			RequestID: fmt.Sprintf("terminal-create-%d", index), WalletID: expiredCreate.WalletID,
			IntentType: intentSolanaSATLookupTable, State: operationFailed,
		}
		putOwnerAndLease(owner, signerSATLookupMutationLeaseV2{
			RequestID: owner.RequestID, CycleID: "8", PageIndex: "3", Address: address.String(),
		})
	}
	activeAddress, _, err := buildCreateSATLookupTableInstructionV2(wallet, 102)
	if err != nil {
		t.Fatal(err)
	}
	activeOwner := signerOperationV2{
		RequestID: "active-create-after-terminals", WalletID: expiredCreate.WalletID,
		IntentType: intentSolanaSATLookupTable, State: operationReserved,
		ExecutionAttempt: 1, ExecutionLeaseUntil: timestampV2(now.Add(time.Minute)),
	}
	putOwnerAndLease(activeOwner, signerSATLookupMutationLeaseV2{
		RequestID: activeOwner.RequestID, CycleID: "8", PageIndex: "3", Address: activeAddress.String(),
	})
	terminalBinding, err := store.getSATLookupBindingV2(expiredCreate.WalletID, signerSATLookupBindingRequestV2{CycleID: "8", PageIndex: "3"})
	if err != nil || terminalBinding.Bound || terminalBinding.MutationRequestID != activeOwner.RequestID || terminalBinding.MutationState != operationReserved {
		t.Fatalf("terminal leases hid or poisoned the interleaved active owner: binding=%#v err=%v", terminalBinding, err)
	}
}

func TestSignerV2SATLookupMutationLeaseSerializesAndFencesStaleOwners(t *testing.T) {
	store, keys := openTestSignerV2(t)
	wallet := solana.NewWallet().PublicKey()
	createTestSignerWalletV2(t, store, keys, "mining", solana.NewWallet().PublicKey().String(), 100, 1000)
	intent, err := normalizeSignerIntentForWalletV2(satTestLookupCreateIntent(t, wallet, 99), &wallet)
	if err != nil {
		t.Fatal(err)
	}
	now := store.now().UTC()
	putOperation := func(operation signerOperationV2) {
		t.Helper()
		if err := store.db.Update(func(tx *bolt.Tx) error {
			encoded, err := json.Marshal(operation)
			if err != nil {
				return err
			}
			return tx.Bucket(bucketSignerOperationsV2).Put([]byte(operation.RequestID), encoded)
		}); err != nil {
			t.Fatal(err)
		}
	}
	first := signerOperationV2{
		RequestID: "lookup-request-first", WalletID: "mining", IntentType: intentSolanaSATLookupTable, State: operationReserved,
		ExecutionAttempt: 1, ExecutionLeaseUntil: timestampV2(now.Add(time.Minute)),
	}
	second := signerOperationV2{
		RequestID: "lookup-request-second", WalletID: "mining", IntentType: intentSolanaSATLookupTable, State: operationReserved,
		ExecutionAttempt: 1, ExecutionLeaseUntil: timestampV2(now.Add(time.Minute)),
	}
	putOperation(first)
	putOperation(second)
	if err := store.acquireSATLookupMutationLeaseV2("mining", first.RequestID, intent); err != nil {
		t.Fatalf("acquire first mutation lease: %v", err)
	}
	if err := store.acquireSATLookupMutationLeaseV2("mining", second.RequestID, intent); err == nil || !strings.Contains(err.Error(), "already in progress") {
		t.Fatalf("concurrent mutation was not blocked: %v", err)
	}

	first.State = operationConfirmed
	first.ExecutionLeaseUntil = ""
	putOperation(first)
	if err := store.acquireSATLookupMutationLeaseV2("mining", second.RequestID, intent); err != nil {
		t.Fatalf("terminal owner did not release mutation identity: %v", err)
	}

	second.ExecutionLeaseUntil = timestampV2(now.Add(-time.Second))
	putOperation(second)
	third := signerOperationV2{
		RequestID: "lookup-request-third", WalletID: "mining", IntentType: intentSolanaSATLookupTable, State: operationReserved,
		ExecutionAttempt: 1, ExecutionLeaseUntil: timestampV2(now.Add(time.Minute)),
	}
	putOperation(third)
	if err := store.acquireSATLookupMutationLeaseV2("mining", third.RequestID, intent); err != nil {
		t.Fatalf("stale owner was not fenced: %v", err)
	}
	fenced, err := store.getOperation(second.RequestID)
	if err != nil || fenced.State != operationFailed || fenced.ExecutionLeaseUntil != "" {
		t.Fatalf("stale owner was not durably failed: operation=%#v err=%v", fenced, err)
	}
	staleRaw := []byte("stale signed lookup mutation")
	staleDigest := sha256.Sum256(staleRaw)
	if _, err := store.validateBindAndMarkBroadcastClaimV2(
		"mining",
		intent,
		second.RequestID,
		second.ExecutionAttempt,
		"stale-signature",
		"sha256:"+hex.EncodeToString(staleDigest[:]),
		base64.StdEncoding.EncodeToString(staleRaw),
	); err == nil {
		t.Fatal("fenced stale mutation persisted a binding or broadcast record")
	}
	binding, err := store.getSATLookupBindingV2("mining", signerSATLookupBindingRequestV2{CycleID: "7", PageIndex: "2"})
	if err != nil || binding.Bound {
		t.Fatalf("fenced stale mutation poisoned the immutable table binding: binding=%#v err=%v", binding, err)
	}

	third.State = operationUnknown
	putOperation(third)
	fourth := signerOperationV2{
		RequestID: "lookup-request-fourth", WalletID: "mining", IntentType: intentSolanaSATLookupTable, State: operationReserved,
		ExecutionAttempt: 1, ExecutionLeaseUntil: timestampV2(now.Add(time.Minute)),
	}
	putOperation(fourth)
	if err := store.acquireSATLookupMutationLeaseV2("mining", fourth.RequestID, intent); err == nil || !strings.Contains(err.Error(), "reconciliation") {
		t.Fatalf("ambiguous mutation owner did not block a new mutation: %v", err)
	}
}

func TestSignerV2ExpiredNonCreateMutationReleasesOwnerAndKeepsBinding(t *testing.T) {
	store, keys := openTestSignerV2(t)
	wallet := solana.NewWallet().PublicKey()
	createTestSignerWalletV2(t, store, keys, "mining-expired-extend", solana.NewWallet().PublicKey().String(), 100, 1000)
	intent, err := normalizeSignerIntentForWalletV2(satTestLookupCreateIntent(t, wallet, 99), &wallet)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.validateOrBindSATLookupTableV2("mining-expired-extend", intent); err != nil {
		t.Fatal(err)
	}
	requestID := "expired-extend-owner"
	operation := signerOperationV2{
		RequestID: requestID, WalletID: "mining_expired_extend", IntentType: intentSolanaSATLookupTable,
		State: operationUnknown, Signature: "historical-extend-signature", ReservationActive: true,
	}
	lease := signerSATLookupMutationLeaseV2{
		RequestID: requestID, CycleID: "7", PageIndex: "2", Address: intent.Intent.LookupTable.Address,
	}
	if err := store.db.Update(func(tx *bolt.Tx) error {
		encodedOperation, err := json.Marshal(operation)
		if err != nil {
			return err
		}
		if err := tx.Bucket(bucketSignerOperationsV2).Put([]byte(requestID), encodedOperation); err != nil {
			return err
		}
		encodedLease, err := json.Marshal(lease)
		if err != nil {
			return err
		}
		return tx.Bucket(bucketSignerMetaV2).Put(satLookupMutationKeyV2(operation.WalletID, lease.Address), encodedLease)
	}); err != nil {
		t.Fatal(err)
	}
	failed, err := store.failExpiredSATLookupMutationV2(operation.WalletID, requestID, lease.Address, false)
	if err != nil || failed.State != operationFailed || failed.Signature != operation.Signature {
		t.Fatalf("expire non-create mutation: operation=%#v err=%v", failed, err)
	}
	binding, err := store.getSATLookupBindingV2(operation.WalletID, signerSATLookupBindingRequestV2{CycleID: "7", PageIndex: "2"})
	if err != nil || !binding.Bound || binding.Address != lease.Address || binding.MutationRequestID != "" {
		t.Fatalf("expired non-create mutation did not retain only its binding: binding=%#v err=%v", binding, err)
	}
}

func TestSignerV2SATLookupMutationContenderRetriesSameRequestAfterOwnerTerminal(t *testing.T) {
	store, keys := openTestSignerV2(t)
	walletRecord, lockedPolicy, err := keys.CreateWithPolicy(signerWalletCreateRequestV2{
		WalletID:        "mining-mutation-service",
		ExpectedVersion: 0,
		Policy:          signerPolicyV2{Role: "mining"},
	})
	if err != nil {
		t.Fatal(err)
	}
	wallet := solana.MustPublicKeyFromBase58(walletRecord.PublicKey)
	input := satTestLookupCreateIntent(t, wallet, 99)
	intent, err := normalizeSignerIntentForWalletV2(input, &wallet)
	if err != nil {
		t.Fatal(err)
	}
	if intent.ParentIntent == nil {
		t.Fatal("lookup create test intent is missing its typed parent")
	}
	programs := append([]string{}, intent.RequiredPrograms...)
	for _, program := range intent.ParentIntent.RequiredPrograms {
		if !containsStringV2(programs, program) {
			programs = append(programs, program)
		}
	}
	destinations := []string{intent.Destination}
	if !containsStringV2(destinations, intent.ParentIntent.Destination) {
		destinations = append(destinations, intent.ParentIntent.Destination)
	}
	policy, err := store.putPolicy(signerPolicyV2{
		WalletID: walletRecord.WalletID,
		Role:     "mining",
		Operations: []string{
			intent.PolicyOperation,
			intent.ParentIntent.PolicyOperation,
		},
		Programs: programs,
		Assets: []signerPolicyAssetV2{
			{Asset: "sat:action", Destinations: destinations, MaxPerTx: "10", MaxDaily: "100"},
			{Asset: "solana:native", Destinations: destinations, MaxPerTx: "100000000", MaxDaily: "500000000"},
		},
	}, lockedPolicy.Version)
	if err != nil {
		t.Fatalf("install lookup mutation test policy: %v", err)
	}

	var blockhash solana.Hash
	blockhash[0] = 9
	genesis := "11111111111111111111111111111111"
	newRPC := func() *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			defer request.Body.Close()
			var body struct {
				ID     any               `json:"id"`
				Method string            `json:"method"`
				Params []json.RawMessage `json:"params"`
			}
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
				t.Fatalf("decode mutation test RPC: %v", err)
			}
			response := map[string]any{"jsonrpc": "2.0", "id": body.ID}
			account := map[string]any{
				"lamports": 1_000_000_000, "owner": solana.SystemProgramID.String(),
				"data": []any{"", "base64"}, "executable": false, "rentEpoch": 0, "space": 0,
			}
			switch body.Method {
			case "getGenesisHash":
				response["result"] = genesis
			case "getSlot":
				response["result"] = 100
			case "getLatestBlockhash":
				response["result"] = map[string]any{
					"context": map[string]any{"slot": 100},
					"value":   map[string]any{"blockhash": blockhash.String(), "lastValidBlockHeight": 500},
				}
			case "getAccountInfo":
				response["result"] = map[string]any{"context": map[string]any{"slot": 100}, "value": account}
			case "simulateTransaction":
				response["result"] = map[string]any{
					"context": map[string]any{"slot": 100},
					"value":   map[string]any{"err": nil, "logs": []string{}, "unitsConsumed": 1, "accounts": []any{account}},
				}
			case "sendTransaction":
				var encoded string
				if len(body.Params) == 0 || json.Unmarshal(body.Params[0], &encoded) != nil {
					t.Fatal("mutation test sendTransaction omitted signed transaction")
				}
				raw, err := base64.StdEncoding.DecodeString(encoded)
				if err != nil {
					t.Fatal(err)
				}
				tx, err := solana.TransactionFromBytes(raw)
				if err != nil || len(tx.Signatures) == 0 {
					t.Fatalf("decode mutation test transaction: %v", err)
				}
				response["result"] = tx.Signatures[0].String()
			case "getSignatureStatuses":
				response["result"] = map[string]any{
					"context": map[string]any{"slot": 101},
					"value": []any{map[string]any{
						"slot": 101, "confirmations": nil, "err": nil, "confirmationStatus": "confirmed",
					}},
				}
			default:
				t.Fatalf("unexpected mutation test RPC method %q", body.Method)
			}
			writer.Header().Set("Content-Type", "application/json")
			if err := json.NewEncoder(writer).Encode(response); err != nil {
				t.Fatal(err)
			}
		}))
	}
	primary, fallback := newRPC(), newRPC()
	defer primary.Close()
	defer fallback.Close()
	if _, err := keys.PutNetworkV2(walletRecord.WalletID, signerNetworkPutRequestV2{
		ExpectedVersion:         signerUint64PointerV2(0),
		PrimaryRPCURL:           primary.URL,
		ExecutionFallbackRPCURL: fallback.URL,
	}); err != nil {
		t.Fatalf("configure mutation test signer network: %v", err)
	}

	firstRequest := signerExecuteRequestV2{
		RequestID: "lookup-service-owner", PolicyHash: policy.Hash, Intent: input, intentWalletID: walletRecord.WalletID,
	}
	first, _, err := store.reserveOperation(firstRequest, intent)
	if err != nil {
		t.Fatal(err)
	}
	first, firstAttempt, claimed, err := store.claimReservedOperation(first.RequestID)
	if err != nil || !claimed {
		t.Fatalf("claim mutation owner: operation=%#v claimed=%t err=%v", first, claimed, err)
	}
	if err := store.acquireSATLookupMutationLeaseV2(walletRecord.WalletID, first.RequestID, intent); err != nil {
		t.Fatal(err)
	}

	service := &signerServiceV2{store: store, keys: keys}
	contenderRequest := signerExecuteRequestV2{
		RequestID: "lookup-service-contender", PolicyHash: policy.Hash, Intent: input, intentWalletID: walletRecord.WalletID,
	}
	blocked, err := service.execute(contenderRequest)
	if err != nil || blocked.State != operationReserved || blocked.ExecutionLeaseUntil != "" {
		t.Fatalf("transient contender was not left exactly retryable: operation=%#v err=%v", blocked, err)
	}
	if _, err := store.markFailedClaim(first.RequestID, firstAttempt, errors.New("test owner terminal before broadcast")); err != nil {
		t.Fatal(err)
	}
	confirmed, err := service.execute(contenderRequest)
	if err != nil || confirmed.State != operationConfirmed || confirmed.RequestID != contenderRequest.RequestID {
		t.Fatalf("same contender request did not complete after owner became terminal: operation=%#v err=%v", confirmed, err)
	}
}

func TestSignerV2SATLookupCreateReconciliationReplaysOrSafelyExpiresExactBytes(t *testing.T) {
	for _, test := range []struct {
		name            string
		blockhashValid  bool
		expectedState   string
		expectedReplay  bool
		expectedBinding bool
	}{
		{name: "valid exact bytes are replayed", blockhashValid: true, expectedState: operationConfirmed, expectedReplay: true, expectedBinding: true},
		{name: "expired absent create is failed and unbound", blockhashValid: false, expectedState: operationFailed, expectedReplay: false, expectedBinding: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			store, keys := openTestSignerV2(t)
			walletRecord, _, err := keys.CreateWithPolicy(signerWalletCreateRequestV2{
				WalletID: "mining-reconcile-create", ExpectedVersion: 0, Policy: signerPolicyV2{Role: "mining"},
			})
			if err != nil {
				t.Fatal(err)
			}
			wallet := solana.MustPublicKeyFromBase58(walletRecord.PublicKey)
			intent, err := normalizeSignerIntentForWalletV2(satTestLookupCreateIntent(t, wallet, 99), &wallet)
			if err != nil {
				t.Fatal(err)
			}
			privateKey, _, err := keys.privateKey(walletRecord.WalletID)
			if err != nil {
				t.Fatal(err)
			}
			defer zeroBytes(privateKey)
			var blockhash solana.Hash
			blockhash[0] = 11
			tx, err := newSignedTypedTransactionV2(intent.Instructions, blockhash, privateKey, nil)
			if err != nil {
				t.Fatal(err)
			}
			raw, err := tx.MarshalBinary()
			if err != nil {
				t.Fatal(err)
			}
			digest := sha256.Sum256(raw)
			requestID := "lookup-reconcile-create"
			operation := signerOperationV2{
				RequestID: requestID, WalletID: walletRecord.WalletID, IntentType: intentSolanaSATLookupTable,
				IntentDigest: intent.Digest, State: operationBroadcast, ReservationActive: true,
				Signature: tx.Signatures[0].String(), TransactionDigest: "sha256:" + hex.EncodeToString(digest[:]),
				SignedTxBase64: base64.StdEncoding.EncodeToString(raw), BroadcastAt: timestampV2(store.now()), UpdatedAt: timestampV2(store.now()),
			}
			if err := store.db.Update(func(dbTx *bolt.Tx) error {
				encoded, err := json.Marshal(operation)
				if err != nil {
					return err
				}
				if err := dbTx.Bucket(bucketSignerOperationsV2).Put([]byte(requestID), encoded); err != nil {
					return err
				}
				lease, err := json.Marshal(signerSATLookupMutationLeaseV2{
					RequestID: requestID,
					CycleID:   "7",
					PageIndex: "2",
					Address:   intent.Intent.LookupTable.Address,
				})
				if err != nil {
					return err
				}
				return dbTx.Bucket(bucketSignerMetaV2).Put(satLookupMutationKeyV2(walletRecord.WalletID, intent.Intent.LookupTable.Address), lease)
			}); err != nil {
				t.Fatal(err)
			}
			if err := store.validateOrBindSATLookupTableV2(walletRecord.WalletID, intent); err != nil {
				t.Fatal(err)
			}

			genesis := "11111111111111111111111111111111"
			var replayed atomic.Bool
			newRPC := func() *httptest.Server {
				return httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
					defer request.Body.Close()
					var body struct {
						ID     any               `json:"id"`
						Method string            `json:"method"`
						Params []json.RawMessage `json:"params"`
					}
					if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
						t.Fatal(err)
					}
					response := map[string]any{"jsonrpc": "2.0", "id": body.ID}
					switch body.Method {
					case "getGenesisHash":
						response["result"] = genesis
					case "getSignatureStatuses":
						value := []any{nil}
						if replayed.Load() {
							value = []any{map[string]any{"slot": 101, "confirmations": nil, "err": nil, "confirmationStatus": "confirmed"}}
						}
						response["result"] = map[string]any{"context": map[string]any{"slot": 101}, "value": value}
					case "isBlockhashValid":
						response["result"] = map[string]any{"context": map[string]any{"slot": 101}, "value": test.blockhashValid}
					case "getAccountInfo":
						response["result"] = map[string]any{"context": map[string]any{"slot": 101}, "value": nil}
					case "sendTransaction":
						var encoded string
						if len(body.Params) == 0 || json.Unmarshal(body.Params[0], &encoded) != nil || encoded != base64.StdEncoding.EncodeToString(raw) {
							t.Fatal("reconciliation did not replay the exact signed transaction bytes")
						}
						replayed.Store(true)
						response["result"] = tx.Signatures[0].String()
					default:
						t.Fatalf("unexpected reconciliation RPC method %q", body.Method)
					}
					writer.Header().Set("Content-Type", "application/json")
					if err := json.NewEncoder(writer).Encode(response); err != nil {
						t.Fatal(err)
					}
				}))
			}
			primary, fallback := newRPC(), newRPC()
			defer primary.Close()
			defer fallback.Close()
			if _, err := keys.PutNetworkV2(walletRecord.WalletID, signerNetworkPutRequestV2{
				ExpectedVersion: signerUint64PointerV2(0), PrimaryRPCURL: primary.URL, ExecutionFallbackRPCURL: fallback.URL,
			}); err != nil {
				t.Fatal(err)
			}

			result, err := (&signerServiceV2{store: store, keys: keys}).reconcile(requestID, walletRecord.WalletID)
			if err != nil || result.State != test.expectedState || replayed.Load() != test.expectedReplay {
				t.Fatalf("unexpected lookup create reconciliation: operation=%#v replayed=%t err=%v", result, replayed.Load(), err)
			}
			binding, err := store.getSATLookupBindingV2(walletRecord.WalletID, signerSATLookupBindingRequestV2{CycleID: "7", PageIndex: "2"})
			if err != nil || binding.Bound != test.expectedBinding {
				t.Fatalf("unexpected lookup binding after reconciliation: binding=%#v err=%v", binding, err)
			}
		})
	}
}

func satTestDistributionIntent(t *testing.T, wallet, program, table solana.PublicKey) signerIntentV2 {
	t.Helper()
	cycleID, pageIndex := uint64(7), uint64(2)
	cycle, page := make([]byte, 8), make([]byte, 8)
	binary.LittleEndian.PutUint64(cycle, cycleID)
	binary.LittleEndian.PutUint64(page, pageIndex)
	data := make([]byte, 25)
	data[0] = 66
	binary.LittleEndian.PutUint64(data[1:9], cycleID)
	binary.LittleEndian.PutUint64(data[9:17], pageIndex)
	miner := solana.NewWallet().PublicKey()
	keys := []signerSATAccountV2{
		satTestAccount(wallet, true, true),
		satTestAccount(satTestPDA(t, program, []byte("sat_cycle_state"), cycle), false, true),
		satTestAccount(satTestPDA(t, program, []byte("sat_cycle_registry_page"), cycle, page), false, false),
		satTestAccount(satTestPDA(t, program, []byte("sat_cycle_settlement_progress_v2"), cycle), false, true),
		satTestAccount(satTestPDA(t, program, []byte("sat_global_state")), false, false),
		satTestAccount(satTestPDA(t, program, []byte("sat_treasury_state")), false, true),
		satTestAccount(satTestPDA(t, program, []byte("sat_miner_cycle_state"), wallet[:], cycle), false, false),
		satTestAccount(satTestPDA(t, program, []byte("sat_miner_capital_state"), wallet[:]), false, true),
		satTestAccount(satTestPDA(t, program, []byte("sat_rebate_vault")), false, true),
		satTestAccount(satTestPDA(t, program, []byte("sat_treasury_vault")), false, true),
		satTestAccount(satTestPDA(t, program, []byte("sat_miner_cycle_state"), miner[:], cycle), false, true),
		satTestAccount(satTestPDA(t, program, []byte("sat_miner_capital_state"), miner[:]), false, true),
	}
	return signerIntentV2{
		Type: intentSolanaSATAction, Action: "distributeCyclePage", ProgramID: program.String(),
		DataBase64: base64.StdEncoding.EncodeToString(data), Keys: keys,
		Context:             &signerSATContextV2{MinerAuthorities: []string{miner.String()}},
		AddressLookupTables: []string{table.String()},
	}
}

func satTestLookupParent(t *testing.T, wallet, table solana.PublicKey) *signerSATInstructionV2 {
	t.Helper()
	parent := satTestDistributionIntent(t, wallet, solana.NewWallet().PublicKey(), table)
	return &signerSATInstructionV2{
		Action: parent.Action, ProgramID: parent.ProgramID, DataBase64: parent.DataBase64,
		Keys: parent.Keys, Context: parent.Context,
	}
}

func TestSignerV2SATDistributionCompilesToOneSignedV0LookupTransaction(t *testing.T) {
	privateKey := solana.NewWallet().PrivateKey
	wallet, program, table := privateKey.PublicKey(), solana.NewWallet().PublicKey(), solana.NewWallet().PublicKey()
	normalized, err := normalizeSignerIntentForWalletV2(satTestDistributionIntent(t, wallet, program, table), &wallet)
	if err != nil {
		t.Fatalf("normalize lookup-backed SAT distribution: %v", err)
	}
	addresses := make(solana.PublicKeySlice, 0)
	for _, instruction := range normalized.Instructions {
		for _, account := range instruction.Accounts() {
			if !account.IsSigner {
				addresses = append(addresses, account.PublicKey)
			}
		}
	}
	tx, err := newSignedTypedTransactionV2(
		normalized.Instructions,
		solana.Hash{},
		privateKey,
		map[solana.PublicKey]solana.PublicKeySlice{table: addresses},
	)
	if err != nil {
		t.Fatalf("build signed lookup-backed SAT distribution: %v", err)
	}
	if tx.Message.GetVersion() != solana.MessageVersionV0 || len(tx.Message.GetAddressTableLookups()) != 1 || tx.Message.NumLookups() == 0 {
		t.Fatalf("SAT distribution did not use exactly one v0 lookup table: %#v", tx.Message)
	}
	raw, err := tx.MarshalBinary()
	if err != nil {
		t.Fatalf("marshal lookup-backed SAT distribution: %v", err)
	}
	if len(raw) == 0 || len(raw) > 1232 || len(tx.Signatures) != 1 || tx.Signatures[0].IsZero() {
		t.Fatalf("invalid signed SAT v0 transaction: bytes=%d signatures=%d", len(raw), len(tx.Signatures))
	}
	invalid := satTestDepositIntent(t, wallet, program, 1)
	invalid.AddressLookupTables = []string{table.String()}
	if _, err := normalizeSignerIntentForWalletV2(invalid, &wallet); err == nil || !strings.Contains(err.Error(), "allowed only") {
		t.Fatalf("non-distribution SAT action accepted a lookup table: %v", err)
	}
}
