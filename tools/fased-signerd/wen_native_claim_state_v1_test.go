package main

import (
	"crypto/sha256"
	"encoding/binary"
	solana "github.com/gagliardetto/solana-go"
	"testing"
)

func nativeStateFixture(t *testing.T, owners ...solana.PublicKey) (signerWENNativeClaimIntentV1, wenNativeClaimSnapshotV1) {
	bv, bs := claimHistoryFixture(t, false, owners...)
	v := nativeClaimIntentFixture()
	v.Sale = bv.Sale
	v.MinFinalizedSlot = "100"
	v.ExpiresSlot = "200"
	p := solana.MustPublicKeyFromBase58(v.ProgramID)
	sale := solana.MustPublicKeyFromBase58(v.Sale)
	owner := solana.PublicKey{5}
	if len(owners) > 0 {
		owner = owners[0]
	}
	derive := func(seed string, parts ...[]byte) (solana.PublicKey, byte) {
		k, b, e := solana.FindProgramAddress(append([][]byte{[]byte(seed)}, parts...), p)
		if e != nil {
			t.Fatal(e)
		}
		return k, b
	}
	mint, _ := derive("wen-sat-mint-v1", sale[:])
	v.Mint = mint.String()
	le := make([]byte, 8)
	binary.LittleEndian.PutUint64(le, 126)
	domain := sha256.Sum256(append([]byte("wen-native-staking-epoch-v1"), le...))
	receipt, rb := derive("wen-named-promise-v1", sale[:], []byte{2}, domain[:])
	source, sb := derive("wen-native-stake-release-v1", receipt[:])
	promises, _ := derive("wen-sat-promises-v1", sale[:])
	acc := func(k solana.PublicKey, b byte, magic string, n int, state byte) *signerWENBTCAccountV1 {
		d := make([]byte, n)
		copy(d, magic)
		d[8] = 1
		d[10] = state
		d[11] = b
		return &signerWENBTCAccountV1{Address: k, Owner: p, Slot: 150, Data: d}
	}
	s := wenNativeClaimSnapshotV1{Slot: 150, Now: 43 * 86400, Receipt: acc(receipt, rb, "WENPRM01", 152, 2), Source: acc(source, sb, "WENNSRC1", 112, 0), Cohort: bs.Cohort, History: bs.History}
	copy(s.Receipt.Data[16:], sale[:])
	copy(s.Receipt.Data[48:], domain[:])
	copy(s.Receipt.Data[80:], promises[:])
	copy(s.Source.Data[16:], sale[:])
	copy(s.Source.Data[48:], receipt[:])
	for off, n := range map[int]uint64{112: 126, 120: 1000, 128: 1000} {
		binary.LittleEndian.PutUint64(s.Receipt.Data[off:], n)
	}
	for off, n := range map[int]uint64{80: 1000, 96: 126, 104: 126} {
		binary.LittleEndian.PutUint64(s.Source.Data[off:], n)
	}
	_, _, _, m, inv, dest := stakingTokenFixture(t)
	ix, e := buildWENNativeClaimInstructionV1(v, owner)
	if e != nil {
		t.Fatal(e)
	}
	a := ix.Accounts()
	collector, _ := derive("wen-sat-collector-v1", sale[:])
	m.Address = mint
	m.Slot = 150
	copy(m.Data[4:], sale[:])
	copy(m.Data[202:], collector[:])
	for _, r := range []*signerWENBTCAccountV1{inv, dest} {
		r.Slot = 150
		copy(r.Data, mint[:])
	}
	inv.Address = a[8].PublicKey
	copy(inv.Data[32:], receipt[:])
	binary.LittleEndian.PutUint64(inv.Data[64:], 1000)
	dest.Address = a[9].PublicKey
	copy(dest.Data[32:], owner[:])
	s.Mint = m
	s.Inventory = inv
	s.Destination = dest
	return v, s
}
func TestWENNativeClaimState(t *testing.T) {
	for _, mode := range []string{"ok", "v2", "cancelled", "minimum", "paid", "open-day", "stale", "mixed-slot", "incomplete", "minted", "future-release", "history-end", "zero-weight", "cohort", "custody", "fee", "authority", "dest-overflow", "withheld-overflow", "wrong-owner", "short", "dust"} {
		t.Run(mode, func(t *testing.T) {
			v, s := nativeStateFixture(t)
			put := func(a *signerWENBTCAccountV1, o int, n uint64) { binary.LittleEndian.PutUint64(a.Data[o:], n) }
			switch mode {
			case "v2":
				s.Source.Data[8] = 2
				s.Receipt.Data[8] = 2
			case "cancelled":
				put(s.Receipt, 120, 1100)
				put(s.Receipt, 136, 100)
			case "minimum":
				v.MinimumReceived = "243"
			case "paid":
				s.Paid = s.Source
			case "open-day":
				s.Now = 42 * 86400
			case "stale":
				s.Slot = 99
			case "mixed-slot":
				s.Inventory.Slot++
			case "incomplete":
				put(s.Receipt, 120, 1001)
			case "minted":
				put(s.Receipt, 128, 999)
				put(s.Receipt, 136, 1)
			case "future-release":
				put(s.Source, 104, 130)
			case "history-end":
				put(s.History, 88, 42)
			case "zero-weight":
				put(s.History, 96, 0)
			case "cohort":
				s.Cohort.Data[136] ^= 1
			case "custody":
				put(s.Inventory, 64, 999)
			case "fee":
				s.Mint.Data[170+90+16] ^= 1
			case "authority":
				s.Mint.Data[170] = 1
			case "dest-overflow":
				put(s.Destination, 64, ^uint64(0))
			case "withheld-overflow":
				put(s.Destination, 170, ^uint64(0))
			case "wrong-owner":
				s.Source.Owner = solana.PublicKey{77}
			case "short":
				s.Receipt.Data = s.Receipt.Data[:151]
			case "dust":
				put(s.Source, 80, 1)
				put(s.Receipt, 120, 1)
				put(s.Receipt, 128, 1)
			}
			out, e := validateWENNativeClaimStateV1(v, solana.PublicKey{5}, solana.PublicKey{6}, s)
			good := mode == "ok" || mode == "v2" || mode == "cancelled"
			if (e == nil) != good {
				t.Fatalf("%+v %v", out, e)
			}
			if good && (out.Gross != 250 || out.Fee != 8 || out.Net != 242 || out.Weight != 25) {
				t.Fatal(out)
			}
		})
	}
}
