package main

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"testing"
)

func claimHistoryFixture(t *testing.T, mining bool, owners ...solana.PublicKey) (signerWENBTCClaimIntentV1, wenBTCClaimHistoryV1) {
	t.Helper()
	v := btcClaimIntentFixture()
	v.MinFinalizedSlot = "100"
	v.ExpiresSlot = "200"
	if mining {
		v.Source = "mining"
		x := "17"
		v.Offer = &x
	}
	program := solana.MustPublicKeyFromBase58(v.ProgramID)
	saleKey, _, err := solana.FindProgramAddress([][]byte{[]byte("wen-genesis-v1"), make([]byte, 32), make([]byte, 32)}, program)
	if err != nil {
		t.Fatal(err)
	}
	v.Sale = saleKey.String()
	owner, policy, usdc := solana.PublicKey{5}, solana.PublicKey{6}, solana.PublicKey{7}
	if len(owners) > 0 {
		owner = owners[0]
	}
	ix, e := buildWENBTCClaimInstructionV1(v, owner)
	if e != nil {
		t.Fatal(e)
	}
	p := ix.ProgramID()
	sale := solana.MustPublicKeyFromBase58(v.Sale)
	le := func(n uint64) []byte { b := make([]byte, 8); binary.LittleEndian.PutUint64(b, n); return b }
	derive := func(seed string, parts ...[]byte) (solana.PublicKey, byte) {
		k, b, e := solana.FindProgramAddress(append([][]byte{[]byte(seed)}, parts...), p)
		if e != nil {
			t.Fatal(e)
		}
		return k, b
	}
	batch, _ := derive("wen-fee-batch-v1", sale[:], le(42))
	if mining {
		prep, _ := derive("wen-mining-preparation-v1", sale[:], le(17))
		offer, _ := derive("wen-mining-offer-v1", sale[:], prep[:])
		progress, _ := derive("wen-mining-progress-v1", sale[:], offer[:])
		batch, _ = derive("wen-mining-income-v1", progress[:])
	}
	funding, fb := derive("wen-btc-funded-v1", batch[:])
	cohort, cb := derive("wen-opening-target-v1", sale[:], []byte{4}, le(42))
	history, hb := derive("wen-stake-history-v1", sale[:], owner[:], le(40))
	settlement, sb := derive("wen-btc-settled-v1", funding[:])
	account := func(k solana.PublicKey, b byte, magic string, size int, state byte) *signerWENBTCAccountV1 {
		d := make([]byte, size)
		copy(d, magic)
		d[8] = 1
		d[10] = state
		d[11] = b
		return &signerWENBTCAccountV1{Address: k, Owner: p, Slot: 150, Data: d}
	}
	s := wenBTCClaimHistoryV1{Slot: 150, Now: 43 * 86400, Funding: account(funding, fb, "WENBTF01", 160, 1), Cohort: account(cohort, cb, "WENBEN01", 168, 4), History: account(history, hb, "WENSTH01", 104, 0), Settlement: account(settlement, sb, "WENBTST1", 208, 0)}
	key := func(a *signerWENBTCAccountV1, o int, k solana.PublicKey) { copy(a.Data[o:], k[:]) }
	put := func(a *signerWENBTCAccountV1, o int, n uint64) { binary.LittleEndian.PutUint64(a.Data[o:], n) }
	key(s.Funding, 16, batch)
	key(s.Funding, 48, cohort)
	key(s.Funding, 80, usdc)
	put(s.Funding, 112, 1000)
	put(s.Funding, 120, s.Now)
	put(s.Funding, 128, s.Now+86400)
	put(s.Funding, 136, 200)
	put(s.Funding, 144, 20)
	key(s.Cohort, 16, sale)
	key(s.Cohort, 48, policy)
	put(s.Cohort, 80, 42)
	put(s.Cohort, 128, 100)
	d := append([]byte("wen-stake-cohort-v1"), sale[:]...)
	d = append(d, policy[:]...)
	d = append(d, le(42)...)
	d = append(d, le(100)...)
	hash := sha256.Sum256(d)
	copy(s.Cohort.Data[136:], hash[:])
	key(s.History, 16, sale)
	key(s.History, 48, owner)
	put(s.History, 80, 40)
	put(s.History, 88, 43)
	put(s.History, 96, 25)
	key(s.Settlement, 16, funding)
	key(s.Settlement, 48, cohort)
	key(s.Settlement, 80, solana.MustPublicKeyFromBase58(v.Mint))
	put(s.Settlement, 112, 800)
	put(s.Settlement, 120, 800)
	put(s.Settlement, 128, 80)
	put(s.Settlement, 136, 200)
	put(s.Settlement, 144, 20)
	put(s.Settlement, 160, s.Now)
	return v, s
}
func TestWENBTCClaimHistory(t *testing.T) {
	for _, mining := range []bool{false, true} {
		for _, mode := range []string{"ok", "minimum", "paid", "fallback", "open-day", "slot", "owner", "short", "bump", "hash", "history-start", "history-end", "zero-weight", "funding-time", "cash", "remaining", "claimed", "future-conversion", "reserved", "wide-product", "rounding", "dust"} {
			t.Run(map[bool]string{false: "fee", true: "mining"}[mining]+"/"+mode, func(t *testing.T) {
				v, s := claimHistoryFixture(t, mining)
				put := func(a *signerWENBTCAccountV1, o int, n uint64) { binary.LittleEndian.PutUint64(a.Data[o:], n) }
				want := uint64(250)
				switch mode {
				case "minimum":
					v.MinimumReceived = "251"
				case "paid":
					s.Paid = s.Funding
				case "fallback":
					s.Fallback = s.Funding
				case "open-day":
					s.Now = 42 * 86400
				case "slot":
					s.History.Slot--
				case "owner":
					s.Funding.Owner = solana.PublicKey{9}
				case "short":
					s.Funding.Data = s.Funding.Data[:8]
				case "bump":
					s.History.Data[11] ^= 1
				case "hash":
					s.Cohort.Data[136] ^= 1
				case "history-start":
					put(s.History, 80, 41)
				case "history-end":
					put(s.History, 88, 42)
				case "zero-weight":
					put(s.History, 96, 0)
				case "funding-time":
					put(s.Funding, 120, s.Now+1)
				case "cash":
					put(s.Settlement, 112, 801)
				case "remaining":
					put(s.Settlement, 128, 81)
				case "claimed":
					put(s.Settlement, 152, 551)
				case "future-conversion":
					put(s.Settlement, 160, s.Now+1)
				case "reserved":
					s.Settlement.Data[200] = 1
				case "wide-product":
					put(s.Settlement, 120, ^uint64(0))
					want = 5764607523034234879
				case "rounding":
					put(s.Settlement, 120, 803)
					want = 250
				case "dust":
					put(s.Settlement, 120, 1)
				}
				out, e := validateWENBTCClaimHistoryV1(v, solana.PublicKey{5}, solana.PublicKey{6}, solana.PublicKey{7}, s)
				good := mode == "ok" || mode == "wide-product" || mode == "rounding"
				if (e == nil) != good {
					t.Fatalf("unexpected admission: %v", e)
				}
				if good && out.Amount != want {
					t.Fatalf("amount %d want %d", out.Amount, want)
				}
			})
		}
	}
}
func TestWENBTCClaimHistoryRPC(t *testing.T) {
	for _, mode := range []string{"ok", "genesis", "genesis-change", "stale", "reference-behind", "reference-expired", "rpc-error", "nil-page", "reference-error", "code", "clock", "missing", "paid", "pin", "expired", "missing-vault", "frozen-vault", "wrong-destination", "wrong-decimals", "inactive-sale", "missing-activation", "activation-supply"} {
		t.Run(mode, func(t *testing.T) {
			v, s := claimHistoryFixture(t, true)
			p := solana.MustPublicKeyFromBase58(v.ProgramID)
			pd, _, _ := solana.FindProgramAddress([][]byte{p[:]}, solana.BPFLoaderUpgradeableProgramID)
			code := []byte{9, 8, 7}
			program := make([]byte, 36)
			binary.LittleEndian.PutUint32(program, 2)
			copy(program[4:], pd[:])
			data := make([]byte, 48)
			binary.LittleEndian.PutUint32(data, 3)
			binary.LittleEndian.PutUint64(data[4:], 1)
			copy(data[45:], code)
			clock := make([]byte, 40)
			binary.LittleEndian.PutUint64(clock, 150)
			binary.LittleEndian.PutUint64(clock[32:], s.Now)
			pins := wenStakingPinsV1{ProgramID: v.ProgramID, Genesis: v.Genesis, DescriptorSHA256: v.DescriptorSHA256, CapabilitySHA256: v.CapabilitySHA256, DeploymentSlot: 1, CodeSHA256: wenHashV1(code)}
			ix, _ := buildWENBTCClaimInstructionV1(v, solana.PublicKey{5})
			keys := []solana.PublicKey{}
			for _, i := range []int{3, 4, 5, 6, 7, 8} {
				keys = append(keys, ix.Accounts()[i].PublicKey)
			}
			keys = append(keys, p, pd, solana.SysVarClockPubkey)
			for _, i := range []int{12, 9, 10, 14, 1, 2} {
				keys = append(keys, ix.Accounts()[i].PublicKey)
			}
			account := func(owner solana.PublicKey, d []byte, ex bool) *rpc.Account {
				return &rpc.Account{Owner: owner, Data: rpc.DataBytesOrJSONFromBytes(d), Executable: ex}
			}
			values := []*rpc.Account{}
			for _, a := range []*signerWENBTCAccountV1{s.Funding, s.Cohort, s.History, s.Settlement} {
				values = append(values, account(a.Owner, a.Data, false))
			}
			values = append(values, nil, nil, account(solana.BPFLoaderUpgradeableProgramID, program, true), account(solana.BPFLoaderUpgradeableProgramID, data, false), account(solana.MustPublicKeyFromBase58("Sysvar1111111111111111111111111111111111111"), clock, false))
			mint, vault, destination, token := claimCustodyFixture(t, v)
			for _, a := range []*signerWENBTCAccountV1{mint, vault, destination, token} {
				values = append(values, account(a.Owner, a.Data, a.Executable))
			}
			saleAccount, activation := claimActivationFixture(t, v)
			for _, a := range []*signerWENBTCAccountV1{saleAccount, activation} {
				values = append(values, account(a.Owner, a.Data, false))
			}
			f := wenReadRPCFake{t: t, genesis: solana.Hash{1}, addresses: keys, page: &rpc.GetMultipleAccountsResult{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: 150}}, Value: values}, change: mode}
			switch mode {
			case "code":
				data[45] ^= 1
			case "clock":
				clock[0] ^= 1
			case "missing":
				values[0] = nil
			case "paid":
				values[5] = values[0]
			case "pin":
				pins.DescriptorSHA256 = "wrong"
			case "missing-vault":
				values[10] = nil
			case "frozen-vault":
				vault.Data[108] = 2
			case "wrong-destination":
				destination.Data[32] ^= 1
			case "wrong-decimals":
				mint.Data[44] = 9
			case "inactive-sale":
				saleAccount.Data[10] = 2
			case "missing-activation":
				values[14] = nil
			case "activation-supply":
				activation.Data[88] ^= 1
			case "expired":
				f.page.Context.Slot = 200
			}
			out, e := readWENBTCClaimHistoryRPCV1(context.Background(), &f, pins, v, solana.PublicKey{5}, solana.PublicKey{6}, solana.PublicKey{7}, 2)
			if (e == nil) != (mode == "ok") {
				t.Fatalf("unexpected RPC admission: %v", e)
			}
			if e == nil && out.Amount != 250 {
				t.Fatal(out)
			}
		})
	}
}

// Every linked account must be independently bound, not merely well formed.
func TestWENBTCClaimHistoryAccountBindings(t *testing.T) {
	for index := 0; index < 4; index++ {
		for _, field := range []string{"address", "owner", "executable", "slot", "version", "reserved", "state", "bump", "link16", "link48"} {
			t.Run(fmt.Sprintf("account-%d/%s", index, field), func(t *testing.T) {
				v, s := claimHistoryFixture(t, false)
				a := []*signerWENBTCAccountV1{s.Funding, s.Cohort, s.History, s.Settlement}[index]
				switch field {
				case "address":
					a.Address[0] ^= 1
				case "owner":
					a.Owner[0] ^= 1
				case "executable":
					a.Executable = true
				case "slot":
					a.Slot--
				case "version":
					a.Data[8]++
				case "reserved":
					a.Data[12] = 1
				case "state":
					a.Data[10]++
				case "bump":
					a.Data[11] ^= 1
				case "link16":
					a.Data[16] ^= 1
				case "link48":
					a.Data[48] ^= 1
				}
				if _, e := validateWENBTCClaimHistoryV1(v, solana.PublicKey{5}, solana.PublicKey{6}, solana.PublicKey{7}, s); e == nil {
					t.Fatal("accepted mismatched account")
				}
			})
		}
	}
}
