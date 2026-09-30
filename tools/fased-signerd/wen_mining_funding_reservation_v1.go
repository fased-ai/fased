package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"math"
	"strconv"
)

// Internal observations only. RPC must independently authenticate the slot,
// clock and rent. Active sale/budget/capital validation remains a separate gate.
type wenMiningFundingReservationV1 struct {
	Slot, Now, VaultLamports, VaultRent uint64
	Vault, Action                       *signerWENBTCAccountV1
}

func validateWENMiningFundingReservationV1(v signerWENMiningFundingIntentV1, owner solana.PublicKey, s wenMiningFundingReservationV1) error {
	ix, e := buildWENMiningFundingInstructionV1(v, owner)
	if e != nil {
		return e
	}
	bad := errors.New("mining funding reservation rejected")
	n := func(x string) uint64 { v, _ := strconv.ParseUint(x, 10, 64); return v }
	read := func(d []byte, o int) uint64 { return binary.LittleEndian.Uint64(d[o:]) }
	if s.Slot < n(v.MinFinalizedSlot) || s.Slot >= n(v.ExpiresSlot) || s.Now >= n(v.Deadline) || s.Now > math.MaxInt64 || s.VaultRent == 0 {
		return bad
	}
	p := ix.ProgramID()
	a := ix.Accounts()
	id := solana.MustPublicKeyFromBase58(v.VaultID)
	_, vb, e := solana.FindProgramAddress([][]byte{[]byte("wen-portfolio-sol-v1"), owner[:], id[:]}, p)
	if e != nil {
		return e
	}
	le := make([]byte, 8)
	binary.LittleEndian.PutUint64(le, n(v.Nonce))
	vault := a[0].PublicKey
	_, ab, e := solana.FindProgramAddress([][]byte{[]byte("wen-portfolio-action-v1"), vault[:], le}, p)
	if e != nil {
		return e
	}
	check := func(r *signerWENBTCAccountV1, k solana.PublicKey, length int, magic string, state, bump byte) bool {
		if r == nil || r.Address != k || r.Owner != p || r.Executable || r.Slot != s.Slot || len(r.Data) != length {
			return false
		}
		d := r.Data
		return string(d[:8]) == magic && d[8] == 1 && d[9] == 0 && d[10] == state && d[11] == bump && bytes.Equal(d[12:16], make([]byte, 4))
	}
	if !check(s.Vault, vault, 160, "WENPVL01", 1, vb) || !check(s.Action, a[1].PublicKey, 112, "WENPVA01", 0, ab) {
		return bad
	}
	d, t := s.Vault.Data, s.Action.Data
	key := func(d []byte, o int, k solana.PublicKey) bool { return bytes.Equal(d[o:o+32], k[:]) }
	if !key(d, 16, owner) || !key(d, 48, id) || !key(d, 80, a[5].PublicKey) || d[136] > 1 || !bytes.Equal(d[137:144], make([]byte, 7)) || read(d, 144) == 0 || !bytes.Equal(d[152:], make([]byte, 8)) || !key(t, 16, vault) || read(t, 48) != n(v.Nonce) || read(t, 56) != n(v.Amount) || read(t, 64) != n(v.Deadline) || !key(t, 72, a[5].PublicKey) || !bytes.Equal(t[104:], make([]byte, 8)) {
		return bad
	}
	reserved, spent := read(d, 120), read(d, 128)
	if reserved > math.MaxUint64-spent || n(v.Amount) > reserved || s.VaultRent > math.MaxUint64-reserved || s.VaultLamports < s.VaultRent+reserved {
		return bad
	}
	// Revoked/lowered limits block new reservations, not these accepted rights.
	return nil
}
