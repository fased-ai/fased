package main

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
)

func TestVaultMiningBindingRPCRequestV1(t *testing.T) {
	body, _, _ := vaultMiningBindingFixtureV1(t)
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	valid := request{Op: "v2.vaultMining.binding.inspect", WalletID: "executor", Request: raw}
	if err := mustValidate(valid, signerConfig{}); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []request{{Op: valid.Op, Request: raw}, {Op: valid.Op, WalletID: "executor"}, {Op: valid.Op, WalletID: "executor", Request: raw, Chain: "solana"}} {
		if err := mustValidate(invalid, signerConfig{}); err == nil {
			t.Fatal("accepted malformed envelope")
		}
	}
	for _, extra := range []string{`,"rpcUrl":"https://untrusted.invalid"}`, `,"nonce":"secret"}`} {
		var decoded vaultMiningBindingRequestV1
		if err := decodeSignerRequestV2(append(append([]byte(nil), raw[:len(raw)-1]...), []byte(extra)...), &decoded); err == nil {
			t.Fatal("accepted caller-controlled extra field")
		}
	}
}

func vaultMiningBindingFixtureV1(t *testing.T) (vaultMiningBindingRequestV1, solana.PublicKey, signerOwnedAccountSnapshotV2) {
	t.Helper()
	profile, mining, executor, keeper := solana.NewWallet().PublicKey(), solana.NewWallet().PublicKey(), solana.NewWallet().PublicKey(), solana.NewWallet().PublicKey()
	request := vaultMiningBindingRequestV1{Cluster: "devnet", Profile: profile.String(), PermanentMining: mining.String(), MinFinalizedSlot: 100}
	addresses, authority, err := vaultMiningBindingAddressesV1(request)
	if err != nil {
		t.Fatal(err)
	}
	sat := solana.MustPublicKeyFromBase58(satcoinOwnerInstructionContractsV1["sat_init_agent_record"].ProgramID)
	capital := solana.MustPublicKeyFromBase58(agentCapitalProgramIDV1)
	b, r, f := make([]byte, 492), make([]byte, 1032), make([]byte, 136)
	disc := sha256.Sum256([]byte("account:AgentCapitalVaultBinding"))
	copy(b, disc[:8])
	b[8] = 1
	r[0], r[8], r[9], r[12], r[14] = 141, 1, 1, 2, 2
	f[0], f[8] = 138, 2
	put := func(data []byte, offset int, key solana.PublicKey) { copy(data[offset:offset+32], key[:]) }
	for offset, key := range map[int]solana.PublicKey{20: profile, 84: addresses[1], 116: sat, 148: mining, 276: authority, 308: addresses[2], 340: authority, 372: profile} {
		put(b, offset, key)
	}
	for offset, key := range map[int]solana.PublicKey{24: mining, 120: authority, 152: authority, 184: executor, 216: keeper, 912: capital, 944: authority, 976: profile} {
		put(r, offset, key)
	}
	put(f, 16, authority)
	put(f, 96, mining)
	for i, generation := range []uint16{1, 3, 3, 3, 3, 2, 2, 2} {
		binary.LittleEndian.PutUint16(r[348+i*2:], generation)
	}
	for _, field := range []struct {
		data   []byte
		offset int
	}{{b, 12}, {b, 468}, {r, 16}, {r, 1008}} {
		binary.LittleEndian.PutUint64(field.data[field.offset:], 1)
	}
	binary.LittleEndian.PutUint64(f[48:], 2_000_000_000)
	binary.LittleEndian.PutUint64(f[64:], 1_000_000_000)
	accounts := []*rpc.Account{}
	for i, data := range [][]byte{b, r, f} {
		owner := sat
		if i == 0 {
			owner = capital
		}
		accounts = append(accounts, &rpc.Account{Owner: owner, Data: rpc.DataBytesOrJSONFromBytes(data)})
	}
	return request, executor, signerOwnedAccountSnapshotV2{Slot: 101, Addresses: addresses, Accounts: accounts}
}

func TestVaultMiningBindingRejectsDriftV1(t *testing.T) {
	request, executor, snapshot := vaultMiningBindingFixtureV1(t)
	result, err := resolveVaultMiningBindingV1(request, executor, snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if result.Verification != "account-bindings-only" || result.FinalizedSlot != 101 || result.StateDigest == "" || result.FundedLamports != "2000000000" || result.ActiveCommitLamports != "1000000000" || result.EntryPaused {
		t.Fatalf("unexpected readback: %+v", result)
	}
	// Pausing entry must remain inspectable for recovery; it is not authority
	// to enter. Recompute the digest rather than trusting caller metadata.
	snapshot.Digest = "caller-supplied-digest"
	paused := snapshot.Accounts[1].Data.GetBinary()
	paused[11] = 1
	snapshot.Accounts[1].Data = rpc.DataBytesOrJSONFromBytes(paused)
	pausedResult, err := resolveVaultMiningBindingV1(request, executor, snapshot)
	if err != nil || !pausedResult.EntryPaused || pausedResult.StateDigest == result.StateDigest || pausedResult.StateDigest == snapshot.Digest {
		t.Fatalf("paused readback/digest mismatch: %+v, %v", pausedResult, err)
	}
	cases := map[string]func(*vaultMiningBindingRequestV1, *solana.PublicKey, *signerOwnedAccountSnapshotV2){
		"wrong network": func(r *vaultMiningBindingRequestV1, _ *solana.PublicKey, _ *signerOwnedAccountSnapshotV2) {
			r.Cluster = "mainnet-beta"
		},
		"wrong executor": func(_ *vaultMiningBindingRequestV1, k *solana.PublicKey, _ *signerOwnedAccountSnapshotV2) {
			*k = solana.NewWallet().PublicKey()
		},
		"stale": func(_ *vaultMiningBindingRequestV1, _ *solana.PublicKey, s *signerOwnedAccountSnapshotV2) {
			s.Slot = 99
		},
		"missing": func(_ *vaultMiningBindingRequestV1, _ *solana.PublicKey, s *signerOwnedAccountSnapshotV2) {
			s.Accounts[1] = nil
		},
		"wrong order": func(_ *vaultMiningBindingRequestV1, _ *solana.PublicKey, s *signerOwnedAccountSnapshotV2) {
			s.Addresses[0], s.Addresses[1] = s.Addresses[1], s.Addresses[0]
		},
		"wrong owner": func(_ *vaultMiningBindingRequestV1, _ *solana.PublicKey, s *signerOwnedAccountSnapshotV2) {
			s.Accounts[0].Owner = executor
		},
		"executable": func(_ *vaultMiningBindingRequestV1, _ *solana.PublicKey, s *signerOwnedAccountSnapshotV2) {
			s.Accounts[2].Executable = true
		},
		"short layout": func(_ *vaultMiningBindingRequestV1, _ *solana.PublicKey, s *signerOwnedAccountSnapshotV2) {
			s.Accounts[1].Data = rpc.DataBytesOrJSONFromBytes([]byte{141})
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			r, k, s := vaultMiningBindingFixtureV1(t)
			mutate(&r, &k, &s)
			if _, err := resolveVaultMiningBindingV1(r, k, s); err == nil {
				t.Fatal("accepted invalid binding")
			}
		})
	}
	for _, field := range []struct {
		name            string
		account, offset int
	}{{"discriminator", 0, 0}, {"binding status", 0, 9}, {"binding generation", 0, 12}, {"authority", 0, 276}, {"destination", 0, 340}, {"allowlist generation", 0, 468}, {"component generation", 1, 350}, {"keeper", 1, 216}, {"capital identity", 2, 96}} {
		t.Run(field.name, func(t *testing.T) {
			r, k, s := vaultMiningBindingFixtureV1(t)
			data := s.Accounts[field.account].Data.GetBinary()
			if field.name == "keeper" {
				clear(data[216:248])
			} else {
				data[field.offset] ^= 1
			}
			s.Accounts[field.account].Data = rpc.DataBytesOrJSONFromBytes(data)
			if _, err := resolveVaultMiningBindingV1(r, k, s); err == nil {
				t.Fatal("accepted drift")
			}
		})
	}
}
