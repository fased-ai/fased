package main

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"strconv"
	"testing"
)

func checkDirectStakeOutcome(t *testing.T, base *wenReadRPCFake, pins wenStakingPinsV1, v signerWENStakingIntentV1, q wenCampaignClaimRequestV1, w solana.PublicKey, key ed25519.PrivateKey) {
	v.MinFinalizedSlot = "140"
	v.ExpiresSlot = "172"
	v.MaxFeeLamports = "5000"
	f := &directStakePrepareFake{campaignPrepareFake: &campaignPrepareFake{campaignReadFake: &campaignReadFake{wenReadRPCFake: base}, next: 149}}
	p, e := prepareWENCampaignClaimStakeV1(context.Background(), f, pins, v, q, w, 970, 32, 6000, nil)
	if e != nil {
		t.Fatal(e)
	}
	a, e := newWENCampaignClaimStakeReviewV1("direct-outcome-001", "miner", "sha256:"+wenHashV1([]byte("policy")), pins, v, q, w, 970, 6000, p)
	if e != nil {
		t.Fatal(e)
	}
	digest, _ := a.digest()
	for _, failed := range []bool{false, true} {
		result, sig, index := directStakeOutcomeFixture(t, a, key, failed)
		m := result.Meta
		s := a.Snapshot.Claim
		debit := a.Fee
		if !failed {
			debit += a.Rent
		}

		checkDirectStakeExecution(t, base, a, key, result)
		got, hash, e := wenCampaignClaimStakeOutcomeV1(a, digest, sig.String(), result)
		if e != nil || got != debit || hash == "" {
			t.Fatal("outcome", got, e)
		}
		for name, mutate := range map[string]func(*rpc.GetTransactionResult){
			"fee":              func(r *rpc.GetTransactionResult) { r.Meta.Fee++ },
			"owner-debit":      func(r *rpc.GetTransactionResult) { r.Meta.PostBalances[index(w)]-- },
			"unrelated-credit": func(r *rpc.GetTransactionResult) { r.Meta.PostBalances[index(s.Position.Address)]++ },
			"stale":            func(r *rpc.GetTransactionResult) { r.Slot = 1 },
			"net":              func(r *rpc.GetTransactionResult) { r.Meta.PostTokenBalances[0].UiTokenAmount.Amount = "999" },
			"missing-balances": func(r *rpc.GetTransactionResult) { r.Meta.PostBalances = nil },
		} {
			t.Run("outcome-"+name, func(t *testing.T) {
				raw, _ := json.Marshal(m)
				var copy rpc.TransactionMeta
				_ = json.Unmarshal(raw, &copy)
				bad := *result
				bad.Meta = &copy
				mutate(&bad)
				if _, _, e = wenCampaignClaimStakeOutcomeV1(a, digest, sig.String(), &bad); e == nil {
					t.Fatal("bad receipt accepted")
				}
			})
		}
		if _, _, e = wenCampaignClaimStakeOutcomeV1(a, wenHashV1([]byte("wrong")), sig.String(), result); e == nil {
			t.Fatal("wrong approval digest")
		}
		wrong := sig
		wrong[0] ^= 1
		if _, _, e = wenCampaignClaimStakeOutcomeV1(a, digest, wrong.String(), result); e == nil {
			t.Fatal("wrong signature")
		}
	}
}

func directStakeOutcomeFixture(t *testing.T, a wenCampaignClaimStakeReviewV1, key ed25519.PrivateKey, failed bool) (*rpc.GetTransactionResult, solana.Signature, func(solana.PublicKey) int) {
	var sig solana.Signature
	copy(sig[:], ed25519.Sign(key, a.Message))
	wire := make([]byte, 65+len(a.Message))
	wire[0] = 1
	copy(wire[1:65], sig[:])
	copy(wire[65:], a.Message)
	tx, e := solana.TransactionFromBytes(wire)
	if e != nil {
		t.Fatal(e)
	}
	envelope := &rpc.TransactionResultEnvelope{}
	raw, _ := json.Marshal([]string{base64.StdEncoding.EncodeToString(wire), "base64"})
	_ = json.Unmarshal(raw, envelope)
	stake, _ := buildWENStakingInstructionV1(a.Intent, solana.MustPublicKeyFromBase58(a.WalletPublicKey))
	metas := stake.Accounts()
	h := a.Snapshot.History
	alloc := map[solana.PublicKey]bool{}
	if h.Position == nil {
		alloc[metas[4].PublicKey] = true
	}
	if h.NextHistory == nil {
		alloc[metas[6].PublicKey] = true
	}
	if h.NextPoint == nil {
		alloc[metas[14].PublicKey] = true
	}
	index := func(k solana.PublicKey) int {
		for i, x := range tx.Message.AccountKeys {
			if k == x {
				return i
			}
		}
		t.Fatal("missing account")
		return 0
	}
	s := a.Snapshot.Claim
	row := func(k, owner solana.PublicKey, n uint64) rpc.TokenBalance {
		program := solana.Token2022ProgramID
		return rpc.TokenBalance{AccountIndex: uint16(index(k)), Owner: &owner, ProgramId: &program, Mint: s.Mint.Address, UiTokenAmount: &rpc.UiTokenAmount{Amount: strconv.FormatUint(n, 10), Decimals: 11}}
	}
	m := &rpc.TransactionMeta{Fee: 5000, PreBalances: make([]uint64, len(tx.Message.AccountKeys)), PostBalances: make([]uint64, len(tx.Message.AccountKeys))}
	debit := uint64(5000)
	dest, vault := uint64(1070), uint64(0)
	if failed {
		m.Err = "failed"
		dest = 100
		vault = 1000
	} else {
		debit += a.Rent
		for k := range alloc {
			m.PostBalances[index(k)] = 100
		}
	}
	m.PreBalances[index(solana.MustPublicKeyFromBase58(a.WalletPublicKey))] = 10000
	m.PostBalances[index(solana.MustPublicKeyFromBase58(a.WalletPublicKey))] = 10000 - debit
	m.PreTokenBalances = []rpc.TokenBalance{row(s.Destination.Address, h.Pool.Address, 100), row(s.Windows[0].Vault.Address, s.Windows[0].Window.Address, 1000)}
	m.PostTokenBalances = []rpc.TokenBalance{row(s.Destination.Address, h.Pool.Address, dest), row(s.Windows[0].Vault.Address, s.Windows[0].Window.Address, vault)}
	result := &rpc.GetTransactionResult{Slot: 170, Meta: m, Transaction: envelope}
	return result, sig, index
}
