package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	solana "github.com/gagliardetto/solana-go"
)

// Checks actual classic SPL custody for the selected SAT reward asset. Issuer
// mint/freeze authorities are allowed; this is not admission of another launch.
func validateWENBTCClaimCustodyV1(v signerWENBTCClaimIntentV1, owner solana.PublicKey, slot uint64, allocation wenBTCClaimAllocationV1, mint, vault, destination, tokenProgram *signerWENBTCAccountV1) error {
	bad := errors.New("BTC claim token custody rejected")
	ix, e := buildWENBTCClaimInstructionV1(v, owner)
	if e != nil {
		return e
	}
	token := solana.TokenProgramID
	envelope := func(a *signerWENBTCAccountV1, k solana.PublicKey, n int) bool {
		return a != nil && a.Address == k && a.Owner == token && !a.Executable && a.Slot == slot && len(a.Data) == n
	}
	if allocation.Amount == 0 || allocation.Amount > allocation.Unclaimed || !envelope(mint, ix.Accounts()[12].PublicKey, 82) || !envelope(vault, ix.Accounts()[9].PublicKey, 165) || !envelope(destination, ix.Accounts()[10].PublicKey, 165) || tokenProgram == nil || tokenProgram.Address != token || !tokenProgram.Executable || tokenProgram.Slot != slot {
		return bad
	}
	u32 := func(d []byte, o int) uint32 { return binary.LittleEndian.Uint32(d[o:]) }
	u64 := func(d []byte, o int) uint64 { return binary.LittleEndian.Uint64(d[o:]) }
	if mint.Data[44] != 8 || mint.Data[45] != 1 || u32(mint.Data, 0) > 1 || u32(mint.Data, 46) > 1 {
		return bad
	}
	for i, a := range []*signerWENBTCAccountV1{vault, destination} {
		d := a.Data
		authority := owner
		if i == 0 {
			authority = ix.Accounts()[11].PublicKey
		}
		if !bytes.Equal(d[:32], mint.Address[:]) || !bytes.Equal(d[32:64], authority[:]) || d[108] != 1 || u32(d, 72) > 1 || u32(d, 129) > 1 || u32(d, 109) != 0 {
			return bad
		}
		if i == 0 && (u32(d, 72) != 0 || u32(d, 129) != 0 || u64(d, 64) < allocation.Amount) {
			return bad
		}
		if i == 1 && u64(d, 64) > ^uint64(0)-allocation.Amount {
			return bad
		}
	}
	return nil
}
