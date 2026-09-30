package main

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"testing"
)

type miningClaimRPCFake struct {
	*wenReadRPCFake
	reference uint64
}

func (f *miningClaimRPCFake) GetSlot(_ context.Context, c rpc.CommitmentType) (uint64, error) {
	if c != rpc.CommitmentFinalized {
		f.t.Fatal("unfinalized reference")
	}
	if f.change == "reference-error" {
		return 0, errors.New("unavailable")
	}
	return f.reference, nil
}
func miningClaimRPCFixture(t *testing.T, op string, owners ...solana.PublicKey) (signerWENMiningClaimIntentV1, solana.PublicKey, wenStakingPinsV1, *miningClaimRPCFake) {
	v := miningClaimIntentFixture()
	v.MinFinalizedSlot = "100"
	v.ExpiresSlot = "132"
	p := solana.MustPublicKeyFromBase58(v.ProgramID)
	policy := solana.PublicKey{6}
	creator := solana.PublicKey{}
	sale, sb, _ := solana.FindProgramAddress([][]byte{[]byte("wen-genesis-v1"), creator[:], policy[:]}, p)
	v.Economy = sale.String()
	owner := solana.PublicKey{5}
	if len(owners) > 0 {
		owner = owners[0]
	}
	v, w, s, c := miningClaimCustodyOwnedFixture(t, op, owner, v)
	ix, _ := buildWENMiningClaimInstructionV1(v, w)
	a := ix.Accounts()
	le := func(n uint64) []byte { b := make([]byte, 8); binary.LittleEndian.PutUint64(b, n); return b }
	derive := func(seed string, parts ...[]byte) (solana.PublicKey, byte) {
		k, b, _ := solana.FindProgramAddress(append([][]byte{[]byte(seed)}, parts...), p)
		return k, b
	}
	makeRecord := func(k solana.PublicKey, magic string, n int, b, state byte) *signerWENBTCAccountV1 {
		d := make([]byte, n)
		copy(d, magic)
		d[8] = 1
		d[10] = state
		d[11] = b
		return &signerWENBTCAccountV1{Address: k, Owner: p, Slot: 101, Data: d}
	}
	prep, _ := derive("wen-mining-preparation-v1", sale[:], le(1))
	_, ob := derive("wen-mining-offer-v1", sale[:], prep[:])
	capacity, _ := derive("wen-capacity-reserved-v1", sale[:], le(1))
	history, _ := derive("wen-mining-history-v1", sale[:])
	fund, _ := derive("wen-mining-lifecycle-fund-v1", sale[:], le(1))
	offer := makeRecord(a[2].PublicKey, "WENMOFR1", 408, ob, 0)
	offer.Data[8] = 2
	for i, k := range []solana.PublicKey{p, sale, policy, prep, capacity, {7}, history, fund} {
		copy(offer.Data[16+i*32:], k[:])
	}
	for i, n := range []uint64{999, 1000, 1, 1, 2000, 2000, 1, 2, 1000, 2000, 1, 1} {
		copy(offer.Data[304+i*8:], le(n))
	}
	preimage := append([]byte("WEN-EXECUTION-PREFUNDED-V1"), a[2].PublicKey[:]...)
	preimage = append(preimage, le(1000)...)
	preimage = append(preimage, fund[:]...)
	digest := sha256.Sum256(preimage)
	copy(offer.Data[272:], digest[:])
	_, eb := derive("wen-mining-entry-v1", a[2].PublicKey[:], w[:], le(2))
	entry := makeRecord(a[5].PublicKey, "WENMEN01", 272, eb, 0)
	capital, _ := derive("wen-mining-capital-v1", sale[:], w[:])
	for i, k := range []solana.PublicKey{p, sale, a[2].PublicKey, w, capital} {
		copy(entry.Data[16+i*32:], k[:])
	}
	for i, n := range []uint64{2, 100, 1000} {
		copy(entry.Data[176+i*8:], le(n))
	}
	binary.LittleEndian.PutUint64(s.Roster.Data[120:], 2000)
	saleRecord := makeRecord(sale, "WENGEN01", 192, sb, 3)
	copy(saleRecord.Data[48:], policy[:])
	for o, n := range map[int]uint64{152: 604800, 160: 604801, 168: 50000000000, 176: 50000000000} {
		copy(saleRecord.Data[o:], le(n))
	}
	activation, ab := derive("wen-activation-v1", sale[:])
	act := makeRecord(activation, "WENACTR1", 160, ab, 1)
	copy(act.Data[16:], sale[:])
	copy(act.Data[128:], policy[:])
	scaled := uint64(50000000000) * 100000
	for o, n := range map[int]uint64{80: 1000, 88: scaled / 2, 120: scaled/2 - scaled/3 - scaled*40/300 - scaled*6/300} {
		copy(act.Data[o:], le(n))
	}
	pd, _, _ := solana.FindProgramAddress([][]byte{p[:]}, solana.BPFLoaderUpgradeableProgramID)
	program := make([]byte, 36)
	binary.LittleEndian.PutUint32(program, 2)
	copy(program[4:], pd[:])
	data := make([]byte, 48)
	binary.LittleEndian.PutUint32(data, 3)
	copy(data[4:], le(1))
	copy(data[45:], []byte{1, 2, 3})
	clock := make([]byte, 40)
	copy(clock, le(101))
	copy(clock[32:], le(1900))
	records := []*signerWENBTCAccountV1{offer, entry, s.Roster, s.Receipt, s.Claim, saleRecord, act, {Address: p, Owner: solana.BPFLoaderUpgradeableProgramID, Data: program, Executable: true}, {Address: pd, Owner: solana.BPFLoaderUpgradeableProgramID, Data: data}, {Address: solana.SysVarClockPubkey, Owner: solana.MustPublicKeyFromBase58("Sysvar1111111111111111111111111111111111111"), Data: clock}}
	if op == "sol" {
		records = append(records, c.Rent)
	} else {
		records = append(records, c.Ledger, c.Vault, c.Mint, c.Destination, &signerWENBTCAccountV1{Address: solana.Token2022ProgramID, Owner: solana.BPFLoaderUpgradeableProgramID, Executable: true, Data: []byte{1}})
	}
	keys := []solana.PublicKey{}
	values := []*rpc.Account{}
	for _, r := range records {
		keys = append(keys, r.Address)
		values = append(values, &rpc.Account{Owner: r.Owner, Executable: r.Executable, Data: rpc.DataBytesOrJSONFromBytes(r.Data), Lamports: 10000000})
	}
	values[4].Lamports = c.ClaimLamports
	pins := wenStakingPinsV1{ProgramID: v.ProgramID, Genesis: v.Genesis, DescriptorSHA256: v.DescriptorSHA256, CapabilitySHA256: v.CapabilitySHA256, DeploymentSlot: 1, CodeSHA256: wenHashV1([]byte{1, 2, 3})}
	return v, w, pins, &miningClaimRPCFake{&wenReadRPCFake{t: t, genesis: solana.Hash{1}, addresses: keys, page: &rpc.GetMultipleAccountsResult{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: 101}}, Value: values}}, 102}
}
func TestWENMiningClaimRPC(t *testing.T) {
	for _, op := range []string{"sol", "sat"} {
		for _, mode := range []string{"ok", "genesis", "genesis-change", "rpc-error", "nil-page", "reference-error", "behind", "stale", "expired", "short", "missing", "code", "clock", "offer-rate", "offer-digest", "entry-owner", "entry-capital", "entry-unrevealed-bytes", "policy", "inactive", "selected-paid", "bounds", "pin", "custody"} {
			t.Run(op+"/"+mode, func(t *testing.T) {
				v, w, p, f := miningClaimRPCFixture(t, op)
				f.change = mode
				lag := uint64(2)
				values := f.page.Value
				mutate := func(i, o int) {
					d := append([]byte(nil), values[i].Data.GetBinary()...)
					d[o] ^= 1
					values[i].Data = rpc.DataBytesOrJSONFromBytes(d)
				}
				switch mode {
				case "behind":
					f.reference = 100
				case "stale":
					f.reference = 104
				case "expired":
					f.page.Context.Slot = 132
				case "short":
					f.page.Value = f.page.Value[:3]
				case "missing":
					values[0] = nil
				case "code":
					mutate(8, 45)
				case "clock":
					mutate(9, 0)
				case "offer-rate":
					mutate(0, 368)
				case "offer-digest":
					mutate(0, 272)
				case "entry-owner":
					mutate(1, 112)
				case "entry-capital":
					mutate(1, 184)
				case "entry-unrevealed-bytes":
					mutate(1, 232)
				case "policy":
					mutate(0, 80)
				case "inactive":
					mutate(5, 10)
				case "selected-paid":
					mutate(4, 10)
				case "bounds":
					lag = 0
				case "pin":
					p.CodeSHA256 = "invalid"
				case "custody":
					if op == "sol" {
						values[4].Lamports--
					} else {
						mutate(13, 32)
					}
				}
				out, e := readWENMiningClaimRPCV1(context.Background(), f, p, v, w, lag)
				if (e == nil) != (mode == "ok") {
					t.Fatalf("unexpected result: %v", e)
				}
				if e == nil && (out.Slot != 101 || len(out.StateHash) != 64 || out.Payout.Net == 0) {
					t.Fatal(out)
				}
			})
		}
	}
}
func TestWENMiningClaimStateDigest(t *testing.T) {
	v, w, p, f := miningClaimRPCFixture(t, "sol")
	out, e := readWENMiningClaimRPCV1(context.Background(), f, p, v, w, 2)
	if e != nil {
		t.Fatal(e)
	}
	f.page.Value[4].Lamports++
	f.calls = 0
	next, e := readWENMiningClaimRPCV1(context.Background(), f, p, v, w, 2)
	if e != nil || next.StateHash == out.StateHash {
		t.Fatal("lamports not bound", e)
	}
	// A committed no-show retains settlement rights; a valid reveal also retains them.
	for _, reveal := range []bool{false, true} {
		v, w, p, f = miningClaimRPCFixture(t, "sol")
		d := append([]byte(nil), f.page.Value[1].Data.GetBinary()...)
		d[9] = 1
		if reveal {
			d[10] = 1
			binary.LittleEndian.PutUint16(d[232:], 10000)
			pre := append([]byte("wen-mining-commitment-v1"), d[16:192]...)
			pre = append(pre, d[232:]...)
			hash := sha256.Sum256(pre)
			copy(d[200:], hash[:])
		}
		f.page.Value[1].Data = rpc.DataBytesOrJSONFromBytes(d)
		if _, e = readWENMiningClaimRPCV1(context.Background(), f, p, v, w, 2); e != nil {
			t.Fatal("valid participation state rejected", e)
		}
	}
}
