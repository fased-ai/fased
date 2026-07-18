package main

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	addresslookuptable "github.com/gagliardetto/solana-go/programs/address-lookup-table"
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
			RecentSlot: strconv.FormatUint(slot, 10),
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
	addresses := []string{solana.NewWallet().PublicKey().String(), solana.NewWallet().PublicKey().String()}
	valid := signerIntentV2{
		Type: intentSolanaSATLookupTable, Action: "extend",
		LookupTable: &signerSATLookupTableIntentV2{Address: table.String(), Addresses: addresses},
	}
	normalized, err := normalizeSignerIntentForWalletV2(valid, &wallet)
	if err != nil {
		t.Fatalf("normalize SAT lookup-table extend: %v", err)
	}
	if normalized.PolicyOperation != "satLookup.extend@"+satAddressLookupTableProgramIDV2.String() || normalized.NativeFeeReservation.Uint64() != satLookupTableRentReservationLamports {
		t.Fatalf("unexpected lookup-table extend policy or cap: %#v", normalized)
	}
	duplicate := valid
	duplicate.LookupTable = &signerSATLookupTableIntentV2{Address: table.String(), Addresses: []string{addresses[0], addresses[0]}}
	if _, err := normalizeSignerIntentForWalletV2(duplicate, &wallet); err == nil || !strings.Contains(err.Error(), "duplicate") {
		t.Fatalf("lookup-table extend accepted duplicate addresses: %v", err)
	}
	oversize := make([]string, maxSATLookupTableExtendAddressesV2+1)
	for index := range oversize {
		oversize[index] = solana.NewWallet().PublicKey().String()
	}
	tooMany := valid
	tooMany.LookupTable = &signerSATLookupTableIntentV2{Address: table.String(), Addresses: oversize}
	if _, err := normalizeSignerIntentForWalletV2(tooMany, &wallet); err == nil || !strings.Contains(err.Error(), "one to 20") {
		t.Fatalf("lookup-table extend accepted too many addresses: %v", err)
	}
	unrelated := valid
	unrelated.Destination = solana.NewWallet().PublicKey().String()
	if _, err := normalizeSignerIntentForWalletV2(unrelated, &wallet); err == nil || !strings.Contains(err.Error(), "unrelated") {
		t.Fatalf("lookup-table intent accepted an unrelated transfer field: %v", err)
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
