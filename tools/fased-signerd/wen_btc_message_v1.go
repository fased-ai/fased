package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	bin "github.com/gagliardetto/binary"
	solana "github.com/gagliardetto/solana-go"
)

// All expectations come from signer-owned preparation, never from the message
// being inspected. This offline guard does not fetch state or enable signing.
type signerWENBTCMessageIntentV1 struct {
	payer, program solana.PublicKey
	blockhash      solana.Hash
	units          uint32
	data           []byte
	accounts       []signerTypedAccountV2
}
type signerWENBTCLookupPinV1 struct {
	key    solana.PublicKey
	digest string
}
type signerWENBTCMessageLifeV1 struct{ currentHeight, lastValidHeight, minimumSlot, maximumSlotLag uint64 }

func verifyWENBTCMessageV1(raw []byte, intent signerWENBTCMessageIntentV1, pins []signerWENBTCLookupPinV1, snapshots []*signerWENBTCAccountV1, life signerWENBTCMessageLifeV1) error {
	bad := errors.New("WEN BTC message differs from prepared intent")
	if len(raw) == 0 || len(raw)+65 > 1232 || raw[0] != 128 || life.currentHeight >= life.lastValidHeight || intent.payer.IsZero() || intent.program.IsZero() || intent.blockhash == (solana.Hash{}) || intent.units == 0 || intent.units > 1400000 || len(intent.data) == 0 || (intent.data[0] != 111 && intent.data[0] != 112) {
		return bad
	}
	tables, err := verifiedWENBTCLookupTablesV1(pins, snapshots, life)
	if err != nil {
		return err
	}
	var message solana.Message
	if err := message.UnmarshalWithDecoder(bin.NewBinDecoder(raw)); err != nil {
		return bad
	}
	encoded, err := message.MarshalBinary()
	if err != nil || !bytes.Equal(encoded, raw) {
		return errors.New("WEN BTC noncanonical message wire")
	}
	count := len(message.AccountKeys)
	h := message.Header
	if message.GetVersion() != solana.MessageVersionV0 || h.NumRequiredSignatures != 1 || h.NumReadonlySignedAccounts != 0 || count < 2 || int(h.NumReadonlyUnsignedAccounts) > count-1 || message.AccountKeys[0] != intent.payer || message.RecentBlockhash != intent.blockhash || len(message.Instructions) != 2 {
		return bad
	}
	lookups := message.GetAddressTableLookups()
	if len(lookups) < 1 || len(lookups) > len(pins) {
		return bad
	}
	seen := map[solana.PublicKey]bool{}
	for _, l := range lookups {
		t, ok := tables[l.AccountKey]
		if !ok || seen[l.AccountKey] {
			return bad
		}
		seen[l.AccountKey] = true
		for _, indices := range []solana.Uint8SliceAsNum{l.WritableIndexes, l.ReadonlyIndexes} {
			for _, n := range indices {
				if int(n) >= len(t) {
					return bad
				}
			}
		}
	}
	if err = message.SetAddressTables(tables); err != nil {
		return bad
	}
	if err = message.ResolveLookups(); err != nil {
		return bad
	}
	if len(message.AccountKeys) > 256 {
		return bad
	}
	compute := solana.MustPublicKeyFromBase58("ComputeBudget111111111111111111111111111111")
	type role struct{ signer, writable bool }
	expected := map[solana.PublicKey]role{intent.payer: {true, true}, intent.program: {false, false}, compute: {false, false}}
	signers := 0
	for _, a := range intent.accounts {
		k, err := solana.PublicKeyFromBase58(a.Pubkey)
		if err != nil || k.String() != a.Pubkey {
			return bad
		}
		if a.IsSigner {
			signers++
			if k != intent.payer {
				return bad
			}
		}
		old := expected[k]
		expected[k] = role{old.signer || a.IsSigner, old.writable || a.IsWritable}
	}
	if signers != 1 || len(expected) != len(message.AccountKeys) {
		return bad
	}
	seen = map[solana.PublicKey]bool{}
	for _, k := range message.AccountKeys {
		want, ok := expected[k]
		if !ok || seen[k] {
			return bad
		}
		seen[k] = true
		writable, err := message.IsWritable(k)
		if err != nil || writable != want.writable || message.IsSigner(k) != want.signer {
			return bad
		}
	}
	budget, ix := message.Instructions[0], message.Instructions[1]
	if int(budget.ProgramIDIndex) >= count || message.AccountKeys[budget.ProgramIDIndex] != compute || len(budget.Accounts) != 0 || len(budget.Data) != 5 || budget.Data[0] != 2 || binary.LittleEndian.Uint32(budget.Data[1:]) != intent.units {
		return bad
	}
	if int(ix.ProgramIDIndex) >= count || message.AccountKeys[ix.ProgramIDIndex] != intent.program || !bytes.Equal(ix.Data, intent.data) || len(ix.Accounts) != len(intent.accounts) {
		return bad
	}
	for i, at := range ix.Accounts {
		if int(at) >= len(message.AccountKeys) || message.AccountKeys[at].String() != intent.accounts[i].Pubkey {
			return bad
		}
	}
	return nil
}

// Shared precondition for construction and verification: invalid lookup bytes
// never enter the transaction compiler.
func verifiedWENBTCLookupTablesV1(pins []signerWENBTCLookupPinV1, snapshots []*signerWENBTCAccountV1, life signerWENBTCMessageLifeV1) (map[solana.PublicKey]solana.PublicKeySlice, error) {
	if len(pins) < 1 || len(pins) > 4 || len(snapshots) != len(pins) {
		return nil, errors.New("WEN BTC lookup admission count")
	}
	lookup := solana.MustPublicKeyFromBase58("AddressLookupTab1e1111111111111111111111111")
	tables := map[solana.PublicKey]solana.PublicKeySlice{}
	for i, p := range pins {
		s := snapshots[i]
		if s == nil || p.key.IsZero() || s.Address != p.key || s.Owner != lookup || s.Executable || s.Slot < life.minimumSlot || s.Slot-life.minimumSlot > life.maximumSlotLag || wenHashV1(s.Data) != p.digest {
			return nil, errors.New("WEN BTC lookup snapshot differs from admission")
		}
		if _, ok := tables[p.key]; ok {
			return nil, errors.New("WEN BTC duplicate lookup admission")
		}
		d := s.Data
		if len(d) < 88 || len(d) > 56+256*32 || (len(d)-56)%32 != 0 || binary.LittleEndian.Uint32(d) != 1 || binary.LittleEndian.Uint64(d[4:]) != ^uint64(0) || binary.LittleEndian.Uint64(d[12:]) >= s.Slot || int(d[20]) > (len(d)-56)/32 || d[21] > 1 {
			return nil, errors.New("WEN BTC inactive or malformed lookup")
		}
		keys := make(solana.PublicKeySlice, (len(d)-56)/32)
		for j := range keys {
			copy(keys[j][:], d[56+j*32:88+j*32])
		}
		tables[p.key] = keys
	}
	return tables, nil
}
