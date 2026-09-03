package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	solana "github.com/gagliardetto/solana-go"
)

func createOwnerCeremonyWalletV1(t *testing.T, keys *signerKeyManagerV2, walletID, role, rpcURL string) signerWalletRecordV2 {
	t.Helper()
	wallet, _, err := keys.CreateWithRoleBaseline(
		walletID, 0,
		signerRoleBaselineRequestV1{Version: signerRoleBaselineVersionV1, Role: role},
		signerRoleBaselineRuntimeV1{},
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := keys.PutNetworkV2(walletID, signerNetworkPutRequestV2{
		ExpectedVersion: signerUint64PointerV2(0), PrimaryRPCURL: rpcURL,
	}); err != nil {
		t.Fatal(err)
	}
	return wallet
}

func ownerCeremonyCreateFixtureV1(t *testing.T, profile, recovery signerWalletRecordV2) ownerCeremonyRequestV1 {
	t.Helper()
	program := solana.MustPublicKeyFromBase58(agentIdentityProgramIDV1)
	profileKey := solana.MustPublicKeyFromBase58(profile.PublicKey)
	recoveryKey := solana.MustPublicKeyFromBase58(recovery.PublicKey)
	record, _, err := solana.FindProgramAddress([][]byte{[]byte("fased-agent-record"), profileKey[:]}, program)
	if err != nil {
		t.Fatal(err)
	}
	controllerIndex, _, err := solana.FindProgramAddress([][]byte{[]byte("authority-index"), profileKey[:]}, program)
	if err != nil {
		t.Fatal(err)
	}
	recoveryIndex, _, err := solana.FindProgramAddress([][]byte{[]byte("authority-index"), recoveryKey[:]}, program)
	if err != nil {
		t.Fatal(err)
	}
	contract := agentIdentityInstructionContractsV1["create_fased_agent_record"]
	data := append([]byte(nil), contract.Discriminator[:]...)
	return ownerCeremonyRequestV1{
		RequestID: "owner-ceremony-create-0001", Cluster: "devnet", Action: "create_fased_agent_record",
		ProgramID: agentIdentityProgramIDV1, DataBase64: base64.StdEncoding.EncodeToString(data),
		Accounts: []ownerCeremonyAccountV1{
			{Name: "profile_controller", Pubkey: profile.PublicKey, IsSigner: true, IsWritable: true, SignerWalletID: profile.WalletID},
			{Name: "recovery_authority", Pubkey: recovery.PublicKey, IsSigner: true, SignerWalletID: recovery.WalletID},
			{Name: "fased_agent_record", Pubkey: record.String(), IsWritable: true},
			{Name: "controller_index", Pubkey: controllerIndex.String(), IsWritable: true},
			{Name: "recovery_index", Pubkey: recoveryIndex.String(), IsWritable: true},
			{Name: "system_program", Pubkey: solana.SystemProgramID.String()},
		},
	}
}

func ownerCeremonyBindingFixtureV1(action string, profile, mining signerWalletRecordV2) ownerCeremonyRequestV1 {
	contract, _ := ownerCeremonyContractForActionV1(action)
	data := make([]byte, contract.DataSize)
	copy(data[:contract.DiscSize], contract.Disc[:contract.DiscSize])
	accounts := make([]ownerCeremonyAccountV1, 0, len(contract.Accounts))
	for _, expected := range contract.Accounts {
		key := solana.NewWallet().PublicKey().String()
		walletID := ""
		switch expected.Name {
		case "profile_controller":
			key, walletID = profile.PublicKey, profile.WalletID
		case "mining_controller", "current_miner_authority":
			key, walletID = mining.PublicKey, mining.WalletID
		default:
			if expected.Address != "" {
				key = expected.Address
			}
		}
		if !expected.IsSigner {
			walletID = ""
		}
		accounts = append(accounts, ownerCeremonyAccountV1{
			Name: expected.Name, Pubkey: key, IsSigner: expected.IsSigner,
			IsWritable: expected.IsWritable, SignerWalletID: walletID,
		})
	}
	return ownerCeremonyRequestV1{
		RequestID: "owner-ceremony-" + action, Cluster: "devnet", Action: action,
		ProgramID: contract.ProgramID, DataBase64: base64.StdEncoding.EncodeToString(data), Accounts: accounts,
	}
}

func ownerCeremonySatInitFixtureV1(t *testing.T, action string, mining signerWalletRecordV2) ownerCeremonyRequestV1 {
	t.Helper()
	contract, ok := ownerCeremonyContractForActionV1(action)
	if !ok {
		t.Fatalf("missing %s contract", action)
	}
	miningKey := solana.MustPublicKeyFromBase58(mining.PublicKey)
	agentRecord, _, err := solana.FindProgramAddress(
		[][]byte{[]byte("sat_agent_record"), miningKey[:]},
		solana.MustPublicKeyFromBase58(contract.ProgramID),
	)
	if err != nil {
		t.Fatal(err)
	}
	capital, _, err := solana.FindProgramAddress(
		[][]byte{[]byte("sat_miner_capital_state"), miningKey[:]},
		solana.MustPublicKeyFromBase58(contract.ProgramID),
	)
	if err != nil {
		t.Fatal(err)
	}
	data := make([]byte, contract.DataSize)
	data[0] = contract.Disc[0]
	if action == "sat_init_agent_record" {
		recovery := solana.NewWallet().PublicKey()
		runtimeExecutor := solana.NewWallet().PublicKey()
		keeperPayer := solana.NewWallet().PublicKey()
		for _, field := range []struct {
			offset int
			key    solana.PublicKey
		}{{1, miningKey}, {33, miningKey}, {65, recovery}, {97, miningKey}, {129, runtimeExecutor}, {161, keeperPayer}} {
			copy(data[field.offset:field.offset+32], field.key[:])
		}
	} else {
		copy(data[1:], miningKey[:])
	}
	accounts := make([]ownerCeremonyAccountV1, 0, len(contract.Accounts))
	for _, expected := range contract.Accounts {
		key := solana.NewWallet().PublicKey().String()
		walletID := ""
		switch expected.Name {
		case "permanent_mining_id", "controller", "active_miner_authority", "signer":
			key, walletID = mining.PublicKey, mining.WalletID
		case "sat_agent_record":
			key = agentRecord.String()
		case "sat_miner_capital_state":
			key = capital.String()
		default:
			if expected.Address != "" {
				key = expected.Address
			}
		}
		if !expected.IsSigner {
			walletID = ""
		}
		accounts = append(accounts, ownerCeremonyAccountV1{
			Name: expected.Name, Pubkey: key, IsSigner: expected.IsSigner,
			IsWritable: expected.IsWritable, SignerWalletID: walletID,
		})
	}
	return ownerCeremonyRequestV1{
		RequestID: "owner-ceremony-" + action, Cluster: "devnet", Action: action,
		ProgramID: contract.ProgramID, DataBase64: base64.StdEncoding.EncodeToString(data), Accounts: accounts,
	}
}

func TestOwnerCeremonyRequiresControlExactContractRolesSimulationAndReplayFence(t *testing.T) {
	var unsignedSimulations, signedSimulations, sends atomic.Int64
	var rejectSimulation atomic.Bool
	var blockhash solana.Hash
	blockhash[0] = 9
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
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
			response["result"] = solanaDevnetGenesisHashV2
		case "getLatestBlockhash":
			response["result"] = map[string]any{"context": map[string]any{"slot": 1}, "value": map[string]any{"blockhash": blockhash.String(), "lastValidBlockHeight": 99}}
		case "simulateTransaction":
			var opts struct {
				SigVerify bool `json:"sigVerify"`
			}
			if len(body.Params) != 2 || json.Unmarshal(body.Params[1], &opts) != nil {
				t.Fatal("simulation options are missing")
			}
			if opts.SigVerify {
				signedSimulations.Add(1)
			} else {
				unsignedSimulations.Add(1)
			}
			var simulationError any
			if rejectSimulation.Load() {
				simulationError = map[string]any{"InstructionError": []any{0, "Custom"}}
			}
			response["result"] = map[string]any{"context": map[string]any{"slot": 1}, "value": map[string]any{"err": simulationError, "logs": []string{}, "unitsConsumed": 10}}
		case "sendTransaction":
			sends.Add(1)
			var encoded string
			if len(body.Params) == 0 || json.Unmarshal(body.Params[0], &encoded) != nil {
				t.Fatal("signed transaction is missing")
			}
			raw, err := base64.StdEncoding.DecodeString(encoded)
			if err != nil {
				t.Fatal(err)
			}
			tx, err := solana.TransactionFromBytes(raw)
			if err != nil || len(tx.Signatures) != 2 || tx.VerifySignatures() != nil {
				t.Fatalf("owner ceremony did not submit both exact signatures: %v", err)
			}
			response["result"] = tx.Signatures[0].String()
		case "getSignatureStatuses":
			response["result"] = map[string]any{"context": map[string]any{"slot": 2}, "value": []any{map[string]any{"slot": 2, "confirmations": nil, "err": nil, "confirmationStatus": "confirmed"}}}
		default:
			t.Fatalf("unexpected RPC method %q", body.Method)
		}
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(response)
	}))
	defer server.Close()

	store, keys := openTestSignerV2(t)
	keys.genesisHash = func(string) (string, error) { return solanaDevnetGenesisHashV2, nil }
	profile := createOwnerCeremonyWalletV1(t, keys, "profile", "profile", server.URL)
	recovery := createOwnerCeremonyWalletV1(t, keys, "recovery", "vault", server.URL)
	mining := createOwnerCeremonyWalletV1(t, keys, "mining", "mining", server.URL)
	service := &signerServiceV2{store: store, keys: keys}
	fixture := ownerCeremonyCreateFixtureV1(t, profile, recovery)
	body, _ := json.Marshal(fixture)
	if _, err := service.handle(request{Op: "v2.ownerCeremony.prepare", Request: body}, signerConfig{}, false); err == nil || !strings.Contains(err.Error(), "control socket") {
		t.Fatalf("owner ceremony escaped the control socket: %v", err)
	}
	prepared, err := service.prepareOwnerCeremonyV1(fixture)
	if err != nil || prepared.State != operationReserved || prepared.SimulationSigVerify || unsignedSimulations.Load() != 1 || sends.Load() != 0 {
		t.Fatalf("owner ceremony preparation changed: result=%#v err=%v", prepared, err)
	}

	wrongProgram := fixture
	wrongProgram.ProgramID = solana.NewWallet().PublicKey().String()
	if _, err := service.prepareOwnerCeremonyV1(wrongProgram); err == nil || !strings.Contains(err.Error(), "generated contract") {
		t.Fatalf("owner ceremony accepted the wrong program: %v", err)
	}
	wrongRole := fixture
	wrongRole.RequestID = "owner-ceremony-create-wrong-role"
	wrongRole.Accounts = append([]ownerCeremonyAccountV1(nil), fixture.Accounts...)
	wrongRole.Accounts[1].Pubkey = mining.PublicKey
	wrongRole.Accounts[1].SignerWalletID = mining.WalletID
	if _, err := service.prepareOwnerCeremonyV1(wrongRole); err == nil || !strings.Contains(err.Error(), "required signer-owned role") {
		t.Fatalf("owner ceremony accepted the wrong signer role: %v", err)
	}
	wrongFlags := fixture
	wrongFlags.RequestID = "owner-ceremony-create-wrong-flags"
	wrongFlags.Accounts = append([]ownerCeremonyAccountV1(nil), fixture.Accounts...)
	wrongFlags.Accounts[2].IsWritable = false
	if _, err := service.prepareOwnerCeremonyV1(wrongFlags); err == nil || !strings.Contains(err.Error(), "generated contract") {
		t.Fatalf("owner ceremony accepted changed account flags: %v", err)
	}
	for _, action := range []string{"bind_agent_mining", "bind_satcoin_vault"} {
		binding := ownerCeremonyBindingFixtureV1(action, profile, mining)
		normalized, err := service.normalizeOwnerCeremonyV1(binding)
		if err != nil {
			t.Fatalf("%s was rejected: %v", action, err)
		}
		tx, err := buildOwnerCeremonyTransactionV1(normalized, blockhash)
		if err != nil || len(tx.Signatures) != 2 {
			t.Fatalf("%s signer layout changed: signatures=%d err=%v", action, len(tx.Signatures), err)
		}
	}
	for _, action := range []string{"sat_init_agent_record", "sat_init_miner_capital"} {
		initialization := ownerCeremonySatInitFixtureV1(t, action, mining)
		normalized, err := service.normalizeOwnerCeremonyV1(initialization)
		if err != nil {
			t.Fatalf("%s was rejected: %v", action, err)
		}
		tx, err := buildOwnerCeremonyTransactionV1(normalized, blockhash)
		if err != nil || len(tx.Signatures) != 1 || !normalized.FeePayer.Equals(solana.MustPublicKeyFromBase58(mining.PublicKey)) {
			t.Fatalf("%s signer layout changed: signatures=%d payer=%s err=%v", action, len(tx.Signatures), normalized.FeePayer, err)
		}
	}
	badSatRoles := ownerCeremonySatInitFixtureV1(t, "sat_init_agent_record", mining)
	badSatRoles.RequestID = "owner-ceremony-sat-init-bad-roles"
	badSatRoleData, err := base64.StdEncoding.DecodeString(badSatRoles.DataBase64)
	if err != nil {
		t.Fatal(err)
	}
	miningKey := solana.MustPublicKeyFromBase58(mining.PublicKey)
	copy(badSatRoleData[129:161], miningKey[:])
	badSatRoles.DataBase64 = base64.StdEncoding.EncodeToString(badSatRoleData)
	if _, err := service.normalizeOwnerCeremonyV1(badSatRoles); err == nil || !strings.Contains(err.Error(), "must be isolated") {
		t.Fatalf("Satcoin initialization accepted a Runtime key equal to Mining: %v", err)
	}
	badSatBinding := ownerCeremonySatInitFixtureV1(t, "sat_init_agent_record", mining)
	badSatBinding.RequestID = "owner-ceremony-sat-init-bad-binding"
	badSatBindingData, err := base64.StdEncoding.DecodeString(badSatBinding.DataBase64)
	if err != nil {
		t.Fatal(err)
	}
	otherController := solana.NewWallet().PublicKey()
	copy(badSatBindingData[33:65], otherController[:])
	badSatBinding.DataBase64 = base64.StdEncoding.EncodeToString(badSatBindingData)
	if _, err := service.normalizeOwnerCeremonyV1(badSatBinding); err == nil || !strings.Contains(err.Error(), "authority fields") {
		t.Fatalf("Satcoin initialization accepted an embedded controller mismatch: %v", err)
	}
	badCapital := ownerCeremonySatInitFixtureV1(t, "sat_init_miner_capital", mining)
	badCapital.RequestID = "owner-ceremony-sat-capital-bad-pda"
	badCapital.Accounts = append([]ownerCeremonyAccountV1(nil), badCapital.Accounts...)
	badCapital.Accounts[3].Pubkey = solana.NewWallet().PublicKey().String()
	if _, err := service.normalizeOwnerCeremonyV1(badCapital); err == nil || !strings.Contains(err.Error(), "PDA changed") {
		t.Fatalf("Satcoin capital initialization accepted a changed capital PDA: %v", err)
	}
	rejected := fixture
	rejected.RequestID = "owner-ceremony-simulation-rejected"
	rejectSimulation.Store(true)
	if _, err := service.prepareOwnerCeremonyV1(rejected); err == nil || !strings.Contains(err.Error(), "simulation failed") {
		t.Fatalf("owner ceremony accepted a rejected simulation: %v", err)
	}
	rejectSimulation.Store(false)
	if _, err := store.getOperation(rejected.RequestID); !errors.Is(err, errSignerOperationNotFoundV2) {
		t.Fatalf("rejected simulation persisted a sendable operation: %v", err)
	}

	confirmed, err := service.executeOwnerCeremonyV1(fixture)
	if err != nil || confirmed.State != operationConfirmed || !confirmed.SimulationSigVerify || signedSimulations.Load() != 1 || sends.Load() != 1 {
		t.Fatalf("owner ceremony execution changed: result=%#v err=%v", confirmed, err)
	}
	duplicate, err := service.executeOwnerCeremonyV1(fixture)
	if err != nil || duplicate.State != operationConfirmed || signedSimulations.Load() != 1 || sends.Load() != 1 {
		t.Fatalf("owner ceremony replay fence changed: result=%#v err=%v", duplicate, err)
	}
}
