package main

import (
	"encoding/binary"
	"fmt"
	solana "github.com/gagliardetto/solana-go"
	"testing"
)

func claimCustodyFixture(t *testing.T, v signerWENBTCClaimIntentV1, owners ...solana.PublicKey) (*signerWENBTCAccountV1, *signerWENBTCAccountV1, *signerWENBTCAccountV1, *signerWENBTCAccountV1) {
	t.Helper()
	wallet := solana.PublicKey{5}
	if len(owners) > 0 {
		wallet = owners[0]
	}
	ix, e := buildWENBTCClaimInstructionV1(v, wallet)
	if e != nil {
		t.Fatal(e)
	}
	makeAccount := func(i, n int) *signerWENBTCAccountV1 {
		return &signerWENBTCAccountV1{Address: ix.Accounts()[i].PublicKey, Owner: solana.TokenProgramID, Slot: 150, Data: make([]byte, n)}
	}
	m, vault, d, token := makeAccount(12, 82), makeAccount(9, 165), makeAccount(10, 165), makeAccount(14, 0)
	m.Data[44] = 8
	m.Data[45] = 1
	token.Executable = true
	for i, a := range []*signerWENBTCAccountV1{vault, d} {
		copy(a.Data, m.Address[:])
		owner := wallet
		if i == 0 {
			owner = ix.Accounts()[11].PublicKey
		}
		copy(a.Data[32:], owner[:])
		a.Data[108] = 1
		binary.LittleEndian.PutUint64(a.Data[64:], 800)
	}
	return m, vault, d, token
}
func TestWENBTCClaimCustody(t *testing.T) {
	for _, mode := range []string{"ok", "issuer-authorities", "destination-delegate", "mint-decimals", "mint-option", "uninitialized", "wrong-mint", "vault-authority", "destination-owner", "insufficient", "overflow", "delegate", "close", "frozen", "native", "token-program", "zero", "overclaimed"} {
		t.Run(mode, func(t *testing.T) {
			v := btcClaimIntentFixture()
			m, vault, d, token := claimCustodyFixture(t, v)
			a := wenBTCClaimAllocationV1{Amount: 250, Unclaimed: 800}
			switch mode {
			case "issuer-authorities":
				m.Data[0] = 1
				m.Data[46] = 1
			case "destination-delegate":
				d.Data[72] = 1
			case "mint-decimals":
				m.Data[44] = 9
			case "mint-option":
				m.Data[0] = 2
			case "uninitialized":
				m.Data[45] = 0
			case "wrong-mint":
				vault.Data[0] ^= 1
			case "vault-authority":
				vault.Data[32] ^= 1
			case "destination-owner":
				d.Data[32] ^= 1
			case "insufficient":
				binary.LittleEndian.PutUint64(vault.Data[64:], 249)
			case "overflow":
				binary.LittleEndian.PutUint64(d.Data[64:], ^uint64(0))
			case "delegate":
				vault.Data[72] = 1
			case "close":
				vault.Data[129] = 1
			case "frozen":
				d.Data[108] = 2
			case "native":
				d.Data[109] = 1
			case "token-program":
				token.Executable = false
			case "zero":
				a.Amount = 0
			case "overclaimed":
				a.Unclaimed = 249
			}
			e := validateWENBTCClaimCustodyV1(v, solana.PublicKey{5}, 150, a, m, vault, d, token)
			good := mode == "ok" || mode == "issuer-authorities" || mode == "destination-delegate"
			if (e == nil) != good {
				t.Fatal(e)
			}
		})
	}
	for i := 0; i < 3; i++ {
		for _, field := range []string{"nil", "address", "owner", "slot", "length", "executable"} {
			t.Run(fmt.Sprintf("account%d/%s", i, field), func(t *testing.T) {
				v := btcClaimIntentFixture()
				m, vault, d, token := claimCustodyFixture(t, v)
				all := []*signerWENBTCAccountV1{m, vault, d}
				a := all[i]
				switch field {
				case "nil":
					all[i] = nil
				case "address":
					a.Address[0] ^= 1
				case "owner":
					a.Owner[0] ^= 1
				case "slot":
					a.Slot--
				case "length":
					a.Data = a.Data[:1]
				case "executable":
					a.Executable = true
				}
				if validateWENBTCClaimCustodyV1(v, solana.PublicKey{5}, 150, wenBTCClaimAllocationV1{Amount: 250, Unclaimed: 800}, all[0], all[1], all[2], token) == nil {
					t.Fatal("accepted")
				}
			})
		}
	}
}
