package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"math"
)

// Internal reconstruction boundary only; deliberately not registered as a socket
// operation or a signing permission. Owner comes from the protected wallet.
type wenCampaignOwnerActionV1 struct {
	Claim                      *wenCampaignClaimRequestV1 `json:",omitempty"`
	Operation                  string
	Program, Economy, Position solana.PublicKey
	Amount                     uint64
	Setup                      *wenCampaignSetupRequestV1 `json:",omitempty"`
	Policy                     *wenCampaignPolicyV1       `json:",omitempty"`
}
type wenCampaignPositionV1 struct {
	Slot, ReferenceSlot uint64
	Address, Owner      solana.PublicKey
	Executable          bool
	Data                []byte
	Lamports, Rent      uint64
	PolicyWindow        *wenCampaignSetupAccountV1 `json:",omitempty"`
	Now                 uint64                     `json:",omitempty"`
	AccountingSHA256    string
}

func buildWENCampaignOwnerV1(v wenCampaignOwnerActionV1, owner solana.PublicKey, s wenCampaignPositionV1) (solana.Instruction, error) {
	bad := errors.New("invalid campaign owner instruction")
	if v.Claim != nil || v.Setup != nil || (v.Operation != "policy" && (v.Policy != nil || s.PolicyWindow != nil || s.Now != 0)) {
		return nil, bad
	}
	mint, _, e := solana.FindProgramAddress([][]byte{[]byte("wen-sat-mint-v1"), v.Economy[:]}, v.Program)
	if e != nil {
		return nil, e
	}
	position, _, e := solana.FindProgramAddress([][]byte{[]byte("wen-retail-position-v2"), owner[:], mint[:]}, v.Program)
	if e != nil {
		return nil, e
	}
	b := s.Data
	if owner.IsZero() || v.Program.IsZero() || v.Economy.IsZero() || s.Address != position || v.Position != position || s.Owner != v.Program || s.Executable || len(b) != 256 || string(b[:8]) != "WENRPOS2" || b[8] != 1 || b[9] != 0 || !bytes.Equal(b[12:16], make([]byte, 4)) || b[10] > 1 || b[184] != 0 || b[224] > 1 || b[225] > 1 || b[226] > 1 || !bytes.Equal(b[16:48], owner[:]) || !bytes.Equal(b[80:112], mint[:]) || s.Lamports < s.Rent || owner == v.Program || position == v.Program || owner == position {
		return nil, bad
	}
	keys := solana.AccountMetaSlice{solana.Meta(owner).WRITE().SIGNER(), solana.Meta(position).WRITE()}
	var issuer, window solana.PublicKey
	copy(issuer[:], b[48:80])
	copy(window[:], b[192:224])
	appendAccounting := func(ix solana.Instruction) (solana.Instruction, error) {
		tail, err := wenCampaignAccountingTailV1(v.Program, v.Economy, issuer, window)
		if err != nil {
			return nil, err
		}
		data, err := ix.Data()
		if err != nil {
			return nil, err
		}
		return solana.NewInstruction(v.Program, append(ix.Accounts(), tail...), data), nil
	}
	var op byte
	switch v.Operation {
	case "policy":
		ix, err := buildWENCampaignPolicyV1(v, owner, s, keys)
		if err != nil {
			return nil, err
		}
		return appendAccounting(ix)
	case "stop":
		op = 139
		if v.Amount != 0 {
			return nil, bad
		}
	case "withdraw":
		op = 138
		if v.Amount == 0 || v.Amount > s.Lamports-s.Rent {
			return nil, bad
		}
	case "top-up":
		op = 143
		if v.Amount == 0 || v.Amount > math.MaxUint64-s.Lamports {
			return nil, bad
		}
		keys = append(keys, solana.Meta(solana.SystemProgramID))
	default:
		return nil, bad
	}
	data := []byte{op}
	if op != 139 {
		data = make([]byte, 9)
		data[0] = op
		binary.LittleEndian.PutUint64(data[1:], v.Amount)
	}
	return appendAccounting(solana.NewInstruction(v.Program, keys, data))
}

// Compare the complete v0 message, not just its first instruction. Lifetime
// observations must come from the protected RPC preparation path.
func verifyWENCampaignOwnerMessageV1(v wenCampaignOwnerActionV1, owner solana.PublicKey, s wenCampaignPositionV1, blockhash solana.Hash, currentHeight, lastValidHeight uint64, message []byte) error {
	if blockhash == (solana.Hash{}) || currentHeight >= lastValidHeight || len(message) > 1232 {
		return errors.New("invalid campaign message lifetime")
	}
	ix, err := buildWENCampaignOwnerV1(v, owner, s)
	if err != nil {
		return err
	}
	tx, err := solana.NewTransaction([]solana.Instruction{ix}, blockhash, solana.TransactionPayer(owner))
	if err != nil {
		return err
	}
	tx.Message.SetVersion(solana.MessageVersionV0)
	expected, err := tx.Message.MarshalBinary()
	if err != nil {
		return err
	}
	if !bytes.Equal(expected, message) {
		return errors.New("campaign canonical message mismatch")
	}
	return nil
}
