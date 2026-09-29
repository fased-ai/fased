package main

import (
	"encoding/binary"
	solana "github.com/gagliardetto/solana-go"
	"math"
	"testing"
)

func miningClaimCustodyFixture(t *testing.T, op string, override ...signerWENMiningClaimIntentV1) (signerWENMiningClaimIntentV1, solana.PublicKey, wenMiningClaimSnapshotV1, wenMiningClaimCustodyV1) {
	return miningClaimCustodyOwnedFixture(t, op, solana.PublicKey{5}, override...)
}
func miningClaimCustodyOwnedFixture(t *testing.T, op string, owner solana.PublicKey, override ...signerWENMiningClaimIntentV1) (signerWENMiningClaimIntentV1, solana.PublicKey, wenMiningClaimSnapshotV1, wenMiningClaimCustodyV1) {
	v, w, s := miningClaimStateOwnedFixture(t, owner, override...)
	v.Operation = op
	if op == "sol" {
		d := make([]byte, 17)
		binary.LittleEndian.PutUint64(d, 3480)
		binary.LittleEndian.PutUint64(d[8:], math.Float64bits(2))
		d[16] = 50
		return v, w, s, wenMiningClaimCustodyV1{ClaimLamports: 2227200 + 100, Rent: &signerWENBTCAccountV1{Address: solana.MustPublicKeyFromBase58("SysvarRent111111111111111111111111111111111"), Owner: solana.MustPublicKeyFromBase58("Sysvar1111111111111111111111111111111111111"), Slot: s.Slot, Data: d}}
	}
	destination := solana.PublicKey{4}.String()
	v.Destination = &destination
	v.ExpectedGross = "20"
	v.MinimumReceived = "19"
	ix, _ := buildWENMiningClaimInstructionV1(v, w)
	a := ix.Accounts()
	p := ix.ProgramID()
	sale := a[1].PublicKey
	_, _, _, mint, vault, dest := stakingTokenFixture(t)
	collector, _, _ := solana.FindProgramAddress([][]byte{[]byte("wen-sat-collector-v1"), sale[:]}, p)
	mint.Address = a[11].PublicKey
	mint.Slot = s.Slot
	copy(mint.Data[4:], sale[:])
	copy(mint.Data[202:], collector[:])
	for i, account := range []*signerWENBTCAccountV1{vault, dest} {
		account.Slot = s.Slot
		copy(account.Data, a[11].PublicKey[:])
		if i == 0 {
			account.Address = a[9].PublicKey
			copy(account.Data[32:], a[7].PublicKey[:])
		} else {
			account.Address = a[10].PublicKey
			copy(account.Data[32:], w[:])
		}
	}
	ledger, b, _ := solana.FindProgramAddress([][]byte{[]byte("wen-mining-reserved-v1"), sale[:]}, p)
	d := make([]byte, 112)
	copy(d, "WENMRSL1")
	d[8] = 1
	d[11] = b
	copy(d[16:], sale[:])
	copy(d[48:], a[9].PublicKey[:])
	for o, n := range map[int]uint64{80: 2, 88: 1, 96: 50} {
		binary.LittleEndian.PutUint64(d[o:], n)
	}
	binary.LittleEndian.PutUint64(s.Receipt.Data[296:], 20)
	return v, w, s, wenMiningClaimCustodyV1{Ledger: &signerWENBTCAccountV1{Address: ledger, Owner: p, Slot: s.Slot, Data: d}, Mint: mint, Vault: vault, Destination: dest}
}
func TestWENMiningClaimCustody(t *testing.T) {
	for _, op := range []string{"sol", "sat"} {
		t.Run(op, func(t *testing.T) {
			v, w, s, c := miningClaimCustodyFixture(t, op)
			out, e := validateWENMiningClaimCustodyV1(v, w, s, c)
			if e != nil {
				t.Fatal(e)
			}
			if op == "sat" && (out.Net != 19 || out.Fee != 1 || out.Reserved != 50) {
				t.Fatal(out)
			}
			if op == "sol" && (out.Net != 100 || out.RentMinimum != 2227200) {
				t.Fatal(out)
			}
		})
	}
	for _, mode := range []string{"rent-balance", "rent-owner", "rent-slot", "rent-short", "rent-nan", "rent-overflow", "rent-negative", "rent-threshold-overflow"} {
		t.Run(mode, func(t *testing.T) {
			v, w, s, c := miningClaimCustodyFixture(t, "sol")
			switch mode {
			case "rent-balance":
				c.ClaimLamports--
			case "rent-owner":
				c.Rent.Owner = w
			case "rent-slot":
				c.Rent.Slot++
			case "rent-short":
				c.Rent.Data = nil
			case "rent-nan":
				binary.LittleEndian.PutUint64(c.Rent.Data[8:], math.Float64bits(math.NaN()))
			case "rent-overflow":
				binary.LittleEndian.PutUint64(c.Rent.Data, ^uint64(0))
			case "rent-negative":
				binary.LittleEndian.PutUint64(c.Rent.Data[8:], math.Float64bits(-1))
			case "rent-threshold-overflow":
				binary.LittleEndian.PutUint64(c.Rent.Data[8:], math.Float64bits(math.MaxFloat64))
			}
			if _, e := validateWENMiningClaimCustodyV1(v, w, s, c); e == nil {
				t.Fatal("invalid rent accepted")
			}
		})
	}
	for _, mode := range []string{"ledger-owner", "ledger-slot", "ledger-bump", "ledger-reserved", "ledger-short", "ledger-domain", "ledger-active", "ledger-next", "under-reserved", "under-inventory", "allocation-paid", "allocation-short", "mint-fee", "mint-authority", "destination-owner", "destination-mint", "destination-overflow", "withheld-overflow", "vault-authority", "vault-slot"} {
		t.Run(mode, func(t *testing.T) {
			v, w, s, c := miningClaimCustodyFixture(t, "sat")
			switch mode {
			case "ledger-owner":
				c.Ledger.Owner = w
			case "ledger-slot":
				c.Ledger.Slot++
			case "ledger-bump":
				c.Ledger.Data[11] ^= 1
			case "ledger-reserved":
				c.Ledger.Data[12] = 1
			case "ledger-short":
				c.Ledger.Data = nil
			case "ledger-domain":
				c.Ledger.Data[16] ^= 1
			case "ledger-active":
				binary.LittleEndian.PutUint64(c.Ledger.Data[88:], 0)
			case "ledger-next":
				binary.LittleEndian.PutUint64(c.Ledger.Data[80:], 1)
			case "under-reserved":
				binary.LittleEndian.PutUint64(c.Ledger.Data[96:], 19)
			case "under-inventory":
				binary.LittleEndian.PutUint64(c.Vault.Data[64:], 49)
			case "allocation-paid":
				binary.LittleEndian.PutUint64(s.Receipt.Data[320:], 1)
				binary.LittleEndian.PutUint64(s.Receipt.Data[296:], 0)
			case "allocation-short":
				binary.LittleEndian.PutUint64(s.Receipt.Data[296:], 19)
			case "mint-fee":
				c.Mint.Data[258] ^= 1
			case "mint-authority":
				c.Mint.Data[170] = 1
			case "destination-owner":
				c.Destination.Data[32] ^= 1
			case "destination-mint":
				c.Destination.Data[0] ^= 1
			case "destination-overflow":
				binary.LittleEndian.PutUint64(c.Destination.Data[64:], ^uint64(0))
			case "withheld-overflow":
				binary.LittleEndian.PutUint64(c.Destination.Data[170:], ^uint64(0))
			case "vault-authority":
				c.Vault.Data[32] ^= 1
			case "vault-slot":
				c.Vault.Slot++
			}
			if _, e := validateWENMiningClaimCustodyV1(v, w, s, c); e == nil {
				t.Fatal("invalid SAT custody accepted")
			}
		})
	}
}
