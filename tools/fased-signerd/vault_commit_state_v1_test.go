package main

import (
	"crypto/sha256"
	"encoding/binary"
	"path/filepath"
	"strconv"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
)

func TestVaultCommitPreparationV1(t *testing.T) {
	dir := t.TempDir()
	store, err := openSignerStoreV2(filepath.Join(dir, "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.db.Close()
	keys, err := openSignerKeyManagerV2(store, filepath.Join(dir, "master.key"))
	if err != nil {
		t.Fatal(err)
	}
	wallet, _, err := keys.CreateWithRoleBaseline("executor", 0, signerRoleBaselineRequestV1{Version: 1, Role: "agent"}, signerRoleBaselineRuntimeV1{})
	if err != nil {
		t.Fatal(err)
	}
	r, _, s := vaultCommitStateFixtureV1(t)
	k := solana.MustPublicKeyFromBase58(wallet.PublicKey)
	record := s.Accounts[1].Data.GetBinary()
	copy(record[184:216], k[:])
	s.Accounts[1].Data = rpc.DataBytesOrJSONFromBytes(record)
	scope, err := validateVaultCommitStateV1(r, k, s, 1_000_000_000)
	if err != nil {
		t.Fatal(err)
	}
	request := signerSATCommitmentAllocateRequestV1{Cluster: "devnet", ProgramID: satcoinOwnerInstructionContractsV1["sat_init_agent_record"].ProgramID, ProtocolGeneration: "2", CycleID: "43", CommittedLamports: "1000000000", AllocationFP: make([]uint32, 16)}
	for i := range request.AllocationFP {
		request.AllocationFP[i] = 62500
	}
	allocated, err := keys.allocateVaultCommitmentV1(wallet.WalletID, scope, request)
	if err != nil {
		t.Fatal(err)
	}
	cycleReserve := vaultCycleReserveForScopeV1(t, scope)
	tx, err := keys.prepareVaultCommitTransactionV1(wallet.WalletID, r, s, request, 5_000_000, solana.Hash{1}, cycleReserve, 1_000_000, 7)
	if err != nil {
		t.Fatal(err)
	}
	if len(tx.Signatures) != 1 || !tx.Signatures[0].IsZero() || tx.Message.AccountKeys[0] != k {
		t.Fatal("preparation signed or changed payer")
	}
	// Exercise the full native review pipeline with synthetic executable pins.
	_, vaultBump, _ := solana.FindProgramAddress([][]byte{[]byte("agent-mining-vault"), scope.Binding[:]}, solana.MustPublicKeyFromBase58(agentCapitalProgramIDV1))
	s.Accounts[3].Data.GetBinary()[10] = vaultBump
	semantic := signerIntentV2{Type: intentSolanaVaultMining, Cluster: "devnet", Action: "commit_vault_cycle", VaultMining: &signerVaultMiningIntentV1{
		Profile: r.Profile, PermanentMining: r.PermanentMining, Reference: allocated.Reference, CycleID: "43", CommittedLamports: "1000000000", AuthorityGeneration: strconv.FormatUint(scope.AuthorityGeneration, 10), BindingGeneration: strconv.FormatUint(scope.BindingGeneration, 10), ActivationGeneration: "7", MaxRentLamports: "5000000", MaxFeeLamports: "5000", MinFinalizedSlot: "101",
	}}
	intent, err := normalizeSignerIntentForWalletV2(semantic, &k)
	if err != nil {
		t.Fatal(err)
	}
	addresses, err := vaultReviewAddressesV1(intent)
	if err != nil {
		t.Fatal(err)
	}
	full := signerOwnedAccountSnapshotV2{Slot: 101, Addresses: addresses, Accounts: append([]*rpc.Account{}, s.Accounts...)}
	full.Accounts = append(full.Accounts, cycleReserve.Accounts[0], nil, nil, cycleReserve.Accounts[1], cycleReserve.Accounts[2])
	pins := make([]vaultProgramPinV1, 0, 2)
	for _, program := range []solana.PublicKey{addresses[9], addresses[11]} {
		pin, snapshot := vaultProgramFixtureV1(t)
		pin.Program = program
		pda, _, _ := solana.FindProgramAddress([][]byte{program[:]}, snapshot.Accounts[0].Owner)
		copy(snapshot.Accounts[0].Data.GetBinary()[4:36], pda[:])
		pins = append(pins, pin)
		full.Accounts = append(full.Accounts, snapshot.Accounts...)
	}
	release := vaultReleaseContextV1{Cluster: "devnet", Genesis: solanaDevnetGenesisHashV2, Capital: pins[0], Satcoin: pins[1]}
	reviewTx, _, err := keys.prepareVaultReviewStateV1(wallet.WalletID, intent, full, release, 1_000_000, solana.Hash{1})
	if err != nil {
		t.Fatal(err)
	}
	expectedRaw, _ := tx.MarshalBinary()
	reviewRaw, _ := reviewTx.MarshalBinary()
	if err := validateVaultTransactionBytesV1(tx, reviewRaw); err != nil {
		t.Fatal(err)
	}
	zeroBytes(expectedRaw)
	zeroBytes(reviewRaw)
	full.Accounts[10].Data.GetBinary()[49] ^= 1
	if _, _, err := keys.prepareVaultReviewStateV1(wallet.WalletID, intent, full, release, 1_000_000, solana.Hash{1}); err == nil {
		t.Fatal("review accepted altered executable")
	}
	full.Accounts[10].Data.GetBinary()[49] ^= 1
	semantic.VaultMining.CommittedLamports = "2000000000"
	changed, _ := normalizeSignerIntentForWalletV2(semantic, &k)
	if _, _, err := keys.prepareVaultReviewStateV1(wallet.WalletID, changed, full, release, 1_000_000, solana.Hash{1}); err == nil {
		t.Fatal("review accepted changed committed capital")
	}
	protocol := cycleReserve.Accounts[2].Data.GetBinary()
	binary.LittleEndian.PutUint64(protocol[112:], 8)
	cycleReserve.Accounts[2].Data = rpc.DataBytesOrJSONFromBytes(protocol)
	if _, err := keys.prepareVaultCommitTransactionV1(wallet.WalletID, r, s, request, 5_000_000, solana.Hash{1}, cycleReserve, 1_000_000, 7); err == nil {
		t.Fatal("prepared with stale activation")
	}
	binary.LittleEndian.PutUint64(protocol[112:], 7)
	cycleReserve.Accounts[2].Data = rpc.DataBytesOrJSONFromBytes(protocol)
	// A queued exit appearing after allocation must prevent preparation.
	vault := s.Accounts[3].Data.GetBinary()
	binary.LittleEndian.PutUint32(vault[279:283], 1)
	s.Accounts[3].Data = rpc.DataBytesOrJSONFromBytes(vault)
	if _, err := keys.prepareVaultCommitTransactionV1(wallet.WalletID, r, s, request, 5_000_000, solana.Hash{1}, cycleReserve, 1_000_000, 7); err == nil {
		t.Fatal("prepared after queued exit")
	}
	// Recovery uses the same encrypted material, even with entry paused and exits queued.
	s.Slot = 250
	record[11] = 1
	vault[9] = 2
	_, bump, err := solana.FindProgramAddress([][]byte{[]byte("agent-mining-vault"), scope.Binding[:]}, solana.MustPublicKeyFromBase58(agentCapitalProgramIDV1))
	if err != nil {
		t.Fatal(err)
	}
	vault[10] = bump
	s.Accounts[1].Data = rpc.DataBytesOrJSONFromBytes(record)
	s.Accounts[3].Data = rpc.DataBytesOrJSONFromBytes(vault)
	reveal := vaultCycleReserveForScopeV1(t, scope)
	reveal.Slot = 250
	binary.LittleEndian.PutUint64(reveal.Accounts[0].Data.GetBinary()[360:368], 300)
	sat := reveal.Accounts[0].Owner
	id := []byte{43, 0, 0, 0, 0, 0, 0, 0}
	reveal.Addresses[1], _, err = solana.FindProgramAddress([][]byte{[]byte("sat_miner_cycle_state_v2"), scope.Authority[:], id}, sat)
	if err != nil {
		t.Fatal(err)
	}
	reveal.Addresses[2], _, err = solana.FindProgramAddress([][]byte{[]byte("sat_cycle_registry_meta"), id}, sat)
	if err != nil {
		t.Fatal(err)
	}
	data, err := keys.vaultCommitmentInstructionDataV1(wallet.WalletID, scope, request, "commit_vault_cycle", 0)
	if err != nil {
		t.Fatal(err)
	}
	defer zeroBytes(data)
	miner := make([]byte, 416)
	miner[0] = 150
	miner[136] = 43
	copy(miner[72:104], scope.Authority[:])
	copy(miner[104:136], scope.PermanentMining[:])
	binary.LittleEndian.PutUint64(miner[144:152], 1_000_000_000)
	copy(miner[240:272], data[24:56])
	copy(miner[328:348], reveal.Accounts[0].Data.GetBinary()[384:404])
	reveal.Accounts[1] = &rpc.Account{Owner: sat, Data: rpc.DataBytesOrJSONFromBytes(miner)}
	reveal.Accounts[2] = nil
	tx, err = keys.prepareVaultRevealTransactionV1(wallet.WalletID, r, s, request, reveal, solana.Hash{1})
	if err != nil {
		t.Fatal(err)
	}
	if len(tx.Signatures) != 1 || !tx.Signatures[0].IsZero() || tx.Message.AccountKeys[0] != k {
		t.Fatal("reveal signed or changed payer")
	}
	for _, offset := range []int{16, 184} {
		record[offset] ^= 1
		if _, err := keys.prepareVaultRevealTransactionV1(wallet.WalletID, r, s, request, reveal, solana.Hash{1}); err == nil {
			t.Fatalf("accepted authority change at %d", offset)
		}
		record[offset] ^= 1
	}
	miner[240] ^= 1
	if _, err := keys.prepareVaultRevealTransactionV1(wallet.WalletID, r, s, request, reveal, solana.Hash{1}); err == nil {
		t.Fatal("accepted mismatched stored commitment")
	}
	miner[240] ^= 1
	reveal.Slot++
	if _, err := keys.prepareVaultRevealTransactionV1(wallet.WalletID, r, s, request, reveal, solana.Hash{1}); err == nil {
		t.Fatal("accepted mixed snapshot context")
	}
	reveal.Slot--
	// Close and reopen durable state: recovery uses only the reference, not a
	// caller-provided allocation or nonce, and reproduces the exact transaction.
	if err := store.db.Close(); err != nil {
		t.Fatal(err)
	}
	store, err = openSignerStoreV2(filepath.Join(dir, "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.db.Close()
	keys, err = openSignerKeyManagerV2(store, filepath.Join(dir, "master.key"))
	if err != nil {
		t.Fatal(err)
	}
	commitment := signerSATCommitmentBindingRequestV1{Cluster: request.Cluster, ProgramID: request.ProgramID, ProtocolGeneration: request.ProtocolGeneration, CycleID: request.CycleID}
	recovered, err := keys.prepareVaultRevealReferenceV1(wallet.WalletID, r, s, commitment, allocated.Reference, reveal, solana.Hash{1})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := recovered.MarshalBinary()
	if err != nil {
		t.Fatal(err)
	}
	defer zeroBytes(raw)
	if err := validateVaultTransactionBytesV1(tx, raw); err != nil {
		t.Fatal("restored reveal differs from original")
	}
	artifact, err := vaultRevealReviewArtifactV1(vaultReviewReferenceV1{Scope: scope, Commitment: commitment, Reference: allocated.Reference, Blockhash: solana.Hash{1}.String()}, tx, "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 250)
	if err != nil {
		t.Fatal(err)
	}
	if err := validateVaultReviewedReconstructionV1(artifact, recovered); err != nil {
		t.Fatal(err)
	}
	recovered.Message.RecentBlockhash = solana.Hash{2}
	if err := validateVaultReviewedReconstructionV1(artifact, recovered); err == nil {
		t.Fatal("accepted new blockhash without new review")
	}
	recovered.Message.RecentBlockhash = solana.Hash{1}
	recovered.Message.Instructions[0].Data[0] ^= 1
	if err := validateVaultReviewedReconstructionV1(artifact, recovered); err == nil {
		t.Fatal("accepted changed reviewed instruction")
	}
	if _, err := keys.prepareVaultRevealReferenceV1(wallet.WalletID, r, s, commitment, "wrong-reference", reveal, solana.Hash{1}); err == nil {
		t.Fatal("accepted substituted recovery reference")
	}
	miner[232] = 1
	if _, err := keys.prepareVaultRevealReferenceV1(wallet.WalletID, r, s, commitment, allocated.Reference, reveal, solana.Hash{1}); err == nil {
		t.Fatal("prepared already revealed cycle after restart")
	}
}

func vaultCommitStateFixtureV1(t *testing.T) (vaultMiningBindingRequestV1, solana.PublicKey, signerOwnedAccountSnapshotV2) {
	t.Helper()
	r, k, s := vaultMiningBindingFixtureV1(t)
	b, err := resolveVaultMiningBindingV1(r, k, s)
	if err != nil {
		t.Fatal(err)
	}
	program := solana.MustPublicKeyFromBase58(agentCapitalProgramIDV1)
	address, _, err := solana.FindProgramAddress([][]byte{[]byte("agent-mining-vault"), b.Scope.Binding[:]}, program)
	if err != nil {
		t.Fatal(err)
	}
	data := make([]byte, 511)
	disc := sha256.Sum256([]byte("account:AgentMiningVault"))
	copy(data, disc[:8])
	data[8] = 1
	data[9] = 1
	for offset, key := range map[int]solana.PublicKey{43: b.Scope.Binding, 75: b.Scope.Profile, 107: b.Scope.Authority, 139: s.Addresses[2]} {
		copy(data[offset:offset+32], key[:])
	}
	s.Accounts[2].Lamports = 2_000_000_000
	s.Addresses = append(s.Addresses, address)
	s.Accounts = append(s.Accounts, &rpc.Account{Owner: program, Data: rpc.DataBytesOrJSONFromBytes(data)})
	return r, k, s
}

func TestVaultCommitStateV1(t *testing.T) {
	r, k, s := vaultCommitStateFixtureV1(t)
	if _, err := validateVaultCommitStateV1(r, k, s, 1_000_000_000); err != nil {
		t.Fatal(err)
	}
	for _, funded := range []uint64{1_000_000_000, 1_009_999_999, 1_010_000_000} {
		r, k, s := vaultCommitStateFixtureV1(t)
		d := s.Accounts[2].Data.GetBinary()
		binary.LittleEndian.PutUint64(d[48:], funded)
		s.Accounts[2].Data = rpc.DataBytesOrJSONFromBytes(d)
		_, err := validateVaultCommitStateV1(r, k, s, 1_000_000_000)
		if (err == nil) != (funded == 1_010_000_000) {
			t.Fatalf("wrong collateral boundary for %d: %v", funded, err)
		}
	}
	for _, tc := range []struct {
		name            string
		account, offset int
	}{{"paused", 1, 11}, {"unreconciled receipt", 1, 376}, {"locked", 2, 56}, {"first pending", 2, 72}, {"last pending", 2, 80}, {"debt", 2, 88}, {"inactive", 3, 9}, {"queued exit", 3, 279}, {"binding", 3, 43}, {"profile", 3, 75}, {"authority", 3, 107}, {"capital", 3, 139}} {
		t.Run(tc.name, func(t *testing.T) {
			r, k, s := vaultCommitStateFixtureV1(t)
			d := s.Accounts[tc.account].Data.GetBinary()
			d[tc.offset] ^= 1
			s.Accounts[tc.account].Data = rpc.DataBytesOrJSONFromBytes(d)
			if _, err := validateVaultCommitStateV1(r, k, s, 1_000_000_000); err == nil {
				t.Fatal("accepted invalid entry")
			}
		})
	}
	for _, amount := range []uint64{0, 999_999_999, 1_000_000_001, ^uint64(0)} {
		if _, err := validateVaultCommitStateV1(r, k, s, amount); err == nil {
			t.Fatal("accepted wrong active amount")
		}
	}
	// Overflow must fail even if both requested and active amounts agree.
	f := s.Accounts[2].Data.GetBinary()
	binary.LittleEndian.PutUint64(f[64:], ^uint64(0))
	binary.LittleEndian.PutUint64(f[48:], ^uint64(0))
	s.Accounts[2].Data = rpc.DataBytesOrJSONFromBytes(f)
	s.Accounts[2].Lamports = ^uint64(0)
	if _, err := validateVaultCommitStateV1(r, k, s, ^uint64(0)); err == nil {
		t.Fatal("accepted collateral overflow")
	}
}
