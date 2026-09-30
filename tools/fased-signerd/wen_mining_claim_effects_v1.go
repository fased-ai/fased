package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"math/big"
	"strconv"
)

// Exact transaction effects plus the selected paid claim leg. A later payment
// of the other leg must not invalidate this historical payment proof.
func wenMiningClaimSuccessEffectsV1(r wenBudgetReservationV1, result *rpc.GetTransactionResult, paid *signerWENBTCAccountV1) string {
	if !wenMiningClaimSettlementScopesValidV1(r) || result == nil || result.Meta == nil || result.Meta.Err != nil || result.Transaction == nil || paid == nil {
		return ""
	}
	wire, e := wenSignedWireV1(r, r.SignedMessage)
	if e != nil || !bytes.Equal(wire, result.Transaction.GetBinary()) || result.Slot < r.MinExecutionSlot {
		return ""
	}
	v := *r.MiningClaimIntent
	w := solana.MustPublicKeyFromBase58(r.WalletPublicKey)
	ix, e := buildWENMiningClaimInstructionV1(v, w)
	if e != nil {
		return ""
	}
	a := ix.Accounts()
	p := ix.ProgramID()
	gross, _ := strconv.ParseUint(v.ExpectedGross, 10, 64)
	m := result.Meta
	if m.Fee > r.MiningClaimPrepared.Fee || len(m.PreBalances) != len(r.AccountKeys) || len(m.PostBalances) != len(r.AccountKeys) || m.PreBalances[0] < m.Fee {
		return ""
	}
	sol := v.Operation == "sol"
	fee, net := wenSatTransferV1(gross)
	if sol {
		fee = 0
		net = gross
	}
	for i, key := range r.AccountKeys {
		delta := new(big.Int).Sub(new(big.Int).SetUint64(m.PostBalances[i]), new(big.Int).SetUint64(m.PreBalances[i]))
		expected := new(big.Int)
		if i == 0 {
			expected.Neg(new(big.Int).SetUint64(m.Fee))
			if sol {
				expected.Add(expected, new(big.Int).SetUint64(gross))
			}
		} else if sol && key == a[6].PublicKey.String() {
			expected.Neg(new(big.Int).SetUint64(gross))
		}
		if delta.Cmp(expected) != 0 {
			return ""
		}
	}
	if sol {
		if len(m.PreTokenBalances) != 0 || len(m.PostTokenBalances) != 0 {
			return ""
		}
	} else {
		token, rows := wenSuccessTokenEffectsV1(r, result)
		if token == "" || len(rows) != 2 {
			return ""
		}
		for _, row := range rows {
			owner, delta := "", ""
			switch row.Account {
			case *v.Destination:
				owner = w.String()
				delta = strconv.FormatUint(net, 10)
			case a[9].PublicKey.String():
				owner = a[7].PublicKey.String()
				delta = new(big.Int).Neg(new(big.Int).SetUint64(gross)).String()
			default:
				return ""
			}
			if !row.PrePresent || !row.PostPresent || row.Owner != owner || row.Mint != a[11].PublicKey.String() || row.Program != solana.Token2022ProgramID.String() || row.Decimals != 11 || row.DeltaRaw != delta {
				return ""
			}
		}
	}
	_, b, _ := solana.FindProgramAddress([][]byte{[]byte("wen-mining-claim-v1"), a[1].PublicKey[:], a[5].PublicKey[:]}, p)
	d := paid.Data
	if paid.Address != a[6].PublicKey || paid.Owner != p || paid.Executable || paid.Slot < result.Slot || len(d) != 192 || string(d[:8]) != "WENMCLM1" || d[8] != 1 || d[9] != 0 || d[10] > 3 || d[11] != b || !bytes.Equal(d[12:16], make([]byte, 4)) {
		return ""
	}
	for i, k := range []solana.PublicKey{p, a[1].PublicKey, a[2].PublicKey, a[5].PublicKey, w} {
		if !bytes.Equal(d[16+i*32:48+i*32], k[:]) {
			return ""
		}
	}
	bit, offset := byte(1), 176
	if !sol {
		bit = 2
		offset = 184
	}
	if d[10]&bit == 0 || binary.LittleEndian.Uint64(d[offset:]) != gross {
		return ""
	}
	raw, e := json.Marshal(struct {
		Message, Claim, Operation                 string
		Slot, Gross, Net, TransferFee, NetworkFee uint64
	}{r.MessageSHA256, paid.Address.String(), v.Operation, result.Slot, gross, net, fee, m.Fee})
	if e != nil {
		return ""
	}
	return wenHashV1(raw)
}
